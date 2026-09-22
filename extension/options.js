const { mergeSettings } = globalThis.SmeAI;
const $ = (id) => document.getElementById(id);
const msg = (text, cls = "") => { $("msg").textContent = text; $("msg").className = cls; };

const SIMPLE = ["typesafeKey", "geminiKey", "geminiModel", "hateThreshold", "attackPenalty", "vulgarPenalty", "topN", "maxPosts", "readDwellMs", "geminiPriceIn", "geminiPriceOut"];
const CHECKS = ["enableDiscussion", "enableArticle", "articleAutoLoad", "autoSummary", "autoExpand", "hideHate", "hideLowQuality", "hideRead"];
const usd = (v) => "$" + (v >= 0.01 ? v.toFixed(3) : v.toFixed(4));

async function showCosts() {
  const { global: c } = await chrome.runtime.sendMessage({ type: "getCosts" });
  $("costs").textContent = `TypeSafe ${usd(c.tsUsd)} (${c.tsPosts} príspevkov, ${c.tsTokens.toLocaleString("sk-SK")} tokenov) · ` +
    `Gemini ${usd(c.gmUsd)} (${c.gmRuns}× zhrnutie, ${c.gmIn.toLocaleString("sk-SK")} + ${c.gmOut.toLocaleString("sk-SK")} tokenov) · spolu ${usd(c.tsUsd + c.gmUsd)}`;
}
const NESTED = { weights: ["substance", "relevance", "writing"], thresholds: ["hidden", "red", "yellow"] };
const nestedId = (group, k) => (group === "weights" ? "w_" : "t_") + k;

async function load() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = mergeSettings(settings);
  for (const k of SIMPLE) $(k).value = s[k];
  for (const k of CHECKS) $(k).checked = !!s[k];
  for (const [g, keys] of Object.entries(NESTED)) for (const k of keys) $(nestedId(g, k)).value = s[g][k];
}

async function save() {
  const s = {};
  for (const k of SIMPLE) {
    const v = $(k).value.trim();
    s[k] = $(k).type === "number" ? Number(v) : v;
  }
  for (const k of CHECKS) s[k] = $(k).checked;
  for (const [g, keys] of Object.entries(NESTED)) {
    s[g] = {};
    for (const k of keys) s[g][k] = Number($(nestedId(g, k)).value);
  }
  const t = s.thresholds;
  if (!(t.hidden <= t.red && t.red <= t.yellow)) return msg("Prahy musia byť vzostupne: skryť ≤ červená ≤ žltá.", "err");
  await chrome.storage.local.set({ settings: s });
  msg("Uložené. Obnov stránku sme.sk.", "ok");
}

$("save").addEventListener("click", save);
$("test").addEventListener("click", async () => {
  await save();
  msg("Testujem…");
  const r = await chrome.runtime.sendMessage({ type: "testKeys" });
  const ok = /^OK/.test(r.typesafe) && /^OK/.test(r.gemini);
  msg(`TypeSafe: ${r.typesafe} · Gemini: ${r.gemini}`, ok ? "ok" : "err");
});
$("clear").addEventListener("click", async () => {
  if (!confirm("Vymazať uložené hodnotenia a zhrnutia? Pri ďalšej návšteve sa budú platiť znova.")) return;
  const r = await chrome.runtime.sendMessage({ type: "clearCache" });
  msg(`Vymazaných ${r.removed} záznamov z cache.`, "ok");
});
$("clearRead").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "clearRead" });
  msg(`Vymazané prečítané v ${r.removed} diskusiách.`, "ok");
});
$("resetCosts").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "resetCosts" });
  showCosts();
  msg("Náklady vynulované.", "ok");
});
load();
showCosts();
