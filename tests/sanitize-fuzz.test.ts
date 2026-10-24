import { describe, expect, test } from "bun:test";
import { sanitizeMarkdown } from "../src/core/sanitize";

// Random hostile Markdown, read back with an independent, strict reading: outside code there must be no image start, no tag
// start, no link that is not https, no link definition, and no fence left open. Read twice, because a viewer may end an
// indented fence at a less indented line (inside a list item) or not (top level). Writing it found real holes: fences made
// by replaced links, indented openers, and brackets that pair up only after a replacement.
const ROOT = "/Users/me/Pictures/AI Chat";
const tokens = ["![", "!", "[", "]", "(", ")", "](", "<", ">", "<img src=", "`", "``", "```", "~~~", "\\", "\n", "\n\n", "\r", " ", "  ", "> ", "- ", "1. ", "https://evil.example/p.gif?q=S", "http://evil.example/x", "javascript:alert(1)", "[r]:", "[r]", "[r][r]", "![r]", "![r][r]", "x", "\"t\"", "<https://evil.example/a>", "<!--", "<?", "<a href=", "\t", "&#60;img", "[^1]:", "```\n", "\n```\n", "\n~~~\n", "   ```", "`a`", "``a`b``", "[a](", "[~~~", "[```", "]()", "\n[", "~~~\n", "\n~~~", "  ~~~", "- ```", "> ```", "[a](https://ok.example.com/x)", "![a](/Users/me/Pictures/AI Chat/a.png)", "| a | b |", "<br>", "&lt;img&gt;"];

function generator(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// CommonMark reading of one line: escapes work outside code spans only; a closing run ignores them.
function strip(line: string): string {
  let out = ""; let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === "\\" && i + 1 < line.length && /[!-\/:-@\[-`{-~]/.test(line[i + 1]!)) { out += "  "; i += 2; continue; }
    if (c === "`") {
      let n = 0; while (line[i + n] === "`") n++;
      let j = i + n, end = -1;
      while (j < line.length) { if (line[j] === "`") { let m = 0; while (line[j + m] === "`") m++; if (m === n) { end = j + m; break; } j += m; } else j++; }
      if (end > 0) { out += " ".repeat(end - i); i = end; continue; }
      out += "`".repeat(n); i += n; continue;
    }
    out += c; i++;
  }
  return out;
}

function cols(line: string): number { let c = 0; for (const ch of line) { if (ch === " ") c++; else if (ch === "\t") c += 4 - (c % 4); else break; } return c; }
function problems(out: string, listAware = false): string[] {
  const found: string[] = [];
  let fence: string | null = null;
  let fenceIndent = 0;
  for (const line of out.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence !== null && listAware && line.trim() !== "" && cols(line) < fenceIndent && !new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`).test(line)) { fence = null; }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null && open && !(open[1]![0] === "`" && line.slice(line.indexOf(open[1]!) + open[1]!.length).includes("`"))) { fence = open[1]!; fenceIndent = cols(line); continue; }
        if (fence !== null) { if (new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`).test(line)) fence = null; continue; }
    const t = strip(line.replace(/!\[\]\(\/Users\/me\/Pictures\/AI Chat\/[^()\[\]?#]*\)/g, " ")).replace(/<https:\/\/[^\s<>`\\]+>/gi, (m) => " ".repeat(m.length));
    if (/!\[/.test(t)) found.push(`image start: ${JSON.stringify(line)}`);
    if (/<[A-Za-z\/!?]/.test(t)) found.push(`tag: ${JSON.stringify(line)}`);
    for (const m of t.matchAll(/\[[^\[\]]*\]\(((?:[^()\s]|\([^()]*\))*)\)/g)) if (m[1]!.trim() !== "" && !/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(m[1]!.trim())) found.push(`link dest ${m[1]}: ${JSON.stringify(line)}`);
    if (/^\s*(?:[>\-+*]\s*)*\[[^\]^][^\]]*\]:/.test(line)) found.push(`definition: ${JSON.stringify(line)}`);
  }
  if (fence !== null) found.push("open fence at end");
  return found;
}


describe("sanitizer fuzz", () => {
  for (const seed of [1, 2, 3, 4]) {
    test(`seed ${seed}: 25000 random inputs leave nothing live`, () => {
      const rnd = generator(seed);
      const pick = () => tokens[Math.floor(rnd() * tokens.length)]!;
      const failures: string[] = [];
      for (let n = 0; n < 25000 && failures.length < 5; n++) {
        let input = "";
        const length = 1 + Math.floor(rnd() * 22);
        for (let i = 0; i < length; i++) input += pick();
        const output = sanitizeMarkdown(input, { imageRoots: [ROOT] });
        const found = [...problems(output), ...problems(output, true)];
        if (found.length > 0) failures.push(`${JSON.stringify(input)} -> ${found.join(" | ")}`);
      }
      expect(failures).toEqual([]);
    });
  }
});
