# Alfred forum post draft

Post in **Share your Workflows**. Replace the release link before posting.

---

**Title:** AI Chat: chat with any OpenRouter model, send images and PDFs, run presets

Hi all,

I built a workflow for chatting with any model on [OpenRouter](https://openrouter.ai) from Alfred, because the existing ones did not do what I needed: they depended on Python, could not take files, and stopped mid-reply.

What it does:

- One list behind `aichat`: continue, start a chat, open a recent one, or jump to models, presets, and images.
- Streams replies into a Text View. ⇧↩ stops and keeps the partial reply, closing the window does not lose the reply, and a message that failed is kept for `/retry`.
- Sends images, PDFs, and text files: select files and use a Universal Action, type `/attach`, or `/paste` an image from the clipboard.
- Searches the model list (`aimodels`) with prices and badges; favorites, a default, and a model per chat.
- Reasoning shown while it streams, `/think` for effort, `/web` for per-chat web search with sources as a line of short links.
- Prompt presets (`aipresets`) that open a chat, copy, paste, or show the reply, defined in a plain JSON file.
- Chat history with automatic titles, pin, archive, Markdown export, and optional retention.
- Image generation with `aiimage` or `/image`.

It is plain JavaScript for Automation scripts: nothing to install, no binaries, no auto-updater, no telemetry, and no site-icon lookups. The code is BSD 3-Clause and borrows the Text View streaming pattern from the OpenAI workflow by Running with Crayons.

Privacy: requests carry no-data-collection provider rules by default (zero-data-retention is one setting away), your API key never appears in a command line, replies cannot make the view fetch an image or open a non-https link, chat files are owner-only, and deleting a chat erases it for good. The README's Privacy and security section lists what still leaves your Mac and what the workflow cannot protect against.

Needs macOS 14+ and Alfred 5.5+ with the Powerpack, and an OpenRouter API key (paste it into the workflow configuration). OpenRouter bills web search, OCR, and reasoning per use, so the workflow keeps web search and OCR off until you ask for them.

Download: <release link>
Source and README: https://github.com/Sillybit-io/silly-alfred-aichat

Feedback and bug reports are welcome on GitHub or here.
