import { decodeBase64, encodeBase64 } from "../core/base64";
import { commandFromPs, isSafePid, killArgv, psArgv, redact, scrubbedEnv, supervisorArgv } from "./common";
import type { ChooseFilesOptions, ChooseFilesResult, FileStat, Host, RunResult, SupervisorFiles } from "./types";

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

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

function permissions(mode: number): any {
  return $({ NSFilePosixPermissions: mode });
}

function fail(action: string, path: string): never {
  throw new Error(`${action} failed for ${path}`);
}

// The child gets the environment without the API key variable. Its stdin is the null device, or a pipe
// that is filled and closed right after launch: the secret is small, so it sits in the pipe's buffer
// and the child can read it after this process has exited.
function launch(argv: string[], out: any, err: any, env: Record<string, string | undefined>, stdin?: string): any {
  const task = $.NSTask.alloc.init;
  const absolute = argv[0]!.charAt(0) === "/";
  task.executableURL = $.NSURL.fileURLWithPath(absolute ? argv[0] : "/usr/bin/env");
  task.arguments = absolute ? argv.slice(1) : argv;
  task.environment = $(scrubbedEnv(env));
  const pipe = stdin === undefined ? null : $.NSPipe.pipe;
  task.standardInput = pipe === null ? $.NSFileHandle.fileHandleWithNullDevice : pipe;
  task.standardOutput = out;
  task.standardError = err;
  if (!task.launchAndReturnError(false)) throw new Error(`could not launch ${argv[0]}`);
  if (pipe !== null) {
    const writer = pipe.fileHandleForWriting;
    try {
      writer.writeData(nsString(stdin as string).dataUsingEncoding($.NSUTF8StringEncoding));
    } catch {
      // The child already exited; it has nothing left to read.
    }
    writer.closeFile;
  }
  return task;
}

class JxaHost implements Host {
  env: Record<string, string | undefined> = ObjC.deepUnwrap($.NSProcessInfo.processInfo.environment);

  constructor() {
    // Anything this process or its children create is private by default; the explicit modes below do not rely on it.
    try {
      ObjC.bindFunction("umask", ["int", ["int"]]);
      $.umask(0o077);
    } catch {
      // the explicit modes still apply
    }
  }

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
    fileManager().setAttributesOfItemAtPathError(permissions(PRIVATE_FILE), path, $());
  }

  mkdirp(path: string): void {
    if (!fileManager().createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, true, permissions(PRIVATE_DIR), $())) fail("mkdir", path);
  }

  mkdirExclusive(path: string): boolean {
    if (fileManager().createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, false, permissions(PRIVATE_DIR), $())) return true;
    if (fileManager().fileExistsAtPath(path)) return false;
    return fail("mkdir", path);
  }

  move(from: string, to: string): void {
    if (!fileManager().moveItemAtPathToPathError(from, to, $())) fail("move", `${from} to ${to}`);
  }

  remove(path: string): void {
    if (fileManager().fileExistsAtPath(path) && !fileManager().removeItemAtPathError(path, $())) fail("remove", path);
  }

  // A path that is missing is skipped; any other failure throws, so a caller never records a migration that did not happen.
  restrict(path: string): void {
    const manager = fileManager();
    if (!manager.fileExistsAtPath(path)) return;
    const apply = (item: string): string => {
      const attributes = manager.attributesOfItemAtPathError(item, $());
      if (isNil(attributes)) fail("read the permissions of", item);
      const type = String(ObjC.unwrap(attributes.objectForKey("NSFileType")));
      if (type === "NSFileTypeSymbolicLink") return type;
      if (!manager.setAttributesOfItemAtPathError(permissions(type === "NSFileTypeDirectory" ? PRIVATE_DIR : PRIVATE_FILE), item, $())) fail("restrict", item);
      return type;
    };
    if (apply(path) !== "NSFileTypeDirectory") return;
    const names = manager.subpathsOfDirectoryAtPathError(path, $());
    if (isNil(names)) fail("list", path);
    for (const name of ObjC.deepUnwrap(names) as string[]) apply(`${path}/${name}`);
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

  spawnSupervised(argv: string[], files: SupervisorFiles, options: { stdin?: string } = {}): void {
    const nullDevice = $.NSFileHandle.fileHandleWithNullDevice;
    launch(supervisorArgv(argv, files), nullDevice, nullDevice, this.env, options.stdin);
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
  runSync(argv: string[], options: { timeoutMs?: number; stdin?: string } = {}): RunResult {
    const folder = `${ObjC.unwrap($.NSTemporaryDirectory())}aichat-run-${this.randomId()}`;
    this.mkdirp(folder);
    const outPath = `${folder}/out`;
    const errPath = `${folder}/err`;
    fileManager().createFileAtPathContentsAttributes(outPath, $(), permissions(PRIVATE_FILE));
    fileManager().createFileAtPathContentsAttributes(errPath, $(), permissions(PRIVATE_FILE));
    const out = $.NSFileHandle.fileHandleForWritingAtPath(outPath);
    const err = $.NSFileHandle.fileHandleForWritingAtPath(errPath);
    try {
      const task = launch(argv, out, err, this.env, options.stdin);
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

  confirm(message: string, action: string): boolean {
    const app = (Application as any).currentApplication();
    app.includeStandardAdditions = true;
    try {
      app.activate();
    } catch {
      // The dialog still shows; it is only not brought to the front.
    }
    try {
      const answer = app.displayDialog(message, { buttons: ["Cancel", action], defaultButton: "Cancel", cancelButton: "Cancel", withIcon: "caution", givingUpAfter: 120 });
      return answer.buttonReturned === action && !answer.gaveUp;
    } catch {
      return false;
    }
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
    $.NSFileHandle.fileHandleWithStandardError.writeData(nsString(`${redact(message, this.env)}\n`).dataUsingEncoding($.NSUTF8StringEncoding));
  }
}

export function createJxaHost(): Host {
  return new JxaHost();
}
