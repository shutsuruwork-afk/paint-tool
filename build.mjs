// ビルド: src/paint.js を圧縮し、ブックマークレット URL とインストールページを生成する
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { minify } from 'terser';

const TERSER = {
  ecma: 2020,
  compress: { passes: 3, pure_getters: true, unsafe_arrows: true, unsafe_methods: true },
  mangle: { toplevel: true },
  // ASCII のみにすると URL エンコードで日本語が膨らまず、どのブラウザでも同じ文字列で保存される
  format: { ascii_only: true, comments: false, quote_style: 1 },
};
// javascript: URL として壊れる文字だけを最小限パーセントエンコードする
const toBookmarklet = c => {
  const b = 'javascript:' + c.replace(/[%#\s"]/g, ch => encodeURIComponent(ch));
  if (decodeURIComponent(b.slice(11)) !== c) throw new Error('bookmarklet round-trip failed');
  return b;
};

const src = await readFile('src/paint.js', 'utf8');
const { code } = await minify(src, TERSER);
const bookmarklet = toBookmarklet(code);
// 最小構成のコード（チェックポイントの画面にある機能だけ。2 は T-080、3 は T-083）。既定を受け取らないので、目印はない。
// インストールページの %%<mark>_HREF%%・%%<mark>_SIZE%%・%%<mark>_GZIP%%・%%INLINE_<mark>%% を置き換える
const MINS = [{ id: 'min', src: 'src/paint-min.js', mark: 'MIN' }, { id: 'min3', src: 'src/paint-min3.js', mark: 'MIN3' }];
for (const m of MINS) {
  m.text = await readFile(m.src, 'utf8');
  m.code = (await minify(m.text, TERSER)).code;
  m.bookmarklet = toBookmarklet(m.code);
  m.gz = gzipSync(m.code).length;
}

await mkdir('dist', { recursive: true });
await writeFile('dist/paint.min.js', code + '\n');
await writeFile('dist/bookmarklet.txt', bookmarklet + '\n');
for (const m of MINS) {
  await writeFile(`dist/paint-${m.id}.min.js`, m.code + '\n');
  await writeFile(`dist/bookmarklet-${m.id}.txt`, m.bookmarklet + '\n');
}

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
// 3 つ目が 'full' の行（ページ操作モード）は、シンプル版のインストールページには出さない（T-077）
const helpHtml = JSON.parse(hm[1]).map(([name, rows]) =>
  `<section class="help-g"><h3>${escHtml(name)}</h3><ul class="keys">` +
  rows.filter(r => r[2] !== 'full').map(([k, d]) => `<li${k.includes('{') ? '' : ' class="t"'}><span class="k">${rich(k)}</span><span>${rich(d)}</span></li>`).join('') +
  '</ul></section>').join('\n');
const kb = n => (n / 1024).toFixed(1) + ' KB';
const gz = gzipSync(code).length;
const tpl = await readFile('src/install.html', 'utf8');
// 置き換え後の文字列は必ず関数で渡す。文字列で渡すと、コードの中の "$&" などが置き換えの特殊な記号として解釈される
// （圧縮で変数名が $ になったときに、ボタンの中身が壊れたことがある）
let page = tpl
  .replaceAll('%%BOOKMARKLET_HREF%%', () => escAttr(bookmarklet))
  .replaceAll('%%SIZE%%', () => kb(bookmarklet.length))
  .replaceAll('%%GZIP%%', () => kb(gz))
  .replace('%%HELP%%', () => helpHtml)
  .replace('%%INLINE_CODE%%', () => inline.replace(/<\/(script)/gi, '<\\/$1'));
for (const m of MINS) {
  page = page
    .replaceAll(`%%${m.mark}_HREF%%`, () => escAttr(m.bookmarklet))
    .replaceAll(`%%${m.mark}_SIZE%%`, () => kb(m.bookmarklet.length))
    .replaceAll(`%%${m.mark}_GZIP%%`, () => kb(m.gz))
    .replace(`%%INLINE_${m.mark}%%`, () => m.code.replace(/<\/(script)/gi, '<\\/$1'));
}
// ボタンの href が、そのままブックマークレットになっているかを確かめる（最小構成は id="bm-min"・"bm-min3" の隠したリンクに置く）
const unesc = t => t.replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const hrefs = [...page.matchAll(/href="(javascript:[^"]*)"/g)].map(m => unesc(m[1]));
const all = [bookmarklet, ...MINS.map(m => m.bookmarklet)];
if (all.some(b => !hrefs.includes(b)) || hrefs.some(h => !all.includes(h))) throw new Error('install page bookmarklet href is corrupted');
// テンプレートは本文のみ（<title> と <style> から始まる）。GitHub Pages 用に文書として包む
await mkdir('docs', { recursive: true });
await writeFile('docs/index.html', `<!doctype html>\n<html lang="ja">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${page}</html>\n`);
// --page <path>: 本文のみの版も書き出す（埋め込み先が文書の骨組みを用意する場合用）
const pi = process.argv.indexOf('--page');
if (pi > 0) await writeFile(process.argv[pi + 1], page);

console.log(`src            ${kb(src.length)}`);
console.log(`paint.min.js   ${kb(code.length)} (gzip ${kb(gz)})`);
console.log(`bookmarklet    ${kb(bookmarklet.length)}`);
for (const m of MINS) console.log(`${m.id.padEnd(5)}: src ${kb(m.text.length)}  min.js ${kb(m.code.length)} (gzip ${kb(m.gz)})  bookmarklet ${kb(m.bookmarklet.length)}`);
