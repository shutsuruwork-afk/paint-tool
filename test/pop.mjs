// 蛍光ペンの先端の「ぴょこぴょこ」を測る（T-055）。
// 入力ごとに見えている画素（live ∪ pred）を取り、前の入力で見えていて次の入力で消えた画素を数える（一度描いた所は消えないのが理想）。
// あわせて、16 ms・33 ms 後のペン先から線までの隙間（予測で埋めたい遅れ）を測る。
// 合成のイベントに 8 ms 刻みの timeStamp を与える（計測にかかる時間で速さが狂わないように）。座標は整数、時間は ±1.5 ms ぶらす
import { CODE, startServer, launch, withDefaults } from './helpers.mjs';

const { srv, base } = await startServer();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
await page.goto(base + '/');
for (const mpred of ['need', 'off', 'full']) {
  const r = await page.evaluate(async code => {
    if (window.__paintBookmarklet) window.__paintBookmarklet.destroy();
    (0, eval)(code);
    await new Promise(r => setTimeout(r, 200));
    const api = window.__paintBookmarklet, root = document.querySelector('paint-bookmarklet').shadowRoot;
    const pad = root.querySelector('.p'), lv = root.querySelector('canvas.l'), pr = root.querySelector('canvas.q');
    const DT = 8;
    const arc = (v, r, ms) => { const pts = []; for (let t = 0; t <= ms; t += DT) { const a = (v * t / 1000) / r; pts.push([500 + r * Math.sin(a), 400 - r * Math.cos(a)]); } return pts; };
    const zigzag = v => {
      const pts = [], cs = [[250, 200], [450, 200], [450, 400], [650, 400], [650, 600]];
      let seg = 0, pos = [...cs[0]];
      pts.push([...pos]);
      while (seg < cs.length - 1) {
        let left = v * DT / 1000;
        while (left > 0 && seg < cs.length - 1) {
          const [tx, ty] = cs[seg + 1], dx = tx - pos[0], dy = ty - pos[1], d = Math.hypot(dx, dy);
          if (d <= left) { pos = [tx, ty]; left -= d; seg++; } else { pos = [pos[0] + dx / d * left, pos[1] + dy / d * left]; left = 0; }
        }
        pts.push([...pos]);
      }
      return pts;
    };
    const paths = { 'slow arc   150 px/s': arc(150, 120, 2500), 'arc        600 px/s': arc(600, 140, 1400), 'circle    1500 px/s': arc(1500, 150, 640), 'zigzag    1500 px/s': zigzag(1500) };
    const ev = (type, x, y, ts, extra) => {
      const e = new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 9, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0, buttons: 1, ...extra });
      Object.defineProperty(e, 'timeStamp', { value: ts });
      return e;
    };
    const X0 = 150, Y0 = 100, WW = 650, HH = 650;
    const mask = () => {
      const a = lv.getContext('2d').getImageData(X0, Y0, WW, HH).data, c = pr.getContext('2d').getImageData(X0, Y0, WW, HH).data, m = new Uint8Array(WW * HH);
      for (let i = 0, j = 3; i < m.length; i++, j += 4) m[i] = a[j] > 10 || c[j] > 10 ? 1 : 0;
      return m;
    };
    const gap = (m, x, y) => {
      const cx = Math.round(x) - X0, cy = Math.round(y) - Y0;
      for (let r = 0; r <= 40; r++) for (let yy = cy - r; yy <= cy + r; yy++) for (let xx = cx - r; xx <= cx + r; xx++) {
        if (Math.max(Math.abs(xx - cx), Math.abs(yy - cy)) !== r) continue;
        if (xx >= 0 && yy >= 0 && xx < WW && yy < HH && m[yy * WW + xx]) return Math.hypot(xx - cx, yy - cy);
      }
      return 40;
    };
    const out = {};
    for (const [name, pts] of Object.entries(paths)) {
      api.clear(); api.tool('marker');
      const T0 = performance.now() + 1000, q = Math.round;
      pad.dispatchEvent(ev('pointerdown', q(pts[0][0]), q(pts[0][1]), T0));
      let prev = mask(), lost = 0, g16 = 0, g33 = 0, n = 0;
      for (let k = 1; k < pts.length; k++) {
        pad.dispatchEvent(ev('pointermove', q(pts[k][0]), q(pts[k][1]), T0 + k * DT + ((k * 7919) % 31) / 10 - 1.5));
        const m = mask();
        for (let i = 0; i < m.length; i++) if (prev[i] && !m[i]) lost++;
        const f2 = pts[Math.min(pts.length - 1, k + 2)], f4 = pts[Math.min(pts.length - 1, k + 4)];
        g16 += gap(m, f2[0], f2[1]); g33 += gap(m, f4[0], f4[1]); n++;
        prev = m;
      }
      pad.dispatchEvent(ev('pointerup', q(pts.at(-1)[0]), q(pts.at(-1)[1]), T0 + pts.length * DT, { buttons: 0 }));
      out[name] = [lost / n, g16 / n, g33 / n];
    }
    return out;
  }, withDefaults(CODE, { mpred }));
  console.log(`\n■ 蛍光ペンの予測: ${mpred}（太さ 24px、1x）`);
  console.log('  経路（速さ）           消える画素/入力  16 ms 後の隙間  33 ms 後の隙間');
  for (const [k, [l, a, b]] of Object.entries(r)) console.log(`  ${k}  ${l.toFixed(1).padStart(12)}  ${a.toFixed(1).padStart(11)} px  ${b.toFixed(1).padStart(11)} px`);
}
await browser.close();
srv.close();
