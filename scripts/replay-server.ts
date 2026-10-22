import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Replays tests/fixtures/http/<name>/: a request to <base>/chat/completions is answered from
// chat_completions.<ext> (.sse or .json), with optional chat_completions.status and
// chat_completions.headers files (one "Name: value" per line). A second argument names a file that
// receives one "METHOD /path" line per request.
export function startReplayServer(dir: string | null, logPath?: string) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch(request) {
      if (logPath) appendFileSync(logPath, `${request.method} ${new URL(request.url).pathname}\n`);
      const route = new URL(request.url).pathname.replace(/^\/+/, "").replace(/^v1\//, "").replace(/\//g, "_");
      if (dir === null || route === "") return new Response("no fixture", { status: 404 });
      const files = existsSync(dir) ? readdirSync(dir) : [];
      const body = files.find((file) => file.startsWith(`${route}.`) && /\.(sse|json|txt)$/.test(file));
      if (!body) return new Response(`no fixture for ${route}`, { status: 404 });
      const headers = new Headers({ "content-type": body.endsWith(".sse") ? "text/event-stream" : "application/json" });
      const headerFile = join(dir, `${route}.headers`);
      if (existsSync(headerFile)) {
        for (const line of readFileSync(headerFile, "utf8").split("\n")) {
          const split = line.indexOf(":");
          if (split > 0) headers.set(line.slice(0, split).trim(), line.slice(split + 1).trim());
        }
      }
      const statusFile = join(dir, `${route}.status`);
      const status = existsSync(statusFile) ? Number(readFileSync(statusFile, "utf8").trim()) : 200;
      return new Response(readFileSync(join(dir, body)), { status, headers });
    },
  });
}

// Run on its own, so a script that blocks on curl (the sync models fetch) never starves it.
if (import.meta.main) {
  const server = startReplayServer(process.argv[2] ? process.argv[2] : null, process.argv[3]);
  console.log(server.port);
}
