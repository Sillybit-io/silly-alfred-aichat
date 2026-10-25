#!/usr/bin/osascript -l JavaScript
var __aichat_main;
(() => {
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
  var BAD_KEY = /[\u0000-\u001f\u007f]/;
  function keyProblem(apiKey) {
    return BAD_KEY.test(apiKey) ? "The OpenRouter API key in the workflow's Configuration contains a line break or control character. Paste it again." : null;
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
  var currentFile = (host) => `${dataDir(host)}/current`;
  function defaultSettings() {
    return { web: false, showReasoning: false, effort: null, pdfEngine: null };
  }
  function createChat(host, init = {}) {
    host.mkdirp(chatsDir(host));
    const id = newId(host);
    if (!host.mkdirExclusive(chatDir(host, id)))
      throw new Error(`chat ${id} already exists`);
    host.mkdirExclusive(attachmentsDir(host, id));
    const now = host.nowMs();
    const chat = {
      schema: 1,
      id,
      title: init.title ?? "New chat",
      titleSource: "auto",
      createdAt: now,
      updatedAt: now,
      revision: 0,
      model: init.model ?? null,
      pinned: false,
      archived: false,
      settings: { ...defaultSettings(), ...init.settings },
      pending: [],
      retry: null,
      messages: []
    };
    host.writeAtomic(chatFile(host, id), JSON.stringify(chat, null, 2));
    return chat;
  }
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
  function setCurrent(host, id) {
    host.mkdirp(dataDir(host));
    host.writeAtomic(currentFile(host), id);
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
  var summaryCacheFile = (host) => `${cacheDir(host)}/summaries.json`;
  var summaryCacheLock = (host) => `${cacheDir(host)}/.summaries.lock`;
  function loadSummaryCache(host) {
    try {
      const parsed = JSON.parse(host.readText(summaryCacheFile(host)));
      if (parsed.schema === 1 && typeof parsed.entries === "object" && parsed.entries !== null)
        return { schema: 1, entries: parsed.entries };
    } catch {}
    return { schema: 1, entries: {} };
  }
  function saveSummaryCache(host, cache) {
    try {
      host.writeAtomic(summaryCacheFile(host), JSON.stringify(cache));
    } catch {}
  }
  function forgetSummary(host, id) {
    if (!host.env.alfred_workflow_cache || !host.exists(cacheDir(host)))
      return;
    withLock(host, summaryCacheLock(host), () => {
      const cache = loadSummaryCache(host);
      if (!Object.prototype.hasOwnProperty.call(cache.entries, id))
        return;
      delete cache.entries[id];
      saveSummaryCache(host, cache);
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

  // src/core/capabilities.ts
  var IGNORED_PRICES = new Set(["prompt", "completion", "web_search", "internal_reasoning", "input_cache_read", "input_cache_write"]);

  // src/store/catalog.ts
  var CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  var RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
  var STUCK_REFRESH_MS = 2 * 60 * 1000;

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

  // src/store/requests.ts
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

  // src/store/current-chat.ts
  function initialSettings(config) {
    const reasoning = config.reasoningDefault;
    return {
      web: config.webDefault,
      showReasoning: config.keepReasoning,
      effort: reasoning === "model" ? null : reasoning === "off" ? "none" : reasoning
    };
  }
  function currentChat(host) {
    const id = getCurrent(host);
    return id === null ? null : getChat(host, id);
  }
  function ensureCurrentChat(host, config) {
    const existing = currentChat(host);
    if (existing)
      return existing;
    const chat = createChat(host, { settings: initialSettings(config) });
    setCurrent(host, chat.id);
    return chat;
  }

  // src/app/view.ts
  function envelope(arg, variables) {
    return JSON.stringify({ alfredworkflow: { arg, variables } });
  }

  // src/app/history-action.ts
  var CHAT_ID = /^[0-9a-z]{1,64}$/;
  function applyHistoryAction(host, action, folderArg) {
    const id = baseName(folderArg.trim().replace(/\/+$/, ""));
    const gone = { next: "list", notice: "That chat no longer exists" };
    if (!CHAT_ID.test(id) || !getChat(host, id))
      return gone;
    try {
      if (action === "archive") {
        mutateChat(host, id, (chat) => {
          chat.archived = !chat.archived;
        });
        return { next: "list", notice: "" };
      }
      if (action === "pin") {
        mutateChat(host, id, (chat) => {
          chat.pinned = !chat.pinned;
        });
        return { next: "list", notice: "" };
      }
      if (action === "delete") {
        const title = getChat(host, id)?.title ?? "this chat";
        if (!host.confirm(`Delete “${title}” permanently? Its messages and attachments cannot be recovered.`, "Delete"))
          return { next: "list", notice: "The chat was not deleted" };
        mutateChat(host, id, () => false);
        try {
          host.remove(chatDir(host, id));
        } catch (error) {
          host.log(`could not delete chat ${id}: ${String(error)}`);
          return { next: "list", notice: "The chat could not be deleted" };
        }
        forgetSummary(host, id);
        if (getCurrent(host) === id)
          clearCurrent(host);
        return { next: "list", notice: "" };
      }
    } catch (error) {
      if (error instanceof NotFoundError)
        return gone;
      throw error;
    }
    setCurrent(host, id);
    return { next: "view", notice: "" };
  }

  // src/app/session.ts
  function stopCurrentRequest(host) {
    const chatId = getCurrent(host);
    if (chatId === null)
      return;
    const record = currentRecord(host, `chat:${chatId}`);
    if (record && !record.final)
      stop(host, record.id);
  }

  // src/app/root-action.ts
  function main(host, argv) {
    const action = (host.env.root_action ?? "continue").trim();
    const arg = argv[0] ?? "";
    const done = (next, text = "", notice = "") => envelope(text, { root_next: next, notice, request_id: "", view_stage: "" });
    switch (action) {
      case "continue":
        return done("view", arg.trim());
      case "new":
        stopCurrentRequest(host);
        clearCurrent(host);
        return done("view", arg.trim());
      case "attach":
      case "attach_new": {
        if (action === "attach_new") {
          stopCurrentRequest(host);
          clearCurrent(host);
        }
        const config = readConfig(host);
        const result = attachPaths(host, config, ensureCurrentChat(host, config).id, [arg.trim()]);
        return envelope("", { root_next: "view", notice: "", request_id: "", view_stage: "", attach_notice: result.errors.join("; ") });
      }
      case "models":
      case "presets":
      case "image":
      case "history":
        return done(action);
      default: {
        const outcome = applyHistoryAction(host, action, arg);
        return done(outcome.next === "view" ? "view" : "root", "", outcome.notice);
      }
    }
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

  // src/entries/root-action.ts
  defineEntry((argv) => main(maintained(createJxaHost()), argv));
})();
function run(argv) { return __aichat_main(argv); }
