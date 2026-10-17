// Audit (2026-10-17): regressions found in the gesture code (T-104〜T-110). Each test failed on v1.32.1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CODE, startServer, launch, runCode, readMain, shadowEval } from './helpers.mjs';

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
