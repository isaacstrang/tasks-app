# Lessons and Ideas Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the phone app capture into two more vault notes, `WU Ideas.md` and `Lessons Learned.md`, alongside `001 Tasks.md`, with a test harness underneath it.

**Architecture:** Two releases. v1.0.1 builds the test harness `CLAUDE.md` already assumes and fixes a live blank-line append bug. v1.1.0 widens the single-file sync core to three files, adds a six-line paragraph parser for the note format, and puts a tab bar over the top. The op queue gains a `file` key and `flush()` groups by file, reusing the existing retry loop per file.

**Tech Stack:** Plain HTML/CSS/JS in one file. No bundler, no framework, no runtime npm. `node --test` for model tests, Playwright for e2e. GitHub Contents API is the only backend.

**Spec:** `docs/superpowers/specs/2026-08-20-notes-capture-design.md`

## Global Constraints

- **No em dashes anywhere.** Code comments, commit messages, UI strings, changelog. Use commas, colons or hyphens.
- **Nothing between `MODEL START` and `MODEL END` may touch `document`, `localStorage`, `fetch`, `navigator` or `window`.**
- Colours are Wilderness Union brand: green `#006633`, yellow `#f9b741`, near-black `#000002`. Light and dark both via `prefers-color-scheme`.
- Touch targets stay at 46px minimum.
- `index.html` stays one file. No bundler, no framework, no npm at runtime.
- Never point a test at the real repo. The e2e config uses the literal token `"fake"`.
- Bump `CACHE` in `sw.js` in any commit that changes `index.html`.
- Vault note paths are repo-root relative: `001 Tasks.md`, `WU Ideas.md`, `Lessons Learned.md`.
- Work happens on branch `notes-capture`. Do not push to `main` and do not tag without Isaac saying so.
- macOS: there is no `timeout` command, and ports 5000 and 7000 are AirPlay Receiver. Dev server uses 8081.

---

# Phase 1: v1.0.1, harness and append fix

## Task 1: Extract the model and get one test running

The pure code sits in two blocks split by an impure one. Making it contiguous is a prerequisite for everything else.

**Files:**
- Modify: `index.html` (move lines 216-231, add markers)
- Create: `package.json`
- Create: `test/model.js`
- Create: `test/model.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `test/model.js` exports `{ SECTIONS, DONE_H, ALL_H, ALIASES, canonHeading, TASK_RE, parse, serialize, blockOf, findTask, applyOp, applyAll, clone }`. Every later task imports from here.

- [ ] **Step 1: Move the impure block below the model code**

In `index.html`, cut this entire block (currently lines 216 to 231, from `const LS` through `const $`):

```js
const LS = { cfg:"tasks.cfg", queue:"tasks.queue", cache:"tasks.cache", seg:"tasks.seg", closed:"tasks.closed" };
const API = "https://api.github.com";

/* ============================ state ============================ */
let cfg    = load(LS.cfg, null);
let queue  = load(LS.queue, []);
let doc    = null;          // { pre:[], blocks:[{h,items:[]}] }
let sha    = null;
let closed = new Set(load(LS.closed, [DONE_H]));
let addSec = load(LS.seg, "This week");   // matches the vault default; tap a chip to change it
let flushT = null, pollT = null, snackT = null, undoOp = null, busy = false;

function load(k, d){ try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch(e){ return d; } }
function save(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }

const $ = id => document.getElementById(id);
```

Paste it back in immediately after `const clone = d => JSON.parse(JSON.stringify(d));`. Keep the internal order exactly as it is: `load` is a hoisted function declaration that `let cfg = load(...)` depends on, and moving the block intact preserves that.

- [ ] **Step 2: Add the markers**

Wrap what is now contiguous. Immediately before `const SECTIONS = [`:

```js
/* ===== MODEL START ===== */
// Pure, DOM-free, browser-free. test/model.js extracts exactly this region and
// runs it in node, so nothing in here may touch document, localStorage or fetch.
```

Immediately after `const clone = d => JSON.parse(JSON.stringify(d));`:

```js
/* ===== MODEL END ===== */
```

- [ ] **Step 3: Create the extractor**

Create `test/model.js`:

```js
"use strict";
// Extracts the marked region out of index.html and evaluates it in node.
// If this throws, the markers moved or something impure crossed the boundary.
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "index.html");
const src = fs.readFileSync(SRC, "utf8");

const m = src.match(/\/\* ===== MODEL START ===== \*\/([\s\S]*?)\/\* ===== MODEL END ===== \*\//);
if (!m) throw new Error("MODEL START / MODEL END markers not found in index.html");

const EXPORTS = [
  "SECTIONS", "DONE_H", "ALL_H", "ALIASES", "canonHeading",
  "TASK_RE", "parse", "serialize", "blockOf", "findTask",
  "appendTask", "prependTask", "applyOp", "applyAll", "clone",
];

module.exports = new Function(
  `"use strict";\n${m[1]}\nreturn { ${EXPORTS.join(", ")} };`
)();
```

`appendTask` and `prependTask` are listed here but do not exist yet. Task 3 adds them. Until then this file throws, which is the point: it fails loudly.

For this task only, temporarily drop `"appendTask", "prependTask",` from `EXPORTS` so the extractor works, and put them back in Task 3.

- [ ] **Step 4: Create package.json**

```json
{
  "name": "tasks-app",
  "version": "1.0.1",
  "private": true,
  "description": "Phone front end for one Markdown file in an Obsidian vault",
  "scripts": {
    "test": "npm run test:model && npm run test:e2e",
    "test:model": "node --test test/model.test.js",
    "test:e2e": "node test/e2e.js",
    "shots": "SHOTS=1 node test/e2e.js",
    "serve": "python3 -m http.server 8081"
  },
  "devDependencies": {
    "playwright": "^1.47.0"
  }
}
```

Port 8081, not 5000 or 7000, because those are AirPlay Receiver on this machine.

- [ ] **Step 5: Write the first test**

Create `test/model.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const M = require("./model.js");

test("parse then serialize round-trips a file it has seen", () => {
  const src = [
    "# Tasks",
    "",
    "Free text preamble.",
    "",
    "## Today",
    "",
    "- [ ] Call the outfitter",
    "",
    "## This week",
    "",
    "- [ ] Review the welcome email",
    "",
    "## Longer term",
    "",
    "## Ice box",
    "",
    "## Done",
    "",
    "- [x] Rope (done Aug 18)",
    "",
  ].join("\n");
  assert.strictEqual(M.serialize(M.parse(src)), src.replace(/\s*$/, "") + "\n");
});

test("unrecognised lines survive as opaque raw items", () => {
  const src = "# Tasks\n\n## Today\n\n- [ ] Real task\n> a blockquote the app cannot show\n";
  const out = M.serialize(M.parse(src));
  assert.ok(out.includes("> a blockquote the app cannot show"));
});

test("old heading names are read through ALIASES and written back as new ones", () => {
  const src = "# Tasks\n\n## Later\n\n- [ ] Sponsor deck\n\n## Someday / maybe\n\n- [ ] Schools deck\n";
  const out = M.serialize(M.parse(src));
  assert.ok(out.includes("## Longer term"));
  assert.ok(out.includes("## Ice box"));
  assert.ok(!out.includes("## Later"));
  assert.ok(!out.includes("## Someday / maybe"));
});

test("Done is always the last section", () => {
  const src = "# Tasks\n\n## Done\n\n- [x] Rope (done Aug 18)\n\n## Today\n\n- [ ] Call the outfitter\n";
  const out = M.serialize(M.parse(src));
  assert.ok(out.indexOf("## Done") > out.indexOf("## Today"));
});

test("accented characters and punctuation survive a round trip", () => {
  const src = "# Tasks\n\n## Today\n\n- [ ] Café run, then Nokomis pickup: 3 canoes\n";
  assert.ok(M.serialize(M.parse(src)).includes("Café run, then Nokomis pickup: 3 canoes"));
});
```

- [ ] **Step 6: Run the model tests**

Run: `npm run test:model`
Expected: PASS, 5 tests. If the extractor throws "markers not found", Step 2 is wrong. If a `document is not defined` error appears, Step 1 left something impure inside the markers.

- [ ] **Step 7: Confirm the app still runs**

Run: `npm run serve` and open `http://localhost:8081/` in a browser. The setup screen should appear. This catches a broken move that the model tests cannot see, because the tests only exercise the marked region.

Stop the server with `killdev 8081`.

- [ ] **Step 8: Commit**

```bash
git add index.html package.json test/model.js test/model.test.js
git commit -m "Extract the pure model and add a node test harness

Moves LS, module state, load, save and \$ out from between the two pure
blocks so MODEL START and MODEL END can wrap a contiguous region. No
behaviour change, kept as its own commit so a bisect can isolate it.

Adds package.json, test/model.js and the first parse and serialize tests.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pin the current behaviour of every existing op

Before changing `applyOp`, lock in what it does today. These tests are the safety net for Task 3 and for the whole of phase 2.

**Files:**
- Modify: `test/model.test.js`

**Interfaces:**
- Consumes: `M.parse`, `M.serialize`, `M.applyOp`, `M.applyAll` from Task 1.
- Produces: nothing new. Behavioural baseline only.

- [ ] **Step 1: Write the op tests**

Append to `test/model.test.js`:

```js
const BASE = [
  "# Tasks",
  "",
  "## Today",
  "",
  "- [ ] Call the outfitter",
  "",
  "## This week",
  "",
  "- [ ] Review the welcome email",
  "",
  "## Longer term",
  "",
  "## Ice box",
  "",
  "## Done",
  "",
].join("\n");

const run = (src, ops) => M.serialize(M.applyAll(M.parse(src), ops));
const tasksIn = (out, heading) => {
  const body = out.split("## " + heading + "\n")[1] || "";
  return body.split(/\n## /)[0].split("\n").filter(l => /^- \[[ x]\] /.test(l));
};

test("add puts a task in the named section", () => {
  const out = run(BASE, [{ t: "add", sec: "This week", text: "Book the campsite deposit" }]);
  assert.ok(tasksIn(out, "This week").includes("- [ ] Book the campsite deposit"));
});

test("add is idempotent: replaying it does not duplicate", () => {
  const op = { t: "add", sec: "This week", text: "Book the campsite deposit" };
  const out = run(BASE, [op, op, op]);
  const hits = out.split("\n").filter(l => l === "- [ ] Book the campsite deposit");
  assert.strictEqual(hits.length, 1);
});

test("del removes a task", () => {
  const out = run(BASE, [{ t: "del", sec: "Today", text: "Call the outfitter" }]);
  assert.ok(!out.includes("Call the outfitter"));
});

test("del is idempotent: replaying it on content that lacks the task is a no-op", () => {
  const op = { t: "del", sec: "Today", text: "Call the outfitter" };
  const out = run(BASE, [op, op]);
  assert.ok(!out.includes("Call the outfitter"));
  assert.ok(out.includes("## Today"));
});

test("edit rewrites the line text", () => {
  const out = run(BASE, [{ t: "edit", sec: "Today", text: "Call the outfitter", newText: "Call the outfitter back" }]);
  assert.ok(out.includes("- [ ] Call the outfitter back"));
});

test("edit is idempotent: replaying it after it landed changes nothing", () => {
  const op = { t: "edit", sec: "Today", text: "Call the outfitter", newText: "Call the outfitter back" };
  const out = run(BASE, [op, op]);
  const hits = out.split("\n").filter(l => l.includes("Call the outfitter"));
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0], "- [ ] Call the outfitter back");
});

test("move to Done stamps the text and lands at the top of Done", () => {
  const out = run(BASE, [{
    t: "move", from: "Today", to: "Done",
    text: "Call the outfitter", newText: "Call the outfitter (done Aug 20)", done: true,
  }]);
  assert.strictEqual(tasksIn(out, "Done")[0], "- [x] Call the outfitter (done Aug 20)");
  assert.ok(!out.split("## This week")[0].includes("Call the outfitter"));
});

test("move is idempotent: replaying it after it landed does not duplicate", () => {
  const op = {
    t: "move", from: "Today", to: "Done",
    text: "Call the outfitter", newText: "Call the outfitter (done Aug 20)", done: true,
  };
  const out = run(BASE, [op, op]);
  const hits = out.split("\n").filter(l => l.includes("Call the outfitter"));
  assert.strictEqual(hits.length, 1);
});

test("move between two open sections keeps the task unchecked", () => {
  const out = run(BASE, [{ t: "move", from: "Today", to: "Ice box", text: "Call the outfitter", done: false }]);
  assert.ok(tasksIn(out, "Ice box").includes("- [ ] Call the outfitter"));
});
```

- [ ] **Step 2: Run them**

Run: `npm run test:model`
Expected: PASS, 14 tests. Every one of these describes current behaviour, so any failure here means Task 1's move broke something and must be fixed before going further.

- [ ] **Step 3: Commit**

```bash
git add test/model.test.js
git commit -m "Pin the current behaviour of every op type

One idempotency test per op, as CLAUDE.md requires. These are the
baseline that the append fix and the whole of the notes work land on.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Fix the blank-line append bug

Verified live: the app inserts a blank line between tasks because a parsed block carries its trailing blank as a real item, and `add` uses `items.push`. Confirmed cosmetic, a loose list in Obsidian reading view, not data loss.

**Files:**
- Modify: `index.html` (inside the MODEL region)
- Modify: `test/model.js` (restore the two names to `EXPORTS`)
- Modify: `test/model.test.js`

**Interfaces:**
- Consumes: `M.parse`, `M.serialize`, `M.applyOp`.
- Produces: `appendTask(block, item)` and `prependTask(block, item)`, both returning `undefined` and mutating `block.items` in place. Phase 2's `note` op uses the same leading-blank reasoning.

- [ ] **Step 1: Write the failing test**

Append to `test/model.test.js`:

```js
test("add lands directly after the last task, not after the section's blank line", () => {
  const out = run(BASE, [{ t: "add", sec: "Today", text: "Brand new task" }]);
  assert.match(out, /- \[ \] Call the outfitter\n- \[ \] Brand new task/);
  assert.ok(!/- \[ \] Call the outfitter\n\n- \[ \] Brand new task/.test(out));
});

test("add into an empty section does not leave a blank line above the task", () => {
  const out = run(BASE, [{ t: "add", sec: "Ice box", text: "Schools deck" }]);
  assert.match(out, /## Ice box\n\n- \[ \] Schools deck/);
});

test("move into an open section appends tightly", () => {
  const src = BASE + "\n";
  const out = run(src, [
    { t: "add", sec: "This week", text: "First" },
    { t: "move", from: "This week", to: "Today", text: "First", done: false },
  ]);
  assert.match(out, /- \[ \] Call the outfitter\n- \[ \] First/);
});

test("move to Done prepends tightly under the heading", () => {
  const out = run(BASE, [{
    t: "move", from: "Today", to: "Done",
    text: "Call the outfitter", newText: "Call the outfitter (done Aug 20)", done: true,
  }]);
  assert.match(out, /## Done\n\n- \[x\] Call the outfitter \(done Aug 20\)/);
});

test("a section's trailing blank line is preserved, so headings stay separated", () => {
  const out = run(BASE, [{ t: "add", sec: "Today", text: "Brand new task" }]);
  assert.match(out, /- \[ \] Brand new task\n\n## This week/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:model`
Expected: FAIL. "add lands directly after the last task" fails on the `assert.match`, because the current output is `- [ ] Call the outfitter\n\n- [ ] Brand new task`.

- [ ] **Step 3: Add the two helpers**

In `index.html`, inside the MODEL region, immediately after `const findTask = ...`:

```js
// A parsed block carries its trailing blank line as a real item, so a plain
// items.push lands a task after that blank. In Obsidian's reading view that
// turns a tight list into a loose one and spaces the tasks apart. Both helpers
// step over leading and trailing blanks so tasks always sit flush together.
function appendTask(b, item){
  let i = b.items.length;
  while (i > 0 && b.items[i-1].k === "r" && !b.items[i-1].text.trim()) i--;
  b.items.splice(i, 0, item);
}
function prependTask(b, item){
  let i = 0;
  while (i < b.items.length && b.items[i].k === "r" && !b.items[i].text.trim()) i++;
  b.items.splice(i, 0, item);
}
```

- [ ] **Step 4: Route the ops through them**

In `applyOp`, change the `add` case from:

```js
if (findTask(b, op.text) === -1) b.items.push({ k:"t", done:false, text:op.text });
```

to:

```js
if (findTask(b, op.text) === -1) appendTask(b, { k:"t", done:false, text:op.text });
```

and the tail of the `move` case from:

```js
if (op.to === DONE_H) to.items.unshift(item); else to.items.push(item);
```

to:

```js
if (op.to === DONE_H) prependTask(to, item); else appendTask(to, item);
```

- [ ] **Step 5: Put the helpers back in the extractor**

In `test/model.js`, restore `"appendTask", "prependTask",` to the `EXPORTS` array.

- [ ] **Step 6: Run the tests**

Run: `npm run test:model`
Expected: PASS, 19 tests. The nine baseline tests from Task 2 must still pass unchanged. If "move to Done stamps the text and lands at the top of Done" now fails, `prependTask` is stepping too far.

- [ ] **Step 7: Bump the cache and commit**

In `sw.js`, change `const CACHE = "tasks-v3";` to `const CACHE = "tasks-v1.0.1";`.

```bash
git add index.html sw.js test/model.js test/model.test.js
git commit -m "Stop inserting a blank line between tasks on add and move

A parsed block carries its trailing blank line as a real item, so
items.push landed each new task after it. Every task the app has added
to the live vault file sits alone, blank-line separated, which renders
as a loose list in Obsidian.

Adds appendTask and prependTask, which step over leading and trailing
blanks, and routes add and move through them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: End-to-end harness against a fake GitHub

**Files:**
- Create: `test/e2e.js`

**Interfaces:**
- Consumes: nothing from earlier tasks. Drives the built app through a browser.
- Produces: `withApp(files, fn, opts)` helper. Phase 2's Task 8 adds cases to this file, so the signature matters: `files` is a mutable `{ [repoPath]: string }`, `fn` receives `(page, files)`, and `opts` accepts `{ fail409: number }`.

- [ ] **Step 1: Install Playwright**

Run: `npm install`
Then: `npx playwright install chromium`

- [ ] **Step 2: Write the harness and the first two tests**

Create `test/e2e.js`:

```js
"use strict";
// Playwright against a fake in-memory GitHub. Every assertion checks what
// landed in the fake file, not what the DOM shows, because that string is
// the vault file. Never point this at the real repo.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const TYPES = { ".html":"text/html", ".js":"text/javascript", ".json":"application/json",
                ".webmanifest":"application/manifest+json", ".png":"image/png" };

function serve(){
  const s = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()){
      res.writeHead(404); return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "text/plain" });
    res.end(fs.readFileSync(file));
  });
  return new Promise(r => s.listen(0, "127.0.0.1", () => r(s)));
}

const shaOf = t => crypto.createHash("sha1").update(t, "utf8").digest("hex");

const CFG = { token:"fake", owner:"isaacstrang", repo:"obsidian",
              path:"001 Tasks.md", branch:"main" };

async function withApp(files, fn, opts = {}){
  let remaining409 = opts.fail409 || 0;
  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.route("https://api.github.com/**", async route => {
    const req = route.request();
    const m = new URL(req.url()).pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
    const p = decodeURIComponent(m[1]);

    if (req.method() === "GET"){
      if (!(p in files)) {
        return route.fulfill({ status:404, contentType:"application/json",
                               body: JSON.stringify({ message:"Not Found" }) });
      }
      return route.fulfill({ status:200, contentType:"application/json", body: JSON.stringify({
        content: Buffer.from(files[p], "utf8").toString("base64"), sha: shaOf(files[p]) }) });
    }

    if (req.method() === "PUT"){
      const body = JSON.parse(req.postData());
      if (remaining409 > 0){
        remaining409--;
        return route.fulfill({ status:409, contentType:"application/json",
                               body: JSON.stringify({ message:"injected conflict" }) });
      }
      const current = p in files ? shaOf(files[p]) : null;
      if ((body.sha || null) !== current){
        return route.fulfill({ status:409, contentType:"application/json",
                               body: JSON.stringify({ message:"sha mismatch" }) });
      }
      files[p] = Buffer.from(body.content, "base64").toString("utf8");
      return route.fulfill({ status:200, contentType:"application/json",
                             body: JSON.stringify({ content: { sha: shaOf(files[p]) } }) });
    }
    return route.fallback();
  });

  const cfg = JSON.stringify(CFG);
  await page.addInitScript(c => localStorage.setItem("tasks.cfg", c), cfg);
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForSelector("#app:not(.hidden)");

  try { await fn(page, files); }
  finally { await browser.close(); server.close(); }
}

const BASE = "# Tasks\n\n## Today\n\n- [ ] Call the outfitter\n\n## This week\n\n" +
             "- [ ] Review the welcome email\n\n## Longer term\n\n## Ice box\n\n## Done\n";

const settled = page => page.waitForFunction(
  () => document.querySelector("#status").textContent.trim() === "Synced", null, { timeout: 15000 });

async function addVia(page, text){
  await page.fill("#addInput", text);
  await page.click("#addBtn");
}

const TESTS = [];
const test = (name, fn) => TESTS.push({ name, fn });

test("a task added on the phone lands in the file under the default section", async () => {
  const files = { "001 Tasks.md": BASE };
  await withApp(files, async page => {
    await addVia(page, "Book the campsite deposit");
    await settled(page);
    const week = files["001 Tasks.md"].split("## This week")[1].split("## Longer term")[0];
    assert.ok(week.includes("- [ ] Book the campsite deposit"), "task missing from This week");
    assert.ok(!/- \[ \] Review the welcome email\n\n- \[ \] campsite deposit/.test(files["001 Tasks.md"]),
              "blank line reintroduced between tasks");
  });
});

test("a 409 from GitHub is retried and the task still lands exactly once", async () => {
  const files = { "001 Tasks.md": BASE };
  await withApp(files, async page => {
    await addVia(page, "Killarney permits");
    await settled(page);
    const hits = files["001 Tasks.md"].split("\n").filter(l => l === "- [ ] Killarney permits");
    assert.strictEqual(hits.length, 1, "task did not land exactly once after a 409");
  }, { fail409: 1 });
});

test("tasks added while offline queue up and flush on reconnect", async () => {
  const files = { "001 Tasks.md": BASE };
  await withApp(files, async page => {
    await page.context().setOffline(true);
    await addVia(page, "Offline one");
    await addVia(page, "Offline two");
    await page.waitForTimeout(1500);
    assert.ok(!files["001 Tasks.md"].includes("Offline one"), "wrote to GitHub while offline");
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await settled(page);
    assert.ok(files["001 Tasks.md"].includes("- [ ] Offline one"), "queued task never flushed");
    assert.ok(files["001 Tasks.md"].includes("- [ ] Offline two"), "second queued task never flushed");
  });
});

(async () => {
  let failed = 0;
  for (const t of TESTS){
    try { await t.fn(); console.log("  ok   " + t.name); }
    catch (e){ failed++; console.error("  FAIL " + t.name + "\n       " + e.message); }
  }
  console.log(`\n${TESTS.length - failed}/${TESTS.length} passed`);
  process.exit(failed ? 1 : 0);
})();
```

- [ ] **Step 3: Run the e2e suite**

Run: `npm run test:e2e`
Expected: 3/3 passed. If the offline test hangs, the app's `online` listener did not fire; check that `page.evaluate` dispatched on `window`, not `document`.

- [ ] **Step 4: Run the whole gate**

Run: `npm test`
Expected: 19 model tests pass, then 3/3 e2e.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json test/e2e.js
git commit -m "Add the e2e harness against a fake in-memory GitHub

Covers the happy path, the injected 409 retry, and the offline queue
and flush path. Every assertion checks what landed in the fake file
rather than what the DOM shows, because that string is the vault file.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Tidy the docs and cut v1.0.1

**Files:**
- Create: `CHANGELOG.md`
- Modify: `CLAUDE.md`
- Modify: `.gitignore` (already created, verify contents)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Documentation and release only.

- [ ] **Step 1: Write the changelog**

Create `CHANGELOG.md`:

```markdown
# Changelog

## v1.0.1, 20 August 2026

Fixed:
- Adding a task no longer inserts a blank line above it. A parsed section
  carries its trailing blank line as a real item, so the old `items.push`
  landed each new task after it, which renders as a loose list in Obsidian.
  Adds `appendTask` and `prependTask`.

Added:
- `test/model.js` and `test/model.test.js`: the pure model is now extracted
  from `index.html` and run in node. 19 tests, including one idempotency
  test per op type.
- `test/e2e.js`: Playwright against a fake in-memory GitHub, covering the
  409 retry and offline queue paths.
- `package.json` with `test`, `test:model`, `test:e2e`, `serve`, `shots`.

Changed:
- The pure region of `index.html` is contiguous and marked with
  `MODEL START` / `MODEL END`. No behaviour change.
```

- [ ] **Step 2: Correct CLAUDE.md**

Three corrections. First, the "Blank lines" section currently says the bug "shipped as a real bug and was caught only because Isaac used the app before I finished testing it". Replace the claim that tasks visually vanish, which was never verified. Change the paragraph to:

```markdown
### Blank lines

`appendTask` and `prependTask` exist for one reason: a plain `items.push`
lands a new task after the section's trailing blank line, because a parsed
block carries that blank as a real item. The result is `- [ ] a`, a blank,
`- [ ] b`, which Obsidian renders as a loose list: the tasks are all still
there, but spaced apart and visually inconsistent with the tight lists that
the `personal-tasks` skill writes.

This shipped and stayed in the live vault file for a week before it was
found, in August 2026. Verified cosmetic, not data loss. Do not reintroduce
`items.push` for tasks, and apply the same reasoning to any new writer:
the boundary of a section is not the boundary of the array.
```

Second, add to the "Working on this from Claude Code" section, after the clone instructions:

```markdown
Node's built-in test runner does the model tests, so `npm install` is only
needed before `npm run test:e2e`. After installing, run
`npx playwright install chromium` once.
```

Third, in the "Two things this repo cannot see" list, replace the vault bullet with the confirmed facts:

```markdown
- **The vault repo** (`isaacstrang/obsidian`) is private and separate. Confirmed
  20 Aug 2026: its root holds `001 Tasks.md`, `WU Ideas.md` and
  `Lessons Learned.md`, and the vault directory is the repo root. If a change
  touches the Markdown contract, the real files have to be eyeballed by hand,
  and the `personal-tasks` skill has to move in the same commit.
```

- [ ] **Step 3: Verify .gitignore**

`.gitignore` should contain exactly:

```
.DS_Store
.superpowers/
node_modules/
test/shots/
```

- [ ] **Step 4: Run the full gate one more time**

Run: `npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md CLAUDE.md .gitignore
git commit -m "Correct CLAUDE.md and add a changelog for v1.0.1

CLAUDE.md described a test harness, MODEL markers and an appendTask fix
that did not exist in the repo. It also claimed the blank-line bug made
tasks visually vanish, which was never verified: it renders as a loose
list, and nothing is lost.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Stop and check in with Isaac**

Do not tag, do not push. Report: tests green, the append fix is in, and v1.0.1 is ready to tag and deploy. Ask whether to merge to `main`, push, tag `v1.0.1` and cut the GitHub release, or to hold until phase 2 is also done.

---

# Phase 2: v1.1.0, Lessons and Ideas

## Task 6: Make the GitHub layer take a file, not the file

Pure plumbing. No new features, no UI. The whole feature rests on this seam.

**Files:**
- Modify: `index.html` (`url`, `fetchFile`, `putFile`, `refresh`, `flush`, `saveCfg`, state)
- Modify: `test/model.test.js`

**Interfaces:**
- Consumes: everything from phase 1.
- Produces:
  - `FILES`: `{ tasks: {cfgKey:"path", blank:()=>SKELETON}, lessons: {cfgKey:"lessonsPath", blank:()=>""}, ideas: {cfgKey:"ideasPath", blank:()=>""} }`
  - `pathOf(id: string) => string`
  - `url(path: string) => string`
  - `fetchFile(id: string) => Promise<{text: string, sha: string|null}>`
  - `putFile(id: string, text: string, curSha: string|null, msg: string) => Promise<string>`
  - `shas: { tasks: string|null, lessons: string|null, ideas: string|null }` replaces the single `sha`
  - `fileOf(op) => string`, exported from the MODEL region

- [ ] **Step 1: Write the failing test for op routing**

Append to `test/model.test.js`:

```js
test("an op with no file key routes to tasks, so ops queued by the old version survive", () => {
  assert.strictEqual(M.fileOf({ t: "add", sec: "Today", text: "Legacy op" }), "tasks");
});

test("an op with a file key routes to that file", () => {
  assert.strictEqual(M.fileOf({ t: "note", file: "ideas", text: "Sponsor local meetups" }), "ideas");
  assert.strictEqual(M.fileOf({ t: "add", file: "tasks", sec: "Today", text: "x" }), "tasks");
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm run test:model`
Expected: FAIL, "M.fileOf is not a function".

- [ ] **Step 3: Add fileOf inside the MODEL region**

In `index.html`, immediately after `const applyAll = ...`:

```js
// Ops queued by versions before v1.1.0 have no file key. They are all tasks
// ops, and they may be sitting in a phone's localStorage right now, so a
// missing key must never be treated as unknown.
const fileOf = op => op.file || "tasks";
```

Add `"fileOf",` to `EXPORTS` in `test/model.js`.

- [ ] **Step 4: Run the model tests**

Run: `npm run test:model`
Expected: PASS, 21 tests.

- [ ] **Step 5: Add the file registry, outside the MODEL region**

In `index.html`, just below the moved `const $ = ...` line:

```js
const FILES = {
  tasks:   { cfgKey:"path",        label:"Tasks"   },
  lessons: { cfgKey:"lessonsPath", label:"Lessons" },
  ideas:   { cfgKey:"ideasPath",   label:"Ideas"   },
};
const pathOf = id => cfg[FILES[id].cfgKey];

// Tasks gets a skeleton when the file does not exist yet. A note file must
// not, or a brand new note is born containing "# Tasks" and four headings.
const blankFor = id => id === "tasks" ? SKELETON : "";
```

Replace `let sha = null;` in the state block with:

```js
let shas = { tasks:null, lessons:null, ideas:null };
```

- [ ] **Step 6: Widen url, fetchFile and putFile**

Replace `url`:

```js
const url = p => `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${p.split("/").map(encodeURIComponent).join("/")}`;
```

Replace `fetchFile`:

```js
async function fetchFile(id){
  const p = pathOf(id);
  const r = await fetch(`${url(p)}?ref=${encodeURIComponent(cfg.branch)}&t=${Date.now()}`,
                        { headers: headers(), cache:"no-store" });
  if (r.status === 404) return { text: blankFor(id), sha: null };
  if (!r.ok) throw new Error(await errText(r));
  const j = await r.json();
  return { text: b64decode(j.content || ""), sha: j.sha };
}
```

Replace `putFile`:

```js
async function putFile(id, text, curSha, msg){
  const body = { message: msg, content: b64encode(text), branch: cfg.branch };
  if (curSha) body.sha = curSha;
  const r = await fetch(url(pathOf(id)), { method:"PUT",
    headers: { ...headers(), "Content-Type":"application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { const e = new Error(await errText(r)); e.status = r.status; throw e; }
  const j = await r.json();
  return j.content.sha;
}
```

- [ ] **Step 7: Update every call site**

There are four. In `refresh`, change `const f = await fetchFile();` to `const f = await fetchFile("tasks");`, `sha = f.sha;` to `shas.tasks = f.sha;`, and `doc = applyAll(parse(f.text), queue);` to:

```js
doc = applyAll(parse(f.text), queue.filter(op => fileOf(op) === "tasks"));
```

In `flush`, change `const f = await fetchFile();` to `const f = await fetchFile("tasks");` and `sha = await putFile(serialize(merged), f.sha, ...)` to `shas.tasks = await putFile("tasks", serialize(merged), f.sha, ...)`. Change `save(LS.cache, { text: serialize(doc), sha });` to `save(LS.cache, { text: serialize(doc), sha: shas.tasks });`.

In `saveCfg`, change `const f = await fetchFile();` to `const f = await fetchFile("tasks");` and `await putFile(SKELETON, null, "tasks: create task file")` to `await putFile("tasks", SKELETON, null, "tasks: create task file")`.

In the boot block, change `if (cached){ sha = cached.sha; ...` to `if (cached){ shas.tasks = cached.sha; ...` and filter the queue the same way as in `refresh`.

- [ ] **Step 8: Add the two config fields**

In the `#setup` markup, after the `cPath` field group:

```html
<div class="f"><label for="cLessons">Lessons file path</label><input id="cLessons" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Lessons Learned.md"></div>
<div class="f"><label for="cIdeas">Ideas file path</label><input id="cIdeas" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="WU Ideas.md"></div>
```

In `showSetup`, after the `cPath` line:

```js
$("cLessons").value = c.lessonsPath || "Lessons Learned.md";
$("cIdeas").value   = c.ideasPath   || "WU Ideas.md";
```

In `saveCfg`, add to the `next` object:

```js
lessonsPath: $("cLessons").value.trim().replace(/^\/+/,"") || "Lessons Learned.md",
ideasPath:   $("cIdeas").value.trim().replace(/^\/+/,"")   || "WU Ideas.md",
```

Leave the required-field loop as `["token","owner","repo","path"]`. The two note paths always have a default, so they can never be empty.

- [ ] **Step 9: Run the full gate**

Run: `npm test`
Expected: all green, unchanged behaviour. This task adds no features, so any e2e failure is a broken call site from Step 7.

- [ ] **Step 10: Commit**

```bash
git add index.html test/model.js test/model.test.js
git commit -m "Make the GitHub layer take a file id instead of the file

url, fetchFile and putFile now take which file to act on. The single sha
becomes a per-file map, a 404 on a note file yields an empty string
rather than the Tasks skeleton, and fileOf routes an op with no file key
to tasks so ops already queued on a phone are not misrouted on upgrade.

No behaviour change and no new UI.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: The note format and the note op

**Files:**
- Modify: `index.html` (inside the MODEL region)
- Modify: `test/model.js`
- Modify: `test/model.test.js`
- Create: `test/fixtures/WU Ideas.md`
- Create: `test/fixtures/Lessons Learned.md`

**Interfaces:**
- Consumes: `fileOf` from Task 6.
- Produces:
  - `parseNote(text: string) => string[]`
  - `serializeNote(entries: string[]) => string`
  - `applyNoteOp(entries: string[], op) => string[]` mutating and returning `entries`
  - `applyAllNotes(entries: string[], ops) => string[]`
  - op shape `{ t:"note", file:"ideas"|"lessons", text:string }`

- [ ] **Step 1: Create the fixtures**

These are byte-copies of the real notes as of 20 Aug 2026. Do not tidy them: the missing trailing newline on Lessons and the wikilink on Ideas are the point.

`test/fixtures/WU Ideas.md`, a single line ending in a newline:

```
Sponsor local meetups. Cover the monthly dues for adjacent community groups (paddling, running, newcomer, tech) in exchange for an intro to their members, then track signups with a unique per-group discount code.[[some-linked-note]]
```

`test/fixtures/Lessons Learned.md`, three lines with **no** trailing newline:

```
First lesson about a policy that did not work out and what we'll change next year

Second lesson about logistics, where fewer of a thing turned out to move faster
```

After creating it, strip the trailing newline:

```bash
printf '%s' "$(cat 'test/fixtures/Lessons Learned.md')" > /tmp/ll && mv /tmp/ll 'test/fixtures/Lessons Learned.md'
```

- [ ] **Step 2: Write the failing tests**

Append to `test/model.test.js`:

```js
const fs = require("node:fs");
const fixture = n => fs.readFileSync(require("node:path").join(__dirname, "fixtures", n), "utf8");

test("parseNote splits the real Lessons file into its two entries", () => {
  const e = M.parseNote(fixture("Lessons Learned.md"));
  assert.strictEqual(e.length, 2);
  assert.ok(e[0].startsWith("First lesson"));
  assert.ok(e[1].startsWith("Second lesson"));
});

test("parseNote keeps a wikilink intact and does not parse inside a paragraph", () => {
  const e = M.parseNote(fixture("WU Ideas.md"));
  assert.strictEqual(e.length, 1);
  assert.ok(e[0].endsWith("[[some-linked-note]]"));
});

test("a note round-trips, normalising only the trailing newline", () => {
  const src = fixture("Lessons Learned.md");
  assert.strictEqual(M.serializeNote(M.parseNote(src)), src + "\n");
});

test("a note that already ends with a newline round-trips byte for byte", () => {
  const src = fixture("WU Ideas.md");
  assert.strictEqual(M.serializeNote(M.parseNote(src)), src);
});

test("parseNote tolerates ragged whitespace between entries", () => {
  const e = M.parseNote("One\n\n\n\nTwo\n   \nThree\n\n");
  assert.deepStrictEqual(e, ["One", "Two", "Three"]);
});

test("parseNote of an empty file yields no entries", () => {
  assert.deepStrictEqual(M.parseNote(""), []);
  assert.deepStrictEqual(M.parseNote("\n\n  \n"), []);
});

test("a note op prepends, newest first", () => {
  const e = M.applyAllNotes(M.parseNote(fixture("Lessons Learned.md")),
                            [{ t:"note", file:"lessons", text:"Fuel the bus the night before" }]);
  assert.strictEqual(e[0], "Fuel the bus the night before");
  assert.strictEqual(e.length, 3);
});

test("a note op never introduces a leading blank line", () => {
  const out = M.serializeNote(M.applyAllNotes(M.parseNote(""),
                              [{ t:"note", file:"ideas", text:"First ever idea" }]));
  assert.strictEqual(out, "First ever idea\n");
});

test("a note op is idempotent: replaying it does not duplicate", () => {
  const op = { t:"note", file:"lessons", text:"Fuel the bus the night before" };
  const e = M.applyAllNotes(M.parseNote(fixture("Lessons Learned.md")), [op, op, op]);
  assert.strictEqual(e.filter(x => x === op.text).length, 1);
});

test("applyAllNotes ignores ops belonging to other files", () => {
  const e = M.applyAllNotes(["Existing"], [
    { t:"note", file:"ideas", text:"An idea" },
    { t:"add",  file:"tasks", sec:"Today", text:"A task" },
  ]);
  assert.deepStrictEqual(e, ["An idea", "Existing"]);
});

test("a multi-line entry is flattened to one paragraph, matching the contract", () => {
  const e = M.applyAllNotes([], [{ t:"note", file:"ideas", text:"line one\nline two" }]);
  assert.strictEqual(M.serializeNote(e), "line one line two\n");
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `npm run test:model`
Expected: FAIL, "M.parseNote is not a function".

- [ ] **Step 4: Implement the note model**

In `index.html`, inside the MODEL region, immediately after `const fileOf = ...`:

```js
/* ---- note files ----
   WU Ideas.md and Lessons Learned.md are not in the Tasks format. They have no
   headings, no frontmatter and no list syntax: entries are plain paragraphs
   separated by one blank line. That blank line is the record separator here,
   which is the exact inverse of its meaning in 001 Tasks.md. Nothing is parsed
   inside a paragraph, so wikilinks and punctuation pass through untouched. */
const parseNote = t => t.replace(/\r\n/g, "\n").split(/\n\s*\n/)
                        .map(s => s.trim()).filter(Boolean);

const serializeNote = e => e.length ? e.join("\n\n") + "\n" : "";

// Entries are single paragraphs by contract, so a pasted multi-line entry is
// flattened rather than silently becoming two entries on the next read.
const flattenEntry = s => s.replace(/\s*\n\s*/g, " ").trim();

function applyNoteOp(entries, op){
  if (op.t !== "note") return entries;
  const text = flattenEntry(op.text);
  if (!text) return entries;
  if (entries.includes(text)) return entries;   // idempotent: a flush can be replayed
  entries.unshift(text);
  return entries;
}

const applyAllNotes = (entries, ops) => { for (const o of ops) applyNoteOp(entries, o); return entries; };
```

Add `"parseNote", "serializeNote", "flattenEntry", "applyNoteOp", "applyAllNotes",` to `EXPORTS` in `test/model.js`.

- [ ] **Step 5: Run the tests**

Run: `npm run test:model`
Expected: PASS, 32 tests.

- [ ] **Step 6: Commit**

```bash
git add index.html test/model.js test/model.test.js test/fixtures/
git commit -m "Add the note file model: paragraphs separated by a blank line

WU Ideas.md and Lessons Learned.md have no headings and no list syntax.
Entries are paragraphs, and the blank line between them is the record
separator, the inverse of what it means in 001 Tasks.md. So they get
their own six-line parser rather than generalising the Tasks one.

Round-trip tests run against byte-copies of the real notes, including
the missing trailing newline on Lessons and the wikilink in Ideas.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Group flush by file

The riskiest change in the plan. This is the code that can duplicate or drop a task.

**Files:**
- Modify: `index.html` (`flush`, plus a new `flushFile`)
- Modify: `test/e2e.js`

**Interfaces:**
- Consumes: `fileOf`, `fetchFile(id)`, `putFile(id, ...)`, `parseNote`, `serializeNote`, `applyAllNotes`.
- Produces: `flushFile(id, ops) => Promise<string>` returning the committed text. `noteCache: { lessons: string[]|null, ideas: string[]|null }`, `null` meaning not yet loaded. Task 9 renders from `noteCache`.

- [ ] **Step 1: Write the failing e2e tests**

Append to `test/e2e.js`, before the runner block at the bottom:

```js
const IDEAS = "An existing idea\n";
const LESSONS = "An existing lesson";

async function addTo(page, tab, text){
  await page.click(`[data-tab="${tab}"]`);
  await page.fill("#addInput", text);
  await page.click("#addBtn");
}

test("an idea lands in WU Ideas.md, newest first, and never touches the task file", async () => {
  const files = { "001 Tasks.md": BASE, "WU Ideas.md": IDEAS, "Lessons Learned.md": LESSONS };
  await withApp(files, async page => {
    await addTo(page, "ideas", "Fall colour bus day trip");
    await settled(page);
    assert.strictEqual(files["WU Ideas.md"], "Fall colour bus day trip\n\nAn existing idea\n");
    assert.strictEqual(files["001 Tasks.md"], BASE, "the task file was rewritten");
  });
});

test("one file failing does not drop another file's ops", async () => {
  const files = { "001 Tasks.md": BASE, "WU Ideas.md": IDEAS, "Lessons Learned.md": LESSONS };
  await withApp(files, async page => {
    // Break only the Ideas file. Tasks must still commit, and the idea must
    // stay queued rather than being silently discarded with the batch.
    await page.route("https://api.github.com/**", async route => {
      if (route.request().method() === "PUT" &&
          decodeURIComponent(route.request().url()).includes("WU Ideas.md")){
        return route.fulfill({ status: 409, contentType: "application/json",
                               body: JSON.stringify({ message: "always conflicts" }) });
      }
      return route.fallback();
    });

    await addTo(page, "ideas", "Doomed idea");
    await addTo(page, "tasks", "Book the campsite deposit");
    await page.waitForFunction(() => document.querySelector("#status").textContent.includes("pending"),
                               null, { timeout: 20000 });

    assert.ok(files["001 Tasks.md"].includes("- [ ] Book the campsite deposit"),
              "the healthy file did not commit");
    assert.strictEqual(files["WU Ideas.md"], IDEAS, "the broken file was written anyway");
    const queued = await page.evaluate(() => JSON.parse(localStorage.getItem("tasks.queue") || "[]"));
    assert.strictEqual(queued.length, 1, "expected exactly the failed op to remain queued");
    assert.strictEqual(queued[0].text, "Doomed idea");
  });
});

test("a note file that does not exist yet is created with just the entry", async () => {
  const files = { "001 Tasks.md": BASE };
  await withApp(files, async page => {
    await addTo(page, "lessons", "Fuel the bus the night before");
    await settled(page);
    assert.strictEqual(files["Lessons Learned.md"], "Fuel the bus the night before\n");
  });
});

test("entries queued offline across two files all flush on reconnect", async () => {
  const files = { "001 Tasks.md": BASE, "WU Ideas.md": IDEAS, "Lessons Learned.md": LESSONS };
  await withApp(files, async page => {
    await page.context().setOffline(true);
    await addTo(page, "ideas", "Offline idea");
    await addTo(page, "lessons", "Offline lesson");
    await addTo(page, "tasks", "Offline task");
    await page.waitForTimeout(1500);
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await settled(page);
    assert.ok(files["WU Ideas.md"].startsWith("Offline idea"));
    assert.ok(files["Lessons Learned.md"].startsWith("Offline lesson"));
    assert.ok(files["001 Tasks.md"].includes("- [ ] Offline task"));
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm run test:e2e`
Expected: the first three new tests FAIL on `[data-tab="ideas"]` not existing. That is expected: Task 9 builds the tab bar. Note which fail and move on; they go green at the end of Task 9.

To keep this task testable on its own, temporarily drive the ops directly instead of through the UI. Replace `addTo` for now with:

```js
async function addTo(page, tab, text){
  if (tab === "tasks"){ await page.fill("#addInput", text); return page.click("#addBtn"); }
  await page.evaluate(([f, t]) => window.push({ t:"note", file:f, text:t }), [tab, text]);
}
```

and add `window.push = push;` at the very bottom of the script in `index.html`, just before the service worker registration, with the comment `// exposed for e2e only; harmless in the browser`. Task 9 restores the UI-driven version of `addTo` and this line stays, since the e2e suite keeps using it for setup.

- [ ] **Step 3: Rewrite flush**

Replace the whole of `flush` in `index.html` with:

```js
// Ops are grouped by file and each file gets its own fetch, replay, PUT and
// retry. Sequential, not concurrent: three parallel writes to one repo would
// generate 409s against each other for no reason.
async function flush(){
  if (busy || !queue.length) return;
  if (!navigator.onLine) { statusIdle(); return; }
  busy = true; setStatus("Syncing…");

  const sending = queue.slice();
  const groups = new Map();
  for (const op of sending){
    const id = fileOf(op);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(op);
  }

  const succeeded = new Set();
  let lastErr = null;
  for (const [id, ops] of groups){
    try {
      const text = await flushFile(id, ops);
      for (const op of ops) succeeded.add(op);
      if (id === "tasks") save(LS.cache, { text, sha: shas.tasks });
      else { noteCache[id] = parseNote(text); save(LS.noteCache(id), { text, sha: shas[id] }); }
    } catch(e){ lastErr = e; }
  }

  // Removal by identity, not by count. Once grouped by file the ops that
  // succeeded are no longer a contiguous prefix of the queue.
  queue = queue.filter(op => !succeeded.has(op));
  save(LS.queue, queue);
  busy = false;

  const cached = load(LS.cache, null);
  if (cached) doc = applyAll(parse(cached.text), queue.filter(op => fileOf(op) === "tasks"));
  render();

  if (lastErr){
    console.error(lastErr);
    setStatus("Not saved", "err"); toast(lastErr.message, null);
    setTimeout(() => { if (queue.length) scheduleFlush(8000); }, 0);
    return;
  }
  statusIdle();
  if (queue.length) scheduleFlush(300);
}

async function flushFile(id, ops){
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++){
    const f = await fetchFile(id);
    const text = id === "tasks"
      ? serialize(applyAll(parse(f.text), ops))
      : serializeNote(applyAllNotes(parseNote(f.text), ops));
    try {
      shas[id] = await putFile(id, text, f.sha, commitMsg(id, ops.length));
      return text;
    } catch(e){
      lastErr = e;
      if (e.status === 409 || e.status === 422){
        await new Promise(r => setTimeout(r, 350 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error(`Could not save ${FILES[id].label} after 3 tries.`);
}

function commitMsg(id, n){
  const what = n > 1 ? `${n} changes` : "1 change";
  return `${FILES[id].label.toLowerCase()}: ${what} from phone`;
}
```

- [ ] **Step 4: Add the note cache state**

In the state block, after `let shas = ...`:

```js
let noteCache = { lessons:null, ideas:null };   // null means not loaded yet
```

In the `LS` object, add a helper for per-note cache keys:

```js
const LS = { cfg:"tasks.cfg", queue:"tasks.queue", cache:"tasks.cache", seg:"tasks.seg",
             closed:"tasks.closed", tab:"tasks.tab", noteCache: id => `tasks.cache.${id}` };
```

- [ ] **Step 5: Run the full gate**

Run: `npm test`
Expected: 32 model tests pass. In e2e, the three original tests plus "one file failing does not drop another file's ops", "a note file that does not exist yet is created with just the entry" and "entries queued offline across two files all flush on reconnect" pass. The two that click `[data-tab=...]` still fail until Task 9.

- [ ] **Step 6: Commit**

```bash
git add index.html test/e2e.js
git commit -m "Group flush by file, with per-file failure isolation

flush now groups pending ops by file and runs the existing fetch,
replay, PUT and retry loop once per file, sequentially. Two things this
had to get right: queue removal is by identity rather than by count,
because grouped ops are no longer a contiguous prefix, and one file
failing no longer abandons another file's ops.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: The tab bar and the read-only note list

**Files:**
- Modify: `index.html` (markup, CSS, `render`, boot, `addTask`)
- Modify: `test/e2e.js`

**Interfaces:**
- Consumes: `noteCache`, `flushFile`, `fetchFile`, `parseNote` from Tasks 6 to 8.
- Produces: `tab` state (`"tasks" | "lessons" | "ideas"`), `switchTab(id)`, `loadNote(id)`, `renderNote(id)`. DOM contract for the e2e suite: `[data-tab="tasks"|"lessons"|"ideas"]` buttons, `#noteList` container, `.entry` per entry, `.entry.pending` while unflushed.

- [ ] **Step 1: Add the markup**

In `index.html`, inside `<header>`, after the `<div class="segs" id="segs"></div>` line:

```html
<div class="tabs" id="tabs">
  <button class="tab" data-tab="tasks" aria-selected="true">Tasks</button>
  <button class="tab" data-tab="lessons" aria-selected="false">Lessons</button>
  <button class="tab" data-tab="ideas" aria-selected="false">Ideas</button>
</div>
```

After `<main id="list"></main>`:

```html
<main id="noteList" class="hidden"></main>
```

- [ ] **Step 2: Add the CSS**

After the `.segs` rules:

```css
/* ---------- tabs ---------- */
.tabs{display:flex;margin:9px -14px -8px;border-top:1px solid var(--line)}
.tab{
  flex:1;min-height:46px;padding:0 4px;font-size:14px;color:var(--muted);
  background:none;border-bottom:2px solid transparent
}
.tab[aria-selected="true"]{color:var(--green);font-weight:700;border-bottom-color:var(--green)}
@media (prefers-color-scheme:dark){.tab[aria-selected="true"]{color:var(--yellow);border-bottom-color:var(--yellow)}}

/* ---------- note entries ---------- */
#noteList{padding:10px 12px calc(120px + var(--safe-b))}
.entry{
  background:var(--card);border:1px solid var(--line);border-radius:14px;
  box-shadow:var(--shadow);padding:11px 13px;margin-bottom:8px;
  font-size:15px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere
}
.entry.pending{opacity:.55}
```

The dark-mode tab colour uses yellow because `#006633` on `#0f1311` fails contrast.

- [ ] **Step 3: Add the tab logic**

Near `buildSegs`, add:

```js
let tab = load(LS.tab, "tasks");

function switchTab(id){
  tab = id; save(LS.tab, id);
  for (const b of document.querySelectorAll(".tab")) b.setAttribute("aria-selected", String(b.dataset.tab === id));
  $("segs").classList.toggle("hidden", id !== "tasks");
  $("list").classList.toggle("hidden", id !== "tasks");
  $("noteList").classList.toggle("hidden", id === "tasks");
  $("addInput").placeholder = id === "tasks" ? "Add a task"
    : id === "lessons" ? "What did you learn?" : "Add an idea";
  document.querySelector("header h1").textContent = FILES[id].label;
  if (id === "tasks") render(); else { renderNote(id); loadNote(id); }
}

// A note file is fetched the first time its tab is opened, never at boot, so
// the cold-open path stays as fast as it was.
async function loadNote(id){
  if (noteCache[id] !== null) return;
  const cached = load(LS.noteCache(id), null);
  if (cached){ shas[id] = cached.sha; noteCache[id] = parseNote(cached.text); renderNote(id); }
  try {
    const f = await fetchFile(id);
    shas[id] = f.sha;
    noteCache[id] = parseNote(f.text);
    save(LS.noteCache(id), { text: f.text, sha: f.sha });
    renderNote(id);
  } catch(e){
    console.error(e);
    if (noteCache[id] === null) renderNoteError(id, e.message);
  }
}

function renderNote(id){
  const el = $("noteList");
  if (tab !== id) return;
  const pending = queue.filter(op => op.t === "note" && op.file === id).map(op => flattenEntry(op.text));
  const saved = noteCache[id];

  if (saved === null && !pending.length){
    el.innerHTML = `<div class="empty">Loading…</div>`;
    return;
  }
  // A pending entry that has already landed in the fetched file must not show
  // twice, so dedupe across the two lists and mark anything not yet in the
  // saved list as still in flight.
  const seen = new Set();
  const rows = [];
  for (const text of pending.concat(saved || [])){
    if (seen.has(text)) continue;
    seen.add(text);
    rows.push({ text, pending: !(saved || []).includes(text) });
  }
  if (!rows.length){
    el.innerHTML = `<div class="empty">Nothing here yet.</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of rows){
    const d = document.createElement("div");
    d.className = "entry" + (r.pending ? " pending" : "");
    d.textContent = r.text;
    frag.appendChild(d);
  }
  el.replaceChildren(frag);
}

function renderNoteError(id, msg){
  $("noteList").innerHTML = `<div class="empty">Could not load ${esc(FILES[id].label)}. ${esc(msg)}</div>`;
}
```

- [ ] **Step 4: Route the add button**

Replace `addTask` with:

```js
function addTask(){
  const inp = $("addInput");
  const text = inp.value.trim();
  if (!text) return;
  if (tab === "tasks"){
    push({ t:"add", file:"tasks", sec: addSec, text });
    if (closed.has(addSec)) { closed.delete(addSec); save(LS.closed,[...closed]); }
  } else {
    push({ t:"note", file: tab, text });
  }
  inp.value = "";
  inp.focus();
}
```

And in `push`, make it render the right pane:

```js
function push(op){
  if (fileOf(op) === "tasks") applyOp(doc, op);
  queue.push(op); save(LS.queue, queue);
  if (tab === "tasks") render(); else renderNote(tab);
  scheduleFlush();
}
```

- [ ] **Step 5: Wire the tab buttons and boot**

Near the other event bindings:

```js
for (const b of document.querySelectorAll(".tab")) b.onclick = () => switchTab(b.dataset.tab);
```

In the boot block, after `render(); statusIdle();`, add `switchTab(tab);` so a reload lands back on the tab you left. In the `visibilitychange` handler, only refresh Tasks:

```js
document.addEventListener("visibilitychange", () => { if (!document.hidden && tab === "tasks") refresh(); });
```

- [ ] **Step 6: Restore the UI-driven e2e helper**

In `test/e2e.js`, replace the temporary `addTo` from Task 8 Step 2 with:

```js
async function addTo(page, tab, text){
  await page.click(`[data-tab="${tab}"]`);
  await page.fill("#addInput", text);
  await page.click("#addBtn");
}
```

Add two more tests before the runner:

```js
test("opening a note tab shows what is already in the file", async () => {
  const files = { "001 Tasks.md": BASE, "WU Ideas.md": IDEAS, "Lessons Learned.md": LESSONS };
  await withApp(files, async page => {
    await page.click('[data-tab="lessons"]');
    await page.waitForSelector(".entry");
    const texts = await page.$$eval(".entry", els => els.map(e => e.textContent));
    assert.deepStrictEqual(texts, ["An existing lesson"]);
  });
});

test("boot fetches only the task file", async () => {
  const files = { "001 Tasks.md": BASE, "WU Ideas.md": IDEAS, "Lessons Learned.md": LESSONS };
  const asked = [];
  await withApp(files, async page => {
    await page.waitForTimeout(800);
    assert.ok(!asked.some(p => p !== "001 Tasks.md"),
              "boot fetched a note file: " + asked.join(", "));
    await page.click('[data-tab="ideas"]');
    await page.waitForSelector(".entry");
    assert.ok(asked.includes("WU Ideas.md"), "opening the tab did not fetch the note");
  }, { onGet: p => asked.push(p) });
});
```

Add the `onGet` hook to `withApp`: inside the `GET` branch of the route handler, before returning, call `if (opts.onGet) opts.onGet(p);`.

- [ ] **Step 7: Run the full gate**

Run: `npm test`
Expected: 32 model tests pass, 9/9 e2e pass. Every test from Task 8 that was failing on `[data-tab=...]` is now green.

- [ ] **Step 8: Eyeball both themes**

Run: `npm run shots` and look at `test/shots/`. Check the tab bar in dark mode, where the selected tab is yellow rather than green, and check that a long entry wraps rather than overflowing.

Then run the real thing: `npm run serve`, open `http://localhost:8081/`, and check the tab targets are comfortably thumb-sized. Stop with `killdev 8081`.

- [ ] **Step 9: Commit**

```bash
git add index.html test/e2e.js
git commit -m "Add the tab bar and the read-only Lessons and Ideas lists

Tabs switch between the three files. A note tab hides the section chips,
changes the placeholder, and renders entries as read-only cards: no
checkbox, no menu, no swipe. Unflushed entries show at the top, muted.

A note file is fetched the first time its tab is opened and never at
boot, so the cold-open path is unchanged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Ship v1.1.0

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`
- Modify: `sw.js`
- Modify: `package.json`
- Modify: `manifest.webmanifest`

**Interfaces:**
- Consumes: everything.
- Produces: a release.

- [ ] **Step 1: Bump the version markers**

`sw.js`: `const CACHE = "tasks-v1.1.0";`
`package.json`: `"version": "1.1.0"`

- [ ] **Step 2: Add the changelog entry**

At the top of `CHANGELOG.md`, above the v1.0.1 entry:

```markdown
## v1.1.0, 20 August 2026

Added:
- Lessons and Ideas tabs, writing to `Lessons Learned.md` and `WU Ideas.md`
  at the root of the vault repo. Capture plus a read-only list of what is
  already in the note. Newest entry first.
- Note files use their own format: plain paragraphs separated by a blank
  line, no headings and no list syntax. Nothing is parsed inside a
  paragraph, so wikilinks pass through untouched.
- Two file path fields in settings, defaulting to the two notes above.

Changed:
- `flush` groups pending ops by file and retries each file independently.
  One file failing no longer discards another file's queued ops.
- Ops carry a `file` key. An op without one is treated as a Tasks op, so
  anything queued by v1.0.1 on a phone still lands correctly.
- A note file is fetched the first time its tab is opened, never at boot.
  Cold open still loads only `001 Tasks.md`.
```

- [ ] **Step 3: Document the second Markdown contract in CLAUDE.md**

Add a section after "The Markdown contract":

```markdown
## The note contract

`WU Ideas.md` and `Lessons Learned.md` are **not** in the Tasks format.

- No headings, no frontmatter, no list syntax.
- One entry per paragraph, separated by a single blank line. **That blank
  line is the record separator**, the exact inverse of what a blank line
  means in `001 Tasks.md`.
- Nothing is parsed inside a paragraph, so wikilinks, punctuation and
  accented characters pass through untouched.
- Entries are single paragraphs by contract. A pasted multi-line entry is
  flattened by `flattenEntry` rather than silently becoming two entries on
  the next read.
- The app never creates structure in these files. If one grows headings by
  hand, they become ordinary entry text and are preserved verbatim.
- New entries go on top, newest first. No date stamps.

The app is capture plus read only here. It cannot edit, delete or reorder
an entry, and that is deliberate: these notes have no lifecycle, so the
task machinery would earn nothing.
```

Also update the architecture diagram in CLAUDE.md to show all three files, and the Layout section to list `test/fixtures/`.

- [ ] **Step 4: Update the manifest description**

In `manifest.webmanifest`, if the `description` field mentions only tasks, widen it to "Tasks, lessons and ideas, straight into the vault." Leave `name`, `short_name`, icons and the share target alone.

- [ ] **Step 5: Run the full gate**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md CLAUDE.md sw.js package.json manifest.webmanifest
git commit -m "Document the note contract and cut v1.1.0

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Stop and hand back to Isaac**

Do not push, do not tag, do not merge. Report what is done and ask for the call on:

1. Merging `notes-capture` into `main` and pushing.
2. Tagging `v1.0.1` and `v1.1.0` and cutting the two GitHub releases.
3. Adding the two note paths to his phone's settings after the deploy, since existing installs have no `lessonsPath` or `ideasPath` in `localStorage` and pick up the defaults on next `saveCfg`.

Also remind him, separately from this work: the vault's `.git/config` still holds its GitHub PAT in plaintext and should be rotated.

---

## Self-review notes

Checked against the spec on 20 Aug 2026:

- Every spec section maps to a task. Markdown contract to Task 7, config to Task 6 Step 8, ops and queue to Tasks 6 and 7, `flush()` to Task 8, UI to Task 9, loading to Task 9 Step 3, testing spread across 2, 3, 4, 7, 8, 9, versioning to Tasks 5 and 10.
- The spec's three `flush()` hazards are each covered: identity removal in Task 8 Step 3, per-file isolation by the e2e test in Task 8 Step 1, and the 404 skeleton in Task 6 Step 5.
- Names are consistent across tasks: `fileOf`, `parseNote`, `serializeNote`, `flattenEntry`, `applyNoteOp`, `applyAllNotes`, `pathOf`, `blankFor`, `flushFile`, `commitMsg`, `switchTab`, `loadNote`, `renderNote`, `noteCache`, `shas`.
- Known ordering wrinkle, called out inline: three e2e tests written in Task 8 depend on the tab bar built in Task 9. Task 8 Step 2 supplies a temporary direct-op helper so the task is independently testable, and Task 9 Step 6 restores the UI-driven version.
