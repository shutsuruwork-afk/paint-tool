import http from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

export const CODE = readFileSync(new URL('../dist/paint.min.js', import.meta.url), 'utf8');
export const BOOKMARKLET = readFileSync(new URL('../dist/bookmarklet.txt', import.meta.url), 'utf8').trim();

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>test</title></head>
<body style="margin:0;font:16px sans-serif"><h1>Sample</h1><p>${'Lorem ipsum dolor sit amet. '.repeat(30)}</p>
<input id="inp"></body></html>`;
// 縦に長いページ。#m1 は文書の y=900 にある目印
const LONG_BODY = `<div id="sp" style="position:relative;height:3000px"><div id="m1" style="position:absolute;left:100px;top:900px;width:300px;height:10px;background:#ddd"></div></div>`;
const LONG = `<!doctype html><html><head><meta charset="utf-8"><title>long</title></head><body style="margin:0">${LONG_BODY}</body></html>`;
// html に位置ずれがあるページ（面の原点の補正を確かめる）
const OFFSET = `<!doctype html><html style="position:relative;margin:40px 0 0 30px;border-top:5px solid #000"><head><meta charset="utf-8"><title>offset</title></head><body style="margin:0">${LONG_BODY}</body></html>`;

// 厳格な CSP + Trusted Types を課したページ（インライン style / data: 画像 / innerHTML が使えない）
const STRICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; " +
  "require-trusted-types-for 'script'; trusted-types 'none'";

export async function startServer() {
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url.startsWith('/strict')) res.setHeader('content-security-policy', STRICT_CSP);
    // /install はビルドしたインストールページ（docs/index.html）
    if (req.url.startsWith('/install')) return res.end(readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8'));
    res.end(req.url.startsWith('/long') ? LONG : req.url.startsWith('/offset') ? OFFSET : PAGE);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { srv, base: `http://localhost:${srv.address().port}` };
}

// チェックポイント 3 のデザイン（T-085）は、出るときにバーとボタンが拡大しながら現れる。押す位置が動かないように、
// テストのページは既定で「動きを減らす」で開く（動きは reducedMotion: 'no-preference' で開いて確かめる）
export async function launch() {
  const b = await chromium.launch();
  for (const k of ['newPage', 'newContext']) {
    const f = b[k].bind(b);
    b[k] = (o = {}) => f({ reducedMotion: 'reduce', ...o });
  }
  return b;
}

export async function openPage(browser, url, viewport = { width: 1000, height: 700 }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  return { page, errors };
}

// 実際のブックマークレットと同じく javascript: URL へのナビゲーションで実行する
export async function runBookmarklet(page) {
  const had = await page.evaluate(() => !!window.__paintBookmarklet);
  await page.evaluate(u => { location.href = u; }, BOOKMARKLET);
  if (!had) await page.waitForFunction(() => !!window.__paintBookmarklet);
  else await page.waitForTimeout(50);
}

// インストールページと同じように、既定（JSON）を埋め込んだコードを作る
export const withDefaults = (code, d) => code.replace(/(["'])__PAINT_DEFAULTS__\1/, () => JSON.stringify(JSON.stringify(d)));
// コードを直接実行して起動する（CSP を通さない。既定を埋め込んだ版を試すとき用）
export async function runCode(page, code) {
  await page.evaluate(c => (0, eval)(c), code);
  await page.waitForFunction(() => !!window.__paintBookmarklet);
}

export const shadowEval = (page, fn, arg) =>
  page.evaluate(([src, a]) => {
    const root = document.querySelector('paint-bookmarklet').shadowRoot;
    return new Function('root', 'a', `return (${src})(root, a)`)(root, a);
  }, [fn.toString(), arg]);

// 画面の指定範囲（CSS px）に見えている確定済みの絵の画素（RGBA の平坦配列）
export const readMain = (page, x, y, w = 1, h = 1) =>
  page.evaluate(([x, y, w, h]) => Array.from(window.__paintBookmarklet.pixels(x, y, w, h).data), [x, y, w, h]);

// 画面の (x, y) に実際に重なっている面のタイル canvas を探して、その画素を直接読む。
// pixels() の座標計算に頼らず、「画面のその位置に本当に描かれているか」を確かめるためのもの
export const screenPixel = (page, x, y) => page.evaluate(([x, y]) => {
  const surf = document.querySelector('paint-bookmarklet-surface');
  const sr = surf.getBoundingClientRect();
  if (x < sr.left || y < sr.top || x >= sr.right || y >= sr.bottom) return [0, 0, 0, 0]; // 面の外は切り取られて見えない
  for (const c of surf.shadowRoot.querySelectorAll('canvas')) {
    const r = c.getBoundingClientRect();
    if (x < r.left || y < r.top || x >= r.right || y >= r.bottom) continue;
    const px = Math.floor((x - r.left) * c.width / r.width), py = Math.floor((y - r.top) * c.height / r.height);
    return Array.from(c.getContext('2d').getImageData(px, py, 1, 1).data);
  }
  return [0, 0, 0, 0];
}, [x, y]);
export const scrollTo = async (page, y) => {
  await page.evaluate(y => window.scrollTo(0, y), y);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())));
};

export const alphaStats = async (page, x, y, w, h) => {
  const d = await readMain(page, x, y, w, h);
  let sum = 0, mx = 0, n = 0;
  for (let i = 3; i < d.length; i += 4) { sum += d[i]; if (d[i] > mx) mx = d[i]; if (d[i]) n++; }
  return { sum, max: mx, count: n };
};

export async function drag(page, pts, steps = 1) {
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (let i = 1; i < pts.length; i++) await page.mouse.move(pts[i][0], pts[i][1], { steps });
  await page.mouse.up();
}

export const click = (page, sel) => shadowEval(page, (root, s) => root.querySelector(s).click(), sel);
export const toolOn = page => shadowEval(page, root => {
  const b = [...root.querySelectorAll('.bar .b.on')].find(x => !x.classList.contains('c'));
  return b ? b.title : null;
});
