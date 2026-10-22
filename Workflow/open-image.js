#!/usr/bin/osascript -l JavaScript
var __aichat_main;
(() => {
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

  // src/core/imagegen.ts
  var IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

  // src/store/images.ts
  function imagesFolder(host, config) {
    const home = host.env.HOME ?? "";
    const folder = config.imagesFolder;
    return (folder === "~" ? home : folder.startsWith("~/") ? `${home}${folder.slice(1)}` : folder).replace(/\/+$/, "");
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

  // src/app/open-image.ts
  function main(host, _argv) {
    const path = newestImage(host, readConfig(host));
    if (path !== null)
      host.runSync(["/usr/bin/open", path], { timeoutMs: 1e4 });
    return "";
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

  // src/entries/open-image.ts
  defineEntry((argv) => main(createJxaHost(), argv));
})();
function run(argv) { return __aichat_main(argv); }
