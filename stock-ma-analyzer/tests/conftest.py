"""테스트 공통 설정.

기본 공급자(auto->free)는 외부 네트워크(FinanceDataReader/Yahoo)를 쓰므로,
서버 통합 테스트는 결정적인 샘플 공급자로 고정한다. 개별 공급자 테스트는
공급자를 직접 생성하므로 영향받지 않는다.
"""
import atexit
import os
import pathlib
import shutil
import sys
import tempfile

import pytest

os.environ["MA_PROVIDER"] = "sample"  # 셸에 다른 값이 있어도 강제 (결정성)

# 회원 인증 테스트는 실제 data/auth.db 를 오염시키지 않게 임시 DB 를 쓴다.
#
# 경로는 반드시 '이 프로세스만의' 것이어야 한다. 예전처럼 고정 경로
# (/tmp/wt_test_auth.db)를 쓰면서 임포트 시점에 지우면, 테스트가 두 번 겹쳐
# 돌 때(두 번째 실행이 시작되거나, 앞 실행이 아직 정리 중일 때) 한쪽이 다른
# 쪽의 DB·WAL 파일을 삭제해 버려 가입 충돌·엉뚱한 예외로 무더기 실패가 났다.
# mkdtemp 는 프로세스마다 새 디렉터리를 주므로 그 경합이 원천적으로 사라진다.
_auth_dir = pathlib.Path(tempfile.mkdtemp(prefix="wt_test_auth_"))
_auth_db = _auth_dir / "auth.db"
os.environ["AUTH_DB_PATH"] = str(_auth_db)


@atexit.register
def _cleanup_auth_db() -> None:
    """세션이 끝나면 이 프로세스의 임시 DB 디렉터리를 통째로 정리."""
    shutil.rmtree(_auth_dir, ignore_errors=True)


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


@pytest.fixture(autouse=True)
def _clear_rate_windows():
    """레이트리밋 창을 테스트마다 초기화 — 모듈 스코프 클라이언트로 수십 개
    테스트가 같은 IP 버킷을 공유하므로, 누적 카운트가 뒤 테스트를 429 로
    오염시키지 않게 한다."""
    try:
        from app import server
        server._rate_windows.clear()
    except Exception:
        pass
    yield
