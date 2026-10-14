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

const escAttr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const kb = n => (n / 1024).toFixed(1) + ' KB';
const gz = gzipSync(code).length;
const tpl = await readFile('src/install.html', 'utf8');
const page = tpl
  .replaceAll('%%BOOKMARKLET_HREF%%', escAttr(bookmarklet))
  .replaceAll('%%SIZE%%', kb(bookmarklet.length))
  .replaceAll('%%GZIP%%', kb(gz))
  .replace('%%INLINE_CODE%%', () => code.replace(/<\/(script)/gi, '<\\/$1'));
// テンプレートは本文のみ（<title> と <style> から始まる）。GitHub Pages 用に文書として包む
await mkdir('docs', { recursive: true });
await writeFile('docs/index.html', `<!doctype html>\n<html lang="ja">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${page}</html>\n`);
// --page <path>: 本文のみの版も書き出す（埋め込み先が文書の骨組みを用意する場合用）
const pi = process.argv.indexOf('--page');
if (pi > 0) await writeFile(process.argv[pi + 1], page);

console.log(`src            ${kb(src.length)}`);
console.log(`paint.min.js   ${kb(code.length)} (gzip ${kb(gz)})`);
console.log(`bookmarklet    ${kb(bookmarklet.length)}`);
