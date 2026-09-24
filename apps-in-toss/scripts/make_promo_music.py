"""홍보 영상 배경음악 — 코드로 합성한 오리지널 곡 (저작권: 원토피아 소유, 외부 음원 없음).

왜 합성하나: 인터넷의 '무료 음원'은 라이선스가 제각각이고(상업 광고 금지, 출처 표기
의무, 플랫폼별 예외…), 광고에 쓰면 나중에 저작권 신고로 영상이 내려갈 수 있다.
여기서 만든 소리는 전부 이 파일의 수식에서 나오므로 그런 위험이 없다.

    python apps-in-toss/scripts/make_promo_music.py   # → scripts/store/promo_music.wav

곡: D장조 · 120 BPM · 27.5초. 마디가 홀수 초(1, 3, 5 …)에서 시작하도록 격자를 잡아
영상 전환과 음악의 큰 순간이 겹친다 (시각은 make_promo_video.mjs 의 타임라인과 같다).

    0.0–3.0   인트로 — 필터가 열리는 패드 + 플럭 아르페지오, 3초로 올라가는 라이저
    3.0       드롭 — 훅 패널이 올라가며 폰이 나오는 순간
    3.0–15.0  A — 킥 · 클랩 · 하이햇 · 베이스 · 사이드체인 패드 (D A Bm G D A)
    15.0–21.0 B — NEW 차트 패턴, 리드 멜로디가 얹힌다 (D A Bm)
    21.0–24.0 브레이크다운 — 다크 모드. 드럼이 빠지고 필터가 닫히며 '밤'으로 (G · A)
    24.0      마지막 D 코드 + 임팩트 — 엔드 카드
    25.0      CTA 가 뜨는 순간 차임
    26.3–27.5 페이드아웃

효과음: 화면을 누르는 순간 탭, 페이지가 넘어가는 순간 휙 소리 — 영상의 TAPS · 전환 시각.
결과물은 -14 LUFS(유튜브·인스타 기준 음량), 트루피크 -1.5 dBFS 로 맞춘다.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.ndimage import maximum_filter1d
from scipy.signal import butter, fftconvolve, lfilter, sosfilt, sosfilt_zi

HERE = Path(__file__).resolve().parent
OUT = HERE / "store" / "promo_music.wav"

SR = 44100
DUR = 27.5
N = int(SR * DUR)
BEAT = 0.5  # 120 BPM
RNG = np.random.default_rng(20260924)  # 같은 입력 → 같은 곡


def midi(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def tt(n: int) -> np.ndarray:
    return np.arange(n) / SR


def noise(n: int) -> np.ndarray:
    return RNG.uniform(-1, 1, n)


# ---------------------------------------------------------------- 오실레이터


def _polyblep(ph: np.ndarray, dt: np.ndarray) -> np.ndarray:
    """톱니파 불연속점의 앨리어싱을 깎는다 — 높은 음에서 '지직'거리는 소리를 없앤다."""
    y = np.zeros_like(ph)
    m = ph < dt
    x = ph[m] / dt[m]
    y[m] = x + x - x * x - 1
    m = ph > 1 - dt
    x = (ph[m] - 1) / dt[m]
    y[m] = x * x + x + x + 1
    return y


def saw(freq, n: int, phase0: float = 0.0) -> np.ndarray:
    f = np.broadcast_to(np.asarray(freq, dtype=float), (n,))
    dt = f / SR
    ph = (phase0 + np.cumsum(dt) - dt[0]) % 1.0
    return 2 * ph - 1 - _polyblep(ph, dt)


def square(freq, n: int) -> np.ndarray:
    return 0.5 * (saw(freq, n) - saw(freq, n, 0.5))


def sine(freq, n: int, phase0: float = 0.0) -> np.ndarray:
    f = np.broadcast_to(np.asarray(freq, dtype=float), (n,))
    return np.sin(2 * np.pi * (np.cumsum(f) / SR) + phase0)


def adsr(n: int, a: float, d: float, s: float, r: float, hold: float) -> np.ndarray:
    """hold 초 동안 누르고 있다가 r 초에 걸쳐 놓는다. n 은 전체 길이(hold + r 이상)."""
    t = tt(n)
    env = np.where(t < a, t / max(a, 1e-6), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-6)))
    rel = np.clip(1 - (t - hold) / max(r, 1e-6), 0, 1)
    level_at_release = np.interp(hold, t, env) if hold < t[-1] else 1.0
    return np.where(t < hold, env, level_at_release * rel)


# ---------------------------------------------------------------- 필터


def lp(x: np.ndarray, fc: float, order: int = 2) -> np.ndarray:
    return sosfilt(butter(order, min(fc, SR * 0.45), "low", fs=SR, output="sos"), x)


def hp(x: np.ndarray, fc: float, order: int = 2) -> np.ndarray:
    return sosfilt(butter(order, fc, "high", fs=SR, output="sos"), x)


def bp(x: np.ndarray, lo: float, hi: float, order: int = 2) -> np.ndarray:
    return sosfilt(butter(order, [lo, min(hi, SR * 0.45)], "band", fs=SR, output="sos"), x)


def sweep_lp(x: np.ndarray, cutoff: np.ndarray, block: int = 256) -> np.ndarray:
    """시간에 따라 차단 주파수가 움직이는 저역통과 — 인트로에서 열리고 다크 모드에서 닫힌다."""
    y = np.empty_like(x)
    zi = None
    for i in range(0, len(x), block):
        fc = float(np.clip(cutoff[min(i + block // 2, len(cutoff) - 1)], 60, SR * 0.45))
        sos = butter(2, fc, "low", fs=SR, output="sos")
        if zi is None:
            zi = sosfilt_zi(sos) * x[0]
        y[i:i + block], zi = sosfilt(sos, x[i:i + block], zi=zi)
    return y


# ---------------------------------------------------------------- 버스(스템)


class Bus:
    def __init__(self) -> None:
        self.s = np.zeros((2, N))

    def add(self, sig: np.ndarray, at: float, gain: float = 1.0, pan: float = 0.0) -> None:
        """mono 또는 (2, n) 신호를 at 초에 얹는다. pan -1(왼쪽)~1(오른쪽), 등전력."""
        i = int(round(at * SR))
        if i >= N:
            return
        if sig.ndim == 1:
            th = (pan + 1) * np.pi / 4
            sig = np.vstack([sig * np.cos(th), sig * np.sin(th)]) * np.sqrt(2)
        j = min(N, i + sig.shape[1])
        if i < 0:
            sig = sig[:, -i:]
            i = 0
        self.s[:, i:j] += sig[:, : j - i] * gain


# padbus: 패드·아르페지오 — 인트로에서 열리고 다크 모드에서 닫히는 필터를 함께 탄다
drums, duck, padbus, lead, fx = Bus(), Bus(), Bus(), Bus(), Bus()


# ---------------------------------------------------------------- 편곡 데이터

# 코드 보이싱(MIDI) — 가까운 음끼리 이어지게(보이스 리딩) 잡았다
CHORDS = {
    "D": [62, 66, 69, 76],   # D  F#  A  E   (Dadd9)
    "A": [61, 64, 69, 76],   # C# E   A  E   (A/C#)
    "Bm": [59, 62, 66, 74],  # B  D   F# D   (Bm)
    "G": [59, 62, 67, 69],   # B  D   G  A   (Gadd9)
}
BASS = {"D": 38, "A": 45, "Bm": 47, "G": 43}
ARP = {  # 아르페지오: 코드 톤을 한 옥타브 위에서
    "D": [74, 78, 81, 86],
    "A": [73, 76, 81, 85],
    "Bm": [71, 74, 78, 83],
    "G": [71, 74, 79, 83],
}

# (시작 초, 코드, 길이 초) — 마디는 2초
PROG = [
    (0.0, "D", 3.0),                                   # 인트로(1.5마디)
    (3.0, "D", 2), (5.0, "A", 2), (7.0, "Bm", 2), (9.0, "G", 2),
    (11.0, "D", 2), (13.0, "A", 2),                    # A
    (15.0, "D", 2), (17.0, "A", 2), (19.0, "Bm", 2),   # B (NEW 차트 패턴)
    (21.0, "G", 2), (23.0, "A", 1),                    # 브레이크다운 (다크 모드)
    (24.0, "D", 3.5),                                  # 엔드 카드
]


def chord_at(t: float) -> str:
    cur = PROG[0][1]
    for start, name, _ in PROG:
        if t >= start - 1e-9:
            cur = name
    return cur


# ---------------------------------------------------------------- 악기


def kick(gain: float = 1.0) -> np.ndarray:
    n = int(0.45 * SR)
    t = tt(n)
    f = 54 + 115 * np.exp(-t / 0.035)
    body = sine(f, n) * np.exp(-t / 0.2) * 0.7
    # 폰 스피커는 100Hz 아래를 거의 못 낸다 — 180Hz '노크'와 딸깍 소리가 킥을 들리게 한다
    knock = sine(180, n) * np.exp(-t / 0.03) * 0.45
    click = hp(noise(n), 2500) * np.exp(-t / 0.004) * 0.4
    return np.tanh(1.6 * (body + knock + click)) * gain


def clap() -> np.ndarray:
    n = int(0.35 * SR)
    t = tt(n)
    env = np.zeros(n)
    for k, off in enumerate((0.0, 0.010, 0.021)):
        tt_ = np.clip(t - off, 0, None)
        env += np.where(t >= off, np.exp(-tt_ / 0.006), 0) * (0.8 if k < 2 else 1.0)
    env += np.where(t >= 0.021, np.exp(-np.clip(t - 0.021, 0, None) / 0.11) * 0.55, 0)
    return bp(noise(n), 900, 5200) * env * 1.6


def hat(open_: bool = False) -> np.ndarray:
    n = int((0.25 if open_ else 0.06) * SR)
    t = tt(n)
    return hp(noise(n), 7500, 3) * np.exp(-t / (0.11 if open_ else 0.022))


def bass_note(m: int, dur: float) -> np.ndarray:
    n = int((dur + 0.05) * SR)
    f = midi(m)
    env = adsr(n, 0.004, 0.12, 0.6, 0.04, dur)
    tone = lp(saw(f, n) * 0.7 + square(f, n) * 0.3, 900) + sine(f, n) * 0.28
    return np.tanh(1.3 * tone) * env


def pad(names_and_spans, intro_open=None) -> None:
    """슈퍼소우 패드 — 음마다 톱니파 3개를 살짝 어긋나게 겹쳐 좌우로 벌린다."""
    for start, name, dur in names_and_spans:
        n = int((dur + 0.6) * SR)
        env = adsr(n, 0.02 if start >= 3 else 0.8, 0.4, 0.75, 0.55, dur)
        stereo = np.zeros((2, n))
        for m in CHORDS[name]:
            f = midi(m)
            for cents, pan in ((0, 0.0), (-11, -0.7), (11, 0.7)):
                v = saw(f * 2 ** (cents / 1200), n, RNG.uniform(0, 1))
                th = (pan + 1) * np.pi / 4
                stereo[0] += v * np.cos(th)
                stereo[1] += v * np.sin(th)
        stereo *= env / 7.0
        padbus.add(stereo, start, 1.0)


def pluck(m: int, gain: float) -> np.ndarray:
    n = int(0.32 * SR)
    t = tt(n)
    f = midi(m)
    tone = saw(f, n) * 0.6 + sine(f * 2, n) * 0.25
    return lp(tone, 3800) * np.exp(-t / 0.085) * gain


def lead_note(m: int, dur: float) -> np.ndarray:
    n = int((dur + 0.18) * SR)
    t = tt(n)
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.5 * t) * np.clip((t - 0.12) / 0.2, 0, 1)
    f = midi(m) * vib
    tone = lp(square(f, n) * 0.55 + saw(f * 1.003, n) * 0.45, 3200)
    return tone * adsr(n, 0.008, 0.18, 0.7, 0.14, dur)


def whoosh(length: float = 0.55, up: bool = True) -> np.ndarray:
    n = int(length * SR)
    t = tt(n) / length
    amp = np.sin(np.pi * t) ** 2
    src = noise(n)
    cutoff = 600 + 5200 * (t if up else 1 - t) ** 1.5
    return sweep_lp(hp(src, 300), cutoff) * amp


def tap() -> np.ndarray:
    n = int(0.06 * SR)
    t = tt(n)
    return (sine(2350, n) * 0.7 + sine(3520, n) * 0.3) * np.exp(-t / 0.011) + hp(noise(n), 4000) * np.exp(-t / 0.002) * 0.4


def pop() -> np.ndarray:
    n = int(0.14 * SR)
    t = tt(n)
    return sine(300 + 700 * np.exp(-t / 0.018), n) * np.exp(-t / 0.05)


def bell(m: int) -> np.ndarray:
    n = int(1.6 * SR)
    t = tt(n)
    f = midi(m)
    out = np.zeros(n)
    for ratio, g, dec in ((1, 1.0, 0.9), (2.0, 0.35, 0.5), (2.76, 0.25, 0.35), (5.4, 0.12, 0.15)):
        out += sine(f * ratio, n) * g * np.exp(-t / dec)
    return out * np.clip(t / 0.002, 0, 1)


def riser(length: float) -> np.ndarray:
    n = int(length * SR)
    t = tt(n) / length
    src = noise(n)
    return sweep_lp(hp(src, 400), 500 + 9000 * t ** 2) * (t ** 2.2)


def impact() -> np.ndarray:
    n = int(2.4 * SR)
    t = tt(n)
    sub = sine(62 * np.exp(-t / 1.4), n) * np.exp(-t / 0.7)
    crash = hp(noise(n), 3500) * np.exp(-t / 0.9) * 0.35
    return sub * 0.9 + crash


# ---------------------------------------------------------------- 곡 쓰기


def beats(a: float, b: float, step: float = BEAT):
    k = int(round(a / step))
    while k * step < b - 1e-9:
        yield round(k * step, 6)
        k += 1


def compose() -> None:
    pad(PROG)

    # 드럼 — A·B 섹션에만. 3.0 드롭에서 시작해 21.0 브레이크다운에서 빠진다
    for b in beats(3.0, 21.0):
        drums.add(kick(), b, 0.85)
        beat_in_bar = int(round((b - 1.0) / BEAT)) % 4        # 마디는 홀수 초에서 시작
        if beat_in_bar in (1, 3):
            drums.add(clap(), b, 0.40, pan=0.05)
        drums.add(hat(open_=True), b + 0.25, 0.14, pan=0.25)  # 뒷박 오픈햇
    for b in beats(3.0, 21.0, BEAT / 2):
        if abs((b / BEAT) - round(b / BEAT)) > 1e-6:
            continue
        drums.add(hat(), b, 0.09, pan=-0.3)
    for b in beats(9.0, 21.0, BEAT / 4):                      # 지지선부터 16분 하이햇으로 한 단계 올린다
        if abs((b * 4 / BEAT) % 2 - 1) < 1e-6:
            drums.add(hat(), b, 0.065, pan=-0.2)
    for b in beats(21.0, 23.0, BEAT * 2):                     # 브레이크다운: 부드러운 킥만 반 박자로
        drums.add(kick(0.55), b, 0.6)
    for k, b in enumerate(beats(23.0, 24.0, BEAT / 4)):       # 스네어 롤로 엔드 카드까지 끌어올린다
        drums.add(clap(), b, 0.08 + 0.26 * (k / 8) ** 1.5, pan=0.05)
    drums.add(kick(), 24.0, 1.0)
    drums.add(impact(), 24.0, 0.55)

    # 베이스 — 8분음표, 앞박은 쉬고 뒷박을 밀어 통통 튀게
    for b in beats(3.0, 21.0, BEAT / 2):
        name = chord_at(b)
        off = abs((b / BEAT) - round(b / BEAT)) > 1e-6
        m = BASS[name] + (12 if off and int(b * 4) % 4 == 3 else 0)
        duck.add(bass_note(m, 0.2), b, 0.30 if off else 0.22)
    duck.add(bass_note(BASS["D"], 2.6), 24.0, 0.32)

    # 플럭 아르페지오 — 인트로부터 끝까지, 다크 모드에선 음량을 줄여 멀어지게
    pattern = [0, 1, 2, 3, 2, 1, 2, 3]
    for k, b in enumerate(beats(0.5, 24.0, BEAT / 2)):
        name = chord_at(b)
        m = ARP[name][pattern[k % 8]]
        g = 0.16 if b < 3 else 0.13 if b < 21 else 0.10
        padbus.add(pluck(m, 1.0), b, g, pan=-0.35 if k % 2 else 0.35)

    # 리드 — B 섹션(NEW 차트 패턴)에서만. D 장조 펜타토닉으로 짧고 외우기 쉽게
    melody = [  # (박, MIDI, 길이 박)
        (0, 78, 0.5), (0.5, 81, 0.5), (1, 83, 1), (2, 81, 0.5), (2.5, 78, 0.5), (3, 76, 1),
        (4, 76, 0.5), (4.5, 73, 0.5), (5, 76, 1), (6, 81, 1), (7, 78, 1),
        (8, 74, 0.5), (8.5, 78, 0.5), (9, 83, 1), (10, 81, 0.5), (10.5, 78, 0.5), (11, 76, 0.75),
    ]
    for beat_, m, length in melody:
        at = 15.0 + beat_ * BEAT
        note = lead_note(m, length * BEAT * 0.92)
        lead.add(note, at, 0.16)
    # 엔드 카드: 마지막 D 코드 위에 리드가 '레—' 하고 한 번 더
    lead.add(lead_note(74, 1.4), 24.0, 0.12)

    # 효과음 — 영상 타임라인 그대로
    fx.add(whoosh(0.45, up=True), 1.15, 0.10, pan=-0.2)       # 취소선이 그어질 때
    fx.add(pop(), 1.55, 0.18)                                  # 둘째 줄이 올라올 때
    fx.add(riser(1.5), 1.5, 0.22)                              # 드롭으로
    fx.add(whoosh(0.6, up=True), 2.7, 0.22)                    # 훅 패널이 올라간다
    for at in (7.75, 9.2, 14.55, 16.75, 18.75):                # 화면을 누르는 순간 (TAPS)
        fx.add(tap(), at, 0.22, pan=0.1)
    for at in (9.45, 14.85):                                   # 페이지 전환
        fx.add(whoosh(0.5, up=False), at - 0.1, 0.12, pan=0.3)
    for at in (16.95, 18.95):                                  # 패턴 카드 바뀜
        fx.add(whoosh(0.35, up=True), at - 0.05, 0.06, pan=-0.3)
    fx.add(whoosh(1.2, up=False), 21.25, 0.16)                 # 다크 모드가 번진다
    fx.add(riser(0.9), 23.1, 0.20)
    fx.add(whoosh(0.6, up=False), 23.8, 0.2)                   # 엔드 패널이 내려온다
    fx.add(pop(), 24.35, 0.16)                                 # 아이콘이 튀어나온다
    fx.add(bell(81), 25.05, 0.16, pan=-0.15)                   # CTA — A5 · D6 차임
    fx.add(bell(86), 25.17, 0.14, pan=0.15)



# ---------------------------------------------------------------- 믹스


def sidechain() -> np.ndarray:
    """킥이 칠 때마다 패드·베이스를 눌렀다 놓는다 — 전자음악 특유의 '들숨' 펌핑."""
    g = np.ones(N)
    t = tt(N)
    for b in list(beats(3.0, 21.0)) + [24.0]:
        i = int(b * SR)
        seg_t = t[i:] - b
        dip = 1 - 0.55 * np.exp(-seg_t / 0.13)
        g[i:] = np.minimum(g[i:], dip)
    return g


def delay_pingpong(x: np.ndarray, time: float, fb: float, taps: int = 5) -> np.ndarray:
    d = int(time * SR)
    y = np.zeros_like(x)
    mono = x.mean(axis=0)
    for k in range(1, taps + 1):
        ch = (k + 1) % 2
        y[ch, k * d:] += mono[: N - k * d] * fb ** k
    return lp(y, 5000)


def reverb(x: np.ndarray, seconds: float = 1.8) -> np.ndarray:
    n = int(seconds * SR)
    t = tt(n)
    out = np.zeros_like(x)
    for ch in range(2):
        ir = lp(noise(n), 6500) * np.exp(-t / (seconds / 5.5))
        ir[: int(0.012 * SR)] = 0  # 프리딜레이
        ir /= np.sqrt(np.sum(ir ** 2))
        out[ch] = fftconvolve(x[ch], ir)[:N]
    return out


def k_weight(x: np.ndarray) -> np.ndarray:
    """ITU-R BS.1770 K 가중 필터 (44.1 kHz 계수)."""
    b1 = [1.53090959, -2.65116903, 1.16916686]
    a1 = [1.0, -1.66375011, 0.71265753]
    b2 = [1.0, -2.0, 1.0]
    a2 = [1.0, -1.98998964, 0.99000501]
    return lfilter(b2, a2, lfilter(b1, a1, x))


def lufs(x: np.ndarray) -> float:
    kw = np.vstack([k_weight(x[0]), k_weight(x[1])])
    blk, hop = int(0.4 * SR), int(0.1 * SR)
    z = np.array([np.mean(kw[:, i:i + blk] ** 2, axis=1).sum() for i in range(0, N - blk, hop)])
    lk = -0.691 + 10 * np.log10(z + 1e-12)
    z = z[lk > -70]
    rel = -0.691 + 10 * np.log10(z.mean()) - 10
    z = z[-0.691 + 10 * np.log10(z) > rel]
    return float(-0.691 + 10 * np.log10(z.mean()))


def limit(x: np.ndarray, ceiling_db: float = -1.5) -> np.ndarray:
    """5ms 앞을 보는 피크 리미터 — 찌그러뜨리지 않고 넘치는 봉우리만 누른다."""
    ceil = 10 ** (ceiling_db / 20)
    look = int(0.005 * SR)
    peak = maximum_filter1d(np.abs(x).max(axis=0), size=2 * look + 1)
    gain = np.minimum(1.0, ceil / np.maximum(peak, 1e-9))
    rel = np.exp(-1 / (0.08 * SR))
    smoothed = lfilter([1 - rel], [1, -rel], gain)
    gain = np.minimum(gain, smoothed)
    return x * gain


def cutoff_curve() -> np.ndarray:
    """패드 필터: 인트로 0→3초에 열리고, 다크 모드(21초~)에 닫혔다가, 엔드 카드 직전에 다시 열린다."""
    t = tt(N)
    c = np.full(N, 5200.0)
    m = t < 3.0
    c[m] = 500 * (5200 / 500) ** ((t[m] / 3.0) ** 1.2)
    m = (t >= 21.0) & (t < 22.6)
    c[m] = 5200 * (900 / 5200) ** ((t[m] - 21.0) / 1.6)
    c[(t >= 22.6) & (t < 23.2)] = 900
    m = (t >= 23.2) & (t < 24.0)
    c[m] = 900 * (5200 / 900) ** ((t[m] - 23.2) / 0.8)
    return c


def master() -> np.ndarray:
    cut = cutoff_curve()
    padf = np.vstack([sweep_lp(padbus.s[0], cut), sweep_lp(padbus.s[1], cut)])
    duck.s += padf
    duck.s *= sidechain()
    send = duck.s * 0.18 + lead.s * 0.35 + fx.s * 0.25 + drums.s * 0.06
    wet = reverb(send) * 0.55 + delay_pingpong(lead.s + padf * 0.2, 0.375, 0.38) * 0.5
    mix = drums.s + duck.s + lead.s + fx.s + wet
    mix = hp(mix, 40)                       # 폰 스피커가 못 내는 초저역은 음량만 잡아먹는다
    mix = mix + hp(mix, 2500) * 0.4         # 고역 존재감(+3dB 셸프) — 폰에서 먹먹하지 않게
    mix = np.tanh(mix * 1.1) / 1.1          # 살짝 테이프처럼 눌러 뭉친다
    t = tt(N)
    mix *= np.clip(t / 0.02, 0, 1)                                  # 시작 클릭 방지
    mix *= np.clip((DUR - t) / 1.2, 0, 1) ** 1.3                   # 끝 페이드아웃
    for _ in range(4):                       # 목표 음량에 수렴할 때까지 게인 → 리미트
        cur = lufs(mix)
        mix = limit(mix * 10 ** ((-14.0 - cur) / 20))
    return mix


def main() -> None:
    compose()
    mix = master()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    wavfile.write(OUT, SR, (np.clip(mix.T, -1, 1) * 32767).astype(np.int16))
    peak = 20 * np.log10(np.abs(mix).max())
    print(f"OK: {OUT} ({DUR}s, {SR} Hz 스테레오) · {lufs(mix):.1f} LUFS · 샘플 피크 {peak:.1f} dBFS")


if __name__ == "__main__":
    sys.exit(main())
