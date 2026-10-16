// The page-world prefetcher (prefetch.js) can't read chrome.storage, so tell it whether it
// is enabled. Either side may load first: it asks with ghpt:want-config, we answer whenever
// the config is ready, and again when it changes.
(function () {
  let config = null;

  function send() {
    if (config) {
      let detail = JSON.stringify({ parallelLoad: config.experiments.parallelLoad });
      window.dispatchEvent(new CustomEvent('ghpt:config', { detail }));
    }
  }

  window.addEventListener('ghpt:want-config', send);

  chrome.storage.onChanged.addListener(async function (changes) {
    if (changes.config) {
      config = await GHPT.load();
      send();
    }
  });

  GHPT.load().then(function (loaded) {
    config = loaded;
    send();
  });
})();
