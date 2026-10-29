import { Chess } from "../vendor/chess.js";
import { Board, parsePlacement } from "./board.js";
import { UciEngine, engineDefs } from "./engine.js";
import { EvalChart, whiteWin, fmtScore } from "./chart.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------------------------------------
// environment & settings
// ---------------------------------------------------------------------------------------------
const HC = navigator.hardwareConcurrency || 4;
const MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const ISO = window.crossOriginIsolated === true;
const MAXT = Math.min(HC, 16);          // size of the Claudy thread pool
const DEFS = engineDefs();
const IDS = ["claudy", "stockfish"];

const S = (() => {
  const d = {
    threads: { claudy: 0, stockfish: 0 },      // 0 = automatic
    hash: { claudy: MOBILE ? 64 : 256, stockfish: MOBILE ? 32 : 128 },
    sfVariant: ISO ? "full" : "lite",
    overhead: 30,
    animate: true,
    think: 1000,
    tc: "300000+3000",
    white: "human", black: "claudy",
    strength: { claudy: { limit: false, elo: 2200 }, stockfish: { limit: false, elo: 2200 } },
    lines: 1,
    anEngines: ["claudy"],
    reviewEng: "claudy", reviewTime: 500,
  };
  const s = store.get("claudyweb.v1", {});
  for (const k of Object.keys(d)) {
    if (s[k] === undefined) continue;
    d[k] = (d[k] && typeof d[k] === "object" && !Array.isArray(d[k])) ? { ...d[k], ...s[k] } : s[k];
  }
  if (!ISO) {
    d.sfVariant = "lite";
    if (d.white === "claudy") d.white = "stockfish";
    if (d.black === "claudy") d.black = "stockfish";
    d.anEngines = d.anEngines.filter((x) => x !== "claudy");
    if (!d.anEngines.length) d.anEngines = ["stockfish"];
    d.reviewEng = "stockfish";
  }
  return d;
})();
const save = () => store.set("claudyweb.v1", S);

const avail = (id) => id !== "claudy" || ISO;

// ---------------------------------------------------------------------------------------------
// game model (shared by play and analysis)
// ---------------------------------------------------------------------------------------------
const G = { startFen: START, plies: [], fens: [START], cursor: 0, evals: [], marks: [], orient: "w", names: ["White", "Black"], acc: null };
let mode = "play";

let chessCache = { fen: null, c: null };
function chessAt(i) {
  const fen = G.fens[i];
  if (chessCache.fen !== fen) chessCache = { fen, c: new Chess(fen) };
  return chessCache.c;
}

function resetGame(fen = START) {
  G.startFen = fen;
  G.plies = [];
  G.fens = [fen];
  G.cursor = 0;
  G.evals = [];
  G.marks = [];
  G.acc = null;
}

function truncate(n) {
  G.plies.length = n;
  G.fens.length = n + 1;
  G.evals.length = Math.min(G.evals.length, n + 1);
  G.marks = [];
  G.acc = null;
}

// Plays a move at the cursor. Returns "adv" when it followed the existing line, the move object when it
// created/extended a line, or null if illegal.
function playMove(from, to, promo) {
  const c = new Chess(G.fens[G.cursor]);
  let m;
  try { m = c.move({ from, to, promotion: promo }); } catch { return null; }
  const uci = from + to + (promo || "");
  if (G.cursor < G.plies.length) {
    if (G.plies[G.cursor].uci === uci) { G.cursor++; return "adv"; }
    truncate(G.cursor);
  }
  G.plies.push({ uci, san: m.san, from, to, promo, color: m.color });
  G.fens.push(c.fen());
  G.cursor = G.plies.length;
  return m;
}

function posCmd(upto) {
  const base = G.startFen === START ? "position startpos" : `position fen ${G.startFen}`;
  const mv = G.plies.slice(0, upto).map((p) => p.uci).join(" ");
  return mv ? `${base} moves ${mv}` : base;
}

function kingSquare(c) {
  const t = c.turn();
  for (const row of c.board()) for (const p of row) if (p && p.type === "k" && p.color === t) return p.square;
  return null;
}

// PV (uci list) -> SAN list from a FEN
function pvToSan(fen, pv, max = 16) {
  const c = new Chess(fen);
  const out = [];
  for (const u of pv.slice(0, max)) {
    try {
      const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      out.push(m.san);
    } catch { break; }
  }
  return out;
}

function moveNumberPrefix(fen, i) {
  const f = fen.split(" ");
  let n = parseInt(f[5], 10) || 1;
  let white = f[1] === "w";
  const out = [];
  for (let k = 0; k <= i; k++) {
    out.push(white ? `${n}.` : (k === 0 ? `${n}…` : ""));
    if (!white) n++;
    white = !white;
  }
  return out[i];
}

// ---------------------------------------------------------------------------------------------
// engines
// ---------------------------------------------------------------------------------------------
const E = {};            // id -> {def, eng, loading, state, err}
for (const id of IDS) E[id] = { def: { ...DEFS[id] }, eng: null, loading: null, state: "idle", err: null };
function sfScript() {
  if (!ISO) return "stockfish/stockfish-19-lite-single.js";
  return S.sfVariant === "lite" ? "stockfish/stockfish-19-lite.js" : "stockfish/stockfish-19.js";
}

function getEngine(id) {
  const rec = E[id];
  if (rec.eng) return Promise.resolve(rec.eng);
  if (rec.loading) return rec.loading;
  if (!avail(id)) return Promise.reject(new Error("needs a cross-origin isolated page"));
  rec.err = null;
  setEngState(id, "load");
  const def = { ...rec.def };
  if (id === "stockfish") def.script = sfScript();
  const eng = new UciEngine(def);
  rec.loading = eng.start().then(() => {
    rec.eng = eng;
    rec.loading = null;
    rec.variant = def.script;
    rec.def.name = eng.title.replace(/^Stockfish (\d+).*$/, "Stockfish $1");
    if (id === "claudy") rec.def.name = eng.title;
    setEngState(id, "idle");
    return eng;
  }).catch((e) => {
    rec.loading = null;
    rec.err = e;
    rec.eng = null;
    eng.terminate();
    setEngState(id, "bad", e.message || String(e));
    throw e;
  });
  return rec.loading;
}

function dropEngine(id) {
  const rec = E[id];
  if (rec.eng) rec.eng.terminate();
  rec.eng = null;
  rec.loading = null;
  setEngState(id, "idle");
}

function effThreads(id, active = 1) {
  const cap = id === "claudy" || ISO ? MAXT : 1;
  const v = S.threads[id];
  if (v > 0) return Math.min(v, cap);
  const total = MOBILE ? Math.max(1, HC >> 1) : Math.max(1, MAXT - 1);
  return Math.max(1, Math.min(cap, Math.floor(total / active)));
}

function strengthOptions(id, st) {
  const def = DEFS[id];
  if (st && st.limit) {
    return { UCI_Elo: Math.max(def.eloMin, Math.min(def.eloMax, st.elo)), UCI_LimitStrength: "true" };
  }
  return { UCI_LimitStrength: "false" };
}

function baseOptions(id, { multipv = 1, active = 1, strength = null } = {}) {
  return {
    Threads: effThreads(id, active),
    Hash: S.hash[id],
    MultiPV: multipv,
    "Move Overhead": S.overhead,
    ...strengthOptions(id, strength),
  };
}

// per-engine live search view
const A = {};
for (const id of IDS) A[id] = { token: 0, lines: [], hist: [], stats: null, idx: -1, fen: START, running: false, note: "" };

function scoreWhite(info, fen) {
  const sign = fen.split(" ")[1] === "w" ? 1 : -1;
  return info.mate !== undefined ? { mate: sign * info.mate } : { cp: sign * info.cp };
}

function setEval(idx, score, depth, eng, force = false) {
  const cur = G.evals[idx];
  if (!force && cur && cur.depth > depth && cur.eng === eng) return;
  G.evals[idx] = { score, depth, eng };
}

function onInfo(id, token, idx, fen, info) {
  const a = A[id];
  if (a.token !== token || info.bound) return;
  const score = scoreWhite(info, fen);
  const line = { multipv: info.multipv, depth: info.depth, seldepth: info.seldepth, score, pv: info.pv || [], nodes: info.nodes, time: info.time, nps: info.nps };
  a.lines[info.multipv - 1] = line;
  a.stats = { depth: info.depth, nodes: info.nodes ?? a.stats?.nodes, nps: info.nps ?? a.stats?.nps, hashfull: info.hashfull ?? a.stats?.hashfull, time: info.time ?? a.stats?.time };
  if (info.multipv === 1) {
    const last = a.hist[a.hist.length - 1];
    const row = { depth: info.depth, score, time: info.time, nodes: info.nodes, nps: info.nps, hashfull: info.hashfull, pv: info.pv || [] };
    if (last && last.depth === row.depth) a.hist[a.hist.length - 1] = row;
    else a.hist.push(row);
    if (a.hist.length > 60) a.hist.shift();
    if (info.depth >= 6) setEval(idx, score, info.depth, id);
  }
  scheduleRender();
}

// ---------------------------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------------------------
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderLive(); });
}

const board = new Board($("#board"), {
  legalFrom: (sq) => [...new Set(chessAt(G.cursor).moves({ square: sq, verbose: true }).map((m) => m.to))],
  movable: (sq) => {
    const c = chessAt(G.cursor);
    const p = c.get(sq);
    if (!p || p.color !== c.turn() || c.isGameOver()) return false;
    if (mode === "analysis") return !review.active;
    return P.active && !P.over && !P.paused && G.cursor === G.plies.length && isHuman(c.turn());
  },
  onPromotionNeeded: (from, to) => {
    const c = chessAt(G.cursor);
    const promo = c.moves({ square: from, verbose: true }).some((m) => m.to === to && m.promotion);
    return promo ? board.askPromotion(to, c.turn()) : undefined;
  },
  onMove: (from, to, promo) => userMove(from, to, promo),
});

function renderBoard({ animate = true } = {}) {
  const c = chessAt(G.cursor);
  board.animate = S.animate;
  board.setOrientation(G.orient);
  board.setPosition(parsePlacement(G.fens[G.cursor]), { animate });
  const last = G.plies[G.cursor - 1];
  board.setLast(last ? last.from : null, last ? last.to : null);
  board.setCheck(c.isCheck() ? kingSquare(c) : null);
  const over = mode === "play" && P.over ? P.banner : "";
  board.banner(over);
  $("#evalbar").classList.toggle("flip", G.orient === "b");
}

function fmtClock(ms) {
  if (ms < 0) ms = 0;
  if (ms < 10000) return (ms / 1000).toFixed(1);
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function playerName(color) {
  if (mode === "play" && (P.active || P.over)) {
    const who = P[color === "w" ? "white" : "black"];
    if (who === "human") return { text: "You", tag: "" };
    const st = S.strength[who];
    return { text: E[who].def.name, tag: st.limit ? `Elo ${st.elo}` : "full strength" };
  }
  return { text: color === "w" ? "White" : "Black", tag: "" };
}

function renderPlayers() {
  const bottom = G.orient, top = bottom === "w" ? "b" : "w";
  const turn = chessAt(G.cursor).turn();
  const live = mode === "play" && P.active && !P.over && G.cursor === G.plies.length;
  for (const [box, color] of [["#ptop", top], ["#pbot", bottom]]) {
    const root = $(box);
    const n = playerName(color);
    const nameEl = $(".name", root);
    nameEl.textContent = n.text;
    if (n.tag) nameEl.appendChild(h("span", "tag", n.tag));
    if (live && P.thinking === color) nameEl.appendChild(h("span", "think", "thinking…"));
    const ck = $(".clock", root);
    const show = mode === "play" && (P.active || P.over) && P.base > 0;
    const ms = P.clocks[color];
    ck.textContent = show ? fmtClock(ms) : "";
    ck.classList.toggle("run", live && !P.paused && G.plies.length >= 2 && turn === color);
    ck.classList.toggle("low", show && ms < 10000);
  }
}

function renderEvalBar() {
  const bar = $("#evalbar");
  let e = G.evals[G.cursor];
  if (!e) for (let i = G.cursor - 1; i >= 0 && !e; i--) e = G.evals[i];
  const fill = $(".fill", bar), txt = $(".txt", bar);
  let pct = 50;
  const c = chessAt(G.cursor);
  if (c.isCheckmate()) pct = c.turn() === "w" ? 0 : 100;
  else if (e) pct = whiteWin(e.score);
  fill.style.height = pct + "%";
  const label = c.isCheckmate() ? (c.turn() === "w" ? "0-1" : "1-0") : (e ? fmtScore(e.score) : "");
  txt.textContent = label;
  const whiteBottom = G.orient === "w";
  const whiteAhead = pct >= 50;
  txt.classList.toggle("top", whiteAhead ? !whiteBottom : whiteBottom);
}

function renderMoves() {
  const root = $("#moves");
  root.innerHTML = "";
  if (!G.plies.length) {
    root.appendChild(h("div", "empty", "No moves yet."));
    return;
  }
  const f = G.startFen.split(" ");
  let num = parseInt(f[5], 10) || 1;
  let i = 0;
  const mk = (idx) => {
    const p = G.plies[idx];
    const d = h("div", "m" + (G.cursor === idx + 1 ? " cur" : ""));
    d.dataset.i = idx + 1;
    d.appendChild(document.createTextNode(p.san));
    const mark = G.marks[idx];
    if (mark) d.appendChild(h("span", "q " + mark.cls, mark.sym));
    const e = G.evals[idx + 1];
    if (e) d.appendChild(h("span", "e", fmtScore(e.score)));
    d.onclick = () => gotoPly(idx + 1);
    return d;
  };
  if (f[1] === "b") {
    root.appendChild(h("div", "n", num + "."));
    root.appendChild(h("div", "m", "…"));
    root.appendChild(mk(0));
    i = 1;
    num++;
  }
  for (; i < G.plies.length; i += 2) {
    root.appendChild(h("div", "n", num + "."));
    root.appendChild(mk(i));
    root.appendChild(i + 1 < G.plies.length ? mk(i + 1) : h("div"));
    num++;
  }
  const cur = $(".m.cur", root);
  if (cur) {   // scroll only the move list, never the page
    const top = cur.offsetTop - root.offsetTop;
    if (top < root.scrollTop || top + cur.offsetHeight > root.scrollTop + root.clientHeight)
      root.scrollTop = top - root.clientHeight / 2;
  }
}

const chart = new EvalChart($("#chart"), $("#chart-tip"), (i) => gotoPly(i));
function renderChart() {
  const data = [];
  for (let i = 0; i < G.fens.length; i++) data.push(G.evals[i]);
  const marks = G.marks.map((m, i) => m ? { i: i + 1, color: m.color } : null).filter(Boolean);
  chart.render(data, G.cursor, marks);
}

function renderNav() {
  $("#nav-first").disabled = G.cursor === 0;
  $("#nav-prev").disabled = G.cursor === 0;
  $("#nav-next").disabled = G.cursor >= G.plies.length;
  $("#nav-last").disabled = G.cursor >= G.plies.length;
}

// ---- engine panels -------------------------------------------------------------------------
const panels = {};
function buildPanel(id) {
  const def = DEFS[id];
  const root = h("div", "panel eng");
  root.id = "eng-" + id;
  const head = h("h3");
  const dot = h("span", "nm");
  dot.style.background = def.color;
  const title = h("span", "title", def.name);
  const state = h("span", "state");
  head.append(dot, title, state, h("span", "grow"), h("span", "dim cfg"));
  const sum = h("div", "sum");
  const score = h("span", "score", "–");
  sum.appendChild(score);
  const kv = {};
  for (const k of ["Depth", "Nodes", "NPS", "Hash", "Time"]) {
    const s = h("span", "kv", k + " ");
    kv[k] = h("b", "", "–");
    s.appendChild(kv[k]);
    sum.appendChild(s);
  }
  const wrap = h("div", "tablewrap");
  const table = h("table");
  const thead = h("thead");
  const tbody = h("tbody");
  table.append(thead, tbody);
  wrap.appendChild(table);
  const nodata = h("div", "nodata", "");
  root.append(head, sum, wrap, nodata);
  $("#engines").appendChild(root);
  panels[id] = { root, title, state, cfg: $(".cfg", head), score, kv, thead, tbody, nodata, wrap, mode: "" };
}
IDS.forEach(buildPanel);

function setEngState(id, st, msg) {
  const rec = E[id];
  rec.state = st;
  rec.msg = msg || "";
  if (panels[id]) renderEngState(id);
}

function renderEngState(id) {
  const p = panels[id], rec = E[id], a = A[id];
  const text = rec.state === "load" ? "loading…" : rec.state === "bad" ? "error: " + rec.msg : a.running ? "analysing" : (rec.eng ? "ready" : "idle");
  p.state.textContent = text;
  p.state.className = "state " + (rec.state === "load" ? "load" : rec.state === "bad" ? "bad" : a.running ? "think" : "");
  if (rec.state === "load" && id === "stockfish" && ISO && S.sfVariant === "full") p.state.textContent = "loading 94 MB…";
}

function fmtNum(n) {
  if (n === undefined || n === null || isNaN(n)) return "–";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "G";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}
function fmtTime(ms) {
  if (ms === undefined || isNaN(ms)) return "–";
  return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
}

function pvCell(fen, pv, interactive) {
  const td = h("td", "pv");
  const san = pvToSan(fen, pv, 14);
  const f = fen.split(" ");
  let num = parseInt(f[5], 10) || 1;
  let white = f[1] === "w";
  san.forEach((s, k) => {
    let label = "";
    if (white) label = num + ". ";
    else if (k === 0) label = num + "… ";
    const sp = h("span", "mv", label + s + " ");
    if (interactive) sp.onclick = () => playLine(pv.slice(0, k + 1));
    td.appendChild(sp);
    if (!white) num++;
    white = !white;
  });
  return td;
}

function renderEnginePanel(id) {
  const p = panels[id], a = A[id];
  const visible = panelVisible(id);
  p.root.hidden = !visible;
  if (!visible) return;
  p.title.textContent = E[id].def.name;
  const eng = E[id].eng;
  p.cfg.textContent = eng ? `${effThreads(id, activeAnalysisCount())} thr · ${S.hash[id]} MB` : "";
  renderEngState(id);
  const here = mode === "play" ? a.lines.length > 0 : (a.idx === G.cursor && a.fen === G.fens[G.cursor]);
  const top = here ? a.lines[0] : null;
  p.score.textContent = top ? fmtScore(top.score) : "–";
  const st = here ? a.stats : null;
  p.kv.Depth.textContent = st ? st.depth + (top && top.seldepth ? "/" + top.seldepth : "") : "–";
  p.kv.Nodes.textContent = st ? fmtNum(st.nodes) : "–";
  p.kv.NPS.textContent = st ? fmtNum(st.nps) : "–";
  p.kv.Hash.textContent = st && st.hashfull !== undefined ? (st.hashfull / 10).toFixed(0) + "%" : "–";
  p.kv.Time.textContent = st ? fmtTime(st.time) : "–";
  const multi = mode === "analysis" && S.lines > 1;
  const want = multi ? "multi" : "hist";
  if (p.mode !== want) {
    p.mode = want;
    p.thead.innerHTML = multi
      ? "<tr><th>#</th><th>Score</th><th>Depth</th><th class='pv'>PV</th></tr>"
      : "<tr><th>Depth</th><th>Score</th><th>Time</th><th>Nodes</th><th>NPS</th><th>Hash</th><th class='pv'>PV</th></tr>";
  }
  p.tbody.innerHTML = "";
  if (!here) {
    p.nodata.textContent = a.note || (E[id].state === "bad" ? "" : (mode === "play" ? (P.thinking ? "Starting…" : "Waiting for its turn.") : (a.running ? "Starting…" : "Engine is off.")));
    return;
  }
  p.nodata.textContent = a.note || "";
  const fen = a.fen;
  const interactive = mode === "analysis";
  const scoreTd = (sc) => {
    const td = h("td", "", fmtScore(sc));
    const v = sc.mate !== undefined ? sc.mate : sc.cp;
    td.className = v > 0 ? "pos" : v < 0 ? "neg" : "";
    return td;
  };
  if (multi) {
    a.lines.forEach((l, k) => {
      if (!l) return;
      const tr = h("tr");
      tr.append(h("td", "", String(k + 1)), scoreTd(l.score), h("td", "", String(l.depth)), pvCell(fen, l.pv, interactive));
      p.tbody.appendChild(tr);
    });
  } else {
    for (let k = a.hist.length - 1; k >= Math.max(0, a.hist.length - 40); k--) {
      const r = a.hist[k];
      const tr = h("tr");
      tr.append(h("td", "", String(r.depth)), scoreTd(r.score), h("td", "", fmtTime(r.time)), h("td", "", fmtNum(r.nodes)),
        h("td", "", fmtNum(r.nps)), h("td", "", r.hashfull !== undefined ? (r.hashfull / 10).toFixed(0) + "%" : "–"),
        pvCell(fen, r.pv, interactive));
      p.tbody.appendChild(tr);
    }
  }
}

function panelVisible(id) {
  if (mode === "analysis") return S.anEngines.includes(id);
  if (!(P.active || P.over)) return false;
  return P.white === id || P.black === id;
}

function activeAnalysisCount() {
  return mode === "analysis" ? Math.max(1, S.anEngines.filter(avail).length) : 1;
}

// Hint: the strongest Claudy suggests a move for the person to move; shown as an arrow until a move is played.
let hintState = null;       // {idx, uci}
let hintBusy = false;
async function hint() {
  if (hintBusy || !P.active || P.over || P.paused || G.cursor !== G.plies.length) return;
  const idx = G.plies.length;
  if (!isHuman(chessAt(idx).turn())) return;
  hintBusy = true;
  $("#btn-hint").disabled = true;
  $("#btn-hint").textContent = "Thinking…";
  try {
    const eng = await getEngine("claudy");
    const res = await eng.begin({
      options: baseOptions("claudy", { multipv: 1, active: 1, strength: null }),
      pos: posCmd(idx), go: "go movetime 2000",
      cancelled: () => G.plies.length !== idx || !P.active,
    });
    if (res && res.best && G.plies.length === idx) hintState = { idx, uci: res.best };
  } catch (e) { /* engine unavailable */ }
  hintBusy = false;
  $("#btn-hint").disabled = false;
  $("#btn-hint").textContent = "Hint";
  renderArrows();
}

function renderArrows() {
  if (mode === "play") {
    const h = hintState;
    board.setArrows(h && P.active && h.idx === G.plies.length && G.cursor === h.idx
      ? [{ from: h.uci.slice(0, 2), to: h.uci.slice(2, 4), color: "#e8941a", width: 0.17, opacity: 0.85 }] : []);
    return;
  }
  if (mode !== "analysis" || review.active) { board.setArrows([]); return; }
  const arrows = [];
  for (const id of S.anEngines) {
    const a = A[id];
    if (a.idx !== G.cursor || a.fen !== G.fens[G.cursor]) continue;
    a.lines.forEach((l, k) => {
      if (!l || !l.pv.length) return;
      const u = l.pv[0];
      arrows.push({ from: u.slice(0, 2), to: u.slice(2, 4), color: DEFS[id].color, width: k === 0 ? 0.17 : 0.1, opacity: k === 0 ? 0.8 : 0.45 });
    });
  }
  board.setArrows(arrows);
}

function renderLive() {
  for (const id of IDS) renderEnginePanel(id);
  renderEvalBar();
  renderChart();
  renderArrows();
  renderPlayers();
}

function renderAll({ animate = true } = {}) {
  renderBoard({ animate });
  renderMoves();
  renderNav();
  renderLive();
  renderModePanels();
}

// ---------------------------------------------------------------------------------------------
// navigation and user input
// ---------------------------------------------------------------------------------------------
function gotoPly(i, { animate = true } = {}) {
  i = Math.max(0, Math.min(G.plies.length, i));
  if (i === G.cursor) return;
  const step = Math.abs(i - G.cursor);
  G.cursor = i;
  renderAll({ animate: animate && step === 1 });
  if (mode === "analysis") restartAnalysis();
}

function userMove(from, to, promo) {
  if (mode === "play") {
    if (!P.active || P.over || G.cursor !== G.plies.length) return;
    commitPlayMove(from, to, promo, "human");
  } else {
    if (review.active) return;
    const r = playMove(from, to, promo);
    if (!r) return;
    renderAll();
    restartAnalysis();
  }
}

function playLine(ucis) {
  if (mode !== "analysis" || review.active) return;
  for (const u of ucis) {
    if (!playMove(u.slice(0, 2), u.slice(2, 4), u[4])) break;
  }
  renderAll();
  restartAnalysis();
}

// ---------------------------------------------------------------------------------------------
// analysis
// ---------------------------------------------------------------------------------------------
let anTimer = 0;
function restartAnalysis() {
  clearTimeout(anTimer);
  anTimer = setTimeout(() => { for (const id of IDS) runAnalysis(id); }, 120);
}

function stopAnalysis(id) {
  const a = A[id];
  a.token++;
  a.running = false;
  const eng = E[id].eng;
  if (eng) eng.halt();
  renderEngState(id);
}

async function runAnalysis(id) {
  if (mode !== "analysis" || !S.anEngines.includes(id) || review.active) { stopAnalysis(id); return; }
  const a = A[id];
  const t = ++a.token;
  const idx = G.cursor, fen = G.fens[idx];
  a.lines = []; a.hist = []; a.stats = null; a.idx = idx; a.fen = fen; a.note = "";
  const c = chessAt(idx);
  if (c.isGameOver()) {
    a.running = false;
    a.note = c.isCheckmate() ? "Checkmate." : "Game is drawn.";
    if (E[id].eng) E[id].eng.halt();
    scheduleRender();
    return;
  }
  a.running = true;
  scheduleRender();
  let eng;
  try { eng = await getEngine(id); } catch (e) { a.running = false; scheduleRender(); return; }
  if (a.token !== t) return;
  const options = baseOptions(id, { multipv: S.lines, active: activeAnalysisCount() });
  options.UCI_LimitStrength = "false";
  eng.begin({
    options, pos: posCmd(idx), go: "go infinite",
    onInfo: (info) => onInfo(id, t, idx, fen, info),
    cancelled: () => a.token !== t,
  }).then(() => { if (a.token === t) { a.running = false; scheduleRender(); } }).catch(() => {});
  renderEngState(id);
}

function setAnalysisEngines(list) {
  S.anEngines = list;
  save();
  for (const id of IDS) if (!list.includes(id)) stopAnalysis(id);
  renderAll({ animate: false });
  restartAnalysis();
}

// full-game review ------------------------------------------------------------------------------
const review = { active: false, cancel: false };

function classify() {
  G.marks = [];
  const accs = { w: [], b: [] };
  for (let i = 0; i < G.plies.length; i++) {
    const before = G.evals[i], after = G.evals[i + 1];
    if (!before || !after) continue;
    const color = G.plies[i].color;
    const wb = whiteWin(before.score), wa = whiteWin(after.score);
    const loss = Math.max(0, color === "w" ? wb - wa : wa - wb);
    accs[color].push(Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669)));
    if (loss >= 30) G.marks[i] = { sym: "??", cls: "blu", color: "#ff5555" };
    else if (loss >= 20) G.marks[i] = { sym: "?", cls: "mis", color: "#e8802a" };
    else if (loss >= 10) G.marks[i] = { sym: "?!", cls: "ina", color: "#d5b020" };
  }
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  G.acc = { w: avg(accs.w), b: avg(accs.b) };
}

async function reviewGame() {
  if (review.active) { review.cancel = true; for (const id of IDS) E[id].eng && E[id].eng.halt(); return; }
  if (!G.plies.length) return;
  const id = S.reviewEng, ms = S.reviewTime;
  for (const x of IDS) stopAnalysis(x);
  board.setArrows([]);
  review.active = true;
  review.cancel = false;
  G.marks = [];
  G.acc = null;
  const prog = $("#an-progress");
  prog.hidden = false;
  $("#an-accuracy").hidden = true;
  const btn = $("#an-review");
  btn.textContent = "Stop";
  let eng;
  try { eng = await getEngine(id); } catch (e) { review.active = false; prog.hidden = true; btn.textContent = "Analyse game"; return; }
  const n = G.fens.length;
  try {
    for (let i = n - 1; i >= 0 && !review.cancel; i--) {      // from the end: the cursor position gets its eval last-minute
      $(".bar > div", prog).style.width = ((n - 1 - i) / n) * 100 + "%";
      $("span", prog).textContent = `Position ${n - i} / ${n}`;
      const c = chessAt(i);
      if (c.isCheckmate()) { G.evals[i] = { score: { mate: c.turn() === "w" ? -1 : 1, final: true }, depth: 99, eng: id }; continue; }
      if (c.isGameOver()) { G.evals[i] = { score: { cp: 0 }, depth: 99, eng: id }; continue; }
      const fen = G.fens[i];
      let last = null;
      const res = await eng.begin({
        options: { ...baseOptions(id, { multipv: 1 }), UCI_LimitStrength: "false" },
        pos: posCmd(i), go: `go movetime ${ms}`,
        onInfo: (info) => { if (!info.bound && info.multipv === 1) last = { score: scoreWhite(info, fen), depth: info.depth }; },
        cancelled: () => review.cancel,
      });
      if (res && last) G.evals[i] = { score: last.score, depth: last.depth, eng: id };
      scheduleRender();
      renderMoves();
    }
  } catch (e) { /* engine died */ }
  review.active = false;
  prog.hidden = true;
  btn.textContent = "Analyse game";
  if (!review.cancel) classify();
  review.cancel = false;
  renderAll({ animate: false });
  restartAnalysis();
}

// ---------------------------------------------------------------------------------------------
// play mode
// ---------------------------------------------------------------------------------------------
const P = {
  white: "human", black: "claudy", active: false, over: false, result: "", reason: "", banner: "",
  base: 0, inc: 0, think: 1000, clocks: { w: 0, b: 0 }, tickAt: 0, paused: false, mtoken: 0, thinking: null,
};
const isHuman = (color) => P[color === "w" ? "white" : "black"] === "human";
const engineIds = () => [...new Set([P.white, P.black])].filter((x) => x !== "human");

async function startGame() {
  review.cancel = true;
  for (const id of IDS) stopAnalysis(id);
  const [base, inc] = $("#ng-tc").value.split("+").map(Number);
  P.mtoken++;
  resetGame(START);
  Object.assign(P, {
    white: S.white, black: S.black, active: true, over: false, result: "", reason: "", banner: "",
    base, inc, think: S.think, clocks: { w: base, b: base }, paused: false, thinking: null, tickAt: performance.now(),
  });
  G.orient = P.white === "human" ? "w" : (P.black === "human" ? "b" : "w");
  renderAll({ animate: false });
  for (const id of engineIds()) {
    if (!avail(id)) continue;
    getEngine(id).then((e) => e.newGame()).catch(() => {});
  }
  maybeEngineMove();
}

function endGame(result, reason) {
  if (P.over) return;
  P.over = true;
  P.active = false;
  P.result = result;
  P.reason = reason;
  P.mtoken++;
  P.thinking = null;
  for (const id of engineIds()) E[id].eng && E[id].eng.halt();
  const who = result === "1-0" ? "White wins" : result === "0-1" ? "Black wins" : "Draw";
  P.banner = `${who} · ${reason}`;
  const c = chessAt(G.plies.length);
  if (c.isCheckmate()) G.evals[G.plies.length] = { score: { mate: c.turn() === "w" ? -1 : 1, final: true }, depth: 99, eng: "" };
  renderAll({ animate: false });
}

function checkGameEnd() {
  const c = new Chess(G.startFen);
  for (const p of G.plies) c.move({ from: p.from, to: p.to, promotion: p.promo });
  if (c.isCheckmate()) { endGame(c.turn() === "w" ? "0-1" : "1-0", "checkmate"); return true; }
  if (c.isStalemate()) { endGame("1/2-1/2", "stalemate"); return true; }
  if (c.isInsufficientMaterial()) { endGame("1/2-1/2", "insufficient material"); return true; }
  if (c.isThreefoldRepetition()) { endGame("1/2-1/2", "threefold repetition"); return true; }
  if (c.isDrawByFiftyMoves()) { endGame("1/2-1/2", "50-move rule"); return true; }
  return false;
}

function commitPlayMove(from, to, promo, who) {
  const nBefore = G.plies.length;
  const mover = chessAt(G.cursor).turn();
  const r = playMove(from, to, promo);
  if (!r) return false;
  if (P.base > 0 && nBefore >= 2) P.clocks[mover] += P.inc;
  P.tickAt = performance.now();
  P.thinking = null;
  renderAll();
  if (!checkGameEnd()) maybeEngineMove();
  return true;
}

async function maybeEngineMove() {
  if (!P.active || P.over || P.paused) return;
  if (G.cursor !== G.plies.length) { G.cursor = G.plies.length; renderAll({ animate: false }); }
  const idx = G.plies.length;
  const c = chessAt(idx);
  const color = c.turn();
  const id = P[color === "w" ? "white" : "black"];
  if (id === "human") return;
  const token = ++P.mtoken;
  P.thinking = color;
  const a = A[id];
  const t = ++a.token;
  const fen = G.fens[idx];
  a.lines = []; a.hist = []; a.stats = null; a.idx = idx; a.fen = fen; a.note = ""; a.running = true;
  renderPlayers();
  scheduleRender();
  let eng;
  try { eng = await getEngine(id); } catch (e) { P.thinking = null; P.paused = true; renderAll({ animate: false }); return; }
  if (P.mtoken !== token) return;
  const go = P.base > 0
    ? `go wtime ${Math.max(1, Math.round(P.clocks.w))} btime ${Math.max(1, Math.round(P.clocks.b))} winc ${P.inc} binc ${P.inc}`
    : `go movetime ${P.think}`;
  let res = null;
  try {
    res = await eng.begin({
      options: baseOptions(id, { multipv: 1, active: engineIds().length, strength: S.strength[id] }),
      pos: posCmd(idx), go,
      onInfo: (info) => onInfo(id, t, idx, fen, info),
      cancelled: () => P.mtoken !== token,
    });
  } catch (e) { return; }
  a.running = false;
  if (!res || P.mtoken !== token) return;
  P.thinking = null;
  if (!res.best) { checkGameEnd(); return; }
  commitPlayMove(res.best.slice(0, 2), res.best.slice(2, 4), res.best[4], id);
}

function tick() {
  const now = performance.now();
  if (P.active && !P.over && !P.paused && P.base > 0 && G.plies.length >= 2 && mode === "play") {
    const side = chessAt(G.plies.length).turn();
    P.clocks[side] -= now - P.tickAt;
    if (P.clocks[side] <= 0) {
      P.clocks[side] = 0;
      endGame(side === "w" ? "0-1" : "1-0", "time out");
    }
  }
  P.tickAt = now;
  if (P.active || P.over) renderPlayers();
}
setInterval(tick, 100);

function resign() {
  if (!P.active) return;
  const humans = ["w", "b"].filter(isHuman);
  const color = humans.length === 1 ? humans[0] : chessAt(G.plies.length).turn();
  endGame(color === "w" ? "0-1" : "1-0", (color === "w" ? "White" : "Black") + " resigned");
}

async function takeback() {
  if (!P.active || P.over) return;
  const humans = ["w", "b"].filter(isHuman);
  if (humans.length !== 1) return;
  const n = G.plies.length;
  if (!n) return;
  P.mtoken++;
  P.thinking = null;
  for (const id of engineIds()) E[id].eng && E[id].eng.halt();
  const turn = chessAt(n).turn();
  const remove = turn === humans[0] ? Math.min(2, n) : 1;
  truncate(n - remove);
  G.cursor = n - remove;
  P.tickAt = performance.now();
  renderAll({ animate: false });
  maybeEngineMove();
}

function togglePause() {
  if (!P.active) return;
  P.paused = !P.paused;
  P.tickAt = performance.now();
  if (P.paused) { P.mtoken++; P.thinking = null; for (const id of engineIds()) E[id].eng && E[id].eng.halt(); }
  else maybeEngineMove();
  renderAll({ animate: false });
}

function renderPlayPanel() {
  const inGame = P.active || P.over;
  $("#ng").hidden = inGame;
  $("#ingame").hidden = !inGame;
  $("#p-play h3").textContent = inGame ? "Game" : "New game";
  if (inGame) {
    const nm = (w) => (w === "human" ? "You" : E[w].def.name);
    $("#ig-status").textContent = P.over ? P.banner : (P.paused ? "Paused" : `${nm(P.white)} vs ${nm(P.black)}`);
    const tc = P.base > 0 ? `${P.base / 60000} + ${P.inc / 1000}` : `unlimited, ${P.think / 1000}s per engine move`;
    $("#ig-sub").textContent = P.over ? `${nm(P.white)} vs ${nm(P.black)} · ${tc}` : tc;
    $("#ig-resign").hidden = !P.active || engineIds().length === 2;
    $("#ig-pause").hidden = !(P.active && engineIds().length === 2);
    $("#ig-pause").textContent = P.paused ? "Resume" : "Pause";
    $("#ig-analyze").hidden = !P.over;
    $("#btn-undo").hidden = !(P.active && ["w", "b"].filter(isHuman).length === 1);
    $("#btn-hint").hidden = $("#btn-undo").hidden;
  } else {
    $("#btn-undo").hidden = true;
    $("#btn-hint").hidden = true;
  }
}

function buildNewGameForm() {
  const labels = { human: "You", claudy: "Claudy", stockfish: "Stockfish" };
  for (const key of ["white", "black"]) {
    const seg = $("#ng-" + key);
    seg.innerHTML = "";
    for (const v of ["human", "claudy", "stockfish"]) {
      const b = h("button", S[key] === v ? "on" : "", labels[v]);
      if (!avail(v)) { b.disabled = true; b.title = "Needs a cross-origin isolated page"; }
      b.onclick = () => { S[key] = v; save(); buildNewGameForm(); };
      seg.appendChild(b);
    }
  }
  $("#ng-tc").value = S.tc;
  $("#ng-think").value = String(S.think);
  $("#ng-think-row").hidden = $("#ng-tc").value !== "0+0";
  const box = $("#ng-strength");
  box.innerHTML = "";
  for (const id of new Set([S.white, S.black])) {
    if (id === "human") continue;
    const def = DEFS[id], st = S.strength[id];
    const row = h("div", "row");
    row.appendChild(h("label", "", def.short));
    const seg = h("div", "seg");
    const full = h("button", st.limit ? "" : "on", "Full strength");
    const lim = h("button", st.limit ? "on" : "", "Limit Elo");
    full.onclick = () => { st.limit = false; save(); buildNewGameForm(); };
    lim.onclick = () => { st.limit = true; save(); buildNewGameForm(); };
    seg.append(full, lim);
    row.appendChild(seg);
    if (st.limit) {
      const sr = h("div", "sliderrow");
      const rng = h("input");
      rng.type = "range"; rng.min = def.eloMin; rng.max = def.eloMax; rng.step = 50;
      st.elo = Math.max(def.eloMin, Math.min(def.eloMax, st.elo));
      rng.value = st.elo;
      const out = h("output", "", String(st.elo));
      rng.oninput = () => { st.elo = +rng.value; out.textContent = rng.value; };
      rng.onchange = save;
      sr.append(rng, out);
      row.appendChild(sr);
    }
    box.appendChild(row);
  }
}

// ---------------------------------------------------------------------------------------------
// mode switching, panels
// ---------------------------------------------------------------------------------------------
function renderModePanels() {
  $("#p-play").hidden = mode !== "play";
  $("#p-analysis").hidden = mode !== "analysis";
  $("#tab-play").classList.toggle("on", mode === "play");
  $("#tab-analysis").classList.toggle("on", mode === "analysis");
  renderPlayPanel();
  if (mode === "analysis") {
    $$("#an-engines button").forEach((b) => b.classList.toggle("on", S.anEngines.includes(b.dataset.id)));
    $$("#an-lines button").forEach((b) => b.classList.toggle("on", +b.dataset.n === S.lines));
    const acc = $("#an-accuracy");
    if (G.acc && (G.acc.w !== null || G.acc.b !== null)) {
      acc.hidden = false;
      const cnt = (cls) => (c) => G.marks.filter((m, i) => m && m.cls === cls && G.plies[i].color === c).length;
      const line = (c) => `${c === "w" ? "White" : "Black"}: <b>${G.acc[c] === null ? "–" : G.acc[c].toFixed(1) + "%"}</b> accuracy · ` +
        `${cnt("ina")(c)} inaccuracies, ${cnt("mis")(c)} mistakes, ${cnt("blu")(c)} blunders`;
      acc.innerHTML = line("w") + "<br>" + line("b");
    } else acc.hidden = true;
  }
}

function setMode(m) {
  if (m === mode) return;
  if (m === "analysis" && P.active && !P.over) {
    if (!confirm("Leave the running game? It will be abandoned.")) return;
    P.mtoken++;
    P.active = false;
    P.over = true;
    P.banner = "Game abandoned";
    P.thinking = null;
    for (const id of engineIds()) E[id].eng && E[id].eng.halt();
  }
  mode = m;
  if (m === "play") for (const id of IDS) stopAnalysis(id);
  board.setArrows([]);
  renderAll({ animate: false });
  if (m === "analysis") restartAnalysis();
}

// ---------------------------------------------------------------------------------------------
// import / export
// ---------------------------------------------------------------------------------------------
function buildPgn() {
  const c = new Chess(G.startFen);
  for (const p of G.plies) c.move({ from: p.from, to: p.to, promotion: p.promo });
  const names = (color) => {
    const n = playerName(color).text;
    return n === "You" ? "Player" : n;
  };
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
  c.setHeader("Event", "Claudy Web");
  c.setHeader("Site", location.href.split("#")[0]);
  c.setHeader("Date", date);
  c.setHeader("White", names("w"));
  c.setHeader("Black", names("b"));
  if (mode === "play" && P.result) c.setHeader("Result", P.result);
  return c.pgn();
}

function importText(text) {
  text = text.trim();
  if (!text) throw new Error("nothing to import");
  const looksFen = /^[rnbqkpRNBQKP1-8]+(\/[rnbqkpRNBQKP1-8]+){7}\s+[wb]\s/.test(text) && !/\[|\d\.\s/.test(text.split("\n")[0].slice(60));
  if (looksFen) {
    const c = new Chess(text);       // throws when invalid
    resetGame(c.fen());
    return;
  }
  const c = new Chess();
  c.loadPgn(text);
  const hist = c.history({ verbose: true });
  const startFen = c.header().FEN || START;
  resetGame(startFen);
  for (const m of hist) if (!playMove(m.from, m.to, m.promotion)) throw new Error("illegal move in PGN: " + m.san);
  G.cursor = 0;
}

async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = h("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = "Copied";
  setTimeout(() => { btn.textContent = old; }, 1200);
}

// ---------------------------------------------------------------------------------------------
// settings dialog
// ---------------------------------------------------------------------------------------------
function buildSettings() {
  const body = $("#set-body");
  body.innerHTML = "";
  const num = (label, get, set, min, max, hint) => {
    const row = h("div", "row");
    row.appendChild(h("label", "", label));
    const i = h("input");
    i.type = "number"; i.min = min; i.max = max; i.value = get();
    i.onchange = () => { set(Math.max(min, Math.min(max, +i.value || 0))); i.value = get(); save(); };
    row.appendChild(i);
    if (hint) row.appendChild(h("span", "dim small", hint));
    return row;
  };
  for (const id of IDS) {
    const g = h("div", "setgrp");
    g.appendChild(h("h4", "", DEFS[id].name));
    if (id === "claudy" && !ISO) { g.appendChild(h("div", "dim small", "Unavailable: this page is not cross-origin isolated.")); body.appendChild(g); continue; }
    const cap = id === "claudy" || ISO ? MAXT : 1;
    g.appendChild(num("Threads", () => S.threads[id], (v) => { S.threads[id] = v; }, 0, cap, `0 = automatic (${effThreads(id)} now, max ${cap})`));
    g.appendChild(num("Hash (MB)", () => S.hash[id], (v) => { S.hash[id] = v; }, 1, 1024, ""));
    if (id === "stockfish" && ISO) {
      const row = h("div", "row");
      row.appendChild(h("label", "", "Network"));
      const sel = h("select");
      sel.innerHTML = '<option value="full">Full (94 MB download, strongest)</option><option value="lite">Lite (1.6 MB, weaker)</option>';
      sel.value = S.sfVariant;
      sel.onchange = () => { S.sfVariant = sel.value; save(); dropEngine("stockfish"); };
      row.appendChild(sel);
      g.appendChild(row);
    }
    body.appendChild(g);
  }
  const g = h("div", "setgrp");
  g.appendChild(h("h4", "", "General"));
  g.appendChild(num("Move overhead (ms)", () => S.overhead, (v) => { S.overhead = v; }, 0, 2000, "safety margin per engine move"));
  const row = h("div", "row");
  row.appendChild(h("label", "", "Animation"));
  const cb = h("input");
  cb.type = "checkbox"; cb.checked = S.animate;
  cb.onchange = () => { S.animate = cb.checked; save(); };
  row.appendChild(cb);
  g.appendChild(row);
  body.appendChild(g);
}

// ---------------------------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------------------------
function wire() {
  $("#tab-play").onclick = () => setMode("play");
  $("#tab-analysis").onclick = () => setMode("analysis");
  $("#btn-flip").onclick = () => { G.orient = G.orient === "w" ? "b" : "w"; renderAll({ animate: false }); };
  $("#nav-first").onclick = () => gotoPly(0);
  $("#nav-prev").onclick = () => gotoPly(G.cursor - 1);
  $("#nav-next").onclick = () => gotoPly(G.cursor + 1);
  $("#nav-last").onclick = () => gotoPly(G.plies.length);
  $("#btn-undo").onclick = takeback;
  $("#btn-hint").onclick = hint;
  $("#btn-settings").onclick = () => { buildSettings(); $("#dlg-settings").showModal(); };

  $("#ng-start").onclick = startGame;
  $("#ng-swap").onclick = () => { [S.white, S.black] = [S.black, S.white]; save(); buildNewGameForm(); };
  $("#ng-tc").onchange = () => { S.tc = $("#ng-tc").value; save(); $("#ng-think-row").hidden = S.tc !== "0+0"; };
  $("#ng-think").onchange = () => { S.think = +$("#ng-think").value; save(); };
  $("#ig-resign").onclick = () => { if (confirm("Resign this game?")) resign(); };
  $("#ig-pause").onclick = togglePause;
  $("#ig-new").onclick = () => {
    if (P.active && !confirm("Abandon the running game?")) return;
    P.mtoken++; P.active = false; P.over = false; P.thinking = null;
    for (const id of engineIds()) E[id].eng && E[id].eng.halt();
    resetGame(START);
    buildNewGameForm();
    renderAll({ animate: false });
  };
  $("#ig-analyze").onclick = () => setMode("analysis");

  // analysis panel
  const engBox = $("#an-engines");
  for (const id of IDS) {
    const b = h("button", "", DEFS[id].short);
    b.dataset.id = id;
    if (!avail(id)) b.disabled = true;
    b.onclick = () => {
      const on = S.anEngines.includes(id);
      setAnalysisEngines(on ? S.anEngines.filter((x) => x !== id) : [...S.anEngines, id]);
    };
    engBox.appendChild(b);
  }
  const linesBox = $("#an-lines");
  for (const n of [1, 2, 3, 4, 5]) {
    const b = h("button", "", String(n));
    b.dataset.n = n;
    b.onclick = () => { S.lines = n; save(); renderAll({ animate: false }); restartAnalysis(); };
    linesBox.appendChild(b);
  }
  const sel = $("#an-review-eng");
  for (const id of IDS) {
    const o = h("option", "", DEFS[id].short);
    o.value = id;
    if (!avail(id)) o.disabled = true;
    sel.appendChild(o);
  }
  sel.value = S.reviewEng;
  sel.onchange = () => { S.reviewEng = sel.value; save(); };
  $("#an-review-time").value = String(S.reviewTime);
  $("#an-review-time").onchange = () => { S.reviewTime = +$("#an-review-time").value; save(); };
  $("#an-review").onclick = reviewGame;
  $("#an-copy-pgn").onclick = (e) => copy(buildPgn(), e.target);
  $("#an-copy-fen").onclick = (e) => copy(G.fens[G.cursor], e.target);
  $("#an-reset").onclick = () => { resetGame(START); renderAll({ animate: false }); restartAnalysis(); };
  $("#an-import").onclick = () => { $("#import-text").value = ""; $("#import-err").textContent = ""; $("#dlg-import").showModal(); };
  $("#import-ok").onclick = (e) => {
    try { importText($("#import-text").value); } catch (err) {
      e.preventDefault();
      $("#import-err").textContent = String(err.message || err);
      return;
    }
    renderAll({ animate: false });
    restartAnalysis();
  };

  window.addEventListener("keydown", (e) => {
    if (e.target.closest && e.target.closest("input, textarea, select, dialog")) return;
    if (e.key === "ArrowLeft") { gotoPly(G.cursor - 1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { gotoPly(G.cursor + 1); e.preventDefault(); }
    else if (e.key === "Home" || e.key === "ArrowUp") { gotoPly(0); e.preventDefault(); }
    else if (e.key === "End" || e.key === "ArrowDown") { gotoPly(G.plies.length); e.preventDefault(); }
    else if (e.key === "f" || e.key === "F") $("#btn-flip").click();
  });
}

function sysChip() {
  const chip = $("#chip-sys");
  chip.textContent = `${HC} threads · ${ISO ? "isolated" : "not isolated"}`;
  chip.classList.toggle("on", ISO);
  chip.classList.toggle("off", !ISO);
  if (!ISO) {
    const n = $("#notice");
    n.hidden = false;
    n.innerHTML = "";
    const secure = window.isSecureContext;
    n.appendChild(h("span", "", secure
      ? "This page is not cross-origin isolated (service workers disabled, e.g. in a private window?). Claudy needs multi-threaded WebAssembly, so only Stockfish Lite is available."
      : "This page is not served over HTTPS, so cross-origin isolation is unavailable. Only Stockfish Lite works."));
    const b = h("button", "", "Reload");
    b.onclick = () => location.reload();
    n.appendChild(b);
  }
}

function init() {
  sysChip();
  wire();
  buildNewGameForm();
  renderAll({ animate: false });
  // warm up Claudy (1 MB) so the first game starts instantly
  if (avail("claudy")) getEngine("claudy").catch(() => {});
  window.__claudyweb = { G, S, E, A, P, board, engines: E };
}
init();
