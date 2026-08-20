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
  const out = run(BASE, [
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

test("a section missing from the file still gets a blank line under its heading", () => {
  const src = "# Tasks\n\n## Today\n\n- [ ] Call the outfitter\n";
  const out = run(src, [{ t: "add", sec: "Ice box", text: "Schools deck" }]);
  assert.match(out, /## Ice box\n\n- \[ \] Schools deck/);
});

test("an op with no file key routes to tasks, so ops queued by the old version survive", () => {
  assert.strictEqual(M.fileOf({ t: "add", sec: "Today", text: "Legacy op" }), "tasks");
});

test("an op with a file key routes to that file", () => {
  assert.strictEqual(M.fileOf({ t: "note", file: "ideas", text: "Sponsor local meetups" }), "ideas");
  assert.strictEqual(M.fileOf({ t: "add", file: "tasks", sec: "Today", text: "x" }), "tasks");
});
