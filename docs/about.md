# AI Chat

Chat with any OpenRouter model from Alfred, without installing anything.

## Use it

- `aichat` lists Continue, New chat, your recent chats, and shortcuts to the other lists; text you type is what Continue and New chat send. In the chat view ↩ sends, ⌘↩ starts a new chat, ⌥↩ copies the last reply, ⌃↩ copies the whole chat, ⇧↩ stops a reply. Type `/help` for the slash commands.
- Select files in Alfred and use **AI Chat: Ask about these files**, or type `/attach` or `/paste`, to send images, PDFs, and text files with your next message.
- `aimodels` searches the model list. ↩ uses a model in this chat, ⌘↩ makes it the default, ⌥↩ adds a favorite, ⌃↩ copies its id.
- Select text and use **AI Chat: Ask about this text** or **AI Chat: Summarize**, **AI Chat: Translate** and the other preset actions, or **AI Chat: Run a preset…**, or type `aipresets`, to run a prompt preset. Edit `presets.json` from the first list to add your own.
- `aiimage` generates images; `/image` does the same inside a chat.
- On a chat in the list: ↩ opens it, ⌘↩ archives, ⌥↩ pins, ⌃↩ deletes it permanently after a confirmation. **All chats…** opens the full list.

## Set it up

Paste an OpenRouter API key (from openrouter.ai/keys) into **Configuration**. Every other field has a default. Spending is shown on the OpenRouter dashboard, not in this workflow.

Web search and the OCR PDF engine are billed by OpenRouter per use, so both are off until you ask for them with `/web on` or `/pdf ocr`.

## License

This workflow borrows the streaming Text View pattern from the OpenAI workflow by Running with Crayons, released under the BSD 3-Clause License. The license text is in `LICENSE` inside this workflow, with attribution to Running with Crayons Ltd.
