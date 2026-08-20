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
