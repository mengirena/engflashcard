var DEFAULTS = {
  anthropicKey: '', model: 'claude-3-5-haiku-latest', githubToken: '',
  owner: 'mengirena', repo: 'engflashcard', branch: 'main',
  deckPath: 'docs/data/words.json', inboxDir: 'docs/data/inbox'
};
var FIELDS = ['anthropicKey', 'model', 'githubToken', 'owner', 'repo', 'branch', 'inboxDir'];

function $(id) { return document.getElementById(id); }

chrome.storage.local.get('flashcfg', function (s) {
  var cfg = Object.assign({}, DEFAULTS, s.flashcfg || {});
  FIELDS.forEach(function (f) { $(f).value = cfg[f] || ''; });
});

$('save').addEventListener('click', function () {
  chrome.storage.local.get('flashcfg', function (s) {
    var cfg = Object.assign({}, DEFAULTS, s.flashcfg || {});
    FIELDS.forEach(function (f) { cfg[f] = $(f).value.trim() || DEFAULTS[f]; });
    cfg.deckPath = DEFAULTS.deckPath;
    chrome.storage.local.set({ flashcfg: cfg }, function () {
      $('msg').textContent = '✓ Saved.';
      setTimeout(function () { $('msg').textContent = ''; }, 2000);
    });
  });
});
