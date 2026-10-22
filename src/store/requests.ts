import { describeFailure, lastStatus, type MappedError } from "../core/errors";
import { newFramer, type FramerState } from "../core/sse";
import { newStreamState, consume, type Annotation, type StreamState } from "../core/stream";
import { newId } from "../core/ids";
import type { Host } from "../host/types";
import { dataDir, getChat, mutateChat, NotFoundError, type AttachmentRef } from "./chats";
import { withLock } from "./lock";

export type RequestKind = "chat" | "image" | "title";
export type RequestState = "open" | "done" | "failed" | "interrupted" | "stopped";

export type Draft = { text: string; attachments: AttachmentRef[] };

export type RequestRecord = {
  schema: 1;
  id: string;
  lane: string;
  kind: RequestKind;
  chatId: string | null;
  model: string;
  draft: Draft;
  stream: boolean;
  timeoutSeconds: number;
  startedAt: number;
  lastGrowthAt: number;
  offset: number;
  framer: FramerState;
  reducer: StreamState;
  state: RequestState;
  final: boolean;
  error: MappedError | null;
  curlExit: number | null;
  httpStatus: number | null;
  finalizeAttempts: number;
  // Feature-owned data a finalizer needs, such as an image prompt; retryOf names the kept draft a resend replaces.
  meta: Record<string, unknown>;
};

export type AdmitInput = {
  lane: string;
  kind: RequestKind;
  chatId: string | null;
  model: string;
  draft: Draft;
  // The encoded JSON body; it goes to a file and never onto the command line.
  body: string;
  url: string;
  apiKey: string;
  stream: boolean;
  // Chat: seconds without a byte before a stall. Image and title: curl --max-time.
  timeoutSeconds: number;
  // Pending attachment refs to remove from the chat once admitted.
  takePending?: boolean;
  meta?: Record<string, unknown>;
};

export type AdmitResult = { ok: true; rid: string } | { ok: false; reason: "busy"; rid: string };

export type Outcome = {
  state: Exclude<RequestState, "open">;
  content: string;
  reasoning: string;
  annotations: Annotation[];
  finishReason: string | null;
  error: MappedError | null;
  httpStatus: number | null;
  // The raw response of a non-streaming request.
  bodyText: string;
};

export type Finalizers = Partial<Record<RequestKind, (host: Host, record: RequestRecord, outcome: Outcome) => void>>;

export type TickResult = { record: RequestRecord; terminal: boolean };
export type FinalizeResult = { finalized: boolean; committed: boolean; record: RequestRecord | null; outcome: Outcome | null };

const FINALIZE_ATTEMPTS = 3;
const PID_GRACE_MS = 3000;
const NO_PID_YET_MS = 5000;
export const REFERER = "https://github.com/Sillybit-io/silly-alfred-aichat";

export const requestsDir = (host: Host) => `${dataDir(host)}/requests`;
export const requestDir = (host: Host, rid: string) => `${requestsDir(host)}/${rid}`;
export const lanesDir = (host: Host) => `${dataDir(host)}/lanes`;
const lanePointer = (host: Host, lane: string) => `${lanesDir(host)}/${lane}`;
const laneLock = (host: Host, lane: string) => `${lanesDir(host)}/${lane}.lock`;

function transport(host: Host, rid: string) {
  const dir = requestDir(host, rid);
  return {
    dir,
    record: `${dir}/request.json`,
    body: `${dir}/body.json`,
    out: `${dir}/out`,
    headers: `${dir}/headers`,
    pid: `${dir}/pid`,
    exit: `${dir}/exit`,
    stderr: `${dir}/stderr`,
    stop: `${dir}/stop`,
  };
}

function readOptional(host: Host, path: string): string | null {
  try {
    return host.readText(path);
  } catch {
    return null;
  }
}

export function loadRecord(host: Host, rid: string): RequestRecord | null {
  const text = readOptional(host, transport(host, rid).record);
  if (text === null) return null;
  try {
    return JSON.parse(text) as RequestRecord;
  } catch {
    return null;
  }
}

function saveRecord(host: Host, record: RequestRecord): void {
  host.writeAtomic(transport(host, record.id).record, JSON.stringify(record));
}

export function laneRecordId(host: Host, lane: string): string | null {
  const text = readOptional(host, lanePointer(host, lane));
  return text === null || text.trim() === "" ? null : text.trim();
}

export function currentRecord(host: Host, lane: string): RequestRecord | null {
  const rid = laneRecordId(host, lane);
  return rid === null ? null : loadRecord(host, rid);
}

function curlPath(host: Host): string {
  return host.env.aichat_curl ?? "/usr/bin/curl";
}

// The process that owns this request's output, or null when the recorded pid is gone or reused.
function ownedPid(host: Host, record: RequestRecord): number | null {
  const files = transport(host, record.id);
  const text = readOptional(host, files.pid);
  const pid = Number(text?.trim());
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const command = host.processCommand(pid);
  return command !== null && command.indexOf(files.out) >= 0 ? pid : null;
}

function transportEnded(host: Host, record: RequestRecord): boolean {
  const files = transport(host, record.id);
  if (host.exists(files.exit)) return true;
  const pidText = readOptional(host, files.pid);
  if (pidText === null) return host.nowMs() - record.startedAt > NO_PID_YET_MS;
  return ownedPid(host, record) === null && host.nowMs() - Math.max(record.lastGrowthAt, record.startedAt) > PID_GRACE_MS;
}

function curlArgs(host: Host, input: AdmitInput, files: ReturnType<typeof transport>): string[] {
  const args = [curlPath(host), "-o", files.out, "-D", files.headers, "--silent", "--show-error", "--connect-timeout", "15"];
  if (input.stream) args.push("--no-buffer", "--speed-limit", "1", "--speed-time", String(input.timeoutSeconds));
  else args.push("--max-time", String(input.timeoutSeconds));
  args.push(
    "-H", "Content-Type: application/json",
    "-H", `Authorization: Bearer ${input.apiKey}`,
    "-H", `HTTP-Referer: ${REFERER}`,
    "-H", "X-Title: Alfred AI Chat",
    "--data-binary", `@${files.body}`,
    input.url,
  );
  return args;
}

function withLaneLock<T>(host: Host, lane: string, fn: () => T): T {
  host.mkdirp(lanesDir(host));
  return withLock(host, laneLock(host, lane), fn);
}

// Admission: refused while the lane's record is open and its process is alive. A record whose
// transport ended is finalized first, so the lane is free before the new one is written.
export function admit(host: Host, input: AdmitInput, finalizers: Finalizers = {}): AdmitResult {
  return withLaneLock(host, input.lane, () => {
    const existing = laneRecordId(host, input.lane);
    if (existing !== null) {
      const record = loadRecord(host, existing);
      if (record && !record.final) {
        if (record.state === "open" && !transportEnded(host, record)) return { ok: false, reason: "busy", rid: existing } as const;
        advanceUnlocked(host, existing, finalizers);
      } else {
        host.remove(lanePointer(host, input.lane));
        if (record) host.remove(requestDir(host, existing));
      }
    }
    host.mkdirp(requestsDir(host));
    const rid = newId(host);
    if (!host.mkdirExclusive(requestDir(host, rid))) throw new Error(`request ${rid} already exists`);
    const files = transport(host, rid);
    const now = host.nowMs();
    const record: RequestRecord = {
      schema: 1,
      id: rid,
      lane: input.lane,
      kind: input.kind,
      chatId: input.chatId,
      model: input.model,
      draft: input.draft,
      stream: input.stream,
      timeoutSeconds: input.timeoutSeconds,
      startedAt: now,
      lastGrowthAt: now,
      offset: 0,
      framer: newFramer(),
      reducer: newStreamState(),
      state: "open",
      final: false,
      error: null,
      curlExit: null,
      httpStatus: null,
      finalizeAttempts: 0,
      meta: input.meta ?? {},
    };
    host.writeAtomic(files.body, input.body);
    saveRecord(host, record);
    host.writeAtomic(lanePointer(host, input.lane), rid);
    if (input.takePending && input.chatId !== null) {
      const taken = new Set(input.draft.attachments.map((ref) => ref.sha));
      try {
        mutateChat(host, input.chatId, (chat) => {
          chat.pending = chat.pending.filter((ref) => !taken.has(ref.sha));
        });
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    }
    host.spawnSupervised(curlArgs(host, input, files), { pid: files.pid, exit: files.exit, stderr: files.stderr });
    return { ok: true, rid } as const;
  });
}

function stopTransport(host: Host, record: RequestRecord): void {
  const pid = ownedPid(host, record);
  if (pid !== null) host.signalTerm(pid);
}

// A finished image request must hold at least one image to count as done.
function hasImages(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { data?: unknown };
    return Array.isArray(parsed.data) && parsed.data.length > 0;
  } catch {
    return false;
  }
}

function failureFor(host: Host, record: RequestRecord, extra: { stalled?: boolean } = {}): MappedError {
  const files = transport(host, record.id);
  const status = record.httpStatus;
  const body = status !== null && status >= 400 ? (readOptional(host, files.out) ?? "").slice(0, 4000) : "";
  if (extra.stalled) {
    return { title: "No data from OpenRouter", detail: `Nothing arrived for ${record.timeoutSeconds} seconds.`, next: "Use /retry, or pick another model with /model." };
  }
  return describeFailure({
    headers: readOptional(host, files.headers) ?? "",
    body,
    curlExit: record.curlExit,
    streamError: record.reducer.error,
    finishReason: record.reducer.finishReason,
  });
}

// Reads only the bytes past the saved offset, folds them, and decides whether the request ended.
function tickUnlocked(host: Host, rid: string): TickResult | null {
  const record = loadRecord(host, rid);
  if (!record) return null;
  if (record.final || record.state !== "open") return { record, terminal: record.state !== "open" };
  const files = transport(host, rid);
  const now = host.nowMs();

  if (host.exists(files.out)) {
    const bytes = host.readBytesFrom(files.out, record.offset);
    if (bytes.length > 0) {
      record.offset += bytes.length;
      record.lastGrowthAt = now;
      if (record.stream) consume(record.framer, record.reducer, bytes);
    }
  }
  const headers = readOptional(host, files.headers);
  if (headers !== null) record.httpStatus = lastStatus(headers)?.status ?? record.httpStatus;
  const exitText = readOptional(host, files.exit);
  if (exitText !== null && Number.isFinite(Number(exitText.trim()))) record.curlExit = Number(exitText.trim());

  const reducer = record.reducer;
  const hasContent = reducer.content !== "";
  const httpFailed = record.httpStatus !== null && record.httpStatus >= 400;
  let state: RequestState = "open";
  let stalled = false;

  if (host.exists(files.stop)) state = "stopped";
  else if (httpFailed && record.curlExit !== null) state = "failed";
  else if (record.stream && reducer.error) state = hasContent ? "interrupted" : "failed";
  else if (record.stream && reducer.doneSeen) state = "done";
  else if (record.curlExit !== null || transportEnded(host, record)) {
    if (record.stream) {
      state = hasContent ? "interrupted" : "failed";
    } else {
      state = record.curlExit === 0 && !httpFailed ? "done" : "failed";
      if (state === "done" && record.kind === "image" && !hasImages(readOptional(host, files.out) ?? "")) {
        state = "failed";
        record.error = { title: "No image returned", detail: "OpenRouter answered without an image.", next: "Try again, or choose another image model." };
      }
    }
  } else if (record.stream && now - record.lastGrowthAt > record.timeoutSeconds * 1000) {
    stalled = true;
    state = hasContent ? "interrupted" : "failed";
  } else if (!record.stream && now - record.startedAt > (record.timeoutSeconds + 15) * 1000) {
    stalled = true;
    state = "failed";
  }

  if (state !== "open") {
    if (state !== "done" && host.exists(files.pid) && record.curlExit === null) stopTransport(host, record);
    record.state = state;
    if ((state === "failed" || state === "interrupted") && !record.error) record.error = failureFor(host, record, { stalled });
  }
  saveRecord(host, record);
  return { record, terminal: state !== "open" };
}

export function tick(host: Host, rid: string): TickResult | null {
  const lane = loadRecord(host, rid)?.lane;
  if (lane === undefined) return null;
  return withLaneLock(host, lane, () => tickUnlocked(host, rid));
}

function outcomeOf(host: Host, record: RequestRecord): Outcome {
  const state = record.state === "open" ? "failed" : record.state;
  const files = transport(host, record.id);
  return {
    state,
    content: record.reducer.content,
    reasoning: record.reducer.reasoning,
    annotations: record.reducer.annotations,
    finishReason: record.reducer.finishReason,
    error: record.error,
    httpStatus: record.httpStatus,
    bodyText: record.stream ? "" : (readOptional(host, files.out) ?? ""),
  };
}

function errorLine(error: MappedError | null): string {
  return error ? `${error.title}: ${error.detail}` : "";
}

// Commits a finished chat request under the chat lock; a message that already carries the request
// id means an earlier run committed it, so nothing is added twice.
function commitChat(host: Host, record: RequestRecord, outcome: Outcome): boolean {
  if (record.chatId === null) return false;
  let committed = false;
  try {
    mutateChat(host, record.chatId, (chat) => {
      if (chat.messages.some((message) => message.requestId === record.id)) return false;
      const hasContent = outcome.content !== "";
      if (hasContent || outcome.state === "done") {
        const now = host.nowMs();
        chat.messages.push({
          id: `${record.id}-u`,
          requestId: record.id,
          role: "user",
          content: record.draft.text,
          attachments: record.draft.attachments,
          status: "ok",
          createdAt: now,
        });
        chat.messages.push({
          id: `${record.id}-a`,
          requestId: record.id,
          role: "assistant",
          content: outcome.content,
          attachments: [],
          ...(outcome.reasoning !== "" && chat.settings.showReasoning ? { reasoning: outcome.reasoning } : {}),
          ...(outcome.annotations.length > 0 ? { annotations: outcome.annotations } : {}),
          status: outcome.state === "done" ? "ok" : outcome.state === "stopped" ? "stopped" : "interrupted",
          ...(outcome.state === "interrupted" && outcome.error ? { error: errorLine(outcome.error) } : {}),
          createdAt: now,
        });
        // Only the resend of the kept draft clears it; other text sent meanwhile leaves it for /retry.
        if (chat.retry && record.meta.retryOf === chat.retry.requestId) chat.retry = null;
        committed = true;
      } else {
        chat.retry = {
          requestId: record.id,
          text: record.draft.text,
          attachments: record.draft.attachments,
          model: record.model,
          error: outcome.state === "stopped" ? "Stopped before the first token" : errorLine(outcome.error),
        };
      }
    });
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }
  return committed;
}

function finalizeUnlocked(host: Host, rid: string, finalizers: Finalizers): FinalizeResult {
  const record = loadRecord(host, rid);
  if (!record) {
    return { finalized: false, committed: false, record: null, outcome: null };
  }
  if (record.state === "open") return { finalized: false, committed: false, record, outcome: null };
  const outcome = outcomeOf(host, record);
  let committed = false;
  if (!record.final) {
    if (record.kind === "chat") {
      committed = commitChat(host, record, outcome);
      // The chat finalizer observes a committed reply (titles); it never blocks the cleanup.
      if (committed && finalizers.chat) {
        try {
          finalizers.chat(host, record, outcome);
        } catch (error) {
          host.log(`after-commit hook failed for request ${record.id}: ${String(error)}`);
        }
      }
    } else {
      const finalizer = finalizers[record.kind];
      if (finalizer) {
        try {
          finalizer(host, record, outcome);
        } catch (error) {
          record.finalizeAttempts += 1;
          if (record.finalizeAttempts < FINALIZE_ATTEMPTS) {
            saveRecord(host, record);
            throw error;
          }
          host.log(`dropping ${record.kind} request ${record.id} after ${record.finalizeAttempts} failed finalizations: ${String(error)}`);
        }
      }
    }
    record.final = true;
    saveRecord(host, record);
  }
  if (laneRecordId(host, record.lane) === rid) host.remove(lanePointer(host, record.lane));
  host.remove(requestDir(host, rid));
  return { finalized: true, committed, record, outcome };
}

export function finalize(host: Host, rid: string, finalizers: Finalizers = {}): FinalizeResult {
  const lane = loadRecord(host, rid)?.lane;
  if (lane === undefined) return { finalized: false, committed: false, record: null, outcome: null };
  return withLaneLock(host, lane, () => finalizeUnlocked(host, rid, finalizers));
}

function advanceUnlocked(host: Host, rid: string, finalizers: Finalizers): FinalizeResult {
  const ticked = tickUnlocked(host, rid);
  if (!ticked || !ticked.terminal) return { finalized: false, committed: false, record: ticked?.record ?? null, outcome: null };
  return finalizeUnlocked(host, rid, finalizers);
}

// One tick, then finalization when the request reached a terminal state.
export function advance(host: Host, rid: string, finalizers: Finalizers = {}): { tick: TickResult | null; finalize: FinalizeResult | null } {
  const lane = loadRecord(host, rid)?.lane;
  if (lane === undefined) return { tick: null, finalize: null };
  return withLaneLock(host, lane, () => {
    const ticked = tickUnlocked(host, rid);
    if (!ticked || !ticked.terminal) return { tick: ticked, finalize: null };
    return { tick: ticked, finalize: finalizeUnlocked(host, rid, finalizers) };
  });
}

// Finalizes records whose transport ended or whose stop sentinel exists.
export function finalizeDue(host: Host, finalizers: Finalizers = {}, lane?: string): string[] {
  if (!host.exists(lanesDir(host))) return [];
  const lanes = lane !== undefined ? [lane] : host.listDir(lanesDir(host)).filter((name) => !name.endsWith(".lock") && name.indexOf(".tmp-") < 0);
  const done: string[] = [];
  for (const name of lanes) {
    const rid = laneRecordId(host, name);
    if (rid === null) continue;
    withLaneLock(host, name, () => {
      const record = loadRecord(host, rid);
      if (!record) {
        host.remove(lanePointer(host, name));
        return;
      }
      const files = transport(host, rid);
      if (record.final || host.exists(files.stop) || host.exists(files.exit) || (record.state === "open" && transportEnded(host, record))) {
        if (advanceUnlocked(host, rid, finalizers).finalized) done.push(rid);
      }
    });
  }
  return done;
}

export type StopResult = { sentinel: boolean; signalled: boolean };

// Writes the sentinel, then signals only a process whose command line names this request's output.
export function stop(host: Host, rid: string): StopResult {
  const record = loadRecord(host, rid);
  if (!record || record.final) return { sentinel: false, signalled: false };
  const files = transport(host, rid);
  try {
    host.writeAtomic(files.stop, String(host.nowMs()));
  } catch {
    return { sentinel: false, signalled: false };
  }
  const pid = ownedPid(host, record);
  return { sentinel: true, signalled: pid !== null ? host.signalTerm(pid) : false };
}

export function chatHasOpenRequest(host: Host, chatId: string): boolean {
  const record = currentRecord(host, `chat:${chatId}`);
  return record !== null && !record.final;
}

export function chatExists(host: Host, chatId: string): boolean {
  return getChat(host, chatId) !== null;
}
