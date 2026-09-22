// Klient pre verejné API diskusií sme.sk (core-forum). fetch sa odovzdáva zvonka,
// lebo v rozšírení volá z content scriptu (pôvod stránky – WAF blokuje iné pôvody).
(function (root) {
  const htmlToText = (root.SmeAI && root.SmeAI.htmlToText) || require("./text.js").htmlToText;
  const PAGE = 100; // API prijme iba 10 / 50 / 100

  function apiBase(forumBase) {
    const b = String(forumBase || "https://core-forum.sme.sk").replace(/\/+$/, "");
    return /\/api\/pub\/v1$/.test(b) ? b : b + "/api/pub/v1";
  }

  function normalizePost(raw) {
    const path = String(raw.path || "");
    const stats = raw.stats || {};
    return {
      id: String(raw.id),
      parentId: raw.parent ? String(raw.parent) : null,
      depth: path ? Math.max(0, path.split("-").length - 1) : 0,
      createdAt: raw.createdAt || null,
      author: (raw.author && raw.author.nickname) || null,
      status: raw.status || "active",
      text: htmlToText(raw.content),
      votesUp: stats.votesPositive || 0,
      votesDown: stats.votesNegative || 0,
    };
  }

  async function getJson(fetchImpl, url) {
    const r = await fetchImpl(url, { credentials: "omit" });
    if (!r.ok) throw new Error(`Fórum API ${r.status} pre ${url}`);
    return r.json();
  }

  async function fetchTopic(fetchImpl, forumBase, topicId) {
    const j = await getJson(fetchImpl, `${apiBase(forumBase)}/topic/ids/${topicId}`);
    const t = j.data && j.data[0];
    if (!t) throw new Error(`Téma ${topicId} neexistuje`);
    return {
      id: String(t.id),
      name: t.name,
      topicLink: t.links && t.links.topicLink,
      articleLink: t.links && t.links.articleLink,
      postCount: (t.stats && t.stats.postCount) || 0,
      rootPostCount: (t.stats && t.stats.rootPostCount) || 0,
    };
  }

  // Stránkuje kurzorom /post/{lastId}; onPage(načítané, celkom) pre priebeh.
  async function fetchAllPosts(fetchImpl, forumBase, topicId, { maxPosts = 2000, onPage } = {}) {
    const base = `${apiBase(forumBase)}/post/treeasc/topic/${topicId}`;
    const seen = new Set();
    const posts = [];
    let last = null, total = null;
    for (let guard = 0; guard < 200; guard++) {
      const url = `${base}${last ? "/post/" + last : ""}?limit=${PAGE}&order=asc`;
      const j = await getJson(fetchImpl, url);
      total = j.totalCount ?? total;
      const data = j.data || [];
      let added = 0;
      for (const raw of data) {
        const id = String(raw.id);
        if (seen.has(id)) continue;
        seen.add(id);
        posts.push(normalizePost(raw));
        added++;
      }
      if (onPage) onPage(posts.length, total);
      if (data.length < PAGE || added === 0 || posts.length >= maxPosts) break;
      if (total != null && posts.length >= total) break;
      last = data[data.length - 1].id;
    }
    return { posts: posts.slice(0, maxPosts), total: total ?? posts.length };
  }

  const api = { apiBase, normalizePost, fetchTopic, fetchAllPosts };
  root.SmeAI = Object.assign(root.SmeAI || {}, api);
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
