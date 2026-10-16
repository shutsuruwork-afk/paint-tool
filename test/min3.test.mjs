// チェックポイント 3 の最小構成のコード（src/paint-min3.js。画面にある機能だけ。T-083）のテスト
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startServer, launch, openPage, shadowEval, readMain, screenPixel, scrollTo, drag, runCode } from './helpers.mjs';

const MIN3 = readFileSync(new URL('../dist/paint-min3.min.js', import.meta.url), 'utf8');
const MIN3_BM = readFileSync(new URL('../dist/bookmarklet-min3.txt', import.meta.url), 'utf8').trim();

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser.close(); server.srv.close(); });

// 実際のブックマークレットと同じく javascript: URL へのナビゲーションで起動する
const fresh = async (path = '/', viewport) => {
  const o = await openPage(browser, server.base + path, viewport);
  await o.page.evaluate(u => { location.href = u; }, MIN3_BM);
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
const press = (page, name) => mouseClick(page, `.bar > [aria-label^="${name}"]`);
// バーのボタンの名前。選んでいる物は *、薄い（押せない）物は -
const bar = page => shadowEval(page, root => [...root.querySelector('.bar').children].filter(e => e.classList.contains('b'))
  .map(b => b.title.split(/[ （(]/)[0] + (b.classList.contains('on') ? '*' : '') + (b.disabled ? '-' : '')));
const stats = page => page.evaluate(() => window.__paintBookmarklet.stats());
const texts = page => page.evaluate(() => [...document.querySelector('paint-bookmarklet-surface').shadowRoot.querySelectorAll('.to')].map(e => e.textContent));
const checksum = page => page.evaluate(() => {
  const de = document.documentElement;
  const d = window.__paintBookmarklet.pixels(0, 0, de.clientWidth, de.clientHeight).data;
  let h = 0;
  for (let i = 0; i < d.length; i++) h = (h * 31 + d[i]) | 0;
  return h;
});

test('最小構成 3: 本体より小さく、画面はチェックポイント 3 と同じ（ペン・文字・色・元に戻す・全消去・閉じる）。開く物もキーのショートカットもない', async () => {
  const main = readFileSync(new URL('../dist/paint.min.js', import.meta.url), 'utf8');
  assert.ok(MIN3.length < main.length / 2, `min3 ${MIN3.length} vs main ${main.length}`);
  const { page, errors } = await fresh();
  assert.match(await page.evaluate(() => window.__paintBookmarklet.version), /-min3$/);
  assert.deepEqual(await bar(page), ['ペン*', '文字', '色', '元に戻す-', '全消去-', '閉じる']);
  // メニュー・パネル・区切り線・お知らせの要素がない
  assert.equal(await shadowEval(page, root => root.querySelectorAll('.pn, .sep, .t, [aria-label^="その他"]').length), 0);
  // キーは何もしない（ページへもそのまま届く）
  await page.evaluate(() => { window.__keys = 0; window.addEventListener('keydown', () => window.__keys++); });
  for (const k of ['e', 't', 'Delete', 'Escape', 'Control+z']) await page.keyboard.press(k);
  assert.equal((await stats(page)).tool, 'pen');
  assert.equal(await page.evaluate(() => window.__keys), 6); // Control+z は Control と z の 2 回
  assert.deepEqual(errors, []);
  await page.close();
});

test('最小構成 3: ペンで描いて元に戻すと画素単位で戻る。ペンのボタンで消しゴムと入れ替わり、消しゴムも元に戻せる', async () => {
  const { page, errors } = await fresh();
  const empty = await checksum(page);
  await drag(page, [[100, 300], [300, 320], [500, 300]], 10);
  assert.ok((await readMain(page, 300, 318))[3] > 200, 'drawn');
  const drawn = await checksum(page);
  assert.deepEqual(await bar(page), ['ペン*', '文字', '色', '元に戻す', '全消去', '閉じる']);
  // ペンのボタンを押すと消しゴム（印と名前も変わる）
  await press(page, 'ペン');
  assert.deepEqual((await bar(page)).slice(0, 2), ['消しゴム*', '文字']);
  assert.equal(await shadowEval(page, root => root.querySelector('.bar > .b path').getAttribute('d').slice(0, 8)), 'M8 20h12');
  await drag(page, [[300, 250], [300, 380]], 10);
  assert.equal((await readMain(page, 300, 318))[3], 0, 'erased');
  await press(page, '元に戻す');
  assert.equal(await checksum(page), drawn, 'undo the eraser');
  await press(page, '元に戻す');
  assert.equal(await checksum(page), empty, 'undo the stroke');
  // 最初まで戻すと元に戻すは薄い。全消去は描いた範囲が残っているので濃いまま（押しても何もしない。チェックポイント 3 の本体と同じ）
  assert.deepEqual(await bar(page), ['消しゴム*', '文字', '色', '元に戻す-', '全消去', '閉じる']);
  await press(page, '消しゴム');
  assert.deepEqual((await bar(page)).slice(0, 1), ['ペン*']);
  assert.deepEqual(errors, []);
  await page.close();
});

test('最小構成 3: 色は押すたびに赤→青→黒→白で、丸が今の色。消しゴムのときはペンに戻る', async () => {
  const { page, errors } = await fresh();
  const dot = () => shadowEval(page, root => root.querySelector('.bar > [aria-label^="色"] .dot').style.getPropertyValue('--c'));
  assert.equal(await dot(), '#e53935');
  assert.match(await shadowEval(page, root => root.querySelector('.bar > [aria-label^="色"]').title), /^色（赤）— 押すと青に/);
  const seen = [];
  for (let i = 0; i < 4; i++) { await press(page, '色'); seen.push((await stats(page)).color); }
  assert.deepEqual(seen, ['#1e88e5', '#111111', '#ffffff', '#e53935']);
  assert.equal(await dot(), '#e53935');
  // 消しゴムで色を押すと、次の色のペンになる
  await press(page, 'ペン');
  await press(page, '色');
  const s = await stats(page);
  assert.equal(s.tool, 'pen');
  assert.equal(s.color, '#1e88e5');
  assert.equal(await dot(), '#1e88e5');
  await drag(page, [[100, 400], [500, 400]], 10);
  assert.deepEqual((await readMain(page, 300, 400)).slice(0, 3), [0x1e, 0x88, 0xe5]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('最小構成 3: 文字は電卓が入り。文字のときにもう一度押すとペン、1 つ書いて確定してもペンに戻る。書き直し・消しゴム・元に戻すも効く', async () => {
  const { page, errors } = await fresh();
  await press(page, '文字');
  assert.deepEqual((await bar(page)).slice(0, 2), ['ペン', '文字*']);
  await press(page, '文字');
  assert.deepEqual((await bar(page)).slice(0, 2), ['ペン*', '文字']);
  await press(page, '文字');
  await page.mouse.click(300, 300);
  await page.keyboard.type('12+30');
  assert.equal(await shadowEval(page, root => root.querySelector('.gh').textContent), '=42');
  await page.keyboard.press('Tab');
  assert.equal(await shadowEval(page, root => root.querySelector('textarea').value), '12+30=42');
  // 書いている間に色を押すと、その文字の色が変わる（文字のまま）
  await press(page, '色');
  assert.equal((await stats(page)).tool, 'text');
  // 外を押すと確定だけ（線は描かない）。ペンに戻る
  await page.mouse.click(600, 500);
  let s = await stats(page);
  assert.equal(s.texts, 1);
  assert.equal(s.history, 1);
  assert.equal(s.tool, 'pen');
  assert.deepEqual(await texts(page), ['12+30=42']);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('paint-bookmarklet-surface').shadowRoot.querySelector('.to')).color), 'rgb(30, 136, 229)');
  // 次の押下はそのまま線になる
  await drag(page, [[100, 450], [400, 450]], 10);
  assert.equal((await stats(page)).history, 2);
  // 文字の道具で文字の上を押すと書き直し。確定するとペンに戻る
  await press(page, '文字');
  await page.mouse.click(310, 300);
  assert.equal(await shadowEval(page, root => root.querySelector('textarea').value), '12+30=42');
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  assert.deepEqual(await texts(page), ['12+30=42!']);
  assert.equal((await stats(page)).tool, 'pen');
  // 消しゴムでなぞると消える。元に戻すで戻る
  await press(page, 'ペン');
  await drag(page, [[280, 300], [400, 300]], 10);
  assert.deepEqual(await texts(page), []);
  await press(page, '元に戻す');
  assert.deepEqual(await texts(page), ['12+30=42!']);
  await press(page, '元に戻す');
  assert.deepEqual(await texts(page), ['12+30=42']);
  assert.deepEqual(errors, []);
  await page.close();
});

test('最小構成 3: 全消去はすぐ効き、元に戻せる。消す物がないときは薄い（文字だけでも消せる）', async () => {
  const { page, errors } = await fresh();
  const trash = async () => (await bar(page))[4];
  assert.equal(await trash(), '全消去-');
  await drag(page, [[100, 300], [500, 300]], 10);
  assert.equal(await trash(), '全消去');
  await press(page, '全消去');
  assert.equal((await readMain(page, 300, 300))[3], 0);
  assert.equal(await trash(), '全消去-');
  const h = (await stats(page)).history;
  await press(page, '全消去'); // 薄いので何も起きない
  assert.equal((await stats(page)).history, h);
  await press(page, '元に戻す');
  assert.ok((await readMain(page, 300, 300))[3] > 200, 'back after undo');
  assert.equal(await trash(), '全消去');
  // 文字だけのときも押せて、文字も消える
  await press(page, '全消去');
  await press(page, '文字');
  await page.mouse.click(300, 450);
  await page.keyboard.type('memo');
  await page.mouse.click(600, 550);
  assert.equal(await trash(), '全消去');
  await press(page, '全消去');
  assert.deepEqual(await texts(page), []);
  assert.equal(await trash(), '全消去-');
  assert.deepEqual(errors, []);
  await page.close();
});

test('最小構成 3: 閉じる（×）は隠すだけ: 絵は残り、お知らせは出ず、ブックマークレットでそのまま戻る', async () => {
  const { page, errors } = await fresh();
  await drag(page, [[100, 300], [500, 300]], 10);
  assert.equal(await shadowEval(page, root => root.querySelector('.bar > [aria-label^="閉じる"] path').getAttribute('d')), 'M6 6l12 12M18 6L6 18');
  await press(page, '閉じる');
  const disp = sel => page.evaluate(s => getComputedStyle(document.querySelector(s)).display, sel);
  assert.equal(await disp('paint-bookmarklet'), 'none');
  assert.equal(await disp('paint-bookmarklet-surface'), 'none');
  assert.ok(await page.evaluate(() => !!window.__paintBookmarklet), 'still alive');
  assert.equal(await page.evaluate(() => document.elementFromPoint(300, 300).tagName === 'PAINT-BOOKMARKLET'), false);
  await page.evaluate(u => { location.href = u; }, MIN3_BM);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('paint-bookmarklet')).display === 'block');
  assert.ok((await readMain(page, 300, 300))[3] > 200, 'drawing is back');
  assert.equal((await stats(page)).history, 1, 'history kept');
  await page.evaluate(() => window.__paintBookmarklet.destroy());
  assert.equal(await page.evaluate(() => !!window.__paintBookmarklet || !!document.querySelector('paint-bookmarklet, paint-bookmarklet-surface')), false);
  assert.deepEqual(errors, []);
  await page.close();
});

test('最小構成 3: 絵はページと一緒にスクロールし、scroll / wheel のリスナーはない。スマホは 2 本指でスクロールする', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.addInitScript(() => {
    window.__types = [];
    const orig = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, ...rest) { window.__types.push(type); return orig.call(this, type, ...rest); };
  });
  await page.goto(server.base + '/long');
  await page.evaluate(u => { location.href = u; }, MIN3_BM);
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
  await runCode(ph, MIN3);
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
  // スマホの幅でも 1 段
  const tops = await shadowEval(ph, root => [...new Set([...root.querySelectorAll('.bar > .b')].map(b => Math.round(b.getBoundingClientRect().top)))]);
  assert.equal(tops.length, 1);
  await ph.close();
});

test('最小構成 3: 厳格な CSP + Trusted Types のページでも動く', async () => {
  const { page, errors } = await openPage(browser, server.base + '/strict');
  await page.evaluate(() => {
    window.__v = [];
    document.addEventListener('securitypolicyviolation', e => window.__v.push(e.effectiveDirective));
  });
  await page.evaluate(MIN3);
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

test('インストールページ: 「3（最小構成のコード）」を選ぶとボタンがそのブックマークレットになり、試すとそれで起動する。ほかを選び直すと起動し直す', async () => {
  const { page, errors } = await openPage(browser, server.base + '/install');
  const version = () => page.evaluate(() => window.__paintBookmarklet.version);
  await page.check('#p-cp input[value="min3"]');
  assert.equal((await page.textContent('#bm')).trim(), 'Paint CP3 最小');
  assert.equal(await page.getAttribute('#bm', 'href'), MIN3_BM);
  await page.click('#try');
  assert.match(await version(), /-min3$/);
  // 2 の最小構成・3 の本体に切り替えて試すと、それぞれで起動し直す
  await page.evaluate(() => window.__paintBookmarklet.hide());
  await page.check('#p-cp input[value="min"]');
  await page.click('#try');
  assert.match(await version(), /-min$/);
  await page.evaluate(() => window.__paintBookmarklet.hide());
  await page.check('#p-cp input[value="3"]');
  await page.click('#try');
  assert.doesNotMatch(await version(), /-min3?$/);
  assert.equal(await page.evaluate(() => window.__paintBookmarklet.stats().prefs.cp), 3);
  assert.deepEqual(errors, []);
  await page.close();
});
