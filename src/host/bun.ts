import {
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { commandFromPs, isSafePid, killArgv, psArgv, supervisorArgv } from "./common";
import type { ChooseFilesOptions, ChooseFilesResult, FileStat, Host, RunResult, SupervisorFiles } from "./types";

export type FakeCommand = (args: string[]) => RunResult;

export type BunHostOptions = {
  env?: Record<string, string | undefined>;
  trashDir?: string;
  chooseFiles?: (options: ChooseFilesOptions) => ChooseFilesResult;
  clipboardPng?: () => Uint8Array | null;
  clipboardText?: () => string | null;
  // Stand-ins for macOS-only tools, matched by the command's base name.
  fakeCommands?: Record<string, FakeCommand>;
  onLog?: (message: string) => void;
};

export class BunHost implements Host {
  env: Record<string, string | undefined>;
  readonly trashDir: string;
  readonly calls: string[][] = [];
  readonly logs: string[] = [];
  private counter = 0;

  constructor(private readonly options: BunHostOptions = {}) {
    this.env = { ...(options.env ?? process.env) };
    this.trashDir = options.trashDir ?? join(tmpdir(), "aichat-trash");
  }

  readText(path: string): string {
    return readFileSync(path, "utf8");
  }

  readBytesFrom(path: string, offset: number): Uint8Array {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      if (offset >= size) return new Uint8Array(0);
      const buffer = new Uint8Array(size - offset);
      let read = 0;
      while (read < buffer.length) {
        const n = readSync(fd, buffer, read, buffer.length - read, offset + read);
        if (n === 0) break;
        read += n;
      }
      return read === buffer.length ? buffer : buffer.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  }

  writeAtomic(path: string, data: Uint8Array | string): void {
    const temp = `${path}.tmp-${process.pid}-${this.counter++}`;
    try {
      writeFileSync(temp, data, { flag: "wx" });
      renameSync(temp, path);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        // the temp file was never created
      }
      throw error;
    }
  }

  mkdirp(path: string): void {
    mkdirSync(path, { recursive: true });
  }

  mkdirExclusive(path: string): boolean {
    try {
      mkdirSync(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  move(from: string, to: string): void {
    if (existsSync(to)) throw new Error(`cannot move ${from}: ${to} exists`);
    renameSync(from, to);
  }

  remove(path: string): void {
    rmSync(path, { recursive: true, force: true });
  }

  trash(path: string): void {
    mkdirSync(this.trashDir, { recursive: true });
    let target = join(this.trashDir, basename(path));
    while (existsSync(target)) target = join(this.trashDir, `${basename(path)}-${this.counter++}`);
    try {
      renameSync(path, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      cpSync(path, target, { recursive: true });
      rmSync(path, { recursive: true, force: true });
    }
  }

  exists(path: string): boolean {
    return existsSync(path);
  }

  stat(path: string): FileStat | null {
    try {
      const info = statSync(path);
      return { size: info.size, mtimeMs: info.mtimeMs, isDirectory: info.isDirectory() };
    } catch {
      return null;
    }
  }

  listDir(path: string): string[] {
    return readdirSync(path);
  }

  spawnSupervised(argv: string[], files: SupervisorFiles): void {
    const child = Bun.spawn(supervisorArgv(argv, files), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    child.unref();
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

  runSync(argv: string[], options: { timeoutMs?: number } = {}): RunResult {
    this.calls.push(argv);
    const fake = this.options.fakeCommands?.[basename(argv[0] ?? "")];
    if (fake) return fake(argv.slice(1));
    const result = Bun.spawnSync(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: this.env as Record<string, string>,
      timeout: options.timeoutMs,
    });
    return {
      exit: result.exitedDueToTimeout ? 124 : (result.exitCode ?? 1),
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  nowMs(): number {
    return Date.now();
  }

  sleepMs(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  randomId(): string {
    return crypto.randomUUID().replace(/-/g, "");
  }

  chooseFiles(options: ChooseFilesOptions = {}): ChooseFilesResult {
    return this.options.chooseFiles ? this.options.chooseFiles(options) : { cancelled: true };
  }

  clipboardPng(): Uint8Array | null {
    return this.options.clipboardPng ? this.options.clipboardPng() : null;
  }

  clipboardText(): string | null {
    return this.options.clipboardText ? this.options.clipboardText() : null;
  }

  log(message: string): void {
    this.logs.push(message);
    if (this.options.onLog) this.options.onLog(message);
    else process.stderr.write(`${message}\n`);
  }
}
