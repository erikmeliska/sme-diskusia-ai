// Živý test pipeline mimo prehliadača: TypeSafe + policy + stats + Gemini na dátach z PoC (poc/posts.json – nie je v repozitári).
// Spustenie: TYPESAFE_API_KEY=... GEMINI_API_KEY=... node scripts/live-check.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { scoreAll } = require("../lib/typesafe.js");
const { verdict, mergeSettings } = require("../lib/policy.js");
const { computeStats, topPosts } = require("../lib/stats.js");
const { summarize } = require("../lib/gemini.js");

const envKey = (...parts) => Object.entries(process.env).find(([k, v]) => parts.some((p) => k.toUpperCase().includes(p)) && v.trim())?.[1].trim();
const tsKey = envKey("JEV", "TYPESAFE");
const gmKey = envKey("GEMINI");
if (!tsKey) { console.error("Chýba TypeSafe kľúč v env"); process.exit(1); }

const src = JSON.parse(readFileSync(new URL("../../poc/posts.json", import.meta.url)));
const votes = JSON.parse(readFileSync(new URL("../../poc/votes.json", import.meta.url)));
const posts = src.posts.map((p) => ({
  id: p.id, parentId: p.parent_id, depth: p.depth, createdAt: `2026-09-22T${p.time.padStart(5, "0")}:00Z`,
  author: null, status: "active", text: p.text, votesUp: votes[p.id][0], votesDown: votes[p.id][1],
}));
const article = { title: src.article.title, summary: src.article.summary };
const settings = mergeSettings({ geminiModel: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite" });

const t0 = Date.now();
const { results, tokens, errors } = await scoreAll(fetch, tsKey, article, posts, { concurrency: 6 });
const enriched = posts.map((p) => ({ ...p, answers: results.get(p.id), verdict: verdict(results.get(p.id), settings) }));
const stats = computeStats(enriched);
console.log(`TypeSafe: ${results.size}/${posts.length} za ${((Date.now() - t0) / 1000).toFixed(1)} s, ${tokens} tokenov ≈ $${((tokens / 1e6) * 0.042).toFixed(4)}, chyby: ${errors.length}`);
if (errors.length) console.log(errors.slice(0, 3));
const { topAuthors, ...rest } = stats;
console.log("Štatistiky:", JSON.stringify(rest, null, 1));

// kontrola: v3 (všeobecné otázky) by malo dávať podobné farby ako v2 z PoC
const scored = JSON.parse(readFileSync(new URL("../../poc/scored.json", import.meta.url))).posts;
const map = { hidden: ["low", "hate"], red: ["red"], yellow: ["yellow"], green: ["green"] };
const same = scored.filter((p) => map[p.color].includes(enriched.find((e) => e.id === p.id).verdict.color)).length;
console.log(`Zhoda farieb v3 vs. PoC v2: ${same}/${scored.length}`);

const top = topPosts(enriched, settings.topN);
console.log("\nTop príspevky:");
top.slice(0, 5).forEach((p, i) => console.log(` #${i + 1} Q${Math.round(p.verdict.quality * 100)} ${p.answers.kind.choice}/${p.answers.stance.choice}: ${p.text.slice(0, 90).replace(/\n/g, " ")}`));

if (!gmKey) { console.log("\n(Gemini kľúč nie je v env – zhrnutie preskočené)"); process.exit(0); }
const t1 = Date.now();
const sum = await summarize(fetch, gmKey, settings.geminiModel, article, top, stats);
console.log(`\nGemini (${settings.geminiModel}) za ${((Date.now() - t1) / 1000).toFixed(1)} s, usage: ${JSON.stringify(sum.usage)}`);
console.log("Zhrnutie:", sum.summary);
sum.key_points.forEach((k) => console.log(" •", k.point, "←", k.post_ids.join(",")));
console.log("Zhoda:", sum.agreements);
console.log("Spory:", sum.disagreements);
const known = new Set(top.map((p) => p.id));
const bad = sum.key_points.flatMap((k) => k.post_ids).filter((id) => !known.has(String(id)));
console.log(`Odkazy na neexistujúce/nevybrané príspevky: ${bad.length ? bad.join(",") : "žiadne"}`);
