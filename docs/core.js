/*
 * core.js — shared logic for the English Flashcard app.
 * Pure functions that take a `cfg` object, so the SAME file is reused by both
 * the PWA (window) and the Chrome extension service worker (importScripts).
 *
 * cfg = {
 *   anthropicKey, model,            // Anthropic API
 *   githubToken, owner, repo, branch, deckPath, inboxDir   // GitHub storage
 * }
 *
 * NOTE: extension/core.js is a copy of this file — keep them in sync.
 */
(function (root) {
  'use strict';

  // ---------- small helpers ----------
  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }
  function addDaysISO(days, fromISO) {
    const d = fromISO ? new Date(fromISO + 'T00:00:00') : new Date();
    d.setDate(d.getDate() + Math.round(days));
    return d.toISOString().slice(0, 10);
  }
  function slugId(word) {
    return String(word || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-']/g, '');
  }
  function utf8ToB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToUtf8(b64) {
    const bin = atob(String(b64 || '').replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function stripFences(text) {
    return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  // run async fn over items with limited concurrency; onProgress(done,total,item,result|error)
  async function mapLimit(items, limit, fn, onProgress) {
    const results = new Array(items.length);
    let index = 0, done = 0;
    async function worker() {
      while (index < items.length) {
        const i = index++;
        try {
          results[i] = { ok: true, value: await fn(items[i], i) };
        } catch (err) {
          results[i] = { ok: false, error: err };
        }
        done++;
        if (onProgress) onProgress(done, items.length, items[i], results[i]);
      }
    }
    const workers = [];
    for (let w = 0; w < Math.max(1, Math.min(limit, items.length)); w++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  // ---------- GitHub Contents API ----------
  function ghBase(cfg, path) {
    return 'https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + path;
  }
  function ghHeaders(cfg) {
    return {
      'Authorization': 'Bearer ' + cfg.githubToken,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }
  async function ghGetRaw(cfg, path) {
    const ref = encodeURIComponent(cfg.branch || 'main');
    const res = await fetch(ghBase(cfg, path) + '?ref=' + ref, {
      headers: ghHeaders(cfg), cache: 'no-store'
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('GitHub GET ' + path + ' failed (' + res.status + '): ' + (await res.text()));
    return res.json();
  }
  async function ghGetJsonFile(cfg, path) {
    const data = await ghGetRaw(cfg, path);
    if (!data) return { json: null, sha: null };
    return { json: JSON.parse(b64ToUtf8(data.content)), sha: data.sha };
  }
  async function ghListDir(cfg, dirPath) {
    const data = await ghGetRaw(cfg, dirPath);
    if (!data) return [];
    return Array.isArray(data) ? data : [data];
  }
  async function ghPutJsonFile(cfg, path, obj, sha, message) {
    const body = {
      message: message || ('update ' + path),
      content: utf8ToB64(JSON.stringify(obj, null, 2) + '\n'),
      branch: cfg.branch || 'main'
    };
    if (sha) body.sha = sha;
    const res = await fetch(ghBase(cfg, path), {
      method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(cfg)),
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const txt = await res.text();
      const err = new Error('GitHub PUT ' + path + ' failed (' + res.status + '): ' + txt);
      err.status = res.status;
      throw err;
    }
    const out = await res.json();
    return out.content ? out.content.sha : null;
  }
  async function ghDeleteFile(cfg, path, sha, message) {
    const res = await fetch(ghBase(cfg, path), {
      method: 'DELETE', headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(cfg)),
      body: JSON.stringify({ message: message || ('remove ' + path), sha: sha, branch: cfg.branch || 'main' })
    });
    if (!res.ok && res.status !== 404) {
      throw new Error('GitHub DELETE ' + path + ' failed (' + res.status + '): ' + (await res.text()));
    }
    return true;
  }

  // ---------- deck operations ----------
  function deckPath(cfg) { return cfg.deckPath || 'docs/data/words.json'; }
  function inboxDir(cfg) { return cfg.inboxDir || 'docs/data/inbox'; }

  async function loadDeck(cfg) {
    const { json, sha } = await ghGetJsonFile(cfg, deckPath(cfg));
    const cards = json && Array.isArray(json.cards) ? json.cards : [];
    return { cards, sha };
  }
  async function saveDeck(cfg, cards, sha, message) {
    return ghPutJsonFile(cfg, deckPath(cfg), { cards }, sha, message || 'update deck');
  }

  function defaultSrs() {
    return { due: todayISO(), interval: 0, ease: 2.5, reps: 0 };
  }
  function buildCard(word, fields, source) {
    const id = slugId(word);
    return {
      id: id,
      word: (fields && fields.word) || word,
      pronunciation: (fields && fields.pronunciation) || '',
      partOfSpeech: (fields && fields.partOfSpeech) || '',
      definition: (fields && fields.definition) || '',
      translation: (fields && fields.translation) || '',
      example: (fields && fields.example) || '',
      synonyms: (fields && Array.isArray(fields.synonyms)) ? fields.synonyms : [],
      added: todayISO(),
      source: source || { label: '', url: '', via: 'manual' },
      srs: defaultSrs()
    };
  }

  // Capture path (extension + Shortcut + ?add=): one tiny per-word file, no merge.
  async function saveCapture(cfg, card) {
    const path = inboxDir(cfg) + '/' + card.id + '.json';
    const existing = await ghGetRaw(cfg, path);
    if (existing) return { skipped: true, reason: 'already in inbox' };
    const stored = Object.assign({}, card);
    delete stored.srs; // PWA assigns SRS on ingest
    await ghPutJsonFile(cfg, path, stored, null, 'capture: ' + card.word);
    return { skipped: false };
  }

  // PWA-only: fold inbox files into words.json and clear them.
  async function ingestInbox(cfg, deck) {
    const entries = (await ghListDir(cfg, inboxDir(cfg)))
      .filter(function (e) { return e.type === 'file' && /\.json$/i.test(e.name); });
    if (!entries.length) return { ingested: 0, cards: deck.cards, sha: deck.sha };

    const byId = {};
    deck.cards.forEach(function (c) { byId[c.id] = true; });
    let added = 0;
    for (const e of entries) {
      try {
        const data = await ghGetRaw(cfg, e.path);
        const card = JSON.parse(b64ToUtf8(data.content));
        if (card && card.id && !byId[card.id]) {
          if (!card.srs) card.srs = defaultSrs();
          if (!card.added) card.added = todayISO();
          deck.cards.push(card);
          byId[card.id] = true;
          added++;
        }
      } catch (err) { /* skip bad inbox file */ }
    }
    let sha = deck.sha;
    if (added > 0) {
      sha = await saveDeck(cfg, deck.cards, deck.sha, 'ingest ' + added + ' captured word(s)');
    }
    // delete processed inbox files (best effort)
    for (const e of entries) {
      try { await ghDeleteFile(cfg, e.path, e.sha, 'clear inbox: ' + e.name); } catch (err) {}
    }
    return { ingested: added, cards: deck.cards, sha: sha };
  }

  // ---------- SRS (simplified SM-2) ----------
  function isDue(card, refISO) {
    const today = refISO || todayISO();
    if (!card.srs || card.srs.reps === 0) return true;
    return card.srs.due <= today;
  }
  function srsReview(card, rating) {
    const s = card.srs || defaultSrs();
    let ease = s.ease || 2.5;
    let interval = s.interval || 0;
    let reps = s.reps || 0;
    switch (rating) {
      case 'again':
        ease = Math.max(1.3, ease - 0.20); interval = 0; reps = 0;
        card.srs = { due: todayISO(), interval: 0, ease: ease, reps: reps };
        return card.srs;
      case 'hard':
        ease = Math.max(1.3, ease - 0.15);
        interval = interval > 0 ? interval * 1.2 : 1;
        break;
      case 'easy':
        ease = ease + 0.15;
        interval = reps === 0 ? 2 : (reps === 1 ? 4 : interval * ease * 1.3);
        break;
      case 'good':
      default:
        interval = reps === 0 ? 1 : (reps === 1 ? 3 : interval * ease);
        break;
    }
    reps += 1;
    interval = Math.max(1, interval);
    card.srs = { due: addDaysISO(interval), interval: interval, ease: ease, reps: reps };
    return card.srs;
  }

  // ---------- Anthropic ----------
  async function anthropicCall(cfg, system, userText, maxTokens) {
    if (!cfg.anthropicKey) throw new Error('Missing Anthropic API key (set it in Settings).');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.anthropicKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: cfg.model || 'claude-3-5-haiku-latest',
        max_tokens: maxTokens || 700,
        system: system,
        messages: [{ role: 'user', content: userText }]
      })
    });
    if (!res.ok) {
      throw new Error('AI lookup failed (' + res.status + '). Check your API key/model. ' + (await res.text()));
    }
    const data = await res.json();
    const text = (data.content && data.content[0] && data.content[0].text) || '';
    return text;
  }

  const LOOKUP_SYSTEM =
    "You are a bilingual (English–Chinese) vocabulary tutor. For the given English word " +
    "or phrase, respond with ONLY a single JSON object, no prose, no code fences, with keys: " +
    "word (string, base/dictionary form), pronunciation (IPA in slashes), partOfSpeech " +
    "(e.g. noun, verb, adjective), definition (clear English, one or two sentences), " +
    "translation (Simplified Chinese translation/explanation), example (one natural English " +
    "sentence using the word), synonyms (array of 2-5 English synonyms). " +
    "If a context sentence is provided, tailor the definition and example to that sense.";

  async function anthropicLookup(cfg, word, context) {
    const user = context
      ? ('Word: "' + word + '"\nContext it appeared in: "' + context + '"')
      : ('Word: "' + word + '"');
    const text = await anthropicCall(cfg, LOOKUP_SYSTEM, user, 700);
    let obj;
    try { obj = JSON.parse(stripFences(text)); }
    catch (e) { throw new Error('AI returned unparseable data for "' + word + '". Raw: ' + text.slice(0, 200)); }
    return obj;
  }

  // High-level: look up a word and build a full card (does not save).
  async function lookup(cfg, word, source, context) {
    const fields = await anthropicLookup(cfg, word, context);
    return buildCard(fields.word || word, fields, source);
  }

  const IMPORT_SYSTEM =
    "You extract vocabulary to study from raw text that may be a plain word list or an " +
    "export from a reading app (Kindle 'My Clippings.txt', Kindle Notebook CSV, Libby or " +
    "Hoopla highlight exports, CSV, markdown, or notes). Respond with ONLY a JSON array " +
    "(no prose, no code fences). Each element: { \"word\": string (the base/dictionary form " +
    "of the vocabulary item), \"context\": string (the sentence/highlight it appeared in, or " +
    "\"\" if none), \"source\": string (the book or article title if the text indicates one, " +
    "else \"\") }. Skip duplicates and non-vocabulary noise (page numbers, locations, dates, " +
    "headers). Prefer single words or short phrases a learner would study.";

  async function parseImport(cfg, rawText) {
    const text = await anthropicCall(cfg, IMPORT_SYSTEM, String(rawText).slice(0, 12000), 2000);
    let arr;
    try { arr = JSON.parse(stripFences(text)); }
    catch (e) { throw new Error('Could not parse the import. The AI returned: ' + text.slice(0, 200)); }
    if (!Array.isArray(arr)) throw new Error('Import parser did not return a list.');
    // normalize + dedupe by id
    const seen = {};
    const out = [];
    arr.forEach(function (it) {
      const w = (it && (it.word || it.term || '')).toString().trim();
      if (!w) return;
      const id = slugId(w);
      if (!id || seen[id]) return;
      seen[id] = true;
      out.push({ word: w, context: (it.context || '').toString(), source: (it.source || '').toString() });
    });
    return out;
  }

  // ---------- export ----------
  root.FlashcardCore = {
    // helpers
    todayISO, addDaysISO, slugId, mapLimit,
    // github
    ghGetRaw, ghGetJsonFile, ghListDir, ghPutJsonFile, ghDeleteFile,
    // deck
    loadDeck, saveDeck, buildCard, defaultSrs,
    saveCapture, ingestInbox,
    // srs
    isDue, srsReview,
    // ai
    anthropicLookup, lookup, parseImport
  };
})(typeof self !== 'undefined' ? self : this);
