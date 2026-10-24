import type { MappedError } from "../core/errors";
import { sanitizeMarkdown } from "../core/sanitize";

export type ViewMode = "replace" | "append" | "replacelast";

export type ViewFrame = {
  response: string;
  footer: string;
  mode: ViewMode;
  requestId: string;
  // header, then live once the assistant section exists; empty when idle.
  stage: string;
  rerun?: number;
  // Folders whose pictures the view may show; every other image in the text is shown as its address, never fetched.
  imageRoots?: string[];
};

// The Text View JSON. The typed message is always left selected, so an error never loses it.
// Everything shown passes the sanitizer: the view must never fetch an address that model output or web content chose.
export function viewJson(frame: ViewFrame): string {
  const view: Record<string, unknown> = {
    response: sanitizeMarkdown(frame.response, { imageRoots: frame.imageRoots ?? [] }),
    footer: frame.footer,
    behaviour: { response: frame.mode, scroll: "end", inputfield: "select" },
    variables: { request_id: frame.requestId, view_stage: frame.stage },
  };
  if (frame.rerun !== undefined) view.rerun = frame.rerun;
  return JSON.stringify(view);
}

export function envelope(arg: string, variables: Record<string, string>): string {
  return JSON.stringify({ alfredworkflow: { arg, variables } });
}

// An image request that fails says so first, then the mapped cause.
export function imageError(error: MappedError): MappedError {
  return { title: "Image generation failed", detail: `${error.title}. ${error.detail}`, next: error.next };
}
