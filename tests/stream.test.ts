import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { newFramer, finish } from "../src/core/sse";
import { consume, newStreamState } from "../src/core/stream";

const dir = resolve(import.meta.dir, "fixtures/sse");
const fixture = (name: string) => new Uint8Array(readFileSync(join(dir, name)));

function run(name: string, cut?: number) {
  const framer = newFramer();
  const state = newStreamState();
  const whole = fixture(name);
  if (cut === undefined) consume(framer, state, whole);
  else {
    consume(framer, state, whole.subarray(0, cut));
    consume(framer, state, whole.subarray(cut));
  }
  return { framer, state };
}

describe("stream reducer", () => {
  test("every fixture split at every byte position gives the same state as one whole feed", () => {
    for (const name of ["ok.sse", "ok-crlf.sse", "ok-cr.sse", "reasoning.sse", "annotations.sse", "error-only.sse", "multiline-data.sse"]) {
      const expected = run(name).state;
      const length = fixture(name).length;
      for (let cut = 0; cut <= length; cut++) expect(run(name, cut).state).toEqual(expected);
    }
  });

  test("folds content, split inside a character, and ends on the usage chunk then DONE", () => {
    const { state } = run("ok.sse");
    expect(state.content).toBe("Héllo wörld 👋");
    expect(state.phase).toBe("answering");
    expect(state.finishReason).toBe("stop");
    expect(state.accountingSeen).toBe(true);
    expect(state.doneSeen).toBe(true);
    expect(state.error).toBeNull();
    const text = JSON.stringify(state);
    expect(text).not.toMatch(/cost|0\.00042|prompt_tokens|total_tokens/);
  });

  test("a multi-line data event is joined before parsing", () => {
    const whole = fixture("multiline-data.sse");
    const cut = whole.indexOf(0xc3) + 1;
    expect(run("multiline-data.sse", cut).state.content).toBe("Héllo");
  });

  test("moves through connecting, processing, thinking, and answering", () => {
    const framer = newFramer();
    const state = newStreamState();
    expect(state.phase).toBe("connecting");
    consume(framer, state, new TextEncoder().encode(": OPENROUTER PROCESSING\n\n"));
    expect(state.phase).toBe("processing");
    consume(framer, state, new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning":"hm"}}]}\n\n'));
    expect(state.phase).toBe("thinking");
    expect(state.reasoning).toBe("hm");
    consume(framer, state, new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
    expect(state.phase).toBe("answering");
  });

  test("reasoning is kept apart from content", () => {
    const { state } = run("reasoning.sse");
    expect(state.reasoning).toBe("Let me think.");
    expect(state.content).toBe("42");
  });

  test("url_citation annotations are collected once and the length finish reason is kept", () => {
    const { state } = run("annotations.sse");
    expect(state.annotations).toHaveLength(1);
    expect(state.annotations[0]!.type).toBe("url_citation");
    expect(state.finishReason).toBe("length");
  });

  test("an error-only stream is an api error with empty content", () => {
    const { state } = run("error-only.sse");
    expect(state.error).toEqual({ kind: "api", message: "Provider disconnected unexpectedly", code: "server_error" });
    expect(state.content).toBe("");
    expect(state.finishReason).toBe("error");
    expect(state.doneSeen).toBe(false);
  });

  test("an unparsable event is a protocol error, never skipped", () => {
    const { state } = run("garbage.sse");
    expect(state.error?.kind).toBe("protocol");
  });

  test("a stream cut before its blank line reports truncated", () => {
    const framer = newFramer();
    const state = newStreamState();
    consume(framer, state, new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n'));
    expect(state.content).toBe("");
    expect(finish(framer)).toEqual({ truncated: true });
  });

  test("the first error wins and the state is JSON-serializable", () => {
    const framer = newFramer();
    const state = newStreamState();
    consume(framer, state, new TextEncoder().encode('data: {"error":{"message":"first"}}\n\ndata: {"error":{"message":"second"}}\n\n'));
    expect(state.error?.message).toBe("first");
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});
