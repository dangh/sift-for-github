// Runs in GitHub's own JS world at document_start, so it can adjust GitHub's page data
// before GitHub reads it.
(function () {
  const EMBEDDED = 'script[data-target="react-app.embeddedData"]';

  function cachedConfig() {
    try {
      return JSON.parse(localStorage.getItem('ghpt:config'));
    } catch (e) {
      return null;
    }
  }

  // GitHub's normal list fetches every diff up front, one request at a time, so the files in
  // the open tab wait behind all the others. Its virtualized list (normally reserved for huge
  // PRs) only fetches diffs near the viewport, and files hidden by a tab never get there.
  function wantsOnDemand(pathname) {
    let config = cachedConfig();
    if (!config?.tabs || config.experiments?.onDemandDiffs === false) {
      return false;
    }
    let pr = GHPT.prKey(pathname);
    return Boolean(pr) && GHPT.initialKey(config, pr) !== 'all';
  }

  function patch(data, pathname) {
    let route = data?.payload?.pullRequestsChangesRoute;
    if (!route || route.virtualizeDiffEntries || !wantsOnDemand(pathname)) {
      return false;
    }
    route.virtualizeDiffEntries = true;
    return true;
  }

  // Returns false while the script's JSON is still incomplete.
  function patchScript(script) {
    let data;
    try {
      data = JSON.parse(script.textContent);
    } catch (e) {
      return false;
    }
    if (patch(data, location.pathname)) {
      script.textContent = JSON.stringify(data);
    }
    return true;
  }

  // GitHub keeps the PR's file list in a store that its diff list and file tree read. Handing
  // it only the open tab's files makes the list render just those, so the virtualized list
  // has no gaps where hidden files sit and only loads what is on screen. The store is reached
  // through React internals; if anything looks different GitHub is left alone and content.js
  // still hides files with CSS.
  let store = null;
  let full = null;
  let shown = null;
  let lastLookup = 0;

  function findStore() {
    // Other elements also have ids starting with "diff-" (e.g. the comparison picker).
    let el = document.querySelector('[data-testid="virtualized-diffs-list"]') ||
      [...document.querySelectorAll('[id^="diff-"]')].find((e) => /^diff-[0-9a-f]{16,}$/.test(e.id));
    let key = el && Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    for (let fiber = el?.[key], depth = 0; fiber && depth < 200; fiber = fiber.return, depth++) {
      let value = fiber.memoizedProps?.value;
      if (typeof value?.getState === 'function' && value.getState()?.diffSummariesActions?.setDiffSummaries) {
        return value;
      }
    }
    return null;
  }

  function sameKeys(a, b) {
    let keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b);
  }

  function track(found) {
    store = found;
    full = { ...found.getState().diffSummaries };
    shown = null;
    found.subscribe(function (state) {
      if (store !== found || state.diffSummaries === shown) {
        return;
      }
      if (shown && sameKeys(state.diffSummaries, shown)) {
        // GitHub updated files it was handed (e.g. one marked viewed); keep those versions.
        Object.assign(full, state.diffSummaries);
        shown = state.diffSummaries;
        return;
      }
      // GitHub loaded a new file list (e.g. new commits pushed); it becomes the full list.
      full = { ...state.diffSummaries };
      shown = null;
      apply();
    });
    apply();
  }

  function apply() {
    let key = document.documentElement.dataset.ghptActive;
    let config = cachedConfig();
    if (!store || !key || !config?.tabs || config.experiments?.onDemandDiffs === false) {
      return;
    }
    if (key === 'all' && !shown) {
      // GitHub already has every file.
      return;
    }
    let next = full;
    if (key !== 'all') {
      let compiled = GHPT.compileConfig(config);
      next = {};
      for (let [path, summary] of Object.entries(full)) {
        if (GHPT.classify(compiled, path).has(Number(key))) {
          next[path] = summary;
        }
      }
    }
    // Set first: the store notifies subscribers synchronously.
    shown = next;
    store.getState().diffSummariesActions.setDiffSummaries(next);
  }

  // A new PR page (or in-app navigation) mounts a new store.
  function lookForStore() {
    if (Date.now() - lastLookup < 300) {
      return;
    }
    lastLookup = Date.now();
    let found = findStore();
    if (found && found !== store) {
      track(found);
    }
  }

  // The parser streams large JSON into the script's existing text node, which fires no
  // childList record, so an incomplete script is retried on every later batch of DOM changes
  // (the parser keeps adding nodes long before GitHub's deferred bundles read the data).
  let pending = new Set();
  // document.documentElement doesn't exist yet at document_start.
  new MutationObserver(function (records) {
    let tabChanged = false;
    for (let record of records) {
      tabChanged ||= record.type === 'attributes';
      for (let node of record.addedNodes) {
        if (node.nodeType === 1 && node.matches(EMBEDDED)) {
          pending.add(node);
        }
      }
    }
    for (let script of pending) {
      if (patchScript(script)) {
        pending.delete(script);
      }
    }
    lookForStore();
    if (tabChanged) {
      apply();
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-ghpt-active'] });

  // In-app navigation to the Files changed page fetches the same page data as JSON.
  let originalFetch = window.fetch;
  window.fetch = function (input) {
    let request = originalFetch.apply(this, arguments);
    let url;
    try {
      url = new URL(String(input?.url ?? input), location.href);
    } catch (e) {
      return request;
    }
    if (!/\/pull\/\d+\/(changes|files)\/?$/.test(url.pathname)) {
      return request;
    }
    return request.then(async function (response) {
      if (!response.headers.get('content-type')?.includes('json')) {
        return response;
      }
      try {
        let data = await response.clone().json();
        if (patch(data, url.pathname)) {
          let { status, statusText, headers } = response;
          return new Response(JSON.stringify(data), { status, statusText, headers });
        }
      } catch (e) {
        // not the page data; hand GitHub the original
      }
      return response;
    });
  };
})();
