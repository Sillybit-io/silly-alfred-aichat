import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "plist";
import pkg from "../package.json";
import { uidFor } from "../scripts/lib/plist";
import { ROUTES, buildWorkflow, renderPlist } from "../scripts/workflow";

const root = resolve(import.meta.dir, "..");
const committed = readFileSync(resolve(root, "Workflow/info.plist"), "utf8");
const info = parse(committed) as any;
const objectsByUid = new Map<string, any>((info.objects as any[]).map((o) => [o.uid, o]));

const CMD = 1048576;
const ALT = 524288;
const CTRL = 262144;
const SHIFT = 131072;

// The routing contract, written out again here so that dropping a route from scripts/workflow.ts fails this test.
type Expect = [from: string, to: string, modifiers: number, output?: string];
const CONTRACT: { id: string; what: string; edges: Expect[] }[] = [
  {
    id: "R01",
    what: "the chat list and its alias run root-action.js on ↩ ⌘↩ ⌥↩ ⌃↩ and route by root_next",
    edges: [
      ...["root list", "root alias list"].flatMap((from): Expect[] => [[from, "root script", 0], [from, "root script", CMD], [from, "root script", ALT], [from, "root script", CTRL]]),
      ["root script", "root route", 0],
    ],
  },
  {
    id: "R02",
    what: "root route reaches view_chat, the chat list, models, presets, the image view, and all chats",
    edges: [["root route", "call view_chat", 0, "view"], ["root route", "call show_root", 0, "root"], ["root route", "call show_models", 0, "models"], ["root route", "call show_presets", 0, "presets"], ["root route", "call show_image", 0, "image"], ["root route", "call show_history", 0, "history"]],
  },
  {
    id: "R03",
    what: "the show_root, show_models, show_presets, and show_image triggers open their lists",
    edges: [["trigger show_root", "root list", 0], ["trigger show_models", "models list", 0], ["trigger show_presets", "presets list", 0], ["trigger show_image", "image view", 0]],
  },
  { id: "R04", what: "the chat Text View reruns chat.js and ⌘⌥↩ goes back to the chat list", edges: [["chat view", "call show_root", CMD | ALT]] },
  { id: "R05", what: "stop: chat Text View ⇧↩ closes the view and runs session.js stop", edges: [["chat view", "session stop vars", SHIFT], ["session stop vars", "session script", 0]] },
  { id: "R06", what: "chat Text View ⌘↩ starts a new chat through session.js and view_chat", edges: [["chat view", "session new vars", CMD], ["session new vars", "session script", 0], ["session script", "call view_chat", 0]] },
  { id: "R07", what: "chat Text View ⌥↩ and ⌃↩ copy through copy.js", edges: [["chat view", "copy last vars", ALT], ["chat view", "copy all vars", CTRL], ["copy last vars", "copy script", 0], ["copy all vars", "copy script", 0], ["copy script", "copy reply", 0]] },
  { id: "R08", what: "Ask AI ↩ goes to view_chat", edges: [["ask text action", "ask pass vars", 0], ["ask pass vars", "call view_chat", 0]] },
  { id: "R09", what: "Ask AI ⌘↩ starts a new chat", edges: [["ask text action", "session new vars", CMD]] },
  { id: "R10", what: "Ask AI about files goes through attach.js to view_chat", edges: [["ask files action", "attach script", 0], ["ask files action", "attach new vars", CMD], ["attach new vars", "attach script", 0], ["attach script", "call view_chat", 0]] },
  { id: "R11", what: "Run a preset… opens the presets list, and each default preset has its own action into preset-run.js", edges: [["preset action", "preset input vars", 0], ["preset input vars", "presets list", 0], ...["summarize", "explain", "translate", "proofread", "fix-code", "action-items"].flatMap((id): Expect[] => [[`preset action ${id}`, `preset vars ${id}`, 0], [`preset vars ${id}`, "preset script", 0]])] },
  { id: "R12", what: "presets run preset-run.js and route by preset_output", edges: [["presets list", "preset script", 0], ["preset script", "preset route", 0], ["preset route", "session new vars", 0, "textview"], ["preset route", "preset copy", 0, "clipboard"], ["preset route", "preset paste", 0, "paste"], ["preset route", "preset large type", 0, "largetype"], ["preset route", "preset error note", 0, "error"], ["preset route", "preset result view", 0, "view"], ["preset result view", "copy preset vars", CMD], ["preset result view", "call show_root", CMD | ALT], ["copy preset vars", "copy script", 0]] },
  { id: "R13", what: "aimodels ↩ ⌘↩ ⌥↩ ⌃↩ run model-action.js and route by model_next", edges: [["models list", "model script", 0], ["models list", "model script", CMD], ["models list", "model script", ALT], ["models list", "model script", CTRL], ["model script", "model route", 0], ["model route", "call view_chat", 0, "view"], ["model route", "model notice", 0, "notify"], ["model route", "model copy", 0, "clipboard"]] },
  { id: "R14", what: "history ↩ ⌘↩ ⌥↩ ⌃↩ run history-action.js and route by history_next", edges: [["history list", "history script", 0], ["history list", "history script", CMD], ["history list", "history script", ALT], ["history list", "history script", CTRL], ["history script", "history route", 0], ["history route", "call view_chat", 0, "view"], ["history route", "call show_history", 0, "list"]] },
  { id: "R15", what: "aiimage ↩ opens the image Text View", edges: [["image keyword", "image view", 0]] },
  { id: "R16", what: "image Text View ⌥↩ reveals the newest image", edges: [["image view", "image last script", ALT], ["image last script", "reveal image", 0], ["image view", "open image script", CMD], ["image view", "call show_root", CMD | ALT]] },
  { id: "R17", what: "External Trigger view_chat opens the chat Text View", edges: [["trigger view_chat", "chat view", 0]] },
  { id: "R18", what: "External Trigger show_history opens the history list", edges: [["trigger show_history", "history list", 0]] },
];

function hasConnection([from, to, modifiers, output]: Expect): boolean {
  const list = (info.connections[uidFor(from)] ?? []) as any[];
  return list.some((c) => {
    if (c.destinationuid !== uidFor(to) || c.modifiers !== modifiers) return false;
    if (output === undefined) return c.sourceoutputuid === undefined;
    const condition = (objectsByUid.get(uidFor(from))?.config.conditions as any[]).find((cond) => cond.outputlabel === output);
    return condition !== undefined && c.sourceoutputuid === condition.uid;
  });
}

describe("routing contract", () => {
  for (const route of CONTRACT) {
    test(`${route.id}: ${route.what}`, () => {
      const generated = ROUTES.find((r) => r.id === route.id);
      expect(generated, `${route.id} (${route.what}) is missing from ROUTES`).toBeDefined();
      for (const edge of route.edges) {
        expect(hasConnection(edge), `${route.id} (${route.what}): no connection ${edge[0]} -> ${edge[1]} with modifier ${edge[2]}${edge[3] ? ` on output ${edge[3]}` : ""}`).toBe(true);
      }
    });
  }

  test("ROUTES holds exactly the contract's rows, and the plist holds no connection beyond them", () => {
    expect(ROUTES.map((r) => r.id)).toEqual(CONTRACT.map((r) => r.id));
    const expected = new Set(CONTRACT.flatMap((r) => r.edges.map(([from, to, mod, out]) => `${uidFor(from)}|${uidFor(to)}|${mod}|${out ?? ""}`)));
    const actual: string[] = [];
    for (const [from, list] of Object.entries(info.connections) as [string, any[]][]) {
      for (const c of list) {
        const source = objectsByUid.get(from);
        const label = c.sourceoutputuid === undefined ? "" : (source.config.conditions as any[]).find((cond) => cond.uid === c.sourceoutputuid).outputlabel;
        actual.push(`${from}|${c.destinationuid}|${c.modifiers}|${label}`);
      }
    }
    expect(actual.filter((entry) => !expected.has(entry))).toEqual([]);
  });

  test("no Script Filter adds a \"Use for Workflow Script Filter\" entry to the Universal Actions panel", () => {
    const filters = (info.objects as any[]).filter((o) => o.type === "alfred.workflow.input.scriptfilter");
    expect(filters.length).toBe(5);
    for (const filter of filters) expect(filter.config.skipuniversalaction, filter.uid).toBe(true);
  });

  test("every Text View can go back to the chat list with ⌘⌥↩, which closes the view", () => {
    for (const view of ["chat view", "image view", "preset result view"]) {
      const back = (info.connections[uidFor(view)] as any[]).find((c) => c.modifiers === (CMD | ALT));
      expect(back, `${view} has no ⌘⌥↩ connection`).toBeDefined();
      expect(back.destinationuid).toBe(uidFor("call show_root"));
      expect(back.vitoclose).toBe(true);
    }
    const call = objectsByUid.get(uidFor("call show_root")).config;
    expect(call).toMatchObject({ externaltriggerid: "show_root", passinputasargument: true });
  });

  test("the stop gesture closes the Text View and every Text View runs its own script with the C6 settings", () => {
    const stop = (info.connections[uidFor("chat view")] as any[]).find((c) => c.modifiers === SHIFT);
    expect(stop.vitoclose).toBe(true);
    const views = (info.objects as any[]).filter((o) => o.type === "alfred.workflow.userinterface.text");
    expect(views).toHaveLength(3);
    expect(views.map((v) => v.config.inputfile).sort()).toEqual(["chat.js", "image.js", "preset-view.js"]);
    for (const view of views) expect(view.config).toMatchObject({ inputtype: 1, scriptinput: 2, behaviour: 2 });
  });
});

describe("generated workflow", () => {
  test("every script file exists in Workflow/ and every script in Workflow/ is used", () => {
    const used = new Set<string>();
    for (const object of info.objects as any[]) {
      for (const file of [object.config.scriptfile, object.type === "alfred.workflow.userinterface.text" ? object.config.inputfile : undefined]) {
        if (typeof file === "string" && file !== "") {
          expect(existsSync(resolve(root, "Workflow", file)), `${file} is missing from Workflow/`).toBe(true);
          used.add(file);
        }
      }
    }
    const shipped = readdirSync(resolve(root, "Workflow")).filter((name) => name.endsWith(".js"));
    expect(shipped.filter((name) => !used.has(name))).toEqual([]);
  });

  test("only external scripts of type 8 are used, with the Run Script argv setting", () => {
    for (const object of info.objects as any[]) {
      if (object.type === "alfred.workflow.action.script") expect(object.config).toMatchObject({ type: 8, scriptargtype: 1 });
      if (object.type === "alfred.workflow.input.scriptfilter") expect(object.config.type).toBe(8);
    }
  });

  test("the keywords are configurable fields with their defaults, the chat alias is empty, and no keyword is hard-coded", () => {
    const fields = new Map((info.userconfigurationconfig as any[]).map((f) => [f.variable, f]));
    for (const [variable, value] of [["keyword_chat", "aichat"], ["keyword_chat_alias", ""], ["keyword_models", "aimodels"], ["keyword_presets", "aipresets"], ["keyword_image", "aiimage"]]) {
      expect(fields.get(variable)?.config.default).toBe(value);
    }
    expect(fields.get("keyword_chat_alias").config.required).toBe(false);
    const keywords = (info.objects as any[]).filter((o) => o.config.keyword !== undefined && o.config.keyword !== "").map((o) => o.config.keyword);
    expect(keywords.sort()).toEqual(["{var:keyword_chat_alias}", "{var:keyword_chat}", "{var:keyword_image}", "{var:keyword_models}", "{var:keyword_presets}"]);
  });

  test("the configuration holds every field the code reads, with the API key required, empty, and not exported", () => {
    const fields = new Map((info.userconfigurationconfig as any[]).map((f) => [f.variable, f]));
    const expected = ["openrouter_api_key", "keyword_chat", "keyword_chat_alias", "keyword_models", "keyword_presets", "keyword_image", "default_model", "system_prompt", "system_context", "max_context", "timeout_seconds", "pdf_engine", "web_default", "web_max_results", "reasoning_default", "keep_reasoning", "sources_style", "preset_clipboard", "auto_titles", "title_model", "translate_language", "export_folder", "images_folder", "image_model", "image_timeout_seconds", "vision_fallback_model", "retention_days", "max_chats", "text_attachment_max_kb", "image_max_edge"];
    expect([...fields.keys()]).toEqual(expected);
    expect(fields.get("openrouter_api_key").config).toMatchObject({ required: true, default: "" });
    expect(info.variablesdontexport).toEqual(["openrouter_api_key"]);
    expect(fields.get("pdf_engine").config.pairs.map((pair: string[]) => pair[1])).toEqual(["auto", "free", "ocr", "native"]);
    expect(fields.get("reasoning_default").config.pairs.map((pair: string[]) => pair[1])).toEqual(["model", "off", "low", "medium", "high"]);
    expect(fields.get("web_default").config.default).toBe(false);
    expect(fields.get("auto_titles").config.default).toBe(true);
    expect(fields.get("system_context").config.default).toBe(true);
    expect(fields.get("sources_style").config.default).toBe("links");
    expect(fields.get("sources_style").config.pairs.map((pair: string[]) => pair[1])).toEqual(["links", "icons"]);
    expect(fields.get("preset_clipboard").config.default).toBe(false);
    expect(fields.get("image_model").config.default).toBe("krea/krea-2-medium-turbo");
    expect(fields.get("system_prompt").config.default.length).toBeGreaterThan(200);
  });

  test("identity: bundle id, author, version from package.json, readme from docs/about.md", () => {
    expect(info).toMatchObject({ bundleid: "com.sillybit.aichat", createdby: "Sillybit", name: "AI Chat", version: pkg.version, webaddress: "https://github.com/Sillybit-io/silly-alfred-aichat" });
    expect(info.readme).toBe(readFileSync(resolve(root, "docs/about.md"), "utf8"));
    expect(info.readme).toContain("BSD 3-Clause");
    expect(info.readme).toContain("Running with Crayons");
  });

  test("the files Universal Action accepts single and multiple files, the text actions accept text", () => {
    const action = (name: string) => objectsByUid.get(uidFor(name)).config;
    expect(action("ask files action")).toMatchObject({ name: "AI Chat: Ask about these files", acceptsfiles: true, acceptstext: false, acceptsmulti: 1 });
    expect(action("ask text action").name).toBe("AI Chat: Ask about this text");
    expect(action("preset action").name).toBe("AI Chat: Run a preset…");
    const titles = ["Summarize", "Explain", "Translate", "Proofread", "Fix code", "Extract action items"];
    const names = (info.objects as any[]).filter((o) => o.type === "alfred.workflow.trigger.universalaction").map((o) => o.config.name as string);
    expect(names.sort()).toEqual(["AI Chat: Ask about these files", "AI Chat: Ask about this text", ...titles.map((t) => `AI Chat: ${t}`), "AI Chat: Run a preset…"].sort());
    for (const id of ["summarize", "explain", "translate", "proofread", "fix-code", "action-items"]) {
      expect(action(`preset action ${id}`)).toMatchObject({ acceptstext: true, acceptsfiles: false });
      expect(action(`preset vars ${id}`).variables).toEqual({ preset_id: id });
    }
    expect(action("ask text action")).toMatchObject({ acceptstext: true, acceptsfiles: false });
    expect(action("preset action")).toMatchObject({ acceptstext: true });
  });

  test("no object, field, or readme mentions usage, cost, credits, balance, or tokens", () => {
    expect(committed).not.toMatch(/\b(usage|costs?|credits?|balance|tokens?)\b/i);
  });

  test("the committed info.plist is exactly what the generator writes, and two runs give the same bytes", () => {
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(hash(renderPlist())).toBe(hash(renderPlist()));
    expect(hash(committed)).toBe(hash(renderPlist()));
    expect(buildWorkflow().objects.length).toBe(info.objects.length);
  });

  test("every called external trigger is defined", () => {
    const triggers = new Set((info.objects as any[]).filter((o) => o.type === "alfred.workflow.trigger.external").map((o) => o.config.triggerid));
    for (const object of info.objects as any[]) {
      if (object.type === "alfred.workflow.output.callexternaltrigger") expect(triggers.has(object.config.externaltriggerid)).toBe(true);
    }
    expect([...triggers].sort()).toEqual(["show_history", "show_image", "show_models", "show_presets", "show_root", "view_chat"]);
  });
});
