import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path("data/songs.db")


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def db():
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                artist TEXT NOT NULL DEFAULT '',
                filename TEXT NOT NULL DEFAULT '',
                source_type TEXT NOT NULL DEFAULT 'upload',
                source_url TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                model TEXT NOT NULL DEFAULT 'htdemucs_6s',
                shifts INTEGER NOT NULL DEFAULT 0,
                stem_base TEXT,
                chord_data TEXT,
                chord_source TEXT,
                chord_source_url TEXT,
                capo INTEGER NOT NULL DEFAULT 0,
                duration_sec REAL,
                progress REAL NOT NULL DEFAULT 0,
                progress_phase TEXT,
                error_msg TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS chords (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                frets TEXT NOT NULL,
                fingers TEXT NOT NULL,
                barre TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );

            INSERT OR IGNORE INTO settings (key, value) VALUES
                ('worker_device', 'cpu'),
                ('worker_last_seen', '');
        """)
        # Migration: add new columns to existing databases
        existing = {row[1] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
        if "chord_source_url" not in existing:
            conn.execute("ALTER TABLE jobs ADD COLUMN chord_source_url TEXT")
        if "capo" not in existing:
            conn.execute("ALTER TABLE jobs ADD COLUMN capo INTEGER NOT NULL DEFAULT 0")
        if "duration_sec" not in existing:
            conn.execute("ALTER TABLE jobs ADD COLUMN duration_sec REAL")
        for col, ddl in [
            ("song_chord_data", "TEXT"),
            ("bpm", "REAL"),
            ("beat_times", "TEXT"),
        ]:
            if col not in existing:
                conn.execute(f"ALTER TABLE jobs ADD COLUMN {col} {ddl}")

        _seed_chords(conn)


_DEFAULT_CHORDS = [
    # name,  frets,                  fingers,              barre
    ("Em",   [0,2,2,0,0,0],          [0,2,3,0,0,0],        None),
    ("Am",   [-1,0,2,2,1,0],         [0,0,2,3,1,0],        None),
    ("E",    [0,2,2,1,0,0],          [0,2,3,1,0,0],        None),
    ("A",    [-1,0,2,2,2,0],         [0,0,1,2,3,0],        None),
    ("D",    [-1,-1,0,2,3,2],        [0,0,0,1,3,2],        None),
    ("Dm",   [-1,-1,0,2,3,1],        [0,0,0,2,3,1],        None),
    ("G",    [3,2,0,0,0,3],          [2,1,0,0,0,3],        None),
    ("C",    [-1,3,2,0,1,0],         [0,3,2,0,1,0],        None),
    ("F",    [1,3,3,2,1,1],          [1,3,4,2,1,1],        {"fret":1,"from":0,"to":5}),
    ("Bm",   [-1,2,4,4,3,2],         [0,1,3,4,2,1],        {"fret":2,"from":1,"to":5}),
    ("E7",   [0,2,0,1,0,0],          [0,2,0,1,0,0],        None),
    ("A7",   [-1,0,2,0,2,0],         [0,0,2,0,3,0],        None),
    ("D7",   [-1,-1,0,2,1,2],        [0,0,0,2,1,3],        None),
    ("B7",   [-1,2,1,2,0,2],         [0,2,1,3,0,4],        None),
]


def _seed_chords(conn: sqlite3.Connection) -> None:
    now = time.time()
    for name, frets, fingers, barre in _DEFAULT_CHORDS:
        conn.execute(
            """INSERT OR IGNORE INTO chords (id, name, frets, fingers, barre, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                str(uuid.uuid4()),
                name,
                json.dumps(frets),
                json.dumps(fingers),
                json.dumps(barre) if barre else None,
                now,
                now,
            ),
        )
