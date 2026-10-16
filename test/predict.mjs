// 録った入力（開発用の「入力を録る」で書き出した JSON。T-070）をまとめて見る。予測の精度を、人が実際に書いた線で比べるため（T-060）。
//   npm run predict -- paint-input-YYYYMMDD-HHMMSS.json [...]
// 線ごとに、点の間隔・フレームの間隔・処理までの遅れと、入力を受け取った時点から H ms 先のペン先と各予測とのずれ（CSS px）を出す。
// 予測: なし（最後の点のまま）/ Chrome（その入力の getPredictedEvents。予測点の先は伸ばさない）/ 直線（本体の外挿と同じ速度のならし、40px まで）
import { readFileSync } from 'node:fs';

const HS = [8, 16, 24, 33]; // 何 ms 先のペン先と比べるか
const files = process.argv.slice(2);
if (!files.length) { console.error('usage: npm run predict -- <paint-input-*.json> ...'); process.exit(1); }

const med = a => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
const pct = (a, q) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * q))]; };
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const f1 = v => Number.isFinite(v) ? v.toFixed(1) : '—';

// 時刻 t のペン先（点の並びを直線でつなぐ）。範囲の外は null
function at(P, t) {
  if (!P.length || t < P[0].t || t > P[P.length - 1].t) return null;
  let lo = 0, hi = P.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m].t <= t) lo = m; else hi = m; }
  const a = P[lo], b = P[hi], u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  return [a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u];
}

export function analyze(data) {
  const out = [];
  for (const s of data.strokes) {
    const R = [];
    for (let i = 0; i < s.rows.length; i += 6) R.push({ k: s.rows[i], t: s.rows[i + 1], x: s.rows[i + 2], y: s.rows[i + 3], p: s.rows[i + 4], h: s.rows[i + 5] });
    // 入力の点（押す・中の点。中の点がない環境では、入力そのもの）を時刻で並べ、同じ時刻は 1 つにする
    const heads = [], frames = [], pts = [];
    let cur = null;
    for (const r of R) {
      if (r.k === 6) { frames.push(r); continue; }
      if (r.k <= 3) { cur = { ...r, co: [], pr: [] }; heads.push(cur); if (r.k === 0) pts.push(r); continue; }
      if (!cur) continue;
      (r.k === 4 ? cur.co : cur.pr).push(r);
    }
    for (const h of heads) if (h.k) { if (h.co.length) pts.push(...h.co); else pts.push(h); }
    pts.sort((a, b) => a.t - b.t);
    const P = pts.filter((p, i) => i === 0 || p.t > pts[i - 1].t);
    const dts = P.slice(1).map((p, i) => p.t - P[i].t);
    const fdt = frames.slice(1).map((f, i) => f.t - frames[i].t).filter(d => d > 0 && d < 100);
    const lag = heads.filter(h => h.k === 1 || h.k === 2).map(h => h.h - h.t).filter(v => v >= 0);
    // 入力ごとに、そのとき分かっている最後の点から H ms 先と比べる
    const err = { none: HS.map(() => []), chrome: HS.map(() => []), linear: HS.map(() => []) };
    const horizon = [];
    let vx = 0, vy = 0, li = 0;
    for (const h of heads) {
      if (h.k !== 1 && h.k !== 2) continue;
      // 本体の inkMove と同じ速度のならし（新しい点ごとに半分ずつ寄せる）
      while (li + 1 < P.length && P[li + 1].t <= h.t) {
        const a = P[li], b = P[li + 1], dt = b.t - a.t;
        if (dt > 0.5) { vx += ((b.x - a.x) / dt - vx) * 0.5; vy += ((b.y - a.y) / dt - vy) * 0.5; }
        li++;
      }
      const L = P[li];
      if (!L || L.t > h.t) continue;
      const pr = h.pr.filter(q => q.t > L.t);
      if (pr.length) horizon.push(pr[pr.length - 1].t - L.t);
      HS.forEach((H, j) => {
        const A = at(P, L.t + H);
        if (!A) return;
        const d = (x, y) => Math.hypot(x - A[0], y - A[1]);
        err.none[j].push(d(L.x, L.y));
        let lx = vx * H, ly = vy * H;
        const m = Math.hypot(lx, ly);
        if (m > 40) { lx *= 40 / m; ly *= 40 / m; }
        err.linear[j].push(d(L.x + lx, L.y + ly));
        if (pr.length) {
          // Chrome の予測点を時刻でたどる（最後の予測点より先は、そこで止める）
          const Q = [L, ...pr];
          const C = L.t + H >= Q[Q.length - 1].t ? [Q[Q.length - 1].x, Q[Q.length - 1].y] : at(Q, L.t + H);
          err.chrome[j].push(d(C[0], C[1]));
        }
      });
    }
    const dur = P.length ? P[P.length - 1].t - P[0].t : 0;
    let len = 0;
    for (let i = 1; i < P.length; i++) len += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
    out.push({ tool: s.tool, pen: s.pen, type: s.type, dur, len, n: P.length, dt: med(dts), fdt: med(fdt), lag: med(lag), horizon: med(horizon), err });
  }
  return out;
}

for (const f of files) {
  const data = JSON.parse(readFileSync(f, 'utf8'));
  console.log(`\n■ ${f}`);
  console.log(`  版 ${data.app}・dpr ${data.dpr}・画面 ${data.vw}×${data.vh}・rawupdate ${data.rawupdate ? 'あり' : 'なし'}・coalesced ${data.coalesced ? 'あり' : 'なし'}・Ink Trail ${data.inkTrail ? 'あり' : 'なし'}`);
  console.log(`  ${data.ua}`);
  const res = analyze(data);
  console.log('  線  道具（入力）          長さ   時間   点の間隔  フレーム  処理の遅れ  Chrome の予測の先');
  res.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}  ${(r.tool + (r.pen && r.pen !== 'pen' ? '/' + r.pen : '') + '（' + r.type + '）').padEnd(18)} ${f1(r.len).padStart(6)}px ${f1(r.dur).padStart(6)}ms ${f1(r.dt).padStart(6)}ms ${f1(r.fdt).padStart(6)}ms ${f1(r.lag).padStart(7)}ms ${f1(r.horizon).padStart(9)}ms`));
  // すべての線をまとめた、H ms 先とのずれ（平均 / 90%）
  console.log('\n  H ms 先のペン先とのずれ（CSS px、平均 / 90%）');
  console.log('  予測     ' + HS.map(H => `${H} ms`.padStart(14)).join(''));
  for (const k of ['none', 'chrome', 'linear']) {
    const cells = HS.map((_, j) => { const a = res.flatMap(r => r.err[k][j]); return a.length ? `${f1(mean(a))} / ${f1(pct(a, 0.9))}`.padStart(14) : '—'.padStart(14); });
    console.log(`  ${({ none: 'なし', chrome: 'Chrome', linear: '直線' })[k].padEnd(7)}` + cells.join(''));
  }
}
