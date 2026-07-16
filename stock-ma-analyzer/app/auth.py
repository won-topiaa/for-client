"""이메일 회원가입/로그인 저장소 — SQLAlchemy Core 기반.

한 벌의 코드로 SQLite(로컬 개발·테스트)와 PostgreSQL(운영)을 모두 지원한다.
DATABASE_URL 이 있으면 그 DB(운영: Neon 등 무료 영구 Postgres)를, 없으면
로컬 SQLite 파일(AUTH_DB_PATH)을 쓴다. 방언 차이(자동증가 PK·바이트 타입·
플레이스홀더·RETURNING)는 SQLAlchemy 가 흡수한다.

보안:
- 비밀번호: PBKDF2-HMAC-SHA256(20만 회) + 사용자별 16바이트 솔트로 해시.
  평문은 저장하지 않고, 검증은 상수시간 비교(compare_digest).
- 세션: 서버측 테이블에 토큰의 sha256 만 저장한다. 쿠키에는 임의 토큰만
  담아(httpOnly), DB가 유출돼도 세션을 바로 못 쓴다.

영속성: 운영에서 DATABASE_URL(외부 Postgres)을 설정하면 재배포·슬립과
무관하게 계정이 보존된다. 설정하지 않으면 SQLite 파일이라 Render 무료
플랜에서는 인스턴스가 초기화될 때 사라진다.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import time
from pathlib import Path

from sqlalchemy import (
    BigInteger,
    Column,
    Float,
    Index,
    Integer,
    LargeBinary,
    MetaData,
    String,
    Table,
    create_engine,
    delete,
    event,
    func,
    insert,
    select,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.engine import Engine, make_url

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


def _default_sqlite_path() -> Path:
    env = os.environ.get("AUTH_DB_PATH")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / "data" / "auth.db"


def _normalize_db_url(url: str) -> str:
    """Neon/Render 등이 주는 postgres:// URL 을 SQLAlchemy+psycopg3 형식으로.
    (드라이버 미지정 시 psycopg2 를 찾으려다 실패하는 것을 막는다.)"""
    url = url.strip()
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


def _resolve_url(db_path: Path | str | None, url: str | None) -> str:
    if url:
        return _normalize_db_url(url)
    env_url = os.environ.get("DATABASE_URL", "").strip()
    if env_url:
        return _normalize_db_url(env_url)
    path = Path(db_path) if db_path else _default_sqlite_path()
    return f"sqlite:///{path}"


_metadata = MetaData()
# 큰 자동증가 값도 담기게 BigInteger — SQLite 에선 INTEGER, Postgres 에선 BIGSERIAL
_users = Table(
    "users", _metadata,
    Column("id", BigInteger().with_variant(Integer, "sqlite"), primary_key=True,
           autoincrement=True),
    Column("email", String(_MAX_EMAIL_LEN), unique=True, nullable=False),
    Column("pw_hash", LargeBinary, nullable=False),
    Column("pw_salt", LargeBinary, nullable=False),
    Column("created_at", Float, nullable=False),
)
_sessions = Table(
    "sessions", _metadata,
    Column("token_hash", String(64), primary_key=True),
    Column("user_id", BigInteger, nullable=False),
    Column("expires_at", Float, nullable=False),
)
Index("idx_sessions_exp", _sessions.c.expires_at)


def _normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def _validate(email: str, password: str) -> None:
    # 제어문자(NUL 등)는 [^@\s] 정규식을 통과하므로 명시적으로 거른다 — 혼동되는
    # 유사-중복 계정(a\x00@b.c vs a@b.c) 생성을 막는다.
    if not email or len(email) > _MAX_EMAIL_LEN or not _EMAIL_RE.match(email) \
            or any(ord(c) < 0x20 or ord(c) == 0x7f for c in email):
        raise AuthError("올바른 이메일 형식이 아니에요.")
    if not isinstance(password, str) or len(password) < _MIN_PW_LEN:
        raise AuthError(f"비밀번호는 {_MIN_PW_LEN}자 이상이어야 해요.")
    if len(password) > _MAX_PW_LEN:
        raise AuthError("비밀번호가 너무 길어요.")


class AuthStore:
    """SQLAlchemy Core 기반 회원/세션 저장소 (SQLite·Postgres 공용).

    Engine 이 커넥션 풀·스레드 안전을 담당하므로 별도 락이 필요 없다. 서버는
    이 동기 메서드를 asyncio.to_thread 로 호출한다."""

    def __init__(self, db_path: Path | str | None = None, url: str | None = None):
        self.url = _resolve_url(db_path, url)
        u = make_url(self.url)
        if u.get_backend_name() == "sqlite":
            # 파일 경로 디렉터리 보장 + 스레드 공유 허용 + WAL/타임아웃
            if u.database and u.database != ":memory:":
                Path(u.database).parent.mkdir(parents=True, exist_ok=True)
            self._engine: Engine = create_engine(
                self.url, connect_args={"check_same_thread": False},
                pool_pre_ping=True, future=True)

            @event.listens_for(self._engine, "connect")
            def _sqlite_pragmas(dbapi_conn, _rec):  # noqa: ANN001
                cur = dbapi_conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA busy_timeout=5000")
                cur.close()
        else:
            # 운영 Postgres(Neon 등 서버리스): 유휴 커넥션이 끊겨도 살아나게
            # pre_ping + 주기적 재활용. 작은 풀로 무료 인스턴스 커넥션 한도 배려.
            self._engine = create_engine(
                self.url, pool_pre_ping=True, pool_recycle=300,
                pool_size=5, max_overflow=5, future=True)
        _metadata.create_all(self._engine)

    @staticmethod
    def _hash_pw(password: str, salt: bytes) -> bytes:
        return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ROUNDS)

    # ---- 회원가입 / 로그인 → 새 세션 토큰 반환 ----
    def signup(self, email: str, password: str) -> str:
        email = _normalize_email(email)
        _validate(email, password)
        salt = secrets.token_bytes(16)
        pw_hash = self._hash_pw(password, salt)
        try:
            with self._engine.begin() as conn:
                res = conn.execute(insert(_users).values(
                    email=email, pw_hash=pw_hash, pw_salt=salt, created_at=time.time()))
                user_id = int(res.inserted_primary_key[0])
        except IntegrityError:
            raise EmailTaken("이미 가입된 이메일이에요. 로그인해 주세요.")
        return self._new_session(user_id)

    def login(self, email: str, password: str) -> str:
        email = _normalize_email(email)
        # 정상 비밀번호는 8~200자 — 그 범위 밖은 일치할 수 없으니 해시(PBKDF2) 전에
        # 잘못된 자격증명으로 처리한다(거대 입력으로 해시/파싱 비용을 못 내게).
        if not isinstance(password, str) or not (_MIN_PW_LEN <= len(password) <= _MAX_PW_LEN):
            raise InvalidCredentials("이메일 또는 비밀번호가 올바르지 않아요.")
        with self._engine.connect() as conn:
            row = conn.execute(
                select(_users.c.id, _users.c.pw_hash, _users.c.pw_salt)
                .where(_users.c.email == email)
            ).first()
        if row is None:
            # 없는 계정도 해시 한 번 계산 — 응답시간으로 가입 여부가 새지 않게
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
        with self._engine.begin() as conn:
            conn.execute(insert(_sessions).values(
                token_hash=token_hash, user_id=user_id,
                expires_at=time.time() + SESSION_TTL_SEC))
        return token

    def user_for_token(self, token: str | None) -> dict | None:
        """세션 토큰 → {'id','email'} 또는 None(없음/만료). 만료 세션은 정리한다."""
        if not token:
            return None
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        with self._engine.connect() as conn:
            row = conn.execute(
                select(_users.c.id, _users.c.email, _sessions.c.expires_at)
                .select_from(_sessions.join(_users, _users.c.id == _sessions.c.user_id))
                .where(_sessions.c.token_hash == token_hash)
            ).first()
            if row is None:
                return None
            user_id, email, expires_at = row
            if float(expires_at) < time.time():
                conn.execute(delete(_sessions).where(_sessions.c.token_hash == token_hash))
                conn.commit()
                return None
        return {"id": int(user_id), "email": str(email)}

    def logout(self, token: str | None) -> None:
        if not token:
            return
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        with self._engine.begin() as conn:
            conn.execute(delete(_sessions).where(_sessions.c.token_hash == token_hash))

    def purge_expired(self) -> int:
        with self._engine.begin() as conn:
            res = conn.execute(delete(_sessions).where(_sessions.c.expires_at < time.time()))
            return res.rowcount or 0

    def user_count(self) -> int:
        with self._engine.connect() as conn:
            return int(conn.execute(select(func.count()).select_from(_users)).scalar() or 0)

    def close(self) -> None:
        self._engine.dispose()
