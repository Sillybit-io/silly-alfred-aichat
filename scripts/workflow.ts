import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pkg from "../package.json";
import { DEFAULT_PRESETS } from "../src/core/presets";
import {
  argVars,
  callExternalTrigger,
  clipboard,
  conditional,
  connect,
  externalTrigger,
  keyword,
  largeType,
  COMMAND_OPTION,
  MODIFIERS,
  notification,
  revealFile,
  runScript,
  scriptFilter,
  serialize,
  textView,
  universalAction,
  type ConfigField,
  type Connection,
  type ObjectDef,
  type WorkflowDef,
} from "./lib/plist";

const root = resolve(import.meta.dir, "..");
export const REPOSITORY = "https://github.com/Sillybit-io/silly-alfred-aichat";

export type Edge = { from: string; to: string; modifiers?: number; subtext?: string; vitoclose?: boolean; output?: string };
export type Route = { id: string; row: string; edges: Edge[] };

const { none, shift, control, option, command } = MODIFIERS;

// One entry per row of the Design routing contract; the connections below are generated from these edges.
export const ROUTES: Route[] = [
  {
    id: "R01",
    row: "chat list (and its alias) ↩ ⌘↩ ⌥↩ ⌃↩ → root-action.js → routed outputs",
    edges: [
      ...["root list", "root alias list"].flatMap((from) => [
        { from, to: "root script" },
        { from, to: "root script", modifiers: command, subtext: "Archive, or start a new chat" },
        { from, to: "root script", modifiers: option, subtext: "Pin or unpin" },
        { from, to: "root script", modifiers: control, subtext: "Delete permanently" },
      ]),
      { from: "root script", to: "root route" },
    ],
  },
  {
    id: "R02",
    row: "root route → view_chat, the chat list, models, presets, image, or all chats",
    edges: [
      { from: "root route", to: "call view_chat", output: "view" },
      { from: "root route", to: "call show_root", output: "root" },
      { from: "root route", to: "call show_models", output: "models" },
      { from: "root route", to: "call show_presets", output: "presets" },
      { from: "root route", to: "call show_image", output: "image" },
      { from: "root route", to: "call show_history", output: "history" },
    ],
  },
  {
    id: "R03",
    row: "External Triggers show_root, show_models, show_presets, show_image → their lists",
    edges: [
      { from: "trigger show_root", to: "root list" },
      { from: "trigger show_models", to: "models list" },
      { from: "trigger show_presets", to: "presets list" },
      { from: "trigger show_image", to: "image view" },
    ],
  },
  {
    id: "R04",
    row: "chat Text View ↩ → chat.js again; ⌘⌥↩ → back to the chat list",
    edges: [{ from: "chat view", to: "call show_root", modifiers: COMMAND_OPTION, subtext: "Back to the chat list", vitoclose: true }],
  },
  { id: "R05", row: "chat Text View ⇧↩ → stop → session.js → view_chat", edges: [{ from: "chat view", to: "session stop vars", modifiers: shift, subtext: "Stop the reply", vitoclose: true }, { from: "session stop vars", to: "session script" }] },
  {
    id: "R06",
    row: "chat Text View ⌘↩ → new chat → session.js → view_chat",
    edges: [
      { from: "chat view", to: "session new vars", modifiers: command, subtext: "Start a new chat", vitoclose: true },
      { from: "session new vars", to: "session script" },
      { from: "session script", to: "call view_chat" },
    ],
  },
  {
    id: "R07",
    row: "chat Text View ⌥↩ / ⌃↩ → copy.js → Copy to Clipboard",
    edges: [
      { from: "chat view", to: "copy last vars", modifiers: option, subtext: "Copy the last reply" },
      { from: "chat view", to: "copy all vars", modifiers: control, subtext: "Copy the whole chat" },
      { from: "copy last vars", to: "copy script" },
      { from: "copy all vars", to: "copy script" },
      { from: "copy script", to: "copy reply" },
    ],
  },
  { id: "R08", row: "Ask AI ↩ → view_chat", edges: [{ from: "ask text action", to: "ask pass vars" }, { from: "ask pass vars", to: "call view_chat" }] },
  { id: "R09", row: "Ask AI ⌘↩ → new chat → session.js → view_chat", edges: [{ from: "ask text action", to: "session new vars", modifiers: command, subtext: "Start a new chat" }] },
  {
    id: "R10",
    row: "Ask AI about files ↩ / ⌘↩ → attach.js → view_chat",
    edges: [
      { from: "ask files action", to: "attach script" },
      { from: "ask files action", to: "attach new vars", modifiers: command, subtext: "Attach to a new chat" },
      { from: "attach new vars", to: "attach script" },
      { from: "attach script", to: "call view_chat" },
    ],
  },
  {
    id: "R11",
    row: "Run a preset… ↩ → presets list; each default preset's own action → preset-run.js",
    edges: [
      { from: "preset action", to: "preset input vars" },
      { from: "preset input vars", to: "presets list" },
      ...DEFAULT_PRESETS.flatMap((preset) => [
        { from: `preset action ${preset.id}`, to: `preset vars ${preset.id}` },
        { from: `preset vars ${preset.id}`, to: "preset script" },
      ]),
    ],
  },
  {
    id: "R12",
    row: "presets ↩ → preset-run.js → routed outputs",
    edges: [
      { from: "presets list", to: "preset script" },
      { from: "preset script", to: "preset route" },
      { from: "preset route", to: "session new vars", output: "textview" },
      { from: "preset route", to: "preset copy", output: "clipboard" },
      { from: "preset route", to: "preset paste", output: "paste" },
      { from: "preset route", to: "preset large type", output: "largetype" },
      { from: "preset route", to: "preset error note", output: "error" },
      { from: "preset route", to: "preset result view", output: "view" },
      { from: "preset result view", to: "copy preset vars", modifiers: command, subtext: "Copy to the clipboard", vitoclose: true },
      { from: "preset result view", to: "call show_root", modifiers: COMMAND_OPTION, subtext: "Back to the chat list", vitoclose: true },
      { from: "copy preset vars", to: "copy script" },
    ],
  },
  {
    id: "R13",
    row: "aimodels ↩ ⌘↩ ⌥↩ ⌃↩ → model-action.js → routed outputs",
    edges: [
      { from: "models list", to: "model script" },
      { from: "models list", to: "model script", modifiers: command, subtext: "Make this the default model" },
      { from: "models list", to: "model script", modifiers: option, subtext: "Add or remove a favorite" },
      { from: "models list", to: "model script", modifiers: control, subtext: "Copy the model id" },
      { from: "model script", to: "model route" },
      { from: "model route", to: "call view_chat", output: "view" },
      { from: "model route", to: "model notice", output: "notify" },
      { from: "model route", to: "model copy", output: "clipboard" },
    ],
  },
  {
    id: "R14",
    row: "history ↩ ⌘↩ ⌥↩ ⌃↩ → history-action.js → routed outputs",
    edges: [
      { from: "history list", to: "history script" },
      { from: "history list", to: "history script", modifiers: command, subtext: "Archive or restore" },
      { from: "history list", to: "history script", modifiers: option, subtext: "Pin or unpin" },
      { from: "history list", to: "history script", modifiers: control, subtext: "Delete permanently" },
      { from: "history script", to: "history route" },
      { from: "history route", to: "call view_chat", output: "view" },
      { from: "history route", to: "call show_history", output: "list" },
    ],
  },
  { id: "R15", row: "aiimage ↩ → image Text View", edges: [{ from: "image keyword", to: "image view" }] },
  { id: "R16", row: "image Text View ⌥↩ → image-last.js → Reveal in Finder", edges: [
      { from: "image view", to: "image last script", modifiers: option, subtext: "Reveal the newest image" },
      { from: "image last script", to: "reveal image" },
      { from: "image view", to: "open image script", modifiers: command, subtext: "Open the newest image" },
      { from: "image view", to: "call show_root", modifiers: COMMAND_OPTION, subtext: "Back to the chat list", vitoclose: true },
    ] },
  { id: "R17", row: "External Trigger view_chat → chat Text View", edges: [{ from: "trigger view_chat", to: "chat view" }] },
  { id: "R18", row: "External Trigger show_history → history list", edges: [{ from: "trigger show_history", to: "history list" }] },
];

function at(column: number, row: number): { position: { x: number; y: number } } {
  return { position: { x: 30 + column * 230, y: 30 + row * 130 } };
}

function objects(): ObjectDef[] {
  return [
    scriptFilter("root list", { scriptfile: "root.js", keyword: "{var:keyword_chat}", title: "AI Chat", subtext: "Continue, start a chat, or open a recent one", ...at(0, 21) }),
    scriptFilter("root alias list", { scriptfile: "root.js", keyword: "{var:keyword_chat_alias}", title: "AI Chat", subtext: "Continue, start a chat, or open a recent one", ...at(0, 22) }),
    runScript("root script", { scriptfile: "root-action.js", declares: ["root_next", "notice", "request_id", "view_stage", "attach_notice"], ...at(1, 21) }),
    conditional("root route", { variable: "root_next", outputs: ["view", "root", "models", "presets", "image", "history"].map((label) => ({ label, match: label })), ...at(2, 21) }),
    callExternalTrigger("call show_root", { triggerid: "show_root", ...at(3, 20) }),
    callExternalTrigger("call show_models", { triggerid: "show_models", ...at(3, 21) }),
    callExternalTrigger("call show_presets", { triggerid: "show_presets", ...at(3, 22) }),
    callExternalTrigger("call show_image", { triggerid: "show_image", ...at(3, 23) }),
    externalTrigger("trigger show_root", { triggerid: "show_root", ...at(0, 24) }),
    externalTrigger("trigger show_models", { triggerid: "show_models", ...at(0, 25) }),
    externalTrigger("trigger show_presets", { triggerid: "show_presets", ...at(0, 26) }),
    externalTrigger("trigger show_image", { triggerid: "show_image", ...at(0, 27) }),
    textView("chat view", {
      scriptfile: "chat.js",
      config: { footertext: "↩ Send · ⌘↩ New · ⌥↩ Copy · ⌃↩ Copy all · ⇧↩ Stop · ⌘⌥↩ Chats", loadingtext: "Connecting…" },
      ...at(1, 0),
    }),
    argVars("session new vars", { argument: "{query}", variables: { session_action: "new" }, ...at(1, 1) }),
    argVars("session stop vars", { argument: "", variables: { session_action: "stop" }, ...at(1, 2) }),
    runScript("session script", { scriptfile: "session.js", declares: ["request_id", "view_stage", "session_action"], ...at(2, 1) }),
    callExternalTrigger("call view_chat", { triggerid: "view_chat", ...at(3, 1) }),
    argVars("copy last vars", { argument: "", variables: { copy_mode: "last" }, ...at(2, 3) }),
    argVars("copy all vars", { argument: "", variables: { copy_mode: "all" }, ...at(2, 4) }),
    runScript("copy script", { scriptfile: "copy.js", ...at(3, 3) }),
    clipboard("copy reply", { text: "{query}", ...at(4, 3) }),
    universalAction("ask text action", { title: "AI Chat: Ask about this text", text: true, ...at(0, 5) }),
    argVars("ask pass vars", { argument: "{query}", variables: { request_id: "", view_stage: "" }, ...at(1, 5) }),
    universalAction("ask files action", { title: "AI Chat: Ask about these files", files: true, multiple: true, ...at(0, 6) }),
    argVars("attach new vars", { argument: "{query}", variables: { attach_mode: "new" }, ...at(1, 6) }),
    runScript("attach script", { scriptfile: "attach.js", declares: ["request_id", "view_stage", "attach_notice"], ...at(2, 6) }),
    ...DEFAULT_PRESETS.flatMap((preset, i) => [
      universalAction(`preset action ${preset.id}`, { title: `AI Chat: ${preset.name}`, text: true, ...at(7, 8 + i) }),
      argVars(`preset vars ${preset.id}`, { argument: "{query}", variables: { preset_id: preset.id }, ...at(8, 8 + i) }),
    ]),
    universalAction("preset action", { title: "AI Chat: Run a preset…", text: true, ...at(0, 8) }),
    argVars("preset input vars", { argument: "", variables: { preset_text: "{query}" }, ...at(1, 8) }),
    scriptFilter("presets list", { scriptfile: "presets.js", keyword: "{var:keyword_presets}", title: "AI Preset", subtext: "Run a prompt preset on the selected or copied text", ...at(2, 8) }),
    runScript("preset script", { scriptfile: "preset-run.js", declares: ["preset_output", "preset_error", "session_action"], ...at(3, 8) }),
    conditional("preset route", { variable: "preset_output", outputs: ["textview", "clipboard", "paste", "largetype", "error", "view"].map((label) => ({ label, match: label })), ...at(4, 8) }),
    textView("preset result view", { scriptfile: "preset-view.js", config: { footertext: "⌘↩ Copy · ⌘⌥↩ Chats", loadingtext: "Running…" }, ...at(5, 11) }),
    argVars("copy preset vars", { argument: "", variables: { copy_mode: "preset" }, ...at(6, 11) }),
    clipboard("preset copy", { text: "{query}", ...at(5, 7) }),
    clipboard("preset paste", { text: "{query}", autopaste: true, ...at(5, 8) }),
    largeType("preset large type", { text: "{query}", ...at(5, 9) }),
    notification("preset error note", { title: "AI Preset", text: "{var:preset_error}", ...at(5, 10) }),
    scriptFilter("models list", { scriptfile: "models.js", keyword: "{var:keyword_models}", title: "AI Models", subtext: "Search OpenRouter models", ...at(0, 12) }),
    runScript("model script", { scriptfile: "model-action.js", declares: ["model_next", "notice"], ...at(1, 12) }),
    conditional("model route", { variable: "model_next", outputs: ["view", "notify", "clipboard"].map((label) => ({ label, match: label })), ...at(2, 12) }),
    notification("model notice", { title: "AI Models", text: "{var:notice}", ...at(3, 13) }),
    clipboard("model copy", { text: "{query}", ...at(3, 14) }),
    scriptFilter("history list", { scriptfile: "history.js", title: "AI Chat History", subtext: "↩ Open · ⌘↩ Archive · ⌥↩ Pin · ⌃↩ Delete", ...at(0, 16) }),
    runScript("history script", { scriptfile: "history-action.js", declares: ["history_next", "notice"], ...at(1, 16) }),
    conditional("history route", { variable: "history_next", outputs: ["view", "list"].map((label) => ({ label, match: label })), ...at(2, 16) }),
    callExternalTrigger("call show_history", { triggerid: "show_history", ...at(3, 17) }),
    keyword("image keyword", { keyword: "{var:keyword_image}", title: "AI Image", subtext: "Generate an image", argument: "optional", ...at(0, 19) }),
    textView("image view", {
      scriptfile: "image.js",
      config: { footertext: "↩ Generate · ⌘↩ Open · ⌥↩ Reveal · ⌘⌥↩ Chats", loadingtext: "Generating…" },
      ...at(1, 19),
    }),
    runScript("image last script", { scriptfile: "image-last.js", ...at(2, 19) }),
    runScript("open image script", { scriptfile: "open-image.js", ...at(2, 20) }),
    revealFile("reveal image", { path: "{query}", ...at(3, 19) }),
    externalTrigger("trigger view_chat", { triggerid: "view_chat", ...at(0, 3) }),
    externalTrigger("trigger show_history", { triggerid: "show_history", ...at(0, 17) }),
  ];
}

const NUMBER_HELP = "A whole number.";

export const DEFAULT_SYSTEM_PROMPT = [
  "You are a capable, honest assistant that the user reaches from Alfred on their Mac.",
  "Put the answer first and keep it concise; skip preambles, apologies, and closing offers.",
  "Format with Markdown, and put code in fenced blocks that name the language. Do not use tables, because the view cannot show them; use short lists instead.",
  "Reply in the language the user writes in and match their tone.",
  "If a request is ambiguous, ask one short clarifying question instead of guessing.",
  "If you are unsure or do not know, say so rather than inventing facts, names, or links.",
  "When files or images are attached, refer to them by name.",
].join(" ");

function fields(): ConfigField[] {
  return [
    { variable: "openrouter_api_key", label: "OpenRouter API Key", type: "textfield", required: true, description: "Get one at https://openrouter.ai/keys" },
    { variable: "keyword_chat", label: "Chat Keyword", type: "textfield", default: "aichat", required: true },
    { variable: "keyword_chat_alias", label: "Chat Alias Keyword", type: "textfield", default: "", description: "Optional second keyword for the chat list, for example chat." },
    { variable: "keyword_models", label: "Models Keyword", type: "textfield", default: "aimodels", required: true },
    { variable: "keyword_presets", label: "Presets Keyword", type: "textfield", default: "aipresets", required: true },
    { variable: "keyword_image", label: "Image Keyword", type: "textfield", default: "aiimage", required: true },
    { variable: "default_model", label: "Default Model", type: "textfield", default: "anthropic/claude-sonnet-5.5", placeholder: "vendor/model", description: "Used by chats that have no model of their own. Change it with the aimodels keyword." },
    { variable: "privacy_mode", label: "Provider Privacy", type: "popupbutton", default: "deny", pairs: [["No data collection (recommended)", "deny"], ["Zero data retention only", "zdr"], ["Standard (any provider your account allows)", "standard"]], description: "Which providers may see your messages. Some models have no provider under the stricter choices. Image generation follows your OpenRouter privacy settings." },
    { variable: "system_prompt", label: "System Prompt", type: "textarea", default: DEFAULT_SYSTEM_PROMPT, description: "Sent at the start of every chat. Leave empty to send none." },
    { variable: "system_context", label: "System Context", type: "checkbox", default: true, text: "Add the current date, time, timezone, and macOS version to the system prompt" },
    { variable: "max_context", label: "Messages Sent as Context", type: "textfield", default: "20", description: NUMBER_HELP },
    { variable: "timeout_seconds", label: "Stall Timeout (seconds)", type: "textfield", default: "90", description: "A reply that sends no data for this long is ended and its text kept." },
    { variable: "pdf_engine", label: "PDF Engine", type: "popupbutton", default: "auto", pairs: [["Auto (native, else free parser)", "auto"], ["Free parser", "free"], ["OCR (billed per page)", "ocr"], ["Native only", "native"]] },
    { variable: "web_default", label: "Web Search", type: "checkbox", default: false, text: "Turn web search on in new chats (billed separately by OpenRouter)" },
    { variable: "web_max_results", label: "Web Search Results", type: "textfield", default: "5", description: NUMBER_HELP },
    { variable: "web_rewrite", label: "Web Follow-ups", type: "checkbox", default: true, text: "Rewrite a follow-up into a standalone search with one small extra request (it carries the chat so far)" },
    { variable: "reasoning_default", label: "Reasoning Effort", type: "popupbutton", default: "model", pairs: [["Model default", "model"], ["Off", "off"], ["Low", "low"], ["Medium", "medium"], ["High", "high"]] },
    { variable: "keep_reasoning", label: "Reasoning", type: "checkbox", default: false, text: "Keep the reasoning under each reply" },
    { variable: "preset_clipboard", label: "Preset Results", type: "checkbox", default: false, text: "Let presets copy or paste their result (otherwise it is shown, and ⌘↩ copies it)" },
    { variable: "auto_titles", label: "Titles", type: "checkbox", default: true, text: "Name new chats automatically" },
    { variable: "title_model", label: "Title Model", type: "textfield", default: "anthropic/claude-haiku-5.5", placeholder: "vendor/model" },
    { variable: "translate_language", label: "Translate Language", type: "textfield", default: "English", description: "The language the Translate preset writes in." },
    { variable: "export_folder", label: "Export Folder", type: "textfield", default: "~/Documents/AI Chat", description: "Where /export saves Markdown files." },
    { variable: "images_folder", label: "Images Folder", type: "textfield", default: "~/Pictures/AI Chat", description: "Where generated images are saved." },
    { variable: "image_model", label: "Image Model", type: "textfield", default: "krea/krea-2-medium-turbo", placeholder: "vendor/model" },
    { variable: "image_save_prompt", label: "Image Prompts", type: "checkbox", default: false, text: "Save the prompt inside each image file (it travels with the file when you share it, and Spotlight indexes it)" },
    { variable: "image_timeout_seconds", label: "Image Timeout (seconds)", type: "textfield", default: "300", description: NUMBER_HELP },
    { variable: "vision_fallback_model", label: "Vision Fallback Model", type: "textfield", default: "google/gemini-3.8-flash", placeholder: "vendor/model", description: "Used for a request when the chat model cannot read the images or PDFs in it." },
    { variable: "retention_days", label: "Delete Chats After (days)", type: "textfield", default: "0", description: "0 keeps every chat. Pinned chats are never deleted; the others are deleted for good." },
    { variable: "max_chats", label: "Keep At Most (chats)", type: "textfield", default: "0", description: "0 means no limit." },
    { variable: "text_attachment_max_kb", label: "Text File Limit (KB)", type: "textfield", default: "200", description: "Larger text files are not attached." },
    { variable: "image_max_edge", label: "Image Longest Edge (px)", type: "textfield", default: "2048", description: "Larger PNG and JPEG images are scaled down before sending." },
  ];
}

export function buildConnections(): Connection[] {
  return ROUTES.flatMap((route) => route.edges.map((edge) => connect(edge.from, edge.to, { modifiers: edge.modifiers ?? none, subtext: edge.subtext, vitoclose: edge.vitoclose, output: edge.output })));
}

export function buildWorkflow(): WorkflowDef {
  const connections: Connection[] = [];
  const seen = new Set<string>();
  for (const connection of buildConnections()) {
    const key = `${connection.from}|${connection.to}|${connection.modifiers}|${connection.output ?? ""}`;
    if (!seen.has(key)) connections.push(connection);
    seen.add(key);
  }
  return {
    bundleid: "com.sillybit.aichat",
    name: "AI Chat",
    createdby: "Sillybit",
    description: "Chat with any OpenRouter model, send images and PDFs, run prompt presets, and generate images.",
    readme: readFileSync(resolve(root, "docs/about.md"), "utf8"),
    webaddress: REPOSITORY,
    version: pkg.version,
    objects: objects(),
    connections,
    config: fields(),
    variablesdontexport: ["openrouter_api_key"],
  };
}

export function renderPlist(): string {
  return serialize(buildWorkflow(), { scriptDir: resolve(root, "Workflow") });
}

if (import.meta.main) {
  const target = resolve(root, "Workflow/info.plist");
  writeFileSync(target, renderPlist());
  console.log(`wrote ${target}`);
}
