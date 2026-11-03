// T-113: スマホ・タブレットでは canvas のメモリを上限までに抑える（使いすぎると iOS や Android がページを読み直し、絵が全部消えるため）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CODE, startServer, launch, runCode, withDefaults, readMain } from './helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser.close(); server.srv.close(); });

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const open = async (opts = {}, path = '/long') => {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 }, ...opts });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.base + path);
  return { page, errors };
};
const stats = page => page.evaluate(() => window.__paintBookmarklet.stats());
const COLORS = ['#e53935', '#43a047', '#1e88e5', '#fdd835', '#8e24aa', '#111111', '#fb8c00', '#ffffff'];
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
// 画面全体を色を変えながら塗りつぶす（1 回で画面 1 枚分の履歴を積む）
async function fills(page, check) {
  await page.evaluate(() => window.__paintBookmarklet.tool('fill'));
  for (const c of COLORS) {
    await page.evaluate(c => window.__paintBookmarklet.color(c), c);
    await page.mouse.click(200, 400);
    if (check) check(await stats(page));
  }
}
const at = async page => (await readMain(page, 200, 400)).slice(0, 3);
async function stroke(page, x, y, n = 8, dx = 20) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= n; i++) await page.mouse.move(x + i * dx, y);
  await page.mouse.up();
}

test('canvas の上限は、iPhone・Android では 192 MB、PC にはない', async () => {
  for (const [ua, cap] of [[IPHONE, 192e6], [ANDROID, 192e6], [undefined, 0]]) {
    const { page, errors } = await open(ua ? { userAgent: ua } : {});
    await runCode(page, CODE);
    assert.equal((await stats(page)).memoryCap, cap, ua || 'PC');
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('スマホでは、上限を超えそうになると古い手から捨てて canvas の合計を上限の中に収める。絵は消えず、残した手は元に戻せる。PC では今まで通り', async () => {
  const { page, errors } = await open({ userAgent: IPHONE, deviceScaleFactor: 2 });
  await runCode(page, withDefaults(CODE, { mem: 35 }));
  const seen = [];
  await fills(page, s => { seen.push(s.history); assert.ok(s.memory <= 35e6, `canvas の合計 ${s.memory} が上限を超えた`); });
  // 画面 1 枚分（1.09 M 画素）の手がいくつか入り、それより古い手は土台に畳んで捨てる（T-131。上限を超えそうなら、先に近い手の前の画素を手放す）
  const n = seen[seen.length - 1];
  assert.ok(n >= 3 && n < 8, `残した手 ${seen}`);
  assert.deepEqual(await at(page), rgb(COLORS[7]), '絵はそのまま');
  for (let i = 0; i <= n; i++) await page.evaluate(() => window.__paintBookmarklet.undo());
  assert.deepEqual(await at(page), rgb(COLORS[7 - n]), '残した手は元に戻せ、それより前には戻らない');
  for (let i = 0; i < n; i++) await page.evaluate(() => window.__paintBookmarklet.redo());
  assert.deepEqual(await at(page), rgb(COLORS[7]), 'やり直しも元通り');
  assert.deepEqual(errors, []);
  await page.close();

  const pc = await open({ deviceScaleFactor: 2 });
  await runCode(pc.page, CODE);
  await fills(pc.page);
  assert.equal((await stats(pc.page)).history, 8, 'PC では画面 8 枚分まで残す');
  await pc.page.close();
});

test('絵そのものが上限より大きくても、画面 1 枚分の履歴は残す（小さな手なら何手も元に戻せる）', async () => {
  const { page, errors } = await open({ userAgent: IPHONE, deviceScaleFactor: 2 });
  await runCode(page, withDefaults(CODE, { mem: 10 }));
  await fills(page);
  assert.ok((await stats(page)).memory > 10e6, '絵とライブの canvas だけで上限を超えている');
  await page.evaluate(() => window.__paintBookmarklet.tool('pen'));
  for (let i = 0; i < 5; i++) await stroke(page, 40, 150 + i * 40);
  const s = await stats(page);
  assert.ok(s.history >= 5, `小さな線 5 本は元に戻せる（${s.history} 手）`);
  assert.ok(s.historyPixels <= s.width * s.height, '履歴は画面 1 枚分まで');
  assert.deepEqual(errors, []);
  await page.close();
});

test('全消去を元に戻す・やり直すと、タイルは面と履歴を行き来するだけで、canvas の合計は変わらない（二重に数えない）', async () => {
  const { page, errors } = await open({ userAgent: IPHONE });
  await runCode(page, CODE);
  // 線は 3 本（全消去を足しても、どの手も元に戻すの近く〈前後 4 手〉にあり、画素を手放さない。T-131）
  for (let i = 0; i < 3; i++) await stroke(page, 30, 120 + i * 150, 10, 30);
  const s0 = await stats(page);
  await page.evaluate(() => window.__paintBookmarklet.clear());
  const s1 = await stats(page);
  assert.equal(s1.tiles, 0);
  assert.equal(s1.memory, s0.memory, '全消去: タイルは履歴へ移るだけ');
  await page.evaluate(() => window.__paintBookmarklet.undo());
  const s2 = await stats(page);
  assert.equal(s2.tiles, s0.tiles);
  assert.equal(s2.historyPixels, s0.historyPixels, '元に戻すと、履歴の画素数も全消去の前に戻る');
  assert.equal(s2.memory, s0.memory);
  await page.evaluate(() => window.__paintBookmarklet.redo());
  assert.deepEqual(await stats(page).then(s => [s.tiles, s.historyPixels, s.memory]), [0, s1.historyPixels, s1.memory]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('画面を回して大きくなった live / pred は、1 秒たつと今の大きさに戻る（描いている間は待つ）。戻した後も描ける', async () => {
  const { page, errors } = await open({ viewport: { width: 390, height: 844 } });
  await runCode(page, CODE);
  const wh = async () => { const s = await stats(page); return [s.width, s.height]; };
  assert.deepEqual(await wh(), [390, 844]);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(100);
  assert.deepEqual(await wh(), [844, 844], '回した直後は大きい方に合わせる（今まで通り）');
  await page.waitForTimeout(1200);
  assert.deepEqual(await wh(), [844, 390], '1 秒たつと今の大きさ');
  await stroke(page, 100, 200, 20, 30);
  assert.equal((await readMain(page, 400, 200))[3], 255, '縮めた後も描ける');
  // 描いている途中に回しても、離すまでは作り直さない
  await page.mouse.move(100, 300);
  await page.mouse.down();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1300);
  for (let i = 1; i <= 10; i++) await page.mouse.move(100 + i * 20, 300);
  assert.deepEqual(await wh(), [844, 390], '描いている間は作り直さない');
  await page.mouse.up();
  await page.waitForTimeout(100);
  assert.equal((await readMain(page, 200, 300))[3], 255, '回した間に描いた線も残る');
  await page.waitForTimeout(1200);
  assert.deepEqual(await wh(), [390, 844]);
  await stroke(page, 50, 500, 10, 25);
  assert.equal((await readMain(page, 150, 500))[3], 255);
  assert.deepEqual(errors, []);
  await page.close();
});

// T-114: 元に戻す・やり直すから遠い手は、何もしていないときに縮める
// 画面の画素をページの中に覚え、その番号を返す
const hash = page => page.evaluate(() => (window.__S || (window.__S = [])).push(window.__paintBookmarklet.pixels(0, 0, innerWidth, innerHeight).data) - 1);
// 今の画面が、覚えた k 番の画面と同じか。描き直し（T-131）は原点を整数だけずらして描くので、線の縁の数画素が数段階違うことがある
// （線の輪郭の計算の丸め。目には見えない）。それは許し、線が欠ける・残るような違いは落とす
async function near(page, k, msg) {
  const [n, mx] = await page.evaluate(k => {
    const a = window.__paintBookmarklet.pixels(0, 0, innerWidth, innerHeight).data, b = window.__S[k];
    let n = 0, mx = 0;
    for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; if (d > mx) mx = d; } }
    return [n, mx];
  }, k);
  assert.ok(n <= 64 && mx <= 8, `${msg || ''}（${n} 値が違い、最大 ${mx}）`);
}
// ペンと蛍光ペン（半透明）を重ねて n 本描き、描く前と 1 本ごとの画面の画素の hash を返す
async function strokes(page, n) {
  const snaps = [await hash(page)];
  for (let i = 0; i < n; i++) {
    await page.evaluate(t => window.__paintBookmarklet.tool(t), i % 3 === 2 ? 'marker' : 'pen');
    await page.evaluate(c => window.__paintBookmarklet.color(c), COLORS[i % 7]);
    const pts = [];
    for (let k = 0; k <= 12; k++) pts.push([40 + k * 25, 120 + i * 30 + 40 * Math.sin(k / 2 + i)]);
    await page.mouse.move(...pts[0]);
    await page.mouse.down();
    for (const p of pts.slice(1)) await page.mouse.move(...p);
    await page.mouse.up();
    snaps.push(await hash(page));
  }
  return snaps;
}
const zipped = async page => (await stats(page)).historyZipped;

// T-131: 線の手は描いた命令を記録し、元に戻す・やり直すの近く（前後 4 手）の外では画素を持たない。戻すときは前の手から描き直す
test('線の手は、新しい 4 手より古いと画素を持たず、描いた命令から描き直して元に戻す。元に戻す・やり直すは見た目が同じ（線の縁の数画素が数段階違うのは許す）（T-131）', async () => {
  const { page, errors } = await open({ userAgent: IPHONE, deviceScaleFactor: 2 });
  const warns = [];
  page.on('console', m => { if (m.type() === 'warning') warns.push(m.text()); });
  await runCode(page, withDefaults(CODE, { mem: 20 }));
  const snaps = await strokes(page, 10);
  await page.mouse.click(30, 650); // 押しただけの点
  const s = await stats(page);
  assert.equal(s.history, 11);
  assert.equal(s.historyDrawn, 11, 'どの手も描いた命令を持つ');
  assert.equal(s.historyCached, 4, '画素を持つのは新しい 4 手だけ');
  assert.ok(s.historyPixels < s.width * s.height, `履歴の画素数は画面 1 枚より小さい（${s.historyPixels}）`);
  await page.evaluate(() => window.__paintBookmarklet.undo()); // 押しただけの点
  for (let i = 10; i >= 1; i--) {
    await page.evaluate(() => window.__paintBookmarklet.undo());
    await near(page, snaps[i - 1], `元に戻す: ${i} 本目の前と同じ`);
  }
  for (let i = 1; i <= 10; i++) {
    await page.evaluate(() => window.__paintBookmarklet.redo());
    await near(page, snaps[i], `やり直す: ${i} 本目の後と同じ`);
  }
  // 最初まで戻した後も、やり直すの並びから遠い手は画素を持たない
  for (let i = 0; i < 10; i++) await page.evaluate(() => window.__paintBookmarklet.undo());
  assert.ok((await stats(page)).historyCached <= 4, 'やり直すの並びの遠い手も画素を持たない');
  for (let i = 1; i <= 10; i++) await page.evaluate(() => window.__paintBookmarklet.redo());
  await near(page, snaps[10]);
  assert.deepEqual(warns.filter(w => /readback/i.test(w)), [], 'ページのコンソールに読み出しの警告を出さない');
  assert.deepEqual(errors, []);
  await page.close();
});

// 線の手は遠くなると画素を持たない（T-131）ので、縮めるのは全消去のタイルと塗りつぶし・選択の移動の画素。上限 14 MB なら、全消去のタイルで半分を超える
// T-131: いろいろな手（ペンの種類・半透明・図形・消しゴム・塗りつぶし・選択の移動・文字・全消去）を混ぜて積み、新しい 4 手より古い手まで
// 描き直しで元に戻す・やり直す。どの手の後も見た目が同じ（near）。途中で元に戻してから新しく描いても同じ
test('いろいろな手を混ぜても、描き直しで元に戻す・やり直すの見た目が同じ（T-131）', async () => {
  const { page, errors } = await open({ userAgent: IPHONE, deviceScaleFactor: 2 });
  await runCode(page, CODE);
  const api = (f, a) => page.evaluate(([f, a]) => window.__paintBookmarklet[f](a), [f, a]);
  const drag = async (pts, steps = 6) => {
    await page.mouse.move(...pts[0]);
    await page.mouse.down();
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      for (let k = 1; k <= steps; k++) await page.mouse.move(ax + (bx - ax) * k / steps, ay + (by - ay) * k / steps);
    }
    await page.mouse.up();
  };
  const penType = name => page.evaluate(n => document.querySelector('paint-bookmarklet').shadowRoot.querySelector(`.pn [aria-label^="${n}"]`).click(), name);
  const wave = (y, a = 30) => Array.from({ length: 9 }, (_, k) => [40 + k * 38, y + a * Math.sin(k)]);
  const snaps = [await hash(page)];
  const step = async f => { await f(); snaps.push(await hash(page)); };
  await step(async () => { await api('tool', 'pen'); await api('color', '#e53935'); await drag(wave(150)); });
  await step(async () => { await penType('万年筆'); await api('color', '#1e88e5'); await drag(wave(170, 50)); });
  await step(async () => { await penType('筆'); await api('color', '#111111'); await drag(wave(200)); });
  await step(async () => { await penType('鉛筆'); await api('color', '#43a047'); await drag(wave(160, 60)); });
  await step(async () => { await penType('ペン'); await api('tool', 'marker'); await api('color', '#fdd835'); await drag(wave(180, 40)); });
  await step(async () => { await api('tool', 'rect'); await drag([[60, 120], [260, 260]], 4); });
  await step(async () => { await api('tool', 'ellipse'); await drag([[150, 140], [330, 300]], 4); });
  await step(async () => { await api('tool', 'arrow'); await drag([[50, 300], [320, 110]], 4); });
  await step(async () => { await api('tool', 'eraser'); await drag([[30, 190], [360, 210]], 10); });
  await step(async () => { await api('tool', 'fill'); await api('color', '#8e24aa'); await page.mouse.click(200, 400); });
  await step(async () => { await api('tool', 'pen'); await api('color', '#fb8c00'); await drag(wave(380, 40)); });
  await step(async () => { await page.keyboard.press('s'); await drag([[30, 100], [370, 330]], 4); await drag([[200, 200], [230, 260]], 4); await page.keyboard.press('Enter'); });
  await step(async () => { await api('tool', 'text'); await page.mouse.click(80, 500); await page.keyboard.type('abc'); await page.keyboard.press('Escape'); });
  await step(async () => { await api('tool', 'line'); await drag([[40, 560], [350, 600]], 4); });
  await step(async () => { await api('clear'); });
  await step(async () => { await api('tool', 'pen'); await api('color', '#e53935'); await drag(wave(250, 70)); });
  await step(async () => { await api('tool', 'marker'); await drag(wave(270, 30)); });
  const n = snaps.length - 1;
  const s = await stats(page);
  assert.equal(s.history, n, `${n} 手`);
  assert.equal(s.historyCached, 3, '画素のアトラスを持つのは新しい 4 手だけ（そのうち全消去はタイルを持つので 3 手）');
  for (let i = n; i >= 1; i--) {
    await api('undo');
    await near(page, snaps[i - 1], `元に戻す: ${i} 手目の前と同じ`);
  }
  for (let i = 1; i <= n; i++) {
    await api('redo');
    await near(page, snaps[i], `やり直す: ${i} 手目の後と同じ`);
  }
  // 途中まで戻してから新しく描くと、やり直すの並びは捨てる。その後も元に戻すは一致する
  for (let i = 0; i < 8; i++) await api('undo');
  await api('tool', 'pen');
  await drag(wave(450, 20));
  await api('undo');
  await near(page, snaps[n - 8]);
  for (let i = n - 8; i >= 1; i--) {
    await api('undo');
    await near(page, snaps[i - 1], `もう一度元に戻す: ${i} 手目の前と同じ`);
  }
  assert.deepEqual(errors, []);
  await page.close();
});

// 上限で古い手を捨てるときは、土台に畳み込む（T-131）。捨てた後も、残した手は描き直しで元に戻せ、いちばん古い残した手の前まで戻る
test('履歴の上限で捨てた古い手は土台に畳まれ、残した手は描き直しで元に戻せる（T-131）', async () => {
  const { page, errors } = await open({ userAgent: IPHONE, deviceScaleFactor: 2 });
  await runCode(page, withDefaults(CODE, { mem: 34 }));
  const snaps = [await hash(page)];
  // 線と塗りつぶしを交互に。塗りつぶしは画面 1 枚分の画素を持つので、上限で古い手から捨てる
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.__paintBookmarklet.tool('fill'));
    await page.evaluate(c => window.__paintBookmarklet.color(c), COLORS[i]);
    await page.mouse.click(200, 600);
    snaps.push(await hash(page));
    snaps.push(...(await strokes(page, 2)).slice(1));
    const s = await stats(page);
    assert.ok(s.memory <= 34e6, `canvas の合計 ${s.memory} が上限を超えた`);
  }
  const s = await stats(page);
  assert.ok(s.baseTiles > 0 && s.history < 18, `古い手は土台に畳まれた（${s.history} 手・土台 ${s.baseTiles} 枚）`);
  const n = snaps.length - 1;
  for (let i = n; i > n - s.history; i--) {
    await page.evaluate(() => window.__paintBookmarklet.undo());
    await near(page, snaps[i - 1], `元に戻す: ${i} 手目の前と同じ`);
  }
  await page.evaluate(() => window.__paintBookmarklet.undo());
  await near(page, snaps[n - s.history], 'それより前には戻らない');
  for (let i = n - s.history + 1; i <= n; i++) {
    await page.evaluate(() => window.__paintBookmarklet.redo());
    await near(page, snaps[i]);
  }
  assert.deepEqual(errors, []);
  await page.close();
});

// 画面に固定を切ると、面と履歴をスクロールした分だけずらす（shiftAll）。描いた命令と土台もずらすので、その後も描き直しで元に戻せる（T-131）
test('画面に固定を切って面をずらした後も、描き直しで元に戻す・やり直すの見た目が同じ（T-131）', async () => {
  const { page, errors } = await open({ userAgent: IPHONE, deviceScaleFactor: 2 });
  await runCode(page, CODE);
  const fixedItem = () => page.evaluate(() => document.querySelector('paint-bookmarklet').shadowRoot.querySelector('[aria-label^="画面に固定"]').click());
  await strokes(page, 4);
  await fixedItem();
  await page.evaluate(() => scrollTo({ top: 300, behavior: 'instant' }));
  await strokes(page, 4);
  await fixedItem(); // 切ると、見えている位置のままページに付き直す（面と履歴を 300px ずらす）
  const snaps = [];
  for (let i = 0; i < 8; i++) { snaps.unshift(await hash(page)); await page.evaluate(() => window.__paintBookmarklet.undo()); }
  const blank = await hash(page);
  for (let i = 0; i < 8; i++) { await page.evaluate(() => window.__paintBookmarklet.redo()); await near(page, snaps[i], `やり直す: ${i + 1} 本目の後と同じ`); }
  for (let i = 7; i >= 0; i--) { await page.evaluate(() => window.__paintBookmarklet.undo()); await near(page, i ? snaps[i - 1] : blank, `元に戻す: ${i + 1} 本目の前と同じ`); }
  assert.deepEqual(errors, []);
  await page.close();
});

test('履歴の圧縮: 全消去の手が持つタイルも縮み、元に戻すと画素単位で戻る', async () => {
  const { page, errors } = await open({ userAgent: IPHONE, deviceScaleFactor: 2 });
  await runCode(page, withDefaults(CODE, { mem: 14 }));
  const snaps = await strokes(page, 6);
  await page.evaluate(() => window.__paintBookmarklet.clear());
  const tiles = (await stats(page)).historyPixels;
  await strokes(page, 5);
  await page.waitForTimeout(1600);
  const s = await stats(page);
  assert.ok(s.historyZipped >= 2, `全消去のタイルが縮む（${s.historyZipped}）`);
  for (let i = 0; i < 6; i++) await page.evaluate(() => window.__paintBookmarklet.undo());
  await near(page, snaps[6], '全消去を元に戻すと、消す前と同じ');
  assert.ok((await stats(page)).historyPixels < tiles, '戻したタイルは履歴に数えない');
  for (let i = 6; i >= 1; i--) {
    await page.evaluate(() => window.__paintBookmarklet.undo());
    await near(page, snaps[i - 1]);
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('履歴の圧縮: スマホの上限が同じでも、縮めた分だけ多くの手を残せる', async () => {
  const { page, errors } = await open({ userAgent: IPHONE, deviceScaleFactor: 2 });
  await runCode(page, withDefaults(CODE, { mem: 45 }));
  await page.evaluate(() => window.__paintBookmarklet.tool('fill'));
  for (let i = 0; i < COLORS.length; i++) {
    await page.evaluate(c => window.__paintBookmarklet.color(c), COLORS[i]);
    await page.mouse.click(200, 400);
    if (i >= 4) await page.waitForTimeout(1300);
  }
  const s = await stats(page);
  assert.equal(s.history, 8, `縮めなければ 6 手まで（${s.history} 手）`);
  assert.ok(s.memory <= 45e6);
  for (let i = 7; i >= 1; i--) {
    await page.evaluate(() => window.__paintBookmarklet.undo());
    assert.deepEqual(await at(page), rgb(COLORS[i - 1]));
  }
  await page.evaluate(() => window.__paintBookmarklet.undo());
  assert.equal((await readMain(page, 200, 400))[3], 0, 'いちばん最初まで戻る');
  assert.deepEqual(errors, []);
  await page.close();
});

test('履歴の圧縮: 読み出した画素に揺らぎが足される環境（指紋対策）では縮めず、元に戻すはそのまま一致する', async () => {
  const { page, errors } = await open({ userAgent: IPHONE, deviceScaleFactor: 2 });
  await page.evaluate(() => {
    for (const P of [CanvasRenderingContext2D.prototype, window.OffscreenCanvasRenderingContext2D && OffscreenCanvasRenderingContext2D.prototype]) {
      if (!P) continue;
      const g = P.getImageData;
      P.getImageData = function (...a) { const im = g.apply(this, a); for (let i = 0; i < im.data.length; i += 4) if (im.data[i + 3] === 255) im.data[i] ^= 1; return im; };
    }
  });
  await runCode(page, withDefaults(CODE, { mem: 20 }));
  const snaps = await strokes(page, 10);
  await page.waitForTimeout(1600);
  assert.equal(await zipped(page), 0, '縮めない');
  for (let i = 10; i >= 1; i--) {
    await page.evaluate(() => window.__paintBookmarklet.undo());
    await near(page, snaps[i - 1]);
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('履歴の圧縮は、スマホ・タブレットで履歴が上限の半分を超えたときだけ。PC と、半分に届かないスマホでは縮めない。2 本指でスクロールしている間も縮めず、止めてから縮める（T-120）', async () => {
  // PC: 上限が大きく、縮めても違いを感じないので縮めない
  let { page, errors } = await open({ deviceScaleFactor: 2 });
  await runCode(page, CODE);
  await strokes(page, 10);
  await page.waitForTimeout(1600);
  assert.equal(await zipped(page), 0, 'PC では縮めない');
  assert.deepEqual(errors, []);
  await page.close();
  // スマホでも、履歴が上限の半分に届かなければ縮めない（192 MB の上限）
  ({ page, errors } = await open({ userAgent: IPHONE, deviceScaleFactor: 2 }));
  await runCode(page, CODE);
  await strokes(page, 10);
  await page.waitForTimeout(1600);
  assert.equal(await zipped(page), 0, '上限の半分に届かない');
  assert.deepEqual(errors, []);
  await page.close();
  // 2 本指でスクロールしている間は縮めない。離して 1 秒たつと縮める（線の手は画素を持たないので、塗りつぶしの手で見る。T-131）
  ({ page, errors } = await open({ userAgent: IPHONE, deviceScaleFactor: 2, hasTouch: true }));
  await runCode(page, withDefaults(CODE, { mem: 45 }));
  await page.evaluate(() => window.__paintBookmarklet.tool('fill'));
  for (let i = 0; i < 6; i++) {
    await page.evaluate(c => window.__paintBookmarklet.color(c), COLORS[i]);
    await page.mouse.click(200, 400);
  }
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  await touch('touchStart', [[150, 600]]);
  await touch('touchStart', [[150, 600], [250, 600]]);
  for (let i = 1; i <= 30; i++) { await touch('touchMove', [[150, 600 - i], [250, 600 - i]]); await page.waitForTimeout(50); } // 1.5 秒ゆっくり動かす
  assert.equal(await zipped(page), 0, 'スクロールしている間は縮めない');
  await page.waitForTimeout(300);
  await touch('touchEnd', [[150, 570]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(1800);
  assert.ok(await zipped(page) >= 1, '止めてから縮める');
  assert.deepEqual(errors, []);
  await page.close();
});
