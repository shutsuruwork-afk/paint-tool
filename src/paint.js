/*!
 * Paint Bookmarklet — どんなページの上にも描ける低遅延ペイントツール
 * https://github.com/shutsuruwork-afk/paint-tool (MIT License)
 */
(() => {
  'use strict';

  const NS = '__paintBookmarklet';
  const VERSION = '1.31.1';
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
  const PRED_TTL = 40;  // 入力が途絶えてから予測線を消すまでの時間 (ms)。入力が遅れて届いているときは、その遅れ（dl）を足す
  // 自前の予測（T-060）: 当てはめる直近の時間（ms）、長さの上限（CSS px）、急に曲がるほど短くする強さ。録った人の線で比べて決めた
  const PW = 32, PCAP = 40, PDAMP = 2;
  const FILL_TOL = 48;  // 塗りつぶしの色許容差 (0-255)
  const BYE_MS = 8000;  // 閉じる（×）を取り消せる時間 (ms)
  const PAGE = 'https://shutsuruwork-afk.github.io/paint-tool/'; // インストールページ
  const HINT_MS = 4000; // 隠したときに「ブックマークレットで再表示」を出す時間 (ms)

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
    select: { size: 0, alpha: 1 },
  };
  // インストールページで選んだ既定。ブックマークレットを作るときに、下の文字列を JSON の文字列に置き換える
  let DEF = null;
  try { DEF = JSON.parse('__PAINT_DEFAULTS__'); } catch (_) { }
  if (!DEF || typeof DEF !== 'object') DEF = {};
  // 文字に触れる: ペンなどを選んでいても、文字の上を押すと選んで動かし、もう一度押すと書き直せる
  const TOUCH = { pen: 1, marker: 1, line: 1, arrow: 1, rect: 1, ellipse: 1, fill: 1 };
  // ペンの種類。ペンを選んだ状態でペンのボタンをもう一度押すと選べる（あまり使わないので、普段の操作は増やさない）
  const PENS = ['pen', 'fountain', 'brush', 'pencil'];
  const PEN_TITLES = {
    pen: 'ペン (P)',
    fountain: '万年筆 (P) — 線の向きで太さが変わる',
    brush: '筆 (P) — ゆっくりだと太く、速いと細い',
    pencil: '鉛筆 (P) — 少しかすれる',
  };
  const NIB_C = Math.SQRT1_2, NIB_S = -Math.SQRT1_2; // 万年筆のペン先の向き（−45°。右上がりが細く、右下がりが太い）
  const KEYMAP = { p: 'pen', h: 'marker', e: 'eraser', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', f: 'fill', t: 'text', s: 'select' };
  // 文字の書体。入力欄（CSS）と確定時の fillText で同じものを使う
  const FONT = 'system-ui,-apple-system,"Segoe UI","Hiragino Sans","Yu Gothic UI",sans-serif';
  const LH = 1.25; // 文字の行の高さ（文字の大きさに対する比）
  const TA_PAD = 10; // 文字の入力欄の周りの、見えない押せる余白（CSS px）。少し外れた所を押しても入力が続く

  const I = {
    pen: 'M4 20l1.2-4.4L16 4.8a2 2 0 0 1 2.9 0l.3.3a2 2 0 0 1 0 2.9L8.4 18.8zM14 7l3 3',
    swap: 'M4 8h15l-4-4M20 16H5l4 4', // 表示の版の切り替え（T-088）
    marker: 'M9.5 10.5L4 16v4h4l5.5-5.5M9.5 10.5l6-6 4 4-6 6zM14 20h6',
    eraser: 'M8 20h12M4.7 14.7l9-9a2 2 0 0 1 2.8 0l2.3 2.3a2 2 0 0 1 0 2.8L11 18.6H8.6zM9 10.3l5 5',
    line: 'M5 19L19 5',
    arrow: 'M5 19L19 5M10 5h9v9',
    rect: 'M4 6h16v12H4z',
    ellipse: 'M3 12a9 6.5 0 1 0 18 0a9 6.5 0 1 0-18 0',
    fill: 'M5 12l7-7 7 7-7 7zM5 12h14M21 18.5a1.5 1.5 0 0 1-3 0c0-1.2 1.5-3 1.5-3s1.5 1.8 1.5 3z',
    text: 'M5 7V5h14v2M12 5v14M9 19h6',
    select: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3',
    drop: 'M13 6l5 5M15.5 3.5a2.1 2.1 0 0 1 3 0l2 2a2.1 2.1 0 0 1 0 3L18 11M15 8l-9 9v3h3l9-9',
    undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
    redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    bg: 'M4 4h16v12H4zM12 16v4M8 20h8',
    pass: 'M6 3l12 11h-6l3.5 7-2.5 1-3.5-7L6 19z',
    save: 'M12 4v11M7 10l5 5 5-5M5 20h14',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    hide: 'M5 12h14',
    pin: 'M9 4h6M10 4v6l-3 4h10l-3-4V4M12 14v6',
    prefs: 'M4 7h9M17 7h3M15 5v4M4 17h3M11 17h9M9 15v4',
    calc: 'M6 3h12v18H6zM9 7h6M9 11.5h.01M12 11.5h.01M15 11.5h.01M9 15h.01M12 15h.01M15 15h.01M9 18.5h.01M12 18.5h.01M15 18.5h.01',
    fountain: 'M12 2.5l5.5 8L12 21.5l-5.5-11zM12 10.5v5M12 15.5a.6.6 0 1 0 0 .01',
    brush: 'M19.5 3.5l1 1-8 9.5-2.5-2.5zM10 11.5c-2.6-.4-5 1.4-5 4.3 0 2-1 3.3-2.5 4.2 4.6.6 9.7-.9 9.9-5.6',
    pencil: 'M4 20l1.3-4.6L15.5 5.2a2 2 0 0 1 2.8 0l.5.5a2 2 0 0 1 0 2.8L8.6 18.7zM13.5 7.2l3.3 3.3M5.3 15.4l3.3 3.3',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    close: 'M6 6l12 12M18 6L6 18',
    rec: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4',
  };

  // ガラスのガウス方式: ぼかしの元を周りへ --gm だけ広げて拾い、見せるのはバーの角丸の形だけ（mask で切る）。
  // 外側の要素で切り抜く（overflow・clip-path）と元の範囲が狭まってぼけが弱くなるので、角丸も mask の中で作る
  // 地は縁（border の 1px）の下まで敷き、縁の線は outline で地の上に描く（T-102）。地が縁の内側だけだと、縁から下のページが透け、
  // 暗い見た目を白いページに置くと白い枠に見えた。縁の線は、暗いページで暗いバーの輪郭を見せるためのもの
  const GQ = (at, pos) => `radial-gradient(circle at ${at},#000 calc(var(--gr) - .5px),#0000 var(--gr)) ${pos}/var(--gr) var(--gr) no-repeat content-box`;
  const GMASK = [GQ('100% 100%', '0 0'), GQ('0 100%', '100% 0'), GQ('100% 0', '0 100%'), GQ('0 0', '100% 100%'),
    'linear-gradient(#000 0 0) 50% 50%/calc(100% - 2 * var(--gr)) 100% no-repeat content-box',
    'linear-gradient(#000 0 0) 50% 50%/100% calc(100% - 2 * var(--gr)) no-repeat content-box'].join(',');
  const CSS = `
.w{--gc:28 30 36;--gt:.8;--gb:18px;--gm:36px;--gs:2;all:initial;position:absolute;inset:0;overflow:hidden;contain:strict;pointer-events:none;outline:none;font:12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e8e9ee;color-scheme:dark;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
.s{position:absolute;inset:0}.s.bg1{background:#fff}.s.bg2{background:#1d1f23}
.sel{position:absolute;z-index:2;pointer-events:none}
.sel b{position:absolute;outline:1px solid #3d7cff}
.sel.only i:nth-of-type(2n){display:none}
.si{position:absolute;left:0;top:0;transform-origin:0 0}
.gh{position:absolute;white-space:pre;pointer-events:none;color:var(--c);opacity:calc(var(--a) * .45);font:600 var(--fs)/${LH} ${FONT}}
.to{position:absolute;z-index:1;white-space:pre;pointer-events:none;color:var(--c);opacity:var(--a);font:600 var(--fs)/${LH} ${FONT}}
.to.gone{opacity:calc(var(--a) * .25)}.to.ed{visibility:hidden}
.sel i{position:absolute;width:9px;height:9px;margin:-5px 0 0 -5px;box-sizing:border-box;background:#fff;border:1.5px solid #3d7cff;border-radius:2px}
canvas{position:absolute;left:0;top:0;pointer-events:none}
.g,.p{position:absolute;inset:0}
.p{pointer-events:auto;touch-action:none;cursor:crosshair}
.pass .p{pointer-events:none}
.bar{position:absolute;left:0;top:0;cursor:grab;display:flex;flex-wrap:wrap;align-items:center;gap:2px;padding:4px;max-width:calc(100% - 16px);box-sizing:border-box;background:var(--bb,#202228);border:1px solid #ffffff1f;border-radius:12px;box-shadow:0 6px 24px #0007;pointer-events:auto;touch-action:none;will-change:transform}
.b{all:unset;box-sizing:border-box;flex:none;width:30px;height:30px;display:grid;place-items:center;border-radius:8px;cursor:pointer;color:inherit}
.bar.drag,.bar.drag *{cursor:grabbing}
.b:hover{background:#ffffff1a}.b:active{background:#ffffff2e}
.b.on{background:#3d7cff;color:#fff}
.b.sg{width:auto;padding:0 9px;font:inherit}
.b:disabled{opacity:.3;cursor:default;background:none}
.b:focus-visible{outline:2px solid #3d7cff;outline-offset:-2px}
.b.open:not(.on){background:#ffffff2e}
.dd{position:relative}.dd::after{content:"";position:absolute;right:3px;bottom:3px;border:2.5px solid transparent;border-right-color:currentColor;border-bottom-color:currentColor;opacity:.55}
.dot{width:var(--d);height:var(--d);border-radius:50%;background:var(--c);opacity:var(--a);box-shadow:0 0 0 1px #ffffff59}
.dot.er{background:none;opacity:1;box-shadow:inset 0 0 0 1.5px #e8e9ee}
.glass .bar,.glass .pn{background:none;border-color:transparent;outline:1px solid #ffffff24;outline-offset:-1px;box-shadow:0 6px 24px #0007,inset 0 1px 0 #ffffff1c}.glass .pn{isolation:isolate}
.glass .bar::before,.glass .pn::before{content:"";position:absolute;inset:-1px;z-index:-1;border-radius:inherit;background:rgb(var(--gc) / var(--gt));-webkit-backdrop-filter:blur(var(--gb)) saturate(var(--gs));backdrop-filter:blur(var(--gb)) saturate(var(--gs));pointer-events:none}
.gauss .bar::before{--gr:12px}.gauss .pn::before{--gr:10px}
.gauss .bar::before,.gauss .pn::before{inset:calc(var(--gm) * -1 - 1px);padding:var(--gm);border-radius:0;-webkit-mask:${GMASK};mask:${GMASK}}
.light{color:#1d2026;color-scheme:light;--gc:250 250 252}
.light .bar,.light .pn,.light .t,.light .hp{background:var(--bb,#fbfbfc);border-color:#0000001a;box-shadow:0 6px 24px #0003}
.light.glass .bar,.light.glass .pn{background:none;border-color:transparent;outline-color:#0000001a;box-shadow:0 6px 24px #0003,inset 0 1px 0 #ffffff99}
.light .b:hover,.light .t button:hover{background:#0000000f}.light .b:active,.light .b.open:not(.on){background:#0000001c}
.b.on:not(.c):hover,.light .b.on:not(.c):hover,.light .b.on:not(.c):active{background:#2f6bea}
.b.on.pc,.b.on.pc:hover,.light .b.on.pc:hover,.light .b.on.pc:active{background:var(--pc);color:var(--pi);box-shadow:0 1px 3px #0000003d}
.light .dot{box-shadow:0 0 0 1px #0000003a}.light .dot.er{box-shadow:inset 0 0 0 1.5px #1d2026}
.light .mi kbd{color:#7b7f89}.light .mi .sw{background:#00000024}
.light .c::before{box-shadow:inset 0 0 0 1px #00000026}.light .c.on::before{box-shadow:0 0 0 2px var(--bb,#fbfbfc),0 0 0 4px #1d2026}
.light .sep{background:#0000001f}.light .r{color:#5c606b}.light .r output{color:#1d2026}
.light .t button{color:#2f6bff}.light .t.act .tc{color:#5c606b}.light.bye .t::after{background:#2f6bff}
.light .hp .hh{color:#5c606b}.light .hp h3{color:#000}.light .hp .hg>:nth-child(odd){color:#3a3e47}.light .hp kbd{border-color:#00000033;color:#1d2026}
.pn{position:absolute;left:0;top:calc(100% + 6px);display:none;flex-direction:column;gap:2px;padding:4px;background:var(--bb,#202228);border:1px solid #ffffff1f;border-radius:10px;box-shadow:0 6px 24px #0007;pointer-events:auto}
.pn.on{display:flex}.up .pn{top:auto;bottom:calc(100% + 6px)}
.row{display:flex;align-items:center;gap:2px}
.b.mi{width:auto;display:flex;justify-content:flex-start;gap:10px;padding:0 10px 0 6px;white-space:nowrap}
.mi kbd{margin-left:auto;padding-left:20px;color:#7d808a;font:inherit}
.mi .sw{position:relative;flex:none;margin-left:auto;width:30px;height:18px;border-radius:9px;background:#ffffff38;transition:background .15s}
.mi .sw::after{content:"";position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #0006;transition:transform .15s}
.mi[aria-checked=true] .sw{background:#3d7cff}.mi[aria-checked=true] .sw::after{transform:translateX(12px)}
svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
[aria-label^="その他"] svg{stroke-width:3}
.c{width:24px}
.c::before{content:"";width:18px;height:18px;border-radius:50%;background:var(--c);box-shadow:inset 0 0 0 1px #ffffff59}
.c.on{background:none}
.c.on::before{box-shadow:0 0 0 2px var(--bb,#202228),0 0 0 4px #fff}
.cc::before{background:conic-gradient(#f44,#fd4,#4d4,#4dd,#44f,#d4d,#f44)}
.sep{flex:none;width:1px;height:22px;margin:0 3px;background:#ffffff24}
.bar.two .brk{flex-basis:100%;width:auto;height:0;margin:0;background:none}
.r{display:flex;align-items:center;gap:8px;height:30px;padding:0 6px;color:#a9acb8}
.r input{flex:1;width:auto;min-width:0;margin:0;accent-color:#3d7cff}
.r output{min-width:30px;color:#e8e9ee;font-variant-numeric:tabular-nums}
.r.dis{opacity:.3;pointer-events:none}
.ci{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;border:0;padding:0}
.t{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);padding:8px 14px;border-radius:8px;background:var(--bb,#202228);box-shadow:0 4px 16px #0007;opacity:0;transition:opacity .2s;pointer-events:none;white-space:nowrap}
.t.on{opacity:1}
.t button{all:unset;display:none;margin:-4px -8px -4px 10px;padding:4px 8px;border-radius:6px;color:#8fb3ff;font-weight:600;cursor:pointer}
.t button:hover{background:#ffffff1a}.t button:focus-visible{outline:2px solid #3d7cff}
.t.act{pointer-events:auto}.t.act button{display:inline-block}
.t.act .tc{display:none;margin:-4px -10px -4px 2px;padding:4px 6px;color:#a9acb8;vertical-align:middle}.t.act.cx .tc{display:inline-grid;place-items:center}
.t .tc svg{width:14px;height:14px}
.t.in button{margin-left:-2px;padding-left:2px}
.bye .t::after{content:"";position:absolute;left:10px;right:10px;bottom:3px;height:2px;border-radius:1px;background:#8fb3ff;transform-origin:left;animation:bye ${BYE_MS}ms linear forwards}
@keyframes bye{to{transform:scaleX(0)}}
.bye>:not(.t),.hint>:not(.t){display:none}
.tx{all:unset;position:absolute;box-sizing:content-box;padding:${TA_PAD}px;white-space:pre;overflow:hidden;resize:none;pointer-events:auto;cursor:text;color:var(--c);opacity:var(--a);caret-color:var(--c);font:600 var(--fs)/${LH} ${FONT};outline:1px dashed #3d7cffb0;outline-offset:${5 - TA_PAD}px;-webkit-user-select:text;user-select:text}
.hp{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);box-sizing:border-box;width:min(680px,calc(100% - 32px));max-height:calc(100% - 32px);overflow:auto;padding:12px 18px 6px;background:var(--bb,#202228);border:1px solid #ffffff1f;border-radius:12px;box-shadow:0 6px 24px #0007;pointer-events:auto;font-size:12.5px;line-height:1.5;-webkit-user-select:text;user-select:text}
.hp .hh{margin-bottom:8px;color:#a9acb8}.hp .hc{columns:2 270px;column-gap:28px}
.hp section{break-inside:avoid;padding-bottom:10px}
.hp h3{all:unset;display:block;margin-bottom:3px;font-weight:600;color:#fff}
.hp .hg{display:grid;grid-template-columns:max-content 1fr;gap:3px 12px}
.hp .hg>:nth-child(odd){color:#c5c8d2;white-space:nowrap}
.hp kbd{display:inline-block;box-sizing:border-box;min-width:1.6em;margin:0 1px;padding:0 4px;border:1px solid #ffffff38;border-bottom-width:2px;border-radius:4px;text-align:center;font:600 11px/1.45 ui-monospace,Menlo,Consolas,monospace;color:#e8e9ee}
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
  // live と pred をまとめる。blend が 'group' のときは、まとめて不透明度をかける（重なり部分が二重に濃くならない）
  const grp = el('div', 'g');
  grp.append(liveC, predC);
  const pad = el('div', 'p');
  const bar = el('div', 'bar', { role: 'toolbar', 'aria-label': 'Paint' });
  const toast = el('div', 't', { role: 'status' });
  const toastM = el('span'), toastB = el('button', '', { type: 'button' });
  const toastX = el('button', 'tc', { type: 'button', title: '今すぐ閉じる', 'aria-label': '今すぐ閉じる' });
  toast.append(toastM, toastB, toastX);
  wrap.append(grp, pad, bar, toast);
  shadow.append(wrap);

  // ---------- 状態 ----------
  let tool = 'pen', color = PALETTE[2], bg = 0, pass = false, visible = false, touchText = DEF.touchText !== false, penType = 'pen', calc = false;
  // 種類のあるボタン（ペン・図形）: 既定は「選んでいないときに押すとその道具、もう一度押すと選択肢」。pickOnce なら 1 回で選択肢も出す
  const pickOnce = DEF.pickOnce === true;
  // ツールバーを引いて動かしても閉じないパネル: 色と太さ・見た目（開発用）はいつも。keepPanels（インストールページ）ならすべて（T-066・T-068）
  const keepPanels = DEF.keepPanels === true;
  // 表示の版（T-088）: 本家と CP2（シンプル版のチェックポイント 2。research/simple-cp2 から移した。お試し〈Preview〉。画面では「Simple Preview」と呼ぶ。T-090・T-101）。切り替えても絵と履歴はそのままで、
  // ツールバーに出す物といくつかの動きだけが変わる（layout）。CP2 は、バーにペン（押すたびに消しゴムと入れ替わる）・文字・元に戻す・その他（全消去・色）・
  // 閉じる（× の見た目で、中身は隠す）だけ。押せるボタンのないお知らせは出さず、電卓はいつも入り、ページ操作モードはない（2 本指のスクロールは本家にも入れた。T-104）。
  // ほかの道具はキーで使える。本家のその他からいつでも CP2 を試せる（T-101 で開発用だけでなくした。CP2 のその他からは、いつでも本家に戻せる）。
  // 最初の版はインストールページ（DEF.ui）で選び、切り替えるとサイトごとに覚える
  const UIS = ['main', 'cp2'], CP2_TOOLS = ['pen', 'eraser', 'text'];
  let cp2 = false;
  // Simple のペンはいつも太さ 5・濃さ 100%・普通のペン（T-091・T-093・T-097。本家の設定には影響されない）。Simple の間は本家の [太さ, 濃さ, 種類] を mainPen に預かる（null = 預かっていない）。
  // Simple の中でキー（[ ]）で変えた太さは覚えない。サイトに覚えるのは本家の値だけ（snapPrefs）
  const SIMPLE_PEN = 5;
  let mainPen = null;
  function swapPen(on) {
    if (on && !mainPen) { mainPen = [CFG.pen.size, CFG.pen.alpha, penType]; CFG.pen.size = SIMPLE_PEN; CFG.pen.alpha = 1; penType = 'pen'; }
    else if (!on && mainPen) { [CFG.pen.size, CFG.pen.alpha, penType] = mainPen; mainPen = null; }
  }
  // 見た目（インストールページの設定）: 明るい（白に黒）と、ガラス風（半透明にして下をぼかす）。既定は白いガラス（T-050、ユーザーが決めた）。
  // ガラスの調整は開発用: ぼかし方（gauss は周りも拾う本物のガウス、plain は backdrop-filter そのまま）・強さ・地の濃さ
  // theme は 'dark'・'light'・'#rrggbb'（好きな色。明るさで文字を黒か白にする）。開発用の見た目のパネル（dev）からも変えられる
  const look = {
    theme: DEF.theme === 'dark' || /^#[0-9a-f]{6}$/i.test(DEF.theme) ? DEF.theme.toLowerCase() : 'light',
    glass: DEF.glass !== false,
    blurMode: DEF.blurMode === 'plain' ? 'plain' : 'gauss',
    blur: +DEF.blur >= 0 && +DEF.blur <= 40 ? +DEF.blur : 18,
    tint: +DEF.tint >= 30 && +DEF.tint <= 95 ? +DEF.tint : 80,
    sat: +DEF.sat >= 100 && +DEF.sat <= 300 ? +DEF.sat : 200, // ガラスの彩度（%。T-065）
  };
  const dev = DEF.dev === true;
  // 蛍光ペンの予測: 'full'（既定）はペンと同じ。'need' は丸い先端で届かない分だけ（1 フレーム後のペン先まで）、曲がりに沿って予測し、
  // 点と点を直線でつなぐ（T-055）。'off' は描かない。ぴょこぴょこの主な原因は半透明の描き方だったので（T-056）、既定はペンと同じに戻した（T-059）。開発用のパネルでも切り替えられる
  // ペンの予測の方法（T-060）: 'own'（既定）は入力ごとに自前で求める（ownPred）。'chrome' は前の方式（pointermove の getPredictedEvents）。開発用で見比べられる
  const PPREDS = ['own', 'chrome'];
  let ppred = PPREDS.includes(DEF.ppred) ? DEF.ppred : 'own';
  const MPREDS = ['need', 'off', 'full'];
  let mpred = MPREDS.includes(DEF.mpred) ? DEF.mpred : 'full';
  // 半透明の線の描き方（T-056）: 'canvas' は線の濃さを live の canvas の中で付ける（まとめた要素の opacity は 1 のまま。不透明の線と同じ経路）。
  // 'group' は前の方式（不透明に描き、live と pred をまとめた要素に CSS の opacity）。半透明のときだけ先端がぴょこぴょこ見えていた（ユーザーが実機で確かめた）
  const BLENDS = ['canvas', 'group'];
  let blend = BLENDS.includes(DEF.blend) ? DEF.blend : 'canvas';
  // 相対輝度が 0.3 を超える（明るい）色か。上に載せる文字や印を黒にする
  function isLite(hex) {
    const n = parseInt(hex.slice(1), 16);
    const L = [n >> 16, n >> 8 & 255, n & 255].map(v => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * L[0] + 0.7152 * L[1] + 0.0722 * L[2] > 0.3;
  }
  function applyLook() {
    const t = look.theme, ws = wrap.style, cl = wrap.classList;
    let lite = t === 'light';
    if (t[0] === '#') {
      // 好きな色: 地と、ガラスの地に使う。文字は相対輝度で黒か白にする
      const n = parseInt(t.slice(1), 16);
      lite = isLite(t);
      ws.setProperty('--bb', t);
      ws.setProperty('--gc', [n >> 16, n >> 8 & 255, n & 255].join(' '));
    } else { ws.removeProperty('--bb'); ws.removeProperty('--gc'); }
    cl.toggle('light', lite);
    cl.toggle('glass', look.glass);
    cl.toggle('gauss', look.glass && look.blurMode === 'gauss');
    ws.setProperty('--gb', look.blur + 'px');
    ws.setProperty('--gm', look.blur * 2 + 'px');
    ws.setProperty('--gt', look.tint / 100);
    ws.setProperty('--gs', look.sat / 100);
  }
  applyLook();
  let dpr = win.devicePixelRatio || 1, W = 0, H = 0, grpA = 1, pendingFit = false, rz = 0, warmT = 0;
  let rg = null, rbx = null, rn = 0; // 半透明の線の、描いた部分の形（addPiece）
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
  // 画面に固定（fixed）の間は、面を入れたときのスクロール位置（fx, fy）で止めて position: fixed にする
  let fixed = false, fx = 0, fy = 0;
  // 画面の左上が S のどこに当たるか
  const origin = () => {
    const x = fixed ? fx : win.scrollX, y = fixed ? fy : win.scrollY;
    return [round((x - hdx) * sdpr), round((y - hdy) * sdpr)];
  };
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
    if (fixed) {
      // 固定の間は文書の原点からのずれを測れない（測らなくても変わらない）。見えている範囲が面からはみ出さないようにだけする
      surfW = max(surfW, ceil(fx - hdx + win.innerWidth));
      surfH = max(surfH, ceil(fy - hdy + win.innerHeight));
    } else {
      const r = surf.getBoundingClientRect();
      hdx = r.left + win.scrollX;
      hdy = r.top + win.scrollY;
    }
    pin(surf, [['width', surfW + 'px'], ['height', surfH + 'px']]);
  }

  // ---------- ツールバー ----------

  // よく使う物だけをバーに並べ、残りはボタンの下に開くパネル（.pn）に入れる。
  // パネルはバーの子なのでバーと一緒に動き、absolute なのでバーの幅には入らない。
  // ボタンは版（本家・CP2）に関係なく全部作り、バーに並べるのは layout()（T-088）
  const TITLES = {
    select: '選択 (S) — 囲むかクリックで選び、ドラッグで移動・角で拡大縮小',
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
  toolBtns.select = btn(TITLES.select, I.select, () => setTool('select'));
  // ペン: ペンでないときに押すとペンになる。ペンのときにもう一度押すと、種類のパネルが開く（pickOnce なら 1 回目から開く）。
  // ページ操作モードのときは、ペンのままでも押せば描画に戻り、パネルも普段と同じに開く（T-057・T-062）。
  // CP2 では、押すたびにペンと消しゴムが入れ替わる（印と名前も今の道具に変わる。markPen）。種類のパネルは出さない
  const penP = pnl();
  const penB = btn(TITLES.pen, I.pen, () => {
    if (cp2) setTool(tool === 'pen' ? 'eraser' : 'pen');
    else if (tool === 'pen') { if (pass) setTool('pen'); togglePanel(penP, penB); }
    else { setTool('pen'); if (pickOnce) openPanel(penP, penB); }
  }, 'dd');
  const penD = penB.querySelector('path');
  toolBtns.pen = penB;
  const penBtns = {};
  penP.append(row(...PENS.map(k => penBtns[k] = btn(PEN_TITLES[k], I[k === 'pen' ? 'pen' : k], () => { setPen(k); closePanel(); }))));
  for (const t of ['marker', 'eraser']) toolBtns[t] = btn(TITLES[t], I[t], () => setTool(t));
  // 図形: 最後に使った図形を表示する。押すとその図形になり、図形のときにもう一度押すと 4 つの図形のパネルが開く（ペンと同じ）
  let lastShape = 'line';
  const shapeP = pnl();
  const shapeB = btn(TITLES.line, I.line, () => {
    if (SHAPES.includes(tool)) { if (pass) setTool(tool); togglePanel(shapeP, shapeB); }
    else { setTool(lastShape); if (pickOnce) openPanel(shapeP, shapeB); }
  }, 'dd shp');
  const shapeD = shapeB.querySelector('path');
  shapeP.append(row(...SHAPES.map(t => toolBtns[t] = btn(TITLES[t], I[t], () => { setTool(t); closePanel(); }))));
  toolBtns.text = btn(TITLES.text, I.text, () => setTool('text'));
  toolBtns.fill = btn(TITLES.fill, I.fill, () => setTool('fill'));

  // 色と太さ: 今の色・太さ・濃さを点で見せる。パネルにパレット・カスタム色・スポイト・太さ・濃さ
  const styleP = pnl();
  const styleB = btn('色・太さ・濃さ', null, () => togglePanel(styleP, styleB), 'dd');
  const dot = el('span', 'dot');
  styleB.append(dot);
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

  const range = (label, title, lo, hi, fn, p = styleP) => {
    const w = el('label', 'r', { title });
    const s = el('span');
    s.textContent = label;
    const r = el('input', null, { type: 'range', min: lo, max: hi, step: 1 });
    const o = el('output');
    r.addEventListener('input', () => fn(+r.value));
    w.append(s, r, o);
    p.append(w);
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
  const MORE_T = ['その他（全消去・背景・保存・コピー・電卓・画面に固定・デフォルトの変更）', 'その他（全消去・色・本家に戻す）'];
  const moreB = btn(MORE_T[0], I.more, () => togglePanel(moreP, moreB));
  // sw なら入り・切りのスイッチ（role="switch"。状態は aria-checked で持ち、つまみは CSS で動かす）
  const item = (title, label, key, d, fn, keep, sw) => {
    const b = btn(title, d, () => { if (!keep) closePanel(); fn(); }, 'mi');
    const s = el('span');
    s.textContent = label;
    b.append(s);
    if (key) { const k = el('kbd'); k.textContent = key; b.append(k); }
    if (sw) { b.setAttribute('role', 'switch'); b.append(el('i', 'sw')); }
    moreP.append(b);
    return [b, s];
  };
  const [clrMi] = item('全消去 (Delete)', '全消去', 'Delete', I.trash, clearAll);
  const [bgB, bgL] = item('', '', 'B', I.bg, cycleBg, true);
  item('PNG で保存 (Ctrl/⌘+S)', 'PNG で保存', IS_MAC ? '⌘S' : 'Ctrl+S', I.save, save);
  if (HAS_CLIP) item('画像をクリップボードにコピー', 'クリップボードにコピー', '', I.copy, copyImg);
  const [calcB] = item('電卓 — 文字に計算式を書くと答えが薄く出て、Tab で書き込める', '電卓', '', I.calc, () => {
    calc = !calc;
    syncCalc();
    updateGhost();
    remember();
    say(calc ? '電卓: 文字に計算式を書くと答えが出ます（Tab で書き込み）' : '電卓: 切');
  }, true, true);
  const [fixB] = item('画面に固定 — スクロールしても絵が画面の同じ所に留まる（動画や地図の上に描くとき）', '画面に固定', '', I.pin, toggleFixed, true, true);
  // デフォルトの変更: インストールページの設定を新しいタブで開く。今のブックマークの既定（DEF）を渡して、フォームに読み込ませる。
  // 設定はこのページに集め、メニューの項目は増やさない
  const openDefaults = d => win.open(PAGE + '#defaults=' + encodeURIComponent(JSON.stringify(d)), '_blank', 'noopener');
  item('デフォルトの変更 — インストールページで、起動したときの色・太さ・動きを選ぶ（新しいタブ）', 'デフォルトの変更', '', I.prefs, () => openDefaults(DEF));
  // 見た目（開発用。インストールページの「開発用」を入れたときだけメニューに出す）: ツールバーの色とガラスをその場で変える。
  // 気に入ったら、その見た目を持ってインストールページを開き、デフォルトにできる
  const lookP = pnl();
  const lookSw = (title, label, fn) => {
    const b = btn(title, null, fn, 'mi');
    const s = el('span');
    s.textContent = label;
    b.setAttribute('role', 'switch');
    b.append(s, el('i', 'sw'));
    return b;
  };
  const setLook = (k, v) => { look[k] = v; applyLook(); syncLook(); };
  const lci = el('input', 'ci', { type: 'color', tabindex: '-1', 'aria-hidden': 'true' });
  lci.addEventListener('input', () => setLook('theme', lci.value));
  const themeBs = [['dark', '#202228', '暗い'], ['light', '#fbfbfc', '明るい']].map(([k, c, t]) => {
    const b = btn(`ツールバーの色: ${t}`, null, () => setLook('theme', k), 'c');
    b.style.setProperty('--c', c);
    return b;
  });
  const lcB = btn('ツールバーの色: 好きな色', null, () => {
    lci.value = look.theme[0] === '#' ? look.theme : '#3a4a5c';
    try { lci.showPicker(); } catch (_) { lci.click(); }
  }, 'c cc');
  const glassSw = lookSw('ガラス風 — 半透明にして下をぼかす', 'ガラス風', () => setLook('glass', !look.glass));
  const gaussSw = lookSw('ガウス — 周りも拾ってぼかす（切るとふつうの backdrop-filter）', 'ガウス', () => setLook('blurMode', look.blurMode === 'gauss' ? 'plain' : 'gauss'));
  lookP.append(row(...themeBs, lcB), glassSw, gaussSw);
  const [blurW, blurR, blurO] = range('ぼかし', 'ぼかしの強さ', 0, 40, v => setLook('blur', v), lookP);
  const [tintW, tintR, tintO] = range('地', 'ガラスの地の濃さ', 30, 95, v => setLook('tint', v), lookP);
  const [satW, satR, satO] = range('彩度', 'ガラスの彩度（下のページの色の鮮やかさ）', 100, 300, v => setLook('sat', v), lookP);
  // 予測の方法を切り替えて見比べる（次に描く線から効く）
  const ppL = el('span');
  ppL.textContent = '予測の方法';
  const ppBs = [['own', '曲がりに沿う'], ['chrome', 'ブラウザ']].map(([k, t]) => {
    const b = btn(`予測の方法: ${t}`, null, () => { ppred = k; syncLook(); }, 'sg');
    b.textContent = t;
    return b;
  });
  const ppR = el('div', 'r');
  ppR.append(ppL);
  lookP.append(ppR, row(...ppBs));
  // 蛍光ペンの予測を切り替えて見比べる（次に描く線から効く）
  const mpL = el('span');
  mpL.textContent = '蛍光ペンの予測';
  const mpBs = [['need', '必要な分だけ'], ['off', 'なし'], ['full', 'そのまま']].map(([k, t]) => {
    const b = btn(`蛍光ペンの予測: ${t}`, null, () => { mpred = k; syncLook(); }, 'sg');
    b.textContent = t;
    return b;
  });
  const mpR = el('div', 'r');
  mpR.append(mpL);
  lookP.append(mpR, row(...mpBs));
  // 半透明の線の描き方を切り替えて見比べる（次に描く線から効く）
  const blL = el('span');
  blL.textContent = '半透明の線の描き方';
  const blBs = [['canvas', 'キャンバスの中で'], ['group', 'まとめて']].map(([k, t]) => {
    const b = btn(`半透明の線の描き方: ${t}`, null, () => { blend = k; liveAlpha(); syncLook(); }, 'sg');
    b.textContent = t;
    return b;
  });
  const blR = el('div', 'r');
  blR.append(blL);
  lookP.append(blR, row(...blBs));
  const toDefB = btn('この見た目をデフォルトにする — インストールページを開く（新しいタブ）', I.prefs, () => {
    closePanel();
    openDefaults({ ...DEF, theme: look.theme, glass: look.glass, blurMode: look.blurMode, blur: look.blur, tint: look.tint, sat: look.sat, ppred, mpred, blend });
  }, 'mi');
  const toDefL = el('span');
  toDefL.textContent = 'この見た目をデフォルトに';
  toDefB.append(toDefL);
  lookP.append(toDefB);
  function syncLook() {
    const t = look.theme;
    themeBs[0].classList.toggle('on', t === 'dark');
    themeBs[1].classList.toggle('on', t === 'light');
    lcB.classList.toggle('on', t[0] === '#');
    if (t[0] === '#') lcB.style.setProperty('--c', t); else lcB.style.removeProperty('--c');
    glassSw.setAttribute('aria-checked', look.glass);
    gaussSw.setAttribute('aria-checked', look.blurMode === 'gauss');
    for (const w of [gaussSw, blurW, tintW, satW]) w.classList.toggle('dis', !look.glass);
    blurR.value = look.blur; blurO.value = look.blur + 'px';
    tintR.value = look.tint; tintO.value = look.tint + '%';
    satR.value = look.sat; satO.value = look.sat + '%';
    ppBs.forEach((b, i) => b.classList.toggle('on', PPREDS[i] === ppred));
    mpBs.forEach((b, i) => b.classList.toggle('on', MPREDS[i] === mpred));
    blBs.forEach((b, i) => b.classList.toggle('on', BLENDS[i] === blend));
  }
  const closeB = btn('閉じる（8 秒間は元に戻せます）', I.close, close);
  // 入力の録画（開発用。T-070）: 描いた線の入力を録って JSON で書き出す。予測の精度を、人が実際に書いた線で測るため（T-060）
  let recB = null;
  if (dev) item('見た目（開発用） — ツールバーの色やガラス、予測の方法、蛍光ペンの予測、半透明の線の描き方をその場で変える', '見た目（開発用）', '', I.bg, () => openPanel(lookP, moreB));
  if (dev) {
    [recB] = item('入力を録る（開発用） — ペン・蛍光ペンで描いた線の入力（座標・時刻・筆圧・Chrome の予測）を録る。入れると前の録画は消える', '入力を録る（開発用）', '', I.rec, toggleRec, true, true);
    item('録った入力を書き出す（開発用） — JSON をダウンロード', '録った入力を書き出す', '', I.save, recExport);
  }
  const hideB = btn('隠す (Esc) — ブックマークレットを再度押すと再表示', I.hide, hideHint);
  // ここまでが本家のその他。CP2 のその他は、全消去・色（選ぶとメニューを閉じ、消しゴムのときはペンに戻す）・本家に戻す
  const mainMore = [...moreP.children];
  const [cp2Mi] = item('Simple Preview — バーをペン・文字・元に戻すだけにしたシンプルな表示に切り替える。絵はそのまま。その他の「本家に戻す」で戻る', 'Simple Preview', '', I.swap, () => setUi(true));
  const [mainMi] = item('本家に戻す — いつもの表示に戻す。絵はそのまま', '本家に戻す', '', I.swap, () => setUi(false));
  const mcBtns = PALETTE.map((c, i) => {
    const b = btn(`色 ${i + 1}`, null, () => { setColor(c); if (tool === 'eraser') setTool('pen'); closePanel(); }, 'c');
    b.style.setProperty('--c', c);
    return b;
  });
  const mcRow = row(...mcBtns);
  // CP2 の閉じる（× の見た目）は、中身は隠す（絵は残り、ブックマークレットでまた出る）。お知らせも出さない
  const hideCB = btn('閉じる — ブックマークレットを再度押すと、絵もそのまま再表示', I.close, hide);
  // 版に合わせて、バーとその他の中身を並べ直す。パネルと色の入力（ci・lci）はどちらの版でもバーの子に置く
  function layout() {
    closePanel();
    if (cp2) bar.replaceChildren(penB, toolBtns.text, sep(), undoB, sep(), moreB, hideCB);
    else bar.replaceChildren(toolBtns.select, penB, toolBtns.marker, toolBtns.eraser, shapeB, toolBtns.text, toolBtns.fill,
      el('div', 'sep brk'), styleB, sep(), undoB, redoB, sep(), passB, moreB, sep(), hideB, closeB); // 1 段に収まらないときは .brk で段を分ける（.two .brk。T-064・T-067）
    bar.append(shapeP, penP, styleP, moreP, lookP, ci, lci);
    moreP.replaceChildren(...(cp2 ? [clrMi, mcRow, mainMi] : [...mainMore, cp2Mi]));
    moreB.title = MORE_T[+cp2];
    moreB.setAttribute('aria-label', MORE_T[+cp2]);
    penB.classList.toggle('dd', !cp2);
    helpEl.replaceChildren(); // 操作の一覧は次に開いたときに作り直す（CP2 ではページ操作モードの行を出さない）
    syncPen();
    syncTool(false);
  }
  // 版を切り替える。絵・履歴・道具・色はそのまま。CP2 にはページ操作モードがないので外す
  function setUi(on) {
    if (cp2 === on) return;
    if (act !== -1) endStroke();
    if (on && pass) togglePass();
    // CP2 のバーにない道具（選択・蛍光ペン・図形・塗りつぶし）のままなら、ペンにする（どのボタンも選ばれていない見た目にしない。T-089）
    if (on && !CP2_TOOLS.includes(tool)) setTool('pen');
    cp2 = on;
    swapPen(on);
    layout();
    layBar();
    measureBar();
    if (barMoved) moveBar(barX, barY); else placeBar();
    updateGhost();
    remember(); // お知らせは出さない（バーが丸ごと変わるので見れば分かる。T-103）
    if (on && !toastFn) { clearTimeout(toastT); unsay(); } // 本家で出ていたボタンのないお知らせ（起動の「Esc で隠す」など）も消す
  }

  // パネルは 1 つだけ開く。描き始め・パネルの外を押す・Esc で閉じる。
  // 開いていなければ pointerdown ごとの仕事は比較 1 回だけ（入力のホットパスには触れない）
  let openP = null, openB = null, pW = 0, pH = 0, pL = 0; // 開いているパネルの大きさと、開いたボタンの位置
  function openPanel(p, b) {
    closePanel();
    openP = p; openB = b;
    p.classList.add('on');
    b.classList.add('open');
    measureBar();
    pW = p.offsetWidth; pH = p.offsetHeight; pL = b.offsetLeft;
    placePanel();
  }
  // 下に入らなければ上に開く。横は画面からはみ出さないように寄せる（開いたままツールバーを動かす間も呼ぶので、読み取りはしない）
  function placePanel() {
    bar.classList.toggle('up', barY + barH + pH + 8 > vh && barY >= pH + 8);
    openP.style.left = max(4 - barX, min(pL, vw - barX - pW - 4)) + 'px';
  }
  function closePanel() {
    if (!openP) return;
    openP.classList.remove('on');
    openB.classList.remove('open');
    openP = openB = null;
  }
  function togglePanel(p, b) { openP === p ? closePanel() : openPanel(p, b); }
  // 色と太さ・開発用の見た目のパネル（keepPanels ならすべて）は、ツールバーを押しただけでは閉じない（引いて動かす間は開いたまま、引かずに離したら閉じる。T-066・T-068）。
  // Simple のその他も同じ（色を選ぶ場所なので、色と太さのパネルと同じ扱い。T-094）
  const keepP = p => p === styleP || p === lookP || keepPanels || (cp2 && p === moreP);
  wrap.addEventListener('pointerdown', e => {
    if (openP && !openP.contains(e.target) && !openB.contains(e.target) && !(keepP(openP) && bar.contains(e.target))) closePanel();
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
  // ツールバーはどこを押しても、4px 以上引けば動かせる（引かずに離せば、そのボタンが押される）。
  // パネルの中（スライダーなど）は除く。動かし始めるまでポインタを奪わないので、ボタンのクリックはそのまま届く
  // 引いて離したあとのクリックは、ボタンを押したことにしない（次にツールバーを押したら印を消す）
  let eatClick = false;
  bar.addEventListener('click', e => { if (eatClick) { eatClick = false; e.stopPropagation(); e.preventDefault(); } }, true);
  bar.addEventListener('pointerdown', e => {
    eatClick = false;
    stopFling();
    offTop();
    if (e.button !== 0 || e.target.closest('.pn')) return;
    measureBar();
    const sx = e.clientX, sy = e.clientY, ox = sx - barX, oy = sy - barY, id = e.pointerId;
    // 色と太さ・開発用の見た目のパネルは、動かす間も開いたまま（T-066・T-068）。ほかのパネルは引き始めで閉じる（keepPanels なら閉じない）
    const kp = openP, look = !!kp && keepP(kp), onB = look && openB.contains(e.target);
    let moving = false;
    const mv = ev => {
      if (ev.pointerId !== id) return;
      if (!moving) {
        if (abs(ev.clientX - sx) < 4 && abs(ev.clientY - sy) < 4) return;
        moving = true;
        if (!look) closePanel();
        bar.classList.add('drag');
        try { bar.setPointerCapture(id); } catch (_) { }
      }
      moveBar(ev.clientX - ox, ev.clientY - oy);
      if (look && openP === kp) placePanel();
    };
    const up = ev => {
      if (ev.pointerId !== id) return;
      win.removeEventListener('pointermove', mv, true);
      win.removeEventListener('pointerup', up, true);
      win.removeEventListener('pointercancel', up, true);
      // 引かずに離したら、ほかのパネルと同じに閉じる（開いたボタンの上なら、そのボタンが開け閉めする）
      if (!moving) { if (look && !onB && openP === kp) closePanel(); return; }
      bar.classList.remove('drag');
      barMoved = true;
      remember();
      eatClick = true;
    };
    win.addEventListener('pointermove', mv, true);
    win.addEventListener('pointerup', up, true);
    win.addEventListener('pointercancel', up, true);
  });

  // ---------- UI 同期（ホットパス外でのみ呼ぶ） ----------
  function setTool(t) {
    if (t !== 'text') commitText();
    if (t !== 'select') dropSel();
    if (pass) togglePass(); // ツールを選んだら描くつもりなので、ページ操作モードは解除する
    tool = t;
    syncTool(false);
    remember();
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
    markPen();
    const c = CFG[tool];
    if (!fromSlider) {
      sizeR.value = round(sqrt(max(c.size, 1) * 100));
      alphaR.value = round(c.alpha * 100);
    }
    const noSize = tool === 'fill' || tool === 'select', noAlpha = tool === 'eraser' || tool === 'select';
    sizeO.value = noSize ? '—' : c.size;
    alphaO.value = noAlpha ? '—' : round(c.alpha * 100) + '%';
    sizeW.classList.toggle('dis', noSize);
    alphaW.classList.toggle('dis', noAlpha);
    sizeW.firstChild.textContent = tool === 'text' ? '大きさ' : '太さ';
    // 入力中の文字は、文字ツールの大きさ・濃さのスライダーを動かしたときだけ追従する
    if (ta && fromSlider && tool === 'text') { taFs = CFG.text.size; taA = CFG.text.alpha; styleTa(); }
    if (fromSlider) remember();
    syncDot();
    updateCursor();
    liveAlpha();
  }
  // 色と太さのボタンの点: 色・太さ（4〜20px に縮めて表示）・濃さ。消しゴムは輪だけ
  function syncDot() {
    const c = CFG[tool];
    dot.style.setProperty('--c', color);
    dot.style.setProperty('--d', (tool === 'fill' || tool === 'select' ? 16 : round(4 + sqrt(min(c.size, 100) / 100) * 16)) + 'px');
    dot.style.setProperty('--a', tool === 'eraser' ? 1 : max(0.2, c.alpha));
    dot.classList.toggle('er', tool === 'eraser');
  }
  // live のグループの不透明度は、ツールや濃さを選んだ時点で合わせておく。押した瞬間に変えると、
  // desynchronized の live の方が先に画面へ出て、半透明の線が最初の 1 フレームだけ濃く見える。
  // blend が 'canvas' なら濃さは canvas の中で付けるので 1 のまま。半透明のペンを選んだら、描いた部分の形を覚える場所を用意しておく
  function liveAlpha() {
    const a = tool === 'eraser' || tool === 'fill' || tool === 'select' ? 1 : CFG[tool].alpha, cv = blend === 'canvas', g = cv ? 1 : a;
    if (cv && a < 1 && (tool === 'pen' || tool === 'marker')) ensureR();
    if (grpA !== g && !handoff) { grp.style.opacity = g; grpA = g; }
  }
  function setPen(k) {
    penType = k;
    setTool('pen');
    syncPen();
    remember();
  }
  function syncPen() {
    penD.setAttribute('d', I[penType === 'pen' ? 'pen' : penType]);
    penB.title = PEN_TITLES[penType];
    penB.setAttribute('aria-label', PEN_TITLES[penType]);
    for (const k of PENS) penBtns[k].classList.toggle('on', k === penType);
    markPen();
  }
  // CP2: ペンのボタンは、消しゴムのときは消しゴムの印と名前にし、ペンか消しゴムのとき選んだ見た目にする（T-088。CP2 ブランチの T-076）
  function markPen() {
    // Simple でペンを選んでいるとき、ペンボタンの選んでいる地を今の色にする（T-100、お試し。色見本のように。印は色の明るさで白か黒）
    penB.classList.toggle('pc', cp2 && tool === 'pen');
    if (!cp2) return;
    const er = tool === 'eraser', t = er ? TITLES.eraser : PEN_TITLES[penType];
    penD.setAttribute('d', I[er ? 'eraser' : penType]);
    penB.title = t;
    penB.setAttribute('aria-label', t);
    penB.classList.toggle('on', er || tool === 'pen');
  }
  // 鉛筆のかすれ: 色ごとに 1 度だけ作る模様（入力のたびには作らない）
  let grainC = '', grainP = null;
  function grain() {
    if (grainC === color && grainP) return grainP;
    const n = 48, c = newCanvas(n, n), x = c.getContext('2d'), im = x.createImageData(n, n), d = im.data;
    const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
    let seed = 12345;
    for (let i = 0; i < d.length; i += 4) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const v = (seed >>> 16) / 65536; // 0〜1 の擬似乱数（毎回同じ模様にする）
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
      d[i + 3] = v < 0.18 ? 40 : v < 0.45 ? 150 : 235;
    }
    x.putImageData(im, 0, 0);
    grainC = color;
    grainP = lctx.createPattern(c, 'repeat');
    return grainP;
  }
  function setSize(s) {
    if (tool === 'fill') return;
    CFG[tool].size = max(1, min(100, s));
    syncTool(false);
    remember();
  }
  function setColor(c) {
    color = c.toLowerCase();
    let hit = false;
    swBtns.forEach((b, i) => { const on = PALETTE[i] === color; b.classList.toggle('on', on); hit = hit || on; });
    mcBtns.forEach((b, i) => b.classList.toggle('on', PALETTE[i] === color));
    penB.style.setProperty('--pc', color);
    penB.style.setProperty('--pi', isLite(color) ? '#111' : '#fff');
    customB.classList.toggle('on', !hit);
    customB.style.setProperty('--c', color);
    if (ta) { taC = color; styleTa(); }
    syncDot();
    remember();
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
  function syncFixed() {
    fixB.setAttribute('aria-checked', fixed);
  }
  function syncCalc() {
    calcB.setAttribute('aria-checked', calc);
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
    settle();
    pass = !pass;
    offTop();
    wrap.classList.toggle('pass', pass);
    passB.classList.toggle('on', pass);
    say(pass ? 'ページ操作モード（V で描画に戻る）' : '描画モード');
  }
  // カーソル画像は OS/コンポジタが描くので遅延ゼロ（DOM で追従させるとフレーム遅れが出る）
  function updateCursor() {
    let cur = tool === 'text' ? 'text' : tool === 'select' ? 'default' : 'crosshair';
    if (tool === 'pen' || tool === 'marker' || tool === 'eraser') {
      const d = max(6, round(CFG[tool].size)), s = d + 4, m = s / 2, r = d / 2;
      if (s <= 128) {
        const svg = `<svg xmlns="${SVGNS}" width="${s}" height="${s}"><circle cx="${m}" cy="${m}" r="${r}" fill="none" stroke="#000" stroke-opacity=".75" stroke-width="1.5"/><circle cx="${m}" cy="${m}" r="${max(r - 1.25, 0.5)}" fill="none" stroke="#fff" stroke-opacity=".9"/></svg>`;
        cur = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${m | 0} ${m | 0},crosshair`;
      }
    }
    pad.style.cursor = toolCur = hoverCur = cur;
  }
  let toastT = 0, toastFn = null, toastXFn = null;
  // fn を渡すと、押せるボタン（act）付きで ms だけ出す（閉じるの取り消しに使う）。xfn を渡すと × のボタンも付く。
  // inl ならボタンを文の続きとして間を空けずに置く（「ブックマークレットで再表示」の「再表示」）
  function say(msg, ms = 1800, act, fn, xfn, inl) {
    if (cp2 && !fn) return; // CP2 は、押せるボタンの付いたお知らせだけを出す（CP2 ブランチの T-074）
    toastM.textContent = msg;
    toastB.textContent = act || '';
    toastFn = fn || null;
    toastXFn = xfn || null;
    toast.classList.toggle('act', !!fn);
    toast.classList.toggle('cx', !!xfn);
    toast.classList.toggle('in', !!inl);
    toast.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(unsay, ms);
  }
  function unsay() {
    toast.classList.remove('on', 'act', 'cx', 'in');
    toastFn = toastXFn = null;
  }
  toastB.addEventListener('click', () => { if (toastFn) toastFn(); });
  toastX.append(icon(I.close));
  toastX.addEventListener('click', () => { if (toastXFn) toastXFn(); });

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
      clearTimeout(warmT);
      warmT = setTimeout(warm, 0);
    }
    const cw = W / dpr + 'px', ch = H / dpr + 'px';
    for (const c of [liveC, predC]) { c.style.width = cw; c.style.height = ch; }
    tx0 = ty0 = tx1 = ty1 = 0;
    if (visible) { sizeSurface(); layBar(); measureBar(); moveBar(barX, barY); }
  }
  // 1 段に収まらない幅（スマホなど）では、上の段に道具、下の段に色と太さ・元に戻す・その他などの 2 段に整える（T-064・T-067）。
  // 幅は決め打ちせず、折り返すかを測る（タッチの端末はボタンが大きい）。ツールバーの幅は長い方の段に合わせる
  function layBar() {
    const cl = bar.classList;
    cl.remove('two');
    bar.style.removeProperty('width');
    if ((cp2 ? hideCB : closeB).offsetTop === (cp2 ? penB : toolBtns.select).offsetTop) return;
    cl.add('two');
    let right = 0;
    for (const b of bar.children) if (b.classList.contains('b')) right = max(right, b.getBoundingClientRect().right);
    bar.style.width = ceil(right - bar.getBoundingClientRect().left) + 5 + 'px';
  }
  // 暖機: キャンバスの GPU バッキング確保や合成パスの初回コンパイルは初回描画時に数十 ms かかる。
  // 描き始めてから払うと最初の一筆が引っかかるので、起動直後の何もしていない時間に済ませておく。
  function warm() {
    warmT = 0;
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
  // b: その手で描いた物の外接矩形 [x0, y0, x1, y1]（S）。選択ツールのクリックで選ぶ物を探すのに使う。
  // t: その手で変わった文字の物と、もう一方の状態の組 [[物, 状態], …]。画素の変化がない手は R を空、c を null にする
  function push(R, c, b, t) {
    grow(R);
    while (hist.length > hpos) free(hist.pop());
    let pix = 0;
    for (let i = 0; i < R.length; i += 6) pix += R[i + 2] * R[i + 3];
    hist.push({ R, c, pix, b, t });
    hpos++;
    hpix += pix;
    // メモリ上限: 画面 8 枚分または 200 手
    const cap = max(W * H * 8, 3e7);
    while (hist.length > 1 && (hist.length > 200 || hpix > cap)) { free(hist.shift()); hpos--; }
    syncHist();
  }
  function free(h) {
    hpix -= h.pix;
    if (h.c) h.c.width = h.c.height = 0;
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
  function swapAll(h) {
    if (h.c) swap(h);
    if (h.t) swapText(h);
  }
  function undo() {
    settle();
    if (act !== -1 || !hpos) return;
    finishHandoff();
    swapAll(hist[--hpos]);
    syncHist();
  }
  function redo() {
    settle();
    if (act !== -1 || hpos >= hist.length) return;
    finishHandoff();
    swapAll(hist[hpos++]);
    syncHist();
  }
  // 全消去はページ全体（見えていない所も含む）。元に戻せるように、全タイルをアトラスに退避してから消す
  function clearAll() {
    if (act !== -1) return;
    settle();
    finishHandoff();
    // 消す物がなければ何もしない（履歴を増やさない。T-058・T-063）: 直前の手が全消去なら面も文字も空。
    // 画素は描いた範囲（cb*）の中にしかないので、範囲が空で文字もなければ空。積むのも範囲に掛かるタイルだけ。
    // 直前の手が描く手（b がある）でなければ、消しゴム・選択の削除・最初まで元に戻した、で空になっているかもしれないので読み戻して確かめる
    const h = hpos ? hist[hpos - 1] : null;
    if ((h && h.clr) || (!tlist.length && (cbx1 <= cbx0 || (!(h && h.b) && !hasInk())))) return;
    const R = [], P = tlist.map(o => [o, tSnap(o)]);
    for (const k of dtiles.keys()) {
      const x = (k % 65536) * DT, y = ((k / 65536) | 0) * DT;
      if (x < cbx1 && x + DT > cbx0 && y < cby1 && y + DT > cby0) R.push(x, y, DT, DT, 0, 0);
    }
    if (!R.length && !P.length) return;
    push(R, R.length ? gather(R, pack(R)) : null, null, P.length ? P : null);
    hist[hpos - 1].clr = true;
    for (let i = 0; i < R.length; i += 6) dtiles.get((R[i + 1] / DT) * 65536 + R[i] / DT).x.clearRect(0, 0, DT, DT);
    for (const p of P) tApply(p[0], null);
    cbx0 = cby0 = cbx1 = cby1 = 0;
  }

  // 描いた範囲（cb*）に画素が 1 つでも残っているか。掛かるタイルの重なる所だけを読み戻す（全消去の前にだけ使う。T-063）
  function hasInk() {
    for (const [k, t] of dtiles) {
      const x = (k % 65536) * DT, y = ((k / 65536) | 0) * DT;
      const ax = max(floor(cbx0), x), ay = max(floor(cby0), y), ex = min(ceil(cbx1), x + DT), ey = min(ceil(cby1), y + DT);
      if (ex <= ax || ey <= ay) continue;
      const d = t.x.getImageData(ax - x, ay - y, ex - ax, ey - ay).data;
      for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
    }
    return false;
  }

  // ---------- 画面に固定（動画や地図の上に描く用。その他のメニューで切り替える） ----------
  // 入れると、面をその時のスクロール位置のまま position: fixed にして、スクロールしても画面の同じ所に留める。
  // 切るときは、今見えている位置のままページに付け直す（スクロールした分だけ、面の画素・履歴・文字をまとめてずらす）
  function toggleFixed() {
    if (act !== -1) return;
    settle();
    finishHandoff();
    if (!fixed) {
      fixed = true;
      fx = win.scrollX; fy = win.scrollY;
      pin(surf, [['position', 'fixed'], ['left', hdx - fx + 'px'], ['top', hdy - fy + 'px']]);
    } else {
      const dx = win.scrollX - fx, dy = win.scrollY - fy;
      fixed = false;
      pin(surf, [['position', 'absolute'], ['left', '0'], ['top', '0']]);
      if (dx || dy) shiftAll(round(dx * sdpr), round(dy * sdpr), round(dx) * sdpr, round(dy) * sdpr);
    }
    sizeSurface();
    syncFixed();
    say(fixed ? '画面に固定: スクロールしても絵は動きません' : '画面に固定: 切（絵はページに付きます）');
  }
  // 面の中身を S の (dx, dy) だけずらす（文字は CSS px の整数のまま (tx, ty) だけ）。文書の上や左にはみ出した所は消える
  function shiftAll(dx, dy, tx, ty) {
    const old = [...dtiles.entries()];
    dtiles.clear();
    for (const [k, t] of old) {
      const x = (k % 65536) * DT + dx, y = ((k / 65536) | 0) * DT + dy;
      forTiles(x, y, DT, DT, true, (n, ox, oy, ix, iy, iw, ih) => n.x.drawImage(t.c, ix - x, iy - y, iw, ih, ix - ox, iy - oy, iw, ih));
      t.c.remove();
      t.c.width = t.c.height = 0;
    }
    const st = q => { q[1] += tx; q[2] += ty; };
    for (const h of hist) {
      for (let i = 0; i < h.R.length; i += 6) { h.R[i] += dx; h.R[i + 1] += dy; }
      if (h.b) { h.b[0] += dx; h.b[1] += dy; h.b[2] += dx; h.b[3] += dy; }
      if (h.t) for (const p of h.t) if (p[1]) st(p[1]);
    }
    for (const o of tlist.slice()) { const q = tSnap(o); st(q); tApply(o, q); }
    if (cbx1 > cbx0) { cbx0 = max(0, cbx0 + dx); cby0 = max(0, cby0 + dy); cbx1 += dx; cby1 += dy; }
  }

  // ---------- ストローク状態（ホットパスで割り当てを起こさないよう、すべてスカラーで保持） ----------
  let act = -1, aType = '', mode = 0; // mode: 1 インク / 2 消しゴム / 3 図形 / 4 選択（囲む・移動・拡大縮小）
  let sTool = 'pen', sW = 0, sA = 1, sP = false, sRaw = false, raf = 0;
  let sPen = 0, pf = 1, sDist = 0; // ペンの種類（PENS の番号）と、万年筆・筆の太さの係数、書き始めからの距離
  // 予測線を描くか（蛍光ペンは mpred で決める）、点と点を直線でつなぐか（蛍光ペン。描いた所が後から変わらない）、必要な分だけ予測するか（T-055）
  let sPd = true, sPoly = false, sNeed = false;
  let sTr = false, sCa = 1, inkS = ''; // 半透明の線を canvas の中で濃さにするか（T-056）、確定で面に合成するときの濃さ、線の色（鉛筆は模様）
  let pvx = 0, pvy = 0, om = 0, fi = 16.7; // 直前の区間の速度、向きの変わる速さ（rad/ms）、1 フレームの長さ（ms。tick で測る）
  let bx = 0, by = 0, bw = 0, mx = 0, my = 0, ps = 1, lt = 0, lastPen = -1e9;
  let x0 = 0, y0 = 0, x1 = 0, y1 = 0, mW = 0; // ストロークの外接矩形
  let tx0 = 0, ty0 = 0, tx1 = 0, ty1 = 0; // pred レイヤの汚れ矩形
  let sx = 0, sy = 0, cx = 0, cy = 0, shShift = false, shAlt = false, shaped = false, gHead = false;
  const G = new Float64Array(8); // 確定時のタイル算出用に、最後に描いた図形の形状を保持
  let pn = 0, nativePred = false, vx = 0, vy = 0;
  const px = new Float64Array(PRED_MAX), py = new Float64Array(PRED_MAX), pt = new Float64Array(PRED_MAX);
  // 直近の入力の点（自前の予測で当てはめる。止まっている間の点も入れる）。HN 個の輪
  const HN = 64, hT = new Float64Array(HN), hX = new Float64Array(HN), hY = new Float64Array(HN);
  let hN = 0, fT = 0, dl = 0; // fT: 前のフレームから新しく来た点の一番古い時刻。dl: 入力が届くまでの遅れ（ms、tick で測る）
  function hPush(t, x, y) { const j = hN++ % HN; hT[j] = t; hX[j] = x; hY[j] = y; if (!fT) fT = t; }
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

  // 2 本指でスクロール（CP2 ブランチの T-074 を T-088 で移し、T-104 で本家にも入れた）: タッチが 2 本になったら、1 本目で描き始めていた線は捨てて、2 本の中点の動きでページをスクロールする。
  // 2 本とも離すまでは描かない。pad に capture で登録し（起動時に一度）、onDown / onMove / onUp より先に呼ばれて、スクロールの間はそれらに渡さない。
  // タッチの塗りつぶしと文字は離したときに行う（tapId）ので、2 本指になったら取り消すだけでよい。1 本のときの仕事は、ポインタの番号の比較と座標の代入だけ
  let tI0 = -1, tX0 = 0, tY0 = 0, tI1 = -1, tX1 = 0, tY1 = 0, scr = 0, scrX = 0, scrY = 0; // scr: 1 = スクロール中、2 = 片方を離した（残りを離すまで描かない）
  // LINE の中のブラウザ（UA に Line/）は、ページがいちばん上のときに下へなぞると、ブラウザごと小さくする。ページからはその操作を止められない
  // （WebKit が preventDefault や touch-action で止めるのは Web ビューの中の操作だけ）ので、ツールを使う間はページを上から 1px 下げておく（T-105）。
  // 出したとき・押したとき（線の前）・2 本指で上へ戻ったとき・ページ操作モードから戻ったときに直す。スクロールできないページでは効かない
  const LINE = /\bLine\//.test(navigator.userAgent);
  const offTop = () => { if (LINE && !pass && win.scrollY < 1) win.scrollTo(win.scrollX, 1); };
  // 離した後の慣性（T-106、ユーザーの要望: スクロールの持続性）: 離す前の 100 ms の中点の動き（輪 KN 個）から速さを出し、1 ms ごとに KF 倍に落としながら
  // 毎フレーム scrollBy する（0.998 は iOS の UIScrollView の normal と同じ減り方）。止まってから離したときは滑らない。
  // 滑っている間に押したら止めるだけ（その指では描かない）。ツールバーを押す・隠す・ページの端に着く、でも止まる
  const KN = 8, KF = 0.998, kT = new Float64Array(KN), kX = new Float64Array(KN), kY = new Float64Array(KN);
  let kN = 0, kVX = 0, kVY = 0, kAX = 0, kAY = 0, kL = 0, kR = 0;
  const kPush = (t, x, y) => { const i = kN++ % KN; kT[i] = t; kX[i] = x; kY[i] = y; };
  const stopFling = () => { if (kR) { cancelAnimationFrame(kR); kR = 0; } };
  function flingStart(t) {
    if (kN < 2) return;
    const j = (kN - 1) % KN, tj = kT[j];
    if (t - tj > 80) return;
    let i = j;
    for (let n = 1; n < min(kN, KN); n++) { const p = (i + KN - 1) % KN; if (tj - kT[p] > 100) break; i = p; }
    const dt = tj - kT[i];
    if (dt < 8) return;
    let vx = (kX[i] - kX[j]) / dt, vy = (kY[i] - kY[j]) / dt; // スクロールの向き（指の動きの逆）。px/ms
    const v = hypot(vx, vy);
    if (v < 0.15) return;
    if (v > 8) { vx *= 8 / v; vy *= 8 / v; }
    kVX = vx; kVY = vy; kAX = kAY = 0; kL = t;
    kR = requestAnimationFrame(fling);
  }
  function fling(ts) {
    const dt = min(50, max(0, ts - kL)), k = KF ** dt;
    kL = ts; kVX *= k; kVY *= k;
    kAX += kVX * dt; kAY += kVY * dt;
    const dx = Math.trunc(kAX), dy = Math.trunc(kAY);
    kAX -= dx; kAY -= dy;
    if (dx || dy) {
      const x0 = win.scrollX, y0 = win.scrollY;
      win.scrollBy(dx, dy);
      offTop();
      if (win.scrollX === x0 && win.scrollY === y0) { kR = 0; return; } // 端に着いた
    }
    kR = abs(kVX) + abs(kVY) < 0.03 ? 0 : requestAnimationFrame(fling);
  }
  function twoDown(e) {
    const flung = !!kR;
    stopFling();
    if (act === -1) offTop();
    if (e.pointerType !== 'touch') return;
    const id = e.pointerId;
    if (e.isPrimary) { tI0 = tI1 = -1; scr = 0; } // 新しいタッチの始まり（離したことを取りこぼしていても数え直す）
    if (tI0 === -1) { tI0 = id; tX0 = e.clientX; tY0 = e.clientY; }
    else if (tI1 === -1) { tI1 = id; tX1 = e.clientX; tY1 = e.clientY; }
    else return;
    if (flung && !scr && tI1 === -1) scr = 2; // 滑っているのを止めた指は、離すまで描かない
    if (tI0 === -1 || tI1 === -1) { if (!scr) return; }
    else if (act === -1 || aType === 'touch') {
      if (act !== -1) abortStroke();
      tapId = -1;
      scr = 1; scrX = (tX0 + tX1) / 2; scrY = (tY0 + tY1) / 2;
      kN = 0; kPush(e.timeStamp, scrX, scrY);
      for (const i of [tI0, tI1]) try { pad.setPointerCapture(i); } catch (_) { }
    } else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function twoMove(e) {
    const id = e.pointerId;
    if (id === tI0) { tX0 = e.clientX; tY0 = e.clientY; }
    else if (id === tI1) { tX1 = e.clientX; tY1 = e.clientY; }
    else return;
    if (!scr) return;
    e.stopImmediatePropagation();
    if (scr !== 1) return;
    const mx = (tX0 + tX1) / 2, my = (tY0 + tY1) / 2;
    win.scrollBy(scrX - mx, scrY - my);
    offTop();
    scrX = mx; scrY = my;
    kPush(e.timeStamp, mx, my);
  }
  function twoUp(e) {
    const id = e.pointerId;
    if (id === tI0) tI0 = -1;
    else if (id === tI1) tI1 = -1;
    else return;
    if (!scr) return;
    e.stopImmediatePropagation();
    if (scr === 1 && e.type === 'pointerup') flingStart(e.timeStamp); // 1 本目を離したところで滑らせる
    scr = tI0 === -1 && tI1 === -1 ? 0 : 2;
  }
  const TWO = [['pointerdown', twoDown], ['pointermove', twoMove], ['pointerup', twoUp], ['pointercancel', twoUp]];

  // 塗りつぶしと文字（x, y は V、cx, cy は client。sk・sox・soy は押したときの mapNow のまま）
  let tapId = -1, tapT = '', tapX = 0, tapY = 0, tapCX = 0, tapCY = 0;
  function tapAct(t, x, y, cx, cy) {
    if (t === 'fill') { floodFill(x, y); return; }
    const o = textHit(x * sk + sox, y * sk + soy);
    if (o) editText(o);
    else textAt(cx, cy);
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
    // 入力中の文字があれば確定する。このクリックは確定だけ（新しい入力欄も線も出さない）
    if (ta) {
      commitText();
      wrap.focus({ preventScroll: true });
      return;
    }
    if (doc.activeElement !== host) wrap.focus({ preventScroll: true });
    if ((win.devicePixelRatio || 1) !== dpr) fit();
    finishHandoff();
    mapNow();
    const t = erase ? 'eraser' : tool;
    const x = e.clientX * dpr, y = e.clientY * dpr, X = x * sk + sox, Y = y * sk + soy;
    // 文字に触れる: 選んでいる物か文字の上を押したら、どの道具でも選択ツールと同じに扱う
    if (t === 'select' || (touchText && TOUCH[t] && ((sel && selHit(X, Y) !== -2) || textHit(X, Y)))) { selDown(e, X, Y); return; }
    dropSel();
    if (t === 'fill' || t === 'text') {
      // タッチは離したときに行う（2 本指のスクロールになったら何もしない。T-104）
      if (type === 'touch') { tapId = e.pointerId; tapT = t; tapX = x; tapY = y; tapCX = e.clientX; tapCY = e.clientY; }
      else tapAct(t, x, y, e.clientX, e.clientY);
      return;
    }

    act = e.pointerId; aType = type; sTool = t;
    const c = CFG[t];
    sW = c.size * dpr; sA = c.alpha; mW = sW;
    lt = e.timeStamp; pn = 0; vx = vy = 0;
    bx = mx = sx = cx = x0 = x1 = x;
    by = my = sy = cy = y0 = y1 = y;
    try { pad.setPointerCapture(act); } catch (_) { }
    sTr = false;

    if (t === 'eraser') {
      mode = 2;
      const p = sW / 2 + 2;
      markBox(x - p, y - p, x + p, y + p); // 削る前に該当タイルを退避
      if (tlist.length) eraseText(x, y, x, y, sW / 2);
      ePts[0] = x * sk + sox; ePts[1] = y * sk + soy;
      erasePts(1);
    } else {
      const cv = blend === 'canvas', ga = cv ? 1 : sA;
      if (grpA !== ga) { grp.style.opacity = ga; grpA = ga; }
      sCa = cv ? 1 : sA;
      setInk(lctx);
      if (t === 'pen' || t === 'marker') {
        mode = 1;
        setInk(pctx);
        // 半透明の線は live に線の濃さで描く（stk）。pred も線の濃さで描き、live が覆う所を抜く（cutPred）
        sTr = cv && sA < 1;
        if (sTr) { ensureR(); rn = 0; pctx.globalAlpha = sA; }
        sP = pen && t === 'pen' && e.pressure > 0;
        ps = sP ? e.pressure : 1;
        sPen = t === 'pen' ? PENS.indexOf(penType) : 0;
        pf = sPen === 1 ? 0.6 : 1;
        sDist = 0;
        sPd = t === 'pen' || mpred !== 'off';
        sNeed = sPoly = t === 'marker' && mpred === 'need';
        pvx = pvy = om = 0;
        bw = sP ? qw(sW * (0.2 + 0.8 * ps)) : sW;
        if (sPen === 1) bw = qw(bw * (0.2 + 0.8 * pf));
        else if (sPen === 2) bw = qw(bw * 0.35);
        else if (sPen === 3) { const g = grain(); lctx.strokeStyle = lctx.fillStyle = pctx.strokeStyle = g; }
        inkS = pctx.strokeStyle;
        // 押した瞬間に点を出す（タップでも点が残る）
        hN = 0; fT = 0; hPush(lt, x, y);
        lctx.beginPath(); lctx.arc(x, y, bw / 2, 0, TAU);
        if (sTr) { lctx.globalAlpha = sA; lctx.fill(); lctx.globalAlpha = 1; addPiece(2, x, y, x, y, x, y, bw); } else lctx.fill();
        const p = bw / 2 + 2;
        markBox(x - p, y - p, x + p, y + p);
      } else {
        mode = 3;
        shaped = false;
        shShift = e.shiftKey; shAlt = e.altKey;
        lctx.lineWidth = sW;
        lctx.lineJoin = t === 'rect' ? 'miter' : 'round';
        lctx.globalAlpha = sA / sCa; // 図形は毎回描き直すので、canvas の方式ならそのまま線の濃さで描ける
      }
    }
    // 図形は 1 フレームに 1 回の再描画で十分なので rawupdate は使わない
    sRaw = HAS_RAW && mode !== 3;
    if (sRaw) pad.addEventListener('pointerrawupdate', onMove);
    lastTs = 0; // 線と線の間は rAF を止めているので、その間隔は数えない
    raf = requestAnimationFrame(tick);
    if (rec && mode === 1) recStart(e, t);
  }

  // pointerrawupdate と pointermove の両方から呼ばれる。タイムスタンプで重複を除くので
  // どちらが先に届いても、どちらかしか来なくても正しく描ける。
  function onMove(e) {
    if (e.pointerId !== act) {
      if (e.pointerType === 'pen') lastPen = e.timeStamp; // ホバー中のペンもパームリジェクションに使う
      if (act === -1 && (sel || (tlist.length && (tool === 'select' || (touchText && TOUCH[tool]))))) selHover(e);
      return;
    }
    if (recCur) recEv(e);
    const t0 = hud ? now() : 0;
    const list = HAS_CO && e.getCoalescedEvents ? e.getCoalescedEvents() : EMPTY;
    const n = list.length;
    const isMove = e.type === 'pointermove';
    if (mode === 1) {
      inkMove(e, list, n);
      if (inkP && sA === 1) {
        // OS が実際のポインタ位置まで線を伸ばすので、推測（予測線）は使わない
        if (isMove) try { inkP.updateInkTrailStartPoint(e, { color, diameter: bw / dpr }); pn = 0; } catch (_) { if (sPd) predict(e, true); }
      } else if (sPd) predict(e, isMove);
      drawTail();
    } else if (mode === 2) {
      eraseMove(e, list, n);
    } else if (mode === 4) {
      selMove(e);
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
      if (t < lt) continue; // 既に処理済み
      // 移動なし: 描かないが、止まったことは予測の点に入れる（速さが落ちて予測が縮む）。lt は動いた時刻のまま（筆の速さや予測線を消す時間が変わらない）
      if (x === bx && y === by) { if (t > hT[(hN - 1) % HN]) hPush(t, x, y); continue; }
      hPush(t, x, y);
      const dt = t - lt;
      if (dt > 0.5) {
        const ix = (x - bx) / dt, iy = (y - by) / dt;
        if (sNeed && (pvx || pvy)) {
          // 向きの変わる速さ（曲がりに沿って予測するため）。入力の揺れで暴れないように上限を付けてならす
          const a = max(-0.02, min(0.02, atan2(pvx * iy - pvy * ix, pvx * ix + pvy * iy) / dt));
          om += (a - om) * 0.5;
        }
        pvx = ix; pvy = iy;
        vx += (ix - vx) * 0.5; vy += (iy - vy) * 0.5;
      }
      lt = t;
      nPts++;
      let w = sW;
      if (sP) {
        const pr = p.pressure;
        ps += ((pr > 0 ? pr : ps) - ps) * 0.5;
        w = sW * (0.2 + 0.8 * ps);
      }
      if (sPen === 1 || sPen === 2) {
        const dx = x - bx, dy = y - by, d = hypot(dx, dy);
        if (sPen === 1) {
          // 万年筆: ペン先の向きに沿うほど細い
          if (d > 0) pf += (abs(dy * NIB_C - dx * NIB_S) / d - pf) * 0.35;
          w *= 0.2 + 0.8 * pf;
        } else {
          // 筆: 速いほど細い（CSS px/ms）。書き始めは細く入る
          const v = dt > 0 ? d / dt / dpr : 0;
          pf += (max(0.3, min(1.25, 1.3 - v * 0.45)) - pf) * 0.3;
          sDist += d;
          w *= pf * (0.35 + 0.65 * min(1, sDist / (sW * 3 + 1)));
        }
      }
      if (sP || sPen) w = qw(w);
      if (sPoly) {
        // 蛍光ペン: 点と点を直線でつなぐ（丸い角）。中点を結ぶ曲線だと、末尾の直線が次の入力で曲線に確定するときに内側へ引っ込む。
        // 太い線では直線でも角は見えない。未確定の末尾がないので、pred には予測だけが残る
        if (bw !== cw) { if (open) stk(c); c.lineWidth = cw = bw; c.beginPath(); c.moveTo(bx, by); open = true; }
        c.lineTo(x, y);
        markSeg(bx, by, x, y, bw / 2 + 2);
        if (sTr) addPiece(0, bx, by, bx, by, x, y, bw);
        mx = bx = x; my = by = y; bw = w;
        if (x < x0) x0 = x; else if (x > x1) x1 = x;
        if (y < y0) y0 = y; else if (y > y1) y1 = y;
        if (w > mW) mW = w;
        continue;
      }
      const nx = (bx + x) * 0.5, ny = (by + y) * 0.5;
      if (bw !== cw) {
        if (open) stk(c);
        c.lineWidth = cw = bw;
        c.beginPath();
        c.moveTo(mx, my);
        open = true;
      }
      c.quadraticCurveTo(bx, by, nx, ny);
      markCurve(mx, my, bx, by, nx, ny, bw / 2 + 2);
      if (sTr) addPiece(1, mx, my, bx, by, nx, ny, bw);
      mx = nx; my = ny; bx = x; by = y; bw = w;
      if (x < x0) x0 = x; else if (x > x1) x1 = x;
      if (y < y0) y0 = y; else if (y > y1) y1 = y;
      if (w > mW) mW = w;
    }
    if (open) stk(c);
  }
  // 線を live に描く。半透明（sTr）なら、新しい部分の所を先に抜いてから（destination-out）、線の濃さで足す（lighter）。
  // 濃さは sA ×（今までの形と新しい部分の和）になり、不透明で重ねてから濃さをかける前の方式と同じ計算。線が自分と重なっても濃くならず、キャンバスのコピーも要らない
  function stk(c) {
    if (!sTr) { c.stroke(); return; }
    c.globalCompositeOperation = 'destination-out';
    c.stroke();
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = sA;
    c.stroke();
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
  }
  // 半透明の線の、描いた部分の形（T-056）。pred から live が覆う所を抜く（cutPred）のに使う。
  // 区間を RN 個まで覚え（それより古い物から上書きする）、RB 個ずつの外接矩形で絞り込む。入力のたびに呼ぶので割り当てをしない
  const RN = 16384, RB = 32;
  function ensureR() {
    if (!rg) { rg = new Float64Array(RN * 8); rbx = new Float64Array(RN / RB * 4); }
  }
  // k: 0 直線（a → e）/ 1 二次曲線（a → 制御点 c → e）/ 2 点（a が中心）。w は太さ
  function addPiece(k, ax, ay, cx, cy, ex, ey, w) {
    const i = rn % RN, o = i * 8, b = ((i / RB) | 0) * 4, r = w / 2 + 1;
    rg[o] = k; rg[o + 1] = ax; rg[o + 2] = ay; rg[o + 3] = cx; rg[o + 4] = cy; rg[o + 5] = ex; rg[o + 6] = ey; rg[o + 7] = w;
    const x0 = min(ax, cx, ex) - r, y0 = min(ay, cy, ey) - r, x1 = max(ax, cx, ex) + r, y1 = max(ay, cy, ey) + r;
    if (i % RB === 0 || x0 < rbx[b]) rbx[b] = x0;
    if (i % RB === 0 || y0 < rbx[b + 1]) rbx[b + 1] = y0;
    if (i % RB === 0 || x1 > rbx[b + 2]) rbx[b + 2] = x1;
    if (i % RB === 0 || y1 > rbx[b + 3]) rbx[b + 3] = y1;
    rn++;
  }
  // pred の矩形 [x0, x1] × [y0, y1] に掛かる、描いた部分の形を不透明で抜く。pred と live を重ねても線の濃さを超えない
  function cutPred(c, x0, y0, x1, y1) {
    const n = min(rn, RN);
    let cw = -1, open = false, lx = NaN, ly = NaN; // lx, ly: 前の区間の終わり（続いていれば 1 本の線にする。区切ると端ごとに丸い先端を描いて重い）
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'destination-out';
    c.strokeStyle = c.fillStyle = '#000';
    for (let b = 0, q = 0; b * RB < n; b++, q += 4) {
      if (rbx[q] > x1 || rbx[q + 2] < x0 || rbx[q + 1] > y1 || rbx[q + 3] < y0) continue;
      for (let i = b * RB, e = min(n, i + RB); i < e; i++) {
        const o = i * 8, w = rg[o + 7], r = w / 2 + 1, ax = rg[o + 1], ay = rg[o + 2], cx = rg[o + 3], cy = rg[o + 4], ex = rg[o + 5], ey = rg[o + 6];
        if (min(ax, cx, ex) - r > x1 || max(ax, cx, ex) + r < x0 || min(ay, cy, ey) - r > y1 || max(ay, cy, ey) + r < y0) continue;
        if (rg[o] === 2) {
          if (open) { c.stroke(); open = false; cw = -1; }
          c.beginPath(); c.arc(ax, ay, w / 2, 0, TAU); c.fill();
          lx = NaN;
          continue;
        }
        if (w !== cw) { if (open) c.stroke(); c.lineWidth = cw = w; c.beginPath(); open = true; lx = NaN; }
        if (ax !== lx || ay !== ly) c.moveTo(ax, ay);
        if (rg[o] === 1) c.quadraticCurveTo(cx, cy, ex, ey); else c.lineTo(ex, ey);
        lx = ex; ly = ey;
      }
    }
    if (open) c.stroke();
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = sA;
    c.strokeStyle = inkS;
    c.lineWidth = bw;
  }

  // 予測線の先を px / py / pt に入れる。自前（ownPred）は入力ごと、ブラウザの予測（readPred）と蛍光ペンの必要な分だけ（needPred）は pointermove のとき
  function predict(e, isMove) {
    if (sNeed) { if (isMove) needPred(); }
    else if (ppred === 'own') ownPred();
    else if (isMove) readPred(e);
  }
  // 自前の予測（T-060。録った人の線で、ブラウザの予測と比べて決めた）: 直近 PW ms の点（3 点に満たなければ 100 ms まで）に 2 次式を当てはめ（最小二乗）、今の速さ・向きの変わる速さ（角速度）・減速を求めて、
  // 1 フレーム（fi）先まで弧に沿って進める。加速は入れない（行き過ぎるため）。急に曲がるほど短く（角速度 × 先の時間）、長さは PCAP まで。
  // ブラウザの予測点は pointermove（1 フレームに 1 回）にしか付かず、pointerrawupdate で先に描いた新しい点より古い点からの予測なので、入力ごとに自前で求める
  function ownPred() {
    pn = 0;
    if (hN < 3) return;
    const t1 = hT[(hN - 1) % HN];
    let n = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, x0 = 0, x1 = 0, x2 = 0, y0 = 0, y1 = 0, y2 = 0;
    for (let i = hN - 1; i >= 0 && i > hN - 1 - HN; i--) {
      const j = i % HN, t = hT[j] - t1;
      if (t < -PW && (n >= 3 || t < -100)) break; // 点の少ない入力（60 Hz など）では、3 点そろうまで 100 ms まで遡る
      const x = hX[j] - bx, y = hY[j] - by, tt = t * t; // 最後の点からの差で足す（桁を小さく）
      n++; s1 += t; s2 += tt; s3 += tt * t; s4 += tt * tt;
      x0 += x; x1 += x * t; x2 += x * tt; y0 += y; y1 += y * t; y2 += y * tt;
    }
    if (n < 3) return;
    // 正規方程式 [[n,s1,s2],[s1,s2,s3],[s2,s3,s4]]·c = q をクラメルの公式で解く（c1 が速度、2·c2 が加速度）
    const d = n * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
    if (abs(d) < 1e-9) return;
    const vx = (n * (x1 * s4 - s3 * x2) - x0 * (s1 * s4 - s3 * s2) + s2 * (s1 * x2 - x1 * s2)) / d;
    const vy = (n * (y1 * s4 - s3 * y2) - y0 * (s1 * s4 - s3 * s2) + s2 * (s1 * y2 - y1 * s2)) / d;
    const ax = 2 * (n * (s2 * x2 - x1 * s3) - s1 * (s1 * x2 - x1 * s2) + x0 * (s1 * s3 - s2 * s2)) / d;
    const ay = 2 * (n * (s2 * y2 - y1 * s3) - s1 * (s1 * y2 - y1 * s2) + y0 * (s1 * s3 - s2 * s2)) / d;
    const v2 = vx * vx + vy * vy;
    if (v2 < 1e-6) return;
    const sp = sqrt(v2), w = (vx * ay - vy * ax) / v2, at = min(0, (vx * ax + vy * ay) / sp);
    const H = fi / (1 + PDAMP * abs(w) * fi), cap = PCAP * dpr, dt = H / 6;
    let x = bx, y = by, th = atan2(vy, vx), s = sp, dist = 0, k = 0;
    for (let i = 0; i < 6; i++) {
      s = max(0, s + at * dt); th += w * dt;
      const st = min(s * dt, cap - dist);
      if (st <= 0) break;
      x += cos(th) * st; y += sin(th) * st; dist += st;
      if (i === 2 || i === 5) { px[k] = x; py[k] = y; pt[k] = t1 + (i + 1) * dt; k++; }
    }
    if (dist > 0 && (!k || px[k - 1] !== x || py[k - 1] !== y)) { px[k] = x; py[k] = y; pt[k] = t1 + H; k++; }
    pn = k;
  }

  function readPred(e) {
    if (sNeed) { needPred(); return; }
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

  // 蛍光ペンの予測（必要な分だけ）: 丸い先端は点より太さの半分だけ先まで覆っているので、1 フレーム後のペン先に届かない分だけ伸ばす。
  // ゆっくり〜ふつうの速さでは予測しない（外れた予測がぴょこぴょこ見えるのは、太い線ほど目立つため）。向きは曲がりに沿って回す
  function needPred() {
    const sp = hypot(vx, vy), L = min(sp * fi - sW / 2, 40 * dpr);
    if (L <= 0) { pn = 0; return; }
    const r = om * (L / sp) / 2, cs = cos(r), sn = sin(r);
    px[0] = bx + (vx * cs - vy * sn) / sp * L;
    py[0] = by + (vx * sn + vy * cs) / sp * L;
    pt[0] = lt + L / sp;
    pn = 1;
  }

  // 未確定の末尾（最後の中点→最新点）と予測点を pred レイヤに描く。毎回この小さな範囲だけ消して描き直す
  function drawTail() {
    const c = pctx;
    if (tx1 > tx0) c.clearRect(tx0, ty0, tx1 - tx0, ty1 - ty0);
    let a0 = min(mx, bx), a1 = max(mx, bx), b0 = min(my, by), b1 = max(my, by), any = mx !== bx || my !== by;
    c.lineWidth = bw;
    c.beginPath();
    c.moveTo(mx, my);
    c.lineTo(bx, by);
    for (let k = 0; k < pn; k++) {
      if (pt[k] && pt[k] <= lt) continue; // 実入力が追い越した予測点は捨てる
      const x = px[k], y = py[k];
      c.lineTo(x, y);
      any = true;
      if (x < a0) a0 = x; else if (x > a1) a1 = x;
      if (y < b0) b0 = y; else if (y > b1) b1 = y;
    }
    // 半透明の線で描く物がなければ（蛍光ペンの末尾は空で、ゆっくりなら予測もない）、描くのも抜くのも飛ばす
    if (sTr && !any) { tx0 = ty0 = tx1 = ty1 = 0; return; }
    c.stroke();
    const m = bw / 2 + 2;
    tx0 = max(0, (a0 - m) | 0); ty0 = max(0, (b0 - m) | 0);
    tx1 = ceil(a1 + m); ty1 = ceil(b1 + m);
    if (sTr) cutPred(c, tx0, ty0, tx1, ty1); // 線の濃さで描いた pred から、live が覆っている所を抜く（重なった所が濃くならない）
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
      if (tlist.length) eraseText(bx, by, x, y, sW / 2);
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
    const c = lctx;
    if (dirty()) c.clearRect(dX, dY, dW, dH);
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

  // ストロークの外接矩形（線幅ぶん広げ、整数ピクセルに丸めてクリップ）を dX, dY, dW, dH に入れる。空なら false。
  // 図形では入力のたびに呼ぶので、オブジェクトを作らずに変数へ書く
  let dX = 0, dY = 0, dW = 0, dH = 0;
  function dirty() {
    const m = mW / 2 + 2;
    const ax = max(0, (x0 - m) | 0), ay = max(0, (y0 - m) | 0);
    const ex = min(W, ceil(x1 + m)), ey = min(H, ceil(y1 + m));
    if (ex <= ax || ey <= ay) return false;
    dX = ax; dY = ay; dW = ex - ax; dH = ey - ay;
    return true;
  }

  let lastTs = 0;
  function tick(ts) {
    raf = requestAnimationFrame(tick);
    if (recCur) recRow(6, ts, 0, 0, 0, now());
    // 1 フレームの長さを測る（蛍光ペンの予測の長さに使う。120 Hz の画面なら短くなる）
    // 重くてフレームが飛んだときは、何フレーム分かで割る（画面の書き換えの間隔は変わらないので、予測を伸ばさない）
    const fd = ts - lastTs;
    if (lastTs && fd > 4 && fd < 100) fi += (fd / max(1, round(fd / fi)) - fi) * 0.1;
    lastTs = ts;
    // 入力が届くまでの遅れ: このフレームまでに新しく来た点のうち一番古い点が待った時間。増えるときはすぐ、減るときはゆっくり追う。
    // パソコンが重いと、入力が古い時刻のまままとめて届く。その間も動いているので、遅れの分だけ待ってから止まったとみなす（T-087）
    if (fT) { const g = ts - fT; if (g < 500) dl = g > dl ? g : dl + (g - dl) * 0.05; fT = 0; }
    // ポインタが止まったら古い予測線を消す（行き過ぎた線が残らないように）。止まった点が届き続けている（ペンを止めて押さえている）ときは待たない
    if (pn && (ts - lt > PRED_TTL + dl || hT[(hN - 1) % HN] - lt > PRED_TTL)) { pn = 0; drawTail(); }
    if (tHit !== tShown) showErased();
  }

  function onUp(e) {
    if (e.pointerType === 'pen') lastPen = e.timeStamp; // ペンを離した直後に手のひらが触れても描かない
    if (e.pointerId === tapId) { tapId = -1; tapAct(tapT, tapX, tapY, tapCX, tapCY); return; }
    if (e.pointerId !== act) return;
    onMove(e);
    endStroke();
  }
  function onLost(e) {
    if (e.pointerId === tapId) tapId = -1;
    if (e.pointerId === act) endStroke();
  }

  function stopStroke() {
    const id = act;
    act = -1;
    if (recCur) recStop();
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
        lctx.lineWidth = sPen === 2 ? qw(bw * 0.6) : bw; // 筆は離し際を細く
        lctx.beginPath(); lctx.moveTo(mx, my); lctx.lineTo(bx, by); stk(lctx);
        markSeg(mx, my, bx, by, bw / 2 + 2);
      }
      clearTail();
      commitLive();
    } else if (m === 3) {
      if (shaped) { markShape(); commitLive(); }
      else if (dirty()) lctx.clearRect(dX, dY, dW, dH);
    } else if (m === 4) {
      selUp();
    } else if (m === 2) {
      // 退避しておいたタイルを 1 枚のアトラスにまとめて履歴へ。触れた文字の物も同じ手で消す
      const R = tileRects(false), P = takeErased(false);
      let ac = null;
      if (R.length) {
        ac = pack(R).getContext('2d');
        for (let k = 0, i = 0; i < R.length; k++, i += 6) ac.drawImage(tsave[k].c, 0, 0, R[i + 2], R[i + 3], R[i + 4], R[i + 5], R[i + 2], R[i + 3]);
      }
      if (R.length || P) push(R, ac && ac.canvas, null, P);
    }
    resetTiles();
    mode = 0;
    if (pendingFit) fit();
  }

  function abortStroke() {
    const m = mode, r = dirty();
    stopStroke();
    if (m === 4) selAbort();
    else if (m === 2) {
      takeErased(true);
      // 退避しておいた画素を戻す（表示タイルが無かった所は、何も消していない）
      const R = tileRects(false);
      for (let k = 0, i = 0; i < R.length; k++, i += 6) {
        const x = R[i], y = R[i + 1], d = dtiles.get(((y / DT) | 0) * 65536 + ((x / DT) | 0));
        if (!d) continue;
        d.x.clearRect(x % DT, y % DT, T, T);
        d.x.drawImage(tsave[k].c, 0, 0, T, T, x % DT, y % DT, T, T);
      }
    } else {
      if (r) lctx.clearRect(dX, dY, dW, dH);
      clearTail();
    }
    resetTiles();
    mode = 0;
  }

  // live のうち触れたタイルの範囲だけを面に合成し、その範囲の元の絵を履歴に積む。
  // 外接矩形ではなくタイル単位なので、斜めの長い線や広範囲の線でも処理量・メモリは線の面積にほぼ比例する
  function commitLive() {
    let R = tileRects(true);
    if (!dirty()) return;
    const rx = dX, ry = dY, rw = dW, rh = dH;
    if (!R.length) { lctx.clearRect(rx, ry, rw, rh); return; }
    // 水平に細長い線などはタイルより外接矩形の方が小さいので、面積の小さい方を使う
    let tp = 0;
    for (let i = 0; i < R.length; i += 6) tp += R[i + 2] * R[i + 3];
    const bX = floor(rx * sk + sox), bY = floor(ry * sk + soy);
    const bW = ceil((rx + rw) * sk + sox) - bX, bH = ceil((ry + rh) * sk + soy) - bY;
    if (bW * bH < tp) R = rect1(bX, bY, bW, bH);
    sizeSurface();
    const atlas = gather(R, pack(R));
    for (let i = 0; i < R.length; i += 6) {
      forTiles(R[i], R[i + 1], R[i + 2], R[i + 3], true, (t, ox, oy, ix, iy, iw, ih) => {
        const c = t.x;
        c.globalAlpha = sCa;
        c.drawImage(liveC, (ix - sox) / sk, (iy - soy) / sk, iw / sk, ih / sk, ix - ox, iy - oy, iw, ih);
        c.globalAlpha = 1;
      });
    }
    push(R, atlas, [bX, bY, bX + bW, bY + bH]);
    // live は desynchronized なので、ここで消すと通常の更新であるタイルより先に画面へ出て、線が一瞬消える。
    // live は残したままグループを隠し（タイルの更新と同じフレームで切り替わる）、2 フレーム後に中身を消す
    grp.style.opacity = 0;
    grpA = 0;
    hcx = rx; hcy = ry; hcw = rw; hch = rh;
    handoff = requestAnimationFrame(() => { handoff = requestAnimationFrame(finishHandoff); });
  }
  function finishHandoff() {
    if (!handoff) return;
    cancelAnimationFrame(handoff);
    handoff = 0;
    lctx.clearRect(hcx, hcy, hcw, hch);
    liveAlpha();
  }

  // ---------- 入力の録画（開発用。T-070） ----------
  // ペン・蛍光ペンで描いている間の入力をそのまま録り、JSON で書き出す（予測の精度を、人が実際に書いた線で測るため。T-060）。
  // 1 行は [種類, 時刻, x, y, 筆圧, 処理した時刻]。種類は 0 押す / 1 pointermove / 2 pointerrawupdate / 3 離す /
  // 4 直前の行の中の点（getCoalescedEvents）/ 5 直前の行での Chrome の予測点（getPredictedEvents）/ 6 フレーム（rAF の時刻）。
  // 座標は CSS px、時刻は ms。録っている間だけは、入力のたびに配列へ書く（足りなければ大きくする）。ふだんは recCur の比較 1 回だけ
  const RC = 6, REC_MAX = 500000;
  let rec = false, recA = null, recN = 0, recCur = null, recFull = false;
  const recS = []; // 線ごとの情報（道具・太さ・入力の種類・行の範囲）
  function toggleRec() {
    rec = !rec;
    recB.setAttribute('aria-checked', rec);
    if (rec) {
      if (!recA) recA = new Float64Array(32768 * RC);
      recN = 0; recS.length = 0; recFull = false;
      say('入力を録っています（描いたら、その他の「録った入力を書き出す」）');
    } else say(`録るのをやめました（${recS.length} 本）`);
  }
  function recStart(e, t) {
    if (recN >= REC_MAX) return;
    recCur = { tool: t, pen: t === 'pen' ? penType : '', size: CFG[t].size, alpha: CFG[t].alpha, type: e.pointerType, at: recN, end: recN };
    recS.push(recCur);
    recEv(e);
  }
  function recRow(k, t, x, y, p, h) {
    if (recN >= REC_MAX) { recFull = true; return; }
    if ((recN + 1) * RC > recA.length) { const a = new Float64Array(recA.length * 2); a.set(recA); recA = a; }
    const o = recN++ * RC;
    recA[o] = k; recA[o + 1] = t; recA[o + 2] = x; recA[o + 3] = y; recA[o + 4] = p; recA[o + 5] = h;
  }
  function recEv(e) {
    const ty = e.type, k = ty === 'pointerdown' ? 0 : ty === 'pointerrawupdate' ? 2 : ty === 'pointerup' ? 3 : 1;
    recRow(k, e.timeStamp, e.clientX, e.clientY, e.pressure, now());
    if (k === 0) return;
    const l = HAS_CO && e.getCoalescedEvents ? e.getCoalescedEvents() : EMPTY;
    for (let i = 0; i < l.length; i++) recRow(4, l[i].timeStamp, l[i].clientX, l[i].clientY, l[i].pressure, 0);
    const q = e.getPredictedEvents ? e.getPredictedEvents() : EMPTY;
    for (let i = 0; i < q.length; i++) recRow(5, q[i].timeStamp, q[i].clientX, q[i].clientY, q[i].pressure, 0);
  }
  function recStop() {
    recCur.end = recN;
    recCur = null;
    if (recFull) { rec = false; recB.setAttribute('aria-checked', false); say('録れる量がいっぱいになりました。書き出してください'); }
  }
  function recExport() {
    if (!recS.length) { say('録った線がありません（その他の「入力を録る」を入れて描く）'); return; }
    const rd = (v, k) => Math.round(v * k) / k;
    const strokes = recS.map(s => {
      const t0 = recA[s.at * RC + 1], rows = [];
      for (let i = s.at; i < s.end; i++) {
        const o = i * RC, h = recA[o + 5];
        rows.push(recA[o], rd(recA[o + 1] - t0, 1000), rd(recA[o + 2], 100), rd(recA[o + 3], 100), rd(recA[o + 4], 1000), h ? rd(h - t0, 1000) : 0);
      }
      return { tool: s.tool, pen: s.pen, size: s.size, alpha: s.alpha, type: s.type, t0: rd(t0, 1000), rows };
    });
    const data = {
      v: 1, app: VERSION, ua: navigator.userAgent, dpr, vw: win.innerWidth, vh: win.innerHeight,
      desynchronized: DESYNC, rawupdate: HAS_RAW, coalesced: HAS_CO, inkTrail: !!inkP, ui: UIS[+cp2], ppred, mpred, blend,
      cols: ['kind', 't', 'x', 'y', 'pressure', 'handled'], kinds: ['down', 'move', 'rawupdate', 'up', 'coalesced', 'predicted', 'frame'], strokes,
    };
    download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `paint-input-${stamp()}.json`);
    say(`録った入力を書き出しました（${recS.length} 本）`);
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
    const clear = seed >>> 24 <= FILL_TOL; // clear: 透明な領域（線で囲まれた内側など）を塗る
    // 透明部分を塗るときは各スパンを 1px 膨張させ、背面合成で線のアンチエイリアス縁の下に潜らせる（隙間が出ない）
    const g = clear ? 1 : 0;
    const path = new Path2D();
    let fx0 = 0, fy0 = 0, fx1 = W - 1, fy1 = H - 1;
    if (data) {
      // 判定表 m: 1 = 塗れる / 2 = 塗った。先に 1 回の線形走査で作り、探索中は配列参照だけにする。
      // 判定表づくりと探索は小さな関数に分ける（大きな関数の中に置くと、同じループが JIT で 2〜3 倍遅かった）
      const m = new Uint8Array(W * H);
      if (clear) maskClear(m, W, data, gx, gy, gw, gh);
      else maskColor(m, W, data, gx, gy, gw, gh, seed);
      [fx0, fy0, fx1, fy1] = scanFill(m, W, H, sx0, sy0, g, path);
    } else path.rect(0, 0, W, H); // 画面に何も描いていなければ、画面全体が 1 つの領域（たどった結果と同じ）
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
    push(R, patch, [R[0], R[1], R[0] + w, R[1] + h]);
    lastFillMs = now() - t0;
  }
  // 透明な所を塗るときの判定表: 透明度だけで決まる（seed と同じ色も透明なので同じ結果になる）。透明度のバイトだけを読む。
  // 描いた範囲（gx, gy, gw, gh）の外は透明と分かっているので、全部塗れる
  function maskClear(m, W, data, gx, gy, gw, gh) {
    m.fill(1);
    const a8 = new Uint8Array(data.buffer);
    for (let y = 0; y < gh; y++) {
      let i = (gy + y) * W + gx, k = y * gw * 4 + 3;
      for (const e = i + gw; i < e; i++, k += 4) if (a8[k] > FILL_TOL) m[i] = 0;
    }
  }
  // 色の付いた所を塗り替えるときの判定表: seed と各成分の差が許容差以内なら塗れる（描いた範囲の外は透明なので塗れない）
  function maskColor(m, W, data, gx, gy, gw, gh, seed) {
    const TL = FILL_TOL, tr = seed & 255, tg = (seed >>> 8) & 255, tb = (seed >>> 16) & 255, ta = seed >>> 24;
    for (let y = 0; y < gh; y++) {
      for (let x = 0, i = (gy + y) * W + gx, j = y * gw; x < gw; x++, i++, j++) {
        const c = data[j];
        if (c === seed) { m[i] = 1; continue; }
        const d1 = (c & 255) - tr, d2 = ((c >>> 8) & 255) - tg, d3 = ((c >>> 16) & 255) - tb, d4 = (c >>> 24) - ta;
        m[i] = d1 <= TL && d1 >= -TL && d2 <= TL && d2 >= -TL && d3 <= TL && d3 >= -TL && d4 <= TL && d4 >= -TL ? 1 : 0;
      }
    }
  }
  // 判定表 m の (sx0, sy0) から塗れる所をスキャンライン法でたどり、各スパンを g だけ膨張させた矩形を path に足す。
  // 画素を ImageData に書いて転送する代わりに、矩形のパスにして GPU で 1 回で塗るため。
  // 膨張分も画面（W × H）の中に収める（画面の外へ 1px はみ出すと履歴の範囲 R から漏れ、元に戻しても細い線が残る）。
  // 塗ったスパンの範囲 [x0, y0, x1, y1] を返す
  function scanFill(m, W, H, sx0, sy0, g, path) {
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
      const rx = max(0, lx - g), ry = max(0, y - g);
      path.rect(rx, ry, min(W, x + g) - rx, min(H, y + 1 + g) - ry);
      if (lx < fx0) fx0 = lx;
      if (x - 1 > fx1) fx1 = x - 1;
      if (y < fy0) fy0 = y;
      if (y > fy1) fy1 = y;
    }
    return [fx0, fy0, fx1, fy1];
  }

  // ---------- 選択（範囲の画素を浮かせ、移動・拡大縮小する） ----------
  // 浮かせた中身は面の中の canvas に置き、枠の位置と大きさだけを変えて見せる（動かしている間は描き直さない）。
  // 浮かせる時に元の範囲を面から消し、確定で「元の範囲」と「置いた範囲」を 1 手として積む
  // 枠（b）は中身より少し外に出し、どの向きも最低 SEL_MIN にする（細い線でも移動とつまみを押し分けられる）
  const SEL_MIN = 24;
  // 浮かせた画素（selC）と選んだ文字の物は入れ物（selIn）に入れ、入れ物の transform で一緒に拡大縮小する
  const selEl = el('div', 'sel'), selIn = el('div', 'si'), selC = el('canvas'), selB = el('b');
  selIn.append(selC);
  selEl.append(selIn, selB);
  const selT = []; // 選んだ文字の物と、選んだ時の状態の組
  let bX0 = 0, bY0 = 0, bW0 = 1, bH0 = 1; // 選んだ時の枠（S）
  // つまみの位置（枠に対する割合）: 左上・上・右上・右・右下・下・左下・左
  const HND = [0, 0, 0.5, 0, 1, 0, 1, 0.5, 1, 1, 0.5, 1, 0, 1, 0, 0.5];
  const HCUR = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'];
  for (let i = 0; i < 16; i += 2) {
    const h = el('i');
    h.style.left = HND[i] * 100 + '%';
    h.style.top = HND[i + 1] * 100 + '%';
    selB.append(h);
  }
  let sel = false, selHint = false, sDrag = 0, sH = 0, sWas = false, hoverCur = '', toolCur = '';
  let selX = 0, selY = 0, selW = 0, selH = 0;     // 今の枠（S、小数のまま持つ）
  let srcX = 0, srcY = 0, srcW = 0, srcH = 0;     // 浮かせた元の範囲（S、整数）
  let dragX = 0, dragY = 0, begX = 0, begY = 0, begW = 0, begH = 0; // ドラッグ開始時のポインタと枠
  // 面や履歴を変える操作の前に、入力中の文字と浮いている選択を確定する
  function settle() {
    commitText();
    dropSel();
  }
  // 枠が中身から外へ出る量（S）。囲んでいる途中は出さない
  const padX = () => max(3 * sdpr, (SEL_MIN * sdpr - selW) / 2);
  const padY = () => max(3 * sdpr, (SEL_MIN * sdpr - selH) / 2);
  // 囲んでいる間の枠: 描いている途中の線と同じ live（低遅延の canvas）に描く。DOM の枠より 1 フレームほど早く画面に出るので、
  // 押してすぐ、少し動かしただけでも出す（クリックか囲むかは、離したときに 3px で決める）。入力ごとに呼ぶので割り当てをしない
  let bdX = 0, bdY = 0, bdW = 0, bdH = 0;
  const BAND_DASH = [0, 0], NO_DASH = [];
  function drawBand() {
    const c = lctx, lw = max(1, round(dpr));
    if (bdW) c.clearRect(bdX, bdY, bdW, bdH);
    const x0 = round((selX - sox) / sk), y0 = round((selY - soy) / sk);
    const w = max(lw, round((selX + selW - sox) / sk) - x0), h = max(lw, round((selY + selH - soy) / sk) - y0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.fillStyle = '#3d7cff14';
    c.fillRect(x0, y0, w, h);
    BAND_DASH[0] = BAND_DASH[1] = 3 * lw;
    c.setLineDash(BAND_DASH);
    c.lineWidth = lw;
    c.strokeStyle = '#3d7cff';
    c.strokeRect(x0 + lw / 2, y0 + lw / 2, w - lw, h - lw);
    c.setLineDash(NO_DASH);
    bdX = x0 - 1; bdY = y0 - 1; bdW = w + 2; bdH = h + 2;
  }
  function showSel() {
    const st = selEl.style, bs = selB.style, px = -padX() / sdpr + 'px', py = -padY() / sdpr + 'px';
    st.left = selX / sdpr + 'px';
    st.top = selY / sdpr + 'px';
    st.width = selW / sdpr + 'px';
    st.height = selH / sdpr + 'px';
    bs.left = bs.right = px;
    bs.top = bs.bottom = py;
    selIn.style.transform = `scale(${selW / bW0},${selH / bH0})`;
    if (!selEl.parentNode) sbox.append(selEl);
  }
  // S の矩形の中の描いた物を浮かせる。withTexts なら、矩形に収まる文字の物も一緒に選ぶ。何もなければ false
  function liftSel(x, y, w, h, withTexts) {
    liftRaster(x, y, w, h);
    const T = [];
    if (withTexts) for (const o of tlist) if (o.x >= x && o.y >= y && o.x + o.w <= x + w && o.y + o.h <= y + h) T.push(o);
    return beginSel(T);
  }
  // 矩形の中の画素を selC へ浮かせ、面から消す。範囲は中身の外接矩形に詰める（何もなければ srcW = 0）
  function liftRaster(x, y, w, h) {
    srcW = srcH = 0;
    // 描いた範囲の外は透明と分かっているので、重なる所だけを 1 回で読む
    const ax = max(0, x, cbx0), ay = max(0, y, cby0), ex = min(x + w, cbx1), ey = min(y + h, cby1);
    if (cbx1 <= cbx0 || ex <= ax || ey <= ay) return;
    const gw = ex - ax, gh = ey - ay, rc = gather(rect1(ax, ay, gw, gh), newCanvas(gw, gh));
    const d = new Uint32Array(rc.getContext('2d').getImageData(0, 0, gw, gh).data.buffer);
    let bx0 = gw, by0 = -1, bx1 = -1, by1 = -1;
    for (let j = 0, i = 0; j < gh; j++, i += gw) {
      let a = 0, b = gw - 1;
      while (a < gw && !(d[i + a] >>> 24)) a++;
      if (a === gw) continue;
      while (!(d[i + b] >>> 24)) b--;
      if (a < bx0) bx0 = a;
      if (b > bx1) bx1 = b;
      if (by0 < 0) by0 = j;
      by1 = j;
    }
    if (by0 >= 0) {
      srcX = ax + bx0; srcY = ay + by0; srcW = bx1 - bx0 + 1; srcH = by1 - by0 + 1;
      selC.width = srcW;
      selC.height = srcH;
      selC.getContext('2d').drawImage(rc, bx0, by0, srcW, srcH, 0, 0, srcW, srcH);
      forTiles(srcX, srcY, srcW, srcH, false, (t, ox, oy, ix, iy, iw, ih) => t.x.clearRect(ix - ox, iy - oy, iw, ih));
    }
    rc.width = rc.height = 0;
  }
  // 浮かせた画素（あれば）と文字の物 T をまとめて選ぶ。枠は全部の外接矩形
  function beginSel(T) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    if (srcW) { x0 = srcX; y0 = srcY; x1 = srcX + srcW; y1 = srcY + srcH; }
    for (const o of T) { x0 = min(x0, o.x); y0 = min(y0, o.y); x1 = max(x1, o.x + o.w); y1 = max(y1, o.y + o.h); }
    if (x1 <= x0 || y1 <= y0) return false;
    bX0 = x0; bY0 = y0; bW0 = x1 - x0; bH0 = y1 - y0;
    const cs = selC.style, is = selIn.style;
    cs.display = srcW ? '' : 'none';
    cs.left = (srcX - bX0) / sdpr + 'px';
    cs.top = (srcY - bY0) / sdpr + 'px';
    cs.width = srcW / sdpr + 'px';
    cs.height = srcH / sdpr + 'px';
    is.width = bW0 / sdpr + 'px';
    is.height = bH0 / sdpr + 'px';
    selT.length = 0;
    for (const o of T) {
      selT.push([o, tSnap(o)]);
      o.el.style.left = (o.x - bX0) / sdpr + 'px';
      o.el.style.top = (o.y - bY0) / sdpr + 'px';
      selIn.append(o.el);
    }
    // 文字だけのときは辺のつまみを出さず、拡大縮小は常に比を保つ
    selEl.classList.toggle('only', !srcW);
    selX = bX0; selY = bY0; selW = bW0; selH = bH0;
    sel = true;
    showSel();
    if (!selHint) { selHint = true; say('ドラッグで移動 ・ 角で拡大縮小 ・ Delete で削除 ・ Esc で確定', 3000); }
    return true;
  }
  // 浮かせた中身を今の枠に描き込み、文字の物を枠に合わせて動かす。del なら置かずに消す。
  // 何も変わっていなければ元に戻すだけで、履歴は増やさない。変わっていれば 1 手として積む
  function dropSel(del) {
    if (!sel) return;
    sel = false;
    selEl.remove();
    updateCursor();
    const sx = selW / bW0, sy = selH / bH0, k = sqrt(sx * sy);
    const dx = round(selX + (srcX - bX0) * sx), dy = round(selY + (srcY - bY0) * sy);
    const dw = max(1, round(srcW * sx)), dh = max(1, round(srcH * sy));
    let changed = !!del || (srcW > 0 && (dx !== srcX || dy !== srcY || dw !== srcW || dh !== srcH));
    // 文字は CSS px の整数に丸めた位置と大きさにする（拡大縮小しても描き直すのでぼやけない）
    const next = selT.map(([o, st0]) => {
      const st = del ? null : [o.s, round((selX + (o.x - bX0) * sx) / sdpr) * sdpr, round((selY + (o.y - bY0) * sy) / sdpr) * sdpr,
        max(4, round(o.fs / sdpr * k)) * sdpr, o.c, o.a];
      if (st && !sameSt(st, st0)) changed = true;
      return st;
    });
    if (!changed) {
      if (srcW) paintSel(srcX, srcY, srcW, srcH);
      for (const p of selT) tApply(p[0], p[1]);
    } else {
      let R = [], atlas = null;
      if (srcW) {
        R = del ? rect1(srcX, srcY, srcW, srcH) : [srcX, srcY, srcW, srcH, 0, 0, dx, dy, dw, dh, 0, 0];
        atlas = gather(R, pack(R));
        const c = atlas.getContext('2d');
        // 保存する画素は「浮かせる前」にそろえる。元の範囲は今は空なので、中身を元の位置に重ねれば戻る
        for (let i = 0; i < R.length; i += 6) {
          c.save();
          c.beginPath();
          c.rect(R[i + 4], R[i + 5], R[i + 2], R[i + 3]);
          c.clip();
          c.drawImage(selC, R[i + 4] + srcX - R[i], R[i + 5] + srcY - R[i + 1]);
          c.restore();
        }
        if (!del) paintSel(dx, dy, dw, dh);
      }
      const P = selT.map(p => [p[0], p[1]]);
      for (let i = 0; i < selT.length; i++) tApply(selT[i][0], next[i]);
      push(R, atlas, srcW && !del ? [dx, dy, dx + dw, dy + dh] : null, P.length ? P : null);
    }
    selT.length = 0;
    selC.width = selC.height = 0;
  }
  function paintSel(x, y, w, h) {
    sizeSurface();
    forTiles(x, y, w, h, true, (t, ox, oy, ix, iy, iw, ih) => {
      const g = t.x;
      g.save();
      g.beginPath();
      g.rect(ix - ox, iy - oy, iw, ih);
      g.clip();
      g.imageSmoothingQuality = 'high';
      g.drawImage(selC, x - ox, y - oy, w, h);
      g.restore();
    });
  }
  // 枠のどこか: 0〜7 つまみ / -1 枠の中 / -2 外。枠の内側はつまみより移動を優先する（小さい枠は全部つまみ）
  function selHit(X, Y) {
    const r = 8 * sdpr, px = padX(), py = padY();
    const fx = selX - px, fy = selY - py, fw = selW + 2 * px, fh = selH + 2 * py;
    if (X > fx + r && X < fx + fw - r && Y > fy + r && Y < fy + fh - r) return -1;
    for (let i = 0; i < 16; i += 2) {
      if (!srcW && i % 4) continue; // 文字だけのときは角のつまみだけ
      if (abs(X - fx - HND[i] * fw) <= r && abs(Y - fy - HND[i + 1] * fh) <= r) return i / 2;
    }
    return X >= fx && X <= fx + fw && Y >= fy && Y <= fy + fh ? -1 : -2;
  }
  // ポインタの下が枠のつまみ・枠の中・文字なら、それに合ったカーソルにする（それ以外は道具のカーソル）
  function selHover(e) {
    mapNow(); // 最後に押してからスクロールしているかもしれないので、画面と面の対応を今の位置で求め直す
    const X = e.clientX * sdpr + sox, Y = e.clientY * sdpr + soy, k = sel ? selHit(X, Y) : -2;
    const c = k >= 0 ? HCUR[k] : k === -1 || textHit(X, Y) ? 'move' : toolCur;
    if (c !== hoverCur) { hoverCur = c; pad.style.cursor = c; }
  }
  function selDown(e, X, Y) {
    let hit = sel ? selHit(X, Y) : -2;
    sWas = hit !== -2;
    if (hit === -2) {
      dropSel();
      // 文字の物は押したらそのまま選び、同じドラッグで動かせる
      const o = textHit(X, Y);
      if (o) { srcW = srcH = 0; beginSel([o]); hit = -1; }
    }
    act = e.pointerId; aType = e.pointerType; mode = 4;
    try { pad.setPointerCapture(act); } catch (_) { }
    dragX = X; dragY = Y; begX = selX; begY = selY; begW = selW; begH = selH;
    if (hit === -1) sDrag = 2;
    else if (hit >= 0) { sDrag = 3; sH = hit; }
    else { sDrag = 1; selX = X; selY = Y; selW = selH = 0; }
  }
  function selMove(e) {
    const X = e.clientX * sdpr + sox, Y = e.clientY * sdpr + soy;
    if (sDrag === 1) {
      selX = min(dragX, X); selY = min(dragY, Y); selW = abs(X - dragX); selH = abs(Y - dragY);
      drawBand();
    } else if (sDrag === 2) {
      selX = max(0, begX + X - dragX);
      selY = max(0, begY + Y - dragY);
      showSel();
    } else if (sDrag === 3) {
      scaleSel(X, Y, e.shiftKey);
      showSel();
    }
  }
  // つまみの反対側を固定し、押した所からの移動量だけ伸び縮みさせる。角は縦横比を保つ（free なら保たない）。
  // 比を保つ倍率は (w, h) を (begW, begH) の向きへ射影して求める（細長い物でも少しの縦の動きで暴れない）。裏返しにはしない
  function scaleSel(X, Y, free) {
    if (!srcW) free = false;
    const hx = HND[sH * 2], hy = HND[sH * 2 + 1], m = 2 * sdpr, dX = X - dragX, dY = Y - dragY;
    const fx = begX + (1 - hx) * begW, fy = begY + (1 - hy) * begH;
    let w = hx === 0.5 ? begW : max(m, hx ? begW + dX : begW - dX);
    let h = hy === 0.5 ? begH : max(m, hy ? begH + dY : begH - dY);
    if (hx !== 0.5 && hy !== 0.5 && !free) {
      const k = (w * begW + h * begH) / (begW * begW + begH * begH);
      w = max(m, begW * k); h = max(m, begH * k);
    }
    selX = hx === 0.5 ? begX : hx ? fx : fx - w;
    selY = hy === 0.5 ? begY : hy ? fy : fy - h;
    if (selX < 0) { w += selX; selX = 0; }
    if (selY < 0) { h += selY; selY = 0; }
    selW = w; selH = h;
  }
  function selUp() {
    if (sDrag === 1) {
      // live の枠は、選択の枠（DOM）が画面に出る 2 フレーム後に消す（確定の受け渡しと同じ。消してから出るまでの 1 フレームに何も見えなくならないように）
      if (bdW) {
        hcx = bdX; hcy = bdY; hcw = bdW; hch = bdH; bdW = 0;
        handoff = requestAnimationFrame(() => { handoff = requestAnimationFrame(finishHandoff); });
      }
      if (selW > 3 * sdpr || selH > 3 * sdpr) {
        const x = floor(selX), y = floor(selY);
        liftSel(x, y, ceil(selX + selW) - x, ceil(selY + selH) - y, true);
      } else pickSel(dragX, dragY);
    } else if (sDrag === 2 && sWas && !srcW && selT.length === 1 && selX === begX && selY === begY) {
      // 選んでいる文字をもう一度押して、動かさずに離した: 書き直す（ダブルクリックもこれになる）
      const o = selT[0][0];
      sDrag = 0;
      dropSel();
      editText(o);
      return;
    }
    sDrag = 0;
  }
  function selAbort() {
    if (sDrag === 1) { if (bdW) lctx.clearRect(bdX, bdY, bdW, bdH); bdW = 0; }
    else { selX = begX; selY = begY; selW = begW; selH = begH; showSel(); }
    sDrag = 0;
  }
  // クリック: その場所に描いた画素がある手のうち、外接矩形がいちばん小さい物を選ぶ
  // （丸で囲んだ文字をクリックすると、丸ではなく文字が選ばれる）
  function pickSel(X, Y) {
    const r = round(3 * sdpr), n = 2 * r + 1, x = floor(X) - r, y = floor(Y) - r;
    const rc = gather(rect1(x, y, n, n), newCanvas(n, n)), d = rc.getContext('2d').getImageData(0, 0, n, n).data;
    rc.width = rc.height = 0;
    let ink = false;
    for (let i = 3; i < d.length && !ink; i += 4) ink = d[i] > 0;
    if (!ink) return;
    let best = null, ba = Infinity;
    for (let i = 0; i < hpos; i++) {
      const b = hist[i].b;
      if (!b || X < b[0] - r || X > b[2] + r || Y < b[1] - r || Y > b[3] + r) continue;
      const a = (b[2] - b[0]) * (b[3] - b[1]);
      if (a <= ba) { ba = a; best = b; }
    }
    if (best) liftSel(best[0] - r, best[1] - r, best[2] - best[0] + 2 * r, best[3] - best[1] + 2 * r, false);
  }
  function nudgeSel(k, step) {
    const d = step * sdpr;
    if (k === 'ArrowLeft') selX = max(0, selX - d);
    else if (k === 'ArrowRight') selX += d;
    else if (k === 'ArrowUp') selY = max(0, selY - d);
    else selY += d;
    showSel();
  }

  // ---------- 文字（入力中は本物の textarea を重ねるので IME がそのまま使える） ----------
  // 確定した文字は「物」として面の中の要素（.to）に置く。あとから選んで動かす・拡大縮小・書き直しができ、拡大してもぼやけない。
  // 物の状態は [文字, x, y, 大きさ, 色, 濃さ]（x, y は行の箱の左上、大きさは文字の高さ。どれも S の px で、CSS px の整数に丸める）
  let ta = null, taX = 0, taCY = 0, taObj = null, mctx = null;
  let taFs = 24, taC = '', taA = 1; // 入力欄の書式（大きさは CSS px）。新しい文字は今の設定、書き直しはその物の書式
  const tlist = []; // 面に置いている文字の物（重なり順。後ろほど手前）
  let tHit = 0, tShown = 0; // 消しゴムが触れた文字の数と、薄く表示した数
  // 入力欄のキーや文字はページへ渡さない（ページのショートカットやフォーカス管理が反応しないように）
  const TA_STOP = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'compositionstart', 'compositionupdate',
    'compositionend', 'paste', 'copy', 'cut', 'focusin', 'focusout'];
  const tNew = () => ({ el: el('div', 'to'), s: '', x: 0, y: 0, fs: 0, c: '', a: 1, w: 0, h: 0, on: false, hit: 0 });
  const tSnap = o => [o.s, o.x, o.y, o.fs, o.c, o.a];
  const sameSt = (p, q) => p[0] === q[0] && p[1] === q[1] && p[2] === q[2] && p[3] === q[3] && p[4] === q[4] && p[5] === q[5];
  // 物を状態 st にする（null なら面から外す）
  function tApply(o, st) {
    if (!st) {
      if (o.on) { o.el.remove(); tlist.splice(tlist.indexOf(o), 1); o.on = false; }
      return;
    }
    [o.s, o.x, o.y, o.fs, o.c, o.a] = st;
    const e = o.el, es = e.style;
    e.textContent = o.s;
    es.left = o.x / sdpr + 'px';
    es.top = o.y / sdpr + 'px';
    es.setProperty('--fs', o.fs / sdpr + 'px');
    es.setProperty('--c', o.c);
    es.setProperty('--a', o.a);
    if (!o.on) { tlist.push(o); o.on = true; }
    if (e.parentNode !== sbox) sbox.append(e);
    o.w = e.offsetWidth * sdpr;
    o.h = e.offsetHeight * sdpr;
  }
  // 履歴の手の文字の物を、今の状態と保存した状態で入れ替える（undo と redo で同じ処理）
  function swapText(h) {
    for (const p of h.t) {
      const cur = p[0].on ? tSnap(p[0]) : null;
      tApply(p[0], p[1]);
      p[1] = cur;
    }
  }
  // S の点にある、いちばん手前の文字の物
  function textHit(X, Y) {
    const r = 3 * sdpr;
    for (let i = tlist.length - 1; i >= 0; i--) {
      const o = tlist[i];
      if (X >= o.x - r && X <= o.x + o.w + r && Y >= o.y - r && Y <= o.y + o.h + r) return o;
    }
    return null;
  }
  // 書き出し用に、文字の物を S の px で描く。表示（CSS の行の中央寄せ）と同じ基線にする
  function paintText(g, o, X, Y) {
    const css = o.fs / sdpr;
    if (!mctx) mctx = newCanvas(1, 1).getContext('2d');
    mctx.font = `600 ${css}px ${FONT}`; // レイアウトは CSS px の書体の寸法で決まる
    const m = mctx.measureText('Hg');
    const A = round(m.fontBoundingBoxAscent || css * 0.8), D = round(m.fontBoundingBoxDescent || css * 0.2);
    const base = (o.y / sdpr + floor((css * LH - A - D) / 2) + A) * sdpr - Y, lines = o.s.split('\n');
    g.save();
    g.globalAlpha = o.a;
    g.fillStyle = o.c;
    g.font = `600 ${o.fs}px ${FONT}`;
    g.textBaseline = 'alphabetic';
    for (let i = 0; i < lines.length; i++) g.fillText(lines[i], o.x - X, base + i * o.fs * LH);
    g.restore();
  }
  // 消しゴムの線分（V）が触れた文字に印を付ける。入力のたびに呼ばれるので、割り当てのない計算だけにする
  let lbA = 0, lbB = 1;
  function lbEdge(p, q) {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > lbB) return false; if (r > lbA) lbA = r; }
    else { if (r < lbA) return false; if (r < lbB) lbB = r; }
    return true;
  }
  function eraseText(ax, ay, bx, by, rad) {
    const x0 = ax * sk + sox, y0 = ay * sk + soy, dx = (bx - ax) * sk, dy = (by - ay) * sk, r = rad * sk;
    for (let i = 0; i < tlist.length; i++) {
      const o = tlist[i];
      if (o.hit) continue;
      lbA = 0; lbB = 1;
      if (lbEdge(-dx, x0 - o.x + r) && lbEdge(dx, o.x + o.w + r - x0) && lbEdge(-dy, y0 - o.y + r) && lbEdge(dy, o.y + o.h + r - y0)) {
        o.hit = 1;
        tHit++;
      }
    }
  }
  // 触れた文字を薄く見せる（tick から 1 フレームに 1 回）
  function showErased() {
    for (let i = 0; i < tlist.length; i++) tlist[i].el.classList.toggle('gone', !!tlist[i].hit);
    tShown = tHit;
  }
  // 消しゴムを離した: 触れた文字を外し、履歴用の組を返す。abort なら印を消すだけ
  function takeErased(abort) {
    if (!tHit) return null;
    const P = [];
    for (let i = 0; i < tlist.length; i++) {
      const o = tlist[i];
      if (o.hit) { o.hit = 0; o.el.classList.remove('gone'); P.push([o, tSnap(o)]); }
    }
    tHit = tShown = 0;
    if (abort) return null;
    for (const p of P) tApply(p[0], null);
    return P;
  }

  function textAt(cx, cy, value) {
    if (!value) { taFs = CFG.text.size; taC = color; taA = CFG.text.alpha; }
    ta = el('textarea', 'tx', { spellcheck: 'false', wrap: 'off', rows: '1', 'aria-label': '文字' });
    taX = cx; taCY = cy; // クリックした点が 1 行目の高さの中央になるように置く
    for (const t of TA_STOP) ta.addEventListener(t, stop);
    ta.addEventListener('input', updateGhost);
    // 日本語入力の変換中も枠を合わせる（変換中の文字で input が来ない環境でも、枠の外にはみ出さないように。T-099）
    ta.addEventListener('compositionupdate', updateGhost);
    ta.addEventListener('compositionend', updateGhost);
    ta.addEventListener('keyup', updateGhost);
    ta.addEventListener('pointerup', updateGhost);
    ta.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229) return;
      // Tab: 電卓の答えを書き込む。答えがなくても、入力欄からフォーカスは外さない
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        acceptGhost();
        return;
      }
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        commitText();
        wrap.focus({ preventScroll: true });
      }
    });
    if (value) ta.value = value;
    bar.before(ta); // ツールバーの前に置く（後に置くと、開いたパネルより手前に出る。T-092）
    styleTa();
    ta.focus({ preventScroll: true });
    if (value) ta.setSelectionRange(value.length, value.length);
  }
  // 確定した文字を書き直す: その物の書式のまま同じ位置に入力欄を出す（物はその間だけ隠す）。道具と今の色は変えない
  function editText(o) {
    settle();
    mapNow();
    taObj = o;
    o.el.classList.add('ed');
    taFs = o.fs / sdpr; taC = o.c; taA = o.a;
    textAt((o.x - sox) / sdpr, (o.y - soy) / sdpr + taFs * LH / 2, o.s);
  }
  function styleTa() {
    const s = ta.style;
    s.setProperty('--c', taC);
    s.setProperty('--a', taA);
    s.setProperty('--fs', taFs + 'px');
    // 余白の分だけ外へずらすので、文字の位置と点線の枠の見た目は変わらない
    s.left = taX - TA_PAD + 'px';
    s.top = taCY - taFs * LH / 2 - TA_PAD + 'px';
    updateGhost();
  }
  // 中身に合わせて入力欄を広げる（折り返さない。改行でだけ行が増える）
  // 余白が scrollWidth に入るかはブラウザで違う（Chrome は左だけ）ので、測る間だけ余白を外す。
  // 空のときは中身の大きさが 0 になるので、少なくとも 1 行・全角 1 文字分の大きさにする（1 文字目で枠が跳ねない）。
  // 電卓の薄い答えが出ている間は、答えの右端まで広げる（点線の枠で答えも囲む。Tab で書き込んでも枠の大きさが変わらない）
  function fitTa() {
    const s = ta.style;
    s.padding = '0';
    // 0 ではなく 1px にして測る。中身が改行だけ（字が 1 つもない）のとき、幅 0 の textarea は scrollHeight が 0 になり、枠が 1 行のままだった（T-099）
    s.width = s.height = '1px';
    const w = max(ta.scrollWidth, ceil(taFs), ghostR) + 2, h = max(ta.scrollHeight, round(taFs * LH));
    s.padding = '';
    s.width = w + 'px';
    s.height = h + 'px';
  }
  // ---- 電卓: カーソルのある行が計算式なら、行の後ろに答えを薄く出す。Tab で書き込む ----
  // 入力欄の大きさ（fitTa）もここで合わせる。答えの右端（ghostR、行の頭からの CSS px）まで枠を広げるため
  const ghostEl = el('div', 'gh');
  let ghostTxt = '', ghostEnd = 0, ghostR = 0, mta = null;
  // 1 行の幅を、入力欄と同じ測り方（見えない入力欄の scrollWidth）で測る。答えの位置と枠の幅が、Tab で書き込んだ後の入力欄とそろう
  // （canvas の measureText や span は、書体によって「*」などの組み方が入力欄と変わり、数 px ずれた）。測る間だけ置いて外す
  function lineW(t) {
    if (!mta) {
      mta = el('textarea', 'tx', { 'aria-hidden': 'true', wrap: 'off', rows: '1' });
      const s = mta.style;
      s.visibility = 'hidden';
      s.padding = '0';
      s.width = s.height = '0';
    }
    mta.style.setProperty('--fs', taFs + 'px');
    mta.value = t;
    bar.before(mta);
    const w = mta.scrollWidth;
    mta.remove();
    return w;
  }
  function updateGhost() {
    ghostTxt = '';
    ghostR = 0;
    if (ta && (calc || cp2)) { // CP2 は電卓がいつも入り
      const v = ta.value, p = ta.selectionEnd, a = v.lastIndexOf('\n', p - 1) + 1, b = v.indexOf('\n', p), end = b < 0 ? v.length : b;
      const line = v.slice(a, end), r = calcLine(line);
      if (r) {
        ghostTxt = r;
        ghostEnd = end;
        const s = ghostEl.style, row = v.slice(0, a).split('\n').length - 1;
        ghostEl.textContent = r;
        ghostR = lineW(line + r);
        s.setProperty('--c', taC);
        s.setProperty('--a', taA);
        s.setProperty('--fs', taFs + 'px');
        s.left = taX + lineW(line) + 'px';
        s.top = taCY - taFs * LH / 2 + row * taFs * LH + 'px';
        if (!ghostEl.parentNode) bar.before(ghostEl); // 入力欄と同じく、ツールバーとパネルの下（T-092）
      }
    }
    if (!ghostTxt) ghostEl.remove();
    if (ta) fitTa();
  }
  function acceptGhost() {
    if (!ghostTxt) return;
    const t = ghostTxt;
    ta.setSelectionRange(ghostEnd, ghostEnd);
    // execCommand なら入力欄の元に戻す（Ctrl+Z）で書き込みを取り消せる。使えないブラウザでは setRangeText
    let ok = false;
    try { ok = doc.execCommand('insertText', false, t); } catch (_) { }
    if (!ok) { ta.setRangeText(t, ghostEnd, ghostEnd, 'end'); updateGhost(); }
  }
  // 1 行の計算式を計算して、薄く出す文字（「 = 36」か「=36」、行が = で終わっていれば「36」か「 36」）を返す。式でなければ ''。
  // eval は使わない（CSP で止まるページがあり、安全のためにも）。かけ算・わり算が先、^ は右から、% は百分率
  function calcLine(src) {
    let s = src.normalize('NFKC').replace(/[×✕]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-').replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
    // 空白は式の書き方に合わせる: 演算子か = の前後に空白があれば空白を入れ、詰めて書いた式なら詰める。
    // 最後に自分で打った空白には重ねない（= の前に打った空白は、空白を入れる書き方とみなす）
    const eq = /=\s*$/.test(s), tw = /\s$/.test(s), sp = tw && !eq || /\s[+\-*/^%=]|[+\-*/^=]\s/.test(s.trim());
    if (eq) s = s.replace(/=\s*$/, '');
    // 数字の後ろに演算子が 1 つ以上ある行だけを式とみなす（「12」や「-5」だけでは出さない）
    if (!/^[\d\s+\-*/^%().]+$/.test(s) || !/\d\s*[%)]*\s*[+\-*/^%]/.test(s)) return '';
    let i = 0;
    const peek = () => { while (s[i] === ' ') i++; return s[i]; };
    const expr = () => {
      let v = term();
      for (;;) {
        const c = peek();
        if (c === '+') { i++; v += term(); } else if (c === '-') { i++; v -= term(); } else return v;
      }
    };
    const term = () => {
      let v = unary();
      for (;;) {
        const c = peek();
        if (c === '*') { i++; v *= unary(); } else if (c === '/') { i++; v /= unary(); } else return v;
      }
    };
    const unary = () => {
      const c = peek();
      if (c === '-') { i++; return -unary(); }
      if (c === '+') { i++; return unary(); }
      const b = post();
      if (peek() === '^') { i++; return b ** unary(); }
      return b;
    };
    const post = () => {
      let v = atom();
      while (peek() === '%') { i++; v /= 100; }
      return v;
    };
    const atom = () => {
      if (peek() === '(') {
        i++;
        const v = expr();
        if (peek() !== ')') throw 0;
        i++;
        return v;
      }
      const m = /^(\d+(\.\d*)?|\.\d+)/.exec(s.slice(i));
      if (!m) throw 0;
      i += m[0].length;
      return +m[0];
    };
    let v;
    try { v = expr(); } catch (_) { return ''; }
    if (peek() !== undefined || !isFinite(v)) return '';
    const r = String(+v.toPrecision(12) || 0);
    return eq ? (sp && !tw ? ' ' : '') + r : sp ? (tw ? '= ' : ' = ') + r : '=' + r;
  }

  // 入力欄の中身を文字の物として面に置く（書き直しなら物を更新し、空なら消す）。1 手として履歴に積む
  function commitText() {
    if (!ta) return;
    const e = ta, v = e.value.replace(/\s+$/, ''), o = taObj;
    ta = taObj = null;
    e.remove();
    ghostEl.remove();
    if (o) o.el.classList.remove('ed');
    mapNow();
    sizeSurface();
    const st = [v, round(taX + sox / sdpr) * sdpr, round(taCY - taFs * LH / 2 + soy / sdpr) * sdpr,
      max(4, round(taFs)) * sdpr, taC, taA];
    if (o) {
      const prev = tSnap(o);
      if (v && sameSt(prev, st)) return;
      tApply(o, v ? st : null);
      push([], null, null, [[o, prev]]);
    } else if (v) {
      const n = tNew();
      tApply(n, st);
      push([], null, null, [[n, null]]);
    }
  }

  // ---------- 書き出し ----------
  // 面のうち、画面の (x, y, w, h)（CSS px）に見えている範囲を 1 枚のキャンバスに写す
  function capture(x, y, w, h, opts) {
    const [ox, oy] = origin(), X = round(x * sdpr) + ox, Y = round(y * sdpr) + oy;
    const cw = max(1, round(w * sdpr)), ch = max(1, round(h * sdpr));
    const c = newCanvas(cw, ch), cx = c.getContext('2d', opts);
    forTiles(X, Y, cw, ch, false, (t, tox, toy, ix, iy, iw, ih) =>
      cx.drawImage(t.c, ix - tox, iy - toy, iw, ih, ix - X, iy - Y, iw, ih));
    // 文字の物は線より手前にあるので、あとから重ねる
    for (const o of tlist) if (o.x < X + cw && o.y < Y + ch && o.x + o.w > X && o.y + o.h > Y) paintText(cx, o, X, Y);
    return [c, cx];
  }
  function exportBlob() {
    settle();
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
  function download(b, name) {
    const a = el('a', null, { download: name });
    const url = URL.createObjectURL(b);
    a.href = url;
    wrap.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function save() {
    exportBlob().then(b => {
      download(b, `paint-${stamp()}.png`);
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

  // ---------- 操作の一覧（? で出す） ----------
  // {…} はキー。build.mjs がこの配列（目印の間は JSON）を読んで、インストールページにも同じ一覧を書き出す。
  // 3 つ目が 'touch' の行は、文字に触れる（touchText）が入りのときだけツールの中に出す
  const HELP = /*HELP*/[
    ["道具", [
      ["{S}", "選択。囲むか押して選び、引くと移動、角で拡大縮小、{Delete} で削除、矢印で 1px（{Shift} で 10px）"],
      ["{P}", "ペン（筆圧対応）"],
      ["{H}", "蛍光ペン"],
      ["{E}", "消しゴム（右クリック・ペンの消しゴム側でも）"],
      ["{L} {A} {R} {O}", "直線・矢印・四角形・楕円"],
      ["{T}", "文字（日本語入力対応）"],
      ["{F}", "塗りつぶし"],
      ["{I}", "スポイト（対応するブラウザで）"]
    ]],
    ["色と太さ", [
      ["{1}〜{8}", "色を選ぶ"],
      ["{[} {]}", "太さ"],
      ["{Shift}", "図形を 45° 刻み・正方形・正円に"],
      ["{Alt}", "図形を中心から描く"]
    ]],
    ["編集", [
      ["{Ctrl}+{Z}", "元に戻す"],
      ["{Ctrl}+{Y}", "やり直す（{Ctrl}+{Shift}+{Z} でも）"],
      ["{Delete}", "全消去（元に戻せる）"],
      ["{Ctrl}+{S}", "PNG で保存"]
    ]],
    ["表示", [
      ["{V}", "ページ操作モード（ツールを選ぶと描画に戻る）", "main"],
      ["{B}", "背景を透明・白・黒に"],
      ["{D}", "計測表示"],
      ["{?}", "この一覧"],
      ["{Esc}", "隠す（ブックマークレットで再表示）"]
    ]],
    ["ボタンと文字", [
      ["ペン・図形をもう一度", "ペンの種類（万年筆・筆・鉛筆）や図形を選ぶ"],
      ["文字を押す", "ペンなどのままでも選んで動かせる。もう一度押すと書き直し", "touch"],
      ["文字の入力中", "{Esc}・{Ctrl}+{Enter}・外を押すと確定"],
      ["{Tab}", "電卓が入りのとき、薄く出た答えを書き込む"],
      ["ツールバー", "どこを押しても、引けば動かせる"],
      ["その他（⋯）", "全消去・背景・保存・コピー・電卓・画面に固定（スクロールしても絵が画面に留まる）・デフォルトの変更（インストールページを開く）"]
    ]]
  ]/*HELP*/;
  // 一覧は初めて開いたときに作る。開いている間は、外を押すと閉じるだけ（線は描かない）
  const helpEl = el('div', 'hp');
  let helpOn = false;
  const rich = (p, s) => s.split(/\{([^}]*)\}/).forEach((t, i) => {
    if (!t) return;
    if (i % 2) { const k = el('kbd'); k.textContent = IS_MAC && t === 'Ctrl' ? '⌘' : t; p.append(k); }
    else p.append(t);
  });
  function openHelp() {
    if (!helpEl.firstChild) {
      const h = el('div', 'hh');
      rich(h, '操作の一覧　{?} か {Esc} で閉じる');
      const c = el('div', 'hc');
      helpEl.append(h, c);
      for (const [name, rows] of HELP) {
        const sec = el('section'), t = el('h3'), g = el('div', 'hg');
        t.textContent = name;
        for (const [k, d, only] of rows) {
          if ((only === 'touch' && !touchText) || (only === 'main' && cp2)) continue;
          const a = el('span'), b = el('span');
          rich(a, k); rich(b, d);
          g.append(a, b);
        }
        sec.append(t, g);
        c.append(sec);
      }
    }
    closePanel();
    wrap.append(helpEl);
    helpOn = true;
  }
  function closeHelp() {
    helpEl.remove();
    helpOn = false;
  }
  wrap.addEventListener('pointerdown', e => {
    if (helpOn && !helpEl.contains(e.target)) { closeHelp(); e.stopPropagation(); e.preventDefault(); }
  }, true);

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
    else if (helpOn && k === 'Escape') closeHelp();
    else if (k === '?' || (e.code === 'Slash' && e.shiftKey)) helpOn ? closeHelp() : openHelp();
    else if (sel && act === -1 && (k === 'Delete' || k === 'Backspace')) dropSel(true);
    else if (sel && act === -1 && k.startsWith('Arrow')) nudgeSel(k, e.shiftKey ? 10 : 1);
    else if (sel && act === -1 && k === 'Enter') dropSel();
    else if (sel && act === -1 && k === 'Escape' && !openP) dropSel();
    else if (KEYMAP[k]) setTool(KEYMAP[k]);
    else if (k >= '1' && k <= '8' && k.length === 1) setColor(PALETTE[k - 1]);
    else if (k === '[') setSize(round(CFG[tool].size / 1.2));
    else if (k === ']') setSize(max(CFG[tool].size + 1, round(CFG[tool].size * 1.2)));
    else if (k === 'v' && !cp2) togglePass(); // CP2 にページ操作モードはない
    else if (k === 'b') cycleBg();
    else if (k === 'd') toggleHud();
    else if (k === 'i' && HAS_ED) pickColor();
    else if (k === 'Delete') clearAll();
    else if (k === 'Escape') openP ? closePanel() : cp2 ? hide() : hideHint(); // CP2 はお知らせを出さずに隠す
    else ok = false;
    if (ok) { e.preventDefault(); e.stopPropagation(); }
  }

  // ---------- イベント登録 ----------
  for (const [t, f] of TWO) pad.addEventListener(t, f, true); // 2 本指のスクロール（onDown などより先に呼ぶ）
  // iPhone・iPad（WebKit）では、touch-action: none でもページ自身のスクロールが同時に動くことがあった（LINE の中のブラウザで、2 本指・ツールバー・描く線が震えた。T-107）。
  // 描く面とツールバーの touchmove を止めると、WebKit は Web ビューのなぞる操作（スクロール・拡大）を待たせてから取り消す。タップ（click）は touchend で決まるので押せる。
  // パネルの中（スライダー）は止めない。ほかのブラウザ（Chrome など）では足さない（touch-action で足り、入力の経路を変えないため）
  if (/iP(hone|ad|od)/.test(navigator.userAgent) || (/Mac/.test(PLAT) && navigator.maxTouchPoints > 1)) {
    pad.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
    bar.addEventListener('touchmove', e => { if (!e.target.closest('.pn')) e.preventDefault(); }, { passive: false });
  }
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
    if (hintT) endHint();
    if (visible) return;
    visible = true;
    hs.setProperty('display', 'block', 'important');
    surf.style.setProperty('display', 'block', 'important');
    topLayer();
    listen(true);
    fit();
    offTop();
    wrap.focus({ preventScroll: true });
  }
  function hide() {
    stopFling();
    if (!visible) return;
    if (act !== -1) endStroke();
    settle();
    if (saveT) { clearTimeout(saveT); saveT = 0; savePrefs(); } // 隠す・閉じる前に、待たせている保存を済ませる
    closePanel();
    if (helpOn) closeHelp();
    visible = false;
    listen(false);
    try { if (host.matches(':popover-open')) host.hidePopover(); } catch (_) { }
    hs.setProperty('display', 'none', 'important');
    surf.style.setProperty('display', 'none', 'important');
    if (doc.activeElement === host) wrap.blur();
  }
  function toggle() { visible ? hide() : show(); }
  // Esc と「−」で隠すときは、戻し方を HINT_MS だけ出す（「再表示」を押してもその場で戻る）。
  // その間も close の取り消し待ちと同じく、お知らせ以外は消えて入力のリスナーも外れている
  let hintT = 0;
  function hideHint() {
    if (!visible) return;
    hide();
    wrap.classList.add('hint');
    hs.setProperty('display', 'block', 'important');
    topLayer();
    hintT = setTimeout(endHint, HINT_MS);
    say('ブックマークレットで', HINT_MS, '再表示', show, null, true);
  }
  function endHint() {
    clearTimeout(hintT);
    hintT = 0;
    wrap.classList.remove('hint');
    unsay();
    if (visible) return;
    try { if (host.matches(':popover-open')) host.hidePopover(); } catch (_) { }
    hs.setProperty('display', 'none', 'important');
  }
  // 閉じる（×）: 描いた物があれば、BYE_MS の間はお知らせのボタン・Ctrl/⌘+Z・ブックマークレットで取り消せる。
  // その間は hide と同じく絵も入力のリスナーも外し、お知らせだけを残す（ページの操作を邪魔しない）
  let byeT = 0;
  function close() {
    if (byeT) return;
    if (hintT) endHint();
    if (!hist.length) { destroy(); return; }
    hide();
    wrap.classList.add('bye');
    hs.setProperty('display', 'block', 'important');
    topLayer();
    win.addEventListener('keydown', onByeKey, true);
    byeT = setTimeout(destroy, BYE_MS);
    say('絵を消して閉じました', BYE_MS, '元に戻す', reopen, destroy);
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
    if (hintT) endHint();
    hide();
    if (hud) toggleHud();
    clearTimeout(toastT);
    toastFn = null;
    finishHandoff();
    // 遅れて動く暖機・リサイズは、キャンバスを 0 にした後で描かないよう止める
    clearTimeout(warmT);
    cancelAnimationFrame(rz);
    while (hist.length) free(hist.pop());
    for (const c of [liveC, predC]) c.width = c.height = 0;
    rg = rbx = recA = null;
    for (const t of dtiles.values()) t.c.width = t.c.height = 0;
    dtiles.clear();
    for (const t of pool) t.c.width = t.c.height = 0;
    pool.length = 0;
    host.remove();
    surf.remove();
    delete win[NS];
  }

  // ---------- 設定（インストールページで選んだ既定 DEF に、このサイトで変えた所を重ねる） ----------
  // サイトの localStorage にはキー 1 つだけ、既定から変えた所だけを書く（何も変えていなければキーを消す）。
  // 背景・ページ操作モード・計測表示は、開いたときに驚かないよう覚えない
  const LS = 'paint-bookmarklet';
  const PREF_T = ['pen', 'marker', 'eraser', 'line', 'arrow', 'rect', 'ellipse', 'text', 'fill'];
  const BARS = { top: 1, 'top-left': 1, 'top-right': 1, bottom: 1 };
  let base = null, barPref = 'top', barMoved = false, saveT = 0, ready = false;
  function applyPrefs(p) {
    if (!p || typeof p !== 'object') return;
    if (typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color)) color = p.color.toLowerCase();
    if (typeof p.tool === 'string' && CFG[p.tool]) tool = p.tool;
    if (PENS.includes(p.pen)) penType = p.pen;
    if (typeof p.calc === 'boolean') calc = p.calc;
    if (UIS.includes(p.ui)) cp2 = p.ui === 'cp2';
    for (const k of PREF_T) {
      const sz = p.size && +p.size[k], al = p.alpha && +p.alpha[k];
      if (k !== 'fill' && sz >= 1 && sz <= 100) CFG[k].size = sz;
      if (k !== 'eraser' && al >= 0.05 && al <= 1) CFG[k].alpha = al;
    }
    if (BARS[p.bar]) barPref = p.bar;
    else if (Array.isArray(p.bar) && p.bar.length === 2 && p.bar.every(v => typeof v === 'number' && isFinite(v))) barPref = p.bar;
  }
  function snapPrefs() {
    const size = {}, alpha = {};
    for (const k of PREF_T) { const held = k === 'pen' && mainPen; size[k] = held ? mainPen[0] : CFG[k].size; alpha[k] = held ? mainPen[1] : CFG[k].alpha; }
    return { color, tool, pen: mainPen ? mainPen[2] : penType, calc, ui: UIS[+cp2], size, alpha };
  }
  function remember() {
    if (!ready) return;
    clearTimeout(saveT);
    saveT = setTimeout(savePrefs, 400);
  }
  function savePrefs() {
    saveT = 0;
    const cur = snapPrefs(), d = {};
    if (cur.color !== base.color) d.color = cur.color;
    if (cur.tool !== base.tool) d.tool = cur.tool;
    if (cur.pen !== base.pen) d.pen = cur.pen;
    if (cur.calc !== base.calc) d.calc = cur.calc;
    if (cur.ui !== base.ui) d.ui = cur.ui;
    for (const g of ['size', 'alpha']) {
      for (const k of PREF_T) if (cur[g][k] !== base[g][k]) (d[g] || (d[g] = {}))[k] = cur[g][k];
    }
    if (barMoved) d.bar = [round(barX), round(barY)];
    try {
      const ls = win.localStorage;
      if (Object.keys(d).length) ls.setItem(LS, JSON.stringify(d));
      else ls.removeItem(LS);
    } catch (_) { }
  }
  function loadSite() {
    try { return JSON.parse(win.localStorage.getItem(LS)); } catch (_) { return null; }
  }
  function placeBar() {
    measureBar();
    const p = barPref;
    if (Array.isArray(p)) moveBar(p[0], p[1]);
    else if (p === 'top-left') moveBar(10, 10);
    else if (p === 'top-right') moveBar(vw - barW - 10, 10);
    else if (p === 'bottom') moveBar((vw - barW) / 2, vh - barH - 12);
    else moveBar((vw - barW) / 2, 10);
  }
  applyPrefs(DEF);
  base = snapPrefs();
  const site = loadSite();
  applyPrefs(site);
  swapPen(cp2);
  barMoved = !!(site && Array.isArray(site.bar));

  // ---------- 起動 ----------
  const stats = () => ({
    width: W, height: H, dpr, surface: [surfW, surfH], tiles: dtiles.size, selection: sel ? [selX, selY, selW, selH] : null, texts: tlist.length, fixed, history: hist.length, historyPixels: hpix, events: nEv, points: nPts,
    desynchronized: DESYNC, rawupdate: HAS_RAW, coalesced: HAS_CO, nativePrediction: nativePred, inkTrail: !!inkP, pred: pn, frame: round(fi * 10) / 10, inputDelay: round(dl * 10) / 10,
    rec: [rec, recS.length, recN],
    prefs: { ...snapPrefs(), bar: [barX, barY], touchText, pickOnce, keepPanels, dev, ...look, ppred, mpred, blend },
  });
  win[NS] = { version: VERSION, toggle, show, hide, close, destroy, undo, redo, clear: clearAll, tool: setTool, color: setColor, stats, pixels };
  layout();
  setColor(color);
  syncPen();
  syncFixed();
  syncLook();
  syncCalc();
  syncTool(false);
  syncHist();
  syncBg();
  doc.documentElement.append(surf, host);
  show();
  placeBar();
  ready = true;
  // キーのないタッチの端末（スマホなど）では、隠すボタンで案内する
  say(win.matchMedia && win.matchMedia('(hover:none)').matches ? '− で隠す' : 'Esc で隠す');
})();
