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

Chats, presets, and attachments are plain, unencrypted files in the workflow's data folder (`~/Library/Application Support/Alfred/Workflow Data/com.sillybit.aichat`), and a cache sits in the matching Caches folder. Both are readable only by you (folders `700`, files `600`); the first run after an update tightens what an earlier version wrote. macOS already keeps `~/Library` closed to other users, so this is a second layer for the case that a folder is shared, copied, or backed up. An administrator can still read everything; only FileVault protects a disk that is read offline.

Deleting a chat (⌃↩ in the lists, after a confirmation) or letting retention remove one erases its folder at once. It does not go to the Trash. That is not a secure erase: macOS has no secure erase for flash storage (Apple removed Secure Empty Trash for that reason), and FileVault is what keeps deleted data unreadable.

Your API key is stored by Alfred in the workflow's preferences, unencrypted, like every Alfred workflow setting. When Alfred's preferences are synced (Alfred Preferences, Advanced, Syncing), they live in the folder you chose, such as iCloud Drive or Dropbox, and the key travels with them. Give the workflow its own key with a credit limit on openrouter.ai/keys, so a copied key can spend little. The workflow leaves it out of exported copies and of the packaged release, and gives it to `curl` on standard input so it never appears in a command line. The workflow has no analytics and never downloads code.

## What leaves my Mac?

Each message goes to OpenRouter over https (and nowhere else) with the last messages of the chat as context and any attachments. OpenRouter passes it to the model provider. Two features send extra requests that carry chat text: the automatic title (the first messages) and the web follow-up rewrite (the chat so far, only with web search on). Both can be turned off in the configuration. Presets send the text you run them on to the model, as you would expect. Web search and PDF parsing are OpenRouter plugins with their own handling of your text.

The configuration's **Provider Privacy** adds `data_collection: deny` (the default) or `zdr: true` to every chat request, which restricts routing as OpenRouter documents. It cannot cover plugins, and OpenRouter always keeps request metadata, such as how long a request took. Prompt logging at OpenRouter is opt-in, so check that it is off in your OpenRouter privacy settings. Image generation has no such request option and follows your OpenRouter privacy settings.

## Why does a reply show "image not loaded"?

A reply, a web page it read, or an attached document can contain Markdown or HTML that makes a viewer fetch an address, and the address can carry your conversation. That is a known way to leak data from a chat. The workflow never lets the view fetch anything a model chose: an image is shown as the text `🖼 image not loaded: <address>` so you can see where it pointed, HTML tags are shown as text, and links other than `https` are shown as text followed by their address. Links that stay get the site name after them and lose tracking parameters such as `utm_source`. Copies and exports are cleaned the same way. Only the pictures the workflow saved itself, in the images folder, are shown; if the folder path contains `[`, `]`, `?`, or `#`, they show as a path instead.

## Can Spotlight or Time Machine see my chats?

The workflow cannot stop them. An empty `.metadata_never_index` file no longer works inside a folder on recent macOS, and Alfred decides where the data folder is. To keep Spotlight out, add the data folder to System Settings, Spotlight, Search Privacy. To keep it out of backups, run `tmutil addexclusion -p "$HOME/Library/Application Support/Alfred/Workflow Data/com.sillybit.aichat"`. Generated images are saved in your Pictures folder, which both of them cover. They carry no prompt unless you turn on **Image Prompts** in the configuration.

## Why is there no spending display?

On purpose: the numbers live on the OpenRouter dashboard, which is always right. The model list shows each model's price per million, since that describes the model and not your spending.

## How do I debug a problem?

Open the workflow in Alfred Preferences and click the bug icon to open the debugger, then repeat the action. The scripts log what went wrong there. When you report an issue, include the debugger output with your API key removed.

## The `aichat` keyword clashes with another workflow

Change it in the configuration. Every keyword is a field there, so no file edit is needed. The configuration also has an optional Chat Alias Keyword: put `chat` there if you want the shorter word as well.

## Image generation says my data policy blocks the model

The workflow's Provider Privacy setting (no data collection by default) and OpenRouter privacy settings such as zero data retention can leave no provider for some models. For chats, choose **Standard** in Provider Privacy or another model. The workflow's default image model, `krea/krea-2-medium-turbo`, was chosen because it is on OpenRouter's zero-data-retention list. If you still see the message, pick another image model with `aimodels #imagegen`, or relax the policy in your OpenRouter privacy settings.
