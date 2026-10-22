import { BunHost } from "../../../src/host/bun";
import { mutateChat } from "../../../src/store/chats";

const [data, id, count, label] = process.argv.slice(2) as [string, string, string, string];
const host = new BunHost({ env: { ...process.env, alfred_workflow_data: data } });
for (let i = 0; i < Number(count); i++) {
  mutateChat(host, id, (chat) => {
    chat.messages.push({ id: `${label}-${i}`, requestId: `${label}-${i}`, role: "user", content: `${label} ${i}`, attachments: [], status: "ok", createdAt: host.nowMs() });
  });
}
