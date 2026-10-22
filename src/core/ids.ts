import type { Host } from "../host/types";

// Lexicographic order is creation order: nine base-36 digits of the millisecond clock, then random.
export function newId(host: Host): string {
  return host.nowMs().toString(36).padStart(9, "0") + host.randomId().slice(0, 7);
}
