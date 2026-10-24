#!/usr/bin/osascript -l JavaScript
var __aichat_main;
(() => {
  // src/core/capabilities.ts
  var IGNORED_PRICES = new Set(["prompt", "completion", "web_search", "internal_reasoning", "input_cache_read", "input_cache_write"]);
  function acceptsFile(model) {
    return model !== null && model.inputModalities.includes("file");
  }
  function efforts(model) {
    if (!model || !model.reasoning)
      return [];
    const list = model.reasoning.efforts.filter((effort) => effort !== "none");
    if (!model.reasoning.mandatory && !list.includes("none"))
      list.push("none");
    return list;
  }

  // src/core/errors.ts
  function lastStatus(headers) {
    const lines = headers.split(/\r\n|\r|\n/);
    let found = null;
    for (const line of lines) {
      const status = /^HTTP\/\S+\s+(\d{3})/.exec(line);
      if (status) {
        found = { status: Number(status[1]), retryAfterSeconds: null };
        continue;
      }
      if (!found)
        continue;
      const retry = /^retry-after:\s*(\d+)\s*$/i.exec(line);
      if (retry)
        found.retryAfterSeconds = Number(retry[1]);
    }
    return found;
  }
  function providerMessage(body) {
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null) {
        const error = parsed.error;
        if (typeof error === "string" && error !== "")
          return clip(error);
        if (typeof error === "object" && error !== null) {
          const message = error.message;
          if (typeof message === "string" && message !== "")
            return clip(message);
        }
      }
    } catch {}
    return null;
  }
  function clip(text) {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat;
  }
  var POLICY_PATTERN = /guardrail|data policy|zero data retention|\bZDR\b/i;
  function mapHttpError(status, body) {
    const message = providerMessage(body);
    if (message !== null && POLICY_PATTERN.test(message) && (status.status === 404 || status.status === 403 || status.status === 400)) {
      return {
        title: "Blocked by your data policy",
        detail: "The privacy rules in force (the workflow's Provider Privacy setting and your OpenRouter privacy settings) leave no provider for this model.",
        next: "Pick a model they allow with the `aimodels` keyword (add #imagegen for image models), or loosen Provider Privacy in the workflow's Configuration or the policy in your OpenRouter privacy settings."
      };
    }
    switch (status.status) {
      case 401:
        return {
          title: "Invalid API key",
          detail: "OpenRouter did not accept the API key.",
          next: "Open the workflow's Configuration and paste a key from openrouter.ai/keys."
        };
      case 402:
        return {
          title: "Out of credits",
          detail: "The account or key behind this API key cannot pay for this request.",
          next: "Add credits on the OpenRouter dashboard, or pick a free model with /model."
        };
      case 403:
        return {
          title: "Request blocked",
          detail: message ?? "OpenRouter or the provider refused this request.",
          next: "Rephrase the message or pick another model with /model."
        };
      case 404:
        return {
          title: "Model not found",
          detail: message ?? "OpenRouter has no model or endpoint for this request.",
          next: "Pick another model with /model."
        };
      case 408:
        return {
          title: "Request timed out",
          detail: message ?? "The provider took too long to answer.",
          next: "Use /retry."
        };
      case 429:
        return {
          title: "Rate limited",
          detail: message ?? "OpenRouter or the provider is limiting requests.",
          next: status.retryAfterSeconds !== null ? `Use /retry — retry in ${status.retryAfterSeconds} s.` : "Wait a moment, then use /retry."
        };
      case 400:
      case 413:
      case 422:
        return {
          title: "Request rejected",
          detail: message ?? "The model could not accept this request.",
          next: "Check the model supports what you attached, shorten the chat, or start /new."
        };
      case 502:
        return {
          title: "Provider error",
          detail: message ?? "The model provider returned an error.",
          next: "Use /retry, or pick another model with /model."
        };
      case 503:
        return {
          title: "Model unavailable",
          detail: message ?? "No provider is available for this model right now.",
          next: "Use /retry later, or pick another model with /model."
        };
      default:
        return {
          title: `OpenRouter error ${status.status}`,
          detail: message ?? "OpenRouter returned an unexpected status.",
          next: "Use /retry."
        };
    }
  }
  function mapCurlExit(code) {
    switch (code) {
      case 6:
      case 7:
        return {
          title: "Cannot reach OpenRouter",
          detail: "The connection to OpenRouter could not be opened.",
          next: "Check your network connection, then use /retry."
        };
      case 28:
        return {
          title: "Request timed out",
          detail: "OpenRouter did not answer in time.",
          next: "Use /retry, or raise the timeout in Configuration."
        };
      case 35:
        return {
          title: "Secure connection failed",
          detail: "The TLS handshake with OpenRouter failed.",
          next: "Check your network, VPN, or proxy, then use /retry."
        };
      case 52:
        return {
          title: "Empty reply",
          detail: "OpenRouter closed the connection without answering.",
          next: "Use /retry."
        };
      case 56:
        return {
          title: "Connection lost",
          detail: "The connection dropped while receiving the reply.",
          next: "Use /retry."
        };
      default:
        return {
          title: "Network error",
          detail: `The network request failed (curl exit ${code}).`,
          next: "Check your network connection, then use /retry."
        };
    }
  }
  function mapStreamError(error) {
    if (error.kind === "protocol") {
      return {
        title: "Unreadable response",
        detail: error.message,
        next: "Use /retry."
      };
    }
    return {
      title: "The model stopped with an error",
      detail: clip(error.message),
      next: "Use /retry, or pick another model with /model."
    };
  }
  function mapFinishReason(reason) {
    if (reason === "length") {
      return {
        title: "Reply cut off",
        detail: "The model reached its length limit before finishing.",
        next: 'Send "continue" to get the rest.'
      };
    }
    if (reason === "content_filter") {
      return {
        title: "Reply blocked",
        detail: "The provider's content filter stopped the reply.",
        next: "Rephrase the message or pick another model with /model."
      };
    }
    return null;
  }
  function describeFailure(input) {
    const status = lastStatus(input.headers);
    if (status && status.status >= 400)
      return mapHttpError(status, input.body);
    if (input.curlExit !== null && input.curlExit !== 0)
      return mapCurlExit(input.curlExit);
    if (input.streamError)
      return mapStreamError(input.streamError);
    if (input.finishReason) {
      const mapped = mapFinishReason(input.finishReason);
      if (mapped)
        return mapped;
    }
    return {
      title: "No reply",
      detail: "The stream ended without an answer.",
      next: "Use /retry."
    };
  }

  // src/core/hooks.ts
  var TEST_HOOKS = false;

  // src/core/payload.ts
  function providerPreferences(mode) {
    if (mode === "zdr")
      return { data_collection: "deny", zdr: true };
    if (mode === "deny")
      return { data_collection: "deny" };
    return null;
  }
  var DEFAULT_API_BASE = "https://openrouter.ai/api/v1";
  function apiBase(env) {
    const configured = TEST_HOOKS ? (env.aichat_api_base ?? "").trim() : "";
    return (configured === "" ? DEFAULT_API_BASE : configured).replace(/\/+$/, "");
  }
  function chatUrl(env) {
    return `${apiBase(env)}/chat/completions`;
  }
  function contentFor(turn) {
    const attachments = turn.attachments ?? [];
    if (attachments.length === 0)
      return turn.content;
    const parts = [{ type: "text", text: turn.content }];
    for (const part of attachments) {
      if (part.kind === "image") {
        parts.push({ type: "image_url", image_url: { url: `data:${part.mime};base64,${part.base64}` } });
      }
    }
    for (const part of attachments) {
      if (part.kind === "file") {
        parts.push({ type: "file", file: { filename: part.name, file_data: `data:${part.mime};base64,${part.base64}` } });
      }
    }
    return parts;
  }
  function fileParserEngine(engine, model) {
    if (engine === "free")
      return "cloudflare-ai";
    if (engine === "ocr")
      return "mistral-ocr";
    if (engine === "native")
      return "native";
    return acceptsFile(model) ? null : "cloudflare-ai";
  }
  function fileHash(annotation) {
    const file = annotation.file;
    if (typeof file === "object" && file !== null && !Array.isArray(file)) {
      const hash = file.hash;
      if (typeof hash === "string" && hash !== "")
        return hash;
    }
    return null;
  }
  function reasoningFor(options) {
    const model = options.model;
    if (!model || !model.reasoning)
      return null;
    const reasoning = {};
    const effort = options.effort ?? null;
    if (effort !== null && efforts(model).includes(effort))
      reasoning.effort = effort;
    if (options.excludeReasoning)
      reasoning.exclude = true;
    return Object.keys(reasoning).length > 0 ? reasoning : null;
  }
  function buildBody(turns, options) {
    const hasFile = turns.some((turn) => (turn.attachments ?? []).some((part) => part.kind === "file"));
    const echoed = new Set;
    const messages = turns.map((turn) => {
      const message = { role: turn.role, content: contentFor(turn) };
      if (hasFile && turn.role === "assistant" && turn.annotations) {
        const fresh = turn.annotations.filter((annotation) => {
          const hash = annotation.type === "file" ? fileHash(annotation) : null;
          if (hash === null || echoed.has(hash))
            return false;
          echoed.add(hash);
          return true;
        });
        if (fresh.length > 0)
          message.annotations = fresh;
      }
      return message;
    });
    const body = { model: options.modelId, messages, stream: options.stream };
    const plugins = [];
    if (hasFile) {
      const engine = fileParserEngine(options.pdfEngine, options.model);
      if (engine !== null)
        plugins.push({ id: "file-parser", pdf: { engine } });
    }
    if (options.web) {
      const web = { id: "web" };
      if (options.webMaxResults !== undefined)
        web.max_results = options.webMaxResults;
      plugins.push(web);
    }
    if (plugins.length > 0)
      body.plugins = plugins;
    const reasoning = reasoningFor(options);
    if (reasoning)
      body.reasoning = reasoning;
    const provider = providerPreferences(options.privacy);
    if (provider)
      body.provider = provider;
    return body;
  }
  function encodeBody(body) {
    return JSON.stringify(body);
  }

  // src/host/common.ts
  var SUPERVISOR_SCRIPT = [
    "umask 077",
    "pid_file=$1; exit_file=$2; err_file=$3; remove_file=$4; shift 4",
    "exec 3<&0",
    '"$@" <&3 >/dev/null 2>"$err_file" &',
    "child=$!",
    "exec 3<&-",
    'printf "%s" "$child" > "$pid_file.tmp" && mv "$pid_file.tmp" "$pid_file"',
    'wait "$child"',
    "status=$?",
    '[ -n "$remove_file" ] && rm -f -- "$remove_file"',
    'printf "%s" "$status" > "$exit_file.tmp" && mv "$exit_file.tmp" "$exit_file"'
  ].join(`
`);
  function supervisorArgv(argv, files) {
    if (argv.length === 0)
      throw new Error("spawnSupervised needs a command");
    return ["/bin/sh", "-c", SUPERVISOR_SCRIPT, "sh", files.pid, files.exit, files.stderr, files.remove ?? "", ...argv];
  }
  var SECRET_ENV = ["openrouter_api_key"];
  function scrubbedEnv(env) {
    const clean = {};
    for (const [name, value] of Object.entries(env)) {
      if (value !== undefined && SECRET_ENV.indexOf(name) < 0)
        clean[name] = value;
    }
    return clean;
  }
  var CURL_STDIN_CONFIG = ["-K", "-"];
  var BAD_KEY = /[\u0000-\u001f\u007f]/;
  function keyProblem(apiKey) {
    return BAD_KEY.test(apiKey) ? "The OpenRouter API key in the workflow's Configuration contains a line break or control character. Paste it again." : null;
  }
  function curlAuthConfig(apiKey) {
    if (apiKey === "" || BAD_KEY.test(apiKey))
      throw new Error("The API key cannot be sent.");
    return `header = "Authorization: Bearer ${apiKey.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"
`;
  }
  var CURL_PATH = "/usr/bin/curl";
  function curlBinary(env) {
    return TEST_HOOKS ? env.aichat_curl ?? CURL_PATH : CURL_PATH;
  }
  function curlProtocolArgs(url) {
    const first = TEST_HOOKS && url.startsWith("http://") ? "=http,https" : "=https";
    return ["--proto", first, "--proto-redir", "=https"];
  }
  function redact(message, env) {
    let text = message;
    for (const name of SECRET_ENV) {
      const value = (env[name] ?? "").trim();
      if (value.length >= 6)
        text = text.split(value).join("[redacted]");
    }
    return text;
  }
  function psArgv(pid) {
    return ["/bin/ps", "-ww", "-o", "command=", "-p", String(Math.trunc(pid))];
  }
  function commandFromPs(result) {
    const text = result.stdout.trim();
    return result.exit === 0 && text !== "" ? text : null;
  }
  function killArgv(pid) {
    return ["/bin/kill", "-s", "TERM", String(Math.trunc(pid))];
  }
  function isSafePid(pid) {
    return Number.isInteger(pid) && pid > 1;
  }

  // src/store/lock.ts
  var LOCK_RETRY_MS = 50;
  var LOCK_WAIT_MS = 2000;
  var LOCK_STALE_MS = 30000;

  class LockTimeoutError extends Error {
    constructor(path) {
      super(`could not acquire ${path}`);
      this.name = "LockTimeoutError";
    }
  }
  function readOwner(host, lockPath) {
    try {
      const [token, at] = host.readText(`${lockPath}/owner`).split(`
`);
      return { token: token ?? "", at: Number(at) };
    } catch {
      return null;
    }
  }
  function breakStale(host, lockPath) {
    const owner = readOwner(host, lockPath);
    const info = host.stat(lockPath);
    if (!info)
      return;
    const acquired = owner && Number.isFinite(owner.at) ? owner.at : info.mtimeMs;
    if (host.nowMs() - acquired <= LOCK_STALE_MS)
      return;
    const aside = `${lockPath}.stale-${host.randomId()}`;
    try {
      host.move(lockPath, aside);
    } catch {
      return;
    }
    host.remove(aside);
  }
  function withLock(host, lockPath, fn) {
    const deadline = host.nowMs() + LOCK_WAIT_MS;
    const token = host.randomId();
    for (;; ) {
      if (host.mkdirExclusive(lockPath))
        break;
      breakStale(host, lockPath);
      if (host.nowMs() >= deadline)
        throw new LockTimeoutError(lockPath);
      host.sleepMs(LOCK_RETRY_MS);
    }
    try {
      host.writeAtomic(`${lockPath}/owner`, `${token}
${host.nowMs()}`);
    } catch (error) {
      host.remove(lockPath);
      throw error;
    }
    try {
      return fn();
    } finally {
      const owner = readOwner(host, lockPath);
      if (owner === null || owner.token === token)
        host.remove(lockPath);
    }
  }

  // src/store/chats.ts
  class NotFoundError extends Error {
    constructor(id) {
      super(`chat ${id} does not exist`);
      this.name = "NotFoundError";
    }
  }
  function dataDir(host) {
    const dir = host.env.alfred_workflow_data;
    if (!dir)
      throw new Error("alfred_workflow_data is not set");
    return dir.replace(/\/+$/, "");
  }
  function cacheDir(host) {
    const dir = host.env.alfred_workflow_cache;
    if (!dir)
      throw new Error("alfred_workflow_cache is not set");
    return dir.replace(/\/+$/, "");
  }
  var chatsDir = (host) => `${dataDir(host)}/chats`;
  var chatDir = (host, id) => `${chatsDir(host)}/${id}`;
  var chatFile = (host, id) => `${chatDir(host, id)}/chat.json`;
  var chatLock = (host, id) => `${chatDir(host, id)}/.lock`;
  function getChat(host, id) {
    try {
      return JSON.parse(host.readText(chatFile(host, id)));
    } catch {
      return null;
    }
  }
  function mutateChat(host, id, fn) {
    if (!host.exists(chatDir(host, id)))
      throw new NotFoundError(id);
    try {
      return withLock(host, chatLock(host, id), () => {
        const chat = getChat(host, id);
        if (!chat)
          throw new NotFoundError(id);
        if (fn(chat) === false)
          return chat;
        chat.revision += 1;
        chat.updatedAt = host.nowMs();
        host.writeAtomic(chatFile(host, id), JSON.stringify(chat, null, 2));
        return chat;
      });
    } catch (error) {
      if (!(error instanceof NotFoundError) && !host.exists(chatDir(host, id)))
        throw new NotFoundError(id);
      throw error;
    }
  }

  // src/store/catalog.ts
  var CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  var RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
  var STUCK_REFRESH_MS = 2 * 60 * 1000;
  var cacheFile = (host) => `${cacheDir(host)}/models.json`;
  function loadCatalog(host) {
    try {
      const parsed = JSON.parse(host.readText(cacheFile(host)));
      if (typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.models))
        return null;
      return { fetchedAt: parsed.fetchedAt, models: parsed.models };
    } catch {
      return null;
    }
  }
  function getModel(host, id) {
    const cache = loadCatalog(host);
    return cache ? cache.models.find((model) => model.id === id) ?? null : null;
  }

  // src/core/sanitize.ts
  var MAX_URL = 2000;
  var MAX_SHOWN_URL = 500;
  var MAX_DEPTH = 4;
  var SLOT_OPEN = "";
  var SLOT_CLOSE = "";
  var TRACKING_PARAM = /^(utm_[a-z0-9_]*|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|twclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|vero_id|ref_src|ref_url|s_cid|oly_enc_id|oly_anon_id|spm|ck_subscriber_id)$/i;
  function safeUrl(raw) {
    const url = raw.trim();
    if (url === "" || url.length > MAX_URL)
      return null;
    if (/[\s\u0000-\u001f\u007f-\u009f<>"`\\]/.test(url))
      return null;
    const match = /^https:\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(url);
    if (!match)
      return null;
    const authority = match[1];
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.(?:[a-z]{2,}|xn--[a-z0-9-]+)(:\d{1,5})?$/i.test(authority))
      return null;
    const query = (match[3] ?? "").slice(1).split("&").filter((pair) => pair !== "" && !TRACKING_PARAM.test(pair.split("=")[0])).join("&");
    return `https://${authority.toLowerCase()}${match[2]}${query === "" ? "" : `?${query}`}${match[4] ?? ""}`;
  }
  function hostOf(url) {
    const match = /^https:\/\/([^/?#:]+)/i.exec(url);
    return match ? match[1].toLowerCase().replace(/^www\./, "") : "";
  }
  function encodeDest(url) {
    return url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\[/g, "%5B").replace(/\]/g, "%5D");
  }
  function shownCode(dest) {
    const flat = dest.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().replace(/%/g, "%25").replace(/\s/g, "%20").replace(/`/g, "%60").replace(/\[/g, "%5B").replace(/\]/g, "%5D").replace(/</g, "%3C").replace(/>/g, "%3E");
    if (flat === "")
      return "`(empty)`";
    return `\`${flat.length > MAX_SHOWN_URL ? `${flat.slice(0, MAX_SHOWN_URL)}…` : flat}\``;
  }
  var PUNCTUATION = /[!-/:-@[-`{-~]/;
  function isBlankAfter(s, newline) {
    let k = newline + 1;
    while (s[k] === " " || s[k] === "\t")
      k++;
    return s[k] === `
`;
  }
  function codeSpanEnd(s, start) {
    let n = 0;
    while (s[start + n] === "`")
      n++;
    let j = start + n;
    while (j < s.length && s[j] !== `
`) {
      if (s[j] === "`") {
        let m = 0;
        while (s[j + m] === "`")
          m++;
        if (m === n)
          return j + m;
        j += m;
      } else {
        j++;
      }
    }
    return -1;
  }
  function matchClose(s, open, up, down) {
    let depth = 0;
    for (let j = open;j < s.length; j++) {
      const c = s[j];
      if (c === "\\") {
        j++;
      } else if (c === "`") {
        const end = codeSpanEnd(s, j);
        if (end > 0)
          j = end - 1;
        else
          while (s[j + 1] === "`")
            j++;
      } else if (c === up) {
        depth++;
      } else if (c === down) {
        depth--;
        if (depth === 0)
          return j;
      } else if (c === `
` && isBlankAfter(s, j)) {
        return -1;
      }
    }
    return -1;
  }
  var normalizeLabel = (label) => label.replace(/\\(.)/g, "$1").trim().replace(/\s+/g, " ").toLowerCase();
  function isLocalImage(dest, roots) {
    if (/[\u0000-\u001f<>`"\\[\]?#]/.test(dest) || dest.indexOf("://") >= 0 || dest.split("/").indexOf("..") >= 0)
      return false;
    return roots.some((root) => root.startsWith("/") && dest.startsWith(`${root}/`) && dest.length > root.length + 1);
  }
  function destinationOf(raw) {
    const text = raw.trim();
    const angle = /^<([^<>\n]*)>/.exec(text);
    if (angle)
      return angle[1];
    const titled = /^(\S+)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/.exec(text);
    return titled ? titled[1] : text;
  }
  function bracketed(s, i, image, ctx, depth) {
    const open = image ? i + 1 : i;
    const close = matchClose(s, open, "[", "]");
    if (close < 0)
      return null;
    const label = s.slice(open + 1, close);
    let dest;
    let end;
    if (s[close + 1] === "(") {
      const paren = matchClose(s, close + 1, "(", ")");
      if (paren < 0)
        return null;
      dest = destinationOf(s.slice(close + 2, paren));
      end = paren + 1;
    } else {
      let key = label;
      end = close + 1;
      if (s[close + 1] === "[") {
        const second = matchClose(s, close + 1, "[", "]");
        if (second > 0) {
          const inner = s.slice(close + 2, second);
          key = inner.trim() === "" ? label : inner;
          end = second + 1;
        }
      }
      const found = ctx.defs.get(normalizeLabel(key));
      if (found === undefined)
        return null;
      dest = found;
    }
    if (image) {
      if (isLocalImage(dest, ctx.roots)) {
        ctx.slots.push(`![](${dest})`);
        return { out: `${SLOT_OPEN}${ctx.slots.length - 1}${SLOT_CLOSE}`, end };
      }
      return { out: `\uD83D\uDDBC image not loaded: ${shownCode(dest)}${s[end] === "`" ? " " : ""}`, end };
    }
    const shown = scan(label, ctx, depth + 1);
    const url = safeUrl(dest);
    if (url === null)
      return { out: `${shown} (${shownCode(dest)})`, end };
    const host = hostOf(url);
    const named = shown.toLowerCase().indexOf(host) >= 0 || s.startsWith(` (${host})`, end);
    return { out: `[${shown}](${encodeDest(url)})${named ? "" : ` (${host})`}`, end };
  }
  function scan(s, ctx, depth) {
    if (depth > MAX_DEPTH)
      return s.replace(/[\\![\]<`]/g, "\\$&");
    let out = "";
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "\\") {
        const next = s[i + 1];
        if (next !== undefined && PUNCTUATION.test(next)) {
          out += c + next;
          i += 2;
        } else {
          out += c;
          i++;
        }
      } else if (c === "`") {
        const end = codeSpanEnd(s, i);
        if (end > 0) {
          out += s.slice(i, end);
          i = end;
        } else {
          let n = 0;
          while (s[i + n] === "`")
            n++;
          out += s.slice(i, i + n);
          i += n;
        }
      } else if (c === "<") {
        const auto = /^<(https:\/\/[^\s<>`\\]+)>/i.exec(s.slice(i, i + MAX_URL + 10));
        const url = auto ? safeUrl(auto[1]) : null;
        if (auto && url !== null) {
          out += `<${url}>`;
          i += auto[0].length;
        } else {
          out += s[i + 1] !== undefined && /[A-Za-z/!?]/.test(s[i + 1]) ? "\\<" : "<";
          i++;
        }
      } else if (c === "!" && s[i + 1] === "[") {
        const found = bracketed(s, i, true, ctx, depth);
        if (found) {
          out += found.out;
          i = found.end;
        } else {
          out += "\\!";
          i++;
        }
      } else if (c === "[") {
        const found = bracketed(s, i, false, ctx, depth);
        if (found) {
          out += found.out;
          i = found.end;
        } else {
          out += c;
          i++;
        }
      } else {
        out += c;
        i++;
      }
    }
    return out;
  }
  var AMBIGUOUS_FENCE = /^[ \t>+*\-\d.)]+(`{3,}|~{3,})/;
  function leadingColumns(line) {
    let columns = 0;
    for (const c of line) {
      if (c === " ")
        columns++;
      else if (c === "\t")
        columns += 4 - columns % 4;
      else
        break;
    }
    return columns;
  }
  var DEFINITION_START = /^((?:[ \t]|>|[-+*]|\d{1,9}[.)])*)\[((?:[^\]\\\n]|\\.)*)\]:/;
  var DEFINITION_REST = /^[ \t]*(?:<([^<>\n]*)>|(\S+))[ \t]*(?:"[^"]*"|'[^']*'|\([^)]*\))?[ \t]*$/;
  function net(chunk) {
    let out = "";
    let i = 0;
    while (i < chunk.length) {
      const c = chunk[i];
      if (c === "\\") {
        out += c + (chunk[i + 1] ?? "");
        i += 2;
      } else if (c === "`") {
        const end = codeSpanEnd(chunk, i);
        if (end > 0) {
          out += chunk.slice(i, end).replace(/(^|[^\\])!\[/g, "$1\\![");
          i = end;
        } else {
          let n = 0;
          while (chunk[i + n] === "`")
            n++;
          out += chunk.slice(i, i + n);
          i += n;
        }
      } else if (c === "<") {
        const auto = /^<(https:\/\/[^\s<>`\\]+)>/i.exec(chunk.slice(i, i + MAX_URL + 10));
        if (auto && safeUrl(auto[1]) === auto[1]) {
          out += auto[0];
          i += auto[0].length;
        } else {
          out += chunk[i + 1] !== undefined && /[A-Za-z/!?]/.test(chunk[i + 1]) ? "\\<" : "<";
          i++;
        }
      } else if (c === "!" && chunk[i + 1] === "[") {
        out += "\\!";
        i++;
      } else {
        out += c;
        i++;
      }
    }
    return out.split(`
`).map((line) => {
      const start = DEFINITION_START.exec(line);
      return start && !start[2].startsWith("^") ? `${start[1]}\\${line.slice(start[1].length)}` : line;
    }).join(`
`);
  }
  function settle(text, ctx) {
    let current = text;
    for (let pass = 0;pass < 4; pass++) {
      const next = net(scan(current, ctx, 0));
      if (next === current)
        return current;
      current = next;
    }
    return current.replace(/[\\![\]<`]/g, "\\$&");
  }
  function fenceAfter(text, start, listAware) {
    let fence = start;
    for (const line of text.split(`
`)) {
      if (fence !== null) {
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
        if (closing && closing[1][0] === fence.char && closing[1].length >= fence.size) {
          fence = null;
          continue;
        }
        if (!listAware || line.trim() === "" || leadingColumns(line) >= fence.indent)
          continue;
        fence = null;
      }
      const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
      if (opening && !(opening[2][0] === "`" && opening[3].indexOf("`") >= 0))
        fence = { char: opening[2][0], size: opening[2].length, indent: opening[1].length };
    }
    return fence;
  }
  function sanitizeMarkdown(input, options = {}) {
    for (const mode of ["normal", "no code", "no fences"]) {
      const result = sanitizeWith(input, options, mode);
      if (result !== null)
        return result;
    }
    throw new Error("unreachable");
  }
  function sanitizeWith(input, options, mode) {
    const trustNoCode = mode !== "normal";
    const lines = input.replace(/[\uE000\uE001]/g, "").replace(/\r\n?/g, `
`).split(`
`);
    const ctx = { defs: new Map, roots: (options.imageRoots ?? []).map((root) => root.replace(/\/+$/, "")), slots: [] };
    const code = [];
    let fence = null;
    let indented = null;
    let strict = trustNoCode;
    for (let n = 0;n < lines.length; n++) {
      const line = lines[n];
      if (strict) {
        code.push(false);
      } else if (fence !== null) {
        code.push(true);
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
        if (closing && closing[1][0] === fence.char && closing[1].length >= fence.size)
          fence = null;
        continue;
      } else if (indented !== null) {
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
        if (closing && closing[1][0] === indented.char && closing[1].length >= indented.size) {
          indented = null;
          code.push(true);
          continue;
        }
        if (line.trim() === "" || leadingColumns(line) >= indented.columns) {
          code.push(true);
          continue;
        }
        indented = null;
        strict = true;
        code.push(false);
      } else {
        const shallow = /^( {1,3})(`{3,}|~{3,})(.*)$/.exec(line);
        const opening = /^(`{3,}|~{3,})(.*)$/.exec(line);
        if (shallow && !(shallow[2][0] === "`" && shallow[3].indexOf("`") >= 0)) {
          indented = { char: shallow[2][0], size: shallow[2].length, columns: shallow[1].length };
          code.push(true);
          continue;
        }
        if (opening && !(opening[1][0] === "`" && opening[2].indexOf("`") >= 0)) {
          fence = { char: opening[1][0], size: opening[1].length };
          code.push(true);
          continue;
        }
        if (AMBIGUOUS_FENCE.test(line))
          strict = true;
        code.push(false);
      }
      const start = DEFINITION_START.exec(line);
      if (start && !start[2].startsWith("^")) {
        const rest = DEFINITION_REST.exec(line.slice(start[0].length));
        if (rest) {
          const key = normalizeLabel(start[2]);
          if (!ctx.defs.has(key))
            ctx.defs.set(key, rest[1] ?? rest[2] ?? "");
          lines[n] = start[1].replace(/[ \t]+$/, "");
        } else {
          lines[n] = `${start[1]}\\${line.slice(start[1].length)}`;
        }
      }
    }
    const segments = [];
    for (let n = 0;n < lines.length; n++) {
      const last = segments[segments.length - 1];
      if (last && last.code === code[n])
        last.text += `
${lines[n]}`;
      else
        segments.push({ code: code[n], text: lines[n] });
    }
    if (mode === "no fences")
      return finish(segments.map((segment) => unfenced(segment.text, ctx)).join(`
`), ctx);
    const pieces = segments.map((segment) => segment.code ? segment.text : settle(segment.text, ctx));
    let flat = null;
    let nested = null;
    for (let k = 0;k < segments.length; k++) {
      if (segments[k].code && (flat !== null || nested !== null))
        return null;
      flat = fenceAfter(pieces[k], flat, false);
      nested = fenceAfter(pieces[k], nested, true);
    }
    let out = pieces.join(`
`);
    if (flat !== null || nested !== null) {
      if (flat === null || nested === null || flat.char !== nested.char || flat.size !== nested.size)
        return null;
      out += `
${flat.char.repeat(flat.size)}`;
      if (fenceAfter(out, null, false) !== null || fenceAfter(out, null, true) !== null)
        return null;
    }
    return finish(out, ctx);
  }
  var escapeFences = (text) => text.replace(/^( {0,3})(`{3,}|~{3,})/gm, "$1\\$2");
  function unfenced(text, ctx) {
    let current = text;
    for (let round = 0;round < 4; round++) {
      current = settle(escapeFences(current), ctx);
      if (escapeFences(current) === current)
        return current;
    }
    return escapeFences(current).replace(/[\\![\]<`]/g, "\\$&");
  }
  function finish(out, ctx) {
    return out.replace(new RegExp(`${SLOT_OPEN}(\\d+)${SLOT_CLOSE}`, "g"), (_all, index) => ctx.slots[Number(index)] ?? "");
  }

  // src/core/presets.ts
  var OUTPUTS = ["textview", "clipboard", "paste", "largetype"];
  var THINK_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  var DEFAULT_PRESETS = [
    { id: "summarize", name: "Summarize", prompt: `Summarize the following text concisely:

{text}`, output: "textview" },
    { id: "explain", name: "Explain", prompt: `Explain the following text in simple terms:

{text}`, output: "textview" },
    { id: "translate", name: "Translate", prompt: `Translate the following text to {language}. Reply with only the translation:

{text}`, output: "clipboard" },
    { id: "proofread", name: "Proofread", prompt: `Proofread the following text. Fix spelling, grammar, and punctuation without changing its meaning or tone. Reply with only the corrected text:

{text}`, output: "paste" },
    { id: "fix-code", name: "Fix code", prompt: `Find and fix the bugs in the following code. Explain each fix briefly, then show the corrected code:

{text}`, output: "textview" },
    { id: "action-items", name: "Extract action items", prompt: `List the action items in the following text as short bullet points, with an owner and a date when the text names them:

{text}`, output: "largetype" }
  ];
  function defaultPresetsJson() {
    return `${JSON.stringify(DEFAULT_PRESETS, null, 2)}
`;
  }

  class JsonError extends Error {
    line;
    constructor(line, message) {
      super(message);
      this.line = line;
    }
  }
  function parseLocated(text) {
    const lines = new WeakMap;
    const keyLines = new WeakMap;
    let index = 0;
    let line = 1;
    const fail = (message) => {
      throw new JsonError(line, message);
    };
    const skip = () => {
      while (index < text.length) {
        const ch = text[index];
        if (ch === `
`)
          line++;
        else if (ch !== " " && ch !== "\t" && ch !== "\r")
          break;
        index++;
      }
    };
    const string = () => {
      index++;
      let result = "";
      while (index < text.length) {
        const ch = text[index];
        if (ch === '"') {
          index++;
          return result;
        }
        if (ch === `
`)
          fail("a string is not closed before the end of the line");
        if (ch === "\\") {
          const next = text[index + 1];
          const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: `
`, r: "\r", t: "\t" };
          if (next === "u") {
            const hex = text.slice(index + 2, index + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex))
              fail("a \\u escape needs four hex digits");
            result += String.fromCharCode(parseInt(hex, 16));
            index += 6;
            continue;
          }
          if (next === undefined || simple[next] === undefined)
            fail(`unknown escape \\${next ?? ""}`);
          result += simple[next];
          index += 2;
          continue;
        }
        result += ch;
        index++;
      }
      return fail("a string is not closed");
    };
    const value = () => {
      skip();
      const ch = text[index];
      if (ch === "{") {
        const object = {};
        lines.set(object, line);
        const keys = {};
        keyLines.set(object, keys);
        index++;
        skip();
        if (text[index] === "}") {
          index++;
          return object;
        }
        for (;; ) {
          skip();
          if (text[index] !== '"')
            fail("expected a quoted property name");
          const keyLine = line;
          const key = string();
          keys[key] = keyLine;
          skip();
          if (text[index] !== ":")
            fail(`expected ":" after "${key}"`);
          index++;
          object[key] = value();
          skip();
          if (text[index] === ",") {
            index++;
            continue;
          }
          if (text[index] === "}") {
            index++;
            return object;
          }
          fail('expected "," or "}"');
        }
      }
      if (ch === "[") {
        const array = [];
        lines.set(array, line);
        index++;
        skip();
        if (text[index] === "]") {
          index++;
          return array;
        }
        for (;; ) {
          array.push(value());
          skip();
          if (text[index] === ",") {
            index++;
            continue;
          }
          if (text[index] === "]") {
            index++;
            return array;
          }
          fail('expected "," or "]"');
        }
      }
      if (ch === '"')
        return string();
      for (const [word, result] of [["true", true], ["false", false], ["null", null]]) {
        if (text.startsWith(word, index)) {
          index += word.length;
          return result;
        }
      }
      const number = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(index));
      if (number) {
        index += number[0].length;
        return Number(number[0]);
      }
      return fail(ch === undefined ? "the file ends too early" : `unexpected "${ch}"`);
    };
    const result = value();
    skip();
    if (index < text.length)
      fail("unexpected text after the list");
    return { value: result, lines, keyLines };
  }
  function parsePresets(text) {
    let located;
    try {
      located = parseLocated(text);
    } catch (error) {
      if (error instanceof JsonError)
        return { presets: [], errors: [{ line: error.line, message: error.message }] };
      throw error;
    }
    const errors = [];
    const presets = [];
    const root = located.value;
    if (!Array.isArray(root))
      return { presets: [], errors: [{ line: 1, message: "presets.json must hold a list of presets between [ and ]" }] };
    const ids = new Set;
    for (const item of root) {
      const line = typeof item === "object" && item !== null ? located.lines.get(item) ?? 1 : 1;
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        errors.push({ line, message: "each preset must be an object between { and }" });
        continue;
      }
      const keyLine = (key) => located.keyLines.get(item)?.[key] ?? line;
      const problems = [];
      const str = (key, required) => {
        const v = item[key];
        if (v === undefined) {
          if (required)
            problems.push({ line, message: `a preset needs "${key}"` });
          return;
        }
        if (typeof v !== "string" || v.trim() === "") {
          problems.push({ line: keyLine(key), message: `"${key}" must be a non-empty string` });
          return;
        }
        return v;
      };
      const id = str("id", true);
      const name = str("name", true);
      const prompt = str("prompt", true);
      const system = str("system", false);
      const model = str("model", false);
      const think = str("think", false);
      if (id !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(id))
        problems.push({ line: keyLine("id"), message: `"id" may use only lower-case letters, digits, and hyphens (got "${id}")` });
      if (id !== undefined && ids.has(id))
        problems.push({ line: keyLine("id"), message: `"id" "${id}" is used twice` });
      if (prompt !== undefined && prompt.indexOf("{text}") < 0)
        problems.push({ line: keyLine("prompt"), message: '"prompt" must contain {text}, where the selected text goes' });
      if (think !== undefined && THINK_VALUES.indexOf(think) < 0)
        problems.push({ line: keyLine("think"), message: `"think" must be one of ${THINK_VALUES.join(", ")}` });
      let web;
      if (item.web !== undefined) {
        if (typeof item.web === "boolean")
          web = item.web;
        else
          problems.push({ line: keyLine("web"), message: '"web" must be true or false' });
      }
      let output = "textview";
      if (item.output !== undefined) {
        if (typeof item.output === "string" && OUTPUTS.indexOf(item.output) >= 0)
          output = item.output;
        else
          problems.push({ line: keyLine("output"), message: `"output" must be one of ${OUTPUTS.join(", ")}` });
      }
      if (problems.length > 0) {
        errors.push(...problems);
        continue;
      }
      ids.add(id);
      presets.push({ id, name, prompt, ...system ? { system } : {}, ...model ? { model } : {}, ...web !== undefined ? { web } : {}, ...think ? { think } : {}, output });
    }
    return { presets, errors };
  }
  function fillPrompt(preset, text, language) {
    return preset.prompt.replace(/\{language\}/g, language).split("{text}").join(text);
  }

  // src/core/attachments.ts
  var MAX_FILE_BYTES = 20 * 1024 * 1024;
  var MAX_BODY_BYTES = 32 * 1024 * 1024;

  // src/core/base64.ts
  var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var LOOKUP = (() => {
    const table = new Array(128).fill(-1);
    for (let i = 0;i < ALPHABET.length; i++)
      table[ALPHABET.charCodeAt(i)] = i;
    return table;
  })();
  function encodeBase64(bytes) {
    const parts = [];
    for (let i = 0;i < bytes.length; i += 3) {
      const a = bytes[i];
      const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      const chunk = a << 16 | b << 8 | c;
      parts.push(ALPHABET[chunk >> 18 & 63] + ALPHABET[chunk >> 12 & 63] + (i + 1 < bytes.length ? ALPHABET[chunk >> 6 & 63] : "=") + (i + 2 < bytes.length ? ALPHABET[chunk & 63] : "="));
    }
    return parts.join("");
  }
  function decodeBase64(text) {
    const symbols = [];
    for (let i = 0;i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 61)
        break;
      if (code === 10 || code === 13 || code === 32 || code === 9)
        continue;
      const value = code < 128 ? LOOKUP[code] : -1;
      if (value < 0)
        throw new Error(`invalid base64 character at ${i}`);
      symbols.push(value);
    }
    if (symbols.length % 4 === 1)
      throw new Error("invalid base64 length");
    const out = new Uint8Array(Math.floor(symbols.length * 3 / 4));
    let o = 0;
    for (let i = 0;i < symbols.length; i += 4) {
      const s0 = symbols[i];
      const s1 = symbols[i + 1];
      const s2 = i + 2 < symbols.length ? symbols[i + 2] : 0;
      const s3 = i + 3 < symbols.length ? symbols[i + 3] : 0;
      const chunk = s0 << 18 | s1 << 12 | s2 << 6 | s3;
      if (o < out.length)
        out[o++] = chunk >> 16 & 255;
      if (o < out.length)
        out[o++] = chunk >> 8 & 255;
      if (o < out.length)
        out[o++] = chunk & 255;
    }
    return out;
  }

  // src/store/settings.ts
  function emptySettings() {
    return { schema: 1, defaultModel: null, lastModel: null, favorites: [] };
  }
  function path(host) {
    return `${dataDir(host)}/settings.json`;
  }
  function getSettings(host) {
    try {
      const parsed = JSON.parse(host.readText(path(host)));
      return {
        schema: 1,
        defaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel : null,
        lastModel: typeof parsed.lastModel === "string" ? parsed.lastModel : null,
        favorites: Array.isArray(parsed.favorites) ? parsed.favorites.filter((id) => typeof id === "string") : []
      };
    } catch {
      return emptySettings();
    }
  }

  // src/store/requests.ts
  var REFERER = "https://github.com/Sillybit-io/silly-alfred-aichat";
  var requestsDir = (host) => `${dataDir(host)}/requests`;
  var requestDir = (host, rid) => `${requestsDir(host)}/${rid}`;
  var lanesDir = (host) => `${dataDir(host)}/lanes`;
  var lanePointer = (host, lane) => `${lanesDir(host)}/${lane}`;
  function transport(host, rid) {
    const dir = requestDir(host, rid);
    return {
      dir,
      record: `${dir}/request.json`,
      body: `${dir}/body.json`,
      out: `${dir}/out`,
      headers: `${dir}/headers`,
      pid: `${dir}/pid`,
      exit: `${dir}/exit`,
      stderr: `${dir}/stderr`,
      stop: `${dir}/stop`
    };
  }
  function readOptional(host, path) {
    try {
      return host.readText(path);
    } catch {
      return null;
    }
  }
  function loadRecord(host, rid) {
    const text = readOptional(host, transport(host, rid).record);
    if (text === null)
      return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  function laneRecordId(host, lane) {
    const text = readOptional(host, lanePointer(host, lane));
    return text === null || text.trim() === "" ? null : text.trim();
  }

  // src/features/history.ts
  function toggle(field, on, off) {
    return (ctx) => {
      const chat = ctx.ensureChat();
      let value = false;
      mutateChat(ctx.host, chat.id, (current) => {
        current[field] = !current[field];
        value = current[field];
      });
      return { kind: "notice", text: value ? on : off };
    };
  }
  var pin = {
    usage: "/pin",
    help: "Pin or unpin this chat so it stays at the top and is never pruned",
    run: toggle("pinned", "Pinned. It stays at the top of the history and is never pruned.", "Unpinned.")
  };
  var archive = {
    usage: "/archive",
    help: "Archive or restore this chat",
    run: toggle("archived", "Archived. Find it with `archived` in the history list.", "Restored from the archive.")
  };

  // src/features/index.ts
  var FALLBACK_MODEL = "openrouter/auto";
  function int(value, fallback) {
    const parsed = Number(value);
    return value !== undefined && value.trim() !== "" && Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  }
  function text(value, fallback) {
    return value !== undefined && value.trim() !== "" ? value.trim() : fallback;
  }
  function readConfig(host) {
    const env = host.env;
    const engine = text(env.pdf_engine, "auto");
    const privacy = text(env.privacy_mode, "deny");
    const key = (env.openrouter_api_key ?? "").trim();
    const keyIssue = keyProblem(key);
    return {
      apiKey: keyIssue === null ? key : "",
      keyIssue,
      defaultModel: text(env.default_model, FALLBACK_MODEL),
      privacy: privacy === "standard" || privacy === "zdr" ? privacy : "deny",
      webRewrite: env.web_rewrite !== "0",
      systemPrompt: env.system_prompt ?? "",
      systemContext: env.system_context !== "0",
      presetClipboard: env.preset_clipboard === "1",
      maxContext: Math.max(1, int(env.max_context, 20)),
      timeoutSeconds: Math.max(5, int(env.timeout_seconds, 90)),
      pdfEngine: engine === "free" || engine === "ocr" || engine === "native" ? engine : "auto",
      webDefault: env.web_default === "1",
      webMaxResults: Math.max(1, int(env.web_max_results, 5)),
      reasoningDefault: text(env.reasoning_default, "model"),
      keepReasoning: env.keep_reasoning === "1",
      autoTitles: env.auto_titles !== "0",
      titleModel: text(env.title_model, ""),
      translateLanguage: text(env.translate_language, "English"),
      exportFolder: text(env.export_folder, "~/Documents/AI Chat"),
      imagesFolder: text(env.images_folder, "~/Pictures/AI Chat"),
      imageModel: text(env.image_model, ""),
      savePrompts: env.image_save_prompt === "1",
      imageTimeoutSeconds: Math.max(10, int(env.image_timeout_seconds, 300)),
      visionFallbackModel: text(env.vision_fallback_model, ""),
      retentionDays: Math.max(0, int(env.retention_days, 0)),
      maxChats: Math.max(0, int(env.max_chats, 0)),
      textAttachmentMaxKb: Math.max(1, int(env.text_attachment_max_kb, 200)),
      imageMaxEdge: Math.max(64, int(env.image_max_edge, 2048))
    };
  }

  // src/store/presets.ts
  var presetsPath = (host) => `${dataDir(host)}/presets.json`;
  function loadPresets(host) {
    const path = presetsPath(host);
    if (!host.exists(path)) {
      host.mkdirp(dataDir(host));
      host.writeAtomic(path, defaultPresetsJson());
    }
    const parsed = parsePresets(host.readText(path));
    return { ...parsed, path };
  }

  // src/app/presets.ts
  var EDIT_ID = "@edit";
  function inputText(host) {
    const given = host.env.preset_text;
    if (given !== undefined && given !== "")
      return given;
    return host.clipboardText() ?? "";
  }

  // src/app/preset-result.ts
  var path2 = (host) => `${dataDir(host)}/last-preset.json`;
  function saveLastResult(host, name, reply) {
    host.mkdirp(dataDir(host));
    host.writeAtomic(path2(host), JSON.stringify({ name, reply }));
  }

  // src/app/view.ts
  function envelope(arg, variables) {
    return JSON.stringify({ alfredworkflow: { arg, variables } });
  }

  // src/app/preset-run.ts
  var MAX_TIME_SECONDS = 60;
  function fail(message) {
    return envelope("", { preset_output: "error", preset_error: message });
  }
  function failureText(title, detail, next) {
    return `${title}: ${detail} ${next}`;
  }
  function replyFrom(body) {
    try {
      const parsed = JSON.parse(body);
      const content = parsed.choices?.[0]?.message?.content;
      return typeof content === "string" && content.trim() !== "" ? content : null;
    } catch {
      return null;
    }
  }
  function request(host, config, preset, prompt) {
    const settings = getSettings(host);
    const modelId = preset.model ?? settings.defaultModel ?? config.defaultModel ?? FALLBACK_MODEL;
    const turns = [];
    const system = preset.system ?? config.systemPrompt;
    if (system.trim() !== "")
      turns.push({ role: "system", content: system });
    turns.push({ role: "user", content: prompt });
    const options = {
      modelId,
      model: getModel(host, modelId),
      stream: false,
      pdfEngine: config.pdfEngine,
      web: preset.web ?? false,
      webMaxResults: config.webMaxResults,
      effort: preset.think === undefined ? null : preset.think === "off" ? "none" : preset.think,
      privacy: config.privacy
    };
    const folder = `${cacheDir(host)}/preset-${host.randomId()}`;
    host.mkdirp(folder);
    try {
      host.writeAtomic(`${folder}/body.json`, encodeBody(buildBody(turns, options)));
      const url = chatUrl(host.env);
      const run = host.runSync([
        curlBinary(host.env),
        ...curlProtocolArgs(url),
        "-o",
        `${folder}/out`,
        "-D",
        `${folder}/headers`,
        "--silent",
        "--show-error",
        "--connect-timeout",
        "15",
        "--max-time",
        String(MAX_TIME_SECONDS),
        ...CURL_STDIN_CONFIG,
        "-H",
        "Content-Type: application/json",
        "-H",
        `HTTP-Referer: ${REFERER}`,
        "-H",
        "X-Title: Alfred AI Chat",
        "--data-binary",
        `@${folder}/body.json`,
        url
      ], { timeoutMs: (MAX_TIME_SECONDS + 15) * 1000, stdin: curlAuthConfig(config.apiKey) });
      const read = (name) => host.exists(`${folder}/${name}`) ? host.readText(`${folder}/${name}`) : "";
      const body = read("out");
      const headers = read("headers");
      const reply = run.exit === 0 && /^HTTP\/\S+\s+2\d\d/m.test(headers) ? replyFrom(body) : null;
      if (reply !== null)
        return { ok: true, reply };
      const mapped = describeFailure({ headers, body: body.slice(0, 4000), curlExit: run.exit === 0 ? null : run.exit, streamError: null, finishReason: null });
      return { ok: false, message: failureText(mapped.title, mapped.detail, mapped.next) };
    } finally {
      host.remove(folder);
    }
  }
  function main(host, argv) {
    const config = readConfig(host);
    const id = (host.env.preset_id ?? "").trim();
    const loaded = loadPresets(host);
    if (id === EDIT_ID) {
      host.runSync(["/usr/bin/open", "-t", loaded.path], { timeoutMs: 1e4 });
      return envelope("", { preset_output: "edit", preset_error: "" });
    }
    const preset = loaded.presets.find((candidate) => candidate.id === id);
    if (!preset)
      return fail(`Preset "${id}" was not found${loaded.errors.length > 0 ? `; presets.json has a problem on line ${loaded.errors[0].line}` : ""}.`);
    const text = (argv[0] ?? "").trim() !== "" ? argv[0] : inputText(host);
    if (text.trim() === "")
      return fail("There is no text to work on. Select some text or copy it first.");
    const prompt = fillPrompt(preset, text, config.translateLanguage);
    if (preset.output === "textview") {
      return envelope(prompt, { preset_output: "textview", session_action: "new", preset_error: "" });
    }
    if (config.apiKey === "")
      return fail(config.keyIssue ?? "Add your OpenRouter API key in the workflow's Configuration first.");
    const result = request(host, config, preset, prompt);
    if (!result.ok)
      return fail(result.message);
    saveLastResult(host, preset.name, result.reply);
    const output = (preset.output === "clipboard" || preset.output === "paste") && !config.presetClipboard ? "view" : preset.output;
    return envelope(output === "view" ? "" : sanitizeMarkdown(result.reply), { preset_output: output, preset_error: "" });
  }

  // src/host/jxa.ts
  function isNil(value) {
    if (value === null || value === undefined)
      return true;
    const unwrapped = ObjC.unwrap(value);
    return unwrapped === null || unwrapped === undefined;
  }
  function nsString(text) {
    return $(text);
  }
  function dataFromBytes(bytes) {
    return $.NSData.alloc.initWithBase64EncodedStringOptions(encodeBase64(bytes), 0);
  }
  function bytesFromData(data) {
    return decodeBase64(ObjC.unwrap(data.base64EncodedStringWithOptions(0)));
  }
  function fileManager() {
    return $.NSFileManager.defaultManager;
  }
  var PRIVATE_DIR = 448;
  var PRIVATE_FILE = 384;
  function permissions(mode) {
    return $({ NSFilePosixPermissions: mode });
  }
  function fail2(action, path) {
    throw new Error(`${action} failed for ${path}`);
  }
  function launch(argv, out, err, env, stdin) {
    const task = $.NSTask.alloc.init;
    const absolute = argv[0].charAt(0) === "/";
    task.executableURL = $.NSURL.fileURLWithPath(absolute ? argv[0] : "/usr/bin/env");
    task.arguments = absolute ? argv.slice(1) : argv;
    task.environment = $(scrubbedEnv(env));
    const pipe = stdin === undefined ? null : $.NSPipe.pipe;
    task.standardInput = pipe === null ? $.NSFileHandle.fileHandleWithNullDevice : pipe;
    task.standardOutput = out;
    task.standardError = err;
    if (!task.launchAndReturnError(false))
      throw new Error(`could not launch ${argv[0]}`);
    if (pipe !== null) {
      const writer = pipe.fileHandleForWriting;
      try {
        writer.writeData(nsString(stdin).dataUsingEncoding($.NSUTF8StringEncoding));
      } catch {}
      writer.closeFile;
    }
    return task;
  }

  class JxaHost {
    env = ObjC.deepUnwrap($.NSProcessInfo.processInfo.environment);
    constructor() {
      try {
        ObjC.bindFunction("umask", ["int", ["int"]]);
        $.umask(63);
      } catch {}
    }
    readText(path) {
      const text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, $());
      if (isNil(text))
        fail2("read", path);
      return ObjC.unwrap(text);
    }
    readBytesFrom(path, offset) {
      const handle = $.NSFileHandle.fileHandleForReadingAtPath(path);
      if (isNil(handle))
        fail2("open", path);
      try {
        handle.seekToFileOffset(offset);
        return bytesFromData(handle.readDataToEndOfFile);
      } finally {
        handle.closeFile;
      }
    }
    writeAtomic(path, data) {
      const payload = typeof data === "string" ? nsString(data).dataUsingEncoding($.NSUTF8StringEncoding) : dataFromBytes(data);
      if (!payload.writeToFileAtomically(path, true))
        fail2("write", path);
      fileManager().setAttributesOfItemAtPathError(permissions(PRIVATE_FILE), path, $());
    }
    mkdirp(path) {
      if (!fileManager().createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, true, permissions(PRIVATE_DIR), $()))
        fail2("mkdir", path);
    }
    mkdirExclusive(path) {
      if (fileManager().createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, false, permissions(PRIVATE_DIR), $()))
        return true;
      if (fileManager().fileExistsAtPath(path))
        return false;
      return fail2("mkdir", path);
    }
    move(from, to) {
      if (!fileManager().moveItemAtPathToPathError(from, to, $()))
        fail2("move", `${from} to ${to}`);
    }
    remove(path) {
      if (fileManager().fileExistsAtPath(path) && !fileManager().removeItemAtPathError(path, $()))
        fail2("remove", path);
    }
    restrict(path) {
      const manager = fileManager();
      if (!manager.fileExistsAtPath(path))
        return;
      const apply = (item) => {
        const attributes = manager.attributesOfItemAtPathError(item, $());
        if (isNil(attributes))
          fail2("read the permissions of", item);
        const type = String(ObjC.unwrap(attributes.objectForKey("NSFileType")));
        if (type === "NSFileTypeSymbolicLink")
          return type;
        if (!manager.setAttributesOfItemAtPathError(permissions(type === "NSFileTypeDirectory" ? PRIVATE_DIR : PRIVATE_FILE), item, $()))
          fail2("restrict", item);
        return type;
      };
      if (apply(path) !== "NSFileTypeDirectory")
        return;
      const names = manager.subpathsOfDirectoryAtPathError(path, $());
      if (isNil(names))
        fail2("list", path);
      for (const name of ObjC.deepUnwrap(names))
        apply(`${path}/${name}`);
    }
    exists(path) {
      return fileManager().fileExistsAtPath(path);
    }
    stat(path) {
      const attributes = fileManager().attributesOfItemAtPathError(path, $());
      if (isNil(attributes))
        return null;
      const date = attributes.objectForKey("NSFileModificationDate");
      return {
        size: Number(ObjC.unwrap(attributes.objectForKey("NSFileSize"))),
        mtimeMs: isNil(date) ? 0 : date.timeIntervalSince1970 * 1000,
        isDirectory: ObjC.unwrap(attributes.objectForKey("NSFileType")) === "NSFileTypeDirectory"
      };
    }
    listDir(path) {
      const names = fileManager().contentsOfDirectoryAtPathError(path, $());
      if (isNil(names))
        fail2("list", path);
      return ObjC.deepUnwrap(names);
    }
    spawnSupervised(argv, files, options = {}) {
      const nullDevice = $.NSFileHandle.fileHandleWithNullDevice;
      launch(supervisorArgv(argv, files), nullDevice, nullDevice, this.env, options.stdin);
    }
    processCommand(pid) {
      if (!isSafePid(pid))
        return null;
      return commandFromPs(this.runSync(psArgv(pid), { timeoutMs: 5000 }));
    }
    signalTerm(pid) {
      if (!isSafePid(pid))
        return false;
      try {
        return this.runSync(killArgv(pid), { timeoutMs: 5000 }).exit === 0;
      } catch {
        return false;
      }
    }
    runSync(argv, options = {}) {
      const folder = `${ObjC.unwrap($.NSTemporaryDirectory())}aichat-run-${this.randomId()}`;
      this.mkdirp(folder);
      const outPath = `${folder}/out`;
      const errPath = `${folder}/err`;
      fileManager().createFileAtPathContentsAttributes(outPath, $(), permissions(PRIVATE_FILE));
      fileManager().createFileAtPathContentsAttributes(errPath, $(), permissions(PRIVATE_FILE));
      const out = $.NSFileHandle.fileHandleForWritingAtPath(outPath);
      const err = $.NSFileHandle.fileHandleForWritingAtPath(errPath);
      try {
        const task = launch(argv, out, err, this.env, options.stdin);
        const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
        let timedOut = false;
        while (task.isRunning) {
          if (Date.now() > deadline) {
            timedOut = true;
            task.terminate;
            break;
          }
          delay(0.005);
        }
        if (!timedOut)
          task.waitUntilExit;
        out.closeFile;
        err.closeFile;
        return {
          exit: timedOut ? 124 : task.terminationStatus,
          stdout: this.readText(outPath),
          stderr: this.readText(errPath)
        };
      } finally {
        this.remove(folder);
      }
    }
    nowMs() {
      return Date.now();
    }
    sleepMs(ms) {
      delay(ms / 1000);
    }
    randomId() {
      return String(ObjC.unwrap($.NSUUID.UUID.UUIDString)).toLowerCase().replace(/-/g, "");
    }
    confirm(message, action) {
      const app = Application.currentApplication();
      app.includeStandardAdditions = true;
      try {
        app.activate();
      } catch {}
      try {
        const answer = app.displayDialog(message, { buttons: ["Cancel", action], defaultButton: "Cancel", cancelButton: "Cancel", withIcon: "caution", givingUpAfter: 120 });
        return answer.buttonReturned === action && !answer.gaveUp;
      } catch {
        return false;
      }
    }
    chooseFiles(options = {}) {
      const app = Application.currentApplication();
      app.includeStandardAdditions = true;
      try {
        const picked = app.chooseFile({
          withPrompt: options.prompt ?? "Choose files to attach",
          multipleSelectionsAllowed: options.multiple ?? true
        });
        const list = Array.isArray(picked) ? picked : [picked];
        return { cancelled: false, paths: list.map((item) => String(item)) };
      } catch (error) {
        if (error && error.errorNumber === -128)
          return { cancelled: true };
        throw error;
      }
    }
    clipboardPng() {
      ObjC.import("AppKit");
      const board = $.NSPasteboard.generalPasteboard;
      const png = board.dataForType($.NSPasteboardTypePNG);
      if (!isNil(png))
        return bytesFromData(png);
      const tiff = board.dataForType($.NSPasteboardTypeTIFF);
      if (isNil(tiff))
        return null;
      const representation = $.NSBitmapImageRep.imageRepWithData(tiff);
      if (isNil(representation))
        return null;
      const converted = representation.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
      return isNil(converted) ? null : bytesFromData(converted);
    }
    clipboardText() {
      ObjC.import("AppKit");
      const text = $.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString);
      return isNil(text) ? null : String(ObjC.unwrap(text));
    }
    log(message) {
      $.NSFileHandle.fileHandleWithStandardError.writeData(nsString(`${redact(message, this.env)}
`).dataUsingEncoding($.NSUTF8StringEncoding));
    }
  }
  function createJxaHost() {
    return new JxaHost;
  }

  // src/store/maintenance.ts
  var PRIVATE_MARK = ".private-v1";
  var SWEPT_MARK = ".swept";
  var SWEEP_EVERY_MS = 60 * 60 * 1000;
  function maintained(host) {
    runMaintenance(host);
    return host;
  }
  function runMaintenance(host) {
    try {
      const data = dataDir(host);
      const cache = cacheDir(host);
      const swept = host.stat(`${data}/${SWEPT_MARK}`);
      const fresh = swept !== null && host.nowMs() - swept.mtimeMs <= SWEEP_EVERY_MS;
      if (fresh && host.exists(`${data}/${PRIVATE_MARK}`))
        return;
      host.mkdirp(data);
      host.mkdirp(cache);
      if (!host.exists(`${data}/${PRIVATE_MARK}`)) {
        host.restrict(data);
        host.restrict(cache);
        host.remove(`${cache}/favicons`);
        host.writeAtomic(`${data}/${PRIVATE_MARK}`, "1");
      }
      if (!fresh) {
        sweepRequests(host);
        host.writeAtomic(`${data}/${SWEPT_MARK}`, String(host.nowMs()));
      }
    } catch (error) {
      host.log(`maintenance failed: ${String(error)}`);
    }
  }
  function sweepRequests(host) {
    if (!host.exists(requestsDir(host)))
      return;
    const now = host.nowMs();
    for (const rid of host.listDir(requestsDir(host))) {
      const dir = requestDir(host, rid);
      const info = host.stat(dir);
      if (info === null || now - info.mtimeMs < SWEEP_EVERY_MS)
        continue;
      const record = loadRecord(host, rid);
      const valid = record !== null && typeof record.id === "string" && typeof record.lane === "string" && typeof record.startedAt === "number";
      if (!valid || record.final || laneRecordId(host, record.lane) !== rid)
        host.remove(dir);
    }
  }

  // src/jxa/entry.ts
  function defineEntry(main) {
    __aichat_main = main;
  }

  // src/entries/preset-run.ts
  defineEntry((argv) => main(maintained(createJxaHost()), argv));
})();
function run(argv) { return __aichat_main(argv); }
