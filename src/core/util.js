// ─────────────────────────────────────────────────────────────────────────────
//  util.js — matemática, azar determinista y ayudantes varios
// ─────────────────────────────────────────────────────────────────────────────

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const smootherstep = (t) => { t = clamp01(t); return t * t * t * (t * (t * 6 - 15) + 10); };
export const sign = Math.sign;

/** Interpolación independiente del framerate. `l` = fracción restante por segundo. */
export const damp = (a, b, l, dt) => lerp(a, b, 1 - Math.pow(l, dt));

/** Diferencia angular más corta, en (-PI, PI]. */
export function angDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
export const angLerp = (a, b, t) => a + angDelta(a, b) * t;

// ── PRNG determinista ────────────────────────────────────────────────────────
/** mulberry32: rápido, buena distribución, sembrable. */
export function makeRng(seed = 0x9e3779b9) {
  let s = seed >>> 0;
  const r = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (a, b) => a + r() * (b - a);
  r.int = (a, b) => Math.floor(a + r() * (b - a + 1));
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.sign = () => (r() < 0.5 ? -1 : 1);
  r.chance = (p) => r() < p;
  /** Gaussiana aproximada (suma de 3 uniformes), media 0, sigma ~1. */
  r.gauss = () => (r() + r() + r() - 1.5) * 1.1547;
  return r;
}

/** Azar global no determinista, para efectos cosméticos. */
export const rnd = makeRng((Math.random() * 0xffffffff) >>> 0);

// ── Ruido de valor 1D/2D, barato, para brillos y viento ──────────────────────
function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1;
}

// ── Ayudantes vectoriales sobre escalares sueltos (sin alocar) ───────────────
export function len3(x, y, z) { return Math.sqrt(x * x + y * y + z * z); }
export function dist3(ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Reserva creciente de objetos reutilizables. */
export class Pool {
  constructor(factory, reset) { this.factory = factory; this.reset = reset; this.free = []; this.live = []; }
  get() {
    const o = this.free.length ? this.free.pop() : this.factory();
    this.live.push(o);
    return o;
  }
  release(o) {
    const i = this.live.indexOf(o);
    if (i >= 0) this.live.splice(i, 1);
    if (this.reset) this.reset(o);
    this.free.push(o);
  }
  releaseAt(i) {
    const o = this.live[i];
    this.live[i] = this.live[this.live.length - 1];
    this.live.pop();
    if (this.reset) this.reset(o);
    this.free.push(o);
    return o;
  }
}

/** Media móvil simple para métricas de rendimiento. */
export class Rolling {
  constructor(n = 60) { this.buf = new Float32Array(n); this.i = 0; this.n = 0; this.sum = 0; }
  push(v) {
    if (this.n === this.buf.length) this.sum -= this.buf[this.i];
    else this.n++;
    this.buf[this.i] = v; this.sum += v;
    this.i = (this.i + 1) % this.buf.length;
  }
  get avg() { return this.n ? this.sum / this.n : 0; }
}
