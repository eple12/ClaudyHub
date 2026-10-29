// UCI engine running in a Web Worker (Claudy WebAssembly or stockfish.js).
// All operations are serialised: begin() stops the running search, applies options, then starts the new one,
// so a setoption can never arrive in the middle of a search.

export function parseInfo(line) {
  const t = line.split(" ");
  const o = { multipv: 1 };
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case "depth": case "seldepth": case "multipv": case "nodes": case "nps":
      case "hashfull": case "time": case "tbhits":
        o[t[i]] = parseInt(t[++i], 10);
        break;
      case "score": {
        const kind = t[++i];
        o[kind] = parseInt(t[++i], 10);
        if (t[i + 1] === "lowerbound" || t[i + 1] === "upperbound") o.bound = t[++i];
        break;
      }
      case "pv":
        o.pv = t.slice(i + 1);
        i = t.length;
        break;
      case "string":
        return null;
      default:
        break;
    }
  }
  return o.depth !== undefined && (o.cp !== undefined || o.mate !== undefined) ? o : null;
}

export class UciEngine {
  constructor(def) {
    this.def = def;                 // {id, name, script, ...}
    this.worker = null;
    this.options = new Map();       // name -> {type, default, min, max}
    this.title = def.name;
    this.job = null;
    this.waiters = [];              // [{test(line)->bool, resolve, reject}]
    this.applied = new Map();       // option name -> last value sent
    this.q = Promise.resolve();     // operation queue
    this.dead = false;
    this.log = [];                  // last raw lines (debug)
  }

  start() {
    if (this._starting) return this._starting;
    this._starting = new Promise((resolve, reject) => {
      let w;
      try { w = this.def.create ? this.def.create() : new Worker(this.def.script); } catch (e) { reject(e); return; }
      this.worker = w;
      w.onmessage = (e) => this._line(typeof e.data === "string" ? e.data : String(e.data));
      w.onerror = (e) => {
        this.dead = true;
        const err = new Error(e.message || "engine worker failed");
        reject(err);
        this._fail(err);
      };
      this._expect((l) => l === "uciok").then(() => resolve(this), reject);
      this.send("uci");
    });
    return this._starting;
  }

  _line(l) {
    l = l.trim();
    if (!l) return;
    this.log.push(l);
    if (this.log.length > 200) this.log.shift();
    if (l.startsWith("id name ")) this.title = l.slice(8);
    else if (l.startsWith("option name ")) this._option(l);
    for (let i = 0; i < this.waiters.length; i++) {
      if (this.waiters[i].test(l)) {
        const w = this.waiters.splice(i, 1)[0];
        w.resolve(l);
        break;
      }
    }
    const job = this.job;
    if (!job) return;
    if (l.startsWith("info ")) {
      const info = parseInfo(l);
      if (info && job.onInfo) job.onInfo(info);
    } else if (l.startsWith("bestmove")) {
      const t = l.split(" ");
      this.job = null;
      job.resolve({ best: t[1] === "(none)" || t[1] === "0000" ? null : t[1], ponder: t[3] || null });
    }
  }

  _option(l) {
    const m = l.match(/^option name (.+?) type (\w+)(.*)$/);
    if (!m) return;
    const o = { name: m[1], type: m[2] };
    const d = m[3].match(/default (\S*)/), mn = m[3].match(/min (-?\d+)/), mx = m[3].match(/max (-?\d+)/);
    if (d) o.default = d[1];
    if (mn) o.min = +mn[1];
    if (mx) o.max = +mx[1];
    this.options.set(o.name, o);
  }

  _fail(err) {
    for (const w of this.waiters.splice(0)) w.reject(err);
    if (this.job) {
      const j = this.job;
      this.job = null;
      j.reject(err);
    }
  }

  send(cmd) { if (this.worker) this.worker.postMessage(cmd); }

  _expect(test) {
    return new Promise((resolve, reject) => this.waiters.push({ test, resolve, reject }));
  }

  async _ready() {
    const p = this._expect((l) => l === "readyok");
    this.send("isready");
    await p;
  }

  async _halt() {
    if (!this.job) return;
    const p = this.job.promise.catch(() => {});
    this.send("stop");
    await p;
  }

  _setOption(name, value) {
    const o = this.options.get(name);
    if (!o) return;
    let v = String(value);
    if (o.type === "spin") {
      let n = Math.round(Number(value));
      if (o.min !== undefined) n = Math.max(o.min, n);
      if (o.max !== undefined) n = Math.min(o.max, n);
      v = String(n);
    }
    if (this.applied.get(name) === v) return;
    this.applied.set(name, v);
    this.send(`setoption name ${name} value ${v}`);
  }

  _chain(fn) {
    const r = this.q.then(fn);
    this.q = r.then(() => {}, () => {});
    return r;
  }

  // Stops the running search (if any) and resolves when it has finished.
  halt() { return this._chain(() => this._halt()); }

  newGame() {
    return this._chain(async () => {
      await this._halt();
      this.send("ucinewgame");
      await this._ready();
    });
  }

  // spec: {options:{name:value}, pos, go, onInfo, cancelled()}
  // Resolves with {best, ponder} when the search finishes (bestmove), or null if it was cancelled before starting.
  async begin(spec) {
    let jobPromise = null;
    await this._chain(async () => {
      await this._halt();
      if (spec.cancelled && spec.cancelled()) return;
      for (const [k, v] of Object.entries(spec.options || {})) this._setOption(k, v);
      await this._ready();
      if (spec.cancelled && spec.cancelled()) return;
      let resolve, reject;
      const promise = new Promise((a, b) => { resolve = a; reject = b; });
      this.job = { onInfo: spec.onInfo, resolve, reject, promise };
      jobPromise = promise;
      this.send(spec.pos);
      this.send(spec.go);
    });
    return jobPromise ? jobPromise : null;
  }

  get searching() { return !!this.job; }

  terminate() {
    this.dead = true;
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this._fail(new Error("terminated"));
  }
}

// Claudy runs on the page's main thread (its search threads are Web Workers spawned by the module, driven
// through a dedicated UCI thread inside the module). This adapter looks like a Worker to UciEngine.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("cannot load " + src));
    document.head.appendChild(s);
  });
}

export function claudyHost(src) {
  const host = { onmessage: null, onerror: null, mod: null, queue: [] };
  host.postMessage = (cmd) => {
    if (host.mod) host.mod.ccall("claudy_cmd", null, ["string"], [cmd]);
    else host.queue.push(cmd);
  };
  host.terminate = () => { host.mod = null; host.queue = []; };
  loadScript(src)
    .then(() => window.createClaudy({
      print: (t) => host.onmessage && host.onmessage({ data: t }),
      printErr: () => {},
    }))
    .then((m) => {
      host.mod = m;
      m.ccall("claudy_init", null, [], []);
      for (const c of host.queue.splice(0)) m.ccall("claudy_cmd", null, ["string"], [c]);
    })
    .catch((e) => host.onerror && host.onerror({ message: e && e.message ? e.message : String(e) }));
  return host;
}

export function engineDefs() {
  return {
    claudy: {
      id: "claudy", name: "Claudy 5.0", short: "Claudy", create: () => claudyHost("engine/claudy.js"),
      eloMin: 100, eloMax: 3400, color: "#4fb3bf",
    },
    stockfish: {
      id: "stockfish", name: "Stockfish 19", short: "Stockfish", script: "stockfish/stockfish-19.js",
      eloMin: 1320, eloMax: 3190, color: "#d59120",
    },
  };
}
