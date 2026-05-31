# iPhone "Save Word" Shortcut

iOS doesn't let any app replace the system **Look Up** that appears when you long-press a
word. The closest thing — and it works in **any** app — is a **Shortcut** you run from the
**Share sheet** after selecting a word.

Two versions are below. **Option A stays inside Safari** (recommended — you never lose your
place). **Option B is a 3-step fallback** that opens the web app.

> You only need to build this **once**. Replace `YOUR_ANTHROPIC_KEY`, `YOUR_GITHUB_TOKEN`,
> and the model name with your own values.

---

## Option A — In-place (stays in Safari) ✅ recommended

This Shortcut looks the word up, saves it, and shows the meaning **as a panel on top of
Safari**. Tap **Done** and you're back in your article exactly where you were.

Open the **Shortcuts** app → **+** (new shortcut) → add these actions in order. Use the search
box at the bottom to find each action by name.

### 1. Receive the selected word
- The new shortcut already has **"Receive [input] from Share Sheet"** at the top. Tap it and
  set **Receive: Text** (you can leave others on).
- Add **Text** action → set its value to the **Shortcut Input** (tap the variable). Rename it
  later if you like; we'll call it **Word**.

### 2. Ask the AI for the meaning  — *Get Contents of URL*
Add **Get Contents of URL**. Tap **Show More** and set:
- **URL:** `https://api.anthropic.com/v1/messages`
- **Method:** `POST`
- **Headers:**
  - `x-api-key` = `YOUR_ANTHROPIC_KEY`
  - `anthropic-version` = `2023-06-01`
  - `content-type` = `application/json`
- **Request Body:** **JSON**, with these keys:
  - `model` (Text) = `claude-3-5-haiku-latest`  *(or your current model)*
  - `max_tokens` (Number) = `700`
  - `system` (Text) = paste the **System prompt** from the box below
  - `messages` (Array) → one **Dictionary** item with:
    - `role` (Text) = `user`
    - `content` (Text) = `Word: "` + **Word** variable + `"`

**System prompt (copy exactly):**
```
You are a bilingual (English–Chinese) vocabulary tutor. For the given English word or phrase, respond with ONLY a single JSON object, no prose, no code fences, with keys: word (string, base/dictionary form), pronunciation (IPA in slashes), partOfSpeech (e.g. noun, verb, adjective), definition (clear English, one or two sentences), translation (Simplified Chinese translation/explanation), example (one natural English sentence using the word), synonyms (array of 2-5 English synonyms). If a context sentence is provided, tailor the definition and example to that sense.
```

### 3. Pull the card fields out of the response
- **Get Dictionary Value** → Get **Value** for key `content` in **Contents of URL**.
- **Get Item from List** → **First Item** of that.
- **Get Dictionary Value** → Get **Value** for key `text` in the item. *(This text is itself
  JSON.)*
- **Get Dictionary from Input** → input = that **text**. Now you have the card fields.
  Call this **Card**.

### 4. Save it to your flashcards  — *Get Contents of URL*
First make the file name from the word:
- **Text** action = the **word** value from **Card** (Get Dictionary Value → `word`).
- **Change Case** → **lowercase**.
- **Replace Text** → find ` ` (space) replace with `-`. Call result **Slug**.

Build the file contents:
- **Get Dictionary Value** doesn't help here; instead add a **Dictionary** action named
  **FileObj** mirroring the Card plus a source, e.g. keys: `id` (=Slug), `word`,
  `pronunciation`, `partOfSpeech`, `definition`, `translation`, `example`, `synonyms`,
  `source` (Dictionary: `label`=`iPhone`, `url`=`Shortcut Input` if a URL was shared, `via`=`ios`).
  Pull each value from **Card** with **Get Dictionary Value**.
- **Base64 Encode** the **FileObj** (add a **Text** action that holds FileObj as JSON, then
  **Base64 Encode** it). *(Tip: a "Get Text from Input" → FileObj produces its JSON text.)*

Now the upload:
- **Get Contents of URL**
  - **URL:** `https://api.github.com/repos/mengirena/engflashcard/contents/docs/data/inbox/` + **Slug** + `.json`
  - **Method:** `PUT`
  - **Headers:**
    - `Authorization` = `Bearer YOUR_GITHUB_TOKEN`
    - `Accept` = `application/vnd.github+json`
  - **Request Body:** **JSON**:
    - `message` (Text) = `capture: ` + **Word**
    - `content` (Text) = the **Base64** value
    - `branch` (Text) = `main`

### 5. Show the meaning over Safari
- **Text** action combining the fields, e.g.:
  ```
  [Word]  [pronunciation]
  [translation]
  [definition]
  e.g. [example]
  ✓ Saved
  ```
  (insert the matching values from **Card**).
- **Show Result** (or **Quick Look**) with that text.

Finally: tap the shortcut's **ⓘ / settings → Show in Share Sheet = ON**, and name it
**Save Word**.

**Use it:** in Safari, select a word → **Share** → **Save Word** → the meaning pops up over
the page → **Done** returns you to the article. The word is now in your synced deck.

> The Anthropic key and GitHub token live inside this Shortcut on your device — the same trust
> level as typing them into the app's Settings.

---

## Option B — Quick fallback (opens the web app)

If Option A feels like too many steps, this 3-action version still saves the word (the web app
does the lookup); it just switches to the app instead of staying in Safari.

1. **Receive Text from Share Sheet.**
2. **URL** action = `https://mengirena.github.io/engflashcard/?add=` + **Shortcut Input**.
3. **Open URLs**.

Name it **Save Word**, enable **Show in Share Sheet**. Selecting a word → Share → **Save Word**
opens the app, which looks it up and saves it. Use the iOS app-switcher (or swipe) to return to
Safari.

---

## Tips
- Test the Shortcut once by running it with a word typed into a **Text** action before wiring
  it to the Share Sheet.
- If you get a GitHub **403**, your token needs **Contents: Read and write** on
  `mengirena/engflashcard` (see the main README, step 1a).
- If the AI step errors, check the **model name** is one your account can use.
