# 저장소가 두 개다 — 어디를 고쳐야 배포되나

**이 저장소(`won-topiaa/for-client`)는 배포되지 않는다.**
운영은 `won-topiaa/ma-radar` 의 `main` 이고, Render 가 그 브랜치를 자동 배포한다.

원본 문서는 운영 저장소에 있다: `won-topiaa/ma-radar` 의 `docs/REPOS.md`.
여기서는 이 저장소에서 일할 때 필요한 것만 적는다 — 같은 내용을 양쪽에 베껴
두면 한쪽만 고쳐져 오히려 헷갈린다.

## 무엇을 어디서 고치나

| | 고치는 곳 | 반영되는 방법 |
|---|---|---|
| 서버 · 웹사이트 (`app/`, `static/`, `tests/`) | **`ma-radar`** | `main` 에 푸시 → Render 자동 배포 |
| 미니앱 (`apps-in-toss/`) | **여기(`for-client`)** | `npx ait build` → `.ait` 를 앱인토스 콘솔에 업로드 |

## 이 저장소의 서버 사본에 손대지 말 것

`app/` · `tests/` · `render.yaml` · `requirements.txt` 가 여기에도 있지만
**2026-08-30 에서 멈춘 사본**이다. 그 뒤 운영에서 다음이 들어갔고, 여기에는
하나도 없다.

- DB 접속 IPv4 고정 (`ipv4_pinning_enabled`) — Neon × Render IPv6 불가로 서버가 부팅조차 못 했던 장애
- 커넥션 풀 `NullPool` — 접속을 붙잡아 Neon 컴퓨트를 못 재우던 문제(무료 한도 초과 → 프로젝트 정지)
- DB 없이도 부팅 + 자동 재연결
- `/api/analyze` 결과 캐시 (1.2초 재계산 제거)
- **앱 아이콘** — 여기 `static/icon.png` 는 옛 초록 아이콘이다. 실제 아이콘(흰 바탕 ·
  남색 캔들 · 주황 이평선)은 운영이 서빙하고, 앱은 `granite.config.ts` 의 `brand.icon`
  주소로 그걸 쓴다. 스크린샷·홍보 영상 스크립트는 `apps-in-toss/scripts/store/app_icon.png`
  를 읽는다 — 2026-09 에 이 낡은 사본을 읽어 스토어 가로 스크린샷과 영상에 옛 아이콘이 들어갔었다.

`render.yaml` 이 양쪽에 똑같이 들어 있어서, Render 를 실수로 이 저장소에
연결하면 위 수정이 전부 빠진 서버가 배포된다. 서버를 만질 일이 있으면
반드시 `ma-radar` 를 클론해서 거기서 한다.

## 앱 빌드에 서버가 필요할 때

`apps-in-toss/scripts/store_screenshot_data.py` 는 백테스트 엔진(`app/`)을
import 한다. 이 저장소의 사본은 오래됐으므로, **스토어 스크린샷용 데이터는
`ma-radar` 쪽에서 뽑아** `apps-in-toss/scripts/store/data.json` 으로 가져온다.
그림을 그리는 `make_store_screenshots.mjs` 는 이 저장소에서 돌린다.
