import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Serves <dir>/body.json with the status in <dir>/status (read per request), and prints its port.
const dir = process.argv[2]!;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch() {
    const statusFile = join(dir, "status");
    const status = existsSync(statusFile) ? Number(readFileSync(statusFile, "utf8").trim()) : 200;
    return new Response(readFileSync(join(dir, "body.json")), { status, headers: { "content-type": "application/json" } });
  },
});
console.log(server.port);
