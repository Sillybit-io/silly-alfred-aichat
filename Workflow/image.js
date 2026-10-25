#!/usr/bin/osascript -l JavaScript
var __aichat_main;
(() => {
  // src/core/imagegen.ts
  var RESOLUTIONS = ["512", "768", "1K", "1.5K", "2K", "4K"];
  var MAX_IMAGES = 10;
  function parseImagePrompt(text) {
    const request = { prompt: "", model: null, aspectRatio: null, resolution: null, count: 1 };
    const words = text.trim().split(/\s+/).filter((word) => word !== "");
    const kept = [];
    for (let i = 0;i < words.length; i++) {
      const word = words[i];
      if (word !== "--ar" && word !== "--res" && word !== "--n" && word !== "--model") {
        kept.push(word);
        continue;
      }
      const value = words[++i];
      if (value === undefined)
        return { ok: false, message: `\`${word}\` needs a value.` };
      if (word === "--ar") {
        if (!/^\d{1,2}:\d{1,2}$/.test(value))
          return { ok: false, message: "`--ar` takes a ratio such as `16:9` or `1:1`." };
        request.aspectRatio = value;
      } else if (word === "--res") {
        const tier = RESOLUTIONS.find((candidate) => candidate.toLowerCase() === value.toLowerCase());
        if (!tier)
          return { ok: false, message: `\`--res\` takes ${RESOLUTIONS.map((r) => `\`${r}\``).join(", ")}.` };
        request.resolution = tier;
      } else if (word === "--n") {
        const count = Number(value);
        if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES)
          return { ok: false, message: `\`--n\` takes a number from 1 to ${MAX_IMAGES}.` };
        request.count = count;
      } else {
        request.model = value;
      }
    }
    request.prompt = kept.join(" ");
    if (request.prompt === "")
      return { ok: false, message: "Describe the image first, for example `a lighthouse at dusk --ar 16:9`." };
    return { ok: true, request };
  }
  function imageBody(request, modelId) {
    const body = { model: modelId, prompt: request.prompt };
    if (request.count > 1)
      body.n = request.count;
    if (request.aspectRatio)
      body.aspect_ratio = request.aspectRatio;
    if (request.resolution)
      body.resolution = request.resolution;
    return JSON.stringify(body);
  }
  var MEDIA_EXTENSIONS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg"
  };
  function startsWith(bytes, signature, offset = 0) {
    return signature.every((value, i) => bytes[offset + i] === value);
  }
  function imageExtension(mediaType, bytes) {
    const fromType = mediaType ? MEDIA_EXTENSIONS[mediaType.toLowerCase().split(";")[0].trim()] : undefined;
    if (fromType)
      return fromType;
    if (startsWith(bytes, [137, 80, 78, 71]))
      return "png";
    if (startsWith(bytes, [255, 216, 255]))
      return "jpg";
    if (startsWith(bytes, [71, 73, 70, 56]))
      return "gif";
    if (startsWith(bytes, [82, 73, 70, 70]) && startsWith(bytes, [87, 69, 66, 80], 8))
      return "webp";
    let head = "";
    for (let i = 0;i < Math.min(bytes.length, 256); i++)
      head += String.fromCharCode(bytes[i]);
    if (/<svg[\s>]/i.test(head) || /^\s*<\?xml/i.test(head))
      return "svg";
    return "png";
  }
  var IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
  function openArgv(path) {
    return /\.svg$/i.test(path) ? ["/usr/bin/open", "-R", path] : ["/usr/bin/open", path];
  }
  function markdownImage(path) {
    return `![](${path})`;
  }
  function imageMarkdown(path) {
    return `${markdownImage(path)}

\uD83D\uDCC2 \`${path}\``;
  }
  function imagePathsIn(text) {
    return [...text.matchAll(/^!\[\]\((.+)\)$/gm)].map((match) => match[1]);
  }
  function xattrPlist(text) {
    const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><string>${escaped}</string></plist>`;
  }
  function promptFromXattr(raw) {
    const match = /<string>([\s\S]*?)<\/string>/.exec(raw);
    return match ? match[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : "";
  }

  // src/core/hooks.ts
  var TEST_HOOKS = false;

  // src/core/capabilities.ts
  function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function strings(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  }
  function price(value) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  var IGNORED_PRICES = new Set(["prompt", "completion", "web_search", "internal_reasoning", "input_cache_read", "input_cache_write"]);
  function normalizeModel(raw) {
    if (!isObject(raw) || typeof raw.id !== "string" || raw.id === "")
      return null;
    const architecture = isObject(raw.architecture) ? raw.architecture : {};
    const pricing = isObject(raw.pricing) ? raw.pricing : {};
    const inputModalities = strings(architecture.input_modalities);
    const outputModalities = strings(architecture.output_modalities);
    const reasoning = isObject(raw.reasoning) ? {
      efforts: strings(raw.reasoning.supported_efforts),
      mandatory: raw.reasoning.mandatory === true,
      defaultEffort: typeof raw.reasoning.default_effort === "string" ? raw.reasoning.default_effort : null,
      defaultEnabled: raw.reasoning.default_enabled === true
    } : null;
    return {
      id: raw.id,
      name: typeof raw.name === "string" && raw.name !== "" ? raw.name : raw.id,
      contextLength: typeof raw.context_length === "number" ? raw.context_length : 0,
      promptPrice: price(pricing.prompt),
      completionPrice: price(pricing.completion),
      otherPriced: Object.entries(pricing).some(([key, value]) => !IGNORED_PRICES.has(key) && price(value) > 0),
      inputModalities: inputModalities.length > 0 ? inputModalities : ["text"],
      outputModalities: outputModalities.length > 0 ? outputModalities : ["text"],
      reasoning,
      supportedParameters: strings(raw.supported_parameters)
    };
  }
  function acceptsImage(model) {
    return model !== null && model.inputModalities.includes("image");
  }
  function acceptsFile(model) {
    return model !== null && model.inputModalities.includes("file");
  }
  function producesImage(model) {
    return model !== null && model.outputModalities.includes("image");
  }
  function supportsReasoning(model) {
    return model !== null && model.reasoning !== null;
  }
  function efforts(model) {
    if (!model || !model.reasoning)
      return [];
    const list = model.reasoning.efforts.filter((effort) => effort !== "none");
    if (!model.reasoning.mandatory && !list.includes("none"))
      list.push("none");
    return list;
  }
  function perMillion(perToken) {
    return Math.round(perToken * 1e6 * 1e6) / 1e6;
  }
  function isFree(model) {
    if (model.promptPrice !== 0 || model.completionPrice !== 0 || model.otherPriced === true)
      return false;
    return model.id.endsWith(":free") || model.outputModalities.every((modality) => modality === "text");
  }
  function pricedPerUse(model) {
    return model.promptPrice === 0 && model.completionPrice === 0 && !isFree(model);
  }

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

  // src/core/utf8.ts
  function continuation(bytes, index, low = 128, high = 191) {
    return index < bytes.length && bytes[index] >= low && bytes[index] <= high;
  }
  function decodeUtf8(bytes) {
    const parts = [];
    let run = [];
    const flush = () => {
      if (run.length > 0) {
        parts.push(String.fromCharCode(...run));
        run = [];
      }
    };
    const push = (codePoint) => {
      if (codePoint > 65535) {
        const offset = codePoint - 65536;
        run.push(55296 + (offset >> 10), 56320 + (offset & 1023));
      } else {
        run.push(codePoint);
      }
      if (run.length >= 4096)
        flush();
    };
    let i = 0;
    while (i < bytes.length) {
      const lead = bytes[i];
      if (lead < 128) {
        push(lead);
        i += 1;
      } else if (lead >= 194 && lead <= 223) {
        if (continuation(bytes, i + 1)) {
          push((lead & 31) << 6 | bytes[i + 1] & 63);
          i += 2;
        } else {
          push(65533);
          i += 1;
        }
      } else if (lead >= 224 && lead <= 239) {
        const low = lead === 224 ? 160 : 128;
        const high = lead === 237 ? 159 : 191;
        if (!continuation(bytes, i + 1, low, high)) {
          push(65533);
          i += 1;
        } else if (!continuation(bytes, i + 2)) {
          push(65533);
          i += 2;
        } else {
          push((lead & 15) << 12 | (bytes[i + 1] & 63) << 6 | bytes[i + 2] & 63);
          i += 3;
        }
      } else if (lead >= 240 && lead <= 244) {
        const low = lead === 240 ? 144 : 128;
        const high = lead === 244 ? 143 : 191;
        if (!continuation(bytes, i + 1, low, high)) {
          push(65533);
          i += 1;
        } else if (!continuation(bytes, i + 2)) {
          push(65533);
          i += 2;
        } else if (!continuation(bytes, i + 3)) {
          push(65533);
          i += 3;
        } else {
          push((lead & 7) << 18 | (bytes[i + 1] & 63) << 12 | (bytes[i + 2] & 63) << 6 | bytes[i + 3] & 63);
          i += 4;
        }
      } else {
        push(65533);
        i += 1;
      }
    }
    flush();
    return parts.join("");
  }

  // src/host/common.ts
  var SUPERVISOR_SCRIPT = [
    "umask 077",
    "pid_file=$1; exit_file=$2; err_file=$3; remove_file=$4; max_blocks=$5; shift 5",
    'if [ -n "$max_blocks" ]; then ulimit -f "$max_blocks" || exit 63; fi',
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
    return ["/bin/sh", "-c", SUPERVISOR_SCRIPT, "sh", files.pid, files.exit, files.stderr, files.remove ?? "", maxBlocks(files.maxBytes), ...argv];
  }
  function maxBlocks(maxBytes) {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1))
      throw new Error("maxBytes must be a positive safe integer");
    return maxBytes === undefined ? "" : String(Math.ceil(maxBytes / 512) + 1);
  }
  function boundedCommandArgv(argv, maxBytes) {
    if (argv.length === 0)
      throw new Error("runSync needs a command");
    return ["/bin/sh", "-c", 'umask 077; ulimit -f "$1" || exit 63; shift; exec "$@"', "sh", maxBlocks(maxBytes), ...argv];
  }
  function boundedRunResult(host, out, err, exit, maxBytes) {
    const stdout = host.readBytesFrom(out, 0, maxBytes + 1);
    const stderr = host.readBytesFrom(err, 0, maxBytes + 1);
    if (stdout.length > maxBytes || stderr.length > maxBytes)
      return { exit: 63, stdout: "", stderr: "" };
    return { exit, stdout: decodeUtf8(stdout), stderr: decodeUtf8(stderr) };
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
    return ["--proto", first, "--proto-redir", "=https", "--tlsv1.2"];
  }
  var MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
  var MAX_IMAGE_RESPONSE_BYTES = 512 * 1024 * 1024;
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

  // src/core/attachments.ts
  var MAX_FILE_BYTES = 20 * 1024 * 1024;
  var MAX_PENDING = 8;
  var MAX_BODY_BYTES = 32 * 1024 * 1024;
  var IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
  function extensionOf(name) {
    const dot = name.lastIndexOf(".");
    return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  }
  function baseName(path) {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(slash + 1) : path;
  }
  function classifyName(name) {
    const ext = extensionOf(name);
    const image = IMAGE_MIME[ext];
    if (image)
      return { kind: "image", ext: ext === "jpeg" ? "jpg" : ext, mime: image };
    if (ext === "pdf")
      return { kind: "file", ext, mime: "application/pdf" };
    return { kind: "unknown", ext: ext === "" ? "txt" : ext, mime: "text/plain" };
  }
  function looksLikeText(bytes) {
    const sample = Math.min(bytes.length, 8192);
    for (let i = 0;i < sample; i++)
      if (bytes[i] === 0)
        return false;
    return true;
  }
  function megabytes(bytes) {
    return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
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
  function escapeMarkdown(text, max = 200) {
    const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
    const cut = flat.length > max ? `${flat.slice(0, max)}…` : flat;
    return cut.replace(/[\\`*_{}[\]()<>!|~&#+]/g, "\\$&");
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

  // src/core/transcript.ts
  var YOU_HEADING = "# \uD83E\uDDD1 You";
  var ASSISTANT_HEADING = "# \uD83E\uDD16 Assistant";
  var TURN_BREAK = "---";
  function formatSize(bytes) {
    if (bytes < 1024)
      return `${bytes} B`;
    if (bytes < 1024 * 1024)
      return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  function sourcesOf(message) {
    const seen = new Set;
    const sources = [];
    for (const annotation of message.annotations ?? []) {
      if (annotation.type !== "url_citation")
        continue;
      const inner = typeof annotation.url_citation === "object" && annotation.url_citation !== null ? annotation.url_citation : annotation;
      const url = typeof inner.url === "string" ? safeUrl(inner.url) : null;
      if (url === null || seen.has(url))
        continue;
      seen.add(url);
      sources.push({ url, title: typeof inner.title === "string" && inner.title.trim() !== "" ? inner.title : url });
    }
    return sources;
  }
  function encodeParens(url) {
    return url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\[/g, "%5B").replace(/\]/g, "%5D");
  }
  function sourceLine(source) {
    return `[${escapeMarkdown(source.title)}](${encodeParens(source.url)})`;
  }
  function sourcesRow(sources, cap) {
    const seen = new Set;
    const unique = sources.filter((source) => {
      const host = hostOf(source.url);
      if (seen.has(host))
        return false;
      seen.add(host);
      return true;
    });
    const shown = unique.slice(0, cap);
    const links = shown.map((source) => `[${escapeMarkdown(hostOf(source.url))}](${encodeParens(source.url)})`);
    const more = unique.length > shown.length ? `  ·  +${unique.length - shown.length} more with \`/sources\`` : "";
    return `**Sources**  ${links.join("  ·  ")}${more}`;
  }
  function quote(text) {
    return text.split(`
`).map((line) => line === "" ? ">" : `> ${line}`).join(`
`);
  }
  function renderMessage(message, options = {}) {
    const parts = [message.role === "user" ? YOU_HEADING : ASSISTANT_HEADING];
    if (message.reasoning)
      parts.push(quote(message.reasoning.trim()));
    if (message.content !== "")
      parts.push(message.content);
    for (const attachment of message.attachments)
      parts.push(`\uD83D\uDCCE ${attachment.name} (${formatSize(attachment.size)})`);
    const sources = sourcesOf(message);
    if (sources.length > 0) {
      parts.push(options.sourcesRowCap !== undefined ? sourcesRow(sources, options.sourcesRowCap) : ["**Sources**", ...sources.map((source) => `- ${sourceLine(source)}`)].join(`
`));
    }
    if (message.status === "interrupted")
      parts.push(`_⚠ Interrupted${message.error ? `: ${message.error}` : ""}. Send "continue" to get the rest._`);
    if (message.status === "stopped")
      parts.push('_■ Stopped. Send "continue" to get the rest._');
    return parts.join(`

`);
  }
  function renderTranscript(chat, options = {}) {
    return chat.messages.map((message, i) => `${message.role === "user" && i > 0 ? `${TURN_BREAK}

` : ""}${renderMessage(message, options)}`).join(`

`);
  }
  function lastReply(chat) {
    for (let i = chat.messages.length - 1;i >= 0; i--)
      if (chat.messages[i].role === "assistant")
        return chat.messages[i];
    return null;
  }

  // src/core/sha256.ts
  var K = [
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ];
  function rotr(x, n) {
    return x >>> n | x << 32 - n;
  }
  function sha256Hex(bytes) {
    const length = bytes.length;
    const whole = length - length % 64;
    const tail = new Uint8Array(length - whole + 9 + 63 >> 6 << 6);
    tail.set(bytes.subarray(whole));
    tail[length - whole] = 128;
    const tailView = new DataView(tail.buffer);
    tailView.setUint32(tail.length - 8, Math.floor(length / 536870912));
    tailView.setUint32(tail.length - 4, length << 3 >>> 0);
    const h = [1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225];
    const w = new Array(64);
    const input = new DataView(bytes.buffer, bytes.byteOffset, whole);
    const blocks = whole / 64 + tail.length / 64;
    for (let block = 0;block < blocks; block++) {
      const inTail = block * 64 >= whole;
      const view = inTail ? tailView : input;
      const offset = inTail ? block * 64 - whole : block * 64;
      for (let i = 0;i < 16; i++)
        w[i] = view.getUint32(offset + i * 4);
      for (let i = 16;i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ w[i - 15] >>> 3;
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ w[i - 2] >>> 10;
        w[i] = w[i - 16] + s0 + w[i - 7] + s1 | 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0;i < 64; i++) {
        const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = e & f ^ ~e & g;
        const t1 = hh + s1 + ch + K[i] + w[i] | 0;
        const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = a & b ^ a & c ^ b & c;
        const t2 = s0 + maj | 0;
        hh = g;
        g = f;
        f = e;
        e = d + t1 | 0;
        d = c;
        c = b;
        b = a;
        a = t1 + t2 | 0;
      }
      h[0] = h[0] + a | 0;
      h[1] = h[1] + b | 0;
      h[2] = h[2] + c | 0;
      h[3] = h[3] + d | 0;
      h[4] = h[4] + e | 0;
      h[5] = h[5] + f | 0;
      h[6] = h[6] + g | 0;
      h[7] = h[7] + hh | 0;
    }
    return h.map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
  }

  // src/core/ids.ts
  function newId(host) {
    return host.nowMs().toString(36).padStart(9, "0") + host.randomId().slice(0, 7);
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
  var attachmentsDir = (host, id) => `${chatDir(host, id)}/attachments`;
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
  function setTitleIfAuto(host, id, title) {
    return mutateChat(host, id, (chat) => {
      if (chat.titleSource === "manual")
        return false;
      chat.title = title;
    });
  }
  function setTitleManual(host, id, title) {
    return mutateChat(host, id, (chat) => {
      chat.title = title;
      chat.titleSource = "manual";
    });
  }

  // src/store/attach.ts
  function downscaled(host, config, path, classified) {
    if (classified.kind !== "image" || classified.ext !== "png" && classified.ext !== "jpg")
      return null;
    let probe;
    try {
      probe = host.runSync(["/usr/bin/sips", "-g", "pixelWidth", "-g", "pixelHeight", path], { timeoutMs: 15000 });
    } catch {
      return null;
    }
    if (probe.exit !== 0)
      return null;
    const width = Number(/pixelWidth:\s*(\d+)/.exec(probe.stdout)?.[1] ?? 0);
    const height = Number(/pixelHeight:\s*(\d+)/.exec(probe.stdout)?.[1] ?? 0);
    if (Math.max(width, height) <= config.imageMaxEdge)
      return null;
    host.mkdirp(cacheDir(host));
    const temp = `${cacheDir(host)}/resize-${host.randomId()}.${classified.ext}`;
    try {
      const result = host.runSync(["/usr/bin/sips", "-Z", String(config.imageMaxEdge), path, "--out", temp], { timeoutMs: 30000 });
      if (result.exit === 0 && host.exists(temp))
        return { bytes: host.readBytesFrom(temp, 0), temp };
    } catch {}
    host.remove(temp);
    return null;
  }
  function snapshot(host, chatId, source) {
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
      if (source.temp !== undefined)
        host.remove(source.temp);
    }
    return {
      name: source.name,
      kind: source.classified.kind === "unknown" ? "text" : source.classified.kind,
      mime: source.classified.mime,
      size: source.bytes.length,
      sha,
      file
    };
  }
  function prepareOne(host, config, path) {
    const name = baseName(path);
    const info = host.stat(path);
    if (!info)
      return `${name}: the file does not exist`;
    if (info.isDirectory)
      return `${name}: folders cannot be attached`;
    if (info.size > MAX_FILE_BYTES)
      return `${name}: ${megabytes(info.size)} is over the 20 MB per-file cap`;
    const classified = classifyName(name);
    const bytes = host.readBytesFrom(path, 0);
    if (classified.kind === "unknown") {
      if (bytes.length > config.textAttachmentMaxKb * 1024)
        return `${name}: text files are limited to ${config.textAttachmentMaxKb} KB`;
      if (!looksLikeText(bytes))
        return `${name}: this file type cannot be read; attach images, PDFs, or text files`;
      return { name, bytes, classified: { kind: "unknown", ext: classified.ext, mime: "text/plain" } };
    }
    const smaller = downscaled(host, config, path, classified);
    return smaller ? { name, bytes: smaller.bytes, classified, temp: smaller.temp } : { name, bytes, classified };
  }
  function attachPaths(host, config, chatId, paths) {
    const result = { added: [], errors: [] };
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
        for (const ref of result.added)
          if (!chat.pending.some((p) => p.sha === ref.sha && p.name === ref.name))
            chat.pending.push(ref);
      });
    }
    return result;
  }
  function attachBytes(host, config, chatId, name, bytes) {
    const classified = classifyName(name);
    if (classified.kind !== "image")
      return { added: [], errors: [`${name}: only images can be pasted`] };
    if (bytes.length > MAX_FILE_BYTES)
      return { added: [], errors: [`${name}: ${megabytes(bytes.length)} is over the 20 MB per-file cap`] };
    const ref = snapshot(host, chatId, { name, bytes, classified });
    let pending = 0;
    mutateChat(host, chatId, (chat) => {
      pending = chat.pending.length;
      if (pending >= MAX_PENDING)
        return false;
      chat.pending.push(ref);
    });
    return pending >= MAX_PENDING ? { added: [], errors: [`${name}: a message can carry ${MAX_PENDING} files`] } : { added: [ref], errors: [] };
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
      case 63:
      case 153:
        return {
          title: "Reply too large",
          detail: "OpenRouter sent more data than the workflow accepts for one reply.",
          next: "Ask for a shorter answer or fewer images, then use /retry."
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

  // src/store/catalog.ts
  var CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  var RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
  var STUCK_REFRESH_MS = 2 * 60 * 1000;
  var cacheFile = (host) => `${cacheDir(host)}/models.json`;
  var transportDir = (host) => `${cacheDir(host)}/catalog`;
  var part = (host) => `${transportDir(host)}/models.part`;
  var files = (host) => ({
    pid: `${transportDir(host)}/models.pid`,
    exit: `${transportDir(host)}/models.exit`,
    stderr: `${transportDir(host)}/models.stderr`,
    headers: `${transportDir(host)}/models.headers`
  });
  var failedAt = (host) => `${transportDir(host)}/failed-at`;
  var startedAt = (host) => `${transportDir(host)}/started-at`;
  function curlArgs(host, extra) {
    const url = `${apiBase(host.env)}/models?output_modalities=all`;
    return [
      curlBinary(host.env),
      ...curlProtocolArgs(url),
      "-o",
      part(host),
      "-D",
      files(host).headers,
      "--silent",
      "--show-error",
      "--connect-timeout",
      "10",
      "--max-filesize",
      String(MAX_RESPONSE_BYTES),
      ...extra,
      url
    ];
  }
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
  function readTrimmed(host, path) {
    try {
      return host.readText(path).trim();
    } catch {
      return null;
    }
  }
  function clearTransport(host) {
    const f = files(host);
    for (const path of [part(host), f.pid, f.exit, f.stderr, f.headers, startedAt(host)])
      host.remove(path);
  }
  function installDownload(host, curlExit) {
    if (curlExit !== 0)
      return { ok: false, reason: mapCurlExit(curlExit).title };
    const status = lastStatus(readTrimmed(host, files(host).headers) ?? "");
    if (!status || status.status !== 200)
      return { ok: false, reason: `HTTP ${status ? status.status : "?"}` };
    if ((host.stat(part(host))?.size ?? 0) > MAX_RESPONSE_BYTES)
      return { ok: false, reason: mapCurlExit(63).title };
    let body;
    try {
      body = JSON.parse(host.readText(part(host)));
    } catch {
      return { ok: false, reason: "unreadable list" };
    }
    const data = typeof body === "object" && body !== null ? body.data : undefined;
    if (!Array.isArray(data))
      return { ok: false, reason: "unexpected list" };
    const models = data.map(normalizeModel).filter((model) => model !== null);
    host.writeAtomic(cacheFile(host), JSON.stringify({ fetchedAt: host.nowMs(), models }));
    return { ok: true };
  }
  function refreshInFlight(host) {
    if (host.exists(files(host).exit))
      return false;
    const started = Number(readTrimmed(host, startedAt(host)));
    if (!Number.isFinite(started) || started <= 0)
      return false;
    if (host.nowMs() - started > STUCK_REFRESH_MS) {
      clearTransport(host);
      return false;
    }
    return true;
  }
  function ensureCatalog(host) {
    host.mkdirp(transportDir(host));
    const f = files(host);
    let note = null;
    const finished = readTrimmed(host, f.exit);
    if (finished !== null) {
      const result = installDownload(host, Number(finished));
      clearTransport(host);
      if (!result.ok) {
        note = `Model list refresh failed (${result.reason}); showing the saved list`;
        host.writeAtomic(failedAt(host), String(host.nowMs()));
      } else {
        host.remove(failedAt(host));
      }
    }
    let cache = loadCatalog(host);
    if (!cache) {
      clearTransport(host);
      const run = host.runSync(curlArgs(host, ["--max-time", "10"]), { timeoutMs: 15000, maxBytes: MAX_RESPONSE_BYTES });
      const result = installDownload(host, run.exit);
      clearTransport(host);
      if (!result.ok)
        return { models: [], note: `Could not load the model list (${result.reason})`, refreshing: false };
      cache = loadCatalog(host);
      return { models: cache ? cache.models : [], note: null, refreshing: false };
    }
    let refreshing = refreshInFlight(host);
    if (!refreshing && host.nowMs() - cache.fetchedAt > CATALOG_MAX_AGE_MS) {
      const failed = Number(readTrimmed(host, failedAt(host)) ?? 0);
      if (host.nowMs() - failed > RETRY_AFTER_FAILURE_MS) {
        clearTransport(host);
        host.writeAtomic(startedAt(host), String(host.nowMs()));
        host.spawnSupervised(curlArgs(host, ["--max-time", "60"]), { pid: f.pid, exit: f.exit, stderr: f.stderr, maxBytes: MAX_RESPONSE_BYTES });
        refreshing = true;
      }
    }
    return { models: cache.models, note, refreshing };
  }
  function getModel(host, id) {
    const cache = loadCatalog(host);
    return cache ? cache.models.find((model) => model.id === id) ?? null : null;
  }

  // src/core/models-search.ts
  function parseQuery(query) {
    const parsed = { words: [], image: false, imagegen: false, file: false, free: false, reasoning: false };
    for (const token of query.toLowerCase().split(/\s+/)) {
      if (token === "")
        continue;
      if (token === "#image")
        parsed.image = true;
      else if (token === "#imagegen")
        parsed.imagegen = true;
      else if (token === "#file")
        parsed.file = true;
      else if (token === "#free")
        parsed.free = true;
      else if (token === "#reasoning")
        parsed.reasoning = true;
      else
        parsed.words.push(token);
    }
    return parsed;
  }
  function wordScore(model, word) {
    const id = model.id.toLowerCase();
    const name = model.name.toLowerCase();
    const slug = id.slice(id.indexOf("/") + 1);
    if (id === word || slug === word)
      return 100;
    if (id.startsWith(word))
      return 60;
    if (slug.startsWith(word) || name.startsWith(word))
      return 50;
    if (name.split(/[\s:/()-]+/).some((part) => part.startsWith(word)) || slug.split(/[-_.:/]/).some((part) => part.startsWith(word)))
      return 30;
    if (id.includes(word) || name.includes(word))
      return 10;
    return 0;
  }
  function searchModels(models, query, options = {}) {
    const parsed = parseQuery(query);
    const favorites = options.favorites ?? [];
    const ranked = [];
    models.forEach((model, order) => {
      if (parsed.image && !acceptsImage(model))
        return;
      if (parsed.imagegen && !producesImage(model))
        return;
      if (parsed.file && !acceptsFile(model))
        return;
      if (parsed.free && !isFree(model))
        return;
      if (parsed.reasoning && !supportsReasoning(model))
        return;
      let score = 0;
      for (const word of parsed.words) {
        const wordRank = wordScore(model, word);
        if (wordRank === 0)
          return;
        score += wordRank;
      }
      ranked.push({ model, score, order });
    });
    ranked.sort((a, b) => {
      const fa = favorites.indexOf(a.model.id);
      const fb = favorites.indexOf(b.model.id);
      if (fa >= 0 !== fb >= 0)
        return fa >= 0 ? -1 : 1;
      if (fa >= 0 && fb >= 0 && fa !== fb)
        return fa - fb;
      return b.score - a.score || a.order - b.order;
    });
    const found = ranked.map((entry) => entry.model);
    return options.limit === undefined ? found : found.slice(0, options.limit);
  }
  function formatPrice(perMillionTokens) {
    if (perMillionTokens === 0)
      return "$0";
    if (perMillionTokens >= 1)
      return `$${Number(perMillionTokens.toFixed(2))}`;
    return `$${Number(perMillionTokens.toPrecision(2))}`;
  }
  function formatContext(tokens) {
    if (tokens >= 1e6)
      return `${Number((tokens / 1e6).toFixed(1))}M`;
    if (tokens >= 1000)
      return `${Math.round(tokens / 1000)}k`;
    return String(tokens);
  }
  function badges(model) {
    const list = [];
    if (acceptsImage(model))
      list.push("\uD83D\uDDBC");
    if (producesImage(model))
      list.push("\uD83C\uDFA8");
    if (acceptsFile(model))
      list.push("\uD83D\uDCC4");
    if (supportsReasoning(model))
      list.push("\uD83E\uDDE0");
    if (isFree(model))
      list.push("\uD83C\uDD93");
    return list.join(" ");
  }
  function formatSubtitle(model) {
    const parts = [];
    const marks = badges(model);
    if (marks !== "")
      parts.push(marks);
    if (isFree(model))
      parts.push("free");
    else if (pricedPerUse(model))
      parts.push(producesImage(model) ? "priced per image" : "priced per use");
    else if (model.completionPrice === 0 && !model.outputModalities.includes("text"))
      parts.push(`${formatPrice(perMillion(model.promptPrice))} in per 1M tokens`);
    else
      parts.push(`${formatPrice(perMillion(model.promptPrice))} in · ${formatPrice(perMillion(model.completionPrice))} out per 1M tokens`);
    if (model.contextLength > 0)
      parts.push(`${formatContext(model.contextLength)} context`);
    return parts.join(" · ");
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
  function mutateSettings(host, fn) {
    host.mkdirp(dataDir(host));
    return withLock(host, `${dataDir(host)}/settings.lock`, () => {
      const settings = getSettings(host);
      fn(settings);
      host.writeAtomic(path(host), JSON.stringify(settings, null, 2));
      return settings;
    });
  }
  function setLastModel(host, id) {
    return mutateSettings(host, (settings) => {
      settings.lastModel = id;
    });
  }

  // src/features/model.ts
  function chatNeeds(chat, pdfEngine) {
    const needs = { image: false, file: false };
    if (!chat)
      return needs;
    const engine = chat.settings.pdfEngine ?? pdfEngine;
    for (const ref of [...chat.messages.flatMap((message) => message.attachments), ...chat.pending]) {
      if (ref.kind === "image")
        needs.image = true;
      if (ref.kind === "file" && engine === "native")
        needs.file = true;
    }
    return needs;
  }
  function modelCovers(model, needs) {
    return (!needs.image || acceptsImage(model)) && (!needs.file || acceptsFile(model));
  }
  function setModel(ctx, models, id, record) {
    const needs = chatNeeds(ctx.chat, ctx.config.pdfEngine);
    let suffix = "";
    if (record && !modelCovers(record, needs)) {
      const fallbackId = ctx.config.visionFallbackModel;
      const fallback = fallbackId === "" ? null : models.find((model) => model.id === fallbackId) ?? null;
      if (!fallback || !modelCovers(fallback, needs)) {
        const what = needs.image && needs.file ? "images and PDFs" : needs.image ? "images" : "PDFs";
        return `**${record.name}** cannot read the ${what} already in this chat, and no vision fallback model is set. The model was not changed. Start a \`/new\` chat or pick a model that accepts ${what}.`;
      }
      suffix = ` Requests that include ${needs.image ? "images" : "PDFs"} will use ${fallback.name} instead.`;
    }
    const chat = ctx.ensureChat();
    mutateChat(ctx.host, chat.id, (current) => {
      current.model = id;
    });
    setLastModel(ctx.host, id);
    return `Chat model: **${record?.name ?? id}** (\`${id}\`).${suffix}`;
  }
  var model = {
    usage: "/model [query | id | default]",
    help: "Show or change this chat's model; a query lists matches",
    run(ctx, args) {
      const catalog = ensureCatalog(ctx.host);
      const settings = getSettings(ctx.host);
      const defaultId = settings.defaultModel ?? ctx.config.defaultModel;
      if (args === "") {
        const current = ctx.chat?.model;
        return { kind: "notice", text: current ? `Chat model: \`${current}\`. Default: \`${defaultId}\`.` : `Chat model: the default, \`${defaultId}\`.` };
      }
      if (args.toLowerCase() === "default") {
        const chat = ctx.ensureChat();
        mutateChat(ctx.host, chat.id, (current) => {
          current.model = null;
        });
        return { kind: "notice", text: `This chat now uses the default model, \`${defaultId}\`.` };
      }
      const exact = catalog.models.find((m) => m.id.toLowerCase() === args.toLowerCase());
      if (exact)
        return { kind: "notice", text: setModel(ctx, catalog.models, exact.id, exact) };
      if (catalog.models.length === 0 && /^[^\s/]+\/[^\s]+$/.test(args)) {
        return { kind: "notice", text: setModel(ctx, catalog.models, args, null) };
      }
      const matches = searchModels(catalog.models, args, { favorites: settings.favorites, limit: 8 });
      if (matches.length === 0) {
        return { kind: "notice", text: `No model matches \`${args}\`.${catalog.note ? ` ${catalog.note}.` : ""} Try the \`aimodels\` keyword to browse.` };
      }
      const lines = matches.map((m) => `- \`${m.id}\` — ${m.name} · ${formatSubtitle(m)}`);
      return { kind: "notice", text: [`**Models matching \`${args}\`**`, ...lines, "", "Use `/model <id>` to pick one."].join(`
`) };
    }
  };
  var feature = { commands: { model } };

  // src/features/attachments.ts
  var PDF_ENGINES = ["auto", "free", "ocr", "native"];
  function attributeText(name) {
    return name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function withAttachments(ctx, turn, refs, needs) {
    const parts = [];
    let content = turn.content;
    for (const ref of refs) {
      const path = `${chatDir(ctx.host, ctx.chat.id)}/${ref.file}`;
      if (!ctx.host.exists(path))
        return `The attachment **${ref.name}** is missing from this chat's saved files (${ref.file}), so nothing was sent. Remove it with \`/detach\` or attach it again.`;
      if (ref.kind === "text") {
        content += `

<attached_file name="${attributeText(ref.name)}">
${decodeUtf8(ctx.host.readBytesFrom(path, 0))}
</attached_file>`;
      } else {
        if (ref.kind === "image")
          needs.image = true;
        else if (ctx.options.pdfEngine === "native")
          needs.file = true;
        parts.push({ kind: ref.kind, name: ref.name, mime: ref.mime, base64: ctx.host.readBase64(path) });
      }
    }
    return { ...turn, content, ...parts.length > 0 ? { attachments: parts } : {} };
  }
  function payloadOptions(ctx) {
    const offset = ctx.turns[0]?.role === "system" ? 1 : 0;
    const turns = ctx.turns.slice();
    const needs = { image: false, file: false };
    for (let i = 0;i < ctx.window.length; i++) {
      const refs = ctx.window[i].attachments;
      if (refs.length === 0)
        continue;
      const built = withAttachments(ctx, turns[offset + i], refs, needs);
      if (typeof built === "string")
        return { refuse: built };
      turns[offset + i] = built;
    }
    if (ctx.draft.attachments.length > 0) {
      const last = turns.length - 1;
      const built = withAttachments(ctx, turns[last], ctx.draft.attachments, needs);
      if (typeof built === "string")
        return { refuse: built };
      turns[last] = built;
    }
    if (!needs.image && !needs.file)
      return { turns };
    if (!ctx.model || modelCovers(ctx.model, needs))
      return { turns };
    const fallback = ctx.config.visionFallbackModel === "" ? null : getModel(ctx.host, ctx.config.visionFallbackModel);
    const what = needs.image && needs.file ? "images and PDFs" : needs.image ? "images" : "PDFs";
    if (fallback && modelCovers(fallback, needs)) {
      return { turns, options: { modelId: fallback.id, model: fallback }, notes: [`${what} sent to ${fallback.id}`] };
    }
    return {
      refuse: `**${ctx.model.name}** cannot read the ${what} in this message or chat, and no vision fallback model is set. Nothing was sent and your text is still in the input. Switch with \`/model\`, set a vision fallback model in Configuration, or start a \`/new\` chat.`
    };
  }
  function summarize(result) {
    const lines = [];
    if (result.added.length > 0)
      lines.push(`Attached: ${result.added.map((ref) => `${ref.name} (${formatSize(ref.size)})`).join(", ")}. They go with your next message.`);
    for (const error of result.errors)
      lines.push(`⚠ ${error}`);
    return lines.length > 0 ? lines.join(`

`) : "Nothing was attached.";
  }
  var attach = {
    usage: "/attach",
    help: "Choose files to send with your next message",
    run(ctx) {
      let picked;
      try {
        picked = ctx.host.chooseFiles({ prompt: "Choose files to attach", multiple: true });
      } catch {
        return { kind: "notice", text: "The file picker could not open. Use the **AI Chat: Ask about these files** Universal Action on the files in Alfred instead." };
      }
      if (picked.cancelled)
        return { kind: "notice", text: "No file was chosen." };
      const chat = ctx.ensureChat();
      return { kind: "notice", text: summarize(attachPaths(ctx.host, ctx.config, chat.id, picked.paths)) };
    }
  };
  var paste = {
    usage: "/paste",
    help: "Attach the image on the clipboard",
    run(ctx) {
      const bytes = ctx.host.clipboardPng();
      if (bytes === null)
        return { kind: "notice", text: "There is no image on the clipboard." };
      const chat = ctx.ensureChat();
      return { kind: "notice", text: summarize(attachBytes(ctx.host, ctx.config, chat.id, `clipboard-${ctx.host.nowMs()}.png`, bytes)) };
    }
  };
  var attachments = {
    usage: "/attachments",
    help: "List the files waiting to be sent",
    run(ctx) {
      const pending = ctx.chat?.pending ?? [];
      if (pending.length === 0)
        return { kind: "notice", text: "No files are waiting. Use `/attach`, `/paste`, or the **AI Chat: Ask about these files** action." };
      return { kind: "notice", text: ["**Waiting to be sent**", ...pending.map((ref, i) => `${i + 1}. ${ref.name} (${formatSize(ref.size)})`), "", "Remove one with `/detach <number>`."].join(`
`) };
    }
  };
  var detach = {
    usage: "/detach <number>",
    help: "Remove a waiting file",
    run(ctx, args) {
      const pending = ctx.chat?.pending ?? [];
      const index = Number(args) - 1;
      if (!ctx.chat || !Number.isInteger(index) || index < 0 || index >= pending.length) {
        return { kind: "notice", text: pending.length === 0 ? "No files are waiting." : `Give a number from 1 to ${pending.length}. See \`/attachments\`.` };
      }
      const removed = pending[index];
      mutateChat(ctx.host, ctx.chat.id, (chat) => {
        chat.pending.splice(index, 1);
      });
      return { kind: "notice", text: `Removed ${removed.name}.` };
    }
  };
  var pdf = {
    usage: "/pdf [auto | free | ocr | native]",
    help: "Choose how PDFs are read",
    run(ctx, args) {
      const engine = args.toLowerCase();
      if (engine === "") {
        const current = ctx.chat?.settings.pdfEngine ?? ctx.config.pdfEngine;
        return { kind: "notice", text: `PDF engine: **${current}**. Choose with \`/pdf ${PDF_ENGINES.join("|")}\`. \`auto\` sends the PDF to models that read files and uses the free parser otherwise; \`ocr\` uses Mistral OCR, which OpenRouter bills per page.` };
      }
      if (PDF_ENGINES.indexOf(engine) < 0)
        return { kind: "notice", text: `Unknown PDF engine \`${args}\`. Use ${PDF_ENGINES.map((e) => `\`${e}\``).join(", ")}.` };
      const chat = ctx.ensureChat();
      mutateChat(ctx.host, chat.id, (current) => {
        current.settings.pdfEngine = engine;
      });
      return { kind: "notice", text: `PDF engine for this chat: **${engine}**${engine === "ocr" ? " (billed per page by OpenRouter)" : ""}.` };
    }
  };
  var feature2 = {
    commands: { attach, paste, attachments, detach, pdf },
    payloadOptions,
    validateBody(_ctx, body) {
      return body.length > MAX_BODY_BYTES ? `The message with its files is ${megabytes(body.length)} once encoded, over the ${megabytes(MAX_BODY_BYTES).replace(".0", "")} limit. Nothing was sent; detach a file with \`/detach\`.` : null;
    },
    footerFlags(ctx) {
      const flags = [];
      const notice = ctx.host.env.attach_notice;
      if (notice)
        flags.push(`⚠ ${notice}`);
      if ((ctx.chat?.settings.pdfEngine ?? ctx.config.pdfEngine) === "ocr")
        flags.push("pdf ocr");
      const pending = ctx.chat?.pending ?? [];
      if (pending.length > 0)
        flags.push(`\uD83D\uDCCE ${pending.length} waiting (${formatSize(pending.reduce((sum, ref) => sum + ref.size, 0))})`);
      return flags;
    }
  };

  // src/core/titles.ts
  var MAX_WORDS = 6;
  function cleanTitle(reply) {
    const firstLine = reply.split(`
`).find((line) => line.trim() !== "") ?? "";
    const stripped = firstLine.replace(/^#+\s*/, "").replace(/^(title:\s*)/i, "").replace(/^["'“”‘’`*_]+|["'“”‘’`*_]+$/g, "").trim();
    const words = stripped.split(/\s+/).filter((word) => word !== "");
    return words.slice(0, MAX_WORDS).join(" ").replace(/[.,;:!?…]+$/, "");
  }
  var TITLE_PROMPT = "Write a title of at most six words for the conversation below. Reply with only the title: no quotes, no trailing punctuation.";
  function fileSafe(title) {
    const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    return cleaned === "" ? "Chat" : cleaned;
  }

  // src/core/base64.ts
  var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var PAD = 61;
  var CHUNK = 8190;
  var CODES = Uint8Array.from(ALPHABET, (c) => c.charCodeAt(0));
  var LOOKUP = (() => {
    const table = new Int8Array(128).fill(-1);
    for (let i = 0;i < ALPHABET.length; i++)
      table[ALPHABET.charCodeAt(i)] = i;
    return table;
  })();
  function ascii(codes) {
    const parts = [];
    for (let i = 0;i < codes.length; i += CHUNK)
      parts.push(String.fromCharCode.apply(null, codes.subarray(i, i + CHUNK)));
    return parts.join("");
  }
  function encodeBase64(bytes) {
    const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
    let o = 0;
    let i = 0;
    for (;i + 2 < bytes.length; i += 3) {
      const chunk = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
      out[o++] = CODES[chunk >> 18 & 63];
      out[o++] = CODES[chunk >> 12 & 63];
      out[o++] = CODES[chunk >> 6 & 63];
      out[o++] = CODES[chunk & 63];
    }
    const rest = bytes.length - i;
    if (rest > 0) {
      const chunk = bytes[i] << 16 | (rest > 1 ? bytes[i + 1] << 8 : 0);
      out[o++] = CODES[chunk >> 18 & 63];
      out[o++] = CODES[chunk >> 12 & 63];
      out[o++] = rest > 1 ? CODES[chunk >> 6 & 63] : PAD;
      out[o++] = PAD;
    }
    return ascii(out);
  }
  function decodeBase64(text) {
    const symbols = new Uint8Array(text.length);
    let n = 0;
    for (let i = 0;i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === PAD)
        break;
      if (code === 10 || code === 13 || code === 32 || code === 9)
        continue;
      const value = code < 128 ? LOOKUP[code] : -1;
      if (value < 0)
        throw new Error(`invalid base64 character at ${i}`);
      symbols[n++] = value;
    }
    if (n % 4 === 1)
      throw new Error("invalid base64 length");
    const out = new Uint8Array(Math.floor(n * 3 / 4));
    let o = 0;
    for (let i = 0;i < n; i += 4) {
      const chunk = symbols[i] << 18 | symbols[i + 1] << 12 | (i + 2 < n ? symbols[i + 2] : 0) << 6 | (i + 3 < n ? symbols[i + 3] : 0);
      if (o < out.length)
        out[o++] = chunk >> 16 & 255;
      if (o < out.length)
        out[o++] = chunk >> 8 & 255;
      if (o < out.length)
        out[o++] = chunk & 255;
    }
    return out;
  }

  // src/store/images.ts
  var XATTR_FIELD = "com.apple.metadata:kMDItemDescription";

  class ImageSaveError extends Error {
  }
  function imagesFolder(host, config) {
    const home = host.env.HOME ?? "";
    const folder = config.imagesFolder;
    return (folder === "~" ? home : folder.startsWith("~/") ? `${home}${folder.slice(1)}` : folder).replace(/\/+$/, "");
  }
  function decodeAll(bodyText) {
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new ImageSaveError("The response was not valid JSON.");
    }
    if (!Array.isArray(parsed.data) || parsed.data.length === 0)
      throw new ImageSaveError("The response held no image.");
    return parsed.data.map((item) => {
      if (typeof item?.b64_json !== "string" || item.b64_json === "")
        throw new ImageSaveError("The response held an image without data.");
      let bytes;
      try {
        bytes = decodeBase64(item.b64_json);
      } catch {
        throw new ImageSaveError("An image in the response could not be decoded.");
      }
      return { bytes, ext: imageExtension(typeof item.media_type === "string" ? item.media_type : null, bytes) };
    });
  }
  function stamp(ms) {
    return new Date(ms).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  }
  function saveImages(host, config, bodyText, prompt) {
    const images = decodeAll(bodyText);
    const folder = imagesFolder(host, config);
    host.mkdirp(folder);
    const saved = [];
    try {
      for (const image of images) {
        const name = `${stamp(host.nowMs())}-${host.randomId().slice(0, 6)}.${image.ext}`;
        const temp = `${folder}/.${name}.tmp`;
        host.writeAtomic(temp, image.bytes);
        host.move(temp, `${folder}/${name}`);
        saved.push(`${folder}/${name}`);
        if (config.savePrompts) {
          try {
            host.runSync(["/usr/bin/xattr", "-w", XATTR_FIELD, xattrPlist(prompt), `${folder}/${name}`], { timeoutMs: 1e4 });
          } catch {}
        }
      }
    } catch (error) {
      for (const path of saved)
        host.remove(path);
      throw error;
    }
    return saved;
  }
  function promptOf(host, path) {
    try {
      const result = host.runSync(["/usr/bin/xattr", "-p", XATTR_FIELD, path], { timeoutMs: 5000 });
      return result.exit === 0 ? promptFromXattr(result.stdout) : null;
    } catch {
      return null;
    }
  }
  function listImages(host, config, limit) {
    const folder = imagesFolder(host, config);
    if (!host.exists(folder)) {
      forgetPromptCache(host);
      return [];
    }
    const found = [];
    for (const name of host.listDir(folder)) {
      const dot = name.lastIndexOf(".");
      if (name.charAt(0) === "." || dot < 0 || IMAGE_EXTENSIONS.indexOf(name.slice(dot + 1).toLowerCase()) < 0)
        continue;
      const info = host.stat(`${folder}/${name}`);
      if (info && !info.isDirectory)
        found.push({ path: `${folder}/${name}`, prompt: "", mtimeMs: info.mtimeMs });
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? 1 : -1));
    const newest = found.slice(0, limit);
    const cached = loadPromptCache(host);
    const fresh = {};
    for (const image of newest) {
      const changedMs = host.changedMs(image.path);
      const hit = cached[image.path];
      if (changedMs !== null && hit && hit.changedMs === changedMs && typeof hit.prompt === "string") {
        image.prompt = hit.prompt;
        fresh[image.path] = hit;
        continue;
      }
      const prompt = promptOf(host, image.path);
      image.prompt = prompt ?? "";
      if (prompt !== null && changedMs !== null)
        fresh[image.path] = { changedMs, prompt };
    }
    if (JSON.stringify(fresh) !== JSON.stringify(cached))
      savePromptCache(host, fresh);
    return newest;
  }
  function forgetPromptCache(host) {
    try {
      host.remove(promptCacheFile(host));
    } catch {}
  }
  var promptCacheFile = (host) => `${cacheDir(host)}/image-prompts.json`;
  function loadPromptCache(host) {
    try {
      const parsed = JSON.parse(host.readText(promptCacheFile(host)));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  function savePromptCache(host, cache) {
    try {
      host.mkdirp(cacheDir(host));
      host.writeAtomic(promptCacheFile(host), JSON.stringify(cache));
    } catch {}
  }
  function newestImage(host, config) {
    const folder = imagesFolder(host, config);
    if (!host.exists(folder))
      return null;
    let best = null;
    for (const name of host.listDir(folder)) {
      const dot = name.lastIndexOf(".");
      if (name.charAt(0) === "." || dot < 0 || IMAGE_EXTENSIONS.indexOf(name.slice(dot + 1).toLowerCase()) < 0)
        continue;
      const info = host.stat(`${folder}/${name}`);
      if (info && !info.isDirectory && (best === null || info.mtimeMs > best.mtimeMs || info.mtimeMs === best.mtimeMs && `${folder}/${name}` > best.path))
        best = { path: `${folder}/${name}`, mtimeMs: info.mtimeMs };
    }
    return best ? best.path : null;
  }

  // src/core/sse.ts
  function newFramer() {
    return { line: "", pendingCr: false, data: [] };
  }
  var LF = 10;
  var CR = 13;
  var COLON = 58;
  var SPACE = 32;
  var CHUNK2 = 8190;
  function byteString(bytes) {
    let text = "";
    for (let i = 0;i < bytes.length; i += CHUNK2)
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK2));
    return text;
  }
  function lineBytes(state, rest) {
    const kept = state.line;
    if (kept.length === 0)
      return rest;
    const out = new Uint8Array(kept.length + rest.length);
    if (typeof kept === "string")
      for (let i = 0;i < kept.length; i++)
        out[i] = kept.charCodeAt(i);
    else
      out.set(kept);
    out.set(rest, kept.length);
    return out;
  }
  function endLine(state, bytes, events) {
    state.line = "";
    if (bytes.length === 0) {
      if (state.data.length > 0) {
        events.push({ type: "data", data: state.data.join(`
`) });
        state.data = [];
      }
      return;
    }
    if (bytes[0] === COLON) {
      events.push({ type: "keepalive" });
      return;
    }
    const text = decodeUtf8(bytes);
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    if (field !== "data")
      return;
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.charCodeAt(0) === SPACE)
      value = value.slice(1);
    state.data.push(value);
  }
  function feed(state, bytes) {
    const events = [];
    let start = 0;
    for (let i = 0;i < bytes.length; i++) {
      const byte = bytes[i];
      if (state.pendingCr) {
        state.pendingCr = false;
        if (byte === LF) {
          start = i + 1;
          continue;
        }
      }
      if (byte === LF || byte === CR) {
        endLine(state, lineBytes(state, bytes.subarray(start, i)), events);
        state.pendingCr = byte === CR;
        start = i + 1;
      }
    }
    if (start < bytes.length)
      state.line = byteString(lineBytes(state, bytes.subarray(start)));
    return events;
  }

  // src/core/stream.ts
  function newStreamState() {
    return {
      phase: "connecting",
      content: "",
      reasoning: "",
      annotations: [],
      finishReason: null,
      doneSeen: false,
      accountingSeen: false,
      error: null
    };
  }
  function isObject2(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function setError(state, error) {
    if (!state.error)
      state.error = error;
  }
  function annotationKey(annotation) {
    if (annotation.type === "url_citation") {
      const citation = isObject2(annotation.url_citation) ? annotation.url_citation : annotation;
      return `url:${String(citation.url ?? "")}`;
    }
    const file = isObject2(annotation.file) ? annotation.file : {};
    return `file:${String(file.hash ?? JSON.stringify(annotation))}`;
  }
  function addAnnotations(state, value) {
    if (!Array.isArray(value))
      return;
    for (const item of value) {
      if (!isObject2(item))
        continue;
      if (item.type !== "url_citation" && item.type !== "file")
        continue;
      const annotation = item;
      const key = annotationKey(annotation);
      if (!state.annotations.some((existing) => annotationKey(existing) === key))
        state.annotations.push(annotation);
    }
  }
  function reasoningText(delta) {
    if (typeof delta.reasoning === "string" && delta.reasoning !== "")
      return delta.reasoning;
    if (!Array.isArray(delta.reasoning_details))
      return "";
    let text = "";
    for (const detail of delta.reasoning_details) {
      if (!isObject2(detail))
        continue;
      if (detail.type === "reasoning.text" && typeof detail.text === "string")
        text += detail.text;
      else if (detail.type === "reasoning.summary" && typeof detail.summary === "string")
        text += detail.summary;
    }
    return text;
  }
  function errorFrom(value) {
    if (isObject2(value)) {
      const message = typeof value.message === "string" && value.message !== "" ? value.message : "The provider reported an error";
      const code = typeof value.code === "string" || typeof value.code === "number" ? String(value.code) : null;
      return { kind: "api", message, code };
    }
    return { kind: "api", message: typeof value === "string" && value !== "" ? value : "The provider reported an error", code: null };
  }
  function fold(state, event) {
    if (state.phase === "connecting")
      state.phase = "processing";
    if (event.type === "keepalive")
      return;
    const payload = event.data;
    if (payload.trim() === "[DONE]") {
      state.doneSeen = true;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      setError(state, { kind: "protocol", message: "The stream held an event that is not valid JSON", code: null });
      return;
    }
    if (!isObject2(parsed)) {
      setError(state, { kind: "protocol", message: "The stream held an event that is not a JSON object", code: null });
      return;
    }
    if (parsed.usage !== undefined && parsed.usage !== null)
      state.accountingSeen = true;
    if (parsed.error !== undefined && parsed.error !== null)
      setError(state, errorFrom(parsed.error));
    const choice = Array.isArray(parsed.choices) && isObject2(parsed.choices[0]) ? parsed.choices[0] : null;
    if (!choice)
      return;
    const delta = isObject2(choice.delta) ? choice.delta : isObject2(choice.message) ? choice.message : null;
    if (delta) {
      const reasoning = reasoningText(delta);
      if (reasoning !== "") {
        state.reasoning += reasoning;
        if (state.phase !== "answering")
          state.phase = "thinking";
      }
      if (typeof delta.content === "string" && delta.content !== "") {
        state.content += delta.content;
        state.phase = "answering";
      }
      addAnnotations(state, delta.annotations);
    }
    if (typeof choice.finish_reason === "string") {
      state.finishReason = choice.finish_reason;
      if (choice.finish_reason === "error")
        setError(state, errorFrom(parsed.error));
    }
  }
  function consume(framer, state, bytes) {
    const events = feed(framer, bytes);
    for (const event of events)
      fold(state, event);
    return events;
  }

  // src/store/requests.ts
  var FINALIZE_ATTEMPTS = 3;
  var PID_GRACE_MS = 3000;
  var NO_PID_YET_MS = 5000;
  var REFERER = "https://github.com/Sillybit-io/silly-alfred-aichat";
  var requestsDir = (host) => `${dataDir(host)}/requests`;
  var requestDir = (host, rid) => `${requestsDir(host)}/${rid}`;
  var lanesDir = (host) => `${dataDir(host)}/lanes`;
  var lanePointer = (host, lane) => `${lanesDir(host)}/${lane}`;
  var laneLock = (host, lane) => `${lanesDir(host)}/${lane}.lock`;
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
  function saveRecord(host, record) {
    host.writeAtomic(transport(host, record.id).record, JSON.stringify(record));
  }
  function laneRecordId(host, lane) {
    const text = readOptional(host, lanePointer(host, lane));
    return text === null || text.trim() === "" ? null : text.trim();
  }
  function currentRecord(host, lane) {
    const rid = laneRecordId(host, lane);
    return rid === null ? null : loadRecord(host, rid);
  }
  function ownedPid(host, record) {
    const files = transport(host, record.id);
    const text = readOptional(host, files.pid);
    const pid = Number(text?.trim());
    if (!Number.isInteger(pid) || pid <= 1)
      return null;
    const command = host.processCommand(pid);
    return command !== null && command.indexOf(files.out) >= 0 ? pid : null;
  }
  function transportEnded(host, record) {
    const files = transport(host, record.id);
    if (host.exists(files.exit))
      return true;
    const pidText = readOptional(host, files.pid);
    if (pidText === null)
      return host.nowMs() - record.startedAt > NO_PID_YET_MS;
    return host.nowMs() - Math.max(record.lastGrowthAt, record.startedAt) > PID_GRACE_MS && ownedPid(host, record) === null;
  }
  var responseLimit = (kind) => kind === "image" ? MAX_IMAGE_RESPONSE_BYTES : MAX_RESPONSE_BYTES;
  function responseText(host, record) {
    const files = transport(host, record.id);
    const info = host.stat(files.out);
    return info === null || info.size > responseLimit(record.kind) ? "" : readOptional(host, files.out) ?? "";
  }
  function curlArgs2(host, input, files) {
    const args = [curlBinary(host.env), ...curlProtocolArgs(input.url), "-o", files.out, "-D", files.headers, "--silent", "--show-error", "--connect-timeout", "15", "--max-filesize", String(responseLimit(input.kind))];
    if (input.stream)
      args.push("--no-buffer", "--speed-limit", "1", "--speed-time", String(input.timeoutSeconds));
    else
      args.push("--max-time", String(input.timeoutSeconds));
    args.push(...CURL_STDIN_CONFIG, "-H", "Content-Type: application/json", "-H", `HTTP-Referer: ${REFERER}`, "-H", "X-Title: Alfred AI Chat", "--data-binary", `@${files.body}`, input.url);
    return args;
  }
  function withLaneLock(host, lane, fn) {
    host.mkdirp(lanesDir(host));
    return withLock(host, laneLock(host, lane), fn);
  }
  function admit(host, input, finalizers = {}) {
    const authConfig = curlAuthConfig(input.apiKey);
    return withLaneLock(host, input.lane, () => {
      const existing = laneRecordId(host, input.lane);
      if (existing !== null) {
        const record = loadRecord(host, existing);
        if (record && !record.final) {
          if (record.state === "open" && !transportEnded(host, record))
            return { ok: false, reason: "busy", rid: existing };
          advanceUnlocked(host, existing, finalizers);
        } else {
          host.remove(lanePointer(host, input.lane));
          if (record)
            host.remove(requestDir(host, existing));
        }
      }
      host.mkdirp(requestsDir(host));
      const rid = newId(host);
      if (!host.mkdirExclusive(requestDir(host, rid)))
        throw new Error(`request ${rid} already exists`);
      const files = transport(host, rid);
      const now = host.nowMs();
      const record = {
        schema: 1,
        id: rid,
        lane: input.lane,
        kind: input.kind,
        chatId: input.chatId,
        model: input.model,
        draft: input.draft,
        stream: input.stream,
        timeoutSeconds: input.timeoutSeconds,
        startedAt: now,
        lastGrowthAt: now,
        offset: 0,
        framer: newFramer(),
        reducer: newStreamState(),
        state: "open",
        final: false,
        error: null,
        curlExit: null,
        httpStatus: null,
        finalizeAttempts: 0,
        meta: input.meta ?? {}
      };
      host.writeAtomic(files.body, input.body);
      saveRecord(host, record);
      host.writeAtomic(lanePointer(host, input.lane), rid);
      if (input.takePending && input.chatId !== null) {
        const taken = new Set(input.draft.attachments.map((ref) => ref.sha));
        try {
          mutateChat(host, input.chatId, (chat) => {
            chat.pending = chat.pending.filter((ref) => !taken.has(ref.sha));
          });
        } catch (error) {
          if (!(error instanceof NotFoundError))
            throw error;
        }
      }
      host.spawnSupervised(curlArgs2(host, input, files), { pid: files.pid, exit: files.exit, stderr: files.stderr, remove: files.body, maxBytes: responseLimit(input.kind) }, { stdin: authConfig });
      return { ok: true, rid };
    });
  }
  function stopTransport(host, record) {
    const pid = ownedPid(host, record);
    if (pid !== null)
      host.signalTerm(pid);
  }
  function hasImages(body) {
    try {
      const parsed = JSON.parse(body);
      return Array.isArray(parsed.data) && parsed.data.length > 0;
    } catch {
      return false;
    }
  }
  function failureFor(host, record, extra = {}) {
    const files = transport(host, record.id);
    const status = record.httpStatus;
    const body = status !== null && status >= 400 && host.exists(files.out) ? decodeUtf8(host.readBytesFrom(files.out, 0, 4000)) : "";
    if (extra.stalled) {
      return { title: "No data from OpenRouter", detail: `Nothing arrived for ${record.timeoutSeconds} seconds.`, next: "Use /retry, or pick another model with /model." };
    }
    return describeFailure({
      headers: readOptional(host, files.headers) ?? "",
      body,
      curlExit: record.curlExit,
      streamError: record.reducer.error,
      finishReason: record.reducer.finishReason
    });
  }
  function tickUnlocked(host, rid) {
    const record = loadRecord(host, rid);
    if (!record)
      return null;
    if (record.final || record.state !== "open")
      return { record, terminal: record.state !== "open" };
    const files = transport(host, rid);
    const now = host.nowMs();
    const limit = responseLimit(record.kind);
    let tooLarge = false;
    let changed = false;
    if (host.exists(files.out)) {
      const read = host.readBytesFrom(files.out, record.offset, limit - record.offset + 1);
      tooLarge = record.offset + read.length > limit;
      const bytes = tooLarge ? read.subarray(0, limit - record.offset) : read;
      if (read.length > 0) {
        record.lastGrowthAt = now;
        changed = true;
      }
      if (bytes.length > 0) {
        record.offset += bytes.length;
        if (record.stream)
          consume(record.framer, record.reducer, bytes);
      }
    }
    const headers = readOptional(host, files.headers);
    const status = headers === null ? record.httpStatus : lastStatus(headers)?.status ?? record.httpStatus;
    if (status !== record.httpStatus) {
      record.httpStatus = status;
      changed = true;
    }
    const exitText = readOptional(host, files.exit);
    if (exitText !== null && Number.isFinite(Number(exitText.trim())) && Number(exitText.trim()) !== record.curlExit) {
      record.curlExit = Number(exitText.trim());
      changed = true;
    }
    const reducer = record.reducer;
    const hasContent = reducer.content !== "";
    const httpFailed = record.httpStatus !== null && record.httpStatus >= 400;
    let state = "open";
    let stalled = false;
    if (host.exists(files.stop))
      state = "stopped";
    else if (tooLarge) {
      state = record.stream && hasContent ? "interrupted" : "failed";
      record.error = mapCurlExit(63);
    } else if (httpFailed && record.curlExit !== null)
      state = "failed";
    else if (record.stream && reducer.error)
      state = hasContent ? "interrupted" : "failed";
    else if (record.stream && reducer.doneSeen)
      state = "done";
    else if (record.curlExit !== null || transportEnded(host, record)) {
      if (record.stream) {
        state = hasContent ? "interrupted" : "failed";
      } else {
        state = record.curlExit === 0 && !httpFailed ? "done" : "failed";
        if (state === "done" && record.kind === "image" && !hasImages(responseText(host, record))) {
          state = "failed";
          record.error = { title: "No image returned", detail: "OpenRouter answered without an image.", next: "Try again, or choose another image model." };
        }
      }
    } else if (record.stream && now - record.lastGrowthAt > record.timeoutSeconds * 1000) {
      stalled = true;
      state = hasContent ? "interrupted" : "failed";
    } else if (!record.stream && now - record.startedAt > (record.timeoutSeconds + 15) * 1000) {
      stalled = true;
      state = "failed";
    }
    if (state !== "open") {
      if (state !== "done" && host.exists(files.pid) && record.curlExit === null)
        stopTransport(host, record);
      record.state = state;
      if ((state === "failed" || state === "interrupted") && !record.error)
        record.error = failureFor(host, record, { stalled });
      changed = true;
    }
    if (changed)
      saveRecord(host, record);
    return { record, terminal: state !== "open" };
  }
  function outcomeOf(host, record) {
    const state = record.state === "open" ? "failed" : record.state;
    const files = transport(host, record.id);
    return {
      state,
      content: record.reducer.content,
      reasoning: record.reducer.reasoning,
      annotations: record.reducer.annotations,
      finishReason: record.reducer.finishReason,
      error: record.error,
      httpStatus: record.httpStatus,
      bodyText: record.stream ? "" : responseText(host, record)
    };
  }
  function errorLine(error) {
    return error ? `${error.title}: ${error.detail}` : "";
  }
  function commitChat(host, record, outcome) {
    if (record.chatId === null)
      return false;
    let committed = false;
    try {
      mutateChat(host, record.chatId, (chat) => {
        if (chat.messages.some((message) => message.requestId === record.id))
          return false;
        const hasContent = outcome.content !== "";
        if (hasContent || outcome.state === "done") {
          const now = host.nowMs();
          chat.messages.push({
            id: `${record.id}-u`,
            requestId: record.id,
            role: "user",
            content: record.draft.text,
            attachments: record.draft.attachments,
            status: "ok",
            createdAt: now
          });
          chat.messages.push({
            id: `${record.id}-a`,
            requestId: record.id,
            role: "assistant",
            content: outcome.content,
            attachments: [],
            ...outcome.reasoning !== "" && chat.settings.showReasoning ? { reasoning: outcome.reasoning } : {},
            ...outcome.annotations.length > 0 ? { annotations: outcome.annotations } : {},
            status: outcome.state === "done" ? "ok" : outcome.state === "stopped" ? "stopped" : "interrupted",
            ...outcome.state === "interrupted" && outcome.error ? { error: errorLine(outcome.error) } : {},
            createdAt: now
          });
          if (chat.retry && record.meta.retryOf === chat.retry.requestId)
            chat.retry = null;
          committed = true;
        } else {
          chat.retry = {
            requestId: record.id,
            text: record.draft.text,
            attachments: record.draft.attachments,
            model: record.model,
            error: outcome.state === "stopped" ? "Stopped before the first token" : errorLine(outcome.error)
          };
        }
      });
    } catch (error) {
      if (!(error instanceof NotFoundError))
        throw error;
    }
    return committed;
  }
  function finalizeUnlocked(host, rid, finalizers) {
    const record = loadRecord(host, rid);
    if (!record) {
      return { finalized: false, committed: false, record: null, outcome: null };
    }
    if (record.state === "open")
      return { finalized: false, committed: false, record, outcome: null };
    const outcome = outcomeOf(host, record);
    let committed = false;
    if (!record.final) {
      if (record.kind === "chat") {
        committed = commitChat(host, record, outcome);
        if (committed && finalizers.chat) {
          try {
            finalizers.chat(host, record, outcome);
          } catch (error) {
            host.log(`after-commit hook failed for request ${record.id}: ${String(error)}`);
          }
        }
      } else {
        const finalizer = finalizers[record.kind];
        if (finalizer) {
          try {
            finalizer(host, record, outcome);
          } catch (error) {
            record.finalizeAttempts += 1;
            if (record.finalizeAttempts < FINALIZE_ATTEMPTS) {
              saveRecord(host, record);
              throw error;
            }
            host.log(`dropping ${record.kind} request ${record.id} after ${record.finalizeAttempts} failed finalizations: ${String(error)}`);
          }
        }
      }
      record.final = true;
      saveRecord(host, record);
    }
    if (laneRecordId(host, record.lane) === rid)
      host.remove(lanePointer(host, record.lane));
    host.remove(requestDir(host, rid));
    return { finalized: true, committed, record, outcome };
  }
  function advanceUnlocked(host, rid, finalizers) {
    const ticked = tickUnlocked(host, rid);
    if (!ticked || !ticked.terminal)
      return { finalized: false, committed: false, record: ticked?.record ?? null, outcome: null };
    return finalizeUnlocked(host, rid, finalizers);
  }
  function advance(host, rid, finalizers = {}) {
    const lane = loadRecord(host, rid)?.lane;
    if (lane === undefined)
      return { tick: null, finalize: null };
    return withLaneLock(host, lane, () => {
      const ticked = tickUnlocked(host, rid);
      if (!ticked || !ticked.terminal)
        return { tick: ticked, finalize: null };
      return { tick: ticked, finalize: finalizeUnlocked(host, rid, finalizers) };
    });
  }
  function finalizeDue(host, finalizers = {}, lane) {
    if (!host.exists(lanesDir(host)))
      return [];
    const lanes = lane !== undefined ? [lane] : host.listDir(lanesDir(host)).filter((name) => !name.endsWith(".lock") && name.indexOf(".tmp-") < 0);
    const done = [];
    for (const name of lanes) {
      const rid = laneRecordId(host, name);
      if (rid === null)
        continue;
      withLaneLock(host, name, () => {
        const record = loadRecord(host, rid);
        if (!record) {
          host.remove(lanePointer(host, name));
          return;
        }
        const files = transport(host, rid);
        if (record.final || host.exists(files.stop) || host.exists(files.exit) || record.state === "open" && transportEnded(host, record)) {
          if (advanceUnlocked(host, rid, finalizers).finalized)
            done.push(rid);
        }
      });
    }
    return done;
  }
  function stop(host, rid) {
    const record = loadRecord(host, rid);
    if (!record || record.final)
      return { sentinel: false, signalled: false };
    const files = transport(host, rid);
    try {
      host.writeAtomic(files.stop, String(host.nowMs()));
    } catch {
      return { sentinel: false, signalled: false };
    }
    const pid = ownedPid(host, record);
    return { sentinel: true, signalled: pid !== null ? host.signalTerm(pid) : false };
  }

  // src/features/history.ts
  var DEFAULT_TITLE = "New chat";
  var MAX_TITLE_ATTEMPTS_MESSAGES = 4;
  function clip2(text, length) {
    return text.length > length ? `${text.slice(0, length)}…` : text;
  }
  function expandHome(host, path) {
    const home = host.env.HOME ?? "";
    return path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
  }
  function displayTitle(chat) {
    if (chat.title !== DEFAULT_TITLE)
      return chat.title;
    const first = chat.messages.find((message) => message.role === "user")?.content ?? chat.retry?.text ?? "";
    const flat = first.replace(/\s+/g, " ").trim();
    return flat === "" ? DEFAULT_TITLE : clip2(flat, 60);
  }
  function requestTitle(host, config, chatId) {
    const chat = getChat(host, chatId);
    if (!chat || chat.titleSource !== "auto" || chat.title !== DEFAULT_TITLE || chat.messages.length === 0 || chat.messages.length > MAX_TITLE_ATTEMPTS_MESSAGES)
      return;
    const user = chat.messages.find((message) => message.role === "user");
    const assistant = chat.messages.find((message) => message.role === "assistant");
    if (!user || config.apiKey === "")
      return;
    const modelId = config.titleModel !== "" ? config.titleModel : config.defaultModel;
    const body = encodeBody(buildBody([
      { role: "system", content: TITLE_PROMPT },
      { role: "user", content: `User: ${clip2(user.content, 600)}

Assistant: ${clip2(assistant?.content ?? "", 600)}` }
    ], { modelId, model: null, stream: false, pdfEngine: "auto", web: false, privacy: config.privacy }));
    admit(host, {
      lane: `title:${chatId}`,
      kind: "title",
      chatId,
      model: modelId,
      draft: { text: "", attachments: [] },
      body,
      url: chatUrl(host.env),
      apiKey: config.apiKey,
      stream: false,
      timeoutSeconds: 30
    });
  }
  function afterCommit(ctx) {
    if (!ctx.config.autoTitles || ctx.record.chatId === null)
      return;
    requestTitle(ctx.host, ctx.config, ctx.record.chatId);
  }
  var titleFinalizer = (host, record, outcome) => {
    if (outcome.state !== "done" || record.chatId === null)
      return;
    let reply = "";
    try {
      const parsed = JSON.parse(outcome.bodyText);
      const content = parsed.choices?.[0]?.message?.content;
      reply = typeof content === "string" ? content : "";
    } catch {
      return;
    }
    const title = cleanTitle(reply);
    if (title === "")
      return;
    try {
      setTitleIfAuto(host, record.chatId, title);
    } catch (error) {
      if (!(error instanceof NotFoundError))
        throw error;
    }
  };
  function exportChat(host, config, chat) {
    const folder = expandHome(host, config.exportFolder);
    host.mkdirp(folder);
    const title = displayTitle(chat);
    const date = new Date(host.nowMs()).toISOString().slice(0, 10);
    const visible = chat.settings.showReasoning ? chat : { ...chat, messages: chat.messages.map(({ reasoning: _hidden, ...rest }) => rest) };
    const text = `${sanitizeMarkdown(`# ${title}

_Exported ${date}${chat.model ? ` · ${chat.model}` : ""}_

${renderTranscript(visible)}`, { imageRoots: [imagesFolder(host, config)] })}
`;
    const base = `${folder}/${date} ${fileSafe(title)}`;
    let path = `${base}.md`;
    for (let n = 2;host.exists(path); n++)
      path = `${base} ${n}.md`;
    host.writeAtomic(path, text);
    return path;
  }
  var exportCommand = {
    usage: "/export",
    help: "Save this chat as a Markdown file in the export folder",
    run(ctx) {
      if (!ctx.chat || ctx.chat.messages.length === 0)
        return { kind: "notice", text: "There is nothing to export yet." };
      try {
        const path = exportChat(ctx.host, ctx.config, ctx.chat);
        return { kind: "notice", text: `Exported to \`${path.replace(ctx.host.env.HOME ?? "\x00", "~")}\`.` };
      } catch (error) {
        return { kind: "notice", text: `The export failed: ${String(error)}. Check the export folder in Configuration.` };
      }
    }
  };
  var title = {
    usage: "/title <text>",
    help: "Name this chat yourself; automatic titles never replace it",
    run(ctx, args) {
      if (args === "")
        return { kind: "notice", text: `Title: **${ctx.chat ? displayTitle(ctx.chat) : DEFAULT_TITLE}**. Use \`/title <text>\` to rename it.` };
      const chat = ctx.ensureChat();
      setTitleManual(ctx.host, chat.id, args.slice(0, 120));
      return { kind: "notice", text: `Title set to **${args.slice(0, 120)}**.` };
    }
  };
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
  var feature3 = {
    commands: { export: exportCommand, title, pin, archive },
    afterCommit,
    finalizers: { title: titleFinalizer }
  };

  // src/features/image.ts
  var IMAGE_MESSAGE_SUFFIX = "-img";
  var imageFinalizer = (host, record, outcome) => {
    if (outcome.state !== "done" || outcome.httpStatus !== 200)
      return;
    const prompt = record.draft.text;
    const config = readConfig(host);
    let paths;
    try {
      paths = saveImages(host, config, outcome.bodyText, prompt);
    } catch (error) {
      if (!(error instanceof ImageSaveError))
        throw error;
      record.meta.failure = error.message;
      return;
    }
    record.meta.files = paths;
    if (record.chatId === null || record.lane.indexOf("chat:") !== 0)
      return;
    try {
      mutateChat(host, record.chatId, (chat) => {
        if (chat.messages.some((message) => message.requestId === record.id))
          return false;
        const now = host.nowMs();
        chat.messages.push({ id: `${record.id}-u`, requestId: record.id, role: "user", content: prompt, attachments: [], status: "ok", createdAt: now });
        chat.messages.push({ id: `${record.id}${IMAGE_MESSAGE_SUFFIX}`, requestId: record.id, role: "assistant", content: paths.map(imageMarkdown).join(`

`), attachments: [], status: "ok", createdAt: now });
      });
    } catch (error) {
      if (!(error instanceof NotFoundError))
        throw error;
    }
  };
  var image = {
    usage: "/image <prompt> [--ar 16:9] [--res 2K] [--n 2] [--model id]",
    help: "Generate an image and keep it in this chat",
    run(ctx, args) {
      const parsed = parseImagePrompt(args);
      if (!parsed.ok)
        return { kind: "notice", text: parsed.message };
      const modelId = parsed.request.model ?? ctx.config.imageModel;
      if (modelId === "")
        return { kind: "notice", text: "Choose an image model first: set Image Model in the workflow's Configuration, or add `--model <id>`." };
      if (ctx.config.apiKey === "")
        return { kind: "notice", text: ctx.config.keyIssue ?? "Add your OpenRouter API key in the workflow's Configuration first." };
      const chat = ctx.ensureChat();
      const result = admit(ctx.host, {
        lane: `chat:${chat.id}`,
        kind: "image",
        chatId: chat.id,
        model: modelId,
        draft: { text: parsed.request.prompt, attachments: [] },
        body: imageBody(parsed.request, modelId),
        url: `${apiBase(ctx.host.env)}/images`,
        apiKey: ctx.config.apiKey,
        stream: false,
        timeoutSeconds: ctx.config.imageTimeoutSeconds,
        meta: { count: parsed.request.count }
      }, { image: imageFinalizer });
      if (!result.ok)
        return { kind: "notice", text: "A reply is still running in this chat. Wait for it or stop it with ⇧↩, then try again." };
      return { kind: "started", rid: result.rid };
    }
  };
  function newestChatImage(ctx) {
    const messages = ctx.chat?.messages ?? [];
    for (let i = messages.length - 1;i >= 0; i--) {
      if (messages[i].id.slice(-IMAGE_MESSAGE_SUFFIX.length) === IMAGE_MESSAGE_SUFFIX)
        return imagePathsIn(messages[i].content).pop() ?? null;
    }
    return null;
  }
  var open = {
    usage: "/open",
    help: "Open the newest image of this chat in its app",
    run(ctx) {
      const path = newestChatImage(ctx) ?? newestImage(ctx.host, ctx.config);
      if (path === null || !ctx.host.exists(path))
        return { kind: "notice", text: "There is no image to open yet." };
      const argv = openArgv(path);
      ctx.host.runSync(argv, { timeoutMs: 1e4 });
      return { kind: "notice", text: argv.length > 2 ? `Showing \`${path}\` in Finder: an SVG can run scripts in a browser, so it is not opened for you.` : `Opened \`${path}\`.` };
    }
  };
  var reveal = {
    usage: "/reveal",
    help: "Show the newest image of this chat in Finder",
    run(ctx) {
      const path = newestChatImage(ctx) ?? newestImage(ctx.host, ctx.config);
      if (path === null || !ctx.host.exists(path))
        return { kind: "notice", text: "There is no image to show yet." };
      ctx.host.runSync(["/usr/bin/open", "-R", path], { timeoutMs: 1e4 });
      return { kind: "notice", text: `Showing \`${path}\` in Finder.` };
    }
  };
  var feature4 = {
    commands: { image, open, reveal },
    finalizers: { image: imageFinalizer },
    payloadOptions(ctx) {
      const offset = ctx.turns[0]?.role === "system" ? 1 : 0;
      let changed = false;
      const turns = ctx.turns.slice();
      ctx.window.forEach((message, i) => {
        if (message.role !== "assistant" || message.id.slice(-IMAGE_MESSAGE_SUFFIX.length) !== IMAGE_MESSAGE_SUFFIX)
          return;
        const prompt = ctx.window[i - 1]?.role === "user" ? ctx.window[i - 1].content : "";
        const turn = turns[offset + i];
        if (turn) {
          turns[offset + i] = { ...turn, content: `[image: ${prompt}]` };
          changed = true;
        }
      });
      return changed ? { turns } : undefined;
    }
  };

  // src/features/reasoning.ts
  var ALL_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "model"];
  function modelFor(ctx) {
    const id = ctx.chat?.model ?? getSettings(ctx.host).defaultModel ?? ctx.config.defaultModel;
    return getModel(ctx.host, id);
  }
  function blockquote(text) {
    return text.trim().split(`
`).map((line) => line === "" ? ">" : `> ${line}`).join(`
`);
  }
  function label(effort) {
    return effort === null ? "the model's own default" : effort === "none" ? "off" : effort;
  }
  var think = {
    usage: "/think [off | minimal | low | medium | high | xhigh | max | model]",
    help: "Set how hard the model reasons in this chat",
    run(ctx, args) {
      const model = modelFor(ctx);
      const requested = args.toLowerCase();
      if (requested === "") {
        const supported = efforts(model).map((e) => e === "none" ? "off" : e);
        const current = label(ctx.chat?.settings.effort ?? null);
        return { kind: "notice", text: supported.length === 0 ? `Reasoning effort: ${current}. This model has no reasoning controls.` : `Reasoning effort: ${current}. This model supports ${supported.map((e) => `\`${e}\``).join(", ")}, or \`model\` for its own default.` };
      }
      if (ALL_EFFORTS.indexOf(requested) < 0)
        return { kind: "notice", text: `Unknown effort \`${args}\`. Use ${ALL_EFFORTS.map((e) => `\`${e}\``).join(", ")}.` };
      let value = requested === "model" ? null : requested === "off" ? "none" : requested;
      if (value !== null && model) {
        if (!supportsReasoning(model))
          return { kind: "notice", text: `**${model.name}** has no reasoning controls, so the setting was not changed.` };
        if (value === "none" && model.reasoning.mandatory)
          return { kind: "notice", text: `Reasoning cannot be turned off for **${model.name}**; it always reasons. The setting was not changed. Try ${efforts(model).map((e) => `\`${e}\``).join(", ")}.` };
        if (efforts(model).indexOf(value) < 0)
          return { kind: "notice", text: `**${model.name}** does not support \`${requested}\`. It supports ${efforts(model).map((e) => `\`${e === "none" ? "off" : e}\``).join(", ")}. The setting was not changed.` };
      }
      const chat = ctx.ensureChat();
      mutateChat(ctx.host, chat.id, (current) => {
        current.settings.effort = value;
      });
      return { kind: "notice", text: `Reasoning effort for this chat: **${label(value)}**.` };
    }
  };
  var reasoning = {
    usage: "/reasoning [on | off]",
    help: "Keep the reasoning under each reply (on) or show it only while streaming (off)",
    run(ctx, args) {
      const value = args.toLowerCase();
      if (value === "" || value === "status") {
        return { kind: "notice", text: `Reasoning is ${ctx.chat?.settings.showReasoning ? "kept under each reply" : "shown while streaming and then collapsed"}. Use \`/reasoning on\` or \`/reasoning off\`.` };
      }
      if (value !== "on" && value !== "off")
        return { kind: "notice", text: "Use `/reasoning on` or `/reasoning off`." };
      const chat = ctx.ensureChat();
      mutateChat(ctx.host, chat.id, (current) => {
        current.settings.showReasoning = value === "on";
      });
      return { kind: "notice", text: value === "on" ? "Reasoning will stay under each new reply." : "Reasoning shows while streaming and collapses to the answer." };
    }
  };
  function effortFor(chat) {
    return chat.settings.effort;
  }
  var feature5 = {
    commands: { think, reasoning },
    payloadOptions(ctx) {
      return { options: { effort: effortFor(ctx.chat) } };
    },
    renderLive(ctx) {
      const text = ctx.state.reasoning;
      if (text.trim() === "")
        return null;
      if (ctx.state.content === "")
        return `**Thinking…**

${blockquote(text)}`;
      if (ctx.chat?.settings.showReasoning)
        return `${blockquote(text)}

${ctx.state.content}`;
      return null;
    },
    footerFlags(ctx) {
      const effort = ctx.chat?.settings.effort ?? null;
      return effort === null ? [] : [`\uD83E\uDDE0 ${label(effort)}`];
    }
  };

  // src/features/web.ts
  var web = {
    usage: "/web [on | off | status]",
    help: "Let the model search the web in this chat",
    run(ctx, args) {
      const value = args.toLowerCase();
      if (value === "" || value === "status") {
        const on = ctx.chat ? ctx.chat.settings.web : ctx.config.webDefault;
        return { kind: "notice", text: `Web search is **${on ? "on" : "off"}** for this chat. Use \`/web on\` or \`/web off\`.` };
      }
      if (value !== "on" && value !== "off")
        return { kind: "notice", text: "Use `/web on` or `/web off`." };
      const chat = ctx.ensureChat();
      mutateChat(ctx.host, chat.id, (current) => {
        current.settings.web = value === "on";
      });
      return { kind: "notice", text: value === "on" ? `Web search is on for this chat (up to ${ctx.config.webMaxResults} results per message). OpenRouter bills web search separately, so turn it off when you do not need it.` : "Web search is off for this chat." };
    }
  };
  var sources = {
    usage: "/sources",
    help: "List every source the last reply cited",
    run(ctx) {
      const reply = ctx.chat ? lastReply(ctx.chat) : null;
      const list = reply ? sourcesOf(reply) : [];
      if (list.length === 0)
        return { kind: "notice", text: "The last reply cited no sources." };
      return { kind: "notice", text: ["**Sources**", ...list.map((source, i) => `${i + 1}. ${sourceLine(source)}`)].join(`
`) };
    }
  };
  var feature6 = {
    commands: { web, sources },
    payloadOptions(ctx) {
      return { options: { web: ctx.chat.settings.web, webMaxResults: ctx.config.webMaxResults } };
    },
    footerFlags(ctx) {
      return ctx.chat?.settings.web ? ["web"] : [];
    }
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
  var features = [feature, feature2, feature5, feature6, feature3, feature4];
  function collectFinalizers(config) {
    const finalizers = {};
    for (const feature of features)
      Object.assign(finalizers, feature.finalizers ?? {});
    finalizers.chat = (host, record, outcome) => {
      for (const feature of features)
        if (feature.afterCommit)
          feature.afterCommit({ host, config, record, outcome });
    };
    return finalizers;
  }

  // src/app/view.ts
  function viewJson(frame) {
    const view = {
      response: sanitizeMarkdown(frame.response, { imageRoots: frame.imageRoots ?? [] }),
      footer: frame.footer.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim(),
      behaviour: { response: frame.mode, scroll: "end", inputfield: "select" },
      variables: { request_id: frame.requestId, view_stage: frame.stage }
    };
    if (frame.rerun !== undefined)
      view.rerun = frame.rerun;
    return JSON.stringify(view);
  }
  function imageError(error) {
    return { title: "Image generation failed", detail: `${error.title}. ${error.detail}`, next: error.next };
  }

  // src/app/image.ts
  var LANE = "image";
  var GALLERY_SIZE = 10;
  var HINT = "↩ generate · ⌘↩ open · ⌥↩ reveal · ⌘⌥↩ chats";
  function idle(host, config, notice) {
    const images = listImages(host, config, GALLERY_SIZE);
    const sections = images.map((image) => `${imageMarkdown(image.path)}

_${image.prompt === "" ? "no prompt saved" : image.prompt}_`);
    const body = sections.length > 0 ? `# Recent images

${sections.join(`

`)}` : "Describe an image and press ↩. Options: `--ar 16:9`, `--res 2K`, `--n 2`, `--model <id>`.";
    return viewJson({
      response: notice ? `${notice}

${body}` : body,
      footer: [config.imageModel, HINT].filter((part) => part !== "").join(" · "),
      mode: "replace",
      requestId: "",
      stage: "",
      imageRoots: [imagesFolder(host, config)]
    });
  }
  function live(host, config, record) {
    const elapsed = Math.max(0, Math.floor((host.nowMs() - record.startedAt) / 1000));
    return viewJson({
      response: `# \uD83C\uDFA8 ${record.draft.text}

_Generating image…_`,
      footer: [record.model, `generating ${elapsed}s`].join(" · "),
      mode: "replace",
      requestId: record.id,
      stage: "",
      rerun: 0.1,
      imageRoots: [imagesFolder(host, config)]
    });
  }
  function finished(host, config, record, files, failure) {
    const parts = [`# \uD83C\uDFA8 ${record.draft.text}`];
    if (files.length > 0)
      parts.push(files.map(imageMarkdown).join(`

`));
    else {
      const error = failure !== null ? { title: "Image", detail: failure, next: "Try again." } : record.error ?? { title: "Image", detail: "No image was returned.", next: "Try again." };
      const shown = imageError(error);
      parts.push(`# ⚠️ ${shown.title}

${shown.detail}

**Next:** ${shown.next}`);
    }
    return viewJson({
      response: parts.join(`

`),
      footer: [record.model, files.length > 0 ? "done" : "failed", HINT].join(" · "),
      mode: "replace",
      requestId: "",
      stage: "",
      imageRoots: [imagesFolder(host, config)]
    });
  }
  function filesOf(record) {
    const files = record && Array.isArray(record.meta.files) ? record.meta.files : [];
    const failure = record && typeof record.meta.failure === "string" ? record.meta.failure : null;
    return { files, failure };
  }
  function main(host, argv) {
    const config = readConfig(host);
    const finalizers = collectFinalizers(config);
    const typed = (argv[0] ?? "").trim();
    const rid = (host.env.request_id ?? "").trim();
    if (rid !== "") {
      const step = advance(host, rid, finalizers);
      if (!step.tick)
        return idle(host, config);
      if (!step.tick.terminal)
        return live(host, config, step.tick.record);
      const outcome = filesOf(step.finalize?.record ?? null);
      return finished(host, config, step.tick.record, outcome.files, outcome.failure);
    }
    finalizeDue(host, finalizers, LANE);
    const open = currentRecord(host, LANE);
    if (open && !open.final && open.state === "open") {
      if (typed === "")
        return live(host, config, open);
      stop(host, open.id);
      advance(host, open.id, finalizers);
    }
    if (typed === "")
      return idle(host, config);
    const parsed = parseImagePrompt(typed);
    if (!parsed.ok)
      return idle(host, config, parsed.message);
    const modelId = parsed.request.model ?? (config.imageModel !== "" ? config.imageModel : getSettings(host).lastModel ?? "");
    if (modelId === "")
      return idle(host, config, "Choose an image model first: set Image Model in the workflow's Configuration, or add `--model <id>`.");
    if (config.apiKey === "")
      return idle(host, config, config.keyIssue ?? "Add your OpenRouter API key in the workflow's Configuration first.");
    const result = admit(host, {
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
      meta: { count: parsed.request.count }
    }, finalizers);
    if (!result.ok)
      return idle(host, config, "An image is still being generated.");
    const record = currentRecord(host, LANE);
    return record ? live(host, config, record) : idle(host, config);
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
  function fail(action, path) {
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
        fail("read", path);
      return ObjC.unwrap(text);
    }
    readBytesFrom(path, offset, maxLength = Infinity) {
      if (maxLength <= 0)
        return new Uint8Array(0);
      const handle = $.NSFileHandle.fileHandleForReadingAtPath(path);
      if (isNil(handle))
        fail("open", path);
      try {
        handle.seekToFileOffset(offset);
        return bytesFromData(Number.isFinite(maxLength) ? handle.readDataOfLength(maxLength) : handle.readDataToEndOfFile);
      } finally {
        handle.closeFile;
      }
    }
    readBase64(path) {
      const data = $.NSData.dataWithContentsOfFile(path);
      if (isNil(data))
        fail("read", path);
      return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
    }
    writeAtomic(path, data) {
      const payload = typeof data === "string" ? nsString(data).dataUsingEncoding($.NSUTF8StringEncoding) : dataFromBytes(data);
      if (!payload.writeToFileAtomically(path, true))
        fail("write", path);
      fileManager().setAttributesOfItemAtPathError(permissions(PRIVATE_FILE), path, $());
    }
    mkdirp(path) {
      if (!fileManager().createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, true, permissions(PRIVATE_DIR), $()))
        fail("mkdir", path);
    }
    mkdirExclusive(path) {
      if (fileManager().createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, false, permissions(PRIVATE_DIR), $()))
        return true;
      if (fileManager().fileExistsAtPath(path))
        return false;
      return fail("mkdir", path);
    }
    move(from, to) {
      if (!fileManager().moveItemAtPathToPathError(from, to, $()))
        fail("move", `${from} to ${to}`);
    }
    remove(path) {
      if (fileManager().fileExistsAtPath(path) && !fileManager().removeItemAtPathError(path, $()))
        fail("remove", path);
    }
    restrict(path) {
      const manager = fileManager();
      if (!manager.fileExistsAtPath(path))
        return;
      const apply = (item) => {
        const attributes = manager.attributesOfItemAtPathError(item, $());
        if (isNil(attributes))
          fail("read the permissions of", item);
        const type = String(ObjC.unwrap(attributes.objectForKey("NSFileType")));
        if (type === "NSFileTypeSymbolicLink")
          return type;
        if (!manager.setAttributesOfItemAtPathError(permissions(type === "NSFileTypeDirectory" ? PRIVATE_DIR : PRIVATE_FILE), item, $()))
          fail("restrict", item);
        return type;
      };
      if (apply(path) !== "NSFileTypeDirectory")
        return;
      const names = manager.subpathsOfDirectoryAtPathError(path, $());
      if (isNil(names))
        fail("list", path);
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
    changedMs(path) {
      const key = $.NSURLAttributeModificationDateKey;
      const values = $.NSURL.fileURLWithPath(path).resourceValuesForKeysError($.NSArray.arrayWithObject(key), $());
      if (isNil(values))
        return null;
      const date = values.objectForKey(key);
      return isNil(date) ? null : date.timeIntervalSince1970 * 1000;
    }
    listDir(path) {
      const names = fileManager().contentsOfDirectoryAtPathError(path, $());
      if (isNil(names))
        fail("list", path);
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
      const command = options.maxBytes === undefined ? argv : boundedCommandArgv(argv, options.maxBytes);
      const folder = `${ObjC.unwrap($.NSTemporaryDirectory())}aichat-run-${this.randomId()}`;
      this.mkdirp(folder);
      const outPath = `${folder}/out`;
      const errPath = `${folder}/err`;
      fileManager().createFileAtPathContentsAttributes(outPath, $(), permissions(PRIVATE_FILE));
      fileManager().createFileAtPathContentsAttributes(errPath, $(), permissions(PRIVATE_FILE));
      const out = $.NSFileHandle.fileHandleForWritingAtPath(outPath);
      const err = $.NSFileHandle.fileHandleForWritingAtPath(errPath);
      try {
        const task = launch(command, out, err, this.env, options.stdin);
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
        if (options.maxBytes !== undefined)
          return boundedRunResult(this, outPath, errPath, timedOut ? 124 : task.terminationStatus, options.maxBytes);
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
      expirePresetResult(host);
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
  var PRESET_RESULT_MAX_AGE_MS = 60 * 60 * 1000;
  function expirePresetResult(host) {
    const path = `${dataDir(host)}/last-preset.json`;
    const info = host.stat(path);
    if (info === null)
      return false;
    if (host.nowMs() - info.mtimeMs < PRESET_RESULT_MAX_AGE_MS)
      return true;
    host.remove(path);
    return false;
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

  // src/entries/image.ts
  defineEntry((argv) => main(maintained(createJxaHost()), argv));
})();
function run(argv) { return __aichat_main(argv); }
