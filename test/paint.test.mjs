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

const rectOf = (page, sel) => shadowEval(page, (root, s) => {
  const r = root.querySelector(s).getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom };
}, sel);
const mouseClick = async (page, sel) => {
  const r = await rectOf(page, sel);
  assert.ok(r.w > 0 && r.h > 0, `${sel} が表示されていない`);
  await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
};

// その他のメニュー（全消去の項目の親）に並ぶ項目の名前
const menuItems = page => shadowEval(page, root => [...[...root.querySelectorAll('.mi')].find(b => b.title.startsWith('全消去')).parentElement.children].map(b => b.querySelector('span').textContent));
test('チェックポイント 1: ツールバーはペン（押すと消しゴムと入れ替わる）・元に戻す・その他・隠すだけで、スマホでも 1 段。お知らせは再表示と元に戻すだけ。ほかの道具はキーで使え、その他は全消去と閉じるだけ', async () => {
  const bar = page => shadowEval(page, root => {
    const bs = [...root.querySelector('.bar').children].filter(e => e.classList.contains('b'));
    return { titles: bs.map(b => b.title.split(/[ （(]/)[0]), tops: [...new Set(bs.map(b => Math.round(b.getBoundingClientRect().top)))], two: root.querySelector('.bar').classList.contains('two') };
  });
  const want = ['ペン', '元に戻す', 'その他', '隠す'];
  const { page, errors } = await openPage(browser, server.base + '/');
  await runCode(page, withDefaults(CODE, { cp: 1 }));
  const b = await bar(page);
  assert.deepEqual(b.titles, want);
  assert.equal(b.tops.length, 1);
  // お知らせは、押せるボタンの付いた物（再表示・元に戻す）だけ。起動・ページ操作では出さない（T-074）
  const toastOn = () => shadowEval(page, root => root.querySelector('.t').classList.contains('on'));
  assert.equal(await toastOn(), false, 'no toast on start');
  // ペンの太さの既定は 6（T-074）
  assert.equal((await page.evaluate(() => window.__paintBookmarklet.stats().prefs.size.pen)), 6);
  // ペンのボタン 1 つで、押すたびにペンと消しゴムが入れ替わり、印と名前も変わる（T-076。種類のパネルは出ない）。
  const st = page => shadowEval(page, root => {
    const b = root.querySelector('.bar > .b');
    return {
      tool: b.title.split(/[ （(]/)[0], on: b.classList.contains('on'), d: b.querySelector('path').getAttribute('d').slice(0, 8),
      pass: !!root.querySelector('.pass'), panel: [...root.querySelectorAll('.pn')].some(p => getComputedStyle(p).display !== 'none'),
    };
  });
  const prefTool = () => page.evaluate(() => window.__paintBookmarklet.stats().prefs.tool);
  const onPage = () => page.evaluate(() => document.elementFromPoint(500, 400).tagName !== 'PAINT-BOOKMARKLET');
  const press = () => mouseClick(page, '.bar > .b');
  const PEN = { tool: 'ペン', on: true, d: 'M4 20l1.', pass: false, panel: false }, ER = { tool: '消しゴム', on: true, d: 'M8 20h12', pass: false, panel: false };
  assert.deepEqual(await st(page), PEN);
  assert.equal(await onPage(), false);
  await press();
  assert.deepEqual(await st(page), ER, 'pen -> eraser');
  assert.equal(await prefTool(), 'eraser');
  await press();
  assert.deepEqual(await st(page), PEN, 'eraser -> pen');
  assert.equal(await prefTool(), 'pen');
  // キーで消しゴムにしても印が変わる
  await page.keyboard.press('e');
  assert.deepEqual(await st(page), ER);
  // ページ操作モードはない（V キーも効かない。T-077）
  await page.keyboard.press('v');
  assert.deepEqual(await st(page), ER);
  assert.equal(await onPage(), false);
  assert.equal(await toastOn(), false);
  await press();
  assert.deepEqual(await st(page), PEN);
  await drag(page, [[300, 300], [400, 320]]);
  assert.equal(await page.evaluate(() => window.__paintBookmarklet.stats().history), 1, 'draws again with the pen');
  // ほかの道具もショートカットで選べる
  await page.keyboard.press('s');
  assert.equal((await page.evaluate(() => window.__paintBookmarklet.stats().prefs.tool)), 'select');
  await page.keyboard.press('p');
  // 閉じる（×）はその他のメニューにある（何も描いていなければすぐ閉じる）
  // その他は全消去と閉じるだけ（T-072）。開発用を入れていても同じ
  assert.deepEqual(await menuItems(page), ['全消去', '閉じる']);
  await click(page, '[title^="その他"]');
  await click(page, '.mi[title^="閉じる"]');
  await page.waitForFunction(() => !window.__paintBookmarklet);
  await runCode(page, withDefaults(CODE, { dev: true, cp: 1 }));
  assert.deepEqual(await menuItems(page), ['全消去', '閉じる']);
  assert.deepEqual(errors, []);
  await page.close();
  // スマホの幅（タッチ・360px）でも 1 段に収まる
  const ph = await browser.newPage({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
  await ph.route('**/phone', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><p>phone</p>' }));
  await ph.goto(server.base + '/phone');
  await runCode(ph, withDefaults(CODE, { cp: 1 }));
  const m = await bar(ph);
  assert.deepEqual(m.titles, want);
  assert.equal(m.two, false);
  assert.equal(m.tops.length, 1);
  await ph.close();
});

test('チェックポイント 2（既定）: ツールバーはペン・文字・元に戻す・その他・隠す。文字は電卓が入り、その他は全消去・色・閉じる。インストールページでチェックポイントを選べる（T-078）', async () => {
  const { page, errors } = await fresh();
  const bar = () => shadowEval(page, root => [...root.querySelector('.bar').children].filter(e => e.classList.contains('b'))
    .map(b => b.title.split(/[ （(]/)[0] + (b.classList.contains('on') ? '*' : '')));
  const prefs = () => page.evaluate(() => window.__paintBookmarklet.stats().prefs);
  assert.equal((await prefs()).cp, 2);
  assert.deepEqual(await bar(), ['ペン*', '文字', '元に戻す', 'その他', '隠す']);
  // 文字: 押すと文字の道具になり、計算式を書くと答えが薄く出て Tab で書き込める（電卓は入り）
  await mouseClick(page, '.bar > [aria-label^="文字"]');
  assert.deepEqual(await bar(), ['ペン', '文字*', '元に戻す', 'その他', '隠す']);
  assert.equal((await prefs()).calc, true);
  await page.mouse.click(300, 300);
  await page.keyboard.type('12+30');
  assert.equal(await shadowEval(page, root => root.querySelector('.gh').textContent), '=42');
  await page.keyboard.press('Tab');
  assert.equal(await shadowEval(page, root => root.querySelector('textarea').value), '12+30=42');
  // ペンを押すと文字は確定してペンに、もう一度で消しゴム
  await mouseClick(page, '.bar > [aria-label^="ペン"]');
  assert.equal((await page.evaluate(() => window.__paintBookmarklet.stats().texts)), 1);
  assert.deepEqual(await bar(), ['ペン*', '文字', '元に戻す', 'その他', '隠す']);
  await mouseClick(page, '.bar > [aria-label^="ペン"]');
  assert.deepEqual(await bar(), ['消しゴム*', '文字', '元に戻す', 'その他', '隠す']);
  // その他: 全消去・色（8 色）・閉じる。色を選ぶとメニューは閉じ、消しゴムのときはペンに戻る
  await mouseClick(page, '.bar > [aria-label^="その他"]');
  const menu = () => shadowEval(page, root => {
    const p = [...root.querySelectorAll('.mi')].find(b => b.title.startsWith('全消去')).parentElement;
    return { open: p.classList.contains('on'), items: [...p.children].map(e => e.classList.contains('mi') ? e.querySelector('span').textContent : e.querySelectorAll('.c').length + ' 色'),
      on: [...p.querySelectorAll('.c.on')].map(b => b.title) };
  });
  assert.deepEqual(await menu(), { open: true, items: ['全消去', '8 色', '閉じる'], on: ['色 3'] });
  await mouseClick(page, '.pn.on [title="色 7"]');
  assert.equal((await prefs()).color, '#1e88e5');
  assert.equal((await prefs()).tool, 'pen');
  assert.deepEqual(await menu(), { open: false, items: ['全消去', '8 色', '閉じる'], on: ['色 7'] });
  assert.deepEqual(errors, []);
  await page.close();
  // インストールページ: チェックポイントを選ぶと Paint ボタンの名前と中身が変わり、試すとそのチェックポイントで起動し直す
  const ins = await openPage(browser, server.base + '/install');
  const ip = ins.page;
  assert.equal((await ip.textContent('#bm')).trim(), 'Paint CP2');
  assert.ok(await ip.isChecked('#p-cp input[value="2"]'));
  await ip.check('#p-cp input[value="1"]');
  assert.equal((await ip.textContent('#bm')).trim(), 'Paint CP1');
  assert.ok(decodeURIComponent(await ip.getAttribute('#bm', 'href')).includes('{\\"cp\\":1}'));
  await ip.click('#try');
  assert.equal(await ip.evaluate(() => window.__paintBookmarklet.stats().prefs.cp), 1);
  // ツールがページを覆っているので、隠してから選び直す
  await ip.keyboard.press('Escape');
  await ip.check('#p-cp input[value="2"]');
  await ip.click('#try');
  assert.equal(await ip.evaluate(() => window.__paintBookmarklet.stats().prefs.cp), 2);
  assert.deepEqual(ins.errors, []);
  await ip.close();
});

test('スマホ: 2 本指で動かすとページがスクロールし、1 本目で描き始めた線は残らない。1 本指では今まで通り描ける（T-074）', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.base + '/long');
  await runCode(page, CODE);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  const hist = () => page.evaluate(() => window.__paintBookmarklet.stats().history);
  // 1 本目を置いて少し動かしてから（線を描き始める）、2 本目を置いて 2 本とも上へ 200px 動かす
  await touch('touchStart', [[150, 500]]);
  await touch('touchMove', [[160, 490]]);
  await touch('touchStart', [[160, 490], [250, 500]]);
  for (let i = 1; i <= 10; i++) await touch('touchMove', [[160, 490 - i * 20], [250, 500 - i * 20]]);
  await touch('touchEnd', [[160, 290]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => scrollY), 200);
  assert.equal(await hist(), 0, 'the stroke started by the first finger is dropped');
  // 1 本指は描く（スクロールしない）
  await touch('touchStart', [[100, 400]]);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [[100 + i * 20, 400 + i * 10]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => scrollY), 200);
  assert.equal(await hist(), 1);
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

const hist = page => page.evaluate(() => window.__paintBookmarklet.stats().history);



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
  assert.deepEqual(saved.size, { pen: 7 });
  assert.equal(saved.color, '#1e88e5');
  assert.equal(saved.tool, 'marker');
  await page.evaluate(() => window.__paintBookmarklet.destroy());
  await runBookmarklet(page);
  const p = await prefs(page);
  assert.equal(p.color, '#1e88e5');
  assert.equal(p.tool, 'marker');
  assert.equal(p.size.pen, 7);
  assert.deepEqual(p.bar, saved.bar);
  assert.equal(await page.evaluate(() => document.querySelector('paint-bookmarklet-surface').shadowRoot.querySelector('.s').className), 's');
  // インストールページの既定を変えると、このサイトで触っていない所（消しゴム）には新しい既定が効く
  await page.evaluate(() => window.__paintBookmarklet.destroy());
  await runCode(page, withDefaults(CODE, { color: '#43a047', size: { eraser: 50 } }));
  const q = await prefs(page);
  assert.equal(q.color, '#1e88e5');
  assert.equal(q.size.eraser, 50);
  assert.equal(q.size.pen, 7);
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
