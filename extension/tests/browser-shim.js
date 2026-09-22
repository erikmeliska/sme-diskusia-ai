// Shim pre test v živom tabe bez nainštalovaného rozšírenia (napr. Playwright addScriptTag).
// V stránke beží SKUTOČNÝ background.js; falošné sú len chrome.* (storage v localStorage → prežije reload)
// a externé AI API (TypeSafe/Gemini) – do stránky sa tak nedostanú žiadne kľúče. Fórum sme.sk je skutočné.
// Počty volaní: window.__mockCalls = { ts, gm }.
(() => {
  const LS_KEY = "__smeai_test_store";
  const load = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } };
  const save = (s) => localStorage.setItem(LS_KEY, JSON.stringify(s));
  const store = load();
  store.settings = Object.assign({ typesafeKey: "test", geminiKey: "test" }, store.settings, window.__smeaiTestSettings || {});
  save(store);

  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const storage = { local: {
    async get(keys) {
      const s = load();
      if (keys == null) return clone(s);
      const ks = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const o = {};
      for (const k of ks) if (k in s) o[k] = clone(s[k]);
      return o;
    },
    async set(obj) { const s = load(); Object.assign(s, clone(obj)); save(s); },
    async remove(keys) { const s = load(); for (const k of [].concat(keys)) delete s[k]; save(s); },
  } };

  // ---- falošné AI API ----
  const calls = (window.__mockCalls = { ts: 0, gm: 0 });
  const { hash } = globalThis.SmeAI;
  const HATE = /bazmek|pakist|palist|tadžik|scum|kraplak|cigán/i;
  function tsAnswers(text) {
    const h = parseInt(hash(text).slice(0, 4), 16) / 65535;
    const q = Math.min(1, 0.3 * h + 0.75 * Math.min(1, text.length / 450));
    const sc = (v) => ({ type: "score", score: 3 * v, confidence: 0.8 });
    const no = (v) => ({ type: "noul", noul: v });
    const kinds = ["argument", "experience", "proposal", "question", "humor", "rant"];
    return {
      sentiment: sc(h), relevance: sc(Math.min(1, q + 0.1)), substance: sc(q), writing: sc(Math.min(1, 0.4 + q / 2)),
      personal_attack: no(/\b(pako|socka|debil|idiot)/i.test(text) ? 0.85 : 0.05), group_hate: no(HATE.test(text) ? 0.9 : 0.02), vulgar: no(0.03),
      kind: { type: "choice", choice: kinds[Math.floor(h * kinds.length)] }, stance: { type: "choice", choice: ["agrees", "disputes", "nuance", "none"][Math.floor(h * 97) % 4] },
    };
  }
  const respond = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
  async function bgFetch(url, init) {
    if (String(url).includes("api.typesafe.ai")) {
      calls.ts++;
      const body = JSON.parse(init.body);
      await new Promise((r) => setTimeout(r, 15));
      return respond({ model: "jev-mock", answers: tsAnswers(body.state.comment), usage: { input_tokens: 1750 } });
    }
    if (String(url).includes("generativelanguage")) {
      calls.gm++;
      const prompt = JSON.parse(init.body).contents[0].parts[0].text;
      const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((m) => m[1]);
      await new Promise((r) => setTimeout(r, 200));
      return respond({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        summary: `[MOCK #${calls.gm}] Falošné zhrnutie z ${ids.length} príspevkov – overuje sa tok, cache a vykreslenie.`,
        key_points: [{ point: "Prvý bod.", post_ids: ids.slice(0, 2) }, { point: "Druhý bod.", post_ids: ids.slice(2, 3) }],
        agreements: "Testovacia zhoda.", disagreements: "Testovací spor.",
      }) }] } }], usageMetadata: { promptTokenCount: Math.round(prompt.length / 3.3), candidatesTokenCount: 700, thoughtsTokenCount: 0 } });
    }
    return fetch(url, init);
  }

  // ---- chrome.runtime most content ↔ background ----
  const L = { connect: [], message: [] };
  const later = (f) => setTimeout(f, 0);
  const bgChrome = {
    storage,
    runtime: {
      onConnect: { addListener: (f) => L.connect.push(f) },
      onMessage: { addListener: (f) => L.message.push(f) },
      onStartup: { addListener() {} }, onInstalled: { addListener() {} },
      openOptionsPage: () => console.log("[shim] openOptionsPage"),
    },
    action: { onClicked: { addListener() {} } },
  };
  const runtime = {
    lastError: undefined,
    connect({ name }) {
      const toContent = [], toBg = [];
      const bgPort = { name, postMessage: (m) => later(() => toContent.forEach((f) => f(clone(m)))), onMessage: { addListener: (f) => toBg.push(f) }, onDisconnect: { addListener() {} } };
      L.connect.forEach((f) => f(bgPort));
      return { name, postMessage: (m) => later(() => toBg.forEach((f) => f(clone(m)))), onMessage: { addListener: (f) => toContent.push(f) }, onDisconnect: { addListener() {} } };
    },
    sendMessage(msg, cb) {
      const p = new Promise((resolve) => later(() => L.message.forEach((f) => f(clone(msg), {}, resolve))));
      if (cb) p.then(cb);
      return p;
    },
  };
  window.chrome = window.chrome || {};
  Object.defineProperty(window.chrome, "runtime", { value: runtime, configurable: true });
  Object.assign(window, { __bgChrome: bgChrome, __bgFetch: bgFetch });
})();
