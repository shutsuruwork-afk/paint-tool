/*!
 * Paint Bookmarklet（シンプル版の最小構成）— どんなページの上にも描ける低遅延ペイントツール
 * https://github.com/shutsuruwork-afk/paint-tool (MIT License)
 *
 * チェックポイント 2 の画面にある機能だけを残した版（T-080）。src/paint.js から、画面から使えない機能
 * （キーボードのショートカット・選択・図形・塗りつぶし・設定の記憶など）を外した。低遅延の仕組みと、
 * 絵をページに貼り付ける仕組みは本体と同じ。
 */
(() => {
  'use strict';

  const NS = '__paintBookmarklet';
  const VERSION = '1.28.0-simple.10-min';
  const win = window;
  // 2 回目以降の実行は表示/非表示の切り替えのみ（描画内容は保持）
  if (win[NS]) { win[NS].toggle(); return; }

  const doc = document;
  const { min, max, round, ceil, floor, abs, hypot, PI } = Math;
  const TAU = PI * 2;
  const EMPTY = [];
  const SVGNS = 'http://www.w3.org/2000/svg';
  const PE = win.PointerEvent && PointerEvent.prototype;
  const HAS_CO = !!PE && 'getCoalescedEvents' in PE;
  // pointerrawupdate: rAF 整列を待たずに届く生の入力（安全なコンテキストのみ）
  const HAS_RAW = 'onpointerrawupdate' in win;
  const HAS_OC = typeof OffscreenCanvas === 'function';
  const PLAT = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  // desynchronized: コンポジタの描画同期を待たずに表示（低遅延キャンバス。非対応環境では無視される）
  const CTX_OPT = { desynchronized: true };
  const PRED_MAX = 16;  // 保持する予測点の上限
  const PRED_MS = 12;   // 予測 API が無い環境で外挿する時間 (ms)
  const PRED_TTL = 40;  // 入力が途絶えてから予測線を消すまでの時間 (ms)
  const BYE_MS = 8000;  // 閉じるを取り消せる時間 (ms)
  const HINT_MS = 4000; // 隠したときに「ブックマークレットで再表示」を出す時間 (ms)

  const PALETTE = ['#111111', '#ffffff', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa'];
  const PEN_W = 6, ERASER_W = 32, TEXT_FS = 24; // ペンと消しゴムの太さ、文字の大きさ（CSS px）
  // 文字の書体。入力欄（CSS）と確定した文字で同じものを使う
  const FONT = 'system-ui,-apple-system,"Segoe UI","Hiragino Sans","Yu Gothic UI",sans-serif';
  const LH = 1.25; // 文字の行の高さ（文字の大きさに対する比）
  const TA_PAD = 10; // 文字の入力欄の周りの、見えない押せる余白（CSS px）。少し外れた所を押しても入力が続く

  const I = {
    pen: 'M4 20l1.2-4.4L16 4.8a2 2 0 0 1 2.9 0l.3.3a2 2 0 0 1 0 2.9L8.4 18.8zM14 7l3 3',
    eraser: 'M8 20h12M4.7 14.7l9-9a2 2 0 0 1 2.8 0l2.3 2.3a2 2 0 0 1 0 2.8L11 18.6H8.6zM9 10.3l5 5',
    text: 'M5 7V5h14v2M12 5v14M9 19h6',
    undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    hide: 'M5 12h14',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    close: 'M6 6l12 12M18 6L6 18',
  };

  // 見た目は白いガラス（ガウス）に固定。ぼかしの元を周りへ --gm だけ広げて拾い、見せるのはバーの角丸の形だけ（mask で切る）
  const GQ = (at, pos) => `radial-gradient(circle at ${at},#000 calc(var(--gr) - .5px),#0000 var(--gr)) ${pos}/var(--gr) var(--gr) no-repeat content-box`;
  const GMASK = [GQ('100% 100%', '0 0'), GQ('0 100%', '100% 0'), GQ('100% 0', '0 100%'), GQ('0 0', '100% 100%'),
    'linear-gradient(#000 0 0) 50% 50%/calc(100% - 2 * var(--gr)) 100% no-repeat content-box',
    'linear-gradient(#000 0 0) 50% 50%/100% calc(100% - 2 * var(--gr)) no-repeat content-box'].join(',');
  const CSS = `
.w{--gm:36px;all:initial;position:absolute;inset:0;overflow:hidden;contain:strict;pointer-events:none;outline:none;font:12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d2026;color-scheme:light;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
.s{position:absolute;inset:0}
.gh{position:absolute;white-space:pre;pointer-events:none;color:var(--c);opacity:.45;font:600 var(--fs)/${LH} ${FONT}}
.to{position:absolute;z-index:1;white-space:pre;pointer-events:none;color:var(--c);font:600 var(--fs)/${LH} ${FONT}}
.to.gone{opacity:.25}.to.ed{visibility:hidden}
canvas{position:absolute;left:0;top:0;pointer-events:none}
.g,.p{position:absolute;inset:0}
.p{pointer-events:auto;touch-action:none;cursor:crosshair}
.bar,.pn{border:1px solid #0000001f;box-shadow:0 6px 24px #0003,inset 0 1px 0 #ffffff99;pointer-events:auto}
.bar{position:absolute;left:0;top:0;cursor:grab;display:flex;align-items:center;gap:2px;padding:4px;box-sizing:border-box;border-radius:12px;touch-action:none;will-change:transform}
.bar::before,.pn::before{content:"";position:absolute;inset:calc(var(--gm) * -1);padding:var(--gm);z-index:-1;background:rgb(250 250 252 / .8);-webkit-backdrop-filter:blur(18px) saturate(2);backdrop-filter:blur(18px) saturate(2);pointer-events:none;-webkit-mask:${GMASK};mask:${GMASK}}
.bar::before{--gr:11px}.pn::before{--gr:9px}
.bar.drag,.bar.drag *{cursor:grabbing}
.b{all:unset;box-sizing:border-box;flex:none;width:30px;height:30px;display:grid;place-items:center;border-radius:8px;cursor:pointer;color:inherit}
.b:hover{background:#0000000f}.b:active,.b.open:not(.on){background:#0000001c}
.b.on{background:#3d7cff;color:#fff}.b.on:hover,.b.on:active{background:#2f6bea}
.b:disabled{opacity:.3;cursor:default;background:none}
.b:focus-visible{outline:2px solid #3d7cff;outline-offset:-2px}
.pn{position:absolute;left:0;top:calc(100% + 6px);display:none;flex-direction:column;gap:2px;padding:4px;border-radius:10px;isolation:isolate}
.pn.on{display:flex}.up .pn{top:auto;bottom:calc(100% + 6px)}
.row{display:flex;align-items:center;gap:2px}
.b.mi{width:auto;display:flex;justify-content:flex-start;gap:10px;padding:0 10px 0 6px;white-space:nowrap}
svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
[aria-label^="その他"] svg{stroke-width:3}
.c{width:24px}
.c::before{content:"";width:18px;height:18px;border-radius:50%;background:var(--c);box-shadow:inset 0 0 0 1px #00000026}
.c.on{background:none}.c.on::before{box-shadow:0 0 0 2px #fbfbfc,0 0 0 4px #1d2026}
.sep{flex:none;width:1px;height:22px;margin:0 3px;background:#0000001f}
.t{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);padding:8px 14px;border-radius:8px;background:#fbfbfc;box-shadow:0 6px 24px #0003;opacity:0;transition:opacity .2s;pointer-events:none;white-space:nowrap}
.t.on{opacity:1;pointer-events:auto}
.t button{all:unset;display:inline-block;margin:-4px -8px -4px 10px;padding:4px 8px;border-radius:6px;color:#2f6bff;font-weight:600;cursor:pointer}
.t button:hover{background:#0000000f}.t button:focus-visible{outline:2px solid #3d7cff}
.t .tc{display:none;margin:-4px -10px -4px 2px;padding:4px 6px;color:#5c606b;vertical-align:middle}.t.cx .tc{display:inline-grid;place-items:center}
.t .tc svg{width:14px;height:14px}
.t.in button{margin-left:-2px;padding-left:2px}
.bye .t::after{content:"";position:absolute;left:10px;right:10px;bottom:3px;height:2px;border-radius:1px;background:#2f6bff;transform-origin:left;animation:bye ${BYE_MS}ms linear forwards}
@keyframes bye{to{transform:scaleX(0)}}
.bye>:not(.t),.hint>:not(.t){display:none}
.tx{all:unset;position:absolute;box-sizing:content-box;padding:${TA_PAD}px;white-space:pre;overflow:hidden;resize:none;pointer-events:auto;cursor:text;color:var(--c);caret-color:var(--c);font:600 var(--fs)/${LH} ${FONT};outline:1px dashed #3d7cffb0;outline-offset:${5 - TA_PAD}px;-webkit-user-select:text;user-select:text}
@media (pointer:coarse){.b{width:38px;height:38px}.c{width:30px}}
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
  let tool = 'pen', color = PALETTE[2], visible = false; // tool: 'pen' / 'eraser' / 'text'
  let dpr = win.devicePixelRatio || 1, W = 0, H = 0, pendingFit = false, rz = 0, warmT = 0;
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
  // 表示タイルの一辺（面の px）。画面の密度によらず CSS で約 256px にする。履歴タイル T の倍数にしておくと、履歴タイルが表示タイルをまたがない
  const DT = T * max(2, round(sdpr * 2));
  function mapNow() {
    sk = sdpr / dpr;
    sox = round((win.scrollX - hdx) * sdpr);
    soy = round((win.scrollY - hdy) * sdpr);
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

  // ---------- ツールバー: ペン（押すたびに消しゴムと入れ替わる）・文字・元に戻す・その他・隠す ----------
  const penB = btn('ペン', I.pen, () => setTool(tool === 'pen' ? 'eraser' : 'pen'));
  const penD = penB.querySelector('path');
  const textB = btn('文字 — 押した所に入力。計算式を書くと答えが薄く出て、Tab で書き込める', I.text, () => setTool('text'));
  const undoB = btn('元に戻す', I.undo, undo);
  // その他: 全消去・閉じる・色
  const moreP = el('div', 'pn');
  const moreB = btn('その他（全消去・閉じる・色）', I.more, () => (open ? closePanel() : openPanel()));
  const item = (label, d, fn) => {
    const b = btn(label, d, () => { closePanel(); fn(); }, 'mi');
    const s = el('span');
    s.textContent = label;
    b.append(s);
    return b;
  };
  // 色を選ぶとメニューを閉じる。消しゴムのときはペンに戻す
  const colBtns = PALETTE.map((c, i) => {
    const b = btn(`色 ${i + 1}`, null, () => { setColor(c); if (tool === 'eraser') setTool('pen'); closePanel(); }, 'c');
    b.style.setProperty('--c', c);
    return b;
  });
  const colRow = el('div', 'row');
  colRow.append(...colBtns);
  moreP.append(item('全消去', I.trash, clearAll), item('閉じる', I.close, close), colRow);
  const hideB = btn('隠す — ブックマークレットを再度押すと再表示', I.hide, hideHint);
  bar.append(penB, textB, sep(), undoB, sep(), moreB, hideB, moreP);

  // その他のメニュー。描き始め・メニューの外を押す・ツールバーを引くと閉じる。
  // 開いていなければ pointerdown ごとの仕事は比較 1 回だけ（入力のホットパスには触れない）
  let open = false, pW = 0, pH = 0;
  function openPanel() {
    open = true;
    moreP.classList.add('on');
    moreB.classList.add('open');
    measureBar();
    pW = moreP.offsetWidth; pH = moreP.offsetHeight;
    // 下に入らなければ上に開く。横は画面からはみ出さないように寄せる
    bar.classList.toggle('up', barY + barH + pH + 8 > vh && barY >= pH + 8);
    moreP.style.left = max(4 - barX, min(moreB.offsetLeft, vw - barX - pW - 4)) + 'px';
  }
  function closePanel() {
    if (!open) return;
    open = false;
    moreP.classList.remove('on');
    moreB.classList.remove('open');
  }
  wrap.addEventListener('pointerdown', e => {
    if (open && !moreP.contains(e.target) && !moreB.contains(e.target)) closePanel();
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
  // メニューの中は除く。動かし始めるまでポインタを奪わないので、ボタンのクリックはそのまま届く。
  // 引いて離したあとのクリックは、ボタンを押したことにしない（次にツールバーを押したら印を消す）
  let eatClick = false;
  bar.addEventListener('click', e => { if (eatClick) { eatClick = false; e.stopPropagation(); e.preventDefault(); } }, true);
  bar.addEventListener('pointerdown', e => {
    eatClick = false;
    if (e.button !== 0 || e.target.closest('.pn')) return;
    measureBar();
    const sx = e.clientX, sy = e.clientY, ox = sx - barX, oy = sy - barY, id = e.pointerId;
    let moving = false;
    const mv = ev => {
      if (ev.pointerId !== id) return;
      if (!moving) {
        if (abs(ev.clientX - sx) < 4 && abs(ev.clientY - sy) < 4) return;
        moving = true;
        closePanel();
        bar.classList.add('drag');
        try { bar.setPointerCapture(id); } catch (_) { }
      }
      moveBar(ev.clientX - ox, ev.clientY - oy);
    };
    const up = ev => {
      if (ev.pointerId !== id) return;
      win.removeEventListener('pointermove', mv, true);
      win.removeEventListener('pointerup', up, true);
      win.removeEventListener('pointercancel', up, true);
      if (!moving) return;
      bar.classList.remove('drag');
      eatClick = true;
    };
    win.addEventListener('pointermove', mv, true);
    win.addEventListener('pointerup', up, true);
    win.addEventListener('pointercancel', up, true);
  });

  // ---------- UI 同期（ホットパス外でのみ呼ぶ） ----------
  function setTool(t) {
    if (t !== 'text') commitText();
    tool = t;
    syncTool();
  }
  // ペンのボタンは、消しゴムのときは消しゴムの印と名前にし、ペンか消しゴムのとき選んだ見た目にする
  function syncTool() {
    const er = tool === 'eraser', t = er ? '消しゴム' : 'ペン';
    penD.setAttribute('d', er ? I.eraser : I.pen);
    penB.title = t;
    penB.setAttribute('aria-label', t);
    penB.classList.toggle('on', tool !== 'text');
    textB.classList.toggle('on', tool === 'text');
    // カーソル画像は OS/コンポジタが描くので遅延ゼロ（DOM で追従させるとフレーム遅れが出る）
    let cur = 'text';
    if (tool !== 'text') {
      const d = er ? ERASER_W : PEN_W, s = d + 4, m = s / 2, r = d / 2;
      const svg = `<svg xmlns="${SVGNS}" width="${s}" height="${s}"><circle cx="${m}" cy="${m}" r="${r}" fill="none" stroke="#000" stroke-opacity=".75" stroke-width="1.5"/><circle cx="${m}" cy="${m}" r="${max(r - 1.25, 0.5)}" fill="none" stroke="#fff" stroke-opacity=".9"/></svg>`;
      cur = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${m | 0} ${m | 0},crosshair`;
    }
    pad.style.cursor = cur;
  }
  function setColor(c) {
    color = c.toLowerCase();
    colBtns.forEach((b, i) => b.classList.toggle('on', PALETTE[i] === color));
    if (ta) { taC = color; styleTa(); }
  }
  function syncHist() {
    undoB.disabled = hpos === 0;
  }
  let toastT = 0, toastFn = null, toastXFn = null;
  // お知らせは、押せるボタン（act）の付いた物だけ（隠した後の「再表示」と、閉じた後の「元に戻す」）。
  // xfn を渡すと × のボタンも付く。inl ならボタンを文の続きとして間を空けずに置く
  function say(msg, ms, act, fn, xfn, inl) {
    toastM.textContent = msg;
    toastB.textContent = act;
    toastFn = fn;
    toastXFn = xfn || null;
    toast.classList.toggle('cx', !!xfn);
    toast.classList.toggle('in', !!inl);
    toast.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(unsay, ms);
  }
  function unsay() {
    toast.classList.remove('on', 'cx', 'in');
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
    if (visible) { sizeSurface(); measureBar(); moveBar(barX, barY); }
  }
  // 暖機: キャンバスの GPU バッキング確保や合成パスの初回コンパイルは初回描画時に数十 ms かかる。
  // 描き始めてから払うと最初の一筆が引っかかるので、起動直後の何もしていない時間に済ませておく。
  function warm() {
    warmT = 0;
    if (act !== -1 || handoff) return;
    for (const c of [lctx, pctx]) { c.fillRect(0, 0, 1, 1); c.clearRect(0, 0, 1, 1); }
    // 確定・消しゴム・退避で使う処理を、画面に出ない小さなキャンバスで一度ずつ通しておく
    const s = newCanvas(2, 2), x = s.getContext('2d');
    x.drawImage(liveC, 0, 0, 1, 1, 0, 0, 1, 1);
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
  // 元に戻すは「現在の画素とアトラスの入れ替え」。新しい手を積むと、元に戻した手は捨てる
  const hist = [];
  let hpos = 0, hpix = 0;
  // これまでに面の画素が変わりうる範囲の和（全消去で積むタイルを絞り、消す物があるかを確かめるのに使う）
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
  // ink: 線を描いた手か（消しゴム・全消去・文字だけの手は false）。t: その手で変わった文字の物と、もう一方の状態の組 [[物, 状態], …]
  function push(R, c, ink, t) {
    grow(R);
    while (hist.length > hpos) free(hist.pop());
    let pix = 0;
    for (let i = 0; i < R.length; i += 6) pix += R[i + 2] * R[i + 3];
    hist.push({ R, c, pix, ink, t });
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
    const h = hist[--hpos];
    if (h.c) swap(h);
    if (h.t) swapText(h);
    syncHist();
  }
  // 全消去はページ全体（見えていない所も含む）。元に戻せるように、描いた範囲に掛かるタイルをアトラスに退避してから消す
  function clearAll() {
    if (act !== -1) return;
    commitText();
    finishHandoff();
    // 消す物がなければ何もしない（履歴を増やさない）: 直前の手が全消去なら空。画素は描いた範囲（cb*）の中にしかない。
    // 直前の手が線を描く手でなければ、消しゴムや元に戻すで空になっているかもしれないので読み戻して確かめる
    const h = hpos ? hist[hpos - 1] : null;
    if ((h && h.clr) || (!tlist.length && (cbx1 <= cbx0 || (!(h && h.ink) && !hasInk())))) return;
    const R = [], P = tlist.map(o => [o, tSnap(o)]);
    for (const k of dtiles.keys()) {
      const x = (k % 65536) * DT, y = ((k / 65536) | 0) * DT;
      if (x < cbx1 && x + DT > cbx0 && y < cby1 && y + DT > cby0) R.push(x, y, DT, DT, 0, 0);
    }
    if (!R.length && !P.length) return;
    push(R, R.length ? gather(R, pack(R)) : null, false, P.length ? P : null);
    hist[hpos - 1].clr = true;
    for (let i = 0; i < R.length; i += 6) dtiles.get((R[i + 1] / DT) * 65536 + R[i] / DT).x.clearRect(0, 0, DT, DT);
    for (const p of P) tApply(p[0], null);
    cbx0 = cby0 = cbx1 = cby1 = 0;
  }
  // 描いた範囲（cb*）に画素が 1 つでも残っているか。掛かるタイルの重なる所だけを読み戻す（全消去の前にだけ使う）
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

  // ---------- ストローク状態（ホットパスで割り当てを起こさないよう、すべてスカラーで保持） ----------
  let act = -1, aType = '', mode = 0; // mode: 1 ペン / 2 消しゴム
  let sW = 0, sP = false, sRaw = false, raf = 0;
  let bx = 0, by = 0, bw = 0, mx = 0, my = 0, ps = 1, lt = 0, lastPen = -1e9;
  let x0 = 0, y0 = 0, x1 = 0, y1 = 0, mW = 0; // ストロークの外接矩形
  let tx0 = 0, ty0 = 0, tx1 = 0, ty1 = 0; // pred レイヤの汚れ矩形
  let pn = 0, nativePred = false, vx = 0, vy = 0;
  const px = new Float64Array(PRED_MAX), py = new Float64Array(PRED_MAX), pt = new Float64Array(PRED_MAX);
  const ePts = new Float64Array(512); // 消しゴム: 1 回の描画で使う点（S 座標、最大 256 点）
  let handoff = 0, hcx = 0, hcy = 0, hcw = 0, hch = 0; // 確定後に live を消すまでの受け渡し（commitLive）
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

  // 2 本指でスクロール: タッチが 2 本になったら、1 本目で描き始めていた線は捨てて、2 本の中点の動きでページをスクロールする。
  // 2 本とも離すまでは描かない。pad の onDown / onMove / onUp より先に呼び、スクロールの間はそれらに渡さない。
  // 1 本のときの仕事は、ポインタの番号の比較と座標の代入だけ
  let tI0 = -1, tX0 = 0, tY0 = 0, tI1 = -1, tX1 = 0, tY1 = 0, scr = 0, scrX = 0, scrY = 0; // scr: 1 = スクロール中、2 = 片方を離した（残りを離すまで描かない）
  function twoDown(e) {
    if (e.pointerType !== 'touch') return;
    const id = e.pointerId;
    if (e.isPrimary) { tI0 = tI1 = -1; scr = 0; } // 新しいタッチの始まり（離したことを取りこぼしていても数え直す）
    if (tI0 === -1) { tI0 = id; tX0 = e.clientX; tY0 = e.clientY; }
    else if (tI1 === -1) { tI1 = id; tX1 = e.clientX; tY1 = e.clientY; }
    else return;
    if (tI0 === -1 || tI1 === -1) { if (!scr) return; }
    else if (act === -1 || aType === 'touch') {
      if (act !== -1) abortStroke();
      scr = 1; scrX = (tX0 + tX1) / 2; scrY = (tY0 + tY1) / 2;
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
    scrX = mx; scrY = my;
  }
  function twoUp(e) {
    const id = e.pointerId;
    if (id === tI0) tI0 = -1;
    else if (id === tI1) tI1 = -1;
    else return;
    if (!scr) return;
    e.stopImmediatePropagation();
    scr = tI0 === -1 && tI1 === -1 ? 0 : 2;
  }

  function onDown(e) {
    const type = e.pointerType, pen = type === 'pen';
    if (pen) lastPen = e.timeStamp;
    if (act !== -1) {
      // パームリジェクション: タッチで描画中にペンが触れたら、タッチの線を破棄してペンを優先
      if (pen && aType === 'touch') abortStroke();
      else return;
    } else if (type === 'touch' && e.timeStamp - lastPen < 500) return;
    if (e.button !== 0) return;
    e.preventDefault();
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
    if (tool === 'text') {
      // 置いた文字の上なら書き直し、それ以外は新しく書く
      const o = textHit(e.clientX * sdpr + sox, e.clientY * sdpr + soy);
      if (o) editText(o);
      else textAt(e.clientX, e.clientY);
      return;
    }
    // x, y は線を描くときだけ求める（文字の分岐の前に置くと、terser 5.36 の圧縮が宣言を落として壊れた）
    const x = e.clientX * dpr, y = e.clientY * dpr;

    act = e.pointerId; aType = type;
    sW = (tool === 'eraser' ? ERASER_W : PEN_W) * dpr; mW = sW;
    lt = e.timeStamp; pn = 0; vx = vy = 0;
    bx = mx = x0 = x1 = x;
    by = my = y0 = y1 = y;
    try { pad.setPointerCapture(act); } catch (_) { }

    if (tool === 'eraser') {
      mode = 2;
      const p = sW / 2 + 2;
      markBox(x - p, y - p, x + p, y + p); // 削る前に該当タイルを退避
      if (tlist.length) eraseText(x, y, x, y, sW / 2);
      ePts[0] = x * sk + sox; ePts[1] = y * sk + soy;
      erasePts(1);
    } else {
      mode = 1;
      setInk(lctx);
      setInk(pctx);
      sP = pen && e.pressure > 0;
      ps = sP ? e.pressure : 1;
      bw = sP ? qw(sW * (0.2 + 0.8 * ps)) : sW;
      // 押した瞬間に点を出す（タップでも点が残る）
      lctx.beginPath(); lctx.arc(x, y, bw / 2, 0, TAU); lctx.fill();
      const p = bw / 2 + 2;
      markBox(x - p, y - p, x + p, y + p);
    }
    sRaw = HAS_RAW;
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
    const list = HAS_CO && e.getCoalescedEvents ? e.getCoalescedEvents() : EMPTY;
    const n = list.length;
    if (mode === 1) {
      inkMove(e, list, n);
      if (e.type === 'pointermove') {
        if (inkP) {
          // OS が実際のポインタ位置まで線を伸ばすので、推測（予測線）は使わない
          try { inkP.updateInkTrailStartPoint(e, { color, diameter: bw / dpr }); pn = 0; } catch (_) { readPred(e); }
        } else readPred(e);
      }
      drawTail();
    } else eraseMove(e, list, n);
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
      if (dt > 0.5) {
        vx += ((x - bx) / dt - vx) * 0.5;
        vy += ((y - by) / dt - vy) * 0.5;
      }
      lt = t;
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

  // ストロークの外接矩形（線幅ぶん広げ、整数ピクセルに丸めてクリップ）を dX, dY, dW, dH に入れる。空なら false
  let dX = 0, dY = 0, dW = 0, dH = 0;
  function dirty() {
    const m = mW / 2 + 2;
    const ax = max(0, (x0 - m) | 0), ay = max(0, (y0 - m) | 0);
    const ex = min(W, ceil(x1 + m)), ey = min(H, ceil(y1 + m));
    if (ex <= ax || ey <= ay) return false;
    dX = ax; dY = ay; dW = ex - ax; dH = ey - ay;
    return true;
  }

  function tick(ts) {
    raf = requestAnimationFrame(tick);
    // ポインタが止まったら古い予測線を消す（行き過ぎた線が残らないように）
    if (pn && ts - lt > PRED_TTL) { pn = 0; drawTail(); }
    if (tHit !== tShown) showErased();
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
      // 最後の半区間（中点→最終点）を確定してから面へ合成
      if (mx !== bx || my !== by) {
        lctx.lineWidth = bw;
        lctx.beginPath(); lctx.moveTo(mx, my); lctx.lineTo(bx, by); lctx.stroke();
        markSeg(mx, my, bx, by, bw / 2 + 2);
      }
      clearTail();
      commitLive();
    } else {
      // 退避しておいたタイルを 1 枚のアトラスにまとめて履歴へ。触れた文字の物も同じ手で消す
      const R = tileRects(false), P = takeErased(false);
      let ac = null;
      if (R.length) {
        ac = pack(R).getContext('2d');
        for (let k = 0, i = 0; i < R.length; k++, i += 6) ac.drawImage(tsave[k].c, 0, 0, R[i + 2], R[i + 3], R[i + 4], R[i + 5], R[i + 2], R[i + 3]);
      }
      if (R.length || P) push(R, ac && ac.canvas, false, P);
    }
    resetTiles();
    mode = 0;
    if (pendingFit) fit();
  }

  // 描いている途中の線を捨てる（パームリジェクションと 2 本指のスクロール）
  function abortStroke() {
    const m = mode, r = dirty();
    stopStroke();
    if (m === 2) {
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
    if (bW * bH < tp) R = [bX, bY, bW, bH, 0, 0];
    sizeSurface();
    const atlas = gather(R, pack(R));
    for (let i = 0; i < R.length; i += 6) {
      forTiles(R[i], R[i + 1], R[i + 2], R[i + 3], true, (t, ox, oy, ix, iy, iw, ih) =>
        t.x.drawImage(liveC, (ix - sox) / sk, (iy - soy) / sk, iw / sk, ih / sk, ix - ox, iy - oy, iw, ih));
    }
    push(R, atlas, true);
    // live は desynchronized なので、ここで消すと通常の更新であるタイルより先に画面へ出て、線が一瞬消える。
    // live は残したままグループを隠し（タイルの更新と同じフレームで切り替わる）、2 フレーム後に中身を消す
    grp.style.opacity = 0;
    hcx = rx; hcy = ry; hcw = rw; hch = rh;
    handoff = requestAnimationFrame(() => { handoff = requestAnimationFrame(finishHandoff); });
  }
  function finishHandoff() {
    if (!handoff) return;
    cancelAnimationFrame(handoff);
    handoff = 0;
    lctx.clearRect(hcx, hcy, hcw, hch);
    grp.style.opacity = 1;
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

  // ---------- 文字（入力中は本物の textarea を重ねるので IME がそのまま使える） ----------
  // 確定した文字は「物」として面の中の要素（.to）に置く。文字の道具で押すと書き直せ、消しゴムで消せる。
  // 物の状態は [文字, x, y, 大きさ, 色]（x, y は行の箱の左上、大きさは文字の高さ。どれも S の px で、CSS px の整数に丸める）
  let ta = null, taX = 0, taCY = 0, taObj = null;
  let taFs = TEXT_FS, taC = ''; // 入力欄の書式（大きさは CSS px）。新しい文字は今の色、書き直しはその物の書式
  const tlist = []; // 面に置いている文字の物（重なり順。後ろほど手前）
  let tHit = 0, tShown = 0; // 消しゴムが触れた文字の数と、薄く表示した数
  // 入力欄のキーや文字はページへ渡さない（ページのショートカットやフォーカス管理が反応しないように）
  const TA_STOP = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'compositionstart', 'compositionupdate',
    'compositionend', 'paste', 'copy', 'cut', 'focusin', 'focusout'];
  const tNew = () => ({ el: el('div', 'to'), s: '', x: 0, y: 0, fs: 0, c: '', w: 0, h: 0, on: false, hit: 0 });
  const tSnap = o => [o.s, o.x, o.y, o.fs, o.c];
  // 物を状態 st にする（null なら面から外す）
  function tApply(o, st) {
    if (!st) {
      if (o.on) { o.el.remove(); tlist.splice(tlist.indexOf(o), 1); o.on = false; }
      return;
    }
    [o.s, o.x, o.y, o.fs, o.c] = st;
    const e = o.el, es = e.style;
    e.textContent = o.s;
    es.left = o.x / sdpr + 'px';
    es.top = o.y / sdpr + 'px';
    es.setProperty('--fs', o.fs / sdpr + 'px');
    es.setProperty('--c', o.c);
    if (!o.on) { tlist.push(o); o.on = true; }
    if (e.parentNode !== sbox) sbox.append(e);
    o.w = e.offsetWidth * sdpr;
    o.h = e.offsetHeight * sdpr;
  }
  // 履歴の手の文字の物を、今の状態と保存した状態で入れ替える
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
  // 消しゴムの線分（V）が触れた文字に印を付ける（Liang–Barsky）。入力のたびに呼ばれるので、割り当てのない計算だけにする
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
    if (!value) { taFs = TEXT_FS; taC = color; }
    ta = el('textarea', 'tx', { spellcheck: 'false', wrap: 'off', rows: '1', 'aria-label': '文字' });
    taX = cx; taCY = cy; // クリックした点が 1 行目の高さの中央になるように置く
    for (const t of TA_STOP) ta.addEventListener(t, stop);
    ta.addEventListener('input', updateGhost);
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
    wrap.append(ta);
    styleTa();
    ta.focus({ preventScroll: true });
    if (value) ta.setSelectionRange(value.length, value.length);
  }
  // 確定した文字を書き直す: その物の書式のまま同じ位置に入力欄を出す（物はその間だけ隠す）
  function editText(o) {
    taObj = o;
    o.el.classList.add('ed');
    taFs = o.fs / sdpr; taC = o.c;
    textAt((o.x - sox) / sdpr, (o.y - soy) / sdpr + taFs * LH / 2, o.s);
  }
  function styleTa() {
    const s = ta.style;
    s.setProperty('--c', taC);
    s.setProperty('--fs', taFs + 'px');
    // 余白の分だけ外へずらすので、文字の位置と点線の枠の見た目は変わらない
    s.left = taX - TA_PAD + 'px';
    s.top = taCY - taFs * LH / 2 - TA_PAD + 'px';
    updateGhost();
  }
  // 中身に合わせて入力欄を広げる（折り返さない。改行でだけ行が増える）。
  // 余白が scrollWidth に入るかはブラウザで違う（Chrome は左だけ）ので、測る間だけ余白を外す。
  // 空のときは少なくとも 1 行・全角 1 文字分。電卓の薄い答えが出ている間は、答えの右端まで広げる
  function fitTa() {
    const s = ta.style;
    s.padding = '0';
    s.width = s.height = '0';
    const w = max(ta.scrollWidth, ceil(taFs), ghostR) + 2, h = max(ta.scrollHeight, round(taFs * LH));
    s.padding = '';
    s.width = w + 'px';
    s.height = h + 'px';
  }
  // ---- 電卓: カーソルのある行が計算式なら、行の後ろに答えを薄く出す。Tab で書き込む ----
  const ghostEl = el('div', 'gh');
  let ghostTxt = '', ghostEnd = 0, ghostR = 0, mta = null;
  // 1 行の幅を、入力欄と同じ測り方（見えない入力欄の scrollWidth）で測る。答えの位置と枠の幅が、Tab で書き込んだ後の入力欄とそろう
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
    wrap.append(mta);
    const w = mta.scrollWidth;
    mta.remove();
    return w;
  }
  function updateGhost() {
    ghostTxt = '';
    ghostR = 0;
    if (ta) {
      const v = ta.value, p = ta.selectionEnd, a = v.lastIndexOf('\n', p - 1) + 1, b = v.indexOf('\n', p), end = b < 0 ? v.length : b;
      const line = v.slice(a, end), r = calcLine(line);
      if (r) {
        ghostTxt = r;
        ghostEnd = end;
        const s = ghostEl.style, row = v.slice(0, a).split('\n').length - 1;
        ghostEl.textContent = r;
        ghostR = lineW(line + r);
        s.setProperty('--c', taC);
        s.setProperty('--fs', taFs + 'px');
        s.left = taX + lineW(line) + 'px';
        s.top = taCY - taFs * LH / 2 + row * taFs * LH + 'px';
        if (!ghostEl.parentNode) wrap.append(ghostEl);
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
    const st = [v, round(taX + sox / sdpr) * sdpr, round(taCY - taFs * LH / 2 + soy / sdpr) * sdpr, max(4, round(taFs)) * sdpr, taC];
    if (o) {
      const prev = tSnap(o);
      if (v && st.every((x, i) => x === prev[i])) return;
      tApply(o, v ? st : null);
      push([], null, false, [[o, prev]]);
    } else if (v) {
      const n = tNew();
      tApply(n, st);
      push([], null, false, [[n, null]]);
    }
  }

  // 画面の (x, y, w, h)（CSS px）に見えている確定済みの線の画素（テスト用。文字の物は含まない）
  function pixels(x, y, w, h) {
    mapNow();
    const X = round(x * sdpr) + sox, Y = round(y * sdpr) + soy;
    const cw = max(1, round(w * sdpr)), ch = max(1, round(h * sdpr));
    const cx = newCanvas(cw, ch).getContext('2d', { willReadFrequently: true });
    forTiles(X, Y, cw, ch, false, (t, tox, toy, ix, iy, iw, ih) =>
      cx.drawImage(t.c, ix - tox, iy - toy, iw, ih, ix - X, iy - Y, iw, ih));
    return cx.getImageData(0, 0, cw, ch);
  }

  // ---------- イベント登録 ----------
  pad.addEventListener('pointerdown', twoDown); // 2 本指のスクロール。onDown などより先に登録する
  pad.addEventListener('pointermove', twoMove);
  pad.addEventListener('pointerup', twoUp);
  pad.addEventListener('pointercancel', twoUp);
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
    win.addEventListener('resize', onResize);
    fit();
    wrap.focus({ preventScroll: true });
  }
  function hide() {
    if (!visible) return;
    if (act !== -1) endStroke();
    commitText();
    closePanel();
    visible = false;
    win.removeEventListener('resize', onResize);
    try { if (host.matches(':popover-open')) host.hidePopover(); } catch (_) { }
    hs.setProperty('display', 'none', 'important');
    surf.style.setProperty('display', 'none', 'important');
    if (doc.activeElement === host) wrap.blur();
  }
  function toggle() { visible ? hide() : show(); }
  // 「−」で隠すときは、戻し方を HINT_MS だけ出す（「再表示」を押してもその場で戻る）。
  // その間も閉じるの取り消し待ちと同じく、お知らせ以外は消えて入力のリスナーも外れている
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
  // 閉じる: 描いた物があれば、BYE_MS の間はお知らせのボタン・ブックマークレットで取り消せる（お知らせの × ですぐ閉じる）。
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
    byeT = setTimeout(destroy, BYE_MS);
    say('絵を消して閉じました', BYE_MS, '元に戻す', reopen, destroy);
  }
  function endBye() {
    clearTimeout(byeT);
    byeT = 0;
    wrap.classList.remove('bye');
  }
  function reopen() {
    if (!byeT) return;
    endBye();
    unsay();
    show();
  }
  function destroy() {
    if (byeT) endBye();
    if (hintT) endHint();
    hide();
    clearTimeout(toastT);
    toastFn = null;
    finishHandoff();
    // 遅れて動く暖機・リサイズは、キャンバスを 0 にした後で描かないよう止める
    clearTimeout(warmT);
    cancelAnimationFrame(rz);
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
  // API はテストと計測用（画面の機能だけで、やり直す・設定などはない）
  const stats = () => ({
    width: W, height: H, dpr, surface: [surfW, surfH], tiles: dtiles.size, texts: tlist.length, history: hist.length, historyPixels: hpix,
    desynchronized: DESYNC, rawupdate: HAS_RAW, coalesced: HAS_CO, nativePrediction: nativePred, inkTrail: !!inkP, tool, color,
  });
  win[NS] = { version: VERSION, toggle, show, hide, close, destroy, undo, clear: clearAll, tool: setTool, color: setColor, stats, pixels };
  setColor(color);
  syncTool();
  syncHist();
  doc.documentElement.append(surf, host);
  show();
  measureBar();
  moveBar((vw - barW) / 2, 10);
})();
