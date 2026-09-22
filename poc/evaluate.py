"""Vyhodnotí results.json voči gold.json a vypočíta kompozitné skóre + farbu (politika je čisto v kóde)."""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(HERE, "posts.json")))
import sys
res = json.load(open(os.path.join(HERE, sys.argv[1] if len(sys.argv) > 1 else "results.json")))
gold = json.load(open(os.path.join(HERE, "gold.json")))

# ---- Politika (váhy a prahy sa dajú meniť bez nového volania modelu)
W = {"substance": 0.45, "relevance": 0.30, "writing": 0.25}
def verdict(a):
    n = lambda q, mx: a[q]["score"] / mx
    base = W["substance"] * n("substance", 3) + W["relevance"] * n("relevance", 3) + W["writing"] * n("writing", 3)
    penalty = 0.35 * a["personal_attack"]["noul"] + 0.10 * a["vulgar"]["noul"]
    q = max(0.0, base - penalty)
    if a["group_hate"]["noul"] > 0.6: return q, "hidden", "xenofóbia/hate"
    if q < 0.25: return q, "hidden", "nízka kvalita"
    if q < 0.45: return q, "red", ""
    if q < 0.65: return q, "yellow", ""
    return q, "green", ""

def auc(scores, labels):
    pos = [s for s, l in zip(scores, labels) if l]; neg = [s for s, l in zip(scores, labels) if not l]
    return sum((p > n) + 0.5 * (p == n) for p in pos for n in neg) / (len(pos) * len(neg))

def prf(scores, labels, t=0.5):
    tp = sum(s > t and l for s, l in zip(scores, labels)); fp = sum(s > t and not l for s, l in zip(scores, labels))
    fn = sum(s <= t and l for s, l in zip(scores, labels))
    return tp / max(tp + fp, 1), tp / max(tp + fn, 1)

def spearman(x, y):
    rk = lambda v: {i: r for r, i in enumerate(sorted(range(len(v)), key=lambda i: v[i]))}
    # priemerné poradie pri zhodách
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i]); r = [0] * len(v); i = 0
        while i < len(v):
            j = i
            while j + 1 < len(v) and v[order[j + 1]] == v[order[i]]: j += 1
            for k in range(i, j + 1): r[order[k]] = (i + j) / 2
            i = j + 1
        return r
    rx, ry = ranks(x), ranks(y); mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    return cov / (sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) ** 0.5

posts = data["posts"]; ids = [p["id"] for p in posts]
A = {i: res[i]["answers"] for i in ids}
out = []
print(f"{'id':>8} d  sent  rel  subs wri  att  hate vulg  kind        stance          Q    verdict")
for p in posts:
    a = A[p["id"]]; q, color, why = verdict(a)
    out.append({**p, "answers": a, "quality": round(q, 3), "color": color, "reason": why})
    print(f"{p['id'][-5:]:>8} {p['depth']}  {a['sentiment']['score']:.2f}  {a['relevance']['score']:.2f} {a['substance']['score']:.2f} {a['writing']['score']:.2f}"
          f"  {a['personal_attack']['noul']:.2f} {a['group_hate']['noul']:.2f} {a['vulgar']['noul']:.2f}  {a['kind']['choice']:<11} {a['stance']['choice']:<14} {q:.2f} {color} {why}"
          f"   | {p['text'][:60].replace(chr(10),' ')}")

print("\n=== Kvalita voči ručným anotáciám ===")
for q, key in [("personal_attack", "attack"), ("group_hate", "hate"), ("sarcasm", "sarcasm")]:
    if q not in A[ids[0]]: continue
    s = [A[i][q]["noul"] for i in ids]; l = [i in gold[key] for i in ids]
    p, r = prf(s, l)
    print(f"{q:16} AUC={auc(s, l):.2f}  P@0.5={p:.2f}  R@0.5={r:.2f}  (pozitívnych {sum(l)}/{len(l)})")
    miss = [i for i in ids if (A[i][q]["noul"] > 0.5) != (i in gold[key])]
    for i in miss:
        print(f"   nezhoda {i[-5:]} model={A[i][q]['noul']:.2f} gold={'1' if i in gold[key] else '0'} | {next(p['text'] for p in posts if p['id']==i)[:90]!r}")
g = [gold["contrib"][i] for i in ids]
for q in ["substance", "relevance", "writing"]:
    print(f"spearman(gold_contrib, {q:9}) = {spearman(g, [A[i][q]['score'] for i in ids]):.2f}")
print(f"spearman(gold_contrib, quality  ) = {spearman(g, [o['quality'] for o in out]):.2f}")
conf = {q: sum(A[i][q]["confidence"] for i in ids) / len(ids) for q in ["sentiment", "relevance", "substance", "writing", "kind", "stance"]}
print("priemerná confidence:", {k: round(v, 2) for k, v in conf.items()})
from collections import Counter
print("farby:", Counter(o["color"] for o in out))
lat = [res[i]["_latency_s"] for i in ids]; tok = [res[i]["usage"]["input_tokens"] for i in ids]
print(f"latencia/príspevok: median {sorted(lat)[len(lat)//2]}s, max {max(lat)}s; input tokens median {sorted(tok)[len(tok)//2]}")
json.dump({"article": data["article"], "posts": out}, open(os.path.join(HERE, "scored.json"), "w"), ensure_ascii=False, indent=1)
