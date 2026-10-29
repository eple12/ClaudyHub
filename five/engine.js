/*
 * ClaudyFive - a Gomoku (freestyle, 15x15, five or more in a row wins) engine.
 *
 * Structure follows ClaudyEngine, scaled down for a game that does not need chess-grade tuning:
 *
 *   rules core   padded mailbox board, incremental Zobrist keys, make / unmake
 *   evaluation   pattern table (9-cell line window -> threat class), kept incrementally per empty cell for
 *                both colours; the static eval is the sum of those cell scores (attack minus defence)
 *   search       PVS + iterative deepening, transposition table, killers + history, light LMR, a width cap
 *                (only the best-ordered candidates are searched), and gomoku-specific threat logic:
 *                  - five-in-one / forced block of a four / double four are exact at every node
 *                  - open four, four-three etc. are recognised from the cell tiers
 *                  - VCF (victory by continuous fours) search at the leaves instead of a quiescence search
 *   strength     LEVELS 1-10 limit depth, node budget, width and VCF depth, add deterministic evaluation noise
 *                (like Claudy's Strength::noise), a chance of a plausible-but-wrong move, and at the lowest
 *                levels a chance of overlooking a four. Every level still plays moves next to the stones.
 *
 * The factory returns an independent engine instance, so two engines can play each other in one process
 * and the whole thing can be shipped to a Web Worker as source text (see app.js).
 */
function claudyFiveFactory() {
  'use strict';

  // ------------------------------------------------------------------------------------------------
  // Board
  // ------------------------------------------------------------------------------------------------
  const N = 15, NN = N * N, PAD = 4, W = N + 2 * PAD, SZ = W * W;
  const DIRS = [1, W, W + 1, W - 1];                 // horizontal, vertical, diagonal, anti-diagonal
  const EMPTY = 0, BLACK = 1, WHITE = 2, WALL = 3;
  const WIN = 30000, INF = 32000, MATE_THR = WIN - 300, MAXPLY = 60;

  const cellIndex = (x, y) => (y + PAD) * W + (x + PAD);
  const cellX = (q) => (q % W) - PAD;
  const cellY = (q) => ((q / W) | 0) - PAD;

  const CELLS = new Int16Array(NN);
  for (let y = 0, i = 0; y < N; y++) for (let x = 0; x < N; x++) CELLS[i++] = cellIndex(x, y);

  const NB_OFF = [];                                  // 5x5 neighbourhood: candidate moves lie within 2 of a stone
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dx || dy) NB_OFF.push(dy * W + dx);

  const board = new Uint8Array(SZ);
  const nb = new Uint8Array(SZ);                      // number of stones within distance 2
  let stm = BLACK, stoneCnt = 0, sp = 0;
  const stack = new Int16Array(NN + 8);

  // Zobrist keys (two 32-bit halves), fixed seed so games are reproducible
  const Z1 = new Int32Array(3 * SZ), Z2 = new Int32Array(3 * SZ);
  {
    let s = 0x2545F491;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s | 0; };
    for (let i = 0; i < Z1.length; i++) { Z1[i] = rnd(); Z2[i] = rnd(); }
  }
  let h1 = 0, h2 = 0;

  // ------------------------------------------------------------------------------------------------
  // Line patterns
  // ------------------------------------------------------------------------------------------------
  // For an empty cell q and a direction, the 8 neighbours (4 each side) are packed as 2-bit codes
  // (0 empty, 1 black, 2 white, 3 wall). PT[c][code] says what a stone of colour c at q would create in
  // that line. Classified lazily and cached: only patterns that actually occur are ever computed.
  const C_NONE = 0, C_ONE = 1, C_TWO = 2, C_LIVE2 = 3, C_THREE = 4, C_LIVE3 = 5, C_FOUR = 6, C_OPEN4 = 7, C_FIVE = 8;
  const PT = [null, new Uint8Array(65536).fill(255), new Uint8Array(65536).fill(255)];
  const PT1 = PT[1], PT2 = PT[2];
  const L = new Uint8Array(9);                        // scratch line, L[4] is the centre

  function runThrough(c) {                            // length of the run of c containing the centre
    let a = 4, b = 4;
    while (a > 0 && L[a - 1] === c) a--;
    while (b < 8 && L[b + 1] === c) b++;
    return b - a + 1;
  }
  function completions(c) {                           // empty cells that would make five through the centre
    let n = 0;
    for (let i = 0; i < 9; i++) {
      if (L[i] !== 0) continue;
      L[i] = c;
      if (runThrough(c) >= 5) n++;
      L[i] = 0;
    }
    return n;
  }
  function classify(c) {
    if (runThrough(c) >= 5) return C_FIVE;
    const n = completions(c);
    if (n >= 2) return C_OPEN4;
    if (n === 1) return C_FOUR;
    let three = 0;                                    // 1: closed three, 2: live three
    for (let e = 0; e < 9 && three < 2; e++) {
      if (L[e] !== 0) continue;
      L[e] = c;
      const m = completions(c);
      L[e] = 0;
      if (m >= 2) three = 2; else if (m === 1) three = 1;
    }
    if (three === 2) return C_LIVE3;
    if (three === 1) return C_THREE;
    for (let e = 0; e < 9; e++) {                     // live two: one more stone makes a live three
      if (L[e] !== 0) continue;
      L[e] = c;
      let found = false;
      for (let f = 0; f < 9 && !found; f++) {
        if (L[f] !== 0) continue;
        L[f] = c;
        if (completions(c) >= 2) found = true;
        L[f] = 0;
      }
      L[e] = 0;
      if (found) return C_LIVE2;
    }
    let m = 0, any = false;                           // otherwise: best open five-window through the centre
    for (let s = 0; s <= 4; s++) {
      let cnt = 0, ok = true;
      for (let i = s; i < s + 5; i++) { if (L[i] === c) cnt++; else if (L[i] !== 0) { ok = false; break; } }
      if (ok) { any = true; if (cnt > m) m = cnt; }
    }
    return !any ? C_NONE : m >= 2 ? C_TWO : C_ONE;
  }
  function patClass(c, code) {
    let v = PT[c][code];
    if (v !== 255) return v;
    for (let k = 0; k < 8; k++) L[k < 4 ? k : k + 1] = (code >> (2 * k)) & 3;
    L[4] = c;
    v = classify(c);
    PT[c][code] = v;
    return v;
  }

  // ------------------------------------------------------------------------------------------------
  // Per-cell scores (incremental)
  // ------------------------------------------------------------------------------------------------
  // CLS[ci*4+d][q]: pattern class a stone of colour ci+1 at empty cell q would form in direction d.
  // SC / TR: score and tactical tier of that cell for each colour, combined over the four directions.
  const T_THREE = 3, T_33 = 4, T_FOUR = 5, T_43 = 6, T_WIN4 = 7, T_FIVE = 8;
  const CW = [0, 4, 20, 100, 300, 3000, 10000, 200000, 1000000];
  const TIER_BONUS = [0, 0, 0, 0, 40000, 0, 100000, 0, 0];
  const EV_CAP = 12000;

  const CLS = [];
  for (let i = 0; i < 8; i++) CLS.push(new Uint8Array(SZ));
  const SC = [new Int32Array(SZ), new Int32Array(SZ)];
  const TR = [new Uint8Array(SZ), new Uint8Array(SZ)];
  const sumEv = [0, 0];

  // (class of dir 0..3) packed as 4 nibbles -> cell score and tier, tabulated once
  const KEY_SC = new Int32Array(65536), KEY_TR = new Uint8Array(65536);
  for (let key = 0; key < 65536; key++) {
    let s = 0, n3 = 0, n4 = 0, big = 0, five = 0, ok = true;
    for (let d = 0; d < 4; d++) {
      const k = (key >> (4 * d)) & 15;
      if (k > C_FIVE) { ok = false; break; }
      s += CW[k];
      if (k === C_LIVE3) n3++; else if (k === C_FOUR) n4++; else if (k === C_OPEN4) big++; else if (k === C_FIVE) five++;
    }
    if (!ok) continue;
    let t = 0;
    if (five) t = T_FIVE;
    else if (big || n4 >= 2) t = T_WIN4;
    else if (n4 === 1) t = n3 ? T_43 : T_FOUR;
    else if (n3 >= 2) t = T_33;
    else if (n3 === 1) t = T_THREE;
    else if (s > 0) t = 1;
    KEY_SC[key] = s + TIER_BONUS[t];
    KEY_TR[key] = t;
  }

  function refreshCell(ci, q) {
    const b = ci * 4;
    const key = CLS[b][q] | (CLS[b + 1][q] << 4) | (CLS[b + 2][q] << 8) | (CLS[b + 3][q] << 12);
    const s = KEY_SC[key], old = SC[ci][q];
    SC[ci][q] = s;
    TR[ci][q] = KEY_TR[key];
    sumEv[ci] += (s > EV_CAP ? EV_CAP : s) - (old > EV_CAP ? EV_CAP : old);
  }

  function updateDir(q, d, dd) {
    const code = board[q - 4 * dd] | (board[q - 3 * dd] << 2) | (board[q - 2 * dd] << 4) | (board[q - dd] << 6) |
      (board[q + dd] << 8) | (board[q + 2 * dd] << 10) | (board[q + 3 * dd] << 12) | (board[q + 4 * dd] << 14);
    let n1 = PT1[code];
    if (n1 === 255) n1 = patClass(1, code);
    if (CLS[d][q] !== n1) { CLS[d][q] = n1; refreshCell(0, q); }
    let n2 = PT2[code];
    if (n2 === 255) n2 = patClass(2, code);
    if (CLS[4 + d][q] !== n2) { CLS[4 + d][q] = n2; refreshCell(1, q); }
  }

  function resetBoard() {
    board.fill(WALL); nb.fill(0);
    for (let i = 0; i < NN; i++) board[CELLS[i]] = EMPTY;
    for (let i = 0; i < 8; i++) CLS[i].fill(0);
    SC[0].fill(0); SC[1].fill(0); TR[0].fill(0); TR[1].fill(0);
    sumEv[0] = sumEv[1] = 0;
    stm = BLACK; stoneCnt = 0; sp = 0; h1 = 0; h2 = 0;
    for (let i = 0; i < NN; i++) for (let d = 0; d < 4; d++) updateDir(CELLS[i], d, DIRS[d]);
  }

  function make(q) {
    const c = stm;
    board[q] = c;
    h1 ^= Z1[c * SZ + q]; h2 ^= Z2[c * SZ + q];
    stack[sp++] = q; stoneCnt++;
    for (let ci = 0; ci < 2; ci++) {
      const o = SC[ci][q];
      sumEv[ci] -= o > EV_CAP ? EV_CAP : o;
      SC[ci][q] = 0; TR[ci][q] = 0;
      for (let d = 0; d < 4; d++) CLS[ci * 4 + d][q] = 0;
    }
    for (let d = 0; d < 4; d++) {
      const dd = DIRS[d];
      for (let k = -4; k <= 4; k++) {
        if (k === 0) continue;
        const r = q + k * dd;
        if (board[r] === EMPTY) updateDir(r, d, dd);
      }
    }
    for (let i = 0; i < 24; i++) nb[q + NB_OFF[i]]++;
    stm = 3 - c;
  }

  function unmake() {
    const q = stack[--sp], c = board[q];
    board[q] = EMPTY;
    h1 ^= Z1[c * SZ + q]; h2 ^= Z2[c * SZ + q];
    stoneCnt--;
    for (let i = 0; i < 24; i++) nb[q + NB_OFF[i]]--;
    stm = c;
    for (let d = 0; d < 4; d++) {
      const dd = DIRS[d];
      for (let k = -4; k <= 4; k++) {
        const r = q + k * dd;
        if (board[r] === EMPTY) updateDir(r, d, dd);
      }
    }
  }

  // ------------------------------------------------------------------------------------------------
  // Strength levels (cf. ClaudyEngine strength.cpp)
  // ------------------------------------------------------------------------------------------------
  //  depth  maximum iterative-deepening depth        width  candidate moves searched per node
  //  nodes  node budget (0 = none), checked after depth 1 is complete;   ms  time limit (0 = none)
  //  rnd    % chance of an arbitrary move next to the stones (ignores wins and blocks)
  //  noise  sd of the deterministic evaluation noise   blunder  % chance of a plausible wrong move
  //  miss   % chance of overlooking a four (lowest levels)   win4  recognises open fours / double fours
  //  vcf    depth of the four-chain search at leaves       defw  how much opponent threats weigh in the eval
  const LEVELS = [null,
    { name: '입문',     info: '거의 아무렇게나 둬요', depth: 1, rnd: 90,  width: 5,  nodes: 0,      ms: 0,    noise: 260, blunder: 16, miss: 30, win4: false, vcf: 0,  defw: 0.3 },
    { name: '초급',     info: '대부분 엉뚱한 곳에 둬요', depth: 1, rnd: 72,  width: 8,  nodes: 0,      ms: 0,    noise: 90,  blunder: 6,  miss: 10, win4: false, vcf: 0,  defw: 0.65 },
    { name: '초중급',   info: '자주 실수해요', depth: 2, rnd: 52,  width: 8,  nodes: 0,      ms: 0,    noise: 60,  blunder: 4,  miss: 3,  win4: true,  vcf: 0,  defw: 0.8 },
    { name: '중급',     info: '가끔 엉뚱한 수를 둬요', depth: 3, rnd: 34,  width: 9,  nodes: 4000,   ms: 0,    noise: 40,  blunder: 2,  miss: 0,  win4: true,  vcf: 2,  defw: 0.85 },
    { name: '중상급',   info: '기본기는 있지만 허술해요', depth: 4, rnd: 20,  width: 10, nodes: 12000,  ms: 0,    noise: 25,  blunder: 1,  miss: 0,  win4: true,  vcf: 4,  defw: 0.9 },
    { name: '상급',     info: '가끔 실수해요', depth: 6, rnd: 9,  width: 11, nodes: 40000,  ms: 0,    noise: 15,  blunder: 0,  miss: 0,  win4: true,  vcf: 6,  defw: 0.9 },
    { name: '고급',     info: '연속 4 공격(VCF)을 잘 봐요', depth: 8, rnd: 3,  width: 10, nodes: 150000, ms: 2000, noise: 20,  blunder: 0,  miss: 0,  win4: true,  vcf: 8, defw: 0.9 },
    { name: '준마스터', info: '아마추어 고수도 어려워요', depth: 10, width: 12, nodes: 0,      ms: 2500, noise: 12,  blunder: 0,  miss: 0,  win4: true,  vcf: 10, defw: 0.9 },
    { name: '마스터',   info: '강한 수읽기', depth: 14, width: 14, nodes: 0,      ms: 4000, noise: 6,   blunder: 0,  miss: 0,  win4: true,  vcf: 14, defw: 0.9 },
    { name: '최강',     info: '이 엔진의 전력', depth: 24, width: 16, nodes: 0,      ms: 6000, noise: 3,   blunder: 0,  miss: 0,  win4: true,  vcf: 16, defw: 0.9 },
  ];

  let params = LEVELS[10];
  let level = 10;

  function setLevel(lv, override) {
    level = Math.max(1, Math.min(10, lv | 0 || 10));
    params = Object.assign({}, LEVELS[level], override || {});
    return params;
  }

  // PRNG (xorshift32) and deterministic eval noise
  let rng = 0x9E3779B9, noiseSeed = 1;
  function rand() { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) / 4294967296; }
  function mix32(x) {
    x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
    return x >>> 0;
  }
  function noiseValue() {                             // roughly normal, sd = params.noise
    const a = mix32(h1 ^ noiseSeed), b = mix32((h2 + noiseSeed) | 0);
    const sum = (a & 0xFFFF) + (a >>> 16) + (b & 0xFFFF) + (b >>> 16);
    return ((sum - 131070) * params.noise / 37837) | 0;
  }

  // ------------------------------------------------------------------------------------------------
  // Transposition table
  // ------------------------------------------------------------------------------------------------
  const TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;
  let ttMask = 0, TTK = null, TTS = null, TTD = null, TTF = null, TTM = null;
  function allocTT(bits) {
    const size = 1 << bits;
    ttMask = size - 1;
    TTK = new Int32Array(size); TTS = new Int32Array(size);
    TTD = new Int8Array(size).fill(-1); TTF = new Uint8Array(size); TTM = new Int16Array(size);
  }
  function clearTT() { TTK.fill(0); TTD.fill(-1); }
  allocTT(18);

  // ------------------------------------------------------------------------------------------------
  // Search
  // ------------------------------------------------------------------------------------------------
  let nodes = 0, stopped = false, deadline = Infinity, maxNodes = 0, curDepth = 0, startT = 0;
  const mvBuf = [], kyBuf = [], vcfBuf = [];
  for (let i = 0; i < MAXPLY + 8; i++) { mvBuf.push(new Int16Array(256)); kyBuf.push(new Int32Array(256)); }
  for (let i = 0; i < 40; i++) vcfBuf.push(new Int16Array(256));
  const PVW = MAXPLY + 8;
  const pvT = new Int16Array(PVW * PVW), pvLen = new Int32Array(PVW);
  const killers = new Int16Array(PVW * 2).fill(-1);
  const hist = [null, new Int32Array(SZ), new Int32Array(SZ)];

  function checkTime() {
    if (curDepth <= 1) return;
    if (maxNodes && nodes >= maxNodes) stopped = true;
    else if (deadline !== Infinity && Date.now() >= deadline) stopped = true;
  }

  function evaluate() {
    const mi = stm - 1;
    let e = sumEv[mi] - sumEv[1 - mi] * params.defw;
    if (params.noise) e += noiseValue();
    e |= 0;
    return e > 20000 ? 20000 : e < -20000 ? -20000 : e;
  }

  function widthFor(ply) {
    const w = params.width;
    return ply === 0 ? w + 6 : ply <= 2 ? w : ply <= 5 ? Math.max(5, w - 2) : Math.max(4, w - 4);
  }

  const VCF_CAP = 5000;
  let vcfNodes = 0, vcfMove = -1;

  // Victory by continuous fours for the side to move: it may only play moves that make a four (or a forced
  // block that itself makes a four); the defender's reply is always the single blocking cell.
  function vcf(depth, lvl) {
    if (++vcfNodes > VCF_CAP) return false;
    nodes++;
    const mi = stm - 1, oi = 1 - mi;
    const T0 = TR[mi], T1 = TR[oi];
    const buf = vcfBuf[lvl];
    let cnt = 0, nOF = 0, oF = -1;
    for (let i = 0; i < NN; i++) {
      const q = CELLS[i];
      if (board[q] !== EMPTY || nb[q] === 0) continue;
      const mt = T0[q];
      if (mt === T_FIVE) { if (lvl === 0) vcfMove = q; return true; }
      if (T1[q] === T_FIVE) { nOF++; oF = q; }
      if (mt >= T_FOUR) buf[cnt++] = q;
    }
    if (nOF >= 2 || depth <= 0 || cnt === 0) return false;
    if (nOF === 1) {
      if (T0[oF] < T_FOUR) return false;
      buf[0] = oF; cnt = 1;
    }
    for (let k = 0; k < cnt; k++) {
      const q = buf[k];
      if (T0[q] >= T_WIN4) { if (lvl === 0) vcfMove = q; return true; }
      make(q);
      let fc = -1, nf = 0;
      for (let i = 0; i < NN; i++) {
        const c = CELLS[i];
        if (board[c] === EMPTY && nb[c] !== 0 && T0[c] === T_FIVE) { nf++; fc = c; }
      }
      if (nf >= 2) { unmake(); if (lvl === 0) vcfMove = q; return true; }
      if (nf === 0) { unmake(); continue; }
      make(fc);
      const r = vcf(depth - 1, lvl + 1);
      unmake(); unmake();
      if (r) { if (lvl === 0) vcfMove = q; return true; }
    }
    return false;
  }

  function search(depth, alpha, beta, ply) {
    nodes++;
    if ((nodes & 2047) === 0) checkTime();
    if (stopped) return 0;
    pvLen[ply] = ply;
    if (stoneCnt >= NN) return 0;
    if (ply >= MAXPLY) return evaluate();

    const me = stm, mi = me - 1, oi = 1 - mi;
    const T0 = TR[mi], T1 = TR[oi], S0 = SC[mi], S1 = SC[oi];
    const mv = mvBuf[ply], ky = kyBuf[ply];
    const defw = params.defw;
    let cnt = 0, nOF = 0, oF = -1, myBest = 0, winCell = -1;
    for (let i = 0; i < NN; i++) {
      const q = CELLS[i];
      if (board[q] !== EMPTY || nb[q] === 0) continue;
      const mt = T0[q], ot = T1[q];
      if (mt === T_FIVE) { pvT[ply * PVW + ply] = q; pvLen[ply] = ply + 1; return WIN - ply - 1; }
      if (ot === T_FIVE) { nOF++; oF = q; }
      if (mt > myBest) { myBest = mt; if (mt >= T_WIN4) winCell = q; }
      mv[cnt] = q;
      ky[cnt++] = S0[q] + ((S1[q] * defw) | 0);
    }
    if (nOF >= 2) return -(WIN - ply - 2);
    if (cnt === 0) return 0;
    let forced = false;
    if (nOF === 1) { mv[0] = oF; cnt = 1; forced = true; }
    else if (params.win4 && myBest >= T_WIN4) { pvT[ply * PVW + ply] = winCell; pvLen[ply] = ply + 1; return WIN - ply - 3; }

    if (depth <= 0 && !forced) {
      if (params.vcf > 0 && myBest >= T_FOUR) {
        vcfNodes = 0;
        if (vcf(params.vcf, 0)) return WIN - ply - 5;
      }
      return evaluate();
    }

    // transposition table
    let ttMove = -1;
    const ti = h1 & ttMask;
    if (!forced && TTK[ti] === h2 && TTD[ti] >= 0) {
      ttMove = TTM[ti];
      if (TTD[ti] >= depth && beta - alpha === 1) {
        let s = TTS[ti];
        if (s > MATE_THR) s -= ply; else if (s < -MATE_THR) s += ply;
        const f = TTF[ti];
        if (f === TT_EXACT || (f === TT_LOWER && s >= beta) || (f === TT_UPPER && s <= alpha)) return s;
      }
    }

    const k0 = killers[ply * 2], k1 = killers[ply * 2 + 1], H = hist[me];
    for (let j = 0; j < cnt; j++) {
      const q = mv[j];
      if (q === ttMove) ky[j] += 100000000;
      else if (q === k0) ky[j] += 2000;
      else if (q === k1) ky[j] += 1500;
      const hh = H[q];
      ky[j] += hh > 800 ? 800 : hh;
    }

    const wmax = forced ? 1 : Math.min(cnt, widthFor(ply));
    const alpha0 = alpha;
    let best = -INF, bestMove = -1;
    for (let i = 0; i < wmax; i++) {
      let bi = i;
      for (let j = i + 1; j < cnt; j++) if (ky[j] > ky[bi]) bi = j;
      if (bi !== i) {
        const tq = mv[i]; mv[i] = mv[bi]; mv[bi] = tq;
        const tk = ky[i]; ky[i] = ky[bi]; ky[bi] = tk;
      }
      const q = mv[i];
      const quiet = T0[q] < T_THREE && T1[q] < T_THREE;
      const nd = forced ? depth : depth - 1;
      make(q);
      let v;
      if (i === 0) v = -search(nd, -beta, -alpha, ply + 1);
      else {
        const r = (depth >= 3 && i >= 3 && quiet) ? 1 : 0;
        v = -search(nd - r, -alpha - 1, -alpha, ply + 1);
        if (v > alpha && (r > 0 || v < beta)) v = -search(nd, -beta, -alpha, ply + 1);
      }
      unmake();
      if (stopped) return 0;
      if (v > best) {
        best = v; bestMove = q;
        if (v > alpha) {
          alpha = v;
          pvT[ply * PVW + ply] = q;
          const cl = pvLen[ply + 1];
          for (let j = ply + 1; j < cl; j++) pvT[ply * PVW + j] = pvT[(ply + 1) * PVW + j];
          pvLen[ply] = cl > ply + 1 ? cl : ply + 1;
          if (alpha >= beta) {
            if (quiet) {
              if (killers[ply * 2] !== q) { killers[ply * 2 + 1] = killers[ply * 2]; killers[ply * 2] = q; }
              H[q] += depth * depth;
            }
            break;
          }
        }
      }
    }

    if (!forced) {
      let s = best;
      if (s > MATE_THR) s += ply; else if (s < -MATE_THR) s -= ply;
      if (TTK[ti] !== h2 || TTD[ti] <= depth) {
        TTK[ti] = h2; TTS[ti] = s; TTD[ti] = depth > 100 ? 100 : depth; TTM[ti] = bestMove;
        TTF[ti] = best >= beta ? TT_LOWER : best > alpha0 ? TT_EXACT : TT_UPPER;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------------------------------------
  // Root
  // ------------------------------------------------------------------------------------------------
  function pvList(len) {
    const out = [];
    for (let i = 0; i < len; i++) { const q = pvT[i]; out.push([cellX(q), cellY(q)]); }
    return out;
  }

  function opponentHasFive() {                       // after a tentative move: can the side to move win now?
    const T = TR[stm - 1];
    for (let i = 0; i < NN; i++) {
      const q = CELLS[i];
      if (board[q] === EMPTY && nb[q] !== 0 && T[q] === T_FIVE) return true;
    }
    return false;
  }

  function finish(q, score, depth, extra) {
    return Object.assign({
      move: [cellX(q), cellY(q)], score, depth, nodes, ms: Date.now() - startT,
      mate: Math.abs(score) > MATE_THR ? (score > 0 ? 1 : -1) * (WIN - Math.abs(score)) : 0,
    }, extra || {});
  }

  /*
   * lim: { depth, nodes, ms, onInfo }   (anything omitted comes from the current level)
   * returns { move:[x,y], score, depth, nodes, ms, pv:[[x,y]...], mate }
   */
  function go(lim) {
    lim = lim || {};
    startT = Date.now(); nodes = 0; stopped = false; curDepth = 1;
    const maxDepth = Math.min(lim.depth || params.depth, MAXPLY - 4);
    const ms = lim.ms !== undefined ? lim.ms : params.ms;
    maxNodes = lim.nodes !== undefined ? lim.nodes : params.nodes;
    deadline = ms ? startT + ms : Infinity;
    const onInfo = lim.onInfo;

    if (stoneCnt === 0) return finish(cellIndex(7, 7), 0, 0);
    if (stoneCnt >= NN) return null;

    // ---- lowest levels: sometimes an arbitrary move next to the stones, wins and blocks ignored ----
    if (params.rnd && rand() * 100 < params.rnd) {
      const pool = [];
      for (let i = 0; i < NN; i++) { const q = CELLS[i]; if (board[q] === EMPTY && nb[q] > 0) pool.push(q); }
      if (pool.length) return finish(pool[(rand() * pool.length) | 0], 0, 0, { random: true });
    }

    // ---- root scan: immediate wins and forced replies are exact at every level -----------------
    const mi = stm - 1, oi = 1 - mi;
    const T0 = TR[mi], T1 = TR[oi], S0 = SC[mi], S1 = SC[oi];
    const list = [], key = [];
    let nOF = 0, oF = -1, winCell = -1, winTier = 0;
    for (let i = 0; i < NN; i++) {
      const q = CELLS[i];
      if (board[q] !== EMPTY || nb[q] === 0) continue;
      if (T0[q] === T_FIVE) return finish(q, WIN - 1, 0, { pv: [[cellX(q), cellY(q)]] });
      if (T1[q] === T_FIVE) { nOF++; oF = q; }
      if (T0[q] >= T_WIN4 && T0[q] > winTier) { winTier = T0[q]; winCell = q; }
      list.push(q); key.push(S0[q] + ((S1[q] * params.defw) | 0));
    }
    if (nOF >= 1) {
      // a four must be blocked; at the lowest levels it is sometimes overlooked
      if (nOF === 1 && params.miss && rand() * 100 < params.miss) {
        const alts = list.map((q, i) => [key[i], q]).filter(a => a[1] !== oF).sort((a, b) => b[0] - a[0]).slice(0, 4);
        if (alts.length) return finish(alts[(rand() * alts.length) | 0][1], 0, 0, { overlooked: true });
      }
      return finish(oF, nOF >= 2 ? -WIN + 2 : 0, 0, { forced: true });
    }
    if (params.win4 && winCell >= 0) return finish(winCell, WIN - 3, 0, { pv: [[cellX(winCell), cellY(winCell)]] });
    if (params.vcf > 0) {
      vcfNodes = 0; vcfMove = -1;
      if (vcf(Math.max(params.vcf, 4) + 4, 0) && vcfMove >= 0) return finish(vcfMove, WIN - 5, 0, { vcf: true, pv: [[cellX(vcfMove), cellY(vcfMove)]] });
    }

    // order root moves (static key, best first), keep the strongest `width` of them
    const idx = list.map((_, i) => i).sort((a, b) => key[b] - key[a]);
    const staticOrder = idx.map(i => list[i]);
    const n = Math.min(staticOrder.length, widthFor(0));
    const rl = staticOrder.slice(0, n), rs = new Array(n).fill(-INF);

    for (let i = 0; i < PVW * 2; i++) killers[i] = -1;
    hist[1].fill(0); hist[2].fill(0);

    let bestMove = rl[0], bestScore = 0, doneDepth = 0, bestPV = [[cellX(rl[0]), cellY(rl[0])]];
    for (let d = 1; d <= maxDepth; d++) {
      curDepth = d;
      let alpha = -INF, curBest = -1, curScore = -INF, pvL = 0;
      pvLen[0] = 0;
      for (let i = 0; i < n; i++) {
        const q = rl[i];
        make(q);
        let v;
        if (i === 0) v = -search(d - 1, -INF, -alpha, 1);
        else {
          v = -search(d - 1, -alpha - 1, -alpha, 1);
          if (v > alpha) v = -search(d - 1, -INF, -alpha, 1);
        }
        unmake();
        if (stopped) break;
        rs[i] = v;
        if (v > curScore) {
          curScore = v; curBest = q;
          if (v > alpha) {
            alpha = v;
            pvT[0] = q;
            const cl = pvLen[1];
            for (let j = 1; j < cl; j++) pvT[j] = pvT[PVW + j];
            pvL = cl > 1 ? cl : 1;
          }
        }
      }
      if (stopped) break;
      bestMove = curBest; bestScore = curScore; doneDepth = d; bestPV = pvList(pvL);
      // reorder: best first, then by score
      const order = rl.map((q, i) => i).sort((a, b) => (b === rl.indexOf(curBest) ? 1 : 0) - (a === rl.indexOf(curBest) ? 1 : 0) || rs[b] - rs[a]);
      const nrl = order.map(i => rl[i]), nrs = order.map(i => rs[i]);
      for (let i = 0; i < n; i++) { rl[i] = nrl[i]; rs[i] = nrs[i]; }
      if (onInfo) onInfo({ depth: d, score: bestScore, nodes, ms: Date.now() - startT, pv: bestPV, move: [cellX(bestMove), cellY(bestMove)] });
      if (Math.abs(bestScore) > MATE_THR) break;
      if (maxNodes && nodes >= maxNodes) break;
      if (ms && Date.now() - startT > ms * 0.45) break;
    }

    // ---- imperfection: sometimes a plausible but worse move -------------------------------------
    let blundered = false;
    if (params.blunder && Math.abs(bestScore) < MATE_THR && rand() * 100 < params.blunder) {
      const pool = staticOrder.slice(0, 6).filter(q => q !== bestMove);
      for (let tries = 0; tries < pool.length && !blundered; tries++) {
        const k = (rand() * pool.length) | 0, q = pool[k];
        pool.splice(k, 1); tries--;
        make(q);
        const bad = opponentHasFive();
        unmake();
        if (!bad) { bestMove = q; blundered = true; }
        if (!pool.length) break;
      }
    }
    const res = finish(bestMove, bestScore, doneDepth, { pv: bestPV });
    if (blundered) res.pv = [res.move];
    return res;
  }

  // ------------------------------------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------------------------------------
  function setPosition(moves) {                       // moves: [[x,y], ...] alternating, black first
    resetBoard();
    for (const m of moves) {
      const q = cellIndex(m[0], m[1]);
      if (m[0] < 0 || m[0] >= N || m[1] < 0 || m[1] >= N || board[q] !== EMPTY) throw new Error('illegal move ' + m);
      make(q);
    }
  }
  function newGame(seed) {
    noiseSeed = (seed === undefined ? (Math.random() * 4294967296) : seed) | 0;
    rng = (noiseSeed ^ 0x9E3779B9) | 1;
    clearTT();
    killers.fill(-1); hist[1].fill(0); hist[2].fill(0);
    resetBoard();
  }
  function setHashBits(bits) { allocTT(bits); }

  // static evaluation from the side to move (centipawn-like units), used by tests
  function staticEval() { const p = params.noise; params.noise = 0; const v = evaluate(); params.noise = p; return v; }
  function toMove() { return stm; }
  function dump() {
    let s = '';
    for (let y = N - 1; y >= 0; y--) {
      for (let x = 0; x < N; x++) s += '.XO'[board[cellIndex(x, y)]] + ' ';
      s += '\n';
    }
    return s;
  }

  resetBoard();
  return { N, LEVELS, newGame, setLevel, setPosition, go, staticEval, toMove, dump, setHashBits, get level() { return level; } };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = claudyFiveFactory;
}
