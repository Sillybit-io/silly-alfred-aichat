import { decodeBase64, encodeBase64 } from "../core/base64";
import { commandFromPs, isSafePid, killArgv, psArgv, supervisorArgv } from "./common";
import type { ChooseFilesOptions, ChooseFilesResult, FileStat, Host, RunResult, SupervisorFiles } from "./types";

declare const Ref: () => any;

// The ObjC bridge hands back wrapped objects; a nil result arrives as undefined or null once unwrapped.
function isNil(value: any): boolean {
  if (value === null || value === undefined) return true;
  const unwrapped = ObjC.unwrap(value);
  return unwrapped === null || unwrapped === undefined;
}

function nsString(text: string): any {
  return $(text);
}

function dataFromBytes(bytes: Uint8Array): any {
  return $.NSData.alloc.initWithBase64EncodedStringOptions(encodeBase64(bytes), 0);
}

function bytesFromData(data: any): Uint8Array {
  return decodeBase64(ObjC.unwrap(data.base64EncodedStringWithOptions(0)));
}

function fileManager(): any {
  return $.NSFileManager.defaultManager;
}

function fail(action: string, path: string): never {
  throw new Error(`${action} failed for ${path}`);
}

function launch(argv: string[], out: any, err: any): any {
  const task = $.NSTask.alloc.init;
  const absolute = argv[0]!.charAt(0) === "/";
  task.executableURL = $.NSURL.fileURLWithPath(absolute ? argv[0] : "/usr/bin/env");
  task.arguments = absolute ? argv.slice(1) : argv;
  task.standardInput = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardOutput = out;
  task.standardError = err;
  if (!task.launchAndReturnError(false)) throw new Error(`could not launch ${argv[0]}`);
  return task;
}

class JxaHost implements Host {
  env: Record<string, string | undefined> = ObjC.deepUnwrap($.NSProcessInfo.processInfo.environment);

  readText(path: string): string {
    const text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, $());
    if (isNil(text)) fail("read", path);
    return ObjC.unwrap(text);
  }

  readBytesFrom(path: string, offset: number): Uint8Array {
    const handle = $.NSFileHandle.fileHandleForReadingAtPath(path);
    if (isNil(handle)) fail("open", path);
    try {
      handle.seekToFileOffset(offset);
      return bytesFromData(handle.readDataToEndOfFile);
    } finally {
      handle.closeFile;
    }
  }

  writeAtomic(path: string, data: Uint8Array | string): void {
    const payload = typeof data === "string" ? nsString(data).dataUsingEncoding($.NSUTF8StringEncoding) : dataFromBytes(data);
    if (!payload.writeToFileAtomically(path, true)) fail("write", path);
  }

  mkdirp(path: string): void {
    if (!fileManager().createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, true, $(), $())) fail("mkdir", path);
  }

  mkdirExclusive(path: string): boolean {
    if (fileManager().createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, false, $(), $())) return true;
    if (fileManager().fileExistsAtPath(path)) return false;
    return fail("mkdir", path);
  }

  move(from: string, to: string): void {
    if (!fileManager().moveItemAtPathToPathError(from, to, $())) fail("move", `${from} to ${to}`);
  }

  remove(path: string): void {
    if (fileManager().fileExistsAtPath(path)) fileManager().removeItemAtPathError(path, $());
  }

  trash(path: string): void {
    if (!fileManager().trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(path), Ref(), $())) fail("trash", path);
  }

  exists(path: string): boolean {
    return fileManager().fileExistsAtPath(path);
  }

  stat(path: string): FileStat | null {
    const attributes = fileManager().attributesOfItemAtPathError(path, $());
    if (isNil(attributes)) return null;
    const date = attributes.objectForKey("NSFileModificationDate");
    return {
      size: Number(ObjC.unwrap(attributes.objectForKey("NSFileSize"))),
      mtimeMs: isNil(date) ? 0 : date.timeIntervalSince1970 * 1000,
      isDirectory: ObjC.unwrap(attributes.objectForKey("NSFileType")) === "NSFileTypeDirectory",
    };
  }

  listDir(path: string): string[] {
    const names = fileManager().contentsOfDirectoryAtPathError(path, $());
    if (isNil(names)) fail("list", path);
    return ObjC.deepUnwrap(names);
  }

  spawnSupervised(argv: string[], files: SupervisorFiles): void {
    const nullDevice = $.NSFileHandle.fileHandleWithNullDevice;
    launch(supervisorArgv(argv, files), nullDevice, nullDevice);
  }

  processCommand(pid: number): string | null {
    if (!isSafePid(pid)) return null;
    return commandFromPs(this.runSync(psArgv(pid), { timeoutMs: 5000 }));
  }

  signalTerm(pid: number): boolean {
    if (!isSafePid(pid)) return false;
    try {
      return this.runSync(killArgv(pid), { timeoutMs: 5000 }).exit === 0;
    } catch {
      return false;
    }
  }

  // Output goes through files so a chatty child can never fill a pipe nobody is reading.
  runSync(argv: string[], options: { timeoutMs?: number } = {}): RunResult {
    const folder = `${ObjC.unwrap($.NSTemporaryDirectory())}aichat-run-${this.randomId()}`;
    this.mkdirp(folder);
    const outPath = `${folder}/out`;
    const errPath = `${folder}/err`;
    fileManager().createFileAtPathContentsAttributes(outPath, $(), $());
    fileManager().createFileAtPathContentsAttributes(errPath, $(), $());
    const out = $.NSFileHandle.fileHandleForWritingAtPath(outPath);
    const err = $.NSFileHandle.fileHandleForWritingAtPath(errPath);
    try {
      const task = launch(argv, out, err);
      const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
      let timedOut = false;
      while (task.isRunning) {
        if (Date.now() > deadline) {
          timedOut = true;
          task.terminate;
          break;
        }
        delay(0.005);
      }
      if (!timedOut) task.waitUntilExit;
      out.closeFile;
      err.closeFile;
      return {
        exit: timedOut ? 124 : task.terminationStatus,
        stdout: this.readText(outPath),
        stderr: this.readText(errPath),
      };
    } finally {
      this.remove(folder);
    }
  }

  nowMs(): number {
    return Date.now();
  }

  sleepMs(ms: number): void {
    delay(ms / 1000);
  }

  randomId(): string {
    return String(ObjC.unwrap($.NSUUID.UUID.UUIDString)).toLowerCase().replace(/-/g, "");
  }

  chooseFiles(options: ChooseFilesOptions = {}): ChooseFilesResult {
    const app = (Application as any).currentApplication();
    app.includeStandardAdditions = true;
    try {
      const picked = app.chooseFile({
        withPrompt: options.prompt ?? "Choose files to attach",
        multipleSelectionsAllowed: options.multiple ?? true,
      });
      const list = Array.isArray(picked) ? picked : [picked];
      return { cancelled: false, paths: list.map((item: any) => String(item)) };
    } catch (error: any) {
      if (error && error.errorNumber === -128) return { cancelled: true };
      throw error;
    }
  }

  clipboardPng(): Uint8Array | null {
    ObjC.import("AppKit");
    const board = $.NSPasteboard.generalPasteboard;
    const png = board.dataForType($.NSPasteboardTypePNG);
    if (!isNil(png)) return bytesFromData(png);
    const tiff = board.dataForType($.NSPasteboardTypeTIFF);
    if (isNil(tiff)) return null;
    const representation = $.NSBitmapImageRep.imageRepWithData(tiff);
    if (isNil(representation)) return null;
    const converted = representation.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
    return isNil(converted) ? null : bytesFromData(converted);
  }

  clipboardText(): string | null {
    ObjC.import("AppKit");
    const text = $.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString);
    return isNil(text) ? null : String(ObjC.unwrap(text));
  }

  log(message: string): void {
    $.NSFileHandle.fileHandleWithStandardError.writeData(nsString(`${message}\n`).dataUsingEncoding($.NSUTF8StringEncoding));
  }
}

export function createJxaHost(): Host {
  return new JxaHost();
}
