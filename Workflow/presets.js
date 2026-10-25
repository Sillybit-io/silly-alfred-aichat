#!/usr/bin/osascript -l JavaScript
var __aichat_main;
(() => {
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
  function outputLabel(output) {
    return { textview: "open in a chat", clipboard: "copy the reply", paste: "paste the reply", largetype: "show in Large Type" }[output];
  }

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
  function preview(text) {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > 70 ? `${flat.slice(0, 67)}…` : flat;
  }
  function inputText(host) {
    const given = host.env.preset_text;
    if (given !== undefined && given !== "")
      return given;
    return host.clipboardText() ?? "";
  }
  function matches(preset, query) {
    const haystack = `${preset.name} ${preset.id}`.toLowerCase();
    return query.toLowerCase().split(/\s+/).filter((word) => word !== "").every((word) => haystack.indexOf(word) >= 0);
  }
  function main(host, argv) {
    const query = argv[0] ?? "";
    const loaded = loadPresets(host);
    const text = inputText(host);
    const items = [];
    if (loaded.errors.length > 0) {
      const first = loaded.errors[0];
      items.push({ title: `presets.json has a problem on line ${first.line}`, subtitle: `${first.message}${loaded.errors.length > 1 ? ` (and ${loaded.errors.length - 1} more)` : ""}. Fix it with Edit presets.json.`, valid: false });
    }
    for (const preset of loaded.presets.filter((candidate) => matches(candidate, query))) {
      const what = text === "" ? "No text: select some and use the Universal Action, or copy some first" : `“${preview(text)}”`;
      items.push({
        title: preset.name,
        subtitle: `${outputLabel(preset.output)} · ${what}`,
        arg: text,
        valid: text !== "",
        variables: { preset_id: preset.id }
      });
    }
    if (query.trim() === "" || "edit presets.json".indexOf(query.toLowerCase().trim()) >= 0 || "edit".indexOf(query.toLowerCase().trim()) >= 0) {
      items.push({ title: "Edit presets.json", subtitle: loaded.path.replace(host.env.HOME ?? "\x00", "~"), arg: "", valid: true, variables: { preset_id: EDIT_ID } });
    }
    return JSON.stringify({ items });
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

  // src/jxa/entry.ts
  function defineEntry(main) {
    __aichat_main = main;
  }

  // src/entries/presets.ts
  defineEntry((argv) => main(maintained(createJxaHost()), argv));
})();
function run(argv) { return __aichat_main(argv); }
