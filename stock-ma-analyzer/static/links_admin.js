/* 작업물 관리 — /links 카드를 소유자가 직접 추가·수정·삭제·순서변경.
   요소는 항상 textContent/속성으로만 채운다(innerHTML 문자열 조립 없음) —
   관리자 본인만 쓰는 폼이라도 XSS 방지는 그대로 지킨다. */
(function () {
  "use strict";

  var rowsEl = document.getElementById("rows");
  var addHost = document.getElementById("addHost");
  var msgEl = document.getElementById("msg");

  function showMsg(text, kind) {
    msgEl.textContent = text;
    msgEl.className = "msg show " + (kind || "error");
  }
  function clearMsg() {
    msgEl.className = "msg";
    msgEl.textContent = "";
  }

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = "same-origin";
    if (opts.body) {
      opts.headers = Object.assign({"Content-Type": "application/json"}, opts.headers || {});
    }
    return fetch(path, opts).then(function (r) {
      if (r.status === 401 || r.status === 403) {
        showMsg(r.status === 401
          ? "로그인이 풀렸어요. 다시 로그인해 주세요."
          : "이 계정으로는 권한이 없어요.", "error");
        if (r.status === 401) {
          setTimeout(function () {
            location.href = "/login?next=" + encodeURIComponent(location.pathname);
          }, 1200);
        }
        throw new Error("__handled__");
      }
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error(body.detail || "요청이 실패했어요.");
        return body;
      });
    });
  }

  function reportError(e) {
    if (e && e.message !== "__handled__") showMsg(e.message, "error");
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function field(parent, idPrefix, label, name, value, maxlen, placeholder) {
    var wrap = el("div", "field");
    var lab = el("label", "", label);
    var inputId = idPrefix + "-" + name;
    lab.setAttribute("for", inputId);
    var input = document.createElement("input");
    input.id = inputId;
    input.name = name;
    input.value = value || "";
    if (maxlen) input.maxLength = maxlen;
    if (placeholder) input.placeholder = placeholder;
    wrap.appendChild(lab);
    wrap.appendChild(input);
    parent.appendChild(wrap);
    return input;
  }

  // initial 이 있으면(id 포함) 수정 폼, 없으면 추가 폼.
  function buildForm(idPrefix, initial, onSubmit) {
    initial = initial || {};
    var isEdit = !!initial.id;
    var form = el("form", "item-form" + (isEdit ? "" : " show"));

    var titleInput = field(form, idPrefix, "제목", "title", initial.title, 80);
    var descInput = field(form, idPrefix, "설명 (한 줄)", "description",
                          initial.description, 200);

    var grid = el("div", "grid2");
    form.appendChild(grid);
    var badgeInput = field(grid, idPrefix, "분류 배지 (선택)", "badge",
                           initial.badge, 24, "예: 스크리너");
    var urlInput = field(grid, idPrefix, "링크 주소", "url",
                         initial.url, 500, "https:// 또는 /경로");

    var details = document.createElement("details");
    details.className = "en-fields";
    details.appendChild(el("summary", "",
      "영문 (선택 — 비워두면 영어 모드에서도 한국어로 보여요)"));
    form.appendChild(details);
    var titleEnInput = field(details, idPrefix, "영문 제목", "titleEn", initial.titleEn, 80);
    var descEnInput = field(details, idPrefix, "영문 설명", "descriptionEn",
                            initial.descriptionEn, 200);
    var badgeEnInput = field(details, idPrefix, "영문 배지", "badgeEn", initial.badgeEn, 24);

    var actionsRow = el("div", "form-actions");
    var submitBtn = el("button", "primary", isEdit ? "저장" : "추가");
    submitBtn.type = "submit";
    actionsRow.appendChild(submitBtn);
    if (isEdit) {
      var cancelBtn = el("button", "secondary", "취소");
      cancelBtn.type = "button";
      cancelBtn.addEventListener("click", function () { form.classList.remove("show"); });
      actionsRow.appendChild(cancelBtn);
    }
    form.appendChild(actionsRow);

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      clearMsg();
      if (!titleInput.value.trim()) { showMsg("제목을 입력해 주세요.", "error"); return; }
      if (!urlInput.value.trim()) { showMsg("링크 주소를 입력해 주세요.", "error"); return; }
      submitBtn.disabled = true;
      onSubmit({
        title: titleInput.value, description: descInput.value, badge: badgeInput.value,
        url: urlInput.value, titleEn: titleEnInput.value,
        descriptionEn: descEnInput.value, badgeEn: badgeEnInput.value,
      }).catch(reportError).then(function () { submitBtn.disabled = false; });
    });

    return form;
  }

  function move(id, direction) {
    api("/api/portfolio/" + id + "/move", {
      method: "POST", body: JSON.stringify({direction: direction}),
    }).then(load).catch(reportError);
  }

  function makeRow(item, idx, total) {
    var row = el("div", "row");
    var summary = el("div", "summary");

    summary.appendChild(el("span", "num", String(idx + 1).padStart(2, "0")));

    var info = el("div", "info");
    var titleLine = item.badge ? item.title + "  ·  " + item.badge : item.title;
    info.appendChild(el("div", "t", titleLine));
    if (item.description) info.appendChild(el("div", "d", item.description));
    info.appendChild(el("div", "u", item.url));
    summary.appendChild(info);

    var actions = el("div", "actions");
    var upBtn = el("button", "", "▲");
    upBtn.type = "button";
    upBtn.disabled = idx === 0;
    upBtn.addEventListener("click", function () { move(item.id, "up"); });
    var downBtn = el("button", "", "▼");
    downBtn.type = "button";
    downBtn.disabled = idx === total - 1;
    downBtn.addEventListener("click", function () { move(item.id, "down"); });
    var editBtn = el("button", "", "수정");
    editBtn.type = "button";
    var delBtn = el("button", "danger", "삭제");
    delBtn.type = "button";
    delBtn.addEventListener("click", function () {
      if (!confirm('"' + item.title + '" 을(를) 정말 삭제할까요?')) return;
      api("/api/portfolio/" + item.id, {method: "DELETE"}).then(function () {
        showMsg("삭제했어요.", "ok");
        load();
      }).catch(reportError);
    });
    actions.appendChild(upBtn);
    actions.appendChild(downBtn);
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    summary.appendChild(actions);
    row.appendChild(summary);

    var form = buildForm("edit-" + item.id, item, function (payload) {
      return api("/api/portfolio/" + item.id, {
        method: "PUT", body: JSON.stringify(payload),
      }).then(function () {
        showMsg("수정했어요.", "ok");
        load();
      });
    });
    row.appendChild(form);
    editBtn.addEventListener("click", function () { form.classList.toggle("show"); });

    return row;
  }

  function renderAddForm() {
    addHost.innerHTML = "";
    var form = buildForm("add", null, function (payload) {
      return api("/api/portfolio", {method: "POST", body: JSON.stringify(payload)})
        .then(function () {
          showMsg("추가했어요.", "ok");
          renderAddForm();  // 입력값 비우고 새 폼으로 교체
          load();
        });
    });
    addHost.appendChild(form);
  }

  function load() {
    api("/api/portfolio").then(function (data) {
      var items = data.items || [];
      rowsEl.innerHTML = "";
      if (!items.length) {
        rowsEl.appendChild(el("p", "empty", "아직 작업물이 없어요. 아래에서 추가해 보세요."));
        return;
      }
      items.forEach(function (item, i) {
        rowsEl.appendChild(makeRow(item, i, items.length));
      });
    }).catch(reportError);
  }

  document.getElementById("logoutBtn").addEventListener("click", function () {
    fetch("/api/auth/logout", {method: "POST", credentials: "same-origin"})
      .then(function () { location.href = "/links"; })
      .catch(function () { location.href = "/links"; });
  });

  renderAddForm();
  load();
})();
