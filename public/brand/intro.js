/*
 * VIWO boot intro — vanilla-JS port of the original brand animation
 * ("Viwo Logo Intro final code"): letters rise in, the i-dot ball wakes,
 * hops twice, winds up and leaps onto the W; impact flash/ring/debris;
 * the brand gradient floods the W which reforms into the VIWO mark,
 * glides to centre and its dot pops in with a shine sweep.
 * Same beat-sheet, coordinates, easing and particle seeds as the source.
 * Plays once per browser session, ~7s, honours prefers-reduced-motion.
 */
(function () {
  'use strict';
  try {
    if (sessionStorage.getItem('viwo_intro_played')) return;
    sessionStorage.setItem('viwo_intro_played', '1');
  } catch (e) {}

  var A = '/brand/anim/';
  var LOGO_W = 2400, LOGO_H = 682;
  var CX = { v: 958.5, i: 1251, w: 1625, o: 2117.5, word: 1544.5, mark: 373.5 };
  var DOT = { x: 1253, y: 146 };
  var IMPACT = { x: 1625, y: 322 };
  var WGC = { x: 1625, y: 437 };
  var MWC = { x: 373.5, y: 443.5 };
  var OVERLAY_S = 494 / 539;
  var GRAD = 'linear-gradient(100deg,#7a3ff2 0%,#4f7bff 45%,#2ec5f6 100%)';

  // beat sheet (7.0s)
  var T_WAKE = 1.3;
  var H1 = { pre: 1.58, t0: 1.7, dur: 0.5, h: 70 };
  var H2 = { pre: 2.36, t0: 2.48, dur: 0.48, h: 122 };
  var T_WIND = 2.96, D_WIND = 0.18;
  var T_LEAP = 3.14, D_LEAP = 0.44, T_HIT = 3.58, T_FX = 3.65;
  var T_SPREAD = T_FX, D_SPREAD = 0.55;
  var T_ABSORB = 3.72, D_ABSORB = 0.68;
  var T_MORPH = 4.12, D_MORPH = 0.42;
  var T_GLIDE = 4.4, D_GLIDE = 0.68;
  var T_DOT = 5.12, D_DOT = 0.45;
  var T_SWEEP = 5.6;
  var T_END = 7.0;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, p) { return a + (b - a) * p; }
  function easeOutCubic(p) { return 1 - Math.pow(1 - p, 3); }
  function easeInQuad(p) { return p * p; }
  function easeOutBack(p) { var c1 = 0.9, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); }
  function smooth(p) { return p * p * (3 - 2 * p); }
  function seg(t, s, d) { return clamp((t - s) / d, 0, 1); }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  var PALETTE = ['#7a3ff2', '#4f7bff', '#2ec5f6', '#5b8dff', '#bfe3ff', '#ffffff'];
  var IMP_PARTS = (function () {
    var r = mulberry32(4211), out = [], i, k, kind, up, ang, v;
    for (i = 0; i < 26; i++) {
      k = r();
      kind = k < 0.28 ? 'frag' : k < 0.56 ? 'dust' : k < 0.82 ? 'spark' : 'glow';
      up = r() < 0.85;
      ang = up ? -Math.PI * (0.08 + 0.84 * r()) : Math.PI * (0.12 + 0.3 * r());
      v = kind === 'frag' ? 150 + r() * 130 : kind === 'dust' ? 260 + r() * 200 : kind === 'spark' ? 300 + r() * 190 : 100 + r() * 90;
      out.push({
        kind: kind, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v,
        g: kind === 'frag' ? 520 : kind === 'dust' ? 320 : kind === 'spark' ? 260 : 140,
        life: kind === 'dust' ? 0.3 + r() * 0.25 : kind === 'spark' ? 0.38 + r() * 0.22 : kind === 'frag' ? 0.65 + r() * 0.3 : 1.0 + r() * 0.4,
        sz: kind === 'frag' ? 8 + r() * 7 : kind === 'dust' ? 2 + r() * 2.5 : kind === 'spark' ? 11 + r() * 8 : 6 + r() * 3,
        delay: r() * 0.05, spin: (r() - 0.5) * 720, col: PALETTE[Math.floor(r() * PALETTE.length)]
      });
    }
    return out;
  })();
  var LET_E = (function () {
    var r = mulberry32(97), out = [], centers = [CX.v, CX.i, CX.o], li, i;
    for (li = 0; li < 3; li++) for (i = 0; i < 6; i++) out.push({
      ox: centers[li] + (r() - 0.5) * 150, oy: 420 + (r() - 0.5) * 190,
      delay: li * 0.09 + i * 0.05 + r() * 0.04, dur: 0.46 + r() * 0.16,
      sz: 3.5 + r() * 3, arc: 30 + r() * 40, col: PALETTE[Math.floor(r() * PALETTE.length)]
    });
    return out;
  })();

  function el(tag, css, parent) {
    var d = document.createElement(tag);
    d.style.cssText = css || '';
    (parent || document.body).appendChild(d);
    return d;
  }
  function maskCss(url) {
    return '-webkit-mask-image:url(' + url + ');mask-image:url(' + url + ');-webkit-mask-size:100% 100%;mask-size:100% 100%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;';
  }
  var LAYER = 'position:absolute;inset:0;width:100%;height:100%;';

  function run() {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var overlay = el('div', 'position:fixed;inset:0;background:#fff;z-index:2000;display:flex;align-items:center;justify-content:center;opacity:1;transition:opacity .45s ease;overflow:hidden');

    if (reduce) {
      var st = el('img', 'width:min(340px,60vw);height:auto', overlay);
      st.src = '/brand/viwo-logo.png';
      setTimeout(function () { overlay.style.opacity = '0'; setTimeout(function () { overlay.remove(); }, 500); }, 1100);
      return;
    }

    var boxW = Math.min(window.innerWidth * 0.82, 980);
    var S = boxW / LOGO_W, boxH = LOGO_H * S, K = boxW / 1180;
    var wordShift = -(CX.word - LOGO_W / 2) * S;
    var dotD = 118 * S;

    var stage = el('div', 'position:relative;width:' + boxW + 'px;height:' + boxH + 'px;will-change:transform', overlay);

    // letters
    var letters = {};
    [['v', CX.v, 0.15], ['istem', CX.i, 0.15], ['wl', CX.w, 0.15], ['o', CX.o, 0.15]].forEach(function (d) {
      var wrap = el('div', LAYER + 'opacity:0;transform-origin:' + (d[1] / LOGO_W * 100) + '% 55%;will-change:transform,opacity', stage);
      var img = el('img', LAYER + 'object-fit:contain;display:block', wrap);
      img.src = A + d[0] + '.png';
      letters[d[0]] = { elw: wrap, cx: d[1], s: d[2] };
    });

    // gradient flood over the W glyph + liquid leading edge
    var gw = el('div', LAYER + 'pointer-events:none;background:' + GRAD + ';opacity:0;transform-origin:' + (WGC.x / LOGO_W * 100) + '% ' + (WGC.y / LOGO_H * 100) + '%;will-change:transform,opacity;' + maskCss(A + 'wl.png'), stage);
    var gwEdge = el('div', LAYER + 'pointer-events:none;mix-blend-mode:screen;opacity:0;' + maskCss(A + 'wl.png'), stage);

    // ball bits
    var shadow = el('div', 'position:absolute;height:' + 9 * K + 'px;border-radius:50%;background:radial-gradient(ellipse,rgba(14,20,51,.28),rgba(14,20,51,0) 70%);opacity:0', stage);
    var wake = el('div', 'position:absolute;width:' + dotD * 2.8 + 'px;height:' + dotD * 2.8 + 'px;border-radius:50%;background:radial-gradient(circle,rgba(84,150,255,.5),rgba(84,150,255,0) 65%);opacity:0;will-change:opacity', stage);
    var ghosts = [];
    for (var gi = 1; gi <= 7; gi++) ghosts.push(el('div', 'position:absolute;width:' + dotD + 'px;height:' + dotD + 'px;border-radius:50%;background:radial-gradient(circle,rgba(84,150,255,.5),rgba(56,189,248,0) 62%);opacity:0', stage));
    var ball = el('div', 'position:absolute;left:0;top:0;width:' + dotD + 'px;height:' + dotD + 'px;border-radius:50%;box-shadow:0 4px 14px rgba(52,120,255,.3),inset -4px -6px 12px rgba(20,30,90,.28);opacity:0;will-change:transform', stage);

    // impact fx
    var flash = el('div', 'position:absolute;width:' + 240 * K + 'px;height:' + 240 * K + 'px;border-radius:50%;background:radial-gradient(circle,#fff,rgba(170,215,255,.5) 45%,rgba(170,215,255,0) 70%);opacity:0;left:' + (IMPACT.x * S - 120 * K) + 'px;top:' + (IMPACT.y * S - 120 * K) + 'px', stage);
    var ring = el('div', 'position:absolute;border-radius:50%;opacity:0', stage);
    var parts = IMP_PARTS.map(function (P) {
      var d = el('div', 'position:absolute;opacity:0', stage);
      if (P.kind === 'spark') { d.style.height = '2.4px'; d.style.borderRadius = '2px'; d.style.transformOrigin = '0 50%'; d.style.background = 'linear-gradient(90deg,' + P.col + ',rgba(255,255,255,0))'; }
      else { d.style.background = P.col; d.style.borderRadius = P.kind === 'frag' ? '22%' : '50%'; if (P.kind === 'glow') d.style.boxShadow = '0 0 ' + P.sz * 1.6 + 'px ' + P.col; }
      return d;
    });
    var motes = LET_E.map(function (E) {
      return el('div', 'position:absolute;width:' + E.sz + 'px;height:' + E.sz + 'px;border-radius:50%;background:' + E.col + ';box-shadow:0 0 ' + E.sz * 1.8 + 'px ' + E.col + ';opacity:0', stage);
    });

    // reformed mark (gradient W) + its dot + sweep
    var mark = el('div', LAYER + 'opacity:0;transform-origin:' + (MWC.x / LOGO_W * 100) + '% ' + (MWC.y / LOGO_H * 100) + '%;will-change:transform,opacity', stage);
    var markImg = el('img', LAYER + 'object-fit:contain;display:block', mark); markImg.src = A + 'markW.png';
    var markDotWrap = el('div', LAYER + 'opacity:0;transform-origin:' + (373.5 / LOGO_W * 100) + '% ' + (252 / LOGO_H * 100) + '%;will-change:transform,opacity', mark);
    var markDotImg = el('img', LAYER + 'object-fit:contain;display:block', markDotWrap); markDotImg.src = A + 'markdot.png';
    var sweep = el('div', LAYER + 'pointer-events:none;mix-blend-mode:screen;opacity:0;' + maskCss(A + 'mark.png'), mark);
    var mglow = el('div', 'position:absolute;border-radius:50%;background:radial-gradient(ellipse,rgba(86,158,255,.12),rgba(86,158,255,0) 65%);opacity:0;will-change:opacity', stage);
    var mshadow = el('div', 'position:absolute;border-radius:50%;background:radial-gradient(ellipse,rgba(14,20,51,.30),rgba(14,20,51,0) 70%);opacity:0', stage);

    var t0 = null, done = false;
    function frame(now) {
      if (t0 === null) t0 = now;
      var t = (now - t0) / 1000;
      if (t > T_END + 0.25 && !done) {
        done = true;
        overlay.style.opacity = '0';
        setTimeout(function () { overlay.remove(); }, 500);
        return;
      }
      if (done) return;

      // letters rise; later dissolve toward the W
      for (var key in letters) {
        var L = letters[key];
        var inP = seg(t, L.s, 0.7), inE = easeOutCubic(inP);
        var tx = 0, sc = lerp(0.985, 1, inE), op = inP;
        if (key !== 'wl') {
          var aE = smooth(seg(t, T_ABSORB + (key === 'o' ? 0.1 : key === 'v' ? 0 : 0.05), D_ABSORB));
          tx = (WGC.x - L.cx) * S * 0.07 * aE;
          sc *= lerp(1, 0.972, aE);
          op *= 1 - aE;
        } else {
          op *= 1 - smooth(seg(t, T_FX + 0.05, 0.45));
        }
        L.elw.style.transform = 'translate3d(' + tx + 'px,' + lerp(18, 0, inE) + 'px,0) scale(' + sc + ')';
        L.elw.style.opacity = op;
      }

      // energy motes into the W
      for (var mi = 0; mi < LET_E.length; mi++) {
        var E = LET_E[mi], mp = seg(t, T_ABSORB + E.delay, E.dur), md = motes[mi];
        if (mp <= 0 || mp >= 1) { md.style.opacity = 0; continue; }
        var q = easeInQuad(mp);
        md.style.left = (lerp(E.ox, WGC.x, q) * S - E.sz / 2) + 'px';
        md.style.top = ((lerp(E.oy, WGC.y, q) - Math.sin(Math.PI * mp) * E.arc) * S - E.sz / 2) + 'px';
        md.style.opacity = Math.sin(Math.PI * Math.min(mp * 1.25, 1)) * 0.95;
      }

      // gradient flood + morph shared state
      var spread = smooth(seg(t, T_SPREAD, D_SPREAD));
      var morphP = smooth(seg(t, T_MORPH, D_MORPH));
      var wob = 1 + 0.045 * Math.sin(morphP * Math.PI * 2) * (1 - morphP);
      var sqY = lerp(1, 0.94, Math.sin(morphP * Math.PI));
      if (t >= T_FX && morphP < 1) {
        var ipx = IMPACT.x * S, ipy = IMPACT.y * S;
        var r = (20 + spread * 270) * K;
        gw.style.clipPath = 'circle(' + r + 'px at ' + ipx + 'px ' + ipy + 'px)';
        gw.style.transform = 'scale(' + wob + ',' + wob * sqY + ')';
        gw.style.opacity = 1 - smooth(seg(t, T_MORPH + 0.06, D_MORPH - 0.06));
        if (spread < 1) {
          gwEdge.style.background = 'radial-gradient(circle at ' + ipx + 'px ' + ipy + 'px,rgba(190,230,255,0) ' + Math.max(0, r - 42 * K) + 'px,rgba(190,230,255,.9) ' + Math.max(0, r - 5 * K) + 'px,rgba(190,230,255,0) ' + (r + 46 * K) + 'px)';
          gwEdge.style.opacity = 1 - spread;
        } else gwEdge.style.opacity = 0;
      } else { gw.style.opacity = 0; gwEdge.style.opacity = 0; }

      // the dot: wake, hops, wind-up, leap
      if (t < T_FX) {
        var inP2 = seg(t, 0.15, 0.7);
        var bx = DOT.x, by = DOT.y, sx = 1, sy = 1, rot = 0, Hs = [H1, H2], hi, H;
        for (hi = 0; hi < 2; hi++) {
          H = Hs[hi];
          var pre = seg(t, H.pre, H.t0 - H.pre);
          if (t < H.t0 && pre > 0) { var kk = Math.sin(Math.PI * pre); sy = 1 - 0.2 * kk; sx = 1 + 0.16 * kk; by = DOT.y + 10 * kk; }
          if (t >= H.t0 && t < H.t0 + H.dur) {
            var hp = seg(t, H.t0, H.dur), hq = Math.pow(hp, 1.22);
            by = DOT.y - H.h * 4 * hq * (1 - hq);
            var vv = Math.abs(2 * hq - 1);
            sy = 1 + 0.13 * vv; sx = 1 - 0.09 * vv;
            rot = (hi === 0 ? 4 : 7) * Math.sin(Math.PI * hp);
          }
          var land = H.t0 + H.dur;
          if (t >= land && t < land + 0.2) { var dt = t - land, w = 0.2 * Math.exp(-dt * 12) * Math.cos(dt * 40); sy = 1 - w; sx = 1 + w * 0.8; }
        }
        var wk = smooth(seg(t, T_WIND, D_WIND));
        if (wk > 0 && t < T_LEAP) { sy = 1 - 0.3 * wk; sx = 1 + 0.22 * wk; by = DOT.y + 14 * wk; bx = DOT.x - 12 * wk; rot = -10 * wk; }
        var jp = seg(t, T_LEAP, D_LEAP);
        if (jp > 0 && t < T_HIT) {
          var jw = Math.pow(jp, 1.45);
          bx = lerp(DOT.x, IMPACT.x, jw);
          by = lerp(DOT.y, IMPACT.y, jw) - Math.sin(Math.PI * Math.pow(jw, 0.9)) * 280;
          var s2 = 0.16 * Math.sin(Math.PI * jp);
          sx = 1 + s2; sy = 1 - s2 * 0.7; rot = jw * 20;
        }
        if (t >= T_HIT) { bx = IMPACT.x; by = IMPACT.y; sx = 1.35; sy = 0.6; rot = 20; }

        if (t > 1.45 && t < T_LEAP + 0.08) {
          var hn = clamp((DOT.y - by) / H2.h, 0, 1);
          var sw = dotD * (1.1 - 0.45 * hn);
          shadow.style.left = (bx * S - sw / 2) + 'px';
          shadow.style.top = ((DOT.y + 78) * S) + 'px';
          shadow.style.width = sw + 'px';
          shadow.style.opacity = 0.75 * (1 - 0.55 * hn);
        } else shadow.style.opacity = 0;

        var wgOp = smooth(seg(t, T_WAKE, 0.35)) * (1 - seg(t, T_LEAP, 0.25));
        if (wgOp > 0.01) {
          wake.style.left = (bx * S - dotD * 1.4) + 'px';
          wake.style.top = (by * S - dotD * 1.4) + 'px';
          wake.style.opacity = wgOp * (0.3 + 0.16 * Math.sin(t * 5.5));
        } else wake.style.opacity = 0;

        if (jp > 0.06 && t < T_HIT) {
          for (gi = 1; gi <= 7; gi++) {
            var gt = Math.max(T_LEAP, t - gi * 0.03);
            var gp = seg(gt, T_LEAP, D_LEAP), gw2 = Math.pow(gp, 1.45);
            var gx = lerp(DOT.x, IMPACT.x, gw2) * S;
            var gy = (lerp(DOT.y, IMPACT.y, gw2) - Math.sin(Math.PI * Math.pow(gw2, 0.9)) * 280) * S;
            var gh = ghosts[gi - 1];
            gh.style.left = (gx - dotD / 2) + 'px';
            gh.style.top = (gy - dotD / 2) + 'px';
            gh.style.transform = 'scale(' + (1 - gi * 0.1) + ')';
            gh.style.opacity = 0.55 * (1 - gi / 8);
          }
        } else for (gi = 0; gi < 7; gi++) ghosts[gi].style.opacity = 0;

        var hx = 35 + 5 * Math.sin(t * 1.7), hy = 28 + 4 * Math.cos(t * 1.3);
        ball.style.background = 'radial-gradient(circle at ' + hx + '% ' + hy + '%,rgba(255,255,255,.92),rgba(255,255,255,0) 34%),radial-gradient(circle at 35% 30%,#5b8dff,#3478ff 75%)';
        ball.style.transform = 'translate3d(' + (bx * S - dotD / 2) + 'px,' + (by * S - dotD / 2) + 'px,0) rotate(' + rot + 'deg) scale(' + sx + ',' + sy + ')';
        ball.style.opacity = inP2;
      } else { ball.style.opacity = 0; shadow.style.opacity = 0; wake.style.opacity = 0; for (gi = 0; gi < 7; gi++) ghosts[gi].style.opacity = 0; }

      // impact fx
      var flp = seg(t, T_HIT, 0.16);
      if (flp > 0 && flp < 1) { flash.style.opacity = 1 - flp; flash.style.transform = 'scale(' + lerp(0.45, 1.7, easeOutCubic(flp)) + ')'; }
      else flash.style.opacity = 0;
      var ringP = seg(t, T_FX, 0.5);
      if (ringP > 0 && ringP < 1) {
        var rr = easeOutCubic(ringP) * 210 * S * 2;
        ring.style.left = (IMPACT.x * S - rr / 2) + 'px';
        ring.style.top = (IMPACT.y * S - rr / 2) + 'px';
        ring.style.width = rr + 'px'; ring.style.height = rr + 'px';
        ring.style.border = Math.max(1, 3.5 * (1 - ringP)) + 'px solid rgba(124,180,255,' + 0.7 * (1 - ringP) + ')';
        ring.style.opacity = 1;
      } else ring.style.opacity = 0;
      var pT = t - T_FX;
      for (var pi = 0; pi < IMP_PARTS.length; pi++) {
        var P = IMP_PARTS[pi], pd = parts[pi];
        var pt = pT - P.delay;
        if (pT <= 0 || pt <= 0 || pt >= P.life) { pd.style.opacity = 0; continue; }
        var px = (IMPACT.x + P.vx * pt) * S, py = (IMPACT.y + P.vy * pt + 0.5 * P.g * pt * pt) * S;
        var pop = Math.min(1, pt / 0.04) * (1 - seg(pt, P.life * 0.62, P.life * 0.38));
        if (P.kind === 'spark') {
          var pang = Math.atan2(P.vy + P.g * pt, P.vx) * 180 / Math.PI;
          pd.style.left = px + 'px'; pd.style.top = py + 'px'; pd.style.width = P.sz + 'px';
          pd.style.transform = 'rotate(' + pang + 'deg)';
          pd.style.opacity = pop;
        } else {
          var psz = P.sz * S * 2 * (P.kind === 'frag' ? 1 - pt / P.life * 0.4 : 1);
          pd.style.left = (px - psz / 2) + 'px'; pd.style.top = (py - psz / 2) + 'px';
          pd.style.width = psz + 'px'; pd.style.height = psz + 'px';
          if (P.kind === 'frag') pd.style.transform = 'rotate(' + P.spin * pt + 'deg)';
          pd.style.opacity = pop * (P.kind === 'glow' ? 0.85 : 1);
        }
      }

      // reformed mark glides to centre; dot pops; sweep shine
      if (t >= T_MORPH) {
        var g = easeOutBack(seg(t, T_GLIDE, D_GLIDE));
        var dxA = (WGC.x - MWC.x) * S, dyA = (WGC.y - MWC.y) * S;
        var endTx = (LOGO_W / 2 - CX.mark) * S - wordShift;
        var dx = lerp(dxA, endTx, g), dy = lerp(dyA, -26 * S, g) - Math.sin(clamp(g, 0, 1) * Math.PI) * 16 * S;
        var msc = lerp(OVERLAY_S, 1.55, g);
        var breathe = 1 + Math.sin(clamp(t - (T_GLIDE + D_GLIDE), 0, 99) * 1.1) * 0.006;
        mark.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + msc * wob * breathe + ',' + msc * wob * breathe * sqY + ')';
        mark.style.opacity = morphP > 0 ? smooth(seg(t, T_MORPH + 0.08, D_MORPH - 0.08)) : 0;
        var dp = seg(t, T_DOT, D_DOT), de = easeOutBack(dp);
        markDotWrap.style.transform = 'translateY(' + lerp(46, 0, de) * S + 'px) scale(' + lerp(0.15, 1, de) + ')';
        markDotWrap.style.opacity = dp > 0 ? smooth(seg(t, T_DOT, 0.16)) : 0;
        var sp = seg(t, T_SWEEP, 1.0);
        if (sp > 0 && sp < 1) {
          var swPos = lerp(-40, 140, smooth(sp));
          sweep.style.background = 'linear-gradient(105deg,rgba(255,255,255,0) ' + (swPos - 16) + '%,rgba(255,255,255,.9) ' + swPos + '%,rgba(255,255,255,0) ' + (swPos + 16) + '%)';
          sweep.style.opacity = 1;
        } else sweep.style.opacity = 0;
        var endIn = smooth(seg(t, 5.15, 0.8));
        if (endIn > 0.01) {
          var cxF = boxW / 2 - wordShift;
          mglow.style.left = (cxF - 320 * K) + 'px'; mglow.style.top = (205 - 180) * K + 'px';
          mglow.style.width = 640 * K + 'px'; mglow.style.height = 360 * K + 'px';
          mglow.style.opacity = endIn * (0.75 + 0.25 * Math.sin(t * 1.3));
          mshadow.style.left = (cxF - 175 * K) + 'px'; mshadow.style.top = 332 * K + 'px';
          mshadow.style.width = 350 * K + 'px'; mshadow.style.height = 26 * K + 'px';
          mshadow.style.opacity = endIn * 0.85;
        }
      }

      // camera: push-in + impact bump/vibration
      var cam = 1 + 0.038 * smooth(t / 7) + (t >= T_HIT ? 0.02 * (1 - smooth(seg(t, T_HIT, 0.5))) : 0);
      var shp = 1 - seg(t, T_FX, 0.32);
      var shake = (t >= T_FX && shp > 0) ? Math.sin(t * 62) * 3.2 * K * shp * shp : 0;
      stage.style.transform = 'translate3d(' + wordShift + 'px,' + shake + 'px,0) scale(' + cam + ')';

      requestAnimationFrame(frame);
    }

    // start once the layer images are ready (they're small; cap the wait)
    var imgs = ['v', 'istem', 'wl', 'o', 'markW', 'mark', 'markdot'].map(function (n) { var i = new Image(); i.src = A + n + '.png'; return i; });
    var started = false;
    function start() { if (started) return; started = true; requestAnimationFrame(frame); }
    Promise.all(imgs.map(function (i) { return i.decode ? i.decode().catch(function () {}) : Promise.resolve(); })).then(start);
    setTimeout(start, 900);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
