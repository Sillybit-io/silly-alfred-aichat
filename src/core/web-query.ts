import type { ContextTurn } from "./payload";

const MAX_ROWS = 6;
const MAX_ROW_CHARS = 400;
export const MAX_REWRITE_INPUT = 500;

export const REWRITE_PROMPT =
  "Rewrite the user's last message so it can be understood without the conversation, because it will be used for a web search. Fill in only what it leaves out, such as the place, subject, date, or names, taken from the conversation. Keep the user's wording and language, and do not answer it. If it already stands on its own, repeat it unchanged. Reply with only the rewritten message.";

type Row = { role: "user" | "assistant"; content: string };

function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

// The conversation so far and the new message, as the one user turn the rewriting model sees.
export function rewriteTurns(history: Row[], text: string): ContextTurn[] {
  const rows = history
    .slice(-MAX_ROWS)
    .map((row) => `${row.role === "user" ? "User" : "Assistant"}: ${clip(row.content.replace(/\s+/g, " ").trim(), MAX_ROW_CHARS)}`);
  return [
    { role: "system", content: REWRITE_PROMPT },
    { role: "user", content: `Conversation:\n${rows.join("\n")}\n\nLast message:\n${text}` },
  ];
}

// The rewritten message, or null when the reply is unusable or changes nothing.
export function cleanRewrite(reply: string, original: string): string | null {
  const stripped = reply
    .trim()
    .replace(/^(last message|rewritten message|rewrite)\s*:\s*/i, "")
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .trim();
  if (stripped === "" || stripped.length > original.length * 3 + 200) return null;
  return stripped === original.trim() ? null : stripped;
}
