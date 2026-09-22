# PoC: hodnotenie príspevkov v diskusii sme.sk cez TypeSafe (Jev)

Diskusia: *Taxikári ryžovali na jazdách z letiska v Bratislave…* (47 príspevkov, reakcie do hĺbky 3)

## Súbory
- `classify.py` – 1 request na príspevok, 10 otázok naraz (fan-out). `TYPESAFE_API_KEY=... python3 classify.py`
- `evaluate.py` – porovnanie s ručnými anotáciami, kompozitné skóre a farba (politika len v kóde)

**Dáta nie sú súčasťou repozitára.** `posts.json`, `votes.json`, `gold.json` a výstupy (`results*.json`, `scored.json`) obsahujú komentáre skutočných diskutujúcich zo sme.sk, preto sú v `.gitignore`. Na zopakovanie experimentu stiahni diskusiu cez DOM alebo API fóra (pozri [extension/PLAN.md](../extension/PLAN.md)) do `posts.json` vo formáte `{article: {title, summary}, posts: [{id, parent_id, depth, time, text}]}`.

## DOM selektory (sme.sk, platforma „anz“)
- príspevok: `.anz-post[data-post-id]`, text: `.anz-post__content-text`
- vlákno: rodičovský `li.anz-posts__item` → `.anz-post[data-post-id]`
- hlasy: `.anz-post__footer-likes` (text „0 42 2“ = ?, 👍, 👎)

## Klasifikácie
| id | typ | význam |
|---|---|---|
| sentiment | score 0–3 | tón: veľmi negatívny → pozitívny |
| relevance | score 0–3 | mimo témy → jadro problému |
| substance | score 0–3 | nič → nová informácia / analýza / riešenie |
| writing | score 0–3 | nezrozumiteľné → jasné a štruktúrované |
| personal_attack | noul | urážka / zosmiešnenie konkrétnej osoby |
| group_hate | noul | hanlivé zovšeobecnenie podľa národnosti, etnika alebo regiónu |
| vulgar | noul | vulgarizmy |
| sarcasm | noul | irónia alebo sarkazmus (v2) |
| kind | choice | experience / argument / proposal / question / humor / attack / rant / other |
| stance | choice | customers / drivers / platform_blame / none |

Kompozit: `Q = 0.45·substance + 0.30·relevance + 0.25·writing − 0.35·attack − 0.10·vulgar`;
`group_hate > 0.6` → skryť; Q < 0.25 skryť, < 0.45 červená, < 0.65 žltá, inak zelená.

## Výsledky (v2, 47 príspevkov)
| metrika | hodnota |
|---|---|
| group_hate | AUC 1.00, P 1.00 / R 0.88 |
| personal_attack | AUC 0.86 (v1 0.90), P/R 0.64 |
| sarcasm | AUC 0.86, ale P 0.35 (za sarkazmus považuje takmer všetko posmešné) |
| substance vs. ručný prínos | Spearman 0.77; kompozit Q 0.78 |
| stabilita medzi behmi | priemerný drift skóre ~0.03 (škála 0–3), `kind` 46/47, `stance` 44/47 |
| latencia | ~0.7 s na príspevok, 47 príspevkov paralelne za 6 s; ~1.7k vstupných tokenov na request |
| kvalita vs. 👍 čitateľov | Spearman 0.05, čiže hlasy merajú súhlas, nie kvalitu |
