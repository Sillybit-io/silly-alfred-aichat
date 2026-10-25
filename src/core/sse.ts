import { decodeUtf8 } from "./utf8";

export type SseEvent = { type: "data"; data: string } | { type: "keepalive" };

// Everything here is JSON-serializable: the request supervisor saves it between runs. The unfinished line is kept
// as one character per byte, which stays compact in JSON; a record saved by an older version holds a number array.
export type FramerState = {
  line: string | number[];
  pendingCr: boolean;
  data: string[];
};

export function newFramer(): FramerState {
  return { line: "", pendingCr: false, data: [] };
}

const LF = 10;
const CR = 13;
const COLON = 58;
const SPACE = 32;
const CHUNK = 8190;

function byteString(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += CHUNK) text += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  return text;
}

function lineBytes(state: FramerState, rest: Uint8Array): Uint8Array {
  const kept = state.line;
  if (kept.length === 0) return rest;
  const out = new Uint8Array(kept.length + rest.length);
  if (typeof kept === "string") for (let i = 0; i < kept.length; i++) out[i] = kept.charCodeAt(i);
  else out.set(kept);
  out.set(rest, kept.length);
  return out;
}

function endLine(state: FramerState, bytes: Uint8Array, events: SseEvent[]): void {
  state.line = "";
  if (bytes.length === 0) {
    if (state.data.length > 0) {
      events.push({ type: "data", data: state.data.join("\n") });
      state.data = [];
    }
    return;
  }
  if (bytes[0] === COLON) {
    events.push({ type: "keepalive" });
    return;
  }
  const text = decodeUtf8(bytes);
  const colon = text.indexOf(":");
  const field = colon < 0 ? text : text.slice(0, colon);
  if (field !== "data") return;
  let value = colon < 0 ? "" : text.slice(colon + 1);
  if (value.charCodeAt(0) === SPACE) value = value.slice(1);
  state.data.push(value);
}

// Splits at LF, CR, or CRLF; bytes are decoded only once their line is complete.
export function feed(state: FramerState, bytes: Uint8Array): SseEvent[] {
  const events: SseEvent[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (state.pendingCr) {
      state.pendingCr = false;
      if (byte === LF) {
        start = i + 1;
        continue;
      }
    }
    if (byte === LF || byte === CR) {
      endLine(state, lineBytes(state, bytes.subarray(start, i)), events);
      state.pendingCr = byte === CR;
      start = i + 1;
    }
  }
  if (start < bytes.length) state.line = byteString(lineBytes(state, bytes.subarray(start)));
  return events;
}

// An unfinished line or an event without its blank line was cut off; the
// WHATWG rules discard it, so it is reported rather than dispatched.
export function finish(state: FramerState): { truncated: boolean } {
  return { truncated: state.line.length > 0 || state.data.length > 0 };
}
