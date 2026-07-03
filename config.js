/**
 * TikTok Lite 포인트 파머 — 설정 (기기 저장소에 영구 저장)
 * ------------------------------------------------------------------
 * v2: 실제 "리워드(초록) 페이지"의 한글 버튼을 텍스트로 찾아 누르는 방식.
 *     좌표는 최소한(포인트 탭 열기, 광고 닫기 X)만 사용 → 기기 달라도 잘 됨.
 *
 * 좌표는 "화면 비율(0.0~1.0)"입니다. x: 0=왼쪽,1=오른쪽 / y: 0=위,1=아래
 */

var STORE = storages.create("ttl_farmer_v2");

var DEFAULTS = {
  // ── 앱 정보 ──
  appName: "TikTok Lite",
  packageCandidates: [
    "com.ss.android.ugc.aweme.lite",
    "com.zhiliaoapp.musically.go",
  ],

  // ── 실행 모드 ──
  //  "farm" = 켜두면 무한 파밍(리워드 수확 → 20분 대기 반복)
  //  "once" = 리워드 페이지에서 받을 수 있는 것 1회 수확 후 종료
  mode: "farm",
  humanize: true,   // 대기시간·탭 위치 랜덤(사람처럼)
  keepScreenOn: true,
  watchVideosForTimer: true, // 20분 대기 동안 영상 시청으로 타이머 충전

  // ── 대기 시간(ms) ──
  timing: {
    afterLaunch: 6000,
    afterPopupClose: 1000,
    afterTapReward: 2500,    // 리워드 버튼 누른 뒤 팝업/광고 뜨는 시간
    adBaseWaitMs: 30000,     // 광고 기본 시청 대기
    adExtraWaitMs: 45000,    // 광고가 더 길 때 닫기(X)를 추가로 기다리는 최대 시간
    betweenCycleMs: 20 * 60 * 1000, // 타이머 수령 간격(20분)
    scrollIntervalMs: 18000, // 영상 1개 시청 시간
    shortWait: 1200,
    dailyAttendanceMs: 24 * 60 * 60 * 1000,
  },

  // ── 팝업/캡차 처리 ──
  popup: {
    maxRounds: 12,       // 첫 진입 시 팝업을 최대 몇 번 반복해 닫을지(이벤트 10개+)
    roundGapMs: 800,
    closeSpots: [        // 텍스트로 못 닫을 때 눌러볼 닫기(X) 후보 좌표
      { x: 0.90, y: 0.06 }, // 우측 상단
      { x: 0.50, y: 0.90 }, // 하단 중앙(닫기 바)
      { x: 0.50, y: 0.86 },
      { x: 0.93, y: 0.10 },
      { x: 0.07, y: 0.06 }, // 좌측 상단
    ],
  },

  // ── 버튼 텍스트(핵심! 실제 리워드 페이지 한글 라벨) ──
  texts: {
    // 리워드(초록) 페이지에 있는지 확인하는 표식
    pageMarker: ["추천 리워드", "타이머", "리워드", "출석", "포인트"],
    // 각 리워드 액션 버튼
    attendance: ["출석하기", "출석체크", "출석 체크", "출석"],
    timerCard:  ["20분마다", "타이머 누르고", "타이머"],
    adReward:   ["광고보고 추가 보상", "광고보고", "광고 보고", "광고를 시청", "광고 보기", "광고보기"],
    dailyAd:    ["매일 광고", "매일 광고를 시청"],
    videoStart: ["영상 시청", "Start"],
    // 광고 화면에서 광고 시작 버튼
    adStart:    ["지금 시작하기", "시작하기", "무료 시청", "지금 시청"],
    // 리워드 수령/팝업 확인
    receive:    ["받기", "수령", "Collect", "Claim"],
    confirm:    ["확인", "완료", "OK", "Got it"],
    // 팝업/광고 닫기
    close:      ["닫기", "×", "✕", "✖", "X", "취소", "取消", "Skip", "건너뛰기",
                 "나중에", "Later", "No thanks", "확인", "완료"],
    // 이벤트(게임/스핀 등 — 자동화가 어려우므로 누르지 않고 닫음)
    event:      ["참여하기", "럭키 스핀", "킥오프", "복권참가"],
    // CAPTCHA/보안인증 감지 → 자동 정지
    captcha:    ["인증", "보안 인증", "확인해 주세요", "퍼즐", "슬라이드", "드래그",
                 "captcha", "verify", "verification", "Slide", "Drag", "puzzle",
                 "비정상", "이상 행동", "이상행동", "abnormal", "unusual activity",
                 "로봇이 아닙니다", "본인 확인"],
  },

  // ── 좌표(최소한만 사용). [좌표설정]으로 잡으면 덮어써짐 ──
  coords: {
    pointButton: { x: 0.30, y: 0.95 }, // 리워드 페이지 여는 탭(좌측하단 두번째)
    adClose:     { x: 0.93, y: 0.05 }, // 광고 화면 닫기 X(우측상단)
    scrollBase:  { x: 0.50, y: 0.50 }, // 리워드 페이지 스크롤 기준점
  },

  retry: { findTimeoutMs: 3500 },
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
