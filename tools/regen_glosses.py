#!/usr/bin/env python3
"""Regenerate the ``g`` (gloss) field of data/hsk.js from CC-CEDICT.

Usage:
    curl -LO https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz
    gunzip cedict_1_0_ts_utf-8_mdbg.txt.gz
    python3 tools/regen_glosses.py cedict_1_0_ts_utf-8_mdbg.txt

Keeps the word list and tone-marked pinyin untouched; only the glosses
are rebuilt. For heteronyms (得 dé/děi/de) the CEDICT entry whose pinyin
matches the HSK pinyin — tone marks and capitalisation included — wins.

CC-CEDICT is © its editors, CC BY-SA 4.0 (https://cc-cedict.org).
"""
import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

HSK_PATH = Path(__file__).resolve().parent.parent / "data" / "hsk.js"

# ── numbered pinyin -> tone marks ─────────────────────────────────────
TONE_MARKS = {
    "a": "aāáǎàa", "e": "eēéěèe", "i": "iīíǐìi",
    "o": "oōóǒòo", "u": "uūúǔùu", "ü": "üǖǘǚǜü",
}

def mark_syllable(syl: str) -> str:
    syl = syl.replace("u:", "ü").replace("U:", "Ü").replace("v", "ü").replace("V", "Ü")
    m = re.match(r"^([A-Za-zü Ü]+)([1-5])$", syl)
    if not m:
        return syl  # punctuation, "xx", numbers etc.
    body, tone = m.group(1), int(m.group(2))
    if tone == 5:
        return body
    lower = body.lower()
    # placement: a/e always take the mark; ou -> o; else last vowel
    if "a" in lower:
        idx = lower.index("a")
    elif "e" in lower:
        idx = lower.index("e")
    elif "ou" in lower:
        idx = lower.index("o")
    else:
        idx = max((lower.rfind(v) for v in "iouü"), default=-1)
        if idx < 0:
            return body
    ch = body[idx]
    marked = TONE_MARKS.get(ch.lower(), ch)[tone]
    if ch.isupper():
        marked = marked.upper()
    return body[:idx] + marked + body[idx + 1:]

def marked_pinyin(numbered: str) -> str:
    return " ".join(mark_syllable(s) for s in numbered.split())

def norm(p: str) -> str:
    """Normalise pinyin for comparison: NFC, lowercase, strip separators."""
    p = unicodedata.normalize("NFC", p or "")
    return re.sub(r"[\s'’\-·]+", "", p).lower()

# ── def cleanup ───────────────────────────────────────────────────────
SKIP_RE = re.compile(
    r"^(CL:|variant of|old variant of|erhua variant|archaic variant|see \S+$|see also |"
    r"also written|also pr\.|also called|used in |\(bound form\)$|Taiwan pr\.)",
    re.I,
)
HAN_PAIR = re.compile(r"([㐀-鿿]+)\|([㐀-鿿]+)")
BRACKET_PY = re.compile(r"\[[^\]]*\]")

def clean_def(d: str) -> str:
    d = HAN_PAIR.sub(r"\2", d)                 # trad|simp -> simp
    d = BRACKET_PY.sub("", d)                  # drop [pin1 yin1] refs
    d = re.sub(r"\s*\(CL:[^)]*\)", "", d)      # classifier noise
    d = re.sub(r"^\(bound form\)\s*", "", d)   # meaningless to learners
    d = re.sub(r"\s{2,}", " ", d).strip()
    d = re.sub(r"\s+([,;.!?)])", r"\1", d)
    return d

def build_gloss(defs: list) -> str:
    keep, fallback = [], []
    for d in defs:
        d = d.strip()
        if not d:
            continue
        if SKIP_RE.match(d) or re.match(r"^surname [A-Z]", d):
            fallback.append(d)
            continue
        keep.append(clean_def(d))
    if not keep:
        keep = [clean_def(d) for d in fallback if d]
    if not keep:
        return ""
    # An over-long first def is usually "X, long appositive explanation" —
    # the head noun alone is the better worksheet gloss.
    if len(keep[0]) > 48 and ", " in keep[0]:
        keep[0] = keep[0].split(", ", 1)[0]
    out = keep[0]
    for d in keep[1:3]:
        if len(out) + 2 + len(d) > 48:
            break
        out += "; " + d
    if len(out) > 70:
        cut = max(out.rfind(",", 0, 64), out.rfind(" ", 0, 64))
        out = out[: cut if cut > 20 else 64].rstrip(" ,;") + "…"
    return out

def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    cedict_path = sys.argv[1]

    cedict = defaultdict(list)  # simplified -> [(numbered_pinyin, [defs])]
    with open(cedict_path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("#"):
                continue
            m = re.match(r"^(\S+) (\S+) \[([^\]]+)\] /(.+)/\s*$", line)
            if not m:
                continue
            _trad, simp, pinyin, defs = m.groups()
            cedict[simp].append((pinyin, defs.split("/")))

    def pick_entry(word, hsk_pinyin):
        cands = cedict.get(word)
        if not cands:
            return None
        target = norm(hsk_pinyin)
        upper = bool(hsk_pinyin[:1].isupper()) if hsk_pinyin else False
        scored = []
        for numbered, defs in cands:
            marked = marked_pinyin(numbered)
            score = 0
            if norm(marked) == target:
                score += 2
                if marked[:1].isupper() == upper:
                    score += 1
            elif not target:
                score += 1
            scored.append((score, numbered, defs))
        best = max(s for s, _, _ in scored)
        if best == 0 and target:
            lower = [t for t in scored if not marked_pinyin(t[1])[:1].isupper()]
            merged = lower or scored
        else:
            merged = [t for t in scored if t[0] == best]
        # Richer entries first: the core sense of a char has many defs,
        # minor homographs (onomatopoeia etc.) have one or two.
        merged.sort(key=lambda t: len(t[2]), reverse=True)
        defs = []
        for _, _, ds in merged:
            defs.extend(ds)
        return defs

    src = HSK_PATH.read_text(encoding="utf-8")
    m = re.match(r"^window\.HSK_LISTS\s*=\s*(\{.*\})\s*;?\s*$", src, re.S)
    data = json.loads(m.group(1))

    changed = missing = 0
    for items in data.values():
        for item in items:
            defs = pick_entry(item["w"], item.get("p", ""))
            if defs is None:
                missing += 1
                continue
            gloss = build_gloss(defs)
            if gloss and gloss != item["g"]:
                item["g"] = gloss
                changed += 1

    out = "window.HSK_LISTS = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n"
    HSK_PATH.write_text(out, encoding="utf-8")
    total = sum(len(v) for v in data.values())
    print(f"updated {changed} / {total} glosses; {missing} words not in CEDICT")

if __name__ == "__main__":
    main()
