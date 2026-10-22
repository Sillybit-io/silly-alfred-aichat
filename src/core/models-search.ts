import { acceptsFile, acceptsImage, isFree, perMillion, pricedPerUse, producesImage, supportsReasoning, type ModelRecord } from "./capabilities";

export type ModelQuery = { words: string[]; image: boolean; imagegen: boolean; file: boolean; free: boolean; reasoning: boolean };

export type SearchOptions = { favorites?: string[]; limit?: number };

export function parseQuery(query: string): ModelQuery {
  const parsed: ModelQuery = { words: [], image: false, imagegen: false, file: false, free: false, reasoning: false };
  for (const token of query.toLowerCase().split(/\s+/)) {
    if (token === "") continue;
    if (token === "#image") parsed.image = true;
    else if (token === "#imagegen") parsed.imagegen = true;
    else if (token === "#file") parsed.file = true;
    else if (token === "#free") parsed.free = true;
    else if (token === "#reasoning") parsed.reasoning = true;
    else parsed.words.push(token);
  }
  return parsed;
}

// 0 means no match; word starts and exact ids rank above substrings.
function wordScore(model: ModelRecord, word: string): number {
  const id = model.id.toLowerCase();
  const name = model.name.toLowerCase();
  const slug = id.slice(id.indexOf("/") + 1);
  if (id === word || slug === word) return 100;
  if (id.startsWith(word)) return 60;
  if (slug.startsWith(word) || name.startsWith(word)) return 50;
  if (name.split(/[\s:/()-]+/).some((part) => part.startsWith(word)) || slug.split(/[-_.:/]/).some((part) => part.startsWith(word))) return 30;
  if (id.includes(word) || name.includes(word)) return 10;
  return 0;
}

export function searchModels(models: ModelRecord[], query: string, options: SearchOptions = {}): ModelRecord[] {
  const parsed = parseQuery(query);
  const favorites = options.favorites ?? [];
  const ranked: { model: ModelRecord; score: number; order: number }[] = [];
  models.forEach((model, order) => {
    if (parsed.image && !acceptsImage(model)) return;
    if (parsed.imagegen && !producesImage(model)) return;
    if (parsed.file && !acceptsFile(model)) return;
    if (parsed.free && !isFree(model)) return;
    if (parsed.reasoning && !supportsReasoning(model)) return;
    let score = 0;
    for (const word of parsed.words) {
      const wordRank = wordScore(model, word);
      if (wordRank === 0) return;
      score += wordRank;
    }
    ranked.push({ model, score, order });
  });
  ranked.sort((a, b) => {
    const fa = favorites.indexOf(a.model.id);
    const fb = favorites.indexOf(b.model.id);
    if ((fa >= 0) !== (fb >= 0)) return fa >= 0 ? -1 : 1;
    if (fa >= 0 && fb >= 0 && fa !== fb) return fa - fb;
    return b.score - a.score || a.order - b.order;
  });
  const found = ranked.map((entry) => entry.model);
  return options.limit === undefined ? found : found.slice(0, options.limit);
}

export function formatPrice(perMillionTokens: number): string {
  if (perMillionTokens === 0) return "$0";
  if (perMillionTokens >= 1) return `$${Number(perMillionTokens.toFixed(2))}`;
  return `$${Number(perMillionTokens.toPrecision(2))}`;
}

export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

export function badges(model: ModelRecord): string {
  const list: string[] = [];
  if (acceptsImage(model)) list.push("🖼");
  if (producesImage(model)) list.push("🎨");
  if (acceptsFile(model)) list.push("📄");
  if (supportsReasoning(model)) list.push("🧠");
  if (isFree(model)) list.push("🆓");
  return list.join(" ");
}

// Model prices describe the model, never what a user has spent.
export function formatSubtitle(model: ModelRecord): string {
  const parts: string[] = [];
  const marks = badges(model);
  if (marks !== "") parts.push(marks);
  if (isFree(model)) parts.push("free");
  else if (pricedPerUse(model)) parts.push(producesImage(model) ? "priced per image" : "priced per use");
  else if (model.completionPrice === 0 && !model.outputModalities.includes("text")) parts.push(`${formatPrice(perMillion(model.promptPrice))} in per 1M tokens`);
  else parts.push(`${formatPrice(perMillion(model.promptPrice))} in · ${formatPrice(perMillion(model.completionPrice))} out per 1M tokens`);
  if (model.contextLength > 0) parts.push(`${formatContext(model.contextLength)} context`);
  return parts.join(" · ");
}
