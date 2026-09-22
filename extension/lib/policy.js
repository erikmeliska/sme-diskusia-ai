// Politika: z odpovedí modelu spraví kvalitu 0–1, farbu a dôvod. Čisto v kóde – zmena váh nevyžaduje nové volanie modelu.
(function (root) {
  const DEFAULT_SETTINGS = {
    typesafeKey: "",
    geminiKey: "",
    geminiModel: "gemini-3.5-flash-lite",
    weights: { substance: 0.45, relevance: 0.3, writing: 0.25 },
    attackPenalty: 0.35,
    vulgarPenalty: 0.1,
    hateThreshold: 0.6,
    thresholds: { hidden: 0.25, red: 0.45, yellow: 0.65 },
    hideHate: true,
    hideLowQuality: true,
    autoExpand: true,
    hideRead: false, // pri opakovanej návšteve diskusie ukázať len nové (neprečítané) príspevky
    readDwellMs: 1500, // ako dlho musí byť príspevok viditeľný, aby sa počítal za prečítaný
    autoSummary: false, // true = prvé zhrnutie sa vygeneruje samo; ďalšie vždy len tlačidlom „Regenerovať“
    articleAutoLoad: false, // true = na stránke článku sa diskusia stiahne a ohodnotí hneď; inak až tlačidlom
    geminiPriceIn: 0, // 0 = cena z tabuľky podľa modelu (USD / 1M tokenov)
    geminiPriceOut: 0,
    topN: 12,
    maxPosts: 1000,
    enableDiscussion: true,
    enableArticle: true,
  };

  function mergeSettings(stored) {
    const s = Object.assign({}, DEFAULT_SETTINGS, stored || {});
    s.weights = Object.assign({}, DEFAULT_SETTINGS.weights, (stored && stored.weights) || {});
    s.thresholds = Object.assign({}, DEFAULT_SETTINGS.thresholds, (stored && stored.thresholds) || {});
    return s;
  }

  const norm = (a, q) => (a[q] && typeof a[q].score === "number" ? a[q].score / 3 : 0);
  const noul = (a, q) => (a[q] && typeof a[q].noul === "number" ? a[q].noul : 0);

  function verdict(answers, settings) {
    const s = settings || DEFAULT_SETTINGS;
    if (!answers) return { quality: null, color: "none", reason: "neohodnotené" };
    const w = s.weights;
    const wsum = w.substance + w.relevance + w.writing || 1;
    const base = (w.substance * norm(answers, "substance") + w.relevance * norm(answers, "relevance") + w.writing * norm(answers, "writing")) / wsum;
    const quality = Math.max(0, Math.min(1, base - s.attackPenalty * noul(answers, "personal_attack") - s.vulgarPenalty * noul(answers, "vulgar")));
    const hate = noul(answers, "group_hate") > s.hateThreshold;
    let color, reason = "";
    if (hate) { color = "hate"; reason = "xenofóbia / hanlivé zovšeobecnenie"; }
    else if (quality < s.thresholds.hidden) { color = "low"; reason = "nízka kvalita"; }
    else if (quality < s.thresholds.red) color = "red";
    else if (quality < s.thresholds.yellow) color = "yellow";
    else color = "green";
    const hidden = (color === "hate" && s.hideHate) || (color === "low" && s.hideLowQuality);
    return { quality, color, reason, hidden };
  }

  const api = { DEFAULT_SETTINGS, mergeSettings, verdict };
  root.SmeAI = Object.assign(root.SmeAI || {}, api);
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
