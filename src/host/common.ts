import { TEST_HOOKS } from "../core/hooks";
import type { RunResult, SupervisorFiles } from "./types";

// Runs the command in the background, records its pid, waits, then records its exit status.
// Both files appear atomically, the pid first. The command's stdin is whatever the supervisor
// was given (the null device, or a secret fed by the host); it is saved on fd 3 first because a
// background job in a non-interactive shell would otherwise get /dev/null.
// A supervisor killed by TERM leaves exit 143; a refused connection leaves curl's own exit 7.
export const SUPERVISOR_SCRIPT = [
  "umask 077",
  'pid_file=$1; exit_file=$2; err_file=$3; remove_file=$4; shift 4',
  "exec 3<&0",
  '"$@" <&3 >/dev/null 2>"$err_file" &',
  "child=$!",
  "exec 3<&-",
  'printf "%s" "$child" > "$pid_file.tmp" && mv "$pid_file.tmp" "$pid_file"',
  'wait "$child"',
  "status=$?",
  '[ -n "$remove_file" ] && rm -f -- "$remove_file"',
  'printf "%s" "$status" > "$exit_file.tmp" && mv "$exit_file.tmp" "$exit_file"',
].join("\n");

export function supervisorArgv(argv: string[], files: SupervisorFiles): string[] {
  if (argv.length === 0) throw new Error("spawnSupervised needs a command");
  return ["/bin/sh", "-c", SUPERVISOR_SCRIPT, "sh", files.pid, files.exit, files.stderr, files.remove ?? "", ...argv];
}

// Variables that hold the API key. Child processes never inherit them: a request can run for
// minutes and `ps eww` shows a process's environment to other processes of the same user.
const SECRET_ENV = ["openrouter_api_key"];

export function scrubbedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && SECRET_ENV.indexOf(name) < 0) clean[name] = value;
  }
  return clean;
}

// The curl config that carries the API key. It travels on curl's stdin (`-K -`), so the key is never
// in a command line, an environment variable, or a file.
export const CURL_STDIN_CONFIG = ["-K", "-"];

// Control characters would end the config line; quotes and backslashes are escaped by curlAuthConfig.
const BAD_KEY = /[\u0000-\u001f\u007f]/;

// A message for a key that cannot be sent safely, or null. An empty key is the caller's own check.
export function keyProblem(apiKey: string): string | null {
  return BAD_KEY.test(apiKey) ? "The OpenRouter API key in the workflow's Configuration contains a line break or control character. Paste it again." : null;
}

export function curlAuthConfig(apiKey: string): string {
  if (apiKey === "" || BAD_KEY.test(apiKey)) throw new Error("The API key cannot be sent.");
  return `header = "Authorization: Bearer ${apiKey.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`;
}

export const CURL_PATH = "/usr/bin/curl";

export function curlBinary(env: Record<string, string | undefined>): string {
  return TEST_HOOKS ? (env.aichat_curl ?? CURL_PATH) : CURL_PATH;
}

// https only, also across redirects. A test build may talk to its own http server on this machine.
export function curlProtocolArgs(url: string): string[] {
  const first = TEST_HOOKS && url.startsWith("http://") ? "=http,https" : "=https";
  return ["--proto", first, "--proto-redir", "=https"];
}

// Keeps the API key out of anything that is logged.
export function redact(message: string, env: Record<string, string | undefined>): string {
  let text = message;
  for (const name of SECRET_ENV) {
    const value = (env[name] ?? "").trim();
    if (value.length >= 6) text = text.split(value).join("[redacted]");
  }
  return text;
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
