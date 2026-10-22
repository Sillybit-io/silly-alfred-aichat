import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnvFile } from "../scripts/dev";
import { renderIcon } from "../scripts/icon";
import { main as chat } from "../src/app/chat";
import { main as copy } from "../src/app/copy";
import { domainOf, isRasterIcon, isSafeDomain, sourcesRow } from "../src/core/favicons";
import { allCommands, readConfig } from "../src/features/index";
import { BunHost } from "../src/host/bun";
import { createChat, mutateChat, setCurrent } from "../src/store/chats";
import { currentChat, ensureCurrentChat } from "../src/store/current-chat";
import { faviconPaths, loadFavicons, resolveFavicons } from "../src/store/favicons";

const repo = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "aichat-favicons-"));
const served = join(work, "served");
const log = join(work, "requests.log");
let server: { kill(): void };
let port = 0;
const png = renderIcon();

beforeAll(async () => {
  mkdirSync(served);
  writeFileSync(log, "");
  writeFileSync(join(served, "good.example.com.ico"), png);
  writeFileSync(join(served, "vector.example.com.ico"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  writeFileSync(join(served, "page.example.com.ico"), "<html><body>not an icon</body></html>");
  writeFileSync(join(served, "huge.example.com.ico"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80 * 1024)]));
  const proc = Bun.spawn(["bun", join(repo, "tests/fixtures/store/icon-server.ts"), served, log], { stdout: "pipe" });
  server = proc;
  port = Number(new TextDecoder().decode((await proc.stdout.getReader().read()).value).trim());
});
afterAll(() => {
  server.kill();
  rmSync(work, { recursive: true, force: true });
});

const sipsFake = (args: string[]) => {
  const out = args[args.indexOf("--out") + 1]!;
  const source = readFileSync(args[args.indexOf("-Z") + 2]!);
  const isPng = source.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (!isPng) return { exit: 13, stdout: "", stderr: "unreadable" };
  writeFileSync(out, source);
  return { exit: 0, stdout: "", stderr: "" };
};

let counter = 0;
function fresh(extra: Record<string, string> = {}) {
  const dir = join(work, `case-${counter++}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "cache"), { recursive: true });
  writeFileSync(join(dir, "cache/models.json"), JSON.stringify({ fetchedAt: Date.now(), models: [] }));
  const env = { PATH: process.env.PATH, ...parseEnvFile(join(repo, "tests/fixtures/dev.env")), alfred_workflow_data: join(dir, "data"), alfred_workflow_cache: join(dir, "cache"), aichat_favicon_base: `http://127.0.0.1:${port}`, ...extra };
  return { dir, host: (more: Record<string, string> = {}) => new BunHost({ env: { ...env, ...more }, fakeCommands: { sips: sipsFake } }) };
}
const requested = () => readFileSync(log, "utf8").split("\n").filter((line) => line !== "");

describe("which domains are asked for", () => {
  test("only public DNS names pass: no IPs, local names, single labels, or odd characters", () => {
    expect(domainOf("https://www.Example.com/path?q=1")).toBe("example.com");
    expect(domainOf("http://sub.news.example.co.uk:8080/x")).toBe("sub.news.example.co.uk");
    for (const bad of ["http://127.0.0.1/x", "http://192.168.1.1:3000", "http://localhost/x", "http://printer.local/", "http://intranet/x", "http://a.internal", "ftp://example.com", "javascript:alert(1)", "https://exa mple.com", "https://-bad.example.com", "https://example.com@evil.test"]) {
      expect(domainOf(bad), bad).toBeNull();
    }
    expect(isSafeDomain("123.456")).toBe(false);
    expect(isSafeDomain("a.b")).toBe(false);
    expect(isSafeDomain("xn--nxasmq6b.example")).toBe(false);
    expect(isSafeDomain("example.com")).toBe(true);
  });

  test("only raster icon bytes within the size cap pass", () => {
    expect(isRasterIcon(png)).toBe(true);
    expect(isRasterIcon(Uint8Array.from([0, 0, 1, 0, 1, 0]))).toBe(true);
    expect(isRasterIcon(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe(true);
    expect(isRasterIcon(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(isRasterIcon(new TextEncoder().encode("<svg xmlns='x'/>"))).toBe(false);
    expect(isRasterIcon(new TextEncoder().encode("<html>"))).toBe(false);
    expect(isRasterIcon(new Uint8Array(0))).toBe(false);
    expect(isRasterIcon(new Uint8Array(70 * 1024).fill(0x89))).toBe(false);
  });
});

describe("downloading and caching", () => {
  test("a good icon is fetched once, validated, converted, and then served from the cache", () => {
    const ctx = fresh();
    const host = ctx.host();
    const before = requested().length;
    const first = loadFavicons(host, ["good.example.com"], 5000);
    const path = first.get("good.example.com")!;
    expect(path).toBe(faviconPaths(host, "good.example.com").png);
    expect(readFileSync(path).equals(Buffer.from(png))).toBe(true);
    expect(requested().slice(before)).toEqual(["/good.example.com.ico"]);
    expect(readdirSync(join(ctx.dir, "cache/favicons")).filter((name) => !name.endsWith(".png"))).toEqual([]);
    expect(resolveFavicons(host, ["good.example.com"], { start: true }).get("good.example.com")).toBe(path);
    expect(requested().length).toBe(before + 1);
  });

  test("SVG, HTML, oversized, missing, and unsafe icons are never shown and not asked for again", () => {
    const ctx = fresh();
    const host = ctx.host();
    const before = requested().length;
    const domains = ["vector.example.com", "page.example.com", "huge.example.com", "nothing.example.com", "127.0.0.1", "localhost"];
    const found = loadFavicons(host, domains, 6000);
    for (const domain of domains) expect(found.get(domain), domain).toBeNull();
    const asked = requested().slice(before).sort();
    expect(asked).toEqual(["/huge.example.com.ico", "/nothing.example.com.ico", "/page.example.com.ico", "/vector.example.com.ico"]);
    const again = requested().length;
    resolveFavicons(host, domains, { start: true });
    expect(requested().length).toBe(again);
    expect(readdirSync(join(ctx.dir, "cache/favicons")).filter((name) => name.endsWith(".png"))).toEqual([]);
  });

  test("a missing icon is reported at once and fetched in the background", async () => {
    const ctx = fresh();
    const host = ctx.host();
    expect(resolveFavicons(host, ["good.example.com"], { start: true }).get("good.example.com")).toBeNull();
    let path: string | null = null;
    for (let i = 0; i < 100 && path === null; i++) {
      await Bun.sleep(50);
      path = resolveFavicons(host, ["good.example.com"], { start: false }).get("good.example.com") ?? null;
    }
    expect(path).not.toBeNull();
  });
});

describe("the sources row", () => {
  const sources = [
    { url: "https://www.berlin.de/en/weather/", title: "Weather for Berlin" },
    { url: "https://www.dwd.de/DE/wetter/vhs_bbb_node.html;jsessionid=ABC", title: "DWD" },
    { url: "https://berlin.de/other", title: "Same site again" },
    ...Array.from({ length: 9 }, (_, i) => ({ url: `https://site_${i}.example.com/page(1)`, title: `Page ${i}` })),
  ];

  test("short links, one per site, escaped, capped, with a pointer to /sources", () => {
    const row = sourcesRow(sources, { cap: 3, icons: false, icon: () => "/never.png" });
    expect(row).toBe("**Sources**  [berlin.de](https://www.berlin.de/en/weather/)  ·  [dwd.de](https://www.dwd.de/DE/wetter/vhs_bbb_node.html;jsessionid=ABC)  ·  [site\\_0.example.com](https://site_0.example.com/page%281%29)  ·  +8 more with `/sources`");
    expect(sourcesRow(sources.slice(0, 2), { cap: 8, icons: false, icon: () => null })).not.toContain("more");
    expect(row).not.toContain("![");
    expect(row).not.toContain('"');
  });

  test("with icons each link is preceded by its cached icon, never wrapped around it", () => {
    const row = sourcesRow(sources.slice(0, 2), { cap: 8, icons: true, icon: (domain) => (domain === "berlin.de" ? "/cache/a b/x.png" : null) });
    expect(row).toBe("**Sources**  ![](/cache/a b/x.png) [berlin.de](https://www.berlin.de/en/weather/)  ·  [dwd.de](https://www.dwd.de/DE/wetter/vhs_bbb_node.html;jsessionid=ABC)");
    expect(row).not.toContain("[![");
    expect(sourcesRow([{ url: "http://10.0.0.1/x", title: "Internal" }], { cap: 8, icons: true, icon: () => "/never.png" })).toBe("**Sources**  [10.0.0.1](http://10.0.0.1/x)");
  });
});

describe("in the chat view", () => {
  function chatWithSources(ctx: ReturnType<typeof fresh>, count: number) {
    const host = ctx.host();
    const created = createChat(host, { title: "Cited" });
    setCurrent(host, created.id);
    const annotations = Array.from({ length: count }, (_, i) => ({ type: "url_citation" as const, url_citation: { url: `https://${i === 0 ? "good" : `s${i}`}.example.com/p${i}`, title: `Source ${i}` } }));
    mutateChat(host, created.id, (c) => {
      c.messages.push({ id: "u", requestId: "r", role: "user", content: "q", attachments: [], status: "ok", createdAt: 1 });
      c.messages.push({ id: "a", requestId: "r", role: "assistant", content: "An answer.", attachments: [], annotations, status: "ok", createdAt: 1 });
    });
    return created.id;
  }

  test("by default the view shows a row of short links and downloads nothing", () => {
    const ctx = fresh();
    chatWithSources(ctx, 12);
    const before = requested().length;
    const view = JSON.parse(chat(ctx.host(), []));
    const rowLine = view.response.split("\n").find((line: string) => line.startsWith("**Sources**"))!;
    expect(rowLine).toContain("[good.example.com](https://good.example.com/p0)");
    expect(rowLine).toContain("+4 more with `/sources`");
    expect(rowLine).not.toContain("![");
    expect(requested().length).toBe(before);
    expect(() => readdirSync(join(ctx.dir, "cache/favicons"))).toThrow();
  });

  test("with icons on, the row shows cached icons before the links, the copy actions keep a plain list, and /sources lists everything", () => {
    const ctx = fresh({ sources_style: "icons" });
    chatWithSources(ctx, 12);
    const warm = ctx.host();
    loadFavicons(warm, ["good.example.com"], 5000);
    const view = JSON.parse(chat(ctx.host(), []));
    const rowLine = view.response.split("\n").find((line: string) => line.startsWith("**Sources**"))!;
    expect(rowLine).toContain(`![](${faviconPaths(warm, "good.example.com").png}) [good.example.com](https://good.example.com/p0)`);
    expect(rowLine).toContain("[s1.example.com](https://s1.example.com/p1)");
    expect((rowLine.match(/\]\(https:\/\//g) ?? []).length).toBe(8);
    expect(rowLine).toContain("+4 more");
    expect(rowLine).not.toContain("[![");
    expect(view.response).not.toContain("- [Source 1]");

    const copied = copy(ctx.host({ copy_mode: "all" }), []);
    expect(copied).toContain("**Sources**\n- [Source 0](https://good.example.com/p0)");
    expect(copied).not.toContain("favicons");

    const host = ctx.host();
    const list = allCommands().sources!.run({ host, config: readConfig(host), chat: currentChat(host), ensureChat: () => ensureCurrentChat(host, readConfig(host)) }, "");
    const text = list.kind === "notice" ? list.text : "";
    expect(text.split("\n").filter((line) => /^\d+\. \[/.test(line))).toHaveLength(12);
    expect(text).toContain("12. [Source 11](https://s11.example.com/p11)");
  });

  test("a chat with no sources never touches the favicon cache", () => {
    const ctx = fresh();
    const host = ctx.host();
    const created = createChat(host, { title: "Plain" });
    setCurrent(host, created.id);
    mutateChat(host, created.id, (c) => {
      c.messages.push({ id: "a", requestId: "r", role: "assistant", content: "hi", attachments: [], status: "ok", createdAt: 1 });
    });
    chat(ctx.host(), []);
    expect(() => readdirSync(join(ctx.dir, "cache/favicons"))).toThrow();
  });
});
