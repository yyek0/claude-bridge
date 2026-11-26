import hashlib
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager

TOKEN = re.compile(r"cb_[A-Za-z0-9_-]{43}\Z")
ACCOUNT = re.compile(r"[a-zA-Z0-9_-]{1,64}\Z")
MAX_DIALOGS = 100
MAX_TURNS = 100
MAX_DATABASE_PAGES = 32768


class Store:
    def __init__(self, path):
        self.path = path
        with self.db() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS devices(
                    id TEXT PRIMARY KEY, account TEXT NOT NULL, label TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS dialogs(
                    id TEXT PRIMARY KEY, account TEXT NOT NULL, title TEXT NOT NULL, updated REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS dialogs_account ON dialogs(account, updated);
                CREATE TABLE IF NOT EXISTS turns(
                    id INTEGER PRIMARY KEY, dialog TEXT NOT NULL REFERENCES dialogs(id),
                    prompt TEXT NOT NULL, answer TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS turns_dialog ON turns(dialog, id);
            """)

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=5)
        try:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            db.execute(f"PRAGMA max_page_count={MAX_DATABASE_PAGES}")
            with db:
                yield db
        finally:
            db.close()

    def add_device(self, account, label):
        if not ACCOUNT.fullmatch(account) or not label.strip() or len(label) > 80:
            raise ValueError("Invalid account or device label")
        token = "cb_" + secrets.token_urlsafe(32)
        device_id = secrets.token_hex(8)
        with self.db() as db:
            db.execute("INSERT INTO devices(id, account, label, token_hash) VALUES(?,?,?,?)",
                       (device_id, account, label, self.digest(token)))
        return device_id, token

    @staticmethod
    def digest(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def authenticate(self, supplied):
        if not supplied.startswith("Bearer ") or not TOKEN.fullmatch(token := supplied[7:]):
            return None
        with self.db() as db:
            return db.execute("SELECT id,account FROM devices WHERE token_hash=? AND revoked=0",
                              (self.digest(token),)).fetchone()

    def active(self, device):
        with self.db() as db:
            return db.execute("SELECT 1 FROM devices WHERE id=? AND revoked=0", (device,)).fetchone() is not None

    def revoke(self, device):
        with self.db() as db:
            return db.execute("UPDATE devices SET revoked=1 WHERE id=? AND revoked=0", (device,)).rowcount

    def devices(self):
        with self.db() as db:
            return [dict(row) for row in db.execute("SELECT id,account,label,revoked FROM devices ORDER BY account,label")]

    def dialogs(self, account):
        with self.db() as db:
            return [dict(row) for row in db.execute(
                "SELECT id,title,updated FROM dialogs WHERE account=? ORDER BY updated DESC", (account,))]

    def create(self, account, dialog):
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT account FROM dialogs WHERE id=?", (dialog,)).fetchone()
            if existing:
                return existing["account"] == account
            if db.execute("SELECT count(*) FROM dialogs WHERE account=?", (account,)).fetchone()[0] >= MAX_DIALOGS:
                return False
            db.execute("INSERT INTO dialogs VALUES(?,?,?,?)", (dialog, account, "Новый диалог", time.time()))
            return True

    def history(self, account, dialog, limit=MAX_TURNS):
        with self.db() as db:
            if not db.execute("SELECT 1 FROM dialogs WHERE id=? AND account=?", (dialog, account)).fetchone():
                return None
            rows = db.execute("SELECT prompt,answer FROM turns WHERE dialog=? ORDER BY id DESC LIMIT ?", (dialog, limit))
            return [dict(row) for row in reversed(rows.fetchall())]

    def append(self, account, device, dialog, prompt, answer):
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM devices WHERE id=? AND account=? AND revoked=0", (device, account)).fetchone():
                return False
            row = db.execute("SELECT title FROM dialogs WHERE id=? AND account=?", (dialog, account)).fetchone()
            if not row:
                return False
            title = row["title"] if row["title"] != "Новый диалог" else (" ".join(prompt.split())[:60] or row["title"])
            db.execute("INSERT INTO turns(dialog,prompt,answer) VALUES(?,?,?)", (dialog, prompt, answer))
            db.execute("UPDATE dialogs SET title=?,updated=? WHERE id=?", (title, time.time(), dialog))
            db.execute("DELETE FROM turns WHERE dialog=? AND id NOT IN (SELECT id FROM turns WHERE dialog=? ORDER BY id DESC LIMIT ?)",
                       (dialog, dialog, MAX_TURNS))
            return True


def default_path():
    return os.environ.get("BRIDGE_DB", "bridge.sqlite3")
