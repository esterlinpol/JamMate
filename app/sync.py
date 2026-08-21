"""Song sync between JamMate instances.

Role is derived from config, never declared. An instance whose `sync_hub_url`
setting is empty is the hub: it only ever serves, and never initiates. An instance
with it set is a client of that address. Every instance runs this same module and
exposes the same endpoints, so a second server — or later a mobile app — is just
another client of the same five calls.

What moves:
  * whole `jobs` rows, with created_at/updated_at carried across verbatim so both
    sides can agree which copy is newer without trusting a shared clock
  * the six stem files per song, compared by size and staged through `.part`

What deliberately does not move: `data/uploads` (source audio is worker input and
is not retained anyway), the `settings` table (per-machine), and `chords` (seeded
locally with per-machine uuids).

Stdlib only — the server image installs six packages and `requests` is not one of
them. urllib is already the house style in routes.py.
"""
import argparse
import hmac
import json
import os
import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from app.db import db
from app.routes import SEPARATED_DIR, _safe_id, _safe_stem_name, _setting

router = APIRouter()


def load_dotenv(path: Path | None = None) -> None:
    """Read `.env` at the repo root into os.environ, if it exists.

    Stdlib only and deliberately tiny — `python-dotenv` would be a seventh package
    in a server image that installs six. A real environment variable always wins,
    so docker-compose (which injects the value itself, and never ships the file
    because .dockerignore excludes it) is unaffected. Local `uvicorn` and
    `python -m app.sync` get the token without an export in every new shell.
    """
    env = path or Path(__file__).resolve().parent.parent / ".env"
    try:
        text = env.read_text()
    except (OSError, UnicodeDecodeError):
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        # setdefault, not assignment: a value already in the environment is the
        # operator being explicit and must not be silently replaced by the file.
        if key:
            os.environ.setdefault(key, value)


# Imported by app/main.py and run directly as __main__, so both the server and the
# CLI pick the file up. Idempotent, so importing twice is harmless.
load_dotenv()

# Both sides store updated_at as a float and round-trip it through JSON. Without a
# little slack, two instances can each decide the other is newer and push back and
# forth forever. This is the single most important constant in the file.
SKEW = 1.0

STEM_SUFFIXES = (".ogg", ".wav", ".mp3")
_CHUNK = 1 << 20
_HTTP_TIMEOUT = 30
_FILE_TIMEOUT = 600


# ── Local state ───────────────────────────────────────────────────────────────

def _job_columns(conn) -> tuple[list[str], set[str]]:
    """Column names of `jobs`, and which of them are NOT NULL.

    Derived rather than hardcoded because this checkout will routinely run a newer
    schema than the deployed hub. A hardcoded list would silently drop any column
    the other side doesn't know about; deriving it means each side accepts exactly
    what it has, and the difference gets reported instead of losing data.
    """
    rows = conn.execute("PRAGMA table_info(jobs)").fetchall()
    return [r[1] for r in rows], {r[1] for r in rows if r[3]}


def _stems_on_disk(job_id: str) -> dict[str, int]:
    d = SEPARATED_DIR / job_id
    if not d.is_dir():
        return {}
    # Same suffix filter get_stems uses, so a half-written `.part` is invisible here
    # exactly as it is to the player.
    return {f.name: f.stat().st_size for f in d.iterdir()
            if f.suffix in STEM_SUFFIXES and f.is_file()}


def local_manifest() -> dict:
    """The whole local library, cheaply. Served to peers and used against itself."""
    with db() as conn:
        cols, _ = _job_columns(conn)
        rows = conn.execute(
            "SELECT id, status, title, artist, source_url, created_at, updated_at"
            " FROM jobs ORDER BY created_at DESC"
        ).fetchall()
        tombs = conn.execute("SELECT id, deleted_at FROM tombstones").fetchall()

    songs = []
    for r in rows:
        s = dict(r)
        # Listed for every status, not just 'done': a run killed part-way leaves a
        # 'syncing' row with some stems already on disk, and the resume needs to see
        # them so it only fetches what is actually missing.
        s["stems"] = _stems_on_disk(r["id"])
        songs.append(s)

    return {"now": time.time(), "columns": cols, "songs": songs,
            "tombstones": [dict(t) for t in tombs]}


def upsert_local(row: dict, force_status: str | None = None) -> None:
    """Write a peer's row verbatim, creating or replacing.

    This is what `patch_job` cannot do: it chooses the id, it writes the origin's
    created_at/updated_at instead of restamping them, and it can write real NULLs.
    """
    job_id = row.get("id")
    if not job_id or not _safe_id(job_id):
        raise ValueError(f"bad job id: {job_id!r}")

    with db() as conn:
        cols, notnull = _job_columns(conn)
        data = {}
        for c in cols:
            if c not in row:
                continue
            # A NOT NULL column would blow up on an explicit null, so let the
            # column default stand instead. Nullable columns keep their None, which
            # is how "the user cleared the chord sheet" propagates.
            if row[c] is None and c in notnull:
                continue
            data[c] = row[c]

        data["id"] = job_id
        if force_status:
            data["status"] = force_status
        for required in ("created_at", "updated_at"):
            if data.get(required) is None:
                raise ValueError(f"{required} is required to upsert a synced row")

        names = list(data)
        placeholders = ", ".join("?" * len(names))
        assignments = ", ".join(f"{n} = excluded.{n}" for n in names if n != "id")
        conn.execute(
            f"INSERT INTO jobs ({', '.join(names)}) VALUES ({placeholders})"
            f" ON CONFLICT(id) DO UPDATE SET {assignments}",
            [data[n] for n in names],
        )
        # Re-adding a song we previously deleted has to actually work, so clear any
        # tombstone rather than letting it eat the row on the next run.
        conn.execute("DELETE FROM tombstones WHERE id = ?", (job_id,))


def delete_local(job_id: str) -> None:
    """Apply a peer's deletion, leaving our own tombstone so it stays deleted."""
    if not _safe_id(job_id):
        raise ValueError(f"bad job id: {job_id!r}")
    with db() as conn:
        conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
        conn.execute("INSERT OR REPLACE INTO tombstones (id, deleted_at) VALUES (?, ?)",
                     (job_id, time.time()))
    for d in (SEPARATED_DIR / job_id,):
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)


# ── Planning (pure) ───────────────────────────────────────────────────────────

@dataclass
class Plan:
    pull_row: list = field(default_factory=list)      # take the peer's row
    push_row: list = field(default_factory=list)      # send ours
    pull_stem: list = field(default_factory=list)     # [(job_id, filename)]
    push_stem: list = field(default_factory=list)
    push_pending: list = field(default_factory=list)  # hand off for separation
    del_local: list = field(default_factory=list)
    del_remote: list = field(default_factory=list)
    warnings: list = field(default_factory=list)

    def is_empty(self) -> bool:
        return not (self.pull_row or self.push_row or self.pull_stem or self.push_stem
                    or self.push_pending or self.del_local or self.del_remote)

    def songs_to_pull(self) -> dict[str, list[str]]:
        out = {i: [] for i in self.pull_row}
        for jid, name in self.pull_stem:
            out.setdefault(jid, []).append(name)
        return out

    def songs_to_push(self) -> dict[str, list[str]]:
        out = {i: [] for i in self.push_row}
        for jid, name in self.push_stem:
            out.setdefault(jid, []).append(name)
        return out


def plan(local: dict, remote: dict, direction: str = "both") -> Plan:
    """Decide what to move. Pure function of two manifests — no I/O, no clock.

    Rules, deliberately dumb:
      * a tombstone on either side beats an edit on the other
      * otherwise the newer updated_at wins the whole row
      * stem direction is decided independently of row direction, because a song
        can have a newer sheet here while a stem is missing there
    """
    p = Plan()
    can_pull = direction in ("both", "pull")
    can_push = direction in ("both", "push")

    # `done` songs are the library. Anything else is local work in progress.
    L = {s["id"]: s for s in local["songs"] if s["status"] == "done"}
    R = {s["id"]: s for s in remote["songs"] if s["status"] == "done"}
    L_all = {s["id"] for s in local["songs"]}
    R_all = {s["id"] for s in remote["songs"]}
    L_pending = {s["id"]: s for s in local["songs"] if s["status"] == "pending"}
    LT = {t["id"] for t in local["tombstones"]}
    RT = {t["id"] for t in remote["tombstones"]}

    lcols, rcols = set(local.get("columns") or []), set(remote.get("columns") or [])
    if lcols and rcols and lcols != rcols:
        if missing_there := sorted(lcols - rcols):
            p.warnings.append(
                f"peer schema is missing {', '.join(missing_there)} — those fields will not sync")
        if missing_here := sorted(rcols - lcols):
            p.warnings.append(
                f"peer has extra columns {', '.join(missing_here)} — ignoring them")

    # Deletions first: they override everything else about that id.
    if can_pull:
        p.del_local = sorted((L_all & RT) - LT)
    if can_push:
        p.del_remote = sorted((R_all & LT) - RT)
    settled = set(p.del_local) | set(p.del_remote)

    # Note L.keys() not L_all: a row left at 'syncing' by an interrupted run is not
    # 'done', so it looks missing here and gets picked up again. That is the whole
    # resume mechanism — no journal, no cursor.
    # Stems already on disk at the right size are skipped, so an interrupted run
    # resumes for the cost of what's left rather than re-fetching the whole song.
    l_stems = {s["id"]: (s.get("stems") or {}) for s in local["songs"]}
    r_stems = {s["id"]: (s.get("stems") or {}) for s in remote["songs"]}

    if can_pull:
        p.pull_row = sorted(R.keys() - L.keys() - LT - settled)
        for jid in p.pull_row:
            have = l_stems.get(jid, {})
            p.pull_stem += [(jid, n) for n, sz in sorted(R[jid]["stems"].items())
                            if have.get(n) != sz]
    if can_push:
        p.push_row = sorted(L.keys() - R.keys() - RT - settled)
        for jid in p.push_row:
            there = r_stems.get(jid, {})
            p.push_stem += [(jid, n) for n, sz in sorted(L[jid]["stems"].items())
                            if there.get(n) != sz]
        # A song added here with no stems yet: hand the row to the hub so whichever
        # worker is up separates it. Only if the hub has never heard of the id, in
        # any state — once it has, the hub owns it.
        p.push_pending = sorted(L_pending.keys() - R_all - RT - settled)

    for jid in sorted(R.keys() & L.keys()):
        if jid in settled:
            continue
        r, l = R[jid], L[jid]
        ru, lu = float(r["updated_at"] or 0), float(l["updated_at"] or 0)
        if can_pull and ru > lu + SKEW:
            p.pull_row.append(jid)
        elif can_push and lu > ru + SKEW:
            p.push_row.append(jid)

        for name, size in sorted(r["stems"].items()):
            if can_pull and l["stems"].get(name) != size:
                p.pull_stem.append((jid, name))
        for name, size in sorted(l["stems"].items()):
            if can_push and r["stems"].get(name) != size:
                p.push_stem.append((jid, name))

    # Same song added independently on both sides gets two uuids. Say so; merging
    # automatically would be a footgun.
    by_url = {}
    for s in local["songs"]:
        if s.get("source_url"):
            by_url.setdefault(s["source_url"], set()).add(s["id"])
    for s in remote["songs"]:
        if s.get("source_url"):
            by_url.setdefault(s["source_url"], set()).add(s["id"])
    for url, ids in sorted(by_url.items()):
        if len(ids) > 1:
            p.warnings.append(f"duplicate source_url on {len(ids)} songs: {url}")

    return p


# ── HTTP ──────────────────────────────────────────────────────────────────────

def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"} if token else {}


def _get_json(url: str, token: str, timeout: int = _HTTP_TIMEOUT):
    req = urllib.request.Request(url, headers=_auth(token), method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "{}")


def _put_json(url: str, token: str, obj: dict, timeout: int = _HTTP_TIMEOUT):
    body = json.dumps(obj).encode()
    headers = {**_auth(token), "Content-Type": "application/json",
               "Content-Length": str(len(body))}
    req = urllib.request.Request(url, data=body, headers=headers, method="PUT")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "{}")


def _download(url: str, token: str, dest: Path, timeout: int = _FILE_TIMEOUT) -> int:
    req = urllib.request.Request(url, headers=_auth(token), method="GET")
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(req, timeout=timeout) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f, _CHUNK)
    return dest.stat().st_size


def _upload(url: str, token: str, src: Path, timeout: int = _FILE_TIMEOUT) -> int:
    size = src.stat().st_size
    # Content-Length set explicitly: passing a file object without it makes urllib
    # fall back to chunked encoding.
    headers = {**_auth(token), "Content-Type": "audio/ogg", "Content-Length": str(size)}
    with open(src, "rb") as f:
        req = urllib.request.Request(url, data=f, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read()
    return size


def _delete(url: str, token: str, timeout: int = _HTTP_TIMEOUT) -> None:
    req = urllib.request.Request(url, headers=_auth(token), method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read()
    except urllib.error.HTTPError as e:
        if e.code != 404:      # already gone is success
            raise


# ── Run status ────────────────────────────────────────────────────────────────

_LOCK = threading.Lock()
_STATUS = {"running": False, "phase": "", "pulled": 0, "pushed": 0, "handed_off": 0,
           "deleted_local": 0, "deleted_remote": 0, "bytes": 0, "errors": [],
           "warnings": [], "started_at": None, "finished_at": None}


def get_status() -> dict:
    with _LOCK:
        return dict(_STATUS, errors=list(_STATUS["errors"]),
                    warnings=list(_STATUS["warnings"]))


def _set(**kw) -> None:
    with _LOCK:
        _STATUS.update(kw)


def _bump(key: str, n: int = 1) -> None:
    with _LOCK:
        _STATUS[key] = (_STATUS[key] or 0) + n


def _note(key: str, msg: str) -> None:
    with _LOCK:
        if msg not in _STATUS[key]:
            _STATUS[key].append(msg)


# ── Transfer ──────────────────────────────────────────────────────────────────

def _pull_song(hub: str, token: str, job_id: str, stems: list[str],
               remote_stems: dict[str, int], title: str) -> None:
    """Row + stems from the hub. Nothing is playable until every stem verifies."""
    row = _get_json(f"{hub}/api/jobs/{job_id}", token)

    # Only hide the song while audio is actually in flight. A metadata-only update
    # to a song that already plays must not make it unplayable.
    upsert_local(row, force_status="syncing" if stems else None)

    d = SEPARATED_DIR / job_id
    for name in stems:
        _set(phase=f"↓ {title or job_id} — {name}")
        part = d / f"{name}.part"
        got = _download(f"{hub}/api/audio/{job_id}/{urllib.parse.quote(name)}", token, part)
        expected = remote_stems.get(name)
        if expected is not None and got != expected:
            part.unlink(missing_ok=True)
            raise IOError(f"{name}: got {got} bytes, expected {expected}")
        os.replace(part, d / name)
        _bump("bytes", got)

    if stems:
        # Every stem is present at the right size, so publish it — with the hub's
        # own updated_at, or the next run would think we are newer and push back.
        have = _stems_on_disk(job_id)
        missing = [n for n in remote_stems if n not in have]
        if missing:
            raise IOError(f"still missing {', '.join(missing)}")
        upsert_local(row)


def _push_song(hub: str, token: str, job_id: str, stems: list[str], title: str) -> None:
    """Row + stems to the hub, held at 'syncing' there until all files land."""
    with db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        raise KeyError(f"{job_id} vanished locally")
    row = dict(row)

    # The row must exist remotely before stems can be posted to it.
    _put_json(f"{hub}/api/sync/jobs/{job_id}", token,
              dict(row, status="syncing" if stems else row["status"]))

    for name in stems:
        _set(phase=f"↑ {title or job_id} — {name}")
        src = SEPARATED_DIR / job_id / name
        if not src.is_file():
            raise IOError(f"{name} missing locally")
        _bump("bytes", _upload(f"{hub}/api/jobs/{job_id}/stems/{urllib.parse.quote(name)}",
                               token, src))

    if stems:
        _put_json(f"{hub}/api/sync/jobs/{job_id}", token, row)


def run_sync(hub: str = "", token: str = "", direction: str = "both") -> dict:
    """One full reconcile against the hub. Safe to call again at any time."""
    with db() as conn:
        hub = (hub or _setting(conn, "sync_hub_url")).rstrip("/")
        token = token or os.environ.get("JAMMATE_SYNC_TOKEN") or _setting(conn, "sync_token")
        # A ceiling, not a default: an instance configured 'pull' is a read-only
        # mirror and cannot write to the hub however it is invoked — UI button,
        # CLI flag or API call. Enforced here so there is exactly one gate.
        allowed = _setting(conn, "sync_direction", "both")
    if allowed in ("pull", "push") and direction != allowed:
        direction = allowed

    with _LOCK:
        if _STATUS["running"]:
            raise RuntimeError("sync already running")
        _STATUS.update(running=True, phase="Starting…", pulled=0, pushed=0, handed_off=0,
                       deleted_local=0, deleted_remote=0, bytes=0, errors=[], warnings=[],
                       started_at=time.time(), finished_at=None)

    try:
        if not hub:
            raise RuntimeError("no sync_hub_url configured — this instance is the hub")

        _set(phase="Fetching manifest…")
        remote = _get_json(f"{hub}/api/sync/manifest", token)
        local = local_manifest()
        p = plan(local, remote, direction)
        for w in p.warnings:
            _note("warnings", w)

        titles = {s["id"]: s.get("title") or "" for s in remote["songs"]}
        titles.update({s["id"]: s.get("title") or "" for s in local["songs"]})

        for job_id in p.del_local:
            try:
                _set(phase=f"Deleting {titles.get(job_id) or job_id} locally")
                delete_local(job_id)
                _bump("deleted_local")
            except Exception as e:
                _note("errors", f"{job_id}: delete failed — {e}")

        for job_id in p.del_remote:
            try:
                _set(phase=f"Deleting {titles.get(job_id) or job_id} on hub")
                _delete(f"{hub}/api/jobs/{job_id}", token)
                _bump("deleted_remote")
            except Exception as e:
                _note("errors", f"{job_id}: remote delete failed — {e}")

        remote_stems = {s["id"]: s.get("stems") or {} for s in remote["songs"]}
        for job_id, stems in sorted(p.songs_to_pull().items()):
            try:
                _pull_song(hub, token, job_id, stems, remote_stems.get(job_id, {}),
                           titles.get(job_id, ""))
                _bump("pulled")
            except Exception as e:
                _note("errors", f"{titles.get(job_id) or job_id}: pull failed — {e}")

        for job_id, stems in sorted(p.songs_to_push().items()):
            try:
                _push_song(hub, token, job_id, stems, titles.get(job_id, ""))
                _bump("pushed")
            except Exception as e:
                _note("errors", f"{titles.get(job_id) or job_id}: push failed — {e}")

        for job_id in p.push_pending:
            try:
                _set(phase=f"Handing off {titles.get(job_id) or job_id}")
                _push_song(hub, token, job_id, [], titles.get(job_id, ""))
                _bump("handed_off")
            except Exception as e:
                _note("errors", f"{titles.get(job_id) or job_id}: handoff failed — {e}")

        _set(phase="Done")
    except Exception as e:
        _note("errors", str(e))
        _set(phase="Failed")
    finally:
        _set(running=False, finished_at=time.time())
        with db() as conn:
            s = get_status()
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('sync_last_run', ?)",
                         (str(s["finished_at"]),))
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('sync_last_result', ?)",
                         (json.dumps({k: s[k] for k in
                                      ("pulled", "pushed", "handed_off", "deleted_local",
                                       "deleted_remote", "bytes", "errors", "warnings")}),))
    return get_status()


# ── Endpoints ─────────────────────────────────────────────────────────────────

def require_sync_token(authorization: str = Header(None)):
    """Fail closed: with no token configured, sync is off rather than open."""
    with db() as conn:
        expected = os.environ.get("JAMMATE_SYNC_TOKEN") or _setting(conn, "sync_token")
    if not expected:
        raise HTTPException(503, "sync not configured")
    got = (authorization or "").removeprefix("Bearer ").strip()
    if not got or not hmac.compare_digest(got, expected):
        raise HTTPException(401, "bad token")


@router.get("/api/sync/manifest", dependencies=[Depends(require_sync_token)])
async def sync_manifest():
    return local_manifest()


@router.put("/api/sync/jobs/{job_id}", dependencies=[Depends(require_sync_token)])
async def sync_put_job(job_id: str, request: Request):
    if not _safe_id(job_id):
        return JSONResponse({"error": "invalid id"}, status_code=400)
    body = await request.json()
    if not isinstance(body, dict):
        return JSONResponse({"error": "expected an object"}, status_code=400)
    try:
        upsert_local(dict(body, id=job_id))
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    return {"ok": True}


@router.get("/api/sync/status")
async def sync_status():
    with db() as conn:
        hub = _setting(conn, "sync_hub_url")
        allowed = _setting(conn, "sync_direction", "both")
    return dict(get_status(), hub=hub, is_hub=not hub, direction=allowed,
                read_only=allowed == "pull")


@router.post("/api/sync/run")
async def sync_run(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    direction = (body or {}).get("direction", "both")
    if direction not in ("both", "pull", "push"):
        return JSONResponse({"error": "bad direction"}, status_code=400)

    with db() as conn:
        hub = _setting(conn, "sync_hub_url")
    if not hub:
        return JSONResponse(
            {"error": "This instance is the hub (no sync_hub_url set)."}, status_code=400)
    with _LOCK:
        if _STATUS["running"]:
            return JSONResponse({"error": "sync already running"}, status_code=409)

    threading.Thread(target=run_sync, kwargs={"direction": direction}, daemon=True).start()
    return {"started": True}


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="JamMate — sync songs with the hub")
    ap.add_argument("--hub", default="", help="Hub base URL (default: sync_hub_url setting)")
    ap.add_argument("--token", default="", help="Shared token (default: env or setting)")
    ap.add_argument("--direction", default="both", choices=["both", "pull", "push"])
    args = ap.parse_args()

    s = run_sync(args.hub, args.token, args.direction)
    for w in s["warnings"]:
        print(f"[sync] warning: {w}")
    for e in s["errors"]:
        print(f"[sync] error: {e}")
    print(f"[sync] pulled={s['pulled']} pushed={s['pushed']} handed_off={s['handed_off']} "
          f"deleted={s['deleted_local']}/{s['deleted_remote']} "
          f"bytes={s['bytes']:,}")
    raise SystemExit(1 if s["errors"] else 0)


if __name__ == "__main__":
    main()
