"""이메일 회원가입/로그인 — 외부 의존성 없이(표준 라이브러리만) 안전하게.

- 비밀번호: PBKDF2-HMAC-SHA256(20만 회) + 종목별 16바이트 솔트로 해시해 저장.
  평문은 어디에도 남기지 않고, 검증은 상수시간 비교(compare_digest).
- 세션: 서버측(SQLite)에 토큰의 sha256 만 저장한다. 쿠키에는 임의 토큰만
  담고(httpOnly) DB엔 해시만 두어, DB가 유출돼도 세션을 바로 못 쓴다.

영속성 주의: SQLite 파일은 AUTH_DB_PATH(기본 <repo>/data/auth.db)에 저장된다.
Render 무료 플랜은 디스크가 잠들거나 재배포될 때 초기화되므로, 계정을 영구
보존하려면 영구 디스크를 붙이거나 외부 Postgres 로 이 저장소만 갈아끼우면 된다
(모든 DB 접근이 AuthStore 한 곳에 모여 있어 교체가 쉽다).
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path

_PBKDF2_ROUNDS = 200_000
SESSION_TTL_SEC = 60 * 60 * 24 * 14        # 세션 유효기간: 2주
COOKIE_NAME = "wt_session"
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_MAX_EMAIL_LEN = 254
_MIN_PW_LEN = 8
_MAX_PW_LEN = 200


class AuthError(Exception):
    """검증 실패 등 사용자에게 그대로 보여줄 수 있는 오류(400)."""


class EmailTaken(AuthError):
    """이미 가입된 이메일(409)."""


class InvalidCredentials(AuthError):
    """이메일/비밀번호 불일치(401). 어느 쪽이 틀렸는지는 알려주지 않는다."""


def _default_db_path() -> Path:
    env = os.environ.get("AUTH_DB_PATH")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / "data" / "auth.db"


def _normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def _validate(email: str, password: str) -> None:
    # 제어문자(NUL 등)는 [^@\s] 정규식을 통과하므로 명시적으로 거른다 — 혼동되는
    # 유사-중복 계정(a\x00@b.c vs a@b.c) 생성을 막는다
    if not email or len(email) > _MAX_EMAIL_LEN or not _EMAIL_RE.match(email) \
            or any(ord(c) < 0x20 or ord(c) == 0x7f for c in email):
        raise AuthError("올바른 이메일 형식이 아니에요.")
    if not isinstance(password, str) or len(password) < _MIN_PW_LEN:
        raise AuthError(f"비밀번호는 {_MIN_PW_LEN}자 이상이어야 해요.")
    if len(password) > _MAX_PW_LEN:
        raise AuthError("비밀번호가 너무 길어요.")


class AuthStore:
    """SQLite 기반 회원/세션 저장소. 모든 접근은 스레드 락으로 직렬화한다
    (단일 프로세스·저트래픽 전제라 충분하며, 서버 이벤트루프는 to_thread 로 호출)."""

    def __init__(self, db_path: Path | str | None = None):
        self.db_path = Path(db_path) if db_path else _default_db_path()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None
        with self._lock:
            self._db_locked()  # 최초 연결 + 스키마 생성

    def _db_locked(self) -> sqlite3.Connection:
        """열린 커넥션을 돌려준다 — 없거나 닫혀 있으면(예: 테스트에서 lifespan
        재시작으로 close 된 경우) 다시 연다. 반드시 self._lock 을 쥔 채 호출한다."""
        if self._conn is None:
            conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=5000")
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS users(
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    email      TEXT UNIQUE NOT NULL,
                    pw_hash    BLOB NOT NULL,
                    pw_salt    BLOB NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions(
                    token_hash TEXT PRIMARY KEY,
                    user_id    INTEGER NOT NULL,
                    expires_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
                """
            )
            conn.commit()
            self._conn = conn
        return self._conn

    @staticmethod
    def _hash_pw(password: str, salt: bytes) -> bytes:
        return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ROUNDS)

    # ---- 회원가입 / 로그인 → 새 세션 토큰 반환 ----
    def signup(self, email: str, password: str) -> str:
        email = _normalize_email(email)
        _validate(email, password)
        salt = secrets.token_bytes(16)
        pw_hash = self._hash_pw(password, salt)
        with self._lock:
            conn = self._db_locked()
            try:
                cur = conn.execute(
                    "INSERT INTO users(email, pw_hash, pw_salt, created_at) VALUES(?,?,?,?)",
                    (email, pw_hash, salt, time.time()),
                )
                conn.commit()
            except sqlite3.IntegrityError:
                raise EmailTaken("이미 가입된 이메일이에요. 로그인해 주세요.")
            user_id = int(cur.lastrowid)
        return self._new_session(user_id)

    def login(self, email: str, password: str) -> str:
        email = _normalize_email(email)
        # 정상 비밀번호는 가입 때 8~200자로 제한돼 있다 — 그 범위 밖은 어차피
        # 일치할 수 없으니, 해시(PBKDF2)를 돌리기 전에 잘못된 자격증명으로 처리한다
        # (거대한 입력으로 해시/파싱 비용을 유발하지 못하게).
        if not isinstance(password, str) or not (_MIN_PW_LEN <= len(password) <= _MAX_PW_LEN):
            raise InvalidCredentials("이메일 또는 비밀번호가 올바르지 않아요.")
        with self._lock:
            row = self._db_locked().execute(
                "SELECT id, pw_hash, pw_salt FROM users WHERE email=?", (email,)
            ).fetchone()
        if row is None:
            # 존재하지 않는 계정도 해시 한 번 계산 — 응답시간으로 가입 여부가 새지 않게
            self._hash_pw(password, b"\x00" * 16)
            raise InvalidCredentials("이메일 또는 비밀번호가 올바르지 않아요.")
        user_id, pw_hash, salt = row
        candidate = self._hash_pw(password, bytes(salt))
        if not hmac.compare_digest(candidate, bytes(pw_hash)):
            raise InvalidCredentials("이메일 또는 비밀번호가 올바르지 않아요.")
        return self._new_session(int(user_id))

    def _new_session(self, user_id: int) -> str:
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        with self._lock:
            conn = self._db_locked()
            conn.execute(
                "INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)",
                (token_hash, user_id, time.time() + SESSION_TTL_SEC),
            )
            conn.commit()
        return token

    def user_for_token(self, token: str | None) -> dict | None:
        """세션 토큰 → {'id','email'} 또는 None(없음/만료). 만료 세션은 정리한다."""
        if not token:
            return None
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        with self._lock:
            conn = self._db_locked()
            row = conn.execute(
                "SELECT u.id, u.email, s.expires_at FROM sessions s "
                "JOIN users u ON u.id = s.user_id WHERE s.token_hash=?",
                (token_hash,),
            ).fetchone()
            if row is None:
                return None
            user_id, email, expires_at = row
            if float(expires_at) < time.time():
                conn.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))
                conn.commit()
                return None
        return {"id": int(user_id), "email": str(email)}

    def logout(self, token: str | None) -> None:
        if not token:
            return
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        with self._lock:
            conn = self._db_locked()
            conn.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))
            conn.commit()

    def purge_expired(self) -> int:
        with self._lock:
            conn = self._db_locked()
            cur = conn.execute("DELETE FROM sessions WHERE expires_at < ?", (time.time(),))
            conn.commit()
            return cur.rowcount

    def user_count(self) -> int:
        with self._lock:
            return int(self._db_locked().execute("SELECT COUNT(*) FROM users").fetchone()[0])

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None
