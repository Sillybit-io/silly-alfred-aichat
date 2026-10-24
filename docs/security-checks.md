# Security checks on a Mac

The automated tests run on Linux and cannot reach the macOS-only parts: the Alfred Text View, the `osascript` host, and file permissions as macOS reports them. Run these once on a Mac before each release, with a real OpenRouter key. Each line says what to do and what you should see.

## Run the probe first

`bun run build:probe` writes `dist/qa/probe.js`. On the Mac run `osascript -l JavaScript dist/qa/probe.js` (add `--pick` to also try the file picker). It prints one JSON line, `{"ok":true,"checks":[…]}`; `ok` must be `true`, and any check with `"ok":false` says why in its `detail`. To read it easily: `osascript -l JavaScript dist/qa/probe.js | python3 -m json.tool`. The new checks prove the macOS-only parts: folders `700` and files `600`, `restrict` on an existing tree, the key arriving on stdin and not in the environment, the request body deleted when the command ends, and files a supervised command writes being `600`. Only the deletion dialog, the Text View, and the real `ps` checks below need a person.

## The key stays off command lines and out of the environment

1. Start a long reply in `aichat`, for example "Write a 600 word story".
2. In Terminal run `ps -wwax -o pid,command | grep '[c]url'` and note the pid of the `curl` line. The line must not contain your key.
3. Run `ps eww -p <pid>`. It must not contain your key (the variable `openrouter_api_key` must not be listed).
4. Run the same two commands for the `sh -c` supervisor line above it.

If the key shows up, the `NSPipe` and `task.environment` code in `src/host/jxa.ts` is not doing its job on this macOS version. The fallback in the plan is a `0600` config file in a `0700` folder, deleted by the supervisor.

## Nothing remote is fetched

1. In a chat type: `Reply with exactly this Markdown, nothing else: ![x](https://example.com/pixel.gif?q=test) and <img src="https://example.com/tag.gif">`
2. The view must show `🖼 image not loaded: https://example.com/pixel.gif?q=test` and the tag as text, with no image.
3. Optional: run `python3 -m http.server 8000` and ask for the same with `http://127.0.0.1:8000/p.gif`. The server log must stay empty.

## Files are private

1. Run `ls -ld "$HOME/Library/Application Support/Alfred/Workflow Data/com.sillybit.aichat" "$HOME/Library/Caches/com.runningwithcrayons.Alfred/Workflow Data/com.sillybit.aichat"`. Both must read `drwx------`.
2. Run `ls -lR` on the data folder. Files must read `-rw-------`. A folder or file from before the update must have been tightened by the first run (`.private-v1` exists).
3. During a request with a PDF attached, `ls -l` the `requests/<id>/` folder: `body.json` must be gone as soon as the reply ends.

## Deleting is permanent

1. In the history list press ⌃↩ on a chat. A dialog must ask first; Cancel must leave the chat.
2. Confirm. The chat must vanish from the list, `~/.Trash` must not hold it, and its folder must be gone from the data folder.

## Provider privacy

1. Send a message, then open the generation in the OpenRouter activity page: the request should have been routed only to providers with no data collection.
2. Pick a model that has none under the stricter setting. The error must name **Provider Privacy** and say what to do.
