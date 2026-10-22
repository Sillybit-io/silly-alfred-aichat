import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnvFile } from "../scripts/dev";
import { main as chat } from "../src/app/chat";
import { composeSystemPrompt, contextLine, formatNow, WEB_LINE } from "../src/core/system-prompt";
import { readConfig } from "../src/features/index";
import { BunHost } from "../src/host/bun";
import { readContextInfo } from "../src/store/system-context";
import { DEFAULT_SYSTEM_PROMPT } from "../scripts/workflow";

const repo = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "aichat-system-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("system prompt text", () => {
  const info = { nowMs: Date.UTC(2026, 9, 22, 13, 40), offsetMinutes: -180, timezone: "Europe/Istanbul", locale: "en_US", os: "14.5" };

  test("the date is formatted from the clock and offset alone", () => {
    expect(formatNow(info)).toBe("Thursday, 22 October 2026, 16:40 (UTC+03:00, Europe/Istanbul)");
    expect(formatNow({ ...info, offsetMinutes: 330, timezone: null })).toBe("Thursday, 22 October 2026, 08:10 (UTC-05:30)");
    expect(formatNow({ ...info, offsetMinutes: 0, timezone: "UTC" })).toBe("Thursday, 22 October 2026, 13:40 (UTC+00:00, UTC)");
    expect(contextLine(info)).toBe("Current date and time: Thursday, 22 October 2026, 16:40 (UTC+03:00, Europe/Istanbul). The user's locale is en_US. The user is on macOS 14.5.");
    expect(contextLine({ ...info, locale: null, os: null })).toBe("Current date and time: Thursday, 22 October 2026, 16:40 (UTC+03:00, Europe/Istanbul).");
  });

  test("the parts become paragraphs and empty parts disappear", () => {
    expect(composeSystemPrompt({ base: " Be brief. ", context: "Now.", web: true })).toBe(`Be brief.\n\nNow.\n\n${WEB_LINE}`);
    expect(composeSystemPrompt({ base: "", context: null, web: false })).toBe("");
    expect(composeSystemPrompt({ base: "", context: "Now.", web: false })).toBe("Now.");
  });

  test("the shipped default is a real prompt, not one sentence", () => {
    expect(DEFAULT_SYSTEM_PROMPT.length).toBeGreaterThan(300);
    for (const rule of ["concise", "Markdown", "clarifying question", "do not know"]) expect(DEFAULT_SYSTEM_PROMPT).toContain(rule);
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/\$|token|credit|cost/i);
  });
});

describe("context lookup", () => {
  test("locale, OS, and timezone are read once and cached for an hour", () => {
    const dir = join(work, "lookup");
    mkdirSync(join(dir, "cache"), { recursive: true });
    const calls: string[] = [];
    const host = new BunHost({
      env: { alfred_workflow_cache: join(dir, "cache") },
      fakeCommands: {
        readlink: () => (calls.push("readlink"), { exit: 0, stdout: "/var/db/timezone/zoneinfo/Europe/Istanbul\n", stderr: "" }),
        defaults: () => (calls.push("defaults"), { exit: 0, stdout: "en_US\n", stderr: "" }),
        sw_vers: () => (calls.push("sw_vers"), { exit: 0, stdout: "14.5\n", stderr: "" }),
      },
    });
    const first = readContextInfo(host);
    expect([first.timezone, first.locale, first.os]).toEqual(["Europe/Istanbul", "en_US", "14.5"]);
    readContextInfo(host);
    expect(calls).toEqual(["readlink", "defaults", "sw_vers"]);
  });

  test("a machine without those tools still gets a date line", () => {
    const dir = join(work, "missing");
    mkdirSync(join(dir, "cache"), { recursive: true });
    const host = new BunHost({ env: { alfred_workflow_cache: join(dir, "cache"), PATH: "/nonexistent" }, fakeCommands: { readlink: () => ({ exit: 1, stdout: "", stderr: "" }) } });
    const info = readContextInfo(host);
    expect(info.timezone).toBeNull();
    expect(contextLine(info)).toContain("Current date and time:");
  });
});

describe("in a request", () => {
  async function send(extra: Record<string, string>, setup?: (host: BunHost) => void) {
    const dir = join(work, `send-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, "data"), { recursive: true });
    mkdirSync(join(dir, "cache"), { recursive: true });
    writeFileSync(join(dir, "cache/models.json"), JSON.stringify({ fetchedAt: Date.now(), models: [] }));
    const bodies: any[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) { bodies.push(JSON.parse(await request.text())); return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }); } });
    try {
      const env = { PATH: process.env.PATH, ...parseEnvFile(join(repo, "tests/fixtures/dev.env")), alfred_workflow_data: join(dir, "data"), alfred_workflow_cache: join(dir, "cache"), aichat_api_base: `http://127.0.0.1:${server.port}/v1`, ...extra };
      const host = new BunHost({ env, fakeCommands: { readlink: () => ({ exit: 0, stdout: "/zoneinfo/Europe/Istanbul", stderr: "" }), defaults: () => ({ exit: 0, stdout: "en_US", stderr: "" }), sw_vers: () => ({ exit: 0, stdout: "14.5", stderr: "" }) } });
      setup?.(host);
      const out = JSON.parse(chat(host, ["hi"]));
      for (let i = 0; i < 100 && bodies.length === 0; i++) await Bun.sleep(30);
      expect(out.variables.request_id).not.toBe("");
      return bodies[0];
    } finally {
      server.stop(true);
    }
  }

  test("the system message holds the configured prompt and, unless turned off, the live context", async () => {
    const body = await send({ system_prompt: "Be brief.", system_context: "1" });
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toMatch(/^Be brief\.\n\nCurrent date and time: \w+, \d+ \w+ \d{4}, \d\d:\d\d \(UTC[+-]\d\d:\d\d, Europe\/Istanbul\)\. The user's locale is en_US\. The user is on macOS 14\.5\.$/);
    const off = await send({ system_prompt: "Be brief.", system_context: "0" });
    expect(off.messages[0].content).toBe("Be brief.");
    const none = await send({ system_prompt: "", system_context: "0" });
    expect(none.messages.map((m: any) => m.role)).toEqual(["user"]);
  });

  test("with web search on the citation rule is added", async () => {
    const body = await send({ system_prompt: "Be brief.", system_context: "0", web_default: "1" });
    expect(body.messages[0].content).toBe(`Be brief.\n\n${WEB_LINE}`);
    expect(readConfig(new BunHost({ env: {} })).systemContext).toBe(true);
  });
});
