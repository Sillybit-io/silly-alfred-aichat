export function defineEntry(main: (argv: string[]) => string): void {
  __aichat_main = main;
}
