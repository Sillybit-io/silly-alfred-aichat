import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnvFile } from "../scripts/dev";
import { main as chat } from "../src/app/chat";
import { main as historyAction } from "../src/app/history-action";
import { main as history } from "../src/app/history";
import { cleanTitle, fileSafe, relativeTime } from "../src/core/titles";
import { allCommands, features, readConfig, type CommandOutcome } from "../src/features/index";
import { BunHost } from "../src/host/bun";
import { chatDir, createChat, getChat, getCurrent, mutateChat, setCurrent, setTitleManual } from "../src/store/chats";
import { currentChat, ensureCurrentChat } from "../src/store/current-chat";
import type { RequestRecord, Outcome } from "../src/store/requests";

const root = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "aichat-history-"));
const encoder = new TextEncoder();
const frame = (data: unknown) => encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);

let bodies: any[] = [];
let titleReply = '{"choices":[{"message":{"role":"assistant","content":"\\"Greeting Chat Opener.\\""}}]}';
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const body = JSON.parse(await request.text());
      bodies.push(body);
      if (body.stream === false) return new Response(titleReply, { headers: { "content-type": "application/json" } });
      return new Response(new ReadableStream({ start(c) { c.enqueue(frame({ choices: [{ delta: { content: "Hello there" }, finish_reason: null }] })); c.enqueue(frame("[DONE]")); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
    },
  });
});
afterAll(() => {
  server.stop(true);
  rmSync(work, { recursive: true, force: true });
});

let counter = 0;
function fresh(extra: Record<string, string> = {}) {
  const dir = join(work, `case-${counter++}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "cache"), { recursive: true });
  mkdirSync(join(dir, "home"));
  writeFileSync(join(dir, "cache/models.json"), JSON.stringify({ fetchedAt: Date.now(), models: [] }));
  const env = { PATH: process.env.PATH, HOME: join(dir, "home"), ...parseEnvFile(join(root, "tests/fixtures/dev.env")), alfred_workflow_data: join(dir, "data"), alfred_workflow_cache: join(dir, "cache"), aichat_api_base: `http://127.0.0.1:${server.port}/v1`, export_folder: "~/Exports", auto_titles: "1", ...extra };
  const session: Record<string, string> = {};
  return { dir, session, host: (more: Record<string, string> = {}) => new BunHost({ env: { ...env, ...session, ...more } }) };
}
type Ctx = ReturnType<typeof fresh>;
const parse = (text: string) => JSON.parse(text);
const items = (ctx: Ctx, query = "") => parse(history(ctx.host(), [query])).items as any[];

function seed(ctx: Ctx, title: string, flags: { pinned?: boolean; archived?: boolean; ageDays?: number; manual?: boolean } = {}) {
  const host = ctx.host();
  const created = createChat(host, { title });
  mutateChat(host, created.id, (c) => {
    c.pinned = flags.pinned ?? false;
    c.archived = flags.archived ?? false;
    c.titleSource = flags.manual ? "manual" : "auto";
    c.messages.push({ id: `${c.id}-u`, requestId: c.id, role: "user", content: `question for ${title}`, attachments: [], status: "ok", createdAt: 1 });
  });
  if (flags.ageDays !== undefined) {
    const path = `${chatDir(host, created.id)}/chat.json`;
    const raw = JSON.parse(host.readText(path));
    raw.updatedAt = host.nowMs() - flags.ageDays * 86_400_000;
    host.writeAtomic(path, JSON.stringify(raw));
  }
  return created.id;
}

describe("history list", () => {
  test("file items with the folder as arg, pinned first, archived hidden, and the three actions on the modifiers", () => {
    const ctx = fresh();
    const plain = seed(ctx, "Plain");
    const pinned = seed(ctx, "Pinned one", { pinned: true });
    seed(ctx, "Shelved", { archived: true });
    const list = items(ctx);
    expect(list.map((i) => i.title)).toEqual(["📌 Pinned one", "Plain"]);
    expect(list[0]).toMatchObject({ type: "file", arg: chatDir(ctx.host(), pinned), variables: { history_action: "open" } });
    expect(list[0].subtitle).toContain("1 messages");
    expect(list[0].subtitle).toContain("pinned");
    expect(list[1].mods.cmd).toMatchObject({ subtitle: "Archive this chat", variables: { history_action: "archive" }, arg: chatDir(ctx.host(), plain) });
    expect(list[0].mods.alt).toMatchObject({ subtitle: "Unpin this chat", variables: { history_action: "pin" } });
    expect(list[1].mods.ctrl).toMatchObject({ variables: { history_action: "delete" } });
    expect(items(ctx, "archived").map((i) => i.title)).toEqual(["Shelved"]);
    expect(items(ctx, "plai").map((i) => i.title)).toEqual(["Plain"]);
    expect(items(ctx, "zzz")[0]).toMatchObject({ title: "No chats match", valid: false });
  });

  test("an untitled chat shows its first message, and an empty list explains itself", () => {
    const ctx = fresh();
    expect(items(ctx)[0]).toMatchObject({ title: "No chats yet", valid: false });
    seed(ctx, "New chat");
    expect(items(ctx)[0].title).toBe("question for New chat");
  });
});

describe("history actions", () => {
  test("open sets current and asks for the view; archive and pin toggle and ask for the list; no path reaches the arg", () => {
    const ctx = fresh();
    const a = seed(ctx, "A");
    const b = seed(ctx, "B");
    const open = parse(historyAction(ctx.host({ history_action: "open" }), [chatDir(ctx.host(), a)])).alfredworkflow;
    expect(open).toEqual({ arg: "", variables: { history_next: "view", notice: "", request_id: "", view_stage: "" } });
    expect(getCurrent(ctx.host())).toBe(a);
    expect(parse(historyAction(ctx.host({ history_action: "archive" }), [chatDir(ctx.host(), b)])).alfredworkflow.variables.history_next).toBe("list");
    expect(getChat(ctx.host(), b)!.archived).toBe(true);
    historyAction(ctx.host({ history_action: "archive" }), [chatDir(ctx.host(), b)]);
    expect(getChat(ctx.host(), b)!.archived).toBe(false);
    historyAction(ctx.host({ history_action: "pin" }), [chatDir(ctx.host(), b)]);
    expect(getChat(ctx.host(), b)!.pinned).toBe(true);
  });

  test("delete removes the folder for good, clears current when it was current, and a vanished chat is handled", () => {
    const ctx = fresh();
    const a = seed(ctx, "A");
    setCurrent(ctx.host(), a);
    const out = parse(historyAction(ctx.host({ history_action: "delete" }), [`${chatDir(ctx.host(), a)}/`])).alfredworkflow;
    expect(out.variables.history_next).toBe("list");
    expect(existsSync(chatDir(ctx.host(), a))).toBe(false);
    expect(getCurrent(ctx.host())).toBeNull();
    const gone = parse(historyAction(ctx.host({ history_action: "open" }), [chatDir(ctx.host(), a)])).alfredworkflow;
    expect(gone.variables.notice).toContain("no longer exists");
    expect(existsSync(chatDir(ctx.host(), a))).toBe(false);
  });

  test("nothing is deleted unless the confirmation is accepted", () => {
    const ctx = fresh();
    const a = seed(ctx, "A");
    const asked: string[] = [];
    const declining = new BunHost({ env: { ...ctx.host().env, history_action: "delete" }, confirm: (message, action) => (asked.push(`${action}: ${message}`), false) });
    const out = parse(historyAction(declining, [chatDir(declining, a)])).alfredworkflow;
    expect(out.variables.notice).toBe("The chat was not deleted");
    expect(existsSync(chatDir(declining, a))).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("Delete: Delete “A” permanently?");
  });

  test("a delete that fails keeps the chat and the current pointer and says so", () => {
    const ctx = fresh();
    const a = seed(ctx, "A");
    setCurrent(ctx.host(), a);
    const failing = new (class extends BunHost {
      override remove(path: string): void {
        if (path.endsWith(`/chats/${a}`)) throw new Error("remove failed for " + path);
        super.remove(path);
      }
    })({ env: { ...ctx.host().env, history_action: "delete" }, onLog: () => {} });
    const out = parse(historyAction(failing, [chatDir(failing, a)])).alfredworkflow;
    expect(out.variables.notice).toBe("The chat could not be deleted");
    expect(existsSync(chatDir(failing, a))).toBe(true);
    expect(getCurrent(failing)).toBe(a);
  });

  test("a chat that is not current stays current when another is deleted", () => {
    const ctx = fresh();
    const keep = seed(ctx, "Keep");
    const drop = seed(ctx, "Drop");
    setCurrent(ctx.host(), keep);
    historyAction(ctx.host({ history_action: "delete" }), [chatDir(ctx.host(), drop)]);
    expect(getCurrent(ctx.host())).toBe(keep);
  });
});

describe("retention", () => {
  test("failure: retention of 7 days with a pinned and an unpinned 30-day-old chat deletes only the unpinned one", () => {
    const ctx = fresh({ retention_days: "7" });
    const pinned = seed(ctx, "Old pinned", { pinned: true, ageDays: 30 });
    const idle = seed(ctx, "Old idle", { ageDays: 30 });
    const fresher = seed(ctx, "Recent");
    items(ctx);
    expect(existsSync(chatDir(ctx.host(), pinned))).toBe(true);
    expect(existsSync(chatDir(ctx.host(), idle))).toBe(false);
    expect(existsSync(chatDir(ctx.host(), fresher))).toBe(true);
  });

  test("a chat with an open request is never pruned", async () => {
    const ctx = fresh({ retention_days: "1" });
    const id = seed(ctx, "Busy", { ageDays: 30 });
    const lanes = join(ctx.dir, "data/lanes");
    mkdirSync(lanes, { recursive: true });
    mkdirSync(join(ctx.dir, "data/requests/r1"), { recursive: true });
    writeFileSync(join(lanes, `chat:${id}`), "r1");
    const record = { schema: 1, id: "r1", lane: `chat:${id}`, kind: "chat", chatId: id, model: "m", draft: { text: "x", attachments: [] }, stream: true, timeoutSeconds: 90, startedAt: Date.now(), lastGrowthAt: Date.now(), offset: 0, framer: { line: [], pendingCr: false, data: [] }, reducer: { phase: "connecting", content: "", reasoning: "", annotations: [], finishReason: null, doneSeen: false, accountingSeen: false, error: null }, state: "open", final: false, error: null, curlExit: null, httpStatus: null, finalizeAttempts: 0, meta: {} };
    writeFileSync(join(ctx.dir, "data/requests/r1/request.json"), JSON.stringify(record));
    writeFileSync(join(ctx.dir, "data/requests/r1/pid"), String(process.pid));
    items(ctx);
    expect(existsSync(chatDir(ctx.host(), id))).toBe(true);
  });
});

describe("titles and export", () => {
  async function loop(ctx: Ctx, argv: string[]) {
    const run = () => {
      const out = parse(chat(ctx.host(), argv));
      ctx.session.request_id = out.variables.request_id;
      ctx.session.view_stage = out.variables.view_stage;
      return out;
    };
    let frameOut = run();
    for (let i = 0; i < 200 && frameOut.rerun !== undefined; i++) {
      await Bun.sleep(60);
      frameOut = run();
    }
    ctx.session.request_id = "";
    return frameOut;
  }

  test("happy: a first reply starts a title request whose result titles the chat, and /export writes Markdown whose first line is the title heading", async () => {
    bodies = [];
    const ctx = fresh();
    const final = await loop(ctx, ["hi"]);
    expect(final.response).toContain("Hello there");
    const id = getCurrent(ctx.host())!;
    let titled = "";
    for (let i = 0; i < 200 && titled === ""; i++) {
      await Bun.sleep(60);
      items(ctx);
      const current = getChat(ctx.host(), id)!;
      if (current.title !== "New chat") titled = current.title;
    }
    expect(titled).toBe("Greeting Chat Opener");
    const titleBody = bodies.find((b) => b.stream === false);
    expect(titleBody.messages[0].role).toBe("system");
    expect(titleBody.messages[1].content).toContain("User: hi");
    expect(getChat(ctx.host(), id)!.titleSource).toBe("auto");

    const host = ctx.host();
    const outcome: CommandOutcome = allCommands().export!.run({ host, config: readConfig(host), chat: currentChat(host), ensureChat: () => ensureCurrentChat(host, readConfig(host)) }, "");
    expect(outcome.kind === "notice" && outcome.text).toContain("Exported to `~/Exports/");
    const files = readdirSync(join(ctx.dir, "home/Exports"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2} Greeting Chat Opener\.md$/);
    const text = readFileSync(join(ctx.dir, "home/Exports", files[0]!), "utf8");
    expect(text.split("\n")[0]).toBe("# Greeting Chat Opener");
    expect(text).toContain("# 🧑 You\n\nhi");
    expect(text).not.toMatch(/\$|cost|token/i);
  });

  const finalizer = features.find((f) => f.finalizers?.title)!.finalizers!.title!;
  const record = (chatId: string): RequestRecord => ({ chatId, kind: "title", id: "t1" } as RequestRecord);
  const outcome = (content: string, state: Outcome["state"] = "done"): Outcome => ({ state, content: "", reasoning: "", annotations: [], finishReason: null, error: null, httpStatus: 200, bodyText: JSON.stringify({ choices: [{ message: { content } }] }) });

  test("failure: a title result arriving after /title Mine keeps Mine", () => {
    const ctx = fresh();
    const id = seed(ctx, "New chat");
    setTitleManual(ctx.host(), id, "Mine");
    finalizer(ctx.host(), record(id), outcome("Late Auto Title"));
    expect(getChat(ctx.host(), id)!.title).toBe("Mine");
    const other = seed(ctx, "New chat");
    finalizer(ctx.host(), record(other), outcome('"Fresh Title."'));
    expect(getChat(ctx.host(), other)!.title).toBe("Fresh Title");
  });

  test("failure: a result after the chat folder was deleted recreates nothing; a failed or unreadable title changes nothing", () => {
    const ctx = fresh();
    const id = seed(ctx, "New chat");
    ctx.host().remove(chatDir(ctx.host(), id));
    expect(() => finalizer(ctx.host(), record(id), outcome("Ghost Title"))).not.toThrow();
    expect(existsSync(chatDir(ctx.host(), id))).toBe(false);
    const live = seed(ctx, "New chat");
    finalizer(ctx.host(), record(live), outcome("Nope", "failed"));
    finalizer(ctx.host(), record(live), { ...outcome("x"), bodyText: "not json" });
    finalizer(ctx.host(), record(live), outcome("   "));
    expect(getChat(ctx.host(), live)!.title).toBe("New chat");
  });

  test("auto titles can be turned off, and a manual or existing title is never replaced by a new request", async () => {
    bodies = [];
    const ctx = fresh({ auto_titles: "0" });
    await loop(ctx, ["hi"]);
    await Bun.sleep(300);
    expect(bodies.filter((b) => b.stream === false)).toHaveLength(0);
    expect(getChat(ctx.host(), getCurrent(ctx.host())!)!.title).toBe("New chat");
  });

  test("/title, /pin, /archive, and an empty /export", () => {
    const ctx = fresh();
    const run = (name: string, args = "") => {
      const host = ctx.host();
      const result = allCommands()[name]!.run({ host, config: readConfig(host), chat: currentChat(host), ensureChat: () => ensureCurrentChat(host, readConfig(host)) }, args);
      return result.kind === "notice" ? result.text : "";
    };
    expect(run("export")).toContain("nothing to export");
    expect(run("title", "My plan")).toContain("**My plan**");
    const id = getCurrent(ctx.host())!;
    expect(getChat(ctx.host(), id)).toMatchObject({ title: "My plan", titleSource: "manual" });
    expect(run("pin")).toContain("Pinned");
    expect(getChat(ctx.host(), id)!.pinned).toBe(true);
    expect(run("pin")).toBe("Unpinned.");
    expect(run("archive")).toContain("Archived");
    expect(getChat(ctx.host(), id)!.archived).toBe(true);
    expect(run("archive")).toContain("Restored");
    expect(run("title")).toContain("**My plan**");
  });

  test("export leaves out reasoning the chat hides and numbers a second export of the same day", () => {
    const ctx = fresh();
    const id = seed(ctx, "Reasoned");
    mutateChat(ctx.host(), id, (c) => {
      c.messages.push({ id: "a", requestId: "r", role: "assistant", content: "answer", reasoning: "secret thoughts", attachments: [], status: "ok", createdAt: 1 });
      c.settings.showReasoning = false;
    });
    setCurrent(ctx.host(), id);
    const run = () => {
      const host = ctx.host();
      return allCommands().export!.run({ host, config: readConfig(host), chat: currentChat(host), ensureChat: () => ensureCurrentChat(host, readConfig(host)) }, "");
    };
    run();
    run();
    const files = readdirSync(join(ctx.dir, "home/Exports")).sort();
    expect(files).toHaveLength(2);
    expect(files.filter((name) => / 2\.md$/.test(name))).toHaveLength(1);
    expect(readFileSync(join(ctx.dir, "home/Exports", files[0]!), "utf8")).not.toContain("secret thoughts");
    mutateChat(ctx.host(), id, (c) => {
      c.settings.showReasoning = true;
    });
    run();
    const third = readdirSync(join(ctx.dir, "home/Exports")).find((name) => / 3\.md$/.test(name))!;
    expect(readFileSync(join(ctx.dir, "home/Exports", third), "utf8")).toContain("> secret thoughts");
  });
});

describe("title helpers", () => {
  test("cleanTitle strips quotes, labels, headings, and trailing punctuation, and cuts to six words", () => {
    expect(cleanTitle('"Planning a trip to Lisbon next spring, maybe."')).toBe("Planning a trip to Lisbon next");
    expect(cleanTitle("Title: Budget review!\nsecond line")).toBe("Budget review");
    expect(cleanTitle("# **Heading Title**")).toBe("Heading Title");
    expect(cleanTitle("   \n  ")).toBe("");
  });
  test("relative times and file-safe names", () => {
    const now = Date.UTC(2026, 9, 21, 12);
    expect(relativeTime(now, now - 5_000)).toBe("just now");
    expect(relativeTime(now, now - 5 * 60_000)).toBe("5 min ago");
    expect(relativeTime(now, now - 3 * 3_600_000)).toBe("3 h ago");
    expect(relativeTime(now, now - 30 * 3_600_000)).toBe("yesterday");
    expect(relativeTime(now, now - 4 * 86_400_000)).toBe("4 days ago");
    expect(relativeTime(now, now - 90 * 86_400_000)).toBe("2026-07-23");
    expect(fileSafe('a/b:c*"d"')).toBe("a b c d");
    expect(fileSafe("///")).toBe("Chat");
  });
});
