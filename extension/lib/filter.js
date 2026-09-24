// Filter diskusie podľa kategórií (kvalita, typ, postoj, príznaky) so zachovaním hierarchie.
// Čistá logika bez DOM – content script z nej len aplikuje triedy.
//
// Filter: { color: [...], kind: [...], stance: [...], flag: [...] }
//   v rámci kategórie ALEBO, medzi kategóriami A ZÁROVEŇ.
// Uzol stromu: { key, children: [uzly] } v poradí dokumentu.
// Výsledok planFilter: každý uzol je "match" (zhoda), "context" (predok zhody – ukáže sa skrátene)
// alebo "hidden"; susedné skryté uzly na jednej úrovni tvoria jednu skupinu (run) s jedným riadkom „N skrytých“.
(function (root) {
  const DIMS = ["color", "kind", "stance", "flag"];
  const FLAG_TESTS = {
    attack: (a) => a.personal_attack && a.personal_attack.noul > 0.5,
    vulgar: (a) => a.vulgar && a.vulgar.noul > 0.5,
  };

  const emptyFilter = () => ({ color: [], kind: [], stance: [], flag: [] });
  const isActive = (f) => !!f && DIMS.some((d) => f[d] && f[d].length);
  const has = (f, dim, val) => !!f && (f[dim] || []).includes(val);

  function toggle(f, dim, val) {
    const out = { ...emptyFilter(), ...f };
    out[dim] = has(f, dim, val) ? out[dim].filter((v) => v !== val) : [...(out[dim] || []), val];
    return out;
  }

  function flagsOf(answers) {
    return answers ? Object.keys(FLAG_TESTS).filter((k) => FLAG_TESTS[k](answers)) : [];
  }

  // entry: { answers, verdict } (z pohľadu service workera) alebo undefined (neohodnotený/moderovaný)
  function matches(entry, f) {
    if (!isActive(f)) return true;
    const a = entry && entry.answers;
    const v = entry && entry.verdict;
    for (const dim of DIMS) {
      const want = f[dim];
      if (!want || !want.length) continue;
      if (dim === "color") { if (!v || !want.includes(v.color)) return false; }
      else if (dim === "flag") { const fl = flagsOf(a); if (!want.some((w) => fl.includes(w))) return false; }
      else { const c = a && a[dim] && a[dim].choice; if (!c || !want.includes(c)) return false; }
    }
    return true;
  }

  function planFilter(roots, isMatch) {
    const state = new Map();
    const size = new Map();
    const hasMatch = new Map();
    // post-order: veľkosť podstromu a či obsahuje zhodu
    const visit = (n) => {
      let s = 1, h = !!isMatch(n);
      for (const c of n.children || []) { visit(c); s += size.get(c.key); h = h || hasMatch.get(c.key); }
      size.set(n.key, s);
      hasMatch.set(n.key, h);
    };
    roots.forEach(visit);

    const runs = [];
    let matched = 0, hidden = 0;
    const walk = (siblings) => {
      let run = null;
      for (const n of siblings) {
        if (!hasMatch.get(n.key)) {
          state.set(n.key, "hidden");
          if (!run) runs.push((run = { keys: [], count: 0 }));
          run.keys.push(n.key);
          run.count += size.get(n.key);
          hidden += size.get(n.key);
          continue; // celý podstrom je v skupine
        }
        run = null;
        if (isMatch(n)) { state.set(n.key, "match"); matched++; } else state.set(n.key, "context");
        walk(n.children || []);
      }
    };
    walk(roots);
    const context = [...state.values()].filter((s) => s === "context").length;
    return { state, runs, matched, hidden, context };
  }

  // #smeai-filter=color:green,kind:argument
  function encodeFilter(f) {
    return DIMS.flatMap((d) => (f[d] || []).map((v) => `${d}:${v}`)).join(",");
  }
  function decodeFilter(str) {
    const f = emptyFilter();
    for (const part of String(str || "").split(",")) {
      const [d, v] = part.split(":");
      if (DIMS.includes(d) && v && /^[a-z_]+$/.test(v) && !f[d].includes(v)) f[d].push(v);
    }
    return f;
  }

  const api = { FILTER_DIMS: DIMS, emptyFilter, isActive, hasFilter: has, toggleFilter: toggle, flagsOf, matchesFilter: matches, planFilter, encodeFilter, decodeFilter };
  root.SmeAI = Object.assign(root.SmeAI || {}, api);
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
