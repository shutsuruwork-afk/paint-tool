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
  // 画面 1 枚分（1.09 M 画素）の手が 4 つまで入り、それより古い手は捨てる
  assert.deepEqual(seen, [1, 2, 3, 4, 4, 4, 4, 4]);
  assert.deepEqual(await at(page), rgb(COLORS[7]), '絵はそのまま');
  for (let i = 0; i < 5; i++) await page.evaluate(() => window.__paintBookmarklet.undo());
  assert.deepEqual(await at(page), rgb(COLORS[3]), '残した 4 手は元に戻せ、それより前には戻らない');
  for (let i = 0; i < 4; i++) await page.evaluate(() => window.__paintBookmarklet.redo());
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
  for (let i = 0; i < 4; i++) await stroke(page, 30, 120 + i * 150, 10, 30);
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
const hash = page => page.evaluate(() => {
  const d = window.__paintBookmarklet.pixels(0, 0, innerWidth, innerHeight).data;
  let h = 2166136261;
  for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619);
  return h >>> 0;
});
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

test('履歴の圧縮: 新しい 4 手より古い手は、1 秒何もしないと縮む（描いている間は縮めない）。縮めた手まで元に戻す・やり直すと画素単位で一致する', async () => {
  const { page, errors } = await open({ deviceScaleFactor: 2 });
  const warns = [];
  page.on('console', m => { if (m.type() === 'warning') warns.push(m.text()); });
  await runCode(page, CODE);
  const snaps = await strokes(page, 10);
  const before = (await stats(page)).historyPixels;
  // 押したまま 1.5 秒待っても縮めない
  await page.mouse.move(30, 650);
  await page.mouse.down();
  await page.waitForTimeout(1500);
  assert.equal(await zipped(page), 0, '描いている間は縮めない');
  await page.mouse.up();
  await page.waitForTimeout(1600);
  const s = await stats(page);
  assert.equal(s.history, 11);
  assert.equal(s.historyZipped, 7, '新しい 4 手を除く 7 手が縮む');
  assert.ok(s.historyPixels < before / 3, `履歴の画素数が減る（${before} → ${s.historyPixels}）`);
  await page.evaluate(() => window.__paintBookmarklet.undo()); // 押しただけの点
  for (let i = 10; i >= 1; i--) {
    await page.evaluate(() => window.__paintBookmarklet.undo());
    assert.equal(await hash(page), snaps[i - 1], `元に戻す: ${i} 本目の前と同じ`);
  }
  for (let i = 1; i <= 10; i++) {
    await page.evaluate(() => window.__paintBookmarklet.redo());
    assert.equal(await hash(page), snaps[i], `やり直す: ${i} 本目の後と同じ`);
  }
  // 最初まで戻した後も、やり直すの並びから遠い手は縮む
  for (let i = 0; i < 10; i++) await page.evaluate(() => window.__paintBookmarklet.undo());
  await page.waitForTimeout(1600);
  assert.ok(await zipped(page) >= 6, 'やり直すの並びの遠い手も縮む');
  for (let i = 1; i <= 10; i++) await page.evaluate(() => window.__paintBookmarklet.redo());
  assert.equal(await hash(page), snaps[10]);
  assert.deepEqual(warns.filter(w => /readback/i.test(w)), [], 'ページのコンソールに読み出しの警告を出さない');
  assert.deepEqual(errors, []);
  await page.close();
});

test('履歴の圧縮: 全消去の手が持つタイルも縮み、元に戻すと画素単位で戻る', async () => {
  const { page, errors } = await open({ deviceScaleFactor: 2 });
  await runCode(page, CODE);
  const snaps = await strokes(page, 6);
  await page.evaluate(() => window.__paintBookmarklet.clear());
  const tiles = (await stats(page)).historyPixels;
  await strokes(page, 5);
  await page.waitForTimeout(1600);
  const s = await stats(page);
  assert.ok(s.historyZipped >= 6 + 2, `線の手と全消去のタイルが縮む（${s.historyZipped}）`);
  for (let i = 0; i < 6; i++) await page.evaluate(() => window.__paintBookmarklet.undo());
  assert.equal(await hash(page), snaps[6], '全消去を元に戻すと、消す前と同じ');
  assert.ok((await stats(page)).historyPixels < tiles, '戻したタイルは履歴に数えない');
  for (let i = 6; i >= 1; i--) {
    await page.evaluate(() => window.__paintBookmarklet.undo());
    assert.equal(await hash(page), snaps[i - 1]);
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
  const { page, errors } = await open();
  await page.evaluate(() => {
    for (const P of [CanvasRenderingContext2D.prototype, window.OffscreenCanvasRenderingContext2D && OffscreenCanvasRenderingContext2D.prototype]) {
      if (!P) continue;
      const g = P.getImageData;
      P.getImageData = function (...a) { const im = g.apply(this, a); for (let i = 0; i < im.data.length; i += 4) if (im.data[i + 3] === 255) im.data[i] ^= 1; return im; };
    }
  });
  await runCode(page, CODE);
  const snaps = await strokes(page, 8);
  await page.waitForTimeout(1600);
  assert.equal(await zipped(page), 0, '縮めない');
  for (let i = 8; i >= 1; i--) {
    await page.evaluate(() => window.__paintBookmarklet.undo());
    assert.equal(await hash(page), snaps[i - 1]);
  }
  assert.deepEqual(errors, []);
  await page.close();
});
