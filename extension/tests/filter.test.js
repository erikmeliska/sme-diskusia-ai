const test = require("node:test");
const assert = require("node:assert/strict");
const { emptyFilter, isActive, toggleFilter, matchesFilter, planFilter, encodeFilter, decodeFilter, flagsOf } = require("../lib/filter.js");

const entry = (color, kind, stance, { attack = 0, vulgar = 0 } = {}) => ({
  verdict: { color },
  answers: { kind: { choice: kind }, stance: { choice: stance }, personal_attack: { noul: attack }, vulgar: { noul: vulgar } },
});

test("toggle, isActive, hash", () => {
  let f = emptyFilter();
  assert.equal(isActive(f), false);
  f = toggleFilter(f, "kind", "argument");
  f = toggleFilter(f, "color", "green");
  assert.equal(isActive(f), true);
  assert.equal(encodeFilter(f), "color:green,kind:argument");
  assert.deepEqual(decodeFilter("color:green,kind:argument,zlé:x,kind:<script>,flag:attack"), { color: ["green"], kind: ["argument"], stance: [], flag: ["attack"] });
  f = toggleFilter(f, "kind", "argument");
  assert.deepEqual(f.kind, []);
});

test("matches: ALEBO v kategórii, A ZÁROVEŇ medzi kategóriami, príznaky, neohodnotené", () => {
  const e = entry("green", "argument", "agrees", { attack: 0.9 });
  assert.equal(matchesFilter(e, emptyFilter()), true);
  assert.equal(matchesFilter(e, { ...emptyFilter(), kind: ["proposal", "argument"] }), true);
  assert.equal(matchesFilter(e, { ...emptyFilter(), kind: ["argument"], color: ["red"] }), false);
  assert.equal(matchesFilter(e, { ...emptyFilter(), kind: ["argument"], color: ["green"] }), true);
  assert.equal(matchesFilter(e, { ...emptyFilter(), flag: ["attack"] }), true);
  assert.equal(matchesFilter(e, { ...emptyFilter(), flag: ["vulgar"] }), false);
  assert.equal(matchesFilter(undefined, { ...emptyFilter(), kind: ["argument"] }), false);
  assert.equal(matchesFilter({ verdict: { color: "none" }, answers: null }, { ...emptyFilter(), color: ["none"] }), true);
  assert.deepEqual(flagsOf(e.answers), ["attack"]);
});

test("planFilter: zhoda, kontext predkov, zlúčené skupiny skrytých", () => {
  // strom:  A(m) ─ A1 ─ A1a        B ─ B1(m)        C   D ─ D1   E(m)   F   G
  //                A2
  const n = (key, ...children) => ({ key, children });
  const roots = [n("A", n("A1", n("A1a")), n("A2")), n("B", n("B1")), n("C"), n("D", n("D1")), n("E"), n("F"), n("G")];
  const M = new Set(["A", "B1", "E"]);
  const p = planFilter(roots, (x) => M.has(x.key));
  const st = Object.fromEntries(p.state);
  assert.equal(st.A, "match");
  assert.equal(st.B, "context", "predok zhody je kontext");
  assert.equal(st.B1, "match");
  assert.equal(st.E, "match");
  assert.equal(st.C, "hidden");
  assert.equal(st.A1a, undefined, "vnútro skrytého podstromu sa neoznačuje – skrýva sa celé");
  // skupiny: [A1, A2] pod A, [C, D] medzi B a E (spolu 3 príspevky), [F, G] na konci
  assert.deepEqual(p.runs.map((r) => [r.keys.join("+"), r.count]), [["A1+A2", 3], ["C+D", 3], ["F+G", 2]]);
  assert.equal(p.matched, 3);
  assert.equal(p.context, 1);
  assert.equal(p.hidden, 8);
  assert.equal(p.matched + p.context + p.hidden, 12, "každý príspevok je započítaný práve raz");
});

test("planFilter: nič nezodpovedá → jedna skupina so všetkým", () => {
  const roots = Array.from({ length: 50 }, (_, i) => ({ key: "r" + i, children: [{ key: "c" + i, children: [] }] }));
  const p = planFilter(roots, () => false);
  assert.equal(p.runs.length, 1);
  assert.equal(p.runs[0].count, 100);
});
