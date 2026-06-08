/* app.js — PWA UI. Uses self.FlashcardCore (core.js). */
(function () {
  'use strict';
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
    $$('.view').forEach(function (v) { v.hidden = true; });
    var el = $('#view-' + view); if (el) el.hidden = false;
    $$('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.view === view); });
    if (view === 'study') renderStudy();
    if (view === 'browse') renderBrowse();
    if (view === 'settings') fillSettings();
  }
  $$('.tab').forEach(function (t) {
    t.addEventListener('click', function () { show(t.dataset.view); });
  });

  // ---------- init ----------
  function updateDueBadge() {
    var n = deck.cards.filter(function (c) { return C.isDue(c, studyDir); }).length;
    var b = $('#dueBadge');
    b.textContent = n; b.hidden = n === 0;
  }

  async function init() {
    // show cached deck immediately if available
    var cached = loadCachedDeck();
    if (cached) { deck = cached; updateDueBadge(); }

    if (!hasKeys()) {
      banner('👋 Welcome! Open <b>⚙︎ Settings</b> and paste your GitHub token + Anthropic key to start syncing.');
    }

    // try to load fresh from GitHub
    if (hasKeys()) {
      try {
        var fresh = await C.loadDeck(cfg);
        deck = fresh;
        cacheDeck();
        // fold in any words captured from the extension / phone
        var res = await C.ingestInbox(cfg, deck);
        if (res.ingested > 0) { deck.cards = res.cards; deck.sha = res.sha; cacheDeck(); toast('Added ' + res.ingested + ' captured word(s).'); }
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
      queue = deck.cards.slice().sort(function (a, b) {
        return C.masteryInfo(a, studyDir).rank - C.masteryInfo(b, studyDir).rank;
      });
    } else {
      // due cards in RANDOM order (not sequential) so each session feels fresh
      queue = shuffle(deck.cards.filter(function (c) { return C.isDue(c, studyDir); }));
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
      $('#studyCard').hidden = true;
      $('#studyEmpty').hidden = false;
      $('#studyEmptyTitle').textContent = !deck.cards.length ? 'No words yet' : 'All caught up 🎉';
      $('#studyEmptyMsg').textContent = !deck.cards.length
        ? 'No words yet — add some in the Add or Import tab, or look one up on your phone.'
        : (studyMode === 'weak'
            ? 'No words to practice.'
            : 'Nothing due right now. Try "Weak words" to practice anyway — you have ' + deck.cards.length + ' word(s) total.');
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
    var dueLeft = deck.cards.filter(function (c) { return C.isDue(c, studyDir); }).length;
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
  function speak(text) {
    if (!speechOK || !text) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US'; u.rate = 0.95;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }
  function speakBtn(text) {
    if (!speechOK) return '';
    return '<button class="speak" data-speak="' + escapeHtml(text) + '" title="Play audio" aria-label="Play audio">🔊</button>';
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
    return '<div class="card-word">' + escapeHtml(c.word) + ' ' + speakBtn(c.word) + '</div>' +
      '<div class="card-ipa">' + escapeHtml(c.pronunciation || '') + '</div>' +
      '<div class="card-pos">' + escapeHtml(c.partOfSpeech || '') + '</div>';
  }
  function meaningBlock(c, blankExample) {
    var ex = c.example ? (blankExample ? maskWord(c.example, c.word) : highlight(c.example, c.word)) : '';
    return '<div class="card-def">' + escapeHtml(c.definition || '') + '</div>' +
      (ex ? '<div class="card-example">' + ex + '</div>' : '');
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
      $('#cardBackContent').innerHTML = wordBlock(current) +
        (current.synonyms && current.synonyms.length ? '<div class="card-syn">' + synChips(current) + '</div>' : '') +
        (current.example ? '<div class="card-example">' + highlight(current.example, current.word) + '</div>' : '') +
        zhBlock(current);
      speak(current.word); // reveal includes a tap gesture, so audio is allowed
    } else {
      $('#cardBackContent').innerHTML = meaningBlock(current, false) +
        (current.synonyms && current.synonyms.length ? '<div class="card-syn">' + synChips(current) + '</div>' : '') +
        zhBlock(current);
    }
    var src = current.source || {};
    $('#cardSeenIn').innerHTML = src.label
      ? 'Seen in: ' + (src.url
          ? '<a href="' + escapeHtml(src.url) + '" target="_blank" rel="noopener">' + escapeHtml(src.label) + '</a>'
          : escapeHtml(src.label))
      : '';
    wireCardButtons();
  }
  function wireCardButtons() {
    $$('#studyCard .speak').forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); speak(b.dataset.speak); };
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
  function rate(rating) {
    if (!current) return;
    C.srsReview(current, rating, studyDir);
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
  async function doAdd(word, sourceLabel) {
    word = (word || '').trim();
    if (!word) return;
    if (!hasKeys()) { toast('Add your keys in Settings first.'); show('settings'); return; }
    var existing = deck.cards.find(function (c) { return c.id === C.slugId(word); });
    var box = $('#addResult');
    if (existing) { box.innerHTML = ''; box.appendChild(renderCardPreview(existing)); toast('Already in your deck.'); return; }
    box.innerHTML = '<p class="muted"><span class="spinner"></span>Looking up “' + escapeHtml(word) + '”…</p>';
    try {
      var source = { label: sourceLabel || '', url: '', via: 'manual' };
      var card = await C.lookup(cfg, word, source);
      deck.cards.push(card);
      deck.sha = await C.saveDeck(cfg, deck.cards, deck.sha, 'add: ' + card.word);
      cacheDeck(); updateDueBadge();
      box.innerHTML = ''; box.appendChild(renderCardPreview(card));
      toast('Saved “' + card.word + '”.');
      $('#addWord').value = ''; $('#addSource').value = '';
    } catch (e) {
      box.innerHTML = '<p class="banner">' + escapeHtml(e.message) + '</p>';
    }
  }
  $('#addBtn').addEventListener('click', function () { doAdd($('#addWord').value, $('#addSource').value); });
  $('#addWord').addEventListener('keydown', function (e) { if (e.key === 'Enter') doAdd($('#addWord').value, $('#addSource').value); });

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
        '<div class="card-syn">' + (card.synonyms || []).map(function (s) { return '<span class="chip">' + escapeHtml(s) + '</span>'; }).join('') + '</div>' +
      '</div>';
    return d;
  }

  // ---------- BROWSE ----------
  function renderBrowse() {
    var sel = $('#sourceFilter');
    var sources = {};
    deck.cards.forEach(function (c) { var l = c.source && c.source.label; if (l) sources[l] = true; });
    var cur = sel.value;
    sel.innerHTML = '<option value="">All sources</option>' +
      Object.keys(sources).sort().map(function (s) { return '<option>' + escapeHtml(s) + '</option>'; }).join('');
    sel.value = cur;
    applyBrowse();
  }
  var MASTERY_CLASS = { 'New': 'm0', 'Learning': 'm1', 'Familiar': 'm2', 'Mastered': 'm3' };
  function applyBrowse() {
    var q = $('#searchInput').value.trim().toLowerCase();
    var src = $('#sourceFilter').value;
    var sort = $('#sortBy').value;
    var list = deck.cards.filter(function (c) {
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
    $('#browseCount').textContent = list.length + ' of ' + deck.cards.length + ' word(s)';
    $('#browseList').innerHTML = list.map(function (c) {
      var mf = C.masteryInfo(c, 'fwd'), mb = C.masteryInfo(c, 'rev');
      var due = (C.isDue(c, 'fwd') || C.isDue(c, 'rev')) ? '<span class="due-dot" title="due"></span>' : '';
      var seen = c.source && c.source.label ? ' · ' + escapeHtml(c.source.label) : '';
      var check = selectMode
        ? '<input type="checkbox" class="bsel" data-id="' + escapeHtml(c.id) + '"' + (selected[c.id] ? ' checked' : '') + '>'
        : '';
      var del = '<button class="bdel" data-id="' + escapeHtml(c.id) + '" title="Delete">🗑</button>';
      var badges = '<span class="mbadge ' + MASTERY_CLASS[mf.label] + '" title="Front (word→meaning)">F·' + mf.label + '</span>' +
                   ' <span class="mbadge ' + MASTERY_CLASS[mb.label] + '" title="Back (meaning→word)">B·' + mb.label + '</span>';
      return '<div class="browse-item' + (selectMode ? ' selectable' : '') + '">' +
        '<div class="bhead">' + check +
          '<div class="bmain"><div>' + due + '<span class="bw">' + escapeHtml(c.word) + '</span> ' + speakBtn(c.word) +
          ' <span class="bipa">' + escapeHtml(c.pronunciation || '') + '</span> ' +
          '<span class="bpos">' + escapeHtml(c.partOfSpeech || '') + '</span>' +
          ' ' + badges + '</div>' +
          '<div class="btr">' + escapeHtml(c.translation || '') + '</div>' +
          '<div class="bdef">' + escapeHtml(c.definition || '') + '</div>' +
          '<div class="bmeta">added ' + escapeHtml(c.added || '') + ' · next ' + escapeHtml(c.srs ? c.srs.due : '') + seen + '</div></div>' +
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
    $$('#browseList .bsel').forEach(function (cb) {
      cb.addEventListener('change', function () {
        if (cb.checked) selected[cb.dataset.id] = true; else delete selected[cb.dataset.id];
        updateSelCount();
      });
    });
    $$('#browseList .speak').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); speak(b.dataset.speak); });
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
    deck.cards.forEach(function (c) { known[c.id] = true; });
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
      var card = await C.lookup(cfg, it.word, source, it.context);
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
    updateDueBadge();
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

  // ---------- service worker ----------
  // Service worker for offline study (network-first, so it never serves stale code).
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }

  init();
})();
