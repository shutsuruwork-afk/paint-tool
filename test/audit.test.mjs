// Audit (2026-10-17): regressions found in the gesture code (T-104〜T-110). Each test failed on v1.32.1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CODE, startServer, launch, runCode, readMain, shadowEval, withDefaults } from './helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser.close(); server.srv.close(); });

const mobile = async (path = '/long', extra = {}) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true, ...extra });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.base + path);
  return { page, errors };
};
const fire = (page, type, o) => shadowEval(page, (root, [type, o]) => {
  root.querySelector('.p').dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, ...o }));
}, [type, o]);
const hist = page => page.evaluate(() => window.__paintBookmarklet.stats().history);
const frames = (page, n = 3) => page.evaluate(n => new Promise(r => { const f = () => (--n ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); }), n);

test('パームリジェクション: ペンで描いた直後やペンを近づけている間の 2 本のタッチ（手のひら）では、ページがスクロールしない。描いている途中にも動かない（T-104 で入った不具合）', async () => {
  const { page, errors } = await mobile();
  await runCode(page, CODE);
  const pen = (type, x, y, buttons = 1) => fire(page, type, { pointerId: 50, pointerType: 'pen', isPrimary: true, pressure: buttons ? 0.6 : 0, clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0, buttons });
  const palm = async (dy, steps = 8) => {
    await fire(page, 'pointerdown', { pointerId: 61, pointerType: 'touch', isPrimary: true, clientX: 250, clientY: 600, button: 0, buttons: 1 });
    await fire(page, 'pointerdown', { pointerId: 62, pointerType: 'touch', isPrimary: false, clientX: 330, clientY: 620, button: 0, buttons: 1 });
    for (let i = 1; i <= steps; i++) {
      await fire(page, 'pointermove', { pointerId: 61, pointerType: 'touch', isPrimary: true, clientX: 250, clientY: 600 - i * dy, button: -1, buttons: 1 });
      await fire(page, 'pointermove', { pointerId: 62, pointerType: 'touch', isPrimary: false, clientX: 330, clientY: 620 - i * dy, button: -1, buttons: 1 });
      await frames(page, 1);
    }
  };
  const palmUp = async () => {
    await fire(page, 'pointerup', { pointerId: 61, pointerType: 'touch', isPrimary: true, clientX: 250, clientY: 300, button: 0, buttons: 0 });
    await fire(page, 'pointerup', { pointerId: 62, pointerType: 'touch', isPrimary: false, clientX: 330, clientY: 320, button: 0, buttons: 0 });
    await page.waitForTimeout(150);
  };
  // 1) right after a pen stroke (within the 500 ms palm-rejection window)
  await pen('pointerdown', 100, 300);
  for (let i = 1; i <= 6; i++) await pen('pointermove', 100 + i * 20, 300);
  await pen('pointerup', 220, 300, 0);
  await palm(25);
  await palmUp();
  assert.equal(await page.evaluate(() => scrollY), 0, 'a palm right after a pen stroke must not scroll the page');
  // 2) while the pen hovers
  await pen('pointermove', 150, 200, 0);
  await palm(25);
  await palmUp();
  assert.equal(await page.evaluate(() => scrollY), 0, 'a palm while the pen hovers must not scroll the page');
  // 3) the page must not move under a pen stroke, even if a palm is resting and moving
  await page.waitForTimeout(600);
  await fire(page, 'pointerdown', { pointerId: 61, pointerType: 'touch', isPrimary: true, clientX: 250, clientY: 600, button: 0, buttons: 1 });
  await fire(page, 'pointerdown', { pointerId: 62, pointerType: 'touch', isPrimary: false, clientX: 330, clientY: 620, button: 0, buttons: 1 });
  await pen('pointerdown', 60, 200);
  const y0 = await page.evaluate(() => scrollY);
  for (let i = 1; i <= 6; i++) {
    await pen('pointermove', 60 + i * 20, 200);
    await fire(page, 'pointermove', { pointerId: 61, pointerType: 'touch', isPrimary: true, clientX: 250, clientY: 600 - i * 20, button: -1, buttons: 1 });
    await fire(page, 'pointermove', { pointerId: 62, pointerType: 'touch', isPrimary: false, clientX: 330, clientY: 620 - i * 20, button: -1, buttons: 1 });
    await frames(page, 1);
  }
  await pen('pointerup', 180, 200, 0);
  await palmUp();
  assert.equal(await page.evaluate(() => scrollY), y0, 'the page does not scroll while the pen draws');
  // 4) control: two fingers well after the pen still scroll
  await page.waitForTimeout(600);
  await palm(25);
  await page.waitForTimeout(150); // stop before lifting (no fling)
  await palmUp();
  assert.ok(await page.evaluate(() => scrollY) >= y0 + 150, 'two fingers without a pen nearby still scroll');
  assert.deepEqual(errors, []);
  await page.close();
});

test('2 本指でスクロールしている間に 3 本目の指が触れても、線は描かない（T-104 で入った不具合）', async () => {
  const { page, errors } = await mobile();
  await runCode(page, CODE);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id })) });
  await touch('touchStart', [[150, 600, 0]]);
  await touch('touchStart', [[150, 600, 0], [250, 600, 1]]);
  for (let i = 1; i <= 5; i++) { await touch('touchMove', [[150, 600 - i * 20, 0], [250, 600 - i * 20, 1]]); await page.waitForTimeout(16); }
  // a third finger lands and moves while the two keep scrolling
  await touch('touchStart', [[150, 500, 0], [250, 500, 1], [80, 300, 2]]);
  for (let i = 1; i <= 6; i++) { await touch('touchMove', [[150, 500 - i * 10, 0], [250, 500 - i * 10, 1], [80 + i * 25, 300, 2]]); await page.waitForTimeout(16); }
  await page.waitForTimeout(150);
  await touch('touchEnd', [[150, 440, 0], [250, 440, 1]]);
  await touch('touchEnd', [[150, 440, 0]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(150);
  assert.equal(await hist(page), 0, 'the third finger did not draw');
  assert.ok(await page.evaluate(() => scrollY) >= 150, 'the two fingers scrolled');
  assert.deepEqual(errors, []);
  await page.close();
});

test('rawupdate で描き終えた点しかない pointermove では、pred（末尾と予測）を描き直さない（desynchronized の canvas の書き出しを 1 フレームに 1 回減らす）', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.base + '/');
  // count stroke() calls per layer (canvas.q = pred, canvas.l = live)
  await page.evaluate(() => {
    window.__strokes = { q: 0, l: 0 };
    const s = CanvasRenderingContext2D.prototype.stroke;
    CanvasRenderingContext2D.prototype.stroke = function (...a) { const c = this.canvas && this.canvas.className; if (c in window.__strokes) window.__strokes[c]++; return s.apply(this, a); };
  });
  await runCode(page, CODE);
  const st = () => page.evaluate(() => window.__paintBookmarklet.stats());
  assert.equal((await st()).rawupdate, true);
  await page.mouse.move(100, 200);
  await page.mouse.down();
  const N = 60;
  const e0 = (await st()).events;
  for (let i = 1; i <= N; i++) await page.mouse.move(100 + i * 10, 200 + (i % 2) * 40);
  const e1 = (await st()).events;
  const q = await page.evaluate(() => window.__strokes.q);
  await page.mouse.up();
  assert.ok(e1 - e0 >= N * 2 - 2, `rawupdate and pointermove both delivered (${e1 - e0})`);
  assert.ok(q <= N + 6, `pred redrawn once per new point, not per event: ${q} strokes for ${N} points`);
  assert.equal((await st()).history, 1);
  assert.deepEqual(errors, []);
  await page.close();
});

// 面のタイル全部の中身（位置つき、空のタイルは数えない）
const surfaceSum = page => page.evaluate(() => {
  const sr = document.querySelector('paint-bookmarklet-surface').shadowRoot;
  let h = 0, s = 0;
  const cs = [...sr.querySelectorAll('canvas')].filter(c => c.width && c.style.left).sort((a, b) => (parseFloat(a.style.top) - parseFloat(b.style.top)) || (parseFloat(a.style.left) - parseFloat(b.style.left)));
  for (const c of cs) {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let ts = 0, th = 0;
    for (let i = 3; i < d.length; i += 4) { ts += d[i]; th = (th * 31 + d[i] + d[i - 1]) | 0; }
    if (ts) { s += ts; h = (h * 131 + th + (parseFloat(c.style.left) | 0) * 7 + (parseFloat(c.style.top) | 0)) | 0; }
  }
  return `${s}:${h}`;
});

test('全消去はタイルを 1 枚のアトラスに写さない（タイルが多くても canvas の上限を超えず、元に戻すと画素単位で戻る）', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.base + '/long');
  await page.evaluate(() => {
    window.__maxOC = 0;
    const O = window.OffscreenCanvas;
    window.OffscreenCanvas = class extends O { constructor(w, h) { super(w, h); if (window.__track) window.__maxOC = Math.max(window.__maxOC, w * h); } };
  });
  await runCode(page, CODE);
  // a zig-zag stroke on every screen down the page (many surface tiles)
  for (let y = 0; y < 2300; y += 600) {
    await page.evaluate(y => scrollTo({ top: y, behavior: 'instant' }), y);
    await frames(page, 2);
    await page.mouse.move(40, 120);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(40 + (i % 2) * 900, 120 + i * 40, { steps: 2 });
    await page.mouse.up();
  }
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  const tiles = (await page.evaluate(() => window.__paintBookmarklet.stats())).tiles;
  assert.ok(tiles >= 20, 'many tiles: ' + tiles);
  const before = await surfaceSum(page);
  await page.evaluate(() => { window.__track = true; });
  await page.keyboard.press('Delete');
  await page.evaluate(() => { window.__track = false; });
  const maxOC = await page.evaluate(() => window.__maxOC);
  assert.ok(maxOC < 256 * 256, `clear-all allocated a ${maxOC} px canvas (an atlas of all ${tiles} tiles is ${tiles * 256 * 256})`);
  assert.equal((await surfaceSum(page)).split(':')[0], '0', 'the surface is blank');
  await page.keyboard.press('Control+z');
  assert.equal(await surfaceSum(page), before, 'undo restores every tile exactly');
  await page.keyboard.press('Control+y');
  assert.equal((await surfaceSum(page)).split(':')[0], '0');
  await page.keyboard.press('Control+z');
  assert.equal(await surfaceSum(page), before);
  // drawing after the clear and undoing everything still round-trips
  await page.keyboard.press('Control+y');
  await page.mouse.move(100, 300); await page.mouse.down(); await page.mouse.move(400, 320, { steps: 5 }); await page.mouse.up();
  const after = await surfaceSum(page);
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  assert.equal(await surfaceSum(page), before);
  await page.keyboard.press('Control+y'); await page.keyboard.press('Control+y');
  assert.equal(await surfaceSum(page), after);
  assert.deepEqual(errors, []);
  await page.close();
});

test('全消去の後に画面に固定を入れてスクロールし、切ってから全消去を元に戻すと、絵は見えていた位置に戻る', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.base + '/long');
  await runCode(page, CODE);
  await page.mouse.move(100, 300); await page.mouse.down(); await page.mouse.move(500, 300, { steps: 8 }); await page.mouse.up();
  assert.ok((await readMain(page, 300, 300))[3] > 200);
  await page.keyboard.press('Delete');
  const fix = () => shadowEval(page, root => root.querySelector('[title^="画面に固定"]').click());
  await fix();
  await page.evaluate(() => scrollTo({ top: 100, behavior: 'instant' }));
  await frames(page, 2);
  await fix(); // off: the surface is re-attached where it is visible now (shifted by the scroll)
  await page.keyboard.press('Control+z');
  await frames(page, 2);
  assert.ok((await readMain(page, 300, 300))[3] > 200, 'the restored line is where it was on screen');
  assert.equal((await readMain(page, 300, 200))[3], 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test('LINE の中で、ページが scroll-behavior: smooth でも、ツールを出すとすぐ 1px 下がり、描いた線は描いた所に付く（offTop は instant で動かす）', async () => {
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.19.0';
  const { page, errors } = await mobile('/long', { userAgent: UA });
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'smooth'; });
  await runCode(page, CODE);
  assert.equal(await page.evaluate(() => scrollY), 1, 'moved 1px off the top at once');
  // the page script scrolls back to the very top; the next stroke moves it 1px first, then maps the stroke
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  await touch('touchStart', [[100, 400]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[100 + i * 20, 400]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(600); // let any smooth scroll finish
  // the line's vertical centre (alpha-weighted) in the column x = 180 must still be at y = 400 on screen
  const d = await readMain(page, 180, 390, 1, 20);
  let s = 0, w = 0;
  for (let i = 0; i < 20; i++) { s += d[i * 4 + 3] * (390 + i + 0.5); w += d[i * 4 + 3]; }
  assert.ok(Math.abs(s / w - 400) < 0.5, 'line centre ' + (s / w).toFixed(2));
  assert.deepEqual(errors, []);
  await page.close();
});

// Audit (2026-10-18, T-117): found while looking into "全消去 right after drawing does nothing" (T-118). Fails on v1.36.0.
test('線の終わり（pointerup・pointercancel）が届かずに描いている途中のまま止まっても、次にどこかを押せば確定して、全消去・次の線・元に戻すが効く（T-118）', async () => {
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const { page, errors } = await mobile('/long', { userAgent: UA, deviceScaleFactor: 3 });
  await runCode(page, CODE);
  await page.waitForTimeout(200);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  const tap = async ([x, y]) => { await touch('touchStart', [[x, y]]); await touch('touchEnd', []); await page.waitForTimeout(30); };
  const center = sel => shadowEval(page, (root, s) => { const r = root.querySelector(s).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel);
  const stats = () => page.evaluate(() => window.__paintBookmarklet.stats());
  const surfInk = () => page.evaluate(() => { const d = window.__paintBookmarklet.pixels(0, 0, 390, 700).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  // a touch stroke whose end never reaches the page (iOS: an app or system swipe took the finger)
  const o = { pointerId: 11, pointerType: 'touch', isPrimary: true, pressure: 0.5 };
  await fire(page, 'pointerdown', { ...o, clientX: 80, clientY: 300, button: 0, buttons: 1 });
  for (let i = 1; i <= 12; i++) await fire(page, 'pointermove', { ...o, clientX: 80 + i * 18, clientY: 300 + i * 10, button: -1, buttons: 1 });
  await frames(page, 3);
  assert.equal((await stats()).drawing, true, 'stuck mid-stroke');
  assert.equal(await hist(page), 0);
  // その他 → 全消去: the tap on the toolbar commits the stuck line first, so the clear works on the first press
  await tap(await center('.bar > [aria-label^="その他"]'));
  await tap(await center('.pn.on [aria-label^="全消去"]'));
  await frames(page, 3);
  let s = await stats();
  assert.equal(s.drawing, false);
  assert.equal(s.history, 2, 'the stuck line was committed, then cleared');
  assert.equal(await surfInk(), 0, 'nothing is left');
  // undo brings the line back, and the next stroke draws
  await page.evaluate(() => window.__paintBookmarklet.undo());
  assert.ok(await surfInk() > 0, 'undo restores the line');
  await touch('touchStart', [[80, 520]]);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', [[80 + i * 20, 520]]); await page.waitForTimeout(8); }
  await touch('touchEnd', []);
  await frames(page, 3);
  s = await stats();
  assert.equal(s.drawing, false);
  assert.equal(s.history, 2, 'the new line is a step (the undone clear is dropped)');
  // a second finger while drawing is not a new primary pointer: the stroke goes on (two-finger scroll rules apply)
  await fire(page, 'pointerdown', { ...o, pointerId: 21, clientX: 100, clientY: 200, button: 0, buttons: 1 });
  await fire(page, 'pointerdown', { ...o, pointerId: 22, isPrimary: false, clientX: 300, clientY: 200, button: 0, buttons: 1 });
  assert.equal(await hist(page), 2, 'a second finger right away does not commit the first one');
  await fire(page, 'pointerup', { ...o, pointerId: 22, isPrimary: false, clientX: 300, clientY: 200, button: 0, buttons: 0 });
  await fire(page, 'pointerup', { ...o, pointerId: 21, clientX: 100, clientY: 200, button: 0, buttons: 0 });
  assert.deepEqual(errors, []);
  await page.close();
});

test('線を確定するたびに（受け渡しで描いている途中の線を隠す・戻す）、ページ全体を描き直さない（T-119）', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.base + '/');
  await runCode(page, CODE);
  await page.waitForTimeout(2300); // the start-up notice fades out first
  const stroke = async (ox, oy) => {
    await page.mouse.move(ox, oy); await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(ox + i * 6, oy + i * 4);
    await page.mouse.up();
    await frames(page, 4);
  };
  // the first strokes make the tiles and enable the undo button (those do paint)
  for (let s = 0; s < 3; s++) await stroke(200 + s * 120, 300);
  await page.waitForTimeout(200);
  const cdp = await browser.newBrowserCDPSession();
  const evs = [];
  cdp.on('Tracing.dataCollected', d => evs.push(...d.value));
  const done = new Promise(r => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline'] } });
  for (let s = 0; s < 6; s++) await stroke(200 + (s % 3) * 120, 300);
  await page.waitForTimeout(200);
  await cdp.send('Tracing.end');
  await done;
  const paints = evs.filter(e => e.name === 'Paint' && e.ph === 'X').length;
  assert.equal(await hist(page), 9);
  assert.ok(paints <= 1, `Paint events: ${paints} (v1.36.1: 4 per stroke)`);
  assert.deepEqual(errors, []);
  await page.close();
});

test('開発用の「ガラスの地」: 重ねる（今）・バー自身・スクロール中は二重を切り替えられ、スクロール中は二重なら 2 本指のスクロールの間だけバーにも地を敷く（T-130）', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.base + '/long');
  await runCode(page, withDefaults(CODE, { dev: true }));
  const look = () => shadowEval(page, root => {
    const w = root.querySelector('.w'), b = root.querySelector('.bar');
    return { cls: ['gself', 'gscr', 'scr'].filter(c => w.classList.contains(c)), bg: getComputedStyle(b).backgroundColor, after: getComputedStyle(b, '::after').content };
  });
  const pick = t => shadowEval(page, (root, t) => root.querySelector(`[aria-label="ガラスの地: ${t}"]`).click(), t);
  let s = await look();
  assert.deepEqual(s.cls, []);
  assert.equal(s.bg, 'rgba(0, 0, 0, 0)', 'the tint is on ::after');
  await pick('バー自身');
  s = await look();
  assert.deepEqual(s.cls, ['gself']);
  assert.notEqual(s.bg, 'rgba(0, 0, 0, 0)', 'the tint is on the bar itself');
  assert.equal(s.after, 'none');
  await pick('スクロール中は二重');
  s = await look();
  assert.deepEqual(s.cls, ['gscr']);
  assert.equal(s.bg, 'rgba(0, 0, 0, 0)', 'at rest it looks as before');
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  await touch('touchStart', [[150, 600]]);
  await touch('touchStart', [[150, 600], [250, 600]]);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [[150, 600 - i * 10], [250, 600 - i * 10]]);
  s = await look();
  assert.deepEqual(s.cls, ['gscr', 'scr'], 'while scrolling');
  assert.notEqual(s.bg, 'rgba(0, 0, 0, 0)');
  await page.waitForTimeout(200); // stop before lifting: no fling
  await touch('touchEnd', [[150, 550]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(50);
  s = await look();
  assert.deepEqual(s.cls, ['gscr'], 'after the scroll');
  await pick('重ねる');
  assert.deepEqual((await look()).cls, []);
  assert.deepEqual(errors, []);
  await page.close();
});

test('ページの高さだけが変わる（LINE などで、スクロールするとブラウザのバーが縮む）ときは、ツールバーを組み直さない。幅が変われば組み直す（T-134）', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.base + '/long');
  await runCode(page, CODE);
  await page.waitForTimeout(200);
  const two = () => shadowEval(page, root => root.querySelector('.bar').classList.contains('two'));
  assert.equal(await two(), true, 'two rows on a phone-width screen');
  await shadowEval(page, root => {
    const bar = root.querySelector('.bar');
    window.__mut = [];
    new MutationObserver(l => { for (const m of l) window.__mut.push(m.attributeName === 'class' ? 'class' : 'style:' + (bar.style.width || '')); }).observe(bar, { attributes: true, attributeFilter: ['class', 'style'] });
  });
  for (const h of [740, 760, 700, 720]) { await page.setViewportSize({ width: 390, height: h }); await page.waitForTimeout(100); }
  assert.deepEqual(await page.evaluate(() => window.__mut), [], 'height-only changes leave the toolbar alone (v1.38.1: the class and width were removed and set again each time)');
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.waitForTimeout(100);
  assert.equal(await two(), false, 'wider: one row again');
  await page.setViewportSize({ width: 390, height: 720 });
  await page.waitForTimeout(100);
  assert.equal(await two(), true, 'narrow again: two rows');
  assert.deepEqual(errors, []);
  await page.close();
});

// Review (2026-10-28, PR #1 /code-review ultra): the iPhone-only default of the prediction method leaked into the bookmark. Fails on v1.38.6.
test('iPhone で「この見た目をデフォルトに」を押しても、予測の方法は選んだときだけ持っていく（iPhone だけの既定〈ブラウザ〉を PC に広げない。T-140）', async () => {
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const page = await browser.newPage({ viewport: { width: 390, height: 700 }, userAgent: UA, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.base + '/');
  await runCode(page, withDefaults(CODE, { dev: true }));
  await page.evaluate(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; });
  const click = sel => shadowEval(page, (root, s) => root.querySelector(s).click(), sel);
  const exported = async () => {
    await click('.bar > [aria-label^="その他"]');
    await click('[aria-label^="見た目（開発用）"]');
    await click('[aria-label^="この見た目をデフォルトに"]');
    const url = (await page.evaluate(() => window.__opened.pop()))[0];
    return JSON.parse(decodeURIComponent(url.slice(url.indexOf('#defaults=') + 10)));
  };
  assert.equal((await page.evaluate(() => window.__paintBookmarklet.stats().prefs)).ppred, 'chrome', 'iPhone defaults to the browser prediction');
  assert.equal('ppred' in await exported(), false, 'not chosen: not written');
  await click('.bar > [aria-label^="その他"]');
  await click('[aria-label^="見た目（開発用）"]');
  await click('[aria-label="予測の方法: 曲がりに沿う"]');
  assert.equal((await exported()).ppred, 'own', 'chosen: written');
  assert.deepEqual(errors, []);
  await page.close();
});

// Review (2026-10-28, PR #1 /code-review ultra): hasInk read the display tiles directly, so a second Delete read the same tile again. Fails on v1.38.7.
test('全部消した後に全消去を何度押しても、表示のタイルを直接読み戻さず（コンソールに読み出しの警告が出ない）、履歴も増えない（T-141）', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [], warns = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'warning') warns.push(m.text()); });
  await page.goto(server.base + '/');
  await runCode(page, CODE);
  const drag = async (pts, steps) => {
    await page.mouse.move(...pts[0]); await page.mouse.down();
    for (const p of pts.slice(1)) await page.mouse.move(...p, { steps });
    await page.mouse.up();
  };
  // 2 つのタイルにまたがる線を描いて、消しゴム（32px）で全部なぞる
  await drag([[100, 300], [520, 300]], 10);
  await page.keyboard.press('e');
  await drag([[90, 300], [530, 300]], 20);
  await frames(page);
  assert.equal(await hist(page), 2);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Delete'); await frames(page, 2); }
  assert.equal(await hist(page), 2, 'nothing to clear');
  // 少しでも残っていれば全消去する
  await page.keyboard.press('p');
  await drag([[100, 400], [300, 400]], 5);
  await page.keyboard.press('e');
  await drag([[90, 400], [150, 400]], 5);
  await page.keyboard.press('Delete');
  assert.equal(await hist(page), 5, 'partly erased: cleared');
  assert.deepEqual(warns.filter(w => /readback/i.test(w)), []);
  assert.deepEqual(errors, []);
  await page.close();
});
