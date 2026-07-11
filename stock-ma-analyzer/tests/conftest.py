"""테스트 공통 설정.

기본 공급자(auto->free)는 외부 네트워크(FinanceDataReader/Yahoo)를 쓰므로,
서버 통합 테스트는 결정적인 샘플 공급자로 고정한다. 개별 공급자 테스트는
공급자를 직접 생성하므로 영향받지 않는다.
"""
import os

os.environ.setdefault("MA_PROVIDER", "sample")
