"""Rank face landmark features by how well they separate labeled eye actions.

Reads a recording with keypress markers (blink, long, wink_L, wink_R) and scores
every near-vertical eye landmark gap, iris height, brow and cheek offset.

Usage: python3 feature_search.py recording.json [--top N]
"""

import argparse
import itertools
import json
import math
import statistics

REGIONS = {
    "Reye": [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
    "Leye": [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
    "Riris": [468, 469, 470, 471, 472],
    "Liris": [473, 474, 475, 476, 477],
    "Rbrow": [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
    "Lbrow": [300, 293, 334, 296, 336, 285, 295, 282, 283, 276],
    "Rcheek": [50, 101, 118, 117, 123],
    "Lcheek": [280, 330, 347, 346, 352],
}
EYE_OF = {"R": (33, 133), "L": (362, 263)}
MAX_GAP_DX = 12
TESTS = {
    "blink vs wink_R": (["blink"], ["wink_R"]),
    "long vs wink_R": (["long"], ["wink_R"]),
    "wink_L vs blink+long": (["wink_L"], ["blink", "long"]),
    "wink_L vs wink_R": (["wink_L"], ["wink_R"]),
    "L closes (blink,long,wink_L) vs wink_R": (["blink", "long", "wink_L"], ["wink_R"]),
    "R closes (blink,long,wink_R) vs wink_L": (["blink", "long", "wink_R"], ["wink_L"]),
}


def load(path):
    """Return frame times in seconds, landmark frames and markers."""
    with open(path, encoding="utf-8") as f:
        events = json.load(f)["events"]
    frames = {}
    for e in events:
        if e["type"] == "face":
            for lm in e["face"].get("landmarks", []):
                frames[int(lm["timestamp"])] = lm["value"]
    t0 = min(frames)
    ts = sorted(frames)
    markers = [
        ((e["arrivalMs"] * 1000 - t0) / 1e6, e["label"])
        for e in events if e["type"] == "marker"
    ]
    return [(t - t0) / 1e6 for t in ts], [frames[t] for t in ts], markers


def features(pts):
    """Compute candidate features for one frame, scaled by interocular distance."""
    iod = math.dist((pts[33]["x"], pts[33]["y"]), (pts[263]["x"], pts[263]["y"]))
    out = {}
    for side, region in (("R", "Reye"), ("L", "Leye")):
        for a, b in itertools.combinations(REGIONS[region], 2):
            out[f"{side}gap{a}-{b}"] = abs(pts[a]["y"] - pts[b]["y"]) / iod
    for name in ("Riris", "Liris"):
        ys = [pts[i]["y"] for i in REGIONS[name]]
        out[f"{name}_h"] = (max(ys) - min(ys)) / iod
    for name in ("Rbrow", "Lbrow", "Rcheek", "Lcheek"):
        a, b = EYE_OF[name[0]]
        cy = (pts[a]["y"] + pts[b]["y"]) / 2
        out[f"{name}_dy"] = (statistics.mean(pts[i]["y"] for i in REGIONS[name]) - cy) / iod
    return out


def is_vertical(key, ref):
    """Keep non-gap features and gaps between points roughly above each other."""
    if "gap" not in key:
        return True
    a, b = key[4:].split("-")
    return abs(ref[int(a)]["x"] - ref[int(b)]["x"]) < MAX_GAP_DX


class FeatureTable:
    """Per-marker feature responses relative to a short pre-action baseline."""

    def __init__(self, times, pts, markers):
        feats = [features(p) for p in pts]
        ref = pts[len(pts) // 2]
        self.keys = [k for k in feats[0] if is_vertical(k, ref)]
        self.times = times
        self.series = {k: [f[k] for f in feats] for k in self.keys}
        self.windows = {}
        for mt, label in markers:
            self.windows.setdefault(label, []).append((mt - 1.4, mt - 0.05))
        self.table = {
            k: {lab: [self.extreme(k, lo, hi) for lo, hi in wins]
                for lab, wins in self.windows.items()}
            for k in self.keys
        }

    def base(self, key, t):
        """Median of a feature in the second before time t."""
        vals = [self.series[key][i] for i, ti in enumerate(self.times) if t - 1.6 <= ti <= t - 0.4]
        return statistics.median(vals) if vals else statistics.median(self.series[key])

    def extreme(self, key, lo, hi):
        """Largest relative change of a feature between lo and hi."""
        b = self.base(key, lo)
        vals = [self.series[key][i] - b for i, ti in enumerate(self.times) if lo <= ti <= hi]
        return max(vals, key=abs) / (abs(b) + 1e-3) if vals else 0.0

    def separation(self, key, group_a, group_b):
        """Return (d-prime, gap) between two groups of labels for one feature."""
        va = [x for lab in group_a for x in self.table[key][lab]]
        vb = [x for lab in group_b for x in self.table[key][lab]]
        if statistics.mean(va) < statistics.mean(vb):
            gap = min(vb) - max(va)
        else:
            gap = min(va) - max(vb)
        spread = statistics.pstdev(va) + statistics.pstdev(vb) + 1e-6
        return abs(statistics.mean(va) - statistics.mean(vb)) / spread, gap

    def means(self, key):
        """Mean response per label, formatted for printing."""
        return "  ".join(f"{lab}={statistics.mean(self.table[key][lab]):+.2f}"
                         for lab in sorted(self.windows))


def report(ft, top):
    """Print the best separating features for each comparison."""
    for name, (group_a, group_b) in TESTS.items():
        ranked = sorted(ft.keys, key=lambda k, a=group_a, b=group_b: -ft.separation(k, a, b)[0])
        print(f"\n== {name}  (score=d', gap>0 means perfectly separable)")
        for k in ranked[:top]:
            d, gap = ft.separation(k, group_a, group_b)
            print(f"  {k:<16} d'={d:5.2f} gap={gap:+.3f}  {ft.means(k)}")


def main():
    """Run the feature search on one recording."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n", maxsplit=1)[0])
    ap.add_argument("path")
    ap.add_argument("--top", type=int, default=8)
    args = ap.parse_args()
    report(FeatureTable(*load(args.path)), args.top)


if __name__ == "__main__":
    main()
