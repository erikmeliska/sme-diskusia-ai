// Service worker: kľúče žijú len tu. Cachuje hodnotenia príspevkov, zhrnutia, snímky tém, prečítané a náklady.
//
// chrome.storage.local:
//   settings                     nastavenia (vrátane kľúčov)
//   ts:<ver>:<postId>:<hash>     { a: odpovede TypeSafe, t }            – každý text sa hodnotí najviac raz
//   topic:<topicId>              { title, lastSeen, summary, costs }     – zhrnutie sa robí len raz, ďalej len na požiadanie
//   snap:<topicId>               { article, posts, at }                  – posledná snímka príspevkov
//   read:<topicId>               { ids: { postId: čas }, lastSeen }      – prečítané príspevky
//   costs:global                 súčet nákladov
importScripts("lib/text.js", "lib/typesafe.js", "lib/policy.js", "lib/stats.js", "lib/gemini.js", "lib/pricing.js");
const S = self.SmeAI;

const RETENTION_MS = 90 * 24 * 3600 * 1000;
const inflight = new Map(); // ts-kľúč -> Promise (zdieľané medzi tabmi)
const summarizing = new Map(); // topicId -> Promise (jedno zhrnutie naraz)

// ---------- storage ----------
const get = async (k) => (await chrome.storage.local.get(k))[k];
const set = (k, v) => chrome.storage.local.set({ [k]: v });
const cache = { getMany: (keys) => (keys.length ? chrome.storage.local.get(keys) : Promise.resolve({})), set };

// sériové read-modify-write pre jeden kľúč (viac tabov naraz)
const locks = new Map();
function update(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).then(async () => {
    const next = await fn(await get(key));
    await set(key, next);
    return next;
  });
  locks.set(key, run.catch(() => {}));
  return run;
}

async function loadSettings() {
  return S.mergeSettings(await get("settings"));
}
function publicSettings(s) {
  const { typesafeKey, geminiKey, ...rest } = s;
  return { ...rest, hasTypesafeKey: !!typesafeKey, hasGeminiKey: !!geminiKey };
}

// ---------- pohľad (všetko, čo content script vykresľuje) ----------
function buildView(ctx, settings, topic) {
  const enriched = ctx.posts.map((p) => {
    const answers = ctx.answers.get(p.id);
    return { ...p, answers, verdict: S.verdict(answers, settings) };
  });
  const stats = S.computeStats(enriched);
  const top = S.topPosts(enriched, settings.topN);
  const price = S.geminiPrice(settings.geminiModel, settings);
  const summary = topic && topic.summary;
  const estUsd = top.length >= 2 ? S.estimateGeminiUsd(S.buildPrompt(ctx.article, top, stats).length, price, summary && summary.charsPerToken) : 0;
  Object.assign(ctx, { enriched, stats, top });
  return {
    type: "state",
    settings: publicSettings(settings),
    stats,
    posts: enriched.map((p) => ({ id: p.id, answers: p.answers || null, verdict: p.verdict })),
    topIds: top.map((p) => p.id),
    summary: summary || null,
    delta: S.summaryDelta(enriched, summary, top),
    estUsd,
    costs: (topic && topic.costs) || S.emptyCosts(),
  };
}

async function recordCosts(topicId, delta, patch) {
  const topic = await update(`topic:${topicId}`, (t) => ({
    summary: null, ...(t || {}), ...(patch || {}), lastSeen: Date.now(), costs: S.addCosts(t && t.costs, delta),
  }));
  await update("costs:global", (c) => S.addCosts(c, delta));
  return topic;
}

// ---------- zrozumiteľné chyby ----------
function typesafeFailure(errors) {
  if (!errors.length) return null;
  const auth = errors.find((e) => e.status === 401 || e.status === 403);
  if (auth) return { code: "badkey", failed: errors.length, message: `TypeSafe odmietol API kľúč (HTTP ${auth.status}) – je neplatný alebo zrušený. Oprav ho v nastaveniach.` };
  const rate = errors.find((e) => e.status === 429 || e.status === 529);
  if (rate) return { code: "busy", failed: errors.length, message: `TypeSafe je preťažený alebo sa minul limit (HTTP ${rate.status}). Skús to o chvíľu znova.` };
  return { code: "typesafe", failed: errors.length, message: `Hodnotenie zlyhalo: ${errors[0].error.slice(0, 160)}` };
}
function geminiFailure(e) {
  if (e.keyInvalid) return { code: "badkey", message: `Gemini odmietol API kľúč (HTTP ${e.status}) – je neplatný alebo zrušený. Oprav ho v nastaveniach.` };
  if (e.status === 429) return { code: "busy", message: "Gemini: minul sa limit požiadaviek (HTTP 429). Skús to neskôr." };
  if (e.status === 404) return { code: "model", message: "Gemini model neexistuje alebo nie je dostupný – skontroluj názov modelu v nastaveniach." };
  return { code: "gemini", message: `Zhrnutie zlyhalo: ${String(e.message || e).slice(0, 200)}` };
}

// ---------- analýza ----------
async function analyze(ctx, send, msg) {
  const settings = await loadSettings();
  if (!settings.typesafeKey) return send({ type: "error", code: "nokey", message: "Chýba TypeSafe API kľúč – doplň ho v nastaveniach rozšírenia." });

  Object.assign(ctx, { topicId: msg.topicId, article: msg.article, posts: msg.posts.slice(0, settings.maxPosts) });
  await set(`snap:${ctx.topicId}`, { article: ctx.article, posts: ctx.posts, at: Date.now(), remoteTotal: msg.remoteTotal ?? null });

  const t0 = Date.now();
  const r = await S.scoreAll(fetch, settings.typesafeKey, ctx.article, ctx.posts, {
    cache, inflight, onProgress: (done, total) => send({ type: "progress", phase: "score", done, total }),
  });
  const fail = typesafeFailure(r.errors);
  if (r.results.size === 0 && fail) return send({ type: "error", ...fail });
  ctx.answers = r.results;

  const run = { tsTokens: r.tokens, tsUsd: S.typesafeUsd(r.tokens), tsPosts: r.scoredNew };
  const topic = await recordCosts(ctx.topicId, run, { title: ctx.article.title });
  const read = (await get(`read:${ctx.topicId}`)) || { ids: {} };
  const view = buildView(ctx, settings, topic);
  // čiastočné zlyhanie: z cache sa zobrazí, čo sa dá; UI ukáže upozornenie a „Skúsiť znova“
  send({ ...view, run: { ...run, cached: r.cached, errors: r.errors.length, seconds: (Date.now() - t0) / 1000 }, failure: fail, readIds: Object.keys(read.ids) });

  if (msg.summarize) await generateSummary(ctx, send);
  else if (!topic.summary && settings.autoSummary) await generateSummary(ctx, send, { auto: true });
}

// Pohľad len z cache (žiadne volanie TypeSafe ani Gemini): posledná snímka + uložené hodnotenia + zhrnutie.
async function peek(ctx, send, msg) {
  const [settings, topic, snap, read] = await Promise.all([loadSettings(), get(`topic:${msg.topicId}`), get(`snap:${msg.topicId}`), get(`read:${msg.topicId}`)]);
  if (!snap) return send({ type: "nocache" });
  const hits = await cache.getMany(snap.posts.map(S.cacheKey));
  const answers = new Map();
  for (const p of snap.posts) {
    const v = hits[S.cacheKey(p)];
    if (v) answers.set(p.id, v.a || v);
  }
  Object.assign(ctx, { topicId: msg.topicId, article: snap.article, posts: snap.posts, answers });
  send({ ...buildView(ctx, settings, topic), fromCache: true, snapAt: snap.at, snapRemoteTotal: snap.remoteTotal ?? null, postsFull: snap.posts, readIds: Object.keys((read && read.ids) || {}) });
}

async function generateSummary(ctx, send, { auto = false } = {}) {
  const settings = await loadSettings();
  if (!settings.geminiKey) return send({ type: "summary_error", code: "nokey", message: "Pre AI zhrnutie doplň Gemini API kľúč v nastaveniach." });
  if (!ctx.top || ctx.top.length < 2) return send({ type: "summary_error", code: "few", message: "Príliš málo hodnotných príspevkov na zhrnutie." });

  if (summarizing.has(ctx.topicId)) await summarizing.get(ctx.topicId).catch(() => {});
  else {
    // pri automatickom spustení nerob nič, ak medzitým zhrnutie vzniklo v inom tabe
    const existing = await get(`topic:${ctx.topicId}`);
    if (auto && existing && existing.summary) return send(buildView(ctx, settings, existing));
    const job = (async () => {
      send({ type: "summary_progress" });
      const price = S.geminiPrice(settings.geminiModel, settings);
      const promptChars = S.buildPrompt(ctx.article, ctx.top, ctx.stats).length;
      const out = await S.summarize(fetch, settings.geminiKey, settings.geminiModel, ctx.article, ctx.top, ctx.stats);
      const usage = S.geminiUsage(out.usage);
      const usd = S.geminiUsd(usage, price);
      const lastPostAt = ctx.posts.reduce((m, p) => (p.createdAt && p.createdAt > m ? p.createdAt : m), "");
      const summary = {
        data: { summary: out.summary, key_points: out.key_points, agreements: out.agreements, disagreements: out.disagreements },
        basisIds: ctx.top.map((p) => p.id), lastPostAt, at: new Date().toISOString(), model: settings.geminiModel,
        usage, usd, postCount: ctx.stats.active, charsPerToken: usage.in ? promptChars / usage.in : null,
      };
      await recordCosts(ctx.topicId, { gmIn: usage.in, gmOut: usage.out, gmUsd: usd, gmRuns: 1 }, { summary });
    })();
    summarizing.set(ctx.topicId, job);
    try { await job; } catch (e) {
      return send({ type: "summary_error", ...geminiFailure(e) });
    } finally { summarizing.delete(ctx.topicId); }
  }
  send(buildView(ctx, await loadSettings(), await get(`topic:${ctx.topicId}`)));
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "smeai") return;
  const ctx = {};
  const send = (m) => { try { port.postMessage(m); } catch (_) { /* tab zatvorený */ } };
  const fail = (e) => send({ type: "error", code: "internal", message: String(e.message || e) });
  port.onMessage.addListener((msg) => {
    if (msg.type === "analyze") analyze(ctx, send, msg).catch(fail);
    if (msg.type === "peek") peek(ctx, send, msg).catch(fail);
    if (msg.type === "regenerate" && ctx.answers) generateSummary(ctx, send).catch(fail);
  });
});

// ---------- jednorazové správy ----------
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

const HANDLERS = {
  openOptions: () => { chrome.runtime.openOptionsPage(); },
  getSettings: async () => publicSettings(await loadSettings()),
  markRead: async ({ topicId, ids }) => {
    const now = Date.now();
    const r = await update(`read:${topicId}`, (v) => {
      const out = { ids: { ...((v && v.ids) || {}) }, lastSeen: now };
      for (const id of ids) if (!out.ids[id]) out.ids[id] = now;
      return out;
    });
    return { count: Object.keys(r.ids).length };
  },
  getCosts: async () => ({ global: (await get("costs:global")) || S.emptyCosts() }),
  resetCosts: async () => { await set("costs:global", S.emptyCosts()); return { ok: true }; },
  clearCache: () => removeWhere((k) => /^(ts|gm|topic|snap):/.test(k)),
  clearRead: () => removeWhere((k) => k.startsWith("read:")),
  testKeys: () => testKeys(),
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const h = HANDLERS[msg.type];
  if (!h) return;
  Promise.resolve(h(msg)).then(reply, (e) => reply({ error: String(e.message || e) }));
  return true;
});

async function removeWhere(pred) {
  const keys = Object.keys(await chrome.storage.local.get(null)).filter(pred);
  await chrome.storage.local.remove(keys);
  return { removed: keys.length };
}

// ---------- údržba: záznamy staršie ako 90 dní ----------
async function evictOld() {
  const all = await chrome.storage.local.get(null);
  const cutoff = Date.now() - RETENTION_MS;
  const old = Object.entries(all).filter(([k, v]) => {
    if (!v || typeof v !== "object") return false;
    if (k.startsWith("ts:")) return (v.t || 0) < cutoff;
    if (/^(topic|read):/.test(k)) return (v.lastSeen || 0) < cutoff;
    if (k.startsWith("snap:")) return (v.at || 0) < cutoff;
    return k.startsWith("gm:"); // starý formát zhrnutí z v0.1
  }).map(([k]) => k);
  if (old.length) await chrome.storage.local.remove(old);
}
chrome.runtime.onStartup.addListener(() => evictOld());
chrome.runtime.onInstalled.addListener(() => evictOld());

async function testKeys() {
  const s = await loadSettings();
  const out = {};
  if (s.typesafeKey) {
    try {
      const r = await fetch(S.TYPESAFE_API, {
        method: "POST",
        headers: { Authorization: `Bearer ${s.typesafeKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "jev-latest", state: "Test", questions: { ok: { type: "noul", instructions: "Is this a test?" } } }),
      });
      out.typesafe = r.ok ? "OK" : `HTTP ${r.status}`;
    } catch (e) { out.typesafe = String(e.message || e); }
  } else out.typesafe = "chýba";
  if (s.geminiKey) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.geminiModel)}`, { headers: { "x-goog-api-key": s.geminiKey } });
      out.gemini = r.ok ? `OK (${s.geminiModel})` : `HTTP ${r.status} – ${(await r.text()).slice(0, 120)}`;
    } catch (e) { out.gemini = String(e.message || e); }
  } else out.gemini = "chýba";
  return out;
}
