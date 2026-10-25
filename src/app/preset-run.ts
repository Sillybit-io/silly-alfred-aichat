import { getModel } from "../store/catalog";
import { describeFailure, mapCurlExit } from "../core/errors";
import { buildBody, chatUrl, encodeBody, type ContextTurn, type PayloadOptions } from "../core/payload";
import { sanitizeMarkdown } from "../core/sanitize";
import { fillPrompt, type Preset } from "../core/presets";
import { readConfig, FALLBACK_MODEL, type Config } from "../features/index";
import { CURL_STDIN_CONFIG, curlAuthConfig, curlBinary, curlProtocolArgs, MAX_RESPONSE_BYTES } from "../host/common";
import type { Host } from "../host/types";
import { cacheDir } from "../store/chats";
import { loadPresets } from "../store/presets";
import { getSettings } from "../store/settings";
import { REFERER } from "../store/requests";
import { EDIT_ID, inputText } from "./presets";
import { saveLastResult } from "./preset-result";
import { envelope } from "./view";

const MAX_TIME_SECONDS = 60;

function fail(message: string): string {
  return envelope("", { preset_output: "error", preset_error: message });
}

function failureText(title: string, detail: string, next: string): string {
  return `${title}: ${detail} ${next}`;
}

function replyFrom(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { choices?: { message?: { content?: unknown } }[] };
    const content = parsed.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() !== "" ? content : null;
  } catch {
    return null;
  }
}

// One non-streaming request, outside the request supervisor: presets finish within a minute or fail.
type Reply = { ok: true; reply: string } | { ok: false; message: string };

function request(host: Host, config: Config, preset: Preset, prompt: string): Reply {
  const settings = getSettings(host);
  const modelId = preset.model ?? settings.defaultModel ?? config.defaultModel ?? FALLBACK_MODEL;
  const turns: ContextTurn[] = [];
  const system = preset.system ?? config.systemPrompt;
  if (system.trim() !== "") turns.push({ role: "system", content: system });
  turns.push({ role: "user", content: prompt });
  const options: PayloadOptions = {
    modelId,
    model: getModel(host, modelId),
    stream: false,
    pdfEngine: config.pdfEngine,
    web: preset.web ?? false,
    webMaxResults: config.webMaxResults,
    effort: preset.think === undefined ? null : preset.think === "off" ? "none" : preset.think,
    privacy: config.privacy,
  };
  const folder = `${cacheDir(host)}/preset-${host.randomId()}`;
  host.mkdirp(folder);
  try {
    host.writeAtomic(`${folder}/body.json`, encodeBody(buildBody(turns, options)));
    const url = chatUrl(host.env);
    const run = host.runSync(
      [
        curlBinary(host.env),
        ...curlProtocolArgs(url),
        "-o", `${folder}/out`,
        "-D", `${folder}/headers`,
        "--silent", "--show-error",
        "--connect-timeout", "15",
        "--max-filesize", String(MAX_RESPONSE_BYTES),
        "--max-time", String(MAX_TIME_SECONDS),
        ...CURL_STDIN_CONFIG,
        "-H", "Content-Type: application/json",
        "-H", `HTTP-Referer: ${REFERER}`,
        "-H", "X-Title: Alfred AI Chat",
        "--data-binary", `@${folder}/body.json`,
        url,
      ],
      { timeoutMs: (MAX_TIME_SECONDS + 15) * 1000, stdin: curlAuthConfig(config.apiKey), maxBytes: MAX_RESPONSE_BYTES },
    );
    // A reply over the cap is never loaded; curl before 8.4.0 does not stop one whose length was not announced.
    if ((host.stat(`${folder}/out`)?.size ?? 0) > MAX_RESPONSE_BYTES) {
      const mapped = mapCurlExit(63);
      return { ok: false, message: failureText(mapped.title, mapped.detail, mapped.next) };
    }
    const read = (name: string) => (host.exists(`${folder}/${name}`) ? host.readText(`${folder}/${name}`) : "");
    const body = read("out");
    const headers = read("headers");
    const reply = run.exit === 0 && /^HTTP\/\S+\s+2\d\d/m.test(headers) ? replyFrom(body) : null;
    if (reply !== null) return { ok: true, reply };
    const mapped = describeFailure({ headers, body: body.slice(0, 4000), curlExit: run.exit === 0 ? null : run.exit, streamError: null, finishReason: null });
    return { ok: false, message: failureText(mapped.title, mapped.detail, mapped.next) };
  } finally {
    host.remove(folder);
  }
}

// The envelope's preset_output routes the next object: textview opens a chat with the filled
// prompt (nothing is sent here), the others carry the one reply, error carries a notification text.
export function main(host: Host, argv: string[]): string {
  const config = readConfig(host);
  const id = (host.env.preset_id ?? "").trim();
  const loaded = loadPresets(host);

  if (id === EDIT_ID) {
    host.runSync(["/usr/bin/open", "-t", loaded.path], { timeoutMs: 10000 });
    return envelope("", { preset_output: "edit", preset_error: "" });
  }
  const preset = loaded.presets.find((candidate) => candidate.id === id);
  if (!preset) return fail(`Preset "${id}" was not found${loaded.errors.length > 0 ? `; presets.json has a problem on line ${loaded.errors[0]!.line}` : ""}.`);
  const text = (argv[0] ?? "").trim() !== "" ? (argv[0] as string) : inputText(host);
  if (text.trim() === "") return fail("There is no text to work on. Select some text or copy it first.");
  const prompt = fillPrompt(preset, text, config.translateLanguage);
  if (preset.output === "textview") {
    return envelope(prompt, { preset_output: "textview", session_action: "new", preset_error: "" });
  }
  if (config.apiKey === "") return fail(config.keyIssue ?? "Add your OpenRouter API key in the workflow's Configuration first.");
  const result = request(host, config, preset, prompt);
  if (!result.ok) return fail(result.message);
  saveLastResult(host, preset.name, result.reply);
  // Copying and pasting change the clipboard and close Alfred, so they are a setting. Without it the
  // reply is shown in a view, and ⌘↩ there copies it.
  const output = (preset.output === "clipboard" || preset.output === "paste") && !config.presetClipboard ? "view" : preset.output;
  return envelope(output === "view" ? "" : sanitizeMarkdown(result.reply), { preset_output: output, preset_error: "" });
}
