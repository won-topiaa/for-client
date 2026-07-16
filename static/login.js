/* 이메일 로그인/가입 폼 — /api/auth/login · /api/auth/signup 호출 후 이동 */
(function () {
  "use strict";

  var form = document.getElementById("authForm");
  var email = document.getElementById("email");
  var pw = document.getElementById("password");
  var msg = document.getElementById("msg");
  var btn = document.getElementById("submitBtn");
  var title = document.getElementById("title");
  var toggleText = document.getElementById("toggleText");
  var toggleBtn = document.getElementById("toggleBtn");
  var pwHint = document.getElementById("pwHint");
  if (!form) return;

  var mode = "login"; // "login" | "signup"

  // 로그인 후 돌아갈 경로 — 반드시 사이트 내부(/로 시작, //는 금지)만 허용(오픈 리다이렉트 방지)
  function safeNext() {
    var n = new URLSearchParams(location.search).get("next") || "/touches";
    if (n.charAt(0) !== "/" || n.charAt(1) === "/") return "/touches";
    return n;
  }

  function showMsg(text) {
    msg.textContent = text;
    msg.classList.add("show");
  }
  function clearMsg() {
    msg.textContent = "";
    msg.classList.remove("show");
  }

  function setMode(next) {
    mode = next;
    clearMsg();
    if (mode === "signup") {
      title.textContent = "회원가입";
      btn.textContent = "가입하고 시작하기";
      toggleText.textContent = "이미 계정이 있으신가요?";
      toggleBtn.textContent = "로그인";
      pw.setAttribute("autocomplete", "new-password");
      pwHint.style.display = "";
    } else {
      title.textContent = "로그인";
      btn.textContent = "로그인";
      toggleText.textContent = "아직 계정이 없으신가요?";
      toggleBtn.textContent = "가입하기";
      pw.setAttribute("autocomplete", "current-password");
      pwHint.style.display = "none";
    }
  }

  toggleBtn.addEventListener("click", function () {
    setMode(mode === "login" ? "signup" : "login");
    email.focus();
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    clearMsg();
    var em = email.value.trim();
    var password = pw.value;
    if (!em || em.indexOf("@") < 0) { showMsg("이메일을 확인해 주세요."); email.focus(); return; }
    if (password.length < 8) { showMsg("비밀번호는 8자 이상이어야 해요."); pw.focus(); return; }

    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = mode === "signup" ? "가입 중…" : "로그인 중…";

    fetch("/api/auth/" + mode, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: em, password: password }),
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          return { ok: r.ok, status: r.status, body: body };
        });
      })
      .then(function (res) {
        if (res.ok) {
          location.href = safeNext();
          return;
        }
        var detail = (res.body && res.body.detail) || "";
        if (res.status === 429) detail = "요청이 너무 잦아요 — 잠시 후 다시 시도해 주세요.";
        showMsg(detail || "처리에 실패했어요. 잠시 후 다시 시도해 주세요.");
        btn.disabled = false;
        btn.textContent = original;
      })
      .catch(function () {
        showMsg("네트워크 오류예요. 연결을 확인하고 다시 시도해 주세요.");
        btn.disabled = false;
        btn.textContent = original;
      });
  });

  // 가입하기로 바로 오도록 ?mode=signup 지원
  if (new URLSearchParams(location.search).get("mode") === "signup") setMode("signup");
  email.focus();
})();
