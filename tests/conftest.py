"""테스트 공통 설정.

기본 공급자(auto->free)는 외부 네트워크(FinanceDataReader/Yahoo)를 쓰므로,
서버 통합 테스트는 결정적인 샘플 공급자로 고정한다. 개별 공급자 테스트는
공급자를 직접 생성하므로 영향받지 않는다.
"""
import os
import pathlib
import sys
import tempfile

import pytest

os.environ["MA_PROVIDER"] = "sample"  # 셸에 다른 값이 있어도 강제 (결정성)

# 회원 인증 테스트는 실제 data/auth.db 를 오염시키지 않게 임시 DB 를 쓴다.
_auth_db = pathlib.Path(tempfile.gettempdir()) / "wt_test_auth.db"
for _p in (_auth_db, _auth_db.with_name(_auth_db.name + "-wal"),
           _auth_db.with_name(_auth_db.name + "-shm")):
    try:
        _p.unlink()
    except FileNotFoundError:
        pass
os.environ["AUTH_DB_PATH"] = str(_auth_db)


@pytest.fixture(autouse=True)
def _reset_rate_windows():
    """레이트리밋은 모듈 전역 상태 — 테스트 간 오염되지 않게 각 테스트 앞뒤로 비운다
    (모듈 스코프 client 를 공유해도 한 테스트의 호출 수가 다음 테스트에 안 샌다)."""
    mod = sys.modules.get("app.server")
    if mod is not None:
        mod._rate_windows.clear()
    yield
    mod = sys.modules.get("app.server")
    if mod is not None:
        mod._rate_windows.clear()
