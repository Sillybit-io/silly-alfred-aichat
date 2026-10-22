import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodeUtf8 } from "../src/core/utf8";
import { feed, finish, newFramer, type SseEvent } from "../src/core/sse";

const dir = resolve(import.meta.dir, "fixtures/sse");
const bytes = (text: string) => Uint8Array.from(Buffer.from(text, "utf8"));

function collect(chunks: Uint8Array[]) {
  const state = newFramer();
  const events: SseEvent[] = [];
  for (const chunk of chunks) events.push(...feed(state, chunk));
  return { events, state };
}

describe("decodeUtf8", () => {
  test("decodes two, three, and four byte sequences", () => {
    expect(decodeUtf8(bytes("é€👋"))).toBe("é€👋");
  });
  test("replaces ill-formed bytes and never throws", () => {
    expect(decodeUtf8(Uint8Array.from([0x61, 0xc0, 0x62, 0xff, 0xe2, 0x82, 0x63]))).toBe("a�b��c");
    expect(decodeUtf8(Uint8Array.from([0xed, 0xa0, 0x80]))).toBe("���");
  });
});

describe("sse framer", () => {
  test("every fixture split at every byte position gives the same events as one whole feed", () => {
    for (const file of readdirSync(dir)) {
      const whole = new Uint8Array(readFileSync(join(dir, file)));
      const expected = collect([whole]).events;
      for (let cut = 0; cut <= whole.length; cut++) {
        const split = collect([whole.subarray(0, cut), whole.subarray(cut)]);
        expect(split.events).toEqual(expected);
      }
      const singles = collect(Array.from(whole, (b) => Uint8Array.of(b)));
      expect(singles.events).toEqual(expected);
    }
  });

  test("LF, CR, and CRLF framings agree", () => {
    const lf = collect([new Uint8Array(readFileSync(join(dir, "ok.sse")))]).events;
    expect(collect([new Uint8Array(readFileSync(join(dir, "ok-crlf.sse")))]).events).toEqual(lf);
    expect(collect([new Uint8Array(readFileSync(join(dir, "ok-cr.sse")))]).events).toEqual(lf);
    expect(lf.filter((e) => e.type === "keepalive")).toHaveLength(2);
  });

  test("a trailing CR is held for a possible LF", () => {
    const state = newFramer();
    expect(feed(state, bytes("data: a\r\n\r"))).toEqual([{ type: "data", data: "a" }]);
    expect(feed(state, bytes("\ndata: b\r\r"))).toEqual([{ type: "data", data: "b" }]);
  });

  test("dispatches only on a blank line and joins data fields with LF", () => {
    const state = newFramer();
    expect(feed(state, bytes("data: one\ndata: two\n"))).toEqual([]);
    expect(feed(state, bytes("\n"))).toEqual([{ type: "data", data: "one\ntwo" }]);
  });

  test("strips exactly one leading space and ignores other fields", () => {
    const { events } = collect([bytes("event: x\nid: 1\ndata:  two spaces\n\ndata:none\n\ndata\n\n")]);
    expect(events).toEqual([
      { type: "data", data: " two spaces" },
      { type: "data", data: "none" },
      { type: "data", data: "" },
    ]);
  });

  test("decodes a multi-byte character cut between reads", () => {
    const all = bytes("data: é\n\n");
    const cut = all.indexOf(0xc3) + 1;
    const { events } = collect([all.subarray(0, cut), all.subarray(cut)]);
    expect(events).toEqual([{ type: "data", data: "é" }]);
  });

  test("an event cut before its blank line is reported as truncated and not dispatched", () => {
    const { events, state } = collect([bytes('data: {"a":1}\n')]);
    expect(events).toEqual([]);
    expect(finish(state)).toEqual({ truncated: true });
    const partial = collect([bytes("data: {")]);
    expect(finish(partial.state)).toEqual({ truncated: true });
    expect(finish(collect([bytes("data: x\n\n")]).state)).toEqual({ truncated: false });
  });

  test("the framer state survives a JSON round trip between runs", () => {
    const state = newFramer();
    feed(state, bytes("data: par"));
    const revived = JSON.parse(JSON.stringify(state));
    expect(feed(revived, bytes("tial\n\n"))).toEqual([{ type: "data", data: "partial" }]);
  });
});
