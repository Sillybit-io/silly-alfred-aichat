import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnvFile } from "../scripts/dev";
import { renderIcon } from "../scripts/icon";
import { main as chat } from "../src/app/chat";
import { main as aiimage } from "../src/app/image";
import { main as imageLast } from "../src/app/image-last";
import { main as openImage } from "../src/app/open-image";
import { encodeBase64 } from "../src/core/base64";
import { imageBody, imageExtension, imageMarkdown, imagePathsIn, markdownImage, parseImagePrompt, promptFromXattr, xattrPlist } from "../src/core/imagegen";
import { BunHost } from "../src/host/bun";
import { getChat, getCurrent } from "../src/store/chats";

const root = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "aichat-image-"));
const png = renderIcon();
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const encoder = new TextEncoder();
const frame = (data: unknown) => encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);

let mode = "png";
let imageBodies: any[] = [];
let chatBodies: any[] = [];
let imageDelay = 0;
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = JSON.parse(await request.text());
      if (path.endsWith("/images")) {
        imageBodies.push(body);
        if (imageDelay) await Bun.sleep(imageDelay);
        const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
        switch (mode) {
          case "png": return json({ data: [{ b64_json: encodeBase64(png), media_type: "image/png" }], usage: { cost: 0.04 } });
          case "jpeg": return json({ data: [{ b64_json: encodeBase64(jpeg) }] });
          case "two": return json({ data: [{ b64_json: encodeBase64(png), media_type: "image/png" }, { b64_json: encodeBase64(jpeg), media_type: "image/jpeg" }] });
          case "502": return json({ error: { message: "upstream died" } }, 502);
          case "badbase64": return json({ data: [{ b64_json: encodeBase64(png), media_type: "image/png" }, { b64_json: "!!!not base64!!!" }] });
          case "empty": return json({ data: [] });
          default: return new Response("{not json", { headers: { "content-type": "application/json" } });
        }
      }
      chatBodies.push(body);
      return new Response(new ReadableStream({ start(c) { c.enqueue(frame({ choices: [{ delta: { content: "Nice." }, finish_reason: null }] })); c.enqueue(frame("[DONE]")); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
    },
  });
});
afterAll(() => {
  server.stop(true);
  rmSync(work, { recursive: true, force: true });
});
beforeEach(() => {
  mode = "png";
  imageBodies = [];
  chatBodies = [];
  imageDelay = 0;
});

let counter = 0;
function fresh(extra: Record<string, string> = {}, port = server.port) {
  const dir = join(work, `case-${counter++}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "cache"), { recursive: true });
  mkdirSync(join(dir, "home"));
  writeFileSync(join(dir, "cache/models.json"), JSON.stringify({ fetchedAt: Date.now(), models: [] }));
  const env = { PATH: process.env.PATH, HOME: join(dir, "home"), ...parseEnvFile(join(root, "tests/fixtures/dev.env")), alfred_workflow_data: join(dir, "data"), alfred_workflow_cache: join(dir, "cache"), aichat_api_base: `http://127.0.0.1:${port}/v1`, image_save_prompt: "1", ...extra };
  const attrs = new Map<string, string>();
  const xattrCalls: string[][] = [];
  const session: Record<string, string> = {};
  const host = (more: Record<string, string> = {}) =>
    new BunHost({
      env: { ...env, ...session, ...more },
      fakeCommands: {
        xattr: (args) => {
          xattrCalls.push(args);
          if (args[0] === "-w") return attrs.set(args[3]!, args[2]!), { exit: 0, stdout: "", stderr: "" };
          return attrs.has(args[2]!) ? { exit: 0, stdout: attrs.get(args[2]!)!, stderr: "" } : { exit: 1, stdout: "", stderr: "" };
        },
      },
    });
  return { dir, session, host, folder: join(dir, "home/Pictures/AI Chat"), attrs, xattrCalls };
}
type Ctx = ReturnType<typeof fresh>;
type Frame = { response: string; footer: string; rerun?: number; variables: { request_id: string } };

function step(app: typeof aiimage, ctx: Ctx, argv: string[]): Frame {
  const out = JSON.parse(app(ctx.host(), argv)) as Frame;
  ctx.session.request_id = out.variables.request_id;
  ctx.session.view_stage = (out.variables as any).view_stage ?? "";
  return out;
}
async function loop(app: typeof aiimage, ctx: Ctx, argv: string[]): Promise<Frame> {
  let out = step(app, ctx, argv);
  for (let i = 0; i < 250 && out.rerun !== undefined; i++) {
    await Bun.sleep(60);
    out = step(app, ctx, argv);
  }
  ctx.session.request_id = "";
  return out;
}
const files = (ctx: Ctx) => (existsSync(ctx.folder) ? readdirSync(ctx.folder).sort() : []);

describe("prompt parsing and files", () => {
  test("options are taken out of the prompt and validated", () => {
    expect(parseImagePrompt("a red fox --ar 16:9 --res 2k --n 2 --model vendor/img")).toEqual({
      ok: true,
      request: { prompt: "a red fox", model: "vendor/img", aspectRatio: "16:9", resolution: "2K", count: 2 },
    });
    expect(parseImagePrompt("plain words")).toEqual({ ok: true, request: { prompt: "plain words", model: null, aspectRatio: null, resolution: null, count: 1 } });
    for (const [text, fragment] of [["", "Describe the image"], ["x --ar wide", "ratio"], ["x --res 9K", "--res"], ["x --n 0", "from 1 to 10"], ["x --n 11", "from 1 to 10"], ["x --model", "needs a value"], ["--n 2", "Describe the image"]] as const) {
      const parsed = parseImagePrompt(text);
      expect(parsed.ok).toBe(false);
      expect(!parsed.ok && parsed.message).toContain(fragment);
    }
    expect(JSON.parse(imageBody({ prompt: "fox", model: null, aspectRatio: "1:1", resolution: "1K", count: 3 }, "m/x"))).toEqual({ model: "m/x", prompt: "fox", n: 3, aspect_ratio: "1:1", resolution: "1K" });
    expect(JSON.parse(imageBody({ prompt: "fox", model: null, aspectRatio: null, resolution: null, count: 1 }, "m/x"))).toEqual({ model: "m/x", prompt: "fox" });
  });

  test("the extension comes from media_type, else from the file signature", () => {
    expect(imageExtension("image/png", jpeg)).toBe("png");
    expect(imageExtension("image/jpeg; charset=x", png)).toBe("jpg");
    expect(imageExtension("image/svg+xml", png)).toBe("svg");
    expect(imageExtension(undefined, png)).toBe("png");
    expect(imageExtension(null, jpeg)).toBe("jpg");
    expect(imageExtension(null, encoder.encode("GIF89a..."))).toBe("gif");
    expect(imageExtension(null, Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("webp");
    expect(imageExtension(null, encoder.encode('<?xml version="1.0"?><svg xmlns="x"/>'))).toBe("svg");
    expect(imageExtension(null, encoder.encode("<svg viewBox='0 0 1 1'/>"))).toBe("svg");
    expect(imageExtension("application/octet-stream", Uint8Array.from([1, 2, 3]))).toBe("png");
  });

  test("markdown paths are percent-encoded and the prompt survives its xattr plist", () => {
    expect(markdownImage("/Users/a b/Pictures/AI Chat/x (1).png")).toBe("![](/Users/a b/Pictures/AI Chat/x (1).png)");
    expect(imageMarkdown("/Users/a b/AI Chat/x.png")).toBe("![](/Users/a b/AI Chat/x.png)\n\n📂 `/Users/a b/AI Chat/x.png`");
    expect(imagePathsIn("![](/a b/1.png)\n\n📂 `/a b/1.png`\n\n![](/a b/2.png)\n\n📂 `/a b/2.png`")).toEqual(["/a b/1.png", "/a b/2.png"]);
    expect(promptFromXattr(xattrPlist('a <fox> & "friend"'))).toBe('a <fox> & "friend"');
    expect(promptFromXattr("")).toBe("");
  });
});

describe("aiimage view", () => {
  test("by default no prompt is written into the image file", async () => {
    const ctx = fresh({ image_save_prompt: "0" });
    await loop(aiimage, ctx, ["a quiet fox"]);
    expect(files(ctx)).toHaveLength(1);
    expect(ctx.xattrCalls.filter((call) => call[0] === "-w")).toEqual([]);
    expect(ctx.attrs.size).toBe(0);
  });

  test("happy: a media_type image/png response yields one .png in the images folder, the prompt in its xattr, and a Markdown image line", async () => {
    const ctx = fresh();
    const first = step(aiimage, ctx, ["a lighthouse --ar 16:9"]);
    expect(first.rerun).toBe(0.1);
    expect(first.response).toContain("Generating image");
    expect(first.footer).toContain("generating");
    const final = await loop(aiimage, ctx, ["a lighthouse --ar 16:9"]);
    const saved = files(ctx);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}\.png$/);
    expect(readFileSync(join(ctx.folder, saved[0]!)).equals(Buffer.from(png))).toBe(true);
    expect(final.response.split("\n").some((line) => line.startsWith("![]("))).toBe(true);
    expect(final.response).toContain(`![](${join(ctx.folder, saved[0]!)})`);
    expect(final.response).toContain(`📂 \`${join(ctx.folder, saved[0]!)}\``);
    expect(final.response).not.toContain("file://");
    expect(final.response).toContain("# 🎨 a lighthouse");
    expect(final.footer).toContain("done");
    expect(final.variables.request_id).toBe("");
    expect(imageBodies[0]).toMatchObject({ model: "test/image-model", prompt: "a lighthouse", aspect_ratio: "16:9" });
    expect(imageBodies[0]).not.toHaveProperty("n");
    expect(promptFromXattr(ctx.attrs.get(join(ctx.folder, saved[0]!))!)).toBe("a lighthouse");
    expect(`${final.footer}${final.response}`).not.toMatch(/\$|0\.04|cost/i);
    expect(readdirSync(ctx.folder).filter((name) => name.startsWith("."))).toEqual([]);
  });

  test("happy: without media_type, JPEG bytes yield a .jpg; two images yield two files", async () => {
    mode = "jpeg";
    const ctx = fresh();
    await loop(aiimage, ctx, ["a fox"]);
    expect(files(ctx)[0]).toMatch(/\.jpg$/);
    mode = "two";
    const second = fresh();
    await loop(aiimage, second, ["pair --n 2"]);
    expect(files(second).map((name) => name.split(".").pop()).sort()).toEqual(["jpg", "png"]);
  });

  test("failure: a 502 leaves the images folder unchanged and shows a generation-failed message", async () => {
    mode = "502";
    const ctx = fresh();
    mkdirSync(ctx.folder, { recursive: true });
    writeFileSync(join(ctx.folder, "keep.png"), "old");
    const final = await loop(aiimage, ctx, ["a fox"]);
    expect(files(ctx)).toEqual(["keep.png"]);
    expect(final.response).toContain("Image generation failed");
    expect(final.response).toContain("Provider error");
    expect(final.footer).toContain("failed");
    expect(final.variables.request_id).toBe("");
  });

  test("failure: a refused connection (curl exit 7) ends as failed instead of polling forever, and writes nothing", async () => {
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = closed.port!;
    closed.stop(true);
    const ctx = fresh({}, port);
    const final = await loop(aiimage, ctx, ["a fox"]);
    expect(final.response).toContain("Image generation failed");
    expect(final.response).toContain("Cannot reach OpenRouter");
    expect(files(ctx)).toEqual([]);
  });

  test("failure: an empty list, unparsable JSON, and an undecodable image all write nothing and say so", async () => {
    for (const bad of ["empty", "garbage", "badbase64"]) {
      mode = bad;
      const ctx = fresh();
      const final = await loop(aiimage, ctx, ["a fox"]);
      expect(files(ctx)).toEqual([]);
      expect(final.response).toContain("Image generation failed");
    }
  });

  test("the idle view lists the last ten images with their prompts, and refusals explain themselves", async () => {
    const ctx = fresh();
    await loop(aiimage, ctx, ["first image"]);
    await Bun.sleep(1100);
    await loop(aiimage, ctx, ["second image"]);
    const gallery = step(aiimage, ctx, []);
    expect(gallery.response).toContain("# Recent images");
    expect(gallery.response.indexOf("second image")).toBeLessThan(gallery.response.indexOf("first image"));
    expect(gallery.rerun).toBeUndefined();
    expect(step(aiimage, ctx, ["x --n 99"]).response).toContain("from 1 to 10");
    expect(step(aiimage, fresh({ image_model: "" }), ["fox"]).response).toContain("Choose an image model");
    expect(step(aiimage, fresh({ openrouter_api_key: "" }), ["fox"]).response).toContain("API key");
    expect(step(aiimage, fresh(), []).response).toContain("Describe an image");
  });

  test("image-last prints the newest image path, or nothing", async () => {
    const ctx = fresh();
    expect(imageLast(ctx.host(), [])).toBe("");
    await loop(aiimage, ctx, ["one"]);
    const newest = imageLast(ctx.host(), []);
    expect(newest).toBe(join(ctx.folder, files(ctx)[0]!));
  });

  test("a second prompt while one is running stops the first and starts the new image", async () => {
    imageDelay = 400;
    const ctx = fresh();
    step(aiimage, ctx, ["slow one"]);
    ctx.session.request_id = "";
    const second = step(aiimage, ctx, ["second prompt"]);
    expect(second.response).toContain("second prompt");
    expect(second.variables.request_id).not.toBe("");
    imageDelay = 0;
    const final = await loop(aiimage, ctx, ["second prompt"]);
    expect(final.response).toContain("![](");
  });
});

describe("/image in a chat", () => {
  function run(ctx: Ctx, argv: string[]): Frame {
    const out = JSON.parse(chat(ctx.host(), argv)) as Frame;
    ctx.session.request_id = out.variables.request_id;
    ctx.session.view_stage = (out.variables as any).view_stage ?? "";
    return out;
  }
  async function chatLoop(ctx: Ctx, argv: string[]): Promise<Frame> {
    let out = run(ctx, argv);
    for (let i = 0; i < 250 && out.rerun !== undefined; i++) {
      await Bun.sleep(60);
      out = run(ctx, argv);
    }
    ctx.session.request_id = "";
    return out;
  }

  test("commits the prompt and an assistant turn with the image path, and later requests send it as [image: prompt]", async () => {
    const ctx = fresh();
    const final = await chatLoop(ctx, ["/image a cat in a hat"]);
    expect(final.response).toContain("# 🧑 You\n\na cat in a hat");
    expect(final.response.split("\n").some((line) => line.startsWith("![]("))).toBe(true);
    expect(final.response).toContain("📂 `");
    expect(final.response).not.toContain("file://");
    const stored = getChat(ctx.host(), getCurrent(ctx.host())!)!;
    expect(stored.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(stored.messages[1]!.id.endsWith("-img")).toBe(true);
    expect(files(ctx)).toHaveLength(1);

    await chatLoop(ctx, ["thanks, now describe it"]);
    const sent = chatBodies.at(-1).messages;
    expect(sent.map((m: any) => m.content)).toEqual([expect.any(String), "a cat in a hat", "[image: a cat in a hat]", "thanks, now describe it"]);
    expect(JSON.stringify(sent)).not.toContain("![](");
  });

  test("/reveal shows the newest image of the chat in Finder, and says so when there is none", async () => {
    const opened: string[][] = [];
    const ctx = fresh();
    await chatLoop(ctx, ["/image a cat"]);
    const host = new BunHost({ env: { ...ctx.host().env, ...ctx.session }, fakeCommands: { open: (args) => (opened.push(args), { exit: 0, stdout: "", stderr: "" }) } });
    const shown = JSON.parse(chat(host, ["/reveal"]));
    expect(opened).toEqual([["-R", join(ctx.folder, files(ctx)[0]!)]]);
    expect(shown.response).toContain("Showing");
    const empty = fresh();
    expect(JSON.parse(chat(empty.host(), ["/reveal"])).response).toContain("no image to show");
  });

  test("/open opens the newest image in its app, and the image view's ⌘↩ script does the same", async () => {
    const opened: string[][] = [];
    const ctx = fresh();
    await chatLoop(ctx, ["/image a cat"]);
    const fakes = { open: (args: string[]) => (opened.push(args), { exit: 0, stdout: "", stderr: "" }) };
    const host = new BunHost({ env: { ...ctx.host().env, ...ctx.session }, fakeCommands: fakes });
    expect(JSON.parse(chat(host, ["/open"])).response).toContain("Opened");
    expect(openImage(host, [])).toBe("");
    const path = join(ctx.folder, files(ctx)[0]!);
    expect(opened).toEqual([[path], [path]]);
    expect(JSON.parse(chat(fresh().host(), ["/open"])).response).toContain("no image to open");
    expect(openImage(fresh().host(), [])).toBe("");
  });

  test("failure in a chat: a 502 shows generation failed, commits nothing, and leaves the folder alone", async () => {
    mode = "502";
    const ctx = fresh();
    const final = await chatLoop(ctx, ["/image a cat"]);
    expect(final.response).toContain("Image generation failed");
    expect(files(ctx)).toEqual([]);
    expect(getChat(ctx.host(), getCurrent(ctx.host())!)!.messages).toEqual([]);
  });

  test("bad options and a missing model get notices instead of requests, and a new /image while one runs replaces it", async () => {
    const ctx = fresh();
    expect(run(ctx, ["/image"]).response).toContain("Describe the image");
    expect(run(fresh({ image_model: "" }), ["/image fox"]).response).toContain("Choose an image model");
    imageDelay = 500;
    const busy = fresh();
    const first = run(busy, ["/image slow fox"]);
    expect(first.variables.request_id).not.toBe("");
    busy.session.request_id = "";
    const again = JSON.parse(chat(busy.host({ request_id: "" }), ["/image another"])) as Frame;
    expect(again.variables.request_id).not.toBe("");
    expect(again.variables.request_id).not.toBe(first.variables.request_id);
    expect(again.response).toContain("another");
    imageDelay = 0;
  });
});
