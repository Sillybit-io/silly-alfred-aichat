import { chatUrl, buildBody, encodeBody, type PrivacyMode } from "../core/payload";
import { cleanRewrite, MAX_REWRITE_INPUT, rewriteTurns } from "../core/web-query";
import { CURL_STDIN_CONFIG, curlAuthConfig, curlBinary, curlProtocolArgs, MAX_RESPONSE_BYTES } from "../host/common";
import type { Host } from "../host/types";
import { dataDir } from "./chats";
import { REFERER } from "./requests";

const TIMEOUT_SECONDS = 8;

// Only a category is logged: a provider's own message can repeat the conversation.
function fail(host: Host, reason: string): Standalone {
  host.log(`web query rewrite failed: ${reason}`);
  return { text: null, failed: reason };
}

type Row = { role: "user" | "assistant"; content: string };

// OpenRouter's web plugin searches with the last user message alone, so a follow-up such as "What about tomorrow?"
// finds nothing useful. One small blocking request turns it into a standalone message; any failure returns null
// and the original message is sent as it is, with the reason in `failed` so the footer can say so.
export type Standalone = { text: string | null; failed: string | null };

const SAME: Standalone = { text: null, failed: null };

export function standaloneMessage(host: Host, apiKey: string, privacy: PrivacyMode, modelId: string, history: Row[], text: string): Standalone {
  if (history.length === 0 || text.trim() === "" || text.length > MAX_REWRITE_INPUT || modelId === "") return SAME;
  const folder = `${dataDir(host)}/web-query`;
  const bodyFile = `${folder}/${host.randomId()}.json`;
  try {
    host.mkdirp(folder);
    host.writeAtomic(bodyFile, encodeBody({ ...buildBody(rewriteTurns(history, text), { modelId, model: null, stream: false, pdfEngine: "auto", web: false, privacy }), max_tokens: 200, temperature: 0 }));
    const url = chatUrl(host.env);
    const run = host.runSync(
      [
        curlBinary(host.env),
        ...curlProtocolArgs(url),
        "--silent",
        "--connect-timeout", "5",
        "--max-filesize", String(MAX_RESPONSE_BYTES),
        "--max-time", String(TIMEOUT_SECONDS),
        ...CURL_STDIN_CONFIG,
        "-H", "Content-Type: application/json",
        "-H", `HTTP-Referer: ${REFERER}`,
        "-H", "X-Title: Alfred AI Chat",
        "--data-binary", `@${bodyFile}`,
        url,
      ],
      { timeoutMs: (TIMEOUT_SECONDS + 2) * 1000, stdin: curlAuthConfig(apiKey), maxBytes: MAX_RESPONSE_BYTES },
    );
    if (run.exit === 63 || run.exit === 153) return fail(host, "reply too large");
    if (run.exit !== 0) return fail(host, run.exit === 124 ? "timed out" : `curl exit ${run.exit}`);
    const parsed = JSON.parse(run.stdout) as { choices?: { message?: { content?: unknown } }[]; error?: { message?: unknown } };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== "string") return fail(host, typeof parsed.error?.message === "string" ? "the provider returned an error" : "no reply");
    return { text: cleanRewrite(content, text), failed: null };
  } catch {
    return fail(host, "unreadable reply");
  } finally {
    try {
      host.remove(bodyFile);
    } catch {
      // The folder holds nothing but this one file; a leftover is harmless.
    }
  }
}
