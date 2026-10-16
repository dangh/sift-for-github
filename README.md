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

How both work, and why: [ARCHITECTURE.md](ARCHITECTURE.md).

## Benchmarks

Measured 2026-10-16 on [react/react#37778](https://github.com/react/react/pull/37778/changes)
(167 files, ~2,000 lines changed), headless Chrome, logged in. Times are from navigation
start. GitHub itself takes about 4-5.7 s before its first diff request; neither experiment
changes that part.

**Opening on a tab** (Load diffs on demand). Diff requests GitHub makes. Before, it goes on
to fetch all 167 files in 42 sequential requests (~30 s+) whatever the tab. After, counted
when the tab was ready (for Metadata, also 3 s later):

| Opening tab | Before | After |
|---|---|---|
| Metadata (3 files) | 42 | 2-5 |
| Scripts (`scripts/*`, last in the list) | 42 | 2-3 |

The first screen of the tab is ready at about the same time before and after (5-7 s),
because GitHub already fetches on-screen diffs first. The saving is the ~160 diffs of
other tabs that GitHub no longer fetches and renders in the background.

**Switching tabs** after opening on Metadata, no reloads: Tests 1.9 s, All 0.33 s,
Source 0.35 s, back to Metadata 0.33 s. 6 diff requests for the whole session.

**Opening on All** (Parallel diff loading). Time until every file has its diff:

| | Before | After |
|---|---|---|
| All 167 files loaded | 35-47 s | 11-15 s |
| Requests in flight | 1 | ~5 |

Diff contents were identical with the experiment on and off. Not measured yet: main-thread
and memory cost, other PRs, and arriving at a PR from elsewhere on GitHub without a reload.

## Notes

- Reads the file list GitHub embeds in the page, so counts are complete on load and files
  are hidden with a stylesheet before they render. Falls back to scanning the page when
  that data is missing or stale.
- Relies on GitHub's current Files changed markup; selectors may need updating if it changes.
