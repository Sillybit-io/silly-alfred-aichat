export type ContextInfo = {
  nowMs: number;
  // Minutes behind UTC, as Date.getTimezoneOffset reports it.
  offsetMinutes: number;
  timezone: string | null;
  locale: string | null;
  os: string | null;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const two = (value: number) => String(value).padStart(2, "0");

// "Thursday, 22 October 2026, 16:40 (UTC+03:00, Europe/Istanbul)" computed from the clock and offset alone.
export function formatNow(info: ContextInfo): string {
  const local = new Date(info.nowMs - info.offsetMinutes * 60_000);
  const offset = -info.offsetMinutes;
  const sign = offset < 0 ? "-" : "+";
  const zone = `UTC${sign}${two(Math.floor(Math.abs(offset) / 60))}:${two(Math.abs(offset) % 60)}${info.timezone ? `, ${info.timezone}` : ""}`;
  return `${WEEKDAYS[local.getUTCDay()]}, ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()}, ${two(local.getUTCHours())}:${two(local.getUTCMinutes())} (${zone})`;
}

export function contextLine(info: ContextInfo): string {
  const facts = [`Current date and time: ${formatNow(info)}.`];
  if (info.locale) facts.push(`The user's locale is ${info.locale}.`);
  if (info.os) facts.push(`The user is on macOS ${info.os}.`);
  return facts.join(" ");
}

export const WEB_LINE = "Web search is on. Cite sources inline as Markdown links on the claim they support, and do not add a separate list of sources at the end.";

// The configured prompt, then the live context, then the web rule, each as its own paragraph.
export function composeSystemPrompt(parts: { base: string; context: string | null; web: boolean }): string {
  return [parts.base.trim(), parts.context ?? "", parts.web ? WEB_LINE : ""].filter((part) => part !== "").join("\n\n");
}
