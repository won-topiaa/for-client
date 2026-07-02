/**
 * TikTok Lite 포인트 파머 — 설정 (기기 저장소에 영구 저장)
 * ------------------------------------------------------------------
 * 앱 안의 [좌표설정] 버튼으로 좌표를 잡으면 이 값들이 자동 저장됩니다.
 * 직접 손볼 필요는 거의 없지만, 기본값을 바꾸고 싶으면 DEFAULTS 를 수정하세요.
 *
 * 좌표는 "화면 비율(0.0~1.0)"입니다.  x: 0=왼쪽,1=오른쪽 / y: 0=위,1=아래
 */

var STORE = storages.create("ttl_farmer_v1");

var DEFAULTS = {
  // ── 앱 정보 ──
  appName: "TikTok Lite",
  packageCandidates: [
    "com.ss.android.ugc.aweme.lite", // 글로벌 TikTok Lite
    "com.zhiliaoapp.musically.go",    // 일부 지역 TikTok Lite
  ],

  // ── 실행 모드 ──
  //  "farm" = 켜두면 무한 파밍(영상 시청으로 타이머 충전 → 20분마다 수령 반복)
  //  "once" = 1~12 단계를 한 바퀴만 돌고 앱 종료
  mode: "farm",
  maxCycles: 1,     // once 모드에서 6~10 반복 횟수
  humanize: true,   // 대기시간에 약간의 랜덤을 줘서 사람처럼(탐지 완화)
  keepScreenOn: true,

  // ── 대기 시간(ms) ──
  timing: {
    afterLaunch: 6000,       // 앱 실행 후 로딩 대기
    afterPopupClose: 1200,   // 팝업 닫은 뒤 대기
    watchDurationMs: 5 * 60 * 1000,   // (once 모드) 초기 시청 시간
    scrollIntervalMs: 20000, // 영상 1개 시청 시간(뒤 다음 영상으로 스크롤)
    afterAdWatch: 30000,     // (8단계) 광고 기본 대기 30초
    adExtraWaitMs: 45000,    // 광고가 더 길 때 닫기버튼을 추가로 기다리는 최대 시간
    betweenCycleMs: 20 * 60 * 1000,   // 타이머 수령 간격(=20분 시청)
    shortWait: 1500,         // 화면 전환 등 짧은 대기
    dailyAttendanceMs: 24 * 60 * 60 * 1000, // 출석체크 주기
  },

  // ── 버튼 텍스트(접근성으로 우선 탐색) ──
  texts: {
    receive:    ["받기", "受け取る", "Collect", "Claim", "Receive"],
    watchAd:    ["광고 보기", "광고보기", "動画を見る", "Watch", "Watch ad", "무료 시청"],
    timer:      ["타이머", "Timer"],
    attendance: ["출석체크", "출석 체크", "출석", "Check-in", "Attendance", "Daily"],
    close:      ["닫기", "×", "✕", "✖", "X", "Close", "취소", "取消", "Skip",
                 "건너뛰기", "나중에", "Later", "No thanks"],
  },

  // ── 좌표(화면 비율). [좌표설정]으로 잡으면 덮어써집니다 ──
  coords: {
    popupClose:      { x: 0.90, y: 0.12 }, // 팝업 우측 상단 X
    heart:           { x: 0.93, y: 0.50 }, // 우측 중간 하트
    pointButton:     { x: 0.30, y: 0.95 }, // 좌측 하단 두번째 포인트 버튼
    timer:           { x: 0.50, y: 0.85 }, // 타이머 버튼
    topLeftP:        { x: 0.07, y: 0.06 }, // 좌측 상단 p
    videoLike:       { x: 0.93, y: 0.55 }, // 영상 좋아요
    attendanceCheck: { x: 0.50, y: 0.20 }, // 출석체크 버튼
  },

  retry: { findTimeoutMs: 4000 },
};

// ── 깊은 병합 ──
function deepMerge(base, over) {
  if (over == null) return clone(base);
  var out = Array.isArray(base) ? base.slice() : {};
  for (var k in base) out[k] = clone(base[k]);
  for (var k2 in over) {
    if (base[k2] && typeof base[k2] === "object" && !Array.isArray(base[k2])) {
      out[k2] = deepMerge(base[k2], over[k2]);
    } else if (over[k2] !== undefined) {
      out[k2] = clone(over[k2]);
    }
  }
  return out;
}
function clone(v) { return (v && typeof v === "object") ? JSON.parse(JSON.stringify(v)) : v; }

var active = deepMerge(DEFAULTS, STORE.get("config", null));

module.exports = {
  DEFAULTS: DEFAULTS,
  get: function () { return active; },
  save: function () { STORE.put("config", active); },
  set: function (cfg) { active = deepMerge(DEFAULTS, cfg); STORE.put("config", active); },
  reset: function () { active = clone(DEFAULTS); STORE.put("config", active); },
};
