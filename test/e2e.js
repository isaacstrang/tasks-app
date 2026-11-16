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
      if (opts.onGet) opts.onGet(p);
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

  const cfg = JSON.stringify(Object.assign({}, CFG, opts.cfg));
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

// Waiting on the "Synced" chip alone races the one the app shows after its
// boot refresh, before the new op has flushed. So wait on the fake file, which
// is the thing under test anyway.
async function until(fn, msg, ms = 15000){
  const stop = Date.now() + ms;
  while (Date.now() < stop){
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("timed out waiting for: " + msg);
}

async function addVia(page, text){
  await page.fill("#addInput", text);
  await page.click("#addBtn");
}

const IDEAS = "An existing idea\n";
const LESSONS = "An existing lesson";
const NOTE_CFG = { lessonsPath: "Lessons Learned.md", ideasPath: "WU Ideas.md" };

async function addTo(page, tab, text){
  await page.click(`[data-tab="${tab}"]`);
  await page.fill("#addInput", text);
  await page.click("#addBtn");
}

const TESTS = [];
const test = (name, fn) => TESTS.push({ name, fn });

test("a task added on the phone lands in the file under the default section", async () => {
  const files = { "001 Tasks.md": BASE };
  await withApp(files, async page => {
    await addVia(page, "Book the campsite deposit");
    await until(() => files["001 Tasks.md"].includes("campsite deposit"), "the task to reach the file");
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
    await until(() => files["001 Tasks.md"].includes("Killarney"), "the task to reach the file after a 409");
    await page.waitForTimeout(600);
    const hits = files["001 Tasks.md"].split("\n").filter(l => l === "- [ ] Killarney permits");
    assert.strictEqual(hits.length, 1, "task did not land exactly once after a 409");
  }, { fail409: 1 });
});

test("tasks added while offline queue up and flush on reconnect", async () => {
  const files = { "001 Tasks.md": BASE };
  await withApp(files, async page => {
    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await addVia(page, "Offline one");
    await addVia(page, "Offline two");
    await page.waitForTimeout(1500);
    assert.ok(!files["001 Tasks.md"].includes("Offline one"), "wrote to GitHub while offline");
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await until(() => files["001 Tasks.md"].includes("Offline two"), "the queue to flush on reconnect");
    assert.ok(files["001 Tasks.md"].includes("- [ ] Offline one"), "queued task never flushed");
    assert.ok(files["001 Tasks.md"].includes("- [ ] Offline two"), "second queued task never flushed");
  });
});


test("an idea lands in WU Ideas.md, newest first, and never touches the task file", async () => {
  const files = { "001 Tasks.md": BASE, "WU Ideas.md": IDEAS, "Lessons Learned.md": LESSONS };
  await withApp(files, async page => {
    await addTo(page, "ideas", "Fall colour bus day trip");
    await until(() => files["WU Ideas.md"].includes("Fall colour"), "the idea to reach its note");
    assert.strictEqual(files["WU Ideas.md"], "Fall colour bus day trip\n\nAn existing idea\n");
    assert.strictEqual(files["001 Tasks.md"], BASE, "the task file was rewritten");
  }, { cfg: NOTE_CFG });
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
    await until(() => files["001 Tasks.md"].includes("campsite deposit"), "the healthy file to commit");

    assert.strictEqual(files["WU Ideas.md"], IDEAS, "the broken file was written anyway");
    const queued = await page.evaluate(() => JSON.parse(localStorage.getItem("tasks.queue") || "[]"));
    assert.strictEqual(queued.length, 1, "expected exactly the failed op to remain queued, got " + JSON.stringify(queued));
    assert.strictEqual(queued[0].text, "Doomed idea");
  }, { cfg: NOTE_CFG });
});

test("a note file that does not exist yet is created with just the entry", async () => {
  const files = { "001 Tasks.md": BASE };
  await withApp(files, async page => {
    await addTo(page, "lessons", "Fuel the bus the night before");
    await until(() => files["Lessons Learned.md"] !== undefined, "the note file to be created");
    assert.strictEqual(files["Lessons Learned.md"], "Fuel the bus the night before\n");
  }, { cfg: NOTE_CFG });
});

test("entries queued offline across three files all flush on reconnect", async () => {
  const files = { "001 Tasks.md": BASE, "WU Ideas.md": IDEAS, "Lessons Learned.md": LESSONS };
  await withApp(files, async page => {
    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await addTo(page, "ideas", "Offline idea");
    await addTo(page, "lessons", "Offline lesson");
    await addTo(page, "tasks", "Offline task");
    await page.waitForTimeout(1200);
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await until(() => files["001 Tasks.md"].includes("Offline task"), "the task file to flush");
    await until(() => files["WU Ideas.md"].startsWith("Offline idea"), "the ideas file to flush");
    await until(() => files["Lessons Learned.md"].startsWith("Offline lesson"), "the lessons file to flush");
  }, { cfg: NOTE_CFG });
});

test("opening a note tab shows what is already in the file", async () => {
  const files = { "001 Tasks.md": BASE, "WU Ideas.md": IDEAS, "Lessons Learned.md": LESSONS };
  await withApp(files, async page => {
    await page.click('[data-tab="lessons"]');
    await page.waitForSelector(".entry");
    const texts = await page.$$eval(".entry", els => els.map(e => e.textContent));
    assert.deepStrictEqual(texts, ["An existing lesson"]);
  }, { cfg: NOTE_CFG });
});

// A config saved before the note tabs shipped has no lessonsPath or ideasPath.
// Every other note test injects NOTE_CFG, so the upgrade path, which is the
// only path a real phone takes, went untested until it broke on the phone.
test("a config saved before the note tabs shipped still finds the note files", async () => {
  const files = { "001 Tasks.md": BASE, "WU Ideas.md": IDEAS, "Lessons Learned.md": LESSONS };
  await withApp(files, async page => {
    await page.click('[data-tab="lessons"]');
    await page.waitForSelector(".entry", { timeout: 8000 });
    const texts = await page.$$eval(".entry", els => els.map(e => e.textContent));
    assert.deepStrictEqual(texts, ["An existing lesson"]);

    await addTo(page, "ideas", "An idea from a phone that never re-connected");
    await until(() => files["WU Ideas.md"].startsWith("An idea from a phone that never re-connected"),
                "the idea to land in WU Ideas.md");
    assert.strictEqual(files["001 Tasks.md"], BASE, "the task file was touched");
  });
});

test("boot fetches only the task file, and a note is fetched when its tab opens", async () => {
  const files = { "001 Tasks.md": BASE, "WU Ideas.md": IDEAS, "Lessons Learned.md": LESSONS };
  const asked = [];
  await withApp(files, async page => {
    await page.waitForTimeout(900);
    assert.deepStrictEqual([...new Set(asked)], ["001 Tasks.md"],
                           "boot fetched more than the task file: " + [...new Set(asked)].join(", "));
    await page.click('[data-tab="ideas"]');
    await page.waitForSelector(".entry");
    assert.ok(asked.includes("WU Ideas.md"), "opening the tab did not fetch the note");
  }, { cfg: NOTE_CFG, onGet: p => asked.push(p) });
});

test("a note tab shows an unflushed entry immediately, marked pending", async () => {
  const files = { "001 Tasks.md": BASE, "WU Ideas.md": IDEAS, "Lessons Learned.md": LESSONS };
  await withApp(files, async page => {
    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await addTo(page, "ideas", "An idea with no signal");
    await page.waitForSelector(".entry.pending");
    const texts = await page.$$eval(".entry", els => els.map(e => e.textContent));
    assert.deepStrictEqual(texts, ["An idea with no signal", "An existing idea"]);
  }, { cfg: NOTE_CFG });
});

/* ---------- reorder ---------- */
// Done deliberately holds two tasks here. With one it would be excluded for
// having nothing to arrange, and the test would pass without proving that a
// section outside SECTIONS is excluded on its own merits.
const ORDERED = "# Tasks\n\n## Today\n\n- [ ] First task\n- [ ] Second task\n- [ ] Third task\n\n" +
                "## This week\n\n- [ ] Review the welcome email\n\n## Longer term\n\n## Ice box\n\n" +
                "## Done\n\n- [x] Rope (done Aug 18)\n- [x] Maps (done Aug 17)\n";

// Sections render in SECTIONS order, so Today is 0 and This week is 1. Done is
// pinned last and only rendered when it has tasks, which here it does.
const sec = (page, i) => page.locator("section.sec").nth(i);
const todayTasks = text => text.split("## Today")[1].split("## This week")[0]
                               .split("\n").filter(l => /^- \[[ x]\] /.test(l));
const row = (page, i, n) => sec(page, i).locator("li.task").nth(n);

test("moving a task up rewrites the order in the file, tightly", async () => {
  const files = { "001 Tasks.md": ORDERED };
  await withApp(files, async page => {
    await sec(page, 0).locator(".reorderbtn").click();
    await row(page, 0, 2).locator('[aria-label="Move up"]').click();
    await until(() => todayTasks(files["001 Tasks.md"])[1] === "- [ ] Third task",
                "the new order to reach the file");
    assert.deepStrictEqual(todayTasks(files["001 Tasks.md"]),
      ["- [ ] First task", "- [ ] Third task", "- [ ] Second task"]);
    assert.ok(/## Today\n\n- \[ \] First task\n- \[ \] Third task\n- \[ \] Second task\n\n## This week/
      .test(files["001 Tasks.md"]), "reorder loosened the list or lost the heading spacing");
  });
});

test("moving a task down past the bottom sends it to the end of the section", async () => {
  const files = { "001 Tasks.md": ORDERED };
  await withApp(files, async page => {
    await sec(page, 0).locator(".reorderbtn").click();
    await row(page, 0, 1).locator('[aria-label="Move down"]').click();
    await until(() => todayTasks(files["001 Tasks.md"])[2] === "- [ ] Second task",
                "the task to reach the bottom of Today");
    assert.deepStrictEqual(todayTasks(files["001 Tasks.md"]),
      ["- [ ] First task", "- [ ] Third task", "- [ ] Second task"]);
    assert.ok(/- \[ \] Second task\n\n## This week/.test(files["001 Tasks.md"]),
      "the task at the bottom gained a blank line above it");
  });
});

// The whole reason the op carries a neighbour instead of an index: a flush can
// fail after GitHub has committed, and the op is then replayed onto content
// that already contains its effect.
test("a 409 retry replays the reorder without moving the task twice", async () => {
  const files = { "001 Tasks.md": ORDERED };
  await withApp(files, async page => {
    await sec(page, 0).locator(".reorderbtn").click();
    await row(page, 0, 2).locator('[aria-label="Move up"]').click();
    await until(() => todayTasks(files["001 Tasks.md"])[1] === "- [ ] Third task",
                "the reorder to land after a 409");
    await page.waitForTimeout(700);
    assert.deepStrictEqual(todayTasks(files["001 Tasks.md"]),
      ["- [ ] First task", "- [ ] Third task", "- [ ] Second task"],
      "the reorder was applied more than once");
  }, { fail409: 1 });
});

test("several taps in a row land as one coherent order in the file", async () => {
  const files = { "001 Tasks.md": ORDERED };
  await withApp(files, async page => {
    await sec(page, 0).locator(".reorderbtn").click();
    // Walk the third task to the top, two taps on the same row position.
    await row(page, 0, 2).locator('[aria-label="Move up"]').click();
    await row(page, 0, 1).locator('[aria-label="Move up"]').click();
    await until(() => todayTasks(files["001 Tasks.md"])[0] === "- [ ] Third task",
                "the task to reach the top of Today");
    await page.waitForTimeout(700);
    assert.deepStrictEqual(todayTasks(files["001 Tasks.md"]),
      ["- [ ] Third task", "- [ ] First task", "- [ ] Second task"]);
  });
});

test("the queue survives being offline mid-reorder and flushes the order on reconnect", async () => {
  const files = { "001 Tasks.md": ORDERED };
  await withApp(files, async page => {
    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await sec(page, 0).locator(".reorderbtn").click();
    await row(page, 0, 2).locator('[aria-label="Move up"]').click();
    await page.waitForTimeout(1200);
    assert.strictEqual(files["001 Tasks.md"], ORDERED, "wrote to GitHub while offline");
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await until(() => todayTasks(files["001 Tasks.md"])[1] === "- [ ] Third task",
                "the queued reorder to flush on reconnect");
    assert.deepStrictEqual(todayTasks(files["001 Tasks.md"]),
      ["- [ ] First task", "- [ ] Third task", "- [ ] Second task"]);
  });
});

test("reorder mode removes the checkboxes, so no task can be completed by mis-tap", async () => {
  const files = { "001 Tasks.md": ORDERED };
  await withApp(files, async page => {
    await sec(page, 0).locator(".reorderbtn").click();
    assert.strictEqual(await sec(page, 0).locator(".check").count(), 0,
                       "a checkbox is still tappable in reorder mode");
    await row(page, 0, 0).locator(".ttl").click();
    await page.waitForTimeout(500);
    assert.strictEqual(await page.locator("#sheet.on").count(), 0,
                       "the action sheet opened from reorder mode");
    assert.strictEqual(files["001 Tasks.md"], ORDERED,
                       "the file changed while only tapping a title");
  });
});

test("the arrows at the ends of the list are disabled rather than missing", async () => {
  const files = { "001 Tasks.md": ORDERED };
  await withApp(files, async page => {
    await sec(page, 0).locator(".reorderbtn").click();
    assert.strictEqual(await row(page, 0, 0).locator('[aria-label="Move up"]').isDisabled(), true);
    assert.strictEqual(await row(page, 0, 2).locator('[aria-label="Move down"]').isDisabled(), true);
    assert.strictEqual(await row(page, 0, 1).locator('[aria-label="Move down"]').isDisabled(), false);
    assert.strictEqual(await row(page, 0, 1).locator('[aria-label="Move up"]').isDisabled(), false);
  });
});

test("Done and a one-task section are offered no reorder control", async () => {
  const files = { "001 Tasks.md": ORDERED };
  await withApp(files, async page => {
    assert.strictEqual(await sec(page, 0).locator(".reorderbtn").count(), 1,
                       "Today was not offered reorder");
    assert.strictEqual(await sec(page, 1).locator(".reorderbtn").count(), 0,
                       "a one-task section was offered reorder");
    // Done starts collapsed, so open it before concluding anything about it.
    await sec(page, 4).locator(".sechead").click();
    await page.waitForSelector("section.sec:nth-of-type(5) li.task", { state: "attached" }).catch(() => {});
    assert.strictEqual(await sec(page, 4).locator(".reorderbtn").count(), 0,
                       "Done was offered reorder");
  });
});

test("leaving reorder mode brings the checkboxes back", async () => {
  const files = { "001 Tasks.md": ORDERED };
  await withApp(files, async page => {
    const pill = sec(page, 0).locator(".reorderbtn");
    await pill.click();
    assert.strictEqual(await pill.textContent(), "Done");
    await pill.click();
    assert.strictEqual(await pill.textContent(), "Reorder");
    assert.strictEqual(await sec(page, 0).locator(".check").count(), 3,
                       "the checkboxes did not come back");
  });
});

// npm run shots: light and dark screenshots of each tab, for eyeballing a CSS
// change without a phone in your hand.
async function shots(){
  const dir = path.join(__dirname, "shots");
  fs.mkdirSync(dir, { recursive: true });
  for (const scheme of ["light", "dark"]){
    // ORDERED, not BASE: a one-task Today draws no reorder control, so the
    // shots could not show the thing a CSS change here most likely breaks.
    const files = { "001 Tasks.md": ORDERED, "WU Ideas.md": IDEAS, "Lessons Learned.md": LESSONS };
    await withApp(files, async page => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 390, height: 844 });
      for (const t of ["tasks", "lessons", "ideas"]){
        await page.click(`[data-tab="${t}"]`);
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(dir, `${t}-${scheme}.png`) });
      }
      await page.click('[data-tab="tasks"]');
      await sec(page, 0).locator(".reorderbtn").click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(dir, `reorder-${scheme}.png`) });
    }, { cfg: NOTE_CFG });
    console.log("  wrote " + scheme + " shots");
  }
  console.log("\nscreenshots in test/shots/");
}

(async () => {
  if (process.env.SHOTS) return shots();
  let failed = 0;
  for (const t of TESTS){
    try { await t.fn(); console.log("  ok   " + t.name); }
    catch (e){ failed++; console.error("  FAIL " + t.name + "\n       " + e.message); }
  }
  console.log(`\n${TESTS.length - failed}/${TESTS.length} passed`);
  process.exit(failed ? 1 : 0);
})();
