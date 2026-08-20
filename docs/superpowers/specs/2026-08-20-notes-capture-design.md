# Lessons Learned and Ideas capture

Date: 20 August 2026
Status: approved design, not yet implemented

## What we are building

Two more capture destinations in the phone app, backed by two existing notes at
the root of the `isaacstrang/obsidian` vault repo:

| Destination | Vault file |
|---|---|
| Ideas | `WU Ideas.md` |
| Lessons | `Lessons Learned.md` |

A tab bar switches between Tasks, Lessons and Ideas. On a note tab you can add a
new entry and scroll what is already there. You cannot edit, delete, reorder or
check off entries. Obsidian stays the place that work happens.

New entries land at the **top** of the note, newest first. No date stamps.

## What we found before designing

Three findings changed the shape of this work. All were verified, not assumed.

### 1. The two notes are not in the Tasks format

Neither note has headings, frontmatter, or list syntax. Entries are plain
paragraphs separated by a single blank line.

```
lessons.md (synthetic fixture)
01| First lesson about a policy that did not work out...
02|
03| Second lesson about logistics, where fewer of a thing...
     (no trailing newline)

ideas.md (synthetic fixture)
01| Sponsor local meetups. Cover the monthly dues for adjacent...[[some-linked-note]]
     (ends with a newline)
```

Entries contain wikilinks. The blank line is the record separator, which is the
exact inverse of its meaning in `001 Tasks.md`, where a blank line between two
`- [ ]` lines is a defect.

**Consequence:** these notes get their own small parser. The Tasks parser is not
generalised to cover them.

### 2. The repo has no tests

`main` is two commits. There is no `test/` directory, no `package.json`, and no
`MODEL START` / `MODEL END` markers. `CLAUDE.md` is untracked and local-only, and
describes all three as if they exist. `npm test`, which `CLAUDE.md` calls the only
gate between an edit and the live task list, cannot be run.

### 3. The blank-line append bug is live

`CLAUDE.md` describes this bug as found and fixed by `appendTask` / `prependTask`.
Those helpers do not exist. Reproduced against the real model code:

```
input : "## Today\n\n- [ ] Existing task\n\n## This week\n..."
op    : { t:"add", sec:"Today", text:"Brand new task" }
output: "## Today\n\n- [ ] Existing task\n\n- [ ] Brand new task\n\n## This week\n..."
                                          ^^^^ blank line between two tasks
```

Cause: `b.items.push(...)` at `index.html:293`. A parsed block carries its
trailing blank line as a real item, so `push` lands the task after it.

It is visible in the live `001 Tasks.md`. Every task the app has added sits alone,
blank-line separated, while tasks written by Claude chats sit contiguously.
Longer term currently has five in that state.

Verified effect: this produces a loose list, which changes spacing in Obsidian
reading view. `CLAUDE.md` claims tasks visually vanish. That stronger claim is
unverified and depends on the vault's plugins.

## Sequencing

Two releases, in order.

### Phase 1, v1.0.1: harness and append fix

No new features. Establish the gate that the feature work needs.

1. Make the pure region contiguous, then mark it. The DOM-free, browser-free code
   is currently in **two** blocks, split by an impure one:

   ```
   198-214  SECTIONS, DONE_H, ALL_H, ALIASES, canonHeading      pure
   216-231  LS, API, module state, load/save, $                 touches localStorage and document
   233-323  TASK_RE, parse, serialize, applyOp, applyAll, clone pure
   ```

   So this is a code move, not a comment. Lines 216 to 231 move as one block to
   below `clone`, then `MODEL START` / `MODEL END` wrap what is left. `load` is a
   hoisted function declaration used by `let cfg = load(...)` on the line above it,
   so the block has to move intact and stay in that internal order.

   This step lands on its own commit with no behaviour change, so a bisect can
   isolate it if anything downstream misbehaves.
2. Add `test/model.js`, which extracts that region and evaluates it in node.
3. Add `test/model.test.js` with parse, serialize and per-op idempotency tests,
   including one that pins the current behaviour of each existing op type.
4. Add `package.json` with `test:model`, `test:e2e`, `test`, `serve`, `shots`.
   Playwright is the only dependency, and only for e2e.
5. Add `appendTask(block, item)` and `prependTask(block, item)`, which step over
   leading and trailing blank `raw` items, and switch `applyOp`'s `add` and
   `move` cases onto them.
6. One-off tidy of `001 Tasks.md` to remove the blank lines already inserted
   between tasks. Done by hand against the real file, not by the app.
7. Correct `CLAUDE.md` and commit it, so it stops describing code that does not
   exist. Add the `personal-tasks` and vault-path facts confirmed here.

Gate for phase 1: `npm test` passes, and the tidied `001 Tasks.md` is eyeballed
in Obsidian before the app is used again.

### Phase 2, v1.1.0: the feature

Everything below.

## Phase 2 design

### Markdown contract for note files

A note file is a list of paragraphs. Nothing is parsed inside a paragraph, so
wikilinks, punctuation and accented characters pass through untouched.

```js
const parseNote = t => t.replace(/\r\n/g, "\n").split(/\n\s*\n/)
                        .map(s => s.trim()).filter(Boolean);
const serializeNote = e => e.join("\n\n") + "\n";
```

Both live files round-trip through this. `Lessons Learned.md` gains a trailing
newline on first write, a whitespace-only change.

Two contract decisions:

- **Entries are single paragraphs.** A multi-line entry would be joined into one
  paragraph on rewrite, so the app never offers a multi-line input.
- **The app does not create structure.** No headings, no bullets, no stamps. If a
  note later grows headings by hand, they become ordinary entry text and are
  preserved verbatim rather than interpreted.

### Config

```js
const NOTES = [
  { id: "lessons", label: "Lessons", cfgKey: "lessonsPath", placeholder: "What did you learn?" },
  { id: "ideas",   label: "Ideas",   cfgKey: "ideasPath",   placeholder: "Add an idea" },
];
```

Paths live in `cfg` alongside `cfg.path`, prefilled `Lessons Learned.md` and
`WU Ideas.md`, both at the vault repo root. Same owner, repo, branch and token as
Tasks. Settings gains two fields.

### Ops and the queue

One new op type, append-only:

```js
{ t: "note", file: "ideas", text }
```

Every op gains a `file` key. **An op with no `file` key means Tasks.** This is not
cosmetic: ops queued by the current version may be sitting in a phone's
`localStorage` right now, and they must not be misrouted when the new version
loads.

Idempotency: `note` returns early if an identical entry already exists in the
note, matching the existing `add` behaviour. A flush can fail after GitHub has
committed, and the op will be replayed.

Placement: new entries `unshift` onto the parsed entry array, which is safe
because `parseNote` has already discarded blank and empty segments. This is the
note-file equivalent of the `prependTask` fix in phase 1.

### flush()

`flush()` currently sends the whole queue against one file, with one sha. It
becomes: group the pending ops by file, then run the **existing** three-attempt
fetch, replay, PUT, retry-on-409 loop once per file, sequentially.

```js
const sending = queue.slice();
const groups  = groupBy(sending, op => op.file || "tasks");
for (const [file, ops] of groups) { /* existing retry loop, this file's path and sha */ }
```

Sequential, not concurrent: three parallel writes to the same repo would produce
avoidable 409s against each other.

Three changes inside that loop that are easy to get wrong:

1. **Queue removal by identity, not by count.** `index.html:426` does
   `queue = queue.slice(sending.length)`, correct only while the sent ops are a
   contiguous prefix. Grouped by file they are not. It becomes
   `queue = queue.filter(op => !succeeded.has(op))`.
2. **One file failing must not drop another file's ops.** Today a single throw
   abandons the whole batch. With three files that is data loss. Each file's ops
   leave the queue only when that file's PUT succeeds.
3. **404 must not seed a note with the Tasks skeleton.** `fetchFile` returns
   `SKELETON` on 404 at `index.html:355`. Note files get `""`.

`refresh()` at `index.html:393` replays the whole queue into the Tasks doc. It
gets filtered to Tasks ops. This is currently harmless because `applyOp` ignores
unknown types, but relying on that plants a bug for the next op type added.

### UI

- Tab bar under the add row: Tasks, Lessons, Ideas. Header title follows the tab.
- Tasks tab is unchanged, including the section chip row.
- Note tabs hide the chip row, change the input placeholder, and render entries as
  read-only cards: no checkbox, no `⋮` menu, no swipe.
- A just-added entry appears at the top immediately, styled muted until it
  flushes, matching how tasks behave now.
- The status chip stays global and counts pending ops across all three files.
- Touch targets stay at 46px. Colours stay `#006633`, `#f9b741`, `#000002`, both
  schemes.

### Loading

**Boot fetches `001 Tasks.md` only.** A note file is fetched the first time its
tab is opened, then cached in `localStorage` beside `tasks.cache`. The two-second
cold-open path is unchanged, and the cost of this feature is paid only when you
go looking.

Note tabs need empty, loading and error states. Tasks has none of these today
because it is always loaded at boot.

## Testing

New tests, all inside the `MODEL` markers so `test/model.js` reaches them:

- `parseNote` / `serializeNote` round-trip against byte-copies of both real notes,
  including the missing trailing newline on Lessons and the wikilink in Ideas
- a `note` op replayed twice produces one entry
- a `note` op prepends, and never introduces a leading blank line
- a 404 note is created containing one entry and nothing else
- an op with no `file` key routes to Tasks

New e2e tests against the fake in-memory GitHub, which grows from one string to
three:

- partial flush failure: Tasks commits, Ideas 409s three times, Tasks ops leave
  the queue and Ideas ops survive to the next flush
- offline queue across two files, then flush on reconnect
- opening a note tab fetches that file once, and not at boot

Fixtures are byte-copies committed to `test/`. No test ever points at the real
repo, and the token stays the literal `"fake"`.

## Versioning and release

- `CHANGELOG.md` at the repo root, updated in the same commit as the code.
- An annotated git tag and a GitHub release per version: `v1.0.1`, then `v1.1.0`.
- `CACHE` in `sw.js` bumped to match the version string.

Declined: an in-app version display. Consequence accepted, that the running
version can be confirmed from GitHub but not from the phone.

## Out of scope

- Editing, deleting or reordering note entries in the app.
- Sections, tags or dates inside the note files.
- Any dependency on the Obsidian MCP, a server, a database or a build step.
- Changes to the Tasks Markdown contract, so the `personal-tasks` skill does not
  change in this work.

## Risks

| Risk | Mitigation |
|---|---|
| Grouped flush drops ops from a file that failed | Identity-based removal, per-file success, e2e test for partial failure |
| Old queued ops misrouted after upgrade | Missing `file` defaults to Tasks, model test pins it |
| A note file is clobbered by a concurrent Mac push | Same re-fetch and replay loop as Tasks, unchanged |
| `parseNote` mangles a hand-written note | Round-trip tests against real byte-copies; parser interprets nothing inside a paragraph |
| Phase 1 tidy of `001 Tasks.md` damages the file | Done by hand, eyeballed in Obsidian, vault is in git and recoverable |

## Related

- Vault repo `isaacstrang/obsidian`, private, notes at root, confirmed via
  `git ls-files`.
- Separate finding, not part of this work: the vault's `.git/config` stores its
  GitHub PAT in plaintext in the remote URL. That token should be rotated and
  moved to the macOS keychain.
