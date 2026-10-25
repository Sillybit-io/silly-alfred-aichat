## Unreleased

**Faster**

- A streaming reply no longer starts a `ps` process or reads the whole model list on every update, and its saved state is written only when something arrived.
- Images and PDFs reach the request without passing through JavaScript, and attaching a large file uses far less memory.
- The chat lists read only the chats that changed since the last keystroke, and the image gallery no longer runs `xattr` once per picture each time.

**Security and privacy**

- Responses are capped in size (32 MB, 512 MB for images) on every supported macOS, also while the chat window is closed, and need TLS 1.2 or newer.
- An SVG from an image model is shown in Finder instead of opened, because its default app can run the scripts it holds.
- The last preset reply is no longer shown after an hour, and is deleted the next time the workflow runs after that.
- Attached file names cannot break out of the text they are quoted in, the footer is always one plain line, and history actions accept only real chat ids.
- The Titles setting says it sends the first message and reply, and the README and FAQ say that a synced Alfred preferences folder syncs the API key too.
- Releases are built in a job that cannot write to the repository, and the package carries build provenance that `gh attestation verify` checks.

## 0.1.1 — 2026-10-24

**Security and privacy**

- The API key reaches `curl` on standard input (`-K -`), so it is no longer in any command line, and the long-running request does not inherit it in its environment. A key with a line break or control character is refused with a clear message.
- Replies can no longer make the view fetch anything: images are shown as `🖼 image not loaded: <address>`, HTML is shown as text, and only `https` links stay, with tracking parameters removed and the site named after them. Copies, exports, and preset results are cleaned the same way.
- Provider Privacy setting: every chat request asks for providers that do not collect data (default), for zero data retention only, or is left standard. Web Follow-ups can be turned off, next to Titles.
- Chat data is private to you: folders `700`, files `600`, applied to existing data on the first run. The request file that holds the conversation is deleted as soon as the request ends, and request folders that nothing will pick up are swept. A reply that finished while the window was closed waits for your next visit, however long that is.
- Deleting a chat asks first and then erases it for good instead of using the Trash. Retention removes chats the same way.
- Generated images no longer carry their prompt in the file unless Image Prompts is turned on.
- Site icons are gone, along with the lookup that sent each cited site to a third party.
- Only `https` is used, also across redirects. The test hooks that could redirect requests are switched off in the shipped bundles, which always use OpenRouter and `/usr/bin/curl`.
- The release workflow pins its actions to commit SHAs, audits the dependencies, and publishes a SHA-256 checksum; Dependabot keeps the pins current.

## 0.1.0 — 2026-10-22

- Streaming chat in an Alfred Text View with stop, reopen, retry, and copy actions.
- Images, PDFs, and text files by Universal Action, file picker, or clipboard, with a snapshot kept per chat.
- Model search with prices and badges, favorites, a default model, and a model per chat.
- Reasoning shown while it streams, `/think` effort, and per-chat web search.
- Prompt presets with Text View, clipboard, paste, and Large Type outputs.
- Chat history with automatic titles, pin, archive, Markdown export, and optional retention.
- Image generation from `aiimage` and `/image`, with its file path in the view, `/reveal` to show it in Finder, and `krea/krea-2-medium-turbo` as the default model.
- The `aichat` keyword opens a list: Continue, New chat, recent chats, and shortcuts to models, presets, and images. An optional alias keyword is available.
- Web search sources shown as one line of short links, with `/sources` for the full list and an experimental setting for site icons.
- A fuller default system prompt, with the current date, time, timezone, and macOS version added to each request.
- A clear message when an OpenRouter data policy leaves no provider for a model, and `#imagegen` to find image models.
- Universal Actions are named "AI Chat: …" so they are easy to find, the chat view lists files that are ready to send, and a file passed to the chat list can be attached from it.
- Each default preset is its own Universal Action (**AI Chat: Translate** and so on), next to **AI Chat: Run a preset…** for all presets.
- The workflow's lists no longer add "Use for Workflow Script Filter" entries to the Universal Actions panel.
- ⌘⌥↩ goes back to the chat list from the chat, image, and preset views; `/open` and ⌘↩ in the image view open the newest image; the files action now shows for a single file too.
- Presets set to copy or paste show their reply in a view instead (⌘↩ copies it) unless Preset Results is turned on.
- A web follow-up such as "What about tomorrow?" is first rewritten into a standalone message by the title model, so the search has the subject and place. The chat keeps what you typed, and the footer shows what was searched. If the rewrite fails, your message is sent as typed and the footer says "search rewrite failed".
- Image, video, and similar models with a zero token price show "priced per image" or "priced per use" instead of "free", and a model that bills only input shows only its input price.
- Markdown tables in a reply are shown as bullet lists, because Alfred's Text View cannot draw tables; copies and exports keep the table. The default system prompt also asks the model to avoid tables.
- The Release workflow is run by hand from the GitHub Actions tab: it checks the code, bumps the version (automatically, or patch, minor, or major), moves the changelog notes under it, commits that to `main`, and publishes a GitHub release with the `.alfredworkflow` and the notes.
