export type FileStat = { size: number; mtimeMs: number; isDirectory: boolean };

export type RunResult = { exit: number; stdout: string; stderr: string };
// maxBytes limits each file written by the child and bounds stdout/stderr reads before decoding.
export type RunOptions = { timeoutMs?: number; stdin?: string; maxBytes?: number };

// remove is a file the supervisor deletes as soon as the command ends: the request body, which holds the conversation.
// maxBytes caps every file the command writes (ulimit -f); one that writes past it is stopped by the system.
export type SupervisorFiles = { pid: string; exit: string; stderr: string; remove?: string; maxBytes?: number };

export type ChooseFilesOptions = { prompt?: string; multiple?: boolean };

export type ChooseFilesResult = { cancelled: true } | { cancelled: false; paths: string[] };

// Everything that touches the machine goes through this interface, so core, store, app,
// and feature code run unchanged under bun on Linux (src/host/bun.ts) and under
// osascript on macOS (src/host/jxa.ts).
export interface Host {
  env: Record<string, string | undefined>;

  readText(path: string): string;
  // Bytes from offset to the end of the file, or at most maxLength of them; empty when the file is shorter.
  readBytesFrom(path: string, offset: number, maxLength?: number): Uint8Array;
  // The whole file as base64, encoded natively, for bytes that only travel in a request body.
  readBase64(path: string): string;
  // Everything the host creates is private to the user: folders 0700, files 0600.
  // Replaces the file in place through a temp file in its folder; fails when the folder is missing.
  writeAtomic(path: string, data: Uint8Array | string): void;
  // Creates missing parents: for base folders only, never for a chat or request folder.
  mkdirp(path: string): void;
  // Creates one folder; false when it already exists, throws when the parent is missing.
  mkdirExclusive(path: string): boolean;
  // Fails when the target exists or its parent folder is missing.
  move(from: string, to: string): void;
  // Deletes at once and for good; macOS has no secure erase for flash storage, so FileVault is the protection at rest.
  remove(path: string): void;
  // Makes an existing folder tree private (folders 0700, files 0600); symbolic links are left alone.
  restrict(path: string): void;
  exists(path: string): boolean;
  stat(path: string): FileStat | null;
  // When the file's content or metadata (extended attributes, permissions) last changed, as ctime; null when unknown.
  changedMs(path: string): number | null;
  listDir(path: string): string[];

  // Runs argv under the sh supervisor: pid, then exit status, written atomically to the given files.
  // stdin, when given, becomes the command's standard input; children never inherit the API key variable.
  spawnSupervised(argv: string[], files: SupervisorFiles, options?: { stdin?: string }): void;
  // The command line of a live process, or null.
  processCommand(pid: number): string | null;
  // TERM through /bin/kill; false when nothing was signalled.
  signalTerm(pid: number): boolean;
  // Exit 124 means the timeout fired; 63 means captured output exceeded maxBytes.
  runSync(argv: string[], options?: RunOptions): RunResult;

  nowMs(): number;
  sleepMs(ms: number): void;
  randomId(): string;

  // A native dialog that asks before something is lost for good; false when declined or left unanswered.
  confirm(message: string, action: string): boolean;
  chooseFiles(options?: ChooseFilesOptions): ChooseFilesResult;
  clipboardPng(): Uint8Array | null;
  clipboardText(): string | null;

  log(message: string): void;
}
