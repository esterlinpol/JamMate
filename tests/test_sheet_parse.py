"""Tests for sheet_parse — the Python port of the chord/lyric line classifier.

The whole value of this module is agreeing with static/js/chords.js line for line:
if it disagrees, the aligner times lyrics the browser never renders and the sheet
silently stops following playback. All fabricated text, no audio, no server.

Run with `python tests/test_sheet_parse.py` or `pytest tests/`.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sheet_parse import (  # noqa: E402
    align_pairs, clean_for_align, is_chord_line, is_metadata_line,
    parse_chord_sheet, plain_lyric_lines, sheet_lyric_lines,
)


def check(name, cond):
    print(("  ok   " if cond else "  FAIL ") + name)
    return bool(cond)


def main():
    results = []
    r = results.append

    # ── is_chord_line: every token must be a chord ────────────────────────────
    r(check("plain chords", is_chord_line("Em  D   C")))
    r(check("extended chords", is_chord_line("Am7 Gmaj7 F#m Bb G/B")))
    r(check("indented chords keep counting", is_chord_line("        D")))
    r(check("one word breaks it", not is_chord_line("Em D and then C")))
    r(check("lyric that starts with a note letter", not is_chord_line("Dance with me")))
    r(check("empty is not a chord line", not is_chord_line("   ")))
    # "A" is a chord and also a word — same ambiguity the JS has, kept on purpose
    r(check("single-letter ambiguity matches JS", is_chord_line("A")))

    # ── is_metadata_line ──────────────────────────────────────────────────────
    r(check("key line is metadata", is_metadata_line("Tono: G")))
    r(check("bpm line is metadata", is_metadata_line("BPM: 120")))
    r(check("colon mid-sentence is not", not is_metadata_line("wait for me: now")))
    # JS \w is ASCII-only; Python's is not, so an accented word must NOT count
    r(check("accented word is not metadata", not is_metadata_line("Canción: uno")))

    # ── parse_chord_sheet: chord line consumes the lyric below it ─────────────
    sheet = "\n".join([
        "Tono: G",
        "[Intro] Em D C",
        "[Verso]",
        "Em          D",
        "one two three four",
        "C",
        "G",
        "five six seven",
        "",
        "eight nine ten",
    ])
    secs = parse_chord_sheet(sheet)
    r(check("metadata section flagged", secs[0]["is_metadata"] and secs[0]["lyric_line"] == "Tono: G"))
    r(check("label with chords keeps both",
            secs[1]["section_label"] == "Intro" and secs[1]["chord_line"] == "Em D C"))
    r(check("bare label has no lyric",
            secs[2]["section_label"] == "Verso" and not secs[2]["lyric_line"]))
    r(check("chord line paired with next lyric",
            secs[3]["chord_line"] == "Em          D"
            and secs[3]["lyric_line"] == "one two three four"))
    r(check("chord followed by chord stays unpaired",
            secs[4]["chord_line"] == "C" and secs[4]["lyric_line"] == ""))
    r(check("second chord takes the lyric",
            secs[5]["chord_line"] == "G" and secs[5]["lyric_line"] == "five six seven"))
    r(check("blank lines are skipped", secs[6]["lyric_line"] == "eight nine ten"))

    # ── sheet_lyric_lines: exactly what assignTimestamps() would time ─────────
    lines = sheet_lyric_lines(sheet)
    r(check("labels and metadata excluded",
            lines == ["one two three four", "five six seven", "eight nine ten"]))

    # Column positions are load-bearing in the sheet, so leading space survives
    indented = "      C\n   sing this line   "
    r(check("leading spaces preserved, trailing trimmed",
            sheet_lyric_lines(indented) == ["   sing this line"]))

    # ── plain_lyric_lines ─────────────────────────────────────────────────────
    plain = "[Chorus]\nfirst line\n\nsecond line\nTono: G\n"
    r(check("plain lyrics drop labels and metadata",
            plain_lyric_lines(plain) == ["first line", "second line"]))

    # ── clean_for_align ───────────────────────────────────────────────────────
    r(check("held-note doubling collapses", clean_for_align("mo____o") == "mo"))
    r(check("held note inside a word rejoins it", clean_for_align("thro____ugh") == "through"))
    r(check("repeat marker stripped", clean_for_align("sing along (x2)") == "sing along"))
    r(check("reversed repeat marker stripped", clean_for_align("sing along (2x)") == "sing along"))
    r(check("bis marker stripped", clean_for_align("sing along (bis)") == "sing along"))
    r(check("dash marker is pure marker", clean_for_align("-CHORUS-") == ""))
    r(check("spaced dash marker too", clean_for_align("--- SOLO ---") == ""))
    r(check("punctuation-only line drops", clean_for_align("( )") == ""))
    r(check("indentation collapses for the aligner",
            clean_for_align("    two   words  ") == "two words"))
    r(check("ordinary line untouched", clean_for_align("just a line") == "just a line"))

    # ── Not-sung lines the parser classifies as lyrics ────────────────────────
    # Whisper places every line it is given, so a chord row or a label handed to
    # it steals time from a real neighbouring line instead of being skipped.
    r(check("tab row dropped", clean_for_align("E|-----------|") == ""))
    r(check("long tab row dropped", clean_for_align("A|--------------------------") == ""))
    # is_chord_line() checks per whitespace token, so a hyphenated group hides
    # a whole chord row in the lyric branch
    r(check("hyphenated chord group dropped", clean_for_align("A# Dm-Gm-Cm-F-A#") == ""))
    r(check("indented chord row dropped", clean_for_align("   F    G   C-Bm-Am") == ""))
    r(check("comma-separated chords dropped", clean_for_align("Am, Em, G") == ""))

    r(check("bare label dropped", clean_for_align("Coro") == ""))
    r(check("label with colon dropped", clean_for_align("Coro:") == ""))
    r(check("numbered label dropped", clean_for_align("Verso2") == ""))
    r(check("spaced numbered label dropped", clean_for_align("Verso 2") == ""))
    r(check("roman-numeral label dropped", clean_for_align("Verso II") == ""))
    r(check("phrase ending in a colon dropped", clean_for_align("Punteo del puente:") == ""))

    # Guards — a false positive here silently deletes a real lyric line
    r(check("real line starting with a label word is kept",
            clean_for_align("Coro de angeles cantando") == "Coro de angeles cantando"))
    r(check("two-word line that isn't label+number is kept",
            clean_for_align("Coro final") == "Coro final"))
    r(check("ambiguous bare word is kept", clean_for_align("Solo") == "Solo"))
    r(check("long line ending in a colon is kept",
            clean_for_align("y me dijo una cosa mas asi:") == "y me dijo una cosa mas asi:"))
    r(check("ordinary line untouched again", clean_for_align("dame la mano") == "dame la mano"))

    # The load-bearing split: what gets RENDERED and what gets ALIGNED are two
    # different questions, so this filtering must not reach sheet_lyric_lines()
    tabbed = "E|-----------|\nCoro:\nsing this line"
    r(check("sheet_lyric_lines still returns all three (browser parity)",
            len(sheet_lyric_lines(tabbed)) == 3))
    r(check("align_pairs keeps only the sung one",
            [c for _, c in align_pairs(sheet_lyric_lines(tabbed))] == ["sing this line"]))

    # ── align_pairs: originals survive, markers don't ─────────────────────────
    pairs = align_pairs(["  a line (x2)", "-CHORUS-", "another"])
    r(check("marker-only lines dropped", len(pairs) == 2))
    r(check("original text kept for the LRC", pairs[0][0] == "  a line (x2)"))
    r(check("cleaned text is what gets aligned", pairs[0][1] == "a line"))

    print(f"\n{sum(results)}/{len(results)} passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
