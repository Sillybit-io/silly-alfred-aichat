export type ParsedCommand = { name: string; args: string };

// "/model gpt" -> { name: "model", args: "gpt" }; plain text and a lone "/" are not commands.
export function parseCommand(text: string): ParsedCommand | null {
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), args: (match[2] ?? "").trim() };
}

export type BuiltinCommand = { name: string; usage: string; help: string };

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: "help", usage: "/help", help: "List the commands" },
  { name: "new", usage: "/new", help: "Start a new chat" },
  { name: "retry", usage: "/retry", help: "Send the last failed message again" },
];

export type HelpEntry = { usage: string; help: string };

export function renderHelp(entries: HelpEntry[]): string {
  const lines = entries.map((entry) => `- \`${entry.usage}\` — ${entry.help}`);
  return ["**Commands**", ...lines, "", "Anything else you type is sent to the model."].join("\n");
}
