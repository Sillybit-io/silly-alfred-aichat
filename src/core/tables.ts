// Alfred's Text View has no tables: pipe rows run together into one paragraph. For display, each table
// becomes a bullet list, "- **first column** — Header: value · Header: value". Code blocks are left alone.

const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  const parts = line.trim().split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
  if (parts[0] === "") parts.shift();
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function bullet(headers: string[], row: string[]): string {
  const [first = "", ...rest] = row;
  const label = first === "" ? "" : first.includes("**") ? first : `**${first}**`;
  const facts = rest.flatMap((cell, i) => (cell === "" ? [] : [headers[i + 1] ? `${headers[i + 1]}: ${cell}` : cell]));
  const body = facts.join(" · ");
  return `- ${[label, body].filter((part) => part !== "").join(" — ")}`;
}

export function flattenTables(markdown: string): string {
  if (!markdown.includes("|")) return markdown;
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const next = lines[i + 1];
    if (fenced || !line.includes("|") || next === undefined || !SEPARATOR.test(next) || !next.includes("-")) {
      out.push(line);
      continue;
    }
    const headers = cells(line);
    i += 1;
    while (i + 1 < lines.length && lines[i + 1]!.trim() !== "" && lines[i + 1]!.includes("|")) {
      i += 1;
      out.push(bullet(headers, cells(lines[i]!)));
    }
  }
  return out.join("\n");
}
