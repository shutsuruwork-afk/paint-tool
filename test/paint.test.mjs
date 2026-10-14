import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE, startServer, launch, openPage, runBookmarklet, shadowEval, readMain, alphaStats, drag, click, toolOn,
} from './helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser.close(); server.srv.close(); });

const fresh = async (path = '/', viewport) => {
  const o = await openPage(browser, server.base + path, viewport);
  if (path === '/') await runBookmarklet(o.page);
  return o;
};
const checksum = page => shadowEval(page, root => {
  const c = root.querySelector('canvas.m');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
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

test('javascript: URL で起動し、再実行で非表示/再表示、閉じるで完全に破棄される', async () => {
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
  assert.equal(await st(), 'removed');
  assert.equal(await page.evaluate(() => window.__paintBookmarklet), undefined);
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
  const bg = await shadowEval(page, root => getComputedStyle(root.querySelector('.bar')).backgroundColor);
  assert.equal(bg, 'rgb(32, 34, 40)', 'shadow styles applied (adoptedStyleSheets)');
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
  const size = await shadowEval(page, root => { const c = root.querySelector('canvas.m'); return [c.width, c.height]; });
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
