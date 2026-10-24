// Test hooks: `aichat_api_base` and `aichat_curl` point the workflow at a local server or a fake curl. They exist only in
// builds made for tests and for `bun run dev`. scripts/build.ts defines __AICHAT_RELEASE__ as true for the bundles that
// ship, where the hooks are removed: no environment variable can redirect the API key or the conversation to another
// address or program, and every request goes to OpenRouter over https through /usr/bin/curl.
declare const __AICHAT_RELEASE__: boolean | undefined;

export const TEST_HOOKS: boolean = typeof __AICHAT_RELEASE__ === "undefined" || __AICHAT_RELEASE__ !== true;
