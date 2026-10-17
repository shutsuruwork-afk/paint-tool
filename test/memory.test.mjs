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
