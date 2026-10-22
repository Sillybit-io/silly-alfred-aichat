import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunHost } from "../../../src/host/bun";
import { admit, advance, finalize, finalizeDue, stop, tick, type Finalizers } from "../../../src/store/requests";

// One request-store call per process, so every step of a test runs after the previous process exited.
const [data, command, json = "{}"] = process.argv.slice(2) as [string, string, string?];
const args = JSON.parse(json);
const host = new BunHost({ env: { ...process.env, alfred_workflow_data: data, alfred_workflow_cache: join(data, "../cache") } });
const finalizers: Finalizers = {
  image: (_h, record, outcome) => writeFileSync(join(data, `finalized-image-${record.id}.json`), JSON.stringify({ meta: record.meta, outcome })),
  title: (_h, record, outcome) => writeFileSync(join(data, `finalized-title-${record.id}.json`), JSON.stringify({ meta: record.meta, outcome })),
};

let result: unknown;
switch (command) {
  case "admit":
    result = admit(
      host,
      {
        lane: args.lane,
        kind: args.kind ?? "chat",
        chatId: args.chatId ?? null,
        model: args.model ?? "test/model",
        draft: { text: args.text ?? "hello", attachments: args.attachments ?? [] },
        body: args.body ?? JSON.stringify({ model: "test/model", messages: [{ role: "user", content: args.text ?? "hello" }], stream: args.stream !== false }),
        url: args.url,
        apiKey: "test-key",
        stream: args.stream !== false,
        timeoutSeconds: args.timeoutSeconds ?? 30,
        takePending: args.takePending ?? false,
        meta: args.meta,
      },
      finalizers,
    );
    break;
  case "tick":
    result = tick(host, args.rid);
    break;
  case "advance":
    result = advance(host, args.rid, finalizers);
    break;
  case "finalize":
    result = finalize(host, args.rid, finalizers);
    break;
  case "finalizeDue":
    result = finalizeDue(host, finalizers, args.lane);
    break;
  case "stop":
    result = stop(host, args.rid);
    break;
  default:
    throw new Error(`unknown command ${command}`);
}
console.log(JSON.stringify(result ?? null));
