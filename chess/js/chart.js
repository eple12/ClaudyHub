// Eval history chart (White win %, like Claudy Live): area chart over positions, click/drag to jump.

const NS = "http://www.w3.org/2000/svg";

export function winPct(cp) {
  // lichess win-probability curve
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

// score object ({cp}|{mate}) from White's point of view -> 0..100
export function whiteWin(score) {
  if (!score) return 50;
  if (score.mate !== undefined) return score.mate > 0 ? 100 : score.mate < 0 ? 0 : 50;
  return winPct(score.cp);
}

export function fmtScore(score) {
  if (!score) return "–";
  if (score.mate !== undefined) return (score.mate > 0 ? "+M" : "-M") + Math.abs(score.mate);
  const v = score.cp / 100;
  return (v > 0 ? "+" : "") + v.toFixed(2);
}

export class EvalChart {
  constructor(svg, tip, onPick) {
    this.svg = svg;
    this.tip = tip;
    this.onPick = onPick;
    this.data = [];
    this.cursor = 0;
    this.n = 1;
    this.dragging = false;
    svg.addEventListener("pointerdown", (e) => { this.dragging = true; svg.setPointerCapture(e.pointerId); this._pick(e); });
    svg.addEventListener("pointermove", (e) => { this._hover(e); if (this.dragging) this._pick(e); });
    svg.addEventListener("pointerup", () => { this.dragging = false; });
    svg.addEventListener("pointerleave", () => { if (this.tip) this.tip.hidden = true; });
  }

  _idx(e) {
    const r = this.svg.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    return Math.max(0, Math.min(this.n - 1, Math.round(x * (this.n - 1))));
  }

  _pick(e) { this.onPick && this.onPick(this._idx(e)); }

  _hover(e) {
    if (!this.tip) return;
    const i = this._idx(e);
    const d = this.data[i];
    this.tip.hidden = false;
    this.tip.textContent = `ply ${i}  ${d ? fmtScore(d.score) : "–"}${d && d.depth ? "  d" + d.depth : ""}`;
    const r = this.svg.getBoundingClientRect();
    const x = (i / Math.max(1, this.n - 1)) * r.width;
    this.tip.style.left = Math.min(r.width - 110, Math.max(0, x - 40)) + "px";
  }

  // data[i] = {score:{cp|mate} (white POV), depth} | undefined ; length = positions
  render(data, cursor, marks) {
    this.data = data;
    this.cursor = cursor;
    const n = Math.max(2, data.length);
    this.n = n;
    const svg = this.svg;
    svg.innerHTML = "";
    const W = 1000, H = 200;
    const x = (i) => (i / (n - 1)) * W;
    const y = (i) => H - (data[i] ? whiteWin(data[i].score) : 50) * (H / 100);
    const el = (name, attrs) => {
      const e = document.createElementNS(NS, name);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      svg.appendChild(e);
      return e;
    };
    const dot = (cx, cy, w, color) => el("line", { x1: cx, y1: cy, x2: cx, y2: cy + 0.01, stroke: color, "stroke-width": w, "stroke-linecap": "round", "vector-effect": "non-scaling-stroke" });
    el("line", { x1: 0, y1: H / 2, x2: W, y2: H / 2, stroke: "#d85000", "stroke-opacity": ".6", "stroke-width": 1.5, "vector-effect": "non-scaling-stroke" });
    const pts = [];
    for (let i = 0; i < data.length; i++) if (data[i]) pts.push([x(i), y(i)]);
    if (pts.length) {
      let d = `M ${pts[0][0]} ${H} L ${pts[0][0]} ${pts[0][1]}`;
      for (let k = 1; k < pts.length; k++) d += ` L ${pts[k][0]} ${pts[k][1]}`;
      d += ` L ${pts[pts.length - 1][0]} ${H} Z`;
      el("path", { d, fill: "#f2f2f2", "fill-opacity": ".92" });
      let l = "M " + pts.map((p) => p.join(" ")).join(" L ");
      el("path", { d: l, fill: "none", stroke: "#bfbfbf", "stroke-width": 1.5, "vector-effect": "non-scaling-stroke" });
    }
    if (pts.length <= 40) for (const q of pts) {
      dot(q[0], q[1], 5, "#bfbfbf");
    }
    if (marks) for (const m of marks) {
      if (data[m.i]) dot(x(m.i), y(m.i), 9, m.color);
    }
    el("line", { x1: x(cursor), y1: 0, x2: x(cursor), y2: H, stroke: "#3692e7", "stroke-width": 2, "vector-effect": "non-scaling-stroke" });
  }
}
