"""앱인토스용 앱 아이콘(static/icon.png, 512x512) 생성.

앱인토스는 아이콘을 파일이 아니라 '이미지 URL' 로 받으므로, 사이트가 서빙하는
static/icon.png 을 만들어 두고 granite.config.ts 의 brand.icon 이 그 주소를 가리킨다.
외부 도구 없이 표준 라이브러리만으로 PNG 를 쓴다 (재현 가능).

사용: python apps-in-toss/scripts/make_icon.py  (저장소 루트에서)
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

SIZE = 512

# 사이트 공통 팔레트 (라이트 기준): 에메랄드 배경 + 흰 캔들 + 앰버 이평선
BG_TOP = (16, 185, 129)      # emerald-500
BG_BOTTOM = (4, 120, 87)     # emerald-700
WHITE = (255, 255, 255)
AMBER = (251, 191, 36)       # amber-400 — 이평선


def make_canvas() -> list[bytearray]:
    rows = []
    for y in range(SIZE):
        t = y / (SIZE - 1)
        r = int(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
        g = int(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
        b = int(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
        rows.append(bytearray(bytes((r, g, b)) * SIZE))
    return rows


def put(rows: list[bytearray], x: int, y: int, color: tuple[int, int, int], alpha: float = 1.0) -> None:
    if 0 <= x < SIZE and 0 <= y < SIZE:
        i = x * 3
        row = rows[y]
        for k in range(3):
            row[i + k] = int(row[i + k] * (1 - alpha) + color[k] * alpha)


def fill_rect(rows: list[bytearray], x0: int, y0: int, x1: int, y1: int,
              color: tuple[int, int, int], alpha: float = 1.0) -> None:
    for y in range(max(0, y0), min(SIZE, y1)):
        for x in range(max(0, x0), min(SIZE, x1)):
            put(rows, x, y, color, alpha)


def candle(rows: list[bytearray], cx: int, top: int, bottom: int,
           wick_top: int, wick_bottom: int, width: int) -> None:
    fill_rect(rows, cx - 3, wick_top, cx + 3, wick_bottom, WHITE, 0.9)
    fill_rect(rows, cx - width // 2, top, cx + width // 2, bottom, WHITE)


def ma_curve(rows: list[bytearray], thickness: int) -> None:
    """왼쪽 아래에서 오른쪽 위로 완만하게 휘는 이평선."""
    prev_y = None
    for x in range(40, SIZE - 40):
        t = (x - 40) / (SIZE - 80)
        # 완만한 상승 곡선 (2차 곡선): 시작 400 -> 끝 150, 중간이 살짝 처짐
        y = 400 - 250 * t + 60 * (t * (1 - t)) * 2
        y = int(y)
        ys = [y] if prev_y is None else range(min(prev_y, y), max(prev_y, y) + 1)
        for yy in ys:
            for dy in range(-thickness // 2, thickness // 2 + 1):
                edge = abs(dy) >= thickness // 2
                put(rows, x, yy + dy, AMBER, 0.45 if edge else 1.0)
        prev_y = y


def write_png(path: Path, rows: list[bytearray]) -> None:
    raw = b"".join(b"\x00" + bytes(row) for row in rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 2, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    path.write_bytes(png)


def main() -> None:
    rows = make_canvas()
    # 캔들 3개 (지지선 위에서 반등하는 모양)
    candle(rows, 140, 260, 360, 210, 395, 56)
    candle(rows, 256, 200, 330, 160, 380, 56)
    candle(rows, 372, 130, 260, 95, 300, 56)
    # 이평선(앰버)이 캔들 아래를 받치며 우상향
    ma_curve(rows, 18)
    out = Path(__file__).resolve().parents[2] / "static" / "icon.png"
    write_png(out, rows)
    print(f"OK: {out} ({out.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
