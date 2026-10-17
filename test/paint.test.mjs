import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CODE, BOOKMARKLET, startServer, launch, openPage, runBookmarklet, shadowEval, readMain, alphaStats, drag, click, toolOn,
  screenPixel, scrollTo, withDefaults, runCode,
} from './helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser.close(); server.srv.close(); });

const fresh = async (path = '/', viewport) => {
  const o = await openPage(browser, server.base + path, viewport);
  if (path !== '/strict') await runBookmarklet(o.page);
  return o;
};
const checksum = page => page.evaluate(() => {
  const de = document.documentElement;
  const d = window.__paintBookmarklet.pixels(0, 0, de.clientWidth, de.clientHeight).data;
  let h = 0, s = 0;
  for (let i = 0; i < d.length; i++) { s += d[i]; h = (h * 31 + d[i]) | 0; }
  return `${s}:${h}`;
});
const firePointer = (page, type, o) => shadowEval(page, (root, [type, o]) => {
  root.querySelector('.p').dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, isPrimary: true, ...o }));
}, [type, o]);
const setSlider = (page, idx, v) => shadowEval(page, (root, [i, v]) => {
  const r = root.querySelectorAll('.r input')[i];
  r.value = v;
  r.dispatchEvent(new Event('input'));
}, [idx, v]);

test('javascript: URL で起動し、再実行で非表示/再表示、閉じると 8 秒後に完全に破棄される', async () => {
  const { page, errors } = await fresh();
  const st = () => page.evaluate(() => {
    const h = document.querySelector('paint-bookmarklet');
    return h ? getComputedStyle(h).display : 'removed';
  });
  assert.equal(await st(), 'block');
  await drag(page, [[100, 300], [400, 300]]);
  await runBookmarklet(page);
  assert.equal(await st(), 'none');
  await runBookmarklet(page);
  assert.equal(await st(), 'block');
  // 非表示→再表示でも絵は残る
  assert.ok((await alphaStats(page, 100, 290, 300, 20)).max > 200);
  await click(page, '[title^="閉じる"]');
  // 描いた物があるので、しばらくは取り消せる状態で残る
  assert.equal(await page.evaluate(() => !!window.__paintBookmarklet), true);
  await page.waitForFunction(() => !window.__paintBookmarklet, null, { timeout: 12000 });
  assert.equal(await st(), 'removed');
  assert.equal(await page.evaluate(() => !!document.querySelector('paint-bookmarklet-surface')), false);
  assert.deepEqual(errors, []);
  await page.close();
});

test('× で閉じても、元に戻す・Ctrl+Z・ブックマークレットで絵も履歴も戻る。戻すまではページを操作できる', async () => {
  const { page, errors } = await fresh();
  await drag(page, [[100, 300], [400, 300]]);
  await drag(page, [[100, 400], [400, 400]]);
  const s = await checksum(page);
  await page.evaluate(() => { window.__clicks = 0; document.addEventListener('click', () => window.__clicks++); });
  const state = () => page.evaluate(() => {
    const sf = document.querySelector('paint-bookmarklet-surface');
    const r = document.querySelector('paint-bookmarklet').shadowRoot, t = r.querySelector('.t');
    return {
      surf: getComputedStyle(sf).display,
      bar: getComputedStyle(r.querySelector('.bar')).display,
      toast: t.classList.contains('on') && t.classList.contains('act') ? t.textContent : '',
      cover: document.elementFromPoint(900, 200).nodeName === 'PAINT-BOOKMARKLET',
    };
  });
  const closed = { surf: 'none', bar: 'none', toast: '絵を消して閉じました元に戻す', cover: false };
  const open = { surf: 'block', bar: 'flex', toast: '', cover: true };
  assert.deepEqual(await state(), open);

  // 1) お知らせのボタンで戻す。戻すまではページのクリックが届く
  await click(page, '[title^="閉じる"]');
  assert.deepEqual(await state(), closed);
  await page.mouse.click(900, 200);
  assert.equal(await page.evaluate(() => window.__clicks), 1);
  const b = await shadowEval(page, root => {
    const r = root.querySelector('.t button').getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });
  await page.mouse.click(b[0], b[1]);
  assert.deepEqual(await state(), open);
  assert.equal(await checksum(page), s);
  // 履歴も残っている
  await page.keyboard.press('Control+z');
  assert.notEqual(await checksum(page), s);
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await checksum(page), s);

  // 2) Ctrl+Z で戻す（1 回だけ戻り、絵の undo までは進まない）
  await click(page, '[title^="閉じる"]');
  assert.deepEqual(await state(), closed);
  await page.keyboard.press('Control+z');
  assert.deepEqual(await state(), open);
  assert.equal(await checksum(page), s);

  // 3) ページの入力欄での Ctrl+Z は横取りしない。ブックマークレットを押すと戻る
  await click(page, '[title^="閉じる"]');
  await page.click('#inp');
  await page.keyboard.type('ab');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await state(), closed);
  await runBookmarklet(page);
  assert.deepEqual(await state(), open);
  assert.equal(await checksum(page), s);
  assert.deepEqual(errors, []);
  await page.close();
});

test('閉じた後のお知らせの × を押すと、8 秒待たずにすぐ閉じる', async () => {
  const { page, errors } = await fresh();
  await drag(page, [[100, 300], [400, 300]]);
  await click(page, '[title^="閉じる"]');
  const x = await shadowEval(page, root => {
    const r = root.querySelector('.t .tc').getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2, r.width];
  });
  assert.ok(x[2] > 0, '× が見えている');
  await page.mouse.click(x[0], x[1]);
  assert.equal(await page.evaluate(() =>
    !window.__paintBookmarklet && !document.querySelector('paint-bookmarklet') && !document.querySelector('paint-bookmarklet-surface')), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('何も描いていなければ × ですぐに閉じる。API の destroy は描いた後でもすぐに破棄する', async () => {
  const { page, errors } = await fresh();
  const gone = () => page.evaluate(() =>
    !window.__paintBookmarklet && !document.querySelector('paint-bookmarklet') && !document.querySelector('paint-bookmarklet-surface'));
  await click(page, '[title^="閉じる"]');
  assert.equal(await gone(), true);
  await runBookmarklet(page);
  await drag(page, [[100, 300], [400, 300]]);
  await page.evaluate(() => window.__paintBookmarklet.destroy());
  assert.equal(await gone(), true);
  // 取り消し待ちの間に destroy しても、あとでタイマーが動いてエラーにならない
  await runBookmarklet(page);
  await drag(page, [[100, 300], [400, 300]]);
  await page.evaluate(() => { const a = window.__paintBookmarklet; a.close(); a.destroy(); });
  assert.equal(await gone(), true);
  // 起動した直後（暖機の前）に destroy しても、あとで暖機が動いてエラーにならない
  await page.evaluate(c => { (0, eval)(c); window.__paintBookmarklet.destroy(); }, CODE);
  await page.waitForTimeout(100);
  assert.equal(await gone(), true);
  assert.deepEqual(errors, []);
  await page.close();
});

const openPanels = page => shadowEval(page, root => root.querySelectorAll('.pn.on').length);
const rectOf = (page, sel) => shadowEval(page, (root, s) => {
  const r = root.querySelector(s).getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom };
}, sel);
const mouseClick = async (page, sel) => {
  const r = await rectOf(page, sel);
  assert.ok(r.w > 0 && r.h > 0, `${sel} が表示されていない`);
  await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
};

test('スマホ（1 段に収まらない幅）では、ツールバーを道具の段・色と元に戻す以降の段の 2 段に整える。広げると 1 段に戻る', async () => {
  const rows = page => shadowEval(page, root => {
    const bar = root.querySelector('.bar'), b = bar.getBoundingClientRect();
    const tops = [...bar.children].filter(e => e.classList.contains('b')).map(e => Math.round(e.getBoundingClientRect().top));
    const right = Math.max(...[...bar.children].filter(e => e.classList.contains('b')).map(e => e.getBoundingClientRect().right));
    return { two: bar.classList.contains('two'), tops, w: Math.round(b.width), over: Math.round(right - b.right), toast: root.querySelector('.t').textContent };
  });
  // タッチのスマホ（390px・360px）: 上の段に 7 個（選択〜塗りつぶし）、下の段に 7 個（色と太さ・元に戻す・やり直す・ページ操作・その他・隠す・閉じる）
  for (const width of [390, 360]) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    // viewport の指定があるページ（ないと、スマホは 980px 幅で描いて縮めて見せる）
    await page.route('**/phone', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><p>phone</p>' }));
    await page.goto(server.base + '/phone');
    await runCode(page, CODE);
    const r = await rows(page);
    assert.equal(r.two, true, width + ': two rows');
    assert.equal(new Set(r.tops.slice(0, 7)).size, 1, width + ': first row ' + r.tops);
    assert.equal(new Set(r.tops.slice(7)).size, 1, width + ': second row ' + r.tops);
    assert.equal(r.tops.length, 14);
    assert.ok(r.tops[7] > r.tops[0], width + ': second row below');
    assert.ok(r.w <= 345 && r.over <= 0 && r.over >= -12, width + ': as wide as the longer row ' + JSON.stringify(r));
    // キーのない端末では、隠すボタンで案内する
    assert.equal(r.toast, '− で隠す');
    assert.deepEqual(errors, []);
    await page.close();
  }
  // マウスの画面を狭めると 2 段に、広げると 1 段に戻る
  const { page, errors } = await fresh('/', { width: 1000, height: 700 });
  assert.equal((await rows(page)).two, false);
  assert.equal((await rows(page)).toast, 'Esc で隠す');
  await page.setViewportSize({ width: 440, height: 700 });
  await page.waitForFunction(() => document.querySelector('paint-bookmarklet').shadowRoot.querySelector('.bar.two'));
  const n = await rows(page);
  assert.equal(new Set(n.tops.slice(0, 7)).size, 1, String(n.tops));
  assert.ok(n.tops[7] > n.tops[0]);
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForFunction(() => !document.querySelector('paint-bookmarklet').shadowRoot.querySelector('.bar.two'));
  assert.equal(new Set((await rows(page)).tops).size, 1, 'one row again');
  assert.deepEqual(errors, []);
  await page.close();
});

test('ツールバーは 1 段で幅 520px 以下。図形は最後に使った物を出し、押すとその図形に、もう一度押すとパネルが開く', async () => {
  const { page, errors } = await fresh();
  const bar = await rectOf(page, '.bar');
  assert.ok(bar.w <= 520 && bar.h <= 50, JSON.stringify(bar));
  // 起動時のお知らせは「Esc で隠す」だけ
  assert.equal(await shadowEval(page, root => root.querySelector('.t.on').textContent), 'Esc で隠す');
  const shapeTitle = () => shadowEval(page, root => root.querySelector('.bar > .shp').title);
  // 図形ボタン: 押すと最後の図形（最初は直線）になるだけ。図形のときにもう一度押すとパネルが開く（ペンと同じ）
  await mouseClick(page, '.bar > .shp');
  assert.match(await toolOn(page), /^直線/);
  assert.equal(await openPanels(page), 0);
  await mouseClick(page, '.bar > .shp');
  assert.equal(await openPanels(page), 1);
  assert.equal(await shadowEval(page, root => root.querySelectorAll('.pn.on .b').length), 4);
  await mouseClick(page, '.pn.on [aria-label^="四角形"]');
  assert.equal(await openPanels(page), 0);
  assert.match(await toolOn(page), /^四角形/);
  assert.match(await shapeTitle(), /^四角形/);
  await page.keyboard.press('o');
  assert.match(await shapeTitle(), /^楕円/);
  await page.keyboard.press('p');
  assert.match(await toolOn(page), /^ペン/);
  // ペンに戻ってから押すと、最後の図形（楕円）になる。描き始めるとパネルは閉じる
  await mouseClick(page, '.bar > .shp');
  assert.match(await toolOn(page), /^楕円/);
  assert.equal(await openPanels(page), 0);
  await mouseClick(page, '.bar > .shp');
  assert.equal(await openPanels(page), 1);
  await drag(page, [[300, 300], [500, 450]], 5);
  assert.equal(await openPanels(page), 0);
  assert.ok((await alphaStats(page, 290, 290, 220, 170)).count > 100);
  assert.deepEqual(errors, []);
  await page.close();
});

test('? で操作の一覧が重なって出る（? ・Esc・外を押すと閉じ、外を押しても線は描かない）。ツールバーにボタンはなく、インストールページにも同じ一覧がある', async () => {
  const { page, errors } = await fresh();
  const nBtn = () => shadowEval(page, root => root.querySelectorAll('.bar > .b').length);
  const n0 = await nBtn();
  const help = () => shadowEval(page, root => {
    const h = root.querySelector('.hp');
    return h && h.isConnected ? [...h.querySelectorAll('.hg > span')].map(s => s.textContent) : null;
  });
  assert.equal(await help(), null);
  await page.keyboard.press('Shift+Slash');
  const rows = await help();
  assert.ok(rows && rows.includes('この一覧') && rows.includes('文字を押す'), JSON.stringify(rows));
  assert.equal(await nBtn(), n0);
  await page.keyboard.press('Shift+Slash');
  assert.equal(await help(), null);
  // Esc はまず一覧を閉じる（隠さない）
  await page.keyboard.press('Shift+Slash');
  await page.keyboard.press('Escape');
  assert.equal(await help(), null);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('paint-bookmarklet-surface')).display), 'block');
  // 外を押すと閉じるだけで、線は描かない
  await page.keyboard.press('Shift+Slash');
  await drag(page, [[100, 600], [300, 650]], 4);
  assert.equal(await help(), null);
  assert.equal(await hist(page), 0);
  // インストールページの一覧と、ツールの中の一覧は同じ内容
  const { page: ip, errors: ie } = await openPage(browser, server.base + '/install');
  const inst = await ip.evaluate(() => [...document.querySelectorAll('.help li > span')].map(s => s.textContent));
  assert.deepEqual(inst, rows);
  assert.ok(await ip.evaluate(() => document.querySelector('#keys-h').parentElement.textContent.includes('を押すと、同じ一覧')));
  assert.deepEqual(ie, []);
  await ip.close();
  assert.deepEqual(errors, []);
  await page.close();
});

test('見た目: 既定は白いガラス（ガウス・ぼかし 18px・地 80%・彩度 200%）。暗い（黒に白）・ガラスなし・ガラスの調整（ぼかし方・強さ・地の濃さ）をインストールページで選べる', async () => {
  const look = page => shadowEval(page, root => {
    const w = root.querySelector('.w'), bar = root.querySelector('.bar'), pn = root.querySelector('.pn'), g = getComputedStyle(bar, '::before'), t = getComputedStyle(bar, '::after');
    return {
      cls: ['light', 'glass', 'gauss'].filter(c => w.classList.contains(c)).join(' '),
      color: getComputedStyle(w).color,
      bar: getComputedStyle(bar).backgroundColor,
      blur: g.backdropFilter,
      tint: t.backgroundColor, // 地の色はぼかし（::before）と別の ::after（T-110。ぼかしが一瞬描かれなくても地は残る）
      blurBg: g.backgroundColor,
      mask: (g.maskImage || g.webkitMaskImage || '').includes('radial-gradient'),
      panel: getComputedStyle(pn, '::before').backdropFilter,
    };
  });
  const { page, errors } = await fresh();
  assert.deepEqual(await look(page), { cls: 'light glass gauss', color: 'rgb(29, 32, 38)', bar: 'rgba(0, 0, 0, 0)', blur: 'blur(18px) saturate(2)', tint: 'rgba(250, 250, 252, 0.8)', blurBg: 'rgba(0, 0, 0, 0)', mask: true, panel: 'blur(18px) saturate(2)' });
  const p0 = await prefs(page);
  assert.deepEqual([p0.theme, p0.glass, p0.blurMode, p0.blur, p0.tint, p0.sat], ['light', true, 'gauss', 18, 80, 200]);
  // 暗い・ガラスなし（T-050 より前の既定）
  await page.evaluate(() => window.__paintBookmarklet.destroy());
  await runCode(page, withDefaults(CODE, { theme: 'dark', glass: false }));
  assert.deepEqual(await look(page), { cls: '', color: 'rgb(232, 233, 238)', bar: 'rgb(32, 34, 40)', blur: 'none', tint: 'rgba(0, 0, 0, 0)', blurBg: 'rgba(0, 0, 0, 0)', mask: false, panel: 'none' });
  // 明るい・ガラス・ふつうのぼかし・強さ 8・濃さ 50%
  await page.evaluate(() => window.__paintBookmarklet.destroy());
  await runCode(page, withDefaults(CODE, { theme: 'light', glass: true, blurMode: 'plain', blur: 8, tint: 50 }));
  assert.deepEqual(await look(page), { cls: 'light glass', color: 'rgb(29, 32, 38)', bar: 'rgba(0, 0, 0, 0)', blur: 'blur(8px) saturate(2)', tint: 'rgba(250, 250, 252, 0.5)', blurBg: 'rgba(0, 0, 0, 0)', mask: false, panel: 'blur(8px) saturate(2)' });
  const p1 = await prefs(page);
  assert.deepEqual([p1.theme, p1.glass, p1.blurMode, p1.blur, p1.tint], ['light', true, 'plain', 8, 50]);
  await page.close();
  // インストールページの既定のまま試すと、白いガラスのガウス（周りも拾い、mask で角丸に切る）で始まる
  const { page: ip, errors: ie } = await openPage(browser, server.base + '/install');
  assert.equal(await ip.isChecked('#p-glass'), true);
  assert.equal(await ip.isChecked('#p-theme input[value="light"]'), true);
  await ip.click('#try');
  const g = await look(ip);
  assert.equal(g.cls, 'light glass gauss');
  assert.equal(g.blur, 'blur(18px) saturate(2)');
  assert.equal(g.mask, true);
  assert.equal(g.panel, 'blur(18px) saturate(2)');
  assert.deepEqual(ie, []);
  assert.deepEqual(errors, []);
  await ip.close();
});

test('ガラスの縁: 地を縁の下まで敷き、細い線をその上に描く。暗い見た目を白いページに置いても白い枠にならず、暗いページでは縁が見える（T-102）', async () => {
  // バーの左の縁を横切る 1 行の画素（赤の値）: [ページ, ページ, 縁, 中, 中, 中]
  const edge = async page => {
    const [x, y] = await shadowEval(page, root => { const b = root.querySelector('.bar').getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y + b.height / 2)]; });
    const png = (await page.screenshot({ clip: { x: x - 2, y, width: 6, height: 1 } })).toString('base64');
    return page.evaluate(async src => {
      const im = new Image(); im.src = 'data:image/png;base64,' + src; await im.decode();
      const c = document.createElement('canvas'); c.width = im.width; c.height = 1;
      const x = c.getContext('2d'); x.drawImage(im, 0, 0);
      return [...x.getImageData(0, 0, im.width, 1).data].filter((_, i) => i % 4 === 0);
    }, png);
  };
  const errors = [];
  for (const [opts, bg] of [[{ theme: 'dark' }, '#fff'], [{ theme: 'dark', blurMode: 'plain' }, '#fff'], [{ theme: 'dark' }, '#1b1d22']]) {
    const { page, errors: e } = await openPage(browser, server.base + '/');
    await page.evaluate(bg => { document.body.style.background = bg; }, bg);
    await runCode(page, withDefaults(CODE, { ui: 'cp2', ...opts }));
    await page.waitForTimeout(200);
    const [p0, , rim, in1] = await edge(page);
    const tag = JSON.stringify(opts) + ' ' + bg;
    if (bg === '#fff') {
      // 白いページ: 縁は白くならず、中の地に近い（前は 255）
      assert.ok(rim < 150 && Math.abs(rim - in1) < 45, tag + ' ' + [p0, rim, in1]);
    } else {
      // 暗いページ: 縁の線が、ページと中の地より明るく見える
      assert.ok(rim > p0 + 15 && rim > in1 + 15, tag + ' ' + [p0, rim, in1]);
    }
    errors.push(...e);
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test('見た目（開発用）と色と太さのパネルは、ツールバーを引いて動かしても閉じず一緒に動く（下の端では上に開く）。引かずに押せば閉じる。ほかのパネルは引くと閉じる（設定ですべて閉じなくできる）', async () => {
  const { page, errors } = await openPage(browser, server.base + '/');
  await runCode(page, withDefaults(CODE, { dev: true }));
  const info = () => shadowEval(page, root => {
    const p = root.querySelector('.pn.on'), r = p && p.getBoundingClientRect(), b = root.querySelector('.bar').getBoundingClientRect();
    return { open: root.querySelectorAll('.pn.on').length, look: !!(p && p.querySelector('[aria-label^="ツールバーの色"]')), px: r && Math.round(r.left - b.left), top: r && Math.round(r.top), bottom: r && Math.round(r.bottom), bx: Math.round(b.left), by: Math.round(b.top) };
  });
  const center = sel => shadowEval(page, (root, sel) => { const r = root.querySelector(sel).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel);
  await mouseClick(page, '[aria-label^="その他"]');
  await mouseClick(page, '.pn.on [aria-label^="見た目"]');
  const a = await info();
  assert.equal(a.look, true);
  // ペンのボタンの上から引いて、右下へ動かす: 開いたまま、ツールバーと一緒に動く
  const [x, y] = await center('.bar [aria-label^="ペン"]');
  await drag(page, [[x, y], [x + 120, y + 80]], 8);
  const b = await info();
  assert.equal(b.open, 1, 'still open while moving');
  assert.equal(b.look, true);
  assert.ok(b.bx === a.bx + 120 && b.by === a.by + 80, JSON.stringify([a, b]));
  assert.equal(await toolOn(page).then(t => /^ペン/.test(t)), true, 'the button under the drag is not pressed');
  // 画面の下の端まで動かすと、パネルは上に開き直して画面に収まる
  const [x2, y2] = await center('.bar [aria-label^="ペン"]');
  await drag(page, [[x2, y2], [x2, 690]], 8);
  const c = await info();
  assert.equal(c.open, 1);
  assert.ok(c.top >= 0 && c.bottom <= c.by, 'opens upward: ' + JSON.stringify(c));
  // 引かずにツールバーを押したら閉じる（押したボタンは効く）
  await mouseClick(page, '.bar [aria-label^="蛍光ペン"]');
  assert.equal((await info()).open, 0);
  assert.match(await toolOn(page), /^蛍光ペン/);
  // 色と太さのパネルも、引いて動かしても閉じない
  const panelIs = sel => shadowEval(page, (root, sel) => !!root.querySelector('.pn.on ' + sel), sel);
  await mouseClick(page, '[aria-label^="色・太さ"]');
  const [x3, y3] = await center('.bar [aria-label^="ペン"]');
  await drag(page, [[x3, y3], [x3, y3 - 200]], 8);
  assert.equal((await info()).open, 1, 'style panel stays open');
  assert.equal(await panelIs('[aria-label="色 1"]'), true);
  await mouseClick(page, '.bar [aria-label^="ペン"]');
  assert.equal((await info()).open, 0);
  // ほかのパネル（その他）は、引き始めると閉じる
  await mouseClick(page, '[aria-label^="その他"]');
  assert.equal((await info()).open, 1);
  const [x4, y4] = await center('.bar [aria-label^="ペン"]');
  await drag(page, [[x4, y4], [x4, y4 + 100]], 8);
  assert.equal((await info()).open, 0);
  assert.deepEqual(errors, []);
  // インストールページの設定（keepPanels）を入れると、その他のパネルも閉じない
  await page.evaluate(() => window.__paintBookmarklet.destroy());
  await runCode(page, withDefaults(CODE, { keepPanels: true }));
  await mouseClick(page, '[aria-label^="その他"]');
  const [x5, y5] = await center('.bar [aria-label^="ペン"]');
  await drag(page, [[x5, y5], [x5, y5 + 100]], 8);
  assert.equal((await info()).open, 1, 'more panel stays open with keepPanels');
  assert.equal(await panelIs('[aria-label^="全消去"]'), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('見た目（開発用）: インストールページの開発用を入れるとメニューに出て、ツールバーの色（暗い・明るい・好きな色）とガラスをその場で変えられ、その見た目をデフォルトにできる', async () => {
  const st = page => shadowEval(page, root => {
    const w = root.querySelector('.w');
    return { cls: ['light', 'glass', 'gauss'].filter(c => w.classList.contains(c)).join(' '), bar: getComputedStyle(root.querySelector('.bar')).backgroundColor, gb: w.style.getPropertyValue('--gb'), color: getComputedStyle(w).color };
  });
  const hasItem = page => shadowEval(page, root => !!root.querySelector('[aria-label^="見た目"]'));
  // 開発用を入れていなければ、メニューに出ない
  const { page, errors } = await fresh();
  assert.equal(await hasItem(page), false);
  await page.evaluate(() => window.__paintBookmarklet.destroy());
  // 暗い・ガラスなしから始めて、切り替えを順に確かめる
  await runCode(page, withDefaults(CODE, { dev: true, theme: 'dark', glass: false }));
  assert.equal(await hasItem(page), true);
  await mouseClick(page, '[aria-label^="その他"]');
  await mouseClick(page, '.pn.on [aria-label^="見た目"]');
  assert.equal(await openPanels(page), 1);
  // 明るい → ガラス風（ガウス）→ ぼかしを 8px
  await mouseClick(page, '.pn.on [aria-label="ツールバーの色: 明るい"]');
  assert.deepEqual(await st(page), { cls: 'light', bar: 'rgb(251, 251, 252)', gb: '18px', color: 'rgb(29, 32, 38)' });
  await mouseClick(page, '.pn.on [aria-label^="ガラス風"]');
  assert.equal((await st(page)).cls, 'light glass gauss');
  await shadowEval(page, root => { const r = [...root.querySelectorAll('.pn.on .r input')][0]; r.value = 8; r.dispatchEvent(new Event('input')); });
  assert.equal((await st(page)).gb, '8px');
  // 彩度（既定 200%）を 250% に: ガラスの backdrop-filter に効く
  const sat = () => shadowEval(page, root => getComputedStyle(root.querySelector('.bar'), '::before').backdropFilter);
  assert.match(await sat(), /saturate\(2\)/);
  await shadowEval(page, root => { const r = [...root.querySelectorAll('.pn.on .r input')][2]; r.value = 250; r.dispatchEvent(new Event('input')); });
  assert.match(await sat(), /saturate\(2\.5\)/);
  assert.equal((await prefs(page)).sat, 250);
  // 好きな色: 濃い色なら白い文字、明るい色なら黒い文字
  const pick = c => shadowEval(page, (root, c) => { const i = root.querySelectorAll('.bar > input.ci')[1]; i.value = c; i.dispatchEvent(new Event('input')); }, c);
  await mouseClick(page, '.pn.on [aria-label^="ガラス風"]');
  await pick('#123456');
  assert.deepEqual(await st(page), { cls: '', bar: 'rgb(18, 52, 86)', gb: '8px', color: 'rgb(232, 233, 238)' });
  await pick('#ffd54f');
  assert.deepEqual(await st(page), { cls: 'light', bar: 'rgb(255, 213, 79)', gb: '8px', color: 'rgb(29, 32, 38)' });
  assert.equal((await prefs(page)).theme, '#ffd54f');
  // 蛍光ペンの予測を切り替える（既定はそのまま）
  const mpOn = () => shadowEval(page, root => [...root.querySelectorAll('.pn.on .sg')].filter(b => b.classList.contains('on')).map(b => b.textContent));
  assert.deepEqual(await mpOn(), ['曲がりに沿う', 'そのまま', 'キャンバスの中で']);
  await mouseClick(page, '.pn.on [aria-label="蛍光ペンの予測: なし"]');
  assert.deepEqual(await mpOn(), ['曲がりに沿う', 'なし', 'キャンバスの中で']);
  // 予測の方法をブラウザ（前の方式）に
  await mouseClick(page, '.pn.on [aria-label="予測の方法: ブラウザ"]');
  assert.equal((await prefs(page)).ppred, 'chrome');
  assert.equal((await prefs(page)).mpred, 'off');
  // 半透明の線の描き方を前の方式（まとめて）にすると、蛍光ペンを選んだ時点でまとめた要素に濃さがかかる
  await mouseClick(page, '.pn.on [aria-label="半透明の線の描き方: まとめて"]');
  assert.deepEqual(await mpOn(), ['ブラウザ', 'なし', 'まとめて']);
  assert.equal((await prefs(page)).blend, 'group');
  // この見た目をデフォルトに: 見た目を持ってインストールページを開く
  await page.evaluate(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; });
  await mouseClick(page, '.pn.on [aria-label^="この見た目をデフォルトに"]');
  const [url] = (await page.evaluate(() => window.__opened))[0];
  const d = JSON.parse(decodeURIComponent(url.slice(url.indexOf('#defaults=') + 10)));
  assert.deepEqual([d.dev, d.theme, d.glass, d.blur, d.sat, d.ppred, d.mpred, d.blend], [true, '#ffd54f', false, 8, 250, 'chrome', 'off', 'group']);
  const { page: ip, errors: ie } = await openPage(browser, server.base + '/install' + url.slice(url.indexOf('#')));
  assert.equal(await ip.isChecked('#p-theme input[value="custom"]'), true);
  assert.equal(await ip.inputValue('#p-tcolor'), '#ffd54f');
  assert.equal(await ip.inputValue('#p-blur'), '8');
  assert.equal(await ip.inputValue('#p-sat'), '250');
  assert.equal(await ip.isChecked('#p-mpred input[value="off"]'), true);
  assert.equal(await ip.isChecked('#p-ppred input[value="chrome"]'), true);
  assert.equal(await ip.isChecked('#p-blend input[value="group"]'), true);
  assert.equal(await ip.isChecked('#p-dev'), true);
  assert.deepEqual(ie, []);
  await ip.close();
  assert.deepEqual(errors, []);
  await page.close();
});

test('選んでいるボタンは、マウスを重ねても押しても青い地のまま（明るい見た目でも白い印が見える）', async () => {
  for (const d of [{}, { theme: 'dark', glass: false }]) {
    const { page, errors } = await fresh();
    if (d.theme) { await page.evaluate(() => window.__paintBookmarklet.destroy()); await runCode(page, withDefaults(CODE, d)); }
    await page.keyboard.press('s');
    const st = () => shadowEval(page, root => { const s = getComputedStyle(root.querySelector('.bar [aria-label^="選択"]')); return [s.backgroundColor, s.color]; });
    assert.deepEqual(await st(), ['rgb(61, 124, 255)', 'rgb(255, 255, 255)'], JSON.stringify(d));
    const r = await rectOf(page, '.bar [aria-label^="選択"]');
    await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2);
    assert.deepEqual(await st(), ['rgb(47, 107, 234)', 'rgb(255, 255, 255)'], '重ねる ' + JSON.stringify(d));
    await page.mouse.down();
    assert.deepEqual(await st(), ['rgb(47, 107, 234)', 'rgb(255, 255, 255)'], '押す ' + JSON.stringify(d));
    await page.mouse.up();
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('ペンと図形の選択肢: 既定はどちらも、選んでいないときは押すとその道具になるだけで、もう一度押すと出る。インストールページで 1 回押しにできる', async () => {
  const { page, errors } = await fresh();
  const check = async (once) => {
    for (const [sel, name] of [['.bar > [aria-label^="ペン"]', /^ペン/], ['.bar > .shp', /^直線/]]) {
      await page.keyboard.press('h');
      await mouseClick(page, sel);
      assert.match(await toolOn(page), name);
      assert.equal(await openPanels(page), once ? 1 : 0, `${sel} 1 回目`);
      if (!once) { await mouseClick(page, sel); assert.equal(await openPanels(page), 1, `${sel} 2 回目`); }
      // 開いているときにもう一度押すと閉じる
      await mouseClick(page, sel);
      assert.equal(await openPanels(page), 0, `${sel} 閉じる`);
    }
  };
  await check(false);
  assert.equal((await prefs(page)).pickOnce, false);
  await page.evaluate(() => window.__paintBookmarklet.destroy());
  await runCode(page, withDefaults(CODE, { pickOnce: true }));
  assert.equal((await prefs(page)).pickOnce, true);
  await check(true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('ツールバーはボタンの上からでも引けば動き（そのボタンは押されない）、引かずに押せばボタンが効く。パネルのスライダーでは動かない', async () => {
  const { page, errors } = await fresh();
  const b0 = await rectOf(page, '.bar');
  const m = await rectOf(page, '.bar > [aria-label^="蛍光ペン"]');
  await page.mouse.move(m.x + m.w / 2, m.y + m.h / 2);
  await page.mouse.down();
  await page.mouse.move(m.x + m.w / 2 + 150, m.y + m.h / 2 + 200, { steps: 5 });
  await page.mouse.up();
  const b1 = await rectOf(page, '.bar');
  assert.ok(near(b1.x, b0.x + 150, 1) && near(b1.y, b0.y + 200, 1), JSON.stringify(b1));
  assert.match(await toolOn(page), /^ペン/);
  // 少しぶれただけ（4px 未満）なら、ボタンが押される
  const m2 = await rectOf(page, '.bar > [aria-label^="蛍光ペン"]');
  await page.mouse.move(m2.x + m2.w / 2, m2.y + m2.h / 2);
  await page.mouse.down();
  await page.mouse.move(m2.x + m2.w / 2 + 2, m2.y + m2.h / 2 + 1);
  await page.mouse.up();
  assert.match(await toolOn(page), /^蛍光ペン/);
  assert.deepEqual(await rectOf(page, '.bar'), b1);
  // パネルのスライダーを引いても、ツールバーは動かない
  await mouseClick(page, '[aria-label^="色・"]');
  const sl = await rectOf(page, '.pn.on input[type=range]');
  await page.mouse.move(sl.x + 4, sl.y + sl.h / 2);
  await page.mouse.down();
  await page.mouse.move(sl.x + 120, sl.y + sl.h / 2, { steps: 5 });
  await page.mouse.up();
  assert.deepEqual(await rectOf(page, '.bar'), b1);
  assert.equal(await openPanels(page), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test('「−」と Esc で隠すと、絵もツールバーも消えて「ブックマークレットで再表示」が出る。再表示を押すと戻り、押さなければ数秒で消える。ブックマークレットで隠したときは出さない', async () => {
  const { page, errors } = await fresh();
  await drag(page, [[100, 400], [400, 400]]);
  const s = await checksum(page);
  await page.evaluate(() => { window.__clicks = 0; document.addEventListener('click', () => window.__clicks++); });
  const state = () => page.evaluate(() => {
    const h = document.querySelector('paint-bookmarklet'), r = h.shadowRoot, t = r.querySelector('.t');
    const host = getComputedStyle(h).display;
    return {
      host,
      surf: getComputedStyle(document.querySelector('paint-bookmarklet-surface')).display,
      bar: host === 'none' ? 'none' : getComputedStyle(r.querySelector('.bar')).display,
      toast: t.classList.contains('on') && t.classList.contains('act') ? t.textContent : '',
      cover: document.elementFromPoint(900, 200).nodeName === 'PAINT-BOOKMARKLET',
    };
  });
  const hidden = { host: 'block', surf: 'none', bar: 'none', toast: 'ブックマークレットで再表示', cover: false };
  const open = { host: 'block', surf: 'block', bar: 'flex', toast: '', cover: true };
  const gone = { host: 'none', surf: 'none', bar: 'none', toast: '', cover: false };
  // 1) − で隠す。お知らせの間もページは押せる。「再表示」を押すと絵も履歴もそのまま戻る
  await mouseClick(page, '.bar > [aria-label^="隠す"]');
  assert.deepEqual(await state(), hidden);
  await page.mouse.click(900, 200);
  assert.equal(await page.evaluate(() => window.__clicks), 1);
  await mouseClick(page, '.t button');
  assert.deepEqual(await state(), open);
  assert.equal(await checksum(page), s);
  assert.equal(await hist(page), 1);
  // 2) Esc でも同じ。押さなければ数秒で消えて何も残らず、ブックマークレットで戻る
  await page.keyboard.press('Escape');
  assert.deepEqual(await state(), hidden);
  await page.waitForTimeout(4300);
  assert.deepEqual(await state(), gone);
  await runBookmarklet(page);
  assert.deepEqual(await state(), open);
  // 3) ブックマークレットで隠したときは出さない。お知らせの間にブックマークレットを押しても戻る
  await runBookmarklet(page);
  assert.deepEqual(await state(), gone);
  await runBookmarklet(page);
  await page.keyboard.press('Escape');
  await runBookmarklet(page);
  assert.deepEqual(await state(), open);
  assert.equal(await checksum(page), s);
  assert.deepEqual(errors, []);
  await page.close();
});

test('色と太さのパネル: 色を選んでも開いたまま、描き始めると閉じてその色で描ける。Esc はまずパネルを閉じる', async () => {
  const { page } = await fresh();
  await mouseClick(page, '[aria-label^="色・"]');
  assert.equal(await openPanels(page), 1);
  await mouseClick(page, '.pn.on [aria-label="色 7"]');
  assert.equal(await openPanels(page), 1);
  assert.equal(await shadowEval(page, root => root.querySelector('.dot').style.getPropertyValue('--c')), '#1e88e5');
  await drag(page, [[100, 400], [600, 400]], 5);
  assert.equal(await openPanels(page), 0);
  const px = await readMain(page, 350, 400);
  assert.deepEqual(px.slice(0, 3), [0x1e, 0x88, 0xe5]);
  // 太さのスライダーもパネルの中で動く
  await mouseClick(page, '[aria-label^="色・"]');
  await setSlider(page, 0, 60);
  assert.equal(await shadowEval(page, root => root.querySelector('.pn.on output').value), '36');
  const display = () => page.evaluate(() => getComputedStyle(document.querySelector('paint-bookmarklet')).display);
  await page.keyboard.press('Escape');
  assert.equal(await openPanels(page), 0);
  assert.equal(await display(), 'block');
  // パネルがなければ Esc で隠す（絵は消え、戻し方のお知らせだけが残る）
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('paint-bookmarklet-surface')).display), 'none');
  assert.equal(await shadowEval(page, root => getComputedStyle(root.querySelector('.bar')).display), 'none');
  await page.close();
});

test('その他のパネルに全消去・背景・保存が名前付きで並び、画面の端では内側に開く', async () => {
  const { page } = await fresh();
  await drag(page, [[100, 400], [600, 400]]);
  // ツールバーを右下の隅へ動かす（区切り線の所から引く）
  const g = await rectOf(page, '.bar > .sep');
  await page.mouse.move(g.x + g.w / 2, g.y + g.h / 2);
  await page.mouse.down();
  await page.mouse.move(995, 695, { steps: 4 });
  await page.mouse.up();
  const bar = await rectOf(page, '.bar');
  assert.ok(bar.r <= 1000 && bar.b <= 700 && bar.b > 680, JSON.stringify(bar));
  for (const sel of ['[aria-label^="その他"]', '[aria-label^="色・"]', '.bar > .shp']) {
    if (sel.includes('shp')) await mouseClick(page, sel); // 図形は 1 回目で図形になり、2 回目でパネル
    await mouseClick(page, sel);
    const p = await rectOf(page, '.pn.on');
    assert.ok(p.x >= 0 && p.y >= 0 && p.r <= 1000 && p.b <= bar.y, `${sel}: ${JSON.stringify(p)}`);
  }
  await mouseClick(page, '[aria-label^="その他"]');
  const labels = await shadowEval(page, root => [...root.querySelectorAll('.pn.on .mi span')].map(s => s.textContent));
  assert.deepEqual(labels.slice(0, 3), ['全消去', '背景: 透明', 'PNG で保存']);
  // 背景は続けて切り替えられるよう、押してもパネルが閉じない
  await mouseClick(page, '.pn.on [aria-label^="背景"]');
  assert.equal(await openPanels(page), 1);
  assert.equal(await shadowEval(page, root => root.querySelectorAll('.pn.on .mi span')[1].textContent), '背景: 白');
  await mouseClick(page, '.pn.on [aria-label^="全消去"]');
  assert.equal(await openPanels(page), 0);
  assert.equal((await alphaStats(page, 0, 0, 1000, 650)).count, 0);
  await page.close();
});

const textBox = page => shadowEval(page, root => {
  const t = root.querySelector('.tx');
  return t ? { value: t.value, focused: root.activeElement === t, color: t.style.getPropertyValue('--c') } : null;
});
const hist = page => page.evaluate(() => window.__paintBookmarklet.stats().history);
// 範囲の中でいちばん濃い画素の RGBA
const inkAt = async (page, x, y, w, h) => {
  const d = await readMain(page, x, y, w, h);
  let best = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > d[best + 3]) best = i - 3;
  return d.slice(best, best + 4);
};

test('文字ツール: クリックした所に入力欄が出て日本語も打てる。入力中はショートカットもページへのキーも止まる', async () => {
  const { page, errors } = await fresh();
  await page.evaluate(() => {
    window.__keys = 0;
    for (const t of ['keydown', 'keyup', 'input', 'beforeinput', 'focusin']) document.addEventListener(t, () => window.__keys++);
  });
  await page.keyboard.press('t');
  assert.match(await toolOn(page), /^文字/);
  await page.evaluate(() => { window.__keys = 0; }); // ショートカットの keyup はページに届く（keydown は止めている）
  await page.mouse.click(200, 450);
  assert.deepEqual(await textBox(page), { value: '', focused: true, color: '#e53935' });
  // ツールのショートカットの文字（p / e / l）を打っても、ツールは変わらない
  await page.keyboard.type('pele');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('日本語');
  assert.equal((await textBox(page)).value, 'pele\n日本語');
  assert.match(await toolOn(page), /^文字/);
  assert.equal(await page.evaluate(() => window.__keys), 0);
  // 外をクリックすると確定する（そのクリックでは新しい入力欄を出さない）
  await page.mouse.click(700, 600);
  assert.equal(await textBox(page), null);
  assert.equal(await hist(page), 1);
  const ink = await inkAt(page, 190, 430, 200, 70);
  assert.ok(ink[3] === 255 && ink[0] > 200 && ink[1] < 90, `ink ${ink}`);
  assert.ok((await alphaStats(page, 190, 430, 200, 70)).count > 200);
  await page.keyboard.press('Control+z');
  assert.equal((await alphaStats(page, 0, 0, 1000, 700)).count, 0);
  await page.keyboard.press('Control+Shift+z');
  assert.ok((await alphaStats(page, 190, 430, 200, 70)).count > 200);
  // 何も打たずに外を押すと、何も残らない
  await page.mouse.click(500, 560);
  assert.ok(await textBox(page));
  await page.mouse.click(500, 640);
  assert.equal(await textBox(page), null);
  assert.equal(await hist(page), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test('文字の入力中は、入力欄の少し外（見えない余白）を押しても確定せずにカーソルが動き、点線の枠の見た目は変わらない。空でも 1 文字分の大きさ', async () => {
  const { page, errors } = await fresh();
  await page.keyboard.press('t');
  await page.mouse.click(200, 300);
  // 入力欄の中身の箱（余白を除いた所）と、点線の枠の外側
  const box = () => shadowEval(page, root => {
    const t = root.querySelector('.tx'), b = t.getBoundingClientRect(), cs = getComputedStyle(t), p = parseFloat(cs.paddingLeft);
    return { l: b.x + p, t: b.y + p, r: b.right - p, b: b.bottom - p, pad: p, ring: p + parseFloat(cs.outlineOffset) };
  });
  // 空のときも、1 行・全角 1 文字分の大きさ（1 文字目を打っても枠がほとんど変わらない）
  const e = await box();
  await page.keyboard.insertText('あ');
  const one = await box();
  assert.ok(e.r - e.l >= 24 && e.b - e.t >= 29, `空の入力欄: ${JSON.stringify(e)}`);
  assert.ok(near(e.l, one.l, 0.5) && near(e.t, one.t, 0.5) && near(e.b, one.b, 0.5) && near(e.r, one.r, 2), `${JSON.stringify(e)} ${JSON.stringify(one)}`);
  await page.keyboard.press('Backspace');
  await page.keyboard.type('Hello');
  const r = await box();
  assert.ok(r.pad >= 8, '押せる余白がある');
  assert.equal(r.ring, 5, '点線の枠は文字から 5px 外のまま');
  // 文字の右 6px を押すと末尾に、文字の上 6px の左端を押すと先頭にカーソルが動く
  await page.mouse.click(r.r + 6, (r.t + r.b) / 2);
  await page.keyboard.type('!');
  await page.mouse.click(r.l + 1, r.t - 6);
  await page.keyboard.type('>');
  assert.equal((await textBox(page)).value, '>Hello!');
  // 余白より外を押すと確定する
  const r2 = await box();
  await page.mouse.click(r2.r + r2.pad + 20, (r2.t + r2.b) / 2);
  assert.equal(await textBox(page), null);
  assert.equal((await textInfo(page))[0].s, '>Hello!');
  assert.deepEqual(errors, []);
  await page.close();
});

test('文字は Esc・ツールの切り替えでも確定し、入力中に変えた色で描かれる。スクロールにも付いていく', async () => {
  const { page } = await fresh('/long');
  await scrollTo(page, 400);
  await page.keyboard.press('t');
  await page.mouse.click(150, 500); // 文書の y = 900
  await page.keyboard.type('Hi');
  // 入力中に色を変えると、入力欄にすぐ反映される（フォーカスは入力欄に残る）
  await mouseClick(page, '[aria-label^="色・"]');
  await mouseClick(page, '.pn.on [aria-label="色 7"]');
  assert.deepEqual(await textBox(page), { value: 'Hi', focused: true, color: '#1e88e5' });
  await page.keyboard.press('Escape');
  assert.equal(await textBox(page), null);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('paint-bookmarklet')).display), 'block');
  assert.deepEqual((await inkAt(page, 140, 480, 60, 40)).slice(0, 3), [0x1e, 0x88, 0xe5]);
  await scrollTo(page, 300);
  assert.ok((await alphaStats(page, 140, 580, 60, 40)).count > 50);
  assert.equal((await alphaStats(page, 140, 480, 60, 40)).count, 0);
  // ツールの切り替えで確定
  await page.mouse.click(500, 200);
  await page.keyboard.type('Yo');
  await click(page, '[aria-label^="ペン"]');
  assert.equal(await textBox(page), null);
  assert.equal(await hist(page), 2);
  assert.ok((await alphaStats(page, 490, 180, 60, 40)).count > 50);
  await page.close();
});

// 選択の中身（.sel）と、つまみの付いた外枠（.sel b）の画面上の矩形。選んでいなければ null
const selBox = (page, frame) => page.evaluate(f => {
  const e = document.querySelector('paint-bookmarklet-surface').shadowRoot.querySelector(f ? '.sel b' : '.sel');
  if (!e || !e.isConnected) return null;
  const r = e.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom };
}, frame);
const near = (a, b, d = 2) => Math.abs(a - b) <= d;
// 面に置いた文字の物（.to）の画面上の矩形。i 番目、なければ null
const textRect = (page, i = 0) => page.evaluate(i => {
  const e = document.querySelector('paint-bookmarklet-surface').shadowRoot.querySelectorAll('.to')[i];
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}, i);

test('選択: 押して 1px 動かしただけで囲む枠が出る（描いている途中の線と同じ live に描く）。離すと選択の枠になり、live の枠は消える', async () => {
  const { page, errors } = await fresh();
  await drag(page, [[200, 300], [400, 340]], 8);
  await page.keyboard.press('s');
  // 1 フレームに 1 回の入力で、1px 動かしたところから広げていく
  const r = await page.evaluate(async () => {
    const root = document.querySelector('paint-bookmarklet').shadowRoot, pad = root.querySelector('.p'), live = root.querySelector('canvas.l');
    const frame = () => new Promise(r => requestAnimationFrame(r));
    const ev = (type, x, y, extra) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 9, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0, buttons: 1, ...extra });
    const ink = () => { const d = live.getContext('2d').getImageData(0, 0, live.width, live.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; };
    const dom = () => { const e = document.querySelector('paint-bookmarklet-surface').shadowRoot.querySelector('.sel'); return !!(e && e.isConnected); };
    pad.dispatchEvent(ev('pointerdown', 180, 280));
    await frame();
    pad.dispatchEvent(ev('pointermove', 181, 281));
    const first = { ink: ink(), dom: dom() };
    for (let i = 1; i <= 20; i++) { await frame(); pad.dispatchEvent(ev('pointermove', 181 + i * 12, 281 + i * 4)); }
    const big = ink();
    pad.dispatchEvent(ev('pointerup', 421, 361, { buttons: 0 }));
    const up = dom();
    for (let i = 0; i < 4; i++) await frame();
    return { first, big, up, later: ink() };
  });
  assert.ok(r.first.ink > 0 && !r.first.dom, JSON.stringify(r));
  assert.ok(r.big > r.first.ink * 10, JSON.stringify(r));
  assert.equal(r.up, true, '離すと選択の枠');
  assert.equal(r.later, 0, 'live の枠は消える');
  const sb = await selBox(page);
  assert.ok(sb && near(sb.x, 200, 4) && near(sb.r, 400, 4), JSON.stringify(sb));
  assert.deepEqual(errors, []);
  await page.close();
});

test('選択: 囲むと中身に詰めた枠で選ばれ、移動して確定・元に戻す・やり直すが画素単位で効く', async () => {
  const { page, errors } = await fresh();
  await drag(page, [[100, 300], [400, 300]], 10);
  const s0 = await checksum(page);
  await page.keyboard.press('s');
  assert.match(await toolOn(page), /^選択/);
  await drag(page, [[80, 250], [450, 350]], 5);
  // 余白を詰めて、線（幅 4px）の外接矩形が選ばれる。浮いている間は面から消えている
  const b = await selBox(page);
  assert.ok(near(b.x, 98) && near(b.r, 402) && near(b.y, 298) && near(b.b, 302), JSON.stringify(b));
  assert.equal((await alphaStats(page, 0, 0, 1000, 700)).count, 0);
  // 動かさずに確定しても、元どおりで履歴は増えない
  await page.keyboard.press('Escape');
  assert.equal(await selBox(page), null);
  assert.equal(await checksum(page), s0);
  assert.equal(await hist(page), 1);
  // 細い線でも、枠の中を押せば移動になる
  await drag(page, [[80, 250], [450, 350]], 5);
  await drag(page, [[250, 300], [250, 500]], 5);
  assert.ok(near((await selBox(page)).y, 498));
  await page.keyboard.press('Enter');
  assert.equal(await hist(page), 2);
  assert.equal((await alphaStats(page, 90, 290, 320, 20)).count, 0);
  assert.ok((await alphaStats(page, 90, 490, 320, 20)).count > 1000);
  const s1 = await checksum(page);
  await page.keyboard.press('Control+z');
  assert.equal(await checksum(page), s0);
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await checksum(page), s1);
  // 何もない所を囲んでも、クリックしても選ばれない
  await drag(page, [[600, 100], [900, 200]], 5);
  assert.equal(await selBox(page), null);
  await page.mouse.click(700, 600);
  assert.equal(await selBox(page), null);
  assert.deepEqual(errors, []);
  await page.close();
});

test('選択: クリックで描いた物を選び（四角で囲んだ文字は文字、四角は四角だけ）、角で比を保って縮小・辺で片方向・矢印で移動・Delete で削除', async () => {
  const { page, errors } = await fresh();
  await page.keyboard.press('r');
  await drag(page, [[100, 300], [500, 500]], 5);
  await page.keyboard.press('t');
  await page.mouse.click(150, 400);
  await page.keyboard.type('Note');
  await page.keyboard.press('Escape');
  await page.keyboard.press('s');
  // 文字をクリックすると、四角ではなく文字が選ばれる
  await page.mouse.click(170, 400);
  const t = await selBox(page);
  assert.ok(t.w < 100 && t.h < 40 && t.x > 140, JSON.stringify(t));
  await page.keyboard.press('Escape');
  // 四角の線をクリックすると四角だけが選ばれる（文字は物なので動かない）
  const textAt0 = await textRect(page);
  await page.mouse.click(300, 500);
  const r = await selBox(page);
  assert.ok(near(r.x, 98) && near(r.r, 502) && near(r.y, 298) && near(r.b, 502), JSON.stringify(r));
  // 右下の角を対角線に沿って半分まで引くと、縦横比を保って半分になる（少し縦にずれても比は保つ）
  const f = await selBox(page, true);
  await drag(page, [[f.r, f.b], [f.r - r.w / 2, f.b - r.h / 2 + 6]], 5);
  const k = await selBox(page);
  assert.ok(near(k.x, r.x) && near(k.y, r.y) && near(k.w, r.w / 2, 4) && near(k.h, r.h / 2, 4) && near(k.w / k.h, r.w / r.h, 0.02), JSON.stringify(k));
  // 右の辺を引くと、横だけ伸びる
  const f2 = await selBox(page, true);
  await drag(page, [[f2.r, f2.y + f2.h / 2], [f2.r + 100, f2.y + f2.h / 2 + 30]], 5);
  const e2 = await selBox(page);
  assert.ok(near(e2.w, k.w + 100, 3) && near(e2.h, k.h), JSON.stringify(e2));
  // 矢印キーで 1px、Shift で 10px
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  const m = await selBox(page);
  assert.ok(near(m.x, e2.x + 1, 0.5) && near(m.y, e2.y + 10, 0.5), JSON.stringify(m));
  await page.keyboard.press('Enter');
  assert.equal(await hist(page), 3);
  assert.deepEqual(await textRect(page), textAt0);
  // 四角の左の辺と上の辺（文字とは重ならない所）で、四角が描かれているかを見る
  const rectInk = async () => (await alphaStats(page, m.x - 2, m.y - 2, 10, m.h + 4)).count + (await alphaStats(page, m.x, m.y - 2, m.w, 8)).count;
  assert.ok(await rectInk() > 300);
  // Delete で四角だけが消え、文字は残る。元に戻すで戻る
  await page.mouse.click(m.x + 1, m.y + m.h / 2);
  assert.ok(await selBox(page));
  await page.keyboard.press('Delete');
  assert.equal(await selBox(page), null);
  assert.equal(await rectInk(), 0);
  assert.deepEqual(await textRect(page), textAt0);
  assert.ok((await alphaStats(page, textAt0.x, textAt0.y, textAt0.w, textAt0.h)).count > 50);
  await page.keyboard.press('Control+z');
  assert.ok(await rectInk() > 300);
  assert.deepEqual(errors, []);
  await page.close();
});

test('選択: 選んだままスクロールすると枠も本文と一緒に動き、ツールの切り替えで確定する', async () => {
  const { page } = await fresh('/long');
  await scrollTo(page, 400);
  await drag(page, [[100, 500], [300, 500]], 5); // 文書の y = 900
  await page.keyboard.press('s');
  await page.mouse.click(200, 500);
  assert.ok(near((await selBox(page)).y, 498));
  await scrollTo(page, 300);
  const b = await selBox(page);
  assert.ok(near(b.y, 598), JSON.stringify(b));
  await drag(page, [[200, 600], [500, 650]], 5);
  await page.keyboard.press('p');
  assert.equal(await selBox(page), null);
  assert.equal(await hist(page), 2);
  await scrollTo(page, 0);
  assert.equal((await alphaStats(page, 0, 0, 1000, 700)).count, 0);
  await scrollTo(page, 350);
  // 文書の y = 950 に、x = 400〜600 で置かれている
  assert.ok((await alphaStats(page, 395, 590, 210, 20)).count > 500);
  assert.equal((await alphaStats(page, 90, 540, 210, 20)).count, 0);
  await page.close();
});

test('選択を引いている途中に元に戻す・やり直す・道具のキー・保存を押しても、空の枠が残らない。元に戻す・やり直すは何もせず、道具のキーと保存は引く前の位置で確定する（T-120）', async () => {
  const { page, errors } = await fresh();
  const selected = () => page.evaluate(() => !!window.__paintBookmarklet.stats().selection);
  const frame = () => page.evaluate(() => {
    const e = document.querySelector('paint-bookmarklet-surface').shadowRoot.querySelector('.sel');
    return !!(e && e.isConnected);
  });
  await drag(page, [[100, 300], [400, 300]], 10);
  const s0 = await checksum(page);
  await page.keyboard.press('s');
  await drag(page, [[80, 250], [450, 350]], 5);
  // 元に戻す・やり直すは、引いている間は何もしない。離すと動かした所で選ばれたまま
  await page.mouse.move(250, 300);
  await page.mouse.down();
  await page.mouse.move(250, 350, { steps: 5 });
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await hist(page), 1);
  assert.equal(await selected(), true);
  await page.mouse.move(250, 400, { steps: 5 });
  await page.mouse.up();
  assert.ok(near((await selBox(page)).y, 398), JSON.stringify(await selBox(page)));
  // 離した後の元に戻すは今まで通り（動かした分を確定してから戻す）
  await page.keyboard.press('Control+z');
  assert.equal(await selected(), false);
  assert.equal(await frame(), false);
  assert.equal(await checksum(page), s0);
  // 道具のキー: 引いている途中なら、その引きを取り消して引く前の位置で確定する。枠は残らず、残りの引きでは何も描かない
  await drag(page, [[80, 250], [450, 350]], 5);
  await page.mouse.move(250, 300);
  await page.mouse.down();
  await page.mouse.move(250, 350, { steps: 5 });
  await page.keyboard.press('p');
  await page.mouse.move(250, 450, { steps: 5 });
  await page.mouse.up();
  assert.match(await toolOn(page), /^ペン/);
  assert.equal(await selected(), false);
  assert.equal(await frame(), false);
  assert.equal(await checksum(page), s0);
  // 保存（Ctrl+S）も同じ
  await page.keyboard.press('s');
  await drag(page, [[80, 250], [450, 350]], 5);
  await page.mouse.move(250, 300);
  await page.mouse.down();
  await page.mouse.move(250, 350, { steps: 5 });
  const dl = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  await dl;
  await page.mouse.move(250, 450, { steps: 5 });
  await page.mouse.up();
  assert.equal(await selected(), false);
  assert.equal(await frame(), false);
  assert.equal(await checksum(page), s0);
  assert.deepEqual(errors, []);
  await page.close();
});

const textInfo = page => page.evaluate(() => [...document.querySelector('paint-bookmarklet-surface').shadowRoot.querySelectorAll('.to')]
  .map(e => ({ s: e.textContent, fs: getComputedStyle(e).fontSize, ed: e.classList.contains('ed'), gone: e.classList.contains('gone') })));

test('文字の物: 押してそのまま動かせ、角で拡大すると文字の大きさが変わる。ダブルクリックや文字ツールで書き直せ、どれも元に戻せる', async () => {
  const { page, errors } = await fresh();
  await page.keyboard.press('t');
  await page.mouse.click(200, 300);
  await page.keyboard.type('Hello');
  await page.keyboard.press('Escape');
  const t0 = await textRect(page);
  assert.deepEqual(await textInfo(page), [{ s: 'Hello', fs: '24px', ed: false, gone: false }]);
  // 選択ツール: 文字を押したまま引くと、そのまま動く
  await page.keyboard.press('s');
  await drag(page, [[t0.x + t0.w / 2, t0.y + t0.h / 2], [t0.x + t0.w / 2 + 200, t0.y + t0.h / 2 + 100]], 5);
  assert.equal(await shadowEval(page, () => document.querySelector('paint-bookmarklet-surface').shadowRoot.querySelector('.sel').classList.contains('only')), true);
  await page.keyboard.press('Escape');
  const t1 = await textRect(page);
  assert.ok(near(t1.x, t0.x + 200, 1) && near(t1.y, t0.y + 100, 1), JSON.stringify(t1));
  assert.equal(await hist(page), 2);
  // 角のつまみを対角線に沿って引いて 2 倍にすると、文字そのものが 48px になる（画像の拡大ではない）
  await page.mouse.click(t1.x + 5, t1.y + t1.h / 2);
  const f = await selBox(page, true);
  await drag(page, [[f.r, f.b], [f.r + t1.w, f.b + t1.h]], 5);
  await page.keyboard.press('Enter');
  assert.equal((await textInfo(page))[0].fs, '48px');
  const t2 = await textRect(page);
  assert.ok(near(t2.x, t1.x, 1) && near(t2.w, t1.w * 2, 4), JSON.stringify(t2));
  // ダブルクリックで書き直す
  await page.mouse.dblclick(t2.x + 10, t2.y + t2.h / 2);
  assert.deepEqual(await textBox(page), { value: 'Hello', focused: true, color: '#e53935' });
  assert.equal((await textInfo(page))[0].ed, true);
  await page.keyboard.type(' world');
  await page.keyboard.press('Escape');
  assert.deepEqual(await textInfo(page), [{ s: 'Hello world', fs: '48px', ed: false, gone: false }]);
  assert.match(await toolOn(page), /^選択/, '書き直しても道具は変わらない');
  // 文字ツールで文字を押しても書き直せる。空にして確定すると消える
  await page.keyboard.press('t');
  await page.mouse.click(t2.x + 10, t2.y + t2.h / 2);
  assert.equal((await textBox(page)).value, 'Hello world');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  assert.deepEqual(await textInfo(page), []);
  assert.equal(await hist(page), 5);
  // 1 手ずつ戻る
  await page.keyboard.press('Control+z');
  assert.equal((await textInfo(page))[0].s, 'Hello world');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await textInfo(page), [{ s: 'Hello', fs: '48px', ed: false, gone: false }]);
  await page.keyboard.press('Control+z');
  assert.equal((await textInfo(page))[0].fs, '24px');
  assert.deepEqual(await textRect(page), t1);
  await page.keyboard.press('Control+z');
  assert.deepEqual(await textRect(page), t0);
  await page.keyboard.press('Control+z');
  assert.deepEqual(await textInfo(page), []);
  await page.keyboard.press('Control+Shift+z');
  assert.deepEqual(await textRect(page), t0);
  assert.deepEqual(errors, []);
  await page.close();
});

test('全消去は、消しゴム・選択の削除で全部消した後や、最初まで元に戻した後も何もしない。一部だけ消した後は消す', async () => {
  const { page, errors } = await fresh();
  const n = async () => (await page.evaluate(() => window.__paintBookmarklet.stats().history));
  // 消しゴム（32px）で線（4px）を全部なぞる
  await drag(page, [[100, 300], [200, 300]], 5);
  await page.keyboard.press('e');
  await drag(page, [[90, 300], [210, 300]], 10);
  assert.equal((await alphaStats(page, 80, 280, 140, 40)).count, 0);
  assert.equal(await n(), 2);
  await page.keyboard.press('Delete');
  assert.equal(await n(), 2, 'after erasing everything');
  // 一部だけ消した後は全消去する
  await page.keyboard.press('p');
  await drag(page, [[100, 400], [300, 400]], 5);
  await page.keyboard.press('e');
  await drag(page, [[90, 400], [150, 400]], 5);
  await page.keyboard.press('Delete');
  assert.equal(await n(), 5, 'partly erased');
  assert.equal((await alphaStats(page, 80, 380, 240, 40)).count, 0);
  // 選択して削除した後
  await page.keyboard.press('p');
  await drag(page, [[400, 300], [500, 300]], 5);
  await page.keyboard.press('s');
  await drag(page, [[380, 270], [520, 330]], 5);
  await page.keyboard.press('Delete');
  const k = await n();
  assert.equal((await alphaStats(page, 380, 280, 140, 40)).count, 0);
  await page.keyboard.press('Delete');
  assert.equal(await n(), k, 'after deleting the selection');
  // 最初まで元に戻した後
  for (let i = 0; i < k; i++) await page.keyboard.press('Control+z');
  assert.equal((await alphaStats(page, 0, 0, 1000, 700)).count, 0);
  await page.keyboard.press('Delete');
  assert.equal(await n(), k, 'after undoing everything');
  // やり直して絵が戻れば、全消去は 1 手（やり直した手は描く手なので読み戻さない）
  await page.keyboard.press('Control+Shift+z');
  await page.keyboard.press('Delete');
  assert.equal(await n(), 2);
  assert.deepEqual(errors, []);
  await page.close();
});

test('全消去は、消す物がないときは何もしない（履歴が増えない）。積むのは描いた範囲に掛かるタイルだけ', async () => {
  const { page, errors } = await fresh();
  const st = () => page.evaluate(() => { const s = window.__paintBookmarklet.stats(); return [s.history, s.historyPixels]; });
  // 何も描いていなければ増えない
  await page.keyboard.press('Delete');
  assert.deepEqual(await st(), [0, 0]);
  // 描いてから全消去は 1 手。続けて押しても増えない
  await drag(page, [[100, 300], [200, 300]], 5);
  await page.keyboard.press('Delete');
  assert.equal((await st())[0], 2);
  await page.keyboard.press('Delete');
  assert.equal((await st())[0], 2, 'second clear does nothing');
  // 元に戻すと絵が戻り、もう一度全消去できる。やり直した直後（直前の手が全消去）は増えない
  await page.keyboard.press('Control+z');
  assert.ok((await alphaStats(page, 90, 290, 120, 20)).count > 100);
  await page.keyboard.press('Control+Shift+z');
  assert.equal((await alphaStats(page, 90, 290, 120, 20)).count, 0);
  await page.keyboard.press('Delete');
  assert.equal((await st())[0], 2, 'clear right after redoing a clear does nothing');
  // 別の所に小さく描いて全消去すると、前に描いて空になったタイルは積まない（1x の表示タイルは 256px 四方）
  await drag(page, [[700, 600], [720, 600]], 5);
  const [n0, p0] = await st();
  await page.keyboard.press('Delete');
  const [n1, p1] = await st();
  assert.equal(n1, n0 + 1);
  assert.ok(p1 - p0 <= 2 * 256 * 256, 'only tiles in the drawn range: ' + (p1 - p0));
  await page.keyboard.press('Control+z');
  assert.ok((await alphaStats(page, 690, 590, 40, 20)).count > 20);
  assert.equal((await alphaStats(page, 90, 290, 120, 20)).count, 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test('文字の物: 消しゴムでなぞると消え（なぞっている間は薄い）、囲むと線と一緒に動き、全消去でも消えて元に戻せる', async () => {
  const { page, errors } = await fresh();
  await page.keyboard.press('t');
  await page.mouse.click(200, 300);
  await page.keyboard.type('Erase me');
  await page.keyboard.press('Escape');
  await page.keyboard.press('p');
  await drag(page, [[150, 400], [450, 400]], 5);
  const t0 = await textRect(page);
  assert.ok((await alphaStats(page, t0.x, t0.y, t0.w, t0.h)).count > 100, '書き出し（pixels）に文字が入る');
  // 消しゴムでなぞる: 離すまでは薄く見え、離すと消える。線には触れていない
  await page.keyboard.press('e');
  await page.mouse.move(150, 300);
  await page.mouse.down();
  await page.mouse.move(300, 300, { steps: 5 });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  assert.equal((await textInfo(page))[0].gone, true);
  await page.mouse.up();
  assert.deepEqual(await textInfo(page), []);
  assert.equal(await hist(page), 3);
  assert.ok((await alphaStats(page, 140, 390, 320, 20)).count > 500);
  await page.keyboard.press('Control+z');
  assert.deepEqual(await textInfo(page), [{ s: 'Erase me', fs: '24px', ed: false, gone: false }]);
  // 囲むと、範囲に収まる文字も線と一緒に選ばれて動く。1 手で戻る
  await page.keyboard.press('s');
  await drag(page, [[100, 250], [500, 450]], 5);
  assert.equal(await shadowEval(page, () => document.querySelector('paint-bookmarklet-surface').shadowRoot.querySelector('.sel').classList.contains('only')), false);
  await drag(page, [[300, 350], [300, 450]], 5);
  await page.keyboard.press('Escape');
  const t1 = await textRect(page);
  assert.ok(near(t1.y, t0.y + 100, 1) && near(t1.x, t0.x, 1), JSON.stringify(t1));
  assert.ok((await alphaStats(page, 140, 490, 320, 20)).count > 500);
  assert.equal((await alphaStats(page, t1.x + t1.w + 5, 390, 460 - t1.x - t1.w - 5, 20)).count, 0, '線の元の位置（文字と重ならない所）');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await textRect(page), t0);
  assert.ok((await alphaStats(page, 140, 390, 320, 20)).count > 500);
  // 全消去は文字も消す。元に戻すで両方戻る
  await page.keyboard.press('Delete');
  assert.deepEqual(await textInfo(page), []);
  assert.equal((await alphaStats(page, 0, 0, 1000, 700)).count, 0);
  await page.keyboard.press('Control+z');
  assert.equal((await textInfo(page)).length, 1);
  assert.ok((await alphaStats(page, 140, 390, 320, 20)).count > 500);
  assert.deepEqual(errors, []);
  await page.close();
});

test('文字の上の移動のカーソルは、スクロールした後も文字の今の位置に出る', async () => {
  const { page, errors } = await fresh('/long');
  await page.keyboard.press('t');
  await page.mouse.click(300, 400);
  await page.keyboard.type('Hello');
  await page.keyboard.press('Escape');
  await page.keyboard.press('p');
  const cursor = () => shadowEval(page, root => root.querySelector('.p').style.cursor);
  const t0 = await textRect(page);
  await page.mouse.move(t0.x + 5, t0.y + t0.h / 2);
  assert.equal(await cursor(), 'move');
  // 描かずにスクロールすると、文字は画面の上へ 200px 動く
  await scrollTo(page, 200);
  const t1 = await textRect(page);
  assert.ok(near(t1.y, t0.y - 200, 1), JSON.stringify([t0, t1]));
  await page.mouse.move(t1.x + 5, t1.y + t1.h / 2);
  assert.equal(await cursor(), 'move', '文字の今の位置');
  await page.mouse.move(t0.x + 5, t0.y + t0.h / 2);
  assert.match(await cursor(), /^url\(/, '文字のあった所（今は何もない）');
  assert.deepEqual(errors, []);
  await page.close();
});

test('ページ操作モードでツールを選ぶ（ボタンでもキーでも）と、描画モードに戻ってすぐ描ける', async () => {
  const { page } = await fresh();
  const passOn = () => shadowEval(page, root => root.querySelector('.w').classList.contains('pass'));
  await page.keyboard.press('v');
  assert.equal(await passOn(), true);
  await mouseClick(page, '.bar [aria-label^="蛍光ペン"]');
  assert.equal(await passOn(), false);
  assert.match(await toolOn(page), /^蛍光ペン/);
  await drag(page, [[100, 400], [400, 400]], 5);
  assert.ok((await alphaStats(page, 90, 380, 320, 40)).count > 1000);
  await page.keyboard.press('v');
  await page.keyboard.press('p');
  assert.equal(await passOn(), false);
  assert.match(await toolOn(page), /^ペン/);
  // ペン・図形を選んだまま、そのボタンを押しても戻り、種類のパネルも描画モードの 2 回目と同じに開く。もう一度押すと閉じる
  const panels = () => shadowEval(page, root => root.querySelectorAll('.pn.on').length);
  for (const [key, sel] of [['p', '.bar [aria-label^="ペン"]'], ['l', '.bar .shp']]) {
    await page.keyboard.press(key);
    await page.keyboard.press('v');
    assert.equal(await passOn(), true, key);
    await mouseClick(page, sel);
    assert.equal(await passOn(), false, key + ': back to drawing');
    assert.equal(await panels(), 1, key + ': panel opens as usual');
    await mouseClick(page, sel);
    assert.equal(await panels(), 0, key + ': closes on the next press');
  }
  await page.close();
});

test('文字に触れる: ペンのまま文字を押して動かし、もう一度押すと書き直し（道具と色はそのまま）。外から描く線は描ける。設定で切れる', async () => {
  const { page, errors } = await fresh();
  await page.keyboard.press('t');
  await page.mouse.click(200, 300);
  await page.keyboard.type('Memo');
  await page.keyboard.press('Escape');
  await page.keyboard.press('p');
  const t0 = await textRect(page);
  // 文字の上では移動のカーソル、外ではペンのカーソル
  const cursor = () => shadowEval(page, root => root.querySelector('.p').style.cursor);
  await page.mouse.move(t0.x + 5, t0.y + t0.h / 2);
  assert.equal(await cursor(), 'move');
  await page.mouse.move(600, 600);
  assert.match(await cursor(), /^url\(/);
  // ペンのまま、文字を押して引くと動く（線は描かれない）
  await drag(page, [[t0.x + 5, t0.y + t0.h / 2], [t0.x + 155, t0.y + t0.h / 2 + 50]], 5);
  const t1 = await textRect(page);
  assert.ok(near(t1.x, t0.x + 150, 1) && near(t1.y, t0.y + 50, 1), JSON.stringify(t1));
  assert.match(await toolOn(page), /^ペン/);
  // 選んでいる文字をもう一度押すと書き直し。道具はペンのまま
  await page.mouse.click(t1.x + 5, t1.y + t1.h / 2);
  assert.deepEqual(await textBox(page), { value: 'Memo', focused: true, color: '#e53935' });
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  assert.equal((await textInfo(page))[0].s, 'Memo!');
  assert.match(await toolOn(page), /^ペン/);
  assert.equal(await hist(page), 3); // 追加・移動・書き直し
  // 外から描き始めて文字の上を通る線は描ける。色を変えても文字の色は変わらない
  await page.keyboard.press('7');
  const t2 = await textRect(page);
  await drag(page, [[100, 500], [t2.x + 20, t2.y + t2.h / 2], [700, 500]], 8);
  assert.equal(await hist(page), 4);
  assert.deepEqual(await textRect(page), t2);
  assert.equal(await page.evaluate(() => document.querySelector('paint-bookmarklet-surface').shadowRoot.querySelector('.to').style.getPropertyValue('--c')), '#e53935');
  const ink = await inkAt(page, 100, 490, 30, 20);
  assert.ok(near(ink[0], 0x1e) && near(ink[1], 0x88) && near(ink[2], 0xe5), `ink ${ink}`);
  assert.deepEqual(errors, []);
  await page.close();

  // 設定で切ると、文字の上からでもペンで描ける（文字は動かない）
  const o2 = await openPage(browser, server.base + '/');
  await runCode(o2.page, withDefaults(CODE, { touchText: false }));
  await o2.page.keyboard.press('t');
  await o2.page.mouse.click(200, 300);
  await o2.page.keyboard.type('Memo');
  await o2.page.keyboard.press('Escape');
  await o2.page.keyboard.press('p');
  const u0 = await textRect(o2.page);
  await drag(o2.page, [[u0.x + 5, u0.y + u0.h / 2], [u0.x + 155, u0.y + u0.h / 2 + 50]], 5);
  assert.deepEqual(await textRect(o2.page), u0);
  assert.equal(await hist(o2.page), 2);
  assert.deepEqual(o2.errors, []);
  await o2.page.close();
});

test('文字に触れる: ペンで動かした文字を選んだままでも、その文字が元あった所から線を描ける（囲む選択にならない）。元あった所のカーソルもペンのまま（T-121）', async () => {
  const { page, errors } = await fresh();
  await page.keyboard.press('t');
  await page.mouse.click(200, 300);
  await page.keyboard.type('Memo');
  await page.keyboard.press('Escape');
  await page.keyboard.press('p');
  const t0 = await textRect(page);
  const cx = t0.x + 5, cy = t0.y + t0.h / 2;
  await drag(page, [[cx, cy], [cx + 150, cy + 80]], 5);
  assert.ok(await selBox(page), 'the moved text stays selected');
  // 元あった所では、移動のカーソルではなくペンのカーソル
  await page.mouse.move(cx, cy);
  assert.match(await shadowEval(page, root => root.querySelector('.p').style.cursor), /^url\(/);
  // 元あった所から線を描くと線が描け、文字は動かした所で確定する
  await drag(page, [[cx, cy], [cx + 120, cy - 60]], 8);
  assert.equal(await selBox(page), null);
  assert.equal(await hist(page), 3); // 文字・移動・線
  assert.ok((await alphaStats(page, cx + 40, cy - 50, 60, 40)).count > 50, 'the line is drawn');
  const t1 = await textRect(page);
  assert.ok(near(t1.x, t0.x + 150, 1) && near(t1.y, t0.y + 80, 1), JSON.stringify(t1));
  assert.deepEqual(errors, []);
  await page.close();
});

test('インストールページの「Paint」ボタンの中身が、そのままのブックマークレットになっている', async () => {
  const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="bm" class="bm" href="([^"]*)"/);
  assert.ok(m);
  const href = m[1].replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  assert.equal(href, BOOKMARKLET);
  assert.equal(decodeURIComponent(href.slice(11)), CODE.trim());
});

const prefs = page => page.evaluate(() => window.__paintBookmarklet.stats().prefs);
const lsGet = page => page.evaluate(() => localStorage.getItem('paint-bookmarklet'));
const setRange = (page, sel, v) => page.evaluate(([s, v]) => { const r = document.querySelector(s); r.value = v; r.dispatchEvent(new Event('input', { bubbles: true })); }, [sel, v]);

test('インストールページで選んだ設定入りのブックマークレットになり、別のサイトでもその設定で始まる。開き直しても選んだ設定が残る', async () => {
  const { page, errors } = await openPage(browser, server.base + '/install');
  const base = await page.getAttribute('#bm', 'href');
  assert.ok(base.includes("'__PAINT_DEFAULTS__'"));
  // ページが持つ組み込みの既定は、本体の既定と同じ
  await page.click('#try');
  const p0 = await prefs(page);
  assert.equal(p0.color, await page.inputValue('#p-custom'));
  for (const k of ['pen', 'marker', 'eraser', 'text']) assert.equal(String(p0.size[k]), await page.inputValue('#p-' + k), k);
  assert.equal(p0.tool, await page.inputValue('#p-tool'));
  assert.equal(p0.touchText, await page.isChecked('#p-touch'));
  assert.equal(p0.calc, await page.isChecked('#p-calc'));
  assert.equal(p0.pickOnce, await page.isChecked('#p-once'));
  assert.equal(p0.keepPanels, await page.isChecked('#p-keep'));
  assert.equal(p0.glass, await page.isChecked('#p-glass'));
  assert.equal(p0.theme, await page.evaluate(() => document.querySelector('#p-theme input:checked').value));
  assert.equal(p0.blurMode, await page.evaluate(() => document.querySelector('#p-mode input:checked').value));
  assert.equal(String(p0.blur), await page.inputValue('#p-blur'));
  assert.equal(String(p0.tint), await page.inputValue('#p-tint'));
  assert.equal(String(p0.sat), await page.inputValue('#p-sat'));
  assert.equal(p0.dev, await page.isChecked('#p-dev'));
  assert.equal(p0.mpred, await page.evaluate(() => document.querySelector('#p-mpred input:checked').value));
  assert.equal(p0.ppred, await page.evaluate(() => document.querySelector('#p-ppred input:checked').value));
  assert.equal(p0.ui, await page.evaluate(() => document.querySelector('#p-ui input:checked').value));
  assert.equal(p0.blend, await page.evaluate(() => document.querySelector('#p-blend input:checked').value));
  await page.evaluate(() => window.__paintBookmarklet.destroy());
  // 選ぶと、ボタンの中身が変わる
  await page.click('[aria-label="色 7"]');
  await setRange(page, '#p-pen', 10);
  await setRange(page, '#p-text', 40);
  await page.selectOption('#p-tool', 'marker');
  await page.check('#p-bar input[value="top-left"]');
  await page.uncheck('#p-touch');
  const href = await page.getAttribute('#bm', 'href');
  assert.notEqual(href, base);
  const want = p => {
    assert.equal(p.color, '#1e88e5');
    assert.equal(p.size.pen, 10);
    assert.equal(p.size.text, 40);
    assert.equal(p.size.marker, 24);
    assert.equal(p.tool, 'marker');
    assert.equal(p.touchText, false);
    assert.ok(p.bar[0] <= 12 && p.bar[1] <= 12, JSON.stringify(p.bar));
  };
  // このページで試しても、別のサイトで本物の javascript: URL として押しても同じ設定
  await page.click('#try');
  want(await prefs(page));
  await page.evaluate(() => window.__paintBookmarklet.destroy());
  const o2 = await openPage(browser, server.base + '/');
  await o2.page.evaluate(u => { location.href = u; }, href);
  await o2.page.waitForFunction(() => !!window.__paintBookmarklet);
  want(await prefs(o2.page));
  assert.deepEqual(o2.errors, []);
  await o2.page.close();
  // 保存は組み込みの既定との差分だけ（あとで既定を変えると、触っていない所には新しい既定が効く）
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('paint-defaults')));
  assert.deepEqual(await saved(), { color: '#1e88e5', tool: 'marker', size: { pen: 10, text: 40 }, bar: 'top-left', touchText: false });
  // 開き直しても残り、「最初の状態に戻す」で元のボタンに戻る
  await page.reload();
  assert.equal(await page.isChecked('[aria-label="色 7"]'), true);
  assert.equal(await page.inputValue('#p-pen'), '10');
  assert.equal(await page.isChecked('#p-touch'), false);
  assert.equal(await page.getAttribute('#bm', 'href'), href);
  await page.click('#p-reset');
  assert.equal(await page.getAttribute('#bm', 'href'), base);
  assert.deepEqual(await saved(), {});
  assert.deepEqual(errors, []);
  await page.close();
});

test('その他の「デフォルトの変更」で、今のブックマークの既定を持ってインストールページの設定が新しいタブで開き、フォームに読み込まれる', async () => {
  const { page, errors } = await openPage(browser, server.base + '/');
  const d = { color: '#1e88e5', size: { pen: 10 }, touchText: false };
  await runCode(page, withDefaults(CODE, d));
  await page.evaluate(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; });
  await mouseClick(page, '[aria-label^="その他"]');
  await mouseClick(page, '.pn.on [aria-label^="デフォルトの変更"]');
  const opened = await page.evaluate(() => window.__opened);
  assert.equal(opened.length, 1);
  const [url, target, feat] = opened[0];
  const head = 'https://shutsuruwork-afk.github.io/paint-tool/#defaults=';
  assert.ok(url.startsWith(head), url);
  assert.deepEqual(JSON.parse(decodeURIComponent(url.slice(head.length))), d);
  assert.equal(target, '_blank');
  assert.match(feat, /noopener/);
  assert.equal(await openPanels(page), 0);
  // インストールページは、届いた既定をフォームとボタンに読み込み、設定の所を見せる
  const { page: ip, errors: ie } = await openPage(browser, server.base + '/install' + url.slice(url.indexOf('#')));
  assert.equal(await ip.isChecked('[aria-label="色 7"]'), true);
  assert.equal(await ip.inputValue('#p-pen'), '10');
  assert.equal(await ip.isChecked('#p-touch'), false);
  assert.equal(await ip.evaluate(() => location.hash), '#defaults');
  assert.ok(await ip.evaluate(() => { const r = document.getElementById('defaults').getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }));
  await ip.click('#try');
  const p = await prefs(ip);
  assert.equal(p.color, '#1e88e5');
  assert.equal(p.size.pen, 10);
  assert.equal(p.touchText, false);
  assert.deepEqual(ie, []);
  await ip.close();
  assert.deepEqual(errors, []);
  await page.close();
});

test('サイトで変えた色・太さ・道具・ツールバーの位置を覚えて次回はその続きから。既定から変えた所だけを書き、背景は覚えない', async () => {
  const { page, errors } = await fresh();
  await page.waitForTimeout(500);
  assert.equal(await lsGet(page), null, '何も変えていなければ書かない');
  await page.keyboard.press('7');
  await page.keyboard.press(']');
  await page.keyboard.press('h');
  await page.keyboard.press('b');
  const g = await rectOf(page, '.bar > .sep');
  await page.mouse.move(g.x + g.w / 2, g.y + g.h / 2);
  await page.mouse.down();
  await page.mouse.move(40, 300, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const saved = JSON.parse(await lsGet(page));
  assert.deepEqual(Object.keys(saved).sort(), ['bar', 'color', 'size', 'tool']);
  assert.deepEqual(saved.size, { pen: 5 });
  assert.equal(saved.color, '#1e88e5');
  assert.equal(saved.tool, 'marker');
  await page.evaluate(() => window.__paintBookmarklet.destroy());
  await runBookmarklet(page);
  const p = await prefs(page);
  assert.equal(p.color, '#1e88e5');
  assert.equal(p.tool, 'marker');
  assert.equal(p.size.pen, 5);
  assert.deepEqual(p.bar, saved.bar);
  assert.equal(await page.evaluate(() => document.querySelector('paint-bookmarklet-surface').shadowRoot.querySelector('.s').className), 's');
  // インストールページの既定を変えると、このサイトで触っていない所（消しゴム）には新しい既定が効く
  await page.evaluate(() => window.__paintBookmarklet.destroy());
  await runCode(page, withDefaults(CODE, { color: '#43a047', size: { eraser: 50 } }));
  const q = await prefs(page);
  assert.equal(q.color, '#1e88e5');
  assert.equal(q.size.eraser, 50);
  assert.equal(q.size.pen, 5);
  assert.deepEqual(errors, []);
  await page.close();
  // localStorage が使えないページでもエラーにならない
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await ctx.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } }));
  const p3 = await ctx.newPage();
  const e3 = [];
  p3.on('pageerror', e => e3.push(e.message));
  await p3.goto(server.base + '/');
  await runBookmarklet(p3);
  await p3.keyboard.press('7');
  await p3.waitForTimeout(600);
  await p3.evaluate(() => window.__paintBookmarklet.hide());
  assert.deepEqual(e3, []);
  await ctx.close();
});

// 間隔（ms）を空けて点を流すストローク（速さで太さが変わるペンを試す）
const timedStroke = (page, pts, gap) => page.evaluate(async ([pts, gap]) => {
  const pad = document.querySelector('paint-bookmarklet').shadowRoot.querySelector('.p');
  const ev = (t, x, y) => pad.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, composed: true, isPrimary: true,
    pointerId: 1, pointerType: 'mouse', button: t === 'pointermove' ? -1 : 0, buttons: t === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
  ev('pointerdown', pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) { await new Promise(r => setTimeout(r, gap)); ev('pointermove', pts[i][0], pts[i][1]); }
  ev('pointerup', pts.at(-1)[0], pts.at(-1)[1]);
}, [pts, gap]);
const line = (x0, y0, x1, y1, n) => Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]);

test('ペンの種類: ペンでないときは押してもペンになるだけ、ペンのときにもう一度押すと種類のパネル。万年筆は向き・筆は速さで太さが変わり、鉛筆はかすれる', async () => {
  const { page, errors } = await fresh();
  await page.keyboard.press('h');
  await mouseClick(page, '.bar > [aria-label^="ペン"]');
  assert.match(await toolOn(page), /^ペン/);
  assert.equal(await openPanels(page), 0);
  await mouseClick(page, '.bar > [aria-label^="ペン"]');
  assert.equal(await openPanels(page), 1);
  assert.equal(await shadowEval(page, root => root.querySelectorAll('.pn.on .b').length), 4);
  await mouseClick(page, '.pn.on [aria-label^="万年筆"]');
  assert.equal(await openPanels(page), 0);
  assert.match(await toolOn(page), /^万年筆/);
  await setSlider(page, 0, 50); // 太さ 25
  // 万年筆: 右下がりは太く、右上がりは細い
  await timedStroke(page, line(100, 150, 300, 350, 20), 8);
  await timedStroke(page, line(500, 350, 700, 150, 20), 8);
  const down = (await alphaStats(page, 80, 130, 240, 240)).count, up = (await alphaStats(page, 480, 130, 240, 240)).count;
  assert.ok(down > up * 2, `万年筆 ↘ ${down} ↗ ${up}`);
  // 筆: ゆっくりだと太く、速いと細い
  await mouseClick(page, '.bar > [aria-label^="万年筆"]');
  await mouseClick(page, '.pn.on [aria-label^="筆"]');
  await timedStroke(page, line(100, 450, 400, 450, 100), 16);
  await timedStroke(page, line(100, 600, 400, 600, 10), 2);
  const slow = (await alphaStats(page, 150, 420, 200, 60)).count, fast = (await alphaStats(page, 150, 570, 200, 60)).count;
  assert.ok(slow > fast * 2, `筆 ゆっくり ${slow} 速い ${fast}`);
  // 鉛筆: かすれる（線の中心でも、薄い画素が混じる）。元に戻すは画素単位
  await mouseClick(page, '.bar > [aria-label^="筆"]');
  await mouseClick(page, '.pn.on [aria-label^="鉛筆"]');
  const s0 = await checksum(page);
  await timedStroke(page, line(550, 500, 900, 500, 30), 8);
  const core = await readMain(page, 600, 497, 250, 6);
  let faint = 0, n = 0;
  for (let i = 3; i < core.length; i += 4) { n++; if (core[i] < 200) faint++; }
  assert.ok(faint / n > 0.08, `鉛筆のかすれ ${faint}/${n}`); // 普通のペンなら 0（つなぎ目は模様が重なって濃くなる）
  const s1 = await checksum(page);
  await page.keyboard.press('Control+z');
  assert.equal(await checksum(page), s0);
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await checksum(page), s1);
  // 選んだ種類はサイトごとに覚える
  await page.waitForTimeout(600);
  assert.equal(JSON.parse(await lsGet(page)).pen, 'pencil');
  assert.deepEqual(errors, []);
  await page.close();
});

test('電卓: 入りにすると、文字の行が計算式なら答えが薄く出て Tab で書き込める。空白は式の書き方に合わせ、点線の枠は答えまで囲む。式でなければ出ない。切りなら今までどおり', async () => {
  const { page, errors } = await fresh();
  const ghost = () => shadowEval(page, root => { const g = root.querySelector('.gh'); return g ? g.textContent : null; });
  const value = async () => (await textBox(page)).value;
  // 切り（既定）: 答えは出ず、Tab でも何も書かれず、入力欄にいたまま
  await page.keyboard.press('t');
  await page.mouse.click(200, 300);
  await page.keyboard.type('12*3');
  assert.equal(await ghost(), null);
  await page.keyboard.press('Tab');
  assert.deepEqual(await textBox(page), { value: '12*3', focused: true, color: '#e53935' });
  await page.keyboard.press('Escape');
  // 入りにする（その他のメニュー）
  await mouseClick(page, '[aria-label^="その他"]');
  await mouseClick(page, '.pn.on [aria-label^="電卓"]');
  assert.equal(await shadowEval(page, root => root.querySelector('[aria-label^="電卓"]').getAttribute('aria-checked')), 'true');
  await page.keyboard.press('Escape');
  await page.mouse.click(200, 450);
  const cases = [['12*3', '=36'], ['2+3*4', '=14'], ['-2^2', '=-4'], ['2^3^2', '=512'], ['50%*200', '=100'],
    ['0.1+0.2', '=0.3'], ['1,000+1', '=1001'], ['(2+3)^2/5', '=5'], ['１２０×１．５＝', '180'], ['10÷4=', '2.5'],
    // 空白は式の書き方に合わせる（演算子か = の前後に空白があれば入れる。最後に打った空白には重ねない）
    ['11 + 1', ' = 12'], ['11+ 1', ' = 12'], ['11　＋　1', ' = 12'], ['11 + 1 =', ' 12'], ['11 + 1 = ', '12'], ['11 + 1 ', '= 12'],
    ['11+1 ', '= 12'], ['11+1=', '12'], ['11+1= ', '12'], ['(1 + 2)*3', ' = 9'],
    ['hello', null], ['12', null], ['-5', null], ['1/0', null], ['3+', null], ['2(3)', null]];
  for (const [ex, want] of cases) {
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.keyboard.insertText(ex);
    assert.equal(await ghost(), want, ex);
  }
  // Tab で書き込む。答えは行の後ろに並び、書き込むと消える
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('12*3');
  const g = await shadowEval(page, root => {
    const a = root.querySelector('.gh').getBoundingClientRect(), t = root.querySelector('.tx'), c = getComputedStyle(t);
    return { gx: a.x, tx: t.getBoundingClientRect().x + parseFloat(c.paddingLeft) };
  });
  assert.ok(g.gx > g.tx + 20, JSON.stringify(g));
  // 点線の枠（入力欄）は答えの右端まで広がり、答えが消えると戻る。Tab で書き込んでも枠の大きさは変わらない
  const box = () => shadowEval(page, root => {
    const t = root.querySelector('.tx'), r = t.getBoundingClientRect(), gh = root.querySelector('.gh');
    return { right: r.right - parseFloat(getComputedStyle(t).paddingRight), w: r.width, gr: gh ? gh.getBoundingClientRect().right : null };
  });
  const b1 = await box();
  assert.ok(b1.right >= b1.gr, JSON.stringify(b1));
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  const b0 = await box();
  assert.equal(b0.gr, null);
  assert.ok(b0.w < b1.w - 30, JSON.stringify([b0, b1]));
  await page.keyboard.type('*3');
  assert.equal((await box()).w, b1.w);
  await page.keyboard.press('Tab');
  assert.equal(await value(), '12*3=36');
  assert.equal(await ghost(), null);
  assert.ok(Math.abs((await box()).w - b1.w) <= 1, JSON.stringify([await box(), b1]));
  // 2 行目でも、カーソルのある行の答えが出る
  await page.keyboard.press('Enter');
  await page.keyboard.type('7*6=');
  assert.equal(await ghost(), '42');
  await page.keyboard.press('Tab');
  assert.equal(await value(), '12*3=36\n7*6=42');
  await page.keyboard.press('Escape');
  assert.equal((await textInfo(page)).at(-1).s, '12*3=36\n7*6=42');
  // サイトごとに覚える
  await page.waitForTimeout(600);
  assert.equal(JSON.parse(await lsGet(page)).calc, true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('予測線: ペンも蛍光ペンも最後の点より先まで伸ばす。蛍光ペンは設定で「必要な分だけ」（丸い先端で届かない分だけ。ゆっくりなら予測しない）「なし」にもできる', async () => {
  // 合成のイベントに timeStamp を与えて速さを決め（step px を 2 ms ごと）、途中の pred を読む。
  // 最後の点は x = 400。reach は線の先の x
  const measure = (page, step) => page.evaluate(step => {
    const api = window.__paintBookmarklet, root = document.querySelector('paint-bookmarklet').shadowRoot;
    const pad = root.querySelector('.p'), q = root.querySelector('canvas.q');
    const ev = (type, x, y, ts, extra) => { const e = new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 9, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0, buttons: 1, ...extra }); Object.defineProperty(e, 'timeStamp', { value: ts }); return e; };
    const out = {};
    for (const t of ['pen', 'marker']) {
      api.tool(t);
      const T0 = performance.now() + 1000;
      pad.dispatchEvent(ev('pointerdown', 400 - 30 * step, 400, T0));
      for (let i = 1; i <= 30; i++) pad.dispatchEvent(ev('pointermove', 400 - (30 - i) * step, 400, T0 + i * 2));
      const d = q.getContext('2d').getImageData(0, 0, q.width, q.height).data, k = devicePixelRatio;
      let reach = -1;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 20) { const x = ((i >> 2) % q.width) / k; if (x > reach) reach = x; }
      out[t] = reach;
      pad.dispatchEvent(ev('pointerup', 400, 400, T0 + 62, { buttons: 0 }));
    }
    return out;
  }, step);
  const { page, errors } = await fresh();
  // 既定（そのまま）: 速くても（5 px/ms）ゆっくりでも（0.5 px/ms）、ペンも蛍光ペンも先まで伸ばす（蛍光ペンは太さの半分 12px より先）
  const fast = await measure(page, 10), slow = await measure(page, 1);
  assert.equal((await prefs(page)).mpred, 'full');
  assert.ok(fast.pen > 415 && fast.marker > 425, JSON.stringify(fast));
  assert.ok(slow.pen > 402 && slow.marker > 414, JSON.stringify(slow));
  // 必要な分だけ: 速いと伸ばし、ゆっくりなら丸い先端で 1 フレーム後のペン先まで届くので予測しない。なし: 速くても太さの半分まで
  for (const [mpred, ok] of [['need', r => r.f > 425 && r.s <= 413], ['off', r => r.f <= 413]]) {
    await page.evaluate(() => window.__paintBookmarklet.destroy());
    await runCode(page, withDefaults(CODE, { mpred }));
    const r = { f: (await measure(page, 10)).marker, s: (await measure(page, 1)).marker };
    assert.ok(ok(r), mpred + ' ' + JSON.stringify(r));
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('予測（曲がりに沿う）: 円を描いている途中の予測は、接線ではなく円の内側へ曲がる。止まると予測が縮む', async () => {
  const { page, errors } = await fresh();
  const r = await page.evaluate(() => {
    const root = document.querySelector('paint-bookmarklet').shadowRoot, pad = root.querySelector('.p'), q = root.querySelector('canvas.q');
    const ev = (type, x, y, ts) => { const e = new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 9, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0, buttons: 1 }); Object.defineProperty(e, 'timeStamp', { value: ts }); return e; };
    // 中心 (500, 450)・半径 200 の円を、4 ms ごとに 4 px/ms で左回りに進む（座標は小数のまま）
    const C = [500, 450], R = 200, T0 = performance.now() + 1000;
    let a = Math.PI, i = 0;
    const p = () => [C[0] + R * Math.cos(a), C[1] - R * Math.sin(a)];
    pad.dispatchEvent(ev('pointerdown', ...p(), T0));
    for (i = 1; i <= 20; i++) { a -= 0.08; pad.dispatchEvent(ev('pointermove', ...p(), T0 + i * 4)); }
    // 予測の先（最後の点から接線の方向に 15px より先のインク）が、接線から円の中心の側へどれだけずれているか
    const [lx, ly] = p(), tx = Math.sin(a), ty = Math.cos(a), nx = C[0] - lx, ny = C[1] - ly, nl = Math.hypot(nx, ny);
    const look = () => {
      const d = q.getContext('2d').getImageData(0, 0, q.width, q.height).data;
      let reach = 0, off = 0, n = 0;
      for (let y = 0; y < q.height; y++) for (let x = 0; x < q.width; x++) {
        if (d[(y * q.width + x) * 4 + 3] < 100) continue;
        const along = (x - lx) * tx + (y - ly) * ty;
        reach = Math.max(reach, along); // 前へ届いた所（末尾の半区間は後ろ側なので入らない）
        if (along > 15) { off += ((x - lx) * nx + (y - ly) * ny) / nl; n++; }
      }
      return { reach: Math.round(reach), inward: n ? off / n : 0, n };
    };
    const moving = look();
    // その場で 40 ms 止まる（同じ座標の入力が続く）
    for (let k = 1; k <= 10; k++) pad.dispatchEvent(ev('pointermove', lx, ly, T0 + i * 4 + k * 4));
    const stopped = look();
    pad.dispatchEvent(ev('pointerup', lx, ly, T0 + i * 4 + 50));
    return { moving, stopped };
  });
  assert.ok(r.moving.reach > 25 && r.moving.n > 10, 'predicts ahead ' + JSON.stringify(r));
  assert.ok(r.moving.inward > 1, 'curves inward along the circle ' + JSON.stringify(r));
  assert.ok(r.stopped.reach <= 4, 'shrinks when stopped ' + JSON.stringify(r));
  assert.deepEqual(errors, []);
  await page.close();
});

test('パソコンが重いとき: 入力が遅れてまとめて届いても、動いている途中に予測線が消えない（止まれば消える）。フレームが飛んでも 1 フレームの長さは伸びない', async () => {
  const { page, errors } = await fresh();
  const r = await page.evaluate(async () => {
    const api = window.__paintBookmarklet, pad = document.querySelector('paint-bookmarklet').shadowRoot.querySelector('.p');
    const ev = (type, x, y, ts) => { const e = new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 9, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1 }); Object.defineProperty(e, 'timeStamp', { value: ts }); return e; };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const frame = () => new Promise(r => requestAnimationFrame(r));
    // 円の上を 8 ms ごとに進む点。時刻は本物の時計で、届けるのは 60 ms ごとにまとめて（ブラウザごと遅れているとき）
    const C = [500, 380], R = 180, pos = i => [C[0] + R * Math.cos(i * 0.02), C[1] + R * Math.sin(i * 0.02)];
    const T0 = performance.now();
    pad.dispatchEvent(ev('pointerdown', ...pos(0), T0));
    let sent = 1, done = false, moving = 0, off = 0;
    (async () => { while (!done) { const s = api.stats().pred; await frame(); if (sent > 10 && !done) { moving++; if (!s) off++; } } })();
    const N = 150; // 1.2 秒
    while (sent < N) {
      await sleep(60);
      const now = performance.now();
      for (; sent < N && T0 + sent * 8 <= now; sent++) pad.dispatchEvent(ev('pointermove', ...pos(sent), T0 + sent * 8));
    }
    done = true;
    const delay = api.stats().inputDelay, predWhenStopped = api.stats().pred;
    // 止まる（入力が来ない）: 遅れの分だけ待ってから消える
    const tStop = performance.now();
    let cleared = -1;
    while (performance.now() - tStop < 600) { await frame(); if (!api.stats().pred) { cleared = performance.now() - tStop; break; } }
    pad.dispatchEvent(ev('pointerup', ...pos(N - 1), performance.now()));
    // フレームが飛ぶ（毎フレーム 22 ms ふさぐ）間に描いても、1 フレームの長さは画面の書き換えの間隔のまま
    const T1 = performance.now();
    pad.dispatchEvent(ev('pointerdown', 200, 600, T1));
    let k = 0;
    while (performance.now() - T1 < 800) {
      await frame();
      const end = performance.now() + 22; while (performance.now() < end);
      k++; pad.dispatchEvent(ev('pointermove', 200 + k * 4, 600, performance.now()));
    }
    const fi = api.stats().frame;
    pad.dispatchEvent(ev('pointerup', 200 + k * 4, 600, performance.now()));
    return { moving, off, delay, predWhenStopped, cleared, fi };
  });
  assert.ok(r.moving > 40, 'frames while moving ' + JSON.stringify(r));
  assert.ok(r.off <= 2, 'prediction stays while input arrives late in bursts ' + JSON.stringify(r));
  assert.ok(r.delay > 30, 'measures the input delay ' + JSON.stringify(r));
  assert.ok(r.predWhenStopped > 0 && r.cleared > 0 && r.cleared < 400, 'cleared after stopping ' + JSON.stringify(r));
  assert.ok(r.fi > 14 && r.fi < 19, 'frame length is not stretched by dropped frames ' + JSON.stringify(r));
  assert.deepEqual(errors, []);
  await page.close();
});

test('蛍光ペン（予測が必要な分だけ）: ゆっくり〜ふつうの速さで曲線を描いても、描いている途中に一度見えた所が次の入力で消えない（先端がぴょこぴょこしない）', async () => {
  const { page, errors } = await openPage(browser, server.base + '/');
  await runCode(page, withDefaults(CODE, { mpred: 'need' }));
  const lost = await page.evaluate(() => {
    const api = window.__paintBookmarklet, root = document.querySelector('paint-bookmarklet').shadowRoot;
    const pad = root.querySelector('.p'), lv = root.querySelector('canvas.l'), pr = root.querySelector('canvas.q'), grp = root.querySelector('.g');
    const ev = (type, x, y, ts, extra) => { const e = new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 9, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0, buttons: 1, ...extra }); Object.defineProperty(e, 'timeStamp', { value: ts }); return e; };
    const k = devicePixelRatio, X0 = 300 * k, Y0 = 200 * k, WW = 400 * k, HH = 300 * k;
    // 見えている画素: live と pred を重ねた濃さ（まとめた要素の opacity も掛ける）が 4 を超える所
    const mask = () => { const a = lv.getContext('2d').getImageData(X0, Y0, WW, HH).data, c = pr.getContext('2d').getImageData(X0, Y0, WW, HH).data, g = +(grp.style.opacity || 1); const m = new Uint8Array(WW * HH); for (let i = 0, j = 3; i < m.length; i++, j += 4) m[i] = (a[j] + c[j] * (1 - a[j] / 255)) * g > 4 ? 1 : 0; return m; };
    const out = {};
    api.tool('marker');
    // 速さ 150 px/s と 600 px/s で半径 100px の弧。入力は 8 ms ごと（±1.5 ms ぶれる）、座標は整数
    for (const v of [150, 600]) {
      api.clear();
      const T0 = performance.now() + 1000, pts = [];
      for (let t = 0; t <= 1000; t += 8) { const a = (v * t / 1000) / 100; pts.push([Math.round(500 + 100 * Math.sin(a)), Math.round(350 - 100 * Math.cos(a))]); }
      pad.dispatchEvent(ev('pointerdown', pts[0][0], pts[0][1], T0));
      let prev = mask(), n = 0;
      for (let i = 1; i < pts.length; i++) {
        pad.dispatchEvent(ev('pointermove', pts[i][0], pts[i][1], T0 + i * 8 + ((i * 7919) % 31) / 10 - 1.5));
        const m = mask();
        for (let j = 0; j < m.length; j++) if (prev[j] && !m[j]) n++;
        prev = m;
      }
      pad.dispatchEvent(ev('pointerup', pts.at(-1)[0], pts.at(-1)[1], T0 + pts.length * 8, { buttons: 0 }));
      out[v] = n;
    }
    return out;
  });
  assert.deepEqual(lost, { 150: 0, 600: 0 });
  assert.deepEqual(errors, []);
  await page.close();
});

test('速いマウス移動でも線が途切れない（全中間点を取りこぼさない）', async () => {
  const { page } = await fresh();
  const pts = [];
  for (let x = 100; x <= 900; x += 40) pts.push([x, 500]);
  await drag(page, pts);
  const row = await readMain(page, 100, 500, 800, 1);
  for (let x = 10; x < 790; x += 5) assert.ok(row[x * 4 + 3] > 200, `gap at x=${100 + x}`);
  await page.close();
});

test('undo / redo は画素単位で完全に元に戻る', async () => {
  const { page } = await fresh();
  await drag(page, [[100, 100], [600, 400]], 10);
  const s1 = await checksum(page);
  await drag(page, [[600, 100], [100, 400]], 10);
  const s2 = await checksum(page);
  assert.notEqual(s1, s2);
  await page.keyboard.press('Control+z');
  assert.equal(await checksum(page), s1);
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await checksum(page), s2);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  assert.equal((await alphaStats(page, 0, 0, 1000, 700)).count, 0);
  await page.keyboard.press('Control+y');
  assert.equal(await checksum(page), s1);
  await page.close();
});

test('消しゴム（キー E と右クリック）で消え、undo で戻る', async () => {
  const { page } = await fresh();
  await drag(page, [[100, 300], [700, 300]], 10);
  await page.keyboard.press('e');
  assert.match(await toolOn(page), /^消しゴム/);
  await drag(page, [[400, 200], [400, 400]], 10);
  assert.equal((await readMain(page, 400, 300))[3], 0);
  assert.ok((await readMain(page, 200, 300))[3] > 200);
  await page.keyboard.press('Control+z');
  assert.ok((await readMain(page, 400, 300))[3] > 200);
  // 右ボタンドラッグは一時的に消しゴム
  await page.keyboard.press('p');
  await page.mouse.move(250, 200);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(250, 400, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  assert.equal((await readMain(page, 250, 300))[3], 0);
  assert.match(await toolOn(page), /^ペン/);
  await page.close();
});

test('半透明ストロークは自己交差部分が二重に濃くならない', async () => {
  const { page } = await fresh();
  await page.keyboard.press('h'); // 蛍光ペン: 不透明度 35%
  await drag(page, [[100, 300], [500, 300], [300, 150], [300, 450]], 15);
  const s = await alphaStats(page, 80, 130, 440, 340);
  const expected = Math.round(0.35 * 255);
  assert.ok(Math.abs(s.max - expected) <= 2, `max alpha ${s.max}, expected ≈${expected}`);
  await page.close();
});

test('四角形を描いて内側を塗りつぶし、外側には漏れない', async () => {
  const { page } = await fresh();
  await page.keyboard.press('r');
  await drag(page, [[200, 200], [500, 450]], 10);
  assert.ok((await readMain(page, 200, 300))[3] > 200, 'rect edge');
  assert.equal((await readMain(page, 350, 325))[3], 0, 'rect inside empty');
  await page.keyboard.press('f');
  await page.mouse.click(350, 325);
  const inside = await readMain(page, 350, 325);
  assert.deepEqual(inside, [229, 57, 53, 255]); // #e53935
  assert.equal((await readMain(page, 600, 500))[3], 0, 'no leak outside');
  assert.equal((await readMain(page, 100, 100))[3], 0, 'no leak outside');
  // 塗りは線の内側の縁 (アンチエイリアス部) まで潜り込み、白い隙間が残らない
  const edge = await readMain(page, 203, 325, 4, 1);
  for (let i = 3; i < edge.length; i += 4) assert.ok(edge[i] > 240, 'no halo between stroke and fill');
  await page.keyboard.press('Control+z');
  assert.equal((await readMain(page, 350, 325))[3], 0);
  await page.close();
});

test('ペン圧で線幅が変わる', async () => {
  const { page } = await fresh();
  await setSlider(page, 0, 60); // 太さ 36
  const stroke = async (id, y, pressure) => {
    const base = { pointerId: id, pointerType: 'pen', pressure };
    await firePointer(page, 'pointerdown', { ...base, clientX: 100, clientY: y, button: 0, buttons: 1 });
    for (let x = 110; x <= 600; x += 10) await firePointer(page, 'pointermove', { ...base, clientX: x, clientY: y, button: -1, buttons: 1 });
    await firePointer(page, 'pointerup', { ...base, clientX: 600, clientY: y, button: 0, buttons: 0, pressure: 0 });
  };
  await stroke(21, 200, 0.1);
  await stroke(22, 450, 1.0);
  const col = async y => (await alphaStats(page, 400, y - 40, 1, 80)).count;
  const thin = await col(200), thick = await col(450);
  assert.ok(thick >= 34 && thick <= 40, `thick=${thick}`);
  assert.ok(thin >= 8 && thin <= 14, `thin=${thin}`);
  await page.close();
});

test('パームリジェクション: タッチ中にペンが触れるとタッチの線は破棄される', async () => {
  const { page } = await fresh();
  await firePointer(page, 'pointerdown', { pointerId: 31, pointerType: 'touch', clientX: 100, clientY: 300, button: 0, buttons: 1 });
  for (let x = 120; x <= 400; x += 20) await firePointer(page, 'pointermove', { pointerId: 31, pointerType: 'touch', clientX: x, clientY: 300, button: -1, buttons: 1 });
  await firePointer(page, 'pointerdown', { pointerId: 32, pointerType: 'pen', pressure: 0.8, clientX: 100, clientY: 500, button: 0, buttons: 1 });
  for (let x = 120; x <= 400; x += 20) await firePointer(page, 'pointermove', { pointerId: 32, pointerType: 'pen', pressure: 0.8, clientX: x, clientY: 500, button: -1, buttons: 1 });
  await firePointer(page, 'pointerup', { pointerId: 32, pointerType: 'pen', clientX: 400, clientY: 500, button: 0, buttons: 0 });
  await firePointer(page, 'pointerup', { pointerId: 31, pointerType: 'touch', clientX: 400, clientY: 300, button: 0, buttons: 0 });
  // ペンを離した直後（500ms 以内）のタッチも無視
  await firePointer(page, 'pointerdown', { pointerId: 33, pointerType: 'touch', clientX: 600, clientY: 300, button: 0, buttons: 1 });
  await firePointer(page, 'pointermove', { pointerId: 33, pointerType: 'touch', clientX: 700, clientY: 300, button: -1, buttons: 1 });
  await firePointer(page, 'pointerup', { pointerId: 33, pointerType: 'touch', clientX: 700, clientY: 300, button: 0, buttons: 0 });
  assert.equal((await alphaStats(page, 90, 280, 320, 40)).count, 0, 'touch stroke discarded');
  assert.ok((await alphaStats(page, 90, 480, 320, 40)).max > 200, 'pen stroke kept');
  assert.equal((await alphaStats(page, 590, 280, 120, 40)).count, 0, 'touch right after pen ignored');
  await page.close();
});

test('パームリジェクション（塗りつぶし・文字）: 手のひらが先に触れてからペンで描いても、手のひらを離したときに塗らず、入力欄も 2 つにならない。手のひらを置いている間にペンが近づいても同じ（T-123）', async () => {
  for (const key of ['f', 't']) {
    const { page, errors } = await fresh();
    await page.keyboard.press(key);
    // 手のひら → ペンで押して離す → 手のひらを離す
    await firePointer(page, 'pointerdown', { pointerId: 41, pointerType: 'touch', clientX: 200, clientY: 200, button: 0, buttons: 1 });
    await firePointer(page, 'pointerdown', { pointerId: 42, pointerType: 'pen', pressure: 0.5, clientX: 600, clientY: 400, button: 0, buttons: 1 });
    await firePointer(page, 'pointerup', { pointerId: 42, pointerType: 'pen', clientX: 600, clientY: 400, button: 0, buttons: 0 });
    await firePointer(page, 'pointerup', { pointerId: 41, pointerType: 'touch', clientX: 200, clientY: 200, button: 0, buttons: 0 });
    await page.waitForTimeout(50);
    const inputs = () => shadowEval(page, root => root.querySelectorAll('.tx').length);
    if (key === 'f') assert.equal(await hist(page), 1, 'only the pen filled');
    else {
      assert.equal(await inputs(), 1, 'one text input (from the pen)');
      await page.keyboard.press('Escape'); // ペンで出した入力欄を閉じる（空なので何も残らない）
    }
    // 手のひらを置いている間に、ペンが触れずに近づく（ホバー）
    const h0 = await hist(page);
    await firePointer(page, 'pointerdown', { pointerId: 43, pointerType: 'touch', clientX: 300, clientY: 500, button: 0, buttons: 1 });
    await firePointer(page, 'pointermove', { pointerId: 44, pointerType: 'pen', clientX: 650, clientY: 450, button: -1, buttons: 0 });
    await firePointer(page, 'pointerup', { pointerId: 43, pointerType: 'touch', clientX: 300, clientY: 500, button: 0, buttons: 0 });
    await page.waitForTimeout(50);
    assert.equal(await hist(page), h0, 'the palm did not fill');
    assert.equal(await inputs(), 0, 'the palm did not open a text input');
    if (key === 't') {
      // 指を置いている間に、別のポインタ（マウス）で入力欄を出して打ってから指を離すと、打った文字は確定し、入力欄は 1 つ
      await page.waitForTimeout(600); // ペンが離れてから 500 ms 以内のタッチは手のひらとして無視されるので待つ
      await firePointer(page, 'pointerdown', { pointerId: 45, pointerType: 'touch', clientX: 300, clientY: 300, button: 0, buttons: 1 });
      await page.mouse.click(600, 200);
      await page.keyboard.type('ab');
      await firePointer(page, 'pointerup', { pointerId: 45, pointerType: 'touch', clientX: 300, clientY: 300, button: 0, buttons: 0 });
      assert.equal(await inputs(), 1);
      assert.equal(await page.evaluate(() => window.__paintBookmarklet.stats().texts), 1, 'the text typed with the mouse is committed');
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('描画中の入力はページ側のリスナーに伝播しない', async () => {
  const { page } = await fresh();
  await page.evaluate(() => {
    window.__leak = 0;
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'click', 'contextmenu']) {
      document.addEventListener(t, () => window.__leak++);
    }
  });
  await drag(page, [[100, 300], [500, 350]], 10);
  await page.mouse.click(300, 400, { button: 'right' });
  await click(page, '[title^="元に戻す"]');
  assert.equal(await page.evaluate(() => window.__leak), 0);
  await page.close();
});

test('ページの入力欄にフォーカスがあってもショートカットが効き、文字が入力されない', async () => {
  const { page } = await openPage(browser, server.base + '/');
  await page.focus('#inp');
  await runBookmarklet(page);
  await page.keyboard.press('e');
  assert.match(await toolOn(page), /^消しゴム/);
  await page.focus('#inp'); // 再びページの入力欄へ
  await drag(page, [[100, 300], [200, 300]]); // 描画開始でフォーカスがツールへ移る
  await page.keyboard.press('l');
  assert.match(await toolOn(page), /^直線/);
  assert.equal(await page.inputValue('#inp'), '');
  // ページ操作モードでは入力欄に普通に文字が打てる
  await page.keyboard.press('v');
  await page.click('#inp');
  await page.keyboard.type('hello');
  assert.equal(await page.inputValue('#inp'), 'hello');
  await page.close();
});

test('厳格な CSP + Trusted Types のページでもコード自体は動作する', async () => {
  const { page, errors } = await openPage(browser, server.base + '/strict');
  await page.evaluate(() => {
    window.__v = [];
    document.addEventListener('securitypolicyviolation', e => window.__v.push(e.effectiveDirective));
  });
  // Firefox 等はブックマークレットを CSP の対象外として実行する。それと同じ状況を DevTools 評価で再現
  await page.evaluate(CODE);
  await page.waitForFunction(() => !!window.__paintBookmarklet);
  const bf = await shadowEval(page, root => getComputedStyle(root.querySelector('.bar'), '::before').backdropFilter);
  assert.equal(bf, 'blur(18px) saturate(2)', 'shadow styles applied (adoptedStyleSheets)');
  await drag(page, [[100, 300], [500, 300]], 10);
  assert.ok((await readMain(page, 300, 300))[3] > 200);
  await page.keyboard.press('Control+z');
  assert.equal((await readMain(page, 300, 300))[3], 0);
  const v = (await page.evaluate(() => window.__v)).filter(d => d !== 'img-src'); // カーソル画像だけは img-src で弾かれうる（十字にフォールバック）
  assert.deepEqual(v, []);
  assert.deepEqual(errors, []);
  await page.close();
});

test('ウィンドウのリサイズで絵が消えない', async () => {
  const { page } = await fresh('/', { width: 1000, height: 700 });
  await drag(page, [[850, 600], [950, 650]], 5);
  await page.setViewportSize({ width: 600, height: 400 });
  await page.waitForTimeout(100);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForTimeout(100);
  const size = await shadowEval(page, root => { const c = root.querySelector('canvas.l'); return [c.width, c.height]; });
  assert.deepEqual(size, [1200, 800]);
  assert.ok((await alphaStats(page, 840, 590, 120, 70)).max > 200);
  await drag(page, [[1100, 750], [1150, 780]], 5);
  assert.ok((await alphaStats(page, 1090, 740, 70, 50)).max > 200);
  await page.close();
});

test('直線・矢印・楕円と Shift 拘束', async () => {
  const { page } = await fresh();
  await page.keyboard.press('l');
  await page.keyboard.down('Shift');
  await drag(page, [[100, 200], [500, 215]], 5); // Shift: 水平にスナップ
  await page.keyboard.up('Shift');
  assert.ok((await readMain(page, 480, 200))[3] > 200, 'snapped to horizontal');
  assert.equal((await readMain(page, 480, 214))[3], 0);
  await page.keyboard.press('a');
  await drag(page, [[100, 400], [400, 400]], 5);
  assert.ok((await alphaStats(page, 380, 380, 20, 15)).count > 0, 'arrow head');
  await page.keyboard.press('o');
  await drag(page, [[600, 300], [800, 400]], 5);
  assert.ok((await readMain(page, 600, 350))[3] > 200, 'ellipse left');
  assert.equal((await readMain(page, 700, 350))[3], 0, 'ellipse hollow');
  await page.close();
});

test('Simple Preview（CP2）: 開発用でなくてもその他の最後に出て（T-101）、押すと絵と履歴はそのままで CP2 の表示になる（ペン ⇄ 消しゴム・文字〈電卓は入り〉・元に戻す・その他〈全消去・色・本家に戻す〉・閉じる〈中身は隠す〉）。本家に戻せ、サイトごとに覚える（T-088）', async () => {
  const bar = page => shadowEval(page, root => [...root.querySelector('.bar').children].filter(e => e.classList.contains('b'))
    .map(b => b.title.split(/[ （(]/)[0] + (b.classList.contains('on') ? '*' : '')));
  const menu = page => shadowEval(page, root => [...root.querySelector('[title^="全消去"]').parentElement.children]
    .map(e => e.classList.contains('mi') ? e.querySelector('span').textContent : e.querySelectorAll('.c').length + ' 色'));
  const toast = page => shadowEval(page, root => { const t = root.querySelector('.t'); return t.classList.contains('on') ? t.textContent : ''; });
  const MAIN = ['選択', 'ペン*', '蛍光ペン', '消しゴム', '直線', '文字', '塗りつぶし', '色・太さ・濃さ', '元に戻す', 'やり直す', 'ページ操作モード', 'その他', '隠す', '閉じる'];
  // 開発用でなくても、その他の最後に出る（T-101）。開発用なら開発用の項目の後
  const { page: p0 } = await openPage(browser, server.base + '/');
  await runCode(p0, withDefaults(CODE, { dev: true }));
  assert.equal((await menu(p0)).at(-1), 'Simple Preview');
  await p0.close();
  const { page, errors } = await fresh();
  assert.deepEqual(await bar(page), MAIN);
  assert.equal((await menu(page)).at(-1), 'Simple Preview');
  await drag(page, [[100, 300], [400, 320]], 10);
  const sum = await checksum(page);
  // 切り替える: 絵と履歴はそのまま。お知らせは出さない（T-103）。CP2 にない道具（塗りつぶし）を選んでいたらペンになる（T-089）
  await mouseClick(page, '.bar > [aria-label^="塗りつぶし"]');
  await click(page, '[title^="Simple"]');
  assert.deepEqual(await bar(page), ['ペン*', '文字', '元に戻す', 'その他', '閉じる']);
  assert.equal((await prefs(page)).tool, 'pen');
  assert.equal((await prefs(page)).ui, 'cp2');
  assert.equal(await checksum(page), sum);
  assert.equal((await page.evaluate(() => window.__paintBookmarklet.stats())).history, 1);
  assert.equal(await toast(page), ''); // 切り替えのお知らせは出さない（T-103）
  // ペンのボタンを押すたびに消しゴムと入れ替わる
  await mouseClick(page, '.bar > [aria-label^="ペン"]');
  assert.deepEqual(await bar(page), ['消しゴム*', '文字', '元に戻す', 'その他', '閉じる']);
  await mouseClick(page, '.bar > [aria-label^="消しゴム"]');
  assert.deepEqual(await bar(page), ['ペン*', '文字', '元に戻す', 'その他', '閉じる']);
  // 文字は電卓が入り（本家の設定は切りのまま）
  await mouseClick(page, '.bar > [aria-label^="文字"]');
  await page.mouse.click(300, 450);
  await page.keyboard.type('12+30');
  assert.equal(await shadowEval(page, root => root.querySelector('.gh').textContent), '=42');
  await page.keyboard.press('Tab');
  assert.equal(await shadowEval(page, root => root.querySelector('textarea').value), '12+30=42');
  await mouseClick(page, '.bar > [aria-label^="ペン"]');
  assert.equal((await page.evaluate(() => window.__paintBookmarklet.stats())).texts, 1);
  assert.equal((await prefs(page)).calc, false);
  // その他: 全消去・8 色・本家に戻す。色を選ぶとメニューは閉じ、消しゴムのときはペンに戻る
  await mouseClick(page, '.bar > [aria-label^="ペン"]');
  await mouseClick(page, '.bar > [aria-label^="その他"]');
  assert.deepEqual(await menu(page), ['全消去', '8 色', '本家に戻す']);
  await mouseClick(page, '.pn.on [title="色 7"]');
  assert.deepEqual([(await prefs(page)).color, (await prefs(page)).tool], ['#1e88e5', 'pen']);
  assert.equal(await shadowEval(page, root => !!root.querySelector('.pn.on')), false);
  // ページ操作モードはない（V はページへ）。操作の一覧にも出ない
  await page.keyboard.press('v');
  assert.equal(await shadowEval(page, root => root.querySelector('.w').classList.contains('pass')), false);
  await page.keyboard.press('?');
  assert.ok(!(await shadowEval(page, root => root.querySelector('.hp').textContent)).includes('ページ操作モード'));
  await page.keyboard.press('Escape');
  // 閉じる（× の見た目）と Esc は、お知らせを出さずに隠す。ブックマークレットで絵もそのまま戻る（本家で出ていた起動のお知らせが消えてから確かめる）
  await page.waitForFunction(() => !document.querySelector('paint-bookmarklet').shadowRoot.querySelector('.t').classList.contains('on'), null, { timeout: 6000 });
  await mouseClick(page, '.bar > [aria-label^="閉じる"]');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('paint-bookmarklet')).display), 'none');
  assert.equal(await toast(page), '');
  await runBookmarklet(page);
  assert.ok((await readMain(page, 250, 310))[3] > 200, 'drawing is back');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('paint-bookmarklet')).display), 'none');
  assert.equal(await toast(page), '');
  await runBookmarklet(page);
  // サイトごとに覚える: 開き直すと CP2 で始まる（起動のお知らせも出さない）
  await page.waitForTimeout(500);
  assert.equal(JSON.parse(await lsGet(page)).ui, 'cp2');
  await page.evaluate(() => window.__paintBookmarklet.destroy());
  await runCode(page, CODE);
  assert.deepEqual(await bar(page), ['ペン*', '文字', '元に戻す', 'その他', '閉じる']);
  assert.equal(await toast(page), '');
  // 本家に戻す: 本家の表示とメニューに戻り、覚えた分も消える
  await click(page, '[title^="本家に戻す"]');
  assert.deepEqual(await bar(page), MAIN);
  assert.equal(await toast(page), '');
  assert.equal((await menu(page)).at(-1), 'Simple Preview');
  // CP2 にもある道具（消しゴム・文字）は、切り替えてもそのまま
  for (const [key, want] of [['e', '消しゴム*'], ['t', 'ペン']]) {
    await page.keyboard.press(key);
    await click(page, '[title^="Simple"]');
    assert.equal((await bar(page))[0], want, key);
    if (key === 't') assert.equal((await bar(page))[1], '文字*');
    await click(page, '[title^="本家に戻す"]');
  }
  await page.waitForTimeout(500);
  assert.equal(JSON.parse(await lsGet(page) || '{}').ui, undefined);
  assert.deepEqual(errors, []);
  await page.close();
  // インストールページで最初の版を CP2 にすると CP2 で始まり、本家に戻せる（本家のその他から、また Simple Preview にできる）
  const { page: p1, errors: e1 } = await openPage(browser, server.base + '/');
  await runCode(p1, withDefaults(CODE, { ui: 'cp2' }));
  assert.deepEqual(await bar(p1), ['ペン*', '文字', '元に戻す', 'その他', '閉じる']);
  assert.deepEqual(await menu(p1), ['全消去', '8 色', '本家に戻す']);
  await click(p1, '[title^="本家に戻す"]');
  assert.deepEqual(await bar(p1), MAIN);
  assert.equal((await menu(p1)).at(-1), 'Simple Preview');
  assert.deepEqual(e1, []);
  await p1.close();
  // インストールページ: 最初の版を選ぶと、ボタンの名前と中身が変わる
  const { page: ip, errors: ie } = await openPage(browser, server.base + '/install');
  assert.equal((await ip.textContent('#bm')).trim(), 'Paint');
  assert.ok(await ip.isChecked('#p-ui input[value="main"]'));
  // 開発用の節ではなく、ふつうの設定の「最初に出す版」にある（T-101）
  assert.equal(await ip.evaluate(() => document.querySelector('#p-ui').closest('fieldset').querySelector('legend').textContent), '最初に出す版');
  await ip.check('#p-ui input[value="cp2"]');
  assert.equal((await ip.textContent('#bm')).trim(), 'Paint Simple');
  assert.ok(decodeURIComponent(await ip.getAttribute('#bm', 'href')).includes('{\\"ui\\":\\"cp2\\"}'));
  await ip.click('#try');
  assert.equal(await ip.evaluate(() => window.__paintBookmarklet.stats().prefs.ui), 'cp2');
  assert.deepEqual(ie, []);
  await ip.close();
});

test('Simple のペンはいつも太さ 5・濃さ 100%・普通のペン。本家の太さ・濃さ・種類（インストールページ・サイトの記憶）に影響されず、Simple で変えた太さは覚えない（T-091・T-093・T-097）', async () => {
  const { page, errors } = await openPage(browser, server.base + '/');
  await runCode(page, withDefaults(CODE, { dev: true, size: { pen: 12 }, alpha: { pen: 0.35 } }));
  const penB = () => shadowEval(page, root => [...root.querySelector('.bar').children].find(b => /^(ペン|万年筆|筆|鉛筆) \(P\)/.test(b.getAttribute('aria-label') || '')).getAttribute('aria-label'));
  // 横線を引いて、真ん中の列で線の画素を数える（線の太さ）。濃さは一番濃い画素の不透明度
  let peak = 0;
  const line = async y => {
    await drag(page, [[150, y], [450, y]], 10);
    const [n, a] = await page.evaluate(y => { const d = window.__paintBookmarklet.pixels(300, y - 20, 1, 40).data; let n = 0, a = 0; for (let i = 3; i < d.length; i += 4) { if (d[i] > 40) n++; a = Math.max(a, d[i]); } return [n, a]; }, y);
    peak = a;
    return n;
  };
  const near = (n, w) => Math.abs(n - w) <= 1;
  let n = await line(200);
  assert.ok(near(n, 12), 'main pen ' + n);
  assert.ok(Math.abs(peak - 89) <= 3, 'main pen alpha ' + peak);
  // 本家のペンを筆にしてから Simple にすると、Simple は普通のペン（本家の種類は預かる）
  await click(page, '[title^="筆"]');
  assert.equal((await prefs(page)).pen, 'brush');
  await click(page, '[title^="Simple"]');
  assert.equal(await penB(), 'ペン (P)', 'the simple pen is the plain pen');
  assert.equal((await prefs(page)).pen, 'brush', 'the main pen type is kept');
  n = await line(260);
  assert.ok(near(n, 5), 'simple pen ' + n);
  assert.equal(peak, 255, 'simple pen is opaque');
  assert.equal((await prefs(page)).size.pen, 12, 'the main size is kept');
  assert.equal((await prefs(page)).alpha.pen, 0.35, 'the main alpha is kept');
  // Simple の中で ] を押して太くしても、覚えるのは本家の太さだけ
  await page.keyboard.press(']');
  await page.keyboard.press(']');
  n = await line(320);
  assert.ok(n > 6, 'bigger in simple ' + n);
  await page.waitForTimeout(500);
  assert.equal(JSON.parse(await lsGet(page)).size, undefined);
  // 本家に戻すと筆・12（太さは普通のペンに戻してから測る）
  await click(page, '[title^="本家に戻す"]');
  assert.match(await penB(), /^筆/);
  await click(page, '[title^="ペン (P)"]');
  n = await line(380);
  assert.ok(near(n, 12), 'main pen again ' + n);
  assert.ok(Math.abs(peak - 89) <= 3, 'main pen alpha again ' + peak);
  // Simple を覚えたサイトで開き直しても、ペンは 5（Simple で変えた太さは残らない）
  await click(page, '[title^="Simple"]');
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__paintBookmarklet.destroy());
  await runCode(page, withDefaults(CODE, { dev: true, size: { pen: 12 }, alpha: { pen: 0.35 } }));
  assert.equal((await prefs(page)).ui, 'cp2');
  n = await line(440);
  assert.ok(near(n, 5), 'simple pen after reopening ' + n);
  assert.equal(peak, 255);
  assert.equal((await prefs(page)).size.pen, 12);
  assert.equal((await prefs(page)).alpha.pen, 0.35);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Simple のその他（⋯）は、開いたままツールバーを引いて動かしても閉じず一緒に動く。引かずに押せば閉じる（T-094）', async () => {
  const { page, errors } = await openPage(browser, server.base + '/');
  await runCode(page, withDefaults(CODE, { ui: 'cp2' }));
  const info = () => shadowEval(page, root => {
    const p = root.querySelector('.pn.on'), r = p && p.getBoundingClientRect(), b = root.querySelector('.bar').getBoundingClientRect();
    return { open: root.querySelectorAll('.pn.on').length, px: r && Math.round(r.left - b.left), bx: Math.round(b.left), by: Math.round(b.top) };
  });
  const center = sel => shadowEval(page, (root, sel) => { const r = root.querySelector(sel).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel);
  await mouseClick(page, '.bar > [aria-label^="その他"]');
  const a = await info();
  assert.equal(a.open, 1);
  // ペンのボタンの上から引いて動かす: 開いたまま一緒に動き、ペンのボタンは押されない（消しゴムにならない）
  const [x, y] = await center('.bar > [aria-label^="ペン"]');
  await drag(page, [[x, y], [x + 120, y + 80]], 8);
  const b = await info();
  assert.equal(b.open, 1, 'still open while moving');
  assert.ok(b.bx === a.bx + 120 && b.by === a.by + 80 && b.px === a.px, JSON.stringify([a, b]));
  assert.equal((await prefs(page)).tool, 'pen');
  // 開いたまま色も選べる（選ぶとメニューは閉じる）
  await mouseClick(page, '.pn.on [title="色 7"]');
  assert.equal((await prefs(page)).color, '#1e88e5');
  assert.equal((await info()).open, 0);
  // 引かずにツールバーを押したら閉じる（押したボタンは効く）
  await mouseClick(page, '.bar > [aria-label^="その他"]');
  await mouseClick(page, '.bar > [aria-label^="文字"]');
  assert.equal((await info()).open, 0);
  assert.equal((await prefs(page)).tool, 'text');
  assert.deepEqual(errors, []);
  await page.close();
});

test('（お試し）Simple でペンを選んでいるとき、ペンボタンの地が今の色になる（印は明るさで白か黒、重ねても同じ。下線はない）。文字・消しゴムのときと本家では青い地のまま（T-100）', async () => {
  const { page, errors } = await openPage(browser, server.base + '/');
  await runCode(page, withDefaults(CODE, { dev: true, ui: 'cp2' }));
  const chip = () => shadowEval(page, root => {
    const b = root.querySelector('.bar').children[0], cs = getComputedStyle(b);
    return { bg: cs.backgroundColor, ink: cs.color, shadow: cs.boxShadow !== 'none', line: getComputedStyle(b, '::after').content };
  });
  const BLUE = 'rgb(61, 124, 255)';
  assert.deepEqual(await chip(), { bg: 'rgb(229, 57, 53)', ink: 'rgb(255, 255, 255)', shadow: true, line: 'none' });
  // その他で色を変えると地も変わる。明るい色（黄）では印が黒
  await mouseClick(page, '.bar > [aria-label^="その他"]');
  await mouseClick(page, '.pn.on [title="色 5"]');
  assert.deepEqual(await chip(), { bg: 'rgb(253, 216, 53)', ink: 'rgb(17, 17, 17)', shadow: true, line: 'none' });
  await mouseClick(page, '.bar > [aria-label^="その他"]');
  await mouseClick(page, '.pn.on [title="色 7"]');
  assert.equal((await chip()).bg, 'rgb(30, 136, 229)');
  // 重ねても今の色のまま（選んでいるボタンの濃い青にならない）
  const r = await shadowEval(page, root => { const b = root.querySelector('.bar').children[0].getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
  await page.mouse.move(r[0], r[1]);
  assert.equal((await chip()).bg, 'rgb(30, 136, 229)');
  await page.mouse.move(300, 300);
  // 文字・消しゴムのときは青い地のまま（消しゴム）・地なし（文字）
  await mouseClick(page, '.bar > [aria-label^="文字"]');
  assert.equal((await chip()).shadow, false);
  await page.keyboard.press('e');
  assert.deepEqual(await chip(), { bg: BLUE, ink: 'rgb(255, 255, 255)', shadow: false, line: 'none' });
  await page.keyboard.press('p');
  assert.equal((await chip()).bg, 'rgb(30, 136, 229)');
  // 本家では選んでいるペンも青い地
  await click(page, '[title^="本家に戻す"]');
  const mainPen = await shadowEval(page, root => getComputedStyle(root.querySelector('.bar [aria-label^="ペン"]')).backgroundColor);
  assert.equal(mainPen, BLUE);
  assert.deepEqual(errors, []);
  await page.close();
});

test('空の文字の入力欄で改行すると、点線の枠も行の数だけ広がり、次の行に打つ文字（日本語入力の変換中も）が枠に収まる（T-099）', async () => {
  const { page, errors } = await openPage(browser, server.base + '/');
  await runCode(page, CODE);
  const cdp = await page.context().newCDPSession(page);
  await page.keyboard.press('t');
  await page.mouse.click(300, 250);
  // 枠（入力欄の中身の大きさ）に、中身が収まっているか。lines は枠の高さが何行分か
  const box = () => shadowEval(page, root => {
    const t = root.querySelector('textarea'), cs = getComputedStyle(t), lh = parseFloat(cs.fontSize) * 1.25;
    return { fitsW: t.clientWidth >= t.scrollWidth, fitsH: t.clientHeight >= t.scrollHeight, lines: Math.round((parseFloat(cs.height)) / lh) };
  });
  assert.deepEqual(await box(), { fitsW: true, fitsH: true, lines: 1 });
  await page.keyboard.press('Enter');
  assert.deepEqual(await box(), { fitsW: true, fitsH: true, lines: 2 }, 'after one newline');
  await page.keyboard.press('Enter');
  assert.deepEqual(await box(), { fitsW: true, fitsH: true, lines: 3 }, 'after two newlines');
  // 3 行目に日本語入力で打つ（変換中・変換後・確定）
  for (const text of ['「こーど', '「コード']) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    const b = await box();
    assert.ok(b.fitsW && b.fitsH && b.lines === 3, 'composing ' + text + ' ' + JSON.stringify(b));
  }
  await cdp.send('Input.insertText', { text: '「コード' });
  assert.deepEqual(await box(), { fitsW: true, fitsH: true, lines: 3 });
  assert.equal(await shadowEval(page, root => root.querySelector('textarea').value), '\n\n「コード');
  assert.deepEqual(errors, []);
  await page.close();
});

test('文字を入力中に、その上にパネルを開くと、パネルが手前に出る（入力欄の枠・文字・薄い答えはツールバーとパネルの下。T-092）', async () => {
  const { page, errors } = await openPage(browser, server.base + '/');
  await runCode(page, withDefaults(CODE, { ui: 'cp2' }));
  // その他のパネルが開く所を測って閉じ、そこに文字を書き始める（電卓は入りなので薄い答えも出る）
  await mouseClick(page, '.bar > [aria-label^="その他"]');
  const pr = await shadowEval(page, root => { const r = root.querySelector('.pn.on').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
  await page.keyboard.press('Escape');
  await mouseClick(page, '.bar > [aria-label^="文字"]');
  await page.mouse.click(pr[0] + 30, pr[1] + 20);
  await page.keyboard.type('11+1');
  assert.equal(await shadowEval(page, root => root.querySelector('.gh').textContent), '=12');
  // 入力したままパネルを開く
  await mouseClick(page, '.bar > [aria-label^="その他"]');
  const r = await shadowEval(page, root => {
    const ta = root.querySelector('textarea'), gh = root.querySelector('.gh'), bar = root.querySelector('.bar'), kids = [...bar.parentElement.children];
    const t = ta.getBoundingClientRect(), hit = root.elementFromPoint(t.left + 15, t.top + t.height / 2);
    return { open: !!root.querySelector('.pn.on'), hitPanel: !!(hit && hit.closest('.pn')),
      taBelow: kids.indexOf(ta) < kids.indexOf(bar), ghBelow: kids.indexOf(gh) < kids.indexOf(bar) };
  });
  assert.deepEqual(r, { open: true, hitPanel: true, taBelow: true, ghBelow: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test('スマホの 2 本指: 本家でも Simple でも、2 本指で動かすとページがスクロールし、1 本目で始めた線・選択・塗りつぶし・文字は残らない。1 本指では今まで通り描け、タッチの塗りつぶしと文字は離したときに行う（T-088・T-104）', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.base + '/long');
  await runCode(page, CODE);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  const state = () => page.evaluate(() => {
    const s = window.__paintBookmarklet.stats();
    return { y: scrollY, history: s.history, input: !!document.querySelector('paint-bookmarklet').shadowRoot.querySelector('.tx'), sel: !!s.selection };
  });
  const twoFingers = async () => {
    // 1 本目を置いて少し動かしてから（線を描き始める）、2 本目を置いて 2 本とも上へ 200px 動かす
    await touch('touchStart', [[150, 500]]);
    await touch('touchMove', [[160, 490]]);
    await touch('touchStart', [[160, 490], [250, 500]]);
    for (let i = 1; i <= 10; i++) await touch('touchMove', [[160, 490 - i * 20], [250, 500 - i * 20]]);
    await page.waitForTimeout(150); // 止まってから離す（慣性で滑らせない。T-106）
    await touch('touchEnd', [[160, 290]]);
    await touch('touchEnd', []);
    await page.waitForTimeout(100);
  };
  const tap = async (x, y) => { await touch('touchStart', [[x, y]]); await touch('touchEnd', []); await page.waitForTimeout(100); };
  // 本家: ペン・選択・塗りつぶし・文字のどれでも、2 本指はスクロールだけ（何も残らない）
  let y = 0;
  for (const key of ['p', 's', 'f', 't']) {
    await page.keyboard.press(key);
    await twoFingers();
    y += 200;
    assert.deepEqual(await state(), { y, history: 0, input: false, sel: false }, key);
  }
  // 1 本指: 塗りつぶしは離したときに塗る。文字は離したときに入力欄が出る
  await page.keyboard.press('f');
  await touch('touchStart', [[200, 450]]);
  assert.equal((await state()).history, 0, 'not filled while the finger is down');
  await touch('touchEnd', []);
  await page.waitForTimeout(100);
  assert.equal((await state()).history, 1, 'filled on release');
  await page.keyboard.press('t');
  await touch('touchStart', [[200, 450]]);
  assert.equal((await state()).input, false);
  await touch('touchEnd', []);
  await page.waitForTimeout(100);
  assert.equal((await state()).input, true, 'the text input appears on release');
  await page.keyboard.type('ab');
  await tap(100, 600); // 外を押すと確定
  assert.equal(await page.evaluate(() => window.__paintBookmarklet.stats().texts), 1);
  // 1 本指のペンは描く（スクロールしない）
  await page.keyboard.press('p');
  const h0 = (await state()).history;
  await touch('touchStart', [[100, 400]]);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [[100 + i * 20, 400 + i * 10]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(100);
  assert.deepEqual([(await state()).y, (await state()).history], [y, h0 + 1]);
  // Simple でも同じ
  await click(page, '[title^="Simple Preview"]');
  await twoFingers();
  y += 200;
  assert.deepEqual([(await state()).y, (await state()).history], [y, h0 + 1]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('2 本指のスクロールは、置いた位置＋指の動きを目標に 1 フレームに 1 回だけ動かす。ページが scroll-behavior: smooth でも指に付いていき、端で止まってから戻すとすぐ動く（T-108）', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.base + '/long');
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'smooth'; });
  await runCode(page, CODE);
  // スクロールを動かした回数とフレームの数を数える
  await page.evaluate(() => {
    window.__sc = 0; window.__fr = 0;
    for (const k of ['scrollTo', 'scrollBy']) { const f = window[k]; window[k] = function (...a) { window.__sc++; return f.apply(this, a); }; }
    const tick = () => { window.__fr++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  const y = () => page.evaluate(() => scrollY);
  const maxY = await page.evaluate(() => { scrollTo({ top: 1e6, behavior: 'instant' }); const m = scrollY; scrollTo({ top: 0, behavior: 'instant' }); return m; });
  // 2 本の指を交互に 3px ずつ動かす（中点は 1.5px ずつ動く）。合わせて 150px 上へ
  await touch('touchStart', [[150, 600]]);
  await touch('touchStart', [[150, 600], [250, 600]]);
  const c0 = await page.evaluate(() => [window.__sc, window.__fr]);
  let a = 600, b = 600;
  for (let i = 0; i < 50; i++) {
    if (i % 2) b -= 6; else a -= 6;
    await touch('touchMove', [[150, a], [250, b]]);
  }
  await page.waitForTimeout(150);
  const c1 = await page.evaluate(() => [window.__sc, window.__fr]);
  assert.equal(await y(), 150, 'the page follows the fingers exactly');
  assert.ok(c1[0] - c0[0] <= c1[1] - c0[1] + 1, 'at most one scroll per frame: ' + (c1[0] - c0[0]) + ' scrolls in ' + (c1[1] - c0[1]) + ' frames');
  await touch('touchEnd', [[150, a]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(100);
  // 下の端まで行ってからさらに引き、そのまま 20px 戻すと、すぐ 20px 戻る
  await page.evaluate(m => scrollTo({ top: m - 50, behavior: 'instant' }), maxY);
  await touch('touchStart', [[150, 600]]);
  await touch('touchStart', [[150, 600], [250, 600]]);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', [[150, 600 - i * 20], [250, 600 - i * 20]]); await page.waitForTimeout(16); }
  await page.waitForTimeout(50);
  assert.equal(await y(), maxY);
  for (let i = 1; i <= 2; i++) { await touch('touchMove', [[150, 400 + i * 10], [250, 400 + i * 10]]); await page.waitForTimeout(16); }
  await page.waitForTimeout(150);
  assert.equal(await y(), maxY - 20, 'moving back scrolls back at once');
  await touch('touchEnd', [[150, 420]]);
  await touch('touchEnd', []);
  assert.deepEqual(errors, []);
  await page.close();
});

test('描いている途中に 2 本目の指を置くと、それまでの線は残してスクロールになる（スクロールの動きでは描かない）。置いてすぐの 2 本目なら線は残さない（T-109）', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.base + '/long');
  await runCode(page, CODE);
  const cdp = await page.context().newCDPSession(page);
  // 指の番号は、3 つ目に書けばそれ、なければ並びの順。CDP の touchEnd は並べた指を離し、離した番号で touchMove を送ると新しい指が置かれる
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id], i) => ({ x, y, id: id ?? i })) });
  const hist = () => page.evaluate(() => window.__paintBookmarklet.stats().history);
  // 1 本指で 300 ms ほど右へ 120px 描いてから、2 本目を置いて 2 本とも上へ 200px
  await touch('touchStart', [[100, 500]]);
  for (let i = 1; i <= 12; i++) { await touch('touchMove', [[100 + i * 10, 500]]); await page.waitForTimeout(25); }
  await touch('touchStart', [[220, 500], [300, 500]]);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', [[220, 500 - i * 20], [300, 500 - i * 20]]); await page.waitForTimeout(16); }
  await page.waitForTimeout(150);
  await touch('touchEnd', [[220, 300, 0]]);
  // 片方を離しても、残りの指（2 本目）では描かない
  for (let i = 1; i <= 5; i++) await touch('touchMove', [[300 + i * 10, 300, 1]]);
  await touch('touchEnd', [[350, 300, 1]]);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => scrollY), 200);
  assert.equal(await hist(), 1, 'the line drawn before the scroll is kept');
  assert.ok((await readMain(page, 160, 300))[3] > 200, 'the kept line moved with the page');
  assert.equal((await readMain(page, 160, 500))[3], 0, 'the scroll itself did not draw');
  // 置いてすぐ 2 本目が来たら、線は残さない
  await touch('touchStart', [[100, 450]]);
  await touch('touchMove', [[106, 450]]);
  await touch('touchStart', [[106, 450], [200, 450]]);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [[106, 450 - i * 20], [200, 450 - i * 20]]);
  await page.waitForTimeout(150);
  await touch('touchEnd', [[106, 350]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(150);
  assert.equal(await hist(), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test('2 本指でスクロールしている間に 3 本目の指（iPad の手のひらなど）が触れても、線を描かない。2 本を離した後に残った 3 本目の指でも描かない（T-122）', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.base + '/long');
  await runCode(page, CODE);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id })) });
  await touch('touchStart', [[150, 500, 0]]);
  await touch('touchStart', [[150, 500, 0], [250, 500, 1]]);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [[150, 500 - i * 10, 0], [250, 500 - i * 10, 1]]);
  // 3 本目の指を置いて、2 本と一緒に動かす
  await touch('touchStart', [[150, 450, 0], [250, 450, 1], [100, 600, 2]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[150, 450 - i * 10, 0], [250, 450 - i * 10, 1], [100 + i * 20, 600, 2]]);
  await page.waitForTimeout(150);
  // スクロールの 2 本を離してから、残った 3 本目の指を動かして離す（CDP の touchEnd は、並べた指を離す）
  await touch('touchEnd', [[150, 370, 0], [250, 370, 1]]);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [[260, 600 - i * 20, 2]]);
  await touch('touchEnd', [[260, 500, 2]]);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => scrollY), 130);
  assert.equal(await page.evaluate(() => window.__paintBookmarklet.stats().history), 0, 'the third finger did not draw');
  assert.deepEqual(errors, []);
  await page.close();
});

test('描いている途中に画面が広がり、その線が 2 本指で取り消されても、すぐにキャンバスを合わせ直す（広がった所に描いた次の線が消えない。T-124）', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.base + '/long');
  await runCode(page, CODE);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id })) });
  const width = () => page.evaluate(() => window.__paintBookmarklet.stats().width);
  assert.equal(await width(), 390);
  await touch('touchStart', [[150, 500, 0]]);
  await touch('touchMove', [[153, 500, 0]]);
  await page.setViewportSize({ width: 800, height: 700 }); // 回転などで広がる（描いている途中なので合わせ直しは後回し）
  await page.waitForTimeout(100);
  await touch('touchStart', [[153, 500, 0], [250, 500, 1]]); // すぐ 2 本目 → 線は取り消し
  for (let i = 1; i <= 5; i++) await touch('touchMove', [[153, 500 - i * 10, 0], [250, 500 - i * 10, 1]]);
  await page.waitForTimeout(150);
  await touch('touchEnd', [[153, 450, 0]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(100);
  assert.equal(await width(), 800, 'refit right after the abort');
  // 広がった所に描いた線が残る
  await touch('touchStart', [[600, 300, 0]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[600 + i * 20, 300, 0]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(150);
  assert.ok((await alphaStats(page, 590, 290, 180, 20)).count > 300, 'the line in the widened area is kept');
  assert.deepEqual(errors, []);
  await page.close();
});

test('2 本指のスクロールの慣性: 動かしたまま離すと滑って止まる。止まってから離すと滑らない。滑っている間に押すと止まり、その指では描かない（T-106）', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.base + '/long');
  await runCode(page, CODE);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  const y = () => page.evaluate(() => scrollY);
  // 2 本指を 16 ms ごとに 20 px ずつ上へ（約 1.25 px/ms）。pause なら止まってから離す
  const swipe = async pause => {
    await touch('touchStart', [[150, 600]]);
    await touch('touchStart', [[150, 600], [250, 600]]);
    for (let i = 1; i <= 10; i++) { await touch('touchMove', [[150, 600 - i * 20], [250, 600 - i * 20]]); await page.waitForTimeout(16); }
    if (pause) await page.waitForTimeout(200);
    await touch('touchEnd', [[150, 400]]);
    await touch('touchEnd', []);
  };
  const settle = async () => { let a = await y(), b; for (;;) { await page.waitForTimeout(250); b = await y(); if (b === a) return b; a = b; } };
  await swipe(false);
  const y1 = await settle();
  assert.ok(y1 > 200 + 150, 'it keeps scrolling after the fingers lift: ' + y1);
  // 止まってから離すと滑らない
  await swipe(true);
  assert.equal(await settle(), y1 + 200);
  // 滑っている間に押すと止まる。その指で動かしても描かない
  const h0 = await page.evaluate(() => window.__paintBookmarklet.stats().history);
  await swipe(false);
  await page.waitForTimeout(60);
  await touch('touchStart', [[200, 300]]);
  const yStop = await y();
  await page.waitForTimeout(200);
  assert.equal(await y(), yStop, 'a touch stops the fling');
  for (let i = 1; i <= 5; i++) await touch('touchMove', [[200 + i * 20, 300]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__paintBookmarklet.stats().history), h0, 'the stopping touch does not draw');
  // 次の 1 本指は描ける
  await touch('touchStart', [[100, 400]]);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [[100 + i * 20, 400]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__paintBookmarklet.stats().history), h0 + 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test('iPhone・iPad では、描く面とツールバーの touchmove を止める（ページ自身のスクロールが同時に動いて震えないように）。ボタンのタップ・パネルのスライダー・2 本指のスクロールはそのまま。ほかでは止めない（T-107）', async () => {
  const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const open = async ua => {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true, ...(ua ? { userAgent: ua } : {}) });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(server.base + '/long');
    await runCode(page, CODE);
    // 最後の touchmove を覚えておき、配り終えた後に止められたかを見る
    await page.evaluate(() => addEventListener('touchmove', e => { window.__tm = e; }, { capture: true, passive: true }));
    await page.waitForTimeout(200);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    const moved = async (x, y) => {
      await page.evaluate(() => { window.__tm = null; });
      await touch('touchStart', [[x, y]]);
      for (let i = 1; i <= 5; i++) { await touch('touchMove', [[x + i * 8, y + i * 4]]); await page.waitForTimeout(20); }
      const p = await page.evaluate(() => window.__tm && window.__tm.defaultPrevented);
      await touch('touchEnd', []);
      await page.waitForTimeout(50);
      return p;
    };
    const center = sel => shadowEval(page, (root, sel) => { const r = root.querySelector(sel).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel);
    return { page, errors, touch, moved, center };
  };
  const P = await open(IOS);
  assert.equal(await P.moved(150, 400), true, 'touchmove on the drawing surface is prevented');
  assert.equal(await P.page.evaluate(() => window.__paintBookmarklet.stats().history), 1, 'the line is drawn');
  const [bx, by] = await P.center('.bar > [aria-label^="消しゴム"]');
  assert.equal(await P.moved(bx, by), true, 'touchmove on the toolbar is prevented');
  // タップでボタンが押せる
  const [tx, ty] = await P.center('.bar > [aria-label^="文字"]');
  await P.touch('touchStart', [[tx, ty]]);
  await P.touch('touchEnd', []);
  await P.page.waitForTimeout(50);
  assert.equal((await prefs(P.page)).tool, 'text');
  // パネルのスライダーは止めない
  await mouseClick(P.page, '.bar > [aria-label^="色・太さ・濃さ"]');
  const [sx, sy] = await P.center('.pn.on input[type="range"]');
  assert.equal(await P.moved(sx, sy), false, 'sliders in a panel keep their touch behaviour');
  // 2 本指のスクロールはそのまま
  await P.page.keyboard.press('Escape');
  await P.touch('touchStart', [[150, 600]]);
  await P.touch('touchStart', [[150, 600], [250, 600]]);
  for (let i = 1; i <= 10; i++) await P.touch('touchMove', [[150, 600 - i * 20], [250, 600 - i * 20]]);
  await P.page.waitForTimeout(150);
  await P.touch('touchEnd', [[150, 400]]);
  await P.touch('touchEnd', []);
  await P.page.waitForTimeout(100);
  assert.equal(await P.page.evaluate(() => scrollY), 200);
  assert.deepEqual(P.errors, []);
  await P.page.close();
  // iPhone・iPad でなければ止めない（touch-action だけ）
  const C = await open();
  assert.equal(await C.moved(150, 400), false);
  assert.deepEqual(C.errors, []);
  await C.page.close();
});

test('LINE の中のブラウザでは、ツールを使う間ページをいちばん上から 1px 下げておく（下へなぞると LINE がブラウザを小さくするのを避ける）。LINE でなければ今まで通り（T-105）', async () => {
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.19.0';
  const open = async ua => {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true, ...(ua ? { userAgent: ua } : {}) });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(server.base + '/long');
    await runCode(page, CODE);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    // 2 本指を下へ動かす（ページは上へ戻る）
    const twoDown = async () => {
      await touch('touchStart', [[150, 300]]);
      await touch('touchStart', [[150, 300], [250, 300]]);
      for (let i = 1; i <= 10; i++) await touch('touchMove', [[150, 300 + i * 20], [250, 300 + i * 20]]);
      await touch('touchEnd', [[150, 500]]);
      await touch('touchEnd', []);
      await page.waitForTimeout(100);
    };
    return { page, errors, touch, twoDown, y: () => page.evaluate(() => scrollY) };
  };
  const L = await open(UA);
  assert.equal(await L.y(), 1, 'opening the tool moves the page 1px off the top');
  await L.page.evaluate(() => scrollTo(0, 100));
  await L.twoDown();
  assert.equal(await L.y(), 1, 'two fingers stop 1px before the top');
  // ページのスクリプトがいちばん上に戻しても、描き始めに 1px 下げてから描く（線はページの描いた所に付く）
  await L.page.evaluate(() => scrollTo(0, 0));
  await L.touch('touchStart', [[100, 400]]);
  for (let i = 1; i <= 5; i++) await L.touch('touchMove', [[100 + i * 30, 400]]);
  await L.touch('touchEnd', []);
  await L.page.waitForTimeout(100);
  assert.equal(await L.y(), 1);
  assert.ok((await readMain(L.page, 160, 400))[3] > 200, 'the line is where it was drawn');
  // ページ操作モードの間は下げない。描く方に戻ると下げる
  await L.page.keyboard.press('v');
  await L.page.evaluate(() => scrollTo(0, 0));
  await L.page.keyboard.press('v');
  assert.equal(await L.y(), 1);
  assert.deepEqual(L.errors, []);
  await L.page.close();
  // LINE でなければ、いちばん上まで戻れる
  const C = await open();
  assert.equal(await C.y(), 0);
  await C.page.evaluate(() => scrollTo(0, 100));
  await C.twoDown();
  assert.equal(await C.y(), 0);
  assert.deepEqual(C.errors, []);
  await C.page.close();
});

test('入力の録画（開発用）: 入れて描くと、線ごとに入力（押す・動く・離す・フレーム）が録られ、JSON で書き出せる。切ると録らない。開発用でなければ出ない', async () => {
  const { readFileSync } = await import('node:fs');
  const items = page => shadowEval(page, root => [...root.querySelectorAll('.mi span')].map(s => s.textContent).filter(t => /録/.test(t)));
  // 開発用でなければメニューに出ない
  const { page: p0 } = await fresh();
  assert.deepEqual(await items(p0), []);
  await p0.close();
  const { page, errors } = await openPage(browser, server.base + '/');
  await runCode(page, withDefaults(CODE, { dev: true }));
  assert.deepEqual(await items(page), ['入力を録る（開発用）', '録った入力を書き出す']);
  // 何も録っていなければ書き出さない
  await click(page, '[title^="録った入力を書き出す"]');
  assert.match(await shadowEval(page, root => root.querySelector('.t').textContent), /録った線がありません/);
  // 入れて、ペンと蛍光ペンで 1 本ずつ描く（消しゴムは録らない）
  await click(page, '[title^="入力を録る"]');
  assert.equal(await shadowEval(page, root => root.querySelector('[title^="入力を録る"]').getAttribute('aria-checked')), 'true');
  await drag(page, [[100, 300], [300, 320], [500, 300]], 12);
  await page.keyboard.press('h');
  await drag(page, [[100, 450], [400, 460]], 8);
  await page.keyboard.press('e');
  await drag(page, [[100, 550], [400, 550]], 5);
  const st = await page.evaluate(() => window.__paintBookmarklet.stats().rec);
  assert.equal(st[0], true);
  assert.equal(st[1], 2, 'two ink strokes');
  const [dl] = await Promise.all([page.waitForEvent('download'), click(page, '[title^="録った入力を書き出す"]')]);
  assert.match(dl.suggestedFilename(), /^paint-input-\d{8}-\d{6}\.json$/);
  const data = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  assert.equal(data.v, 1);
  assert.deepEqual(data.cols, ['kind', 't', 'x', 'y', 'pressure', 'handled']);
  assert.equal(typeof data.ua, 'string');
  assert.equal(data.url, undefined, 'no page URL');
  assert.deepEqual(data.strokes.map(s => [s.tool, s.type]), [['pen', 'mouse'], ['marker', 'mouse']]);
  for (const s of data.strokes) {
    assert.equal(s.rows.length % 6, 0);
    const rows = [];
    for (let i = 0; i < s.rows.length; i += 6) rows.push(s.rows.slice(i, i + 6));
    const kinds = new Set(rows.map(r => r[0]));
    assert.equal(rows[0][0], 0, 'starts with down');
    assert.equal(rows[0][1], 0, 'times are relative to the down');
    assert.ok(kinds.has(1) && kinds.has(3), 'moves and up: ' + [...kinds]);
    assert.ok(rows.filter(r => r[0] === 1 || r[0] === 2).length >= 5);
    // 実際の入力の点（予測点は線の先へはみ出してよい）
    for (const r of rows) if (r[0] < 5) assert.ok(r[2] >= 90 && r[2] <= 510 && r[3] >= 290 && r[3] <= 470, 'coordinates in CSS px: ' + r);
  }
  // 切ると、それからの線は録らない（録った分は書き出せる）
  await click(page, '[title^="入力を録る"]');
  await page.keyboard.press('p');
  await drag(page, [[600, 300], [800, 300]], 5);
  assert.deepEqual((await page.evaluate(() => window.__paintBookmarklet.stats().rec)).slice(0, 2), [false, 2]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('PNG 保存がダウンロードされる', async () => {
  const { page } = await fresh();
  await drag(page, [[100, 300], [500, 300]], 5);
  const [dl] = await Promise.all([page.waitForEvent('download'), click(page, '[title^="PNG"]')]);
  assert.match(dl.suggestedFilename(), /^paint-\d{8}-\d{6}\.png$/);
  await page.close();
});

test('塗りつぶし: 画面を横切る線の上側だけが塗られる / 線の上をクリックすると線の色が変わる', async () => {
  const { page } = await fresh();
  await page.keyboard.press(']'); await page.keyboard.press(']'); // 少し太く
  await drag(page, [[1, 350], [999, 350]], 20); // 画面の端から端まで（上下を分断する壁）
  await page.keyboard.press('f');
  await page.keyboard.press('6'); // 緑
  await page.mouse.click(500, 100);
  assert.deepEqual(await readMain(page, 500, 100), [67, 160, 71, 255], 'top filled');
  assert.deepEqual(await readMain(page, 2, 2), [67, 160, 71, 255], 'top corner filled');
  assert.equal((await readMain(page, 500, 600))[3], 0, 'bottom not filled');
  assert.equal((await readMain(page, 998, 698))[3], 0, 'bottom corner not filled');
  // 線（赤）の上をクリック → 線だけが青に
  await page.keyboard.press('7');
  await page.mouse.click(500, 350);
  assert.deepEqual(await readMain(page, 300, 350), [30, 136, 229, 255], 'stroke recolored');
  assert.deepEqual(await readMain(page, 500, 100), [67, 160, 71, 255], 'fill untouched');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await readMain(page, 300, 350), [229, 57, 53, 255]);
  await page.close();
});

test('pointerrawupdate と pointermove の両方が届いても各入力点は 1 回だけ処理される', async () => {
  const { page } = await fresh();
  const st = () => page.evaluate(() => window.__paintBookmarklet.stats());
  const before = await st();
  assert.equal(before.rawupdate, true, 'this Chromium supports pointerrawupdate');
  await page.mouse.move(100, 200);
  await page.mouse.down();
  const N = 60;
  for (let i = 1; i <= N; i++) await page.mouse.move(100 + i * 10, 200 + (i % 2) * 40);
  await page.mouse.up();
  const after = await st();
  assert.ok(after.events - before.events >= N * 2 - 2, `both event types delivered (${after.events - before.events})`);
  assert.equal(after.points - before.points, N, 'each point consumed exactly once');
  await page.close();
});

// ---------- T-003: 絵がページに貼り付き、スクロールで一緒に動く ----------

test('描いてからスクロールすると、絵も本文と一緒に動く', async () => {
  const { page } = await fresh('/long');
  await drag(page, [[100, 300], [400, 300]], 10);
  assert.ok((await screenPixel(page, 250, 300))[3] > 200, 'drawn');
  await scrollTo(page, 200);
  assert.ok((await screenPixel(page, 250, 100))[3] > 200, 'moved up with the page');
  assert.equal((await screenPixel(page, 250, 300))[3], 0, 'nothing left at the old screen position');
  assert.ok((await readMain(page, 250, 100))[3] > 200, 'pixels() agrees');
  await page.close();
});

test('スクロールした位置で描いた線が本文の正しい位置に付き、元に戻す・やり直すも効く', async () => {
  const { page } = await fresh('/long');
  await scrollTo(page, 800); // 目印 #m1（文書の y=900〜910）は画面の y=100〜110
  await drag(page, [[120, 105], [380, 105]], 10);
  await scrollTo(page, 850); // 目印は画面の y=50〜60 へ
  const m1 = await page.evaluate(() => document.getElementById('m1').getBoundingClientRect().top);
  assert.equal(m1, 50);
  assert.ok((await screenPixel(page, 250, 55))[3] > 200, 'stroke stays on the marker');
  await page.keyboard.press('Control+z');
  assert.equal((await screenPixel(page, 250, 55))[3], 0, 'undo');
  await page.keyboard.press('Control+Shift+z');
  assert.ok((await screenPixel(page, 250, 55))[3] > 200, 'redo');
  await scrollTo(page, 0);
  await scrollTo(page, 850);
  assert.ok((await screenPixel(page, 250, 55))[3] > 200, 'still there after scrolling away and back');
  await page.close();
});

test('画面に固定: その他のメニューで入れると、スクロールしても絵と文字が画面の同じ所に留まり、そのまま描ける。切ると見えている位置のままページに付き直し、元に戻す・やり直すも合う', async () => {
  const { page, errors } = await fresh('/long');
  await drag(page, [[120, 200], [380, 200]], 10); // A: 文書の y=200
  await page.keyboard.press('t');
  await page.mouse.click(500, 400);
  await page.keyboard.type('Hi');
  await page.keyboard.press('Escape');
  await page.keyboard.press('p');
  const t0 = await textRect(page);
  const fixedNow = () => page.evaluate(() => window.__paintBookmarklet.stats().fixed);
  const toggleFixed = async () => {
    await mouseClick(page, '[aria-label^="その他"]');
    await mouseClick(page, '.pn.on [aria-label^="画面に固定"]');
    await page.keyboard.press('Escape'); // メニューを閉じる
  };
  const ink = (x, y) => screenPixel(page, x, y).then(p => p[3] > 200);
  // 入れてスクロールしても、絵と文字は画面の同じ所にある
  await toggleFixed();
  assert.equal(await fixedNow(), true);
  await scrollTo(page, 500);
  assert.equal(await ink(250, 200), true, 'A は画面に留まる');
  assert.deepEqual(await textRect(page), t0);
  // 固定のまま描け、元に戻す・やり直すも画素単位で合う
  await drag(page, [[120, 300], [380, 300]], 10); // B: 画面の y=300
  assert.equal(await ink(250, 300), true);
  const s1 = await checksum(page);
  await page.keyboard.press('Control+z');
  assert.equal(await ink(250, 300), false);
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await checksum(page), s1);
  // 切っても（スクロールは 500 のまま）見えている位置は変わらない
  await toggleFixed();
  assert.equal(await fixedNow(), false);
  assert.equal(await ink(250, 200), true);
  assert.equal(await ink(250, 300), true);
  assert.deepEqual(await textRect(page), t0);
  assert.equal(await checksum(page), s1);
  // その後はページに付く（文書の y=700・800 に付き直した）
  await scrollTo(page, 300);
  assert.equal(await ink(250, 400), true, 'A はページと一緒に動く');
  assert.equal(await ink(250, 500), true, 'B はページと一緒に動く');
  assert.equal(await ink(250, 200), false);
  assert.ok(near((await textRect(page)).y, t0.y + 200, 1));
  const s2 = await checksum(page);
  await page.keyboard.press('Control+z');
  assert.equal(await ink(250, 500), false, 'B の取り消し');
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await checksum(page), s2);
  assert.deepEqual(errors, []);
  await page.close();
});

test('塗りつぶしは見えている画面の外へはみ出さず、元に戻すとスクロールしても細い線が残らない', async () => {
  const { page, errors } = await fresh('/long');
  // 文書の y の範囲 [y0, y1) で色の付いた画素を数える（今のスクロール位置から画面の座標に直して読む）
  const ink = (y0, y1) => page.evaluate(([y0, y1]) => {
    const d = window.__paintBookmarklet.pixels(0, y0 - scrollY, 1000, y1 - y0).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
    return n;
  }, [y0, y1]);
  await scrollTo(page, 500);
  await page.keyboard.press('f');
  await page.mouse.click(500, 400); // 何も描いていない所: 画面いっぱい（文書の y=500〜1200）を塗る
  assert.equal(await ink(500, 1200), 1000 * 700, '画面の中は全部塗られる（何も描いていない画面は 1 つの領域）');
  await scrollTo(page, 900);
  assert.equal(await ink(1200, 1203), 0, '画面の下端の外は塗らない');
  await scrollTo(page, 200);
  assert.equal(await ink(497, 500), 0, '画面の上端の外は塗らない');
  await page.keyboard.press('Control+z');
  for (const y of [0, 900]) {
    await scrollTo(page, y);
    assert.equal(await ink(y, y + 700), 0, `元に戻した後、スクロール ${y} で何も残らない`);
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('スクロールした位置でも、塗りつぶし・消しゴム・PNG 保存の範囲が正しい', async () => {
  const { page } = await fresh('/long');
  await scrollTo(page, 1200);
  await page.keyboard.press('r');
  await drag(page, [[200, 200], [400, 350]], 10);
  await page.keyboard.press('f');
  await page.mouse.click(300, 275);
  assert.deepEqual(await screenPixel(page, 330, 275), [229, 57, 53, 255], 'filled inside');
  assert.equal((await screenPixel(page, 450, 275))[3], 0, 'no leak outside');
  await page.keyboard.press('e');
  await drag(page, [[300, 220], [300, 330]], 10);
  assert.equal((await screenPixel(page, 300, 275))[3], 0, 'erased');
  await page.keyboard.press('Control+z');
  assert.ok((await screenPixel(page, 300, 275))[3] > 200, 'erase undone');
  await scrollTo(page, 1300);
  assert.deepEqual(await screenPixel(page, 330, 175), [229, 57, 53, 255], 'moved with the page');
  // PNG はいま見えている範囲を写す
  const png = await page.evaluate(async () => {
    const d = window.__paintBookmarklet.pixels(330, 175, 1, 1).data;
    return Array.from(d);
  });
  assert.deepEqual(png, [229, 57, 53, 255]);
  await page.close();
});

test('画面の端に描いても、スクロール範囲が広がらない', async () => {
  const { page } = await fresh('/long');
  const size = () => page.evaluate(() => {
    const de = document.documentElement;
    return [de.scrollWidth, de.scrollHeight, de.clientWidth];
  });
  const [w0, h0, cw] = await size();
  await drag(page, [[990, 100], [999, 600]], 10); // 右端
  await scrollTo(page, 99999);
  await drag(page, [[100, 690], [900, 699]], 10); // 下端
  const [w1, h1] = await size();
  assert.equal(w1, w0, 'no wider');
  assert.ok(w1 <= cw, 'no horizontal scrollbar');
  assert.equal(h1, h0, 'no taller');
  await page.close();
});

test('ページの高さが縮むと、面も縮んでスクロール範囲が残らない', async () => {
  const { page } = await fresh('/long');
  await drag(page, [[100, 100], [300, 100]], 5);
  await page.evaluate(() => { document.getElementById('sp').style.height = '1200px'; });
  await drag(page, [[100, 200], [300, 200]], 5); // 確定のときに面の大きさを測り直す
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  assert.equal(h, 1200);
  await page.close();
});

test('html に position や margin があるページでも、画面上の位置が合う', async () => {
  const { page } = await fresh('/offset');
  await drag(page, [[100, 300], [400, 300]], 10);
  assert.ok((await screenPixel(page, 250, 300))[3] > 200, 'at the drawn position');
  await scrollTo(page, 500);
  await drag(page, [[100, 200], [400, 200]], 10);
  assert.ok((await screenPixel(page, 250, 200))[3] > 200, 'drawn after scrolling');
  await scrollTo(page, 600);
  assert.ok((await screenPixel(page, 250, 100))[3] > 200, 'moves with the page');
  await page.close();
});

test('確定の瞬間にちらつかない（live は隠してから 2 フレーム後に消す）。半透明の濃さは canvas の中で付ける（前の方式では押す前に合わせてある）', async () => {
  for (const blend of ['canvas', 'group']) {
    const { page } = await openPage(browser, server.base + '/');
    await runCode(page, withDefaults(CODE, { blend }));
    await page.keyboard.press('h'); // 蛍光ペン（35%）
    const r = await shadowEval(page, async root => {
      const grp = root.querySelector('.g'), live = root.querySelector('canvas.l'), pad = root.querySelector('.p');
      const op = () => grp.style.opacity || '1';
      const before = op();
      const ev = (type, x) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 5, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: 300, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1 });
      const alpha = () => live.getContext('2d').getImageData(250, 300, 1, 1).data[3];
      pad.dispatchEvent(ev('pointerdown', 100));
      for (let x = 110; x <= 400; x += 10) pad.dispatchEvent(ev('pointermove', x));
      const during = { opacity: op(), live: alpha() };
      pad.dispatchEvent(ev('pointerup', 400));
      const atUp = { opacity: op(), live: alpha(), surface: window.__paintBookmarklet.pixels(250, 300, 1, 1).data[3] };
      for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
      return { before, during, atUp, after: { opacity: op(), live: alpha() } };
    });
    const a = blend === 'canvas' ? '1' : '0.35';
    assert.equal(r.before, a, blend + ': opacity set when the tool was chosen');
    assert.equal(r.during.opacity, a, blend + ': opacity while drawing');
    // canvas の方式は live に線の濃さ（35% ≈ 89）で、前の方式は不透明で描く
    assert.ok(blend === 'canvas' ? Math.abs(r.during.live - 89) <= 2 : r.during.live > 200, blend + ': live alpha ' + r.during.live);
    assert.equal(r.atUp.opacity, '0', blend + ': live hidden at commit');
    assert.ok(r.atUp.live > 80 && r.atUp.surface > 80, blend + ': stroke on both layers at the moment of commit');
    assert.equal(r.after.live, 0, blend + ': live cleared after frames');
    assert.equal(r.after.opacity, a, blend + ': opacity restored');
    await page.close();
  }
});

test('半透明の線は、描いている途中も重なった所が濃くならず（まとめた要素の opacity は 1）、確定した絵は前の方式とほぼ同じ', async () => {
  const run = (page, pen) => shadowEval(page, async (root, pen) => {
    const api = window.__paintBookmarklet, pad = root.querySelector('.p'), lv = root.querySelector('canvas.l'), pr = root.querySelector('canvas.q'), grp = root.querySelector('.g');
    api.clear(); api.tool(pen === 'marker' ? 'marker' : 'pen');
    const ev = (type, x, y, ts) => { const e = new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 9, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1 }); Object.defineProperty(e, 'timeStamp', { value: ts }); return e; };
    // 自分と交わる線（途中で予測線も出るように、8 ms 刻みで速く動かす）
    const cs = [[100, 300], [500, 300], [300, 150], [300, 450]], path = [];
    for (let i = 0; i < cs.length - 1; i++) for (let k = 0; k < 20; k++) path.push([Math.round(cs[i][0] + (cs[i + 1][0] - cs[i][0]) * k / 20), Math.round(cs[i][1] + (cs[i + 1][1] - cs[i][1]) * k / 20)]);
    path.push(cs.at(-1));
    const T0 = performance.now() + 1000;
    pad.dispatchEvent(ev('pointerdown', ...path[0], T0));
    // 見えている濃さ（live と pred を重ねて、まとめた要素の opacity を掛ける）の最大と、線の濃さ（89）を 6 以上超えた画素の数（1 回の入力での最大）
    let max = 0, over = 0, ops = new Set();
    for (let k = 1; k < path.length; k++) {
      pad.dispatchEvent(ev('pointermove', ...path[k], T0 + k * 8));
      ops.add(grp.style.opacity || '1');
      const a = lv.getContext('2d').getImageData(80, 130, 440, 340).data, b = pr.getContext('2d').getImageData(80, 130, 440, 340).data, g = +(grp.style.opacity || 1);
      let o = 0;
      for (let i = 3; i < a.length; i += 4) { const t = (a[i] + b[i] * (1 - a[i] / 255)) * g; if (t > max) max = t; if (t > 95) o++; }
      over = Math.max(over, o);
    }
    pad.dispatchEvent(ev('pointerup', ...cs.at(-1), T0 + path.length * 8));
    const d = api.pixels(80, 130, 440, 340).data, al = [];
    for (let i = 3; i < d.length; i += 4) al.push(d[i]);
    return { max: Math.round(max), over, ops: [...ops], al };
  }, pen);
  const res = {};
  for (const blend of ['canvas', 'group']) {
    const { page, errors } = await openPage(browser, server.base + '/');
    await runCode(page, withDefaults(CODE, { blend, alpha: { pen: 0.35 }, size: { pen: 24 } }));
    for (const pen of ['marker', 'pen', 'pencil']) {
      if (pen === 'pencil') await shadowEval(page, root => root.querySelector('[aria-label^="鉛筆"]').click());
      res[blend + ' ' + pen] = await run(page, pen);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  for (const pen of ['marker', 'pen', 'pencil']) {
    const c = res['canvas ' + pen], g = res['group ' + pen];
    assert.deepEqual(c.ops, ['1'], pen + ': group opacity stays 1');
    assert.deepEqual(g.ops, ['0.35'], pen + ': old way uses group opacity');
    // 重なった所が二重になると 0.35 + 0.35 × 0.65 ≈ 148 になる。縁のぼかしの数画素だけは少し超えてよい
    assert.ok(c.max < 115 && c.over <= 20, pen + ': while drawing ' + JSON.stringify({ max: c.max, over: c.over }));
    assert.ok(g.max <= 90, pen + ': old way while drawing ' + g.max);
    // 確定した絵の濃さは、前の方式と 3 以内（8 ビットで足すときの丸め）
    let n = 0, dmax = 0;
    for (let i = 0; i < c.al.length; i++) { if (c.al[i]) n++; dmax = Math.max(dmax, Math.abs(c.al[i] - g.al[i])); }
    assert.ok(n > 10000, pen + ': stroke committed');
    assert.ok(dmax <= 3, pen + ': committed alpha differs from the old way by ' + dmax);
  }
});

test('scroll / wheel のリスナーを登録しない（スクロール中に JS が動かない）', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.addInitScript(() => {
    window.__types = [];
    const orig = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, ...rest) { window.__types.push(type); return orig.call(this, type, ...rest); };
  });
  await page.goto(server.base + '/long');
  await runBookmarklet(page);
  await drag(page, [[100, 300], [400, 300]], 10);
  await scrollTo(page, 500);
  await drag(page, [[100, 300], [400, 300]], 10);
  const types = await page.evaluate(() => window.__types);
  assert.ok(types.includes('pointerdown'), 'instrumentation works');
  assert.deepEqual(types.filter(t => t === 'scroll' || t === 'wheel'), []);
  await page.close();
});

test('高密度の画面（2x）でも、スクロールに追従し位置が合う', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });
  await page.goto(server.base + '/long');
  await runBookmarklet(page);
  await scrollTo(page, 300);
  await drag(page, [[100, 300], [400, 300]], 10);
  assert.ok((await screenPixel(page, 250, 300))[3] > 200, 'drawn');
  await scrollTo(page, 400);
  assert.ok((await screenPixel(page, 250, 200))[3] > 200, 'moved with the page');
  assert.equal((await page.evaluate(() => window.__paintBookmarklet.stats().dpr)), 2);
  await page.close();
});

test('途中で画面の密度が変わっても（ズーム相当）、描いた位置が合う', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(server.base + '/long');
  await runBookmarklet(page);
  await drag(page, [[100, 200], [400, 200]], 10); // 面の解像度は最初の 1x で決まる
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1.5, mobile: false });
  await page.waitForFunction(() => devicePixelRatio === 1.5);
  await scrollTo(page, 100);
  await drag(page, [[100, 400], [400, 400]], 10); // 画面 1.5x → 面 1x の縮小が入る
  assert.ok((await screenPixel(page, 250, 400))[3] > 150, 'second stroke at the drawn position');
  assert.ok((await screenPixel(page, 250, 100))[3] > 150, 'first stroke moved with the page');
  await page.keyboard.press('Control+z');
  assert.equal((await screenPixel(page, 250, 400))[3], 0, 'undo');
  await page.close();
});
