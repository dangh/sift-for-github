// Runs in the page (MAIN world) so it can wrap the fetch GitHub's diff loader uses.
// GitHub loads diff contents 4 files per request, strictly one request at a time. When it
// asks for the first batch, fetch every file in parallel batches and answer GitHub's queued
// requests from those, so its queue drains as fast as the batches land.
(function () {
  const CONCURRENCY = 5;
  const BATCH = 4;
  let nativeFetch = window.fetch;
  let initialPr = prPath(location.pathname);
  let embeddedRead = false;
  // PR path -> { files: [path], loaded: Set(path) } from the page's embedded or route data.
  let routes = new Map();
  let plan = null;

  // content.js keeps a copy of the extension config here (see page.js); it is on by default.
  function enabled() {
    try {
      return JSON.parse(localStorage.getItem('ghpt:config'))?.experiments?.parallelLoad !== false;
    } catch (e) {
      return true;
    }
  }

  function prPath(pathname) {
    let match = pathname.match(/^\/[^/]+\/[^/]+\/pull\/\d+/);
    return match ? match[0] : '';
  }

  function remember(pr, route) {
    if (pr && Array.isArray(route?.diffSummaries)) {
      // diffContents holds diffs GitHub already has inline (the first file); it never asks for them.
      let loaded = new Set((route.diffContents || []).map((entry) => entry.path));
      // In the virtualized list (see page.js) GitHub only asks for diffs near the viewport;
      // fetching every file ahead would undo that.
      let virtualized = Boolean(route.virtualizeDiffEntries);
      routes.set(pr, { files: route.diffSummaries.map((s) => s.path), loaded, virtualized });
    }
  }

  // The embedded data describes the page as first loaded, which soft navigation may have left.
  function readEmbedded() {
    embeddedRead = true;
    for (let script of document.querySelectorAll('script[data-target="react-app.embeddedData"]')) {
      try {
        let route = JSON.parse(script.textContent)?.payload?.pullRequestsChangesRoute;
        if (route) {
          remember(initialPr, route);
          return;
        }
      } catch (e) {
        // not the script we want
      }
    }
  }

  // Query params as raw [key, value] pairs, so rebuilt URLs match GitHub's byte for byte.
  function rawPairs(search) {
    return search.replace(/^\?/, '').split('&').filter(Boolean).map((part) => {
      let at = part.indexOf('=');
      return at === -1 ? [part, ''] : [part.slice(0, at), part.slice(at + 1)];
    });
  }

  // How GitHub encodes one path in the paths list: encodeURIComponent, then form encoding.
  function segmentOf(path) {
    return new URLSearchParams([['p', encodeURIComponent(path)]]).toString().slice(2);
  }

  function createPlan(key, url, pairs, init) {
    let pr = prPath(url.pathname);
    if (!embeddedRead && pr === initialPr) {
      readEmbedded();
    }
    let route = routes.get(pr);
    if (!route || route.virtualized) {
      return null;
    }
    let entries = new Map();
    let resolvers = new Map();
    for (let path of route.files) {
      if (!route.loaded.has(path)) {
        entries.set(path, new Promise((resolve) => resolvers.set(path, resolve)));
      }
    }
    // File order, which is the order GitHub's queue asks in; anything it asks for out of
    // order (e.g. a file scrolled into view) is promoted.
    let queue = [...entries.keys()];
    let running = 0;
    // Same headers GitHub sent, minus its abort signal (a batch serves several of its requests).
    let options = { method: 'GET', credentials: init?.credentials || 'same-origin', headers: init?.headers };

    function load(batch) {
      let query = pairs.map(([k, v]) => {
        if (k === 'paths') {
          return k + '=' + batch.map(segmentOf).join('%2C');
        }
        if (k === 'ctx') {
          return k + '=' + '%3A'.repeat(batch.length - 1);
        }
        return k + '=' + v;
      });
      running += 1;
      nativeFetch.call(window, url.origin + url.pathname + '?' + query.join('&'), options)
        .then((response) => response.ok ? response.json() : null)
        .catch(() => null)
        .then(function (list) {
          let byPath = new Map((Array.isArray(list) ? list : []).map((entry) => [entry?.path, entry]));
          for (let path of batch) {
            resolvers.get(path)(byPath.get(path) || null);
          }
          running -= 1;
          pump();
        });
    }

    function pump() {
      while (running < CONCURRENCY && queue.length > 0) {
        load(queue.splice(0, BATCH));
      }
    }

    // Paths GitHub is waiting on skip the queue, as GitHub's own request would have.
    function promote(paths) {
      let waiting = paths.filter((p) => queue.includes(p));
      if (waiting.length > 0) {
        queue = queue.filter((p) => !waiting.includes(p));
        load(waiting);
      }
    }

    pump();
    return { key, entries, promote };
  }

  function abortError() {
    return new DOMException('The operation was aborted.', 'AbortError');
  }

  function untilAbort(promise, signal) {
    if (!signal) {
      return promise;
    }
    if (signal.aborted) {
      return Promise.reject(abortError());
    }
    return new Promise(function (resolve, reject) {
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
      promise.then(resolve, reject);
    });
  }

  // Returns a promise for GitHub's response, or null to let the request through unchanged.
  function answer(url, init, original) {
    let pairs = rawPairs(url.search);
    let raw = pairs.find(([k]) => k === 'paths')?.[1];
    let ctx = decodeURIComponent(pairs.find(([k]) => k === 'ctx')?.[1] || '');
    // Extra context lines (e.g. around comments) are per request; leave those to GitHub.
    if (!raw || /[^:]/.test(ctx)) {
      return null;
    }
    let paths;
    try {
      paths = raw.split('%2C').map((s) => decodeURIComponent(decodeURIComponent(s)));
    } catch (e) {
      return null;
    }
    // Requests for another commit range or whitespace setting need a fresh plan.
    let key = url.pathname + '?' + pairs.filter(([k]) => k !== 'paths' && k !== 'ctx').map((p) => p.join('=')).join('&');
    if (plan?.key !== key) {
      plan = createPlan(key, url, pairs, init);
    }
    let pending = paths.map((p) => plan?.entries.get(p));
    if (pending.some((p) => !p)) {
      return null;
    }
    plan.promote(paths);
    let current = plan;
    let response = Promise.all(pending).then(function (entries) {
      if (init?.signal?.aborted) {
        return null;
      }
      // GitHub treats a path missing from the response as loading forever, so any failure
      // falls back to its own request rather than a partial answer.
      if (entries.some((e) => !e)) {
        return original();
      }
      for (let path of paths) {
        current.entries.delete(path);
      }
      return new Response(JSON.stringify(entries), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    });
    return untilAbort(response, init?.signal);
  }

  function isRouteData(url, init) {
    if (!/^\/[^/]+\/[^/]+\/pull\/\d+\/changes$/.test(url.pathname)) {
      return false;
    }
    try {
      return new Headers(init?.headers).get('X-GitHub-App-Type') === 'dataRouter';
    } catch (e) {
      return false;
    }
  }

  window.fetch = function fetch(input, init) {
    let self = this;
    let args = arguments;
    let original = () => nativeFetch.apply(self, args);
    if (typeof input !== 'string' && !(input instanceof URL)) {
      return original();
    }
    let url;
    try {
      url = new URL(input, location.href);
    } catch (e) {
      return original();
    }
    if (url.origin !== location.origin) {
      return original();
    }
    if (/^\/[^/]+\/[^/]+\/pull\/\d+\/page_data\/diff_entries$/.test(url.pathname)) {
      return (enabled() && answer(url, init, original)) || original();
    }
    if (isRouteData(url, init) && enabled()) {
      // Soft navigation to Files changed: keep the file list from GitHub's route data, and
      // plan afresh since GitHub's loader starts over too.
      let pending = original();
      pending.then((response) => response.ok ? response.clone().json() : null)
        .then(function (data) {
          remember(prPath(url.pathname), data?.payload?.pullRequestsChangesRoute);
          plan = null;
        })
        .catch(() => {});
      return pending;
    }
    return original();
  };
})();
