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
  dailyAdBatch: 6,  // '매일 광고'(하루 40개)를 사이클당 몇 개씩 볼지(0=끄기)
                    // 몰아보면 봇 티가 나므로 나눠서 보는 게 안전

  // ── 대기 시간(ms) ── (UI 전환 대기는 최대한 짧게, 광고/영상 시청 시간만 유지)
  timing: {
    afterLaunch: 5000,
    afterPopupClose: 400,    // 팝업 닫은 뒤(짧게)
    afterTapReward: 1200,    // 리워드 버튼 누른 뒤 팝업/광고 뜨는 시간
    adBaseWaitMs: 20000,     // 광고 기본 시청 대기(광고 크레딧 위해 유지)
    adExtraWaitMs: 25000,    // 광고가 더 길 때 닫기(X)를 추가로 기다리는 최대 시간
    betweenCycleMs: 20 * 60 * 1000, // 타이머 수령 간격(20분, TikTok 고정)
    harvestBudgetMs: 8 * 60 * 1000, // 한 번의 수확 최대 시간(넘으면 피드로 탈출)
    scrollIntervalMs: 18000, // 영상 1개 시청 시간(게이지 충전용 — 유지)
    shortWait: 450,          // 탭 후 대기(짧게 — 화면 렌더링 최소치)
    tapGap: 250,             // 연속 클릭 사이 최소 간격
    dailyAttendanceMs: 24 * 60 * 60 * 1000,
  },

  // ── 팝업/캡차 처리 ──
  popup: {
    maxRounds: 12,       // 첫 진입 시 팝업을 최대 몇 번 반복해 닫을지(이벤트 10개+)
    roundGapMs: 450,
    closeSpots: [        // 텍스트로 못 닫을 때 눌러볼 닫기(X) 후보 좌표
      { x: 0.905, y: 0.83 }, // 하단 스티키 배너 ✕(야시장 챌린지 등, 실측)
      { x: 0.90, y: 0.06 },  // 우측 상단
      { x: 0.50, y: 0.90 },  // 하단 중앙(닫기 바)
      { x: 0.93, y: 0.10 },
      { x: 0.07, y: 0.06 },  // 좌측 상단
    ],
  },

  // ── 버튼 텍스트(실제 화면 녹화에서 실측한 한글 라벨) ──
  texts: {
    // 하단 탭 "포인트" — 텍스트로 눌러서 리워드 페이지 진입
    pointsTab:  ["포인트"],
    // 리워드(초록) 페이지 표식 — 이게 보이면 "리워드 페이지에 있음"
    pageMarker: ["추천 리워드", "출금하기", "보유 포인트", "상시 이벤트", "기간 한정 이벤트"],
    // 각 리워드 액션(실측 문구) — 카드는 '제목'으로 식별하고 그 카드의 버튼만 누름
    attendance: ["출석하기"],                        // 출석 카드의 버튼(하단 풀폭)
    timerTitle: ["타이머 누르고", "20분마다"],        // 타이머 카드 제목
    likeTitle:  ["좋아요", "누르면"],                 // 좋아요 미션 카드 제목
    likeStart:  ["시작하기"],                         // 좋아요 카드의 '시작하기'(카드 안에서만)
    adRewardTitle: ["광고 보면 추가 보상", "광고 보면", "광고보고 추가 보상"], // 광고 추가보상 카드
    dailyAdCard: ["매일 광고를 시청", "매일 광고", "시청하여 최대"], // 매일광고 카드 제목
    watchBtn:   ["시청"],                             // 매일광고/라이브 카드의 '시청' 버튼
    likeDone:   ["미션 완료"],                        // 좋아요 미션 완료 표시
    // 리워드 수령 버튼(실측: 타이머·좋아요 모두 "포인트 받기")
    receive:    ["포인트 받기", "받기", "수령"],
    confirm:    ["확인", "완료", "OK"],
    // 리워드 팝업 하단에 뜨는 '광고보기'(추가 보상) — 있으면 그 광고도 시청
    popupAd:    ["광고 보기", "광고보기", "광고 보고 받기", "동영상 보고 받기", "광고 시청하고"],
    // 모달 이벤트 팝업에만 나오는 표식(페이지 표식이 없을 때만 사용)
    eventPopup: ["획득하세요", "열기 시작", "행운의 주인공", "클릭만 하면",
                 "응모하기", "참여하기", "당첨 가능"],
    // 하단 스티키 배너(야시장 챌린지 등)
    banner:     ["야시장", "챌린지", "입장하기"],
    // 광고 화면 표식(상단 "15초 시청하고 30포인트 받기")
    adMarker:   ["시청하고"],
    // 팝업 닫기(텍스트/desc 기반 — 안전)
    close:      ["닫기", "×", "✕", "✖", "X", "취소", "Skip", "건너뛰기",
                 "나중에", "Later", "No thanks", "확인", "완료"],
    // CAPTCHA/보안인증 감지 → 자동 정지
    captcha:    ["인증", "보안 인증", "확인해 주세요", "퍼즐", "슬라이드", "드래그",
                 "captcha", "verify", "verification", "Slide", "Drag", "puzzle",
                 "비정상", "이상 행동", "이상행동", "abnormal", "unusual activity",
                 "로봇이 아닙니다", "본인 확인"],
  },

  // ── 좌표(실측 기반 기본값). [좌표설정]으로 잡으면 덮어써짐 ──
  coords: {
    pointButton: { x: 0.30, y: 0.92 }, // 하단 "포인트" 탭(텍스트 실패 시 폴백)
    adClose:     { x: 0.92, y: 0.065 }, // 광고 우측상단 X(실측)
    feedLike:    { x: 0.92, y: 0.57 },  // 피드 우측 하트(좋아요 미션용, 실측)
    bannerClose: { x: 0.905, y: 0.83 }, // 하단 스티키 배너 ✕(실측)
    // 모달 이벤트 팝업 닫기 ✕ 후보(페이지 표식 없을 때만 사용)
    eventCloseSpots: [
      { x: 0.50, y: 0.72 }, // 카드 아래 중앙 ✕(킥오프/스핀 팝업, 실측)
      { x: 0.90, y: 0.06 }, // 우측 상단
      { x: 0.50, y: 0.90 }, // 하단 중앙
    ],
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
