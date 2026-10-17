// 録った入力（開発用の「入力を録る」で書き出した JSON。T-070）で、予測の方法を比べる（T-060）。
//   npm run predict -- paint-input-YYYYMMDD-HHMMSS.json [...]
// 線ごとに、点の間隔・フレームの間隔・処理までの遅れを出し、予測の方法ごとに次の 2 つを出す（CSS px）。
//   遅れ: 入力の時点から 1 フレーム後（録画のフレームの間隔）の実際のペン先と、描いた予測の先との距離（小さいほどペン先に付いてくる）
//   はみ出し: 描いた予測の点が、実際にこの後 150 ms に通る線から外れた距離（大きいほど、後で消える線〈ぴょこぴょこ〉が出る）
//   点滅: 動いている途中に、予測線を消す判定（止まったとみなす）が効いたフレームの数（前の判定と今の判定。パソコンが重いと増える）
//   消える長さ: 前の入力で描いた予測のうち、次の入力で描いた物（そこまでの線と新しい予測）から 1px より離れた所の長さ（入力ごと。ぴょこぴょこそのもの）
// 入力は処理した順にたどり、そのとき本体が知っている点（pointerrawupdate が pointermove より先に新しい点を運ぶ）から予測する。
// 予測: なし / ブラウザ（本体の前の方式。pointermove の getPredictedEvents を入れ替え、rawupdate では前の予測点の先の部分を描く）/
//       曲がりに沿う（本体の ownPred と同じ計算）/ 直線（速度を半分ずつならして 1 フレーム先へ。40px まで）
import { readFileSync } from 'node:fs';

const PW = 32, PCAP = 40, PDAMP = 2; // src/paint.js の ownPred と同じ値

const med = a => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
const pct = (a, q) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * q))]; };
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const f1 = v => Number.isFinite(v) ? v.toFixed(1) : '—';

// 時刻 t のペン先（点の並びを直線でつなぐ。範囲の外は端）
function at(P, t) {
  if (t <= P[0].t) return [P[0].x, P[0].y];
  if (t >= P[P.length - 1].t) return [P[P.length - 1].x, P[P.length - 1].y];
  let lo = 0, hi = P.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m].t <= t) lo = m; else hi = m; }
  const a = P[lo], b = P[hi], u = (t - a.t) / (b.t - a.t);
  return [a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u];
}
// 点から、時刻 [t0, t1] に通る線（折れ線）までの距離
function distPath(P, t0, t1, x, y) {
  let i = 0;
  while (i < P.length && P[i].t < t0) i++;
  let [ax, ay] = at(P, t0), best = Infinity;
  for (; i < P.length && P[i].t <= t1; i++) {
    const bx = P[i].x, by = P[i].y, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const u = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(ax + dx * u - x, ay + dy * u - y));
    ax = bx; ay = by;
  }
  return Math.min(best, Math.hypot(ax - x, ay - y));
}

// 点から折れ線 Q（[{x, y}...]）までの距離
function distPoly(Q, x, y) {
  let best = Math.hypot(Q[0].x - x, Q[0].y - y);
  for (let i = 1; i < Q.length; i++) {
    const a = Q[i - 1], b = Q[i], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const u = L2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(a.x + dx * u - x, a.y + dy * u - y));
  }
  return best;
}
// 前の入力で描いた予測（折れ線 A）のうち、次の入力で描いた物（折れ線 B）から 1px より離れた所の長さ（消える線）
function lost(A, B) {
  let n = 0;
  for (let i = 1; i < A.length; i++) {
    const a = A[i - 1], b = A[i], d = Math.hypot(b.x - a.x, b.y - a.y), k = Math.ceil(d);
    for (let j = 1; j <= k; j++) if (distPoly(B, a.x + (b.x - a.x) * j / k, a.y + (b.y - a.y) * j / k) > 1) n += d / k;
  }
  return n;
}

// 曲がりに沿う予測（src/paint.js の ownPred と同じ計算。H は先の時間〈1 フレーム〉、点は CSS px）
export function ownPred(hist, H) {
  const L = hist[hist.length - 1];
  let n = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, x0 = 0, x1 = 0, x2 = 0, y0 = 0, y1 = 0, y2 = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    const t = hist[i].t - L.t;
    if (t < -PW && (n >= 3 || t < -100)) break;
    const x = hist[i].x - L.x, y = hist[i].y - L.y, tt = t * t;
    n++; s1 += t; s2 += tt; s3 += tt * t; s4 += tt * tt;
    x0 += x; x1 += x * t; x2 += x * tt; y0 += y; y1 += y * t; y2 += y * tt;
  }
  if (n < 3) return [];
  const d = n * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (Math.abs(d) < 1e-9) return [];
  const vx = (n * (x1 * s4 - s3 * x2) - x0 * (s1 * s4 - s3 * s2) + s2 * (s1 * x2 - x1 * s2)) / d;
  const vy = (n * (y1 * s4 - s3 * y2) - y0 * (s1 * s4 - s3 * s2) + s2 * (s1 * y2 - y1 * s2)) / d;
  const ax = 2 * (n * (s2 * x2 - x1 * s3) - s1 * (s1 * x2 - x1 * s2) + x0 * (s1 * s3 - s2 * s2)) / d;
  const ay = 2 * (n * (s2 * y2 - y1 * s3) - s1 * (s1 * y2 - y1 * s2) + y0 * (s1 * s3 - s2 * s2)) / d;
  const v2 = vx * vx + vy * vy;
  if (v2 < 1e-6) return [];
  const sp = Math.sqrt(v2), w = (vx * ay - vy * ax) / v2, acc = Math.min(0, (vx * ax + vy * ay) / sp);
  const h = H / (1 + PDAMP * Math.abs(w) * H), dt = h / 6, out = [];
  let x = L.x, y = L.y, th = Math.atan2(vy, vx), s = sp, dist = 0;
  for (let i = 0; i < 6; i++) {
    s = Math.max(0, s + acc * dt); th += w * dt;
    const st = Math.min(s * dt, PCAP - dist);
    if (st <= 0) break;
    x += Math.cos(th) * st; y += Math.sin(th) * st; dist += st;
    if (i === 2 || i === 5) out.push({ t: L.t + (i + 1) * dt, x, y });
  }
  if (dist > 0 && (!out.length || out[out.length - 1].x !== x || out[out.length - 1].y !== y)) out.push({ t: L.t + h, x, y });
  return out;
}

// 予測線を消す判定（本体の tick）を、処理した順にたどる。動いている途中（このフレームの 30 ms 後までに次に動いた点がある）に消えたフレームを数える。
//   前の判定: フレームの時刻 − 最後に動いた点の時刻 > 40 ms。今の判定（T-087）: 入力が届くまでの遅れ dl を足す。止まった点が 40 ms 続けば待たない
// あわせて、フレームまでに新しく届いた点のうち一番古い点が待った時間（届くまでの遅れ）を集める
function blinks(R) {
  const P = R.filter(r => r.k === 4 || r.k === 0).sort((a, b) => a.t - b.t), end = R.find(r => r.k === 3)?.t ?? Infinity;
  const o = { moving: 0, old: 0, now: 0, wait: [] };
  let lt = -1e9, lastT = -1e9, bx = NaN, by = NaN, fT = 0, dl = 0, pOld = false, pNow = false, j = 0;
  for (const r of R) {
    if (r.k === 0 || r.k === 4) {
      if (r.t > lastT && !fT) fT = r.t;
      if (r.t >= lastT) lastT = r.t;
      if (r.t >= lt && (r.x !== bx || r.y !== by)) { lt = r.t; bx = r.x; by = r.y; }
    }
    if (r.k === 1 || r.k === 2) pOld = pNow = true; // 入力ごとに予測を描き直す
    if (r.k !== 6) continue;
    const ts = r.t;
    if (fT) { const g = ts - fT; o.wait.push(g); if (g < 500) dl = g > dl ? g : dl + (g - dl) * 0.05; fT = 0; }
    if (ts > end) continue;
    while (j < P.length && (P[j].t <= lt || (P[j].x === bx && P[j].y === by))) j++;
    const mv = j < P.length && P[j].t <= ts + 30;
    if (mv) o.moving++;
    if (pOld && ts - lt > 40) { pOld = false; if (mv) o.old++; }
    if (pNow && (ts - lt > 40 + dl || lastT - lt > 40)) { pNow = false; if (mv) o.now++; }
  }
  return o;
}

export function analyze(data) {
  const out = [];
  for (const s of data.strokes) {
    const R = [];
    for (let i = 0; i < s.rows.length; i += 6) R.push({ k: s.rows[i], t: s.rows[i + 1], x: s.rows[i + 2], y: s.rows[i + 3], p: s.rows[i + 4], h: s.rows[i + 5] });
    // 入力（押す・中の点。中の点がない環境では入力そのもの）を時刻で並べ、同じ時刻は 1 つにする
    const heads = [], frames = [], pts = [];
    let cur = null;
    for (const r of R) {
      if (r.k === 6) { frames.push(r); continue; }
      if (r.k <= 3) { cur = { ...r, co: [], pr: [] }; heads.push(cur); if (r.k === 0) pts.push(r); continue; }
      if (cur) (r.k === 4 ? cur.co : cur.pr).push(r);
    }
    for (const h of heads) if (h.k) { if (h.co.length) pts.push(...h.co); else pts.push(h); }
    pts.sort((a, b) => a.t - b.t);
    const P = pts.filter((p, i) => i === 0 || p.t > pts[i - 1].t);
    const fdt = frames.slice(1).map((f, i) => f.t - frames[i].t).filter(d => d > 0 && d < 100);
    const H = med(fdt) || 16.7; // 1 フレーム先
    const lag = heads.filter(h => h.k === 1 || h.k === 2).map(h => h.h - h.t).filter(v => v >= 0);
    const res = {}, prev = {};
    for (const k of ['none', 'chrome', 'own', 'linear']) res[k] = { lag: [], off: [], lost: [] };
    const horizon = [];
    let li = 0, pli = 0, tKnown = -1e9, lastPr = [], vx = 0, vy = 0;
    for (const h of heads) {
      if (h.k !== 1 && h.k !== 2) continue;
      tKnown = Math.max(tKnown, h.t);
      while (li + 1 < P.length && P[li + 1].t <= tKnown) {
        const a = P[li], b = P[li + 1], dt = b.t - a.t;
        if (dt > 0.5) { vx += ((b.x - a.x) / dt - vx) * 0.5; vy += ((b.y - a.y) / dt - vy) * 0.5; }
        li++;
      }
      if (h.k === 1) { lastPr = h.pr; if (h.pr.length) horizon.push(h.pr[h.pr.length - 1].t - h.t); }
      const L = P[li];
      if (!L || L.t + H > P[P.length - 1].t) continue;
      const A = at(P, L.t + H), drawn = P.slice(Math.max(0, pli - 8), li + 1);
      const score = (k, pr) => {
        // pr: 描く予測の点（L から先）。先は 1 フレーム後の時刻で取る（予測がそこまで届かなければ最後の点）
        const Q = [L, ...pr], tip = pr.length ? at(Q, Math.min(L.t + H, Q[Q.length - 1].t)) : [L.x, L.y];
        res[k].lag.push(Math.hypot(tip[0] - A[0], tip[1] - A[1]));
        let o = 0;
        for (const q of pr) o = Math.max(o, distPath(P, L.t, L.t + 150, q.x, q.y));
        res[k].off.push(o);
        // 前の入力の予測のうち、今の入力で描いた物（ここまでの線と今の予測）に覆われない所は消える
        const B = [...drawn, ...pr];
        if (prev[k]) res[k].lost.push(lost(prev[k], B));
        prev[k] = [L, ...pr];
      };
      score('none', []);
      score('chrome', lastPr.filter(q => q.t > L.t));
      score('own', ownPred(P.slice(Math.max(0, li - 63), li + 1), H));
      let dx = vx * H, dy = vy * H;
      const m = Math.hypot(dx, dy);
      if (m > 40) { dx *= 40 / m; dy *= 40 / m; }
      score('linear', m > 0 ? [{ t: L.t + H, x: L.x + dx, y: L.y + dy }] : []);
      pli = li;
    }
    let len = 0;
    for (let i = 1; i < P.length; i++) len += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
    out.push({
      tool: s.tool, pen: s.pen, type: s.type, len, dur: P.length ? P[P.length - 1].t - P[0].t : 0,
      dt: med(P.slice(1).map((p, i) => p.t - P[i].t)), fdt: H, lag: med(lag), horizon: med(horizon), res, blink: blinks(R),
    });
  }
  return out;
}

const files = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!files.length) { console.error('usage: npm run predict -- <paint-input-*.json> ...'); process.exit(1); }
  for (const f of files) {
    const data = JSON.parse(readFileSync(f, 'utf8'));
    console.log(`\n■ ${f}`);
    console.log(`  版 ${data.app}・dpr ${data.dpr}・画面 ${data.vw}×${data.vh}・rawupdate ${data.rawupdate ? 'あり' : 'なし'}・coalesced ${data.coalesced ? 'あり' : 'なし'}・Ink Trail ${data.inkTrail ? 'あり' : 'なし'}`);
    console.log(`  ${data.ua}`);
    const res = analyze(data);
    console.log('  線  道具（入力）           長さ    時間   点の間隔  フレーム  処理の遅れ  ブラウザの予測の先');
    res.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}  ${(r.tool + (r.pen && r.pen !== 'pen' ? '/' + r.pen : '') + '（' + r.type + '）').padEnd(18)} ${f1(r.len).padStart(7)}px ${f1(r.dur).padStart(7)}ms ${f1(r.dt).padStart(6)}ms ${f1(r.fdt).padStart(6)}ms ${f1(r.lag).padStart(7)}ms ${f1(r.horizon).padStart(9)}ms`));
    const bl = res.map(r => r.blink), wait = bl.flatMap(b => b.wait), mvn = bl.reduce((s, b) => s + b.moving, 0);
    const fdts = data.strokes.flatMap(s => { const f = []; for (let i = 0; i < s.rows.length; i += 6) if (s.rows[i] === 6) f.push(s.rows[i + 1]); return f.slice(1).map((t, i) => t - f[i]); });
    console.log(`\n  負荷の様子: フレームの間隔 中央 ${f1(med(fdts))} / 90% ${f1(pct(fdts, 0.9))} / 最大 ${f1(Math.max(...fdts))} ms、入力が届くまでの遅れ（一番古い新しい点）中央 ${f1(med(wait))} / 90% ${f1(pct(wait, 0.9))} / 最大 ${f1(Math.max(...wait))} ms`);
    console.log(`  動いている途中に予測線が消えたフレーム（点滅）: 前の判定 ${bl.reduce((s, b) => s + b.old, 0)}・今の判定 ${bl.reduce((s, b) => s + b.now, 0)}（動いているフレーム ${mvn}）`);
    console.log('\n  予測の方法ごと（すべての線、CSS px）   1 フレーム後の遅れ（平均 / 90%）   はみ出し（平均 / 90% / 99%）   消える長さ（平均 / 90%）');
    for (const [k, name] of [['none', 'なし'], ['chrome', 'ブラウザ（前の方式）'], ['own', '曲がりに沿う（本体）'], ['linear', '直線']]) {
      const lag = res.flatMap(r => r.res[k].lag), off = res.flatMap(r => r.res[k].off), ls = res.flatMap(r => r.res[k].lost);
      console.log(`  ${name.padEnd(16)}  ${`${f1(mean(lag))} / ${f1(pct(lag, 0.9))}`.padStart(18)}   ${`${f1(mean(off))} / ${f1(pct(off, 0.9))} / ${f1(pct(off, 0.99))}`.padStart(22)}   ${`${f1(mean(ls))} / ${f1(pct(ls, 0.9))}`.padStart(14)}`);
    }
  }
}
