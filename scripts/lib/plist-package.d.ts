declare module "plist" {
  export function parse(xml: string): unknown;
  export function build(value: unknown, options?: { indent?: string; pretty?: boolean; newline?: string }): string;
}
