export type FileStat = { size: number; mtimeMs: number; isDirectory: boolean };

export type RunResult = { exit: number; stdout: string; stderr: string };

export type SupervisorFiles = { pid: string; exit: string; stderr: string };

export type ChooseFilesOptions = { prompt?: string; multiple?: boolean };

export type ChooseFilesResult = { cancelled: true } | { cancelled: false; paths: string[] };

// Everything that touches the machine goes through this interface, so core, store, app,
// and feature code run unchanged under bun on Linux (src/host/bun.ts) and under
// osascript on macOS (src/host/jxa.ts).
export interface Host {
  env: Record<string, string | undefined>;

  readText(path: string): string;
  // Bytes from offset to the end of the file; empty when the file is shorter.
  readBytesFrom(path: string, offset: number): Uint8Array;
  // Replaces the file in place through a temp file in its folder; fails when the folder is missing.
  writeAtomic(path: string, data: Uint8Array | string): void;
  // Creates missing parents: for base folders only, never for a chat or request folder.
  mkdirp(path: string): void;
  // Creates one folder; false when it already exists, throws when the parent is missing.
  mkdirExclusive(path: string): boolean;
  // Fails when the target exists or its parent folder is missing.
  move(from: string, to: string): void;
  remove(path: string): void;
  trash(path: string): void;
  exists(path: string): boolean;
  stat(path: string): FileStat | null;
  listDir(path: string): string[];

  // Runs argv under the sh supervisor: pid, then exit status, written atomically to the given files.
  spawnSupervised(argv: string[], files: SupervisorFiles): void;
  // The command line of a live process, or null.
  processCommand(pid: number): string | null;
  // TERM through /bin/kill; false when nothing was signalled.
  signalTerm(pid: number): boolean;
  // Exit 124 means the timeout fired.
  runSync(argv: string[], options?: { timeoutMs?: number }): RunResult;

  nowMs(): number;
  sleepMs(ms: number): void;
  randomId(): string;

  chooseFiles(options?: ChooseFilesOptions): ChooseFilesResult;
  clipboardPng(): Uint8Array | null;
  clipboardText(): string | null;

  log(message: string): void;
}
