#!/usr/bin/osascript -l JavaScript
var __aichat_main;
(() => {
  // src/store/chats.ts
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

  // src/app/preset-result.ts
  var path = (host) => `${dataDir(host)}/last-preset.json`;
  function loadLastResult(host) {
    try {
      if (!expirePresetResult(host))
        return null;
      const parsed = JSON.parse(host.readText(path(host)));
      return typeof parsed.reply === "string" ? { name: typeof parsed.name === "string" ? parsed.name : "Preset", reply: parsed.reply } : null;
    } catch {
      return null;
    }
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

  // src/app/preset-view.ts
  function main(host, _argv) {
    const result = loadLastResult(host);
    return viewJson({
      response: result ? result.reply : "There is no preset result to show.",
      footer: result ? `${result.name} · ⌘↩ copy · ⌘⌥↩ chats` : "Run a preset with the aipresets keyword",
      mode: "replace",
      requestId: "",
      stage: ""
    });
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

  // src/jxa/entry.ts
  function defineEntry(main) {
    __aichat_main = main;
  }

  // src/entries/preset-view.ts
  defineEntry((argv) => main(maintained(createJxaHost()), argv));
})();
function run(argv) { return __aichat_main(argv); }
