#!/usr/bin/env python3
"""
Chord-sheet line classification — a Python port of the logic in static/js/chords.js.

Local lyric alignment needs the *same* set of lyric lines the browser will later try
to time, or the generated LRC won't match what the sheet renders. That classifier
only existed in JavaScript, so it is ported here verbatim rather than approximated:
`_CHORD_NAME_RE` in routes.py is unanchored and only ranks whole <pre> blocks, and
reusing it as a line classifier would call half the lyrics chords.

Zero dependencies — the server container has neither torch nor numpy, so this module
has to be importable from both the worker and the server.

Keep in sync with:
  CHORD_TOKEN_RE     chords.js:6
  SECTION_LINE_RE    chords.js:167
  isChordLine        chords.js:169
  isMetadataLine     chords.js:175
  parseChordSheet    chords.js:180
  assignTimestamps   chords.js:239   (which lyric lines get a timestamp)
"""
import re

# chords.js:6 — one chord token: Em, D, Am7, Gmaj7, F#m, Bb, G/B
CHORD_TOKEN_RE = re.compile(
    r"[A-G][#b]?(?:maj|min|sus|aug|dim|add|M|m)?[0-9]*"
    r"(?:/[A-G][#b]?(?:maj|min|sus|aug|dim|add|M|m)?[0-9]*)?"
)

# chords.js:167 — [Label] optional-rest
SECTION_LINE_RE = re.compile(r"\[([^\]]+)\]\s*(.*)")

# chords.js:175 — "Tono: G", "BPM: 120". JS \w is ASCII-only, so spell it out
# instead of letting Python's Unicode \w classify accented words as metadata.
_METADATA_RE = re.compile(r"[A-Za-z0-9_]+:\s")


def is_chord_line(line: str) -> bool:
    trimmed = line.strip()
    if not trimmed:
        return False
    return all(CHORD_TOKEN_RE.fullmatch(t) for t in trimmed.split())


def is_metadata_line(trimmed: str) -> bool:
    return bool(_METADATA_RE.match(trimmed))


def parse_chord_sheet(text: str) -> list[dict]:
    """Split a sheet into sections. Mirrors parseChordSheet() branch for branch.

    The five-branch precedence order and the `i += 2` chord/lyric consumption are
    load-bearing: change either and this silently stops agreeing with the browser.
    """
    lines = (text or "").split("\n")
    sections: list[dict] = []
    i = 0

    while i < len(lines):
        line = lines[i]
        trimmed = line.strip()

        if not trimmed:
            i += 1
            continue

        # Section label: [Primera Parte] or [Intro] Em D C ...
        section_match = SECTION_LINE_RE.fullmatch(trimmed)
        if section_match:
            label = section_match.group(1).strip()
            rest = section_match.group(2).strip()
            if not rest:
                sections.append({"section_label": label, "chord_line": "",
                                 "lyric_line": "", "is_metadata": False})
            elif is_chord_line(rest):
                sections.append({"section_label": label, "chord_line": rest,
                                 "lyric_line": "", "is_metadata": False})
            else:
                sections.append({"section_label": label, "chord_line": "",
                                 "lyric_line": rest, "is_metadata": False})
            i += 1
            continue

        # Metadata line: "Tono: G", "BPM: 120"
        if is_metadata_line(trimmed):
            sections.append({"section_label": None, "chord_line": "",
                             "lyric_line": trimmed, "is_metadata": True})
            i += 1
            continue

        # Chord line — original spacing kept, chords are positioned by column
        if is_chord_line(line):
            chord_line = line
            next_line = lines[i + 1] if i + 1 < len(lines) else ""
            next_trimmed = next_line.strip()
            if (next_trimmed and not is_chord_line(next_line)
                    and not SECTION_LINE_RE.fullmatch(next_trimmed)):
                sections.append({"section_label": None, "chord_line": chord_line,
                                 "lyric_line": next_line.rstrip(), "is_metadata": False})
                i += 2
            else:
                sections.append({"section_label": None, "chord_line": chord_line,
                                 "lyric_line": "", "is_metadata": False})
                i += 1
            continue

        # Lyric or other text line
        sections.append({"section_label": None, "chord_line": "",
                         "lyric_line": line.rstrip(), "is_metadata": False})
        i += 1

    return [s for s in sections
            if s["section_label"] is not None or s["chord_line"] or s["lyric_line"]]


def sheet_lyric_lines(text: str) -> list[str]:
    """Exactly the lines assignTimestamps() tries to time (chords.js:247)."""
    return [s["lyric_line"] for s in parse_chord_sheet(text)
            if s["lyric_line"] and not s["section_label"] and not s["is_metadata"]]


def plain_lyric_lines(text: str) -> list[str]:
    """Lyric lines out of LRCLIB plain lyrics — no chord lines to worry about.

    Section markers still turn up in plain lyrics ("[Chorus]") and nobody sings
    them, so they go the same way they do in a sheet.
    """
    out = []
    for raw in (text or "").split("\n"):
        trimmed = raw.strip()
        if not trimmed:
            continue
        if SECTION_LINE_RE.fullmatch(trimmed) or is_metadata_line(trimmed):
            continue
        out.append(raw.rstrip())
    return out


# ── Cleaning for the aligner ──────────────────────────────────────────────────
# What reaches Whisper has to be what the singer actually sings. The emitted LRC
# still carries the *original* line, so smartMatchLyrics() re-matches it against
# the sheet at near-identical scores.

# Held-note padding: "you____u", "thro_____ugh". Same rule as wordOverlapScore
# (chords.js:327) — dropping the underscores alone leaves a doubled letter.
_HELD_DOUBLED_RE = re.compile(r"([A-Za-z0-9])_+\1", re.IGNORECASE)
_HELD_TAIL_RE = re.compile(r"_+")

# Repeat counts the sheet writes once but the singer sings twice: (x2) (2x) (bis)
_REPEAT_RE = re.compile(r"\(\s*(?:x\s*\d+|\d+\s*x|bis)\s*\)", re.IGNORECASE)

# A whole line that is only a marker: -CHORUS-, --- SOLO ---
_DASH_MARKER_RE = re.compile(r"-+[^-]*-+")

_HAS_WORD_RE = re.compile(r"[^\W_]", re.UNICODE)

# Structural labels a sheet writes as ordinary text. Only unambiguous ones live
# here: "solo" and "final" are also real Spanish words and could genuinely be sung,
# so they are caught by the trailing-colon rule instead or not at all.
_SECTION_WORDS = {
    "coro", "estribillo", "precoro", "verso", "estrofa", "puente", "punteo",
    "intro", "introduccion", "outro", "interludio", "instrumental",
    "chorus", "prechorus", "verse", "bridge", "refrain",
}
_ACCENTS = str.maketrans("áàäâãéèëêíìïîóòöôõúùüûñç", "aaaaaeeeeiiiiooooouuuunc")

# A chord group the parser's per-token check can't see: "Dm-Gm-Cm-F-A#" is one
# whitespace token, so is_chord_line() rejects the whole line and it falls through
# to the lyric branch. Rare (2 lines in 35 sheets) but it reaches the aligner as
# words to find in the audio, which is strictly worse than dropping it.
_CHORD_GROUP_SEP_RE = re.compile(r"[-–/|,]")


def _is_chord_only(text: str) -> bool:
    tokens = text.split()
    if not tokens:
        return False
    for token in tokens:
        parts = [p for p in _CHORD_GROUP_SEP_RE.split(token) if p]
        if not parts or not all(CHORD_TOKEN_RE.fullmatch(p) for p in parts):
            return False
    return True


def _is_section_header(text: str) -> bool:
    """A label, not a line to sing. Deliberately narrow — a false positive here
    silently deletes a real lyric line from the alignment."""
    words = text.split()
    # "Punteo del puente:", "Coro:", "Solo:" — a sung line practically never ends
    # in a colon, which makes this the safest signal available.
    if text.endswith(":") and len(words) <= 4:
        return True
    # A single bare label, with or without a number: "Coro", "Verso2", "Verso 2"
    if 1 <= len(words) <= 2:
        head = re.sub(r"[^a-z]", "", words[0].lower().translate(_ACCENTS))
        tail_is_number = len(words) == 1 or re.fullmatch(r"[0-9ivx]+", words[1].lower())
        if head in _SECTION_WORDS and tail_is_number:
            return True
    return False


def clean_for_align(line: str) -> str:
    """Strip what the singer doesn't sing. "" means the line isn't sung at all.

    Whisper is asked to place every line it is given (`original_split=True`), so a
    chord row or a section label handed to it doesn't get skipped — it gets placed
    somewhere, stealing time from a real neighbouring line. Dropping it is the only
    safe option.

    This is deliberately narrower than sheet_lyric_lines(), which must keep matching
    the browser byte for byte. What gets *rendered* and what gets *aligned* are two
    different questions, so filtering here needs no change in chords.js.
    """
    text = _HELD_DOUBLED_RE.sub(r"\1", line or "")
    text = _HELD_TAIL_RE.sub("", text)
    text = _REPEAT_RE.sub(" ", text)
    text = " ".join(text.split())
    if not text:
        return ""
    if _DASH_MARKER_RE.fullmatch(text):
        return ""
    # No letters or digits left (stray punctuation, "( )") — nothing to align to
    if not _HAS_WORD_RE.search(text):
        return ""
    if _is_chord_only(text) or _is_section_header(text):
        return ""
    return text


def align_pairs(lines: list[str]) -> list[tuple[str, str]]:
    """[(original, cleaned)] with pure-marker lines dropped."""
    pairs = []
    for line in lines:
        cleaned = clean_for_align(line)
        if cleaned:
            pairs.append((line, cleaned))
    return pairs
