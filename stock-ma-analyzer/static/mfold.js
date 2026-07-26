/* 모바일 전용 설명 접기 — data-mfold="제목" 이 붙은 블록을 폰 화면(640px 이하)
   에서만 '제목 버튼'으로 접어두고, 탭하면 펼친다. 데스크톱은 버튼이 아예
   숨겨지고 본문이 항상 보여 기존과 1픽셀도 다르지 않다. JS 가 실패해도
   본문은 그대로 보이므로(기본 펼침) 내용 접근성이 깨지지 않는다. */
(function () {
  "use strict";

  var mq = window.matchMedia("(max-width: 640px)");
  var items = [];

  function apply(item) {
    if (!mq.matches) {
      // 데스크톱/태블릿: 버튼 숨김 + 본문 항상 표시 (기존 모습 그대로)
      item.btn.style.display = "none";
      item.el.classList.remove("mfold-hidden");
      return;
    }
    var TR = window.WT_T || function (ko) { return ko; };
    // CSS 기본값이 display:none(데스크톱 깜빡임 방지)이라 "" 로 지우면
    // 폰에서도 버튼이 사라진다 — 모바일에서는 block 을 명시해야 한다
    item.btn.style.display = "block";
    item.btn.textContent = item.label +
      (item.open ? "  ▴ " + TR("접기", "hide") : "  ▾ " + TR("보기", "show"));
    item.btn.setAttribute("aria-expanded", item.open ? "true" : "false");
    item.el.classList.toggle("mfold-hidden", !item.open);
  }

  function update() {
    items.forEach(apply);
  }

  function setup() {
    document.querySelectorAll("[data-mfold]").forEach(function (el) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mfold-btn";
      btn.style.display = "none"; // 데스크톱 초기 렌더에서 절대 안 보이게
      el.parentNode.insertBefore(btn, el);
      var item = {
        el: el, btn: btn, open: false,
        label: el.getAttribute("data-mfold"),
      };
      btn.addEventListener("click", function () {
        item.open = !item.open;
        apply(item);
      });
      items.push(item);
    });
    update();
    // 화면 회전/창 크기 변화에도 상태 일관 유지
    if (mq.addEventListener) mq.addEventListener("change", update);
    else if (mq.addListener) mq.addListener(update);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }
})();
