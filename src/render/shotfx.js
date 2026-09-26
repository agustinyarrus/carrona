// ─────────────────────────────────────────────────────────────────────────────
//  shotfx.js — Cómo se VE un tiro: fogonazos con forma, trazadoras que viajan,
//  rayos con núcleo blanco, rieles con espiral, relámpagos que saltan, chispas
//  estiradas por su velocidad, anillos de onda, bolas de fuego, humo, escarcha
//  y ácido. Y los proyectiles con modelo (cohetes, granadas, virotes, discos).
//
//  Todo lo que brilla es UN draw call: un InstancedBufferGeometry de quads
//  cuyo vertex shader arma cada instancia en uno de tres modos:
//    0 billboard   mira a la cámara, rotado (fogonazo de frente, brasas, bolas)
//    1 segmento    de A a B, girando sobre su eje para mirar a la cámara
//                  (trazadoras, rayos, chispas, relámpagos)
//    2 plano       apoyado sobre una normal (anillo de onda en el piso, marca
//                  de impacto en la pared)
//  El humo es otro lote igual con mezcla alfa (el humo oscurece; lo aditivo
//  sólo puede aclarar). Las formas salen de un atlas 4×4 calculado en JS puro.
//
//  Las partículas viven en arrays planos (SoA) con un integrador de pocas
//  líneas; sin objetos por partícula, sin basura por cuadro. O(n) por cuadro
//  con n partículas vivas; el lote se escribe compacto (sólo las vivas).
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { mergeGeoms } from './models.js';

// ── celdas del atlas ─────────────────────────────────────────────────────────
export const CELL = Object.freeze({
  DOT: 0, STAR4: 1, STAR6: 2, CONE: 3, RING: 4, BEAM: 5, STREAK: 6, PUFF: 7,
  BOLT: 8, EMBER_RING: 9, PETALS: 10, SWIRL: 11, FLARE: 12, TONGUE: 13, CRYSTAL: 14, BUBBLE: 15,
});
const MODE_BILL = 0, MODE_SEG = 1, MODE_PLANE = 2;

// comportamiento por partícula
const K_STATIC = 0, K_MOVE = 1, K_STREAK = 2, K_TRACER = 3;
// curvas de desvanecimiento
const F_LINEAR = 0, F_QUAD = 1, F_FLASH = 2, F_FIRE = 3, F_HOLD = 4, F_SMOKE = 5;

const _c = new THREE.Color();

// ═════════════════════════════════════════════════════════════════════════════
//  Atlas procedural (512², 4×4 celdas de 128). Determinista, sin canvas.
// ═════════════════════════════════════════════════════════════════════════════
function hash(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/**
 * Cada celda: f(x, y) con x, y ∈ [-1, 1] (y "hacia arriba" = a lo largo del
 * segmento en modo 1) → [intensidad, alfa]. El color blanco lo tiñe la
 * instancia; el núcleo caliente se logra con intensidad > alfa (satura a
 * blanco con el tone mapping, que es como se ve un fogonazo de verdad).
 */
const CELL_FN = [
  // 0 punto suave
  (x, y) => { const r2 = x * x + y * y; const a = Math.exp(-r2 * 4.2); return [a, a]; },
  // 1 estrella de 4 puntas con núcleo
  (x, y) => {
    const r = Math.hypot(x, y), ang = Math.atan2(y, x);
    const arms = Math.pow(Math.abs(Math.cos(ang * 2)), 18) * sat(1 - r) * 1.0;
    const core = Math.exp(-r * r * 22);
    const a = sat(arms * 0.9 + core + Math.exp(-r * r * 5) * 0.25);
    return [a, a];
  },
  // 2 estrella de 6 puntas
  (x, y) => {
    const r = Math.hypot(x, y), ang = Math.atan2(y, x);
    const arms = Math.pow(Math.abs(Math.cos(ang * 3)), 14) * sat(1 - r * 1.05);
    const a = sat(arms * 0.85 + Math.exp(-r * r * 18) + Math.exp(-r * r * 4) * 0.2);
    return [a, a];
  },
  // 3 cono de fogonazo lateral: nace ancho abajo (y=-1, la boca) y se afina arriba
  (x, y) => {
    const t = (y + 1) / 2;                      // 0 en la boca, 1 en la punta
    const w = 0.85 * (1 - t) + 0.08;
    const across = Math.exp(-(x * x) / (w * w) * 2.2);
    const along = sstep(1.0, 0.55, t) * sstep(0.0, 0.06, t);
    const n = 0.75 + 0.25 * vnoise(x * 6, t * 9, 3);
    const a = sat(across * along * n * 1.15);
    return [a, a];
  },
  // 4 anillo fino suave
  (x, y) => { const r = Math.hypot(x, y); const a = Math.exp(-Math.pow((r - 0.78) / 0.07, 2)) * sstep(1.0, 0.92, r); return [a, a]; },
  // 5 perfil de rayo: núcleo angosto + halo; extremos redondeados
  (x, y) => {
    const core = Math.exp(-x * x * 90), halo = Math.exp(-x * x * 7) * 0.45;
    const ends = sstep(1.0, 0.8, Math.abs(y));
    const a = sat((core + halo) * ends);
    return [a, a];
  },
  // 6 chispa: cabeza brillante arriba, cola que se apaga
  (x, y) => {
    const t = (y + 1) / 2;
    const across = Math.exp(-x * x * 26);
    const a = sat(across * Math.pow(t, 1.6) * sstep(1.0, 0.9, t) * 1.2);
    return [a, a];
  },
  // 7 bocanada de humo: mancha con borde ruidoso
  (x, y) => {
    const r = Math.hypot(x, y);
    const n = vnoise(x * 3.2 + 7, y * 3.2 + 3, 11) * 0.6 + vnoise(x * 7, y * 7, 13) * 0.4;
    const a = sat(sstep(1.0, 0.25, r + (n - 0.5) * 0.55)) * 0.9;
    return [0.85 + n * 0.15, a];
  },
  // 8 relámpago: núcleo durísimo, halo corto
  (x, y) => {
    const a = sat((Math.exp(-x * x * 160) + Math.exp(-x * x * 14) * 0.35) * sstep(1.0, 0.85, Math.abs(y)));
    return [a, a];
  },
  // 9 anillo de brasas (marca caliente en una superficie)
  (x, y) => {
    const r = Math.hypot(x, y), n = vnoise(Math.atan2(y, x) * 3 + 10, r * 4, 17);
    const a = sat(Math.exp(-Math.pow((r - 0.55) / (0.16 + n * 0.1), 2)) * (0.6 + n * 0.6) * sstep(1, 0.85, r));
    return [a, a];
  },
  // 10 pétalos: fogonazo de frente irregular (5 lóbulos)
  (x, y) => {
    const r = Math.hypot(x, y), ang = Math.atan2(y, x);
    const lobes = 0.55 + 0.45 * Math.pow(Math.abs(Math.cos(ang * 2.5)), 3) + (vnoise(ang * 2 + 5, 1, 21) - 0.5) * 0.3;
    const a = sat(sstep(lobes, lobes * 0.35, r) + Math.exp(-r * r * 16));
    return [a, a];
  },
  // 11 remolino (plasma, vórtice): brazos en espiral
  (x, y) => {
    const r = Math.hypot(x, y), ang = Math.atan2(y, x);
    const s = Math.pow(0.5 + 0.5 * Math.cos(ang * 3 + r * 9), 3) * sstep(1, 0.4, r) * sstep(0.02, 0.2, r);
    const a = sat(s * 0.8 + Math.exp(-r * r * 12) * 0.9);
    return [a, a];
  },
  // 12 destello horizontal (lente): línea larga y fina con núcleo
  (x, y) => { const a = sat(Math.exp(-y * y * 220) * Math.exp(-x * x * 1.6) + Math.exp(-(x * x + y * y) * 30)); return [a, a]; },
  // 13 lengua de fuego: gota con ruido, se afina hacia arriba
  (x, y) => {
    const t = (y + 1) / 2, w = 0.75 * (1 - t * 0.85);
    const n = vnoise(x * 4 + 3, y * 4 - 2, 29);
    const a = sat(Math.exp(-(x * x) / (w * w) * 2.6) * sstep(1, 0.4, t + (n - 0.5) * 0.4) * sstep(-0.05, 0.18, t) * 1.2);
    return [a, a];
  },
  // 14 cristal de hielo: seis brazos finos con ramitas
  (x, y) => {
    const r = Math.hypot(x, y), ang = Math.atan2(y, x);
    const k = Math.abs(Math.sin(ang * 3));
    const arm = Math.exp(-k * k * r * r * 900) * sstep(1, 0.7, r);
    const twig = Math.exp(-Math.pow(Math.abs(Math.sin(ang * 3 + 0.9)) * r, 2) * 1500) * sstep(0.35, 0.45, r) * sstep(0.8, 0.6, r);
    const a = sat(arm + twig * 0.6 + Math.exp(-r * r * 40));
    return [a, a];
  },
  // 15 burbuja: aro con reflejo
  (x, y) => {
    const r = Math.hypot(x, y);
    const rim = Math.exp(-Math.pow((r - 0.8) / 0.09, 2));
    const hi = Math.exp(-((x + 0.35) ** 2 + (y - 0.35) ** 2) * 40);
    const a = sat(rim * 0.9 + hi + (r < 0.8 ? 0.12 : 0) * sstep(0.8, 0.7, r));
    return [a, a];
  },
];

/** El atlas en bytes: RGB = intensidad, A = alfa. Premultiplicado en el shader. O(512²). */
export function renderSpriteAtlas(S = 512) {
  const C = S / 4, data = new Uint8Array(S * S * 4);
  for (let cell = 0; cell < 16; cell++) {
    const cx = (cell % 4) * C, cy = Math.floor(cell / 4) * C, fn = CELL_FN[cell];
    for (let j = 0; j < C; j++) {
      const y = ((j + 0.5) / C) * 2 - 1;
      for (let i = 0; i < C; i++) {
        const x = ((i + 0.5) / C) * 2 - 1;
        // un píxel de margen transparente: el filtrado no sangra hacia la celda vecina
        const edge = i === 0 || j === 0 || i === C - 1 || j === C - 1;
        const [v, a] = edge ? [0, 0] : fn(x, y);
        const k = ((cy + j) * S + cx + i) * 4;
        const vb = Math.round(sat(v) * 255);
        data[k] = vb; data[k + 1] = vb; data[k + 2] = vb; data[k + 3] = Math.round(sat(a) * 255);
      }
    }
  }
  return data;
}

// ═════════════════════════════════════════════════════════════════════════════
//  El lote de sprites
// ═════════════════════════════════════════════════════════════════════════════
const VERT = /* glsl */`
  attribute vec2 corner;
  attribute vec3 iA;
  attribute vec3 iB;
  attribute vec2 iSize;
  attribute vec4 iColor;
  attribute vec3 iMisc;          // modo, celda, rotación
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vCell;
  void main() {
    int mode = int(iMisc.x + 0.5);
    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec2 c = corner;
    vec3 p;
    if (mode == 1) {
      vec3 axis = iB - iA;
      float L = length(axis);
      vec3 d = L > 1e-6 ? axis / L : vec3(0.0, 0.0, 1.0);
      vec3 mid = mix(iA, iB, c.y * 0.5 + 0.5);
      vec3 toCam = normalize(cameraPosition - mid);
      vec3 side = cross(d, toCam);
      float sl = length(side);
      side = sl > 1e-5 ? side / sl : camRight;
      p = mid + side * (c.x * iSize.x) + d * (c.y * iSize.x * 0.5);
    } else {
      float s = sin(iMisc.z), co = cos(iMisc.z);
      vec2 r = vec2(c.x * co - c.y * s, c.x * s + c.y * co);
      if (mode == 2) {
        vec3 n = normalize(iB);
        vec3 t = abs(n.y) < 0.99 ? normalize(cross(n, vec3(0.0, 1.0, 0.0))) : normalize(cross(n, vec3(1.0, 0.0, 0.0)));
        vec3 b = cross(n, t);
        p = iA + t * (r.x * iSize.x) + b * (r.y * iSize.y);
      } else {
        p = iA + camRight * (r.x * iSize.x) + camUp * (r.y * iSize.y);
      }
    }
    vUv = c * 0.5 + 0.5;
    vColor = iColor;
    vCell = iMisc.y;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }`;
const FRAG = /* glsl */`
  uniform sampler2D atlas;
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vCell;
  void main() {
    float cell = floor(vCell + 0.5);
    vec2 uv = (vec2(mod(cell, 4.0), floor(cell / 4.0)) + clamp(vUv, 0.004, 0.996)) * 0.25;
    vec4 t = texture2D(atlas, uv);
    float a = t.a * vColor.a;
    if (a < 0.002) discard;
    gl_FragColor = vec4(vColor.rgb * t.rgb * a, a);    // premultiplicado: sirve igual para suma y para alfa
  }`;

let ATLAS_TEX = null;
function atlasTexture() {
  if (ATLAS_TEX) return ATLAS_TEX;
  const S = 512;
  const t = new THREE.DataTexture(renderSpriteAtlas(S), S, S, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.needsUpdate = true;
  ATLAS_TEX = t;
  return t;
}

/**
 * Un lote de partículas-sprite de capacidad fija. `additive`: suman luz (lo
 * que brilla); si no, mezcla alfa premultiplicada (humo, polvo).
 */
class SpriteBatch {
  constructor(scene, cap, additive, renderOrder) {
    this.cap = cap;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const attr = (name, n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(name, a); return a; };
    this.aA = attr('iA', 3); this.aB = attr('iB', 3); this.aSize = attr('iSize', 2); this.aColor = attr('iColor', 4); this.aMisc = attr('iMisc', 3);
    g.instanceCount = 0;
    this.geo = g;
    // el fragment devuelve color premultiplicado: suma pura (1, 1) para la luz, "encima" (1, 1−α) para el humo
    this.mat = new THREE.ShaderMaterial({
      uniforms: { atlas: { value: atlasTexture() } }, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    scene.add(this.mesh);

    // estado por partícula (SoA)
    const F = (n = 1) => new Float32Array(cap * n);
    this.kind = new Uint8Array(cap); this.mode = new Uint8Array(cap); this.cell = new Uint8Array(cap); this.fade = new Uint8Array(cap);
    this.p = F(3); this.q = F(3); this.v = F(3);
    this.w = F(); this.h = F(); this.gw = F(); this.gh = F();         // tamaño y crecimiento (por segundo, multiplicativo)
    this.col = F(4); this.life = F(); this.life0 = F(); this.rot = F(); this.rotV = F();
    this.drag = F(); this.grav = F(); this.stretch = F(); this.speed = F(); this.len = F(); this.travel = F();
    this.n = 0;              // partículas vivas (compactas en [0, n))
  }

  /** Alta de una partícula. Si el lote está lleno, pisa la más vieja (índice rotativo). */
  spawn(kind, mode, cell, fade, life) {
    let i;
    if (this.n < this.cap) i = this.n++;
    else { this._cursor = ((this._cursor | 0) + 1) % this.cap; i = this._cursor; }
    this.kind[i] = kind; this.mode[i] = mode; this.cell[i] = cell; this.fade[i] = fade;
    this.life[i] = life; this.life0[i] = life;
    this.gw[i] = 0; this.gh[i] = 0; this.rot[i] = 0; this.rotV[i] = 0; this.drag[i] = 0; this.grav[i] = 0; this.stretch[i] = 0;
    this.v[i * 3] = 0; this.v[i * 3 + 1] = 0; this.v[i * 3 + 2] = 0;
    return i;
  }
  setP(i, x, y, z) { this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z; }
  setQ(i, x, y, z) { this.q[i * 3] = x; this.q[i * 3 + 1] = y; this.q[i * 3 + 2] = z; }
  setV(i, x, y, z) { this.v[i * 3] = x; this.v[i * 3 + 1] = y; this.v[i * 3 + 2] = z; }
  setColor(i, r, g, b, a = 1) { this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a; }

  /** Paso: integra, desvanece, compacta y escribe el lote. O(n). */
  update(dt) {
    let live = 0;
    const A = this.aA.array, B = this.aB.array, SZ = this.aSize.array, CO = this.aColor.array, MI = this.aMisc.array;
    for (let i = 0; i < this.n; i++) {
      let L = this.life[i] - dt;
      if (L <= 0) continue;
      const i3 = i * 3;
      const k = this.kind[i];
      let ax, ay, az, bx, by, bz;
      if (k === K_TRACER) {
        // trazadora: la cabeza avanza a `speed` desde el origen hasta `len`; la cola la sigue a `stretch` metros
        this.travel[i] += this.speed[i] * dt;
        const head = Math.min(this.len[i], this.travel[i]), tail = Math.max(0, head - this.stretch[i]);
        if (tail >= this.len[i] - 1e-3) continue;
        const dx = this.q[i3], dy = this.q[i3 + 1], dz = this.q[i3 + 2];
        ax = this.p[i3] + dx * tail; ay = this.p[i3 + 1] + dy * tail; az = this.p[i3 + 2] + dz * tail;
        bx = this.p[i3] + dx * head; by = this.p[i3 + 1] + dy * head; bz = this.p[i3 + 2] + dz * head;
        L = Math.max(L, 0.001);
      } else {
        if (k === K_MOVE || k === K_STREAK) {
          const kd = Math.max(0, 1 - this.drag[i] * dt);
          this.v[i3] *= kd; this.v[i3 + 2] *= kd;
          this.v[i3 + 1] = this.v[i3 + 1] * kd - this.grav[i] * dt;
          this.p[i3] += this.v[i3] * dt; this.p[i3 + 1] += this.v[i3 + 1] * dt; this.p[i3 + 2] += this.v[i3 + 2] * dt;
          if (this.p[i3 + 1] < 0.02 && this.grav[i] > 0) { this.p[i3 + 1] = 0.02; this.v[i3 + 1] *= -0.3; this.v[i3] *= 0.6; this.v[i3 + 2] *= 0.6; }
        }
        if (this.gw[i]) this.w[i] *= Math.exp(this.gw[i] * dt);
        if (this.gh[i]) this.h[i] *= Math.exp(this.gh[i] * dt);
        this.rot[i] += this.rotV[i] * dt;
        ax = this.p[i3]; ay = this.p[i3 + 1]; az = this.p[i3 + 2];
        if (k === K_STREAK) {
          const s = this.stretch[i];
          bx = ax; by = ay; bz = az;
          ax -= this.v[i3] * s; ay -= this.v[i3 + 1] * s; az -= this.v[i3 + 2] * s;
        } else { bx = this.q[i3]; by = this.q[i3 + 1]; bz = this.q[i3 + 2]; }
      }
      this.life[i] = L;
      const u = L / this.life0[i];          // 1 → 0
      let f;
      switch (this.fade[i]) {
        case F_QUAD: f = u * u; break;
        case F_FLASH: f = u * u * u; break;
        case F_HOLD: f = u > 0.35 ? 1 : u / 0.35; break;
        case F_SMOKE: f = Math.min(1, (1 - u) * 6) * u; break;
        case F_FIRE: f = u; break;
        default: f = u;
      }
      // compactar: la partícula viva pasa al índice `live`
      if (live !== i) this._move(i, live);
      const o3 = live * 3, o4 = live * 4, o2 = live * 2;
      A[o3] = ax; A[o3 + 1] = ay; A[o3 + 2] = az;
      B[o3] = bx; B[o3 + 1] = by; B[o3 + 2] = bz;
      SZ[o2] = this.w[live]; SZ[o2 + 1] = this.h[live];
      let r = this.col[o4], g = this.col[o4 + 1], b = this.col[o4 + 2];
      if (this.fade[live] === F_FIRE) {
        // fuego: blanco amarillo → naranja → rojo oscuro a medida que se consume
        const t = 1 - u;
        r *= 1; g *= Math.max(0.12, 1 - t * 1.25); b *= Math.max(0.02, 1 - t * 2.6);
      }
      CO[o4] = r * f; CO[o4 + 1] = g * f; CO[o4 + 2] = b * f; CO[o4 + 3] = this.col[o4 + 3] * f;
      MI[o3] = this.mode[live]; MI[o3 + 1] = this.cell[live]; MI[o3 + 2] = this.rot[live];
      live++;
    }
    this.n = live;
    this.geo.instanceCount = live;
    this.mesh.visible = live > 0;
    if (live) { this.aA.needsUpdate = this.aB.needsUpdate = this.aSize.needsUpdate = this.aColor.needsUpdate = this.aMisc.needsUpdate = true; }
  }

  _move(i, j) {
    this.kind[j] = this.kind[i]; this.mode[j] = this.mode[i]; this.cell[j] = this.cell[i]; this.fade[j] = this.fade[i];
    for (let c = 0; c < 3; c++) { this.p[j * 3 + c] = this.p[i * 3 + c]; this.q[j * 3 + c] = this.q[i * 3 + c]; this.v[j * 3 + c] = this.v[i * 3 + c]; }
    for (let c = 0; c < 4; c++) this.col[j * 4 + c] = this.col[i * 4 + c];
    this.w[j] = this.w[i]; this.h[j] = this.h[i]; this.gw[j] = this.gw[i]; this.gh[j] = this.gh[i];
    this.life[j] = this.life[i]; this.life0[j] = this.life0[i]; this.rot[j] = this.rot[i]; this.rotV[j] = this.rotV[i];
    this.drag[j] = this.drag[i]; this.grav[j] = this.grav[i]; this.stretch[j] = this.stretch[i];
    this.speed[j] = this.speed[i]; this.len[j] = this.len[i]; this.travel[j] = this.travel[i];
  }

  clear() { this.n = 0; this.geo.instanceCount = 0; this.mesh.visible = false; }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Proyectiles con modelo: una malla instanciada por aspecto
// ═════════════════════════════════════════════════════════════════════════════
const M4 = () => new THREE.Matrix4();
function part(geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = M4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')).setPosition(x, y, z);
  return { geo, matrix: m };
}
const cylZ = (r1, r2, len, seg = 10) => new THREE.CylinderGeometry(r2, r1, len, seg).rotateX(Math.PI / 2);

/** Geometrías de los proyectiles (apuntan a +Z). Cuerpo iluminado + parte que brilla. */
function projectileLooks() {
  const L = {};
  const std = (color, rough = 0.5, metal = 0.3) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  const glow = (color, k = 2.4) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), toneMapped: false });
  const fins = (r, len, z) => [0, 1, 2, 3].map(k => part(new THREE.BoxGeometry(0.004, r * 2.2, len), 0, 0, z, 0, 0, k * Math.PI / 4 + Math.PI / 4));
  L.rocket = { body: mergeGeoms([part(cylZ(0.028, 0.028, 0.26), 0, 0, 0), part(new THREE.ConeGeometry(0.04, 0.14, 12).rotateX(Math.PI / 2), 0, 0, 0.2), part(cylZ(0.04, 0.04, 0.05, 12), 0, 0, 0.11), ...fins(0.03, 0.08, -0.1)]), mat: std(0x55603f, 0.6, 0.2) };
  L.mini = { body: mergeGeoms([part(cylZ(0.012, 0.012, 0.13), 0, 0, 0), part(new THREE.ConeGeometry(0.012, 0.04, 8).rotateX(Math.PI / 2), 0, 0, 0.085), ...fins(0.012, 0.03, -0.05)]), mat: std(0xe8ebef, 0.4, 0.2), tip: glow(0xf38ba8) };
  L.grenade = { body: mergeGeoms([part(cylZ(0.02, 0.02, 0.05, 12), 0, 0, 0), part(new THREE.SphereGeometry(0.02, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), 0, 0, 0.025)]), mat: std(0x5d6142, 0.5, 0.2) };
  L.sticky = { body: new THREE.IcosahedronGeometry(0.036, 1), mat: std(0xe3b341, 0.5, 0.1) };
  L.bolt = { body: mergeGeoms([part(cylZ(0.004, 0.004, 0.42, 6), 0, 0, 0), part(new THREE.ConeGeometry(0.009, 0.04, 6).rotateX(Math.PI / 2), 0, 0, 0.23), ...[0, 1, 2].map(k => part(new THREE.BoxGeometry(0.001, 0.02, 0.06), 0, 0, -0.18, 0, 0, k * Math.PI * 2 / 3))]), mat: std(0x2a2c31, 0.4, 0.5) };
  L.nail = { body: mergeGeoms([part(cylZ(0.0025, 0.0025, 0.07, 6), 0, 0, 0), part(cylZ(0.006, 0.006, 0.003, 8), 0, 0, -0.036)]), mat: std(0xb6bcc4, 0.3, 0.9) };
  L.harpoon = { body: mergeGeoms([part(cylZ(0.007, 0.007, 0.6, 8), 0, 0, 0), part(new THREE.ConeGeometry(0.018, 0.08, 8).rotateX(Math.PI / 2), 0, 0, 0.33), part(new THREE.TorusGeometry(0.012, 0.003, 4, 10), 0, 0, -0.3)]), mat: std(0x9aa1aa, 0.3, 0.9) };
  L.disc = { body: mergeGeoms([part(cylZ(0.07, 0.07, 0.004, 24).rotateX(Math.PI / 2), 0, 0, 0), ...Array.from({ length: 12 }, (_, k) => { const a = k * Math.PI / 6; return part(new THREE.BoxGeometry(0.016, 0.004, 0.014), Math.sin(a) * 0.074, 0, Math.cos(a) * 0.074, 0, a + 0.5, 0); })]), mat: std(0x9aa1aa, 0.35, 0.9), flat: true };
  L.flare = { body: cylZ(0.012, 0.012, 0.05, 10), mat: std(0xc9412f, 0.6, 0.1), tip: glow(0xfab387, 3) };
  L.glob = { body: new THREE.IcosahedronGeometry(0.045, 1), mat: glow(0xb5f25a, 1.6) };
  L.orb = { body: new THREE.IcosahedronGeometry(0.028, 1), mat: glow(0xffffff, 2.2) };
  L.ion = { body: new THREE.IcosahedronGeometry(0.05, 2), mat: glow(0xf5f7ff, 2.6) };
  L.vortex = { body: new THREE.IcosahedronGeometry(0.05, 2), mat: new THREE.MeshBasicMaterial({ color: 0x050507 }) };
  if (L.mini.tip) L.mini.tipGeo = new THREE.ConeGeometry(0.0125, 0.04, 8).rotateX(Math.PI / 2).translate(0, 0, 0.085);
  if (L.flare.tip) L.flare.tipGeo = new THREE.SphereGeometry(0.014, 8, 6).translate(0, 0, 0.03);
  return L;
}

// ═════════════════════════════════════════════════════════════════════════════
//  ShotFX: la fachada que usan el juego, la balística y la galería
// ═════════════════════════════════════════════════════════════════════════════
export class ShotFX {
  /**
   * @param scene  escena de Three
   * @param opts   {glow: capacidad, smoke: capacidad, projectiles: capacidad por aspecto, light(x,y,z,color,k,dist)}
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.glow = new SpriteBatch(scene, opts.glow ?? 4096, true, 7);
    this.smoke = new SpriteBatch(scene, opts.smoke ?? 1024, false, 3);
    this.light = opts.light || null;                // pulso de luz (fogonazos de color, explosiones)
    this.rng = opts.rng || Math.random;
    this.looks = projectileLooks();
    this.proj = {};
    const cap = opts.projectiles ?? 48;
    for (const k in this.looks) {
      const Lk = this.looks[k];
      const m = new THREE.InstancedMesh(Lk.body, Lk.mat, cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; m.count = 0; m.castShadow = true;
      scene.add(m);
      let tip = null;
      if (Lk.tipGeo) { tip = new THREE.InstancedMesh(Lk.tipGeo, Lk.tip, cap); tip.instanceMatrix.setUsage(THREE.DynamicDrawUsage); tip.frustumCulled = false; tip.count = 0; scene.add(tip); }
      this.proj[k] = { mesh: m, tip, n: 0, cap };
    }
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._qs = new THREE.Quaternion(); this._v = new THREE.Vector3(); this._s = new THREE.Vector3(1, 1, 1);
    this._z = new THREE.Vector3(0, 0, 1); this._d = new THREE.Vector3(); this._ax = new THREE.Vector3();
  }

  _rgb(color, k = 1) { _c.set(color); return [_c.r * k, _c.g * k, _c.b * k]; }
  _r() { return this.rng(); }

  // ── primitivas ────────────────────────────────────────────────────────────
  /** Sprite que mira a la cámara. */
  billboard(x, y, z, size, color, k, life, cell = CELL.DOT, fade = F_QUAD, rot = 0, grow = 0, batch = this.glow) {
    const B = batch, i = B.spawn(K_STATIC, MODE_BILL, cell, fade, life);
    B.setP(i, x, y, z); B.w[i] = size; B.h[i] = size; B.gw[i] = grow; B.gh[i] = grow; B.rot[i] = rot;
    const [r, g, b] = this._rgb(color, k); B.setColor(i, r, g, b, 1);
    return i;
  }
  /** Segmento de A a B (rayo, trazo). */
  segment(x0, y0, z0, x1, y1, z1, width, color, k, life, cell = CELL.BEAM, fade = F_QUAD) {
    const B = this.glow, i = B.spawn(K_STATIC, MODE_SEG, cell, fade, life);
    B.setP(i, x0, y0, z0); B.setQ(i, x1, y1, z1); B.w[i] = width; B.h[i] = width;
    const [r, g, b] = this._rgb(color, k); B.setColor(i, r, g, b, 1);
    return i;
  }
  /** Plano apoyado sobre una normal (anillo en el piso, marca en la pared). */
  plane(x, y, z, nx, ny, nz, size, color, k, life, cell = CELL.RING, fade = F_QUAD, grow = 0, rot = 0) {
    const B = this.glow, i = B.spawn(K_STATIC, MODE_PLANE, cell, fade, life);
    B.setP(i, x + nx * 0.02, y + ny * 0.02, z + nz * 0.02); B.setQ(i, nx, ny, nz); B.w[i] = size; B.h[i] = size; B.gw[i] = grow; B.gh[i] = grow; B.rot[i] = rot;
    const [r, g, b] = this._rgb(color, k); B.setColor(i, r, g, b, 1);
    return i;
  }
  /** Partícula que se mueve (brasa, fuego, humo). */
  mote(x, y, z, vx, vy, vz, size, color, k, life, { cell = CELL.DOT, fade = F_QUAD, drag = 1.5, grav = 0, grow = 0, rotV = 0, batch = this.glow, alpha = 1 } = {}) {
    const B = batch, i = B.spawn(K_MOVE, MODE_BILL, cell, fade, life);
    B.setP(i, x, y, z); B.setV(i, vx, vy, vz); B.w[i] = size; B.h[i] = size; B.gw[i] = grow; B.gh[i] = grow;
    B.drag[i] = drag; B.grav[i] = grav; B.rot[i] = this._r() * 6.283; B.rotV[i] = rotV;
    const [r, g, b] = this._rgb(color, k); B.setColor(i, r, g, b, alpha);
    return i;
  }
  /** Chispa: segmento estirado según su velocidad. */
  spark(x, y, z, vx, vy, vz, width, color, k, life, stretch = 0.035, grav = 14, drag = 2.2) {
    const B = this.glow, i = B.spawn(K_STREAK, MODE_SEG, CELL.STREAK, F_QUAD, life);
    B.setP(i, x, y, z); B.setV(i, vx, vy, vz); B.w[i] = width; B.h[i] = width; B.stretch[i] = stretch; B.grav[i] = grav; B.drag[i] = drag;
    const [r, g, b] = this._rgb(color, k); B.setColor(i, r, g, b, 1);
    return i;
  }
  /** Trazadora que viaja de A a B a `speed`, con una estela de `tail` metros. */
  tracer(x0, y0, z0, x1, y1, z1, color, width = 0.014, { speed = 320, tail = 3.2, k = 2.6, fadeLine = 0.06 } = {}) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, L = Math.hypot(dx, dy, dz);
    if (L < 1e-3) return;
    const B = this.glow, i = B.spawn(K_TRACER, MODE_SEG, CELL.BEAM, F_HOLD, L / speed + tail / speed + 0.02);
    B.setP(i, x0, y0, z0); B.setQ(i, dx / L, dy / L, dz / L);
    B.w[i] = width * 1.6; B.speed[i] = speed; B.len[i] = L; B.stretch[i] = Math.min(tail, L); B.travel[i] = 0;
    const [r, g, b] = this._rgb(color, k); B.setColor(i, r, g, b, 1);
    // línea tenue de todo el recorrido que se apaga enseguida (el ojo lee la dirección)
    if (fadeLine > 0) this.segment(x0, y0, z0, x1, y1, z1, width * 0.7, color, k * 0.22, fadeLine, CELL.BEAM, F_QUAD);
  }

  // ── fogonazos ─────────────────────────────────────────────────────────────
  /**
   * Fogonazo según el estilo del arma: std · big · brake · sup · shotgun ·
   * dragon · mini · energy · plasma · rail · beam · launch · gl · none.
   */
  flash(style, x, y, z, dx, dy, dz, color = '#ffd39a', scale = 1, rear = null) {
    const R = () => this._r();
    const tip = (d) => [x + dx * d, y + dy * d, z + dz * d];
    const cone = (len, width, k = 3.4, life = 0.05, col = color) => { const [ex, ey, ez] = tip(len); this.segment(x, y, z, ex, ey, ez, width, col, k, life, CELL.CONE, F_FLASH); };
    const front = (size, k = 3, cell = CELL.PETALS, life = 0.045) => { const [fx, fy, fz] = tip(0.04); this.billboard(fx, fy, fz, size, color, k, life, cell, F_FLASH, R() * 6.283); };
    const puff = (n, size, speed = 0.8, col = 0x9a9ea6, a = 0.35) => { for (let i = 0; i < n; i++) { const [px, py, pz] = tip(0.05 + R() * 0.1); this.mote(px, py, pz, dx * speed + (R() - 0.5) * 0.4, dy * speed + 0.3 + R() * 0.3, dz * speed + (R() - 0.5) * 0.4, size, col, 1, 0.9 + R() * 0.5, { batch: this.smoke, fade: F_SMOKE, cell: CELL.PUFF, drag: 1.8, grow: 1.1, alpha: a, rotV: (R() - 0.5) * 1.5 }); } };
    const light = (k, dist, col = color) => { if (this.light) this.light(x, y, z, col, k, dist); };
    const s = scale;
    switch (style) {
      case 'none': return;
      case 'sup':
        cone(0.12 * s, 0.03 * s, 1.2, 0.03); puff(2, 0.07, 0.5, 0xb0b4bb, 0.25); light(4, 4); return;
      case 'big':
        cone(0.42 * s, 0.14 * s, 4.2, 0.06); front(0.2 * s, 3.4, CELL.STAR6); puff(3, 0.12); light(30, 12); this._muzzleSparks(x, y, z, dx, dy, dz, 5, color); return;
      case 'brake': {
        cone(0.34 * s, 0.1 * s, 3.6, 0.05); front(0.14 * s, 3, CELL.STAR4);
        // freno de boca: dos chorros laterales
        const sx = -dz, sz = dx, sl = Math.hypot(sx, sz) || 1;
        for (const sg of [-1, 1]) { const ex = x + dx * 0.02 + sx / sl * sg * 0.22 * s, ez = z + dz * 0.02 + sz / sl * sg * 0.22 * s; this.segment(x, y, z, ex, y, ez, 0.07 * s, color, 3.0, 0.05, CELL.CONE, F_FLASH); }
        puff(4, 0.13, 0.4); light(26, 12); return;
      }
      case 'shotgun': case 'dragon': {
        cone(0.62 * s, 0.24 * s, 4.4, 0.065); front(0.28 * s, 3.6, CELL.PETALS);
        puff(5, 0.15, 1.1); light(34, 13);
        this._muzzleSparks(x, y, z, dx, dy, dz, style === 'dragon' ? 26 : 9, style === 'dragon' ? '#ff9a4a' : color, style === 'dragon' ? 1.8 : 1);
        return;
      }
      case 'mini':
        cone(0.26 * s, 0.07 * s, 3.2, 0.03); front(0.1 * s, 2.6, CELL.STAR4, 0.03); light(14, 8); return;
      case 'energy':
        front(0.16 * s, 3.2, CELL.DOT, 0.07);
        { const [fx, fy, fz] = tip(0.03); this.plane(fx, fy, fz, dx, dy, dz, 0.09 * s, color, 3, 0.18, CELL.RING, F_QUAD, 2.4); }
        light(18, 8); return;
      case 'plasma':
        front(0.26 * s, 3.4, CELL.SWIRL, 0.1);
        { const [fx, fy, fz] = tip(0.04); this.plane(fx, fy, fz, dx, dy, dz, 0.12 * s, color, 3, 0.25, CELL.RING, F_QUAD, 2.8); }
        light(24, 10); return;
      case 'rail': {
        front(0.22 * s, 4, CELL.FLARE, 0.12); front(0.14 * s, 4, CELL.STAR4, 0.08);
        const [fx, fy, fz] = tip(0.05);
        for (let r = 0; r < 3; r++) this.plane(fx + dx * r * 0.12, fy + dy * r * 0.12, fz + dz * r * 0.12, dx, dy, dz, 0.07 + r * 0.03, color, 3.4 - r, 0.2 + r * 0.06, CELL.RING, F_QUAD, 3 + r);
        light(40, 14); return;
      }
      case 'beam':
        front(0.1 * s, 2.4, CELL.DOT, 0.05); light(6, 5); return;
      case 'launch': case 'gl': {
        cone(0.3 * s, 0.14 * s, 3.2, 0.06); front(0.22 * s, 2.8, CELL.PETALS);
        puff(style === 'launch' ? 10 : 5, 0.18, 1.4, 0x8a8e96, 0.42); light(30, 12);
        if (rear) {
          // contragolpe del lanzacohetes: fogonazo y humo para ATRÁS
          const [rx, ry, rz] = rear;
          this.segment(rx, ry, rz, rx - dx * 0.6, ry - dy * 0.6, rz - dz * 0.6, 0.3 * s, color, 3, 0.08, CELL.CONE, F_FLASH);
          for (let i = 0; i < 12; i++) this.mote(rx, ry, rz, -dx * (3 + R() * 4) + (R() - 0.5) * 2, 0.4 + R(), -dz * (3 + R() * 4) + (R() - 0.5) * 2, 0.2, 0x9a9ea6, 1, 1.4 + R(), { batch: this.smoke, fade: F_SMOKE, cell: CELL.PUFF, drag: 2.4, grow: 1.2, alpha: 0.4 });
        }
        return;
      }
      default:  // 'std'
        cone(0.26 * s, 0.085 * s, 3.4, 0.045); front(0.12 * s, 3.0, R() < 0.5 ? CELL.STAR4 : CELL.PETALS, 0.04); light(20, 10); return;
    }
  }

  _muzzleSparks(x, y, z, dx, dy, dz, n, color, speedMul = 1) {
    for (let i = 0; i < n; i++) {
      const sp = (4 + this._r() * 10) * speedMul;
      this.spark(x + dx * 0.1, y + dy * 0.1, z + dz * 0.1, (dx + (this._r() - 0.5) * 0.6) * sp, (dy + (this._r() - 0.5) * 0.5) * sp + 1, (dz + (this._r() - 0.5) * 0.6) * sp,
        0.01, color, 2.6, 0.12 + this._r() * 0.2, 0.02, 10, 1.6);
    }
  }

  // ── rayos ─────────────────────────────────────────────────────────────────
  /** Rayo instantáneo con núcleo blanco y halo del color del arma. */
  beam(x0, y0, z0, x1, y1, z1, color, width = 0.02, life = 0.09) {
    this.segment(x0, y0, z0, x1, y1, z1, width * 3.2, color, 1.4, life * 1.3, CELL.BEAM, F_QUAD);
    this.segment(x0, y0, z0, x1, y1, z1, width, '#ffffff', 2.4, life, CELL.BOLT, F_QUAD);
    this.segment(x0, y0, z0, x1, y1, z1, width * 1.4, color, 2.6, life, CELL.BEAM, F_QUAD);
  }

  /** Riel: núcleo que dura y una espiral de chispitas que se abre (el clásico). */
  rail(x0, y0, z0, x1, y1, z1, color, width = 0.03) {
    this.segment(x0, y0, z0, x1, y1, z1, width * 4, color, 1.2, 0.5, CELL.BEAM, F_QUAD);
    this.segment(x0, y0, z0, x1, y1, z1, width, '#ffffff', 3.2, 0.3, CELL.BOLT, F_QUAD);
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, L = Math.hypot(dx, dy, dz);
    if (L < 1e-3) return;
    const ux = dx / L, uy = dy / L, uz = dz / L;
    // base perpendicular
    let px = -uz, py = 0, pz = ux; const pl = Math.hypot(px, pz) || 1; px /= pl; pz /= pl;
    const qx = uy * pz - uz * py, qy = uz * px - ux * pz, qz = ux * py - uy * px;
    const turns = 2.4, step = 0.07, R0 = 0.07;
    const n = Math.min(900, Math.floor(L / step));
    for (let i = 0; i < n; i++) {
      const s = i * step, a = s * turns * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      const ox = (px * c + qx * sn) * R0, oy = (py * c + qy * sn) * R0, oz = (pz * c + qz * sn) * R0;
      const i2 = this.mote(x0 + ux * s + ox, y0 + uy * s + oy, z0 + uz * s + oz, ox * 2.2, oy * 2.2 + 0.1, oz * 2.2, 0.035, color, 2.4, 0.5 + (i / n) * 0.35, { drag: 2.5, fade: F_QUAD, grow: 0.6 });
      void i2;
    }
  }

  /**
   * Relámpago de `a` a `b`: una polilínea quebrada con desvíos
   * perpendiculares que se achican hacia las puntas; núcleo blanco y halo.
   */
  arc(ax, ay, az, bx, by, bz, color, width = 0.02, life = 0.12) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, L = Math.hypot(dx, dy, dz);
    if (L < 1e-3) return;
    const n = Math.max(4, Math.min(16, Math.round(L / 0.35)));
    let px = -dz, py = 0, pz = dx; const pl = Math.hypot(px, pz) || 1; px /= pl; pz /= pl;
    let lx = ax, ly = ay, lz = az;
    for (let i = 1; i <= n; i++) {
      const t = i / n, env = Math.sin(t * Math.PI);
      const off = (this._r() - 0.5) * L * 0.16 * env, offY = (this._r() - 0.5) * L * 0.1 * env;
      const x = ax + dx * t + px * off, y = ay + dy * t + offY, z = az + dz * t + pz * off;
      this.segment(lx, ly, lz, x, y, z, width * 3.5, color, 1.6, life * 1.2, CELL.BEAM, F_QUAD);
      this.segment(lx, ly, lz, x, y, z, width, '#ffffff', 2.8, life, CELL.BOLT, F_QUAD);
      // ramitas
      if (this._r() < 0.25 && i < n) {
        const bl = L * 0.15 * (0.5 + this._r());
        this.segment(x, y, z, x + (this._r() - 0.5) * bl, y + (this._r() - 0.3) * bl * 0.6, z + (this._r() - 0.5) * bl, width * 0.6, color, 2, life * 0.8, CELL.BOLT, F_QUAD);
      }
      lx = x; ly = y; lz = z;
    }
    this.billboard(bx, by, bz, 0.18, color, 2.4, life * 1.4, CELL.STAR6, F_FLASH, this._r() * 6.28);
  }

  // ── impactos ──────────────────────────────────────────────────────────────
  /** Chispas en abanico alrededor de la normal (bala contra pared, metal). */
  sparks(x, y, z, nx, ny, nz, n = 8, color = '#ffc070', speed = 1) {
    for (let i = 0; i < n; i++) {
      const sp = (2.5 + this._r() * 9) * speed;
      this.spark(x + nx * 0.02, y + ny * 0.02, z + nz * 0.02,
        (nx + (this._r() - 0.5) * 1.4) * sp, (ny + (this._r() - 0.5) * 1.2) * sp + 1.2, (nz + (this._r() - 0.5) * 1.4) * sp,
        0.008 + this._r() * 0.006, color, 2.6, 0.1 + this._r() * 0.25);
    }
  }
  /** Destello de impacto de energía: estrella + marca que brilla y se enfría. */
  impactGlow(x, y, z, nx, ny, nz, color, size = 0.2) {
    this.billboard(x + nx * 0.03, y + ny * 0.03, z + nz * 0.03, size, color, 3, 0.08, CELL.STAR4, F_FLASH, this._r() * 6.28);
    this.plane(x, y, z, nx, ny, nz, size * 0.8, color, 1.6, 0.9, CELL.EMBER_RING, F_QUAD, 0.3, this._r() * 6.28);
    this.billboard(x + nx * 0.03, y + ny * 0.03, z + nz * 0.03, size * 0.6, color, 2, 0.25, CELL.DOT, F_QUAD);
  }

  /**
   * Explosión: destello, bola de fuego en capas, anillo de onda rasante,
   * esquirlas, brasas y humo que sube. `radius` en metros.
   */
  explosion(x, y, z, radius = 3, color = '#ffb35a', kind = 'fire') {
    const R = () => this._r(), s = radius / 3;
    const y0 = Math.max(0.15, y);
    if (kind === 'ion' || kind === 'plasma' || kind === 'vortex') {
      this.billboard(x, y0, z, 1.6 * s, color, 3.2, 0.12, CELL.STAR6, F_FLASH, R() * 6.28);
      this.billboard(x, y0, z, 1.1 * s, color, 2.2, 0.5, CELL.SWIRL, F_QUAD, R() * 6.28, 1.2);
      this.plane(x, 0.03, z, 0, 1, 0, 0.4 * s, color, 2.4, 0.5, CELL.RING, F_QUAD, 3.2);
      for (let i = 0; i < 24; i++) { const a = R() * 6.28, e = R() * 0.9, sp = 3 + R() * 7; this.spark(x, y0, z, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 1, Math.sin(a) * Math.cos(e) * sp, 0.012, color, 2.6, 0.2 + R() * 0.3); }
      if (this.light) this.light(x, y0 + 0.4, z, color, 90 * s, 14 * s);
      return;
    }
    // destello blanco
    this.billboard(x, y0 + 0.2, z, 1.4 * s, '#fff4dc', 4, 0.07, CELL.STAR6, F_FLASH, R() * 6.28);
    // bola de fuego: varias bocanadas brillantes que crecen y se enfrían
    for (let i = 0; i < 14; i++) {
      const a = R() * 6.28, r = R() * 0.5 * s;
      this.mote(x + Math.cos(a) * r, y0 + R() * 0.4 * s, z + Math.sin(a) * r, Math.cos(a) * (1 + R() * 2) * s, (0.8 + R() * 2.2) * s, Math.sin(a) * (1 + R() * 2) * s,
        (0.35 + R() * 0.4) * s, color, 2.6, 0.45 + R() * 0.35, { cell: R() < 0.5 ? CELL.PUFF : CELL.DOT, fade: F_FIRE, drag: 3, grow: 1.3, rotV: (R() - 0.5) * 3 });
    }
    // anillo de onda que barre el piso
    this.plane(x, 0.03, z, 0, 1, 0, 0.5 * s, '#ffe2b8', 2.2, 0.35, CELL.RING, F_QUAD, 4.2);
    this.plane(x, 0.02, z, 0, 1, 0, 0.9 * s, color, 1.2, 1.6, CELL.EMBER_RING, F_QUAD, 0.25, R() * 6.28);
    // esquirlas y brasas
    for (let i = 0; i < 34; i++) {
      const a = R() * 6.28, e = R() * 1.2, sp = (5 + R() * 13) * Math.min(1.6, s);
      this.spark(x, y0, z, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 2, Math.sin(a) * Math.cos(e) * sp, 0.014, '#ffb45c', 2.6, 0.35 + R() * 0.5, 0.03, 16, 1.2);
    }
    for (let i = 0; i < 16; i++) this.mote(x + (R() - 0.5) * s, y0 + R() * s, z + (R() - 0.5) * s, (R() - 0.5) * 3, 1.5 + R() * 3, (R() - 0.5) * 3, 0.03, '#ff9a4a', 2.4, 1.2 + R() * 1.2, { drag: 1.2, grav: 3.5, fade: F_QUAD });
    // humo: columna oscura que sube y se abre
    for (let i = 0; i < 16; i++) {
      const a = R() * 6.28, r = R() * 0.8 * s;
      this.mote(x + Math.cos(a) * r, y0 + R() * 0.5, z + Math.sin(a) * r, Math.cos(a) * 0.8, 0.8 + R() * 1.4, Math.sin(a) * 0.8, (0.45 + R() * 0.4) * s, R() < 0.5 ? 0x26272b : 0x3a3b40, 1, 2.2 + R() * 1.6,
        { batch: this.smoke, fade: F_SMOKE, cell: CELL.PUFF, drag: 0.9, grow: 0.55, alpha: 0.62, rotV: (R() - 0.5) * 1.2 });
    }
    if (this.light) this.light(x, y0 + 0.6, z, color, 140 * s, 16 * s);
  }

  /** Anillo que avanza (onda sónica): plano perpendicular a la dirección, se agranda y se va. */
  shockRing(x, y, z, dx, dy, dz, color, speed = 9, size = 0.3) {
    const B = this.glow, i = B.spawn(K_MOVE, MODE_PLANE, CELL.RING, F_QUAD, 0.55);
    B.setP(i, x, y, z); B.setQ(i, dx, dy, dz); B.setV(i, dx * speed, dy * speed, dz * speed);
    B.w[i] = size; B.h[i] = size; B.gw[i] = 3.2; B.gh[i] = 3.2; B.drag[i] = 1.2;
    const [r, g, b] = this._rgb(color, 2.2); B.setColor(i, r, g, b, 1);
  }

  /** Llamas (lanzallamas): lenguas que nacen chicas y blancas y se vuelven rojas. */
  flame(x, y, z, vx, vy, vz, life = 0.55, size = 0.08) {
    this.mote(x, y, z, vx, vy, vz, size, '#fff0c8', 2.2, life, { cell: this._r() < 0.5 ? CELL.TONGUE : CELL.PUFF, fade: F_FIRE, drag: 2.2, grow: 2.6, rotV: (this._r() - 0.5) * 4 });
  }
  /** Niebla criogénica y cristalitos. */
  frost(x, y, z, vx, vy, vz, life = 0.6, size = 0.08) {
    this.mote(x, y, z, vx, vy, vz, size, '#bfe8ff', 1.2, life, { cell: CELL.PUFF, fade: F_QUAD, drag: 2.4, grow: 2.4, alpha: 0.8 });
    if (this._r() < 0.3) this.mote(x, y, z, vx * 0.8, vy * 0.8, vz * 0.8, 0.03, '#e8f7ff', 2.4, life * 0.8, { cell: CELL.CRYSTAL, drag: 2, rotV: 3 });
  }
  /** Burbujas y humito verde (ácido). */
  bubble(x, y, z, size = 0.04, color = '#b5f25a') {
    this.mote(x, y, z, (this._r() - 0.5) * 0.3, 0.3 + this._r() * 0.4, (this._r() - 0.5) * 0.3, size, color, 1.8, 0.6 + this._r() * 0.5, { cell: CELL.BUBBLE, drag: 1.5, grow: 0.4 });
  }
  /** Humo suelto (caños calientes, estelas). */
  puff(x, y, z, vx, vy, vz, size, life = 1.4, color = 0x8a8e96, alpha = 0.4) {
    this.mote(x, y, z, vx, vy, vz, size, color, 1, life, { batch: this.smoke, fade: F_SMOKE, cell: CELL.PUFF, drag: 1.4, grow: 1.0, alpha, rotV: (this._r() - 0.5) * 1.5 });
  }

  // ── proyectiles ───────────────────────────────────────────────────────────
  /**
   * Dibuja los proyectiles vivos de la balística (lista de objetos con
   * look, x y z, vx vy vz, spin, stuck). Una matriz por instancia. O(n).
   */
  drawProjectiles(list) {
    for (const k in this.proj) this.proj[k].n = 0;
    const m = this._m, q = this._q, v = this._v, d = this._d, sc = this._s;
    for (const p of list) {
      if (!p.alive || p.hidden) continue;
      const P = this.proj[p.look];
      if (!P || P.n >= P.cap) continue;
      const sp = Math.hypot(p.vx, p.vy, p.vz);
      if (sp > 1e-3 && !p.stuck) d.set(p.vx / sp, p.vy / sp, p.vz / sp); else d.set(p.fx ?? 0, p.fy ?? 0, p.fz ?? 1);
      q.setFromUnitVectors(this._z, d);
      if (p.spin) q.multiply(this._qs.setFromAxisAngle(this.looks[p.look].flat ? this._ax.set(0, 1, 0) : this._ax.set(0, 0, 1), p.spin));
      const s = p.size || 1;
      m.compose(v.set(p.x, p.y, p.z), q, sc.set(s, s, s));
      P.mesh.setMatrixAt(P.n, m);
      if (P.tip) P.tip.setMatrixAt(P.n, m);
      P.n++;
    }
    for (const k in this.proj) {
      const P = this.proj[k];
      P.mesh.count = P.n; P.mesh.visible = P.n > 0;
      if (P.n) P.mesh.instanceMatrix.needsUpdate = true;
      if (P.tip) { P.tip.count = P.n; P.tip.visible = P.n > 0; if (P.n) P.tip.instanceMatrix.needsUpdate = true; }
    }
  }

  update(dt) { this.glow.update(dt); this.smoke.update(dt); }
  clear() { this.glow.clear(); this.smoke.clear(); for (const k in this.proj) { this.proj[k].mesh.count = 0; this.proj[k].mesh.visible = false; if (this.proj[k].tip) { this.proj[k].tip.count = 0; this.proj[k].tip.visible = false; } } }
  get live() { return this.glow.n + this.smoke.n; }
}

export const FADE = Object.freeze({ LINEAR: F_LINEAR, QUAD: F_QUAD, FLASH: F_FLASH, FIRE: F_FIRE, HOLD: F_HOLD, SMOKE: F_SMOKE });
