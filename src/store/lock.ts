import type { Host } from "../host/types";

export const LOCK_RETRY_MS = 50;
export const LOCK_WAIT_MS = 2000;
export const LOCK_STALE_MS = 30000;

export class LockTimeoutError extends Error {
  constructor(path: string) {
    super(`could not acquire ${path}`);
    this.name = "LockTimeoutError";
  }
}

function readOwner(host: Host, lockPath: string): { token: string; at: number } | null {
  try {
    const [token, at] = host.readText(`${lockPath}/owner`).split("\n");
    return { token: token ?? "", at: Number(at) };
  } catch {
    return null;
  }
}

// A lock is a directory made with mkdir, which only one process can win. A holder that vanished
// is broken after 30 s by moving the directory aside first, so only one breaker succeeds.
function breakStale(host: Host, lockPath: string): void {
  const owner = readOwner(host, lockPath);
  const info = host.stat(lockPath);
  if (!info) return;
  const acquired = owner && Number.isFinite(owner.at) ? owner.at : info.mtimeMs;
  if (host.nowMs() - acquired <= LOCK_STALE_MS) return;
  const aside = `${lockPath}.stale-${host.randomId()}`;
  try {
    host.move(lockPath, aside);
  } catch {
    return;
  }
  host.remove(aside);
}

export function withLock<T>(host: Host, lockPath: string, fn: () => T): T {
  const deadline = host.nowMs() + LOCK_WAIT_MS;
  const token = host.randomId();
  for (;;) {
    if (host.mkdirExclusive(lockPath)) break;
    breakStale(host, lockPath);
    if (host.nowMs() >= deadline) throw new LockTimeoutError(lockPath);
    host.sleepMs(LOCK_RETRY_MS);
  }
  try {
    host.writeAtomic(`${lockPath}/owner`, `${token}\n${host.nowMs()}`);
  } catch (error) {
    host.remove(lockPath);
    throw error;
  }
  try {
    return fn();
  } finally {
    // Another process may have broken a lock held too long; never remove its replacement.
    const owner = readOwner(host, lockPath);
    if (owner === null || owner.token === token) host.remove(lockPath);
  }
}
