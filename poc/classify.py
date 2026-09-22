"""PoC: klasifikácia príspevkov z diskusie sme.sk cez TypeSafe (Jev).

Spúšťanie:  TYPESAFE_API_KEY=... python3 classify.py
Kľúč sa berie z prvej env premennej, ktorej názov obsahuje TYPESAFE (alebo JEV).
Vstup poc/posts.json (stiahnuté komentáre) nie je súčasťou repozitára – pozri poc/README.md.
"""
import json, os, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://api.typesafe.ai/v1/systemone"

def api_key():
    for k, v in os.environ.items():
        if ("JEV" in k.upper() or "TYPESAFE" in k.upper()) and v.strip():
            return v.strip()
    sys.exit("Chýba API kľúč (env premenná s JEV/TYPESAFE v názve).")

# ---- Otázky: jedna úzka judgment na otázku, všetky nad rovnakým state -> jeden request na príspevok
QUESTIONS = {
    "sentiment": {
        "type": "score",
        "instructions": "What is the emotional tone of `comment` (a reader comment in Slovak)? Judge the tone of the writing itself, not whether the author agrees with the article.",
        "criteria": [
            "Very negative: angry, contemptuous, hostile or disgusted",
            "Negative: irritated, complaining, dismissive or mocking",
            "Neutral: matter-of-fact, informational, calm",
            "Positive: friendly, appreciative, constructive or good-humoured",
        ],
    },
    "relevance": {
        "type": "score",
        "instructions": "How closely is `comment` related to the topic of `article` (Bolt taxi drivers cancelling airport rides to push prices up, pricing, platforms, airport taxi services)? Use `parent_comment` only to understand what the reply refers to.",
        "criteria": [
            "Off-topic: unrelated to the article or the thread",
            "Tangential: loosely connected, mostly about something else (e.g. the commenters, influencers' looks, unrelated anecdotes)",
            "On-topic: addresses the article's subject",
            "Central: directly addresses the core issue (ride cancellations, pricing, responsibility of drivers/Bolt/airport)",
        ],
    },
    "substance": {
        "type": "score",
        "instructions": "How much does `comment` add to the discussion of `article`? Judge informational and argumentative value, not tone or grammar.",
        "criteria": [
            "Nothing: emoji, one-liner, pure reaction, joke or insult with no content",
            "Bare opinion: states a view or feeling without support",
            "Supported: gives a reason, analogy, concrete personal experience or a relevant fact",
            "Valuable: new information, careful analysis, comparison with other places or a concrete proposed solution",
        ],
    },
    "writing": {
        "type": "score",
        "instructions": "How well is `comment` written as a piece of communication? Missing Slovak diacritics alone is common online and should not lower the rating much. Ignore whether you agree.",
        "criteria": [
            "Incoherent or unreadable",
            "Hard to follow, fragmentary or sloppy",
            "Clear enough, informal",
            "Clear, well-structured and precise",
        ],
    },
    "personal_attack": {
        "type": "noul",
        "instructions": {
            "question": "Does `comment` insult, mock or demean an individual person — another commenter (usually the author of `parent_comment`, addressed as 'ty'/'Vy'/'pán') or a named individual from the article such as the influencers?",
            "includes": "name-calling, questioning their intelligence, mocking their home town or origin, mock-helpful or ironic replies that ridicule the person, insulting their looks",
            "excludes": "derogatory remarks about a whole group (foreign drivers, a nationality) — that is a different question; sharp but impersonal disagreement with an argument; criticism of a company",
        },
        "criteria": {
            "true": "An individual person is ridiculed or insulted, openly or through irony",
            "false": "No individual person is ridiculed or insulted",
        },
    },
    "sarcasm": {
        "type": "noul",
        "instructions": "Is `comment` sarcastic or ironic, i.e. does it say something it does not literally mean in order to mock (for example fake sympathy or fake helpfulness towards `parent_comment`)?",
    },
    "group_hate": {
        "type": "noul",
        "instructions": "Does `comment` demean or stereotype people as a group based on nationality, ethnicity, origin, or Slovak region (e.g. slurs or mocking terms for foreign drivers, 'scum', mocking people from a region)?",
        "criteria": {
            "true": "Derogatory generalisation or slur about a national, ethnic or regional group",
            "false": "No group-based derogation; criticism of a company or of drivers' behaviour without reference to origin is not this",
        },
    },
    "vulgar": {
        "type": "noul",
        "instructions": "Does `comment` contain vulgar or profane language (including censored swear words like d***)?",
    },
    "kind": {
        "type": "choice",
        "instructions": "What is the primary function of `comment` in the discussion?",
        "criteria": {
            "experience": "Shares a personal experience with taxis, Bolt or airports",
            "argument": "Argues a position with reasons, analogies or analysis",
            "proposal": "Proposes a concrete solution or compares with how it works elsewhere",
            "question": "Asks a genuine question",
            "humor": "Joke, sarcasm or irony without much other content",
            "attack": "Mainly attacks or insults someone",
            "rant": "Venting frustration or anger without argument",
            "other": "Correction, emoji, off-topic remark or anything else",
        },
    },
    "stance": {
        "type": "choice",
        "instructions": "Whose side does `comment` take in the conflict described in `article`?",
        "criteria": {
            "customers": "Sides with passengers / the influencers; drivers' behaviour is unacceptable",
            "drivers": "Sides with the drivers or blames the passengers / influencers",
            "platform_blame": "Mainly blames Bolt, its algorithm or the airport arrangement",
            "none": "No clear stance or not about the conflict",
        },
    },
}

def ask(key, state, retries=4):
    body = json.dumps({"model": "jev-latest", "state": state, "questions": QUESTIONS}).encode()
    for attempt in range(retries):
        req = urllib.request.Request(API, data=body, method="POST", headers={
            "Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        try:
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=60) as r:
                out = json.load(r)
                out["_latency_s"] = round(time.time() - t0, 2)
                return out
        except urllib.error.HTTPError as e:
            if e.code in (429, 529, 500, 502, 503) and attempt < retries - 1:
                time.sleep(2 ** attempt); continue
            return {"error": f"HTTP {e.code}: {e.read().decode()[:300]}"}
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt); continue
            return {"error": repr(e)}

def main():
    key = api_key()
    data = json.load(open(os.path.join(HERE, "posts.json")))
    by_id = {p["id"]: p for p in data["posts"]}
    art = {"title": data["article"]["title"], "summary": data["article"]["summary"]}

    def run(p):
        parent = by_id.get(p["parent_id"])
        state = {"article": art,
                 "parent_comment": parent["text"] if parent else None,
                 "comment": p["text"]}
        return p["id"], ask(key, state)

    t0 = time.time()
    with ThreadPoolExecutor(6) as ex:
        results = dict(ex.map(run, data["posts"]))
    print(f"{len(results)} príspevkov za {time.time()-t0:.1f}s", file=sys.stderr)
    errs = {k: v["error"] for k, v in results.items() if "error" in v}
    if errs:
        print("Chyby:", json.dumps(errs, ensure_ascii=False, indent=1), file=sys.stderr)
    out = sys.argv[1] if len(sys.argv) > 1 else "results.json"
    json.dump(results, open(os.path.join(HERE, out), "w"), ensure_ascii=False, indent=1)

if __name__ == "__main__":
    main()
