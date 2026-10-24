import { decodeBase64 } from "../core/base64";
import { IMAGE_EXTENSIONS, imageExtension, promptFromXattr, xattrPlist, type DecodedImage } from "../core/imagegen";
import type { Config } from "../features/index";
import type { Host } from "../host/types";

const XATTR_FIELD = "com.apple.metadata:kMDItemDescription";

export class ImageSaveError extends Error {}

export function imagesFolder(host: Host, config: Config): string {
  const home = host.env.HOME ?? "";
  const folder = config.imagesFolder;
  return (folder === "~" ? home : folder.startsWith("~/") ? `${home}${folder.slice(1)}` : folder).replace(/\/+$/, "");
}

function decodeAll(bodyText: string): DecodedImage[] {
  let parsed: { data?: { b64_json?: unknown; media_type?: unknown }[] };
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new ImageSaveError("The response was not valid JSON.");
  }
  if (!Array.isArray(parsed.data) || parsed.data.length === 0) throw new ImageSaveError("The response held no image.");
  return parsed.data.map((item) => {
    if (typeof item?.b64_json !== "string" || item.b64_json === "") throw new ImageSaveError("The response held an image without data.");
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(item.b64_json);
    } catch {
      throw new ImageSaveError("An image in the response could not be decoded.");
    }
    return { bytes, ext: imageExtension(typeof item.media_type === "string" ? item.media_type : null, bytes) };
  });
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

// Everything is decoded before the first file is written, so a bad response leaves the folder untouched.
export function saveImages(host: Host, config: Config, bodyText: string, prompt: string): string[] {
  const images = decodeAll(bodyText);
  const folder = imagesFolder(host, config);
  host.mkdirp(folder);
  const saved: string[] = [];
  try {
    for (const image of images) {
      const name = `${stamp(host.nowMs())}-${host.randomId().slice(0, 6)}.${image.ext}`;
      const temp = `${folder}/.${name}.tmp`;
      host.writeAtomic(temp, image.bytes);
      host.move(temp, `${folder}/${name}`);
      saved.push(`${folder}/${name}`);
      // The prompt travels with the file when it is shared and Spotlight indexes it, so it is saved only on request.
      if (config.savePrompts) {
        try {
          host.runSync(["/usr/bin/xattr", "-w", XATTR_FIELD, xattrPlist(prompt), `${folder}/${name}`], { timeoutMs: 10000 });
        } catch {
          // the prompt is only metadata; the image is already saved
        }
      }
    }
  } catch (error) {
    for (const path of saved) host.remove(path);
    throw error;
  }
  return saved;
}

export type SavedImage = { path: string; prompt: string; mtimeMs: number };

function promptOf(host: Host, path: string): string {
  try {
    const result = host.runSync(["/usr/bin/xattr", "-p", XATTR_FIELD, path], { timeoutMs: 5000 });
    return result.exit === 0 ? promptFromXattr(result.stdout) : "";
  } catch {
    return "";
  }
}

export function listImages(host: Host, config: Config, limit: number): SavedImage[] {
  const folder = imagesFolder(host, config);
  if (!host.exists(folder)) return [];
  const found: SavedImage[] = [];
  for (const name of host.listDir(folder)) {
    const dot = name.lastIndexOf(".");
    if (name.charAt(0) === "." || dot < 0 || IMAGE_EXTENSIONS.indexOf(name.slice(dot + 1).toLowerCase()) < 0) continue;
    const info = host.stat(`${folder}/${name}`);
    if (info && !info.isDirectory) found.push({ path: `${folder}/${name}`, prompt: "", mtimeMs: info.mtimeMs });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? 1 : -1));
  const newest = found.slice(0, limit);
  for (const image of newest) image.prompt = promptOf(host, image.path);
  return newest;
}

export function newestImage(host: Host, config: Config): string | null {
  const folder = imagesFolder(host, config);
  if (!host.exists(folder)) return null;
  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of host.listDir(folder)) {
    const dot = name.lastIndexOf(".");
    if (name.charAt(0) === "." || dot < 0 || IMAGE_EXTENSIONS.indexOf(name.slice(dot + 1).toLowerCase()) < 0) continue;
    const info = host.stat(`${folder}/${name}`);
    if (info && !info.isDirectory && (best === null || info.mtimeMs > best.mtimeMs || (info.mtimeMs === best.mtimeMs && `${folder}/${name}` > best.path))) best = { path: `${folder}/${name}`, mtimeMs: info.mtimeMs };
  }
  return best ? best.path : null;
}
