import type { AttachmentRef } from "../store/chats";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_PENDING = 8;
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export type Classified = { kind: AttachmentRef["kind"] | "unknown"; ext: string; mime: string };

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

export function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

// Images and PDFs are told apart by extension; anything else may still be inline text once its bytes are read.
export function classifyName(name: string): Classified {
  const ext = extensionOf(name);
  const image = IMAGE_MIME[ext];
  if (image) return { kind: "image", ext: ext === "jpeg" ? "jpg" : ext, mime: image };
  if (ext === "pdf") return { kind: "file", ext, mime: "application/pdf" };
  return { kind: "unknown", ext: ext === "" ? "txt" : ext, mime: "text/plain" };
}

export function looksLikeText(bytes: Uint8Array): boolean {
  const sample = Math.min(bytes.length, 8192);
  for (let i = 0; i < sample; i++) if (bytes[i] === 0) return false;
  return true;
}

export function megabytes(bytes: number): string {
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}

export type Refusal = { name: string; reason: string };

export function oversizeRefusal(name: string, size: number): Refusal | null {
  return size > MAX_FILE_BYTES ? { name, reason: `is ${megabytes(size)}, over the ${megabytes(MAX_FILE_BYTES).replace(".0", "")} per-file cap` } : null;
}

export function pdfCapNote(): string {
  return `20 MB per file, ${MAX_PENDING} files per message`;
}
