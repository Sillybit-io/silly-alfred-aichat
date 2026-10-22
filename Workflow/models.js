#!/usr/bin/osascript -l JavaScript
var __aichat_main;
(() => {
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

  // src/core/favicons.ts
  var MAX_ICON_BYTES = 64 * 1024;

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
  var currentFile = (host) => `${dataDir(host)}/current`;
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
  function clearCurrent(host) {
    host.remove(currentFile(host));
  }
  function getCurrent(host) {
    let id;
    try {
      id = host.readText(currentFile(host)).trim();
    } catch {
      return null;
    }
    if (id !== "" && host.exists(chatDir(host, id)))
      return id;
    clearCurrent(host);
    return null;
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

  // src/core/payload.ts
  var DEFAULT_API_BASE = "https://openrouter.ai/api/v1";
  function apiBase(env) {
    const configured = (env.aichat_api_base ?? "").trim();
    return (configured === "" ? DEFAULT_API_BASE : configured).replace(/\/+$/, "");
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
  function curl(host) {
    return host.env.aichat_curl ?? "/usr/bin/curl";
  }
  function curlArgs(host, extra) {
    return [
      curl(host),
      "-o",
      part(host),
      "-D",
      files(host).headers,
      "--silent",
      "--show-error",
      "--connect-timeout",
      "10",
      ...extra,
      `${apiBase(host.env)}/models?output_modalities=all`
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
      const run = host.runSync(curlArgs(host, ["--max-time", "10"]), { timeoutMs: 15000 });
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
        host.spawnSupervised(curlArgs(host, ["--max-time", "60"]), { pid: f.pid, exit: f.exit, stderr: f.stderr });
        refreshing = true;
      }
    }
    return { models: cache.models, note, refreshing };
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
    return {
      apiKey: (env.openrouter_api_key ?? "").trim(),
      defaultModel: text(env.default_model, FALLBACK_MODEL),
      systemPrompt: env.system_prompt ?? "",
      systemContext: env.system_context !== "0",
      sourcesIcons: env.sources_style === "icons",
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
      imageTimeoutSeconds: Math.max(10, int(env.image_timeout_seconds, 300)),
      visionFallbackModel: text(env.vision_fallback_model, ""),
      retentionDays: Math.max(0, int(env.retention_days, 0)),
      maxChats: Math.max(0, int(env.max_chats, 0)),
      textAttachmentMaxKb: Math.max(1, int(env.text_attachment_max_kb, 200)),
      imageMaxEdge: Math.max(64, int(env.image_max_edge, 2048))
    };
  }

  // src/store/current-chat.ts
  function currentChat(host) {
    const id = getCurrent(host);
    return id === null ? null : getChat(host, id);
  }

  // src/app/models.ts
  var MAX_ITEMS = 60;
  function modItem(subtitle, id, action) {
    return { valid: true, subtitle, arg: id, variables: { model_action: action } };
  }
  function main(host, argv) {
    const config = readConfig(host);
    const query = argv[0] ?? "";
    const catalog = ensureCatalog(host);
    const settings = getSettings(host);
    const chat = currentChat(host);
    const defaultId = settings.defaultModel ?? config.defaultModel;
    const currentId = chat?.model ?? defaultId;
    const found = searchModels(catalog.models, query, { favorites: settings.favorites, limit: MAX_ITEMS });
    const items = found.map((model) => {
      const favorite = settings.favorites.indexOf(model.id) >= 0;
      const marks = [model.id === currentId ? "●" : "", favorite ? "★" : "", model.id === defaultId ? "default" : ""].filter((m) => m !== "");
      return {
        title: marks.length > 0 ? `${model.name}  ${marks.join(" ")}` : model.name,
        subtitle: `${model.id} · ${formatSubtitle(model)}`,
        arg: model.id,
        autocomplete: model.id,
        valid: true,
        variables: { model_action: "use" },
        mods: {
          cmd: modItem("Set as the default model", model.id, "default"),
          alt: modItem(favorite ? "Remove from favorites" : "Add to favorites", model.id, "favorite"),
          ctrl: modItem("Copy the model id", model.id, "copy")
        }
      };
    });
    if (items.length === 0) {
      items.push({
        title: catalog.models.length === 0 ? "The model list is not available" : "No models match",
        subtitle: catalog.models.length === 0 ? catalog.note ?? "Check your connection and try again" : "Try fewer words, or #image #imagegen #file #free #reasoning",
        valid: false
      });
    } else if (catalog.note) {
      items.push({ title: "Model list note", subtitle: catalog.note, valid: false });
    }
    return JSON.stringify({ skipknowledge: true, items });
  }

  // src/host/common.ts
  var SUPERVISOR_SCRIPT = [
    "pid_file=$1; exit_file=$2; err_file=$3; shift 3",
    '"$@" </dev/null >/dev/null 2>"$err_file" &',
    "child=$!",
    'printf "%s" "$child" > "$pid_file.tmp" && mv "$pid_file.tmp" "$pid_file"',
    'wait "$child"',
    "status=$?",
    'printf "%s" "$status" > "$exit_file.tmp" && mv "$exit_file.tmp" "$exit_file"'
  ].join(`
`);
  function supervisorArgv(argv, files) {
    if (argv.length === 0)
      throw new Error("spawnSupervised needs a command");
    return ["/bin/sh", "-c", SUPERVISOR_SCRIPT, "sh", files.pid, files.exit, files.stderr, ...argv];
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
  function fail(action, path) {
    throw new Error(`${action} failed for ${path}`);
  }
  function launch(argv, out, err) {
    const task = $.NSTask.alloc.init;
    const absolute = argv[0].charAt(0) === "/";
    task.executableURL = $.NSURL.fileURLWithPath(absolute ? argv[0] : "/usr/bin/env");
    task.arguments = absolute ? argv.slice(1) : argv;
    task.standardInput = $.NSFileHandle.fileHandleWithNullDevice;
    task.standardOutput = out;
    task.standardError = err;
    if (!task.launchAndReturnError(false))
      throw new Error(`could not launch ${argv[0]}`);
    return task;
  }

  class JxaHost {
    env = ObjC.deepUnwrap($.NSProcessInfo.processInfo.environment);
    readText(path) {
      const text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, $());
      if (isNil(text))
        fail("read", path);
      return ObjC.unwrap(text);
    }
    readBytesFrom(path, offset) {
      const handle = $.NSFileHandle.fileHandleForReadingAtPath(path);
      if (isNil(handle))
        fail("open", path);
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
        fail("write", path);
    }
    mkdirp(path) {
      if (!fileManager().createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, true, $(), $()))
        fail("mkdir", path);
    }
    mkdirExclusive(path) {
      if (fileManager().createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, false, $(), $()))
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
      if (fileManager().fileExistsAtPath(path))
        fileManager().removeItemAtPathError(path, $());
    }
    trash(path) {
      if (!fileManager().trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(path), Ref(), $()))
        fail("trash", path);
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
        fail("list", path);
      return ObjC.deepUnwrap(names);
    }
    spawnSupervised(argv, files) {
      const nullDevice = $.NSFileHandle.fileHandleWithNullDevice;
      launch(supervisorArgv(argv, files), nullDevice, nullDevice);
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
      fileManager().createFileAtPathContentsAttributes(outPath, $(), $());
      fileManager().createFileAtPathContentsAttributes(errPath, $(), $());
      const out = $.NSFileHandle.fileHandleForWritingAtPath(outPath);
      const err = $.NSFileHandle.fileHandleForWritingAtPath(errPath);
      try {
        const task = launch(argv, out, err);
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
      $.NSFileHandle.fileHandleWithStandardError.writeData(nsString(`${message}
`).dataUsingEncoding($.NSUTF8StringEncoding));
    }
  }
  function createJxaHost() {
    return new JxaHost;
  }

  // src/jxa/entry.ts
  function defineEntry(main) {
    __aichat_main = main;
  }

  // src/entries/models.ts
  defineEntry((argv) => main(createJxaHost(), argv));
})();
function run(argv) { return __aichat_main(argv); }
