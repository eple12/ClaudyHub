// Chess board widget: pieces (with move animation), drag & click input, highlights, arrows, promotion picker.
// The board knows nothing about the rules; the app supplies legal destinations through callbacks.

const FILES = "abcdefgh";
const sqName = (f, r) => FILES[f] + (r + 1);
const sqFile = (s) => s.charCodeAt(0) - 97;
const sqRank = (s) => s.charCodeAt(1) - 49;

export function parsePlacement(fen) {
  const out = new Map();
  const rows = fen.split(" ")[0].split("/");
  for (let i = 0; i < 8; i++) {
    let f = 0;
    for (const ch of rows[i]) {
      if (ch >= "1" && ch <= "8") f += +ch;
      else {
        const color = ch === ch.toUpperCase() ? "w" : "b";
        out.set(sqName(f, 7 - i), color + ch.toUpperCase());
        f++;
      }
    }
  }
  return out;
}

export class Board {
  // opts: { legalFrom(sq) -> [to...], movable(sq) -> bool, onMove(from, to) , onPromotionNeeded(from,to) -> Promise<piece|null> }
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    this.orientation = "w";
    this.pieces = new Map();          // square -> {el, code}
    this.last = null;
    this.checkSq = null;
    this.selected = null;
    this.targets = [];
    this.drag = null;
    this.arrows = [];
    this.locked = false;
    this.animate = true;
    this._build();
  }

  _build() {
    const r = this.root;
    r.classList.add("board");
    r.innerHTML = "";
    this.squaresEl = document.createElement("div");
    this.squaresEl.className = "squares";
    this.sqEls = {};
    for (let i = 0; i < 64; i++) {
      const el = document.createElement("div");
      el.className = "sq";
      this.squaresEl.appendChild(el);
    }
    r.appendChild(this.squaresEl);
    this.piecesEl = document.createElement("div");
    this.piecesEl.className = "pieces";
    r.appendChild(this.piecesEl);
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.setAttribute("class", "arrows");
    this.svg.setAttribute("viewBox", "0 0 8 8");
    r.appendChild(this.svg);
    this.promoEl = document.createElement("div");
    this.promoEl.className = "promo";
    this.promoEl.hidden = true;
    r.appendChild(this.promoEl);
    this.bannerEl = document.createElement("div");
    this.bannerEl.className = "banner";
    this.bannerEl.hidden = true;
    r.appendChild(this.bannerEl);
    this._layoutSquares();
    r.addEventListener("pointerdown", (e) => this._down(e));
    window.addEventListener("pointermove", (e) => this._move(e));
    window.addEventListener("pointerup", (e) => this._up(e));
    window.addEventListener("pointercancel", () => this._cancelDrag());
    r.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  // grid cell order depends on orientation
  _layoutSquares() {
    const cells = this.squaresEl.children;
    for (let i = 0; i < 64; i++) {
      const col = i % 8, row = (i / 8) | 0;
      const f = this.orientation === "w" ? col : 7 - col;
      const rk = this.orientation === "w" ? 7 - row : row;
      const name = sqName(f, rk);
      const el = cells[i];
      el.dataset.sq = name;
      el.className = "sq " + ((f + rk) % 2 === 0 ? "d" : "l");
      el.innerHTML = "";
      if (col === 0) {
        const c = document.createElement("span");
        c.className = "coord rank";
        c.textContent = rk + 1;
        el.appendChild(c);
      }
      if (row === 7) {
        const c = document.createElement("span");
        c.className = "coord file";
        c.textContent = FILES[f];
        el.appendChild(c);
      }
      this.sqEls[name] = el;
    }
    this._paintMarks();
  }

  _pos(sq) {
    let f = sqFile(sq), r = sqRank(sq);
    if (this.orientation === "b") { f = 7 - f; r = 7 - r; }
    return { x: f * 100, y: (7 - r) * 100 };
  }

  _place(el, sq) {
    const p = this._pos(sq);
    el.style.transform = `translate(${p.x}%, ${p.y}%)`;
  }

  setOrientation(o) {
    if (o === this.orientation) return;
    this.orientation = o;
    this._layoutSquares();
    for (const [sq, p] of this.pieces) {
      p.el.style.transition = "none";
      this._place(p.el, sq);
    }
    this._drawArrows();
    requestAnimationFrame(() => { for (const p of this.pieces.values()) p.el.style.transition = ""; });
  }

  flip() { this.setOrientation(this.orientation === "w" ? "b" : "w"); }

  // position: Map square -> "wP" ...
  setPosition(placement, { animate = true } = {}) {
    const next = placement;
    const old = this.pieces;
    const keep = new Map();
    const free = new Map();   // code -> [elements of vanished pieces]
    for (const [sq, p] of old) {
      if (next.get(sq) === p.code) keep.set(sq, p);
      else {
        if (!free.has(p.code)) free.set(p.code, []);
        free.get(p.code).push({ sq, p });
      }
    }
    const result = new Map(keep);
    for (const [sq, code] of next) {
      if (keep.has(sq)) continue;
      const list = free.get(code);
      let piece = null;
      if (list && list.length && animate && this.animate) {
        // reuse the closest vanished piece of the same kind (animates the move)
        let bi = 0, bd = 1e9;
        const t = this._pos(sq);
        list.forEach((c, i) => {
          const q = this._pos(c.sq);
          const d = Math.abs(q.x - t.x) + Math.abs(q.y - t.y);
          if (d < bd) { bd = d; bi = i; }
        });
        piece = list.splice(bi, 1)[0].p;
        piece.el.classList.add("moving");
        setTimeout(() => piece.el.classList.remove("moving"), 260);
      } else {
        const el = document.createElement("div");
        el.className = "piece";
        el.style.backgroundImage = `url(pieces/${code}.svg)`;
        this.piecesEl.appendChild(el);
        if (!animate || !this.animate) el.style.transition = "none";
        this._place(el, sq);
        if (!animate || !this.animate) requestAnimationFrame(() => { el.style.transition = ""; });
        piece = { el, code };
      }
      this._place(piece.el, sq);
      result.set(sq, piece);
    }
    for (const list of free.values()) for (const c of list) {
      c.p.el.classList.add("gone");
      const el = c.p.el;
      setTimeout(() => el.remove(), 230);
    }
    this.pieces = result;
    this.clearSelection();
  }

  setLast(from, to) { this.last = from ? [from, to] : null; this._paintMarks(); }
  setCheck(sq) { this.checkSq = sq || null; this._paintMarks(); }

  _paintMarks() {
    for (const el of Object.values(this.sqEls)) el.classList.remove("last", "check", "sel", "tgt", "cap");
    if (this.last) for (const s of this.last) this.sqEls[s]?.classList.add("last");
    if (this.checkSq) this.sqEls[this.checkSq]?.classList.add("check");
    if (this.selected) this.sqEls[this.selected]?.classList.add("sel");
    for (const t of this.targets) this.sqEls[t]?.classList.add("tgt", this.pieces.has(t) ? "cap" : "x");
  }

  clearSelection() { this.selected = null; this.targets = []; this._wasSelected = null; this._paintMarks(); }

  select(sq) {
    this.selected = sq;
    this.targets = this.opts.legalFrom(sq) || [];
    this._paintMarks();
  }

  setLocked(v) { this.locked = v; if (v) this.clearSelection(); }

  banner(text) {
    this.bannerEl.hidden = !text;
    this.bannerEl.textContent = text || "";
  }

  // ---- arrows --------------------------------------------------------------------------------
  setArrows(arrows) { this.arrows = arrows || []; this._drawArrows(); }

  _drawArrows() {
    const svg = this.svg;
    svg.innerHTML = "";
    const ns = "http://www.w3.org/2000/svg";
    const center = (sq) => {
      const p = this._pos(sq);
      return { x: p.x / 100 + 0.5, y: p.y / 100 + 0.5 };
    };
    const defs = document.createElementNS(ns, "defs");
    svg.appendChild(defs);
    this.arrows.forEach((a, idx) => {
      const id = "ah" + idx;
      const w = a.width || 0.17;
      const m = document.createElementNS(ns, "marker");
      m.setAttribute("id", id);
      m.setAttribute("orient", "auto");
      m.setAttribute("markerWidth", "4");
      m.setAttribute("markerHeight", "8");
      m.setAttribute("refX", "2.05");
      m.setAttribute("refY", "2.01");
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", "M0,0 V4 L3,2 Z");
      path.setAttribute("fill", a.color);
      m.appendChild(path);
      defs.appendChild(m);
      const s = center(a.from), t = center(a.to);
      const dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy) || 1;
      const head = w * 3.2;           // length of the arrow head
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", s.x);
      line.setAttribute("y1", s.y);
      line.setAttribute("x2", t.x - (dx / len) * head * 0.62);
      line.setAttribute("y2", t.y - (dy / len) * head * 0.62);
      line.setAttribute("stroke", a.color);
      line.setAttribute("stroke-width", w);
      line.setAttribute("stroke-linecap", "butt");
      line.setAttribute("marker-end", `url(#${id})`);
      line.setAttribute("opacity", a.opacity ?? 0.78);
      svg.appendChild(line);
    });
  }

  // ---- input ---------------------------------------------------------------------------------
  _sqAt(e) {
    const r = this.root.getBoundingClientRect();
    let f = Math.floor(((e.clientX - r.left) / r.width) * 8);
    let rk = 7 - Math.floor(((e.clientY - r.top) / r.height) * 8);
    if (f < 0 || f > 7 || rk < 0 || rk > 7) return null;
    if (this.orientation === "b") { f = 7 - f; rk = 7 - rk; }
    return sqName(f, rk);
  }

  _down(e) {
    if (e.button !== 0 || this.locked || !this.promoEl.hidden) return;
    const sq = this._sqAt(e);
    if (!sq) return;
    if (this.selected && this.targets.includes(sq)) {
      this._commit(this.selected, sq);
      return;
    }
    const piece = this.pieces.get(sq);
    if (piece && this.opts.movable(sq)) {
      this.select(sq);
      this.drag = { from: sq, piece, startX: e.clientX, startY: e.clientY, moved: false, id: e.pointerId };
      e.preventDefault();
    } else {
      this.clearSelection();
    }
  }

  _move(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
    if (!d.moved) {
      d.moved = true;
      d.piece.el.classList.add("drag");
      d.piece.el.style.transition = "none";
    }
    const r = this.root.getBoundingClientRect();
    const size = r.width / 8;
    const x = e.clientX - r.left - size / 2, y = e.clientY - r.top - size / 2;
    d.piece.el.style.transform = `translate(${(x / size) * 100}%, ${(y / size) * 100}%)`;
  }

  _up(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const el = d.piece.el;
    el.classList.remove("drag");
    el.style.transition = "";
    if (!d.moved) { // plain click: keep selection (toggle off if clicked again while selected earlier)
      if (this._wasSelected === d.from) { this.clearSelection(); this._wasSelected = null; }
      else this._wasSelected = d.from;
      return;
    }
    const to = this._sqAt(e);
    this._place(el, d.from);
    if (to && to !== d.from && this.targets.includes(to)) this._commit(d.from, to);
  }

  _cancelDrag() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.piece.el.classList.remove("drag");
    d.piece.el.style.transition = "";
    this._place(d.piece.el, d.from);
  }

  async _commit(from, to) {
    this._wasSelected = null;
    const promo = await this.opts.onPromotionNeeded(from, to);
    if (promo === null) { this.clearSelection(); return; }
    this.clearSelection();
    this.opts.onMove(from, to, promo || undefined);
  }

  // Shows the promotion picker on the destination file; resolves with "q" | "r" | "b" | "n" or null (cancelled)
  askPromotion(to, color) {
    return new Promise((resolve) => {
      const el = this.promoEl;
      el.innerHTML = "";
      const pos = this._pos(to);
      const down = pos.y > 300;                      // destination on the lower half: stack upwards
      const order = ["q", "n", "r", "b"];
      el.style.left = pos.x + "%";
      el.style.top = (down ? pos.y - 300 : pos.y) + "%";
      const close = (v) => { el.hidden = true; el.onclick = null; resolve(v); };
      const list = down ? order.slice().reverse() : order;
      for (const p of list) {
        const b = document.createElement("button");
        b.className = "pp";
        b.style.backgroundImage = `url(pieces/${color}${p.toUpperCase()}.svg)`;
        b.onclick = (ev) => { ev.stopPropagation(); close(p); };
        el.appendChild(b);
      }
      const cancel = document.createElement("div");
      cancel.className = "pcancel";
      cancel.onclick = () => close(null);
      this.root.appendChild(cancel);
      el.hidden = false;
      const old = close;
      const wrapped = (v) => { cancel.remove(); old(v); };
      el.querySelectorAll(".pp").forEach((b, i) => { b.onclick = (ev) => { ev.stopPropagation(); wrapped(list[i]); }; });
      cancel.onclick = () => wrapped(null);
    });
  }
}
