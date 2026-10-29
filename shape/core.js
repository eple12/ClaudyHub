// Browser/Node port of the Python model: ideal shapes, rasterizer, CNN inference, shape fitting.
(function (g) {
  const NAMES = ['원', '정사각형', '정삼각형', '별', '정오각형', '정육각형', '하트', '십자가', '초승달', '번개'];
  const R = 64;

  function resample(p, n) {
    const s = [0];
    for (let i = 1; i < p.length; i++) s.push(s[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
    const L = s[s.length - 1];
    if (!L) return Array.from({ length: n }, () => p[0].slice());
    const out = [];
    let j = 0;
    for (let i = 0; i < n; i++) {
      const t = (L * i) / (n - 1);
      while (j < p.length - 2 && s[j + 1] < t) j++;
      const u = Math.min(1, Math.max(0, (t - s[j]) / (s[j + 1] - s[j] || 1)));
      out.push([p[j][0] + (p[j + 1][0] - p[j][0]) * u, p[j][1] + (p[j + 1][1] - p[j][1]) * u]);
    }
    return out;
  }

  function ideal(k, n = 240) {
    const T = Array.from({ length: 721 }, (_, i) => (i / 720) * 2 * Math.PI);
    let v;
    if (k === 0) v = T.map(t => [Math.cos(t), Math.sin(t)]);
    else if (k === 6) v = T.map(t => [16 * Math.sin(t) ** 3 / 16, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 16]);
    else if (k === 7) { const a = .33; v = [[a, -1], [a, -a], [1, -a], [1, a], [a, a], [a, 1], [-a, 1], [-a, a], [-1, a], [-1, -a], [-a, -a], [-a, -1], [a, -1]]; }
    else if (k === 8) {
      const d = .5, r = .8, x = (1 - r * r + d * d) / (2 * d), y = Math.sqrt(1 - x * x), f = Math.atan2(y, x), gg = Math.atan2(y, x - d);
      v = [];
      for (let i = 0; i < 300; i++) { const a = f + (2 * Math.PI - 2 * f) * i / 299; v.push([Math.cos(a), Math.sin(a)]); }
      for (let i = 0; i < 300; i++) { const a = (2 * Math.PI - gg) + (gg - (2 * Math.PI - gg)) * i / 299; v.push([d + r * Math.cos(a), r * Math.sin(a)]); }
    } else if (k === 9) v = [[.25, -1], [-.55, .1], [-.05, .1], [-.25, 1], [.55, -.2], [.05, -.2], [.25, -1]];
    else {
      let ang, rad;
      if (k === 3) { ang = Array.from({ length: 10 }, (_, i) => -Math.PI / 2 + i * Math.PI / 5); rad = ang.map((_, i) => (i % 2 ? .382 : 1)); }
      else {
        const m = { 1: 4, 2: 3, 4: 5, 5: 6 }[k];
        ang = Array.from({ length: m }, (_, i) => -Math.PI / 2 + (i + (k === 1 ? .5 : 0)) * 2 * Math.PI / m); rad = ang.map(() => 1);
      }
      v = ang.map((a, i) => [rad[i] * Math.cos(a), rad[i] * Math.sin(a)]);
      v.push(v[0]);
    }
    const p = resample(v, n);
    const mx = p.reduce((s, q) => s + q[0], 0) / n, my = p.reduce((s, q) => s + q[1], 0) / n;
    return p.map(q => [q[0] - mx, q[1] - my]);
  }

  // Binary 64x64 raster of the strokes, normalised to the bounding box (matches training data).
  function render(strokes, w = 3) {
    const all = strokes.flat();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of all) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, sc = 52 / Math.max(x1 - x0, y1 - y0, 1e-6);
    const img = new Float32Array(R * R), h = w / 2;
    for (const st of strokes) {
      const q = st.map(([x, y]) => [(x - cx) * sc + R / 2, (y - cy) * sc + R / 2]);
      for (let i = 1; i < q.length; i++) {
        const [ax, ay] = q[i - 1], [bx, by] = q[i], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
        for (let y = Math.max(0, Math.floor(Math.min(ay, by) - h)); y <= Math.min(R - 1, Math.ceil(Math.max(ay, by) + h)); y++)
          for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - h)); x <= Math.min(R - 1, Math.ceil(Math.max(ax, bx) + h)); x++) {
            const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / l2));
            if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= h) img[y * R + x] = 1;
          }
      }
    }
    return img;
  }

  function conv(x, ci, H, W, w, b, co) {
    const y = new Float32Array(co * H * W);
    for (let o = 0; o < co; o++) {
      for (let c = 0; c < ci; c++) for (let ky = 0; ky < 3; ky++) for (let kx = 0; kx < 3; kx++) {
        const wv = w[((o * ci + c) * 3 + ky) * 3 + kx];
        if (!wv) continue;
        for (let yy = 0; yy < H; yy++) {
          const sy = yy + ky - 1;
          if (sy < 0 || sy >= H) continue;
          for (let xx = 0; xx < W; xx++) {
            const sx = xx + kx - 1;
            if (sx >= 0 && sx < W) y[(o * H + yy) * W + xx] += wv * x[(c * H + sy) * W + sx];
          }
        }
      }
      for (let i = 0; i < H * W; i++) { const v = y[o * H * W + i] + b[o]; y[o * H * W + i] = v > 0 ? v : 0; }
    }
    return y;
  }

  function pool(x, c, H, W) {
    const h = H >> 1, w = W >> 1, y = new Float32Array(c * h * w);
    for (let o = 0; o < c; o++) for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
      const b = (o * H + 2 * i) * W + 2 * j;
      y[(o * h + i) * w + j] = Math.max(x[b], x[b + 1], x[b + W], x[b + W + 1]);
    }
    return y;
  }

  const SHAPES = [[1, 16, 9], [16, 32, 9], [32, 64, 9], [64, 64, 9]];
  let P = null;

  async function load(url = 'weights.bin') {
    const buf = new Float32Array(await (await fetch(url)).arrayBuffer());
    let o = 0;
    const take = n => buf.subarray(o, (o += n));
    P = { conv: SHAPES.map(([ci, co, k]) => ({ w: take(co * ci * k), b: take(co) })) };
    P.fc1 = { w: take(128 * 1024), b: take(128) };
    P.fc2 = { w: take(NAMES.length * 128), b: take(NAMES.length) };
  }
  function setWeights(buf) { // node tests
    let o = 0;
    const take = n => buf.subarray(o, (o += n));
    P = { conv: SHAPES.map(([ci, co, k]) => ({ w: take(co * ci * k), b: take(co) })) };
    P.fc1 = { w: take(128 * 1024), b: take(128) };
    P.fc2 = { w: take(NAMES.length * 128), b: take(NAMES.length) };
  }

  function predict(strokes) {
    let x = render(strokes), H = R;
    SHAPES.forEach(([ci, co], i) => { x = pool(conv(x, ci, H, H, P.conv[i].w, P.conv[i].b, co), co, H, H); H >>= 1; });
    const h = new Float32Array(128);
    for (let o = 0; o < 128; o++) { let s = P.fc1.b[o]; for (let i = 0; i < 1024; i++) s += P.fc1.w[o * 1024 + i] * x[i]; h[o] = s > 0 ? s : 0; }
    const z = Array.from({ length: NAMES.length }, (_, o) => { let s = P.fc2.b[o]; for (let i = 0; i < 128; i++) s += P.fc2.w[o * 128 + i] * h[i]; return s; });
    const m = Math.max(...z), e = z.map(v => Math.exp(v - m)), t = e.reduce((a, b) => a + b);
    const pr = e.map(v => v / t), k = pr.indexOf(Math.max(...pr));
    return { k, conf: pr[k] };
  }

  // Fit a rotated/scaled ideal shape to the stroke points; score from mean chamfer distance.
  function fit(k, pts) {
    const n = pts.length;
    const cx = pts.reduce((s, p) => s + p[0], 0) / n, cy = pts.reduce((s, p) => s + p[1], 0) / n;
    const px = Float64Array.from(pts, p => p[0] - cx), py = Float64Array.from(pts, p => p[1] - cy);
    const I = ideal(k, 120), F = ideal(k, 720);
    const r0 = Math.sqrt(px.reduce((s, v, i) => s + v * v + py[i] * py[i], 0) / n);
    const Ir = Math.sqrt(I.reduce((s, p) => s + p[0] * p[0] + p[1] * p[1], 0) / I.length);
    const minQ = new Float64Array(720);
    function cost(a, s, Q, step) {
      const ca = Math.cos(a) * s, sa = Math.sin(a) * s, m = Q.length;
      const qx = new Float64Array(m), qy = new Float64Array(m);
      for (let j = 0; j < m; j++) { qx[j] = Q[j][0] * ca - Q[j][1] * sa; qy[j] = Q[j][0] * sa + Q[j][1] * ca; }
      minQ.fill(Infinity, 0, m);
      let sp = 0, cnt = 0;
      for (let i = 0; i < n; i += step) {
        let mn = Infinity;
        for (let j = 0; j < m; j++) {
          const dx = px[i] - qx[j], dy = py[i] - qy[j], d = dx * dx + dy * dy;
          if (d < mn) mn = d;
          if (d < minQ[j]) minQ[j] = d;
        }
        sp += Math.sqrt(mn); cnt++;
      }
      let sq = 0;
      for (let j = 0; j < m; j++) sq += Math.sqrt(minQ[j]);
      return (sp / cnt + sq / m) / 2;
    }
    let best = [Infinity, 0, 0];
    for (let si = 0; si < 13; si++) {
      const s = (r0 / Ir) * (.7 + .7 * si / 12);
      for (let a = 0; a < 360; a += 4) { const e = cost(a * Math.PI / 180, s, I, 3); if (e < best[0]) best = [e, a * Math.PI / 180, s]; }
    }
    const [, a0, s0] = best;
    best = [Infinity, 0, 0];
    for (let si = 0; si < 7; si++) {
      const s = s0 * (.97 + .06 * si / 6);
      for (let ai = 0; ai < 9; ai++) { const a = a0 + (-4 + ai) * Math.PI / 180, e = cost(a, s, F, 1); if (e < best[0]) best = [e, a, s]; }
    }
    const [e, a, s] = best, ca = Math.cos(a) * s, sa = Math.sin(a) * s;
    return { pct: Math.max(0, 1 - e / (s * Ir) / .2) * 100, fit: F.map(q => [q[0] * ca - q[1] * sa + cx, q[0] * sa + q[1] * ca + cy]) };
  }

  // strokes: arrays of [x,y] in a 480x480 space
  function recognize(strokes) {
    const st = strokes.slice(0, 20).filter(p => p.length > 1);
    const ln = st.map(p => p.reduce((s, q, i) => (i ? s + Math.hypot(q[0] - p[i - 1][0], q[1] - p[i - 1][1]) : 0), 0));
    const tot = ln.reduce((a, b) => a + b, 0);
    if (tot < 120) return { error: 'short' };
    const rs = st.map((p, i) => resample(p, Math.max(2, Math.round(300 * ln[i] / tot))));
    const { k, conf } = predict(rs);
    const { pct, fit: f } = fit(k, rs.flat());
    return { idx: k, name: NAMES[k], pct: Math.round(pct * 10) / 10, conf: Math.round(conf * 100), fit: f };
  }

  const api = { NAMES, load, setWeights, recognize, predict, fit, ideal, render, resample };
  if (typeof module !== 'undefined') module.exports = api; else g.Shape = api;
})(globalThis);
