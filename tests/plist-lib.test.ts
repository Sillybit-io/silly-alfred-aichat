import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parse } from "plist";
import { callExternalTrigger, connect, externalTrigger, keyword, MODIFIERS, PlistValidationError, serialize, uidFor, validate, type WorkflowDef } from "../scripts/lib/plist";
import { fixtureGraph } from "./fixtures/plist/graph";

const scriptDir = resolve(import.meta.dir, "fixtures/plist/scripts");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function mutated(change: (def: WorkflowDef) => void): WorkflowDef {
  const def = fixtureGraph();
  change(def);
  return def;
}

describe("plist generator", () => {
  test("the fixture serializes, parses back with integer modifiers, and two generations give identical bytes", () => {
    const first = serialize(fixtureGraph(), { scriptDir });
    const second = serialize(fixtureGraph(), { scriptDir });
    expect(sha(first)).toBe(sha(second));
    const parsed = parse(first) as any;
    expect(Object.keys(parsed).sort()).toEqual([
      "bundleid", "connections", "createdby", "description", "disabled", "name", "objects", "readme",
      "uidata", "userconfigurationconfig", "variables", "variablesdontexport", "version", "webaddress",
    ]);
    const all = Object.values(parsed.connections).flat() as any[];
    expect(all.map((c) => c.modifiers).sort((a, b) => a - b)).toEqual([0, 0, 0, 0, 0, 0, 0, 131072, 524288, 1048576]);
    for (const conn of all) expect(Number.isInteger(conn.modifiers)).toBe(true);
    expect(parsed.objects).toHaveLength(12);
    expect(parsed.objects[0].uid).toBe(uidFor("main keyword"));
  });

  test("conditional outputs carry the condition uid, and configuration types serialize", () => {
    const parsed = parse(serialize(fixtureGraph(), { scriptDir })) as any;
    const route = parsed.objects.find((o: any) => o.type === "alfred.workflow.utility.conditional");
    const outputs = (parsed.connections[route.uid] as any[]).map((c) => c.sourceoutputuid).sort();
    expect(outputs).toEqual(route.config.conditions.map((c: any) => c.uid).sort());
    expect(route.config.conditions.every((c: any) => c.matchmode === 0)).toBe(true);
    expect(parsed.userconfigurationconfig.map((f: any) => f.type)).toEqual(["textfield", "textarea", "checkbox", "popupbutton", "filepicker"]);
    expect(parsed.userconfigurationconfig[3].config.pairs).toEqual([["Fast", "fast"], ["Slow", "slow"]]);
  });

  test("a connection to an unknown object name throws naming it", () => {
    const def = mutated((d) => d.connections.push(connect("act", "nowhere")));
    expect(() => validate(def)).toThrow(PlistValidationError);
    expect(() => validate(def)).toThrow(/nowhere/);
  });

  test("an undeclared {var:missing} throws naming it and the object", () => {
    const def = mutated((d) => {
      d.objects.find((o) => o.name === "copy out")!.config.clipboardtext = "{var:missing}";
    });
    expect(() => validate(def)).toThrow(/copy out.*\{var:missing\}/);
  });

  test("combinations of ⇧ ⌃ ⌥ ⌘ are accepted, and anything else is not", () => {
    for (const modifiers of [MODIFIERS.command | MODIFIERS.option, MODIFIERS.shift | MODIFIERS.control | MODIFIERS.command, 0]) {
      expect(() => validate(mutated((d) => d.connections.push(connect("act", "copy out", { modifiers }))))).not.toThrow();
    }
    expect(() => validate(mutated((d) => d.connections.push(connect("act", "copy out", { modifiers: MODIFIERS.command | 1 }))))).toThrow(/modifier 1048577/);
    expect(() => validate(mutated((d) => d.connections.push(connect("act", "copy out", { modifiers: -1 }))))).toThrow(/modifier -1/);
  });

  test("modifier 3 throws naming the connection", () => {
    const def = mutated((d) => d.connections.push(connect("act", "copy out", { modifiers: 3 })));
    expect(() => validate(def)).toThrow(/modifier 3/);
  });

  test("a call to an undefined external trigger throws", () => {
    const def = mutated((d) => d.objects.push(callExternalTrigger("call ghost", { triggerid: "ghost" })));
    expect(() => validate(def)).toThrow(/ghost/);
  });

  test("a script file missing from the folder throws naming it", () => {
    const def = mutated((d) => {
      d.objects.find((o) => o.name === "act")!.config.scriptfile = "missing.js";
    });
    expect(() => validate(def, { scriptDir })).toThrow(/missing\.js/);
    expect(() => validate(fixtureGraph(), { scriptDir })).not.toThrow();
  });

  test("duplicate names, unknown condition outputs, and script types other than 8 are refused", () => {
    expect(() => validate(mutated((d) => d.objects.push(keyword("act", { keyword: "x" }))))).toThrow(/duplicate object name "act"/);
    expect(() => validate(mutated((d) => d.connections.push(connect("route", "copy out", { output: "nope" }))))).toThrow(/nope/);
    expect(() => validate(mutated((d) => { d.objects.find((o) => o.name === "act")!.config.type = 11; }))).toThrow(/type 8/);
  });

  test("variables set by an upstream Arg and Vars, a script declaration, or a configuration field are accepted", () => {
    const def = mutated((d) => {
      d.objects.push(externalTrigger("extra trigger", { triggerid: "extra" }));
      d.objects.find((o) => o.name === "fail out")!.config.text = "{var:next} {var:session_action} {var:keyword_main}";
    });
    expect(() => validate(def)).not.toThrow();
    expect(MODIFIERS.command).toBe(1048576);
  });
});
