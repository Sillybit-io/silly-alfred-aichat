import { argVars, callExternalTrigger, clipboard, connect, conditional, externalTrigger, keyword, MODIFIERS, notification, runScript, scriptFilter, textView, universalAction, type WorkflowDef } from "../../../scripts/lib/plist";

export function fixtureGraph(): WorkflowDef {
  return {
    bundleid: "com.example.fixture",
    name: "Fixture",
    createdby: "Tests",
    description: "A small synthetic graph",
    readme: "",
    webaddress: "https://example.com",
    version: "0.0.1",
    config: [
      { variable: "keyword_main", label: "Keyword", type: "textfield", default: "fix", required: true },
      { variable: "notes", label: "Notes", type: "textarea" },
      { variable: "use_extras", label: "Extras", type: "checkbox", default: true, text: "Use extras" },
      { variable: "mode", label: "Mode", type: "popupbutton", pairs: [["Fast", "fast"], ["Slow", "slow"]] },
      { variable: "folder", label: "Folder", type: "filepicker" },
    ],
    objects: [
      keyword("main keyword", { keyword: "{var:keyword_main}", position: { x: 30, y: 30 } }),
      textView("main view", { scriptfile: "view.js" }),
      universalAction("ask action", { text: true }),
      universalAction("files action", { files: true, multiple: true }),
      argVars("set action", { argument: "{query}", variables: { session_action: "new" } }),
      runScript("act", { scriptfile: "act.js", declares: ["next"] }),
      conditional("route", { variable: "next", outputs: [{ label: "copy", match: "copy" }, { label: "fail", match: "fail" }] }),
      clipboard("copy out"),
      notification("fail out", { title: "Failed", text: "{var:detail}" }),
      scriptFilter("list", { scriptfile: "list.js", keyword: "fixlist" }),
      externalTrigger("trigger view", { triggerid: "view_main" }),
      callExternalTrigger("call view", { triggerid: "view_main" }),
    ],
    connections: [
      connect("main keyword", "main view"),
      connect("main keyword", "set action", { modifiers: MODIFIERS.command, subtext: "New chat" }),
      connect("main keyword", "list", { modifiers: MODIFIERS.option }),
      connect("main view", "act", { modifiers: MODIFIERS.shift, subtext: "Stop", vitoclose: true }),
      connect("ask action", "call view"),
      connect("set action", "act"),
      connect("act", "route"),
      connect("route", "copy out", { output: "copy" }),
      connect("route", "fail out", { output: "fail" }),
      connect("trigger view", "main view"),
    ],
    variables: { detail: "Something went wrong" },
    variablesdontexport: ["notes"],
  };
}
