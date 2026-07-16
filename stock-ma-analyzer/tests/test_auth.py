"""회원 인증(이메일 가입/로그인) + '오늘의 지지선 터치' 게이팅 테스트."""
import time

import pytest
from fastapi.testclient import TestClient

from app.auth import AuthError, AuthStore, EmailTaken, InvalidCredentials
from app.server import app


# ---------- AuthStore 단위 테스트 (임시 DB) ----------
@pytest.fixture()
def store(tmp_path):
    return AuthStore(tmp_path / "auth.db")


def test_signup_then_login(store):
    tok = store.signup("User@Example.com", "s3cretpw!")
    assert store.user_for_token(tok)["email"] == "user@example.com"  # 이메일 정규화
    tok2 = store.login("user@example.com", "s3cretpw!")
    assert store.user_for_token(tok2)["email"] == "user@example.com"


def test_wrong_password_rejected(store):
    store.signup("a@b.com", "correcthorse")
    with pytest.raises(InvalidCredentials):
        store.login("a@b.com", "wrongpassword")
    with pytest.raises(InvalidCredentials):   # 없는 계정도 동일 오류(정보 노출 방지)
        store.login("nobody@b.com", "whatever1")


def test_duplicate_email_rejected(store):
    store.signup("dup@b.com", "password1")
    with pytest.raises(EmailTaken):
        store.signup("DUP@b.com", "password2")  # 대소문자 무시 중복


def test_validation(store):
    with pytest.raises(AuthError):
        store.signup("not-an-email", "password1")
    with pytest.raises(AuthError):
        store.signup("x@y.com", "short")         # 8자 미만
    with pytest.raises(AuthError):
        store.signup("x@y.com", "x" * 201)       # 너무 김


def test_password_not_stored_plaintext(store):
    store.signup("p@b.com", "supersecretpw")
    row = store._conn.execute("SELECT pw_hash, pw_salt FROM users").fetchone()
    assert b"supersecretpw" not in bytes(row[0])
    assert len(row[1]) == 16                      # 솔트 존재


def test_session_expiry_and_logout(store, monkeypatch):
    tok = store.signup("e@b.com", "password1")
    assert store.user_for_token(tok) is not None
    # 만료된 세션은 None 을 돌려주고 정리한다
    import app.auth as mod
    monkeypatch.setattr(mod, "SESSION_TTL_SEC", -1)
    tok2 = store.login("e@b.com", "password1")
    assert store.user_for_token(tok2) is None
    # 로그아웃하면 세션 무효화
    monkeypatch.setattr(mod, "SESSION_TTL_SEC", 3600)
    tok3 = store.login("e@b.com", "password1")
    assert store.user_for_token(tok3) is not None
    store.logout(tok3)
    assert store.user_for_token(tok3) is None


def test_bad_token_is_none(store):
    assert store.user_for_token(None) is None
    assert store.user_for_token("") is None
    assert store.user_for_token("garbage-token") is None


def test_login_rejects_overlong_password_without_hashing(store):
    """로그인도 비밀번호 길이 상한(200)을 적용 — 거대한 입력을 해시하지 않는다."""
    store.signup("cap@b.com", "password123")
    with pytest.raises(InvalidCredentials):
        store.login("cap@b.com", "x" * 5000)


def test_email_control_chars_rejected(store):
    """정규식을 통과하는 제어문자(NUL 등) 이메일을 거른다 (유사-중복 계정 방지)."""
    with pytest.raises(AuthError):
        store.signup("a\x00@b.com", "password123")
    with pytest.raises(AuthError):
        store.signup("x@y.com\x01", "password123")


# ---------- 서버 통합 테스트 (게이팅) ----------
@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_touches_requires_login(client):
    fresh = TestClient(app)  # 쿠키 없는 클라이언트
    assert fresh.get("/api/touches?market=kr").status_code == 401
    # 페이지는 /login 으로 리다이렉트
    r = fresh.get("/touches", follow_redirects=False)
    assert r.status_code == 302 and "/login" in r.headers["location"]


def test_signup_login_flow_grants_touches(client):
    # 가입하면 세션 쿠키가 발급되고 터치 API 가 열린다
    r = client.post("/api/auth/signup",
                    json={"email": "flow@example.com", "password": "password123"})
    assert r.status_code == 200 and r.json()["email"] == "flow@example.com"
    assert client.cookies.get("wt_session")
    assert client.get("/api/auth/me").json()["email"] == "flow@example.com"
    assert client.get("/api/touches?market=kr").status_code == 200
    # 로그아웃하면 다시 막힌다
    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/touches?market=kr").status_code == 401


def test_duplicate_signup_409(client):
    client.post("/api/auth/signup", json={"email": "dup2@example.com", "password": "password123"})
    r = client.post("/api/auth/signup", json={"email": "dup2@example.com", "password": "password123"})
    assert r.status_code == 409


def test_login_wrong_password_401(client):
    client.post("/api/auth/signup", json={"email": "wp@example.com", "password": "password123"})
    client.post("/api/auth/logout")
    r = client.post("/api/auth/login", json={"email": "wp@example.com", "password": "nope-nope-nope"})
    assert r.status_code == 401
    assert client.get("/api/touches?market=kr").status_code == 401


def test_signup_validation_400(client):
    assert client.post("/api/auth/signup",
                       json={"email": "bad", "password": "password123"}).status_code == 400
    assert client.post("/api/auth/signup",
                       json={"email": "ok@example.com", "password": "short"}).status_code == 400


def test_auth_bad_json_400(client):
    r = client.post("/api/auth/login", content=b"not json",
                    headers={"Content-Type": "application/json"})
    assert r.status_code == 400


def test_login_page_served(client):
    r = client.get("/login")
    assert r.status_code == 200 and "회원 전용" in r.text


def test_login_redirect_blocks_open_redirect(client):
    """로그인 상태에서 /login?next=... 가 외부 사이트로 튀지 않는다 (오픈 리다이렉트)."""
    client.post("/api/auth/signup",
                json={"email": "redir@example.com", "password": "password123"})
    try:
        for bad in ("//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)"):
            r = client.get("/login", params={"next": bad}, follow_redirects=False)
            assert r.status_code == 302
            assert r.headers["location"] == "/touches", f"open redirect: {bad}"
        # 사이트 내부 경로는 그대로 허용
        r = client.get("/login", params={"next": "/ma"}, follow_redirects=False)
        assert r.headers["location"] == "/ma"
    finally:
        client.post("/api/auth/logout")
