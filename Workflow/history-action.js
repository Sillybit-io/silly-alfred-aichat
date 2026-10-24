#!/usr/bin/osascript -l JavaScript
var __aichat_main;
(() => {
  // src/core/attachments.ts
  var MAX_FILE_BYTES = 20 * 1024 * 1024;
  var MAX_BODY_BYTES = 32 * 1024 * 1024;
  function baseName(path) {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(slash + 1) : path;
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

  // src/app/view.ts
  function envelope(arg, variables) {
    return JSON.stringify({ alfredworkflow: { arg, variables } });
  }

  // src/app/history-action.ts
  function applyHistoryAction(host, action, folderArg) {
    const id = baseName(folderArg.trim().replace(/\/+$/, ""));
    const gone = { next: "list", notice: "That chat no longer exists" };
    if (id === "" || !getChat(host, id))
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
  function main(host, argv) {
    const outcome = applyHistoryAction(host, (host.env.history_action ?? "open").trim(), argv[0] ?? "");
    return envelope("", { history_next: outcome.next, notice: outcome.notice, request_id: "", view_stage: "" });
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

  // src/entries/history-action.ts
  defineEntry((argv) => main(maintained(createJxaHost()), argv));
})();
function run(argv) { return __aichat_main(argv); }
