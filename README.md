# PR Files Tabs

Chrome extension that adds configurable tabs (All / Source / Tests / Metadata by default)
to the GitHub pull request **Files changed** view. Switching a tab filters both the diff
list and the left file tree.

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** and pick this folder.
3. Open a PR's Files changed page.

## Configure

Open the extension's options page to add, rename and reorder tabs, and to choose which
tab opens first on a PR. The tab you pick on a PR is remembered across refreshes.

One pattern per line; a tab shows a file when any pattern matches.

- `package*.json` matches the file name (`*` any characters, `?` one character).
- `services/*/lib/*` (contains `/`) matches the full path.
- `/test/i` is a regex tested against the full path.
- `!Metadata` excludes files that belong to the tab labelled Metadata; `!*.md` excludes
  files matching a pattern. A tab with only `!` lines starts from every file.

## Experiments

Both are on by default and can be turned off in the options page.

- **Load diffs on demand**. When a PR opens on a tab other than All, a page script
  (`page.js`) switches GitHub to the virtualized list it uses for very large PRs, which
  only fetches diffs near the viewport, and hands GitHub's diff store just the open tab's
  files. Files in other tabs aren't fetched until you show them, and switching tabs needs
  no reload. Trade-offs: Find on Page only sees diffs near the screen, and GitHub's own
  file tree and "viewed" counter show the open tab's files. It reaches GitHub's store
  through React internals; if those change it does nothing and tabs fall back to hiding
  files with CSS.
- **Parallel diff loading**. GitHub fetches diff contents 4 files per
  request, one request at a time, so a 160-file PR takes 30 s or more to fill in. A page
  script (`prefetch.js`) wraps `fetch`, loads the same batches with about 5 requests in
  flight, and answers GitHub's queued requests from them. Any batch that fails falls back
  to GitHub's own request. It stays out of the way while the on-demand list is in use.

## Notes

- Reads the file list GitHub embeds in the page, so counts are complete on load and files
  are hidden with a stylesheet before they render. Falls back to scanning the page when
  that data is missing or stale.
- Relies on GitHub's current Files changed markup; selectors may need updating if it changes.
