# Task: Fix Shift+Alt+U Text-To-Speech Start

## Goal

Fix the bug where pressing `Shift+Alt+U` / `Alt+Shift+U` does not start reading selected text.

## Known Findings

- The command is declared as `toggle-reading` in `manifest.json`.
- `background.js` receives the command and sends `TOGGLE_READING` to the active tab.
- `content.js` handles `TOGGLE_READING`, but only reads text from `window.getSelection()`.
- This can fail silently for input/textarea selections, iframe selections, pages without a content script, or empty selections.
- Background/offscreen messaging currently reports success before confirming offscreen delivery.

## Required Improvements

- Make selected-text retrieval more robust in `content.js`.
- Do not silently ignore empty text on shortcut activation; surface an error state or useful log.
- Improve failure visibility for `tabs.sendMessage` / offscreen message failures where practical.
- Keep changes narrow and compatible with Manifest V3.

## Verification

Run at least:

```powershell
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest json ok')"
node --check background.js
node --check content.js
node --check offscreen.js
node --check options.js
git diff --check
```

## Output

Summarize:

- files changed
- behavior changed
- checks run
- any remaining limitations
