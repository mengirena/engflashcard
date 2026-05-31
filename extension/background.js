/* background.js — MV3 service worker.
   Right-click a selection -> look up via Anthropic, save to GitHub inbox,
   show the meaning as an in-page overlay (no navigation). */
importScripts('core.js');
var C = self.FlashcardCore;

var DEFAULTS = {
  anthropicKey: '', model: 'claude-3-5-haiku-latest', githubToken: '',
  owner: 'mengirena', repo: 'engflashcard', branch: 'main',
  deckPath: 'docs/data/words.json', inboxDir: 'docs/data/inbox'
};
async function getCfg() {
  var s = await chrome.storage.local.get('flashcfg');
  return Object.assign({}, DEFAULTS, s.flashcfg || {});
}

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.create({
    id: 'fc_lookup',
    title: 'Look up & save “%s”',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener(async function (info, tab) {
  if (info.menuItemId !== 'fc_lookup' || !info.selectionText || !tab || !tab.id) return;
  var word = info.selectionText.trim().split(/\s+/).slice(0, 6).join(' ');
  await render(tab.id, { state: 'loading', word: word });
  var cfg = await getCfg();
  if (!cfg.anthropicKey || !cfg.githubToken) {
    await render(tab.id, { state: 'error', word: word, message: 'Open the extension Options (right-click the toolbar icon → Options) and add your Anthropic key + GitHub token.' });
    return;
  }
  try {
    var source = { label: tab.title || '', url: tab.url || '', via: 'extension' };
    var card = await C.lookup(cfg, word, source);
    var save = await C.saveCapture(cfg, card);
    card.__saved = save.skipped ? 'Already saved earlier' : 'Saved to your flashcards';
    await render(tab.id, { state: 'result', card: card });
  } catch (e) {
    await render(tab.id, { state: 'error', word: word, message: e.message });
  }
});

function render(tabId, payload) {
  return chrome.scripting.executeScript({ target: { tabId: tabId }, func: overlay, args: [payload] })
    .catch(function () {});
}

/* Injected into the page. Self-contained (only uses its `payload` arg). */
function overlay(payload) {
  var ID = '__fc_overlay_host__';
  var host = document.getElementById(ID);
  if (!host) {
    host = document.createElement('div');
    host.id = ID;
    (document.documentElement || document.body).appendChild(host);
    host.attachShadow({ mode: 'open' });
  }
  var sh = host.shadowRoot;
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  var body = '';
  if (payload.state === 'loading') {
    body = '<div class="fc-row fc-load"><span class="fc-spin"></span>Looking up “' + esc(payload.word) + '”…</div>';
  } else if (payload.state === 'error') {
    body = '<div class="fc-err">' + esc(payload.message || 'Something went wrong.') + '</div>';
  } else {
    var c = payload.card;
    var syn = (c.synonyms || []).map(function (s) { return '<span class="fc-chip">' + esc(s) + '</span>'; }).join('');
    body =
      '<div class="fc-w">' + esc(c.word) + ' <span class="fc-ipa">' + esc(c.pronunciation || '') + '</span></div>' +
      '<div class="fc-pos">' + esc(c.partOfSpeech || '') + '</div>' +
      '<div class="fc-tr">' + esc(c.translation || '') + '</div>' +
      '<div class="fc-def">' + esc(c.definition || '') + '</div>' +
      (c.example ? '<div class="fc-ex">' + esc(c.example) + '</div>' : '') +
      (syn ? '<div class="fc-syn">' + syn + '</div>' : '') +
      '<div class="fc-ok">✓ ' + esc(c.__saved || 'Saved') + '</div>';
  }
  sh.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '.fc-card{position:fixed;top:16px;right:16px;z-index:2147483647;width:320px;max-width:92vw;' +
    'background:#fff;color:#1f2333;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.25);' +
    'padding:16px 18px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45}' +
    '.fc-x{position:absolute;top:8px;right:10px;border:0;background:transparent;font-size:20px;cursor:pointer;color:#9aa0b4}' +
    '.fc-w{font-size:20px;font-weight:800;padding-right:18px}' +
    '.fc-ipa{color:#4f46e5;font-weight:600;font-size:14px}' +
    '.fc-pos{color:#6b7280;font-style:italic;margin-bottom:6px}' +
    '.fc-tr{font-size:17px;font-weight:700;margin:4px 0}' +
    '.fc-def{margin:4px 0}' +
    '.fc-ex{background:#f5f6fb;border-radius:8px;padding:7px 9px;font-style:italic;margin:6px 0}' +
    '.fc-chip{display:inline-block;background:#eef0fb;color:#4f46e5;padding:2px 9px;border-radius:999px;font-size:12px;margin:3px 4px 0 0}' +
    '.fc-ok{color:#10b981;font-weight:600;margin-top:10px}' +
    '.fc-err{color:#b91c1c}' +
    '.fc-load{color:#6b7280}' +
    '.fc-spin{display:inline-block;width:13px;height:13px;border:2px solid #c7c9d6;border-top-color:#4f46e5;border-radius:50%;margin-right:8px;animation:fcsp .7s linear infinite;vertical-align:-2px}' +
    '@keyframes fcsp{to{transform:rotate(360deg)}}' +
    '@media (prefers-color-scheme:dark){.fc-card{background:#1c1e29;color:#e8e9f0}.fc-ex{background:#13141b}.fc-chip{background:#262a3d}}' +
    '</style>' +
    '<div class="fc-card"><button class="fc-x" aria-label="Close">×</button>' + body + '</div>';

  var close = function () { try { host.remove(); } catch (e) {} document.removeEventListener('keydown', onKey); };
  sh.querySelector('.fc-x').onclick = close;
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  setTimeout(function () {
    document.addEventListener('mousedown', function md(e) {
      if (!host.contains(e.target)) { close(); document.removeEventListener('mousedown', md); }
    });
  }, 0);
}
