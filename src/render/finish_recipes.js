// ─────────────────────────────────────────────────────────────────────────────
//  finish_recipes.js — Las recetas de los acabados de las armas: texturas
//  procedurales calculadas en JS puro. Sin Three ni DOM: corre igual en el
//  hilo principal, en el Worker que las hornea en segundo plano
//  (finish_worker.js) y en Node (las pruebas).
//
//  Nada de canvas: cada textura es una función pura de (receta, colores,
//  semilla, tamaño) que escribe bytes en un Uint8Array y da SIEMPRE los
//  mismos bytes (las pruebas lo verifican con un hash). Todo el ruido vive en
//  retículas PERIÓDICAS cuyo período entero divide al mosaico: la textura
//  repite sin costura por construcción.
//
//  Una receta devuelve, por píxel: color (sRGB), y si la receta lo pide,
//  altura (de ahí sale el mapa de normales por diferencias centrales),
//  rugosidad y máscara emisiva. Costo: O(S²·octavas) por textura más O(S²)
//  para las normales; S = 128 o 256.
//
//  Los UV de las armas vienen en METROS (ver gunsmith.js): una receta dice
//  cuántos metros cubre su mosaico (`tile`) y el material ajusta el repeat.
// ─────────────────────────────────────────────────────────────────────────────

import { makeRng, TAU } from '../core/util.js';

// ═════════════════════════════════════════════════════════════════════════════
//  Ruido periódico
// ═════════════════════════════════════════════════════════════════════════════

const LATTICES = new Map();

/**
 * Retícula de valores al azar de Pu×Pv, sembrada; memoizada (se comparte
 * entre texturas). La clave es NUMÉRICA: armar un string por muestra costaba
 * más que el ruido mismo (el camuflaje pasó de 274 ms a una fracción).
 */
function lattice(Pu, Pv, seed) {
  const key = (Pu * 2048 + Pv) * 1048576 + (seed & 0xfffff);    // Pu, Pv < 2048 → entra en 2^53
  let L = LATTICES.get(key);
  if (!L) {
    L = new Float32Array(Pu * Pv);
    const r = makeRng((Math.imul(seed | 0, 0x9E3779B1) ^ Math.imul(Pu, 0x85EBCA77) ^ Math.imul(Pv, 0xC2B2AE3D)) >>> 0);
    for (let i = 0; i < L.length; i++) L[i] = r();
    LATTICES.set(key, L);
  }
  return L;
}

// quíntica de Perlin: derivada continua, así el mapa de normales no muestra la retícula
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const wrap = (i, P) => ((i % P) + P) % P;

/** Ruido de valor sobre una retícula YA resuelta: período Pu en x, Pv en y. O(1), sin búsquedas. */
function vn(L, x, y, Pu, Pv) {
  const xf = Math.floor(x), yf = Math.floor(y);
  const u = fade(x - xf), v = fade(y - yf);
  const x0 = wrap(xf, Pu), y0 = wrap(yf, Pv);
  const x1 = x0 + 1 === Pu ? 0 : x0 + 1, y1 = y0 + 1 === Pv ? 0 : y0 + 1;
  const a = L[y0 * Pu + x0], b = L[y0 * Pu + x1], c = L[y1 * Pu + x0], d = L[y1 * Pu + x1];
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

//  Fábricas de ruido: resuelven las retículas UNA vez (en `make`, fuera del
//  bucle por píxel) y devuelven una función pura de (u, v). Así el bucle
//  caliente no toca ningún Map.

/** Ruido de valor con período (Pu, Pv); se llama con coordenadas de retícula. */
function noiseFn(Pu, Pv, seed) {
  const L = lattice(Pu, Pv, seed);
  return (x, y) => vn(L, x, y, Pu, Pv);
}

/**
 * fBm sobre el mosaico: (u, v) ∈ ℝ² con período 1. Octavas de período
 * P·2^o, todas enteras: la suma repite igual. O(octavas) por muestra.
 */
function fbmFn(P, oct, seed, gain = 0.5) {
  const Ls = new Array(oct), Ps = new Float64Array(oct), A = new Float64Array(oct);
  let amp = 1, norm = 0, p = P;
  for (let o = 0; o < oct; o++) { Ls[o] = lattice(p, p, seed + o * 101); Ps[o] = p; A[o] = amp; norm += amp; amp *= gain; p *= 2; }
  for (let o = 0; o < oct; o++) A[o] /= norm;
  return (u, v) => {
    let s = 0;
    for (let o = 0; o < oct; o++) { const q = Ps[o]; s += A[o] * vn(Ls[o], u * q, v * q, q, q); }
    return s;
  };
}

/** Hash entero → [0,1). */
function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Voronoi periódico de P×P celdas con un punto por celda. Deja en `out` la
 * distancia al más cercano (f1), al segundo (f2), el vector al más cercano
 * (dx, dy) y un id estable de la celda. Revisa las 9 vecinas: O(9).
 */
function voronoi(u, v, P, seed, out, jitter = 0.85) {
  const x = u * P, y = v * P;
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 9, f2 = 9, bx = 0, by = 0, id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const wx = wrap(cx, P), wy = wrap(cy, P);
      const px = cx + 0.5 + (hash2(wx, wy, seed) - 0.5) * jitter;
      const py = cy + 0.5 + (hash2(wx, wy, seed + 17) - 0.5) * jitter;
      const dx = px - x, dy = py - y, d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) { f2 = f1; f1 = d; bx = dx; by = dy; id = wy * P + wx; }
      else if (d < f2) f2 = d;
    }
  }
  out.f1 = f1; out.f2 = f2; out.dx = bx; out.dy = by; out.id = id;
  return out;
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const fract = (x) => x - Math.floor(x);
const tri = (x) => 1 - 2 * Math.abs(fract(x) - 0.5);        // onda triangular 0..1

// ═════════════════════════════════════════════════════════════════════════════
//  Color
// ═════════════════════════════════════════════════════════════════════════════

/** '#rrggbb' o número → [r, g, b] en bytes sRGB. */
export function rgb(c) {
  if (Array.isArray(c)) return c;
  const n = typeof c === 'number' ? c : parseInt(String(c).replace('#', ''), 16);
  if (!Number.isFinite(n)) throw new Error(`color inválido: ${c}`);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mixInto(o, a, b, t) {
  o.r = a[0] + (b[0] - a[0]) * t; o.g = a[1] + (b[1] - a[1]) * t; o.b = a[2] + (b[2] - a[2]) * t;
}
function mulInto(o, k) { o.r *= k; o.g *= k; o.b *= k; }
function setInto(o, c, k = 1) { o.r = c[0] * k; o.g = c[1] * k; o.b = c[2] * k; }

// ═════════════════════════════════════════════════════════════════════════════
//  Recetas
//
//  Cada receta: { size, tile (metros por mosaico), rough, metal (del
//  material), normal (fuerza del relieve; 0 = sin mapa de normales),
//  roughMap (true si escribe `ro`), emissive (true si escribe `e`),
//  make(params) → función de píxel (u, v, o) }. `o` trae r g b (0..255),
//  h (altura 0..1), ro (rugosidad 0..1), e (emisión 0..1).
// ═════════════════════════════════════════════════════════════════════════════

export const RECIPES = {
  // plástico inyectado: ondulación leve y grano fino
  polymer: { size: 128, tint: true, tile: 0.22, rough: 0.72, metal: 0.04, normal: 0.35, make: (p) => {
    const c = rgb(p.c), amp = p.amp ?? 0.07, N = fbmFn(4, 4, p.seed), G = noiseFn(64, 64, p.seed + 7);
    return (u, v, o) => {
      const n = N(u, v), g = G(u * 64, v * 64);
      setInto(o, c, 1 + (n - 0.5) * amp + (g - 0.5) * amp * 0.5);
      o.h = n * 0.3 + g * 0.7;
    };
  } },

  // pintura cerámica satinada (Cerakote): casi lisa, apenas moteada
  cerakote: { size: 128, tint: true, tile: 0.3, rough: 0.5, metal: 0.12, normal: 0.12, make: (p) => {
    const c = rgb(p.c), N = fbmFn(3, 4, p.seed), G = noiseFn(96, 96, p.seed + 3);
    return (u, v, o) => {
      const g = G(u * 96, v * 96);
      setInto(o, c, 1 + (N(u, v) - 0.5) * 0.045 + (g - 0.5) * 0.02);
      o.h = g;
    };
  } },

  // empuñadura punteada: puntos en relieve en tresbolillo
  stipple: { size: 128, tint: true, tile: 0.06, rough: 0.86, metal: 0.02, normal: 1.3, make: (p) => {
    const c = rgb(p.c), N = 16, G = noiseFn(96, 96, p.seed);          // N par: las filas impares también repiten
    return (u, v, o) => {
      const fy = fract(v) * N, row = Math.floor(fy);
      let best = 9;
      for (let dr = -1; dr <= 1; dr++) {
        const r = row + dr, off = (wrap(r, N) & 1) ? 0.5 : 0;
        const fx = fract(u) * N - off, col = Math.floor(fx);
        for (let dc = -1; dc <= 1; dc++) {
          const dx = fx - (col + dc + 0.5), dy = fy - (r + 0.5);
          const d = dx * dx + dy * dy;
          if (d < best) best = d;
        }
      }
      const bump = 1 - smooth(0.24, 0.40, Math.sqrt(best));
      const g = G(u * 96, v * 96);
      setInto(o, c, 0.9 + bump * 0.16 + (g - 0.5) * 0.05);
      o.h = bump * 0.85 + g * 0.15;
    };
  } },

  // acero cepillado: vetas largas a lo largo del arma y rugosidad que las sigue
  brushed: { size: 128, tint: true, tile: 0.25, rough: 1, metal: 0.86, normal: 0.25, roughMap: true, make: (p) => {
    const c = rgb(p.c), r0 = p.r0 ?? 0.2, A = noiseFn(2, 128, p.seed), B = noiseFn(4, 64, p.seed + 3);
    return (u, v, o) => {
      const s = A(u * 2, v * 128) * 0.6 + B(u * 4, v * 64) * 0.4;
      setInto(o, c, 0.9 + s * 0.18);
      o.ro = r0 + s * 0.2;
      o.h = s;
    };
  } },

  // fosfatado mate (parkerizado): moteado gris y grano
  parkerized: { size: 128, tint: true, tile: 0.2, rough: 0.62, metal: 0.45, normal: 0.3, make: (p) => {
    const c = rgb(p.c), N = fbmFn(6, 4, p.seed), G = noiseFn(64, 64, p.seed + 5);
    return (u, v, o) => {
      const g = G(u * 64, v * 64);
      setInto(o, c, 0.93 + N(u, v) * 0.12 + (g - 0.5) * 0.06);
      o.h = g;
    };
  } },

  // pavonado: negro azulado con un brillo que se corre
  blued: { size: 128, tile: 0.3, rough: 0.3, metal: 0.72, normal: 0, make: (p) => {
    const a = rgb(p.c ?? '#1d2230'), b = rgb(p.c2 ?? '#3a4662'), N = fbmFn(2, 4, p.seed);
    return (u, v, o) => mixInto(o, a, b, smooth(0.3, 0.85, N(u, v)) * 0.3);
  } },

  // cromo: espejo con vetas apenas visibles
  chrome: { size: 128, tint: true, tile: 0.3, rough: 1, metal: 1.0, normal: 0, roughMap: true, make: (p) => {
    const c = rgb(p.c ?? '#d9dde2'), A = noiseFn(2, 96, p.seed);
    return (u, v, o) => {
      const s = A(u * 2, v * 96);
      setInto(o, c, 0.96 + s * 0.06);
      o.ro = 0.1 + s * 0.08;
    };
  } },

  // oro grabado: un rulo (espiral logarítmica) por celda de voronoi, pátina encima
  gold: { size: 256, tile: 0.085, rough: 0.26, metal: 1.0, normal: 1.4, make: (p) => {
    const c = rgb(p.c ?? '#caa24e'), d = rgb(p.c2 ?? '#6a4f1f'), N = fbmFn(4, 3, p.seed + 9), W = {};
    return (u, v, o) => {
      voronoi(u, v, 5, p.seed, W, 0.6);
      const r = Math.hypot(W.dx, W.dy) + 1e-4, a = Math.atan2(W.dy, W.dx);
      const sp = fract(a / TAU + Math.log(r) * 1.7 + W.id * 0.37);
      const line = 1 - smooth(0.03, 0.075, Math.abs(sp - 0.5));
      const groove = line * smooth(0.62, 0.42, r) * smooth(0.02, 0.07, r);
      mixInto(o, c, d, groove * 0.8 + (N(u, v) - 0.5) * 0.18);
      o.h = 1 - groove;
    };
  } },

  // madera: anillos que ondulan, poros alargados a lo largo del arma
  wood: { size: 256, tile: 0.3, rough: 0.6, metal: 0.0, normal: 0.3, make: (p) => {
    const a = rgb(p.c), b = rgb(p.c2 ?? '#2e1a0e'), WARP = fbmFn(3, 4, p.seed), R = noiseFn(2, 7, p.seed + 5), PO = noiseFn(3, 90, p.seed + 11);
    return (u, v, o) => {
      const w = v * 7 + (WARP(u, v) - 0.5) * 1.6 + R(u * 2, v * 7) * 0.35;
      const band = Math.pow(Math.sin(fract(w) * Math.PI), 3);
      const pore = PO(u * 3, v * 90);
      const pp = pore > 0.76 ? (pore - 0.76) * 2.4 : 0;
      mixInto(o, a, b, Math.min(1, 0.18 + band * 0.58 + pp));
      o.h = 1 - pp * 1.6 - band * 0.15;
    };
  } },

  // fibra de carbono: sarga 2/2, cada haz un cilindro con brillo
  carbon: { size: 256, tile: 0.08, rough: 0.34, metal: 0.12, normal: 0.9, make: (p) => {
    const c = rgb(p.c ?? '#16171a'), s = rgb(p.c2 ?? '#41454e'), N = 24;
    return (u, v, o) => {
      const x = fract(u) * N, y = fract(v) * N, i = Math.floor(x), j = Math.floor(y);
      const horiz = (((i + j) >> 1) & 1) === 0;
      const fx = x - i, fy = y - j;
      const across = horiz ? fy : fx, along = horiz ? fx : fy;
      const tow = Math.sin(across * Math.PI);
      const sheen = Math.pow(tow, 2.2) * (0.72 + 0.28 * Math.sin(along * Math.PI));
      mixInto(o, c, s, sheen * 0.85);
      o.h = tow * 0.75 + sheen * 0.25;
    };
  } },

  // camuflaje boscoso: manchas orgánicas en capas (cuatro colores)
  camo: { size: 256, tile: 0.5, rough: 0.78, metal: 0.03, normal: 0.2, make: (p) => {
    const field = camoField(p);
    return (u, v, o) => field(u, v, o, 0.012);
  } },

  // camuflaje digital: el mismo campo muestreado en bloques de Q×Q, memoizado por bloque
  //  (el campo es constante dentro de un bloque: 48² evaluaciones en vez de 256²)
  digicamo: { size: 256, tile: 0.4, rough: 0.78, metal: 0.03, normal: 0.15, make: (p) => {
    const field = camoField(p), Q = 48, memo = new Array(Q * Q);
    return (u, v, o) => {
      const bx = Math.floor(fract(u) * Q), by = Math.floor(fract(v) * Q), k = by * Q + bx;
      let m = memo[k];
      if (!m) { const t = { r: 0, g: 0, b: 0, h: 0 }; field((bx + 0.5) / Q, (by + 0.5) / Q, t, 0.0005); m = memo[k] = t; }
      o.r = m.r; o.g = m.g; o.b = m.b; o.h = m.h;
    };
  } },

  // rayas de tigre: bandas onduladas a lo largo del arma
  tiger: { size: 256, tile: 0.45, rough: 0.78, metal: 0.03, normal: 0.15, make: (p) => {
    const [c1, c2, c3] = p.cols.map(rgb), W1 = fbmFn(3, 4, p.seed), W2 = fbmFn(6, 2, p.seed + 3), M = fbmFn(4, 3, p.seed + 5);
    return (u, v, o) => {
      const s = v * 5 + (W1(u, v) - 0.5) * 1.5 + Math.sin(u * TAU * 2) * 0.15;
      const f = fract(s), w = 0.18 + W2(u, v) * 0.2;         // ancho de la raya: varía a lo largo
      const stripe = 1 - smooth(w - 0.025, w + 0.025, f);
      mixInto(o, c1, c3, smooth(0.3, 0.7, M(u, v)) * 0.55);
      if (stripe > 0) { o.r += (c2[0] - o.r) * stripe; o.g += (c2[1] - o.g) * stripe; o.b += (c2[2] - o.b) * stripe; }
      o.h = 1 - stripe * 0.3;
    };
  } },

  // acero damasco: capas plegadas que fluyen
  damascus: { size: 256, tile: 0.22, rough: 0.3, metal: 0.9, normal: 0.5, make: (p) => {
    const a = rgb(p.c ?? '#2b2f36'), b = rgb(p.c2 ?? '#aab1bb'), W1 = fbmFn(3, 5, p.seed), W2 = fbmFn(2, 3, p.seed + 1);
    return (u, v, o) => {
      const w = v * 9 + (W1(u, v) - 0.5) * 3.2 + Math.sin(u * TAU * 3 + W2(u, v) * 4) * 0.35;
      const t = smooth(0.25, 0.75, 0.5 + 0.5 * Math.sin(w * TAU));
      mixInto(o, a, b, t);
      o.h = t * 0.6;
    };
  } },

  // paneles hexagonales (ciencia ficción): celdas de un tresbolillo, surcos en los bordes
  hex: { size: 256, tint: true, tile: 0.14, rough: 0.42, metal: 0.25, normal: 1.1, make: (p) => {
    const c = rgb(p.c), N = 8;
    return (u, v, o) => {
      const fy = fract(v) * N, row = Math.floor(fy);
      let f1 = 9, f2 = 9, id = 0;
      for (let dr = -1; dr <= 1; dr++) {
        const r = row + dr, wr = wrap(r, N), off = (wr & 1) ? 0.5 : 0;
        const fx = fract(u) * N - off, col = Math.floor(fx);
        for (let dc = -1; dc <= 1; dc++) {
          const dx = fx - (col + dc + 0.5), dy = fy - (r + 0.5);
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < f1) { f2 = f1; f1 = d; id = wr * N + wrap(col + dc, N); } else if (d < f2) f2 = d;
        }
      }
      const edge = smooth(0.0, 0.09, f2 - f1);
      setInto(o, c, (0.8 + edge * 0.2) * (0.95 + hash2(id, 3, p.seed) * 0.1));
      o.h = edge;
    };
  } },

  // paneles rectangulares con remaches: partición binaria determinista por píxel, O(profundidad)
  panel: { size: 256, tint: true, tile: 0.3, rough: 0.4, metal: 0.2, normal: 1.0, make: (p) => {
    const c = rgb(p.c), DEPTH = 4;
    return (u, v, o) => {
      let x0 = 0, y0 = 0, x1 = 1, y1 = 1, id = 1;
      const x = fract(u), y = fract(v);
      for (let d = 0; d < DEPTH; d++) {
        const cut = 0.3 + hash2(id, d, p.seed) * 0.4;
        if ((d + (id & 1)) & 1) { const m = x0 + (x1 - x0) * cut; if (x < m) { x1 = m; id = id * 2; } else { x0 = m; id = id * 2 + 1; } }
        else { const m = y0 + (y1 - y0) * cut; if (y < m) { y1 = m; id = id * 2; } else { y0 = m; id = id * 2 + 1; } }
      }
      const e = Math.min(x - x0, x1 - x, y - y0, y1 - y);
      const groove = smooth(0.012, 0.0, e);
      const rx = Math.min(x - x0, x1 - x), ry = Math.min(y - y0, y1 - y);
      const rivet = 1 - smooth(0.006, 0.011, Math.hypot(rx - 0.03, ry - 0.03));
      setInto(o, c, (0.94 + hash2(id, 9, p.seed) * 0.1) * (1 - groove * 0.35) * (1 + rivet * 0.12));
      o.h = 0.6 - groove * 0.6 + rivet * 0.4;
    };
  } },

  // franjas de peligro con desgaste que deja ver el metal
  hazard: { size: 128, tile: 0.2, rough: 1, metal: 0.3, normal: 0.2, roughMap: true, make: (p) => {
    const a = rgb(p.c ?? '#e3b341'), b = rgb(p.c2 ?? '#1b1c1f'), m = rgb(p.c3 ?? '#8a8f97'), N = fbmFn(6, 4, p.seed);
    return (u, v, o) => {
      const s = fract((u + v) * 4);
      const stripe = smooth(0.49, 0.51, s) - smooth(0.99, 1.0, s);
      mixInto(o, a, b, stripe);
      const edge = Math.min(Math.abs(s - 0.5), s, 1 - s) * 2;
      const wear = smooth(0.68, 0.76, N(u, v) + (0.5 - edge) * 0.22);
      if (wear > 0) { o.r += (m[0] - o.r) * wear; o.g += (m[1] - o.g) * wear; o.b += (m[2] - o.b) * wear; }
      o.ro = 0.62 - wear * 0.3;
      o.h = 1 - wear * 0.4;
    };
  } },

  // metal oxidado: parches de óxido en dos tonos y picaduras
  rust: { size: 256, tile: 0.35, rough: 1, metal: 1, normal: 0.6, roughMap: true, make: (p) => {
    const m = rgb(p.c ?? '#5b5f66'), r1 = rgb(p.c2 ?? '#7a3d1c'), r2 = rgb(p.c3 ?? '#a8622e');
    const N = fbmFn(5, 5, p.seed), N2 = fbmFn(10, 3, p.seed + 3), PIT = noiseFn(128, 128, p.seed + 7);
    return (u, v, o) => {
      const t = smooth(0.44, 0.62, N(u, v)), n2 = N2(u, v);
      const rc0 = r1[0] + (r2[0] - r1[0]) * n2, rc1 = r1[1] + (r2[1] - r1[1]) * n2, rc2 = r1[2] + (r2[2] - r1[2]) * n2;
      o.r = m[0] + (rc0 - m[0]) * t; o.g = m[1] + (rc1 - m[1]) * t; o.b = m[2] + (rc2 - m[2]) * t;
      const pit = PIT(u * 128, v * 128) > 0.83 ? 1 : 0;
      if (pit) mulInto(o, 0.7);
      o.ro = 0.42 + t * 0.5;
      o.h = t * 0.4 + 0.5 - pit * 0.5;
    };
  } },

  // cinta de tela enrollada en diagonal (empuñaduras de chatarra)
  tape: { size: 128, tint: true, tile: 0.12, rough: 0.9, metal: 0.0, normal: 0.8, make: (p) => {
    const c = rgb(p.c), G = noiseFn(64, 64, p.seed);
    return (u, v, o) => {
      const f = fract(u * 6 + v * 2);
      const edge = smooth(0.0, 0.07, f) * smooth(1.0, 0.92, f);
      const weave = Math.sin(u * 192 * Math.PI) * Math.sin(v * 192 * Math.PI) * 0.5 + 0.5;
      const g = G(u * 64, v * 64);
      setInto(o, c, 0.8 + edge * 0.18 + weave * 0.04 + (g - 0.5) * 0.06);
      o.h = edge * 0.6 + weave * 0.25 + g * 0.15;
    };
  } },

  // goma: mate con grano
  rubber: { size: 128, tint: true, tile: 0.15, rough: 0.94, metal: 0.0, normal: 0.3, make: (p) => {
    const c = rgb(p.c), G = noiseFn(48, 48, p.seed);
    return (u, v, o) => {
      const g = G(u * 48, v * 48);
      setInto(o, c, 1 + (g - 0.5) * 0.07);
      o.h = g;
    };
  } },

  // esmalte blanco de ciencia ficción: liso, casi sin mancha
  enamel: { size: 128, tint: true, tile: 0.4, rough: 0.3, metal: 0.05, normal: 0, make: (p) => {
    const c = rgb(p.c), N = fbmFn(3, 3, p.seed);
    return (u, v, o) => setInto(o, c, 1 + (N(u, v) - 0.5) * 0.035);
  } },

  // circuito: pistas en una grilla, con máscara emisiva (brillan con el color del arma)
  circuit: { size: 256, tile: 0.32, rough: 0.45, metal: 0.3, normal: 0.5, emissive: true, make: (p) => {
    const c = rgb(p.c ?? '#15171c'), t = rgb(p.c2 ?? '#2a2f3a'), G = 12;
    // las pistas se sortean una vez: tablas de G×G en vez de un hash por consulta
    const H = new Uint8Array(G * G), Vt = new Uint8Array(G * G);
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) { H[j * G + i] = hash2(i, j, p.seed) > 0.52 ? 1 : 0; Vt[j * G + i] = hash2(i, j, p.seed + 1) > 0.6 ? 1 : 0; }
    const hEdge = (i, j) => H[wrap(j, G) * G + wrap(i, G)];      // pista (i,j)→(i+1,j)
    const vEdge = (i, j) => Vt[wrap(j, G) * G + wrap(i, G)];     // pista (i,j)→(i,j+1)
    return (u, v, o) => {
      const x = fract(u) * G, y = fract(v) * G, i = Math.floor(x), j = Math.floor(y);
      let d = 9;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ci = i + di, cj = j + dj;
        if (hEdge(ci, cj)) { const cx = Math.min(Math.max(x, ci), ci + 1); d = Math.min(d, Math.hypot(x - cx, y - cj)); }
        if (vEdge(ci, cj)) { const cy = Math.min(Math.max(y, cj), cj + 1); d = Math.min(d, Math.hypot(x - ci, y - cy)); }
      }
      // en cada vértice: grado 1 = terminal (anillo), grado ≥ 3 = unión (punto lleno)
      const rx = Math.round(x), ry = Math.round(y);
      const deg = hEdge(rx, ry) + hEdge(rx - 1, ry) + vEdge(rx, ry) + vEdge(rx, ry - 1);
      const dv = Math.hypot(x - rx, y - ry);
      const node = deg === 1 ? smooth(0.08, 0.1, dv) * (1 - smooth(0.15, 0.18, dv)) : deg >= 3 ? 1 - smooth(0.1, 0.13, dv) : 0;
      const trace = Math.max(1 - smooth(0.05, 0.085, d), node);
      mixInto(o, c, t, trace * 0.3);             // la pista casi no se ve de día: la dibuja la emisión
      o.e = trace;
      o.h = trace * 0.5;
    };
  } },

  // moleteado: pirámides en diamante (anillos de supresores, perillas)
  knurl: { size: 128, tint: true, tile: 0.03, rough: 0.42, metal: 0.8, normal: 1.6, make: (p) => {
    const c = rgb(p.c), N = 16;
    return (u, v, o) => {
      const h = Math.min(tri(u * N + v * N), tri(u * N - v * N));
      setInto(o, c, 0.76 + h * 0.32);
      o.h = h;
    };
  } },

  // marfil: blanco cálido con veta fina y grietas apenas marcadas
  ivory: { size: 128, tile: 0.15, rough: 0.42, metal: 0.0, normal: 0.25, make: (p) => {
    const c = rgb(p.c ?? '#e8dfca'), G = noiseFn(3, 60, p.seed), W = {};
    return (u, v, o) => {
      voronoi(u, v, 4, p.seed + 3, W, 0.9);
      const crack = 1 - smooth(0.0, 0.03, W.f2 - W.f1);
      setInto(o, c, 0.95 + G(u * 3, v * 60) * 0.06 - crack * 0.07);
      o.h = 1 - crack * 0.5;
    };
  } },

  // bronce/latón con pátina
  brass: { size: 128, tile: 0.2, rough: 0.34, metal: 0.92, normal: 0, make: (p) => {
    const a = rgb(p.c ?? '#b58f55'), b = rgb(p.c2 ?? '#6f6040'), N = fbmFn(4, 4, p.seed);
    return (u, v, o) => mixInto(o, a, b, smooth(0.45, 0.85, N(u, v)) * 0.5);
  } },

  // escarcha: facetas de cristal con aristas claras
  frost: { size: 256, tile: 0.18, rough: 0.24, metal: 0.1, normal: 0.8, make: (p) => {
    const a = rgb(p.c ?? '#cfe6f2'), b = rgb(p.c2 ?? '#7fb3d0'), W = {};
    return (u, v, o) => {
      voronoi(u, v, 6, p.seed, W, 0.95);
      const edge = 1 - smooth(0.0, 0.045, W.f2 - W.f1);
      mixInto(o, a, b, hash2(W.id, 1, p.seed) * 0.55);
      const k = 1 + edge * 0.18; o.r = Math.min(255, o.r * k); o.g = Math.min(255, o.g * k); o.b = Math.min(255, o.b * k);
      o.h = 0.5 + hash2(W.id, 2, p.seed) * 0.4 - edge * 0.3;
    };
  } },

  // rosetas de yaguareté: anillos cortados sobre ocre, centro un poco más oscuro
  jaguar: { size: 256, tile: 0.3, rough: 0.6, metal: 0.08, normal: 0.2, make: (p) => {
    const base = rgb(p.c ?? '#c89a45'), ring = rgb(p.c2 ?? '#1a1612'), inner = rgb(p.c3 ?? '#a9772f'), N = fbmFn(4, 3, p.seed + 1), W = {};
    return (u, v, o) => {
      voronoi(u, v, 7, p.seed, W, 0.75);
      const r = W.f1, a = Math.atan2(W.dy, W.dx);
      const annulus = smooth(0.2, 0.25, r) * smooth(0.43, 0.36, r);
      const broken = smooth(-0.35, 0.05, Math.sin(a * 4 + W.id * 5.3));
      const spot = annulus * broken;
      mixInto(o, base, inner, smooth(0.26, 0.18, r) * 0.6 + (N(u, v) - 0.5) * 0.2);
      if (spot > 0) { o.r += (ring[0] - o.r) * spot; o.g += (ring[1] - o.g) * spot; o.b += (ring[2] - o.b) * spot; }
      o.h = 1 - spot * 0.2;
    };
  } },
};

/**
 * El campo de camuflaje (lo comparten camo y digicamo): una base y tres
 * capas de manchas deformadas por dos fBm. Las fábricas se arman una vez.
 */
function camoField(p) {
  const [c1, c2, c3, c4] = p.cols.map(rgb), sc = p.scale ?? 3, seed = p.seed;
  const WU = fbmFn(2, 3, seed + 1), WV = fbmFn(2, 3, seed + 2);
  const N1 = fbmFn(sc, 4, seed + 3), N2 = fbmFn(sc, 4, seed + 4), N3 = fbmFn(sc * 2, 3, seed + 5);
  return (u, v, o, aa) => {
    const wu = u + (WU(u, v) - 0.5) * 0.2, wv = v + (WV(u, v) - 0.5) * 0.2;
    setInto(o, c1);
    let t = smooth(0.52 - aa, 0.52 + aa, N1(wu, wv));
    if (t > 0) { o.r += (c2[0] - o.r) * t; o.g += (c2[1] - o.g) * t; o.b += (c2[2] - o.b) * t; }
    t = smooth(0.56 - aa, 0.56 + aa, N2(wu, wv));
    if (t > 0) { o.r += (c3[0] - o.r) * t; o.g += (c3[1] - o.g) * t; o.b += (c3[2] - o.b) * t; }
    t = smooth(0.64 - aa, 0.64 + aa, N3(wu, wv));
    if (t > 0) { o.r += (c4[0] - o.r) * t; o.g += (c4[1] - o.g) * t; o.b += (c4[2] - o.b) * t; }
    o.h = 0.5;
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Generador
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Calcula los píxeles de una receta. Devuelve arrays RGBA crudos: albedo
 * (sRGB), y si la receta los tiene, normales (espacio tangente, +Z afuera),
 * rugosidad (en G, como la lee three) y emisión. O(S²).
 */
export function renderFinish(name, params = {}, sizeOverride = 0) {
  const R = RECIPES[name];
  if (!R) throw new Error(`receta de acabado desconocida: ${name}`);
  const S = sizeOverride || R.size;
  const p = { seed: 1, ...params };
  const px = R.make(p);
  const n = S * S;
  const albedo = new Uint8Array(n * 4);
  const height = R.normal > 0 ? new Float32Array(n) : null;
  const rough = R.roughMap ? new Uint8Array(n * 4) : null;
  const emissive = R.emissive ? new Uint8Array(n * 4) : null;
  const o = { r: 0, g: 0, b: 0, h: 0.5, ro: 0.5, e: 0 };
  const clampByte = (x) => (x <= 0 ? 0 : x >= 255 ? 255 : x + 0.5) | 0;
  for (let y = 0, k = 0; y < S; y++) {
    const v = (y + 0.5) / S;
    for (let x = 0; x < S; x++, k++) {
      o.h = 0.5; o.ro = 0.5; o.e = 0;
      px((x + 0.5) / S, v, o);
      const q = k * 4;
      albedo[q] = clampByte(o.r); albedo[q + 1] = clampByte(o.g); albedo[q + 2] = clampByte(o.b); albedo[q + 3] = 255;
      if (height) height[k] = o.h;
      if (rough) { const r8 = clampByte(o.ro * 255); rough[q] = r8; rough[q + 1] = r8; rough[q + 2] = r8; rough[q + 3] = 255; }
      if (emissive) { const e8 = clampByte(o.e * 255); emissive[q] = e8; emissive[q + 1] = e8; emissive[q + 2] = e8; emissive[q + 3] = 255; }
    }
  }
  const normal = height ? heightToNormal(height, S, R.normal) : null;
  return { name, size: S, albedo, normal, rough, emissive };
}

/**
 * Mapa de normales por diferencias centrales con vecinos que envuelven
 * (repite igual que la altura). `strength` escala la pendiente. O(S²).
 */
function heightToNormal(h, S, strength) {
  const out = new Uint8Array(S * S * 4);
  const k = strength * S / 64;          // la fuerza no depende de la resolución
  for (let y = 0; y < S; y++) {
    const ym = ((y - 1 + S) % S) * S, yp = ((y + 1) % S) * S, yr = y * S;
    for (let x = 0; x < S; x++) {
      const xm = (x - 1 + S) % S, xp = (x + 1) % S;
      const dx = (h[yr + xp] - h[yr + xm]) * 0.5 * k;
      const dy = (h[yp + x] - h[ym + x]) * 0.5 * k;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const q = (yr + x) * 4;
      out[q] = ((-dx * inv) * 0.5 + 0.5) * 255 + 0.5 | 0;
      out[q + 1] = ((-dy * inv) * 0.5 + 0.5) * 255 + 0.5 | 0;
      out[q + 2] = (inv * 0.5 + 0.5) * 255 + 0.5 | 0;
      out[q + 3] = 255;
    }
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Especificación de acabado: 'receta:#color/#color2/...' o un objeto
// ═════════════════════════════════════════════════════════════════════════════

const FLAT = 'flat';

/**
 * Normaliza la descripción de un acabado. Acepta 'wood:#6b4128/#3a2213',
 * 'camo:#a/#b/#c/#d', 'flat:#222' o {f, c, c2, rough, metal, ...}. Se valida
 * acá (la frontera): adentro todo confía en la forma.
 */
export function parseFinish(spec) {
  if (spec && typeof spec === 'object') return { ...spec, f: spec.f || FLAT };
  if (typeof spec !== 'string' || !spec) throw new Error(`acabado inválido: ${spec}`);
  const [f, colors = ''] = spec.split(':');
  const cols = colors ? colors.split('/') : [];
  if (f !== FLAT && !RECIPES[f]) throw new Error(`acabado inválido: ${spec}`);
  for (const c of cols) rgb(c);
  // sin colores, la receta usa los suyos (el latón es latón, no gris)
  const out = { f };
  if (cols[0]) out.c = cols[0];
  if (cols[1]) out.c2 = cols[1];
  if (cols[2]) out.c3 = cols[2];
  if (cols.length >= 3) out.cols = cols.slice(0, 4);
  while (out.cols && out.cols.length < 4) out.cols.push(out.cols[out.cols.length - 1]);
  return out;
}

