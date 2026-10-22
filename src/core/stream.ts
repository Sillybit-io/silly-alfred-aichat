import { feed, type FramerState, type SseEvent } from "./sse";

export type StreamPhase = "connecting" | "processing" | "thinking" | "answering";

export type StreamError = { kind: "api" | "protocol"; message: string; code: string | null };

export type Annotation = { type: "url_citation" | "file"; [key: string]: unknown };

// The usage chunk only marks the end of a stream; none of its numbers are kept.
export type StreamState = {
  phase: StreamPhase;
  content: string;
  reasoning: string;
  annotations: Annotation[];
  finishReason: string | null;
  doneSeen: boolean;
  accountingSeen: boolean;
  error: StreamError | null;
};

export function newStreamState(): StreamState {
  return {
    phase: "connecting",
    content: "",
    reasoning: "",
    annotations: [],
    finishReason: null,
    doneSeen: false,
    accountingSeen: false,
    error: null,
  };
}

type Json = { [key: string]: unknown };

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setError(state: StreamState, error: StreamError): void {
  if (!state.error) state.error = error;
}

function annotationKey(annotation: Annotation): string {
  if (annotation.type === "url_citation") {
    const citation = isObject(annotation.url_citation) ? annotation.url_citation : annotation;
    return `url:${String(citation.url ?? "")}`;
  }
  const file = isObject(annotation.file) ? annotation.file : {};
  return `file:${String(file.hash ?? JSON.stringify(annotation))}`;
}

function addAnnotations(state: StreamState, value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!isObject(item)) continue;
    if (item.type !== "url_citation" && item.type !== "file") continue;
    const annotation = item as Annotation;
    const key = annotationKey(annotation);
    if (!state.annotations.some((existing) => annotationKey(existing) === key)) state.annotations.push(annotation);
  }
}

function reasoningText(delta: Json): string {
  if (typeof delta.reasoning === "string" && delta.reasoning !== "") return delta.reasoning;
  if (!Array.isArray(delta.reasoning_details)) return "";
  let text = "";
  for (const detail of delta.reasoning_details) {
    if (!isObject(detail)) continue;
    if (detail.type === "reasoning.text" && typeof detail.text === "string") text += detail.text;
    else if (detail.type === "reasoning.summary" && typeof detail.summary === "string") text += detail.summary;
  }
  return text;
}

function errorFrom(value: unknown): StreamError {
  if (isObject(value)) {
    const message = typeof value.message === "string" && value.message !== "" ? value.message : "The provider reported an error";
    const code = typeof value.code === "string" || typeof value.code === "number" ? String(value.code) : null;
    return { kind: "api", message, code };
  }
  return { kind: "api", message: typeof value === "string" && value !== "" ? value : "The provider reported an error", code: null };
}

export function fold(state: StreamState, event: SseEvent): void {
  if (state.phase === "connecting") state.phase = "processing";
  if (event.type === "keepalive") return;
  const payload = event.data;
  if (payload.trim() === "[DONE]") {
    state.doneSeen = true;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    setError(state, { kind: "protocol", message: "The stream held an event that is not valid JSON", code: null });
    return;
  }
  if (!isObject(parsed)) {
    setError(state, { kind: "protocol", message: "The stream held an event that is not a JSON object", code: null });
    return;
  }
  if (parsed.usage !== undefined && parsed.usage !== null) state.accountingSeen = true;
  if (parsed.error !== undefined && parsed.error !== null) setError(state, errorFrom(parsed.error));

  const choice = Array.isArray(parsed.choices) && isObject(parsed.choices[0]) ? parsed.choices[0] : null;
  if (!choice) return;
  const delta = isObject(choice.delta) ? choice.delta : isObject(choice.message) ? choice.message : null;
  if (delta) {
    const reasoning = reasoningText(delta);
    if (reasoning !== "") {
      state.reasoning += reasoning;
      if (state.phase !== "answering") state.phase = "thinking";
    }
    if (typeof delta.content === "string" && delta.content !== "") {
      state.content += delta.content;
      state.phase = "answering";
    }
    addAnnotations(state, delta.annotations);
  }
  if (typeof choice.finish_reason === "string") {
    state.finishReason = choice.finish_reason;
    if (choice.finish_reason === "error") setError(state, errorFrom(parsed.error));
  }
}

export function consume(framer: FramerState, state: StreamState, bytes: Uint8Array): SseEvent[] {
  const events = feed(framer, bytes);
  for (const event of events) fold(state, event);
  return events;
}
