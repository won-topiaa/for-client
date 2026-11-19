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

/** 가격 변동폭 — 기준 가격이 화면에 보이는 자릿수와 맞춘다.
 *
 * fmtPrice 는 값 자체의 크기로 자릿수를 정한다(1,000 미만이면 소수 2자리). 변동폭을
 * 그대로 넘기면 원화 종목의 700원 변동이 "700.00" 으로 찍힌다(원화엔 소수가 없다).
 * 그래서 변동폭은 '그 가격(ref)'의 규칙을 따른다: 가격이 1,000 이상으로 정수로
 * 보이면 변동폭도 정수, 아니면 소수 2자리. */
export function fmtPriceDelta(delta: number, ref: number): string {
  if (!Number.isFinite(delta) || !Number.isFinite(ref)) {
    return '—';
  }
  if (Math.abs(ref) >= 1000) {
    return Math.round(delta).toLocaleString('ko-KR');
  }
  return delta.toFixed(2);
}

/** 성공률 0~1 → "83%". 값이 없으면 "—" (fmtPrice 와 같은 규약).
 *
 * 유한성 검사가 중요하다: 서버 응답의 필드 이름이 바뀌면 여기로 undefined 가
 * 흘러들어오는데(api 응답은 무검증 캐스팅이라 타입체커가 못 잡는다), 검사가
 * 없으면 화면에 "NaN%" 가 그대로 찍힌다. 실제로 그런 적이 있다. */
export function fmtRate(rate: number): string {
  if (!Number.isFinite(rate)) {
    return '—';
  }
  return `${(rate * 100).toFixed(0)}%`;
}

/** 이격 % → "+1.2%" / "-0.8%" */
export function fmtDistPct(pct: number): string {
  if (!Number.isFinite(pct)) {
    return '—';
  }
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
