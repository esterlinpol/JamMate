"""Tests for sync.plan() — the pure decision function.

Every interesting sync bug is reachable here with fabricated manifests: no server,
no files, no audio. Run with `python tests/test_sync_plan.py` or `pytest tests/`.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.sync import SKEW, plan  # noqa: E402

STEMS = {"bass.ogg": 100, "drums.ogg": 200, "guitar.ogg": 300,
         "other.ogg": 400, "piano.ogg": 500, "vocals.ogg": 600}
COLS = ["id", "title", "status", "created_at", "updated_at"]


def song(sid, updated=1000.0, status="done", stems=None, **kw):
    return dict({"id": sid, "status": status, "title": sid, "artist": "",
                 "source_url": None, "created_at": 1.0, "updated_at": updated,
                 "stems": dict(STEMS) if stems is None else stems}, **kw)


def manifest(songs=(), tombstones=(), columns=None):
    return {"now": 9999.0, "columns": list(COLS if columns is None else columns),
            "songs": list(songs),
            "tombstones": [{"id": t, "deleted_at": 500.0} for t in tombstones]}


def check(name, cond):
    print(("  ok   " if cond else "  FAIL ") + name)
    return bool(cond)


def main():
    results = []
    r = results.append

    # ── Cold pull: hub has a song we've never seen ────────────────────────────
    p = plan(manifest(), manifest([song("a")]))
    r(check("cold pull takes the row", p.pull_row == ["a"]))
    r(check("cold pull takes all 6 stems", len(p.pull_stem) == 6))
    r(check("cold pull pushes nothing", not p.push_row and not p.push_stem))

    # ── Cold push: we have a song the hub doesn't ─────────────────────────────
    p = plan(manifest([song("a")]), manifest())
    r(check("cold push sends the row", p.push_row == ["a"]))
    r(check("cold push sends all 6 stems", len(p.push_stem) == 6))

    # ── Idempotency: identical state must be a no-op (the ping-pong test) ─────
    both = [song("a")]
    p = plan(manifest(both), manifest(both))
    r(check("identical manifests are a no-op", p.is_empty()))

    # Sub-second drift must not trigger a transfer either.
    p = plan(manifest([song("a", updated=1000.4)]), manifest([song("a", updated=1000.0)]))
    r(check("sub-SKEW drift is a no-op", p.is_empty()))

    # ── Metadata direction ───────────────────────────────────────────────────
    p = plan(manifest([song("a", updated=1000.0)]),
             manifest([song("a", updated=1000.0 + SKEW + 1)]))
    r(check("newer remote row is pulled", p.pull_row == ["a"] and not p.push_row))
    r(check("newer remote row moves no stems", not p.pull_stem))

    p = plan(manifest([song("a", updated=1000.0 + SKEW + 1)]),
             manifest([song("a", updated=1000.0)]))
    r(check("newer local row is pushed", p.push_row == ["a"] and not p.pull_row))

    # ── Stem direction is independent of row direction ───────────────────────
    # Our row is newer, but the hub has a stem we're missing: push row, pull stem.
    local_missing = {k: v for k, v in STEMS.items() if k != "vocals.ogg"}
    p = plan(manifest([song("a", updated=2000.0, stems=local_missing)]),
             manifest([song("a", updated=1000.0)]))
    r(check("newer local row still pulls a missing stem",
            p.push_row == ["a"] and p.pull_stem == [("a", "vocals.ogg")]))

    # A stem whose size differs is re-fetched, not assumed equal.
    wrong_size = {**STEMS, "bass.ogg": 999}
    p = plan(manifest([song("a", stems=wrong_size)]), manifest([song("a")]))
    r(check("size mismatch re-fetches that stem", ("a", "bass.ogg") in p.pull_stem))

    # ── Tombstones ───────────────────────────────────────────────────────────
    p = plan(manifest([song("a")]), manifest(tombstones=["a"]))
    r(check("hub tombstone deletes locally", p.del_local == ["a"]))
    r(check("hub tombstone does not re-pull", not p.pull_row))

    # The resurrection test: we deleted it, hub still has it. Must not come back.
    p = plan(manifest(tombstones=["a"]), manifest([song("a")]))
    r(check("local tombstone blocks the pull", not p.pull_row))
    r(check("local tombstone deletes on hub", p.del_remote == ["a"]))

    # Both sides already agree it's gone — nothing left to do.
    p = plan(manifest(tombstones=["a"]), manifest(tombstones=["a"]))
    r(check("mutual tombstone is a no-op", p.is_empty()))

    # Delete beats edit, even when the surviving copy is much newer.
    p = plan(manifest([song("a", updated=99999.0)]), manifest(tombstones=["a"]))
    r(check("delete beats a newer local edit",
            p.del_local == ["a"] and not p.push_row and not p.push_stem))

    # ── Interrupted run resumes ──────────────────────────────────────────────
    # A row left at 'syncing' is not 'done', so it looks absent and is retried.
    p = plan(manifest([song("a", status="syncing", stems={"bass.ogg": 100})]),
             manifest([song("a")]))
    r(check("interrupted pull resumes", p.pull_row == ["a"]))
    r(check("resume skips the stem already on disk",
            ("a", "bass.ogg") not in p.pull_stem and len(p.pull_stem) == 5))

    # A stem left at the wrong size is not trusted just because it exists.
    p = plan(manifest([song("a", status="syncing", stems={"bass.ogg": 7})]),
             manifest([song("a")]))
    r(check("resume refetches a wrong-sized stem", len(p.pull_stem) == 6))

    # All six already landed, only the status flip is left: row, no transfer.
    p = plan(manifest([song("a", status="syncing")]), manifest([song("a")]))
    r(check("resume with all stems present is metadata-only",
            p.pull_row == ["a"] and not p.pull_stem))

    # Same on the push side: don't re-send stems the hub already has.
    p = plan(manifest([song("a")]), manifest([song("a", status="syncing")]))
    r(check("push skips stems the hub already has",
            p.push_row == ["a"] and not p.push_stem))

    # ── Pending handoff ──────────────────────────────────────────────────────
    p = plan(manifest([song("a", status="pending", stems={})]), manifest())
    r(check("pending song is handed off", p.push_pending == ["a"]))
    r(check("pending song sends no stems", not p.push_stem))

    # Once the hub knows the id in any state, we stop pushing it.
    for st in ("pending", "processing", "syncing", "done"):
        p = plan(manifest([song("a", status="pending", stems={})]),
                 manifest([song("a", status=st, stems={})]))
        r(check(f"no re-handoff once hub has it as {st}", not p.push_pending))

    # And a deleted pending song is not handed off.
    p = plan(manifest([song("a", status="pending", stems={})]), manifest(tombstones=["a"]))
    r(check("tombstoned pending song is not handed off", not p.push_pending))

    # ── Direction locks ──────────────────────────────────────────────────────
    p = plan(manifest([song("a")]), manifest([song("b")]), direction="pull")
    r(check("pull-only takes b", p.pull_row == ["b"]))
    r(check("pull-only sends nothing", not p.push_row and not p.push_stem))

    p = plan(manifest([song("a")]), manifest([song("b")]), direction="push")
    r(check("push-only sends a", p.push_row == ["a"]))
    r(check("push-only takes nothing", not p.pull_row and not p.pull_stem))

    p = plan(manifest([song("a")]), manifest(tombstones=["a"]), direction="push")
    r(check("push-only does not delete locally", not p.del_local))

    # ── Schema drift is reported, not silent ─────────────────────────────────
    p = plan(manifest(columns=COLS + ["new_field"]), manifest(columns=COLS))
    r(check("missing peer column warns",
            any("new_field" in w and "not sync" in w for w in p.warnings)))

    p = plan(manifest(columns=COLS), manifest(columns=COLS + ["future"]))
    r(check("extra peer column warns", any("future" in w for w in p.warnings)))

    # ── Duplicate detection warns but changes nothing ───────────────────────
    p = plan(manifest([song("a", source_url="http://y/1")]),
             manifest([song("b", source_url="http://y/1")]))
    r(check("duplicate source_url warns", any("duplicate" in w for w in p.warnings)))
    r(check("duplicate still syncs both", p.pull_row == ["b"] and p.push_row == ["a"]))

    print(f"\n{sum(results)}/{len(results)} passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
