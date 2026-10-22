import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { build } from "plist";

export const MODIFIERS = { none: 0, shift: 131072, control: 262144, option: 524288, command: 1048576 } as const;
export const COMMAND_OPTION = MODIFIERS.command | MODIFIERS.option;
const MODIFIER_MASK = MODIFIERS.shift | MODIFIERS.control | MODIFIERS.option | MODIFIERS.command;
// A connection modifier is none, one of ⇧ ⌃ ⌥ ⌘, or a combination of them (Alfred stores the bit sum).
const isKnownModifier = (value: number) => Number.isInteger(value) && value >= 0 && (value & ~MODIFIER_MASK) === 0;

type Config = Record<string, unknown>;

export type ObjectDef = {
  name: string;
  type: string;
  version: number;
  config: Config;
  position?: { x: number; y: number };
  note?: string;
  // Variables a script sets in its envelope, for the {var:x} check.
  declares?: string[];
};

export type Connection = {
  from: string;
  to: string;
  modifiers: number;
  subtext: string;
  vitoclose: boolean;
  output?: string;
};

export type ConfigField = {
  variable: string;
  label: string;
  type: "textfield" | "textarea" | "checkbox" | "popupbutton" | "filepicker";
  description?: string;
  default?: string | boolean;
  placeholder?: string;
  required?: boolean;
  text?: string;
  pairs?: [string, string][];
};

export type WorkflowDef = {
  bundleid: string;
  name: string;
  createdby: string;
  description: string;
  readme: string;
  webaddress: string;
  version: string;
  objects: ObjectDef[];
  connections: Connection[];
  config?: ConfigField[];
  variables?: Record<string, string>;
  variablesdontexport?: string[];
};

export class PlistValidationError extends Error {}

export function uidFor(name: string): string {
  const hex = createHash("sha256").update(name).digest("hex").toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function object(name: string, type: string, version: number, config: Config, extra: Partial<ObjectDef> = {}): ObjectDef {
  return { name, type, version, config, ...extra };
}

const ARGUMENT_TYPES = { required: 0, optional: 1, none: 2 } as const;

export function keyword(name: string, o: { keyword: string; title?: string; subtext?: string; argument?: keyof typeof ARGUMENT_TYPES; config?: Config } & Partial<ObjectDef>): ObjectDef {
  return object(name, "alfred.workflow.input.keyword", 1, {
    argumenttype: ARGUMENT_TYPES[o.argument ?? "optional"],
    keyword: o.keyword,
    subtext: o.subtext ?? "",
    text: o.title ?? name,
    withspace: true,
    ...o.config,
  }, pick(o));
}

export function scriptFilter(name: string, o: { scriptfile: string; keyword?: string; title?: string; subtext?: string; argument?: keyof typeof ARGUMENT_TYPES; config?: Config } & Partial<ObjectDef>): ObjectDef {
  return object(name, "alfred.workflow.input.scriptfilter", 3, {
    alfredfiltersresults: false,
    alfredfiltersresultsmatchmode: 0,
    argumenttrimmode: 0,
    argumenttype: ARGUMENT_TYPES[o.argument ?? "optional"],
    escaping: 102,
    keyword: o.keyword ?? "",
    queuedelaycustom: 3,
    queuedelayimmediatelyinitially: true,
    queuedelaymode: 0,
    queuemode: 1,
    runningsubtext: "",
    script: "",
    scriptargtype: 1,
    scriptfile: o.scriptfile,
    // Keeps Alfred from listing "Use for Workflow Script Filter" in the Universal Actions panel.
    skipuniversalaction: true,
    subtext: o.subtext ?? "",
    title: o.title ?? name,
    type: 8,
    withspace: true,
    ...o.config,
  }, pick(o));
}

export function textView(name: string, o: { scriptfile: string; config?: Config } & Partial<ObjectDef>): ObjectDef {
  return object(name, "alfred.workflow.userinterface.text", 1, {
    behaviour: 2,
    fontmode: 0,
    fontsizing: 0,
    footertext: "",
    inputfile: o.scriptfile,
    inputtype: 1,
    loadingtext: "",
    outputmode: 1,
    scriptinput: 2,
    spellchecking: 0,
    stackview: false,
    ...o.config,
  }, pick(o));
}

// `title` is the name Alfred lists in the Universal Actions panel; the object name stays the stable id.
export function universalAction(name: string, o: { title?: string; text?: boolean; files?: boolean; multiple?: boolean; urls?: boolean; config?: Config } & Partial<ObjectDef>): ObjectDef {
  return object(name, "alfred.workflow.trigger.universalaction", 1, {
    acceptsfiles: o.files ?? false,
    acceptsmulti: o.multiple ? 1 : 0,
    acceptstext: o.text ?? false,
    acceptsurls: o.urls ?? false,
    name: o.title ?? name,
    ...o.config,
  }, pick(o));
}

export function externalTrigger(name: string, o: { triggerid: string; config?: Config } & Partial<ObjectDef>): ObjectDef {
  return object(name, "alfred.workflow.trigger.external", 1, { triggerid: o.triggerid, ...o.config }, pick(o));
}

export function callExternalTrigger(name: string, o: { triggerid: string; passInput?: boolean; passVariables?: boolean; config?: Config } & Partial<ObjectDef>): ObjectDef {
  return object(name, "alfred.workflow.output.callexternaltrigger", 1, {
    externaltriggerid: o.triggerid,
    passinputasargument: o.passInput ?? true,
    passvariables: o.passVariables ?? true,
    workflowbundleid: "self",
    ...o.config,
  }, pick(o));
}

export function runScript(name: string, o: { scriptfile: string; declares?: string[]; config?: Config } & Partial<ObjectDef>): ObjectDef {
  return object(name, "alfred.workflow.action.script", 2, {
    concurrently: false,
    escaping: 102,
    script: "",
    scriptargtype: 1,
    scriptfile: o.scriptfile,
    type: 8,
    ...o.config,
  }, pick(o));
}

export function argVars(name: string, o: { argument?: string; passthrough?: boolean; variables?: Record<string, string>; config?: Config } & Partial<ObjectDef>): ObjectDef {
  return object(name, "alfred.workflow.utility.argument", 1, {
    argument: o.argument ?? "{query}",
    passthroughargument: o.passthrough ?? false,
    variables: o.variables ?? {},
    ...o.config,
  }, pick(o));
}

export function conditional(name: string, o: { variable: string; outputs: { label: string; match: string }[]; elseLabel?: string; config?: Config } & Partial<ObjectDef>): ObjectDef {
  return object(name, "alfred.workflow.utility.conditional", 1, {
    conditions: o.outputs.map((out) => ({
      inputstring: `{var:${o.variable}}`,
      matchcasesensitive: false,
      matchmode: 0,
      matchstring: out.match,
      outputlabel: out.label,
      uid: uidFor(`${name}/${out.label}`),
    })),
    elselabel: o.elseLabel ?? "else",
    hideelse: o.elseLabel === undefined,
    ...o.config,
  }, pick(o));
}

export function clipboard(name: string, o: { autopaste?: boolean; text?: string; config?: Config } & Partial<ObjectDef> = {}): ObjectDef {
  return object(name, "alfred.workflow.output.clipboard", 3, {
    autopaste: o.autopaste ?? false,
    clipboardtext: o.text ?? "{query}",
    ignoredynamic: false,
    transient: false,
    ...o.config,
  }, pick(o));
}

export function largeType(name: string, o: { text?: string; config?: Config } & Partial<ObjectDef> = {}): ObjectDef {
  return object(name, "alfred.workflow.output.largetype", 3, { largetypetext: o.text ?? "{query}", ...o.config }, pick(o));
}

export function notification(name: string, o: { title: string; text: string; config?: Config } & Partial<ObjectDef>): ObjectDef {
  return object(name, "alfred.workflow.output.notification", 1, {
    lastpathcomponent: false,
    onlyshowifquerypopulated: false,
    removeextension: false,
    text: o.text,
    title: o.title,
    ...o.config,
  }, pick(o));
}

export function revealFile(name: string, o: { path?: string; config?: Config } & Partial<ObjectDef> = {}): ObjectDef {
  return object(name, "alfred.workflow.action.revealfile", 1, { path: o.path ?? "{query}", ...o.config }, pick(o));
}

function pick(o: Partial<ObjectDef>): Partial<ObjectDef> {
  const extra: Partial<ObjectDef> = {};
  if (o.position) extra.position = o.position;
  if (o.note) extra.note = o.note;
  if (o.declares) extra.declares = o.declares;
  return extra;
}

export function connect(from: string, to: string, o: { modifiers?: number; subtext?: string; vitoclose?: boolean; output?: string } = {}): Connection {
  return { from, to, modifiers: o.modifiers ?? 0, subtext: o.subtext ?? "", vitoclose: o.vitoclose ?? false, ...(o.output ? { output: o.output } : {}) };
}

const VAR_PATTERN = /\{var:([A-Za-z0-9_]+)\}/g;

function stringsIn(value: unknown, out: string[], skipKeys: Set<string>): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out, skipKeys);
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) if (!skipKeys.has(key)) stringsIn(item, out, skipKeys);
  }
}

function variablesUsed(config: Config): string[] {
  const texts: string[] = [];
  stringsIn(config, texts, new Set(["script", "variables"]));
  const found: string[] = [];
  for (const text of texts) for (const match of text.matchAll(VAR_PATTERN)) found.push(match[1]!);
  const nested = config.variables;
  if (typeof nested === "object" && nested !== null) {
    for (const value of Object.values(nested)) if (typeof value === "string") for (const match of value.matchAll(VAR_PATTERN)) found.push(match[1]!);
  }
  return found;
}

export function validate(def: WorkflowDef, options: { scriptDir?: string } = {}): void {
  const byName = new Map<string, ObjectDef>();
  const uids = new Map<string, string>();
  for (const obj of def.objects) {
    if (byName.has(obj.name)) throw new PlistValidationError(`duplicate object name "${obj.name}"`);
    const uid = uidFor(obj.name);
    if (uids.has(uid)) throw new PlistValidationError(`uid collision between "${obj.name}" and "${uids.get(uid)}"`);
    byName.set(obj.name, obj);
    uids.set(uid, obj.name);
  }

  const incoming = new Map<string, string[]>();
  for (const conn of def.connections) {
    const from = byName.get(conn.from);
    if (!from) throw new PlistValidationError(`connection from unknown object "${conn.from}"`);
    if (!byName.has(conn.to)) throw new PlistValidationError(`connection from "${conn.from}" to unknown object "${conn.to}"`);
    if (!isKnownModifier(conn.modifiers)) {
      throw new PlistValidationError(`connection "${conn.from}" -> "${conn.to}" uses modifier ${conn.modifiers}, which is not none, ⇧ ⌃ ⌥ ⌘, or a combination of them`);
    }
    if (conn.output !== undefined) {
      const conditions = from.config.conditions;
      const known = Array.isArray(conditions) && conditions.some((c) => (c as { outputlabel?: string }).outputlabel === conn.output);
      if (!known) throw new PlistValidationError(`connection from "${conn.from}" names output "${conn.output}", which that object does not have`);
    }
    incoming.set(conn.to, [...(incoming.get(conn.to) ?? []), conn.from]);
  }

  const triggers = new Set<string>();
  for (const obj of def.objects) if (obj.type === "alfred.workflow.trigger.external") triggers.add(String(obj.config.triggerid));
  for (const obj of def.objects) {
    if (obj.type !== "alfred.workflow.output.callexternaltrigger") continue;
    const id = String(obj.config.externaltriggerid);
    if (!triggers.has(id)) throw new PlistValidationError(`"${obj.name}" calls external trigger "${id}", which no object defines`);
    for (const target of def.objects) {
      if (target.type === "alfred.workflow.trigger.external" && target.config.triggerid === id) {
        incoming.set(target.name, [...(incoming.get(target.name) ?? []), obj.name]);
      }
    }
  }

  const configVariables = new Set((def.config ?? []).map((field) => field.variable));
  for (const key of Object.keys(def.variables ?? {})) configVariables.add(key);
  const provided = (name: string): Set<string> => {
    const obj = byName.get(name)!;
    const set = new Set<string>(obj.declares ?? []);
    if (obj.type === "alfred.workflow.utility.argument") {
      const vars = obj.config.variables;
      if (typeof vars === "object" && vars !== null) for (const key of Object.keys(vars)) set.add(key);
    }
    return set;
  };
  for (const obj of def.objects) {
    const used = variablesUsed(obj.config);
    if (used.length === 0) continue;
    const upstream = new Set<string>();
    const seen = new Set<string>([obj.name]);
    const queue = [...(incoming.get(obj.name) ?? [])];
    while (queue.length > 0) {
      const next = queue.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const variable of provided(next)) upstream.add(variable);
      queue.push(...(incoming.get(next) ?? []));
    }
    for (const variable of used) {
      if (!configVariables.has(variable) && !upstream.has(variable)) {
        throw new PlistValidationError(`"${obj.name}" uses {var:${variable}}, which no configuration field, upstream Arg and Vars, or script declares`);
      }
    }
  }

  for (const obj of def.objects) {
    if ("scriptfile" in obj.config && obj.config.type !== undefined && obj.config.type !== 8) {
      throw new PlistValidationError(`"${obj.name}" uses script type ${String(obj.config.type)}; only type 8 (external script) is allowed`);
    }
  }
  if (options.scriptDir !== undefined) {
    for (const obj of def.objects) {
      const files = [obj.config.scriptfile, obj.type === "alfred.workflow.userinterface.text" ? obj.config.inputfile : undefined];
      for (const file of files) {
        if (typeof file === "string" && file !== "" && !existsSync(join(options.scriptDir, file))) {
          throw new PlistValidationError(`"${obj.name}" names script file "${file}", which is not in ${options.scriptDir}`);
        }
      }
    }
  }
}

function userConfig(field: ConfigField): Config {
  const config: Config = {};
  switch (field.type) {
    case "textfield":
    case "textarea":
      config.default = field.default ?? "";
      config.placeholder = field.placeholder ?? "";
      config.required = field.required ?? false;
      config.trim = true;
      break;
    case "checkbox":
      config.default = field.default ?? false;
      config.required = false;
      config.text = field.text ?? field.label;
      break;
    case "popupbutton":
      config.default = field.default ?? field.pairs?.[0]?.[1] ?? "";
      config.pairs = (field.pairs ?? []).map(([label, value]) => [label, value]);
      break;
    case "filepicker":
      config.default = field.default ?? "";
      config.filtermode = 0;
      config.placeholder = field.placeholder ?? "";
      config.required = field.required ?? false;
      break;
  }
  return { config, description: field.description ?? "", label: field.label, type: field.type, variable: field.variable };
}

function layout(def: WorkflowDef): Record<string, { xpos: number; ypos: number; note?: string }> {
  const uidata: Record<string, { xpos: number; ypos: number; note?: string }> = {};
  def.objects.forEach((obj, index) => {
    const position = obj.position ?? { x: 30 + (index % 6) * 170, y: 30 + Math.floor(index / 6) * 130 };
    uidata[uidFor(obj.name)] = { xpos: position.x, ypos: position.y, ...(obj.note ? { note: obj.note } : {}) };
  });
  return uidata;
}

export function toPlistObject(def: WorkflowDef): Record<string, unknown> {
  const connections: Record<string, unknown[]> = {};
  for (const conn of def.connections) {
    const entry: Record<string, unknown> = {
      destinationuid: uidFor(conn.to),
      modifiers: conn.modifiers,
      modifiersubtext: conn.subtext,
      vitoclose: conn.vitoclose,
    };
    if (conn.output !== undefined) {
      const source = def.objects.find((obj) => obj.name === conn.from)!;
      const condition = (source.config.conditions as { outputlabel: string; uid: string }[]).find((c) => c.outputlabel === conn.output)!;
      entry.sourceoutputuid = condition.uid;
    }
    const key = uidFor(conn.from);
    connections[key] = [...(connections[key] ?? []), entry];
  }
  return {
    bundleid: def.bundleid,
    connections,
    createdby: def.createdby,
    description: def.description,
    disabled: false,
    name: def.name,
    objects: def.objects.map((obj) => ({ config: obj.config, type: obj.type, uid: uidFor(obj.name), version: obj.version })),
    readme: def.readme,
    uidata: layout(def),
    userconfigurationconfig: (def.config ?? []).map(userConfig),
    variables: def.variables ?? {},
    variablesdontexport: def.variablesdontexport ?? [],
    version: def.version,
    webaddress: def.webaddress,
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function serialize(def: WorkflowDef, options: { scriptDir?: string } = {}): string {
  validate(def, options);
  return `${build(sortKeys(toPlistObject(def)) as Record<string, unknown>)}\n`;
}
