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
    deckPath: 'docs/data/words.json', inboxDir: 'docs/data/inbox'
  };

  var cfg = loadCfg();
  var deck = { cards: [], sha: null };   // canonical, mutated in place
  var queue = [];                         // study queue (card refs)
  var current = null;
  var dirty = false;
  var flushTimer = null;
  var online = true;

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
    var n = deck.cards.filter(function (c) { return C.isDue(c); }).length;
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
        banner('');
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
    queue = deck.cards.filter(function (c) { return C.isDue(c); });
    // new/most-overdue first-ish: keep stable; shuffle lightly
    queue.sort(function (a, b) { return (a.srs.due || '').localeCompare(b.srs.due || ''); });
  }
  function renderStudy() {
    buildQueue();
    updateDueBadge();
    if (!queue.length) {
      $('#studyCard').hidden = true;
      $('#studyEmpty').hidden = false;
      $('#studyEmptyMsg').textContent = deck.cards.length
        ? 'Nothing due right now. You have ' + deck.cards.length + ' word(s) total.'
        : 'No words yet — add some in the Add or Import tab, or look one up on your phone.';
      return;
    }
    $('#studyEmpty').hidden = true;
    $('#studyCard').hidden = false;
    nextCard();
  }
  function nextCard() {
    if (!queue.length) { renderStudy(); return; }
    current = queue[0];
    $('#cardSource').textContent = current.source && current.source.label ? '— ' + current.source.label : '';
    $('#cardWord').textContent = current.word;
    $('#cardIpa').textContent = current.pronunciation || '';
    $('#cardPos').textContent = current.partOfSpeech || '';
    $('#cardBack').hidden = true;
    $('#revealBtn').hidden = false;
  }
  function revealCard() {
    $('#revealBtn').hidden = true;
    $('#cardBack').hidden = false;
    $('#cardTranslation').textContent = current.translation || '';
    $('#cardDef').textContent = current.definition || '';
    $('#cardExample').innerHTML = current.example ? highlight(current.example, current.word) : '';
    $('#cardSyn').innerHTML = (current.synonyms || []).map(function (s) {
      return '<span class="chip">' + escapeHtml(s) + '</span>';
    }).join('');
    var src = current.source || {};
    if (src.label) {
      $('#cardSeenIn').innerHTML = 'Seen in: ' + (src.url
        ? '<a href="' + escapeHtml(src.url) + '" target="_blank" rel="noopener">' + escapeHtml(src.label) + '</a>'
        : escapeHtml(src.label));
    } else { $('#cardSeenIn').textContent = ''; }
  }
  function rate(rating) {
    if (!current) return;
    C.srsReview(current, rating);
    dirty = true;
    scheduleFlush();
    // remove from front; if 'again', re-queue near the end of this session
    queue.shift();
    if (rating === 'again') queue.push(current);
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
  function applyBrowse() {
    var q = $('#searchInput').value.trim().toLowerCase();
    var src = $('#sourceFilter').value;
    var list = deck.cards.filter(function (c) {
      if (src && (!c.source || c.source.label !== src)) return false;
      if (!q) return true;
      return (c.word + ' ' + c.definition + ' ' + c.translation + ' ' + (c.synonyms || []).join(' ')).toLowerCase().indexOf(q) >= 0;
    });
    list.sort(function (a, b) { return (b.added || '').localeCompare(a.added || ''); });
    $('#browseCount').textContent = list.length + ' of ' + deck.cards.length + ' word(s)';
    $('#browseList').innerHTML = list.map(function (c) {
      var due = C.isDue(c) ? '<span class="due-dot" title="due"></span>' : '';
      var seen = c.source && c.source.label ? ' · ' + escapeHtml(c.source.label) : '';
      return '<div class="browse-item">' +
        '<div>' + due + '<span class="bw">' + escapeHtml(c.word) + '</span>' +
        '<span class="bipa">' + escapeHtml(c.pronunciation || '') + '</span> ' +
        '<span class="bpos">' + escapeHtml(c.partOfSpeech || '') + '</span></div>' +
        '<div class="btr">' + escapeHtml(c.translation || '') + '</div>' +
        '<div class="bdef">' + escapeHtml(c.definition || '') + '</div>' +
        '<div class="bmeta">added ' + escapeHtml(c.added || '') + ' · next ' + escapeHtml(c.srs ? c.srs.due : '') + seen + '</div>' +
      '</div>';
    }).join('') || '<p class="muted">No matches.</p>';
  }
  $('#searchInput').addEventListener('input', applyBrowse);
  $('#sourceFilter').addEventListener('change', applyBrowse);

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
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }

  init();
})();
