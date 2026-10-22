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
    return expect(
      tail.length === 6 && tail[0] === 250 && tail[5] === 255 && past.length === 0 && all.length === 256 && all[255] === 255,
      `tail ${tail.length} past ${past.length} all ${all.length}`,
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
  check("remove", () => {
    host.writeAtomic(`${root}/r.txt`, "r");
    host.remove(`${root}/r.txt`);
    host.remove(`${root}/never-existed`);
    return expect(!host.exists(`${root}/r.txt`), "file still there");
  });
  check("runSync output, exit codes, and timeout", () => {
    const echo = host.runSync(["/bin/sh", "-c", "printf out; printf err >&2; exit 3"]);
    if (echo.exit !== 3 || echo.stdout !== "out" || echo.stderr !== "err") return `got ${JSON.stringify(echo)}`;
    const slow = host.runSync(["/bin/sleep", "5"], { timeoutMs: 200 });
    return expect(slow.exit === 124, `timeout exit ${slow.exit}`);
  });
  check("supervisor records pid and exit", () => {
    const ok = supervised(["/bin/sh", "-c", "exit 0"], "ok");
    const bad = supervised(["/bin/sh", "-c", "exit 3"], "bad");
    if (!waitFor(host, ok.exit, 5000) || !waitFor(host, bad.exit, 5000)) return "exit files never appeared";
    const pid = Number(host.readText(ok.pid));
    return expect(host.readText(ok.exit) === "0" && host.readText(bad.exit) === "3" && pid > 1, `exit ${host.readText(ok.exit)}/${host.readText(bad.exit)} pid ${pid}`);
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
  check("trash", () => {
    host.writeAtomic(`${root}/trash-me.txt`, "t");
    host.trash(`${root}/trash-me.txt`);
    return expect(!host.exists(`${root}/trash-me.txt`), "file still in place");
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
