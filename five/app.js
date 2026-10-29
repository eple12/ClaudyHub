/* ClaudyFive GUI: board, game flow and the engine worker. */
(() => {
  'use strict';
  const N = 15, BLACK = 1, WHITE = 2;
  const $ = (id) => document.getElementById(id);
  const LEVELS = claudyFiveFactory().LEVELS;

  // ---------------------------------------------------------------- persistence
  const store = {
    get(k, d) { try { const v = localStorage.getItem('cf.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('cf.' + k, JSON.stringify(v)); } catch (e) { /* private mode etc. */ } },
  };

  const S = {
    moves: [],            // [[x, y], ...]  black first
    human: BLACK,
    level: store.get('level', 3),
    over: false, winner: 0, line: null,
    thinking: false, thinkStart: 0, token: 0,
    info: null, engineColor: WHITE, seed: 1,
    analysis: store.get('analysis', false),
    numbers: store.get('numbers', false),
    sound: store.get('sound', true),
    colorPref: store.get('color', 'black'),
  };

  const colName = (c) => (c === BLACK ? '흑' : '백');
  const coord = (m) => String.fromCharCode(65 + m[0]) + (m[1] + 1);
  const turnColor = () => (S.moves.length % 2 === 0 ? BLACK : WHITE);

  // ---------------------------------------------------------------- engine (web worker, with a main-thread fallback)
  let worker = null, fallback = null, pending = null;

  function workerSource() {
    return `const CF=(${claudyFiveFactory.toString()})();
onmessage=function(e){var m=e.data;
if(m.type==='newgame'){CF.newGame(m.seed);}
else if(m.type==='go'){
 CF.setLevel(m.level,m.override);
 try{CF.setPosition(m.moves);}catch(err){postMessage({type:'error',id:m.id,msg:String(err)});return;}
 var res=CF.go(Object.assign({},m.limit,{onInfo:function(i){postMessage({type:'info',id:m.id,info:i});}}));
 postMessage({type:'best',id:m.id,res:res});}};`;
  }
  function spawnWorker() {
    if (worker) { worker.terminate(); worker = null; }
    try {
      const url = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (e) => {
        const m = e.data;
        if (!pending || m.id !== pending.id) return;
        if (m.type === 'info') pending.onInfo && pending.onInfo(m.info);
        else if (m.type === 'best') { const p = pending; pending = null; p.resolve(m.res); }
        else if (m.type === 'error') { const p = pending; pending = null; p.reject(new Error(m.msg)); }
      };
      worker.onerror = () => { worker = null; };
    } catch (err) {
      worker = null;
    }
  }
  let seq = 0;
  function think(moves, level, limit, onInfo, override) {
    const id = ++seq;
    if (!worker && !fallback) { fallback = claudyFiveFactory(); fallback.newGame(S.seed); }
    return new Promise((resolve, reject) => {
      pending = { id, resolve, reject, onInfo };
      if (worker) worker.postMessage({ type: 'go', id, moves, level, limit, override });
      else setTimeout(() => {                         // fallback: blocks the page while thinking
        try {
          fallback.setLevel(level, override); fallback.setPosition(moves);
          const res = fallback.go(Object.assign({}, limit, { onInfo }));
          if (pending && pending.id === id) { pending = null; resolve(res); }
        } catch (err) { reject(err); }
      }, 30);
    });
  }
  function abortEngine() {
    pending = null; S.token++;
    if (worker) { spawnWorker(); worker.postMessage({ type: 'newgame', seed: S.seed }); }
    else if (fallback) { fallback = null; }
  }

  // ---------------------------------------------------------------- sound
  let actx = null;
  function click(strong) {
    if (!S.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const t = actx.currentTime, len = 0.05;
      const buf = actx.createBuffer(1, actx.sampleRate * len, actx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
      const src = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
      f.type = 'bandpass'; f.frequency.value = strong ? 900 : 1200; f.Q.value = 1.2;
      g.gain.value = strong ? 0.9 : 0.6;
      src.buffer = buf; src.connect(f); f.connect(g); g.connect(actx.destination); src.start(t);
    } catch (e) { /* audio unavailable */ }
  }

  // ---------------------------------------------------------------- board drawing
  const boardEl = $('board'), stonesEl = $('stones'), ghostEl = $('ghost'), hintEl = $('hintmark'), gridEl = $('grid');
  const pos = (x, y) => ({ l: ((x + 1) / 16) * 100, t: ((N - y) / 16) * 100 });   // y=0 is the bottom row
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, text) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function drawGrid() {
    gridEl.textContent = '';
    for (let i = 0; i < N; i++) {
      const p = i + 1, edge = (i === 0 || i === N - 1) ? 'edge' : '';
      gridEl.appendChild(svg('line', { x1: 1, y1: p, x2: N, y2: p, class: edge }));
      gridEl.appendChild(svg('line', { x1: p, y1: 1, x2: p, y2: N, class: edge }));
      gridEl.appendChild(svg('text', { x: p, y: 0.45 }, String.fromCharCode(65 + i)));
      gridEl.appendChild(svg('text', { x: p, y: 15.55 }, String.fromCharCode(65 + i)));
      gridEl.appendChild(svg('text', { x: 0.45, y: N + 1 - p }, String(i + 1)));
      gridEl.appendChild(svg('text', { x: 15.55, y: N + 1 - p }, String(i + 1)));
    }
    for (const [x, y] of [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]])
      gridEl.appendChild(svg('circle', { cx: x + 1, cy: y + 1, r: 0.11, class: 'star' }));
  }

  const stoneEls = [];
  function renderStones(animateLast) {
    while (stoneEls.length > S.moves.length) stoneEls.pop().remove();
    while (stoneEls.length < S.moves.length) {
      const i = stoneEls.length, [x, y] = S.moves[i];
      const el = document.createElement('div');
      el.className = 'stone ' + (i % 2 === 0 ? 'b' : 'w');
      const p = pos(x, y);
      el.style.left = p.l + '%'; el.style.top = p.t + '%';
      const n = document.createElement('span'); n.className = 'num'; n.textContent = i + 1;
      el.appendChild(n);
      if (animateLast && i === S.moves.length - 1) el.classList.add('new');
      stonesEl.appendChild(el); stoneEls.push(el);
    }
    const last = S.moves.length - 1;
    stoneEls.forEach((el, i) => {
      el.classList.toggle('last', i === last);
      el.classList.remove('win');
    });
    const old = gridEl.querySelector('.winline');
    if (old) old.remove();
    if (S.line) {
      for (const [x, y] of S.line) {
        const i = S.moves.findIndex((m) => m[0] === x && m[1] === y);
        if (i >= 0) stoneEls[i].classList.add('win');
      }
      const a = S.line[0], b = S.line[S.line.length - 1];
      gridEl.appendChild(svg('line', { x1: a[0] + 1, y1: N - a[1], x2: b[0] + 1, y2: N - b[1], class: 'winline' }));
    }
  }

  function renderMoves() {
    const box = $('moves');
    box.textContent = '';
    for (let i = 0; i < S.moves.length; i += 2) {
      const n = document.createElement('div'); n.className = 'n'; n.textContent = i / 2 + 1; box.appendChild(n);
      for (let k = 0; k < 2; k++) {
        const d = document.createElement('div');
        d.className = 'm' + (i + k === S.moves.length - 1 ? ' cur' : '');
        d.textContent = S.moves[i + k] ? coord(S.moves[i + k]) : '';
        box.appendChild(d);
      }
    }
    box.scrollTop = box.scrollHeight;
    $('mv-count').textContent = S.moves.length ? S.moves.length + '수' : '';
  }

  // ---------------------------------------------------------------- UI state
  let tick = null;
  function renderStatus() {
    const myTurn = !S.over && !S.thinking && turnColor() === S.human;
    $('top-ico').className = 'stone-ico ' + (S.engineColor === BLACK ? 'b' : 'w');
    $('bot-ico').className = 'stone-ico ' + (S.human === BLACK ? 'b' : 'w');
    $('top-name').textContent = `ClaudyFive · 레벨 ${S.level} ${LEVELS[S.level].name}`;
    $('bot-name').textContent = '나';
    $('pl-top').classList.toggle('turn', S.thinking);
    $('pl-bot').classList.toggle('turn', myTurn);
    $('bot-status').textContent = myTurn ? '내 차례' : '';
    $('top-status').textContent = S.thinking ? `생각 중… ${((performance.now() - S.thinkStart) / 1000).toFixed(1)}s` : '';
    boardEl.classList.toggle('locked', !myTurn);
    $('btn-undo').disabled = S.moves.length <= (S.human === BLACK ? 0 : 1);
    $('btn-hint').disabled = !myTurn;
    $('btn-resign').disabled = S.over || S.moves.length === 0;
    $('chip-level').textContent = S.level;
    document.querySelectorAll('#levels button').forEach((b) => b.classList.toggle('on', +b.dataset.lv === S.level));
    $('lvl-name').textContent = `${S.level} · ${LEVELS[S.level].name}`;
    $('lvl-info').textContent = LEVELS[S.level].info;
    if (S.thinking && !tick) tick = setInterval(renderStatus, 200);
    if (!S.thinking && tick) { clearInterval(tick); tick = null; }
  }

  function showBanner(text) {
    $('banner-text').textContent = text;
    $('banner').hidden = !text;
  }

  function renderEval() {
    const panel = $('p-engine'), bar = $('evalbar');
    panel.hidden = !S.analysis;
    bar.hidden = !S.analysis;
    if (!S.analysis) return;
    const i = S.info;
    if (!i) { $('eng-eval').textContent = '–'; $('evalfill').style.height = '50%'; $('evaltxt').textContent = ''; return; }
    const sb = i.engineColor === BLACK ? i.score : -i.score;      // from black's point of view
    const mate = Math.abs(i.score) > 29700;
    const pBlack = mate ? (sb > 0 ? 1 : 0) : 1 / (1 + Math.exp(-sb / 5000));
    $('evalfill').style.height = ((1 - pBlack) * 100).toFixed(1) + '%';
    let txt;
    if (mate) { const n = Math.ceil((30000 - Math.abs(i.score)) / 2); txt = (sb > 0 ? '흑 #' : '백 #') + n; }
    else txt = (sb >= 0 ? '흑 +' : '백 +') + (Math.abs(sb) / 1000).toFixed(1);
    $('eng-eval').textContent = txt;
    $('evaltxt').textContent = mate ? '#' + Math.ceil((30000 - Math.abs(i.score)) / 2) : (sb / 1000).toFixed(1);
    $('eng-depth').textContent = i.depth || '–';
    $('eng-nodes').textContent = i.nodes >= 1000 ? (i.nodes / 1000).toFixed(i.nodes > 99999 ? 0 : 1) + 'k' : i.nodes;
    $('eng-time').textContent = (i.ms / 1000).toFixed(1) + 's';
    $('eng-nps').textContent = i.ms > 20 ? Math.round(i.nodes / i.ms) + 'k/s' : '–';
    const pv = $('eng-pv');
    pv.textContent = '';
    let c = i.engineColor;
    (i.pv || []).forEach((m, k) => {
      const lab = document.createElement('i'); lab.textContent = c === BLACK ? '●' : '○';
      pv.appendChild(lab); pv.appendChild(document.createTextNode(coord(m) + ' '));
      c = 3 - c;
    });
  }

  function renderAll(animateLast) {
    renderStones(animateLast);
    renderMoves();
    renderStatus();
    renderEval();
    hintEl.hidden = true;
  }

  // ---------------------------------------------------------------- rules: five (or more) in a row
  function winLine(moves) {
    if (!moves.length) return null;
    const grid = new Uint8Array(N * N);
    moves.forEach((m, i) => { grid[m[1] * N + m[0]] = (i % 2) + 1; });
    const [x, y] = moves[moves.length - 1], c = grid[y * N + x];
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const cells = [[x, y]];
      for (let s = -1; s <= 1; s += 2)
        for (let k = 1; k < N; k++) {
          const xx = x + s * k * dx, yy = y + s * k * dy;
          if (xx < 0 || yy < 0 || xx >= N || yy >= N || grid[yy * N + xx] !== c) break;
          if (s < 0) cells.unshift([xx, yy]); else cells.push([xx, yy]);
        }
      if (cells.length >= 5) return cells;
    }
    return null;
  }

  function afterMove() {
    const line = winLine(S.moves);
    if (line) {
      S.over = true; S.line = line; S.winner = turnColor() === BLACK ? WHITE : BLACK;   // the side that just moved
      endGame();
    } else if (S.moves.length >= N * N) { S.over = true; S.winner = 0; endGame(); }
  }
  function endGame(resigned) {
    let text;
    if (!S.winner) text = '무승부';
    else if (S.winner === S.human) text = resigned ? '엔진이 졌어요' : '승리! 🎉';
    else text = resigned ? '기권패' : '패배…';
    if (S.winner) text += ` (${colName(S.winner)})`;
    showBanner(text);
    renderAll(false);
  }

  // ---------------------------------------------------------------- game flow
  function newGame() {
    abortEngine();
    S.seed = (Math.random() * 4294967296) | 0;
    if (worker) worker.postMessage({ type: 'newgame', seed: S.seed });
    else fallback = null;
    S.colorPref = $('sel-color').value; store.set('color', S.colorPref);
    S.human = S.colorPref === 'random' ? (Math.random() < 0.5 ? BLACK : WHITE) : S.colorPref === 'white' ? WHITE : BLACK;
    S.engineColor = 3 - S.human;
    S.moves = []; S.over = false; S.winner = 0; S.line = null; S.info = null; S.thinking = false;
    showBanner('');
    renderAll(false);
    if (turnColor() !== S.human) engineMove();
  }

  async function engineMove() {
    if (S.over) return;
    S.thinking = true; S.thinkStart = performance.now();
    const token = ++S.token, level = S.level, base = S.moves.slice();
    renderStatus(); renderEval();
    let res;
    try {
      res = await think(base, level, {}, (i) => {
        if (token !== S.token) return;
        S.info = Object.assign({ engineColor: S.engineColor }, i); renderEval();
      });
    } catch (err) { if (token === S.token) { S.thinking = false; renderStatus(); } return; }
    if (token !== S.token || !res) return;
    const wait = Math.max(0, 350 - (performance.now() - S.thinkStart));     // so a reply is never a blur
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (token !== S.token) return;
    S.thinking = false;
    const pv = res.pv && res.pv.length ? res.pv : [res.move];
    if ((res.forced || res.overlooked) && S.info) S.info = Object.assign({}, S.info, { pv });   // no real score: keep the last one
    else S.info = Object.assign({ engineColor: S.engineColor }, res, { pv });
    S.moves.push(res.move);
    click(true);
    afterMove();
    renderAll(true);
  }

  function humanMove(x, y) {
    if (S.over || S.thinking || turnColor() !== S.human) return;
    if (S.moves.some((m) => m[0] === x && m[1] === y)) return;
    S.moves.push([x, y]);
    click(false);
    ghostEl.hidden = true;
    afterMove();
    renderAll(true);
    if (!S.over) engineMove();
  }

  function undo() {
    const minLen = S.human === BLACK ? 0 : 1;          // a white human keeps the engine's opening move
    if (S.moves.length <= minLen) return;
    if (S.thinking) abortEngine();
    S.thinking = false;
    S.moves.pop();                                      // back to the human's turn (one or two plies)
    if (turnColor() !== S.human && S.moves.length > minLen) S.moves.pop();
    S.over = false; S.winner = 0; S.line = null; S.info = null;
    showBanner('');
    renderAll(false);
    if (turnColor() !== S.human) engineMove();
  }

  async function hint() {
    if (S.over || S.thinking || turnColor() !== S.human) return;
    const token = ++S.token;
    $('btn-hint').disabled = true;
    $('bot-status').textContent = '추천수 계산 중…';
    let res;
    try { res = await think(S.moves.slice(), 9, { ms: 1200 }, null, { blunder: 0, miss: 0, noise: 0 }); } catch (e) { return; }
    if (token !== S.token || !res) return;
    renderStatus();
    const p = pos(res.move[0], res.move[1]);
    hintEl.style.left = p.l + '%'; hintEl.style.top = p.t + '%'; hintEl.hidden = false;
  }

  function resign() {
    if (S.over || !S.moves.length) return;
    abortEngine();
    S.thinking = false; S.over = true; S.winner = S.engineColor;
    endGame(true);
  }

  // ---------------------------------------------------------------- input
  function cellFromEvent(e) {
    const r = boardEl.getBoundingClientRect();
    const u = ((e.clientX - r.left) / r.width) * 16 - 1, v = ((e.clientY - r.top) / r.height) * 16 - 1;
    const x = Math.round(u), y = N - 1 - Math.round(v);
    if (x < 0 || x >= N || y < 0 || y >= N) return null;
    return [x, y];
  }
  boardEl.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const myTurn = !S.over && !S.thinking && turnColor() === S.human;
    const c = myTurn ? cellFromEvent(e) : null;
    if (!c || S.moves.some((m) => m[0] === c[0] && m[1] === c[1])) { ghostEl.hidden = true; return; }
    const p = pos(c[0], c[1]);
    ghostEl.style.left = p.l + '%'; ghostEl.style.top = p.t + '%';
    ghostEl.className = 'ghost stone ' + (S.human === BLACK ? 'b' : 'w');
    ghostEl.hidden = false;
  });
  boardEl.addEventListener('pointerleave', () => { ghostEl.hidden = true; });
  boardEl.addEventListener('click', (e) => {
    const c = cellFromEvent(e);
    if (c) humanMove(c[0], c[1]);
  });

  $('btn-new').addEventListener('click', newGame);
  $('banner-new').addEventListener('click', newGame);
  $('btn-undo').addEventListener('click', undo);
  $('btn-hint').addEventListener('click', hint);
  $('btn-resign').addEventListener('click', resign);
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'u' || e.key === 'U') undo();
    else if (e.key === 'h' || e.key === 'H') hint();
    else if (e.key === 'n' || e.key === 'N') newGame();
  });

  // level pills
  const lv = $('levels');
  for (let i = 1; i <= 10; i++) {
    const b = document.createElement('button');
    b.dataset.lv = i; b.setAttribute('role', 'radio');
    b.innerHTML = `<b>${i}</b><span>${LEVELS[i].name}</span>`;
    b.addEventListener('click', () => { S.level = i; store.set('level', i); renderStatus(); });
    lv.appendChild(b);
  }

  function bindToggle(id, key, apply) {
    const el = $(id);
    el.checked = S[key];
    el.addEventListener('change', () => { S[key] = el.checked; store.set(key, el.checked); apply(); });
    apply();
  }
  bindToggle('opt-analysis', 'analysis', renderEval);
  bindToggle('opt-numbers', 'numbers', () => document.body.classList.toggle('numbers', S.numbers));
  bindToggle('opt-sound', 'sound', () => {});

  // theme
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    const dark = t ? t === 'dark' : !(window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
    $('btn-theme').textContent = dark ? '☀︎' : '☾';
    document.querySelector('meta[name=theme-color]').content = dark ? '#161512' : '#edebe9';
  }
  let theme = store.get('theme', null);
  applyTheme(theme);
  $('btn-theme').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark'
      : !(window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
    theme = dark ? 'light' : 'dark'; store.set('theme', theme); applyTheme(theme);
  });

  // ---------------------------------------------------------------- start
  $('sel-color').value = S.colorPref;
  drawGrid();
  spawnWorker();
  newGame();
  window.__cf = { S, think };   // handy for debugging in the console
})();
