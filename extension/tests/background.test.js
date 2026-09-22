// Integračný test service workera: background.js beží vo vm kontexte s falošným chrome.* a falošnými API,
// ktoré počítajú volania. Overuje, že sa nič neplatí dvakrát.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const EXT = path.join(__dirname, "..");

const res = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) });

function answersFor(text) {
  const q = Math.min(1, text.length / 60);
  const sc = (v) => ({ type: "score", score: 3 * v, confidence: 0.8, legend: { 0: "x" } });
  const no = (v) => ({ type: "noul", noul: v });
  return {
    sentiment: sc(0.5), relevance: sc(q), substance: sc(q), writing: sc(q),
    personal_attack: no(0), group_hate: no(/HATE/.test(text) ? 0.95 : 0), vulgar: no(0),
    kind: { type: "choice", choice: "argument" }, stance: { type: "choice", choice: "agrees" },
  };
}

function makeEnv(settings) {
  const store = { settings: { typesafeKey: "ts-key", geminiKey: "gm-key", ...settings } };
  const L = { connect: [], message: [] };
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const chrome = {
    storage: { local: {
      async get(keys) {
        if (keys == null) return clone({ ...store });
        const ks = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const o = {};
        for (const k of ks) if (k in store) o[k] = clone(store[k]);
        return o;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) store[k] = clone(v); },
      async remove(keys) { for (const k of [].concat(keys)) delete store[k]; },
    } },
    runtime: {
      onConnect: { addListener: (f) => L.connect.push(f) },
      onMessage: { addListener: (f) => L.message.push(f) },
      onStartup: { addListener() {} }, onInstalled: { addListener() {} },
      openOptionsPage() {},
    },
    action: { onClicked: { addListener() {} } },
  };
  const calls = { ts: 0, gm: 0, tsTexts: [] };
  const fail = {}; // { ts: HTTP status, gm: HTTP status } – simulácia zrušeného kľúča / preťaženia
  const fetch = async (url, init) => {
    if (url.includes("api.typesafe.ai")) {
      calls.ts++;
      if (fail.ts) return res({ detail: "Invalid API key" }, fail.ts);
      const body = JSON.parse(init.body);
      calls.tsTexts.push(body.state.comment);
      await new Promise((r) => setTimeout(r, 5));
      return res({ model: "jev-test", answers: answersFor(body.state.comment), usage: { input_tokens: 1000 } });
    }
    if (url.includes("generativelanguage")) {
      calls.gm++;
      if (fail.gm) return res({ error: { code: fail.gm, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }, fail.gm);
      const prompt = JSON.parse(init.body).contents[0].parts[0].text;
      const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((m) => m[1]);
      const out = { summary: "Zhrnutie", key_points: [{ point: "Bod", post_ids: ids.slice(0, 2) }], agreements: "", disagreements: "" };
      return res({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }], usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 700, thoughtsTokenCount: 100 } });
    }
    throw new Error("neočakávaný fetch " + url);
  };
  const ctx = { chrome, fetch, console, setTimeout, clearTimeout, setInterval, structuredClone, URL };
  ctx.self = ctx;
  ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx, { filename: f }));
  vm.createContext(ctx);
  vm.runInContext("globalThis.self = globalThis;", ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), ctx, { filename: "background.js" });

  function connect() {
    const inbox = [], pl = [];
    L.connect.forEach((f) => f({ name: "smeai", postMessage: (m) => inbox.push(structuredClone(m)), onMessage: { addListener: (f2) => pl.push(f2) } }));
    const port = {
      inbox,
      send: (m) => pl.forEach((f) => f(m)),
      // počká na n-tý (od konca nových) state/summary_error/error
      async next(types = ["state", "error", "summary_error"], from = inbox.length) {
        for (let i = 0; i < 3000; i++) {
          const m = inbox.slice(from).find((x) => types.includes(x.type));
          if (m) return m;
          await new Promise((r) => setTimeout(r, 5));
        }
        throw new Error("timeout, inbox: " + inbox.map((m) => m.type).join(","));
      },
      async request(msg, types) { const from = inbox.length; port.send(msg); return port.next(types, from); },
      async settle() { await new Promise((r) => setTimeout(r, 60)); },
    };
    return port;
  }
  const message = (msg) => new Promise((resolve) => L.message.forEach((f) => f(msg, {}, resolve)));
  return { store, calls, fail, connect, message };
}

const article = { title: "Článok", summary: "Perex" };
let seq = 0;
const post = (text, minute, parentId = null) => ({ id: String(++seq), parentId, depth: parentId ? 1 : 0, createdAt: `2026-09-22T10:${String(minute).padStart(2, "0")}:00Z`, author: "a" + seq, status: "active", text, votesUp: 1, votesDown: 0 });
const longText = (n) => `Dlhý a vecný príspevok číslo ${n} s argumentmi, faktami a skúsenosťou.`;
const analyzeMsg = (topicId, posts, extra = {}) => ({ type: "analyze", mode: "article", topicId, article, posts, remoteTotal: posts.length, ...extra });

test("hodnotenie: každý text najviac raz, náklady, zhrnutie len na požiadanie", async () => {
  const env = makeEnv({ autoSummary: false });
  const posts = [post(longText(1), 1), post(longText(2), 2), post("ok", 3), post(longText(4), 4), post("HATE " + longText(5), 5)];

  // 1. prvá analýza: 5 hodnotení, žiadne Gemini
  const p1 = env.connect();
  const s1 = await p1.request(analyzeMsg("T1", posts));
  assert.equal(s1.type, "state");
  assert.equal(env.calls.ts, 5);
  assert.equal(env.calls.gm, 0);
  assert.equal(s1.summary, null);
  assert.equal(s1.run.tsPosts, 5);
  assert.equal(s1.run.cached, 0);
  assert.ok(Math.abs(s1.run.tsUsd - (5000 / 1e6) * 0.042) < 1e-12);
  assert.equal(s1.costs.tsPosts, 5);
  assert.ok(s1.estUsd > 0);
  const k = Object.keys(env.store).find((x) => x.startsWith("ts:"));
  assert.ok(env.store[k].a && env.store[k].t, "cache má formát {a, t}");
  assert.equal(env.store[k].a.relevance.legend, undefined, "legend sa neukladá");

  // 2. druhá analýza (iný tab) + 2 nové príspevky → hodnotia sa len 2 nové
  const more = [...posts, post(longText(6), 6), post(longText(7), 7)];
  const s2 = await env.connect().request(analyzeMsg("T1", more));
  assert.equal(env.calls.ts, 7);
  assert.equal(s2.run.cached, 5);
  assert.equal(s2.run.tsPosts, 2);
  assert.equal(s2.costs.tsPosts, 7);

  // 3. zhrnutie na požiadanie
  const p3 = env.connect();
  await p3.request(analyzeMsg("T1", more));
  const s3 = await p3.request({ type: "regenerate" }, ["state", "summary_error"]);
  assert.equal(env.calls.gm, 1);
  assert.equal(env.calls.ts, 7, "regenerácia nehodnotí znova");
  assert.equal(s3.summary.data.summary, "Zhrnutie");
  assert.equal(s3.summary.usage.out, 800);
  assert.ok(Math.abs(s3.summary.usd - (2000 * 0.3 + 800 * 2.5) / 1e6) < 1e-12);
  assert.equal(s3.costs.gmRuns, 1);
  assert.ok(!s3.summary.basisIds.includes(posts[4].id), "xenofóbny príspevok nie je v podklade");
  assert.deepEqual(s3.delta, { newPosts: 0, newUseful: 0, wouldEnter: 0 });

  // 4. nové príspevky → zhrnutie sa NEROBÍ samo, ale delta ukáže, čo by pribudlo
  const evenMore = [...more, post(longText(8) + " navyše dlhšie", 8), post("krátke", 9)];
  const s4 = await env.connect().request(analyzeMsg("T1", evenMore));
  assert.equal(env.calls.gm, 1);
  assert.equal(s4.summary.data.summary, "Zhrnutie");
  assert.equal(s4.delta.newPosts, 2);
  assert.equal(s4.delta.newUseful, 1);
  assert.ok(s4.delta.wouldEnter >= 1);

  // 5. peek: len z cache, žiadne API
  const s5 = await env.connect().request({ type: "peek", topicId: "T1" });
  assert.equal(s5.fromCache, true);
  assert.equal(env.calls.ts, 9);
  assert.equal(env.calls.gm, 1);
  assert.equal(s5.postsFull.length, 9);
  assert.equal(s5.snapRemoteTotal, 9);
  assert.equal(s5.summary.data.summary, "Zhrnutie");
  const none = await env.connect().request({ type: "peek", topicId: "NEZNAMA" }, ["nocache", "state"]);
  assert.equal(none.type, "nocache");

  // 6. analyze + summarize:true → nové zhrnutie, bez nového hodnotenia
  const p6 = env.connect();
  const from = p6.inbox.length;
  p6.send(analyzeMsg("T1", evenMore, { summarize: true }));
  await p6.next(["state"], from);
  const s6 = await p6.next(["state"], p6.inbox.findIndex((m, i) => i >= from && m.type === "summary_progress"));
  assert.equal(env.calls.gm, 2);
  assert.equal(env.calls.ts, 9);
  assert.equal(s6.costs.gmRuns, 2);
  assert.deepEqual(s6.delta, { newPosts: 0, newUseful: 0, wouldEnter: 0 });

  // 7. globálne náklady
  const { global: g } = await env.message({ type: "getCosts" });
  assert.equal(g.tsPosts, 9);
  assert.equal(g.gmRuns, 2);
});

test("súbežné analýzy tej istej diskusie nehodnotia príspevok dvakrát", async () => {
  const env = makeEnv({});
  const posts = Array.from({ length: 12 }, (_, i) => post(longText(100 + i), i));
  const [a, b] = await Promise.all([env.connect().request(analyzeMsg("T2", posts)), env.connect().request(analyzeMsg("T2", posts))]);
  assert.equal(env.calls.ts, 12);
  assert.equal(a.run.tsPosts + b.run.tsPosts, 12);
  assert.equal(new Set(env.calls.tsTexts).size, 12);
  assert.equal(b.costs.tsPosts, 12);
});

test("autoSummary: prvé zhrnutie samo, ďalšie už nie; súbežne len jedno", async () => {
  const env = makeEnv({ autoSummary: true });
  const posts = Array.from({ length: 4 }, (_, i) => post(longText(200 + i), i));
  const p1 = env.connect(), p2 = env.connect();
  p1.send(analyzeMsg("T3", posts));
  p2.send(analyzeMsg("T3", posts));
  for (const p of [p1, p2]) {
    for (let i = 0; i < 200 && !p.inbox.some((m) => m.type === "state" && m.summary); i++) await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(env.calls.gm, 1);
  await env.connect().request(analyzeMsg("T3", posts));
  const p3 = env.connect();
  await p3.request(analyzeMsg("T3", posts));
  await p3.settle();
  assert.equal(env.calls.gm, 1, "pri ďalšej návšteve sa zhrnutie negeneruje");
});

test("prečítané, chýbajúce kľúče a mazanie cache", async () => {
  const env = makeEnv({});
  const posts = [post(longText(300), 1), post(longText(301), 2)];
  await env.connect().request(analyzeMsg("T4", posts));
  const r = await env.message({ type: "markRead", topicId: "T4", ids: [posts[0].id] });
  assert.equal(r.count, 1);
  await env.message({ type: "markRead", topicId: "T4", ids: [posts[0].id, posts[1].id] });
  const s = await env.connect().request(analyzeMsg("T4", posts));
  assert.deepEqual(s.readIds.sort(), [posts[0].id, posts[1].id].sort());
  const peeked = await env.connect().request({ type: "peek", topicId: "T4" });
  assert.equal(peeked.readIds.length, 2);

  const cleared = await env.message({ type: "clearCache" });
  assert.ok(cleared.removed >= 4);
  assert.ok(env.store.settings && env.store["read:T4"], "nastavenia a prečítané zostávajú");
  assert.ok(!Object.keys(env.store).some((k) => /^(ts|topic|snap):/.test(k)));
  await env.message({ type: "clearRead" });
  assert.ok(!env.store["read:T4"]);

  const noKey = makeEnv({ typesafeKey: "" });
  const e = await noKey.connect().request(analyzeMsg("T5", posts));
  assert.equal(e.type, "error");
  assert.equal(e.code, "nokey");
  const noGm = makeEnv({ geminiKey: "" });
  const pg = noGm.connect();
  await pg.request(analyzeMsg("T6", posts));
  const se = await pg.request({ type: "regenerate" }, ["summary_error", "state"]);
  assert.equal(se.code, "nokey");
  assert.equal(noGm.calls.gm, 0);
});

test("zrušené kľúče: zrozumiteľné chyby, čiastočné výsledky z cache, nič sa neuloží ani nezaplatí", async () => {
  const env = makeEnv({});
  const posts = [post(longText(400), 1), post(longText(401), 2), post(longText(402), 3)];
  const ok = await env.connect().request(analyzeMsg("T7", posts));
  assert.equal(ok.failure, null);

  // TypeSafe kľúč zrušený: staré príspevky z cache, nové zlyhajú → state s failure badkey
  env.fail.ts = 401;
  const more = [...posts, post(longText(403), 4), post(longText(404), 5)];
  const partial = await env.connect().request(analyzeMsg("T7", more));
  assert.equal(partial.type, "state");
  assert.equal(partial.failure.code, "badkey");
  assert.equal(partial.failure.failed, 2);
  assert.match(partial.failure.message, /odmietol API kľúč/);
  assert.equal(partial.stats.scored, 3, "3 z cache ostanú ohodnotené");
  assert.equal(partial.posts.filter((p) => !p.answers).length, 2);
  assert.equal(partial.run.tsPosts, 0);
  assert.equal(partial.costs.tsPosts, 3, "neúspešné volania sa neúčtujú");
  const tsCalls = env.calls.ts;

  // úplne nová diskusia so zrušeným kľúčom → error badkey (1 request, potom stop)
  const bad = await env.connect().request(analyzeMsg("T8", [post(longText(500), 1), post(longText(501), 2)]));
  assert.equal(bad.type, "error");
  assert.equal(bad.code, "badkey");
  assert.ok(env.calls.ts - tsCalls <= 2);

  // preťaženie (429) → code busy, bez nekonečného opakovania
  env.fail.ts = 429;
  const busy = await env.connect().request(analyzeMsg("T9", [post(longText(600), 1)]));
  assert.equal(busy.code, "busy");

  // kľúč opravený → „Skúsiť znova“ dohodnotí len chýbajúce
  env.fail.ts = 0;
  const before = env.calls.ts;
  const fixed = await env.connect().request(analyzeMsg("T7", more));
  assert.equal(fixed.failure, null);
  assert.equal(env.calls.ts - before, 2);
  assert.equal(fixed.stats.scored, 5);

  // Gemini kľúč zrušený: existujúce zhrnutie zostane, chyba badkey, nič sa nezaúčtuje
  const p = env.connect();
  await p.request(analyzeMsg("T7", more));
  const s1 = await p.request({ type: "regenerate" }, ["state", "summary_error"]);
  assert.ok(s1.summary);
  env.fail.gm = 400;
  const gerr = await p.request({ type: "regenerate" }, ["state", "summary_error"]);
  assert.equal(gerr.type, "summary_error");
  assert.equal(gerr.code, "badkey");
  assert.match(gerr.message, /Gemini odmietol API kľúč/);
  assert.equal(env.store["topic:T7"].summary.data.summary, "Zhrnutie", "staré zhrnutie ostalo");
  assert.equal(env.store["topic:T7"].costs.gmRuns, 1);
  env.fail.gm = 404;
  const nomodel = await p.request({ type: "regenerate" }, ["state", "summary_error"]);
  assert.equal(nomodel.code, "model");
});
