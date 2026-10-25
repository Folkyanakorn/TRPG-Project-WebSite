from __future__ import annotations

import hashlib
import hmac
import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_NAME = str(Path(__file__).resolve().parent / "trpg.db")
DEFAULT_RANK = "พลทหาร (Rookie)"

# คอลัมน์ที่เพิ่มภายหลัง (เพิ่มให้อัตโนมัติถ้า DB เก่ายังไม่มี)
_EXTRA_COLUMNS = {
    "rank": f"TEXT DEFAULT '{DEFAULT_RANK}'",
    "hp": "INTEGER DEFAULT 100",
    "sp": "INTEGER DEFAULT 100",
    "max_hp": "INTEGER DEFAULT 100",
    "max_sp": "INTEGER DEFAULT 100",
}


@contextmanager
def _conn():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                password TEXT,
                avatar_url TEXT
            )
            """
        )
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
        for col, ddl in _EXTRA_COLUMNS.items():
            if col not in existing:
                conn.execute(f"ALTER TABLE users ADD COLUMN {col} {ddl}")


# ---------- password ----------
def _hash(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), 120_000
    ).hex()
    return f"pbkdf2${salt}${digest}"


def _verify(password: str, stored: str | None) -> bool:
    stored = stored or ""
    if stored.startswith("pbkdf2$"):
        try:
            _, salt, _ = stored.split("$")
        except ValueError:
            return False
        return hmac.compare_digest(_hash(password, salt), stored)
    # บัญชีเก่าที่เก็บรหัสเป็น plain text (จะอัปเกรดเป็น hash ตอน login สำเร็จ)
    return hmac.compare_digest(stored.encode("utf-8"), password.encode("utf-8"))


# ---------- users ----------
def _row_to_user(row) -> dict:
    return {
        "username": row["username"],
        "avatar_url": row["avatar_url"] or "",
        "rank": row["rank"] or DEFAULT_RANK,
        "hp": row["hp"] if row["hp"] is not None else 100,
        "sp": row["sp"] if row["sp"] is not None else 100,
        "max_hp": row["max_hp"] or 100,
        "max_sp": row["max_sp"] or 100,
    }


def register_user(username: str, password: str, avatar_url: str) -> bool:
    with _conn() as conn:
        taken = conn.execute(
            "SELECT 1 FROM users WHERE lower(username) = lower(?)", (username,)
        ).fetchone()
        if taken:
            return False
        try:
            conn.execute(
                "INSERT INTO users (username, password, avatar_url, rank) VALUES (?, ?, ?, ?)",
                (username, _hash(password), avatar_url, DEFAULT_RANK),
            )
        except sqlite3.IntegrityError:
            return False
        return True


def login_user(username: str, password: str) -> dict:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE lower(username) = lower(?)", (username,)
        ).fetchone()
        if not row or not _verify(password, row["password"]):
            return {"success": False}
        if not (row["password"] or "").startswith("pbkdf2$"):
            conn.execute(
                "UPDATE users SET password = ? WHERE username = ?",
                (_hash(password), row["username"]),
            )
        return {"success": True, **_row_to_user(row)}


def get_user_info(username: str) -> dict | None:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE username = ?", (username,)
        ).fetchone()
        return _row_to_user(row) if row else None


def save_status(username: str, hp: int, sp: int, max_hp: int, max_sp: int):
    with _conn() as conn:
        conn.execute(
            "UPDATE users SET hp = ?, sp = ?, max_hp = ?, max_sp = ? WHERE username = ?",
            (hp, sp, max_hp, max_sp, username),
        )
