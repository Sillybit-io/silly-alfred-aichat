import { imageBody, imageMarkdown, parseImagePrompt } from "../core/imagegen";
import { apiBase } from "../core/payload";
import { collectFinalizers, readConfig, type Config } from "../features/index";
import type { Host } from "../host/types";
import { listImages } from "../store/images";
import { admit, advance, currentRecord, finalizeDue, stop, type Finalizers, type RequestRecord } from "../store/requests";
import { getSettings } from "../store/settings";
import { imageError, viewJson } from "./view";

const LANE = "image";
const GALLERY_SIZE = 10;
const HINT = "↩ generate · ⌘↩ open · ⌥↩ reveal · ⌘⌥↩ chats";

function idle(host: Host, config: Config, notice?: string): string {
  const images = listImages(host, config, GALLERY_SIZE);
  const sections = images.map((image) => `${imageMarkdown(image.path)}\n\n_${image.prompt === "" ? "no prompt saved" : image.prompt}_`);
  const body = sections.length > 0 ? `# Recent images\n\n${sections.join("\n\n")}` : "Describe an image and press ↩. Options: `--ar 16:9`, `--res 2K`, `--n 2`, `--model <id>`.";
  return viewJson({
    response: notice ? `${notice}\n\n${body}` : body,
    footer: [config.imageModel, HINT].filter((part) => part !== "").join(" · "),
    mode: "replace",
    requestId: "",
    stage: "",
  });
}

function live(host: Host, record: RequestRecord): string {
  const elapsed = Math.max(0, Math.floor((host.nowMs() - record.startedAt) / 1000));
  return viewJson({
    response: `# 🎨 ${record.draft.text}\n\n_Generating image…_`,
    footer: [record.model, `generating ${elapsed}s`].join(" · "),
    mode: "replace",
    requestId: record.id,
    stage: "",
    rerun: 0.1,
  });
}

function finished(record: RequestRecord, files: string[], failure: string | null): string {
  const parts = [`# 🎨 ${record.draft.text}`];
  if (files.length > 0) parts.push(files.map(imageMarkdown).join("\n\n"));
  else {
    const error = failure !== null ? { title: "Image", detail: failure, next: "Try again." } : (record.error ?? { title: "Image", detail: "No image was returned.", next: "Try again." });
    const shown = imageError(error);
    parts.push(`# ⚠️ ${shown.title}\n\n${shown.detail}\n\n**Next:** ${shown.next}`);
  }
  return viewJson({
    response: parts.join("\n\n"),
    footer: [record.model, files.length > 0 ? "done" : "failed", HINT].join(" · "),
    mode: "replace",
    requestId: "",
    stage: "",
  });
}

function filesOf(record: RequestRecord | null): { files: string[]; failure: string | null } {
  const files = record && Array.isArray(record.meta.files) ? (record.meta.files as string[]) : [];
  const failure = record && typeof record.meta.failure === "string" ? record.meta.failure : null;
  return { files, failure };
}

// The aiimage Text View: one image request in the image lane, ticked like a chat reply.
export function main(host: Host, argv: string[]): string {
  const config = readConfig(host);
  const finalizers: Finalizers = collectFinalizers(config);
  const typed = (argv[0] ?? "").trim();
  const rid = (host.env.request_id ?? "").trim();

  if (rid !== "") {
    const step = advance(host, rid, finalizers);
    if (!step.tick) return idle(host, config);
    if (!step.tick.terminal) return live(host, step.tick.record);
    const outcome = filesOf(step.finalize?.record ?? null);
    return finished(step.tick.record, outcome.files, outcome.failure);
  }

  finalizeDue(host, finalizers, LANE);
  const open = currentRecord(host, LANE);
  if (open && !open.final && open.state === "open") {
    if (typed === "") return live(host, open);
    stop(host, open.id);
    advance(host, open.id, finalizers);
  }
  if (typed === "") return idle(host, config);

  const parsed = parseImagePrompt(typed);
  if (!parsed.ok) return idle(host, config, parsed.message);
  const modelId = parsed.request.model ?? (config.imageModel !== "" ? config.imageModel : (getSettings(host).lastModel ?? ""));
  if (modelId === "") return idle(host, config, "Choose an image model first: set Image Model in the workflow's Configuration, or add `--model <id>`.");
  if (config.apiKey === "") return idle(host, config, "Add your OpenRouter API key in the workflow's Configuration first.");
  const result = admit(
    host,
    {
      lane: LANE,
      kind: "image",
      chatId: null,
      model: modelId,
      draft: { text: parsed.request.prompt, attachments: [] },
      body: imageBody(parsed.request, modelId),
      url: `${apiBase(host.env)}/images`,
      apiKey: config.apiKey,
      stream: false,
      timeoutSeconds: config.imageTimeoutSeconds,
      meta: { count: parsed.request.count },
    },
    finalizers,
  );
  if (!result.ok) return idle(host, config, "An image is still being generated.");
  const record = currentRecord(host, LANE);
  return record ? live(host, record) : idle(host, config);
}
