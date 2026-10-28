// ビルド: src/paint.js を圧縮し、ブックマークレット URL とインストールページを生成する
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { minify } from 'terser';

const src = await readFile('src/paint.js', 'utf8');
const { code } = await minify(src, {
  ecma: 2020,
  compress: { passes: 3, pure_getters: true, unsafe_arrows: true, unsafe_methods: true },
  mangle: { toplevel: true },
  // ASCII のみにすると URL エンコードで日本語が膨らまず、どのブラウザでも同じ文字列で保存される
  format: { ascii_only: true, comments: false, quote_style: 1 },
});

// javascript: URL として壊れる文字だけを最小限パーセントエンコードする
const bookmarklet = 'javascript:' + code.replace(/[%#\s"]/g, c => encodeURIComponent(c));
if (decodeURIComponent(bookmarklet.slice(11)) !== code) throw new Error('bookmarklet round-trip failed');

await mkdir('dist', { recursive: true });
await writeFile('dist/paint.min.js', code + '\n');
await writeFile('dist/bookmarklet.txt', bookmarklet + '\n');

// インストールページの「このページで試す」用。既定の文字列を、ページが渡す変数を読む式に変える（eval を使わないため）
const MARK = /'__PAINT_DEFAULTS__'/g;
if ((code.match(MARK) || []).length !== 1) throw new Error('defaults marker must appear exactly once');
const inline = code.replace(MARK, "(window.__paintBookmarkletDefaults||'')");

const escAttr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// 操作の一覧: src/paint.js の HELP（/*HELP*/ の間は JSON）を、インストールページにも同じ内容で書き出す
const hm = src.match(/\/\*HELP\*\/([\s\S]*?)\/\*HELP\*\//);
if (!hm) throw new Error('HELP list not found in src/paint.js');
const rich = t => t.split(/\{([^}]*)\}/).map((x, i) => (i % 2 ? `<kbd>${escHtml(x)}</kbd>` : escHtml(x))).join('');
const helpHtml = JSON.parse(hm[1]).map(([name, rows]) =>
  `<section class="help-g"><h3>${escHtml(name)}</h3><ul class="keys">` +
  rows.map(([k, d]) => `<li${k.includes('{') ? '' : ' class="t"'}><span class="k">${rich(k)}</span><span>${rich(d)}</span></li>`).join('') +
  '</ul></section>').join('\n');
const kb = n => (n / 1024).toFixed(1) + ' KB';
const gz = gzipSync(code).length;
const tpl = await readFile('src/install.html', 'utf8');
// 置き換え後の文字列は必ず関数で渡す。文字列で渡すと、コードの中の "$&" などが置き換えの特殊な記号として解釈される
// （圧縮で変数名が $ になったときに、ボタンの中身が壊れたことがある）
const page = tpl
  .replaceAll('%%BOOKMARKLET_HREF%%', () => escAttr(bookmarklet))
  .replaceAll('%%SIZE%%', () => kb(bookmarklet.length))
  .replaceAll('%%GZIP%%', () => kb(gz))
  .replace('%%HELP%%', () => helpHtml)
  .replace('%%INLINE_CODE%%', () => inline.replace(/<\/(script)/gi, '<\\/$1'));
// ボタンの href が、そのままブックマークレットになっているかを確かめる
const unesc = t => t.replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const hrefs = [...page.matchAll(/href="(javascript:[^"]*)"/g)].map(m => unesc(m[1]));
if (!hrefs.length || hrefs.some(h => h !== bookmarklet)) throw new Error('install page bookmarklet href is corrupted');
// テンプレートは本文のみ（<title> と <style> から始まる）。GitHub Pages 用に文書として包む
await mkdir('docs', { recursive: true });
await writeFile('docs/index.html', `<!doctype html>\n<html lang="ja">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${page}</html>\n`);
// --page <path>: 本文のみの版も書き出す（埋め込み先が文書の骨組みを用意する場合用）
const pi = process.argv.indexOf('--page');
if (pi > 0) await writeFile(process.argv[pi + 1], page);

console.log(`src            ${kb(src.length)}`);
console.log(`paint.min.js   ${kb(code.length)} (gzip ${kb(gz)})`);
console.log(`bookmarklet    ${kb(bookmarklet.length)}`);
