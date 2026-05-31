# 📚 Word Flashcards

Look up English words you don't know — on your **laptop** or **iPhone** — and they're
automatically saved as **spaced-repetition flashcards** that sync across both devices.

Each card has the **pronunciation (IPA)**, **part of speech**, an **English definition**, a
**Chinese translation**, an **example sentence**, **synonyms**, and a note of **where you
saw the word**.

---

## How it works (the big picture)

```
        Reading an article…                       Studying later…
   ┌───────────────────────────┐            ┌──────────────────────────┐
   │ Laptop: right-click a word │            │  Open the web app and    │
   │ iPhone: select → Share     │ ──looks──▶ │  review the cards that    │
   │                            │   up &     │  are "due" today, rating  │
   │ → meaning pops up in place │   saves    │  each Again/Hard/Good/Easy│
   └───────────────────────────┘            └──────────────────────────┘
                 │                                        ▲
                 └──────────── synced through ────────────┘
                       one file in this GitHub repo
```

There are **three places** you use the app:

| Surface | Where | What it does |
|---|---|---|
| **Web app** | `https://mengirena.github.io/engflashcard/` | Study, browse, add, and import words. Works on laptop **and** iPhone. |
| **Chrome extension** | your laptop browser | Right-click a selected word → "Look up & save". |
| **iPhone Shortcut** | iOS Share sheet | Select a word → Share → "Save Word". |

The whole deck lives in **one file in this repo** (`docs/data/words.json`), so every device
sees the same words and study progress. Your **API keys are entered once per device and
stored only on that device** — they are never put in the repo.

> **Note on the app icon:** the icon is a simple built-in SVG. On Android/desktop it shows
> fine; on iPhone the Home-Screen icon may look plain. That's cosmetic only.

---

## 1. One-time account setup

You need two secrets. (They are pasted into the app's **Settings** on each device and stored
locally — never committed to GitHub.)

### 1a. GitHub token (lets the app save your words)
1. Go to **GitHub → your avatar → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**.
2. **Token name:** `flashcards`. **Expiration:** your choice (e.g. 1 year).
3. **Repository access:** *Only select repositories* → choose **`mengirena/engflashcard`**.
4. **Permissions → Repository permissions → Contents → Read and write.**
5. **Generate token** and **copy it** (starts with `github_pat_…`). You won't see it again.

### 1b. Anthropic API key (writes the definitions/translations)
1. Go to **https://console.anthropic.com → API Keys → Create Key**, copy it (`sk-ant-…`).
2. Note a **current model name** to use (e.g. a current Claude Haiku or Sonnet model). You'll
   paste this into Settings; if a model name ever stops working, just update it there.

---

## 2. Turn on the website (GitHub Pages)

1. In this repo: **Settings → Pages**.
2. **Build and deployment → Source: Deploy from a branch.**
3. **Branch:** `main`, **Folder:** `/docs` → **Save**.
4. Wait ~1 minute. Your app is now live at:
   **https://mengirena.github.io/engflashcard/**

✅ *Check:* open that URL — you should see three starter cards (ephemeral, serendipity,
ubiquitous).

---

## 3. Install on your LAPTOP

### 3a. The web app
1. Open **https://mengirena.github.io/engflashcard/** in Chrome.
2. Click the **⚙︎** tab → paste your **GitHub token**, **Anthropic key**, and **model** →
   **Save settings**. (Owner/repo/branch are pre-filled.)
3. Click **Test connection** — you want two green ✅ lines.

✅ *Check:* go to the **Add** tab, type a word, **Look up & save** — a full card appears.

### 3b. (Optional) Install it as a desktop app
In Chrome's address bar click the **Install** icon → it opens in its own window and lands in
your dock/taskbar.

### 3c. Right-click capture (Chrome extension)
1. Go to `chrome://extensions` → turn on **Developer mode** (top-right).
2. **Load unpacked** → select the **`extension/`** folder from this repo.
3. Right-click the new toolbar icon → **Options** → paste the **same** Anthropic key + GitHub
   token → **Save**.

✅ *Check:* on any web page, **select a word → right-click → "Look up & save …"**. A small
panel appears **on top of the page** with the meaning, and "✓ Saved". Press **Esc** or click
away — you're exactly where you were. The word shows up in the web app's **Browse** tab after
you next open/refresh it.

---

## 4. Install on your iPHONE

### 4a. Add the app to your Home Screen
1. Open **https://mengirena.github.io/engflashcard/** in **Safari**.
2. Tap **Share → Add to Home Screen → Add**.
3. Open it from the Home Screen → **⚙︎** tab → paste your keys + model → **Save settings**.

✅ *Check:* the **Add** tab can look up a word on the phone.

### 4b. Tap-to-capture while reading (Shortcut)
Build the **"Save Word"** Shortcut — full step-by-step (with the exact API steps) is in
**[`ios/README.md`](ios/README.md)**. Once set up:

✅ *Check:* in Safari, **select a word → Share → Save Word**. The meaning appears as a panel
**on top of Safari**; tap **Done** and you're back in your article exactly where you were. The
word is saved and will appear on your laptop too.

---

## 5. Daily use

- **Study tab:** the number badge shows how many cards are **due**. Tap **Show answer**, then
  rate yourself:
  - **Again** — forgot it (comes back today).
  - **Hard** — barely knew it (short interval).
  - **Good** — knew it (normal interval).
  - **Easy** — too easy (long interval).
  The app schedules each word using spaced repetition, so hard words come back sooner.
- Every card shows **"Seen in: …"** — where you learned it (a link if it came from a web page).
- **Browse tab:** search all your words and **filter by source** (e.g. show every word from
  one article or book).

## 5b. Importing word lists

Use the **Import** tab to add many words at once:
1. **Paste** a list (one word per line is fine), **or** paste/upload an **export file** from
   **Kindle** ("My Clippings.txt" or your Notebook export), **Libby**, or **Hoopla**.
2. Tap **Analyze** — the AI reads the (even messy) text and extracts the words, pulling the
   highlighted sentence as the example where available.
3. Review the checklist (words already in your deck are pre-skipped), then **Import selected**.
   A progress bar runs as each word is looked up; duplicates are skipped automatically.

---

## 6. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Banner "Could not reach GitHub" | Wrong/expired **GitHub token**, or no internet. Re-paste the token in Settings. You can still study the last-loaded cards offline. |
| GitHub error **403** | The token lacks **Contents: Read and write**, or isn't scoped to `mengirena/engflashcard`. Recreate it (step 1a). |
| GitHub error **401** | Token is wrong or expired. |
| "AI lookup failed" | Wrong **Anthropic key**, or a **retired model name** — update the model in Settings. |
| A word saved on the phone isn't on the laptop yet | The phone drops captures into `docs/data/inbox/`. The **web app folds them into your deck when you open it** — just open/refresh the web app. |
| Extension panel says "add your API keys" | Open the extension's **Options** and paste the keys there (separate from the web app). |

---

## For the curious — repo layout

```
docs/            the web app (served by GitHub Pages)
  index.html app.js core.js styles.css manifest.webmanifest sw.js icons/
  data/words.json     ← your synced deck (words + study schedule)
  data/inbox/         ← words captured on phone/extension wait here until the app folds them in
extension/       the Chrome extension (Load unpacked)
ios/README.md    how to build the iPhone "Save Word" Shortcut
```

Built to run with **no server and no build step** — just static files on GitHub Pages, talking
directly to the GitHub and Anthropic APIs from your own devices.
