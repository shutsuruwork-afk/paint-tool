// 性能計測。入力遅延に効くのは「メインスレッドを塞ぐ時間」なので、それを測る
// （Chrome の Canvas 2D は描画命令を記録するだけで、ラスタライズは GPU プロセスで非同期に行われる）。
// 比較対象として「毎イベントでパス全体を描き直す」素朴な実装も同じ入力で測る。
import { CODE, startServer, launch } from './helpers.mjs';

const N = Number(process.env.N || 3000);
const { srv, base } = await startServer();
const browser = await launch();
const results = [];

for (const dpr of [1, 2]) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: dpr });
  await page.goto(base + '/');
  const r = await page.evaluate(async ([code, N]) => {
    const frame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
    const t0 = performance.now();
    (0, eval)(code);
    const init = performance.now() - t0;
    const api = window.__paintBookmarklet;
    const root = document.querySelector('paint-bookmarklet').shadowRoot;
    const pad = root.querySelector('.p'), main = root.querySelector('canvas.l');
    await new Promise(r => setTimeout(r, 100));
    const ev = (type, [x, y], extra) => new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, pointerId: 9, pointerType: 'pen', isPrimary: true,
      clientX: x, clientY: y, pressure: 0.6 + 0.3 * Math.sin(x / 40), button: type === 'pointermove' ? -1 : 0, buttons: 1, ...extra,
    });
    const shapes = {
      '手書き風': i => [150 + i * 0.5 + Math.sin(i / 6) * 18, 500 + Math.cos(i / 9) * 30],
      '長い対角線': i => [100 + i * 0.55, 100 + i * 0.3],
      '密な塗り込み': i => [200 + (i * 0.5) % 1500, 300 + Math.sin(i / 40) * 250],
    };
    // JIT が最適化を終えるまでの初回の揺らぎを除くため、計測しない準備ストロークを 1 本描く
    // （取り消すと次の確定で redo 履歴が解放され、履歴メモリの差分が狂うので残しておく）
    pad.dispatchEvent(ev('pointerdown', [300, 900]));
    for (let i = 0; i < 2000; i++) pad.dispatchEvent(ev('pointermove', [300 + (i % 400), 900 + (i % 97)]));
    pad.dispatchEvent(ev('pointerup', [300, 900], { buttons: 0 }));
    await frame();
    const strokes = [];
    for (const [name, f] of Object.entries(shapes)) {
      const pts = Array.from({ length: N }, (_, i) => f(i));
      const hp0 = api.stats().historyPixels;
      pad.dispatchEvent(ev('pointerdown', pts[0]));
      // timeStamp は生成時刻なので pointerdown の後に生成する（古い時刻の入力は重複として捨てられる）
      const evs = pts.map(p => ev('pointermove', p));
      let t = performance.now();
      for (let i = 1; i < N; i++) pad.dispatchEvent(evs[i]);
      const move = (performance.now() - t) / (N - 1) * 1000;
      // 3,000 点を 1 タスクで流し込んだ分の GPU 描画を済ませてから確定を測る（実際の入力では毎フレーム消化される）
      main.getContext('2d').getImageData(0, 0, 1, 1);
      await frame();
      t = performance.now();
      pad.dispatchEvent(ev('pointerup', pts[N - 1], { buttons: 0 }));
      const commit = performance.now() - t;
      // 確定で積んだタイルへの描画を済ませてから元に戻すを測る（実際の操作では、確定から元に戻すまでに何フレームも空く）
      api.pixels(0, 0, innerWidth, innerHeight);
      await frame();
      t = performance.now();
      api.undo();
      const undo = performance.now() - t;
      api.pixels(0, 0, innerWidth, innerHeight);
      await frame();
      api.redo();
      api.pixels(0, 0, innerWidth, innerHeight);
      await frame();
      const xs = pts.map(p => p[0] * devicePixelRatio), ys = pts.map(p => p[1] * devicePixelRatio), w = 4 * devicePixelRatio + 4;
      const bbox = (Math.max(...xs) - Math.min(...xs) + w) * (Math.max(...ys) - Math.min(...ys) + w);
      strokes.push({ name, move, commit, undo, tilesPx: api.stats().historyPixels - hp0, bbox });
    }

    // 素朴な実装: 毎イベントでキャンバス全体をクリアしてパス全体を再描画
    const nc = document.createElement('canvas');
    nc.width = main.width; nc.height = main.height;
    const nx = nc.getContext('2d');
    nx.lineCap = nx.lineJoin = 'round'; nx.lineWidth = 4 * devicePixelRatio; nx.strokeStyle = '#e53935';
    const f = shapes['手書き風'], path = [];
    let t = performance.now();
    for (let i = 0; i < N; i++) {
      const [x, y] = f(i);
      path.push(x * devicePixelRatio, y * devicePixelRatio);
      nx.clearRect(0, 0, nc.width, nc.height);
      nx.beginPath();
      nx.moveTo(path[0], path[1]);
      for (let k = 2; k < path.length; k += 2) nx.lineTo(path[k], path[k + 1]);
      nx.stroke();
    }
    const naive = (performance.now() - t) / N * 1000;

    // 3 本のストロークが残った状態で、その周囲（ほぼ全画面）を塗りつぶす
    api.tool('fill');
    api.pixels(0, 0, innerWidth, innerHeight);
    await frame();
    t = performance.now();
    pad.dispatchEvent(ev('pointerdown', [5, 5], { pointerType: 'mouse', pointerId: 1 }));
    const fill = performance.now() - t;
    return { init, strokes, naive, fill, w: main.width, h: main.height };
  }, [CODE, N]);
  results.push({ dpr, ...r });
  await page.close();
}
await browser.close();
srv.close();

const f = (v, d = 1) => v.toFixed(d).padStart(7);
console.log(`N=${N} 点のペンストローク（筆圧あり）。数値はメインスレッドの占有時間`);
for (const r of results) {
  console.log(`\n■ 1920×1080 @${r.dpr}x（キャンバス ${r.w}×${r.h}）  起動 ${r.init.toFixed(1)} ms  背景の塗りつぶし ${r.fill.toFixed(0)} ms`);
  console.log('  ストローク        入力1件     確定      undo     履歴メモリ（外接矩形比）');
  for (const s of r.strokes) {
    console.log(`  ${s.name.padEnd(8, '　')}  ${f(s.move, 2)} µs ${f(s.commit, 2)} ms ${f(s.undo, 2)} ms   ${f(s.tilesPx / 1e6, 2)} MP（${(s.tilesPx / s.bbox * 100).toFixed(0)}%）`);
  }
  const ours = r.strokes[0].move;
  console.log(`  参考: 毎回全体を再描画する素朴な実装  ${f(r.naive, 1)} µs/件（本ツールの ${(r.naive / ours).toFixed(0)} 倍、点数に比例して増加）`);
}
