# Word Flashcards — Chrome extension

Right-click any selected word on a web page → **"Look up & save"** → its meaning appears in a
small panel **on top of the page** (it never navigates away), and the word is saved to your
synced flashcard deck.

## Install (unpacked)
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this **`extension/`** folder.
4. Right-click the new toolbar icon → **Options** → paste your **Anthropic API key** and
   **GitHub fine-grained token** (Contents read/write on `mengirena/engflashcard`) → **Save**.

## Use
Select a word on any page → **right-click → "Look up & save …"**. Dismiss the panel with
**Esc** or by clicking elsewhere — your scroll position is untouched.

## Notes
- Keys are stored in this browser only (`chrome.storage.local`) and sent directly to Anthropic
  and GitHub. They are never committed to the repo.
- Captured words land in `docs/data/inbox/` and are folded into your main deck the next time
  you open the web app.
- `core.js` here is a copy of `docs/core.js`; if you change one, copy it to the other.
- Works in Chrome and Edge (Manifest V3).
