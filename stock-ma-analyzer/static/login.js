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
  var consentWrap = document.getElementById("consentWrap");
  var consent = document.getElementById("consent");
  if (!form) return;

  var mode = "login"; // "login" | "signup"
  // 한/영 분기 — i18n.js 가 head 에서 window.WT_T 를 정의한다 (없으면 한국어)
  var TR = window.WT_T || function (ko) { return ko; };

  // 로그인 후 돌아갈 경로 — 반드시 '같은 출처(origin)'로만. 문자열을 손으로
  // 파싱하지 않고 URL 로 해석해 비교한다: 브라우저가 URL 에서 제거하는 탭·개행
  // (예: /\t/evil.com → //evil.com) 같은 우회까지 한 번에 막힌다.
  function safeNext() {
    var raw = new URLSearchParams(location.search).get("next") || "/touches";
    try {
      var u = new URL(raw, location.origin);
      if (u.origin === location.origin) return u.pathname + u.search + u.hash;
    } catch (e) { /* 잘못된 URL 이면 기본값으로 */ }
    return "/touches";
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
      title.textContent = TR("회원가입", "Sign up");
      btn.textContent = TR("가입하고 시작하기", "Create account & start");
      toggleText.textContent = TR("이미 계정이 있으신가요?", "Already have an account?");
      toggleBtn.textContent = TR("로그인", "Log in");
      pw.setAttribute("autocomplete", "new-password");
      pwHint.style.display = "";
      if (consentWrap) consentWrap.style.display = "";
    } else {
      title.textContent = TR("로그인", "Log in");
      btn.textContent = TR("로그인", "Log in");
      toggleText.textContent = TR("아직 계정이 없으신가요?", "Don't have an account yet?");
      toggleBtn.textContent = TR("가입하기", "Create account");
      pw.setAttribute("autocomplete", "current-password");
      pwHint.style.display = "none";
      if (consentWrap) consentWrap.style.display = "none";
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
    if (!em || em.indexOf("@") < 0) { showMsg(TR("이메일을 확인해 주세요.", "Please check your email address.")); email.focus(); return; }
    if (password.length < 8) { showMsg(TR("비밀번호는 8자 이상이어야 해요.", "Password must be at least 8 characters.")); pw.focus(); return; }
    if (mode === "signup" && consent && !consent.checked) {
      showMsg(TR("개인정보처리방침에 동의해 주세요.", "Please agree to the privacy policy.")); return;
    }

    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = mode === "signup" ? TR("가입 중…", "Signing up…") : TR("로그인 중…", "Logging in…");

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
        if (res.status === 429) detail = TR("요청이 너무 잦아요 — 잠시 후 다시 시도해 주세요.", "Too many requests — please try again in a moment.");
        showMsg(detail || TR("처리에 실패했어요. 잠시 후 다시 시도해 주세요.", "Something went wrong. Please try again in a moment."));
        btn.disabled = false;
        btn.textContent = original;
      })
      .catch(function () {
        showMsg(TR("네트워크 오류예요. 연결을 확인하고 다시 시도해 주세요.", "Network error. Check your connection and try again."));
        btn.disabled = false;
        btn.textContent = original;
      });
  });

  // 가입하기로 바로 오도록 ?mode=signup 지원
  if (new URLSearchParams(location.search).get("mode") === "signup") setMode("signup");
  email.focus();
})();
