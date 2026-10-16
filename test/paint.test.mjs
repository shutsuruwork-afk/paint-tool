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

test('見た目: 明るい（白に黒）とガラス風（既定はガウス）、ガラスの調整（ぼかし方・強さ・地の濃さ）をインストールページで選べる。既定は今までどおり', async () => {
  const look = page => shadowEval(page, root => {
    const w = root.querySelector('.w'), bar = root.querySelector('.bar'), pn = root.querySelector('.pn'), g = getComputedStyle(bar, '::before');
    return {
      cls: ['light', 'glass', 'gauss'].filter(c => w.classList.contains(c)).join(' '),
      color: getComputedStyle(w).color,
      bar: getComputedStyle(bar).backgroundColor,
      blur: g.backdropFilter,
      tint: g.backgroundColor,
      mask: (g.maskImage || g.webkitMaskImage || '').includes('radial-gradient'),
      panel: getComputedStyle(pn, '::before').backdropFilter,
    };
  });
  const { page, errors } = await fresh();
  assert.deepEqual(await look(page), { cls: '', color: 'rgb(232, 233, 238)', bar: 'rgb(32, 34, 40)', blur: 'none', tint: 'rgba(0, 0, 0, 0)', mask: false, panel: 'none' });
  assert.equal((await prefs(page)).glass, false);
  // 明るい・ガラス・ふつうのぼかし・強さ 8・濃さ 50%
  await page.evaluate(() => window.__paintBookmarklet.destroy());
  await runCode(page, withDefaults(CODE, { theme: 'light', glass: true, blurMode: 'plain', blur: 8, tint: 50 }));
  assert.deepEqual(await look(page), { cls: 'light glass', color: 'rgb(29, 32, 38)', bar: 'rgba(0, 0, 0, 0)', blur: 'blur(8px) saturate(1.8)', tint: 'rgba(250, 250, 252, 0.5)', mask: false, panel: 'blur(8px) saturate(1.8)' });
  const p1 = await prefs(page);
  assert.deepEqual([p1.theme, p1.glass, p1.blurMode, p1.blur, p1.tint], ['light', true, 'plain', 8, 50]);
  await page.close();
  // インストールページでガラスを入れて試すと、ガウス（周りも拾い、mask で角丸に切る）で始まる
  const { page: ip, errors: ie } = await openPage(browser, server.base + '/install');
  await ip.check('#p-glass');
  await ip.click('#try');
  const g = await look(ip);
  assert.equal(g.cls, 'glass gauss');
  assert.equal(g.blur, 'blur(15px) saturate(1.8)');
  assert.equal(g.mask, true);
  assert.equal(g.panel, 'blur(15px) saturate(1.8)');
  assert.deepEqual(ie, []);
  assert.deepEqual(errors, []);
  await ip.close();
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
  await runCode(page, withDefaults(CODE, { dev: true }));
  assert.equal(await hasItem(page), true);
  await mouseClick(page, '[aria-label^="その他"]');
  await mouseClick(page, '.pn.on [aria-label^="見た目"]');
  assert.equal(await openPanels(page), 1);
  // 明るい → ガラス風（ガウス）→ ぼかしを 8px
  await mouseClick(page, '.pn.on [aria-label="ツールバーの色: 明るい"]');
  assert.deepEqual(await st(page), { cls: 'light', bar: 'rgb(251, 251, 252)', gb: '15px', color: 'rgb(29, 32, 38)' });
  await mouseClick(page, '.pn.on [aria-label^="ガラス風"]');
  assert.equal((await st(page)).cls, 'light glass gauss');
  await shadowEval(page, root => { const r = [...root.querySelectorAll('.pn.on .r input')][0]; r.value = 8; r.dispatchEvent(new Event('input')); });
  assert.equal((await st(page)).gb, '8px');
  // 好きな色: 濃い色なら白い文字、明るい色なら黒い文字
  const pick = c => shadowEval(page, (root, c) => { const i = root.querySelectorAll('.bar > input.ci')[1]; i.value = c; i.dispatchEvent(new Event('input')); }, c);
  await mouseClick(page, '.pn.on [aria-label^="ガラス風"]');
  await pick('#123456');
  assert.deepEqual(await st(page), { cls: '', bar: 'rgb(18, 52, 86)', gb: '8px', color: 'rgb(232, 233, 238)' });
  await pick('#ffd54f');
  assert.deepEqual(await st(page), { cls: 'light', bar: 'rgb(255, 213, 79)', gb: '8px', color: 'rgb(29, 32, 38)' });
  assert.equal((await prefs(page)).theme, '#ffd54f');
  // この見た目をデフォルトに: 見た目を持ってインストールページを開く
  await page.evaluate(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; });
  await mouseClick(page, '.pn.on [aria-label^="この見た目をデフォルトに"]');
  const [url] = (await page.evaluate(() => window.__opened))[0];
  const d = JSON.parse(decodeURIComponent(url.slice(url.indexOf('#defaults=') + 10)));
  assert.deepEqual([d.dev, d.theme, d.glass, d.blur], [true, '#ffd54f', false, 8]);
  const { page: ip, errors: ie } = await openPage(browser, server.base + '/install' + url.slice(url.indexOf('#')));
  assert.equal(await ip.isChecked('#p-theme input[value="custom"]'), true);
  assert.equal(await ip.inputValue('#p-tcolor'), '#ffd54f');
  assert.equal(await ip.inputValue('#p-blur'), '8');
  assert.equal(await ip.isChecked('#p-dev'), true);
  assert.deepEqual(ie, []);
  await ip.close();
  assert.deepEqual(errors, []);
  await page.close();
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
  assert.equal(p0.glass, await page.isChecked('#p-glass'));
  assert.equal(p0.theme, await page.evaluate(() => document.querySelector('#p-theme input:checked').value));
  assert.equal(p0.blurMode, await page.evaluate(() => document.querySelector('#p-mode input:checked').value));
  assert.equal(String(p0.blur), await page.inputValue('#p-blur'));
  assert.equal(String(p0.tint), await page.inputValue('#p-tint'));
  assert.equal(p0.dev, await page.isChecked('#p-dev'));
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
