import { decodeUtf8 } from "./utf8";

export type SseEvent = { type: "data"; data: string } | { type: "keepalive" };

// Everything here is JSON-serializable: the request supervisor saves it between runs.
export type FramerState = {
  line: number[];
  pendingCr: boolean;
  data: string[];
};

export function newFramer(): FramerState {
  return { line: [], pendingCr: false, data: [] };
}

const LF = 10;
const CR = 13;
const COLON = 58;
const SPACE = 32;

function endLine(state: FramerState, events: SseEvent[]): void {
  const bytes = Uint8Array.from(state.line);
  state.line = [];
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
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (state.pendingCr) {
      state.pendingCr = false;
      if (byte === LF) continue;
    }
    if (byte === LF) {
      endLine(state, events);
    } else if (byte === CR) {
      endLine(state, events);
      state.pendingCr = true;
    } else {
      state.line.push(byte);
    }
  }
  return events;
}

// An unfinished line or an event without its blank line was cut off; the
// WHATWG rules discard it, so it is reported rather than dispatched.
export function finish(state: FramerState): { truncated: boolean } {
  return { truncated: state.line.length > 0 || state.data.length > 0 };
}
