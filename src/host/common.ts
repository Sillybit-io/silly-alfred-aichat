import type { RunResult, SupervisorFiles } from "./types";

// Runs the command in the background with stdin from the null device, records its pid, waits,
// then records its exit status. Both files appear atomically, the pid first.
// A supervisor killed by TERM leaves exit 143; a refused connection leaves curl's own exit 7.
export const SUPERVISOR_SCRIPT = [
  'pid_file=$1; exit_file=$2; err_file=$3; shift 3',
  '"$@" </dev/null >/dev/null 2>"$err_file" &',
  "child=$!",
  'printf "%s" "$child" > "$pid_file.tmp" && mv "$pid_file.tmp" "$pid_file"',
  'wait "$child"',
  "status=$?",
  'printf "%s" "$status" > "$exit_file.tmp" && mv "$exit_file.tmp" "$exit_file"',
].join("\n");

export function supervisorArgv(argv: string[], files: SupervisorFiles): string[] {
  if (argv.length === 0) throw new Error("spawnSupervised needs a command");
  return ["/bin/sh", "-c", SUPERVISOR_SCRIPT, "sh", files.pid, files.exit, files.stderr, ...argv];
}

export function psArgv(pid: number): string[] {
  return ["/bin/ps", "-ww", "-o", "command=", "-p", String(Math.trunc(pid))];
}

export function commandFromPs(result: RunResult): string | null {
  const text = result.stdout.trim();
  return result.exit === 0 && text !== "" ? text : null;
}

export function killArgv(pid: number): string[] {
  return ["/bin/kill", "-s", "TERM", String(Math.trunc(pid))];
}

export function isSafePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1;
}
