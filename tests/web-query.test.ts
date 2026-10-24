import { describe, expect, test } from "bun:test";
import { cleanRewrite, rewriteTurns } from "../src/core/web-query";
import { standaloneMessage } from "../src/store/web-query";
import { BunHost } from "../src/host/bun";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SAME = { text: null, failed: null };
const history = [
  { role: "user" as const, content: "how is weather in New york right now?" },
  { role: "assistant" as const, content: "Sunny, 64°F." },
];

describe("standalone web messages", () => {
  test("the prompt carries the conversation and the new message", () => {
    const turns = rewriteTurns(history, "What about tomorrow?");
    expect(turns[0]!.role).toBe("system");
    expect(turns[1]!.content).toContain("User: how is weather in New york right now?");
    expect(turns[1]!.content).toContain("Assistant: Sunny, 64°F.");
    expect(turns[1]!.content).toEndWith("Last message:\nWhat about tomorrow?");
  });

  test("replies are trimmed of quotes and labels, and unchanged or runaway replies are dropped", () => {
    expect(cleanRewrite('"What is the weather in New York tomorrow?"', "What about tomorrow?")).toBe("What is the weather in New York tomorrow?");
    expect(cleanRewrite("Rewritten message: Weather in New York tomorrow", "What about tomorrow?")).toBe("Weather in New York tomorrow");
    expect(cleanRewrite("What about tomorrow?", "What about tomorrow?")).toBeNull();
    expect(cleanRewrite("", "x")).toBeNull();
    expect(cleanRewrite("y".repeat(900), "short")).toBeNull();
  });

  function host(handler: (argv: string[]) => { exit: number; stdout: string; stderr: string }) {
    const dir = mkdtempSync(join(tmpdir(), "aichat-wq-"));
    const calls: string[][] = [];
    class Fake extends BunHost {
      override runSync(argv: string[]) {
        calls.push(argv);
        return handler(argv);
      }
    }
    return { dir, calls, host: new Fake({ env: { alfred_workflow_data: dir, alfred_workflow_cache: dir, aichat_api_base: "http://127.0.0.1:1/v1" } }) };
  }
  const reply = (content: string) => ({ exit: 0, stdout: JSON.stringify({ choices: [{ message: { content } }] }), stderr: "" });

  test("a follow-up becomes a standalone message through one small request", () => {
    const { host: h, calls } = host(() => reply("What is the weather in New York tomorrow?"));
    expect(standaloneMessage(h, "k", "standard", "m", history, "What about tomorrow?")).toEqual({ text: "What is the weather in New York tomorrow?", failed: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("http://127.0.0.1:1/v1/chat/completions");
  });

  test("no history, a long message, or a missing model sends nothing", () => {
    const { host: h, calls } = host(() => reply("x"));
    expect(standaloneMessage(h, "k", "standard", "m", [], "What about tomorrow?")).toEqual(SAME);
    expect(standaloneMessage(h, "k", "standard", "m", history, "z".repeat(600))).toEqual(SAME);
    expect(standaloneMessage(h, "k", "standard", "", history, "What about tomorrow?")).toEqual(SAME);
    expect(calls).toHaveLength(0);
  });

  test("a failed, timed-out, or garbled request returns null and leaves no body file behind", () => {
    for (const result of [{ exit: 28, stdout: "", stderr: "" }, { exit: 0, stdout: "<html>", stderr: "" }, { exit: 0, stdout: JSON.stringify({ error: { message: "no" } }), stderr: "" }]) {
      const { host: h, dir } = host(() => result);
      const outcome = standaloneMessage(h, "k", "standard", "m", history, "What about tomorrow?");
      expect(outcome.text).toBeNull();
      expect(outcome.failed).not.toBeNull();
      expect(readdirSync(join(dir, "web-query")).length).toBe(0);
    }
  });

  test("a provider error that repeats the conversation is not written to the log", () => {
    const logs: string[] = [];
    const { host: h } = host(() => ({ exit: 0, stdout: JSON.stringify({ error: { message: "Bad request: my secret diary entry about Alice" } }), stderr: "" }));
    const original = h.log.bind(h);
    h.log = (message: string) => (logs.push(message), original(message));
    const outcome = standaloneMessage(h, "k", "standard", "m", history, "What about tomorrow?");
    expect(outcome.failed).toBe("the provider returned an error");
    expect(logs.join("\n")).not.toContain("diary");
  });
});
