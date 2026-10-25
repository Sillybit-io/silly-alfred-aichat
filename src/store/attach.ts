import { baseName, classifyName, looksLikeText, MAX_FILE_BYTES, MAX_PENDING, megabytes, type Classified } from "../core/attachments";
import { sha256Hex } from "../core/sha256";
import type { Config } from "../features/index";
import type { Host } from "../host/types";
import { attachmentsDir, cacheDir, mutateChat, type AttachmentRef } from "./chats";

export type AttachResult = { added: AttachmentRef[]; errors: string[] };

// temp is a file of ours that holds exactly these bytes; the snapshot moves it into place instead of writing them again.
type Source = { name: string; bytes: Uint8Array; classified: Classified; temp?: string };

// Large PNG and JPEG screenshots cost tokens without adding detail: sips writes a smaller temporary
// copy and the source file is left alone. GIF and WebP are sent as they are.
function downscaled(host: Host, config: Config, path: string, classified: Classified): { bytes: Uint8Array; temp: string } | null {
  if (classified.kind !== "image" || (classified.ext !== "png" && classified.ext !== "jpg")) return null;
  let probe;
  try {
    probe = host.runSync(["/usr/bin/sips", "-g", "pixelWidth", "-g", "pixelHeight", path], { timeoutMs: 15000 });
  } catch {
    return null;
  }
  if (probe.exit !== 0) return null;
  const width = Number(/pixelWidth:\s*(\d+)/.exec(probe.stdout)?.[1] ?? 0);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(probe.stdout)?.[1] ?? 0);
  if (Math.max(width, height) <= config.imageMaxEdge) return null;
  host.mkdirp(cacheDir(host));
  const temp = `${cacheDir(host)}/resize-${host.randomId()}.${classified.ext}`;
  try {
    const result = host.runSync(["/usr/bin/sips", "-Z", String(config.imageMaxEdge), path, "--out", temp], { timeoutMs: 30000 });
    if (result.exit === 0 && host.exists(temp)) return { bytes: host.readBytesFrom(temp, 0), temp };
  } catch {
    // the original is sent instead
  }
  host.remove(temp);
  return null;
}

function snapshot(host: Host, chatId: string, source: Source): AttachmentRef {
  const sha = sha256Hex(source.bytes);
  const file = `attachments/${sha}.${source.classified.ext}`;
  const dir = attachmentsDir(host, chatId);
  try {
    host.mkdirExclusive(dir);
    const target = `${dir}/${sha}.${source.classified.ext}`;
    if (!host.exists(target)) {
      if (source.temp !== undefined) {
        host.move(source.temp, target);
        host.restrict(target);
      } else {
        host.writeAtomic(target, source.bytes);
      }
    }
  } finally {
    if (source.temp !== undefined) host.remove(source.temp);
  }
  return {
    name: source.name,
    kind: source.classified.kind === "unknown" ? "text" : source.classified.kind,
    mime: source.classified.mime,
    size: source.bytes.length,
    sha,
    file,
  };
}

function prepareOne(host: Host, config: Config, path: string): Source | string {
  const name = baseName(path);
  const info = host.stat(path);
  if (!info) return `${name}: the file does not exist`;
  if (info.isDirectory) return `${name}: folders cannot be attached`;
  // The size cap is checked before a single byte is read.
  if (info.size > MAX_FILE_BYTES) return `${name}: ${megabytes(info.size)} is over the 20 MB per-file cap`;
  const classified = classifyName(name);
  const bytes = host.readBytesFrom(path, 0);
  if (classified.kind === "unknown") {
    if (bytes.length > config.textAttachmentMaxKb * 1024) return `${name}: text files are limited to ${config.textAttachmentMaxKb} KB`;
    if (!looksLikeText(bytes)) return `${name}: this file type cannot be read; attach images, PDFs, or text files`;
    return { name, bytes, classified: { kind: "unknown", ext: classified.ext, mime: "text/plain" } };
  }
  const smaller = downscaled(host, config, path, classified);
  return smaller ? { name, bytes: smaller.bytes, classified, temp: smaller.temp } : { name, bytes, classified };
}

// Reads each source once, snapshots it into the chat, and adds a pending ref under the chat lock.
export function attachPaths(host: Host, config: Config, chatId: string, paths: string[]): AttachResult {
  const result: AttachResult = { added: [], errors: [] };
  const chatPending = () => {
    let count = 0;
    mutateChat(host, chatId, (chat) => {
      count = chat.pending.length;
      return false;
    });
    return count;
  };
  let pending = chatPending();
  for (const path of paths) {
    if (pending + result.added.length >= MAX_PENDING) {
      result.errors.push(`${baseName(path)}: a message can carry ${MAX_PENDING} files; send it first or use /detach`);
      continue;
    }
    const prepared = prepareOne(host, config, path);
    if (typeof prepared === "string") {
      result.errors.push(prepared);
      continue;
    }
    result.added.push(snapshot(host, chatId, prepared));
  }
  if (result.added.length > 0) {
    mutateChat(host, chatId, (chat) => {
      for (const ref of result.added) if (!chat.pending.some((p) => p.sha === ref.sha && p.name === ref.name)) chat.pending.push(ref);
    });
  }
  return result;
}

export function attachBytes(host: Host, config: Config, chatId: string, name: string, bytes: Uint8Array): AttachResult {
  const classified = classifyName(name);
  if (classified.kind !== "image") return { added: [], errors: [`${name}: only images can be pasted`] };
  if (bytes.length > MAX_FILE_BYTES) return { added: [], errors: [`${name}: ${megabytes(bytes.length)} is over the 20 MB per-file cap`] };
  const ref = snapshot(host, chatId, { name, bytes, classified });
  let pending = 0;
  mutateChat(host, chatId, (chat) => {
    pending = chat.pending.length;
    if (pending >= MAX_PENDING) return false;
    chat.pending.push(ref);
  });
  return pending >= MAX_PENDING ? { added: [], errors: [`${name}: a message can carry ${MAX_PENDING} files`] } : { added: [ref], errors: [] };
}
