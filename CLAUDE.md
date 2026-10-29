# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

A phone front end for one Markdown file. That file is `001 Tasks.md` at the root
of Isaac's private Obsidian vault repo, `isaacstrang/obsidian`. It is the single
source of truth for his personal tasks across every Claude chat, his Mac, and
his phone.

**This app is not the source of truth. It is one of several writers to a file
that a human reads in Obsidian every day.** That framing decides most of the
arguments you will have with yourself in here. When a design choice is between
"nicer app" and "cleaner Markdown", clean Markdown wins.

## Stakes

A bug here does not show a wrong pixel. It corrupts a real, actively used vault
file. Realistic damage: silently dropping a task, duplicating a task on every
sync, splitting a list so half of it disappears from Obsidian's reading view, or
clobbering an edit Isaac made on his Mac thirty seconds ago.

Run `npm test` before you hand anything back. Not "if the change looks risky".

## Architecture

```
  Phone (this app) ──HTTPS──► GitHub Contents API
                                 isaacstrang/obsidian
                                   001 Tasks.md
                                   WU Ideas.md
                                   Lessons Learned.md
                                    │        ▲
                       auto pull    │        │  auto commit + push
                        (2 min)     ▼        │  (5 min)
                              Mac vault, Obsidian
                                    ▲
                                    │  Obsidian Local REST API, port 27124
                              Claude chats via the Obsidian MCP
```

There is no server and no database. The app talks straight to the GitHub
Contents API with a fine-grained token that lives in the phone's
`localStorage`, scoped to that one repo with Contents read and write.

Consequences worth holding in your head:

- **The vault changes underneath the app constantly.** The Mac pushes every five
  minutes. Any write that assumes the app's last-read version is still current
  will lose data.
- **The Obsidian MCP is not in this path.** That is deliberate. The MCP only
  works while Obsidian is open on the Mac, which is exactly when Isaac is least
  likely to need his phone. Do not add a dependency on it.
- **GitHub is the only backend.** Do not introduce a database, a Worker, or a
  build step without asking. The whole design is "a static file anyone can
  redeploy by dragging six files into a repo".

## Layout

```
index.html                everything: markup, CSS, and all the JS
sw.js                     service worker, app-shell cache, offline fallback
manifest.webmanifest      PWA install, Android share target, home-screen shortcut
icon-*.png                generated, 192 / 512 / 512-maskable
test/model.js             extracts the pure model out of index.html
test/model.test.js        parse, serialize and op tests, plain node
test/e2e.js               Playwright against a fake in-memory GitHub, plus shots
test/fixtures/            synthetic note files, structurally like the real ones
CHANGELOG.md              one entry per released version
```

`index.html` is one file on purpose. No bundler, no framework, no npm at
runtime. Keep it that way.

Inside the script there is a marked region:

```js
/* ===== MODEL START ===== */   // pure, DOM-free, browser-free
/* ===== MODEL END ===== */
```

`test/model.js` extracts exactly that region and runs it in node. So **nothing
inside those markers may touch `document`, `localStorage`, or `fetch`.** If you
move code across that boundary, run `npm run test:model` immediately, because
breaking the extraction fails loudly rather than subtly.

## Working on this from Claude Code

```bash
git clone https://github.com/isaacstrang/tasks-app.git
cd tasks-app
npm install          # playwright only, and only for the e2e run
npx playwright install chromium   # once per machine
npm test
```

That is the whole setup. Nothing to build, nothing to configure, no env file.
The model tests use node's built-in test runner and need no dependencies at
all, so `npm run test:model` works on a bare clone.

The edit loop is: change `index.html`, run `npm test`, bump `CACHE` in `sw.js`,
commit, push. GitHub Pages redeploys off `main` in about a minute. There is no
staging environment, so `npm test` is the only gate between an edit and Isaac's
live task list.

`npm run shots` writes light and dark screenshots to `test/shots/` if you want to
eyeball a CSS change without a phone in your hand.

Two things this repo cannot see, so ask rather than guess:

- **The vault repo** (`isaacstrang/obsidian`) is private and separate. Confirmed
  20 Aug 2026: the vault directory is the repo root, and its root holds
  `001 Tasks.md`, `WU Ideas.md` and `Lessons Learned.md`. If a change touches
  either Markdown contract, the real files have to be eyeballed by hand, and the
  `personal-tasks` skill has to move in the same commit.
- **The `index.lock` trap** below applies to the Cowork device bridge, not to
  Claude Code on the Mac. Local git here is ordinary git and can unlink files
  fine. Do not code around a problem you do not have.

## The Markdown contract

```markdown
# Tasks

Free-text preamble, preserved verbatim.

## Today
## This week
## Longer term
## Ice box
## Done
```

- One task per line, top level only: `- [ ] text` or `- [x] text`.
- No indentation, no sub-bullets, no nested lists. The parser keeps unrecognised
  lines as opaque `raw` items so it never eats content, but the app cannot show
  or move them.
- Completed tasks move to the **top** of `## Done` with a stamp: `(done Aug 13)`.
- Older vaults used `## Later` and `## Someday / maybe`. `ALIASES` maps those to
  `Longer term` and `Ice box` on read, and they are written back under the new
  names. Do not delete that map; there are still old notes and old backups.
- Unknown `##` sections are preserved and rendered read-mostly, ordered after the
  four known sections. `## Done` is always pinned last.

New tasks default to **This week**, not Today. Today is reserved for what Isaac
has actually committed to today, and defaulting to it makes the section
meaningless. The `personal-tasks` skill uses the same default; keep them in step.

## The note contract

`WU Ideas.md` and `Lessons Learned.md` are **not** in the Tasks format.

- No headings, no frontmatter, no list syntax.
- One entry per paragraph, separated by a single blank line. **That blank line
  is the record separator**, the exact inverse of what a blank line means in
  `001 Tasks.md`. Removing it merges two entries into one.
- Nothing is parsed inside a paragraph, so wikilinks, punctuation and accented
  characters pass straight through.
- Entries are single paragraphs by contract. A pasted multi-line entry is
  flattened by `flattenEntry` rather than silently becoming two entries on the
  next read.
- The app never creates structure in these files. If one grows headings by
  hand, they become ordinary entry text and are preserved verbatim.
- New entries go on **top**, newest first. No date stamps.

The app is capture plus read only here. It cannot edit, delete or reorder an
entry, and that is deliberate: these notes have no lifecycle, so the task
machinery would earn nothing and would triple the surface area that can corrupt
a vault file.

Fixtures in `test/fixtures/` are **synthetic**. They reproduce the structural
properties of the real notes, a missing trailing newline on one and an inline
wikilink on the other, without putting Isaac's actual content into this repo,
which is public.

## The sync model

Naive read-modify-write loses data here, because the Mac pushes on its own
schedule. So the app keeps an **operation queue** instead of a dirty document.

Every user action pushes a small, replayable op onto `queue`, applies it
optimistically to the in-memory doc, and schedules a debounced flush:

```js
{ t:"add",  file:"tasks", sec, text }
{ t:"del",  file:"tasks", sec, text }
{ t:"edit", file:"tasks", sec, text, newText }
{ t:"move", file:"tasks", from, to, text, newText?, done? }
{ t:"reorder", file:"tasks", sec, text, before }
{ t:"note", file:"lessons"|"ideas", text }
```

`flush()` groups the pending ops **by file**, then runs `flushFile` once per
file, sequentially. Sequential and not concurrent on purpose: three parallel
writes to one repo would generate 409s against each other for no reason.

`flushFile(id, ops)` then, for up to three attempts:

1. **Re-fetches** that file from GitHub, getting the current content and sha.
2. **Replays** that file's pending ops onto the fresh content, with `applyAll`
   for Tasks or `applyAllNotes` for a note.
3. `PUT`s the result with that sha. A 409 or 422 means someone else wrote in
   between, so it loops and replays onto the newer version.

Two rules in `flush()` that are easy to break and expensive to break:

- **Queue removal is by identity, never by count.** The old `queue.slice(n)` was
  correct only while the sent ops were a contiguous prefix. Grouped by file they
  are not.
- **One file failing must never drop another file's ops.** Each file's ops leave
  the queue only when that file's `PUT` succeeds. The previous code abandoned
  the whole batch on a single throw, which is data loss once there is more than
  one file. There is an e2e test pinning this.

The queue persists to `localStorage`, so a task added on the subway survives
being killed by Android and pushes when signal returns.

### Two invariants you must not break

**Ops match tasks by exact line text within a section.** There are no task IDs,
because an ID would be a visible artefact in a file a human reads. So an op that
rewrites text must carry both `text` and `newText`, and any code that changes a
line has to go through an op rather than mutating `doc` directly.

**Every op must be idempotent.** A flush can fail after GitHub has already
committed, and the same op gets replayed onto content that already contains its
effect. `add` checks for an existing identical line first; `move` returns early
if the task is already at the destination. If you add an op type, add an
idempotency test with it. There is one for each existing type in
`test/model.test.js`.

**Position is a neighbour, never an index.** `reorder` carries `before`, the
exact text of the task it should sit immediately above, with `before:null`
meaning the bottom of the section. An index would point at a different task the
moment anyone else writes to the file, and the Mac pushes every five minutes.
Naming a neighbour also makes the op idempotent for free, because "put this
line above that one" gives the same answer however many times it is replayed.
It no-ops when either the task or the anchor has gone from the section, which
is exactly what a replay meets when the task was deleted in Obsidian in the
meantime.

Beware `Array.splice(-1, 1)`. It is not an error, it silently removes the last
element, so every `findTask` result has to be checked against -1 before it
reaches a splice. Two of the reorder guards were written correctly but went
unpinned by tests at first, because in the fixtures the stolen last item
happened to be a blank line and `serialize` collapses runs of newlines. A
section whose last item is a real task, which means the last section in the
file, is the shape that exposes it.

### Blank lines

A parsed section carries **two** blank lines as real items: the one under its
heading, and the one before the next heading. So a plain `items.push` lands a
new task after the trailing blank, and `unshift` lands a completed task above
the leading one. The results are `- [ ] a`, blank, `- [ ] b`, which Obsidian
renders as a loose list, and a `## Done` heading with no blank line under it.

`appendTask` and `prependTask` exist to prevent both. They anchor on the tasks
themselves, inserting after the last task or before the first, and fall back to
"after any leading blanks" for a section that has no tasks yet. That is what
makes the empty-section and missing-section cases come out right too. Do not
reintroduce `items.push` or `unshift` for tasks.

**Severity, so nobody over-corrects:** this shipped and sat in the live vault
file for a week before it was found, in August 2026. Verified by Isaac on 20
Aug 2026 as cosmetic. The tasks are all still there and readable, just spaced
apart and inconsistent with the tight lists the `personal-tasks` skill writes.
Earlier versions of this file claimed the tasks visually vanish. They do not.

## Testing

```
npm test              model tests, then the full UI run
npm run test:model    fast, no browser, no dependencies
npm run test:e2e      Playwright against a fake in-memory GitHub
npm run shots         same, plus screenshots to test/shots/ (light and dark)
```

`test/e2e.js` intercepts `api.github.com` and backs it with a single in-memory
string. Every assertion checks **what landed in that string**, not what the DOM
shows, because that string is the vault file. It covers the injected-409 retry
path and the offline queue-and-flush path.

Never point a test at the real repo, and never put a real token in this repo.
The e2e config uses the literal token `"fake"`.

The app is loadable straight from disk for eyeballing, but a service worker and
the PWA manifest need an origin, so use `npm run serve`.

## Deploying

GitHub Pages off `main`, root folder, at
`https://isaacstrang.github.io/tasks-app/`. Public repo, which is fine because
the app holds no secrets; the token is only ever in the user's browser.

**Bump `CACHE` in `sw.js` whenever you change `index.html`.** The worker is
network-first for same-origin requests so a stale shell self-heals, but the
version bump is what guarantees old assets get evicted. The `sw.js` fetch handler
deliberately ignores cross-origin requests so GitHub API calls are never cached
or replayed; leave that early return alone.

## Traps that have already bitten

- **`git status` through the Cowork device bridge.** The bridge cannot unlink, so
  `git status` and `git add` leave a stale `.git/index.lock` in the vault, which
  silently stops the obsidian-git plugin from committing anything. Read-only
  commands like `git log`, `git show` and `git ls-files` are safe. If you must
  check state, use those.
- **The GitHub Contents API is CDN-cached.** Reads append a cache-buster and send
  `cache: "no-store"`. Without it you can fetch a version older than your own
  last write and replay ops onto stale content.
- **`atob`/`btoa` are byte functions, not text functions.** Isaac's tasks contain
  accented characters and em-dash-adjacent punctuation. Base64 has to go through
  `TextEncoder`/`TextDecoder`, which `b64encode`/`b64decode` already do. Do not
  "simplify" them.
- **The MCP times out when Obsidian is closed**, which looks like a broken tool
  and is not. Nothing in this repo depends on it.

## House style

- **No em dashes, anywhere.** Standing preference of Isaac's, and it applies to
  code comments, commit messages, and any string the app renders. Use commas,
  colons, or hyphens.
- Colours are Wilderness Union brand: green `#006633`, yellow `#f9b741` used
  sparingly, near-black `#000002`. Light and dark both supported through
  `prefers-color-scheme`; check both when you touch CSS.
- Touch targets stay at 46px minimum. This is used one-handed, outdoors, often
  in a hurry.
- Keep the app fast to open and boring to use. It is competing with Google Keep,
  and it wins or loses on the two seconds between unlocking the phone and having
  the task written down. Any feature that costs a tap on the common path is
  probably the wrong feature.

## Related

- `personal-tasks` skill: how Claude chats write to the same file. If you change
  the section names, the completion stamp format, or the default section, that
  skill has to change in the same breath or the two writers will disagree.
- `notes-system` skill: the wider vault conventions.
- The vault's obsidian-git settings: `basePath` empty, pull on boot, pull every
  2 minutes, commit and push every 5, pull before push on.
