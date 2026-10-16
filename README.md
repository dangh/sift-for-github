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

## Notes

- Reads the file list GitHub embeds in the page, so counts are complete on load and files
  are hidden with a stylesheet before they render. Falls back to scanning the page when
  that data is missing or stale.
- Relies on GitHub's current Files changed markup; selectors may need updating if it changes.
