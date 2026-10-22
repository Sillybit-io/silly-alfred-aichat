import { BunHost } from "../../../src/host/bun";

// Starts a supervised command and exits at once, like an osascript run that returns while curl still works.
const [out, headers, pid, exit, stderr, url] = process.argv.slice(2) as [string, string, string, string, string, string];
new BunHost().spawnSupervised(["curl", "-o", out, "-D", headers, "--silent", "--show-error", "--connect-timeout", "15", url], { pid, exit, stderr });
process.exit(0);
