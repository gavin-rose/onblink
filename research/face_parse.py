"""Detect blinks, long blinks and winks from SmartSpectra face landmarks.

Reads a recording saved by the exploratory recorder and compares landmark-based
eye closures with the SDK's own blink flag and with any keypress markers.

Usage: python3 face_parse.py recording.json [--trace] [--csv out.csv]
"""

import argparse
import json
import math
import statistics
import sys

RIGHT_EYE = (33, 160, 158, 133, 153, 144)
LEFT_EYE = (362, 385, 387, 263, 373, 380)

WINK_R_MIN_L = 0.93
WINK_R_MAX_R = 0.75
WINK_L_MIN_R = 0.66
WINK_L_MAX_L = 0.86
LONG_MS = 550
WINK_MIN_MS = 300
WEAK = 0.7
KINDS = ["blink", "long", "wink_R", "wink_L", "weak", "MISSED"]


def dist(a, b):
    """Return the distance between two landmark points."""
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


def ear(pts, idx):
    """Return the eye aspect ratio for the six landmark indices in idx."""
    p1, p2, p3, p4, p5, p6 = (pts[i] for i in idx)
    horiz = dist(p1, p4)
    return (dist(p2, p6) + dist(p3, p5)) / (2 * horiz) if horiz else 0.0


def collect(events):
    """Group landmarks, SDK blink and talking flags by sample timestamp."""
    frames = {}
    for e in events:
        if e["type"] != "face":
            continue
        face = e["face"]
        for lm in face.get("landmarks", []):
            frames.setdefault(int(lm["timestamp"]), {})["pts"] = lm["value"]
        for b in face.get("blinking", []):
            frames.setdefault(int(b["timestamp"]), {})["sdk_blink"] = bool(b.get("detected"))
        for t in face.get("talking", []):
            frames.setdefault(int(t["timestamp"]), {})["talking"] = bool(t.get("detected"))
    return frames


def load_frames(path):
    """Load a recording and return per-frame rows and markers in seconds."""
    with open(path, encoding="utf-8") as f:
        events = json.load(f)["events"]
    frames = collect(events)
    t0 = min(frames)
    markers = [
        ((e["arrivalMs"] * 1000 - t0) / 1e6, e["label"])
        for e in events if e["type"] == "marker"
    ]
    rows = []
    for ts in sorted(frames):
        fr = frames[ts]
        if "pts" not in fr:
            continue
        rows.append({
            "t": (ts - t0) / 1e6,
            "r": ear(fr["pts"], RIGHT_EYE),
            "l": ear(fr["pts"], LEFT_EYE),
            "sdk": fr.get("sdk_blink", False),
            "talk": fr.get("talking", False),
        })
    return rows, markers


def segments(rows, pred):
    """Return (start, end) index pairs of consecutive rows matching pred."""
    out, start = [], None
    for i, row in enumerate(rows):
        if pred(row) and start is None:
            start = i
        elif not pred(row) and start is not None:
            out.append((start, i - 1))
            start = None
    if start is not None:
        out.append((start, len(rows) - 1))
    return out


def classify(ev):
    """Label a closure event as blink, long, wink_R, wink_L or weak."""
    held = ev["dur_ms"] >= WINK_MIN_MS and not ev["sdk"]
    if held and ev["min_l"] >= WINK_R_MIN_L and ev["min_r"] < WINK_R_MAX_R:
        return "wink_R"
    if held and ev["min_r"] >= WINK_L_MIN_R and ev["min_l"] < WINK_L_MAX_L:
        return "wink_L"
    if not ev["sdk"] and ev["min_r"] >= WEAK and ev["min_l"] >= WEAK:
        return "weak"
    if ev["dur_ms"] >= LONG_MS:
        return "long"
    return "blink"


def normalize(rows, drop_r, drop_l, window):
    """Scale each eye by its rolling median and mark frames that look closed."""
    r_base = statistics.median(r["r"] for r in rows)
    l_base = statistics.median(r["l"] for r in rows)
    j = k = 0
    for row in rows:
        while rows[j]["t"] < row["t"] - window / 2:
            j += 1
        while k < len(rows) and rows[k]["t"] <= row["t"] + window / 2:
            k += 1
        win = rows[j:k]
        rb = statistics.median(x["r"] for x in win) if window else r_base
        lb = statistics.median(x["l"] for x in win) if window else l_base
        row["rn"] = row["r"] / rb
        row["ln"] = row["l"] / lb
        row["rc"] = row["rn"] < 1 - drop_r
        row["lc"] = row["ln"] < 1 - drop_l
    return r_base, l_base


def merged_closures(rows, merge):
    """Return closure segments, joining ones split by short open gaps."""
    segs = []
    for s, e in segments(rows, lambda x: x["rc"] or x["lc"]):
        if segs and s - segs[-1][1] <= merge + 1:
            segs[-1] = (segs[-1][0], e)
        else:
            segs.append((s, e))
    return segs


def make_event(rows, s, e):
    """Summarize rows[s..e] as a classified closure event."""
    seg = rows[s:e + 1]
    near = range(max(0, s - 3), min(len(rows), e + 4))
    ev = {
        "start": seg[0]["t"],
        "end": seg[-1]["t"],
        "dur_ms": (seg[-1]["t"] - seg[0]["t"]) * 1000 + 33,
        "frames": len(seg),
        "min_r": min(x["rn"] for x in seg),
        "min_l": min(x["ln"] for x in seg),
        "sdk": any(rows[i]["sdk"] for i in near),
    }
    ev["kind"] = classify(ev)
    return ev


def detect(rows, drop_r, drop_l, window, merge):
    """Find eye closure events and return baselines plus the events."""
    r_base, l_base = normalize(rows, drop_r, drop_l, window)
    events = [make_event(rows, s, e) for s, e in merged_closures(rows, merge) if e > s]
    return r_base, l_base, events


def match_markers(events, markers, before=2.0, after=0.3):
    """Pair each marker with the closest unused event that ended near it."""
    used = set()
    pairs = []
    for mt, label in markers:
        best = None
        for i, ev in enumerate(events):
            if i in used or not mt - before <= ev["end"] <= mt + after:
                continue
            if best is None or abs(mt - ev["end"]) < abs(mt - events[best]["end"]):
                best = i
        if best is not None:
            used.add(best)
        pairs.append((mt, label, events[best] if best is not None else None))
    return pairs, used


def print_matches(pairs):
    """Print each marker next to the event it matched."""
    print(f"{'mark_t':>7} {'label':<7} {'det':<7} {'dur_ms':>7} "
          f"{'minR':>5} {'minL':>5} {'R-L':>6} sdk")
    for mt, label, ev in pairs:
        if not ev:
            print(f"{mt:7.2f} {label:<7} MISSED")
            continue
        print(f"{mt:7.2f} {label:<7} {ev['kind']:<7} {ev['dur_ms']:7.0f} "
              f"{ev['min_r']:5.2f} {ev['min_l']:5.2f} {ev['min_r'] - ev['min_l']:6.2f} "
              f"{'Y' if ev['sdk'] else '-'}")


def print_confusion(pairs):
    """Print a marker-by-detection count table."""
    print("\nconfusion (rows=marker, cols=detected)")
    print(f"{'':<8}" + "".join(f"{k:>8}" for k in KINDS))
    for lab in sorted({p[1] for p in pairs}):
        found = [p[2]["kind"] if p[2] else "MISSED" for p in pairs if p[1] == lab]
        print(f"{lab:<8}" + "".join(f"{found.count(k):>8}" for k in KINDS))


def score(events, markers):
    """Report how well detected events line up with keypress markers."""
    pairs, used = match_markers(events, markers)
    matched = sum(1 for p in pairs if p[2])
    print(f"\nmarkers={len(markers)} matched={matched} "
          f"unmatched_detections={len(events) - len(used)}")
    print_matches(pairs)
    print_confusion(pairs)
    extra = [(round(e["start"], 2), e["kind"], round(e["dur_ms"]))
             for i, e in enumerate(events) if i not in used]
    if extra:
        print("\nunmatched detections:", extra)


def write_csv(rows, path):
    """Write per-frame eye values to a csv file."""
    with open(path, "w", encoding="utf-8") as f:
        f.write("t,ear_r,ear_l,rn,ln,sdk_blink,talking\n")
        for r in rows:
            f.write(f"{r['t']:.3f},{r['r']:.4f},{r['l']:.4f},{r['rn']:.3f},"
                    f"{r['ln']:.3f},{int(r['sdk'])},{int(r['talk'])}\n")


def print_trace(rows, markers):
    """Print a per-frame bar chart of both eyes with SDK and marker flags."""
    for r in rows:
        bar_r = "#" * int(r["rn"] * 20)
        bar_l = "#" * int(r["ln"] * 20)
        flag = "SDK" if r["sdk"] else ""
        flag += " " + " ".join(lab.upper() for mt, lab in markers if abs(mt - r["t"]) < 0.017)
        print(f"{r['t']:6.2f}  R {r['rn']:.2f} {bar_r:<26} L {r['ln']:.2f} {bar_l:<26} {flag}")


def print_summary(rows, events, args, baselines):
    """Print detected events and SDK blinks that had no landmark event."""
    sdk_events = segments(rows, lambda x: x["sdk"])
    print(f"frames={len(rows)} span={rows[-1]['t']:.1f}s "
          f"baseline EAR R={baselines[0]:.3f} L={baselines[1]:.3f}")
    print(f"sdk blink frames={sum(1 for r in rows if r['sdk'])} "
          f"sdk blink events={len(sdk_events)}")
    print(f"landmark events (drop R>{args.drop_r:.0%} L>{args.drop_l:.0%}): {len(events)}")
    print(f"{'start':>7} {'dur_ms':>7} {'fr':>3} {'kind':<7} {'minR':>5} {'minL':>5} sdk")
    for ev in events:
        print(f"{ev['start']:7.2f} {ev['dur_ms']:7.0f} {ev['frames']:3d} {ev['kind']:<7} "
              f"{ev['min_r']:5.2f} {ev['min_l']:5.2f} {'Y' if ev['sdk'] else '-'}")
    missed = [round(rows[s[0]]["t"], 2) for s in sdk_events
              if not any(abs(rows[s[0]]["t"] - ev["start"]) < 0.3 for ev in events)]
    if missed:
        print("sdk events with no landmark event:", missed)


def parse_args():
    """Parse command line options."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n", maxsplit=1)[0])
    ap.add_argument("path")
    ap.add_argument("--drop-r", type=float, default=0.25,
                    help="fractional right EAR drop from baseline to count as closed")
    ap.add_argument("--drop-l", type=float, default=0.15,
                    help="fractional left EAR drop from baseline to count as closed")
    ap.add_argument("--merge", type=int, default=4,
                    help="merge closures separated by at most this many open frames")
    ap.add_argument("--window", type=float, default=3.0,
                    help="rolling baseline window in seconds, 0 for global median")
    ap.add_argument("--trace", action="store_true", help="print per-frame EAR")
    ap.add_argument("--csv", help="write per-frame data to csv")
    return ap.parse_args()


def main():
    """Run the analysis on one recording."""
    args = parse_args()
    rows, markers = load_frames(args.path)
    r_base, l_base, events = detect(rows, args.drop_r, args.drop_l, args.window, args.merge)
    if args.csv:
        write_csv(rows, args.csv)
    if args.trace:
        print_trace(rows, markers)
        return
    print_summary(rows, events, args, (r_base, l_base))
    if markers:
        score(events, markers)


if __name__ == "__main__":
    sys.exit(main())
