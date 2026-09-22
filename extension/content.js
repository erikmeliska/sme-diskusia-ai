// Content script pre *.sme.sk.
// Článok (/c/)  → rozbaľovací blok „AI prehľad diskusie“ pod nadpisom; bez kliknutia len stav z cache (zadarmo).
// Diskusia (/d/) → ten istý blok hore + farebné označenie príspevkov, skrývanie nevhodných a prečítaných.
(() => {
  if (window.__smeaiLoaded) return;
  window.__smeaiLoaded = true;

  const { fetchTopic, fetchAllPosts, readPlan } = globalThis.SmeAI;
  const topicEl = document.querySelector("[data-topic-id]");
  if (!topicEl || !topicEl.dataset.topicId) return;

  const topicId = topicEl.dataset.topicId;
  const forumBase = topicEl.dataset.forumBaseUrl || "https://core-forum.sme.sk";
  const mode = /\/d\//.test(location.pathname) ? "discussion" : "article";

  const KIND = { experience: "skúsenosť", argument: "argument", proposal: "návrh", question: "otázka", humor: "humor", attack: "útok", rant: "ventilovanie", other: "iné" };
  const STANCE = { agrees: "súhlasí s článkom", disputes: "spochybňuje článok", nuance: "dopĺňa kontext", none: "bez postoja" };
  const COLOR_LABEL = { green: "hodnotné", yellow: "priemerné", red: "slabé", low: "bez prínosu", hate: "xenofóbia", none: "neohodnotené" };

  // ---------- pomocné ----------
  const el = (tag, attrs = {}, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat(Infinity)) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  };
  const pct = (a, b) => (b ? Math.round((100 * a) / b) + " %" : "–");
  const usd = (v) => "$" + (v >= 0.01 ? v.toFixed(3) : v.toFixed(4));
  const estTypesafe = (nPosts) => (nPosts * 1750 * 0.042) / 1e6; // ~1 750 vstupných tokenov na príspevok (namerané)
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString("sk-SK", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
  const ago = (iso) => {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return m < 60 ? `pred ${m} min` : m < 1440 ? `pred ${Math.round(m / 60)} h` : `pred ${Math.round(m / 1440)} d`;
  };
  const cleanTitle = (t) => (t || "").replace(/^Diskusia k článku:\s*/i, "").trim();
  const openOptions = () => chrome.runtime.sendMessage({ type: "openOptions" });

  function articleContext(topic) {
    const h1 = document.querySelector("h1");
    const title = cleanTitle(h1 && h1.innerText) || topic.name || document.title;
    if (mode !== "article") return { title: topic.name || title, summary: "" };
    const perex = document.querySelector(".perex");
    const PAYWALL = /odomknite článok|predplatné|pošlite sms|zaplatením potvrdíte|VOP a Zásadami/i;
    const body = [...document.querySelectorAll(".article-body p")]
      .filter((p) => !p.closest("[class*=paywall],[class*=piano],[class*=promo]"))
      .map((p) => p.innerText.trim()).filter((t) => t && !PAYWALL.test(t)).join("\n");
    return { title, summary: perex ? perex.innerText.trim() : "", body: body.slice(0, 2000) };
  }

  // ---------- sledovanie prečítaných ----------
  function readTracker(dwellMs) {
    const timers = new Map(), pending = new Set(), done = new Set();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = e.target.dataset.smeaiId;
        if (!id || done.has(id)) continue;
        if (e.isIntersecting) {
          if (!timers.has(id)) timers.set(id, setTimeout(() => { done.add(id); pending.add(id); io.unobserve(e.target); timers.delete(id); }, dwellMs));
        } else if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
      }
    }, { threshold: 0.5 });
    const flush = () => {
      if (!pending.size) return;
      const ids = [...pending];
      pending.clear();
      chrome.runtime.sendMessage({ type: "markRead", topicId, ids });
    };
    setInterval(flush, 2000);
    addEventListener("pagehide", flush);
    return {
      observe(node, id) { if (done.has(id)) return; node.dataset.smeaiId = id; io.observe(node); },
      isReadNow: (id) => done.has(id),
    };
  }

  // =====================================================================
  // Blok „AI prehľad diskusie“ (Shadow DOM) – rovnaký na článku aj v diskusii
  // =====================================================================
  // placement: "before" | "after" anchor; collapsed: začne zbalený; onLoad({summarize}) – stiahnuť a ohodnotiť (článok)
  function createPanel(anchor, { placement = "before", collapsed = false, compact, postsById, onRef, tracker, onLoad, onNoCache }) {
    const host = el("div", { id: "smeai-panel" });
    const root = host.attachShadow({ mode: "open" });
    root.append(el("style", { text: PANEL_CSS }));
    const title = el("strong", { text: "AI prehľad diskusie" });
    const hint = el("span", { class: "hint" });
    const status = el("div", { class: "status", text: "Načítavam…" });
    const prog = el("progress", { max: "1", value: "0", hidden: true });
    const body = el("div", { class: "body" });
    const panelEl = el("div", { class: collapsed ? "panel closed" : "panel" },
      el("div", { class: "head", role: "button", tabindex: "0", title: "Rozbaliť / zbaliť", onclick: (e) => { if (!e.target.closest(".icon")) panelEl.classList.toggle("closed"); } },
        el("span", { class: "arrow" }), title, hint, el("button", { class: "icon", title: "Nastavenia", text: "⚙", onclick: openOptions })),
      el("div", { class: "content" }, status, prog, body));
    root.append(panelEl);
    anchor[placement](host);

    let last = null, lastRun = null, readIds = new Set(), port = null, summaryBusy = false;

    const setStatus = (t, err) => { status.textContent = t; status.classList.toggle("err", !!err); };
    const progress = (done, total) => { prog.hidden = false; prog.value = total ? done / total : 0; };

    function summarySection(s) {
      const sec = el("section", { class: "summary" }, el("h3", { text: "Zhrnutie" }));
      if (summaryBusy) return sec.append(el("div", { class: "muted", text: "Generujem zhrnutie…" })), sec;
      const sum = s.summary;
      if (!sum) {
        sec.append(el("div", { class: "muted", text: s.summaryError || (s.settings.hasGeminiKey ? "Zhrnutie zatiaľ neexistuje." : "Pre AI zhrnutie doplň Gemini API kľúč v nastaveniach.") }));
        if (s.settings.hasGeminiKey && s.topIds.length >= 2) sec.append(regenButton(s, "Vygenerovať zhrnutie"));
        else if (!s.settings.hasGeminiKey) sec.append(el("button", { class: "link", text: "Otvoriť nastavenia", onclick: openOptions }));
        return sec;
      }
      const d = sum.data;
      sec.append(el("p", { text: d.summary }));
      if (d.key_points.length) sec.append(el("ul", {}, d.key_points.map((k) => el("li", {}, k.point, " ",
        (k.post_ids || []).map(String).filter((id) => postsById.has(id)).map((id) =>
          el("a", { href: "#", class: "ref", title: "Prejsť na príspevok", text: `↗ ${postsById.get(id).author || "príspevok"}`, onclick: (e) => { e.preventDefault(); onRef(id, root); } }))))));
      if (d.agreements) sec.append(el("p", {}, el("strong", { text: "Zhoda: " }), d.agreements));
      if (d.disagreements) sec.append(el("p", {}, el("strong", { text: "Spory: " }), d.disagreements));
      sec.append(el("div", { class: "meta", text: `Zhrnutie ${ago(sum.at)} (${fmtTime(sum.at)}) z ${sum.basisIds.length} najlepších z ${sum.postCount} príspevkov · ${sum.model} · ${sum.usage.in.toLocaleString("sk-SK")} + ${sum.usage.out.toLocaleString("sk-SK")} tokenov = ${usd(sum.usd)} · AI zhrnutie môže byť nepresné.` }));

      const dl = s.delta;
      const box = el("div", { class: "delta" });
      if (dl && dl.newPosts) {
        box.append(el("div", {}, "Od zhrnutia pribudlo ", el("strong", { text: `${dl.newPosts} príspevkov` }), `, z toho ${dl.newUseful} užitočných. `,
          "Do nového zhrnutia by vstúpilo ", el("strong", { text: `${dl.wouldEnter} nových` }), ` z ${s.topIds.length} vybraných.`));
      } else box.append(el("div", { class: "muted", text: dl && dl.wouldEnter ? `Bez nových príspevkov; výber top príspevkov sa zmenil o ${dl.wouldEnter}.` : "Od zhrnutia nepribudli žiadne príspevky." }));
      box.append(regenButton(s, "Regenerovať zhrnutie", dl && !dl.wouldEnter));
      sec.append(box);
      return sec;
    }

    function regenButton(s, label, quiet) {
      return el("button", { class: quiet ? "btn ghost" : "btn", text: `${label} (~${usd(s.estUsd)})`, onclick: () => {
        summaryBusy = true;
        render(last);
        // pohľad z cache môže byť zastaraný → najprv dotiahni nové príspevky, potom zhrň
        if (s.fromCache && onLoad) onLoad({ summarize: true });
        else port.postMessage({ type: "regenerate" });
      } });
    }

    function postCard(p, rank, s, basis) {
      const d = s.byId.get(p.id);
      const full = p.text, short = full.length > 420 ? full.slice(0, 400).trimEnd() + "…" : full;
      const txt = el("div", { class: "txt", text: short });
      const wasRead = readIds.has(p.id);
      const card = el("article", { class: `card c-${d.verdict.color}`, id: `p-${p.id}` },
        el("div", { class: "cardhead" },
          el("span", { class: "rank", text: `#${rank}` }),
          el("strong", { text: p.author || "anonym" }),
          el("span", { class: "muted", text: `${fmtTime(p.createdAt)}${p.parentId ? " · reakcia" : ""}` }),
          basis && !basis.has(p.id) ? el("span", { class: "tag new", text: "nový od zhrnutia" }) : null,
          wasRead ? el("span", { class: "tag", text: "✓ prečítané" }) : null,
          el("span", { class: "votes", text: `👍 ${p.votesUp} 👎 ${p.votesDown}` })),
        el("div", { class: "badge", text: badgeText(d.verdict, d.answers) + (d.answers.stance ? ` · ${STANCE[d.answers.stance.choice]}` : "") }),
        txt,
        full !== short ? el("button", { class: "link", text: "celý príspevok", onclick: (e) => { txt.textContent = full; e.target.remove(); } }) : null,
        mode === "discussion" ? el("button", { class: "link", text: "  ↓ v diskusii", onclick: () => onRef(p.id, root) }) : null);
      if (tracker && !wasRead) tracker.observe(card, p.id);
      return card;
    }

    function costsSection(s) {
      const c = s.costs, r = lastRun;
      return el("section", { class: "costs" }, el("h3", { text: "Náklady" }), el("dl", {},
        r ? [el("dt", { text: "Toto načítanie" }), el("dd", { text: `TypeSafe ${usd(r.tsUsd)} · ${r.tsPosts} nových príspevkov, ${r.cached} z cache${r.errors ? `, ${r.errors} chýb` : ""} · ${r.seconds.toFixed(1)} s` })] : null,
        el("dt", { text: "TypeSafe (spolu)" }), el("dd", { text: `${usd(c.tsUsd)} · ${c.tsPosts} ohodnotených príspevkov · ${c.tsTokens.toLocaleString("sk-SK")} tokenov` }),
        el("dt", { text: "Gemini (spolu)" }), el("dd", { text: `${usd(c.gmUsd)} · ${c.gmRuns}× zhrnutie · ${c.gmIn.toLocaleString("sk-SK")} + ${c.gmOut.toLocaleString("sk-SK")} tokenov` }),
        el("dt", { text: "Diskusia spolu" }), el("dd", {}, el("strong", { text: usd(c.tsUsd + c.gmUsd) }))));
    }

    function render(s) {
      if (!s) return;
      last = s;
      prog.hidden = true;
      hint.textContent = s.summary ? `zhrnutie ${ago(s.summary.at)}` : `${s.stats.scored} ohodnotených`;
      if (s.fromCache) {
        const fresh = s.remotePostCount != null && s.snapRemoteTotal != null ? Math.max(0, s.remotePostCount - s.snapRemoteTotal) : null;
        setStatus(`Z cache (${ago(new Date(s.snapAt).toISOString())}) · ${s.stats.scored} ohodnotených príspevkov${fresh ? ` · odvtedy pribudlo ~${fresh}` : ""}`);
      } else setStatus(`Ohodnotených ${s.stats.scored} príspevkov${s.stats.hiddenByUs ? ` · ${s.stats.hiddenByUs} nevhodných` : ""}`);
      const basis = s.summary ? new Set(s.summary.basisIds) : null;
      const cards = s.topIds.map((id, i) => postCard(postsById.get(id), i + 1, s, basis));
      const topSec = el(compact ? "details" : "section", { class: "top" },
        el(compact ? "summary" : "h3", { text: `Najhodnotnejšie príspevky (${s.topIds.length})` }),
        cards.length ? cards : el("div", { class: "muted", text: "Žiadne hodnotné príspevky." }));
      const statsSec = el(compact ? "details" : "section", {}, el(compact ? "summary" : "h3", { text: "Štatistiky diskusie" }), statsGrid(s.stats));
      const fresh = s.remotePostCount != null && s.snapRemoteTotal != null ? Math.max(0, s.remotePostCount - s.snapRemoteTotal) : null;
      const refresh = s.fromCache && onLoad
        ? el("div", { class: "delta" }, el("span", { class: "muted", text: "Zobrazujem uložený stav. " }),
            el("button", { class: fresh ? "btn small" : "btn small ghost", text: fresh ? `Aktualizovať: ${fresh} nových (~${usd(estTypesafe(fresh))})` : "Aktualizovať (nič nové)", onclick: () => onLoad({}) }))
        : null;
      body.replaceChildren(...[refresh, summarySection(s), topSec, statsSec, costsSection(s)].filter(Boolean));
    }

    return {
      root,
      host,
      setStatus,
      progress,
      setTitle(t) { title.textContent = t; },
      open() { panelEl.classList.remove("closed"); },
      append(node) { panelEl.querySelector(".content").append(node); },
      setHint(t) { hint.textContent = t; },
      setBody(...nodes) { body.replaceChildren(...nodes); },
      remote: {},
      attach(p) { port = p; },
      onMessage(m) {
        if (m.type === "progress") { progress(m.done, m.total); setStatus(`Hodnotím príspevky: ${m.done} / ${m.total}`); }
        else if (m.type === "nocache") { if (onNoCache) onNoCache(); }
        else if (m.type === "state") {
          if (this.remote.postCount != null) m.remotePostCount = this.remote.postCount;
          if (m.postsFull) m.postsFull.forEach((p) => postsById.set(p.id, p));
          if (m.run) lastRun = m.run;
          if (m.readIds) readIds = new Set(m.readIds);
          m.byId = new Map(m.posts.map((p) => [p.id, p]));
          summaryBusy = false;
          render(m);
        } else if (m.type === "summary_progress") { summaryBusy = true; render(last); }
        else if (m.type === "summary_error") { summaryBusy = false; if (last) { last.summaryError = m.message; render(last); } }
        else if (m.type === "error") { prog.hidden = true; setStatus(m.message, true); if (m.code === "nokey") body.replaceChildren(el("button", { class: "btn", text: "Otvoriť nastavenia", onclick: openOptions })); }
      },
    };
  }

  function statsGrid(s) {
    const rows = [
      ["Príspevky", `${s.active}${s.moderated ? ` (+${s.moderated} moderované)` : ""}`],
      ["Vlákna / reakcie", `${s.roots} / ${s.replies} (hĺbka ${s.maxDepth})`],
      ["Diskutujúci", `${s.authors}${s.topAuthors.length ? " · najaktívnejší: " + s.topAuthors.map(([a, n]) => `${a} (${n})`).join(", ") : ""}`],
      ["Obdobie", s.firstAt ? `${fmtTime(s.firstAt)} – ${fmtTime(s.lastAt)}` : "–"],
      ["Priemerná kvalita", s.avgQuality != null ? `${Math.round(s.avgQuality * 100)} / 100` : "–"],
      ["Tón", s.avgSentiment != null ? ["veľmi negatívny", "negatívny", "neutrálny", "pozitívny"][Math.min(3, Math.round(s.avgSentiment))] + ` (${s.avgSentiment.toFixed(2)} / 3)` : "–"],
      ["Osobné útoky", `${s.attacks} (${pct(s.attacks, s.scored)})`],
      ["Xenofóbia", `${s.hate} (${pct(s.hate, s.scored)})`],
      ["Vulgarizmy", `${s.vulgar} (${pct(s.vulgar, s.scored)})`],
      ["Hlasy čitateľov", `👍 ${s.votesUp} · 👎 ${s.votesDown}`],
      ["Kvalita vs. 👍", s.qualityVsLikes != null ? `${s.qualityVsLikes.toFixed(2)} (Spearman, n=${s.qualityVsLikesN})` : "–"],
    ];
    const bar = (obj, labels, cls) => {
      const total = Object.values(obj).reduce((a, b) => a + b, 0) || 1;
      return el("div", { class: "dist" }, Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, n]) =>
        el("span", { class: `chip ${cls ? cls + "-" + k : ""}`, title: `${n} príspevkov` }, `${labels[k] || k} ${Math.round((100 * n) / total)} %`)));
    };
    return el("div", { class: "stats" },
      el("dl", {}, rows.map(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })])),
      el("div", { class: "sub", text: "Kvalita" }), bar(s.colors, COLOR_LABEL, "c"),
      el("div", { class: "sub", text: "Typ príspevkov" }), bar(s.kinds, KIND),
      el("div", { class: "sub", text: "Postoj k článku" }), bar(s.stances, STANCE));
  }

  function badgeText(v, a) {
    if (!a) return "neohodnotené";
    const parts = [`Q ${Math.round(v.quality * 100)}`, KIND[a.kind && a.kind.choice] || "", `prínos ${a.substance.score.toFixed(1)}/3`];
    if (a.personal_attack.noul > 0.5) parts.push("osobný útok");
    if (a.group_hate.noul > 0.6) parts.push("xenofóbia");
    if (a.vulgar.noul > 0.5) parts.push("vulgarizmy");
    return parts.filter(Boolean).join(" · ");
  }

  function connect(panel, extra) {
    const port = chrome.runtime.connect({ name: "smeai" });
    panel.attach(port);
    port.onMessage.addListener((m) => { panel.onMessage(m); if (extra) extra(m); });
    return port;
  }
  const analyzeMsg = (topic, posts, article, summarize = false) =>
    ({ type: "analyze", mode, topicId, article, posts, remoteTotal: topic.postCount, summarize });

  // =====================================================================
  // DISKUSIA
  // =====================================================================
  function discussionMode(posts, topic, article, settings) {
    const postsById = new Map(posts.map((p) => [p.id, p]));
    const tracker = readTracker(settings.readDwellMs);
    const html = document.documentElement;

    const scrollToPost = (id) => {
      const node = document.querySelector(`.anz-post[data-post-id="${id}"]`);
      if (!node) return;
      node.classList.add("smeai-revealed");
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      node.classList.add("smeai-flash");
      setTimeout(() => node.classList.remove("smeai-flash"), 1500);
    };
    const panel = createPanel(topicEl, { compact: true, postsById, onRef: scrollToPost, tracker });
    panel.setStatus(`Načítaných ${posts.length} príspevkov, hodnotím…`);

    // --- dock s ovládaním ---
    const dockHost = el("div", { id: "smeai-dock" });
    const droot = dockHost.attachShadow({ mode: "open" });
    droot.append(el("style", { text: PANEL_CSS }));
    const dstatus = el("div", { class: "status", text: "Hodnotím…" });
    const controls = el("div", {});
    droot.append(el("div", { class: "dock" },
      el("div", { class: "head" }, el("strong", { text: "SME Diskusia AI" }),
        el("button", { class: "icon", title: "Zbaliť", text: "–", onclick: () => droot.host.classList.toggle("min") })),
      dstatus, controls));
    document.body.append(dockHost);

    let data = new Map(), plan = { hide: new Set(), context: new Set() };

    function decorate(postEl) {
      const id = postEl.dataset.postId;
      const d = data.get(id);
      if (!d || postEl.dataset.smeai) return;
      postEl.dataset.smeai = "1";
      const { verdict: v, answers: a } = d;
      postEl.classList.add("smeai-post", `smeai-c-${v.color}`);
      const header = postEl.querySelector(".anz-post__header");
      (header || postEl.firstElementChild || postEl).after(el("div", { class: "smeai-badge", text: "● " + badgeText(v, a) }));
      const content = postEl.querySelector(".anz-post__content-text");
      if (v.hidden) {
        postEl.classList.add("smeai-hidden");
        if (content) content.after(el("a", { href: "#", class: "smeai-ph", text: `[skryté: ${v.reason} – zobraziť]`, onclick: (e) => { e.preventDefault(); postEl.classList.add("smeai-revealed"); } }));
      }
      if (plan.hide.has(id)) postEl.classList.add("smeai-read");
      if (plan.context.has(id)) {
        postEl.classList.add("smeai-readctx");
        if (content) content.after(el("a", { href: "#", class: "smeai-ctxph", text: "[prečítaný príspevok – zobraziť]", onclick: (e) => { e.preventDefault(); postEl.classList.add("smeai-revealed"); } }));
      }
      if (!plan.hide.has(id) && !plan.context.has(id)) tracker.observe(postEl, id);
    }
    const decorateAll = () => document.querySelectorAll(".anz-post[data-post-id]").forEach(decorate);

    async function autoExpand() {
      for (let i = 0; i < 40; i++) {
        const btn = [...document.querySelectorAll("a.anz-btn, button.anz-btn")].find((b) => /ĎALŠÍCH|ďalších/i.test(b.innerText));
        if (!btn) return;
        const before = document.querySelectorAll(".anz-post[data-post-id]").length;
        btn.click();
        for (let t = 0; t < 30; t++) {
          await new Promise((r) => setTimeout(r, 200));
          if (document.querySelectorAll(".anz-post[data-post-id]").length > before) break;
        }
      }
    }

    function renderControls(s) {
      const readCount = plan.hide.size + plan.context.size;
      const hideBad = el("input", { type: "checkbox", checked: html.classList.contains("smeai-hide-on"), onchange: (e) => html.classList.toggle("smeai-hide-on", e.target.checked) });
      const readOn = html.classList.contains("smeai-hideread");
      controls.replaceChildren(
        el("label", { class: "toggle" }, hideBad, ` skrývať nevhodné (${s.stats.hiddenByUs})`),
        readCount
          ? el("div", { class: "readrow" },
              el("span", { text: readOn ? `Skrytých ${readCount} prečítaných` : `Prečítaných z minula: ${readCount}` }),
              el("button", { class: "btn small", text: readOn ? "Zobraziť" : "Skryť", onclick: () => { html.classList.toggle("smeai-hideread"); renderControls(s); } }))
          : el("div", { class: "muted", text: "Žiadne prečítané príspevky z minulých návštev." }),
        el("button", { class: "link", text: "Nastavenia", onclick: openOptions }));
    }

    let started = false;
    const port = connect(panel, (m) => {
      if (m.type === "progress") dstatus.textContent = `Hodnotím príspevky: ${m.done} / ${m.total}`;
      if (m.type === "error") dstatus.textContent = m.message;
      if (m.type !== "state") return;
      data = new Map(m.posts.map((p) => [p.id, p]));
      dstatus.textContent = `Ohodnotených ${m.stats.scored} príspevkov`;
      if (!started) {
        started = true;
        const p = readPlan(posts, m.readIds || []);
        plan = { hide: new Set(p.hide), context: new Set(p.context) };
        html.classList.toggle("smeai-hide-on", m.settings.hideHate || m.settings.hideLowQuality);
        html.classList.toggle("smeai-hideread", !!m.settings.hideRead);
        decorateAll();
        new MutationObserver(decorateAll).observe(document.body, { childList: true, subtree: true });
        if (m.settings.autoExpand) autoExpand();
      }
      renderControls(m);
    });
    port.postMessage(analyzeMsg(topic, posts, article));
  }

  // =====================================================================
  // ČLÁNOK
  // =====================================================================
  // Rozbaľovací blok pod nadpisom. Bez kliknutia sa neplatí nič: zobrazí sa len stav z cache
  // (ak existuje) a počet príspevkov z fóra. Stiahnutie + hodnotenie a zhrnutie idú cez tlačidlá.
  function articleMode(settings) {
    const postsById = new Map();
    const tracker = readTracker(settings.readDwellMs);
    const onRef = (id, root) => {
      const c = root.getElementById(`p-${id}`);
      if (!c) return;
      c.scrollIntoView({ behavior: "smooth", block: "center" });
      c.classList.add("flash");
      setTimeout(() => c.classList.remove("flash"), 1200);
    };
    const h1 = document.querySelector("h1");
    let port = null, loading = false;
    const panel = createPanel(h1 || topicEl, { placement: h1 ? "after" : "before", collapsed: true, compact: false, postsById, onRef, tracker, onLoad: (o) => load(o), onNoCache });
    const ensurePort = () => port || (port = connect(panel, (m) => { if (m.type === "state" || m.type === "error") loading = false; }));

    function onNoCache() {
      const n = panel.remote.postCount;
      panel.setStatus(n ? "Diskusia ešte nebola analyzovaná." : "Diskusia zatiaľ nemá príspevky.");
      if (n) panel.setBody(
        el("button", { class: "btn", text: `Načítať a ohodnotiť diskusiu (~${usd(estTypesafe(n))})`, onclick: () => load({}) }),
        el("div", { class: "meta", text: "Zhrnutie (Gemini) sa generuje zvlášť tlačidlom po ohodnotení." }));
    }

    async function load({ summarize = false } = {}) {
      if (loading) return;
      loading = true;
      panel.open();
      try {
        panel.setStatus("Sťahujem diskusiu…");
        const { topic, posts } = await loadPosts((n, total) => { panel.progress(n, total); panel.setStatus(`Sťahujem diskusiu: ${n} / ${total}`); });
        if (!posts.length) { loading = false; return panel.setStatus("Diskusia zatiaľ nemá príspevky."); }
        posts.forEach((p) => postsById.set(p.id, p));
        panel.remote.postCount = topic.postCount;
        ensurePort().postMessage(analyzeMsg(topic, posts, articleContext(topic), summarize));
      } catch (e) { loading = false; panel.setStatus(String(e.message || e), true); }
    }

    (async () => {
      try {
        const t = await fetchTopic(window.fetch.bind(window), forumBase, topicId); // zadarmo – len metadáta fóra
        panel.remote.postCount = t.postCount;
        panel.setHint(`${t.postCount} príspevkov`);
        if (t.topicLink) panel.append(el("a", { class: "open", href: t.topicLink, target: "_top", text: "Otvoriť celú diskusiu →" }));
      } catch (e) { panel.setHint(""); }
      if (settings.articleAutoLoad) load({});
      else ensurePort().postMessage({ type: "peek", topicId });
    })();
  }

  // ---------- štart ----------
  async function loadPosts(onProgress) {
    const topic = await fetchTopic(window.fetch.bind(window), forumBase, topicId);
    const { posts } = await fetchAllPosts(window.fetch.bind(window), forumBase, topicId, { onPage: onProgress });
    return { topic, posts: posts.filter((p) => p.status !== "hidden" && p.text) };
  }

  async function startDiscussion(settings) {
    const { topic, posts } = await loadPosts();
    if (!posts.length) return;
    discussionMode(posts, topic, articleContext(topic), settings);
  }

  // ---------- štýly (Shadow DOM) ----------
  const PANEL_CSS = `
    :host { all: initial; --bg:#fff; --fg:#1f2328; --mut:#6b7280; --bd:#e5e7eb; --card:#f9fafb; --acc:#7c3aed;
      --green:#16a34a; --yellow:#ca8a04; --red:#dc2626; --gray:#6b7280; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); }
    @media (prefers-color-scheme: dark) { :host { --bg:#1c1c1e; --fg:#e5e7eb; --mut:#9ca3af; --bd:#374151; --card:#26262a; } }
    .panel, .dock, button { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
    .panel { background: var(--bg); border: 1px solid var(--bd); border-top: 4px solid var(--acc); border-radius: 10px; padding: 12px 16px; margin: 12px 0 18px; }
    .dock { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; width: 300px;
      background: var(--bg); border: 1px solid var(--bd); border-top: 4px solid var(--acc); border-radius: 10px; padding: 12px 14px; box-shadow: 0 8px 30px rgba(0,0,0,.18); font-size: 13px; }
    :host(.min) .dock > :not(.head) { display: none; }
    .head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 15px; }
    .panel .head { justify-content: flex-start; cursor: pointer; user-select: none; }
    .panel .head .icon { margin-left: auto; }
    .arrow::before { content: "▾"; color: var(--acc); display: inline-block; transition: transform .15s; }
    .panel.closed .arrow::before { transform: rotate(-90deg); }
    .panel.closed .content { display: none; }
    .panel.closed { padding-bottom: 10px; } .panel.closed .head { margin-bottom: 0; }
    .hint { color: var(--mut); font-size: 12px; font-weight: normal; }
    .icon { border: 0; background: transparent; color: var(--mut); font-size: 16px; cursor: pointer; }
    .status { color: var(--mut); font-size: 13px; } .status.err { color: var(--red); }
    progress { width: 100%; height: 6px; accent-color: var(--acc); }
    h3 { font-size: 15px; margin: 18px 0 8px; }
    details { margin-top: 14px; } summary { cursor: pointer; font-weight: 600; font-size: 15px; }
    .summary p { margin: 6px 0; } .summary ul { margin: 6px 0; padding-left: 20px; } .summary li { margin: 4px 0; }
    .ref { color: var(--acc); font-size: 12px; text-decoration: none; margin-left: 4px; white-space: nowrap; }
    .delta { margin-top: 10px; padding: 8px 10px; border: 1px dashed var(--bd); border-radius: 8px; font-size: 13px; }
    .muted { color: var(--mut); } .meta { color: var(--mut); font-size: 11px; margin-top: 8px; }
    .card { background: var(--card); border-left: 4px solid var(--gray); border-radius: 6px; padding: 10px 12px; margin: 8px 0; transition: box-shadow .3s; }
    .card.flash { box-shadow: 0 0 0 3px var(--acc); }
    .c-green { border-left-color: var(--green); } .c-yellow { border-left-color: var(--yellow); } .c-red { border-left-color: var(--red); }
    .cardhead { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: 13px; }
    .rank { color: var(--acc); font-weight: 700; } .votes { margin-left: auto; color: var(--mut); font-size: 12px; }
    .tag { font-size: 11px; color: var(--mut); border: 1px solid var(--bd); border-radius: 8px; padding: 0 6px; }
    .tag.new { color: var(--acc); border-color: var(--acc); }
    .badge { font-size: 11px; color: var(--mut); margin: 2px 0 4px; }
    .txt { white-space: pre-wrap; overflow-wrap: anywhere; }
    .link { border: 0; background: none; color: var(--acc); cursor: pointer; padding: 0; font: inherit; font-size: 12px; margin-top: 6px; margin-right: 10px; }
    .btn { margin-top: 8px; border: 1px solid var(--acc); background: var(--acc); color: #fff; border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 13px; }
    .btn.ghost { background: transparent; color: var(--acc); }
    .btn.small { margin: 0; padding: 2px 10px; font-size: 12px; }
    .readrow { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 6px 0; }
    .open { display: inline-block; margin-top: 14px; color: var(--acc); font-weight: 600; text-decoration: none; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 3px 12px; margin: 0; font-size: 13px; }
    dt { color: var(--mut); } dd { margin: 0; overflow-wrap: anywhere; }
    .sub { color: var(--mut); font-size: 12px; margin: 10px 0 4px; }
    .dist { display: flex; flex-wrap: wrap; gap: 4px; }
    .chip { font-size: 11px; padding: 1px 7px; border-radius: 10px; background: var(--card); border: 1px solid var(--bd); }
    .chip.c-green { border-color: var(--green); } .chip.c-yellow { border-color: var(--yellow); } .chip.c-red { border-color: var(--red); }
    .chip.c-low, .chip.c-hate { border-color: var(--gray); }
    .costs dl { font-size: 12px; }
    .toggle { display: block; margin: 6px 0; }
  `;

  chrome.runtime.sendMessage({ type: "getSettings" }, (s) => {
    if (chrome.runtime.lastError || !s) return;
    if (mode === "discussion" && s.enableDiscussion) startDiscussion(s).catch((e) => console.warn("[SME AI]", e));
    if (mode === "article" && s.enableArticle) articleMode(s);
  });
})();
