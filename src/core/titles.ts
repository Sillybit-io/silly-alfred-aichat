const MAX_WORDS = 6;

// Reduces a model's reply to a short, plain title: no quotes, no trailing punctuation, six words.
export function cleanTitle(reply: string): string {
  const firstLine = reply.split("\n").find((line) => line.trim() !== "") ?? "";
  const stripped = firstLine
    .replace(/^#+\s*/, "")
    .replace(/^(title:\s*)/i, "")
    .replace(/^["'“”‘’`*_]+|["'“”‘’`*_]+$/g, "")
    .trim();
  const words = stripped.split(/\s+/).filter((word) => word !== "");
  return words.slice(0, MAX_WORDS).join(" ").replace(/[.,;:!?…]+$/, "");
}

export const TITLE_PROMPT = "Write a title of at most six words for the conversation below. Reply with only the title: no quotes, no trailing punctuation.";

export function relativeTime(now: number, then: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(then).toISOString().slice(0, 10);
}

export function fileSafe(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return cleaned === "" ? "Chat" : cleaned;
}
