import { describe, expect, test } from "bun:test";
import { newId } from "../src/core/ids";
import { formatSize, renderLastReply, renderTranscript } from "../src/core/transcript";
import { BunHost } from "../src/host/bun";
import type { Chat, Message } from "../src/store/chats";

const base = (): Chat => ({
  schema: 1, id: "c", title: "t", titleSource: "auto", createdAt: 1, updatedAt: 1, revision: 1, model: null, pinned: false, archived: false,
  settings: { web: false, showReasoning: false, effort: null, pdfEngine: null }, pending: [], retry: null, messages: [],
});
const msg = (over: Partial<Message>): Message => ({ id: "m", requestId: "r", role: "assistant", content: "", attachments: [], status: "ok", createdAt: 1, ...over });

describe("transcript", () => {
  test("renders headings, attachment lines, reasoning quotes, and deduplicated sources", () => {
    const chat = base();
    chat.messages = [
      msg({ role: "user", content: "What is in this?", attachments: [{ name: "shot.png", kind: "image", mime: "image/png", size: 2048, sha: "s", file: "attachments/s.png" }] }),
      msg({
        content: "A cat.",
        reasoning: "Looking.\n\nIt has ears.",
        annotations: [
          { type: "url_citation", url_citation: { url: "https://a.example", title: "A" } },
          { type: "url_citation", url_citation: { url: "https://a.example", title: "A again" } },
          { type: "url_citation", url_citation: { url: "https://b.example", title: "" } },
        ],
      }),
    ];
    const text = renderTranscript(chat);
    expect(text).toContain("# 🧑 You\n\nWhat is in this?\n\n📎 shot.png (2 KB)");
    expect(text).toContain("# 🤖 Assistant\n\n> Looking.\n>\n> It has ears.\n\nA cat.");
    expect(text.match(/\(https:\/\/a\.example\)/g)).toHaveLength(1);
    expect(text).toContain("- [https://b.example](https://b.example)");
  });

  test("marks interrupted and stopped replies, and the last reply drops its heading", () => {
    const chat = base();
    chat.messages = [msg({ content: "part", status: "interrupted", error: "Connection lost" }), msg({ id: "n", content: "half", status: "stopped" })];
    expect(renderTranscript(chat)).toContain("_⚠ Interrupted: Connection lost.");
    expect(renderTranscript(chat)).toContain("_■ Stopped.");
    expect(renderLastReply(chat).startsWith("half")).toBe(true);
    expect(renderLastReply(base())).toBe("");
  });

  test("sizes and sortable ids", () => {
    expect(formatSize(12)).toBe("12 B");
    expect(formatSize(1536)).toBe("2 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
    const early = new BunHost();
    const first = newId(early);
    early.sleepMs(3);
    expect(newId(early) > first).toBe(true);
  });
});
