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
  "appendTask", "prependTask", "applyOp", "applyAll", "clone", "fileOf",
  "parseNote", "serializeNote", "flattenEntry", "applyNoteOp", "applyAllNotes",
];

module.exports = new Function(
  `"use strict";\n${m[1]}\nreturn { ${EXPORTS.join(", ")} };`
)();
