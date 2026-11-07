/* app.js — PWA UI. Uses self.FlashcardCore (core.js). */
(function () {
  'use strict';

  // No zooming: iOS Safari ignores the viewport user-scalable=no, so block
  // its pinch-gesture events directly. Also block trackpad pinch (Ctrl+wheel).
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (type) {
    document.addEventListener(type, function (e) { e.preventDefault(); }, { passive: false });
  });
  document.addEventListener('wheel', function (e) {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });

  var C = self.FlashcardCore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var CFG_KEY = 'flashcfg';
  var CACHE_KEY = 'deckcache';
  var DEFAULTS = {
    anthropicKey: '', model: 'claude-3-5-haiku-latest', githubToken: '',
    owner: 'mengirena', repo: 'engflashcard', branch: 'main',
    deckPath: 'docs/data/words.json', inboxDir: 'docs/data/inbox',
    hideChinese: true
  };

  var cfg = loadCfg();
  var deck = { cards: [], sha: null };   // canonical, mutated in place
  var queue = [];                         // study queue (card refs)
  var current = null;
  var dirty = false;
  var flushTimer = null;
  var online = true;
  var studyMode = 'due';                  // 'due' | 'weak'
  var studyDir = 'fwd';                   // 'fwd' (word→meaning) | 'rev' (meaning→word)
  var sessionTotal = 0;                   // cards in the current study session
  var sessionDone = {};                   // ids graduated (rated non-"again") this session
  var selectMode = false;                 // batch-select in Browse
  var selected = {};                      // ids checked in Browse
  var currentView = 'study';
  var COLLECTION_KEY = 'flashcollection';
  var selectedCollection = loadSelectedCollection();
  var pendingCollection = null;           // new collection named in Add, no cards yet
  var creatingCollection = false;         // Add view is showing the new-collection form
  var NEW_COLLECTION_OPTION = '__new_collection__'; // picker sentinel: "+ New collection…"

  // ---------- collections ----------
  function loadSelectedCollection() {
    try { return localStorage.getItem(COLLECTION_KEY) || C.DEFAULT_COLLECTION; }
    catch (e) { return C.DEFAULT_COLLECTION; }
  }
  function persistCollection() {
    try { localStorage.setItem(COLLECTION_KEY, selectedCollection); } catch (e) {}
  }
  function inCollection(c) { return C.getCollection(c) === selectedCollection; }
  function collectionCards() { return deck.cards.filter(inCollection); }
  // Cards saved before collections existed have no tag: they are English.
  // Normalizing in memory means the tag is written out on the next save.
  function normalizeDeck() {
    deck.cards.forEach(function (c) { if (!c.collection) c.collection = C.DEFAULT_COLLECTION; });
  }
  function refreshCollectionPicker() {
    var sel = $('#collectionPicker');
    if (!sel) return;
    var names = C.listCollections(deck.cards);
    if (names.indexOf(selectedCollection) < 0) names.push(selectedCollection);
    if (pendingCollection && names.indexOf(pendingCollection) < 0) names.push(pendingCollection);
    sel.innerHTML = names.map(function (n) {
      return '<option value="' + escapeHtml(n) + '"' + (n === selectedCollection ? ' selected' : '') + '>' + escapeHtml(n) + '</option>';
    }).join('') + '<option value="' + NEW_COLLECTION_OPTION + '">+ New collection…</option>';
    sel.value = selectedCollection;
  }

  // ---------- config ----------
  function loadCfg() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveCfg() { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }
  function hasKeys() { return cfg.anthropicKey && cfg.githubToken; }

  // ---------- deck cache ----------
  function cacheDeck() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(deck)); } catch (e) {}
  }
  function loadCachedDeck() {
    try { var d = JSON.parse(localStorage.getItem(CACHE_KEY)); if (d && d.cards) return d; } catch (e) {}
    return null;
  }

  // ---------- ui helpers ----------
  var toastTimer;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function banner(msg) {
    var b = $('#banner');
    if (!msg) { b.hidden = true; return; }
    b.innerHTML = msg; b.hidden = false;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function highlight(text, word) {
    var safe = escapeHtml(text);
    if (!word) return safe;
    try {
      var re = new RegExp('(' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\w*)', 'ig');
      return safe.replace(re, '<mark>$1</mark>');
    } catch (e) { return safe; }
  }

  // ---------- navigation ----------
  function show(view) {
    currentView = view;
    $$('.view').forEach(function (v) { v.hidden = true; });
    var el = $('#view-' + view); if (el) el.hidden = false;
    $$('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.view === view); });
    refreshCollectionPicker();
    if (view === 'study') renderStudy();
    if (view === 'browse') renderBrowse();
    if (view === 'add') renderAddForm();
    if (view === 'settings') fillSettings();
  }
  $$('.tab').forEach(function (t) {
    t.addEventListener('click', function () { show(t.dataset.view); });
  });
  $('#collectionPicker').addEventListener('change', function () {
    if (this.value === NEW_COLLECTION_OPTION) {
      // Start a new collection: jump to Add in create mode. The picker itself
      // keeps showing the current collection until the new one is created.
      creatingCollection = true;
      refreshCollectionPicker();
      show('add');
      var nameInput = $('#newCollectionName'); if (nameInput) nameInput.focus();
      return;
    }
    selectedCollection = this.value || C.DEFAULT_COLLECTION;
    persistCollection();
    refreshCollectionPicker();
    updateDueBadge();
    if (currentView === 'study') renderStudy();
    if (currentView === 'browse') renderBrowse();
    if (currentView === 'add') renderAddForm();
  });

  // ---------- init ----------
  function updateDueBadge() {
    var n = deck.cards.filter(function (c) { return inCollection(c) && C.isDue(c, studyDir); }).length;
    var b = $('#dueBadge');
    b.textContent = n; b.hidden = n === 0;
  }

  async function init() {
    // show cached deck immediately if available
    var cached = loadCachedDeck();
    if (cached) { deck = cached; normalizeDeck(); cacheDeck(); refreshCollectionPicker(); updateDueBadge(); }

    if (!hasKeys()) {
      banner('👋 Welcome! Open <b>⚙︎ Settings</b> and paste your GitHub token + Anthropic key to start syncing.');
    }

    // try to load fresh from GitHub
    if (hasKeys()) {
      try {
        var fresh = await C.loadDeck(cfg);
        deck = fresh;
        normalizeDeck();
        cacheDeck();
        // fold in any words captured from the extension / phone
        var res = await C.ingestInbox(cfg, deck);
        if (res.ingested > 0) { deck.cards = res.cards; deck.sha = res.sha; normalizeDeck(); cacheDeck(); toast('Added ' + res.ingested + ' captured word(s).'); }
        refreshCollectionPicker();
        if (res.failed > 0) { banner('⚠︎ ' + res.failed + ' captured file(s) couldn\'t be read and were left in the inbox for another try. They may be malformed.'); }
        else banner('');
        online = true;
      } catch (e) {
        online = false;
        banner('⚠︎ Could not reach GitHub (' + escapeHtml(e.message.slice(0, 120)) + '). Showing the last saved copy; studying offline is fine.');
      }
    }
    updateDueBadge();

    // handle ?add=word capture entry point
    var params = new URLSearchParams(location.search);
    var add = params.get('add');
    if (add) {
      show('add');
      $('#addWord').value = add;
      history.replaceState({}, '', location.pathname);
      doAdd(add, 'Shared link');
    } else {
      show('study');
    }
  }

  // ---------- STUDY ----------
  function buildQueue() {
    if (studyMode === 'weak') {
      // practice the least-mastered words first (for the current side), regardless of due date
      // (retired cards for this side are out of study entirely)
      queue = deck.cards.filter(function (c) { return inCollection(c) && !C.isRetired(c, studyDir); }).sort(function (a, b) {
        return C.masteryInfo(a, studyDir).rank - C.masteryInfo(b, studyDir).rank;
      });
    } else {
      // due cards in RANDOM order (not sequential) so each session feels fresh
      queue = shuffle(deck.cards.filter(function (c) { return inCollection(c) && C.isDue(c, studyDir); }));
    }
  }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  $$('.mode').forEach(function (b) {
    b.addEventListener('click', function () {
      studyMode = b.dataset.mode;
      $$('.mode').forEach(function (m) { m.classList.toggle('active', m === b); });
      renderStudy();
    });
  });
  $$('.dir').forEach(function (b) {
    b.addEventListener('click', function () {
      studyDir = b.dataset.dir;
      $$('.dir').forEach(function (m) { m.classList.toggle('active', m === b); });
      renderStudy(); // rebuild the queue for this side (front/back have separate schedules)
    });
  });
  function updateProgress() {
    var p = $('#studyProgress');
    if (!sessionTotal) { p.hidden = true; return; }
    p.hidden = false;
    var done = Object.keys(sessionDone).length;
    $('#studyBar').style.width = Math.min(100, Math.round(done / sessionTotal * 100)) + '%';
    $('#studyCount').textContent = done + ' / ' + sessionTotal;
  }
  function renderStudy() {
    buildQueue();
    sessionTotal = queue.length;
    sessionDone = {};
    updateProgress();
    updateDueBadge();
    if (!queue.length) {
      var collTotal = collectionCards().length;
      $('#studyCard').hidden = true;
      $('#studyEmpty').hidden = false;
      $('#studyEmptyTitle').textContent = !collTotal ? 'No words yet' : 'All caught up 🎉';
      $('#studyEmptyMsg').textContent = !collTotal
        ? 'No cards yet in the ' + selectedCollection + ' collection — add some in the Add tab.'
        : (studyMode === 'weak'
            ? 'No words to practice.'
            : 'Nothing due right now. Try "Weak words" to practice anyway — you have ' + collTotal + ' word(s) in ' + selectedCollection + '.');
      return;
    }
    $('#studyEmpty').hidden = true;
    $('#studyCard').hidden = false;
    nextCard();
  }
  function sessionDone() {
    $('#studyCard').hidden = true;
    $('#studyProgress').hidden = true;
    $('#studyEmpty').hidden = false;
    updateDueBadge();
    var dueLeft = deck.cards.filter(function (c) { return inCollection(c) && C.isDue(c, studyDir); }).length;
    if (studyMode === 'weak') {
      $('#studyEmptyTitle').textContent = 'Practice round complete 💪';
      $('#studyEmptyMsg').textContent = 'Tap "Weak words" again for another pass.';
    } else {
      $('#studyEmptyTitle').textContent = 'All done for today 🎉';
      $('#studyEmptyMsg').textContent = dueLeft ? (dueLeft + ' still due.') : 'No more cards due.';
    }
  }
  // ---- audio (Web Speech API, on-device, free) ----
  var speechOK = ('speechSynthesis' in window);
  function langForCollection(name) {
    var n = String(name || '').toLowerCase();
    if (n.indexOf('japanese') >= 0 || n.indexOf('日本') >= 0) return 'ja-JP';
    if (n.indexOf('korean') >= 0 || n.indexOf('한국') >= 0) return 'ko-KR';
    if (n.indexOf('chinese') >= 0 || n.indexOf('中文') >= 0 || n.indexOf('中国') >= 0 || n.indexOf('中國') >= 0) return 'zh-TW';
    if (n.indexOf('spanish') >= 0 || n.indexOf('español') >= 0) return 'es-ES';
    if (n.indexOf('french') >= 0 || n.indexOf('français') >= 0) return 'fr-FR';
    if (n.indexOf('german') >= 0 || n.indexOf('deutsch') >= 0) return 'de-DE';
    if (n.indexOf('italian') >= 0 || n.indexOf('italiano') >= 0) return 'it-IT';
    return 'en-US';
  }
  function speak(text, collection) {
    if (!speechOK || !text) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      var coll = collection || (current ? C.getCollection(current) : selectedCollection);
      u.lang = langForCollection(coll); u.rate = 0.95;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }
  function speakBtn(text, collection) {
    if (!speechOK) return '';
    return '<button class="speak" data-speak="' + escapeHtml(text) + '" data-coll="' + escapeHtml(collection || '') + '" title="Play audio" aria-label="Play audio">🔊</button>';
  }
  function maskWord(text, word) {
    var safe = escapeHtml(text);
    if (!word) return safe;
    try {
      var re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\w*', 'ig');
      return safe.replace(re, '_____');
    } catch (e) { return safe; }
  }
  function synChips(c) {
    return (c.synonyms || []).map(function (s) { return '<span class="chip">' + escapeHtml(s) + '</span>'; }).join('');
  }
  function zhBlock(c) {
    var zh = escapeHtml(c.translation || '');
    if (!zh) return '';
    if (cfg.hideChinese) {
      return '<div class="zh-wrap"><button type="button" class="zh-toggle">Show Chinese</button>' +
        '<div class="card-translation" hidden>' + zh + '</div></div>';
    }
    return '<div class="card-translation">' + zh + '</div>';
  }
  function wordBlock(c) {
    return '<div class="card-word">' + escapeHtml(c.word) + ' ' + speakBtn(c.word, C.getCollection(c)) + '</div>' +
      '<div class="card-ipa">' + escapeHtml(c.pronunciation || '') + '</div>' +
      '<div class="card-pos">' + escapeHtml(c.partOfSpeech || '') + '</div>';
  }
  function meaningBlock(c, blankExample) {
    var ex = c.example ? (blankExample ? maskWord(c.example, c.word) : highlight(c.example, c.word)) : '';
    return '<div class="card-def">' + escapeHtml(c.definition || '') + '</div>' +
      (ex ? '<div class="card-example">' + ex + '</div>' : '');
  }
  function usageBlock(c) {
    if (!c.usage) return '';
    return '<div class="card-usage"><span class="usage-tag">Usage</span> ' + escapeHtml(c.usage) + '</div>';
  }
  function mineBlock(c) {
    if (!c.mySentence) return '';
    return '<div class="card-mine"><span class="usage-tag mine">Your sentence</span> ' + highlight(c.mySentence, c.word) + '</div>';
  }

  function nextCard() {
    if (!queue.length) { sessionDone(); return; }
    $('#studyEmpty').hidden = true;
    $('#studyCard').hidden = false;
    current = queue[0];
    var m = C.masteryInfo(current, studyDir);
    var badge = $('#cardMastery');
    badge.className = 'mbadge ' + (MASTERY_CLASS[m.label] || 'm0');
    badge.textContent = (studyDir === 'rev' ? 'Back · ' : 'Front · ') + m.label;
    $('#cardActive').hidden = !current.activeMastery;
    $('#cardSource').textContent = current.source && current.source.label ? '— ' + current.source.label : '';
    if (studyDir === 'rev') {
      // show the meaning; recall the word
      $('#cardFront').innerHTML = meaningBlock(current, true) +
        '<div class="card-pos prompt">What\'s the word?</div>';
    } else {
      $('#cardFront').innerHTML = wordBlock(current);
    }
    $('#cardBack').hidden = true;
    $('#revealBtn').hidden = false;
    // entrance animation
    var card = $('#studyCard');
    card.classList.remove('enter'); void card.offsetWidth; card.classList.add('enter');
    wireCardButtons();
  }
  function revealCard() {
    $('#revealBtn').hidden = true;
    $('#cardBack').hidden = false;
    if (studyDir === 'rev') {
      // back side shows the word; chip goes right under its part of speech
      $('#cardBackContent').innerHTML = wordBlock(current) + zhBlock(current) +
        (current.synonyms && current.synonyms.length ? '<div class="card-syn">' + synChips(current) + '</div>' : '') +
        (current.example ? '<div class="card-example">' + highlight(current.example, current.word) + '</div>' : '') +
        usageBlock(current) + mineBlock(current);
      speak(current.word); // reveal includes a tap gesture, so audio is allowed
    } else {
      // front holds the word + POS; reveal the chip there (under POS, above the divider)
      $('#cardFront').innerHTML = wordBlock(current) + zhBlock(current);
      $('#cardBackContent').innerHTML = meaningBlock(current, false) +
        (current.synonyms && current.synonyms.length ? '<div class="card-syn">' + synChips(current) + '</div>' : '') +
        usageBlock(current) + mineBlock(current);
    }
    var src = current.source || {};
    $('#cardSeenIn').innerHTML = src.label
      ? 'Seen in: ' + (src.url
          ? '<a href="' + escapeHtml(src.url) + '" target="_blank" rel="noopener">' + escapeHtml(src.label) + '</a>'
          : escapeHtml(src.label))
      : '';
    wireCardButtons();
    setupPractice();
  }
  function wireCardButtons() {
    $$('#studyCard .speak').forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); speak(b.dataset.speak, b.dataset.coll); };
    });
    $$('#studyCard .zh-toggle').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var t = b.parentNode.querySelector('.card-translation');
        if (t) t.hidden = false;
        b.hidden = true;
      };
    });
  }

  // ---------- practice (write a sentence, AI checks it) ----------
  function setupPractice() {
    // The sentence check is an English coach — hide it for other collections.
    var practiceBox = document.querySelector('.practice');
    if (practiceBox) practiceBox.hidden = C.getCollection(current) !== C.DEFAULT_COLLECTION;
    $('#practicePanel').hidden = true;
    $('#practiceInput').value = current.mySentence || '';
    $('#practiceFeedback').innerHTML = '';
    $('#practiceToggle').textContent = current.mySentence ? '✍️ Practice (saved ✓)' : '✍️ Practice using it';
  }
  $('#practiceToggle').addEventListener('click', function () {
    var p = $('#practicePanel');
    p.hidden = !p.hidden;
    if (!p.hidden) $('#practiceInput').focus();
  });
  $('#practiceCheck').addEventListener('click', async function () {
    var s = $('#practiceInput').value.trim();
    if (!s) { toast('Write a sentence first.'); return; }
    if (!hasKeys()) { toast('Add your keys in Settings first.'); show('settings'); return; }
    var fb = $('#practiceFeedback');
    fb.innerHTML = '<p class="muted"><span class="spinner"></span>Checking…</p>';
    try {
      var r = await C.checkSentence(cfg, current.word, current.definition, s);
      renderFeedback(r, s);
    } catch (e) { fb.innerHTML = '<p class="banner">' + escapeHtml(e.message) + '</p>'; }
  });
  function renderFeedback(r, s) {
    var v = (r.verdict || '').toLowerCase();
    var cls = v === 'correct' ? 'v-good' : (v === 'awkward' ? 'v-warn' : 'v-bad');
    var label = v === 'correct' ? '✓ Natural' : (v === 'awkward' ? '~ A bit awkward' : '✗ Needs work');
    $('#practiceFeedback').innerHTML = '<div class="fb ' + cls + '">' +
      '<div class="fb-verdict">' + label + '</div>' +
      (r.feedback ? '<div>' + escapeHtml(r.feedback) + '</div>' : '') +
      (r.better ? '<div class="fb-better"><b>More natural:</b> ' + escapeHtml(r.better) + '</div>' : '') +
      (r.tip ? '<div class="fb-tip">💡 ' + escapeHtml(r.tip) + '</div>' : '') +
      '<button id="practiceSave" class="secondary small">Save my sentence ✓</button>' +
      '</div>';
    $('#practiceSave').addEventListener('click', function () { savePractice(s); });
  }
  function savePractice(s) {
    current.mySentence = s;
    current.activeMastery = true;
    dirty = true; scheduleFlush();
    $('#cardActive').hidden = false;
    $('#practiceToggle').textContent = '✍️ Practice (saved ✓)';
    toast('Saved your sentence ✓');
  }
  function rate(rating) {
    if (!current) return;
    C.srsReview(current, rating, studyDir);
    if (C.isRetired(current, studyDir)) {
      toast('🎉 Retired “' + current.word + '” (' + (studyDir === 'rev' ? 'back' : 'front') + ') — mastered!');
    }
    dirty = true;
    scheduleFlush();
    if (rating !== 'again') sessionDone[current.id] = true;
    // remove from front; if 'again', re-queue near the end of this session
    queue.shift();
    if (rating === 'again') queue.push(current);
    updateProgress();
    updateDueBadge();
    nextCard();
  }
  $('#revealBtn').addEventListener('click', revealCard);
  $$('.rate').forEach(function (b) { b.addEventListener('click', function () { rate(b.dataset.rate); }); });

  // ---------- flush (batched saves) ----------
  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 1500);
  }
  async function flush() {
    if (!dirty || !hasKeys()) return;
    dirty = false;
    try {
      deck.sha = await C.saveDeck(cfg, deck.cards, deck.sha, 'study progress');
      cacheDeck();
    } catch (e) {
      if (e.status === 409) {
        try { var fresh = await C.loadDeck(cfg); deck.sha = fresh.sha; deck.sha = await C.saveDeck(cfg, deck.cards, deck.sha, 'study progress (retry)'); cacheDeck(); return; }
        catch (e2) {}
      }
      dirty = true; // try again later
      toast('Could not save progress (will retry).');
    }
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });
  window.addEventListener('pagehide', function () { if (dirty) flush(); });

  // ---------- ADD ----------
  function renderAddForm() {
    refreshCollectionPicker();
    var eng = selectedCollection === C.DEFAULT_COLLECTION;
    $('#addPanel').hidden = creatingCollection;
    $('#newCollectionPanel').hidden = !creatingCollection;
    if (!creatingCollection) $('#addManualPanel').hidden = true;
    $('#addTitle').textContent = creatingCollection ? 'New collection'
      : (eng ? 'Add a word' : 'Add to ' + selectedCollection);
    $('#addWord').placeholder = eng
      ? 'Type an English word or phrase'
      : 'Type what you want to remember';
  }
  $('#manualToggle').addEventListener('click', function (e) {
    e.preventDefault();
    var p = $('#addManualPanel');
    p.hidden = !p.hidden;
    if (!p.hidden) $('#manFront').focus();
  });
  $('#newCollectionBtn').addEventListener('click', function () {
    var name = $('#newCollectionName').value.trim();
    if (!name) { toast('Type a collection name first.'); return; }
    if (C.listCollections(deck.cards).indexOf(name) >= 0 || name === pendingCollection) {
      creatingCollection = false;
      selectedCollection = name;
      persistCollection();
      renderAddForm();
      toast('Collection “' + name + '” already exists — switched to it.');
      return;
    }
    pendingCollection = name;
    selectedCollection = name;
    persistCollection();
    creatingCollection = false;
    $('#newCollectionName').value = '';
    refreshCollectionPicker();
    renderAddForm();
    toast('New collection “' + name + '” — add its first card in the box.');
    $('#addWord').focus();
  });
  $('#newCollectionCancel').addEventListener('click', function () {
    creatingCollection = false;
    $('#newCollectionName').value = '';
    renderAddForm();
  });
  async function doAdd(word, sourceLabel) {
    word = (word || '').trim();
    if (!word) return;
    if (!hasKeys()) { toast('Add your keys in Settings first.'); show('settings'); return; }
    var coll = selectedCollection;
    var provisional = C.buildCard(word, {}, null, coll);
    var existing = deck.cards.find(function (c) { return C.getCollection(c) === coll && c.id === provisional.id; });
    var box = $('#addResult');
    if (existing) { box.innerHTML = ''; box.appendChild(renderCardPreview(existing)); toast('Already in ' + coll + '.'); return; }
    box.innerHTML = '<p class="muted"><span class="spinner"></span>Looking up “' + escapeHtml(word) + '”…</p>';
    try {
      var source = { label: sourceLabel || '', url: '', via: 'manual' };
      var card = await C.lookup(cfg, word, source, null, coll);
      // The AI may normalize the item (e.g. base form) — re-check for a duplicate.
      var dupe = deck.cards.find(function (c) { return C.getCollection(c) === coll && c.id === card.id; });
      if (dupe) { box.innerHTML = ''; box.appendChild(renderCardPreview(dupe)); toast('Already in ' + coll + '.'); return; }
      deck.cards.push(card);
      deck.sha = await C.saveDeck(cfg, deck.cards, deck.sha, 'add: ' + card.word);
      if (pendingCollection === coll) pendingCollection = null;
      cacheDeck(); updateDueBadge(); refreshCollectionPicker();
      box.innerHTML = ''; box.appendChild(renderCardPreview(card));
      toast('Saved “' + card.word + '” to ' + coll + '.');
      $('#addWord').value = ''; $('#addSource').value = '';
    } catch (e) {
      box.innerHTML = '<p class="banner">' + escapeHtml(e.message) + '</p>';
    }
  }
  $('#addBtn').addEventListener('click', function () { doAdd($('#addWord').value, $('#addSource').value); });
  $('#addWord').addEventListener('keydown', function (e) { if (e.key === 'Enter') doAdd($('#addWord').value, $('#addSource').value); });

  // Manual add (any collection): no AI lookup, just front/back — for personal
  // facts the AI can't know. Reached via the "type both sides yourself" link.
  async function doManualAdd() {
    var front = $('#manFront').value.trim();
    var back = $('#manBack').value.trim();
    if (!front || !back) { toast('Fill in both the front and the back.'); return; }
    if (!hasKeys()) { toast('Add your keys in Settings first.'); show('settings'); return; }
    var coll = selectedCollection;
    var box = $('#addResult');
    var source = { label: $('#manSource').value.trim(), url: '', via: 'manual' };
    var card = C.buildCard(front, { word: front, definition: back, example: $('#manExample').value.trim() }, source, coll);
    var existing = deck.cards.find(function (c) { return C.getCollection(c) === coll && c.id === card.id; });
    if (existing) { box.innerHTML = ''; box.appendChild(renderCardPreview(existing)); toast('Already in ' + coll + '.'); return; }
    try {
      deck.cards.push(card);
      deck.sha = await C.saveDeck(cfg, deck.cards, deck.sha, 'add: ' + card.word);
      if (pendingCollection === coll) pendingCollection = null;
      cacheDeck(); updateDueBadge(); refreshCollectionPicker();
      box.innerHTML = ''; box.appendChild(renderCardPreview(card));
      toast('Saved “' + card.word + '” to ' + coll + '.');
      $('#manFront').value = ''; $('#manBack').value = ''; $('#manExample').value = ''; $('#manSource').value = '';
    } catch (e) {
      box.innerHTML = '<p class="banner">' + escapeHtml(e.message) + '</p>';
    }
  }
  $('#manAddBtn').addEventListener('click', doManualAdd);

  function renderCardPreview(card) {
    var d = document.createElement('div'); d.className = 'card';
    d.innerHTML =
      '<div class="card-word">' + escapeHtml(card.word) + '</div>' +
      '<div class="card-ipa">' + escapeHtml(card.pronunciation || '') + '</div>' +
      '<div class="card-pos">' + escapeHtml(card.partOfSpeech || '') + '</div>' +
      '<div class="card-back" style="border-top:1px solid var(--line);padding-top:14px">' +
        '<div class="card-translation">' + escapeHtml(card.translation || '') + '</div>' +
        '<div class="card-def">' + escapeHtml(card.definition || '') + '</div>' +
        '<div class="card-example">' + (card.example ? highlight(card.example, card.word) : '') + '</div>' +
        usageBlock(card) +
        '<div class="card-syn">' + (card.synonyms || []).map(function (s) { return '<span class="chip">' + escapeHtml(s) + '</span>'; }).join('') + '</div>' +
      '</div>';
    return d;
  }

  // ---------- BROWSE ----------
  function renderBrowse() {
    var sel = $('#sourceFilter');
    var sources = {};
    collectionCards().forEach(function (c) { var l = c.source && c.source.label; if (l) sources[l] = true; });
    var cur = sel.value;
    sel.innerHTML = '<option value="">All sources</option>' +
      Object.keys(sources).sort().map(function (s) { return '<option>' + escapeHtml(s) + '</option>'; }).join('');
    sel.value = cur;
    applyBrowse();
  }
  var MASTERY_CLASS = { 'New': 'm0', 'Learning': 'm1', 'Familiar': 'm2', 'Mastered': 'm3', 'Retired': 'mret' };
  function applyBrowse() {
    var q = $('#searchInput').value.trim().toLowerCase();
    var src = $('#sourceFilter').value;
    var sort = $('#sortBy').value;
    var list = deck.cards.filter(function (c) {
      if (!inCollection(c)) return false;
      if (src && (!c.source || c.source.label !== src)) return false;
      if (!q) return true;
      return (c.word + ' ' + c.definition + ' ' + c.translation + ' ' + (c.synonyms || []).join(' ')).toLowerCase().indexOf(q) >= 0;
    });
    function weakRank(c) { return Math.min(C.masteryInfo(c, 'fwd').rank, C.masteryInfo(c, 'rev').rank); }
    list.sort(function (a, b) {
      switch (sort) {
        case 'added-asc': return (a.added || '').localeCompare(b.added || '');
        case 'mastery-asc': return weakRank(a) - weakRank(b);
        case 'mastery-desc': return weakRank(b) - weakRank(a);
        case 'az': return a.word.localeCompare(b.word);
        case 'added-desc':
        default: return (b.added || '').localeCompare(a.added || '');
      }
    });
    $('#browseCount').textContent = list.length + ' of ' + collectionCards().length + ' word(s) in ' + selectedCollection;
    $('#browseList').innerHTML = list.map(function (c) {
      var mf = C.masteryInfo(c, 'fwd'), mb = C.masteryInfo(c, 'rev');
      var due = (C.isDue(c, 'fwd') || C.isDue(c, 'rev')) ? '<span class="due-dot" title="due"></span>' : '';
      var seen = c.source && c.source.label ? ' · ' + escapeHtml(c.source.label) : '';
      var check = selectMode
        ? '<input type="checkbox" class="bsel" data-id="' + escapeHtml(c.id) + '"' + (selected[c.id] ? ' checked' : '') + '>'
        : '';
      var del = '<button class="bdel" data-id="' + escapeHtml(c.id) + '" title="Delete">🗑</button>';
      var badges = '<span class="mbadge ' + MASTERY_CLASS[mf.label] + '" title="Front (word→meaning)">F·' + mf.label + '</span>' +
                   ' <span class="mbadge ' + MASTERY_CLASS[mb.label] + '" title="Back (meaning→word)">B·' + mb.label + '</span>' +
                   ' <span class="chip" title="Collection">' + escapeHtml(C.getCollection(c)) + '</span>' +
                   (c.activeMastery ? ' <span class="mbadge m3" title="You can use it in your own sentence">✓ Active</span>' : '');
      var unretire = (mf.label === 'Retired' ? ' <button class="bunretire secondary small" data-id="' + escapeHtml(c.id) + '" data-dir="fwd">↩ Bring back F</button>' : '') +
                     (mb.label === 'Retired' ? ' <button class="bunretire secondary small" data-id="' + escapeHtml(c.id) + '" data-dir="rev">↩ Bring back B</button>' : '');
      return '<div class="browse-item' + (selectMode ? ' selectable' : '') + '">' +
        '<div class="bhead">' + check +
          '<div class="bmain"><div>' + due + '<span class="bw">' + escapeHtml(c.word) + '</span> ' + speakBtn(c.word, C.getCollection(c)) +
          ' <span class="bipa">' + escapeHtml(c.pronunciation || '') + '</span> ' +
          '<span class="bpos">' + escapeHtml(c.partOfSpeech || '') + '</span>' +
          ' ' + badges + '</div>' +
          '<div class="btr">' + escapeHtml(c.translation || '') + '</div>' +
          '<div class="bdef">' + escapeHtml(c.definition || '') + '</div>' +
          (c.usage ? '<div class="card-usage"><span class="usage-tag">Usage</span> ' + escapeHtml(c.usage) + '</div>' : '') +
          '<div class="bmeta">added ' + escapeHtml(c.added || '') + ' · next ' + escapeHtml(c.srs ? c.srs.due : '') + seen + unretire + '</div></div>' +
          (selectMode ? '' : del) +
        '</div>' +
      '</div>';
    }).join('') || '<p class="muted">No matches.</p>';
    wireBrowseRowActions();
  }
  function wireBrowseRowActions() {
    $$('#browseList .bdel').forEach(function (b) {
      b.addEventListener('click', function () { confirmDelete([b.dataset.id]); });
    });
    $$('#browseList .bunretire').forEach(function (b) {
      b.addEventListener('click', function () {
        var c = deck.cards.find(function (x) { return x.id === b.dataset.id; });
        if (!c) return;
        C.setRetired(c, b.dataset.dir, false);
        dirty = true; scheduleFlush(); cacheDeck();
        updateDueBadge(); applyBrowse();
        toast('Brought back “' + c.word + '” — due today.');
      });
    });
    $$('#browseList .bsel').forEach(function (cb) {
      cb.addEventListener('change', function () {
        if (cb.checked) selected[cb.dataset.id] = true; else delete selected[cb.dataset.id];
        updateSelCount();
      });
    });
    $$('#browseList .speak').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); speak(b.dataset.speak, b.dataset.coll); });
    });
  }
  function updateSelCount() {
    var n = Object.keys(selected).length;
    $('#selCount').textContent = n + ' selected';
    $('#delSelected').disabled = n === 0;
  }
  async function confirmDelete(ids) {
    if (!ids.length) return;
    if (!hasKeys()) { toast('Add your keys in Settings first.'); return; }
    var names = ids.map(function (id) { var c = deck.cards.find(function (x) { return x.id === id; }); return c ? c.word : id; });
    var msg = ids.length === 1 ? 'Delete “' + names[0] + '”?' : 'Delete ' + ids.length + ' words?';
    if (!confirm(msg)) return;
    try {
      var res = await C.deleteCards(cfg, ids, deck);
      deck.cards = res.cards; deck.sha = res.sha; cacheDeck();
      ids.forEach(function (id) { delete selected[id]; });
      updateDueBadge(); updateSelCount();
      renderBrowse();
      toast('Deleted ' + res.removed + ' word(s).');
    } catch (e) {
      toast('Delete failed: ' + e.message.slice(0, 80));
    }
  }
  $('#searchInput').addEventListener('input', applyBrowse);
  $('#sourceFilter').addEventListener('change', applyBrowse);
  $('#sortBy').addEventListener('change', applyBrowse);
  function setSelectMode(on) {
    selectMode = on;
    if (!on) selected = {};
    var btn = $('#selectMode');
    btn.textContent = on ? 'Done' : 'Select';
    btn.classList.toggle('active-sel', on);
    $('#selAllWrap').hidden = !on;
    $('#selCount').hidden = !on;
    $('#delSelected').hidden = !on;
    if (on) { $('#selAllBrowse').checked = false; }
    updateSelCount();
    applyBrowse();
  }
  $('#selectMode').addEventListener('click', function () { setSelectMode(!selectMode); });
  $('#selAllBrowse').addEventListener('change', function () {
    var on = this.checked;
    $$('#browseList .bsel').forEach(function (cb) {
      cb.checked = on; if (on) selected[cb.dataset.id] = true; else delete selected[cb.dataset.id];
    });
    updateSelCount();
  });
  $('#delSelected').addEventListener('click', function () { confirmDelete(Object.keys(selected)); });

  // ---------- IMPORT ----------
  var parsed = [];
  $('#importFile').addEventListener('change', function () {
    var f = this.files[0]; if (!f) return;
    var r = new FileReader();
    r.onload = function () { $('#importText').value = r.result; };
    r.readAsText(f);
  });
  $('#analyzeBtn').addEventListener('click', async function () {
    if (!hasKeys()) { toast('Add your keys in Settings first.'); show('settings'); return; }
    var text = $('#importText').value.trim();
    if (!text) { toast('Paste a list or choose a file first.'); return; }
    $('#importProgress').innerHTML = '<span class="spinner"></span>Reading your list…';
    $('#importPick').innerHTML = '';
    try {
      parsed = await C.parseImport(cfg, text);
      $('#importProgress').textContent = '';
      renderPick();
    } catch (e) {
      $('#importProgress').innerHTML = '<span class="banner">' + escapeHtml(e.message) + '</span>';
    }
  });
  function renderPick() {
    if (!parsed.length) { $('#importPick').innerHTML = '<p class="muted">No words found.</p>'; return; }
    var known = {};
    deck.cards.forEach(function (c) { if (C.getCollection(c) === C.DEFAULT_COLLECTION) known[c.id] = true; });
    var html = '<div class="pick-actions">' +
      '<button class="secondary" id="selAll">Select all new</button>' +
      '<button class="secondary" id="selNone">Clear</button>' +
      '<button class="primary" id="importGo">Import selected</button>' +
      '<span id="pickCount" class="muted"></span></div>' +
      '<div class="progress" id="impBar" hidden><i></i></div>';
    html += parsed.map(function (it, i) {
      var isKnown = !!known[C.slugId(it.word)];
      return '<label class="pick-item' + (isKnown ? ' known' : '') + '">' +
        '<input type="checkbox" data-i="' + i + '"' + (isKnown ? '' : ' checked') + (isKnown ? ' disabled' : '') + '>' +
        '<span><span class="pw">' + escapeHtml(it.word) + '</span>' +
        (isKnown ? ' <span class="pctx">(already in deck)</span>' : '') +
        (it.context ? '<div class="pctx">' + escapeHtml(it.context.slice(0, 120)) + '</div>' : '') +
        (it.source ? '<div class="pctx">source: ' + escapeHtml(it.source) + '</div>' : '') +
        '</span></label>';
    }).join('');
    $('#importPick').innerHTML = html;
    function count() {
      var n = $$('#importPick input[type=checkbox]:checked').length;
      $('#pickCount').textContent = n + ' selected';
    }
    $('#selAll').addEventListener('click', function () { $$('#importPick input:not(:disabled)').forEach(function (c) { c.checked = true; }); count(); });
    $('#selNone').addEventListener('click', function () { $$('#importPick input').forEach(function (c) { c.checked = false; }); count(); });
    $('#importPick').addEventListener('change', count);
    $('#importGo').addEventListener('click', runImport);
    count();
  }
  async function runImport() {
    var picks = $$('#importPick input[type=checkbox]:checked').map(function (c) { return parsed[+c.dataset.i]; });
    if (!picks.length) { toast('Select at least one word.'); return; }
    var bar = $('#impBar'); bar.hidden = false; var fill = $('#impBar > i');
    $('#importGo').disabled = true;
    var added = 0, failed = 0;
    var results = await C.mapLimit(picks, 3, async function (it) {
      var source = { label: it.source || 'Imported', url: '', via: 'import' };
      // Import is English-only, whatever collection the picker is on.
      var card = await C.lookup(cfg, it.word, source, it.context, C.DEFAULT_COLLECTION);
      return card;
    }, function (done, total) { fill.style.width = Math.round(done / total * 100) + '%'; $('#pickCount').textContent = done + '/' + total; });

    results.forEach(function (r) {
      if (r.ok && r.value && !deck.cards.some(function (c) { return c.id === r.value.id; })) { deck.cards.push(r.value); added++; }
      else if (!r.ok) failed++;
    });
    if (added > 0) {
      try { deck.sha = await C.saveDeck(cfg, deck.cards, deck.sha, 'import ' + added + ' word(s)'); cacheDeck(); }
      catch (e) { toast('Saved locally but GitHub write failed: ' + e.message.slice(0, 80)); }
    }
    updateDueBadge(); refreshCollectionPicker();
    $('#importGo').disabled = false;
    $('#importProgress').textContent = 'Imported ' + added + ' word(s)' + (failed ? ', ' + failed + ' failed' : '') + '.';
    toast('Imported ' + added + ' word(s).');
    parsed = []; $('#importPick').innerHTML = ''; $('#importText').value = '';
  }

  // ---------- SETTINGS ----------
  function fillSettings() {
    $('#setAnthropic').value = cfg.anthropicKey || '';
    $('#setModel').value = cfg.model || DEFAULTS.model;
    $('#setGhToken').value = cfg.githubToken || '';
    $('#setOwner').value = cfg.owner || DEFAULTS.owner;
    $('#setRepo').value = cfg.repo || DEFAULTS.repo;
    $('#setBranch').value = cfg.branch || DEFAULTS.branch;
    $('#setDeckPath').value = cfg.deckPath || DEFAULTS.deckPath;
    $('#setInbox').value = cfg.inboxDir || DEFAULTS.inboxDir;
    $('#setHideZh').checked = cfg.hideChinese !== false;
    var missing = deck.cards.filter(function (c) { return !c.usage && C.getCollection(c) === C.DEFAULT_COLLECTION; }).length;
    $('#backfillUsage').textContent = missing ? ('Fill missing usage notes (' + missing + ')') : 'Usage notes complete ✓';
    $('#backfillUsage').disabled = missing === 0;
  }
  $('#saveSettings').addEventListener('click', async function () {
    cfg.anthropicKey = $('#setAnthropic').value.trim();
    cfg.model = $('#setModel').value.trim() || DEFAULTS.model;
    cfg.githubToken = $('#setGhToken').value.trim();
    cfg.owner = $('#setOwner').value.trim() || DEFAULTS.owner;
    cfg.repo = $('#setRepo').value.trim() || DEFAULTS.repo;
    cfg.branch = $('#setBranch').value.trim() || DEFAULTS.branch;
    cfg.deckPath = $('#setDeckPath').value.trim() || DEFAULTS.deckPath;
    cfg.inboxDir = $('#setInbox').value.trim() || DEFAULTS.inboxDir;
    cfg.hideChinese = $('#setHideZh').checked;
    saveCfg();
    $('#settingsMsg').textContent = 'Saved. Reloading deck…';
    banner('');
    await init();
    $('#settingsMsg').textContent = 'Saved.';
  });
  $('#testConn').addEventListener('click', async function () {
    var m = $('#settingsMsg'); m.innerHTML = '<span class="spinner"></span>Testing…';
    // save current field values first
    cfg.anthropicKey = $('#setAnthropic').value.trim();
    cfg.model = $('#setModel').value.trim() || DEFAULTS.model;
    cfg.githubToken = $('#setGhToken').value.trim();
    cfg.owner = $('#setOwner').value.trim() || DEFAULTS.owner;
    cfg.repo = $('#setRepo').value.trim() || DEFAULTS.repo;
    cfg.branch = $('#setBranch').value.trim() || DEFAULTS.branch;
    cfg.deckPath = $('#setDeckPath').value.trim() || DEFAULTS.deckPath;
    saveCfg();
    var out = [];
    try { var d = await C.loadDeck(cfg); out.push('✅ GitHub OK — ' + d.cards.length + ' word(s) in deck.'); }
    catch (e) { out.push('❌ GitHub: ' + e.message.slice(0, 140)); }
    try { await C.anthropicLookup(cfg, 'test'); out.push('✅ Anthropic OK.'); }
    catch (e) { out.push('❌ Anthropic: ' + e.message.slice(0, 140)); }
    m.innerHTML = out.map(escapeHtml).join('<br>');
  });
  $('#backfillUsage').addEventListener('click', async function () {
    if (!hasKeys()) { toast('Add your keys first.'); return; }
    var missing = deck.cards.filter(function (c) { return !c.usage && C.getCollection(c) === C.DEFAULT_COLLECTION; });
    var m = $('#settingsMsg');
    if (!missing.length) { m.textContent = 'All cards already have usage notes.'; return; }
    var btn = this; btn.disabled = true;
    await C.mapLimit(missing, 3, async function (c) {
      var u = await C.usageFor(cfg, c.word, c.definition);
      if (u) c.usage = u;
    }, function (done, total) { m.innerHTML = '<span class="spinner"></span>Filling usage notes… ' + done + '/' + total; });
    var filled = missing.filter(function (c) { return !!c.usage; }).length;
    try {
      deck.sha = await C.saveDeck(cfg, deck.cards, deck.sha, 'backfill usage notes (' + filled + ')');
      cacheDeck();
      m.textContent = 'Added usage notes to ' + filled + ' card(s).';
    } catch (e) {
      m.textContent = 'Generated locally but GitHub save failed: ' + e.message.slice(0, 80);
    }
    fillSettings();
  });

  // ---------- service worker ----------
  // Service worker for offline study (network-first, so it never serves stale code).
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }

  init();
})();
