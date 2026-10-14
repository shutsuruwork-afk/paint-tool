import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE, startServer, launch, openPage, runBookmarklet, shadowEval, readMain, alphaStats, drag, click, toolOn,
  screenPixel, scrollTo,
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

test('確定の瞬間にちらつかない（live は隠してから 2 フレーム後に消す）、半透明の濃さは押す前に合わせてある', async () => {
  const { page } = await fresh('/');
  await page.keyboard.press('h'); // 蛍光ペン（35%）
  const r = await shadowEval(page, async root => {
    const grp = root.querySelector('.g'), live = root.querySelector('canvas.l'), pad = root.querySelector('.p');
    const before = grp.style.opacity;
    const ev = (type, x) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 5, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: 300, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1 });
    pad.dispatchEvent(ev('pointerdown', 100));
    for (let x = 110; x <= 400; x += 10) pad.dispatchEvent(ev('pointermove', x));
    pad.dispatchEvent(ev('pointerup', 400));
    const alpha = () => live.getContext('2d').getImageData(250, 300, 1, 1).data[3];
    const atUp = { opacity: grp.style.opacity, live: alpha(), surface: window.__paintBookmarklet.pixels(250, 300, 1, 1).data[3] };
    for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
    return { before, atUp, after: { opacity: grp.style.opacity, live: alpha() } };
  });
  assert.equal(r.before, '0.35', 'opacity set when the tool was chosen');
  assert.equal(r.atUp.opacity, '0', 'live hidden at commit');
  assert.ok(r.atUp.live > 200 && r.atUp.surface > 80, 'stroke on both layers at the moment of commit');
  assert.equal(r.after.live, 0, 'live cleared after frames');
  assert.equal(r.after.opacity, '0.35', 'opacity restored');
  await page.close();
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
