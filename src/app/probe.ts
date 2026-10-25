import type { Host } from "../host/types";

type Check = { name: string; ok: boolean; detail: string };

function waitFor(host: Host, path: string, timeoutMs: number): boolean {
  const deadline = host.nowMs() + timeoutMs;
  while (host.nowMs() < deadline) {
    if (host.exists(path)) return true;
    host.sleepMs(20);
  }
  return host.exists(path);
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// Exercises every host primitive in a temporary folder. On the Mac this is the one manual
// step that proves the JXA adapter works; under bun it proves the twin behaves the same.
export function main(host: Host, argv: string[]): string {
  const checks: Check[] = [];
  const check = (name: string, run: () => string | true) => {
    try {
      const result = run();
      checks.push({ name, ok: result === true || result === "", detail: result === true ? "" : result });
    } catch (error) {
      checks.push({ name, ok: false, detail: String(error) });
    }
  };
  const expect = (condition: boolean, message: string): string | true => (condition ? true : message);

  const base = (host.env.TMPDIR ?? "/tmp").replace(/\/+$/, "");
  const root = `${base}/aichat-probe-${host.randomId()}`;
  const supervised = (argvList: string[], name: string) => {
    const files = { pid: `${root}/${name}.pid`, exit: `${root}/${name}.exit`, stderr: `${root}/${name}.stderr` };
    host.spawnSupervised(argvList, files);
    return files;
  };
  // The permission bits of a path as octal text (macOS stat first, GNU stat as the fallback for the bun twin).
  const modeOf = (path: string): string => {
    for (const args of [["-f", "%Lp"], ["-c", "%a"]]) {
      const result = host.runSync(["/usr/bin/stat", ...args, path], { timeoutMs: 5000 });
      if (result.exit === 0 && /^[0-7]{3,4}$/.test(result.stdout.trim())) return result.stdout.trim();
    }
    return "unknown";
  };

  check("mkdirp", () => {
    host.mkdirp(root);
    return expect(host.exists(root) && host.stat(root)?.isDirectory === true, "folder missing");
  });
  check("text round trip", () => {
    host.writeAtomic(`${root}/a.txt`, "héllo ✓");
    return expect(host.readText(`${root}/a.txt`) === "héllo ✓", "text differs");
  });
  check("bytes round trip and offset reads", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    host.writeAtomic(`${root}/b.bin`, bytes);
    const tail = host.readBytesFrom(`${root}/b.bin`, 250);
    const past = host.readBytesFrom(`${root}/b.bin`, 300);
    const all = host.readBytesFrom(`${root}/b.bin`, 0);
    const base64 = host.readBase64(`${root}/b.bin`);
    const capped = host.readBytesFrom(`${root}/b.bin`, 10, 4);
    return expect(
      tail.length === 6 && tail[0] === 250 && tail[5] === 255 && past.length === 0 && all.length === 256 && all[255] === 255 && base64.length === 344 && base64.endsWith("/w==") && capped.length === 4 && capped[0] === 10 && capped[3] === 13,
      `tail ${tail.length} past ${past.length} all ${all.length} base64 ${base64.length} capped ${capped.length}`,
    );
  });
  check("writeAtomic replaces in place and never recreates a missing folder", () => {
    host.writeAtomic(`${root}/a.txt`, "second");
    if (host.readText(`${root}/a.txt`) !== "second") return "replace failed";
    const gone = `${root}/gone`;
    return expect(throws(() => host.writeAtomic(`${gone}/x.txt`, "x")) && !host.exists(gone), "folder was recreated or no error");
  });
  check("mkdirExclusive", () => {
    const folder = `${root}/lock`;
    if (!host.mkdirExclusive(folder)) return "first create returned false";
    if (host.mkdirExclusive(folder)) return "second create returned true";
    return expect(throws(() => host.mkdirExclusive(`${root}/no/parent`)), "missing parent did not throw");
  });
  check("move", () => {
    host.writeAtomic(`${root}/m1.txt`, "1");
    host.writeAtomic(`${root}/m2.txt`, "2");
    if (!throws(() => host.move(`${root}/m1.txt`, `${root}/m2.txt`))) return "overwrote an existing target";
    if (!throws(() => host.move(`${root}/m1.txt`, `${root}/no/m3.txt`))) return "moved into a missing folder";
    host.move(`${root}/m1.txt`, `${root}/m3.txt`);
    return expect(!host.exists(`${root}/m1.txt`) && host.readText(`${root}/m3.txt`) === "1", "move did not land");
  });
  check("stat and listDir", () => {
    const info = host.stat(`${root}/b.bin`);
    const names = host.listDir(root);
    return expect(info !== null && info.size === 256 && info.mtimeMs > 0 && names.indexOf("b.bin") >= 0 && host.stat(`${root}/nope`) === null, `stat ${JSON.stringify(info)}`);
  });
  check("changedMs moves when an extended attribute changes and the content does not", () => {
    host.writeAtomic(`${root}/x.txt`, "x");
    const before = host.changedMs(`${root}/x.txt`);
    const mtime = host.stat(`${root}/x.txt`)?.mtimeMs;
    host.sleepMs(50);
    // On a Mac this is the gallery's own case; elsewhere a mode change moves ctime the same way.
    if (host.exists("/usr/bin/xattr")) host.runSync(["/usr/bin/xattr", "-w", "com.apple.metadata:kMDItemDescription", "probe", `${root}/x.txt`]);
    else host.runSync(["/bin/chmod", "640", `${root}/x.txt`]);
    const after = host.changedMs(`${root}/x.txt`);
    return expect(before !== null && after !== null && after > before && host.stat(`${root}/x.txt`)?.mtimeMs === mtime && host.changedMs(`${root}/nope`) === null, `before ${before} after ${after} mtime ${mtime}`);
  });
  check("remove", () => {
    host.writeAtomic(`${root}/r.txt`, "r");
    host.remove(`${root}/r.txt`);
    host.remove(`${root}/never-existed`);
    return expect(!host.exists(`${root}/r.txt`), "file still there");
  });
  check("everything created is private to the user", () => {
    host.mkdirp(`${root}/priv/deep`);
    host.writeAtomic(`${root}/priv/deep/f.txt`, "x");
    host.mkdirExclusive(`${root}/priv/excl`);
    const modes = [modeOf(`${root}/priv`), modeOf(`${root}/priv/deep`), modeOf(`${root}/priv/excl`), modeOf(`${root}/priv/deep/f.txt`)];
    return expect(modes.join(" ") === "700 700 700 600", `folder, nested, exclusive, file: ${modes.join(" ")} (want 700 700 700 600)`);
  });
  check("restrict tightens an existing tree and leaves links alone", () => {
    host.mkdirp(`${root}/loose/sub`);
    host.writeAtomic(`${root}/loose/sub/a.json`, "{}");
    host.writeAtomic(`${root}/outside.txt`, "o");
    host.runSync(["/bin/chmod", "755", `${root}/loose`, `${root}/loose/sub`]);
    host.runSync(["/bin/chmod", "644", `${root}/loose/sub/a.json`, `${root}/outside.txt`]);
    host.runSync(["/bin/ln", "-s", `${root}/outside.txt`, `${root}/loose/link`]);
    host.restrict(`${root}/loose`);
    host.restrict(`${root}/does-not-exist`);
    const modes = [modeOf(`${root}/loose`), modeOf(`${root}/loose/sub`), modeOf(`${root}/loose/sub/a.json`), modeOf(`${root}/outside.txt`)];
    return expect(modes.join(" ") === "700 700 600 644", `tree, sub, file, link target: ${modes.join(" ")} (want 700 700 600 644)`);
  });
  check("runSync output, exit codes, and timeout", () => {
    const echo = host.runSync(["/bin/sh", "-c", "printf out; printf err >&2; exit 3"]);
    if (echo.exit !== 3 || echo.stdout !== "out" || echo.stderr !== "err") return `got ${JSON.stringify(echo)}`;
    const slow = host.runSync(["/bin/sleep", "5"], { timeoutMs: 200 });
    return expect(slow.exit === 124, `timeout exit ${slow.exit}`);
  });
  check("bounded runSync caps stdout, stderr, and files written by the child", () => {
    const options = { maxBytes: 4096, timeoutMs: 5000 };
    const out = host.runSync(["/bin/sh", "-c", "exec /bin/dd if=/dev/zero bs=1024 count=16"], options);
    const err = host.runSync(["/bin/sh", "-c", "exec /bin/dd if=/dev/zero bs=1024 count=16 1>&2"], options);
    const path = `${root}/bounded.out`;
    host.runSync(["/bin/sh", "-c", 'exec /bin/dd if=/dev/zero bs=1024 count=16 > "$1"', "sh", path], options);
    const size = host.stat(path)?.size ?? 0;
    const unicode = host.runSync(["/bin/sh", "-c", "printf 'ééé'"], { maxBytes: 4, timeoutMs: 5000 });
    return expect(out.exit === 63 && err.exit === 63 && unicode.exit === 63 && size > 4096 && size <= 4608, `stdout ${out.exit}, stderr ${err.exit}, UTF-8 ${unicode.exit}, file ${size}`);
  });
  check("supervisor file-size limit works without ticks and records its signal exit", () => {
    const files = { pid: `${root}/bounded.pid`, exit: `${root}/bounded.exit`, stderr: `${root}/bounded.err`, maxBytes: 4096 };
    const out = `${root}/supervised.out`;
    host.spawnSupervised(["/bin/sh", "-c", 'exec /bin/dd if=/dev/zero bs=1024 count=16 > "$1"', "sh", out], files);
    if (!waitFor(host, files.exit, 5000)) return "exit file never appeared";
    const size = host.stat(out)?.size ?? 0;
    return expect(host.readText(files.exit) === "153" && size > 4096 && size <= 4608, `exit ${host.readText(files.exit)}, file ${size}`);
  });
  check("supervisor records pid and exit", () => {
    const ok = supervised(["/bin/sh", "-c", "exit 0"], "ok");
    const bad = supervised(["/bin/sh", "-c", "exit 3"], "bad");
    if (!waitFor(host, ok.exit, 5000) || !waitFor(host, bad.exit, 5000)) return "exit files never appeared";
    const pid = Number(host.readText(ok.pid));
    return expect(host.readText(ok.exit) === "0" && host.readText(bad.exit) === "3" && pid > 1, `exit ${host.readText(ok.exit)}/${host.readText(bad.exit)} pid ${pid}`);
  });
  check("the API key reaches a command on stdin only, never in its environment", () => {
    const previous = host.env.openrouter_api_key;
    host.env.openrouter_api_key = "aichat-probe-secret-123456";
    try {
      const sync = host.runSync(["/bin/sh", "-c", 'cat; printf "|%s" "${openrouter_api_key:-none}"'], { stdin: "from-stdin", timeoutMs: 5000 });
      if (sync.stdout !== "from-stdin|none") return `runSync gave ${JSON.stringify(sync.stdout)}`;
      const files = { pid: `${root}/key.pid`, exit: `${root}/key.exit`, stderr: `${root}/key.stderr`, remove: `${root}/key.body` };
      host.writeAtomic(files.remove, "the conversation");
      host.spawnSupervised(["/bin/sh", "-c", 'cat > "$1"; env > "$2"', "sh", `${root}/key.in`, `${root}/key.env`], files, { stdin: "secret-line\n" });
      if (!waitFor(host, files.exit, 5000)) return "exit file never appeared";
      if (host.readText(`${root}/key.in`) !== "secret-line\n") return `stdin gave ${JSON.stringify(host.readText(`${root}/key.in`))}`;
      const environment = host.readText(`${root}/key.env`);
      if (environment.indexOf("aichat-probe-secret") >= 0 || environment.indexOf("openrouter_api_key") >= 0) return "the key is in the environment of a supervised command";
      if (host.exists(files.remove)) return "the body file was not removed when the command ended";
      const made = modeOf(`${root}/key.in`);
      return expect(made === "600", `a file the command wrote has mode ${made} (want 600)`);
    } finally {
      if (previous === undefined) delete host.env.openrouter_api_key;
      else host.env.openrouter_api_key = previous;
    }
  });
  check("processCommand and signalTerm own a live process", () => {
    const files = supervised(["/bin/sleep", "30"], "sleep");
    if (!waitFor(host, files.pid, 5000)) return "pid file never appeared";
    const pid = Number(host.readText(files.pid));
    const command = host.processCommand(pid);
    if (command === null || command.indexOf("sleep") < 0) return `command ${String(command)}`;
    if (!host.signalTerm(pid)) return "TERM was not delivered";
    if (!waitFor(host, files.exit, 5000)) return "exit file never appeared after TERM";
    const status = Number(host.readText(files.exit));
    return expect(status > 128 && host.processCommand(pid) === null && !host.signalTerm(pid), `status ${status}`);
  });
  check("clock, sleep, and ids", () => {
    const before = host.nowMs();
    host.sleepMs(30);
    const elapsed = host.nowMs() - before;
    const a = host.randomId();
    const b = host.randomId();
    return expect(elapsed >= 25 && elapsed < 2000 && a !== b && a.length >= 16, `elapsed ${elapsed}`);
  });
  check("clipboard reads do not throw", () => {
    const text = host.clipboardText();
    const png = host.clipboardPng();
    if (text !== null && typeof text !== "string") return "text type";
    return expect(png === null || png.length > 0, "png type");
  });
  check("remove deletes for good", () => {
    host.writeAtomic(`${root}/remove-me.txt`, "t");
    host.remove(`${root}/remove-me.txt`);
    return expect(!host.exists(`${root}/remove-me.txt`), "file still in place");
  });
  if (argv.indexOf("--pick") >= 0) {
    check("chooseFiles", () => {
      const picked = host.chooseFiles({ prompt: "Probe: choose one file or cancel" });
      return picked.cancelled ? true : expect(picked.paths.length > 0 && picked.paths[0]!.charAt(0) === "/", "no absolute path");
    });
  }

  host.remove(root);
  const ok = checks.every((item) => item.ok);
  return JSON.stringify({ ok, checks });
}
