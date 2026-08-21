#!/usr/bin/env python3
"""
Forced lyric alignment — time known lyrics against the isolated vocals stem.

Run as a subprocess, the same way demucs_runner.py is, so a torch crash or an OOM
kills this process and not the worker's poll loop:

  python lyric_align.py --audio vocals.ogg --text lines.txt \
                        --lang auto --model small --device cpu --out result.json

--text is one lyric line per line, already cleaned by sheet_parse.clean_for_align().
--original, if given, is the same number of lines in their untouched form: those are
what the emitted LRC carries, so smartMatchLyrics() re-matches them against the
sheet at near-identical scores. Whisper only ever sees the cleaned text.

Writes {"lrc", "times", "score", "language", "lines", "aligned"} to --out.

This is alignment, never transcription: Whisper is given the words and only asked
where they fall. A song with no lyrics text is a hard error, not an invitation to
guess at what is being sung.
"""
import argparse
import json
import os
import sys

# Whisper on MPS hits unimplemented sparse ops; the fallback has to be set before
# torch is imported, which is why this sits above every heavy import.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")


def _fmt_ts(seconds: float) -> str:
    """[MM:SS.hh] — two fraction digits, which is what parseLRC expects."""
    seconds = max(0.0, float(seconds))
    minutes = int(seconds // 60)
    rest = seconds - minutes * 60
    # 59.999 must not round to :60.00
    if round(rest, 2) >= 60.0:
        minutes += 1
        rest = 0.0
    return f"[{minutes:02d}:{rest:05.2f}]"


def _detect_language(model, audio_path: str) -> str:
    """Whisper's own detection on the first 30 s. Nothing in the schema stores a
    language and it can't be hardcoded — this library is mostly Spanish, not all."""
    import whisper

    audio = whisper.load_audio(audio_path)
    audio = whisper.pad_or_trim(audio)
    try:
        n_mels = model.dims.n_mels
    except AttributeError:
        n_mels = 80
    mel = whisper.log_mel_spectrogram(audio, n_mels).to(model.device)
    _, probs = model.detect_language(mel)
    if isinstance(probs, list):
        probs = probs[0]
    return max(probs, key=probs.get)


def _norm(text: str) -> str:
    return " ".join((text or "").lower().split())


def _pair_segments(segments, lines: list[str]) -> list[tuple[int, object]]:
    """(line_index, segment) pairs. original_split=True is meant to give one segment
    per input line; when it doesn't, fall back to walking the lines forward by text
    so a dropped segment shifts nothing after it."""
    if len(segments) == len(lines):
        return list(enumerate(segments))

    pairs: list[tuple[int, object]] = []
    cursor = 0
    for seg in segments:
        target = _norm(getattr(seg, "text", ""))
        hit = -1
        for j in range(cursor, len(lines)):
            if _norm(lines[j]) == target:
                hit = j
                break
        if hit == -1:
            continue
        pairs.append((hit, seg))
        cursor = hit + 1
    return pairs


def _score(segments) -> float:
    """Mean word probability, discounted by the fraction of zero-duration words.

    A word Whisper could not place at all still gets a timestamp, so probability
    on its own reads as confident when it isn't."""
    probs: list[float] = []
    zero = 0
    total = 0
    for seg in segments:
        for w in getattr(seg, "words", None) or []:
            total += 1
            p = getattr(w, "probability", None)
            if p is not None:
                probs.append(float(p))
            start = getattr(w, "start", 0.0) or 0.0
            end = getattr(w, "end", 0.0) or 0.0
            if end - start <= 0.0:
                zero += 1
    if not total:
        return 0.0
    mean_prob = sum(probs) / len(probs) if probs else 0.0
    return max(0.0, min(1.0, mean_prob * (1.0 - zero / total)))


def main() -> int:
    ap = argparse.ArgumentParser(description="Forced lyric alignment via stable-ts")
    ap.add_argument("--audio", required=True, help="Vocals stem to align against")
    ap.add_argument("--text", required=True, help="File of cleaned lyric lines, one per line")
    ap.add_argument("--original", default="",
                    help="Same lines untouched — what the emitted LRC carries")
    ap.add_argument("--out", required=True, help="Where to write the JSON result")
    ap.add_argument("--lang", default="auto", help="ISO code, or 'auto' to detect")
    ap.add_argument("--model", default="small", help="Whisper model size")
    ap.add_argument("--device", default="cpu", choices=["cpu", "cuda", "mps"])
    args = ap.parse_args()

    with open(args.text, encoding="utf-8") as f:
        lines = [l.rstrip("\n") for l in f if l.strip()]
    if not lines:
        print("[align] no lyric lines to align", file=sys.stderr)
        return 2

    originals = lines
    if args.original:
        with open(args.original, encoding="utf-8") as f:
            originals = [l.rstrip("\n") for l in f]
        if len(originals) != len(lines):
            print(f"[align] --original has {len(originals)} lines, --text has "
                  f"{len(lines)} — they must correspond one to one", file=sys.stderr)
            return 2

    if not os.path.exists(args.audio):
        print(f"[align] audio not found: {args.audio}", file=sys.stderr)
        return 2

    import stable_whisper

    model = stable_whisper.load_model(args.model, device=args.device)

    language = args.lang
    if not language or language == "auto":
        language = _detect_language(model, args.audio)
        print(f"[align] detected language: {language}", file=sys.stderr)

    # original_split=True is what guarantees one result segment per input line —
    # without it stable-ts re-segments and the line/timestamp mapping is lost.
    result = model.align(
        args.audio,
        "\n".join(lines),
        language=language,
        original_split=True,
        failure_threshold=0.5,
    )
    if result is None:
        print("[align] alignment failed (failure_threshold exceeded)", file=sys.stderr)
        return 3

    segments = list(result.segments)
    pairs = _pair_segments(segments, lines)
    if not pairs:
        print("[align] no segments could be matched back to input lines", file=sys.stderr)
        return 3

    lrc = "\n".join(f"{_fmt_ts(seg.start)}{originals[i].strip()}" for i, seg in pairs)

    payload = {
        "lrc": lrc,
        # index → seconds, so a caller can rebuild the LRC differently if it wants
        "times": {str(i): round(float(seg.start), 3) for i, seg in pairs},
        "score": round(_score(segments), 4),
        "language": language,
        "lines": len(lines),
        "aligned": len(pairs),
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    print(f"[align] {payload['aligned']}/{payload['lines']} lines, "
          f"score {payload['score']:.2f}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
