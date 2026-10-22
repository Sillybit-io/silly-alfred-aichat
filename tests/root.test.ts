import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnvFile } from "../scripts/dev";
import { main as rootAction } from "../src/app/root-action";
import { main as root } from "../src/app/root";
import { BunHost } from "../src/host/bun";
import { chatDir, createChat, getChat, getCurrent, mutateChat, setCurrent } from "../src/store/chats";

const repo = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "aichat-root-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let counter = 0;
function fresh(extra: Record<string, string> = {}) {
  const dir = join(work, `case-${counter++}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "cache"), { recursive: true });
  const env = { PATH: process.env.PATH, ...parseEnvFile(join(repo, "tests/fixtures/dev.env")), alfred_workflow_data: join(dir, "data"), alfred_workflow_cache: join(dir, "cache"), ...extra };
  return { dir, host: (more: Record<string, string> = {}) => new BunHost({ env: { ...env, ...more }, trashDir: join(dir, "Trash") }) };
}
type Ctx = ReturnType<typeof fresh>;
const items = (ctx: Ctx, query = "") => JSON.parse(root(ctx.host(), [query])).items as any[];
const envelope = (text: string) => JSON.parse(text).alfredworkflow as { arg: string; variables: Record<string, string> };

function seed(ctx: Ctx, title: string, flags: { pinned?: boolean; archived?: boolean } = {}) {
  const host = ctx.host();
  const chat = createChat(host, { title, model: "m/x" });
  mutateChat(host, chat.id, (c) => {
    c.pinned = flags.pinned ?? false;
    c.archived = flags.archived ?? false;
    c.messages.push({ id: `${c.id}-u`, requestId: c.id, role: "user", content: `question about ${title}`, attachments: [], status: "ok", createdAt: 1 });
  });
  return chat.id;
}

describe("chat list (root)", () => {
  test("an empty history shows New chat and the three shortcuts, with their keywords named", () => {
    const list = items(fresh());
    expect(list.map((i) => i.title)).toEqual(["New chat", "All chats…", "AI Models", "AI Presets", "AI Image"]);
    expect(list[0]).toMatchObject({ arg: "", variables: { root_action: "new" } });
    expect(list.find((i) => i.title === "AI Models").subtitle).toContain("aimodels");
  });

  test("with a current chat it offers Continue first, then New chat, then recent chats without repeating the current one", () => {
    const ctx = fresh();
    const a = seed(ctx, "Alpha");
    const b = seed(ctx, "Beta", { pinned: true });
    seed(ctx, "Shelved", { archived: true });
    setCurrent(ctx.host(), a);
    const list = items(ctx);
    expect(list.map((i) => i.title)).toEqual(["Continue: Alpha", "New chat", "📌 Beta", "All chats…", "AI Models", "AI Presets", "AI Image"]);
    expect(list[0]).toMatchObject({ variables: { root_action: "continue" }, valid: true });
    expect(list[0].mods.cmd).toMatchObject({ subtitle: "Start a new chat", variables: { root_action: "new" } });
    const beta = list[2];
    expect(beta).toMatchObject({ type: "file", arg: chatDir(ctx.host(), b), variables: { root_action: "open" } });
    expect(beta.mods.cmd).toMatchObject({ variables: { root_action: "archive" } });
    expect(beta.mods.alt).toMatchObject({ subtitle: "Unpin this chat", variables: { root_action: "pin" } });
    expect(beta.mods.ctrl).toMatchObject({ variables: { root_action: "trash" } });
  });

  test("typed text is what Continue and New chat send, and it filters the chats and shortcuts", () => {
    const ctx = fresh();
    const a = seed(ctx, "Alpha");
    seed(ctx, "Travel plans");
    setCurrent(ctx.host(), a);
    const list = items(ctx, "travel");
    expect(list.map((i) => i.title)).toEqual(["Continue: Alpha", "New chat", "Travel plans"]);
    expect(list[0]).toMatchObject({ arg: "travel", subtitle: "Send “travel” in this chat" });
    expect(list[1]).toMatchObject({ arg: "travel", subtitle: "Start a new chat and send “travel”" });
    expect(items(ctx, "pre").map((i) => i.title)).toEqual(["Continue: Alpha", "New chat", "AI Presets"]);
  });

  test("only the eight most recent chats are listed, and All chats… stays reachable", () => {
    const ctx = fresh();
    for (let i = 0; i < 11; i++) seed(ctx, `Chat ${i}`);
    const list = items(ctx, "chat");
    expect(list.filter((i) => i.type === "file")).toHaveLength(8);
    expect(list.map((i) => i.title)).toContain("All chats…");
  });
});

describe("chat list actions", () => {
  test("continue and new pass the typed text on; new stops the old chat and clears current", () => {
    const ctx = fresh();
    const a = seed(ctx, "Alpha");
    setCurrent(ctx.host(), a);
    expect(envelope(rootAction(ctx.host({ root_action: "continue" }), ["hello"]))).toEqual({ arg: "hello", variables: { root_next: "view", notice: "", request_id: "", view_stage: "" } });
    expect(getCurrent(ctx.host())).toBe(a);
    const fresher = envelope(rootAction(ctx.host({ root_action: "new" }), ["  start over  "]));
    expect(fresher.arg).toBe("start over");
    expect(fresher.variables.root_next).toBe("view");
    expect(getCurrent(ctx.host())).toBeNull();
    expect(getChat(ctx.host(), a)).not.toBeNull();
  });

  test("open sets current and sends no arg; archive, pin, and trash return to the list with no arg", () => {
    const ctx = fresh();
    const a = seed(ctx, "Alpha");
    const b = seed(ctx, "Beta");
    const open = envelope(rootAction(ctx.host({ root_action: "open" }), [chatDir(ctx.host(), a)]));
    expect(open).toMatchObject({ arg: "", variables: { root_next: "view" } });
    expect(getCurrent(ctx.host())).toBe(a);
    for (const action of ["archive", "pin"]) expect(envelope(rootAction(ctx.host({ root_action: action }), [chatDir(ctx.host(), b)]))).toMatchObject({ arg: "", variables: { root_next: "root" } });
    expect(getChat(ctx.host(), b)).toMatchObject({ archived: true, pinned: true });
    const trashed = envelope(rootAction(ctx.host({ root_action: "trash" }), [chatDir(ctx.host(), b)]));
    expect(trashed.variables.root_next).toBe("root");
    expect(existsSync(chatDir(ctx.host(), b))).toBe(false);
    expect(readdirSync(join(ctx.dir, "Trash"))).toEqual([b]);
    const gone = envelope(rootAction(ctx.host({ root_action: "open" }), [chatDir(ctx.host(), b)]));
    expect(gone.variables.notice).toContain("no longer exists");
    expect(gone.variables.root_next).toBe("root");
  });

  test("the shortcuts route to their lists and never pass an arg", () => {
    const ctx = fresh();
    for (const action of ["models", "presets", "image", "history"]) {
      expect(envelope(rootAction(ctx.host({ root_action: action }), ["typed"]))).toMatchObject({ arg: "", variables: { root_next: action } });
    }
  });
});

describe("a file passed to the chat list", () => {
  test("a typed path to a file offers to attach it, and the normal send items are left out", () => {
    const ctx = fresh();
    const a = seed(ctx, "Alpha");
    setCurrent(ctx.host(), a);
    const file = join(ctx.dir, "photo.png");
    writeFileSync(file, "png");
    const list = items(ctx, file);
    expect(list.map((i) => i.title)).toEqual(["Attach “photo.png” to this chat", "Attach “photo.png” to a new chat"]);
    expect(list[0]).toMatchObject({ arg: file, variables: { root_action: "attach" } });
    expect(list[1]).toMatchObject({ arg: file, variables: { root_action: "attach_new" } });
    expect(items(ctx, join(ctx.dir, "missing.png")).map((i) => i.title)[0]).toBe("Continue: Alpha");
    expect(items(ctx, ctx.dir).map((i) => i.title)[0]).toBe("Continue: Alpha");
    expect(items(fresh(), file).map((i) => i.title)).toEqual(["Attach “photo.png” to a new chat"]);
  });

  test("attach puts the file in the current chat, attach_new in a new one, and the view opens", () => {
    const ctx = fresh();
    const a = seed(ctx, "Alpha");
    setCurrent(ctx.host(), a);
    const file = join(ctx.dir, "notes.txt");
    writeFileSync(file, "hello");
    const first = envelope(rootAction(ctx.host({ root_action: "attach" }), [file]));
    expect(first).toMatchObject({ arg: "", variables: { root_next: "view", attach_notice: "" } });
    expect(getCurrent(ctx.host())).toBe(a);
    expect(getChat(ctx.host(), a)!.pending.map((p) => p.name)).toEqual(["notes.txt"]);
    const second = envelope(rootAction(ctx.host({ root_action: "attach_new" }), [file]));
    expect(second.variables.root_next).toBe("view");
    const fresherId = getCurrent(ctx.host())!;
    expect(fresherId).not.toBe(a);
    expect(getChat(ctx.host(), fresherId)!.pending.map((p) => p.name)).toEqual(["notes.txt"]);
    const bad = envelope(rootAction(ctx.host({ root_action: "attach" }), [join(ctx.dir, "gone.txt")]));
    expect(bad.variables.attach_notice).toContain("gone.txt");
  });
});
