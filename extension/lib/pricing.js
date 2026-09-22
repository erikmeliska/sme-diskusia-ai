// Ceny a výpočet nákladov. Ceny sú USD za 1M tokenov (TypeSafe účtuje len vstup).
(function (root) {
  const TYPESAFE_PER_M = 0.042;
  // [vstup, výstup] – Standard tier, september 2026 (ai.google.dev/gemini-api/docs/pricing)
  const GEMINI_PRICES = {
    "gemini-3.5-flash-lite": [0.3, 2.5],
    "gemini-3.1-flash-lite": [0.25, 1.5],
    "gemini-2.5-flash-lite": [0.1, 0.4],
  };
  const DEFAULT_GEMINI_PRICE = [0.3, 2.5];
  const EST_OUTPUT_TOKENS = 900; // typická dĺžka JSON zhrnutia
  const EST_CHARS_PER_TOKEN = 3.3; // slovenský text, kým nie je kalibrácia z reálneho volania

  function geminiPrice(model, settings) {
    const s = settings || {};
    if (s.geminiPriceIn > 0 && s.geminiPriceOut > 0) return [s.geminiPriceIn, s.geminiPriceOut];
    return GEMINI_PRICES[model] || DEFAULT_GEMINI_PRICE;
  }

  const typesafeUsd = (tokens) => (tokens / 1e6) * TYPESAFE_PER_M;

  // usage z Gemini usageMetadata; výstup = kandidáti + premýšľanie
  function geminiUsage(meta) {
    const m = meta || {};
    return { in: m.promptTokenCount || 0, out: (m.candidatesTokenCount || 0) + (m.thoughtsTokenCount || 0) };
  }
  const geminiUsd = (usage, price) => (usage.in / 1e6) * price[0] + (usage.out / 1e6) * price[1];

  // odhad ceny ďalšieho zhrnutia; charsPerToken sa kalibruje z posledného volania
  function estimateGeminiUsd(promptChars, price, charsPerToken) {
    const tin = Math.ceil(promptChars / (charsPerToken || EST_CHARS_PER_TOKEN));
    return geminiUsd({ in: tin, out: EST_OUTPUT_TOKENS }, price);
  }

  const emptyCosts = () => ({ tsTokens: 0, tsUsd: 0, tsPosts: 0, gmIn: 0, gmOut: 0, gmUsd: 0, gmRuns: 0 });
  function addCosts(acc, d) {
    const out = Object.assign(emptyCosts(), acc || {});
    for (const k of Object.keys(d || {})) out[k] = (out[k] || 0) + d[k];
    return out;
  }

  const api = { TYPESAFE_PER_M, GEMINI_PRICES, geminiPrice, typesafeUsd, geminiUsage, geminiUsd, estimateGeminiUsd, emptyCosts, addCosts };
  root.SmeAI = Object.assign(root.SmeAI || {}, api);
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
