import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Serves <dir>/<domain>.ico for GET /<domain>.ico, logs each requested path, and prints its port.
const [dir, log] = process.argv.slice(2) as [string, string];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const path = new URL(request.url).pathname;
    appendFileSync(log, `${path}\n`);
    const file = join(dir, path.replace(/^\/+/, ""));
    return existsSync(file) ? new Response(readFileSync(file)) : new Response("missing", { status: 404 });
  },
});
console.log(server.port);
