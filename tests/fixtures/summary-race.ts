import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunHost } from "../../src/host/bun";
import { chatDir, listSummaries } from "../../src/store/chats";
import { applyHistoryAction } from "../../src/app/history-action";

const [dir, mode, id] = process.argv.slice(2) as [string, string, string];
class PausedHost extends BunHost {
  writeAtomic(path: string, data: string | Uint8Array): void {
    if (mode === "write" && path.endsWith("/summaries.json")) {
      writeFileSync(join(dir, "writer-ready"), "1");
      const deadline = Date.now() + 5000;
      while (!existsSync(join(dir, "resume"))) {
        if (Date.now() > deadline) throw new Error("writer was never resumed");
        this.sleepMs(10);
      }
    }
    super.writeAtomic(path, data);
  }
  mkdirExclusive(path: string): boolean {
    const acquired = super.mkdirExclusive(path);
    if (!acquired && mode === "delete" && path.endsWith("/.summaries.lock")) writeFileSync(join(dir, "delete-waiting"), "1");
    return acquired;
  }
}
const host = new PausedHost({ env: { alfred_workflow_data: join(dir, "data"), alfred_workflow_cache: join(dir, "cache") } });
if (mode === "write") listSummaries(host);
else applyHistoryAction(host, "delete", chatDir(host, id));
