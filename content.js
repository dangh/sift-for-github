(function () {
  let config = GHPT.DEFAULTS;
  let compiled = GHPT.compileConfig(config);
  let active = 'all';
  let activeFor = null;
  let ready = false;
  let timer = null;

  function prKey() {
    return GHPT.prKey(location.pathname);
  }

  function saveChoice(pr, tabs, key) {
    let value = 'all';
    let tab = tabs.find((t) => t.key === key);
    if (key !== 'all' && tab) {
      value = 'tab:' + tab.label;
    }
    try {
      sessionStorage.setItem('ghpt:' + pr, value);
    } catch (e) {
      // storage unavailable; the choice just won't persist
    }
  }

  function tabList() {
    return GHPT.tabList(config);
  }

  // page.js runs before chrome.storage can answer and can't reach it anyway, so it reads this copy.
  function shareConfig() {
    try {
      localStorage.setItem('ghpt:config', JSON.stringify(config));
    } catch (e) {
      // storage unavailable; page.js then leaves GitHub's loading alone
    }
  }

  function pathOf(container) {
    let raw = container.getAttribute('data-tagsearch-path') || '';
    if (!raw) {
      let header = container.querySelector('h3 code, h3, [class*="file-name"]');
      if (header) {
        // Renames separate old and new path with an SVG arrow, not text.
        let copy = header.cloneNode(true);
        for (let svg of copy.querySelectorAll('svg')) {
          svg.replaceWith('\u2192');
        }
        raw = copy.textContent;
      }
    }
    // The new path decides the bucket for renames.
    let parts = raw.replace(/[\u200e\u200f\u202a-\u202e]/g, '').split('\u2192');
    return parts.pop().trim();
  }

  function findContainers() {
    let all = document.querySelectorAll('[id^="diff-"], .file[data-tagsearch-path]');
    let valid = [];
    for (let el of all) {
      if (/^diff-[0-9a-f]{16,}$/.test(el.id) || el.hasAttribute('data-tagsearch-path')) {
        valid.push(el);
      }
    }
    // Drop any match nested inside another match (e.g. classic UI line cells).
    return valid.filter((el) => !valid.some((other) => other !== el && other.contains(el)));
  }

  // GitHub wraps each diff in an entry that reserves its own height and list gap, so the
  // wrapper has to be hidden too. Walk up while the parent holds only this one child.
  function slotOf(el) {
    let slot = el;
    // A virtualized row (data-index) is the outermost per-file wrapper; its parent is the list.
    while (!slot.hasAttribute('data-index') && slot.parentElement && slot.parentElement.children.length === 1 && slot.parentElement.tagName === 'DIV') {
      slot = slot.parentElement;
    }
    return slot;
  }

  function labelOf(item) {
    let text = item.querySelector('[class*="item-content-text"]') || item.querySelector('span');
    return text?.textContent.trim() || '';
  }

  function treePathOf(item) {
    // Tree rows carry their full path as the element id.
    if (item.id) {
      return item.id;
    }
    let parts = [labelOf(item)];
    let parent = item.parentElement?.closest('li[role="treeitem"]');
    while (parent) {
      parts.unshift(labelOf(parent));
      parent = parent.parentElement?.closest('li[role="treeitem"]');
    }
    return parts.join('/');
  }

  // Filters the left file tree. Files resolve through the diff anchor they link to
  // (falling back to the path built from labels); folders stay only if they hold a visible file.
  function filterTree(bucketByPath, bucketByDiffId) {
    let items = document.querySelectorAll('[role="tree"] li[role="treeitem"]');
    let activePaths = [];
    for (let [path, held] of bucketByPath) {
      if (active === 'all' || held.has(Number(active))) {
        activePaths.push(path);
      }
    }
    for (let item of items) {
      let isFolder = item.hasAttribute('aria-expanded');
      let path = treePathOf(item);
      let visible = true;
      if (active !== 'all' && isFolder) {
        visible = activePaths.some((p) => p.startsWith(path + '/'));
      }
      if (active !== 'all' && !isFolder) {
        let href = item.querySelector('a[href*="#diff-"]')?.getAttribute('href') || '';
        let held = bucketByDiffId.get(href.slice(href.indexOf('#') + 1)) || bucketByPath.get(path);
        visible = Boolean(held?.has(Number(active)));
      }
      if (visible) {
        delete item.dataset.ghptHidden;
      } else {
        item.dataset.ghptHidden = '1';
      }
    }
  }

  function onFilesPage() {
    return /\/pull\/\d+\/(files|changes)/.test(location.pathname);
  }

  // GitHub embeds the whole PR's file list in the initial page (digest = the diff element id
  // suffix), so every file is known before the lazy diff list renders.
  let summaryCache = new WeakMap();

  function readSummary() {
    for (let script of document.querySelectorAll('script[data-target="react-app.embeddedData"]')) {
      if (!summaryCache.has(script)) {
        let map = null;
        try {
          let list = JSON.parse(script.textContent)?.payload?.pullRequestsChangesRoute?.diffSummaries;
          if (Array.isArray(list) && list.length > 0) {
            map = new Map(list.map((s) => [s.pathDigest, s.path]));
          }
        } catch (e) {
          // not the script we want
        }
        summaryCache.set(script, map);
      }
      if (summaryCache.get(script)) {
        return summaryCache.get(script);
      }
    }
    return null;
  }

  // Hiding by stylesheet applies the moment GitHub renders a file, so there is no flash
  // of unfiltered files while the list loads.
  function writeFilterStyle(files, heldByDiffId) {
    let rules = [];
    if (active !== 'all') {
      for (let file of files) {
        if (!heldByDiffId.get('diff-' + file.digest).has(Number(active))) {
          rules.push('div:has(> #diff-' + file.digest + ') { display: none !important; }');
          rules.push('li[role="treeitem"][id=' + JSON.stringify(file.path) + '] { display: none !important; }');
        }
      }
    }
    let css = rules.join('\n');
    let style = document.getElementById('ghpt-filter');
    if (!style) {
      style = document.createElement('style');
      style.id = 'ghpt-filter';
      document.head.append(style);
    }
    if (style.textContent !== css) {
      style.textContent = css;
    }
  }

  function render() {
    if (!ready) {
      return;
    }
    let bar = document.getElementById('ghpt-bar');
    if (!onFilesPage()) {
      bar?.remove();
      document.getElementById('ghpt-filter')?.remove();
      delete document.documentElement.dataset.ghptActive;
      return;
    }

    let containers = findContainers();
    let summary = readSummary();
    // A rendered diff missing from the embedded list means the list is stale (e.g. the
    // commit range changed without a page load); fall back to the DOM.
    if (summary && containers.some((el) => !summary.has(el.id.replace(/^diff-/, '')))) {
      summary = null;
    }
    if (containers.length === 0 && !summary) {
      return;
    }

    let tabs = tabList();
    let pr = prKey();
    if (activeFor !== pr) {
      activeFor = pr;
      active = GHPT.initialKey(config, pr);
    }
    if (!tabs.some((t) => t.key === active)) {
      active = 'all';
    }
    // page.js watches this to hand GitHub only the open tab's files.
    if (document.documentElement.dataset.ghptActive !== active) {
      document.documentElement.dataset.ghptActive = active;
    }

    let files = [];
    if (summary) {
      for (let [digest, path] of summary) {
        files.push({ digest, path });
      }
    } else {
      for (let el of containers) {
        files.push({ digest: el.id.replace(/^diff-/, ''), path: pathOf(el) });
      }
    }

    let counts = { all: files.length };
    for (let tab of tabs) {
      counts[tab.key] = counts[tab.key] || 0;
    }
    let bucketByPath = new Map();
    let bucketByDiffId = new Map();
    for (let file of files) {
      let held = GHPT.classify(compiled, file.path);
      bucketByPath.set(file.path, held);
      bucketByDiffId.set('diff-' + file.digest, held);
      for (let index of held) {
        counts[String(index)] += 1;
      }
    }
    let hide = new Set();
    for (let el of containers) {
      let held = bucketByDiffId.get(el.id);
      if (active !== 'all' && !held.has(Number(active))) {
        hide.add(slotOf(el));
      }
    }
    // A wrapper that held a single hidden diff can later hold more (GitHub's virtualized list
    // reuses its row container), so drop every mark this pass doesn't set again.
    for (let el of document.querySelectorAll('[data-ghpt-hidden]:not(li[role="treeitem"])')) {
      if (!hide.has(el)) {
        delete el.dataset.ghptHidden;
      }
    }
    for (let slot of hide) {
      slot.dataset.ghptHidden = '1';
    }
    if (summary) {
      writeFilterStyle(files, bucketByDiffId);
    } else {
      document.getElementById('ghpt-filter')?.remove();
    }

    filterTree(bucketByPath, bucketByDiffId);

    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'ghpt-bar';
      bar.setAttribute('role', 'tablist');
      bar.addEventListener('change', function (event) {
        if (event.target.matches('select.ghpt-select')) {
          active = event.target.value;
          saveChoice(prKey(), tabList(), active);
          render();
        }
      });
      bar.addEventListener('click', function (event) {
        let btn = event.target.closest('button[data-key]');
        if (btn) {
          active = btn.dataset.key;
          saveChoice(prKey(), tabList(), active);
          render();
        }
      });
    }

    let signature = tabs.map((t) => t.key + t.label + counts[t.key] + (t.key === active)).join('|');
    if (bar.dataset.sig !== signature) {
      bar.dataset.sig = signature;
      bar.textContent = '';
      for (let tab of tabs) {
        let btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.key = tab.key;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', String(tab.key === active));
        btn.append(tab.label);
        let count = document.createElement('span');
        count.className = 'ghpt-count';
        count.textContent = String(counts[tab.key]);
        btn.append(count);
        bar.append(btn);
      }
      // Shown instead of the buttons when the toolbar is too narrow (see fit()).
      let select = document.createElement('select');
      select.className = 'ghpt-select';
      select.setAttribute('aria-label', 'File filter');
      for (let tab of tabs) {
        select.append(new Option(tab.label + ' (' + counts[tab.key] + ')', tab.key));
      }
      select.value = active;
      bar.append(select);
    }

    placeBar(bar, containers[0]);
    fit(bar);
  }

  // Collapse the buttons into a dropdown when the toolbar row can't hold them all.
  function fit(bar) {
    bar.classList.remove('ghpt-compact');
    let toolbar = bar.closest('section');
    if (!bar.classList.contains('ghpt-inline') || !toolbar) {
      return;
    }
    let used = 0;
    for (let child of toolbar.children) {
      used += child.offsetWidth;
    }
    let right = bar.parentElement;
    let natural = used - right.offsetWidth + right.scrollWidth;
    if (natural + 32 > toolbar.clientWidth) {
      bar.classList.add('ghpt-compact');
    }
  }

  // Prefer the sticky toolbar row (left of the viewed counter and Submit review).
  // Fall back to just above the first diff on pages without that toolbar.
  function placeBar(bar, firstDiff) {
    let review = [...document.querySelectorAll('button')].find((b) => /Submit review/.test(b.textContent));
    let toolbar = review?.closest('section');
    let anchor = review;
    while (toolbar && anchor && anchor.parentElement !== toolbar) {
      anchor = anchor.parentElement;
    }
    if (toolbar && anchor) {
      bar.classList.add('ghpt-inline');
      // First child of the right-hand group, i.e. just left of the viewed counter.
      if (bar.parentElement !== anchor || anchor.firstElementChild !== bar) {
        anchor.insertBefore(bar, anchor.firstElementChild);
      }
      return;
    }
    bar.classList.remove('ghpt-inline');
    if (firstDiff && bar.nextElementSibling !== firstDiff) {
      firstDiff.parentElement.insertBefore(bar, firstDiff);
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(render, 200);
  }

  // GitHub is a SPA and lazily renders diffs, so re-run on DOM changes (debounced).
  window.addEventListener('resize', schedule);
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener(async function (changes) {
    if (changes.config) {
      config = await GHPT.load();
      compiled = GHPT.compileConfig(config);
      shareConfig();
      render();
    }
  });

  GHPT.load().then(function (loaded) {
    config = loaded;
    compiled = GHPT.compileConfig(config);
    shareConfig();
    ready = true;
    render();
  });
})();
