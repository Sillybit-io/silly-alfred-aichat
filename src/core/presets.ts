export type PresetOutput = "textview" | "clipboard" | "paste" | "largetype";

export type Preset = {
  id: string;
  name: string;
  prompt: string;
  system?: string;
  model?: string;
  web?: boolean;
  think?: string;
  output: PresetOutput;
};

export type PresetError = { line: number; message: string };

export const OUTPUTS: PresetOutput[] = ["textview", "clipboard", "paste", "largetype"];
const THINK_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// {text} is the selected or clipboard text; {language} is translate_language from Configuration.
export const DEFAULT_PRESETS: Preset[] = [
  { id: "summarize", name: "Summarize", prompt: "Summarize the following text concisely:\n\n{text}", output: "textview" },
  { id: "explain", name: "Explain", prompt: "Explain the following text in simple terms:\n\n{text}", output: "textview" },
  { id: "translate", name: "Translate", prompt: "Translate the following text to {language}. Reply with only the translation:\n\n{text}", output: "clipboard" },
  { id: "proofread", name: "Proofread", prompt: "Proofread the following text. Fix spelling, grammar, and punctuation without changing its meaning or tone. Reply with only the corrected text:\n\n{text}", output: "paste" },
  { id: "fix-code", name: "Fix code", prompt: "Find and fix the bugs in the following code. Explain each fix briefly, then show the corrected code:\n\n{text}", output: "textview" },
  { id: "action-items", name: "Extract action items", prompt: "List the action items in the following text as short bullet points, with an owner and a date when the text names them:\n\n{text}", output: "largetype" },
];

export function defaultPresetsJson(): string {
  return `${JSON.stringify(DEFAULT_PRESETS, null, 2)}\n`;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Located = { value: Json; lines: WeakMap<object, number>; keyLines: WeakMap<object, Record<string, number>> };

class JsonError extends Error {
  constructor(
    public line: number,
    message: string,
  ) {
    super(message);
  }
}

// A small strict JSON parser that remembers the line of every object and key, so a mistake in
// presets.json is reported as "line 7" rather than "unexpected token".
function parseLocated(text: string): Located {
  const lines = new WeakMap<object, number>();
  const keyLines = new WeakMap<object, Record<string, number>>();
  let index = 0;
  let line = 1;
  const fail = (message: string): never => {
    throw new JsonError(line, message);
  };
  const skip = () => {
    while (index < text.length) {
      const ch = text[index]!;
      if (ch === "\n") line++;
      else if (ch !== " " && ch !== "\t" && ch !== "\r") break;
      index++;
    }
  };
  const string = (): string => {
    index++;
    let result = "";
    while (index < text.length) {
      const ch = text[index]!;
      if (ch === '"') {
        index++;
        return result;
      }
      if (ch === "\n") fail("a string is not closed before the end of the line");
      if (ch === "\\") {
        const next = text[index + 1];
        const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (next === "u") {
          const hex = text.slice(index + 2, index + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("a \\u escape needs four hex digits");
          result += String.fromCharCode(parseInt(hex, 16));
          index += 6;
          continue;
        }
        if (next === undefined || simple[next] === undefined) fail(`unknown escape \\${next ?? ""}`);
        result += simple[next!]!;
        index += 2;
        continue;
      }
      result += ch;
      index++;
    }
    return fail("a string is not closed");
  };
  const value = (): Json => {
    skip();
    const ch = text[index];
    if (ch === "{") {
      const object: { [key: string]: Json } = {};
      lines.set(object, line);
      const keys: Record<string, number> = {};
      keyLines.set(object, keys);
      index++;
      skip();
      if (text[index] === "}") {
        index++;
        return object;
      }
      for (;;) {
        skip();
        if (text[index] !== '"') fail("expected a quoted property name");
        const keyLine = line;
        const key = string();
        keys[key] = keyLine;
        skip();
        if (text[index] !== ":") fail(`expected ":" after "${key}"`);
        index++;
        object[key] = value();
        skip();
        if (text[index] === ",") {
          index++;
          continue;
        }
        if (text[index] === "}") {
          index++;
          return object;
        }
        fail('expected "," or "}"');
      }
    }
    if (ch === "[") {
      const array: Json[] = [];
      lines.set(array, line);
      index++;
      skip();
      if (text[index] === "]") {
        index++;
        return array;
      }
      for (;;) {
        array.push(value());
        skip();
        if (text[index] === ",") {
          index++;
          continue;
        }
        if (text[index] === "]") {
          index++;
          return array;
        }
        fail('expected "," or "]"');
      }
    }
    if (ch === '"') return string();
    for (const [word, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, index)) {
        index += word.length;
        return result;
      }
    }
    const number = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(index));
    if (number) {
      index += number[0].length;
      return Number(number[0]);
    }
    return fail(ch === undefined ? "the file ends too early" : `unexpected "${ch}"`);
  };
  const result = value();
  skip();
  if (index < text.length) fail("unexpected text after the list");
  return { value: result, lines, keyLines };
}

export function parsePresets(text: string): { presets: Preset[]; errors: PresetError[] } {
  let located: Located;
  try {
    located = parseLocated(text);
  } catch (error) {
    if (error instanceof JsonError) return { presets: [], errors: [{ line: error.line, message: error.message }] };
    throw error;
  }
  const errors: PresetError[] = [];
  const presets: Preset[] = [];
  const root = located.value;
  if (!Array.isArray(root)) return { presets: [], errors: [{ line: 1, message: "presets.json must hold a list of presets between [ and ]" }] };
  const ids = new Set<string>();
  for (const item of root) {
    const line = typeof item === "object" && item !== null ? (located.lines.get(item) ?? 1) : 1;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      errors.push({ line, message: "each preset must be an object between { and }" });
      continue;
    }
    const keyLine = (key: string) => located.keyLines.get(item)?.[key] ?? line;
    const problems: PresetError[] = [];
    const str = (key: string, required: boolean): string | undefined => {
      const v = item[key];
      if (v === undefined) {
        if (required) problems.push({ line, message: `a preset needs "${key}"` });
        return undefined;
      }
      if (typeof v !== "string" || v.trim() === "") {
        problems.push({ line: keyLine(key), message: `"${key}" must be a non-empty string` });
        return undefined;
      }
      return v;
    };
    const id = str("id", true);
    const name = str("name", true);
    const prompt = str("prompt", true);
    const system = str("system", false);
    const model = str("model", false);
    const think = str("think", false);
    if (id !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(id)) problems.push({ line: keyLine("id"), message: `"id" may use only lower-case letters, digits, and hyphens (got "${id}")` });
    if (id !== undefined && ids.has(id)) problems.push({ line: keyLine("id"), message: `"id" "${id}" is used twice` });
    if (prompt !== undefined && prompt.indexOf("{text}") < 0) problems.push({ line: keyLine("prompt"), message: '"prompt" must contain {text}, where the selected text goes' });
    if (think !== undefined && THINK_VALUES.indexOf(think) < 0) problems.push({ line: keyLine("think"), message: `"think" must be one of ${THINK_VALUES.join(", ")}` });
    let web: boolean | undefined;
    if (item.web !== undefined) {
      if (typeof item.web === "boolean") web = item.web;
      else problems.push({ line: keyLine("web"), message: '"web" must be true or false' });
    }
    let output: PresetOutput = "textview";
    if (item.output !== undefined) {
      if (typeof item.output === "string" && (OUTPUTS as string[]).indexOf(item.output) >= 0) output = item.output as PresetOutput;
      else problems.push({ line: keyLine("output"), message: `"output" must be one of ${OUTPUTS.join(", ")}` });
    }
    if (problems.length > 0) {
      errors.push(...problems);
      continue;
    }
    ids.add(id!);
    presets.push({ id: id!, name: name!, prompt: prompt!, ...(system ? { system } : {}), ...(model ? { model } : {}), ...(web !== undefined ? { web } : {}), ...(think ? { think } : {}), output });
  }
  return { presets, errors };
}

export function fillPrompt(preset: Preset, text: string, language: string): string {
  // The text goes in last, so braces inside it are never read as placeholders.
  return preset.prompt.replace(/\{language\}/g, language).split("{text}").join(text);
}

export function outputLabel(output: PresetOutput): string {
  return { textview: "open in a chat", clipboard: "copy the reply", paste: "paste the reply", largetype: "show in Large Type" }[output];
}
