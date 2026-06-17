import sqlite3
import time
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
