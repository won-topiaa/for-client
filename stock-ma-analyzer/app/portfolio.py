"""작업물(포트폴리오) 카드 저장소 — /links 페이지에 보여줄 목록.

소유자가 관리 페이지(/links/admin)에서 직접 추가·수정·삭제·순서변경할 수
있게, 코드가 아니라 DB 에 저장한다. auth.py 와 같은 MetaData·엔진을 공유해
(같은 create_all 호출로 함께 생성) 별도 DB 설정이 필요 없다 — 운영에서는
회원 인증과 동일한 Postgres 에 함께 저장돼 재배포에도 지워지지 않는다.

아이콘은 관리 API 로 받지 않는다(이 모듈의 어떤 공개 함수도 icon_svg 를
인자로 받지 않는다) — sync_seed 로만 심어지는 신뢰된 문자열이라 그대로
HTML 에 꽂아도 안전하다. 반대로 title/description/badge/url 은 관리자
입력이라도 서버가 렌더링할 때 항상 이스케이프한다(server.py 참고).
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from sqlalchemy import (
    BigInteger,
    Column,
    Float,
    Integer,
    String,
    Table,
    Text,
    func,
    insert,
    select,
)
from sqlalchemy import delete as sa_delete
from sqlalchemy import update as sa_update
from sqlalchemy.engine import Engine

from .auth import _metadata

MAX_TITLE_LEN = 80
MAX_DESC_LEN = 200
MAX_BADGE_LEN = 24
MAX_URL_LEN = 500

_portfolio = Table(
    "portfolio_items", _metadata,
    Column("id", BigInteger().with_variant(Integer, "sqlite"), primary_key=True,
           autoincrement=True),
    Column("title", String(MAX_TITLE_LEN), nullable=False),
    Column("title_en", String(MAX_TITLE_LEN), nullable=False, server_default=""),
    Column("description", String(MAX_DESC_LEN), nullable=False, server_default=""),
    Column("description_en", String(MAX_DESC_LEN), nullable=False, server_default=""),
    Column("badge", String(MAX_BADGE_LEN), nullable=False, server_default=""),
    Column("badge_en", String(MAX_BADGE_LEN), nullable=False, server_default=""),
    Column("url", String(MAX_URL_LEN), nullable=False),
    # 관리 API 로는 절대 못 받는 필드 — sync_seed 전용(모듈 docstring 참고)
    Column("icon_svg", Text, nullable=False, server_default=""),
    Column("sort_order", Integer, nullable=False),
    Column("created_at", Float, nullable=False),
)

# 코드에 정의된 '기본 작업물(seed)'을 이미 반영했는지 기록하는 장부.
# sync_seed 가 각 seed 항목을 URL 키로 '한 번만' 반영하게 해, 사용자가 관리
# 페이지에서 지운 항목이 배포 때마다 되살아나는 것을 막는다(부활 방지).
_seed_applied = Table(
    "portfolio_seed_applied", _metadata,
    Column("seed_key", String(MAX_URL_LEN), primary_key=True),
    Column("applied_at", Float, nullable=False),
)


class PortfolioError(Exception):
    """입력 검증 실패 — 메시지를 그대로 사용자에게 보여준다."""


def _clean(value: object, max_len: int, label: str) -> str:
    s = str(value or "").strip()
    if len(s) > max_len:
        raise PortfolioError(f"{label}은(는) {max_len}자를 넘을 수 없어요.")
    return s


def _validate_title(value: object) -> str:
    title = _clean(value, MAX_TITLE_LEN, "제목")
    if not title:
        raise PortfolioError("제목을 입력해 주세요.")
    return title


def _validate_url(value: object) -> str:
    url = _clean(value, MAX_URL_LEN, "링크 주소")
    if not url:
        raise PortfolioError("링크 주소를 입력해 주세요.")
    if not (url.startswith("/") or url.startswith("http://") or url.startswith("https://")):
        raise PortfolioError(
            "링크 주소는 '/'로 시작하는 내부 경로이거나 http(s):// 로 시작해야 해요.")
    return url


@dataclass
class PortfolioItem:
    id: int
    title: str
    description: str
    badge: str
    url: str
    sort_order: int
    title_en: str = ""
    description_en: str = ""
    badge_en: str = ""
    icon_svg: str = ""
    created_at: float = field(default=0.0)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "titleEn": self.title_en,
            "description": self.description,
            "descriptionEn": self.description_en,
            "badge": self.badge,
            "badgeEn": self.badge_en,
            "url": self.url,
        }


def _row_to_item(row) -> PortfolioItem:
    m = row._mapping
    return PortfolioItem(
        id=m["id"], title=m["title"], title_en=m["title_en"],
        description=m["description"], description_en=m["description_en"],
        badge=m["badge"], badge_en=m["badge_en"], url=m["url"],
        icon_svg=m["icon_svg"], sort_order=m["sort_order"], created_at=m["created_at"],
    )


class PortfolioStore:
    """작업물 카드 CRUD. AuthStore 와 엔진을 공유(서버 시작 시 주입)한다."""

    def __init__(self, engine: Engine):
        self._engine = engine

    def list_items(self) -> list[PortfolioItem]:
        with self._engine.connect() as conn:
            rows = conn.execute(
                select(_portfolio).order_by(_portfolio.c.sort_order)).all()
        return [_row_to_item(r) for r in rows]

    def get(self, item_id: int) -> PortfolioItem | None:
        with self._engine.connect() as conn:
            row = conn.execute(
                select(_portfolio).where(_portfolio.c.id == item_id)).first()
        return _row_to_item(row) if row else None

    def create(self, *, title, description, badge, url,
               title_en="", description_en="", badge_en="") -> PortfolioItem:
        title = _validate_title(title)
        description = _clean(description, MAX_DESC_LEN, "설명")
        badge = _clean(badge, MAX_BADGE_LEN, "분류")
        url = _validate_url(url)
        title_en = _clean(title_en, MAX_TITLE_LEN, "영문 제목")
        description_en = _clean(description_en, MAX_DESC_LEN, "영문 설명")
        badge_en = _clean(badge_en, MAX_BADGE_LEN, "영문 분류")
        with self._engine.begin() as conn:
            next_order = conn.execute(
                select(func.coalesce(func.max(_portfolio.c.sort_order), -1) + 1)
            ).scalar_one()
            now = time.time()
            res = conn.execute(insert(_portfolio).values(
                title=title, title_en=title_en, description=description,
                description_en=description_en, badge=badge, badge_en=badge_en,
                url=url, icon_svg="", sort_order=next_order, created_at=now))
            new_id = int(res.inserted_primary_key[0])
        return PortfolioItem(
            id=new_id, title=title, title_en=title_en, description=description,
            description_en=description_en, badge=badge, badge_en=badge_en,
            url=url, sort_order=next_order, created_at=now)

    def update(self, item_id: int, *, title, description, badge, url,
               title_en="", description_en="", badge_en="") -> PortfolioItem:
        title = _validate_title(title)
        description = _clean(description, MAX_DESC_LEN, "설명")
        badge = _clean(badge, MAX_BADGE_LEN, "분류")
        url = _validate_url(url)
        title_en = _clean(title_en, MAX_TITLE_LEN, "영문 제목")
        description_en = _clean(description_en, MAX_DESC_LEN, "영문 설명")
        badge_en = _clean(badge_en, MAX_BADGE_LEN, "영문 분류")
        with self._engine.begin() as conn:
            res = conn.execute(sa_update(_portfolio).where(_portfolio.c.id == item_id).values(
                title=title, title_en=title_en, description=description,
                description_en=description_en, badge=badge, badge_en=badge_en, url=url))
            if res.rowcount == 0:
                raise PortfolioError("존재하지 않는 작업물이에요.")
        item = self.get(item_id)
        assert item is not None  # 방금 업데이트했으니 반드시 있다
        return item

    def delete(self, item_id: int) -> None:
        with self._engine.begin() as conn:
            res = conn.execute(sa_delete(_portfolio).where(_portfolio.c.id == item_id))
            if res.rowcount == 0:
                raise PortfolioError("존재하지 않는 작업물이에요.")

    def move(self, item_id: int, direction: str) -> None:
        """direction: 'up' 또는 'down' — 화면에 보이는 순서대로 인접 항목과
        sort_order 를 교환한다. 이미 맨 위/아래면 조용히 아무 일도 하지 않는다
        (맨 위 카드에서 '위로'를 또 눌러도 오류가 아니라 그냥 그대로가 자연스럽다)."""
        if direction not in ("up", "down"):
            raise PortfolioError("direction 은 up 또는 down 이어야 해요.")
        with self._engine.begin() as conn:
            rows = conn.execute(
                select(_portfolio.c.id, _portfolio.c.sort_order)
                .order_by(_portfolio.c.sort_order)).all()
            ids = [r.id for r in rows]
            orders = [r.sort_order for r in rows]
            try:
                idx = ids.index(item_id)
            except ValueError:
                raise PortfolioError("존재하지 않는 작업물이에요.")
            other = idx - 1 if direction == "up" else idx + 1
            if other < 0 or other >= len(ids):
                return  # 이미 끝 — 아무 것도 안 함
            conn.execute(sa_update(_portfolio).where(_portfolio.c.id == ids[idx])
                        .values(sort_order=orders[other]))
            conn.execute(sa_update(_portfolio).where(_portfolio.c.id == ids[other])
                        .values(sort_order=orders[idx]))

    def sync_seed(self, items: list[dict]) -> None:
        """코드에 정의된 '기본 작업물'을 DB 에 반영한다 — 각 항목을 URL 키로
        '딱 한 번'만 반영하는 멱등(idempotent) 동기화.

        - 아직 장부에 없고(=처음 보는 seed) 같은 URL 이 DB 에 없으면 맨 뒤에
          추가한다. 그 뒤 장부에 기록해 다시는 건드리지 않는다.
        - 이미 장부에 있으면(=한 번 반영했던 seed) 아무 것도 하지 않는다 —
          그래서 사용자가 관리 페이지에서 지운 항목이 다음 배포 때 되살아나지
          않고, 제목 등 사용자 편집도 절대 덮어쓰지 않는다.
        - 비어 있던 DB 든, 이미 몇 개 들어 있던 DB(구버전 seed 로 심긴 3개 등)든
          똑같이 안전하게 동작한다: 이미 있는 URL 은 추가하지 않고 장부에만
          올려, 새로 추가된 seed 만 실제로 삽입된다."""
        with self._engine.begin() as conn:
            applied = {row[0] for row in
                       conn.execute(select(_seed_applied.c.seed_key))}
            for it in items:
                key = it["url"]
                if key in applied:
                    continue
                exists = conn.execute(
                    select(_portfolio.c.id).where(_portfolio.c.url == it["url"])
                ).first()
                if exists is None:
                    next_order = conn.execute(
                        select(func.coalesce(func.max(_portfolio.c.sort_order), -1) + 1)
                    ).scalar_one()
                    conn.execute(insert(_portfolio).values(
                        sort_order=next_order, created_at=time.time(), **it))
                conn.execute(insert(_seed_applied).values(
                    seed_key=key, applied_at=time.time()))
