let tabsEl = document.getElementById('tabs');
let defaultEl = document.getElementById('default');
let statusEl = document.getElementById('status');

function addTab(tab) {
  let box = document.createElement('div');
  box.className = 'tab';

  let row = document.createElement('div');
  row.className = 'row';
  let label = document.createElement('input');
  label.placeholder = 'Tab label';
  label.value = tab.label;
  label.className = 'label';
  row.append(label);
  for (let [text, action] of [['Up', 'up'], ['Down', 'down'], ['Delete', 'delete']]) {
    let btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.dataset.action = action;
    row.append(btn);
  }

  let area = document.createElement('textarea');
  area.className = 'patterns';
  area.value = tab.patterns.join('\n');
  area.spellcheck = false;

  box.append(row, area);
  tabsEl.append(box);
}

function refreshDefaults(selected) {
  let current = selected;
  if (current === undefined) {
    current = defaultEl.value;
  }
  defaultEl.textContent = '';
  let all = new Option('All', '');
  defaultEl.append(all);
  for (let box of tabsEl.children) {
    let label = box.querySelector('.label').value.trim();
    if (label) {
      defaultEl.append(new Option(label, label));
    }
  }
  defaultEl.value = current;
}

function show(config) {
  tabsEl.textContent = '';
  for (let tab of config.tabs) {
    addTab(tab);
  }
  refreshDefaults(config.defaultTab || '');
}

function read() {
  let tabs = [];
  for (let box of tabsEl.children) {
    let label = box.querySelector('.label').value.trim();
    let patterns = box.querySelector('.patterns').value.split('\n').map((p) => p.trim()).filter(Boolean);
    if (label) {
      tabs.push({ label, patterns });
    }
  }
  return { tabs, defaultTab: defaultEl.value };
}

function flash(text) {
  statusEl.textContent = text;
  setTimeout(() => { statusEl.textContent = ''; }, 2500);
}

function probe() {
  let path = document.getElementById('probe').value.trim();
  let result = document.getElementById('result');
  if (!path) {
    result.textContent = '';
    return;
  }
  let config = read();
  let held = GHPT.classify(GHPT.compileConfig(config), path);
  let labels = [...held].map((i) => config.tabs[i].label);
  result.textContent = '→ ' + (labels.join(', ') || 'no tab (only shown under All)');
}

tabsEl.addEventListener('click', function (event) {
  let btn = event.target.closest('button[data-action]');
  if (!btn) {
    return;
  }
  let box = btn.closest('.tab');
  if (btn.dataset.action === 'delete') {
    box.remove();
  }
  if (btn.dataset.action === 'up' && box.previousElementSibling) {
    box.previousElementSibling.before(box);
  }
  if (btn.dataset.action === 'down' && box.nextElementSibling) {
    box.nextElementSibling.after(box);
  }
  refreshDefaults();
  probe();
});

tabsEl.addEventListener('input', function () {
  refreshDefaults();
  probe();
});
document.getElementById('probe').addEventListener('input', probe);

document.getElementById('add').addEventListener('click', function () {
  addTab({ label: '', patterns: [] });
});

document.getElementById('save').addEventListener('click', async function () {
  let config = read();
  let invalid = [];
  for (let tab of config.tabs) {
    for (let pattern of tab.patterns) {
      if (!GHPT.compile(pattern.replace(/^!/, ''))) {
        invalid.push(pattern);
      }
    }
  }
  if (invalid.length > 0) {
    flash('Invalid pattern: ' + invalid[0]);
    return;
  }
  await chrome.storage.sync.set({ config });
  flash('Saved');
});

document.getElementById('reset').addEventListener('click', async function () {
  await chrome.storage.sync.remove('config');
  show(GHPT.DEFAULTS);
  flash('Reset');
});

GHPT.load().then(show);
