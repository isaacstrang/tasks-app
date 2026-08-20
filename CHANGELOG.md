# Changelog

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
