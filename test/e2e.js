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

// npm run shots: light and dark screenshots of each tab, for eyeballing a CSS
// change without a phone in your hand.
async function shots(){
  const dir = path.join(__dirname, "shots");
  fs.mkdirSync(dir, { recursive: true });
  for (const scheme of ["light", "dark"]){
    const files = { "001 Tasks.md": BASE, "WU Ideas.md": IDEAS, "Lessons Learned.md": LESSONS };
    await withApp(files, async page => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 390, height: 844 });
      for (const t of ["tasks", "lessons", "ideas"]){
        await page.click(`[data-tab="${t}"]`);
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(dir, `${t}-${scheme}.png`) });
      }
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
