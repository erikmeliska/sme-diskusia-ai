// TypeSafe (Jev) – otázky a volanie API. Otázky sú všeobecné (téma prichádza cez `article` v state).
// v3 = v2 z PoC, zovšeobecnené relevance/stance/kind.
(function (root) {
  const API = "https://api.typesafe.ai/v1/systemone";
  const QUESTIONS_VERSION = "v3";

  const QUESTIONS = {
    sentiment: {
      type: "score",
      instructions: "What is the emotional tone of `comment` (a reader comment in Slovak)? Judge the tone of the writing itself, not whether the author agrees with the article.",
      criteria: [
        "Very negative: angry, contemptuous, hostile or disgusted",
        "Negative: irritated, complaining, dismissive or mocking",
        "Neutral: matter-of-fact, informational, calm",
        "Positive: friendly, appreciative, constructive or good-humoured",
      ],
    },
    relevance: {
      type: "score",
      instructions: "How closely is `comment` related to the subject of `article`? Use `parent_comment` only to understand what a reply refers to.",
      criteria: [
        "Off-topic: unrelated to the article or the thread",
        "Tangential: loosely connected, mostly about something else (the other commenters, people's looks, unrelated anecdotes)",
        "On-topic: addresses the article's subject",
        "Central: directly addresses the core issue, causes, consequences or responsibility described in the article",
      ],
    },
    substance: {
      type: "score",
      instructions: "How much does `comment` add to the discussion of `article`? Judge informational and argumentative value, not tone or grammar.",
      criteria: [
        "Nothing: emoji, one-liner, pure reaction, joke or insult with no content",
        "Bare opinion: states a view or feeling without support",
        "Supported: gives a reason, analogy, concrete personal experience or a relevant fact",
        "Valuable: new information, careful analysis, comparison with other places or a concrete proposed solution",
      ],
    },
    writing: {
      type: "score",
      instructions: "How well is `comment` written as a piece of communication? Missing Slovak diacritics alone is common online and should not lower the rating much. Ignore whether you agree.",
      criteria: [
        "Incoherent or unreadable",
        "Hard to follow, fragmentary or sloppy",
        "Clear enough, informal",
        "Clear, well-structured and precise",
      ],
    },
    personal_attack: {
      type: "noul",
      instructions: {
        question: "Does `comment` insult, mock or demean an individual person — another commenter (usually the author of `parent_comment`, addressed as 'ty'/'Vy'/'pán') or a named individual from the article?",
        includes: "name-calling, questioning their intelligence, mocking their home town or origin, mock-helpful or ironic replies that ridicule the person, insulting their looks",
        excludes: "derogatory remarks about a whole group (a nationality, an occupation) — that is a different question; sharp but impersonal disagreement with an argument; criticism of a company, institution or politician's actions",
      },
      criteria: {
        true: "An individual person is ridiculed or insulted, openly or through irony",
        false: "No individual person is ridiculed or insulted",
      },
    },
    group_hate: {
      type: "noul",
      instructions: "Does `comment` demean or stereotype people as a group based on nationality, ethnicity, origin, religion or Slovak region (slurs, mocking names for foreigners, 'scum', mocking people from a region)?",
      criteria: {
        true: "Derogatory generalisation or slur about a national, ethnic, religious or regional group",
        false: "No group-based derogation; criticism of a company, institution or behaviour without reference to origin is not this",
      },
    },
    vulgar: {
      type: "noul",
      instructions: "Does `comment` contain vulgar or profane language (including censored swear words like d***)?",
    },
    kind: {
      type: "choice",
      instructions: "What is the primary function of `comment` in the discussion?",
      criteria: {
        experience: "Shares a personal experience relevant to the topic",
        argument: "Argues a position with reasons, analogies or analysis",
        proposal: "Proposes a concrete solution or compares with how it works elsewhere",
        question: "Asks a genuine question",
        humor: "Joke, sarcasm or irony without much other content",
        attack: "Mainly attacks or insults someone",
        rant: "Venting frustration or anger without argument",
        other: "Correction, emoji, off-topic remark or anything else",
      },
    },
    stance: {
      type: "choice",
      instructions: "How does `comment` relate to the account and framing of events in `article`?",
      criteria: {
        agrees: "Accepts the article's framing; criticises the same actors or behaviour the article criticises",
        disputes: "Disputes the article or defends the actors the article criticises",
        nuance: "Adds context or blames a different actor without clearly agreeing or disagreeing",
        none: "No stance on the article's subject",
      },
    },
  };

  function buildState(article, post, parent) {
    return {
      article: { title: article.title || "", summary: article.summary || "" },
      parent_comment: parent ? parent.text : null,
      comment: post.text,
    };
  }

  // odstráni legend (dlhé texty kritérií) – do cache ukladáme len čísla
  function compactAnswers(answers) {
    const out = {};
    for (const [k, a] of Object.entries(answers || {})) {
      const { legend, ...rest } = a;
      out[k] = rest;
    }
    return out;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function ask(fetchImpl, apiKey, state, { retries = 4, model = "jev-latest" } = {}) {
    const body = JSON.stringify({ model, state, questions: QUESTIONS });
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const r = await fetchImpl(API, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body,
        });
        if (r.ok) {
          const j = await r.json();
          return { answers: compactAnswers(j.answers), inputTokens: (j.usage && j.usage.input_tokens) || 0, model: j.model };
        }
        const text = (await r.text()).slice(0, 300);
        lastErr = new Error(`TypeSafe HTTP ${r.status}: ${text}`);
        lastErr.status = r.status;
        if (![429, 500, 502, 503, 529].includes(r.status)) throw lastErr;
      } catch (e) {
        lastErr = e;
        if (e.status && ![429, 500, 502, 503, 529].includes(e.status)) throw e;
      }
      await sleep(500 * 2 ** attempt);
    }
    throw lastErr;
  }

  const cacheKey = (p) => {
    const hash = (root.SmeAI && root.SmeAI.hash) || require("./text.js").hash;
    return `ts:${QUESTIONS_VERSION}:${p.id}:${hash(p.text)}`;
  };
  // záznam v cache: { a: answers, t: čas uloženia }; starší formát (priamo answers) sa tiež prijme
  const unwrap = (v) => (v && v.a ? v.a : v && v.sentiment ? v : undefined);

  // cache: { getMany(keys) -> {key: value}, set(key, value) } (async)
  // inflight: zdieľaná Map key -> Promise<{answers, inputTokens}> – ten istý príspevok sa nepošle 2× ani pri súbežných analýzach
  async function scoreAll(fetchImpl, apiKey, article, posts, { cache, inflight, concurrency = 6, onProgress } = {}) {
    const byId = new Map(posts.map((p) => [p.id, p]));
    const results = new Map();
    let done = 0, tokens = 0, cached = 0, scoredNew = 0;
    const errors = [];
    const all = posts.filter((p) => p.status !== "hidden" && p.text);
    const keys = new Map(all.map((p) => [p.id, cacheKey(p)]));
    const hits = cache ? await cache.getMany([...keys.values()]) : {};

    const queue = [];
    for (const p of all) {
      const a = unwrap(hits[keys.get(p.id)]);
      if (a) { results.set(p.id, a); cached++; } else queue.push(p);
    }
    done = cached;
    if (onProgress) onProgress(done, all.length);

    let idx = 0, stop = false;
    async function worker() {
      while (!stop && idx < queue.length) {
        const p = queue[idx++];
        const key = keys.get(p.id);
        try {
          let job = inflight && inflight.get(key);
          const own = !job;
          if (own) {
            job = ask(fetchImpl, apiKey, buildState(article, p, byId.get(p.parentId)))
              .then(async (res) => { if (cache) await cache.set(key, { a: res.answers, t: Date.now() }); return res; })
              .finally(() => inflight && inflight.delete(key));
            if (inflight) inflight.set(key, job);
          }
          const res = await job;
          results.set(p.id, res.answers);
          if (own) { tokens += res.inputTokens; scoredNew++; } else cached++;
        } catch (e) {
          errors.push({ id: p.id, error: String(e.message || e) });
          if (e.status === 401 || e.status === 403) stop = true;
        }
        done++;
        if (onProgress) onProgress(done, all.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
    return { results, tokens, cached, scoredNew, errors };
  }

  const api = { QUESTIONS, QUESTIONS_VERSION, buildState, compactAnswers, ask, scoreAll, cacheKey, TYPESAFE_API: API };
  root.SmeAI = Object.assign(root.SmeAI || {}, api);
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
