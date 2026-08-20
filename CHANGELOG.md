# Changelog

## v1.1.1, 20 August 2026

Fixed:
- The Lessons and Ideas tabs threw "Cannot read properties of undefined
  (reading 'split')" on any phone set up before v1.1.0. The config in
  `localStorage` still had the v1.0 shape, with no `lessonsPath` or
  `ideasPath`, and nothing rewrites it until Connect is pressed again, so the
  path handed to the GitHub URL builder was `undefined`. `pathOf` now falls
  back to the default path for the file. Tasks was unaffected and no vault
  file was ever at risk: the crash happened before the fetch.
- The e2e suite now boots the app once with a pre-v1.1.0 config. Every note
  test injected the new keys, so the upgrade path, which is the only path a
  real phone takes, had never been exercised.

## v1.1.0, 20 August 2026

Added:
- Lessons and Ideas tabs, writing to `Lessons Learned.md` and `WU Ideas.md` at
  the root of the vault repo. Capture, plus a read-only list of what is already
  in the note. Newest entry first, no date stamps.
- Note files use their own format: plain paragraphs separated by a blank line,
  no headings and no list syntax. Nothing is parsed inside a paragraph, so
  wikilinks pass through untouched.
- Two file path fields in settings, defaulting to the two notes above.
- `npm run shots` writes light and dark screenshots of all three tabs.

Changed:
- `flush` groups pending ops by file and retries each file independently. One
  file failing no longer discards another file's queued ops, which the old code
  did: the e2e test for it found an empty queue against the previous version.
- Ops carry a `file` key. An op without one is treated as a Tasks op, so
  anything queued by v1.0.1 on a phone still lands correctly after the upgrade.
- A note file is fetched the first time its tab is opened, never at boot. Cold
  open still loads only `001 Tasks.md`.

## v1.0.1, 20 August 2026

Fixed:
- Adding a task no longer inserts a blank line above it, and completing one no
  longer strips the blank line under the `## Done` heading. A parsed section
  carries the blank line after its heading, and the blank before the next
  heading, as real items, so the old `items.push` landed each new task after
  the trailing one and `unshift` landed a completed task above the leading one.
  Adds `appendTask` and `prependTask`, which anchor on the tasks themselves
  rather than counting blanks.

Added:
- `test/model.js` and `test/model.test.js`: the pure model is now extracted
  from `index.html` and run in node. 20 tests, including one idempotency test
  per op type.
- `test/e2e.js`: Playwright against a fake in-memory GitHub, covering the 409
  retry and the offline queue paths.
- `package.json` with `test`, `test:model`, `test:e2e`, `serve`, `shots`.

Changed:
- The pure region of `index.html` is contiguous and marked with `MODEL START`
  and `MODEL END`. No behaviour change.
