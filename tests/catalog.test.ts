import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BunHost } from "../src/host/bun";
import { CATALOG_MAX_AGE_MS, ensureCatalog, getModel, listModels, loadCatalog } from "../src/store/catalog";

const root = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "aichat-catalog-"));
const serve = join(work, "serve");
let server: { kill(): void };
let port = 0;

beforeAll(async () => {
  mkdirSync(serve);
  cpSync(join(root, "tests/fixtures/models/models.json"), join(serve, "body.json"));
  const proc = Bun.spawn(["bun", join(root, "tests/fixtures/store/models-server.ts"), serve], { stdout: "pipe" });
  server = proc;
  const reader = proc.stdout.getReader();
  port = Number(new TextDecoder().decode((await reader.read()).value).trim());
});
afterAll(() => {
  server.kill();
  rmSync(work, { recursive: true, force: true });
});

let counter = 0;
function fresh(apiBase = `http://127.0.0.1:${port}/v1`) {
  const dir = join(work, `case-${counter++}`);
  const host = new BunHost({ env: { alfred_workflow_data: join(dir, "data"), alfred_workflow_cache: join(dir, "cache"), aichat_api_base: apiBase } });
  return { dir, host };
}
const setBody = (models: unknown) => writeFileSync(join(serve, "body.json"), JSON.stringify(models));
const setStatus = (status: number | null) => (status === null ? rmSync(join(serve, "status"), { force: true }) : writeFileSync(join(serve, "status"), String(status)));
const original = () => JSON.parse(readFileSync(join(root, "tests/fixtures/models/models.json"), "utf8"));

async function waitForExit(host: BunHost): Promise<void> {
  const exit = join(host.env.alfred_workflow_cache!, "catalog/models.exit");
  for (let i = 0; i < 400 && !existsSync(exit); i++) await Bun.sleep(25);
  expect(existsSync(exit)).toBe(true);
}

function makeStale(host: BunHost, ageMs = CATALOG_MAX_AGE_MS + 60_000) {
  const cache = loadCatalog(host)!;
  writeFileSync(join(host.env.alfred_workflow_cache!, "models.json"), JSON.stringify({ ...cache, fetchedAt: host.nowMs() - ageMs }));
}

describe("models catalog", () => {
  test("with no cache the first call fetches synchronously and normalizes the list", () => {
    setStatus(null);
    setBody(original());
    const { host } = fresh();
    const result = ensureCatalog(host);
    expect(result.note).toBeNull();
    expect(result.models).toHaveLength(7);
    expect(getModel(host, "google/gemini-3-flash")!.reasoning!.mandatory).toBe(true);
    expect(listModels(host)).toHaveLength(7);
    expect(existsSync(join(host.env.alfred_workflow_cache!, "catalog/models.part"))).toBe(false);
  });

  test("a stale cache answers at once and the next call installs the list refreshed from the server", async () => {
    setStatus(null);
    setBody(original());
    const { host } = fresh();
    ensureCatalog(host);
    const refreshed = original();
    refreshed.data.push({ id: "new/model", name: "New", context_length: 1000, pricing: { prompt: "0", completion: "0" }, architecture: {} });
    setBody(refreshed);
    makeStale(host);
    const started = ensureCatalog(host);
    expect(started.models).toHaveLength(7);
    expect(started.refreshing).toBe(true);
    expect(ensureCatalog(host).refreshing).toBe(true);
    await waitForExit(host);
    const installed = ensureCatalog(host);
    expect(installed.models).toHaveLength(8);
    expect(installed.note).toBeNull();
    expect(installed.refreshing).toBe(false);
    expect(host.nowMs() - loadCatalog(host)!.fetchedAt).toBeLessThan(60_000);
  });

  test("a refresh ending in HTTP 500 leaves the old cache in place and reports the failure", async () => {
    setBody(original());
    setStatus(null);
    const { host } = fresh();
    ensureCatalog(host);
    makeStale(host);
    setStatus(500);
    ensureCatalog(host);
    await waitForExit(host);
    const result = ensureCatalog(host);
    expect(result.models).toHaveLength(7);
    expect(result.note).toContain("HTTP 500");
    expect(loadCatalog(host)!.fetchedAt).toBeLessThan(host.nowMs() - CATALOG_MAX_AGE_MS);
    expect(ensureCatalog(host).refreshing).toBe(false);
    setStatus(null);
  });

  test("a refresh with curl exit 7 leaves the old cache in place and reports the failure", async () => {
    setBody(original());
    setStatus(null);
    const { host } = fresh();
    ensureCatalog(host);
    makeStale(host);
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const deadPort = closed.port;
    closed.stop(true);
    host.env.aichat_api_base = `http://127.0.0.1:${deadPort}/v1`;
    ensureCatalog(host);
    await waitForExit(host);
    const result = ensureCatalog(host);
    expect(result.models).toHaveLength(7);
    expect(result.note).toContain("Cannot reach OpenRouter");
  });

  test("a 200 body without a data array is not installed", async () => {
    setBody(original());
    setStatus(null);
    const { host } = fresh();
    ensureCatalog(host);
    makeStale(host);
    setBody({ error: { message: "nope" } });
    ensureCatalog(host);
    await waitForExit(host);
    const result = ensureCatalog(host);
    expect(result.models).toHaveLength(7);
    expect(result.note).not.toBeNull();
    setBody(original());
  });

  test("with no cache and an unreachable server the list is empty with a note, and nothing is cached", () => {
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const deadPort = closed.port;
    closed.stop(true);
    const { host } = fresh(`http://127.0.0.1:${deadPort}/v1`);
    const result = ensureCatalog(host);
    expect(result.models).toEqual([]);
    expect(result.note).toContain("Could not load the model list");
    expect(loadCatalog(host)).toBeNull();
  });

  test("a fresh cache never touches the network", () => {
    setBody(original());
    setStatus(null);
    const { host } = fresh();
    ensureCatalog(host);
    host.env.aichat_api_base = "http://127.0.0.1:1/v1";
    const result = ensureCatalog(host);
    expect(result.refreshing).toBe(false);
    expect(result.models).toHaveLength(7);
    expect(host.calls.filter((call) => call.some((arg) => arg.includes("127.0.0.1:1"))).length).toBe(0);
  });
});
