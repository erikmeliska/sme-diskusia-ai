# SME Diskusia AI – plán Chrome rozšírenia (MV3)

## Cieľ
1. **Stránka diskusie** (`*/d/*`): každý príspevok dostane farbu podľa kvality (zelená / žltá / červená), štítok so skóre a nevhodné príspevky sa zbalia.
2. **Stránka článku** (`*/c/*`): nad diskusiou sa zobrazí panel „AI prehľad diskusie“ s najhodnotnejšími príspevkami, zhrnutím od Gemini Flash-Lite a štatistikami diskusie.
3. Kľúče TypeSafe a Gemini sa zadávajú na stránke nastavení rozšírenia.

## Zistenia z prieskumu
- Obe stránky majú element `[data-topic-id][data-forum-base-url]`, cez ktorý rozšírenie zistí ID témy.
- Príspevky vracia verejné JSON API:
  `GET {forumBase}/api/pub/v1/post/treeasc/topic/{topicId}[/post/{lastId}]?limit=100&order=asc`
  - `limit` môže byť iba 10, 50 alebo 100 (iná hodnota vráti 500).
  - Stránkuje sa kurzorom: `/post/{id posledného príspevku}` (rovnaký request posiela tlačidlo „Zobraziť ďalších N“).
  - Každý príspevok má `id, parent, path, content (HTML), createdAt, status (active|hidden), author.nickname, stats.votesPositive/Negative`.
- Metadáta témy: `GET {forumBase}/api/pub/v1/topic/ids/{topicId}` (názov, odkazy, `stats.postCount/rootPostCount`).
- API je chránené WAF: z CLI vráti 403, z prehliadača funguje. **Sťahuje preto content script** (má pôvod stránky), nie service worker.
- DOM na stránke diskusie: `.anz-post[data-post-id]`, text `.anz-post__content-text`. Viac ako 50 príspevkov sa načíta tlačidlom `a.anz-btn` („ZOBRAZIŤ ĎALŠÍCH …“).

## Architektúra
```
content.js (na *.sme.sk)          background.js (service worker)         externé API
 ├ zistí režim a topicId           ├ nastavenia z chrome.storage
 ├ stiahne príspevky z fóra ───────►├ TypeSafe scoring (6 paralelne) ────► api.typesafe.ai
 │  (stránkuje kurzorom)           │   + cache podľa postId+hash textu
 │                                 ├ policy → kvalita, farba
 │                                 ├ štatistiky
 │◄──── priebeh / výsledky (port) ─┤ Gemini zhrnutie top N ───────────────► generativelanguage.googleapis.com
 ├ diskusia: dekorácia DOM, MutationObserver, auto-rozbalenie
 └ článok: panel (Shadow DOM)
```
- `lib/*.js` sú čisté funkcie bez závislostí na Chrome API. Načítavajú ich content script, service worker aj `node --test`.
- Kľúče sú iba v `chrome.storage.local` a používa ich len service worker. Content script ich nikdy nedostane.
- Obsah príspevkov a výstup Gemini sa vkladá výhradne cez `textContent`, nikdy nie cez `innerHTML`.

## Súbory
| súbor | úloha |
|---|---|
| `manifest.json` | MV3, content script na `*://*.sme.sk/*`, host permissions pre TypeSafe a Gemini |
| `lib/text.js` | HTML → text, hash |
| `lib/forum.js` | normalizácia príspevkov, stránkovanie API (fetch sa odovzdáva ako parameter) |
| `lib/typesafe.js` | otázky (v3, všeobecné, bez viazanosti na tému), stav, request, retry, paralelizmus |
| `lib/policy.js` | predvolené nastavenia, kompozitné skóre, farba a dôvod |
| `lib/stats.js` | štatistiky diskusie |
| `lib/gemini.js` | prompt, JSON schéma, parsovanie odpovede |
| `background.js` | orchestrácia, cache, správy |
| `content.js`, `content.css` | UI na stránke diskusie aj článku |
| `options.html/js` | kľúče, model, váhy, prahy, prepínače, test kľúčov, vymazanie cache |
| `tests/*.test.js` | unit testy (`node --test`) |
| `scripts/live-check.mjs` | živý test TypeSafe (a Gemini, ak je kľúč) na PoC dátach |

## Štatistiky diskusie
Počet príspevkov, hlavných príspevkov a reakcií; maximálna hĺbka vlákna; unikátni autori a top 3 najaktívnejší; časové rozpätie; rozdelenie farieb; typy príspevkov (`kind`); postoj k článku; priemerný tón; podiel osobných útokov, xenofóbie a vulgarizmov; súčet 👍/👎; korelácia kvality s 👍.

## Zhrnutie (Gemini)
- Vstup: titulok a perex článku, úryvok textu, top N príspevkov (predvolene 12) podľa kvality s vylúčením skrytých. Pri každom: id, typ, postoj, 👍/👎.
- Výstup (JSON schéma): `summary`, `key_points[{point, post_ids}]`, `agreements`, `disagreements`.
- Model je nastaviteľný, predvolene `gemini-3.5-flash-lite`.

## Testovanie
1. `node --test`: unit testy lib vrstvy (bez siete).
2. `scripts/live-check.mjs`: skutočný TypeSafe (+ Gemini) na 47 príspevkoch z PoC.
3. Test v živom Chrome: content script sa injektuje do tabu a namiesto background sa použije shim. Overí sa sťahovanie 122 príspevkov a vykreslenie.
4. Finálne načítanie cez `chrome://extensions → Load unpacked` spraví používateľ.
