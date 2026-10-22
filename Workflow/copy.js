#!/usr/bin/osascript -l JavaScript
var __aichat_main;
(() => {
  // src/core/favicons.ts
  function domainOf(url) {
    const match = /^https?:\/\/([^/:?#\s]+)/i.exec(url.trim());
    if (!match)
      return null;
    const host = match[1].toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    return isSafeDomain(host) ? host : null;
  }
  function isSafeDomain(host) {
    if (host.length < 4 || host.length > 253)
      return false;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host))
      return false;
    if (/^\d+(\.\d+)*$/.test(host) || /^[0-9]+$/.test(host.slice(host.lastIndexOf(".") + 1)))
      return false;
    const last = host.slice(host.lastIndexOf(".") + 1);
    if (["local", "localhost", "internal", "lan", "home", "corp", "intranet", "test", "invalid", "example"].indexOf(last) >= 0)
      return false;
    return true;
  }
  var MAX_ICON_BYTES = 64 * 1024;
  function labelOf(url) {
    const domain = domainOf(url);
    const host = domain ?? (/^https?:\/\/([^/?#]+)/i.exec(url)?.[1] ?? "link");
    return host.replace(/([\\_*`\[\]])/g, "\\$1");
  }
  function sourcesRow(sources, style) {
    const seen = new Set;
    const unique = sources.filter((source) => {
      const key = labelOf(source.url);
      if (seen.has(key))
        return false;
      seen.add(key);
      return true;
    });
    const shown = unique.slice(0, style.cap);
    const links = shown.map((source) => {
      const domain = domainOf(source.url);
      const icon = style.icons && domain !== null ? style.icon(domain) : null;
      const link = `[${labelOf(source.url)}](${source.url.replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
      return icon === null ? link : `![](${icon}) ${link}`;
    });
    const more = unique.length > shown.length ? `  ·  +${unique.length - shown.length} more with \`/sources\`` : "";
    return `**Sources**  ${links.join("  ·  ")}${more}`;
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
      const url = typeof inner.url === "string" ? inner.url : "";
      if (url === "" || seen.has(url))
        continue;
      seen.add(url);
      sources.push({ url, title: typeof inner.title === "string" && inner.title !== "" ? inner.title : url });
    }
    return sources;
  }
  function quote(text) {
    return text.split(`
`).map((line) => line === "" ? ">" : `> ${line}`).join(`
`);
  }
  function renderMessage(message, style) {
    const parts = [message.role === "user" ? YOU_HEADING : ASSISTANT_HEADING];
    if (message.reasoning)
      parts.push(quote(message.reasoning.trim()));
    if (message.content !== "")
      parts.push(message.content);
    for (const attachment of message.attachments)
      parts.push(`\uD83D\uDCCE ${attachment.name} (${formatSize(attachment.size)})`);
    const sources = sourcesOf(message);
    if (sources.length > 0) {
      parts.push(style ? sourcesRow(sources, style) : ["**Sources**", ...sources.map((source) => `- [${source.title}](${source.url})`)].join(`
`));
    }
    if (message.status === "interrupted")
      parts.push(`_⚠ Interrupted${message.error ? `: ${message.error}` : ""}. Send "continue" to get the rest._`);
    if (message.status === "stopped")
      parts.push('_■ Stopped. Send "continue" to get the rest._');
    return parts.join(`

`);
  }
  function renderTranscript(chat, style) {
    return chat.messages.map((message, i) => `${message.role === "user" && i > 0 ? `${TURN_BREAK}

` : ""}${renderMessage(message, style)}`).join(`

`);
  }
  function lastReply(chat) {
    for (let i = chat.messages.length - 1;i >= 0; i--)
      if (chat.messages[i].role === "assistant")
        return chat.messages[i];
    return null;
  }
  function renderLastReply(chat) {
    const reply = lastReply(chat);
    if (!reply)
      return "";
    return renderMessage(reply).replace(`${ASSISTANT_HEADING}

`, "");
  }

  // src/store/chats.ts
  function dataDir(host) {
    const dir = host.env.alfred_workflow_data;
    if (!dir)
      throw new Error("alfred_workflow_data is not set");
    return dir.replace(/\/+$/, "");
  }
  var chatsDir = (host) => `${dataDir(host)}/chats`;
  var chatDir = (host, id) => `${chatsDir(host)}/${id}`;
  var chatFile = (host, id) => `${chatDir(host, id)}/chat.json`;
  var currentFile = (host) => `${dataDir(host)}/current`;
  function getChat(host, id) {
    try {
      return JSON.parse(host.readText(chatFile(host, id)));
    } catch {
      return null;
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

  // src/app/preset-result.ts
  var path = (host) => `${dataDir(host)}/last-preset.json`;
  function loadLastResult(host) {
    try {
      const parsed = JSON.parse(host.readText(path(host)));
      return typeof parsed.reply === "string" ? { name: typeof parsed.name === "string" ? parsed.name : "Preset", reply: parsed.reply } : null;
    } catch {
      return null;
    }
  }

  // src/app/copy.ts
  function main(host, _argv) {
    if ((host.env.copy_mode ?? "").trim() === "preset")
      return loadLastResult(host)?.reply ?? "";
    const id = getCurrent(host);
    const chat = id === null ? null : getChat(host, id);
    if (!chat)
      return "";
    return (host.env.copy_mode ?? "").trim() === "all" ? renderTranscript(chat) : renderLastReply(chat);
  }

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

  // src/entries/copy.ts
  defineEntry((argv) => main(createJxaHost(), argv));
})();
function run(argv) { return __aichat_main(argv); }
