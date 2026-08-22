// 사용자에게 보이는 숫자/날짜 포맷 — 한 곳에서만 정의한다.

/** 가격: 1,000 이상은 정수+콤마, 미만은 소수 2자리 (미국 주식 대응) */
export function fmtPrice(v: number): string {
  if (!Number.isFinite(v)) {
    return '—';
  }
  if (Math.abs(v) >= 1000) {
    return Math.round(v).toLocaleString('ko-KR');
  }
  return v.toFixed(2);
}

/** 성공률 0~1 → "83%" */
export function fmtRate(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

/** 이격 % → "+1.2%" / "-0.8%" */
export function fmtDistPct(pct: number): string {
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}

/** "2025-08-22" → "25.08.22" (차트 축용 짧은 표기) */
export function fmtDateShort(time: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(time);
  if (!m) {
    return time;
  }
  return `${(m[1] ?? '').slice(2)}.${m[2]}.${m[3]}`;
}
