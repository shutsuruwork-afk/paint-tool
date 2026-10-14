/*!
 * Paint Bookmarklet — どんなページの上にも描ける低遅延ペイントツール
 * https://github.com/shutsuruwork-afk/paint-tool (MIT License)
 */
(() => {
  'use strict';

  const NS = '__paintBookmarklet';
  const VERSION = '1.4.0';
  const win = window;
  // 2 回目以降の実行は表示/非表示の切り替えのみ（描画内容は保持）
  if (win[NS]) { win[NS].toggle(); return; }

  const doc = document;
  const perf = performance;
  const now = () => perf.now();
  const { min, max, round, ceil, floor, sqrt, abs, atan2, cos, sin, hypot, PI } = Math;
  const TAU = PI * 2;
  const EMPTY = [];
  const SVGNS = 'http://www.w3.org/2000/svg';
  const PE = win.PointerEvent && PointerEvent.prototype;
  const HAS_CO = !!PE && 'getCoalescedEvents' in PE;
  // pointerrawupdate: rAF 整列を待たずに届く生の入力（安全なコンテキストのみ）
  const HAS_RAW = 'onpointerrawupdate' in win;
  const HAS_OC = typeof OffscreenCanvas === 'function';
  const HAS_ED = 'EyeDropper' in win;
  const HAS_CLIP = !!(navigator.clipboard && navigator.clipboard.write && win.ClipboardItem);
  const PLAT = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const IS_MAC = /^(mac|ip)/i.test(PLAT);
  // desynchronized: コンポジタの描画同期を待たずに表示（低遅延キャンバス。非対応環境では無視される）
  const CTX_OPT = { desynchronized: true };
  const PRED_MAX = 16;  // 保持する予測点の上限
  const PRED_MS = 12;   // 予測 API が無い環境で外挿する時間 (ms)
  const PRED_TTL = 40;  // 入力が途絶えてから予測線を消すまでの時間 (ms)
  const FILL_TOL = 48;  // 塗りつぶしの色許容差 (0-255)
  const BYE_MS = 8000;  // 閉じる（×）を取り消せる時間 (ms)

  const PALETTE = ['#111111', '#ffffff', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa'];
  const BGS = ['', '#ffffff', '#1d1f23'];
  const BG_NAMES = ['透明', '白', '黒'];
  const CFG = {
    pen: { size: 4, alpha: 1 },
    marker: { size: 24, alpha: 0.35 },
    eraser: { size: 32, alpha: 1 },
    line: { size: 4, alpha: 1 },
    arrow: { size: 4, alpha: 1 },
    rect: { size: 4, alpha: 1 },
    ellipse: { size: 4, alpha: 1 },
    fill: { size: 0, alpha: 1 },
    text: { size: 24, alpha: 1 },
  };
  const KEYMAP = { p: 'pen', h: 'marker', e: 'eraser', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', f: 'fill', t: 'text' };
  // 文字の書体。入力欄（CSS）と確定時の fillText で同じものを使う
  const FONT = 'system-ui,-apple-system,"Segoe UI","Hiragino Sans","Yu Gothic UI",sans-serif';
  const LH = 1.25; // 文字の行の高さ（文字の大きさに対する比）

  const I = {
    grip: 'M9 6v.01M9 12v.01M9 18v.01M15 6v.01M15 12v.01M15 18v.01',
    pen: 'M4 20l1.2-4.4L16 4.8a2 2 0 0 1 2.9 0l.3.3a2 2 0 0 1 0 2.9L8.4 18.8zM14 7l3 3',
    marker: 'M9.5 10.5L4 16v4h4l5.5-5.5M9.5 10.5l6-6 4 4-6 6zM14 20h6',
    eraser: 'M8 20h12M4.7 14.7l9-9a2 2 0 0 1 2.8 0l2.3 2.3a2 2 0 0 1 0 2.8L11 18.6H8.6zM9 10.3l5 5',
    line: 'M5 19L19 5',
    arrow: 'M5 19L19 5M10 5h9v9',
    rect: 'M4 6h16v12H4z',
    ellipse: 'M3 12a9 6.5 0 1 0 18 0a9 6.5 0 1 0-18 0',
    fill: 'M5 12l7-7 7 7-7 7zM5 12h14M21 18.5a1.5 1.5 0 0 1-3 0c0-1.2 1.5-3 1.5-3s1.5 1.8 1.5 3z',
    text: 'M5 7V5h14v2M12 5v14M9 19h6',
    drop: 'M13 6l5 5M15.5 3.5a2.1 2.1 0 0 1 3 0l2 2a2.1 2.1 0 0 1 0 3L18 11M15 8l-9 9v3h3l9-9',
    undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
    redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    bg: 'M4 4h16v12H4zM12 16v4M8 20h8',
    pass: 'M6 3l12 11h-6l3.5 7-2.5 1-3.5-7L6 19z',
    save: 'M12 4v11M7 10l5 5 5-5M5 20h14',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    hide: 'M5 12h14',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    close: 'M6 6l12 12M18 6L6 18',
  };

  const CSS = `
.w{all:initial;position:absolute;inset:0;overflow:hidden;contain:strict;pointer-events:none;outline:none;font:12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e8e9ee;color-scheme:dark;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
.s{position:absolute;inset:0}.s.bg1{background:#fff}.s.bg2{background:#1d1f23}
canvas{position:absolute;left:0;top:0;pointer-events:none}
.g,.p{position:absolute;inset:0}
.p{pointer-events:auto;touch-action:none;cursor:crosshair}
.pass .p{pointer-events:none}
.bar{position:absolute;left:0;top:0;display:flex;flex-wrap:wrap;align-items:center;gap:2px;padding:4px;max-width:calc(100% - 16px);box-sizing:border-box;background:#202228;border:1px solid #ffffff1f;border-radius:12px;box-shadow:0 6px 24px #0007;pointer-events:auto;touch-action:none;will-change:transform}
.b{all:unset;box-sizing:border-box;flex:none;width:30px;height:30px;display:grid;place-items:center;border-radius:8px;cursor:pointer;color:inherit}
.b:hover{background:#ffffff1a}.b:active{background:#ffffff2e}
.b.on{background:#3d7cff;color:#fff}
.b:disabled{opacity:.3;cursor:default;background:none}
.b:focus-visible{outline:2px solid #3d7cff;outline-offset:-2px}
.b.open:not(.on){background:#ffffff2e}
.dd{position:relative}.dd::after{content:"";position:absolute;right:3px;bottom:3px;border:2.5px solid transparent;border-right-color:currentColor;border-bottom-color:currentColor;opacity:.55}
.dot{width:var(--d);height:var(--d);border-radius:50%;background:var(--c);opacity:var(--a);box-shadow:0 0 0 1px #ffffff59}
.dot.er{background:none;opacity:1;box-shadow:inset 0 0 0 1.5px #e8e9ee}
.pn{position:absolute;left:0;top:calc(100% + 6px);display:none;flex-direction:column;gap:2px;padding:4px;background:#202228;border:1px solid #ffffff1f;border-radius:10px;box-shadow:0 6px 24px #0007;pointer-events:auto}
.pn.on{display:flex}.up .pn{top:auto;bottom:calc(100% + 6px)}
.row{display:flex;align-items:center;gap:2px}
.b.mi{width:auto;display:flex;justify-content:flex-start;gap:10px;padding:0 10px 0 6px;white-space:nowrap}
.mi kbd{margin-left:auto;padding-left:20px;color:#7d808a;font:inherit}
svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
.grip{width:16px;cursor:grab;color:#7d808a}.grip:hover{background:none}.grip svg,[aria-label^="その他"] svg{stroke-width:3}
.c{width:24px}
.c::before{content:"";width:18px;height:18px;border-radius:50%;background:var(--c);box-shadow:inset 0 0 0 1px #ffffff59}
.c.on{background:none}
.c.on::before{box-shadow:0 0 0 2px #202228,0 0 0 4px #fff}
.cc::before{background:conic-gradient(#f44,#fd4,#4d4,#4dd,#44f,#d4d,#f44)}
.sep{flex:none;width:1px;height:22px;margin:0 3px;background:#ffffff24}
.r{display:flex;align-items:center;gap:8px;height:30px;padding:0 6px;color:#a9acb8}
.r input{flex:1;width:auto;min-width:0;margin:0;accent-color:#3d7cff}
.r output{min-width:30px;color:#e8e9ee;font-variant-numeric:tabular-nums}
.r.dis{opacity:.3;pointer-events:none}
.ci{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;border:0;padding:0}
.t{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);padding:8px 14px;border-radius:8px;background:#202228;box-shadow:0 4px 16px #0007;opacity:0;transition:opacity .2s;pointer-events:none;white-space:nowrap}
.t.on{opacity:1}
.t button{all:unset;display:none;margin:-4px -8px -4px 10px;padding:4px 8px;border-radius:6px;color:#8fb3ff;font-weight:600;cursor:pointer}
.t button:hover{background:#ffffff1a}.t button:focus-visible{outline:2px solid #3d7cff}
.t.act{pointer-events:auto}.t.act button{display:inline-block}
.bye .t::after{content:"";position:absolute;left:10px;right:10px;bottom:3px;height:2px;border-radius:1px;background:#8fb3ff;transform-origin:left;animation:bye ${BYE_MS}ms linear forwards}
@keyframes bye{to{transform:scaleX(0)}}
.bye>:not(.t){display:none}
.tx{all:unset;position:absolute;box-sizing:content-box;white-space:pre;overflow:hidden;resize:none;pointer-events:auto;cursor:text;color:var(--c);opacity:var(--a);caret-color:var(--c);font:600 var(--fs)/${LH} ${FONT};outline:1px dashed #3d7cffb0;outline-offset:5px;-webkit-user-select:text;user-select:text}
.hud{position:absolute;left:8px;bottom:8px;padding:6px 8px;border-radius:6px;background:#000c;color:#8f8;font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre;pointer-events:none}
@media (pointer:coarse){.b{width:38px;height:38px}.c{width:30px}.r{height:38px}}
`;

  // ---------- DOM ヘルパ（innerHTML を使わないので Trusted Types 強制ページでも動く） ----------
  const el = (tag, cls, attrs) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };
  const icon = d => {
    const s = doc.createElementNS(SVGNS, 'svg'), p = doc.createElementNS(SVGNS, 'path');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    p.setAttribute('d', d);
    s.append(p);
    return s;
  };
  const btn = (title, d, fn, cls) => {
    const b = el('button', cls ? 'b ' + cls : 'b', { type: 'button', title, 'aria-label': title });
    if (d) b.append(icon(d));
    b.addEventListener('click', fn);
    return b;
  };
  const sep = () => el('div', 'sep');
  const newCanvas = (w, h) => {
    if (HAS_OC) return new OffscreenCanvas(w, h);
    const c = el('canvas');
    c.width = w; c.height = h;
    return c;
  };

  // ---------- ホスト要素（Shadow DOM でページの CSS から隔離） ----------
  // style 属性ではなく CSSOM 経由で設定する（CSP の style-src に阻まれない）
  const pin = (e, list) => { for (const [k, v] of list) e.style.setProperty(k, v, 'important'); };
  const BASE = [['all', 'initial'], ['margin', '0'], ['padding', '0'], ['border', 'none'], ['background', 'transparent'],
    ['pointer-events', 'none'], ['display', 'block']];
  // 2 つの Shadow DOM で 1 枚のスタイルシートを共有する（使えない環境では <style> を置く）
  let sheet = null;
  try { sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); } catch (_) { sheet = null; }
  const adopt = root => {
    if (sheet) try { root.adoptedStyleSheets = [sheet]; return; } catch (_) { }
    const st = el('style');
    st.textContent = CSS;
    root.append(st);
  };
  // UI と描いている途中の線は画面に固定する
  const host = el('paint-bookmarklet');
  const hs = host.style;
  pin(host, [...BASE, ['position', 'fixed'], ['top', '0'], ['left', '0'], ['right', '0'], ['bottom', '0'],
    ['width', 'auto'], ['height', 'auto'], ['overflow', 'visible'], ['z-index', '2147483647']]);
  // 対応ブラウザでは top layer に載せ、ページのモーダルや z-index 競争より常に手前に出す
  host.setAttribute('popover', 'manual');
  const shadow = host.attachShadow({ mode: 'open' });
  adopt(shadow);
  // 確定した絵は「面」に描く。面は文書に貼り付く要素で、本文と一緒にスクロールする。
  // contain: strict と overflow: clip で文書の大きさに切り詰め、はみ出したタイルでスクロール範囲を広げない
  const surf = el('paint-bookmarklet-surface');
  pin(surf, [...BASE, ['position', 'absolute'], ['left', '0'], ['top', '0'], ['width', '0'], ['height', '0'],
    ['overflow', 'hidden'], ['overflow', 'clip'], ['contain', 'strict'], ['z-index', '2147483646']]);
  const sroot = surf.attachShadow({ mode: 'open' });
  adopt(sroot);
  const sbox = el('div', 's');
  sroot.append(sbox);

  const wrap = el('div', 'w', { tabindex: '-1' });
  const layer = cls => {
    const c = el('canvas', cls);
    return [c, c.getContext('2d', CTX_OPT)];
  };
  // live: 描いている途中の線 / pred: 未確定の末尾＋予測線（どちらも画面のデバイス px）
  const [liveC, lctx] = layer('l');
  const [predC, pctx] = layer('q');
  const DESYNC = !!(lctx.getContextAttributes && lctx.getContextAttributes().desynchronized);
  // live と pred をまとめて不透明度をかける（重なり部分が二重に濃くならない）
  const grp = el('div', 'g');
  grp.append(liveC, predC);
  const pad = el('div', 'p');
  const bar = el('div', 'bar', { role: 'toolbar', 'aria-label': 'Paint' });
  const toast = el('div', 't', { role: 'status' });
  const toastM = el('span'), toastB = el('button', '', { type: 'button' });
  toast.append(toastM, toastB);
  wrap.append(grp, pad, bar, toast);
  shadow.append(wrap);

  // ---------- 状態 ----------
  let tool = 'pen', color = PALETTE[2], bg = 0, pass = false, visible = false;
  let dpr = win.devicePixelRatio || 1, W = 0, H = 0, grpA = 1, pendingFit = false, rz = 0;
  // 履歴タイル: ストロークが触れた T×T タイル（面の座標）だけを記録し、確定・undo・消しゴムの退避をその範囲に限定する。
  // 文書は大きいので、印は配列ではなく Set で持つ。番号は 行 × 65536 + 列
  const T = 128;
  const tmark = new Set();
  const tl = [];    // 現在のストロークが触れたタイル番号
  const tsave = []; // 消しゴム: 削る直前に退避したタイル（tl と同じ順）
  const pool = [];  // 退避用タイルキャンバスの再利用プール

  // ---------- 面（確定した絵。ページの座標に貼り付く） ----------
  // 座標は 2 種類。V = 画面のデバイス px（live / pred / 入力）、S = 面の px（文書の左上が原点、解像度は sdpr で固定）。
  // S = V × sk + (sox, soy)。ストロークの開始時に mapNow() で一度だけ決める
  const dtiles = new Map(); // 表示タイル: 行 × 65536 + 列 → { c, x }
  let sdpr = dpr, surfW = 0, surfH = 0, hdx = 0, hdy = 0, sk = 1, sox = 0, soy = 0;
  // 表示タイルの一辺（面の px）。画面の密度によらず CSS で約 256px にする（1x なら 256、2x なら 512）。
  // 小さいほど初めて描く場所での確保が軽く、大きいほど層の数が減って合成とスクロールが軽い。
  // 履歴タイル T の倍数にしておくと、履歴タイルが表示タイルをまたがない
  const DT = T * max(2, round(sdpr * 2));
  // 画面の左上が S のどこに当たるか
  const origin = () => [round((win.scrollX - hdx) * sdpr), round((win.scrollY - hdy) * sdpr)];
  function mapNow() {
    sk = sdpr / dpr;
    [sox, soy] = origin();
  }
  function dtile(tx, ty) {
    const k = ty * 65536 + tx;
    let t = dtiles.get(k);
    if (!t) {
      const c = el('canvas'), st = c.style, css = DT / sdpr + 'px';
      c.width = c.height = DT;
      st.left = tx * DT / sdpr + 'px';
      st.top = ty * DT / sdpr + 'px';
      st.width = st.height = css;
      // 数が多くなるので desynchronized にはしない（低遅延の経路はキャンバスごとに重い）
      t = { c, x: c.getContext('2d') };
      sbox.append(c);
      dtiles.set(k, t);
    }
    return t;
  }
  // S の矩形に掛かる表示タイルごとに fn(タイル, タイル原点, 重なり矩形) を呼ぶ。make なら無いタイルを作る
  function forTiles(x, y, w, h, make, fn) {
    if (w <= 0 || h <= 0) return;
    const tx0 = max(0, floor(x / DT)), ty0 = max(0, floor(y / DT));
    const tx1 = min(65535, floor((x + w - 1) / DT)), ty1 = floor((y + h - 1) / DT);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = make ? dtile(tx, ty) : dtiles.get(ty * 65536 + tx);
        if (!t) continue;
        const ox = tx * DT, oy = ty * DT, ix = max(x, ox), iy = max(y, oy);
        fn(t, ox, oy, ix, iy, min(x + w, ox + DT) - ix, min(y + h, oy + DT) - iy);
      }
    }
  }
  // 面の大きさを文書のスクロール範囲に合わせ、文書の原点からのずれ（html に margin や position がある場合）を測る。
  // 一度 0 にしてから測るので、ページが縮んだときも追従する。強制レイアウトになるので、入力の処理中には呼ばない
  function sizeSurface() {
    const de = doc.documentElement, b = doc.body;
    pin(surf, [['width', '0'], ['height', '0']]);
    surfW = max(de.scrollWidth, de.clientWidth, b ? b.scrollWidth : 0);
    surfH = max(de.scrollHeight, de.clientHeight, b ? b.scrollHeight : 0);
    const r = surf.getBoundingClientRect();
    hdx = r.left + win.scrollX;
    hdy = r.top + win.scrollY;
    pin(surf, [['width', surfW + 'px'], ['height', surfH + 'px']]);
  }

  // ---------- ツールバー ----------
  const grip = el('div', 'b grip', { title: 'ドラッグで移動' });
  grip.append(icon(I.grip));
  bar.append(grip);

  // よく使う物だけをバーに並べ、残りはボタンの下に開くパネル（.pn）に入れる。
  // パネルはバーの子なのでバーと一緒に動き、absolute なのでバーの幅には入らない
  const TITLES = {
    pen: 'ペン (P)',
    marker: '蛍光ペン (H)',
    eraser: '消しゴム (E) — 右クリックやペンの消しゴム側でも消せます',
    line: '直線 (L) — Shift で 45° 刻み',
    arrow: '矢印 (A) — Shift で 45° 刻み',
    rect: '四角形 (R) — Shift で正方形 / Alt で中心から',
    ellipse: '楕円 (O) — Shift で正円 / Alt で中心から',
    fill: '塗りつぶし (F)',
    text: '文字 (T) — クリックした所に入力。外を押すか Esc で確定',
  };
  const SHAPES = ['line', 'arrow', 'rect', 'ellipse'];
  const pnl = () => el('div', 'pn');
  const row = (...a) => { const r = el('div', 'row'); r.append(...a); return r; };
  const toolBtns = {};
  for (const t of ['pen', 'marker', 'eraser']) bar.append(toolBtns[t] = btn(TITLES[t], I[t], () => setTool(t)));
  // 図形: 最後に使った図形を表示する。押すとその図形になり、4 つの図形のパネルが開く
  let lastShape = 'line';
  const shapeP = pnl();
  const shapeB = btn(TITLES.line, I.line, () => {
    if (SHAPES.includes(tool)) togglePanel(shapeP, shapeB);
    else { setTool(lastShape); openPanel(shapeP, shapeB); }
  }, 'dd');
  const shapeD = shapeB.querySelector('path');
  shapeP.append(row(...SHAPES.map(t => toolBtns[t] = btn(TITLES[t], I[t], () => { setTool(t); closePanel(); }))));
  bar.append(shapeB, toolBtns.text = btn(TITLES.text, I.text, () => setTool('text')),
    toolBtns.fill = btn(TITLES.fill, I.fill, () => setTool('fill')), sep());

  // 色と太さ: 今の色・太さ・濃さを点で見せる。パネルにパレット・カスタム色・スポイト・太さ・濃さ
  const styleP = pnl();
  const styleB = btn('色・太さ・濃さ', null, () => togglePanel(styleP, styleB), 'dd');
  const dot = el('span', 'dot');
  styleB.append(dot);
  bar.append(styleB, sep());
  const swBtns = PALETTE.map((c, i) => {
    const b = btn(`色 ${i + 1}`, null, () => setColor(c), 'c');
    b.style.setProperty('--c', c);
    return b;
  });
  const ci = el('input', 'ci', { type: 'color', tabindex: '-1', 'aria-hidden': 'true' });
  ci.addEventListener('input', () => setColor(ci.value));
  const customB = btn('カスタム色', null, () => {
    ci.value = color;
    try { ci.showPicker(); } catch (_) { ci.click(); }
  }, 'c cc');
  const pal = row(...swBtns, customB);
  if (HAS_ED) pal.append(btn('スポイト (I) — 画面上の色を拾う', I.drop, () => { closePanel(); pickColor(); }));
  styleP.append(pal);
  bar.append(ci);

  const range = (label, title, lo, hi, fn) => {
    const w = el('label', 'r', { title });
    const s = el('span');
    s.textContent = label;
    const r = el('input', null, { type: 'range', min: lo, max: hi, step: 1 });
    const o = el('output');
    r.addEventListener('input', () => fn(+r.value));
    w.append(s, r, o);
    styleP.append(w);
    return [w, r, o];
  };
  // 太さは二乗スケール（細い線を細かく調整できる）
  const [sizeW, sizeR, sizeO] = range('太さ', '太さ ([ / ])', 10, 100, v => {
    CFG[tool].size = max(1, round(v * v / 100));
    syncTool(true);
  });
  const [alphaW, alphaR, alphaO] = range('濃さ', '不透明度', 5, 100, v => {
    CFG[tool].alpha = v / 100;
    syncTool(true);
  });

  const undoB = btn('元に戻す (Ctrl/⌘+Z)', I.undo, undo);
  const redoB = btn('やり直す (Ctrl/⌘+Shift+Z)', I.redo, redo);
  const passB = btn('ページ操作モード (V) — 絵を残したままページを操作', I.pass, togglePass);
  // その他: 名前とショートカット付きのメニュー。keep なら押しても閉じない（背景を続けて切り替えられる）
  const moreP = pnl();
  const moreB = btn('その他（全消去・背景・保存・コピー）', I.more, () => togglePanel(moreP, moreB));
  const item = (title, label, key, d, fn, keep) => {
    const b = btn(title, d, () => { if (!keep) closePanel(); fn(); }, 'mi');
    const s = el('span');
    s.textContent = label;
    b.append(s);
    if (key) { const k = el('kbd'); k.textContent = key; b.append(k); }
    moreP.append(b);
    return [b, s];
  };
  item('全消去 (Delete)', '全消去', 'Delete', I.trash, clearAll);
  const [bgB, bgL] = item('', '', 'B', I.bg, cycleBg, true);
  item('PNG で保存 (Ctrl/⌘+S)', 'PNG で保存', IS_MAC ? '⌘S' : 'Ctrl+S', I.save, save);
  if (HAS_CLIP) item('画像をクリップボードにコピー', 'クリップボードにコピー', '', I.copy, copyImg);
  bar.append(undoB, redoB, sep(), passB, moreB, sep(),
    btn('隠す (Esc) — ブックマークレットを再度押すと再表示', I.hide, hide), btn('閉じる（8 秒間は元に戻せます）', I.close, close),
    shapeP, styleP, moreP);

  // パネルは 1 つだけ開く。描き始め・パネルの外を押す・Esc で閉じる。
  // 開いていなければ pointerdown ごとの仕事は比較 1 回だけ（入力のホットパスには触れない）
  let openP = null, openB = null;
  function openPanel(p, b) {
    closePanel();
    openP = p; openB = b;
    p.classList.add('on');
    b.classList.add('open');
    measureBar();
    const pw = p.offsetWidth, ph = p.offsetHeight;
    // 下に入らなければ上に開く。横は画面からはみ出さないように寄せる
    bar.classList.toggle('up', barY + barH + ph + 8 > vh && barY >= ph + 8);
    p.style.left = max(4 - barX, min(b.offsetLeft, vw - barX - pw - 4)) + 'px';
  }
  function closePanel() {
    if (!openP) return;
    openP.classList.remove('on');
    openB.classList.remove('open');
    openP = openB = null;
  }
  function togglePanel(p, b) { openP === p ? closePanel() : openPanel(p, b); }
  wrap.addEventListener('pointerdown', e => {
    if (openP && !openP.contains(e.target) && !openB.contains(e.target)) closePanel();
  }, true);

  // ボタンがフォーカスを奪うと Space/Enter で誤作動するため、クリックでのフォーカス移動を抑止
  bar.addEventListener('pointerdown', e => { if (e.target.closest('.b')) e.preventDefault(); });

  // ツールバーのドラッグ移動（transform のみ更新＝レイアウト不要）
  let barX = 0, barY = 10, barW = 0, barH = 0, vw = 0, vh = 0;
  const moveBar = (x, y) => {
    barX = max(0, min(x, vw - barW));
    barY = max(0, min(y, vh - barH));
    bar.style.transform = `translate(${barX}px,${barY}px)`;
  };
  const measureBar = () => {
    vw = wrap.clientWidth; vh = wrap.clientHeight;
    barW = bar.offsetWidth; barH = bar.offsetHeight;
  };
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    measureBar();
    const ox = e.clientX - barX, oy = e.clientY - barY, id = e.pointerId;
    try { grip.setPointerCapture(id); } catch (_) { }
    const mv = ev => { if (ev.pointerId === id) moveBar(ev.clientX - ox, ev.clientY - oy); };
    const up = ev => {
      if (ev.pointerId !== id) return;
      grip.removeEventListener('pointermove', mv);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
    };
    grip.addEventListener('pointermove', mv);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });

  // ---------- UI 同期（ホットパス外でのみ呼ぶ） ----------
  function setTool(t) {
    if (t !== 'text') commitText();
    tool = t;
    syncTool(false);
  }
  function syncTool(fromSlider) {
    for (const k in toolBtns) toolBtns[k].classList.toggle('on', k === tool);
    const shape = SHAPES.includes(tool);
    if (shape && lastShape !== tool) {
      lastShape = tool;
      shapeD.setAttribute('d', I[tool]);
      shapeB.title = TITLES[tool];
      shapeB.setAttribute('aria-label', TITLES[tool]);
    }
    shapeB.classList.toggle('on', shape);
    const c = CFG[tool];
    if (!fromSlider) {
      sizeR.value = round(sqrt(max(c.size, 1) * 100));
      alphaR.value = round(c.alpha * 100);
    }
    sizeO.value = tool === 'fill' ? '—' : c.size;
    alphaO.value = tool === 'eraser' ? '—' : round(c.alpha * 100) + '%';
    sizeW.classList.toggle('dis', tool === 'fill');
    alphaW.classList.toggle('dis', tool === 'eraser');
    sizeW.firstChild.textContent = tool === 'text' ? '大きさ' : '太さ';
    if (ta) styleTa();
    syncDot();
    updateCursor();
    liveAlpha();
  }
  // 色と太さのボタンの点: 色・太さ（4〜20px に縮めて表示）・濃さ。消しゴムは輪だけ
  function syncDot() {
    const c = CFG[tool];
    dot.style.setProperty('--c', color);
    dot.style.setProperty('--d', (tool === 'fill' ? 16 : round(4 + sqrt(min(c.size, 100) / 100) * 16)) + 'px');
    dot.style.setProperty('--a', tool === 'eraser' ? 1 : max(0.2, c.alpha));
    dot.classList.toggle('er', tool === 'eraser');
  }
  // live のグループの不透明度は、ツールや濃さを選んだ時点で合わせておく。押した瞬間に変えると、
  // desynchronized の live の方が先に画面へ出て、半透明の線が最初の 1 フレームだけ濃く見える
  function liveAlpha() {
    const a = tool === 'eraser' || tool === 'fill' ? 1 : CFG[tool].alpha;
    if (grpA !== a && !handoff) { grp.style.opacity = a; grpA = a; }
  }
  function setSize(s) {
    if (tool === 'fill') return;
    CFG[tool].size = max(1, min(100, s));
    syncTool(false);
  }
  function setColor(c) {
    color = c.toLowerCase();
    let hit = false;
    swBtns.forEach((b, i) => { const on = PALETTE[i] === color; b.classList.toggle('on', on); hit = hit || on; });
    customB.classList.toggle('on', !hit);
    customB.style.setProperty('--c', color);
    if (ta) styleTa();
    syncDot();
  }
  function syncHist() {
    undoB.disabled = hpos === 0;
    redoB.disabled = hpos >= hist.length;
  }
  function cycleBg() {
    bg = (bg + 1) % BGS.length;
    sbox.classList.toggle('bg1', bg === 1);
    sbox.classList.toggle('bg2', bg === 2);
    syncBg();
  }
  function syncBg() {
    const t = `背景: ${BG_NAMES[bg]}`;
    bgB.title = t + ' (B)';
    bgB.setAttribute('aria-label', t + ' (B)');
    bgL.textContent = t;
    bgB.classList.toggle('on', bg !== 0);
  }
  function togglePass() {
    if (act !== -1) endStroke();
    commitText();
    pass = !pass;
    wrap.classList.toggle('pass', pass);
    passB.classList.toggle('on', pass);
    say(pass ? 'ページ操作モード（V で描画に戻る）' : '描画モード');
  }
  // カーソル画像は OS/コンポジタが描くので遅延ゼロ（DOM で追従させるとフレーム遅れが出る）
  function updateCursor() {
    let cur = tool === 'text' ? 'text' : 'crosshair';
    if (tool === 'pen' || tool === 'marker' || tool === 'eraser') {
      const d = max(6, round(CFG[tool].size)), s = d + 4, m = s / 2, r = d / 2;
      if (s <= 128) {
        const svg = `<svg xmlns="${SVGNS}" width="${s}" height="${s}"><circle cx="${m}" cy="${m}" r="${r}" fill="none" stroke="#000" stroke-opacity=".75" stroke-width="1.5"/><circle cx="${m}" cy="${m}" r="${max(r - 1.25, 0.5)}" fill="none" stroke="#fff" stroke-opacity=".9"/></svg>`;
        cur = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${m | 0} ${m | 0},crosshair`;
      }
    }
    pad.style.cursor = cur;
  }
  let toastT = 0, toastFn = null;
  // fn を渡すと、押せるボタン（act）付きで ms だけ出す（閉じるの取り消しに使う）
  function say(msg, ms = 1800, act, fn) {
    toastM.textContent = msg;
    toastB.textContent = act || '';
    toastFn = fn || null;
    toast.classList.toggle('act', !!fn);
    toast.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(unsay, ms);
  }
  function unsay() {
    toast.classList.remove('on', 'act');
    toastFn = null;
  }
  toastB.addEventListener('click', () => { if (toastFn) toastFn(); });

  // ---------- キャンバスのサイズ管理 ----------
  // live / pred は画面の大きさ。拡大時だけ作り直す（中身は描いている途中の線だけなので引き継がない）
  function fit() {
    if (act !== -1) { pendingFit = true; return; }
    pendingFit = false;
    finishHandoff();
    dpr = win.devicePixelRatio || 1;
    const w = ceil(win.innerWidth * dpr), h = ceil(win.innerHeight * dpr);
    if (w > W || h > H) {
      W = max(w, W); H = max(h, H);
      for (const c of [liveC, predC]) { c.width = W; c.height = H; }
      setTimeout(warm, 0);
    }
    const cw = W / dpr + 'px', ch = H / dpr + 'px';
    for (const c of [liveC, predC]) { c.style.width = cw; c.style.height = ch; }
    tx0 = ty0 = tx1 = ty1 = 0;
    if (visible) { sizeSurface(); measureBar(); moveBar(barX, barY); }
  }
  // 暖機: キャンバスの GPU バッキング確保や合成パスの初回コンパイルは初回描画時に数十 ms かかる。
  // 描き始めてから払うと最初の一筆が引っかかるので、起動直後の何もしていない時間に済ませておく。
  function warm() {
    if (act !== -1 || handoff) return;
    for (const c of [lctx, pctx]) { c.fillRect(0, 0, 1, 1); c.clearRect(0, 0, 1, 1); }
    // 確定（半透明の合成）・消しゴム・退避で使う処理を、画面に出ない小さなキャンバスで一度ずつ通しておく
    const s = newCanvas(2, 2), x = s.getContext('2d');
    x.globalAlpha = 0.5;
    x.drawImage(liveC, 0, 0, 1, 1, 0, 0, 1, 1);
    x.globalAlpha = 1;
    x.globalCompositeOperation = 'destination-out';
    x.fillRect(0, 0, 1, 1);
    if (!pool.length) pool.push(newTile());
    pool[0].x.drawImage(s, 0, 0, 1, 1, 0, 0, 1, 1);
  }
  function onResize() {
    if (!rz) rz = requestAnimationFrame(() => { rz = 0; fit(); });
  }

  // ---------- 履歴 ----------
  // 1 手 = 変更された矩形群 R（[x, y, w, h, ax, ay] の平坦配列）と、その元の画素を詰めた 1 枚のアトラス c。
  // undo と redo はどちらも「現在の画素とアトラスの入れ替え」なので同じ処理で済む。
  const hist = [];
  let hpos = 0, hpix = 0;
  // これまでに main の画素が変わりうる範囲の和（塗りつぶしの読み戻し範囲を絞るのに使う）
  let cbx0 = 0, cby0 = 0, cbx1 = 0, cby1 = 0;
  function grow(R) {
    for (let i = 0; i < R.length; i += 6) {
      const x = R[i], y = R[i + 1], ex = x + R[i + 2], ey = y + R[i + 3];
      if (cbx1 <= cbx0) { cbx0 = x; cby0 = y; cbx1 = ex; cby1 = ey; continue; }
      if (x < cbx0) cbx0 = x;
      if (y < cby0) cby0 = y;
      if (ex > cbx1) cbx1 = ex;
      if (ey > cby1) cby1 = ey;
    }
  }
  function push(R, c) {
    grow(R);
    while (hist.length > hpos) free(hist.pop());
    let pix = 0;
    for (let i = 0; i < R.length; i += 6) pix += R[i + 2] * R[i + 3];
    hist.push({ R, c, pix });
    hpos++;
    hpix += pix;
    // メモリ上限: 画面 8 枚分または 200 手
    const cap = max(W * H * 8, 3e7);
    while (hist.length > 1 && (hist.length > 200 || hpix > cap)) { free(hist.shift()); hpos--; }
    syncHist();
  }
  function free(h) {
    hpix -= h.pix;
    h.c.width = h.c.height = 0;
  }
  // 矩形群を棚詰め (shelf packing) で 1 枚のアトラスに配置し、その大きさのキャンバスを返す
  function pack(R) {
    let ax = 0, ay = 0, rh = 0, aw = 1;
    for (let i = 0; i < R.length; i += 6) {
      const w = R[i + 2], h = R[i + 3];
      if (ax + w > max(W, 4096)) { ay += rh; ax = rh = 0; }
      R[i + 4] = ax; R[i + 5] = ay;
      ax += w;
      if (h > rh) rh = h;
      if (ax > aw) aw = ax;
    }
    return newCanvas(aw, max(1, ay + rh));
  }
  // 面の R の範囲をアトラスへ GPU コピー（タイルの無い所は透明のまま）
  function gather(R, atlas) {
    const c = atlas.getContext('2d');
    for (let i = 0; i < R.length; i += 6) {
      const x = R[i], y = R[i + 1], ax = R[i + 4], ay = R[i + 5];
      forTiles(x, y, R[i + 2], R[i + 3], false, (t, ox, oy, ix, iy, iw, ih) =>
        c.drawImage(t.c, ix - ox, iy - oy, iw, ih, ax + ix - x, ay + iy - y, iw, ih));
    }
    return atlas;
  }
  const rect1 = (x, y, w, h) => [x, y, w, h, 0, 0];
  function swap(h) {
    const R = h.R, src = h.c, cur = gather(R, newCanvas(src.width, src.height));
    grow(R);
    for (let i = 0; i < R.length; i += 6) {
      const x = R[i], y = R[i + 1], ax = R[i + 4], ay = R[i + 5];
      forTiles(x, y, R[i + 2], R[i + 3], true, (t, ox, oy, ix, iy, iw, ih) => {
        t.x.clearRect(ix - ox, iy - oy, iw, ih);
        t.x.drawImage(src, ax + ix - x, ay + iy - y, iw, ih, ix - ox, iy - oy, iw, ih);
      });
    }
    src.width = src.height = 0;
    h.c = cur;
  }
  function undo() {
    commitText();
    if (act !== -1 || !hpos) return;
    finishHandoff();
    swap(hist[--hpos]);
    syncHist();
  }
  function redo() {
    commitText();
    if (act !== -1 || hpos >= hist.length) return;
    finishHandoff();
    swap(hist[hpos++]);
    syncHist();
  }
  // 全消去はページ全体（見えていない所も含む）。元に戻せるように、全タイルをアトラスに退避してから消す
  function clearAll() {
    if (act !== -1) return;
    commitText();
    finishHandoff();
    const R = [];
    for (const k of dtiles.keys()) R.push((k % 65536) * DT, ((k / 65536) | 0) * DT, DT, DT, 0, 0);
    if (!R.length) return;
    push(R, gather(R, pack(R)));
    for (const t of dtiles.values()) t.x.clearRect(0, 0, DT, DT);
    cbx0 = cby0 = cbx1 = cby1 = 0;
  }

  // ---------- ストローク状態（ホットパスで割り当てを起こさないよう、すべてスカラーで保持） ----------
  let act = -1, aType = '', mode = 0; // mode: 1 インク / 2 消しゴム / 3 図形
  let sTool = 'pen', sW = 0, sA = 1, sP = false, sRaw = false, raf = 0;
  let bx = 0, by = 0, bw = 0, mx = 0, my = 0, ps = 1, lt = 0, lastPen = -1e9;
  let x0 = 0, y0 = 0, x1 = 0, y1 = 0, mW = 0; // ストロークの外接矩形
  let tx0 = 0, ty0 = 0, tx1 = 0, ty1 = 0; // pred レイヤの汚れ矩形
  let sx = 0, sy = 0, cx = 0, cy = 0, shShift = false, shAlt = false, shaped = false, gHead = false;
  const G = new Float64Array(8); // 確定時のタイル算出用に、最後に描いた図形の形状を保持
  let pn = 0, nativePred = false, vx = 0, vy = 0;
  const px = new Float64Array(PRED_MAX), py = new Float64Array(PRED_MAX), pt = new Float64Array(PRED_MAX);
  const ePts = new Float64Array(512); // 消しゴム: 1 回の描画で使う点（S 座標、最大 256 点）
  let handoff = 0, hcx = 0, hcy = 0, hcw = 0, hch = 0; // 確定後に live を消すまでの受け渡し（commitLive）
  // 計測（HUD 表示中のみ時間を測る）
  let hud = null, hudT = 0, stEv = 0, stPred = 0, stCost = 0, stLag = 0, stT = 0, stP0 = 0, lastFillMs = 0;
  let nEv = 0, nPts = 0; // 累計（stats() 用）
  // Delegated Ink Trail: 次フレームまでの隙間を OS が直接描く。OS 描画が確実な Windows に限定し、
  // それ以外では予測線を使う（API が存在しても軌跡が描かれない環境で予測を失わないため）
  let inkP = null;
  try {
    if (/^Win/i.test(PLAT) && navigator.ink && navigator.ink.requestPresenter) {
      navigator.ink.requestPresenter({ presentationArea: pad }).then(p => { inkP = p; }, () => { });
    }
  } catch (_) { }

  const qw = w => round(w * 4) / 4; // 線幅を 0.25px 単位に量子化（同じ幅の区間をまとめて 1 回で stroke）

  function setInk(c) {
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.strokeStyle = c.fillStyle = color;
    c.lineCap = 'round';
    c.lineJoin = 'round';
  }

  function onDown(e) {
    const type = e.pointerType, pen = type === 'pen';
    if (pen) lastPen = e.timeStamp;
    if (act !== -1) {
      // パームリジェクション: タッチで描画中にペンが触れたら、タッチの線を破棄してペンを優先
      if (pen && aType === 'touch') abortStroke();
      else return;
    } else if (type === 'touch' && e.timeStamp - lastPen < 500) return;
    const b = e.button;
    const erase = b === 2 || b === 5 || (e.buttons & 32) !== 0;
    if (b !== 0 && !erase) return;
    e.preventDefault();
    // 入力中の文字があれば確定する。文字ツールのままなら、このクリックは確定だけ（新しい入力欄は出さない）
    if (ta) {
      commitText();
      if (!erase && tool === 'text') { wrap.focus({ preventScroll: true }); return; }
    }
    if (doc.activeElement !== host) wrap.focus({ preventScroll: true });
    if ((win.devicePixelRatio || 1) !== dpr) fit();
    finishHandoff();
    mapNow();
    const t = erase ? 'eraser' : tool;
    const x = e.clientX * dpr, y = e.clientY * dpr;
    if (t === 'fill') { floodFill(x, y); return; }
    if (t === 'text') { textAt(e.clientX, e.clientY); return; }

    act = e.pointerId; aType = type; sTool = t;
    const c = CFG[t];
    sW = c.size * dpr; sA = c.alpha; mW = sW;
    lt = e.timeStamp; pn = 0; vx = vy = 0;
    bx = mx = sx = cx = x0 = x1 = x;
    by = my = sy = cy = y0 = y1 = y;
    try { pad.setPointerCapture(act); } catch (_) { }

    if (t === 'eraser') {
      mode = 2;
      const p = sW / 2 + 2;
      markBox(x - p, y - p, x + p, y + p); // 削る前に該当タイルを退避
      ePts[0] = x * sk + sox; ePts[1] = y * sk + soy;
      erasePts(1);
    } else {
      if (grpA !== sA) { grp.style.opacity = sA; grpA = sA; }
      setInk(lctx);
      if (t === 'pen' || t === 'marker') {
        mode = 1;
        setInk(pctx);
        sP = pen && t === 'pen' && e.pressure > 0;
        ps = sP ? e.pressure : 1;
        bw = sP ? qw(sW * (0.2 + 0.8 * ps)) : sW;
        // 押した瞬間に点を出す（タップでも点が残る）
        lctx.beginPath(); lctx.arc(x, y, bw / 2, 0, TAU); lctx.fill();
        const p = bw / 2 + 2;
        markBox(x - p, y - p, x + p, y + p);
      } else {
        mode = 3;
        shaped = false;
        shShift = e.shiftKey; shAlt = e.altKey;
        lctx.lineWidth = sW;
        lctx.lineJoin = t === 'rect' ? 'miter' : 'round';
      }
    }
    // 図形は 1 フレームに 1 回の再描画で十分なので rawupdate は使わない
    sRaw = HAS_RAW && mode !== 3;
    if (sRaw) pad.addEventListener('pointerrawupdate', onMove);
    raf = requestAnimationFrame(tick);
  }

  // pointerrawupdate と pointermove の両方から呼ばれる。タイムスタンプで重複を除くので
  // どちらが先に届いても、どちらかしか来なくても正しく描ける。
  function onMove(e) {
    if (e.pointerId !== act) {
      if (e.pointerType === 'pen') lastPen = e.timeStamp; // ホバー中のペンもパームリジェクションに使う
      return;
    }
    const t0 = hud ? now() : 0;
    const list = HAS_CO && e.getCoalescedEvents ? e.getCoalescedEvents() : EMPTY;
    const n = list.length;
    const isMove = e.type === 'pointermove';
    if (mode === 1) {
      inkMove(e, list, n);
      if (inkP && sA === 1 && isMove) {
        // OS が実際のポインタ位置まで線を伸ばすので、推測（予測線）は使わない
        try { inkP.updateInkTrailStartPoint(e, { color, diameter: bw / dpr }); pn = 0; } catch (_) { readPred(e); }
      } else if (isMove) readPred(e);
      drawTail();
    } else if (mode === 2) {
      eraseMove(e, list, n);
    } else if (e.type !== 'pointerrawupdate') {
      const p = n ? list[n - 1] : e;
      cx = p.clientX * dpr; cy = p.clientY * dpr;
      shShift = e.shiftKey; shAlt = e.altKey;
      drawShape();
    }
    nEv++;
    if (hud) { stEv++; stPred += pn; stCost += now() - t0; stLag += t0 - e.timeStamp; }
  }

  // 中点を結ぶ二次ベジエで平滑化しつつ、新しい点の分だけを live レイヤに追記する
  function inkMove(e, list, n) {
    const c = lctx;
    let open = false, cw = -1;
    for (let i = 0, len = n || 1; i < len; i++) {
      const p = n ? list[i] : e;
      const t = p.timeStamp || lt, x = p.clientX * dpr, y = p.clientY * dpr;
      if (t < lt || (x === bx && y === by)) continue; // 既に処理済み、または移動なし
      const dt = t - lt;
      if (dt > 0.5) { vx += ((x - bx) / dt - vx) * 0.5; vy += ((y - by) / dt - vy) * 0.5; }
      lt = t;
      nPts++;
      let w = sW;
      if (sP) {
        const pr = p.pressure;
        ps += ((pr > 0 ? pr : ps) - ps) * 0.5;
        w = qw(sW * (0.2 + 0.8 * ps));
      }
      const nx = (bx + x) * 0.5, ny = (by + y) * 0.5;
      if (bw !== cw) {
        if (open) c.stroke();
        c.lineWidth = cw = bw;
        c.beginPath();
        c.moveTo(mx, my);
        open = true;
      }
      c.quadraticCurveTo(bx, by, nx, ny);
      markCurve(mx, my, bx, by, nx, ny, bw / 2 + 2);
      mx = nx; my = ny; bx = x; by = y; bw = w;
      if (x < x0) x0 = x; else if (x > x1) x1 = x;
      if (y < y0) y0 = y; else if (y > y1) y1 = y;
      if (w > mW) mW = w;
    }
    if (open) c.stroke();
  }

  function readPred(e) {
    const l = e.getPredictedEvents ? e.getPredictedEvents() : EMPTY;
    let k = 0;
    for (let i = 0; i < l.length && k < PRED_MAX; i++, k++) {
      const p = l[i];
      px[k] = p.clientX * dpr; py[k] = p.clientY * dpr; pt[k] = p.timeStamp;
    }
    if (k) nativePred = true;
    else if (!nativePred && (vx || vy)) {
      // 予測 API が無い環境: 直近の速度から短時間だけ等速外挿（行き過ぎを防ぐため距離も制限）
      let dx = vx * PRED_MS, dy = vy * PRED_MS;
      const d = hypot(dx, dy), lim = 40 * dpr;
      if (d > lim) { dx *= lim / d; dy *= lim / d; }
      px[0] = bx + dx; py[0] = by + dy; pt[0] = lt + PRED_MS;
      k = 1;
    }
    pn = k;
  }

  // 未確定の末尾（最後の中点→最新点）と予測点を pred レイヤに描く。毎回この小さな範囲だけ消して描き直す
  function drawTail() {
    const c = pctx;
    if (tx1 > tx0) c.clearRect(tx0, ty0, tx1 - tx0, ty1 - ty0);
    let a0 = min(mx, bx), a1 = max(mx, bx), b0 = min(my, by), b1 = max(my, by);
    c.lineWidth = bw;
    c.beginPath();
    c.moveTo(mx, my);
    c.lineTo(bx, by);
    for (let k = 0; k < pn; k++) {
      if (pt[k] && pt[k] <= lt) continue; // 実入力が追い越した予測点は捨てる
      const x = px[k], y = py[k];
      c.lineTo(x, y);
      if (x < a0) a0 = x; else if (x > a1) a1 = x;
      if (y < b0) b0 = y; else if (y > b1) b1 = y;
    }
    c.stroke();
    const m = bw / 2 + 2;
    tx0 = max(0, (a0 - m) | 0); ty0 = max(0, (b0 - m) | 0);
    tx1 = ceil(a1 + m); ty1 = ceil(b1 + m);
  }
  function clearTail() {
    if (tx1 > tx0) pctx.clearRect(tx0, ty0, tx1 - tx0, ty1 - ty0);
    tx0 = ty0 = tx1 = ty1 = 0;
  }

  function eraseMove(e, list, n) {
    let k = 1;
    ePts[0] = bx * sk + sox; ePts[1] = by * sk + soy;
    for (let i = 0, len = n || 1; i < len; i++) {
      const p = n ? list[i] : e;
      const t = p.timeStamp || lt, x = p.clientX * dpr, y = p.clientY * dpr;
      if (t < lt || (x === bx && y === by)) continue;
      lt = t;
      nPts++;
      markSeg(bx, by, x, y, sW / 2 + 2); // 描く（erasePts）より前に呼ぶので、削られる前の画素を退避できる
      ePts[k * 2] = x * sk + sox; ePts[k * 2 + 1] = y * sk + soy;
      bx = x; by = y;
      if (x < x0) x0 = x; else if (x > x1) x1 = x;
      if (y < y0) y0 = y; else if (y > y1) y1 = y;
      if (++k === 256) { erasePts(k); ePts[0] = ePts[510]; ePts[1] = ePts[511]; k = 1; }
    }
    if (k > 1) erasePts(k);
  }
  // 消しゴムの線（ePts の n 点、S 座標）を、掛かる表示タイルそれぞれに destination-out で描く。
  // タイルの無い所には消すものも無いので作らない。入力のたびに呼ばれるので割り当てをしない
  function erasePts(n) {
    const w = sW * sk, r = w / 2 + 2;
    let ax = ePts[0], ay = ePts[1], ex = ax, ey = ay;
    for (let i = 2; i < n * 2; i += 2) {
      const x = ePts[i], y = ePts[i + 1];
      if (x < ax) ax = x; else if (x > ex) ex = x;
      if (y < ay) ay = y; else if (y > ey) ey = y;
    }
    if (ex + r <= 0 || ey + r <= 0) return;
    const tx0 = max(0, floor((ax - r) / DT)), ty0 = max(0, floor((ay - r) / DT));
    const tx1 = floor((ex + r) / DT), ty1 = floor((ey + r) / DT);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = dtiles.get(ty * 65536 + tx);
        if (!t) continue;
        const c = t.x, ox = tx * DT, oy = ty * DT;
        c.globalCompositeOperation = 'destination-out';
        c.lineCap = c.lineJoin = 'round';
        c.lineWidth = w;
        c.strokeStyle = c.fillStyle = '#000';
        c.beginPath();
        if (n === 1) {
          c.arc(ePts[0] - ox, ePts[1] - oy, w / 2, 0, TAU);
          c.fill();
        } else {
          c.moveTo(ePts[0] - ox, ePts[1] - oy);
          for (let i = 2; i < n * 2; i += 2) c.lineTo(ePts[i] - ox, ePts[i + 1] - oy);
          c.stroke();
        }
        c.globalCompositeOperation = 'source-over';
      }
    }
  }

  function drawShape() {
    const c = lctx, r = dirty();
    if (r) c.clearRect(r.x, r.y, r.w, r.h);
    let ax = sx, ay = sy, ex = cx, ey = cy;
    c.beginPath();
    if (sTool === 'line' || sTool === 'arrow') {
      let d = hypot(ex - ax, ey - ay);
      if (shShift) {
        const a = round(atan2(ey - ay, ex - ax) / (PI / 4)) * (PI / 4);
        ex = ax + cos(a) * d; ey = ay + sin(a) * d;
      }
      c.moveTo(ax, ay);
      c.lineTo(ex, ey);
      G[0] = ax; G[1] = ay; G[2] = ex; G[3] = ey;
      gHead = false;
      x0 = min(ax, ex); x1 = max(ax, ex); y0 = min(ay, ey); y1 = max(ay, ey);
      if (sTool === 'arrow' && d > 0) {
        const a = atan2(ey - ay, ex - ax), hl = min(d * 0.6, max(12 * dpr, sW * 3.5));
        const hx1 = ex + cos(a + 2.6) * hl, hy1 = ey + sin(a + 2.6) * hl;
        const hx2 = ex + cos(a - 2.6) * hl, hy2 = ey + sin(a - 2.6) * hl;
        c.moveTo(hx1, hy1); c.lineTo(ex, ey); c.lineTo(hx2, hy2);
        G[4] = hx1; G[5] = hy1; G[6] = hx2; G[7] = hy2;
        gHead = true;
        x0 = min(x0, hx1, hx2); x1 = max(x1, hx1, hx2); y0 = min(y0, hy1, hy2); y1 = max(y1, hy1, hy2);
      }
      shaped = d > 0;
    } else {
      let w = ex - ax, h = ey - ay;
      if (shShift) {
        const s = max(abs(w), abs(h));
        w = w < 0 ? -s : s; h = h < 0 ? -s : s;
      }
      let l, tp, rw, rh;
      if (shAlt) { rw = abs(w) * 2; rh = abs(h) * 2; l = ax - rw / 2; tp = ay - rh / 2; }
      else { rw = abs(w); rh = abs(h); l = min(ax, ax + w); tp = min(ay, ay + h); }
      if (sTool === 'rect') c.rect(l, tp, rw, rh);
      else c.ellipse(l + rw / 2, tp + rh / 2, rw / 2, rh / 2, 0, 0, TAU);
      G[0] = l; G[1] = tp; G[2] = rw; G[3] = rh;
      x0 = l; y0 = tp; x1 = l + rw; y1 = tp + rh;
      shaped = rw > 0 || rh > 0;
    }
    c.stroke();
  }

  // ストロークの外接矩形（線幅ぶん広げ、整数ピクセルに丸めてクリップ）
  function dirty() {
    const m = mW / 2 + 2;
    const ax = max(0, (x0 - m) | 0), ay = max(0, (y0 - m) | 0);
    const ex = min(W, ceil(x1 + m)), ey = min(H, ceil(y1 + m));
    return ex > ax && ey > ay ? { x: ax, y: ay, w: ex - ax, h: ey - ay } : null;
  }

  function tick(ts) {
    raf = requestAnimationFrame(tick);
    // ポインタが止まったら古い予測線を消す（行き過ぎた線が残らないように）
    if (pn && ts - lt > PRED_TTL) { pn = 0; drawTail(); }
  }

  function onUp(e) {
    if (e.pointerType === 'pen') lastPen = e.timeStamp; // ペンを離した直後に手のひらが触れても描かない
    if (e.pointerId !== act) return;
    onMove(e);
    endStroke();
  }
  function onLost(e) {
    if (e.pointerId === act) endStroke();
  }

  function stopStroke() {
    const id = act;
    act = -1;
    if (sRaw) pad.removeEventListener('pointerrawupdate', onMove);
    cancelAnimationFrame(raf);
    raf = 0; pn = 0;
    try { if (pad.hasPointerCapture(id)) pad.releasePointerCapture(id); } catch (_) { }
  }

  function endStroke() {
    if (act === -1) return;
    const m = mode;
    stopStroke();
    if (m === 1) {
      // 最後の半区間（中点→最終点）を確定してから main へ合成
      if (mx !== bx || my !== by) {
        lctx.lineWidth = bw;
        lctx.beginPath(); lctx.moveTo(mx, my); lctx.lineTo(bx, by); lctx.stroke();
        markSeg(mx, my, bx, by, bw / 2 + 2);
      }
      clearTail();
      commitLive();
    } else if (m === 3) {
      if (shaped) { markShape(); commitLive(); }
      else { const r = dirty(); if (r) lctx.clearRect(r.x, r.y, r.w, r.h); }
    } else if (m === 2) {
      // 退避しておいたタイルを 1 枚のアトラスにまとめて履歴へ
      const R = tileRects(false);
      if (R.length) {
        const ac = pack(R).getContext('2d');
        for (let k = 0, i = 0; i < R.length; k++, i += 6) ac.drawImage(tsave[k].c, 0, 0, R[i + 2], R[i + 3], R[i + 4], R[i + 5], R[i + 2], R[i + 3]);
        push(R, ac.canvas);
      }
    }
    resetTiles();
    mode = 0;
    if (pendingFit) fit();
  }

  function abortStroke() {
    const m = mode, r = dirty();
    stopStroke();
    if (m === 2) {
      // 退避しておいた画素を戻す（表示タイルが無かった所は、何も消していない）
      const R = tileRects(false);
      for (let k = 0, i = 0; i < R.length; k++, i += 6) {
        const x = R[i], y = R[i + 1], d = dtiles.get(((y / DT) | 0) * 65536 + ((x / DT) | 0));
        if (!d) continue;
        d.x.clearRect(x % DT, y % DT, T, T);
        d.x.drawImage(tsave[k].c, 0, 0, T, T, x % DT, y % DT, T, T);
      }
    } else {
      if (r) lctx.clearRect(r.x, r.y, r.w, r.h);
      clearTail();
    }
    resetTiles();
    mode = 0;
  }

  // live のうち触れたタイルの範囲だけを面に合成し、その範囲の元の絵を履歴に積む。
  // 外接矩形ではなくタイル単位なので、斜めの長い線や広範囲の線でも処理量・メモリは線の面積にほぼ比例する
  function commitLive() {
    let R = tileRects(true);
    const r = dirty();
    if (!R.length || !r) { if (r) lctx.clearRect(r.x, r.y, r.w, r.h); return; }
    // 水平に細長い線などはタイルより外接矩形の方が小さいので、面積の小さい方を使う
    let tp = 0;
    for (let i = 0; i < R.length; i += 6) tp += R[i + 2] * R[i + 3];
    const bX = floor(r.x * sk + sox), bY = floor(r.y * sk + soy);
    const bW = ceil((r.x + r.w) * sk + sox) - bX, bH = ceil((r.y + r.h) * sk + soy) - bY;
    if (bW * bH < tp) R = rect1(bX, bY, bW, bH);
    sizeSurface();
    const atlas = gather(R, pack(R));
    for (let i = 0; i < R.length; i += 6) {
      forTiles(R[i], R[i + 1], R[i + 2], R[i + 3], true, (t, ox, oy, ix, iy, iw, ih) => {
        const c = t.x;
        c.globalAlpha = sA;
        c.drawImage(liveC, (ix - sox) / sk, (iy - soy) / sk, iw / sk, ih / sk, ix - ox, iy - oy, iw, ih);
        c.globalAlpha = 1;
      });
    }
    push(R, atlas);
    // live は desynchronized なので、ここで消すと通常の更新であるタイルより先に画面へ出て、線が一瞬消える。
    // live は残したままグループを隠し（タイルの更新と同じフレームで切り替わる）、2 フレーム後に中身を消す
    grp.style.opacity = 0;
    grpA = 0;
    hcx = r.x; hcy = r.y; hcw = r.w; hch = r.h;
    handoff = requestAnimationFrame(() => { handoff = requestAnimationFrame(finishHandoff); });
  }
  function finishHandoff() {
    if (!handoff) return;
    cancelAnimationFrame(handoff);
    handoff = 0;
    lctx.clearRect(hcx, hcy, hcw, hch);
    liveAlpha();
  }

  // ---------- タイル ----------
  // 矩形 [ax,bx]×[ay,by]（V 座標）に掛かる履歴タイル（S 座標）に印を付ける。
  // 消しゴム中は、初めて触れるタイルを削る前に退避する（コピーオンライト）
  function markBox(ax, ay, bx, by) {
    const X0 = ax * sk + sox, Y0 = ay * sk + soy, X1 = bx * sk + sox, Y1 = by * sk + soy;
    if (X1 < 0 || Y1 < 0) return;
    const c0 = X0 > 0 ? (X0 / T) | 0 : 0, r0 = Y0 > 0 ? (Y0 / T) | 0 : 0;
    const c1 = min(65535, (X1 / T) | 0), r1 = (Y1 / T) | 0;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0, k = r * 65536 + c0; c <= c1; c++, k++) {
        if (tmark.has(k)) continue;
        tmark.add(k);
        tl.push(k);
        if (mode === 2) {
          // T は DT の約数なので、履歴タイルは必ず 1 枚の表示タイルに収まる
          const s = pool.pop() || newTile(), x = c * T, y = r * T;
          const d = dtiles.get(((y / DT) | 0) * 65536 + ((x / DT) | 0));
          if (d) s.x.drawImage(d.c, x % DT, y % DT, T, T, 0, 0, T, T);
          else s.x.clearRect(0, 0, T, T);
          tsave.push(s);
        }
      }
    }
  }
  function newTile() {
    const c = newCanvas(T, T), x = c.getContext('2d');
    x.globalCompositeOperation = 'copy';
    return { c, x };
  }
  // 線分（太さ 2p）に掛かるタイル。長い線分は T/2 ごとに分割して斜め方向の無駄を抑える
  function markSeg(ax, ay, bx, by, p) {
    const n = max(1, ceil(max(abs(bx - ax), abs(by - ay)) / (T / 2)));
    let qx = ax, qy = ay;
    for (let i = 1; i <= n; i++) {
      const t = i / n, rx = ax + (bx - ax) * t, ry = ay + (by - ay) * t;
      markBox(min(qx, rx) - p, min(qy, ry) - p, max(qx, rx) + p, max(qy, ry) + p);
      qx = rx; qy = ry;
    }
  }
  // 二次ベジエ (a, 制御点 c, e) に掛かるタイル。分割した部分曲線の制御点 (blossom) を含む箱で覆うので取りこぼさない
  function markCurve(ax, ay, cx, cy, ex, ey, p) {
    const L = max(abs(cx - ax), abs(cy - ay)) + max(abs(ex - cx), abs(ey - cy));
    if (L <= T / 2) {
      markBox(min(ax, cx, ex) - p, min(ay, cy, ey) - p, max(ax, cx, ex) + p, max(ay, cy, ey) + p);
      return;
    }
    const k = ceil(L / (T / 2));
    let qx = ax, qy = ay;
    for (let i = 1; i <= k; i++) {
      const t0 = (i - 1) / k, t1 = i / k, u0 = 1 - t0, u1 = 1 - t1, m = u0 * t1 + t0 * u1;
      const kx = u0 * u1 * ax + m * cx + t0 * t1 * ex, ky = u0 * u1 * ay + m * cy + t0 * t1 * ey;
      const rx = u1 * u1 * ax + 2 * u1 * t1 * cx + t1 * t1 * ex, ry = u1 * u1 * ay + 2 * u1 * t1 * cy + t1 * t1 * ey;
      markBox(min(qx, kx, rx) - p, min(qy, ky, ry) - p, max(qx, kx, rx) + p, max(qy, ky, ry) + p);
      qx = rx; qy = ry;
    }
  }
  function markShape() {
    const p = mW / 2 + 2;
    if (sTool === 'line' || sTool === 'arrow') {
      markSeg(G[0], G[1], G[2], G[3], p);
      if (gHead) { markSeg(G[4], G[5], G[2], G[3], p); markSeg(G[6], G[7], G[2], G[3], p); }
    } else if (sTool === 'rect') {
      const l = G[0], t = G[1], r = l + G[2], b = t + G[3];
      markSeg(l, t, r, t, p); markSeg(r, t, r, b, p); markSeg(r, b, l, b, p); markSeg(l, b, l, t, p);
    } else {
      // 楕円: 各弧は「両端点と接線の交点」の三角形に含まれるので、その外接箱で覆う
      const rx = G[2] / 2, ry = G[3] / 2, ox = G[0] + rx, oy = G[1] + ry;
      const k = max(32, ceil(TAU * max(rx, ry) / (T / 2))), d = TAU / k, s = 1 / cos(d / 2);
      let ax = ox + rx, ay = oy;
      for (let i = 1; i <= k; i++) {
        const a = i * d, am = a - d / 2;
        const bx2 = ox + rx * cos(a), by2 = oy + ry * sin(a);
        const qx = ox + rx * s * cos(am), qy = oy + ry * s * sin(am);
        markBox(min(ax, bx2, qx) - p, min(ay, by2, qy) - p, max(ax, bx2, qx) + p, max(ay, by2, qy) + p);
        ax = bx2; ay = by2;
      }
    }
  }
  // 印の付いたタイルを矩形配列にする。merge=true なら同じ行で隣接するタイルを 1 つの矩形にまとめる
  function tileRects(merge) {
    const R = [];
    if (merge) tl.sort((a, b) => a - b);
    for (let k = 0; k < tl.length; k++) {
      const s = tl[k], row = (s / 65536) | 0;
      let e = s;
      if (merge) while (k + 1 < tl.length && tl[k + 1] === e + 1 && ((e + 1) / 65536 | 0) === row) { k++; e++; }
      R.push((s % 65536) * T, row * T, (e - s + 1) * T, T, 0, 0);
    }
    return R;
  }
  function resetTiles() {
    tmark.clear();
    tl.length = 0;
    // 退避タイルはプールへ戻して再利用（上限を超えた分は解放）
    for (const t of tsave) { if (pool.length < 256) pool.push(t); else t.c.width = t.c.height = 0; }
    tsave.length = 0;
  }

  // ---------- 塗りつぶし（スキャンライン法） ----------
  // 塗る範囲は、いま見えている画面の中だけ（見えない所まで広げない）。
  // 以下の座標は、画面の左上を原点にした面の px（S − (sox, soy)）
  function floodFill(vx0, vy0) {
    const W = ceil(wrap.clientWidth * sdpr), H = ceil(wrap.clientHeight * sdpr), FX = sox, FY = soy;
    const sx0 = floor(vx0 * sk), sy0 = floor(vy0 * sk);
    if (sx0 < 0 || sy0 < 0 || sx0 >= W || sy0 >= H) return;
    const t0 = now();
    // 読み戻すのは「これまでに描いた範囲」+1px と画面の重なりだけ（それ以外は透明と分かっている）。
    // タイルごとに CPU へ読み戻すと往復がタイルの数だけ起きるので、GPU 上で 1 枚に集めてから 1 回だけ読む。
    // 表示用のタイルでは getImageData しない（読み戻しのあと GPU 描画が遅くなるブラウザがある）
    let gx = 0, gy = 0, gw = 0, gh = 0, data = null;
    if (cbx1 > cbx0) {
      gx = max(0, cbx0 - 1 - FX); gy = max(0, cby0 - 1 - FY);
      gw = min(W, cbx1 + 1 - FX) - gx; gh = min(H, cby1 + 1 - FY) - gy;
      if (gw > 0 && gh > 0) {
        const rc = gather(rect1(gx + FX, gy + FY, gw, gh), newCanvas(gw, gh));
        data = new Uint32Array(rc.getContext('2d').getImageData(0, 0, gw, gh).data.buffer);
        rc.width = rc.height = 0;
      } else gw = gh = 0;
    }
    const inG = sx0 >= gx && sy0 >= gy && sx0 < gx + gw && sy0 < gy + gh;
    const seed = data && inG ? data[(sy0 - gy) * gw + sx0 - gx] : 0;
    const tr = seed & 255, tg = (seed >>> 8) & 255, tb = (seed >>> 16) & 255, ta = seed >>> 24;
    const TL = FILL_TOL, clear = ta <= TL; // clear: 透明な領域（線で囲まれた内側など）を塗る
    // 判定表 m: 1 = 塗れる / 2 = 塗った。先に 1 回の線形走査で作り、探索中は配列参照だけにする
    const m = new Uint8Array(W * H);
    if (clear) m.fill(1);
    for (let y = 0; y < gh; y++) {
      for (let x = 0, i = (gy + y) * W + gx, j = y * gw; x < gw; x++, i++, j++) {
        const c = data[j];
        if (c === seed) { m[i] = 1; continue; }
        const a = c >>> 24;
        if (clear) { m[i] = a <= TL ? 1 : 0; continue; }
        const d1 = (c & 255) - tr, d2 = ((c >>> 8) & 255) - tg, d3 = ((c >>> 16) & 255) - tb, d4 = a - ta;
        m[i] = d1 <= TL && d1 >= -TL && d2 <= TL && d2 >= -TL && d3 <= TL && d3 >= -TL && d4 <= TL && d4 >= -TL ? 1 : 0;
      }
    }
    // 透明部分を塗るときは各スパンを 1px 膨張させ、背面合成で線のアンチエイリアス縁の下に潜らせる（隙間が出ない）
    const g = clear ? 1 : 0;
    const path = new Path2D();
    let fx0 = sx0, fx1 = sx0, fy0 = sy0, fy1 = sy0;
    const stack = [sx0, sy0];
    while (stack.length) {
      const y = stack.pop();
      let x = stack.pop();
      const row = y * W;
      if (m[row + x] !== 1) continue;
      while (x > 0 && m[row + x - 1] === 1) x--;
      const lx = x, ur = row - W, dr = row + W, hasUp = y > 0, hasDn = y < H - 1;
      let up = false, dn = false;
      for (; x < W && m[row + x] === 1; x++) {
        if (hasUp) { if (m[ur + x] === 1) { if (!up) { stack.push(x, y - 1); up = true; } } else up = false; }
        if (hasDn) { if (m[dr + x] === 1) { if (!dn) { stack.push(x, y + 1); dn = true; } } else dn = false; }
      }
      m.fill(2, row + lx, row + x);
      // 画素を ImageData に書いて転送する代わりに、スパンを矩形パスにして GPU で 1 回で塗る
      path.rect(lx - g, y - g, x - lx + 2 * g, 1 + 2 * g);
      if (lx < fx0) fx0 = lx;
      if (x - 1 > fx1) fx1 = x - 1;
      if (y < fy0) fy0 = y;
      if (y > fy1) fy1 = y;
    }
    const ax = max(0, fx0 - g), ay = max(0, fy0 - g), w = min(W, fx1 + 1 + g) - ax, h = min(H, fy1 + 1 + g) - ay;
    const R = rect1(ax + FX, ay + FY, w, h);
    const patch = gather(R, newCanvas(w, h));
    forTiles(R[0], R[1], w, h, true, (t, ox, oy) => {
      const c = t.x;
      c.setTransform(1, 0, 0, 1, FX - ox, FY - oy);
      c.globalCompositeOperation = clear ? 'destination-over' : 'source-over';
      c.globalAlpha = CFG.fill.alpha;
      c.fillStyle = color;
      c.fill(path); // 非ゼロ規則なので重なった矩形も 1 回分の濃さになる
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      c.setTransform(1, 0, 0, 1, 0, 0);
    });
    push(R, patch);
    lastFillMs = now() - t0;
  }

  // ---------- 文字（入力中は本物の textarea を重ねるので IME がそのまま使える。確定したら面に描き込む） ----------
  let ta = null, taX = 0, taCY = 0, mctx = null;
  // 入力欄のキーや文字はページへ渡さない（ページのショートカットやフォーカス管理が反応しないように）
  const TA_STOP = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'compositionstart', 'compositionupdate',
    'compositionend', 'paste', 'copy', 'cut', 'focusin', 'focusout'];
  function textAt(cx, cy) {
    ta = el('textarea', 'tx', { spellcheck: 'false', wrap: 'off', rows: '1', 'aria-label': '文字' });
    taX = cx; taCY = cy; // クリックした点が 1 行目の高さの中央になるように置く
    for (const t of TA_STOP) ta.addEventListener(t, stop);
    ta.addEventListener('input', fitTa);
    ta.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        commitText();
        wrap.focus({ preventScroll: true });
      }
    });
    wrap.append(ta);
    styleTa();
    ta.focus({ preventScroll: true });
  }
  function styleTa() {
    const c = CFG.text, s = ta.style;
    s.setProperty('--c', color);
    s.setProperty('--a', c.alpha);
    s.setProperty('--fs', c.size + 'px');
    s.left = taX + 'px';
    s.top = taCY - c.size * LH / 2 + 'px';
    fitTa();
  }
  // 中身に合わせて入力欄を広げる（折り返さない。改行でだけ行が増える）
  function fitTa() {
    const s = ta.style;
    s.width = s.height = '0';
    s.width = ta.scrollWidth + 2 + 'px';
    s.height = ta.scrollHeight + 'px';
  }
  // 入力欄と同じ位置・書体・色・濃さで、外接矩形の範囲のタイルへ直接描く（live を通さないので二重に見えない）
  function commitText() {
    if (!ta) return;
    const e = ta, v = e.value.replace(/\s+$/, '');
    ta = null;
    e.remove();
    if (!v || act !== -1) return;
    finishHandoff();
    mapNow();
    sizeSurface();
    const c = CFG.text, fs = c.size * dpr, lh = fs * LH, lines = v.split('\n'), f = `600 ${fs}px ${FONT}`;
    if (!mctx) mctx = newCanvas(1, 1).getContext('2d');
    mctx.font = f;
    let w = 0;
    for (const l of lines) w = max(w, mctx.measureText(l).width);
    // CSS は行の高さの中で文字（ascent + descent）を上下中央に置く。同じ基線を求める（CSS px で整数に丸めて計算）
    mctx.font = `600 ${c.size}px ${FONT}`; // レイアウトは CSS px の書体の寸法で決まる
    const m = mctx.measureText('Hg');
    const A = round(m.fontBoundingBoxAscent || c.size * 0.8), D = round(m.fontBoundingBoxDescent || c.size * 0.2);
    const tc = taCY - c.size * LH / 2, x = taX * dpr, top = tc * dpr;
    const base = (tc + floor((c.size * LH - A - D) / 2) + A) * dpr;
    const p = fs * 0.25 + 2;
    const X0 = max(0, floor((x - p) * sk + sox)), Y0 = max(0, floor((top - p) * sk + soy));
    const X1 = ceil((x + w + p) * sk + sox), Y1 = ceil((top + lines.length * lh + p) * sk + soy);
    if (X1 <= X0 || Y1 <= Y0) return;
    const R = rect1(X0, Y0, X1 - X0, Y1 - Y0);
    const atlas = gather(R, pack(R));
    forTiles(X0, Y0, X1 - X0, Y1 - Y0, true, (t, ox, oy, ix, iy, iw, ih) => {
      const g = t.x;
      g.save();
      g.beginPath();
      g.rect(ix - ox, iy - oy, iw, ih);
      g.clip();
      g.setTransform(sk, 0, 0, sk, sox - ox, soy - oy);
      g.globalAlpha = c.alpha;
      g.fillStyle = color;
      g.font = f;
      g.textBaseline = 'alphabetic';
      for (let i = 0; i < lines.length; i++) g.fillText(lines[i], x, base + i * lh);
      g.restore();
    });
    push(R, atlas);
  }

  // ---------- 書き出し ----------
  // 面のうち、画面の (x, y, w, h)（CSS px）に見えている範囲を 1 枚のキャンバスに写す
  function capture(x, y, w, h, opts) {
    const [ox, oy] = origin(), X = round(x * sdpr) + ox, Y = round(y * sdpr) + oy;
    const cw = max(1, round(w * sdpr)), ch = max(1, round(h * sdpr));
    const c = newCanvas(cw, ch), cx = c.getContext('2d', opts);
    forTiles(X, Y, cw, ch, false, (t, tox, toy, ix, iy, iw, ih) =>
      cx.drawImage(t.c, ix - tox, iy - toy, iw, ih, ix - X, iy - Y, iw, ih));
    return [c, cx];
  }
  function exportBlob() {
    commitText();
    const [c, x] = capture(0, 0, wrap.clientWidth, wrap.clientHeight);
    if (bg) {
      x.globalCompositeOperation = 'destination-over';
      x.fillStyle = BGS[bg];
      x.fillRect(0, 0, c.width, c.height);
    }
    return c.convertToBlob
      ? c.convertToBlob({ type: 'image/png' })
      : new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(Error('toBlob'))), 'image/png'));
  }
  // 画面の (x, y, w, h)（CSS px）に見えている確定済みの絵の画素
  const pixels = (x, y, w, h) => {
    const [c, cx] = capture(x, y, w, h, { willReadFrequently: true });
    return cx.getImageData(0, 0, c.width, c.height);
  };
  function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  function save() {
    exportBlob().then(b => {
      const a = el('a', null, { download: `paint-${stamp()}.png` });
      const url = URL.createObjectURL(b);
      a.href = url;
      wrap.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      say('PNG をダウンロードします');
    }, () => say('保存できませんでした'));
  }
  function copyImg() {
    try {
      navigator.clipboard.write([new ClipboardItem({ 'image/png': exportBlob() })])
        .then(() => say('クリップボードにコピーしました'), () => say('コピーできませんでした'));
    } catch (_) { say('コピーできませんでした'); }
  }
  function pickColor() {
    try { new EyeDropper().open().then(r => setColor(r.sRGBHex), () => { }); } catch (_) { }
  }

  // ---------- パフォーマンス HUD (D) ----------
  function toggleHud() {
    if (hud) { clearInterval(hudT); hud.remove(); hud = null; return; }
    hud = el('div', 'hud');
    wrap.append(hud);
    stEv = stPred = stCost = stLag = 0;
    stT = now();
    stP0 = nPts;
    hudT = setInterval(updHud, 500);
    updHud();
  }
  function updHud() {
    const t = now(), sec = (t - stT) / 1000, n = stEv || 1;
    const on = v => (v ? 'on' : 'off');
    hud.textContent =
      `入力 ${round(stEv / sec)} ev/s  点 ${((nPts - stP0) / n).toFixed(1)}/ev  予測 ${(stPred / n).toFixed(1)}/ev\n` +
      `処理 ${round(stCost / n * 1000)} µs/ev  入力→描画 ${(stLag / n).toFixed(1)} ms  塗り ${lastFillMs.toFixed(0)} ms\n` +
      `desync ${on(DESYNC)}  rawupdate ${on(HAS_RAW)}  coalesced ${on(HAS_CO)}  予測 ${nativePred ? 'native' : 'fallback'}  ink ${on(inkP)}\n` +
      `${W}×${H} @${dpr}  面 ${surfW}×${surfH} タイル ${dtiles.size}  履歴 ${hpos}/${hist.length} (${(hpix / 1e6).toFixed(1)} MP)  v${VERSION}`;
    stEv = stPred = stCost = stLag = 0;
    stT = t;
    stP0 = nPts;
  }

  // ---------- キーボード ----------
  const NON_TEXT = /^(range|color|button|checkbox|radio|submit|reset|file|image)$/;
  function isEditable(e) {
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    if (!t || t.nodeType !== 1) return false;
    if (t.isContentEditable) return true;
    const n = t.nodeName;
    return n === 'TEXTAREA' || n === 'SELECT' || (n === 'INPUT' && !NON_TEXT.test(t.type));
  }
  function onKey(e) {
    if (e.isComposing || isEditable(e)) return;
    let k = e.key || '';
    // かな入力や非ラテン配列でもショートカットが効くよう、物理キーにフォールバック
    if (/^Key[A-Z]$/.test(e.code) && !/^[a-z]$/i.test(k)) k = e.code[3];
    if (k.length === 1) k = k.toLowerCase();
    let ok = true;
    if (e.ctrlKey || e.metaKey) {
      if (k === 'z') e.shiftKey ? redo() : undo();
      else if (k === 'y') redo();
      else if (k === 's') save();
      else ok = false;
    } else if (e.altKey) ok = false;
    else if (KEYMAP[k]) setTool(KEYMAP[k]);
    else if (k >= '1' && k <= '8' && k.length === 1) setColor(PALETTE[k - 1]);
    else if (k === '[') setSize(round(CFG[tool].size / 1.2));
    else if (k === ']') setSize(max(CFG[tool].size + 1, round(CFG[tool].size * 1.2)));
    else if (k === 'v') togglePass();
    else if (k === 'b') cycleBg();
    else if (k === 'd') toggleHud();
    else if (k === 'i' && HAS_ED) pickColor();
    else if (k === 'Delete') clearAll();
    else if (k === 'Escape') openP ? closePanel() : hide();
    else ok = false;
    if (ok) { e.preventDefault(); e.stopPropagation(); }
  }

  // ---------- イベント登録 ----------
  pad.addEventListener('pointerdown', onDown);
  pad.addEventListener('pointermove', onMove);
  pad.addEventListener('pointerup', onUp);
  pad.addEventListener('pointercancel', onLost);
  pad.addEventListener('lostpointercapture', onLost);
  pad.addEventListener('contextmenu', e => e.preventDefault());
  // ページ側のリスナー（解析スクリプトやドラッグ処理など）に入力を渡さず、メインスレッドの負荷を減らす
  const stop = e => e.stopPropagation();
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerover', 'pointerout',
    'mousedown', 'mousemove', 'mouseup', 'mouseover', 'mouseout', 'click', 'dblclick', 'auxclick', 'contextmenu',
    'touchstart', 'touchmove', 'touchend', 'touchcancel', 'selectstart', 'dragstart']) {
    wrap.addEventListener(t, stop, { passive: true });
  }
  const listen = on => {
    const f = on ? 'addEventListener' : 'removeEventListener';
    win[f]('keydown', onKey, true);
    win[f]('resize', onResize);
  };

  // ---------- 表示制御 ----------
  function topLayer() {
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch (_) { }
  }
  function show() {
    if (byeT) { reopen(); return; }
    if (visible) return;
    visible = true;
    hs.setProperty('display', 'block', 'important');
    surf.style.setProperty('display', 'block', 'important');
    topLayer();
    listen(true);
    fit();
    wrap.focus({ preventScroll: true });
  }
  function hide() {
    if (!visible) return;
    if (act !== -1) endStroke();
    commitText();
    closePanel();
    visible = false;
    listen(false);
    try { if (host.matches(':popover-open')) host.hidePopover(); } catch (_) { }
    hs.setProperty('display', 'none', 'important');
    surf.style.setProperty('display', 'none', 'important');
    if (doc.activeElement === host) wrap.blur();
  }
  function toggle() { visible ? hide() : show(); }
  // 閉じる（×）: 描いた物があれば、BYE_MS の間はお知らせのボタン・Ctrl/⌘+Z・ブックマークレットで取り消せる。
  // その間は hide と同じく絵も入力のリスナーも外し、お知らせだけを残す（ページの操作を邪魔しない）
  let byeT = 0;
  function close() {
    if (byeT) return;
    if (!hist.length) { destroy(); return; }
    hide();
    wrap.classList.add('bye');
    hs.setProperty('display', 'block', 'important');
    topLayer();
    win.addEventListener('keydown', onByeKey, true);
    byeT = setTimeout(destroy, BYE_MS);
    say('絵を消して閉じました', BYE_MS, '元に戻す', reopen);
  }
  function endBye() {
    clearTimeout(byeT);
    byeT = 0;
    win.removeEventListener('keydown', onByeKey, true);
    wrap.classList.remove('bye');
  }
  function reopen() {
    if (!byeT) return;
    endBye();
    unsay();
    show();
  }
  function onByeKey(e) {
    if (e.isComposing || isEditable(e) || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    if ((e.key || '').toLowerCase() === 'z' || e.code === 'KeyZ') {
      e.preventDefault();
      e.stopPropagation();
      reopen();
    }
  }
  function destroy() {
    if (byeT) endBye();
    hide();
    if (hud) toggleHud();
    clearTimeout(toastT);
    toastFn = null;
    finishHandoff();
    while (hist.length) free(hist.pop());
    for (const c of [liveC, predC]) c.width = c.height = 0;
    for (const t of dtiles.values()) t.c.width = t.c.height = 0;
    dtiles.clear();
    for (const t of pool) t.c.width = t.c.height = 0;
    pool.length = 0;
    host.remove();
    surf.remove();
    delete win[NS];
  }

  // ---------- 起動 ----------
  const stats = () => ({
    width: W, height: H, dpr, surface: [surfW, surfH], tiles: dtiles.size, history: hist.length, historyPixels: hpix, events: nEv, points: nPts,
    desynchronized: DESYNC, rawupdate: HAS_RAW, coalesced: HAS_CO, nativePrediction: nativePred, inkTrail: !!inkP,
  });
  win[NS] = { version: VERSION, toggle, show, hide, close, destroy, undo, redo, clear: clearAll, tool: setTool, color: setColor, stats, pixels };
  setColor(color);
  syncTool(false);
  syncHist();
  syncBg();
  doc.documentElement.append(surf, host);
  show();
  measureBar();
  moveBar((vw - barW) / 2, 10);
  say('Esc で隠す ・ V でページ操作 ・ D で計測表示');
})();
