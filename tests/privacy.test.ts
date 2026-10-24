import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnvFile } from "../scripts/dev";
import { main as chat } from "../src/app/chat";
import { providerPreferences, buildBody } from "../src/core/payload";
import { imageBody } from "../src/core/imagegen";
import { mapHttpError } from "../src/core/errors";
import { readConfig } from "../src/features/index";
import { BunHost } from "../src/host/bun";

const root = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "aichat-privacy-"));
let bodies: any[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const text = await request.text();
      bodies.push(JSON.parse(text));
      const stream = JSON.parse(text).stream === true;
      if (stream) return new Response('data: {"choices":[{"delta":{"content":"Hi there"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
      return new Response('{"choices":[{"message":{"content":"A title"}}]}', { headers: { "content-type": "application/json" } });
    },
  });
});
afterAll(() => {
  server.stop(true);
  rmSync(work, { recursive: true, force: true });
});
beforeEach(() => {
  bodies = [];
});

let counter = 0;
function envFor(extra: Record<string, string>) {
  const dir = join(work, `case-${counter++}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "cache"), { recursive: true });
  writeFileSync(join(dir, "cache/models.json"), JSON.stringify({ fetchedAt: Date.now(), models: [] }));
  return { PATH: process.env.PATH ?? "", ...parseEnvFile(join(root, "tests/fixtures/dev.env")), alfred_workflow_data: join(dir, "data"), alfred_workflow_cache: join(dir, "cache"), aichat_api_base: `http://127.0.0.1:${server.port}/v1`, ...extra };
}

async function converse(extra: Record<string, string>) {
  const env = { ...envFor(extra), auto_titles: "1" };
  let session: Record<string, string> = {};
  const step = () => {
    const out = JSON.parse(chat(new BunHost({ env: { ...env, ...session } }), ["hello"]));
    session = { request_id: out.variables.request_id, view_stage: out.variables.view_stage };
    return out;
  };
  const deadline = Date.now() + 10000;
  let out = step();
  while (out.rerun !== undefined && Date.now() < deadline) {
    await Bun.sleep(60);
    out = step();
  }
  for (let i = 0; i < 40 && bodies.length < 2; i++) {
    await Bun.sleep(100);
    session = {};
    chat(new BunHost({ env }), []);
  }
}

describe("provider privacy", () => {
  test("each level maps to the provider preferences OpenRouter documents", () => {
    expect(providerPreferences("standard")).toBeNull();
    expect(providerPreferences("deny")).toEqual({ data_collection: "deny" });
    expect(providerPreferences("zdr")).toEqual({ data_collection: "deny", zdr: true });
    const options = { modelId: "m", model: null, stream: false, pdfEngine: "auto" as const, web: false };
    expect((buildBody([{ role: "user", content: "x" }], { ...options, privacy: "deny" }) as any).provider).toEqual({ data_collection: "deny" });
    expect("provider" in buildBody([{ role: "user", content: "x" }], { ...options, privacy: "standard" })).toBe(false);
  });

  test("the setting defaults to no data collection, and an unknown value never loosens it", () => {
    expect(readConfig(new BunHost({ env: {} })).privacy).toBe("deny");
    expect(readConfig(new BunHost({ env: { privacy_mode: "everything" } })).privacy).toBe("deny");
    expect(readConfig(new BunHost({ env: { privacy_mode: "zdr" } })).privacy).toBe("zdr");
    expect(readConfig(new BunHost({ env: { privacy_mode: "standard" } })).privacy).toBe("standard");
    expect(readConfig(new BunHost({ env: {} })).webRewrite).toBe(true);
    expect(readConfig(new BunHost({ env: { web_rewrite: "0" } })).webRewrite).toBe(false);
  });

  test("a chat reply and its automatic title both ask for no data collection by default", async () => {
    await converse({});
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const body of bodies) expect(body.provider).toEqual({ data_collection: "deny" });
  });

  test("zero-data-retention mode is sent on every request", async () => {
    await converse({ privacy_mode: "zdr" });
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const body of bodies) expect(body.provider).toEqual({ data_collection: "deny", zdr: true });
  });

  test("standard mode adds no provider rules", async () => {
    await converse({ privacy_mode: "standard" });
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const body of bodies) expect("provider" in body).toBe(false);
  });

  test("the image API takes no such field, so none is sent", () => {
    expect("provider" in JSON.parse(imageBody({ prompt: "fox", model: null, aspectRatio: null, resolution: null, count: 1 }, "m/x"))).toBe(false);
  });

  test("when the rules leave no provider, the error points to the setting", () => {
    const body = JSON.stringify({ error: { message: "No endpoints found matching your data policy (Zero data retention).", code: 404 } });
    const mapped = mapHttpError({ status: 404, retryAfter: null } as any, body);
    expect(mapped.title).toBe("Blocked by your data policy");
    expect(mapped.next).toContain("Provider Privacy");
  });
});
