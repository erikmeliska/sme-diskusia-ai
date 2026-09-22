// Štatistiky diskusie. Vstup: príspevky s { answers, verdict } (answers môžu chýbať).
(function (root) {
  function ranks(v) {
    const order = v.map((_, i) => i).sort((a, b) => v[a] - v[b]);
    const r = new Array(v.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && v[order[j + 1]] === v[order[i]]) j++;
      for (let k = i; k <= j; k++) r[order[k]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  }

  function spearman(x, y) {
    if (x.length < 3) return null;
    const rx = ranks(x), ry = ranks(y);
    const mx = rx.reduce((a, b) => a + b, 0) / rx.length, my = ry.reduce((a, b) => a + b, 0) / ry.length;
    let cov = 0, vx = 0, vy = 0;
    for (let i = 0; i < rx.length; i++) {
      cov += (rx[i] - mx) * (ry[i] - my);
      vx += (rx[i] - mx) ** 2;
      vy += (ry[i] - my) ** 2;
    }
    return vx && vy ? cov / Math.sqrt(vx * vy) : null;
  }

  const count = (arr) => arr.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {});

  function computeStats(posts) {
    const active = posts.filter((p) => p.status !== "hidden");
    const scored = active.filter((p) => p.answers);
    const n = scored.length || 1;
    const authors = count(active.map((p) => p.author).filter(Boolean));
    const times = active.map((p) => Date.parse(p.createdAt)).filter(Number.isFinite).sort((a, b) => a - b);
    const avg = (f) => scored.reduce((s, p) => s + f(p), 0) / n;
    const share = (q, t = 0.5) => scored.filter((p) => p.answers[q] && p.answers[q].noul > t).length;
    const voted = scored.filter((p) => p.votesUp + p.votesDown >= 5);

    return {
      total: posts.length,
      active: active.length,
      moderated: posts.length - active.length,
      scored: scored.length,
      roots: active.filter((p) => !p.parentId).length,
      replies: active.filter((p) => p.parentId).length,
      maxDepth: active.reduce((m, p) => Math.max(m, p.depth || 0), 0),
      authors: Object.keys(authors).length,
      topAuthors: Object.entries(authors).sort((a, b) => b[1] - a[1]).slice(0, 3),
      firstAt: times.length ? new Date(times[0]).toISOString() : null,
      lastAt: times.length ? new Date(times[times.length - 1]).toISOString() : null,
      colors: count(scored.map((p) => p.verdict.color)),
      hiddenByUs: scored.filter((p) => p.verdict.hidden).length,
      kinds: count(scored.map((p) => p.answers.kind && p.answers.kind.choice).filter(Boolean)),
      stances: count(scored.map((p) => p.answers.stance && p.answers.stance.choice).filter(Boolean)),
      avgQuality: scored.length ? avg((p) => p.verdict.quality) : null,
      avgSentiment: scored.length ? avg((p) => (p.answers.sentiment ? p.answers.sentiment.score : 1.5)) : null, // 0–3
      attacks: share("personal_attack"),
      hate: share("group_hate", 0.6),
      vulgar: share("vulgar"),
      votesUp: active.reduce((s, p) => s + (p.votesUp || 0), 0),
      votesDown: active.reduce((s, p) => s + (p.votesDown || 0), 0),
      qualityVsLikes: spearman(
        voted.map((p) => p.verdict.quality),
        voted.map((p) => p.votesUp / (p.votesUp + p.votesDown))
      ),
      qualityVsLikesN: voted.length,
    };
  }

  // najhodnotnejšie: neskryté, zoradené podľa kvality, pri zhode podľa 👍
  function topPosts(posts, n) {
    return posts
      .filter((p) => p.answers && p.status !== "hidden" && !p.verdict.hidden && p.verdict.color !== "hate")
      .sort((a, b) => b.verdict.quality - a.verdict.quality || b.votesUp - a.votesUp)
      .slice(0, n);
  }

  // Čo pribudlo od posledného zhrnutia. summary: { basisIds, lastPostAt } | null
  function summaryDelta(posts, summary, top) {
    if (!summary) return null;
    const cut = Date.parse(summary.lastPostAt) || 0;
    const basis = new Set(summary.basisIds || []);
    const fresh = posts.filter((p) => p.status !== "hidden" && Date.parse(p.createdAt) > cut);
    return {
      newPosts: fresh.length,
      newUseful: fresh.filter((p) => p.verdict && p.verdict.color === "green").length,
      wouldEnter: top.filter((p) => !basis.has(p.id)).length,
    };
  }

  // Prečítané príspevky pri novej návšteve: úplne skryť, alebo nechať ako skrátený kontext,
  // ak majú v podstrome neprečítanú reakciu.
  function readPlan(posts, readIds) {
    const read = readIds instanceof Set ? readIds : new Set(readIds || []);
    const children = new Map();
    for (const p of posts) if (p.parentId) (children.get(p.parentId) || children.set(p.parentId, []).get(p.parentId)).push(p.id);
    const memo = new Map();
    const hasUnread = (id) => {
      if (memo.has(id)) return memo.get(id);
      memo.set(id, false); // ochrana proti cyklu
      const r = (children.get(id) || []).some((c) => !read.has(c) || hasUnread(c));
      memo.set(id, r);
      return r;
    };
    const hide = [], context = [];
    for (const p of posts) if (read.has(p.id)) (hasUnread(p.id) ? context : hide).push(p.id);
    return { hide, context, unread: posts.filter((p) => !read.has(p.id)).length };
  }

  const api = { spearman, computeStats, topPosts, summaryDelta, readPlan };
  root.SmeAI = Object.assign(root.SmeAI || {}, api);
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
