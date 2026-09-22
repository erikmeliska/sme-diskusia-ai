# SME Diskusia AI (Chrome rozšírenie, MV3) – v0.2

Hodnotí príspevky v diskusiách na sme.sk (TypeSafe/Jev), zhŕňa najhodnotnejšie (Gemini) a ukazuje štatistiky aj náklady. Návrh a zistenia o API sme.sk sú v [PLAN.md](PLAN.md).

## Inštalácia
1. Otvor `chrome://extensions` a zapni **Developer mode**.
2. Klikni na **Load unpacked** a vyber tento priečinok (`extension/`).
3. Klikni na ikonu rozšírenia, čím sa otvoria nastavenia. Vlož kľúč TypeSafe a Gemini, klikni **Uložiť** a potom **Otestovať kľúče**.
4. Po aktualizácii kódu stačí v `chrome://extensions` kliknúť na ↻ a obnoviť stránku sme.sk.

## Stránka článku (`/c/`)
- Pod nadpisom je rozbaľovací blok **AI prehľad diskusie**, predvolene zbalený.
- **Bez kliknutia sa neplatí nič.** Blok zistí len počet príspevkov z fóra a ukáže uložený stav z cache (zhrnutie, top príspevky, štatistiky), ak existuje.
- Tlačidlá:
  - **Načítať a ohodnotiť diskusiu (~$)** stiahne príspevky a ohodnotí iba tie, ktoré ešte nie sú v cache.
  - **Aktualizovať: N nových (~$)** sa zobrazí pri pohľade z cache.
  - **Vygenerovať / Regenerovať zhrnutie (~$)**: pred regeneráciou blok ukáže, koľko príspevkov pribudlo od posledného zhrnutia, koľko z nich je užitočných a koľko nových by vstúpilo do výberu top N. Nové príspevky v zozname majú štítok „nový od zhrnutia“.
- Voliteľne v nastaveniach: *stiahnuť a ohodnotiť hneď* a *prvé zhrnutie automaticky*. Obe sú predvolene vypnuté.

## Stránka diskusie (`/d/`)
- Hore je ten istý blok (zhrnutie, zbalené top príspevky a štatistiky, náklady). Zhrnutie sa tu negeneruje samo, iba tlačidlom.
- Každý príspevok má farebný okraj a štítok. Xenofóbne príspevky a príspevky bez prínosu sa zbalia s odkazom „zobraziť“.
- Rozšírenie samo načíta všetky príspevky (tlačidlo „Zobraziť ďalších N“).
- **Prečítané:** príspevok je prečítaný, keď je aspoň z polovice na obrazovke dlhšie ako 1,5 s. Platí to aj pre karty v paneli článku.
  - Ak je zapnuté *Skrývať prečítané*, pri ďalšej návšteve vidíš len nové príspevky.
  - Prečítaný príspevok s novou reakciou zostane ako skrátený riadok, aby mala reakcia kontext.
  - V plávajúcom paneli je „Skrytých N prečítaných“ a tlačidlo **Zobraziť / Skryť**.

## Cache (nič sa neplatí dvakrát)
| kľúč | obsah | platnosť |
|---|---|---|
| `ts:v3:<postId>:<hash textu>` | odpovede TypeSafe | 90 dní; upravený text = nový záznam |
| `topic:<topicId>` | zhrnutie + náklady diskusie | 90 dní od poslednej návštevy; zhrnutie sa mení len tlačidlom |
| `snap:<topicId>` | posledná snímka príspevkov (pohľad z cache bez API) | 90 dní |
| `read:<topicId>` | prečítané príspevky | 90 dní |
| `costs:global` | súčet nákladov (zobrazený v nastaveniach) | trvalo |

- Rozbehnuté hodnotenia sa zdieľajú medzi tabmi, takže otvorený článok aj diskusia naraz nepošlú ten istý príspevok dvakrát.
- Zmena váh a prahov v nastaveniach sa prejaví bez nového volania modelu, lebo farby sa počítajú z uložených odpovedí.

## Náklady
Blok ukazuje cenu **tohto načítania** (TypeSafe), súčet **za diskusiu** (TypeSafe + Gemini) a cenu každého zhrnutia. Pred každou platenou akciou ukáže odhad. Namerané hodnoty:
- TypeSafe: ~1 750 tokenov na príspevok × 0,042 $/1M ≈ 0,00007 $. Diskusia so 120 príspevkami stojí ~0,009 $.
- Gemini 3.5 Flash-Lite (0,30 / 2,50 $ za 1M): ~1 750 vstupných + ~750 výstupných tokenov ≈ **0,0023 $ za zhrnutie**.

## Vývoj a testy
```bash
node --test tests/*.test.js                                          # 24 testov: lib/ + service worker vo vm s falošným chrome.*
TYPESAFE_API_KEY=... GEMINI_API_KEY=... node scripts/live-check.mjs  # živý TypeSafe + Gemini (potrebuje lokálne dáta PoC)
node tests/build-test-bundle.mjs /tmp/bundle.js                      # bundle na injektovanie do stránky (Playwright addScriptTag)
```
Test bundle spúšťa v stránke **skutočný `background.js`**. Falošné sú len `chrome.*` (storage v `localStorage`, takže prežije reload) a AI API (`window.__mockCalls` počíta volania). Fórum sme.sk je skutočné.

## Obmedzenia
- Kľúče sú v `chrome.storage.local` (lokálne, nešifrované), čo je v poriadku pre osobné použitie.
- Selektory `.anz-post[data-post-id]`, `[data-topic-id]` a API `core-forum.sme.sk` nie sú zdokumentované a môžu sa zmeniť.
- „Pribudlo od zhrnutia“ porovnáva čas vzniku príspevkov s najnovším príspevkom v čase zhrnutia.
- `personal_attack` a sarkazmus sú najmenej spoľahlivé (AUC ~0,86), preto osobný útok iba penalizuje skóre a príspevok samostatne neskrýva.
