import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as session } from "../src/app/session";
import { envelope } from "../src/app/view";
import { BunHost } from "../src/host/bun";
import { createChat, getCurrent, setCurrent } from "../src/store/chats";

const roots: string[] = [];
afterAll(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function host(action: string) {
  const dir = mkdtempSync(join(tmpdir(), "aichat-session-"));
  roots.push(dir);
  return new BunHost({ env: { alfred_workflow_data: join(dir, "data"), alfred_workflow_cache: join(dir, "cache"), session_action: action } });
}

const parse = (text: string) => JSON.parse(text) as { alfredworkflow: { arg: string; variables: Record<string, string> } };

describe("session actions", () => {
  test("stop with nothing running only clears the request id and passes no argument", () => {
    const out = parse(session(host("stop"), ["typed text"]));
    expect(out.alfredworkflow.arg).toBe("");
    expect(out.alfredworkflow.variables).toEqual({ request_id: "", view_stage: "", session_action: "" });
  });

  test("new clears the current chat and hands the typed text to the next view", () => {
    const h = host("new");
    const chat = createChat(h);
    setCurrent(h, chat.id);
    const out = parse(session(h, ["fresh start"]));
    expect(out.alfredworkflow.arg).toBe("fresh start");
    expect(getCurrent(h)).toBeNull();
    expect(parse(session(h, [])).alfredworkflow.arg).toBe("");
  });

  test("stop keeps the current chat", () => {
    const h = host("stop");
    const chat = createChat(h);
    setCurrent(h, chat.id);
    session(h, []);
    expect(getCurrent(h)).toBe(chat.id);
  });

  test("the envelope is the alfredworkflow JSON Alfred reads", () => {
    expect(JSON.parse(envelope("a", { b: "c" }))).toEqual({ alfredworkflow: { arg: "a", variables: { b: "c" } } });
  });
});
