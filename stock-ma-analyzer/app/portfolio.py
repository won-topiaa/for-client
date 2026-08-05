"""작업물(포트폴리오) 카드 저장소 — /links 페이지에 보여줄 목록.

소유자가 관리 페이지(/links/admin)에서 직접 추가·수정·삭제·순서변경할 수
있게, 코드가 아니라 DB 에 저장한다. auth.py 와 같은 MetaData·엔진을 공유해
(같은 create_all 호출로 함께 생성) 별도 DB 설정이 필요 없다 — 운영에서는
회원 인증과 동일한 Postgres 에 함께 저장돼 재배포에도 지워지지 않는다.

아이콘은 관리 API 로 받지 않는다(이 모듈의 어떤 공개 함수도 icon_svg 를
인자로 받지 않는다) — seed_if_empty 로만 심어지는 신뢰된 문자열이라 그대로
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
    # 관리 API 로는 절대 못 받는 필드 — seed_if_empty 전용(모듈 docstring 참고)
    Column("icon_svg", Text, nullable=False, server_default=""),
    Column("sort_order", Integer, nullable=False),
    Column("created_at", Float, nullable=False),
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

    def seed_if_empty(self, items: list[dict]) -> None:
        """DB 가 비어 있을 때만(최초 배포) 기본 작업물을 심는다 — 이미 뭔가
        있으면(관리자가 손댄 뒤) 절대 덮어쓰지 않는다."""
        with self._engine.begin() as conn:
            count = conn.execute(
                select(func.count()).select_from(_portfolio)).scalar_one()
            if count:
                return
            now = time.time()
            for i, it in enumerate(items):
                conn.execute(insert(_portfolio).values(sort_order=i, created_at=now, **it))
