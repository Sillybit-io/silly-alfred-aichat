export const RESOLUTIONS = ["512", "768", "1K", "1.5K", "2K", "4K"];
export const MAX_IMAGES = 10;

export type ImageRequest = {
  prompt: string;
  model: string | null;
  aspectRatio: string | null;
  resolution: string | null;
  count: number;
};

export type ParsedImagePrompt = { ok: true; request: ImageRequest } | { ok: false; message: string };

// "a red fox --ar 16:9 --res 2K --n 2 --model vendor/model" -> the prompt and its options.
export function parseImagePrompt(text: string): ParsedImagePrompt {
  const request: ImageRequest = { prompt: "", model: null, aspectRatio: null, resolution: null, count: 1 };
  const words = text.trim().split(/\s+/).filter((word) => word !== "");
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word !== "--ar" && word !== "--res" && word !== "--n" && word !== "--model") {
      kept.push(word);
      continue;
    }
    const value = words[++i];
    if (value === undefined) return { ok: false, message: `\`${word}\` needs a value.` };
    if (word === "--ar") {
      if (!/^\d{1,2}:\d{1,2}$/.test(value)) return { ok: false, message: "`--ar` takes a ratio such as `16:9` or `1:1`." };
      request.aspectRatio = value;
    } else if (word === "--res") {
      const tier = RESOLUTIONS.find((candidate) => candidate.toLowerCase() === value.toLowerCase());
      if (!tier) return { ok: false, message: `\`--res\` takes ${RESOLUTIONS.map((r) => `\`${r}\``).join(", ")}.` };
      request.resolution = tier;
    } else if (word === "--n") {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES) return { ok: false, message: `\`--n\` takes a number from 1 to ${MAX_IMAGES}.` };
      request.count = count;
    } else {
      request.model = value;
    }
  }
  request.prompt = kept.join(" ");
  if (request.prompt === "") return { ok: false, message: "Describe the image first, for example `a lighthouse at dusk --ar 16:9`." };
  return { ok: true, request };
}

export function imageBody(request: ImageRequest, modelId: string): string {
  // Some image models take no `n`; it is sent only when more than one image is asked for.
  const body: Record<string, unknown> = { model: modelId, prompt: request.prompt };
  if (request.count > 1) body.n = request.count;
  if (request.aspectRatio) body.aspect_ratio = request.aspectRatio;
  if (request.resolution) body.resolution = request.resolution;
  return JSON.stringify(body);
}

const MEDIA_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((value, i) => bytes[offset + i] === value);
}

// The extension comes from media_type; without one, from the file's own first bytes.
export function imageExtension(mediaType: string | null | undefined, bytes: Uint8Array): string {
  const fromType = mediaType ? MEDIA_EXTENSIONS[mediaType.toLowerCase().split(";")[0]!.trim()] : undefined;
  if (fromType) return fromType;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  let head = "";
  for (let i = 0; i < Math.min(bytes.length, 256); i++) head += String.fromCharCode(bytes[i]!);
  if (/<svg[\s>]/i.test(head) || /^\s*<\?xml/i.test(head)) return "svg";
  return "png";
}

export type DecodedImage = { bytes: Uint8Array; ext: string };

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

// Alfred's Text View takes the plain file path, spaces included, as the image source.
export function markdownImage(path: string): string {
  return `![](${path})`;
}

// The picture, then its path as plain text: Alfred's Text View shows images but does not open file links.
export function imageMarkdown(path: string): string {
  return `${markdownImage(path)}\n\n📂 \`${path}\``;
}

// Image paths written by imageMarkdown, in order.
export function imagePathsIn(text: string): string[] {
  return [...text.matchAll(/^!\[\]\((.+)\)$/gm)].map((match) => match[1]!);
}

export function xattrPlist(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><string>${escaped}</string></plist>`;
}

export function promptFromXattr(raw: string): string {
  const match = /<string>([\s\S]*?)<\/string>/.exec(raw);
  return match ? match[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : "";
}
