import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BunHost } from "../src/host/bun";
import { LOCK_STALE_MS, LockTimeoutError, withLock } from "../src/store/lock";
import {
  NotFoundError,
  chatDir,
  clearCurrent,
  createChat,
  getChat,
  getCurrent,
  listSummaries,
  mutateChat,
  pruneChats,
  setCurrent,
  setTitleIfAuto,
  setTitleManual,
  type Message,
} from "../src/store/chats";
import { getSettings, setDefaultModel, toggleFavorite } from "../src/store/settings";

const roots: string[] = [];
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "aichat-chats-"));
  roots.push(dir);
  const host = new BunHost({ env: { alfred_workflow_data: join(dir, "data"), alfred_workflow_cache: join(dir, "cache") } });
  return { dir, host };
}
afterAll(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const message = (id: string, content = id): Message => ({ id, requestId: id, role: "user", content, attachments: [], status: "ok", createdAt: 1 });

describe("locks", () => {
  test("serialize a critical section and always release", () => {
    const { dir, host } = fresh();
    const lock = join(dir, "x.lock");
    expect(withLock(host, lock, () => host.exists(lock))).toBe(true);
    expect(host.exists(lock)).toBe(false);
    expect(() => withLock(host, lock, () => { throw new Error("boom"); })).toThrow("boom");
    expect(host.exists(lock)).toBe(false);
  });

  test("a lock held longer than 30 s is broken by moving it aside; a fresh one times out", () => {
    const { dir, host } = fresh();
    const stale = join(dir, "stale.lock");
    mkdirSync(stale);
    writeFileSync(join(stale, "owner"), `dead\n${Date.now() - LOCK_STALE_MS - 1000}`);
    expect(withLock(host, stale, () => "got it")).toBe("got it");
    expect(readdirSync(dir).filter((name) => name.includes("stale"))).toEqual([]);

    const held = join(dir, "held.lock");
    mkdirSync(held);
    writeFileSync(join(held, "owner"), `other\n${Date.now()}`);
    expect(() => withLock(host, held, () => 1)).toThrow(LockTimeoutError);
    expect(existsSync(held)).toBe(true);
  });
});

describe("chats", () => {
  test("two bun processes each make 50 mutations on one chat: revision 100 and all 100 messages", async () => {
    const { dir, host } = fresh();
    const chat = createChat(host);
    const worker = resolve(import.meta.dir, "fixtures/store/mutate-worker.ts");
    const run = (label: string) => Bun.spawn(["bun", worker, join(dir, "data"), chat.id, "50", label], { stdout: "pipe", stderr: "pipe" });
    const [a, b] = [run("a"), run("b")];
    const codes = await Promise.all([a.exited, b.exited]);
    expect(codes).toEqual([0, 0]);
    const result = getChat(host, chat.id)!;
    expect(result.revision).toBe(100);
    expect(result.messages).toHaveLength(100);
    expect(new Set(result.messages.map((m) => m.id)).size).toBe(100);
  });

  test("a stale title result after an appended message and a manual title changes neither", () => {
    const { host } = fresh();
    const chat = createChat(host);
    mutateChat(host, chat.id, (c) => { c.messages.push(message("m1")); });
    setTitleManual(host, chat.id, "Mine");
    const result = setTitleIfAuto(host, chat.id, "Auto title from a slow job");
    expect(result.title).toBe("Mine");
    expect(getChat(host, chat.id)!.messages.map((m) => m.id)).toEqual(["m1"]);
    const second = createChat(host);
    expect(setTitleIfAuto(host, second.id, "Auto").title).toBe("Auto");
  });

  test("deleting the folder between a mutation's read and write raises NotFound and recreates nothing", () => {
    const { host } = fresh();
    const chat = createChat(host);
    expect(() =>
      mutateChat(host, chat.id, (c) => {
        host.remove(chatDir(host, chat.id));
        c.messages.push(message("late"));
      }),
    ).toThrow(NotFoundError);
    expect(host.exists(chatDir(host, chat.id))).toBe(false);
    expect(() => mutateChat(host, chat.id, () => {})).toThrow(NotFoundError);
    expect(host.exists(chatDir(host, chat.id))).toBe(false);
  });

  test("prune with retention 1 day keeps a pinned 10-day-old chat and an active one, and deletes an idle unpinned one", () => {
    const { host } = fresh();
    const old = host.nowMs() - 10 * 86_400_000;
    const make = (flags: { pinned?: boolean }) => {
      const chat = createChat(host);
      mutateChat(host, chat.id, (c) => { c.pinned = flags.pinned ?? false; });
      const path = `${chatDir(host, chat.id)}/chat.json`;
      const raw = JSON.parse(host.readText(path));
      raw.updatedAt = old;
      host.writeAtomic(path, JSON.stringify(raw));
      return chat.id;
    };
    const pinned = make({ pinned: true });
    const active = make({});
    const idle = make({});
    const recent = createChat(host).id;
    const pruned = pruneChats(host, 1, 0, new Set([active]));
    expect(pruned).toEqual([idle]);
    expect(host.exists(chatDir(host, pinned))).toBe(true);
    expect(host.exists(chatDir(host, active))).toBe(true);
    expect(host.exists(chatDir(host, recent))).toBe(true);
    expect(host.exists(chatDir(host, idle))).toBe(false);
  });

  test("prune by count keeps the newest and never touches pinned chats", () => {
    const { host } = fresh();
    const ids = [1, 2, 3, 4].map(() => createChat(host).id);
    host.sleepMs(5);
    mutateChat(host, ids[0]!, (c) => { c.pinned = true; });
    const pruned = pruneChats(host, 0, 2, []);
    expect(pruned.length).toBe(2);
    expect(host.exists(chatDir(host, ids[0]!))).toBe(true);
  });

  test("current pointer: cleared when its folder is gone", () => {
    const { host, dir } = fresh();
    expect(getCurrent(host)).toBeNull();
    const chat = createChat(host);
    setCurrent(host, chat.id);
    expect(getCurrent(host)).toBe(chat.id);
    renameSync(chatDir(host, chat.id), join(dir, "elsewhere"));
    expect(getCurrent(host)).toBeNull();
    expect(host.exists(join(dir, "data", "current"))).toBe(false);
    clearCurrent(host);
  });

  test("summaries are newest first and carry a preview; unreadable folders are skipped", () => {
    const { host } = fresh();
    const a = createChat(host);
    host.sleepMs(3);
    const b = createChat(host);
    host.sleepMs(3);
    mutateChat(host, a.id, (c) => { c.messages.push(message("m", "hello   there\nworld")); });
    mkdirSync(`${chatDir(host, "garbage")}`);
    const summaries = listSummaries(host);
    expect(summaries.map((s) => s.id)).toEqual([a.id, b.id]);
    expect(summaries[0]!.preview).toBe("hello there world");
  });

  test("a chat file never holds an API key or a usage figure", () => {
    const { host } = fresh();
    const chat = createChat(host);
    const text = host.readText(`${chatDir(host, chat.id)}/chat.json`);
    expect(text).not.toMatch(/api_key|usage|cost|token/i);
  });
});

describe("settings", () => {
  test("default model, favorites, and last model persist under their lock", () => {
    const { host } = fresh();
    expect(getSettings(host)).toEqual({ schema: 1, defaultModel: null, lastModel: null, favorites: [] });
    setDefaultModel(host, "a/b");
    expect(toggleFavorite(host, "x/y").favorite).toBe(true);
    expect(toggleFavorite(host, "x/y").favorite).toBe(false);
    toggleFavorite(host, "p/q");
    expect(getSettings(host)).toEqual({ schema: 1, defaultModel: "a/b", lastModel: null, favorites: ["p/q"] });
  });
});
