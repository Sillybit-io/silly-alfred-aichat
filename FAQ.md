# FAQ

## A reply stopped halfway. What happened?

The workflow ends a reply that sends no data for the stall timeout (90 seconds by default, set in the configuration) and keeps the text that arrived, marked as interrupted. Send "continue" to get the rest, or use `/retry` when nothing arrived. Comments that OpenRouter sends to keep a connection open count as data, so a slow model that is still working is not cut off.

If a reply keeps stalling, pick another model with `/model`, or raise the stall timeout.

## What does ⇧↩ stop?

It stops the current reply, closes the view, and reopens it with the partial reply saved and marked as stopped. Some providers ignore a cancelled connection and finish the request anyway, so OpenRouter may still bill for it. Stopping always ends the reply on your side.

## Where did my message go after an error?

A message that could not be sent stays in the input field, selected, so you can fix the problem and press ↩ again. It is also kept with the chat: type `/retry`, even after closing the window or typing something else.

## Does closing the window cancel a reply?

No. The request keeps running while the window is closed. Open the `aichat` keyword and choose Continue to rejoin it; the reply continues from where it was and is saved when it ends.

## How do the presets work?

Presets live in `presets.json` in the workflow's data folder, created with six defaults the first time you list presets. Choose **Edit presets.json** in the `aipresets` list to open it. Each preset has an `id`, a `name`, and a `prompt` that contains `{text}`, where your selected or copied text goes (`{language}` is the translate language from the configuration). Optional fields: `system`, `model`, `web`, `think`, and `output`, which is `textview`, `clipboard`, `paste`, or `largetype`.

The Text View output opens a chat with the filled prompt; the others send one request and show, copy, or paste the reply. When a preset fails, nothing is copied or pasted, and a notification says why. If `presets.json` has a mistake, the list shows the line number.

## How do I get back to the chat list?

Press <kbd>⌘</kbd><kbd>⌥</kbd><kbd>↩︎</kbd> in the chat, image, or preset view. <kbd>esc</kbd> closes Alfred itself, and Alfred does not let a workflow change that. Anything you typed goes to the list, where **New chat** or **Continue** can send it.

## How do I send a file?

Select the file in Alfred (or Finder), open the Universal Actions panel, and look for the actions that start with **AI Chat:**. Choose **AI Chat: Ask about these files** (it works for one file or several). The chat opens with the file listed as ready to send; type your question and press ↩.

## `/attach` shows no file picker

Alfred hides its window while macOS shows a file picker, and some setups block the picker entirely. When that happens, select the files in Alfred and use the **AI Chat: Ask about these files** Universal Action instead; it does the same thing.

## Which files can I send?

PNG, JPEG, WebP, and GIF images; PDFs; and plain text files, which are placed in your message. Each file can be up to 20 MB, a message carries up to 8 files, and the whole request must stay under 32 MB once encoded. Large PNG and JPEG images are scaled down to the longest edge set in the configuration before they are sent.

## Why was my message refused after I switched models?

Every image in the part of the chat that is sent has to be readable by the model that receives it. If the chat model cannot read images and no vision fallback model is set, the message is refused before anything is uploaded and your text stays in the input. Set a vision fallback model in the configuration, switch models with `/model`, or start a `/new` chat.

## Where is my data?

Chats, presets, and attachments are plain files in the workflow's data folder (`~/Library/Application Support/Alfred/Workflow Data/com.sillybit.aichat`). Deleted chats go to the Trash. Your API key is stored by Alfred in the workflow's configuration and sent only to OpenRouter. The workflow has no analytics and never downloads code.

## Why is there no spending display?

On purpose: the numbers live on the OpenRouter dashboard, which is always right. The model list shows each model's price per million, since that describes the model and not your spending.

## How do I debug a problem?

Open the workflow in Alfred Preferences and click the bug icon to open the debugger, then repeat the action. The scripts log what went wrong there. When you report an issue, include the debugger output with your API key removed.

## The `aichat` keyword clashes with another workflow

Change it in the configuration. Every keyword is a field there, so no file edit is needed. The configuration also has an optional Chat Alias Keyword: put `chat` there if you want the shorter word as well.

## Where do the source icons come from?

Source icons are off by default; the Sources setting turns them on. Alfred cannot make an icon itself a link, so with the setting on each icon sits before its own link. The first time a reply cites a site, the workflow then downloads that site's icon from DuckDuckGo's icon service; only the site's domain is sent. Only public website names are looked up, never IP addresses or local names. The download must be a small PNG, ICO, GIF, or JPEG (SVG, HTML, and anything larger than 64 KB are discarded), and it is re-encoded as a 32 px PNG with macOS's own `sips` before it is ever shown. Icons are cached for 30 days in the workflow's cache folder. If an icon is missing, the link is shown without it.

## Image generation says my data policy blocks the model

OpenRouter privacy settings such as zero data retention can leave no provider for some models. The workflow's default image model, `krea/krea-2-medium-turbo`, was chosen because it is on OpenRouter's zero-data-retention list. If you still see the message, pick another image model with `aimodels #imagegen`, or relax the policy in your OpenRouter privacy settings.
