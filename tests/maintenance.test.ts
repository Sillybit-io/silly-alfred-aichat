import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunHost } from "../src/host/bun";
import { createChat, getChat } from "../src/store/chats";
import { runMaintenance } from "../src/store/maintenance";
import { admit, finalizeDue, requestDir } from "../src/store/requests";

const work = mkdtempSync(join(tmpdir(), "aichat-maintenance-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let counter = 0;
function fresh() {
  const dir = join(work, `case-${counter++}`);
  const data = join(dir, "data");
  const cache = join(dir, "cache");
  mkdirSync(data, { recursive: true });
  mkdirSync(cache, { recursive: true });
  const host = new BunHost({ env: { alfred_workflow_data: data, alfred_workflow_cache: cache }, onLog: () => {} });
  return { dir, data, cache, host };
}
const mode = (path: string) => statSync(path).mode & 0o777;
const ago = (path: string, ms: number) => utimesSync(path, new Date(Date.now() - ms), new Date(Date.now() - ms));

describe("first run after an update", () => {
  test("existing data becomes private, the icon cache of the removed feature goes, and it happens once", () => {
    const { data, cache, host } = fresh();
    mkdirSync(join(data, "chats/abc"), { recursive: true });
    writeFileSync(join(data, "chats/abc/chat.json"), "{}");
    mkdirSync(join(cache, "favicons"));
    writeFileSync(join(cache, "favicons/x.png"), "png");
    writeFileSync(join(cache, "models.json"), "{}");
    for (const path of [data, join(data, "chats"), join(data, "chats/abc"), cache]) chmodSync(path, 0o755);
    for (const path of [join(data, "chats/abc/chat.json"), join(cache, "models.json")]) chmodSync(path, 0o644);

    runMaintenance(host);
    expect([mode(data), mode(join(data, "chats")), mode(join(data, "chats/abc")), mode(join(data, "chats/abc/chat.json")), mode(cache), mode(join(cache, "models.json"))]).toEqual([0o700, 0o700, 0o700, 0o600, 0o700, 0o600]);
    expect(existsSync(join(cache, "favicons"))).toBe(false);

    chmodSync(join(data, "chats/abc/chat.json"), 0o644);
    runMaintenance(host);
    expect(mode(join(data, "chats/abc/chat.json"))).toBe(0o644);
  });

  test("a broken data folder is logged and never stops the workflow", () => {
    const logs: string[] = [];
    const host = new BunHost({ env: {}, onLog: (message) => logs.push(message) });
    expect(() => runMaintenance(host)).not.toThrow();
    expect(logs[0]).toContain("maintenance failed");
  });
});

describe("leftover request folders", () => {
  const HOUR = 3_600_000;
  function request(data: string, id: string, record: Record<string, unknown> | string | null, ageMs: number, lane = true) {
    const dir = join(data, "requests", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "body.json"), '{"messages":[{"content":"private"}]}');
    if (record !== null) writeFileSync(join(dir, "request.json"), typeof record === "string" ? record : JSON.stringify(record));
    if (lane && record !== null && typeof record !== "string") {
      mkdirSync(join(data, "lanes"), { recursive: true });
      writeFileSync(join(data, "lanes", String(record.lane)), id);
    }
    ago(dir, ageMs);
    return dir;
  }
  const base = (id: string, extra: Record<string, unknown>) => ({ id, lane: `chat:${id}`, final: false, state: "open", startedAt: Date.now() - 2 * HOUR, lastGrowthAt: Date.now(), ...extra });

  test("finalized, orphaned, unreadable, and unreachable ones are deleted; running, fresh, and finished-unsaved ones stay", () => {
    const { data, host } = fresh();
    const gone = [
      request(data, "finalized", base("finalized", { final: true }), 2 * HOUR),
      request(data, "orphan", null, 2 * HOUR),
      request(data, "malformed", {}, 2 * HOUR),
      request(data, "garbage", "not json", 2 * HOUR),
      request(data, "unreachable", base("unreachable", {}), 30 * HOUR, false),
    ];
    const kept = [
      request(data, "running", base("running", { startedAt: Date.now() - 40 * HOUR }), 2 * HOUR),
      request(data, "fresh", base("fresh", { final: true }), 0),
      request(data, "just-made", null, 0),
      request(data, "unsaved", base("unsaved", { startedAt: Date.now() - 80 * HOUR, state: "done" }), 80 * HOUR),
    ];
    runMaintenance(host);
    expect(gone.map(existsSync)).toEqual([false, false, false, false, false]);
    expect(kept.map(existsSync)).toEqual([true, true, true, true]);
  });

  test("the sweep runs at most once an hour", () => {
    const { data, host } = fresh();
    runMaintenance(host);
    const old = request(data, "late", null, 2 * HOUR);
    runMaintenance(host);
    expect(existsSync(old)).toBe(true);
    ago(join(data, ".swept"), 2 * HOUR);
    runMaintenance(host);
    expect(existsSync(old)).toBe(false);
  });

  test("a reply that finished days ago, while the window was closed, is still saved into the chat when you come back", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response('data: {"choices":[{"delta":{"content":"The reply you never saw"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) });
    try {
      const { data, cache } = fresh();
      const host = new BunHost({ env: { PATH: process.env.PATH, alfred_workflow_data: data, alfred_workflow_cache: cache, aichat_api_base: `http://127.0.0.1:${server.port}/v1` }, onLog: () => {} });
      const chat = createChat(host);
      const result = admit(host, { lane: `chat:${chat.id}`, kind: "chat", chatId: chat.id, model: "m", draft: { text: "hello", attachments: [] }, body: '{"model":"m","messages":[]}', url: `http://127.0.0.1:${server.port}/v1/chat/completions`, apiKey: "sk-test-key", stream: true, timeoutSeconds: 30 });
      if (!result.ok) throw new Error("busy");
      const dir = requestDir(host, result.rid);
      for (let i = 0; i < 250 && !existsSync(join(dir, "exit")); i++) await Bun.sleep(20);
      expect(existsSync(join(dir, "exit"))).toBe(true);
      expect(existsSync(join(dir, "body.json"))).toBe(false);

      const record = JSON.parse(readFileSync(join(dir, "request.json"), "utf8"));
      record.startedAt -= 80 * HOUR;
      writeFileSync(join(dir, "request.json"), JSON.stringify(record));
      ago(dir, 80 * HOUR);

      runMaintenance(host);
      expect(existsSync(dir)).toBe(true);
      finalizeDue(host, {});
      expect(getChat(host, chat.id)!.messages.map((message) => message.content)).toEqual(["hello", "The reply you never saw"]);
      expect(existsSync(dir)).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});

describe("when it runs", () => {
  test("every script entry passes its host through maintenance, so a preset-only first launch is covered too", () => {
    const entries = readdirSync(join(import.meta.dir, "../src/entries")).filter((name) => name.endsWith(".ts"));
    expect(entries.length).toBeGreaterThanOrEqual(16);
    for (const name of entries) expect(readFileSync(join(import.meta.dir, "../src/entries", name), "utf8"), name).toContain("main(maintained(createJxaHost()), argv)");
  });

  test("once it has run and the sweep is fresh, a run costs two checks and touches nothing", () => {
    const { data, host } = fresh();
    runMaintenance(host);
    chmodSync(data, 0o755);
    runMaintenance(host);
    expect(mode(data)).toBe(0o755);
  });
});

describe("failures", () => {
  test("a tree that could not be tightened is not recorded as done, and the next run tries again", () => {
    const { data, cache } = fresh();
    let broken = true;
    const host = new (class extends BunHost {
      override restrict(path: string): void {
        if (broken) throw new Error("not permitted");
        super.restrict(path);
      }
    })({ env: { alfred_workflow_data: data, alfred_workflow_cache: cache }, onLog: () => {} });
    runMaintenance(host);
    expect(existsSync(join(data, ".private-v1"))).toBe(false);
    expect(host.logs.join("\n")).toContain("maintenance failed");
    broken = false;
    runMaintenance(host);
    expect(existsSync(join(data, ".private-v1"))).toBe(true);
  });
});
