/* 원토피아 작업물 페이지 — 배경 지수 그래프 + 지수 요약 줄.

   장식이지만 데이터는 진짜다: /api/indices/spark 의 실제 일봉 종가로 곡선을
   그리고, /api/indices 의 현재값으로 요약 줄을 채운다. 둘 중 무엇이 실패해도
   페이지는 그대로 보인다 (배경은 비고, 요약 줄은 숨김). */
(function () {
  "use strict";

  var TR = window.WT_T || function (ko) { return ko; };
  var NAME_EN = { "코스피": "KOSPI", "코스닥": "KOSDAQ", "나스닥": "NASDAQ" };
  // 지수마다 다른 색 — 배경에서 서로 구분되되 본문을 방해하지 않을 만큼 옅게
  var COLORS = { KS11: "#00c805", KQ11: "#4cc9f0", US500: "#f4a261", IXIC: "#b892ff" };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function dispName(n) {
    return (window.WT_LANG === "en" && NAME_EN[n]) ? NAME_EN[n] : n;
  }

  /* 종가 배열 → SVG path. 각 지수를 '자기 구간의 최소~최대'로 정규화해
     서로 다른 단위(2,600 vs 20,000)를 한 화면에서 겹쳐 보여준다. */
  function toPath(closes, w, h, band, top) {
    var lo = Math.min.apply(null, closes);
    var hi = Math.max.apply(null, closes);
    var span = hi - lo;
    if (!isFinite(span) || span <= 0) return null;
    var n = closes.length;
    var pts = [];
    for (var i = 0; i < n; i++) {
      pts.push([(i / (n - 1)) * w,
                top + (1 - (closes[i] - lo) / span) * band]);
    }
    // 값은 그대로 두고 선만 부드럽게(카트멀-롬 → 베지어) — 데이터를 바꾸지 않는다
    var d = "M" + pts[0][0].toFixed(1) + " " + pts[0][1].toFixed(1);
    for (var j = 0; j < pts.length - 1; j++) {
      var p0 = pts[j === 0 ? 0 : j - 1], p1 = pts[j], p2 = pts[j + 1];
      var p3 = pts[j + 2 < pts.length ? j + 2 : pts.length - 1];
      var c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      var c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += "C" + c1x.toFixed(1) + " " + c1y.toFixed(1) + "," +
           c2x.toFixed(1) + " " + c2y.toFixed(1) + "," +
           p2[0].toFixed(1) + " " + p2[1].toFixed(1);
    }
    return d;
  }

  function drawBackground(list) {
    var host = document.getElementById("bgChart");
    if (!host || !list.length) return;
    var W = 1200, H = 420;
    var svg = [
      '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" ' +
      'xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">',
      "<defs>",
    ];
    list.forEach(function (ix, i) {
      var c = COLORS[ix.key] || "#8b9296";
      svg.push('<linearGradient id="g' + i + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="' + c + '" stop-opacity=".07"/>' +
        '<stop offset="100%" stop-color="' + c + '" stop-opacity="0"/></linearGradient>');
    });
    svg.push("</defs>");
    // 네 지수를 서로 다른 높이 띠에 얕게 눕힌다 — 겹쳐 뒤엉키지 않고,
    // 진폭을 화면의 일부만 쓰게 해 배경이 본문을 이기지 않는다.
    var band = H * 0.22;
    list.forEach(function (ix, i) {
      var top = H * (0.10 + i * 0.19);
      var d = toPath(ix.closes, W, H, band, top);
      if (!d) return;
      var c = COLORS[ix.key] || "#8b9296";
      // 면(그라데이션) → 선 순서로 그려야 선이 위에 온다
      svg.push('<path d="' + d + " L" + W + " " + H + " L0 " + H + ' Z" fill="url(#g' + i + ')"/>');
      svg.push('<path d="' + d + '" fill="none" stroke="' + c +
               '" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round" opacity=".3"/>');
    });
    svg.push("</svg>");
    host.innerHTML = svg.join("");
    host.classList.add("on");
  }

  function renderQuotes(items) {
    var strip = document.getElementById("idxStrip");
    if (!strip || !items.length) return;
    strip.innerHTML = items.map(function (it) {
      var pct = Number(it.changePct);
      var up = pct > 0, flat = Math.abs(pct) < 0.005;
      var cls = flat ? "flat" : up ? "up" : "down";
      var arrow = flat ? "" : up ? "▲" : "▼";
      var dot = COLORS[it.key] || "#8b9296";
      return '<span class="idx">' +
        '<i class="dot" style="background:' + dot + '" aria-hidden="true"></i>' +
        '<b>' + esc(dispName(it.name)) + "</b>" +
        '<span class="v">' + esc(Number(it.value).toLocaleString("en-US",
          { minimumFractionDigits: 2, maximumFractionDigits: 2 })) + "</span>" +
        '<span class="c ' + cls + '">' + arrow + Math.abs(pct).toFixed(2) + "%</span>" +
        "</span>";
    }).join("");
    strip.style.display = "";
  }

  // 배경(모양)과 요약 줄(현재값)은 서로 독립 — 한쪽이 실패해도 다른 쪽은 그린다
  fetch("/api/indices/spark")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (b) { drawBackground((b && b.indices) || []); })
    .catch(function () { /* 배경 없이도 페이지는 완성이다 */ });

  fetch("/api/indices")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (b) { renderQuotes((b && b.indices) || []); })
    .catch(function () { /* 요약 줄은 숨긴 채로 둔다 */ });
})();
