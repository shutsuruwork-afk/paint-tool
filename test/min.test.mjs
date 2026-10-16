// 最小構成のコード（src/paint-min.js、チェックポイント 2 の画面にある機能だけ。T-080）のテスト
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startServer, launch, openPage, shadowEval, readMain, screenPixel, scrollTo, drag, runCode } from './helpers.mjs';

const MIN = readFileSync(new URL('../dist/paint-min.min.js', import.meta.url), 'utf8');
const MIN_BM = readFileSync(new URL('../dist/bookmarklet-min.txt', import.meta.url), 'utf8').trim();

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser.close(); server.srv.close(); });

// 実際のブックマークレットと同じく javascript: URL へのナビゲーションで起動する
const fresh = async (path = '/', viewport) => {
  const o = await openPage(browser, server.base + path, viewport);
  await o.page.evaluate(u => { location.href = u; }, MIN_BM);
  await o.page.waitForFunction(() => !!window.__paintBookmarklet);
  return o;
};
const rectOf = (page, sel) => shadowEval(page, (root, s) => {
  const r = root.querySelector(s).getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}, sel);
const mouseClick = async (page, sel) => {
  const r = await rectOf(page, sel);
  assert.ok(r.w > 0 && r.h > 0, `${sel} が表示されていない`);
  await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
};
const bar = page => shadowEval(page, root => [...root.querySelector('.bar').children].filter(e => e.classList.contains('b'))
  .map(b => b.title.split(/[ （(]/)[0] + (b.classList.contains('on') ? '*' : '')));
const stats = page => page.evaluate(() => window.__paintBookmarklet.stats());
const checksum = page => page.evaluate(() => {
  const de = document.documentElement;
  const d = window.__paintBookmarklet.pixels(0, 0, de.clientWidth, de.clientHeight).data;
  let h = 0;
  for (let i = 0; i < d.length; i++) h = (h * 31 + d[i]) | 0;
  return h;
});

test('最小構成: 本体より小さく、画面はチェックポイント 2 と同じ（ペン・文字・元に戻す・その他・閉じる）。キーのショートカットはない', async () => {
  const main = readFileSync(new URL('../dist/paint.min.js', import.meta.url), 'utf8');
  assert.ok(MIN.length < main.length / 2, `min ${MIN.length} vs main ${main.length}`);
  const { page, errors } = await fresh();
  assert.match(await page.evaluate(() => window.__paintBookmarklet.version), /-min$/);
  assert.deepEqual(await bar(page), ['ペン*', '文字', '元に戻す', 'その他', '閉じる']);
  // キーは何もしない（ページへもそのまま届く）
  await page.evaluate(() => { window.__keys = 0; window.addEventListener('keydown', () => window.__keys++); });
  for (const k of ['e', 't', 'Delete', 'Escape', 'Control+z']) await page.keyboard.press(k);
  assert.equal((await stats(page)).tool, 'pen');
  assert.equal(await page.evaluate(() => window.__keys), 6); // Control+z は Control と z の 2 回
  assert.deepEqual(errors, []);
  await page.close();
});

test('最小構成: ペンで描いて元に戻すと画素単位で戻る。ペンのボタンで消しゴムと入れ替わり、消しゴムも元に戻せる', async () => {
  const { page, errors } = await fresh();
  const empty = await checksum(page);
  await drag(page, [[100, 300], [300, 320], [500, 300]], 10);
  assert.ok((await readMain(page, 300, 318))[3] > 200, 'drawn');
  const drawn = await checksum(page);
  assert.equal((await stats(page)).history, 1);
  // ペンのボタンを押すと消しゴム（印と名前も変わる）、もう一度でペン
  await mouseClick(page, '.bar > [aria-label^="ペン"]');
  assert.deepEqual(await bar(page), ['消しゴム*', '文字', '元に戻す', 'その他', '閉じる']);
  assert.equal(await shadowEval(page, root => root.querySelector('.bar > .b path').getAttribute('d').slice(0, 8)), 'M8 20h12');
  await drag(page, [[300, 250], [300, 380]], 10);
  assert.equal((await readMain(page, 300, 318))[3], 0, 'erased');
  await mouseClick(page, '.bar > [aria-label^="元に戻す"]');
  assert.equal(await checksum(page), drawn, 'undo the eraser');
  await mouseClick(page, '.bar > [aria-label^="元に戻す"]');
  assert.equal(await checksum(page), empty, 'undo the stroke');
  assert.equal(await shadowEval(page, root => root.querySelector('[aria-label^="元に戻す"]').disabled), true);
  await mouseClick(page, '.bar > [aria-label^="消しゴム"]');
  assert.deepEqual(await bar(page), ['ペン*', '文字', '元に戻す', 'その他', '閉じる']);
  assert.deepEqual(errors, []);
  await page.close();
});

test('最小構成: 文字は電卓が入り（Tab で答えを書き込む）。文字の道具で押すと書き直せ、消しゴムで消え、元に戻せる', async () => {
  const { page, errors } = await fresh();
  await mouseClick(page, '.bar > [aria-label^="文字"]');
  assert.deepEqual(await bar(page), ['ペン', '文字*', '元に戻す', 'その他', '閉じる']);
  await page.mouse.click(300, 300);
  await page.keyboard.type('12+30');
  assert.equal(await shadowEval(page, root => root.querySelector('.gh').textContent), '=42');
  await page.keyboard.press('Tab');
  assert.equal(await shadowEval(page, root => root.querySelector('textarea').value), '12+30=42');
  // 外を押すと確定（線は描かない）
  await page.mouse.click(600, 500);
  let s = await stats(page);
  assert.equal(s.texts, 1);
  assert.equal(s.history, 1);
  const text = () => shadowEval(page, () => [...document.querySelector('paint-bookmarklet-surface').shadowRoot.querySelectorAll('.to')].map(e => e.textContent));
  assert.deepEqual(await text(), ['12+30=42']);
  // 文字の上を押すと書き直し
  await page.mouse.click(310, 300);
  assert.equal(await shadowEval(page, root => root.querySelector('textarea').value), '12+30=42');
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  assert.deepEqual(await text(), ['12+30=42!']);
  // ペン → 消しゴムでなぞると消える。元に戻すで戻る
  await mouseClick(page, '.bar > [aria-label^="ペン"]');
  await mouseClick(page, '.bar > [aria-label^="ペン"]');
  await drag(page, [[280, 300], [400, 300]], 10);
  assert.deepEqual(await text(), []);
  await mouseClick(page, '.bar > [aria-label^="元に戻す"]');
  assert.deepEqual(await text(), ['12+30=42!']);
  await mouseClick(page, '.bar > [aria-label^="元に戻す"]');
  assert.deepEqual(await text(), ['12+30=42']);
  assert.deepEqual(errors, []);
  await page.close();
});

test('最小構成: その他は全消去と 8 色。色を選ぶと閉じ、消しゴムならペンに戻る。全消去は元に戻せ、消す物がなければ何もしない', async () => {
  const { page, errors } = await fresh();
  await drag(page, [[100, 300], [500, 300]], 10);
  await mouseClick(page, '.bar > [aria-label^="ペン"]'); // 消しゴム
  await mouseClick(page, '.bar > [aria-label^="その他"]');
  const menu = () => shadowEval(page, root => {
    const p = root.querySelector('.pn');
    return { open: p.classList.contains('on'), items: [...p.children].map(e => e.classList.contains('mi') ? e.textContent : e.querySelectorAll('.c').length + ' 色'),
      on: [...p.querySelectorAll('.c.on')].map(b => b.title) };
  });
  assert.deepEqual(await menu(), { open: true, items: ['全消去', '8 色'], on: ['色 3'] });
  await mouseClick(page, '.pn.on [title="色 7"]');
  const s = await stats(page);
  assert.equal(s.color, '#1e88e5');
  assert.equal(s.tool, 'pen');
  assert.equal((await menu()).open, false);
  await drag(page, [[100, 400], [500, 400]], 10);
  assert.deepEqual((await readMain(page, 300, 400)).slice(0, 3), [0x1e, 0x88, 0xe5]);
  // 全消去
  await mouseClick(page, '.bar > [aria-label^="その他"]');
  await mouseClick(page, '.pn.on [title="全消去"]');
  assert.equal((await readMain(page, 300, 300))[3], 0);
  assert.equal((await stats(page)).history, 3);
  // もう一度押しても増えない
  await mouseClick(page, '.bar > [aria-label^="その他"]');
  await mouseClick(page, '.pn.on [title="全消去"]');
  assert.equal((await stats(page)).history, 3);
  await mouseClick(page, '.bar > [aria-label^="元に戻す"]');
  assert.ok((await readMain(page, 300, 300))[3] > 200, 'back after undo');
  assert.deepEqual(errors, []);
  await page.close();
});

test('最小構成: 閉じる（×）の見た目のボタンは隠すだけ: 絵は残り、お知らせは出ず、ブックマークレットでそのまま戻る（T-081）', async () => {
  const { page, errors } = await fresh();
  await drag(page, [[100, 300], [500, 300]], 10);
  assert.equal(await shadowEval(page, root => root.querySelector('.bar > [aria-label^="閉じる"] path').getAttribute('d')), 'M6 6l12 12M18 6L6 18');
  await mouseClick(page, '.bar > [aria-label^="閉じる"]');
  const disp = sel => page.evaluate(s => getComputedStyle(document.querySelector(s)).display, sel);
  assert.equal(await disp('paint-bookmarklet'), 'none');
  assert.equal(await disp('paint-bookmarklet-surface'), 'none');
  assert.equal(await shadowEval(page, root => !!root.querySelector('.t')), false, 'no toast at all');
  assert.ok(await page.evaluate(() => !!window.__paintBookmarklet), 'still alive');
  // ページを押せる
  assert.equal(await page.evaluate(() => document.elementFromPoint(300, 300).tagName === 'PAINT-BOOKMARKLET'), false);
  await page.evaluate(u => { location.href = u; }, MIN_BM);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('paint-bookmarklet')).display === 'block');
  assert.ok((await readMain(page, 300, 300))[3] > 200, 'drawing is back');
  assert.equal((await stats(page)).history, 1, 'history kept');
  // API の destroy で片付く
  await page.evaluate(() => window.__paintBookmarklet.destroy());
  assert.equal(await page.evaluate(() => !!window.__paintBookmarklet || !!document.querySelector('paint-bookmarklet, paint-bookmarklet-surface')), false);
  assert.deepEqual(errors, []);
  await page.close();
});

test('最小構成: 絵はページと一緒にスクロールし、scroll / wheel のリスナーはない。スマホは 2 本指でスクロールする', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.addInitScript(() => {
    window.__types = [];
    const orig = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, ...rest) { window.__types.push(type); return orig.call(this, type, ...rest); };
  });
  await page.goto(server.base + '/long');
  await page.evaluate(u => { location.href = u; }, MIN_BM);
  await page.waitForFunction(() => !!window.__paintBookmarklet);
  await drag(page, [[100, 300], [400, 300]], 10);
  await scrollTo(page, 200);
  assert.ok((await screenPixel(page, 250, 100))[3] > 200, 'moved with the page');
  assert.equal((await screenPixel(page, 250, 300))[3], 0);
  await drag(page, [[100, 300], [400, 300]], 10); // 文書の y=500
  await scrollTo(page, 0);
  assert.ok((await screenPixel(page, 250, 500))[3] > 200, 'drawn after scrolling sits on the page');
  const types = await page.evaluate(() => window.__types);
  assert.deepEqual(types.filter(t => t === 'scroll' || t === 'wheel'), []);
  await page.close();
  // 2 本指
  const ph = await browser.newPage({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true });
  await ph.goto(server.base + '/long');
  await runCode(ph, MIN);
  const cdp = await ph.context().newCDPSession(ph);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  await touch('touchStart', [[150, 500]]);
  await touch('touchMove', [[160, 490]]);
  await touch('touchStart', [[160, 490], [250, 500]]);
  for (let i = 1; i <= 10; i++) await touch('touchMove', [[160, 490 - i * 20], [250, 500 - i * 20]]);
  await touch('touchEnd', [[160, 290]]);
  await touch('touchEnd', []);
  await ph.waitForTimeout(100);
  assert.equal(await ph.evaluate(() => scrollY), 200);
  assert.equal((await ph.evaluate(() => window.__paintBookmarklet.stats())).history, 0);
  await touch('touchStart', [[100, 400]]);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [[100 + i * 20, 400 + i * 10]]);
  await touch('touchEnd', []);
  await ph.waitForTimeout(100);
  assert.equal((await ph.evaluate(() => window.__paintBookmarklet.stats())).history, 1);
  await ph.close();
});

test('最小構成: 厳格な CSP + Trusted Types のページでも動く', async () => {
  const { page, errors } = await openPage(browser, server.base + '/strict');
  await page.evaluate(() => {
    window.__v = [];
    document.addEventListener('securitypolicyviolation', e => window.__v.push(e.effectiveDirective));
  });
  await page.evaluate(MIN);
  await page.waitForFunction(() => !!window.__paintBookmarklet);
  const bf = await shadowEval(page, root => getComputedStyle(root.querySelector('.bar'), '::before').backdropFilter);
  assert.equal(bf, 'blur(18px) saturate(2)', 'shadow styles applied (adoptedStyleSheets)');
  await drag(page, [[100, 300], [500, 300]], 10);
  assert.ok((await readMain(page, 300, 300))[3] > 200);
  const v = (await page.evaluate(() => window.__v)).filter(d => d !== 'img-src');
  assert.deepEqual(v, []);
  assert.deepEqual(errors, []);
  await page.close();
});

test('インストールページ: チェックポイントで「2（最小構成のコード）」を選ぶと、ボタンが最小構成のブックマークレットになり、試すとそれで起動する', async () => {
  const { page, errors } = await openPage(browser, server.base + '/install');
  await page.check('#p-cp input[value="min"]');
  assert.equal((await page.textContent('#bm')).trim(), 'Paint CP2 最小');
  assert.equal(await page.getAttribute('#bm', 'href'), MIN_BM);
  await page.click('#try');
  assert.match(await page.evaluate(() => window.__paintBookmarklet.version), /-min$/);
  // 2 に戻して試すと、本体で起動し直す
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__paintBookmarklet.hide());
  await page.check('#p-cp input[value="2"]');
  await page.click('#try');
  assert.doesNotMatch(await page.evaluate(() => window.__paintBookmarklet.version), /-min$/);
  assert.deepEqual(errors, []);
  await page.close();
});
