import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnvFile } from "../scripts/dev";
import { renderIcon } from "../scripts/icon";
import { main as attach } from "../src/app/attach";
import { main as chat } from "../src/app/chat";
import { normalizeModel } from "../src/core/capabilities";
import { BunHost } from "../src/host/bun";
import { createChat, getChat, getCurrent, mutateChat, setCurrent } from "../src/store/chats";

const root = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "aichat-attach-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let counter = 0;
function fresh(extra: Record<string, string> = {}) {
  const dir = join(work, `case-${counter++}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "cache"), { recursive: true });
  mkdirSync(join(dir, "files"));
  const models = (JSON.parse(readFileSync(join(root, "tests/fixtures/models/models.json"), "utf8")).data as unknown[]).map(normalizeModel).filter((m) => m !== null);
  writeFileSync(join(dir, "cache/models.json"), JSON.stringify({ fetchedAt: Date.now(), models }));
  const env = { PATH: process.env.PATH, ...parseEnvFile(join(root, "tests/fixtures/dev.env")), alfred_workflow_data: join(dir, "data"), alfred_workflow_cache: join(dir, "cache"), aichat_api_base: "http://127.0.0.1:1/v1", ...extra };
  return { dir, host: (more: Record<string, string> = {}) => new BunHost({ env: { ...env, ...more } }) };
}
const file = (dir: string, name: string, data: Uint8Array | string) => {
  const path = join(dir, "files", name);
  writeFileSync(path, data);
  return path;
};
const parse = (text: string) => JSON.parse(text).alfredworkflow as { arg: string; variables: Record<string, string> };

describe("attach entry", () => {
  test("every argv element is split on tabs, attached to a chat created on demand, and the arg stays empty", () => {
    const ctx = fresh();
    const a = file(ctx.dir, "a.png", renderIcon());
    const b = file(ctx.dir, "b.txt", "notes");
    const c = file(ctx.dir, "c.png", Uint8Array.from([...renderIcon(), 9]));
    const out = parse(attach(ctx.host(), [`${a}\t${b}`, c]));
    expect(out.arg).toBe("");
    expect(out.variables).toEqual({ request_id: "", view_stage: "", attach_notice: "" });
    const id = getCurrent(ctx.host())!;
    expect(getChat(ctx.host(), id)!.pending.map((r) => r.name)).toEqual(["a.png", "b.txt", "c.png"]);
  });

  test("attach_mode new starts a new current chat and leaves the old one", () => {
    const ctx = fresh();
    const old = createChat(ctx.host());
    setCurrent(ctx.host(), old.id);
    parse(attach(ctx.host({ attach_mode: "new" }), [file(ctx.dir, "a.png", renderIcon())]));
    const now = getCurrent(ctx.host())!;
    expect(now).not.toBe(old.id);
    expect(getChat(ctx.host(), now)!.pending).toHaveLength(1);
    expect(getChat(ctx.host(), old.id)!.pending).toHaveLength(0);
  });

  test("errors are passed on as a notice and the footer of the next view shows them with the waiting files", () => {
    const ctx = fresh();
    const out = parse(attach(ctx.host(), [file(ctx.dir, "a.png", renderIcon()), join(ctx.dir, "files/missing.pdf")]));
    expect(out.variables.attach_notice).toContain("missing.pdf");
    const view = JSON.parse(chat(ctx.host({ attach_notice: out.variables.attach_notice }), []));
    expect(view.footer).toContain("⚠ missing.pdf");
    expect(view.footer).toContain("📎 1 waiting");
    expect(view.response).toContain("**📎 Ready to send with your next message**\n- a.png (");
    expect(view.response).toContain("⚠ missing.pdf");
    expect(view.response).toContain("Type your question and press ↩.");
  });
});

describe("sending refused", () => {
  test("an image-bearing chat on a text-only model with no fallback is refused with the draft kept and no body written", () => {
    const ctx = fresh({ vision_fallback_model: "", default_model: "deepseek/deepseek-r2" });
    parse(attach(ctx.host(), [file(ctx.dir, "shot.png", renderIcon())]));
    const id = getCurrent(ctx.host())!;
    mutateChat(ctx.host(), id, (c) => {
      c.messages.push({ id: "u", requestId: "r", role: "user", content: "see", attachments: c.pending, status: "ok", createdAt: 1 });
      c.messages.push({ id: "a", requestId: "r", role: "assistant", content: "cat", attachments: [], status: "ok", createdAt: 1 });
      c.pending = [];
    });
    const view = JSON.parse(chat(ctx.host(), ["what next?"]));
    expect(view.response).toContain("DeepSeek: R2");
    expect(view.response).toContain("cannot read the images");
    expect(view.behaviour.inputfield).toBe("select");
    expect(view.variables.request_id).toBe("");
    expect(view.rerun).toBeUndefined();
    expect(existsSync(join(ctx.dir, "data/requests"))).toBe(false);
    expect(getChat(ctx.host(), id)!.messages).toHaveLength(2);
  });
});
