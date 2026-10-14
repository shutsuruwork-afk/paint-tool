import http from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

export const CODE = readFileSync(new URL('../dist/paint.min.js', import.meta.url), 'utf8');
export const BOOKMARKLET = readFileSync(new URL('../dist/bookmarklet.txt', import.meta.url), 'utf8').trim();

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>test</title></head>
<body style="margin:0;font:16px sans-serif"><h1>Sample</h1><p>${'Lorem ipsum dolor sit amet. '.repeat(30)}</p>
<input id="inp"></body></html>`;

// 厳格な CSP + Trusted Types を課したページ（インライン style / data: 画像 / innerHTML が使えない）
const STRICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; " +
  "require-trusted-types-for 'script'; trusted-types 'none'";

export async function startServer() {
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url.startsWith('/strict')) res.setHeader('content-security-policy', STRICT_CSP);
    res.end(PAGE);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { srv, base: `http://localhost:${srv.address().port}` };
}

export async function launch() {
  return chromium.launch();
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

export const shadowEval = (page, fn, arg) =>
  page.evaluate(([src, a]) => {
    const root = document.querySelector('paint-bookmarklet').shadowRoot;
    return new Function('root', 'a', `return (${src})(root, a)`)(root, a);
  }, [fn.toString(), arg]);

// main キャンバスの指定範囲の画素 (RGBA 配列の集計) を返す
export const readMain = (page, x, y, w = 1, h = 1) =>
  shadowEval(page, (root, [x, y, w, h]) => {
    const c = root.querySelector('canvas.m');
    return Array.from(c.getContext('2d').getImageData(x, y, w, h).data);
  }, [x, y, w, h]);

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
