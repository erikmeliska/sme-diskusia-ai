// Zloží jeden skript na injektovanie do stránky: lib/* + shim + background.js (vo vlastnom scope s falošným chrome/fetch) + content.js
// Použitie: node tests/build-test-bundle.mjs <výstup.js>
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const ext = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(path.join(ext, f), "utf8");
const libs = ["lib/text.js", "lib/forum.js", "lib/typesafe.js", "lib/policy.js", "lib/stats.js", "lib/gemini.js", "lib/pricing.js"].map(read);
const bundle = [
  ...libs,
  read("tests/browser-shim.js"),
  `(function (chrome, fetch, importScripts, self) {\n${read("background.js")}\n})(window.__bgChrome, window.__bgFetch, () => {}, window);`,
  read("content.js"),
].join("\n;\n");
writeFileSync(process.argv[2], bundle);
console.log(`bundle ${bundle.length} B → ${process.argv[2]}`);
