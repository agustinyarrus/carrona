// ─────────────────────────────────────────────────────────────────────────────
//  gunsmith.js — El armero: arma los modelos de las 104 armas a partir de
//  piezas paramétricas. Cero archivos: cada arma es una lista de piezas
//  (cajas biseladas, perfiles laterales extruidos, tubos, tornos, toros)
//  generada por el constructor de su familia con los parámetros del catálogo.
//
//  Convención (la misma de siempre): +Z hacia el caño, +Y arriba, origen en
//  la empuñadura, donde va la mano derecha. Metros.
//
//  Cómo se ve lindo y cuesta poco:
//   · Biseles: los cantos cortados agarran la luz (el look low poly bueno).
//   · La silueta la da el PERFIL lateral de cada pieza (culatas, empuñaduras,
//     cajones, cargadores curvos): un polígono 2D extruido con bisel.
//   · Los UV se calculan DESPUÉS de juntar todo, por proyección de caja en el
//     espacio del modelo y en metros: el camuflaje y la veta corren continuos
//     de una pieza a la otra, y la textura tiene la misma escala en todas.
//   · Todas las piezas de un mismo material se funden en UNA malla: un arma
//     es de 3 a 8 draw calls sin importar cuántas piezas tenga.
//   · Las partes que se mueven (corredera, tambor, cañones rotativos, cerrojo)
//     quedan en su propio grupo para animarlas al disparar.
//
//  El modelo se construye una vez por arma (caché) y se clona para cada uso:
//  los clones comparten geometría y materiales.
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { finishMaterial, parseFinish } from './finishes.js';
import { makeRng } from '../core/util.js';

const HALF_PI = Math.PI / 2;

// ═════════════════════════════════════════════════════════════════════════════
//  Primitivas (todas terminan no indexadas, con normales)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Caja con los 12 cantos biselados: la envolvente convexa de 24 puntos (tres
 * por esquina). 6 caras + 12 biseles + 8 triángulos de esquina = 44
 * triángulos. Las normales son de cara (plano), que es lo que hace brillar
 * el bisel.
 */
function chamferBox(w, h, d, c) {
  const hx = w / 2, hy = h / 2, hz = d / 2;
  c = Math.min(c, hx * 0.49, hy * 0.49, hz * 0.49);
  if (c < 1e-5) return new THREE.BoxGeometry(w, h, d).toNonIndexed();
  const X = (sx, sy, sz) => [sx * hx, sy * (hy - c), sz * (hz - c)];
  const Y = (sx, sy, sz) => [sx * (hx - c), sy * hy, sz * (hz - c)];
  const Z = (sx, sy, sz) => [sx * (hx - c), sy * (hy - c), sz * hz];
  const polys = [];
  const S = [-1, 1];
  for (const s of S) {
    polys.push([X(s, -1, -1), X(s, 1, -1), X(s, 1, 1), X(s, -1, 1)]);
    polys.push([Y(-1, s, -1), Y(1, s, -1), Y(1, s, 1), Y(-1, s, 1)]);
    polys.push([Z(-1, -1, s), Z(1, -1, s), Z(1, 1, s), Z(-1, 1, s)]);
  }
  for (const a of S) for (const b of S) {
    polys.push([X(a, b, -1), X(a, b, 1), Y(a, b, 1), Y(a, b, -1)]);    // canto a lo largo de Z
    polys.push([X(a, -1, b), X(a, 1, b), Z(a, 1, b), Z(a, -1, b)]);    // canto a lo largo de Y
    polys.push([Y(-1, a, b), Y(1, a, b), Z(1, a, b), Z(-1, a, b)]);    // canto a lo largo de X
  }
  for (const sx of S) for (const sy of S) for (const sz of S) polys.push([X(sx, sy, sz), Y(sx, sy, sz), Z(sx, sy, sz)]);
  return convexPolysToGeometry(polys);
}

/** Polígonos convexos alrededor del origen → triángulos con la cara hacia afuera. */
function convexPolysToGeometry(polys) {
  let nt = 0;
  for (const p of polys) nt += p.length - 2;
  const pos = new Float32Array(nt * 9);
  let k = 0;
  for (const p of polys) {
    const a = p[0], b = p[1], c = p[2];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    let cx = 0, cy = 0, cz = 0;
    for (const q of p) { cx += q[0]; cy += q[1]; cz += q[2]; }
    const flip = nx * cx + ny * cy + nz * cz < 0;
    for (let i = 1; i < p.length - 1; i++) {
      const tri = flip ? [p[0], p[i + 1], p[i]] : [p[0], p[i], p[i + 1]];
      for (const q of tri) { pos[k++] = q[0]; pos[k++] = q[1]; pos[k++] = q[2]; }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * Perfil lateral extruido: `pts` son [z, y] (el costado del arma) y el
 * espesor va en X, centrado. Bisel `b` en los bordes de las tapas, con el
 * contorno exterior EXACTO en el medio (bevelOffset = −b). Admite agujeros.
 */
function profileGeometry(pts, t, b, holes) {
  const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  if (holes) for (const h of holes) shape.holes.push(new THREE.Path(h.map(([z, y]) => new THREE.Vector2(z, y))));
  b = Math.min(b, t * 0.3);
  const depth = Math.max(1e-4, t - 2 * b);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, steps: 1, curveSegments: 4,
    bevelEnabled: b > 1e-5, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 1,
  });
  g.translate(0, 0, -depth / 2);
  g.rotateY(-HALF_PI);          // x del perfil → Z del arma; extrusión → X
  return g.index ? g.toNonIndexed() : g;
}

/** Tubo a lo largo de Z (r1 atrás, r2 adelante). Lados suaves por defecto; tapas planas. */
function tubeGeometry(r1, r2, len, seg, open, smooth) {
  const g = new THREE.CylinderGeometry(r2, r1, len, seg, 1, open).rotateX(HALF_PI);
  const n = g.toNonIndexed();
  if (!smooth) n.computeVertexNormals();
  return n;
}

/** Torno alrededor de Z: `pts` = [radio, z] de atrás hacia adelante. */
function latheGeometry(pts, seg, smooth) {
  const g = new THREE.LatheGeometry(pts.map(([r, z]) => new THREE.Vector2(Math.max(1e-4, r), z)), seg).rotateX(HALF_PI);
  const n = g.toNonIndexed();
  if (!smooth) n.computeVertexNormals();
  return n;
}

// ═════════════════════════════════════════════════════════════════════════════
//  El banco de piezas
// ═════════════════════════════════════════════════════════════════════════════

const _m = new THREE.Matrix4(), _e = new THREE.Euler(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);

/**
 * Lista de piezas de un arma. Cada método agrega una pieza en coordenadas del
 * modelo: rol de material, dimensiones, posición y rotación (rx, ry, rz).
 * `anim` manda la pieza a un grupo que se anima aparte.
 */
class Rig {
  constructor(seed = 1) {
    this.parts = [];
    this.rng = makeRng(seed >>> 0);
    this.anchor = {
      muzzle: [0, 0.03, 0.2], muzzles: null, eject: [0.02, 0.04, 0.06], fore: 0.14, foreY: 0,
      sight: [0, 0.07, 0.05], rear: [0, 0.03, -0.1], pivot: {},
    };
  }
  _add(role, g, x, y, z, o) {
    _e.set(o.rx || 0, o.ry || 0, o.rz || 0, 'YXZ');
    _q.setFromEuler(_e);
    _m.compose(_p.set(x, y, z), _q, _s.set(o.sx || 1, o.sy || 1, o.sz || 1));
    g.applyMatrix4(_m);
    this.parts.push({ role, g, anim: o.anim || '' });
    return g;
  }
  box(role, w, h, d, x, y, z, o = {}) { return this._add(role, chamferBox(w, h, d, o.c ?? Math.min(w, h, d) * 0.18), x, y, z, o); }
  tube(role, r, len, x, y, z, o = {}) { return this._add(role, tubeGeometry(r, o.r2 ?? r, len, o.seg || 12, !!o.open, o.smooth !== false), x, y, z, o); }
  /**
   * Torno. Con `inner` agrega la cara de adentro (el perfil al revés y un
   * poco más chico, oscuro): una boca acampanada vista de frente no deja ver
   * el fondo a través de las caras traseras.
   */
  lathe(role, pts, x, y, z, o = {}) {
    const g = this._add(role, latheGeometry(pts, o.seg || 14, o.smooth !== false), x, y, z, o);
    if (o.inner) {
      const inside = pts.map(([r, zz]) => [r * (1 - o.inner), zz]).reverse();
      this._add('hole', latheGeometry(inside, o.seg || 14, true), x, y, z, { ...o, inner: 0 });
    }
    return g;
  }
  prof(role, pts, t, x, y, z, o = {}) { return this._add(role, profileGeometry(pts, t, o.b ?? t * 0.14, o.holes), x, y, z, o); }
  ring(role, R, r, x, y, z, o = {}) { return this._add(role, new THREE.TorusGeometry(R, r, o.rs || 6, o.ts || 16).toNonIndexed(), x, y, z, o); }
  ball(role, r, x, y, z, o = {}) { return this._add(role, new THREE.IcosahedronGeometry(r, o.detail ?? 1), x, y, z, o); }   // el icosaedro de three ya viene sin índice
}

// ═════════════════════════════════════════════════════════════════════════════
//  Piezas compuestas (las usan varias familias: nada se copia)
// ═════════════════════════════════════════════════════════════════════════════

/** Empuñadura de pistola inclinada hacia atrás; `L` largo, `a` inclinación, `w` profundidad. */
function grip(R, role, L = 0.095, a = 0.26, w = 0.034, t = 0.03, z0 = 0, y0 = 0.004) {
  const k = Math.tan(a);
  const pts = [
    [w * 0.55, 0], [-w * 0.45, 0],
    [-w * 0.52 - k * L * 0.5 - 0.004, -L * 0.52],
    [-w * 0.44 - k * L, -L], [w * 0.42 - k * L, -L],
    [w * 0.5 - k * L * 0.45, -L * 0.55],
    [w * 0.56 - k * L * 0.2, -L * 0.2],
  ];
  R.prof(role, pts, t, 0, y0, z0, { b: 0.005 });
}

/** Guardamonte: un aro de perfil (contorno con agujero). */
function triggerGuard(R, role, z0 = 0.012, len = 0.05, depth = 0.028, t = 0.009) {
  const outer = [[z0 + len, 0.002], [z0 + len, -depth * 0.55], [z0 + len * 0.72, -depth], [z0, -depth], [z0, 0.002]];
  const hole = [[z0 + len - 0.006, -0.004], [z0 + len - 0.006, -depth * 0.52], [z0 + len * 0.7, -depth + 0.006], [z0 + 0.006, -depth + 0.006], [z0 + 0.006, -0.004]];
  R.prof(role, outer, t, 0, 0, 0, { b: 0.0015, holes: [hole] });
  R.box('dark', 0.004, 0.018, 0.006, 0, -0.01, z0 + len * 0.42, { rx: -0.25 });    // cola del disparador
}

/** Riel picatinny: base y dientes (cada 12 mm). */
function rail(R, len, y, z, x = 0, role = 'rail', rz = 0) {
  R.box(role, 0.021, 0.006, len, x, y, z, { c: 0.0015, rz });
  const n = Math.max(2, Math.floor(len / 0.012));
  for (let i = 0; i < n; i++) {
    const zz = z - len / 2 + (i + 0.5) * (len / n);
    R.box(role, 0.023, 0.005, 0.0065, x + Math.sin(rz) * -0.005, y + 0.005 * Math.cos(rz), zz, { c: 0.001, rz });
  }
}

/**
 * Mira según el tipo. Deja el ancla de la mira (para el láser y el reflejo).
 *  iron · dot · holo · scope · longscope · carry · none
 */
function sight(R, kind, yTop, zRear, zFront, P = {}) {
  const zc = (zRear + zFront) / 2;
  switch (kind) {
    case 'iron': {
      R.box('dark', 0.012, 0.012, 0.012, 0, yTop + 0.006, zRear + 0.01);
      R.box('dark', 0.004, 0.014, 0.006, 0, yTop + 0.007, zFront - 0.005);
      R.ball('glow', 0.0022, 0, yTop + 0.015, zFront - 0.005, { detail: 0 });
      break;
    }
    case 'dot': {
      R.box('dark', 0.022, 0.008, 0.04, 0, yTop + 0.004, zc);
      R.tube('body2', 0.013, 0.036, 0, yTop + 0.022, zc, { seg: 14 });
      R.tube('dark', 0.0145, 0.006, 0, yTop + 0.022, zc + 0.018, { seg: 14 });
      R.tube('lens', 0.0115, 0.002, 0, yTop + 0.022, zc + 0.019, { seg: 14 });
      R.ball('glow', 0.0016, 0, yTop + 0.022, zc - 0.002, { detail: 0 });
      break;
    }
    case 'holo': {
      R.box('dark', 0.03, 0.01, 0.07, 0, yTop + 0.005, zc);
      const w = [[zc - 0.028, 0.0], [zc + 0.03, 0.0], [zc + 0.03, 0.035], [zc - 0.028, 0.035]];
      const hole = [[zc - 0.02, 0.007], [zc + 0.022, 0.007], [zc + 0.022, 0.029], [zc - 0.02, 0.029]];
      R.prof('body2', w, 0.03, 0, yTop + 0.008, 0, { b: 0.002, holes: [hole] });
      R.box('lens', 0.024, 0.02, 0.002, 0, yTop + 0.026, zc + 0.01, { c: 0.0005 });
      R.ring('glow', 0.0035, 0.0006, 0, yTop + 0.026, zc + 0.008, { rs: 3, ts: 10 });
      break;
    }
    case 'scope': case 'longscope': {
      const L = kind === 'longscope' ? (P.scopeLen || 0.34) : (P.scopeLen || 0.24);
      const r = kind === 'longscope' ? 0.019 : 0.016, big = r * 1.55;
      const y = yTop + 0.032;
      R.lathe('body2', [[r * 1.2, -L / 2], [r * 1.35, -L / 2 + 0.012], [r, -L / 2 + 0.05], [r, L / 2 - 0.07], [big, L / 2 - 0.02], [big, L / 2]], 0, y, zc, { seg: 18 });
      R.tube('lens', big * 0.86, 0.002, 0, y, zc + L / 2 + 0.001, { seg: 18 });
      R.tube('lens', r * 1.05, 0.002, 0, y, zc - L / 2 - 0.001, { seg: 16 });
      R.tube('dark', 0.009, 0.014, 0, y + r + 0.006, zc, { rx: HALF_PI, seg: 10 });            // torreta de altura
      R.tube('dark', 0.008, 0.012, r + 0.005, y, zc, { ry: HALF_PI, rx: 0, rz: 0, seg: 10 });  // torreta lateral
      for (const dz of [-L * 0.22, L * 0.18]) {
        R.box('dark', 0.03, 0.03, 0.012, 0, yTop + 0.012, zc + dz, { c: 0.003 });
        R.ring('dark', r + 0.002, 0.0035, 0, y, zc + dz, { rs: 4, ts: 14 });
      }
      break;
    }
    case 'carry': {
      const pts = [[zRear, 0], [zRear, 0.045], [zRear + 0.11, 0.045], [zRear + 0.13, 0.0]];
      const hole = [[zRear + 0.014, 0.006], [zRear + 0.1, 0.006], [zRear + 0.1, 0.03], [zRear + 0.014, 0.03]];
      R.prof('body', pts, 0.02, 0, yTop, 0, { b: 0.003, holes: [hole] });
      R.box('dark', 0.012, 0.014, 0.016, 0, yTop + 0.05, zRear + 0.02);
      R.prof('dark', [[zFront - 0.02, 0], [zFront, 0], [zFront - 0.004, 0.05], [zFront - 0.014, 0.05]], 0.014, 0, yTop - 0.004, 0, { b: 0.002 });
      R.ball('glow', 0.0022, 0, yTop + 0.05, zFront - 0.009, { detail: 0 });
      break;
    }
    default: break;
  }
  R.anchor.sight = [0, yTop + 0.02, zc];
}

/** Dispositivo de boca: hider · brake · comp · sup · bigbrake · flute · none. Devuelve la nueva z de la boca. */
function muzzleDevice(R, kind, y, z, r = 0.012, P = {}) {
  switch (kind) {
    case 'hider': {
      R.tube('dark', r * 1.15, 0.045, 0, y, z + 0.0225, { seg: 10 });
      for (let i = 0; i < 4; i++) {
        const a = i * HALF_PI + Math.PI / 4;
        R.box('dark', 0.004, 0.004, 0.018, Math.cos(a) * r * 1.1, y + Math.sin(a) * r * 1.1, z + 0.054, { c: 0.001 });
      }
      return z + 0.062;
    }
    case 'brake': {
      R.box('dark', r * 2.9, r * 2.5, 0.055, 0, y, z + 0.0275, { c: 0.003 });
      for (const s of [-1, 1]) for (let i = 0; i < 3; i++) R.box('hole', 0.003, r * 1.5, 0.008, s * r * 1.46, y, z + 0.012 + i * 0.014, { c: 0.0006 });
      return z + 0.056;
    }
    case 'bigbrake': {
      R.box('dark', r * 3.6, r * 2.6, 0.1, 0, y, z + 0.05, { c: 0.004 });
      for (const s of [-1, 1]) for (let i = 0; i < 2; i++) R.box('hole', 0.003, r * 1.9, 0.026, s * r * 1.81, y, z + 0.025 + i * 0.045, { c: 0.001 });
      return z + 0.101;
    }
    case 'comp': {
      R.box('dark', r * 2.3, r * 2.3, 0.03, 0, y, z + 0.015, { c: 0.003 });
      for (let i = 0; i < 3; i++) R.box('hole', r * 1.1, 0.003, 0.005, 0, y + r * 1.16, z + 0.007 + i * 0.008, { c: 0.0005 });
      return z + 0.031;
    }
    case 'sup': {
      const L = P.supLen || 0.16, rr = P.supR || r * 1.8;
      R.tube('sup', rr, L, 0, y, z + L / 2, { seg: 16 });
      R.tube('knurl', rr * 1.04, 0.022, 0, y, z + 0.011, { seg: 16 });
      R.tube('dark', rr * 1.01, 0.006, 0, y, z + L - 0.003, { seg: 16 });
      return z + L;
    }
    case 'flute': {
      R.tube('metal', r * 1.3, 0.04, 0, y, z + 0.02, { seg: 8, smooth: false });
      return z + 0.04;
    }
    default: return z;
  }
}

/**
 * Cargador. kind: box · curved · drum · pan · tube · pistol · side · belt · cell · quad.
 * (z, y) es el punto de encastre debajo del cajón. Devuelve {bottom}.
 */
function magazine(R, kind, z, y, P = {}) {
  const len = P.magLen || 0.13, d = P.magD || 0.034, t = P.magT || 0.024, rake = P.magRake ?? 0.12;
  switch (kind) {
    case 'box': {
      const k = Math.tan(rake);
      R.prof('mag', [[z + d / 2, 0], [z - d / 2, 0], [z - d / 2 - k * len, -len], [z + d / 2 - k * len, -len]], t, 0, y, 0, { b: 0.003 });
      R.box('dark', t + 0.004, 0.008, d + 0.004, 0, y - len - 0.002, z - k * len, { c: 0.002 });
      return { bottom: y - len };
    }
    case 'quad': {
      const k = Math.tan(rake);
      R.prof('mag', [[z + d / 2, 0], [z - d / 2, 0], [z - d / 2 - k * len, -len], [z + d / 2 - k * len, -len]], t * 1.5, 0, y, 0, { b: 0.004 });
      R.box('dark', t * 1.5 + 0.004, 0.01, d + 0.006, 0, y - len - 0.003, z - k * len, { c: 0.002 });
      return { bottom: y - len };
    }
    case 'curved': {
      // banana: la línea media baja y se curva hacia adelante; frente y lomo a ±d/2 de la normal
      const N = 7, curve = P.magCurve ?? 0.9, front = [], back = [];
      for (let i = 0; i <= N; i++) {
        const s = i / N, ang = s * curve * (len / 0.2) * 0.55;
        const cz = z + Math.sin(ang) * len * 0.62 * s - rake * s * len * 0.2, cy = -len * s * (1 - s * 0.08);
        const nz = Math.cos(ang), ny = Math.sin(ang);
        front.push([cz + nz * d / 2, cy + ny * d / 2]);
        back.push([cz - nz * d / 2, cy - ny * d / 2]);
      }
      R.prof('mag', [...front, ...back.reverse()], t, 0, y, 0, { b: 0.003 });
      return { bottom: y - len };
    }
    case 'drum': {
      const r = P.drumR || 0.058;
      R.box('mag', t, 0.04, d, 0, y - 0.02, z, { c: 0.003 });
      R.tube('mag', r, t * 2.1, 0, y - 0.04 - r * 0.8, z - 0.01, { ry: HALF_PI, seg: 18 });
      R.tube('dark', r * 0.35, t * 2.3, 0, y - 0.04 - r * 0.8, z - 0.01, { ry: HALF_PI, seg: 12 });
      return { bottom: y - 0.04 - r * 1.8 };
    }
    case 'twindrum': {
      const r = P.drumR || 0.05;
      R.box('mag', t, 0.03, d, 0, y - 0.015, z, { c: 0.003 });
      for (const s of [-1, 1]) R.tube('mag', r, 0.03, s * 0.032, y - 0.03 - r * 0.7, z, { ry: HALF_PI, seg: 16 });
      return { bottom: y - 0.03 - r * 1.7 };
    }
    case 'pan': {
      // plato arriba del cajón (Lewis, DP): eje vertical, rayos que se ven desde la cámara cenital
      const r = P.panR || 0.11, yy = y;
      R.tube('mag', r, 0.026, 0, yy + 0.013, z, { rx: -HALF_PI, seg: 24 });
      R.tube('dark', r * 0.22, 0.034, 0, yy + 0.017, z, { rx: -HALF_PI, seg: 12 });
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        R.box('dark', 0.004, 0.004, r * 0.7, Math.sin(a) * r * 0.55, yy + 0.028, z + Math.cos(a) * r * 0.55, { ry: a, c: 0.001 });
      }
      return { bottom: y };
    }
    case 'tube': {
      const L2 = P.tubeLen || 0.34;
      R.tube('metal', 0.011, L2, 0, y, z + L2 / 2, { seg: 10 });
      R.tube('dark', 0.012, 0.012, 0, y, z + L2 - 0.006, { seg: 10 });
      return { bottom: y - 0.011 };
    }
    case 'pistol': {
      // el cargador de pistola va dentro de la empuñadura: sólo asoma la base (y el extendido)
      const ext = P.ext || 0;
      const zz = z - Math.tan(P.gripA ?? 0.26) * (P.gripL ?? 0.09);
      R.box('dark', 0.03, 0.008 + ext, 0.036, 0, y - (P.gripL ?? 0.09) - ext / 2, zz, { c: 0.002 });
      return { bottom: y - (P.gripL ?? 0.09) - ext };
    }
    case 'side': {
      const L2 = P.magLen || 0.16;
      R.box('mag', L2, 0.028, 0.034, -L2 / 2 - 0.012, y + 0.02, z, { c: 0.003 });
      return { bottom: y };
    }
    case 'belt': {
      const bw = P.boxW || 0.1;
      R.box('mag', 0.085, 0.1, bw, -0.012, y - 0.05, z - 0.01, { c: 0.006 });
      R.box('dark', 0.087, 0.012, bw * 0.3, -0.012, y - 0.004, z - 0.01, { c: 0.002 });
      for (let i = 0; i < 6; i++) {
        const a = -0.2 + i * 0.12;
        R.tube('brass', 0.0045, 0.03, 0.028 + i * 0.006, y + 0.012 + Math.sin(a) * 0.01, z + 0.02, { ry: HALF_PI, seg: 6 });
      }
      return { bottom: y - 0.1 };
    }
    case 'cell': {
      R.tube('dark', 0.016, 0.06, 0, y - 0.03, z, { rx: HALF_PI, seg: 12 });
      R.tube('glow', 0.012, 0.05, 0, y - 0.03, z, { rx: HALF_PI, seg: 12 });
      return { bottom: y - 0.06 };
    }
    default: return { bottom: y };
  }
}

/**
 * Culata. kind: fixed · tube · skeleton · fold · wood · thumbhole · brace · bullpup · none.
 * `zr` es el fondo del cajón; `yb` la línea de la base del cajón.
 */
function stock(R, kind, zr, yb, P = {}) {
  const L = P.stockLen || 0.24, drop = P.drop ?? 0.02, H = P.stockH || 0.11;
  switch (kind) {
    case 'fixed': {
      const pts = [[zr, yb + 0.05], [zr - L, yb + 0.05 - drop], [zr - L, yb + 0.05 - drop - H], [zr - L * 0.55, yb - 0.035], [zr, yb - 0.015]];
      R.prof('stock', pts, 0.036, 0, 0, 0, { b: 0.005 });
      R.box('rubber', 0.038, H + 0.004, 0.014, 0, yb + 0.05 - drop - H / 2, zr - L - 0.006, { c: 0.004 });
      return zr - L - 0.013;
    }
    case 'tube': {
      R.tube('metal', 0.0145, L * 0.9, 0, yb + 0.03, zr - L * 0.45, { seg: 12 });
      const z0 = zr - L * 0.45;
      const pts = [[z0, yb + 0.055], [zr - L, yb + 0.058], [zr - L, yb - 0.05], [zr - L + 0.03, yb - 0.05], [z0, yb + 0.005]];
      R.prof('stock', pts, 0.034, 0, 0, 0, { b: 0.005 });
      R.box('rubber', 0.036, 0.112, 0.014, 0, yb + 0.004, zr - L - 0.006, { c: 0.004 });
      return zr - L - 0.013;
    }
    case 'skeleton': {
      const outer = [[zr, yb + 0.05], [zr - L, yb + 0.055], [zr - L, yb - 0.06], [zr - L * 0.5, yb - 0.03], [zr, yb - 0.01]];
      const hole = [[zr - 0.03, yb + 0.034], [zr - L + 0.025, yb + 0.037], [zr - L + 0.025, yb - 0.035], [zr - L * 0.5, yb - 0.012], [zr - 0.03, yb + 0.004]];
      R.prof('stock', outer, 0.03, 0, 0, 0, { b: 0.004, holes: [hole] });
      R.box('rubber', 0.032, 0.12, 0.014, 0, yb - 0.003, zr - L - 0.006, { c: 0.004 });
      return zr - L - 0.013;
    }
    case 'fold': {
      // culata plegable de alambre, extendida: dos varillas y una cantonera
      for (const s of [-1, 1]) R.tube('metal', 0.0045, L, s * 0.012, yb + 0.02, zr - L / 2, { seg: 6 });
      R.tube('metal', 0.0045, L * 0.96, 0, yb - 0.035, zr - L / 2, { seg: 6, rx: 0.12 });
      R.box('rubber', 0.034, 0.1, 0.012, 0, yb - 0.01, zr - L, { c: 0.003 });
      return zr - L - 0.006;
    }
    case 'wood': {
      const pts = [[zr + 0.01, yb + 0.02], [zr - 0.04, yb + 0.03], [zr - L, yb + 0.03 - drop], [zr - L, yb + 0.03 - drop - H],
        [zr - L * 0.45, yb - 0.045], [zr - 0.06, yb - 0.06], [zr - 0.02, yb - 0.02]];
      R.prof('stock', pts, 0.04, 0, 0, 0, { b: 0.007 });
      R.box('rubber', 0.041, H, 0.01, 0, yb + 0.03 - drop - H / 2, zr - L - 0.004, { c: 0.003 });
      return zr - L - 0.009;
    }
    case 'thumbhole': {
      const outer = [[zr + 0.02, yb + 0.03], [zr - L, yb + 0.05 - drop], [zr - L, yb - 0.08 - drop], [zr - L * 0.4, yb - 0.1], [zr, yb - 0.02]];
      const hole = [[zr - 0.03, yb - 0.005], [zr - L * 0.34, yb - 0.003], [zr - L * 0.34, yb - 0.06], [zr - 0.05, yb - 0.055]];
      R.prof('stock', outer, 0.04, 0, 0, 0, { b: 0.007, holes: [hole] });
      R.box('rubber', 0.042, 0.13, 0.012, 0, yb - 0.015 - drop, zr - L - 0.005, { c: 0.004 });
      R.box('stock', 0.02, 0.022, L * 0.5, 0, yb + 0.055 - drop * 0.5, zr - L * 0.55, { c: 0.006 });    // carrillera
      return zr - L - 0.011;
    }
    case 'brace': {
      R.tube('metal', 0.012, L * 0.6, 0, yb + 0.03, zr - L * 0.3, { seg: 10 });
      R.box('stock', 0.03, 0.05, L * 0.45, 0, yb + 0.02, zr - L * 0.72, { c: 0.008 });
      return zr - L * 0.95;
    }
    default: return zr;
  }
}

/** Empuñadura delantera: vert · angled · stub. */
function foregrip(R, kind, z, y) {
  if (kind === 'vert') {
    R.tube('grip', 0.012, 0.07, 0, y - 0.035, z, { rx: HALF_PI, seg: 10 });
    R.tube('dark', 0.0135, 0.006, 0, y - 0.072, z, { rx: HALF_PI, seg: 10 });
  } else if (kind === 'angled') {
    R.prof('grip', [[z + 0.03, 0], [z - 0.03, 0], [z + 0.012, -0.034], [z + 0.03, -0.034]], 0.022, 0, y, 0, { b: 0.004 });
  } else if (kind === 'stub') {
    R.box('grip', 0.022, 0.028, 0.03, 0, y - 0.014, z, { c: 0.006 });
  }
}

/** Bípode plegado debajo del guardamanos. */
function bipod(R, z, y) {
  R.box('dark', 0.03, 0.012, 0.02, 0, y - 0.006, z);
  for (const s of [-1, 1]) R.tube('metal', 0.004, 0.17, s * 0.012, y - 0.014, z - 0.085, { seg: 6, rx: 0.06 });
  for (const s of [-1, 1]) R.box('rubber', 0.008, 0.008, 0.012, s * 0.012, y - 0.024, z - 0.172);
}

/** Láser táctico al costado del guardamanos, con el punto emisor. */
function laser(R, z, y, x = 0.022) {
  R.box('dark', 0.016, 0.018, 0.045, x, y, z, { c: 0.003 });
  R.tube('glow', 0.004, 0.002, x, y + 0.003, z + 0.0235, { seg: 8 });
}

// ═════════════════════════════════════════════════════════════════════════════
//  Constructores por familia
//
//  Cada uno recibe P (parámetros del catálogo con los defaults de la familia
//  ya mezclados) y un Rig. Dejan las anclas: boca(s), expulsión, mano
//  izquierda (fore: cuánto adelante de la derecha), mira, parte de atrás.
// ═════════════════════════════════════════════════════════════════════════════

export const BUILDERS = {
  // ── pistola semiautomática ────────────────────────────────────────────────
  pistol(R, P) {
    const L = P.len ?? 0.19, sh = P.sh ?? 0.032, sw = P.sw ?? 0.028, y = 0.028 + sh / 2 - 0.004;
    const zF = 0.155 * (L / 0.19), zB = zF - L;
    // corredera (se anima: retrocede al disparar)
    R.box('body2', sw, sh, L, 0, y, (zF + zB) / 2, { c: 0.0035, anim: 'slide' });
    if (P.cuts) for (let i = 0; i < 3; i++) R.box('hole', sw * 0.5, 0.003, 0.014, 0, y + sh / 2 - 0.0005, zF - 0.035 - i * 0.022, { c: 0.0008, anim: 'slide' });
    for (let i = 0; i < 6; i++) R.box('dark', 0.0015, sh * 0.7, 0.003, sw / 2, y - 0.002, zB + 0.012 + i * 0.006, { c: 0.0004, anim: 'slide' });   // estrías
    R.box('hole', 0.003, 0.012, 0.03, sw / 2, y + 0.002, zF - L * 0.52, { c: 0.001, anim: 'slide' });   // ventana de expulsión
    // armazón con riel
    R.prof('body', [[zF - 0.012, 0.016], [zB + 0.02, 0.016], [zB + 0.004, 0.006], [zB + 0.01, -0.004], [zF - 0.006, -0.004], [zF, 0.006]], sw - 0.002, 0, 0.006, 0, { b: 0.002 });
    if (P.hammer) R.box('dark', 0.008, 0.014, 0.01, 0, y + 0.004, zB - 0.004, { rx: -0.5 });
    grip(R, 'grip', P.gripL ?? 0.09, P.gripA ?? 0.26, 0.044, sw + 0.002);
    triggerGuard(R, 'body', 0.012, 0.05, 0.027, 0.008);
    magazine(R, 'pistol', 0, 0.004, P);
    let zm = zF;
    R.tube('metal', 0.0055, 0.008, 0, y + 0.002, zF + 0.002, { seg: 8, anim: 'slide' });
    if (P.comp) zm = muzzleDevice(R, 'comp', y + 0.002, zF, 0.01);
    if (P.sup) zm = muzzleDevice(R, 'sup', y + 0.002, zF, 0.009, { supLen: P.sup, supR: 0.016 });
    if (P.dot) sight(R, 'dot', y + sh / 2, zB + 0.03, zB + 0.07);
    else sight(R, 'iron', y + sh / 2, zB + 0.004, zF - 0.004);
    if (P.laser) laser(R, zF - 0.045, 0.0, 0);
    R.anchor.muzzle = [0, y + 0.002, zm + 0.004];
    R.anchor.eject = [sw / 2 + 0.004, y + 0.006, zF - L * 0.52];
    R.anchor.fore = 0.01; R.anchor.foreY = -0.02;
    R.anchor.rear = [0, y, zB];
    R.anchor.slideTravel = 0.022;
  },

  // ── revólver ──────────────────────────────────────────────────────────────
  revolver(R, P) {
    const bl = P.bl ?? 0.12, cr = P.cylR ?? 0.024, cl = P.cylL ?? 0.042, yb = 0.036;
    const zc = 0.03;     // centro del tambor
    const zf = zc + cl / 2 + 0.006;
    // armazón: puente superior, marco, tope
    R.prof('body', [[zc - cl / 2 - 0.018, -0.006], [zc - cl / 2 - 0.022, yb + cr * 0.6], [zc - cl / 2 - 0.01, yb + cr + 0.008],
      [zf + 0.012, yb + cr + 0.008], [zf + 0.014, yb - 0.004], [zf + 0.004, yb - cr - 0.004], [zc - cl / 2, -0.006]], 0.024, 0, 0, 0,
      { b: 0.003, holes: [[[zc - cl / 2 - 0.002, yb - cr - 0.002], [zc + cl / 2 + 0.002, yb - cr - 0.002], [zc + cl / 2 + 0.002, yb + cr + 0.002], [zc - cl / 2 - 0.002, yb + cr + 0.002]]] });
    // tambor (se anima: gira 1/6 por tiro) con estrías
    R.tube('metal', cr, cl, 0, yb, zc, { seg: 12, anim: 'cyl' });
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      R.box('hole', 0.005, 0.004, cl * 0.62, Math.cos(a) * cr * 0.93, yb + Math.sin(a) * cr * 0.93, zc - 0.002, { rz: a, c: 0.001, anim: 'cyl' });
    }
    R.anchor.pivot.cyl = [0, yb, zc];
    // caño con costilla y, si pide, contrapeso abajo
    R.tube('metal', 0.0085, bl, 0, yb + 0.004, zf + bl / 2, { seg: 12 });
    if (P.rib !== false) R.box('body', 0.008, 0.008, bl * 0.96, 0, yb + 0.014, zf + bl / 2, { c: 0.0015 });
    if (P.lug) R.box('body', 0.014, 0.016, bl * (P.lug === 'full' ? 0.98 : 0.5), 0, yb - 0.01, zf + bl * (P.lug === 'full' ? 0.49 : 0.25), { c: 0.003 });
    else R.tube('dark', 0.003, bl * 0.4, 0, yb - 0.012, zf + bl * 0.2, { seg: 6 });
    // martillo, empuñadura redondeada y guardamonte
    R.prof('dark', [[zc - cl / 2 - 0.02, yb + cr * 0.4], [zc - cl / 2 - 0.036, yb + cr + 0.012], [zc - cl / 2 - 0.028, yb + cr + 0.016], [zc - cl / 2 - 0.014, yb + cr * 0.6]], 0.007, 0, 0, 0, { b: 0.001 });
    // empuñadura: corta y llena, con la panza de atrás y el talón redondeado (la de acción
    // simple es la "manija de arado": más curva y más atrás)
    const gl = Math.min(P.gripL ?? 0.088, 0.095), k = P.sa ? 0.5 : 0.34, dz = gl * k;
    R.prof('grip', [
      [0.006, 0.002], [-0.03, 0.006], [-0.044, -gl * 0.2], [-0.05 - dz * 0.55, -gl * 0.55], [-0.048 - dz, -gl * 0.88],
      [-0.038 - dz, -gl], [-0.014 - dz, -gl - 0.002], [-0.004 - dz * 0.9, -gl * 0.86], [0.0 - dz * 0.45, -gl * 0.45], [0.006, -0.016],
    ], 0.032, 0, 0, 0, { b: 0.007 });
    R.box('dark', 0.034, 0.006, 0.012, 0, -gl * 0.5, -0.02 - dz * 0.5, { c: 0.002, rx: -k * 0.8 });     // tornillo de las cachas
    if (!P.sa) triggerGuard(R, 'body', -0.004, 0.044, 0.026, 0.008);
    else R.box('dark', 0.004, 0.018, 0.006, 0, -0.01, 0.014, { rx: -0.3 });
    let zm = zf + bl;
    if (P.brake) zm = muzzleDevice(R, 'brake', yb + 0.004, zm, 0.011);
    if (P.scope) sight(R, 'scope', yb + cr + 0.01, zf, zf + 0.16, { scopeLen: 0.16 });
    else sight(R, 'iron', yb + 0.012, zc - cl / 2 - 0.01, zf + bl - 0.004);
    R.anchor.muzzle = [0, yb + 0.004, zm + 0.004];
    R.anchor.eject = [0.02, yb, zc];
    R.anchor.fore = 0.012; R.anchor.foreY = -0.022;
    R.anchor.rear = [0, yb, zc - cl / 2 - 0.02];
  },

  // ── subfusil / PDW ────────────────────────────────────────────────────────
  smg(R, P) {
    const st = P.style || 'box', rl = P.rl ?? 0.26, rh = P.rh ?? 0.052, rw = P.rw ?? 0.044, yc = 0.034;
    let zr = -0.08, zf = zr + rl;
    if (st === 'bullpup') {
      // cuerpo de una pieza, cargador arriba, empuñadura adelante del cajón
      zr = -0.25; zf = 0.17;
      // una sola pieza orgánica: lomo que cae hacia la cantonera, frente redondeado y el
      // agujero del pulgar adelante (la mano pasa por adentro). Perfil de riñón, no de caja
      R.prof('body', [
        [zr, -0.05], [zr, yc + 0.022], [zr + 0.03, yc + 0.034], [zf - 0.06, yc + 0.036], [zf - 0.02, yc + 0.028], [zf, yc + 0.008],
        [zf, -0.022], [zf - 0.03, -0.05], [0.09, -0.07], [0.03, -0.076], [-0.05, -0.074], [-0.13, -0.066], [-0.2, -0.062],
      ], 0.052, 0, 0, 0, { b: 0.011, holes: [[[0.078, -0.022], [0.0, -0.022], [-0.018, -0.056], [0.068, -0.056]]] });
      // armazón inferior oscuro alrededor del agujero: el P90 es de dos tonos
      R.prof('grip', [[zf - 0.012, -0.018], [0.086, -0.016], [0.086, -0.062], [-0.03, -0.068], [-0.03, -0.06], [0.07, -0.058], [0.074, -0.02], [-0.004, -0.02], [-0.03, -0.06], [-0.03, -0.074], [0.03, -0.08], [0.09, -0.074], [zf - 0.03, -0.054], [zf - 0.004, -0.028]], 0.054, 0, 0, 0, { b: 0.006 });
      // cargador ahumado encima, a lo largo (se lee desde la cámara cenital), con su riel de mira
      R.box('lens', 0.038, 0.014, 0.25, 0, yc + 0.044, -0.045, { c: 0.005 });
      R.box('dark', 0.024, 0.008, 0.06, 0, yc + 0.055, 0.08, { c: 0.002 });
      R.tube('metal', 0.0075, 0.05, 0, yc - 0.004, zf + 0.025, { seg: 10 });
      R.tube('dark', 0.0105, 0.018, 0, yc - 0.004, zf + 0.009, { seg: 10 });
      zf += 0.05;
      if (P.sight) sight(R, P.sight, yc + 0.059, 0.05, 0.11);
      R.anchor.eject = [0, -0.035, -0.08];
      R.anchor.fore = 0.13; R.anchor.foreY = -0.02;
      let zm = zf;
      if (P.sup) zm = muzzleDevice(R, 'sup', yc, zf, 0.009, { supLen: P.sup });
      R.anchor.muzzle = [0, yc, zm + 0.004];
      R.anchor.rear = [0, yc, zr];
      return;
    }
    if (st === 'vector') {
      // cajón inclinado y un bloque bajo que se come el retroceso
      R.prof('body', [[zr, yc + 0.03], [zf, yc + 0.03], [zf + 0.02, yc], [zf, -0.04], [zr + 0.14, -0.06], [zr + 0.1, -0.02], [zr, -0.02]], rw, 0, 0, 0, { b: 0.007 });
    } else if (st === 'mac') {
      R.box('body', rw, rh + 0.02, rl * 0.8, 0, yc - 0.006, zr + rl * 0.4, { c: 0.004 });
    } else if (st === 'tube') {
      R.tube('body', rh * 0.55, rl, 0, yc, zr + rl / 2, { seg: 14 });
      R.box('dark', 0.03, 0.02, rl * 0.5, 0, yc - rh * 0.4, zr + rl * 0.35, { c: 0.004 });
    } else {
      // "box": cajón redondeado de estampado con el caño cubierto (tipo MP5)
      R.prof('body', [[zr, yc - 0.02], [zr, yc + 0.02], [zr + 0.02, yc + rh / 2 + 0.004], [zf - 0.03, yc + rh / 2 + 0.004], [zf, yc + 0.012], [zf, yc - 0.022], [zr + 0.1, yc - 0.028]], rw, 0, 0, 0, { b: 0.009 });
      rail(R, rl * 0.5, yc + rh / 2 + 0.006, zr + rl * 0.45);
    }
    // guardamanos
    const hl = P.hl ?? 0.12;
    if (P.hg === 'vented') {
      R.tube('body', 0.02, hl, 0, yc + 0.006, zf + hl / 2, { seg: 12 });
      for (let i = 0; i < 4; i++) R.tube('hole', 0.0205, 0.008, 0, yc + 0.006, zf + 0.018 + i * hl * 0.22, { seg: 12 });
    } else if (hl > 0) R.box('hg', 0.046, 0.044, hl, 0, yc - 0.002, zf + hl / 2, { c: 0.008 });
    const bl = P.bl ?? 0.07;
    R.tube('metal', 0.0075, bl, 0, yc + 0.006, zf + hl + bl / 2 - 0.01, { seg: 10 });
    let zm = zf + hl + bl - 0.01;
    if (P.sup) zm = muzzleDevice(R, 'sup', yc + 0.006, zm, 0.009, { supLen: P.sup, supR: 0.019 });
    else if (P.md) zm = muzzleDevice(R, P.md, yc + 0.006, zm, 0.009);
    // empuñadura, guardamonte, cargador
    grip(R, 'grip', 0.085, 0.24, 0.034, 0.03, 0, 0);
    triggerGuard(R, 'body', 0.012, 0.05, 0.026, 0.009);
    const mz = P.magZ ?? (st === 'mac' ? 0 : 0.09);
    if (st === 'mac') magazine(R, 'box', -0.008, -0.03, { magLen: P.magLen || 0.12, magD: 0.028, magRake: 0.24, magT: 0.022 });
    else magazine(R, P.mag || 'curved', mz, yc - rh / 2, { ...P, magLen: P.magLen || 0.13, magD: 0.03, magT: 0.022, magCurve: P.magCurve ?? 0.35 });
    // culata
    const zs = stock(R, P.stock || 'fold', zr, yc - 0.01, { stockLen: P.stockLen || 0.22 });
    if (P.fg) foregrip(R, P.fg, zf + hl * 0.55, yc - 0.024);
    if (P.laser) laser(R, zf + hl * 0.4, yc + 0.004, 0.028);
    if (P.sight && st !== 'box') sight(R, P.sight, yc + 0.03, zr + 0.04, zf - 0.02);
    else if (P.sight) sight(R, P.sight, yc + rh / 2 + 0.009, zr + 0.06, zf - 0.04);
    else sight(R, 'iron', yc + rh / 2, zr + 0.02, zf + hl - 0.01);
    R.anchor.muzzle = [0, yc + 0.006, zm + 0.004];
    R.anchor.eject = [rw / 2 + 0.004, yc + 0.012, zr + rl * 0.55];
    R.anchor.fore = Math.min(0.2, zf + hl * 0.45); R.anchor.foreY = -0.004;
    R.anchor.rear = [0, yc, zs];
  },

  // ── pistola ametralladora: una pistola con cargador largo y quizás culata ─
  mpistol(R, P) {
    BUILDERS.pistol(R, { ...P, ext: P.ext ?? 0.07 });
    if (P.fg) R.box('grip', 0.02, 0.04, 0.02, 0, -0.022, 0.12, { c: 0.005, rx: 0.3 });
    if (P.stub) { R.tube('metal', 0.006, 0.12, 0, 0.006, -0.1, { seg: 8 }); R.box('rubber', 0.026, 0.07, 0.012, 0, -0.015, -0.16, { c: 0.003 }); }
    R.anchor.fore = P.fg ? 0.1 : 0.01;
  },

  // ── escopeta de bomba (y posta única) ─────────────────────────────────────
  pump(R, P) {
    const yc = 0.036, bl = P.bl ?? 0.46, rl = 0.2, zr = -0.07, zf = zr + rl;
    R.prof('body', [[zr, yc - 0.03], [zr, yc + 0.028], [zr + 0.02, yc + 0.034], [zf, yc + 0.034], [zf, yc - 0.03]], 0.044, 0, 0, 0, { b: 0.006 });
    R.box('hole', 0.003, 0.018, 0.05, 0.022, yc + 0.006, zr + 0.11, { c: 0.001 });                                // ventana
    if (P.shells) for (let i = 0; i < 5; i++) {                                                                       // cartuchos de repuesto al costado
      R.tube('shell', 0.0095, 0.05, -0.028, yc + 0.02 - 0.0005, zr + 0.03 + i * 0.022, { rx: -HALF_PI, seg: 8 });
      R.tube('brass', 0.01, 0.012, -0.028, yc - 0.012, zr + 0.03 + i * 0.022, { rx: -HALF_PI, seg: 8 });
    }
    R.tube('metal', 0.012, bl, 0, yc + 0.012, zf + bl / 2, { seg: 12 });
    if (P.shield) {
      R.box('body2', 0.03, 0.012, bl * 0.55, 0, yc + 0.03, zf + bl * 0.32, { c: 0.003 });
      for (let i = 0; i < 6; i++) R.box('hole', 0.018, 0.003, 0.012, 0, yc + 0.036, zf + 0.03 + i * bl * 0.085, { c: 0.001 });
    }
    magazine(R, 'tube', zf, yc - 0.016, { tubeLen: bl * (P.tubeFrac ?? 0.82) });
    // bomba (se anima: va y viene)
    const pl = P.pumpLen ?? 0.17, pz = zf + (P.pumpAt ?? 0.15);
    R.box('pump', 0.046, 0.04, pl, 0, yc - 0.012, pz, { c: 0.01, anim: 'pump' });
    for (let i = 0; i < 5; i++) R.box('hole', 0.047, 0.004, 0.005, 0, yc - 0.012, pz - pl / 2 + 0.02 + i * (pl - 0.04) / 4, { c: 0.001, anim: 'pump' });
    R.anchor.pivot.pump = [0, 0, 0];
    triggerGuard(R, 'body', 0.012, 0.052, 0.026, 0.009);
    let zs = zr;
    if (P.stock === 'pistol') grip(R, 'grip', 0.09, 0.3, 0.036, 0.032);
    else if (P.stock === 'tac') { grip(R, 'grip', 0.09, 0.26, 0.036, 0.032); zs = stock(R, 'tube', zr, yc - 0.02, { stockLen: 0.24 }); }
    else {
      // culata de caza con la empuñadura incluida (perfil único)
      const L = P.stockLen ?? 0.3;
      R.prof('stock', [[zr + 0.005, yc + 0.03], [zr - 0.05, yc + 0.025], [zr - L, yc - 0.005], [zr - L, yc - 0.13], [zr - L * 0.5, yc - 0.075], [zr - 0.07, yc - 0.075], [zr - 0.02, yc - 0.035], [zr + 0.005, yc - 0.03]], 0.04, 0, 0, 0, { b: 0.007 });
      R.box('rubber', 0.041, 0.13, 0.012, 0, yc - 0.068, zr - L - 0.005, { c: 0.004 });
      zs = zr - L - 0.011;
    }
    let zm = zf + bl;
    if (P.md) zm = muzzleDevice(R, P.md, yc + 0.012, zm, 0.012);
    if (P.sight) sight(R, P.sight, yc + 0.034, zr + 0.03, zf - 0.02, { scopeLen: 0.2 });
    else R.ball('glow', 0.003, 0, yc + 0.026, zf + bl - 0.01, { detail: 0 });      // mira de cuenta
    if (P.light) { R.tube('dark', 0.014, 0.06, 0, yc - 0.04, zf + 0.25, { seg: 10 }); R.tube('glow', 0.011, 0.002, 0, yc - 0.04, zf + 0.281, { seg: 10 }); }
    R.anchor.muzzle = [0, yc + 0.012, zm + 0.004];
    R.anchor.eject = [0.026, yc + 0.006, zr + 0.11];
    R.anchor.fore = pz; R.anchor.foreY = -0.03;
    R.anchor.rear = [0, yc, zs];
  },

  // ── escopeta de dos caños (quebrada) ──────────────────────────────────────
  double(R, P) {
    const yc = 0.034, bl = P.bl ?? 0.5, zf = 0.07;
    R.box('body2', 0.05, 0.05, 0.12, 0, yc - 0.004, 0.01, { c: 0.008 });           // báscula
    for (const s of [-1, 1]) R.tube('metal', 0.0115, bl, s * 0.0118, yc + 0.006, zf + bl / 2, { seg: 12 });
    R.box('body', 0.008, 0.006, bl * 0.95, 0, yc + 0.019, zf + bl / 2, { c: 0.0015 });   // costilla
    R.box('pump', 0.044, 0.028, 0.22, 0, yc - 0.018, zf + 0.12, { c: 0.009 });           // delantera de madera
    triggerGuard(R, 'body', 0.0, 0.056, 0.026, 0.009);
    const L = P.stockLen ?? 0.32;
    R.prof('stock', [[-0.05, yc + 0.02], [-0.1, yc + 0.02], [-0.05 - L, yc - 0.01], [-0.05 - L, yc - 0.13], [-0.05 - L * 0.5, yc - 0.07], [-0.11, yc - 0.075], [-0.05, yc - 0.03]], 0.04, 0, 0, 0, { b: 0.007 });
    R.box('rubber', 0.041, 0.125, 0.012, 0, yc - 0.068, -0.055 - L, { c: 0.004 });
    for (const s of [-1, 1]) R.box('dark', 0.006, 0.012, 0.012, s * 0.012, yc + 0.03, -0.04, { rx: -0.6 });   // martillos
    R.ball('glow', 0.003, 0, yc + 0.024, zf + bl - 0.01, { detail: 0 });
    R.anchor.muzzles = [[-0.0118, yc + 0.006, zf + bl + 0.004], [0.0118, yc + 0.006, zf + bl + 0.004]];
    R.anchor.muzzle = R.anchor.muzzles[0];
    R.anchor.eject = [0, yc + 0.01, zf];
    R.anchor.fore = zf + 0.12; R.anchor.foreY = -0.03;
    R.anchor.rear = [0, yc, -0.06 - L];
  },

  // ── escopeta automática (de cargador o tambor) ────────────────────────────
  autoshot(R, P) {
    const yc = 0.036, rl = P.rl ?? 0.3, zr = -0.1, zf = zr + rl, bl = P.bl ?? 0.3;
    R.prof('body', [[zr, yc - 0.03], [zr, yc + 0.03], [zf - 0.04, yc + 0.034], [zf, yc + 0.026], [zf, yc - 0.034], [zr + 0.1, yc - 0.036]], 0.05, 0, 0, 0, { b: 0.008 });
    rail(R, rl * 0.7, yc + 0.037, zr + rl * 0.5);
    R.box('hg', 0.05, 0.048, bl * 0.55, 0, yc + 0.002, zf + bl * 0.275, { c: 0.01 });
    R.tube('metal', 0.012, bl, 0, yc + 0.01, zf + bl / 2, { seg: 12 });
    let zm = zf + bl;
    zm = muzzleDevice(R, P.md || 'brake', yc + 0.01, zm, 0.013);
    grip(R, 'grip', 0.09, 0.24, 0.036, 0.032);
    triggerGuard(R, 'body', 0.012, 0.05, 0.026, 0.009);
    magazine(R, P.mag || 'box', 0.08, yc - 0.034, { magLen: 0.11, magD: 0.05, magT: 0.03, drumR: 0.075, magRake: 0.05 });
    const zs = stock(R, P.stock || 'fixed', zr, yc - 0.01, { stockLen: 0.26 });
    if (P.sight) sight(R, P.sight, yc + 0.043, zr + 0.06, zf - 0.04);
    if (P.fg) foregrip(R, P.fg, zf + bl * 0.3, yc - 0.022);
    R.anchor.muzzle = [0, yc + 0.01, zm + 0.004];
    R.anchor.eject = [0.028, yc + 0.012, zr + 0.14];
    R.anchor.fore = zf + bl * 0.28; R.anchor.foreY = -0.006;
    R.anchor.rear = [0, yc, zs];
  },

  // ── fusil de asalto (convencional o bullpup) ──────────────────────────────
  rifle(R, P) {
    const yc = 0.036, bl = P.bl ?? 0.09, hl = P.hl ?? 0.28;      // carabina moderna: guardamanos largo, caño apenas asomado
    if (P.bullpup) return BUILDERS.bullpup(R, P);
    const rl = P.rl ?? 0.25, zr = -0.07, zf = zr + rl;
    // cajón: superior con riel e inferior con el brocal del cargador
    R.prof('body', [[zr, yc - 0.008], [zr, yc + 0.026], [zr + 0.012, yc + 0.032], [zf, yc + 0.032], [zf, yc - 0.008]], 0.04, 0, 0, 0, { b: 0.005 });
    R.prof('body', [[zr + 0.03, yc - 0.008], [zf - 0.01, yc - 0.008], [zf - 0.01, yc - 0.03], [0.12, yc - 0.042], [0.06, yc - 0.042], [0.03, yc - 0.03], [zr + 0.04, yc - 0.03]], 0.038, 0, 0, 0, { b: 0.004 });
    R.box('hole', 0.003, 0.012, 0.05, 0.02, yc + 0.012, zr + 0.13, { c: 0.001 });
    if (P.carry) sight(R, 'carry', yc + 0.032, zr + 0.03, zf + hl + 0.02);
    else rail(R, rl * 0.9, yc + 0.035, zr + rl * 0.48);
    // guardamanos
    const hg = P.hg || 'mlok';
    if (hg === 'mlok') {
      R.tube('hg', 0.027, hl, 0, yc + 0.01, zf + hl / 2, { seg: 8, smooth: false, rz: Math.PI / 8 });
      for (const s of [-1, 1]) for (let i = 0; i < 4; i++) R.box('hole', 0.003, 0.009, 0.026, s * 0.0252, yc + 0.01, zf + 0.035 + i * hl * 0.22, { c: 0.001 });
      if (!P.carry) rail(R, hl * 0.95, yc + 0.035, zf + hl * 0.5);
    } else if (hg === 'quad') {
      R.box('hg', 0.044, 0.044, hl, 0, yc + 0.01, zf + hl / 2, { c: 0.004 });
      rail(R, hl, yc + 0.035, zf + hl / 2);
      for (const s of [-1, 1]) rail(R, hl * 0.8, yc + 0.01, zf + hl * 0.45, s * 0.025, 'rail', s * -HALF_PI);
    } else if (hg === 'wood') {
      R.box('hg', 0.046, 0.046, hl, 0, yc + 0.004, zf + hl / 2, { c: 0.014 });
    } else if (hg === 'ribbed') {
      R.tube('hg', 0.024, hl, 0, yc + 0.008, zf + hl / 2, { seg: 12 });
      for (let i = 0; i < 6; i++) R.tube('hole', 0.0245, 0.006, 0, yc + 0.008, zf + 0.02 + i * hl * 0.16, { seg: 12 });
    }
    R.tube('metal', P.heavy ? 0.011 : 0.0085, bl, 0, yc + 0.01, zf + hl + bl / 2, { seg: 10 });
    if (P.gas) R.tube('dark', 0.006, hl * 0.9, 0, yc + 0.026, zf + hl * 0.5, { seg: 8 });
    if (!P.carry && P.fsp !== false) R.prof('dark', [[zf + hl + 0.008, 0], [zf + hl + 0.02, 0], [zf + hl + 0.016, 0.045], [zf + hl + 0.012, 0.045]], 0.01, 0, yc + 0.008, 0, { b: 0.0015 });
    let zm = zf + hl + bl;
    if (P.sup) zm = muzzleDevice(R, 'sup', yc + 0.01, zm, 0.011, { supLen: P.sup });
    else zm = muzzleDevice(R, P.md || 'hider', yc + 0.01, zm, 0.0095);
    grip(R, 'grip', 0.088, 0.3, 0.034, 0.03);
    triggerGuard(R, 'body', 0.016, 0.052, 0.026, 0.009);
    magazine(R, P.mag || 'curved', 0.09, yc - 0.03, { ...P, magLen: P.magLen || 0.16, magD: P.magD || 0.052, magT: 0.024, magCurve: P.magCurve ?? 0.7, drumR: 0.07 });
    const zs = stock(R, P.stock || 'tube', zr, yc - 0.012, { stockLen: P.stockLen || 0.25, drop: P.drop ?? 0.015 });
    if (P.sight && !P.carry) sight(R, P.sight, yc + 0.04, zr + 0.05, zf + 0.02, { scopeLen: P.scopeLen });
    if (P.fg) foregrip(R, P.fg, zf + hl * 0.45, yc - 0.016);
    if (P.laser) laser(R, zf + hl * 0.35, yc + 0.012, 0.03);
    if (P.bipod) bipod(R, zf + hl * 0.8, yc - 0.016);
    R.anchor.muzzle = [0, yc + 0.01, zm + 0.004];
    R.anchor.eject = [0.024, yc + 0.014, zr + 0.13];
    R.anchor.fore = Math.min(0.26, zf + hl * 0.42); R.anchor.foreY = -0.01;
    R.anchor.rear = [0, yc, zs];
  },

  // ── bullpup: el cajón va detrás de la empuñadura ──────────────────────────
  bullpup(R, P) {
    const yc = 0.04, zr = -0.36, zf = 0.2, bl = P.bl ?? 0.2;
    // cuerpo: adelante bajo, la culata (con el cajón adentro) más alta atrás
    const outer = [[zr, yc - 0.1], [zr, yc + 0.03], [zr + 0.04, yc + 0.04], [zf - 0.04, yc + 0.04], [zf, yc + 0.02], [zf, yc - 0.03],
      [0.06, yc - 0.04], [-0.05, yc - 0.04], [-0.14, yc - 0.045], [-0.22, yc - 0.1]];
    R.prof('body', outer, 0.05, 0, 0, 0, { b: 0.009 });
    grip(R, 'grip', 0.085, 0.2, 0.034, 0.032, 0, 0);
    // guardamonte grande que encierra la mano (tipo AUG)
    R.prof('body', [[0.075, 0], [0.075, -0.07], [0.03, -0.1], [0.018, -0.1], [0.058, -0.066], [0.058, 0]], 0.03, 0, 0, 0, { b: 0.004 });
    magazine(R, P.mag || 'box', -0.17, yc - 0.1, { magLen: P.magLen || 0.1, magD: 0.034, magT: 0.024, magRake: 0.1 });
    R.box('rubber', 0.052, 0.14, 0.012, 0, yc - 0.035, zr - 0.006, { c: 0.004 });
    R.tube('metal', 0.0085, bl, 0, yc + 0.006, zf + bl / 2, { seg: 10 });
    let zm = zf + bl;
    if (P.sup) zm = muzzleDevice(R, 'sup', yc + 0.006, zm, 0.011, { supLen: P.sup });
    else zm = muzzleDevice(R, P.md || 'hider', yc + 0.006, zm, 0.0095);
    if (P.sight === 'integral') {
      // mira óptica integrada al asa (tipo AUG)
      R.prof('body', [[-0.12, 0], [-0.1, 0.035], [0.08, 0.035], [0.1, 0]], 0.03, 0, yc + 0.04, 0, { b: 0.005, holes: [[[-0.08, 0.004], [0.07, 0.004], [0.07, 0.022], [-0.08, 0.022]]] });
      R.lathe('body2', [[0.014, -0.05], [0.017, -0.04], [0.014, 0.0], [0.02, 0.04], [0.02, 0.05]], 0, yc + 0.09, -0.01, { seg: 16 });
      R.tube('lens', 0.018, 0.002, 0, yc + 0.09, 0.041, { seg: 16 });
      R.anchor.sight = [0, yc + 0.09, -0.01];
    } else {
      rail(R, 0.3, yc + 0.043, -0.06);
      if (P.sight) sight(R, P.sight, yc + 0.048, -0.16, 0.06, { scopeLen: P.scopeLen });
    }
    if (P.fg) foregrip(R, P.fg, 0.15, yc - 0.03);
    if (P.laser) laser(R, 0.14, yc + 0.004, 0.032);
    R.anchor.muzzle = [0, yc + 0.006, zm + 0.004];
    R.anchor.eject = [0.028, yc + 0.01, -0.2];
    R.anchor.fore = 0.15; R.anchor.foreY = -0.012;
    R.anchor.rear = [0, yc, zr];
  },

  // ── fusil de batalla / tirador designado ──────────────────────────────────
  battle(R, P) {
    // el mismo esqueleto del fusil, más largo, con cargador recto y culata de madera si pide
    BUILDERS.rifle(R, { hl: 0.3, bl: 0.14, rl: 0.28, mag: P.mag || 'box', magLen: P.magLen || 0.12, magCurve: 0.1, stock: P.stock || 'wood', stockLen: 0.27, md: P.md || 'brake', ...P });
  },

  // ── francotirador de cerrojo (y antimaterial) ─────────────────────────────
  sniper(R, P) {
    const yc = 0.04, big = !!P.amr, bl = P.bl ?? (big ? 0.5 : 0.42), rl = big ? 0.34 : 0.26, zr = -0.08, zf = zr + rl;
    R.tube('body', big ? 0.024 : 0.019, rl, 0, yc + 0.006, zr + rl / 2, { seg: 14 });               // cajón redondo
    if (big) R.box('body', 0.052, 0.05, rl, 0, yc - 0.012, zr + rl / 2, { c: 0.006 });
    // cerrojo (se anima): manija que sale a la derecha con la bola
    R.tube('metal', 0.004, 0.05, 0.028, yc + 0.004, zr + 0.06, { ry: HALF_PI, rz: -0.25, seg: 8, anim: 'bolt' });
    R.ball('metal', 0.009, 0.052, yc - 0.004, zr + 0.06, { anim: 'bolt' });
    R.anchor.pivot.bolt = [0, yc + 0.006, zr + 0.06];
    // caño cónico
    R.lathe('metal', [[big ? 0.016 : 0.012, 0], [big ? 0.013 : 0.0095, bl * 0.6], [big ? 0.012 : 0.0085, bl]], 0, yc + 0.006, zf, { seg: 12 });
    let zm = zf + bl;
    if (P.sup) zm = muzzleDevice(R, 'sup', yc + 0.006, zm, 0.012, { supLen: P.sup, supR: 0.022 });
    else zm = muzzleDevice(R, big ? 'bigbrake' : (P.md || 'brake'), yc + 0.006, zm, big ? 0.015 : 0.012);
    // chasis/culata
    const kind = P.stock || (big ? 'skeleton' : 'wood');
    let zs;
    if (kind === 'wood' || kind === 'thumbhole') {
      // culata de caza de una pieza: se extiende adelante como caja del caño
      R.prof('stock', [[zf + 0.2, yc - 0.004], [zf + 0.2, yc - 0.03], [zf - 0.03, yc - 0.05], [0.04, yc - 0.05], [0.02, -0.02], [-0.01, -0.09], [-0.05, -0.09], [-0.05, yc - 0.03], [zr, yc - 0.01], [zr, yc - 0.004]], 0.044, 0, 0, 0, { b: 0.007 });
      zs = stock(R, kind, zr - 0.02, yc - 0.01, { stockLen: 0.25, drop: 0.012, H: 0.12 });
    } else {
      R.box('hg', 0.05, 0.05, bl * 0.5, 0, yc - 0.004, zf + bl * 0.25, { c: 0.006 });
      for (const s of [-1, 1]) for (let i = 0; i < 4; i++) R.box('hole', 0.003, 0.018, 0.03, s * 0.0252, yc - 0.004, zf + 0.03 + i * bl * 0.11, { c: 0.001 });
      grip(R, 'grip', 0.09, 0.2, 0.034, 0.032, 0, 0);
      zs = stock(R, kind, zr, yc - 0.012, { stockLen: big ? 0.3 : 0.26 });
    }
    triggerGuard(R, 'dark', 0.012, 0.048, 0.024, 0.008);
    magazine(R, 'box', 0.03, yc - 0.03, { magLen: big ? 0.1 : 0.06, magD: big ? 0.07 : 0.05, magT: big ? 0.032 : 0.026, magRake: 0 });
    sight(R, P.sight || 'longscope', yc + (big ? 0.03 : 0.024), zr + 0.02, zf + 0.04, { scopeLen: P.scopeLen || (big ? 0.38 : 0.32) });
    if (P.bipod || big) bipod(R, zf + 0.18, yc - 0.028);
    R.anchor.muzzle = [0, yc + 0.006, zm + 0.004];
    R.anchor.eject = [0.03, yc + 0.012, zr + 0.1];
    R.anchor.fore = 0.2; R.anchor.foreY = -0.03;
    R.anchor.rear = [0, yc, zs];
  },

  // ── ametralladora liviana ─────────────────────────────────────────────────
  lmg(R, P) {
    const yc = 0.044, rl = 0.34, zr = -0.1, zf = zr + rl, bl = P.bl ?? 0.42;
    R.prof('body', [[zr, yc - 0.035], [zr, yc + 0.034], [zr + 0.02, yc + 0.045], [zf, yc + 0.045], [zf, yc - 0.035]], 0.06, 0, 0, 0, { b: 0.008 });
    R.box('body2', 0.066, 0.02, 0.16, 0, yc + 0.052, zr + 0.2, { c: 0.005 });          // tapa del alimentador
    if (P.shroud) {
      // camisa de refrigeración con aletas (Lewis): se lee desde arriba
      R.tube('hg', 0.036, bl * 0.7, 0, yc + 0.006, zf + bl * 0.35, { seg: 16 });
      for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; R.box('hg', 0.003, 0.012, bl * 0.66, Math.cos(a) * 0.041, yc + 0.006 + Math.sin(a) * 0.041, zf + bl * 0.35, { rz: a, c: 0.0008 }); }
    } else {
      R.tube('metal', 0.013, bl, 0, yc + 0.006, zf + bl / 2, { seg: 12 });
      R.box('hg', 0.056, 0.05, bl * 0.4, 0, yc + 0.002, zf + bl * 0.2, { c: 0.008 });
      if (P.vent !== false) for (let i = 0; i < 5; i++) R.box('hole', 0.057, 0.006, 0.014, 0, yc + 0.014, zf + 0.02 + i * bl * 0.07, { c: 0.001 });
    }
    // asa de transporte
    R.tube('dark', 0.005, 0.1, 0, yc + 0.07, zf + 0.06, { seg: 8 });
    for (const dz of [0.02, 0.1]) R.box('dark', 0.01, 0.03, 0.01, 0, yc + 0.055, zf + dz);
    let zm = zf + bl;
    zm = muzzleDevice(R, P.md || 'hider', yc + 0.006, zm, 0.012);
    grip(R, 'grip', 0.09, 0.26, 0.036, 0.032);
    triggerGuard(R, 'body', 0.012, 0.054, 0.026, 0.009);
    magazine(R, P.mag || 'belt', 0.07, yc - 0.035, { panR: 0.12, boxW: 0.11, drumR: 0.07 });
    if (P.mag === 'pan') magazine(R, 'pan', zr + 0.2, yc + 0.062, { panR: 0.13 });
    const zs = stock(R, P.stock || 'fixed', zr, yc - 0.015, { stockLen: 0.24, H: 0.12 });
    if (P.sight) sight(R, P.sight, yc + 0.064, zr + 0.05, zr + 0.2, { scopeLen: 0.2 });
    else sight(R, 'iron', yc + 0.045, zr + 0.02, zf + bl - 0.02);
    if (P.twin) R.tube('metal', 0.013, bl, 0, yc - 0.024, zf + bl / 2, { seg: 12 });
    bipod(R, zf + bl * 0.7, yc - 0.01);
    R.anchor.muzzle = [0, yc + 0.006, zm + 0.004];
    if (P.twin) R.anchor.muzzles = [[0, yc + 0.006, zm + 0.004], [0, yc - 0.024, zf + bl + 0.004]];
    R.anchor.eject = [0.034, yc - 0.02, zr + 0.2];
    R.anchor.fore = 0.28; R.anchor.foreY = 0.02;
    R.anchor.rear = [0, yc, zs];
  },

  // ── ametralladora rotativa ────────────────────────────────────────────────
  rotary(R, P) {
    const yc = 0.02, n = P.barrels ?? 6, rr = P.rr ?? 0.03, bl = P.bl ?? 0.5, z0 = 0.1;
    // carcasa del motor, asas, caja de munición con cinta
    R.tube('body', 0.058, 0.22, 0, yc, -0.02, { seg: 16 });
    R.lathe('body2', [[0.058, 0], [0.05, 0.04], [0.042, 0.06]], 0, yc, 0.09, { seg: 16 });
    R.box('body', 0.07, 0.07, 0.12, -0.02, yc - 0.075, -0.05, { c: 0.01 });
    for (let i = 0; i < 8; i++) R.tube('brass', 0.0045, 0.03, -0.055 - i * 0.006, yc - 0.06 + i * 0.008, 0.0, { ry: HALF_PI, seg: 6 });
    R.tube('dark', 0.006, 0.14, 0, yc + 0.085, -0.02, { seg: 8 });
    for (const dz of [-0.08, 0.04]) R.box('dark', 0.012, 0.03, 0.012, 0, yc + 0.07, dz);
    R.tube('grip', 0.014, 0.08, 0, yc - 0.1, 0.15, { rx: HALF_PI, seg: 10 });
    grip(R, 'grip', 0.08, 0.1, 0.034, 0.032, 0.0, yc - 0.05);
    // el racimo de cañones (se anima: gira)
    R.anchor.pivot.spin = [0, yc, 0];
    for (let i = 0; i < n; i++) {
      const a = i * Math.PI * 2 / n;
      R.tube('metal', 0.0085, bl, Math.cos(a) * rr, yc + Math.sin(a) * rr, z0 + bl / 2, { seg: 8, anim: 'spin' });
    }
    for (const f of [0.1, 0.55, 0.95]) R.tube('dark', rr + 0.014, 0.014, 0, yc, z0 + bl * f, { seg: 14, anim: 'spin' });
    R.tube('dark', rr * 0.6, bl, 0, yc, z0 + bl / 2, { seg: 8, anim: 'spin' });
    if (P.coils) for (let i = 0; i < 3; i++) R.ring('glow', 0.05, 0.004, 0, yc, 0.0 + i * 0.03, { rs: 4, ts: 20 });
    R.anchor.muzzle = [0, yc, z0 + bl + 0.006];
    R.anchor.eject = [-0.06, yc - 0.04, 0.0];
    R.anchor.fore = 0.15; R.anchor.foreY = -0.06;
    R.anchor.rear = [0, yc, -0.13];
  },

  // ── lanzadores: tubo cohete, lanzagranadas quebrado, revólver, cápsulas ───
  launcher(R, P) {
    const st = P.style || 'tube';
    if (st === 'tube') {
      const L = P.tubeLen ?? 0.95, r = P.tubeR ?? 0.034, yc = 0.07, zb = -0.42;
      R.tube('body', r, L, 0, yc, zb + L / 2, { seg: 16 });
      R.lathe('body2', [[r * 1.15, 0], [r * 1.5, 0.08], [r * 1.55, 0.12]], 0, yc, zb + L - 0.03, { seg: 16, inner: 0.08 });     // boca acampanada
      R.lathe('body2', [[r * 1.6, -0.1], [r * 1.25, -0.04], [r * 1.1, 0]], 0, yc, zb + 0.02, { seg: 16, inner: 0.08 });          // tobera
      for (const f of [0.35, 0.62]) R.ring('dark', r + 0.002, 0.004, 0, yc, zb + L * f, { rs: 4, ts: 16 });
      if (P.wood) R.tube('wood', r + 0.004, 0.18, 0, yc, zb + L * 0.45, { seg: 16 });
      R.box('dark', 0.03, 0.05, 0.1, 0, yc - r - 0.02, 0.0, { c: 0.006 });
      grip(R, 'grip', 0.085, 0.22, 0.034, 0.03, 0.0, yc - r - 0.04);
      R.tube('grip', 0.012, 0.07, 0, yc - r - 0.055, 0.2, { rx: HALF_PI, seg: 10 });
      const ogive = P.warhead !== false;
      if (ogive) {
        R.lathe('warhead', [[r * 0.9, 0], [r * 1.6, 0.05], [r * 1.6, 0.12], [r * 0.8, 0.2], [0.004, 0.24]], 0, yc, zb + L + 0.06, { seg: 14 });
      }
      sight(R, P.sight || 'dot', yc + r, -0.1, 0.1);
      R.anchor.muzzle = [0, yc, zb + L + (ogive ? 0.3 : 0.08)];
      R.anchor.rear = [0, yc, zb - 0.08];
      R.anchor.eject = [0, yc, 0];
      R.anchor.fore = 0.2; R.anchor.foreY = -0.02;
      R.anchor.backblast = true;
      return;
    }
    if (st === 'break') {
      const yc = 0.04, bl = 0.32, r = 0.022;
      R.box('body2', 0.05, 0.06, 0.1, 0, yc, 0.0, { c: 0.008 });
      R.tube('metal', r, bl, 0, yc + 0.006, 0.05 + bl / 2, { seg: 16 });
      R.tube('dark', r * 0.8, 0.004, 0, yc + 0.006, 0.05 + bl + 0.001, { seg: 16 });
      R.box('pump', 0.046, 0.03, 0.16, 0, yc - 0.024, 0.14, { c: 0.009 });
      triggerGuard(R, 'body', -0.01, 0.05, 0.026, 0.009);
      stock(R, 'wood', -0.05, yc - 0.01, { stockLen: 0.3, drop: 0.03, H: 0.12 });
      R.prof('dark', [[0.2, 0], [0.22, 0], [0.22, 0.05], [0.2, 0.05]], 0.03, 0, yc + 0.03, 0, { b: 0.002, holes: [[[0.204, 0.01], [0.216, 0.01], [0.216, 0.04], [0.204, 0.04]]] });
      R.anchor.muzzle = [0, yc + 0.006, 0.05 + bl + 0.006];
      R.anchor.fore = 0.14; R.anchor.foreY = -0.03;
      R.anchor.rear = [0, yc, -0.36];
      R.anchor.eject = [0, yc, 0.05];
      return;
    }
    if (st === 'revolver') {
      const yc = 0.05, cr = 0.06, cl = 0.14, bl = 0.2;
      R.tube('body', cr, cl, 0, yc - 0.02, 0.05, { seg: 18, anim: 'cyl' });
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3;
        R.tube('dark', 0.02, cl + 0.004, Math.cos(a) * cr * 0.6, yc - 0.02 + Math.sin(a) * cr * 0.6, 0.05, { seg: 10, anim: 'cyl' });
      }
      R.anchor.pivot.cyl = [0, yc - 0.02, 0.05];
      R.tube('metal', 0.022, bl, 0, yc + 0.02, 0.12 + bl / 2, { seg: 14 });
      R.box('body2', 0.03, 0.03, cl + 0.16, 0, yc + 0.05, 0.08, { c: 0.005 });
      grip(R, 'grip', 0.09, 0.22, 0.036, 0.032, -0.03, yc - 0.08);
      R.tube('grip', 0.013, 0.07, 0, yc - 0.035, 0.22, { rx: HALF_PI, seg: 10 });
      stock(R, 'tube', -0.03, yc - 0.03, { stockLen: 0.22 });
      sight(R, 'holo', yc + 0.065, 0.03, 0.12);
      R.anchor.muzzle = [0, yc + 0.02, 0.12 + bl + 0.006];
      R.anchor.fore = 0.22; R.anchor.foreY = -0.04;
      R.anchor.rear = [0, yc, -0.27];
      R.anchor.eject = [0.06, yc, 0.05];
      return;
    }
    if (st === 'pods') {
      // enjambre: dos vainas biseladas lado a lado (dos cohetes cada una), bisel oscuro al
      // frente con las bocas encendidas, asa arriba y aletas atrás
      const yc = 0.06, L = 0.46, r = 0.02, zc = 0.1, sx = 0.032;
      for (const s of [-1, 1]) {
        R.box('body', 0.06, 0.1, L, s * sx, yc, zc, { c: 0.016 });
        R.box('dark', 0.064, 0.104, 0.03, s * sx, yc, zc + L / 2 - 0.012, { c: 0.01 });
        R.box('glow2', 0.062, 0.004, L * 0.7, s * sx, yc + 0.046, zc - 0.03, { c: 0.001 });     // franja de luz en el lomo
        for (const sy of [-1, 1]) {
          R.tube('hole', r, 0.012, s * sx, yc + sy * 0.024, zc + L / 2 + 0.004, { seg: 12 });
          R.tube('glow', r * 0.5, 0.004, s * sx, yc + sy * 0.024, zc + L / 2 + 0.008, { seg: 10 });
        }
        R.prof('dark', [[0, 0], [-0.07, 0], [-0.07, 0.05], [-0.03, 0.05]], 0.006, s * (sx + 0.03), yc - 0.02, zc - L / 2 + 0.05, { b: 0.001 });   // aletas
      }
      R.tube('dark', 0.007, 0.16, 0, yc + 0.075, zc, { seg: 8 });
      for (const dz of [-0.07, 0.07]) R.box('dark', 0.014, 0.026, 0.014, 0, yc + 0.06, zc + dz);
      grip(R, 'grip', 0.085, 0.2, 0.034, 0.03, 0.0, yc - 0.05);
      R.tube('grip', 0.013, 0.07, 0, yc - 0.085, 0.24, { rx: HALF_PI, seg: 10 });
      sight(R, 'holo', yc + 0.05, -0.04, 0.06);
      const zm = zc + L / 2 + 0.02;
      R.anchor.muzzle = [0, yc, zm];
      R.anchor.muzzles = [[-sx, yc - 0.024, zm], [sx, yc - 0.024, zm], [-sx, yc + 0.024, zm], [sx, yc + 0.024, zm]];
      R.anchor.fore = 0.24; R.anchor.foreY = -0.05;
      R.anchor.rear = [0, yc, -0.15];
      R.anchor.eject = [0, yc, 0];
      R.anchor.backblast = true;
      return;
    }
    // 'drum': lanzagranadas con tambor abajo (ráfagas de racimo)
    BUILDERS.autoshot(R, { ...P, mag: 'drum', md: 'none', bl: 0.22 });
    R.tube('metal', 0.024, 0.2, 0, 0.046, 0.3, { seg: 16 });
    R.anchor.muzzle = [0, 0.046, 0.41];
  },

  // ── armas de energía ──────────────────────────────────────────────────────
  energy(R, P) {
    const st = P.style || 'rifle', yc = 0.038;
    if (st === 'pistol') {
      const L = 0.2;
      R.prof('body', [[-0.05, 0.0], [-0.05, 0.05], [-0.02, 0.062], [0.12, 0.062], [0.15, 0.045], [0.15, 0.012], [0.1, 0.0]], 0.032, 0, 0, 0, { b: 0.006 });
      R.box('glow', 0.034, 0.004, 0.12, 0, 0.044, 0.05, { c: 0.001 });
      for (let i = 0; i < 3; i++) R.ring('glow2', 0.013, 0.0022, 0, 0.034, 0.12 + i * 0.012, { rs: 4, ts: 14 });
      R.tube('metal', 0.009, 0.04, 0, 0.034, 0.165, { seg: 12 });
      R.tube('glow', 0.006, 0.003, 0, 0.034, 0.186, { seg: 12 });
      grip(R, 'grip', 0.09, 0.22, 0.036, 0.03);
      triggerGuard(R, 'body', 0.012, 0.05, 0.026, 0.009);
      magazine(R, 'cell', -0.03, 0.004, {});
      R.anchor.muzzle = [0, 0.034, 0.19]; R.anchor.fore = 0.01; R.anchor.foreY = -0.02;
      R.anchor.rear = [0, 0.03, -0.05]; R.anchor.eject = [0, 0.03, 0];
      sight(R, 'dot', 0.062, 0.0, 0.05);
      void L;
      return;
    }
    // fusiles, cañones: cuerpo de perfil suave, bandas brillantes, bobinas, lente
    const len = P.len ?? 0.72, h = P.h ?? 0.08, zr = -0.28, zf = zr + len;
    const body = [[zr, yc - 0.04], [zr, yc + 0.02], [zr + 0.08, yc + h * 0.5 + 0.01], [zf - 0.14, yc + h * 0.5 + 0.01], [zf - 0.04, yc + 0.02], [zf, yc + 0.008],
      [zf, yc - 0.022], [zf - 0.2, yc - 0.04], [0.06, yc - 0.045], [0.05, -0.02], [0.0, -0.02], [-0.06, yc - 0.045]];
    R.prof('body', body, P.w ?? 0.05, 0, 0, 0, { b: 0.01 });
    R.prof('body2', [[zr + 0.1, 0], [zf - 0.16, 0], [zf - 0.2, 0.018], [zr + 0.14, 0.018]], (P.w ?? 0.05) + 0.004, 0, yc + h * 0.5 - 0.004, 0, { b: 0.004 });
    // bandas de luz a los costados
    for (const s of [-1, 1]) R.box('glow', 0.002, 0.006, len * 0.55, s * ((P.w ?? 0.05) / 2 + 0.001), yc + 0.006, zr + len * 0.5, { c: 0.0005 });
    grip(R, 'grip', 0.088, 0.22, 0.034, 0.032);
    triggerGuard(R, 'body', 0.012, 0.05, 0.026, 0.009);
    R.box('rubber', (P.w ?? 0.05) + 0.002, 0.07, 0.014, 0, yc - 0.01, zr - 0.006, { c: 0.004 });
    let zm = zf;
    if (st === 'rail') {
      // dos rieles paralelos con un canal brillante entre medio y bobinas
      for (const s of [-1, 1]) R.box('metal', 0.012, 0.024, 0.34, s * 0.02, yc + 0.006, zf + 0.17, { c: 0.003 });
      R.box('glow', 0.006, 0.006, 0.33, 0, yc + 0.006, zf + 0.17, { c: 0.001 });
      for (let i = 0; i < 5; i++) R.ring('glow2', 0.034, 0.004, 0, yc + 0.006, zf + 0.03 + i * 0.07, { rs: 4, ts: 18 });
      zm = zf + 0.34;
    } else if (st === 'tesla') {
      // horquilla de dos puntas con una esfera de vidrio y bobina de cobre
      R.ball('lens', 0.034, 0, yc + 0.03, zf - 0.12, { detail: 2 });
      R.ball('glow', 0.014, 0, yc + 0.03, zf - 0.12, { detail: 1 });
      for (let i = 0; i < 7; i++) R.ring('copper', 0.022, 0.004, 0, yc + 0.004, zf + 0.01 + i * 0.012, { rs: 4, ts: 14 });
      for (const s of [-1, 1]) {
        R.tube('metal', 0.006, 0.16, s * 0.022, yc + 0.004, zf + 0.12, { seg: 8, rz: 0, ry: s * -0.06 });
        R.ball('glow', 0.008, s * 0.03, yc + 0.004, zf + 0.2, { detail: 1 });
      }
      zm = zf + 0.2;
    } else if (st === 'plasma') {
      // cámara de plasma: cilindro con ventanas y aletas de refrigeración
      R.tube('dark', 0.04, 0.16, 0, yc + 0.004, zf + 0.06, { seg: 16 });
      R.tube('glow', 0.041, 0.02, 0, yc + 0.004, zf + 0.03, { seg: 16 });
      R.tube('glow', 0.041, 0.02, 0, yc + 0.004, zf + 0.09, { seg: 16 });
      for (let i = 0; i < 6; i++) R.box('body2', 0.1, 0.004, 0.02, 0, yc + 0.004 + (i - 2.5) * 0.012, zf - 0.04, { c: 0.001 });
      R.lathe('metal', [[0.03, 0], [0.024, 0.04], [0.02, 0.07]], 0, yc + 0.004, zf + 0.14, { seg: 14 });
      zm = zf + 0.21;
    } else if (st === 'beam') {
      // lente grande al frente, anillos concéntricos
      R.lathe('body2', [[0.03, 0], [0.05, 0.05], [0.055, 0.12], [0.05, 0.14]], 0, yc + 0.004, zf - 0.02, { seg: 20 });
      R.tube('lens', 0.046, 0.003, 0, yc + 0.004, zf + 0.122, { seg: 20 });
      R.ring('glow', 0.036, 0.003, 0, yc + 0.004, zf + 0.124, { rs: 4, ts: 24 });
      R.ring('glow2', 0.02, 0.003, 0, yc + 0.004, zf + 0.125, { rs: 4, ts: 18 });
      zm = zf + 0.13;
    } else if (st === 'ion') {
      const r = 0.05;
      R.tube('body2', r, 0.3, 0, yc + 0.03, zf + 0.05, { seg: 20 });
      for (let i = 0; i < 4; i++) R.ring('glow', r + 0.003, 0.004, 0, yc + 0.03, zf - 0.05 + i * 0.07, { rs: 4, ts: 24 });
      R.tube('lens', r * 0.8, 0.003, 0, yc + 0.03, zf + 0.201, { seg: 20 });
      R.ball('glow', r * 0.45, 0, yc + 0.03, zf + 0.19, { detail: 1 });
      zm = zf + 0.21;
      R.anchor.muzzle = [0, yc + 0.03, zm];
    } else if (st === 'pulse') {
      R.tube('metal', 0.012, 0.1, 0, yc + 0.006, zf + 0.05, { seg: 12 });
      for (let i = 0; i < 4; i++) R.ring('glow2', 0.016, 0.0025, 0, yc + 0.006, zf + 0.015 + i * 0.022, { rs: 4, ts: 14 });
      zm = zf + 0.1;
    } else if (st === 'scatter') {
      // boca ancha rectangular con tres emisores (escopeta de plasma)
      R.box('body2', 0.07, 0.05, 0.1, 0, yc, zf + 0.05, { c: 0.008 });
      for (let i = -1; i <= 1; i++) R.tube('glow', 0.008, 0.004, i * 0.02, yc, zf + 0.101, { seg: 10 });
      zm = zf + 0.1;
    } else {
      // láser: caño fino con disipadores
      R.tube('metal', 0.01, 0.2, 0, yc + 0.006, zf + 0.1, { seg: 12 });
      for (let i = 0; i < 5; i++) R.tube('body2', 0.017, 0.008, 0, yc + 0.006, zf + 0.02 + i * 0.03, { seg: 12 });
      R.tube('glow', 0.006, 0.003, 0, yc + 0.006, zf + 0.201, { seg: 10 });
      zm = zf + 0.2;
    }
    magazine(R, 'cell', -0.1, yc - 0.04, {});
    sight(R, P.sight || 'holo', yc + h * 0.5 + 0.012, zr + 0.18, zr + 0.3, { scopeLen: 0.22 });
    if (!R.anchor.muzzle || R.anchor.muzzle[2] < zm) R.anchor.muzzle = [0, st === 'ion' ? yc + 0.03 : yc + 0.006, zm + 0.004];
    R.anchor.eject = [0, yc, 0];
    R.anchor.fore = Math.min(0.28, zf - 0.08); R.anchor.foreY = -0.02;
    R.anchor.rear = [0, yc, zr];
  },

  // ── exóticas ──────────────────────────────────────────────────────────────
  exotic(R, P) {
    const st = P.style;
    if (st === 'thrower') {
      // lanzallamas/criógeno: tanques gemelos, manguera, lanza con piloto
      const yc = 0.03;
      for (const s of [-1, 1]) {
        R.tube('tank', 0.042, 0.26, s * 0.045, yc - 0.03, -0.12, { seg: 16 });
        R.lathe('tank', [[0.042, 0], [0.03, 0.03], [0.012, 0.045]], s * 0.045, yc - 0.03, 0.01, { seg: 16 });
        R.lathe('tank', [[0.012, -0.045], [0.03, -0.03], [0.042, 0]], s * 0.045, yc - 0.03, -0.25, { seg: 16 });
      }
      R.box('dark', 0.12, 0.012, 0.12, 0, yc + 0.018, -0.12, { c: 0.003 });
      for (let i = 0; i < 6; i++) R.ring('dark', 0.012, 0.005, 0, yc + 0.02 + i * 0.004, -0.04 + i * 0.03, { rs: 4, ts: 10, rx: 0.3 });
      R.tube('body', 0.018, 0.4, 0, yc + 0.04, 0.2, { seg: 12 });
      R.lathe('metal', [[0.018, 0], [0.026, 0.05], [0.03, 0.07]], 0, yc + 0.04, 0.4, { seg: 14 });
      R.tube('dark', 0.004, 0.08, 0.02, yc + 0.03, 0.44, { seg: 6 });
      R.ball('glow', 0.006, 0.02, yc + 0.03, 0.48, { detail: 1 });                        // piloto
      grip(R, 'grip', 0.085, 0.2, 0.034, 0.03, 0.0, yc + 0.02);
      R.tube('grip', 0.013, 0.07, 0, yc - 0.005, 0.28, { rx: HALF_PI, seg: 10 });
      R.anchor.muzzle = [0, yc + 0.04, 0.475];
      R.anchor.fore = 0.28; R.anchor.foreY = -0.02;
      R.anchor.rear = [0, yc, -0.3]; R.anchor.eject = [0, yc, 0];
      R.anchor.pilot = [0.02, yc + 0.03, 0.48];
      return;
    }
    if (st === 'canister') {
      // lanzador de ácido: bidón transparente con el líquido brillante adentro
      const yc = 0.04;
      R.tube('body', 0.03, 0.2, 0, yc, 0.08, { seg: 14 });
      R.tube('lens', 0.052, 0.14, 0, yc + 0.075, -0.02, { seg: 16 });
      R.tube('glow', 0.045, 0.1, 0, yc + 0.07, -0.02, { seg: 16 });
      for (const dz of [-0.09, 0.05]) R.tube('dark', 0.055, 0.012, 0, yc + 0.075, dz, { seg: 16 });
      R.lathe('metal', [[0.03, 0], [0.026, 0.06], [0.036, 0.1]], 0, yc, 0.18, { seg: 14 });
      grip(R, 'grip', 0.088, 0.24, 0.034, 0.03);
      stock(R, 'tube', -0.05, yc - 0.01, { stockLen: 0.22 });
      R.tube('grip', 0.013, 0.07, 0, yc - 0.04, 0.16, { rx: HALF_PI, seg: 10 });
      R.anchor.muzzle = [0, yc, 0.285]; R.anchor.fore = 0.16; R.anchor.foreY = -0.03;
      R.anchor.rear = [0, yc, -0.28]; R.anchor.eject = [0, yc, 0];
      return;
    }
    if (st === 'crossbow') {
      const yc = 0.03;
      R.prof('stock', [[0.3, yc + 0.01], [0.3, yc - 0.02], [0.05, yc - 0.03], [0.02, -0.02], [-0.02, -0.08], [-0.06, -0.08], [-0.05, yc - 0.03], [-0.3, yc - 0.06], [-0.3, yc + 0.02], [-0.05, yc + 0.02]], 0.036, 0, 0, 0, { b: 0.006 });
      R.box('metal', 0.012, 0.006, 0.5, 0, yc + 0.014, 0.08, { c: 0.001 });                // riel del virote
      // palas: salen del frente hacia los costados y un poco hacia atrás (recurva)
      const zLimb = 0.33, spread = HALF_PI + 0.35, LL = 0.29;
      const tipX = Math.sin(spread) * LL, tipZ = zLimb + Math.cos(spread) * LL;
      for (const s of [-1, 1]) {
        R.prof('limb', [[0.0, -0.006], [0.0, 0.006], [LL - 0.02, 0.004], [LL, -0.004]], 0.036, 0, yc + 0.012, zLimb, { b: 0.004, ry: s * spread });
        R.tube('dark', 0.009, 0.012, s * tipX, yc + 0.012, tipZ, { rx: HALF_PI, seg: 10 });     // poleas
        // cuerda tensada: de la polea al fiador
        const dx = -s * tipX, dz = 0.03 - tipZ, L = Math.hypot(dx, dz);
        R.box('dark', 0.0022, 0.0022, L, s * tipX / 2, yc + 0.016, (tipZ + 0.03) / 2, { ry: Math.atan2(dx, dz), c: 0 });
      }
      R.box('limb', 0.05, 0.03, 0.04, 0, yc + 0.008, zLimb, { c: 0.006 });                   // bloque de las palas
      R.tube('bolt', 0.004, 0.42, 0, yc + 0.02, 0.18, { seg: 6 });                           // virote montado
      R.lathe('metal', [[0.004, 0], [0.009, 0.01], [0.0005, 0.04]], 0, yc + 0.02, 0.39, { seg: 8 });
      sight(R, 'scope', yc + 0.02, -0.05, 0.1, { scopeLen: 0.2 });
      R.anchor.muzzle = [0, yc + 0.02, 0.44]; R.anchor.fore = 0.18; R.anchor.foreY = -0.02;
      R.anchor.rear = [0, yc, -0.3]; R.anchor.eject = [0, yc, 0];
      R.anchor.loaded = true;
      return;
    }
    if (st === 'nailgun') {
      const yc = 0.05;
      R.prof('body', [[-0.12, 0.0], [-0.12, 0.09], [0.1, 0.09], [0.14, 0.06], [0.14, 0.02], [0.02, 0.0]], 0.056, 0, 0, 0, { b: 0.012 });
      R.tube('dark', 0.022, 0.08, 0, yc + 0.01, 0.17, { seg: 12 });
      R.tube('metal', 0.012, 0.03, 0, yc + 0.01, 0.225, { seg: 10 });
      R.tube('mag', 0.05, 0.03, 0, yc - 0.06, 0.07, { ry: HALF_PI, seg: 18 });               // bobina de clavos
      grip(R, 'grip', 0.09, 0.3, 0.036, 0.034);
      R.box('rubber', 0.05, 0.03, 0.05, 0, yc + 0.05, -0.08, { c: 0.008 });
      R.anchor.muzzle = [0, yc + 0.01, 0.245]; R.anchor.fore = 0.05; R.anchor.foreY = -0.02;
      R.anchor.rear = [0, yc, -0.12]; R.anchor.eject = [0, yc, 0];
      return;
    }
    if (st === 'harpoon') {
      const yc = 0.04;
      R.tube('body', 0.028, 0.5, 0, yc, 0.12, { seg: 14 });
      R.box('dark', 0.04, 0.04, 0.2, 0, yc - 0.03, -0.02, { c: 0.006 });
      R.tube('bolt', 0.007, 0.6, 0, yc + 0.034, 0.24, { seg: 8 });                            // arpón montado arriba
      R.lathe('metal', [[0.007, 0], [0.018, 0.02], [0.012, 0.03], [0.02, 0.05], [0.0005, 0.09]], 0, yc + 0.034, 0.54, { seg: 8 });
      R.tube('dark', 0.035, 0.03, 0.05, yc - 0.01, -0.02, { ry: HALF_PI, seg: 16 });         // carrete
      grip(R, 'grip', 0.09, 0.24, 0.036, 0.032, 0.0, yc - 0.05);
      stock(R, 'fixed', -0.1, yc - 0.02, { stockLen: 0.22 });
      R.anchor.muzzle = [0, yc + 0.034, 0.64]; R.anchor.fore = 0.2; R.anchor.foreY = -0.03;
      R.anchor.rear = [0, yc, -0.34]; R.anchor.eject = [0, yc, 0];
      R.anchor.loaded = true;
      return;
    }
    if (st === 'flaregun') {
      const yc = 0.034;
      R.box('body', 0.034, 0.05, 0.08, 0, yc - 0.006, 0.0, { c: 0.01 });
      R.tube('body', 0.02, 0.12, 0, yc + 0.006, 0.1, { seg: 16 });
      R.tube('dark', 0.016, 0.003, 0, yc + 0.006, 0.161, { seg: 16 });
      grip(R, 'grip', 0.09, 0.3, 0.038, 0.032);
      triggerGuard(R, 'body', 0.0, 0.05, 0.028, 0.01);
      R.box('dark', 0.008, 0.016, 0.012, 0, yc + 0.02, -0.042, { rx: -0.6 });
      R.anchor.muzzle = [0, yc + 0.006, 0.165]; R.anchor.fore = 0.01; R.anchor.foreY = -0.02;
      R.anchor.rear = [0, yc, -0.05]; R.anchor.eject = [0, yc, 0];
      return;
    }
    if (st === 'saw') {
      // lanzador de discos de chatarra: el disco asoma arriba
      const yc = 0.04;
      R.box('body', 0.06, 0.06, 0.34, 0, yc, 0.06, { c: 0.01 });
      R.tube('blade', 0.07, 0.004, 0, yc + 0.045, 0.12, { rx: -HALF_PI, seg: 24, anim: 'spin' });
      for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; R.box('blade', 0.014, 0.004, 0.012, Math.sin(a) * 0.074, yc + 0.045, 0.12 + Math.cos(a) * 0.074, { ry: a + 0.5, c: 0.001, anim: 'spin' }); }
      R.anchor.pivot.spin = [0, yc + 0.045, 0.12];
      R.tube('dark', 0.03, 0.02, 0, yc + 0.034, 0.12, { rx: -HALF_PI, seg: 12 });
      R.box('tape', 0.064, 0.02, 0.1, 0, yc - 0.02, 0.2, { c: 0.006 });
      grip(R, 'grip', 0.09, 0.26, 0.036, 0.032);
      stock(R, 'fold', -0.11, yc - 0.01, { stockLen: 0.22 });
      R.anchor.muzzle = [0, yc + 0.04, 0.24]; R.anchor.fore = 0.2; R.anchor.foreY = -0.03;
      R.anchor.rear = [0, yc, -0.33]; R.anchor.eject = [0, yc, 0];
      R.anchor.spinAxis = 'y';
      return;
    }
    if (st === 'horn') {
      // cañón sónico: bocina de bronce y resonadores
      const yc = 0.04;
      R.tube('body', 0.03, 0.22, 0, yc, 0.02, { seg: 14 });
      R.lathe('horn', [[0.03, 0], [0.04, 0.1], [0.07, 0.18], [0.11, 0.22], [0.115, 0.225]], 0, yc, 0.13, { seg: 22, inner: 0.06 });
      R.lathe('dark', [[0.001, 0.0], [0.02, 0.01], [0.001, 0.02]], 0, yc, 0.2, { seg: 12 });
      for (let i = 0; i < 3; i++) R.ring('glow', 0.034, 0.003, 0, yc, -0.04 + i * 0.04, { rs: 4, ts: 16 });
      grip(R, 'grip', 0.088, 0.24, 0.034, 0.03);
      stock(R, 'brace', -0.09, yc - 0.01, { stockLen: 0.2 });
      R.tube('grip', 0.013, 0.07, 0, yc - 0.045, 0.1, { rx: HALF_PI, seg: 10 });
      R.anchor.muzzle = [0, yc, 0.36]; R.anchor.fore = 0.1; R.anchor.foreY = -0.03;
      R.anchor.rear = [0, yc, -0.29]; R.anchor.eject = [0, yc, 0];
      return;
    }
    if (st === 'orb') {
      // lanzador de vórtice: jaula con una esfera oscura que late
      const yc = 0.05;
      R.box('body', 0.05, 0.05, 0.3, 0, yc - 0.02, 0.0, { c: 0.01 });
      for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; R.tube('metal', 0.004, 0.14, Math.cos(a) * 0.05, yc + 0.04 + Math.sin(a) * 0.05, 0.17, { seg: 6 }); }
      for (const dz of [0.1, 0.24]) R.ring('dark', 0.05, 0.006, 0, yc + 0.04, dz, { rs: 4, ts: 18 });
      R.ball('void', 0.03, 0, yc + 0.04, 0.17, { detail: 2 });
      R.ring('glow', 0.036, 0.0025, 0, yc + 0.04, 0.17, { rs: 4, ts: 24, ry: HALF_PI });
      grip(R, 'grip', 0.088, 0.24, 0.034, 0.03);
      stock(R, 'skeleton', -0.15, yc - 0.02, { stockLen: 0.2 });
      R.anchor.muzzle = [0, yc + 0.04, 0.25]; R.anchor.fore = 0.1; R.anchor.foreY = -0.04;
      R.anchor.rear = [0, yc, -0.36]; R.anchor.eject = [0, yc, 0];
      return;
    }
  },
};

// ═════════════════════════════════════════════════════════════════════════════
//  Ensamblado: piezas → mallas fundidas por material, UV en metros
// ═════════════════════════════════════════════════════════════════════════════

/** Paleta por defecto: lo que no dice el catálogo, sale de acá. */
export const BASE_LOOK = Object.freeze({
  body: 'polymer:#2a2c31', body2: 'parkerized:#3a3d44', metal: 'parkerized:#303338', dark: 'flat:#1b1c20',
  grip: 'stipple:#232529', stock: 'polymer:#2a2c31', hg: 'polymer:#2a2c31', mag: 'polymer:#232428', pump: 'polymer:#26282c',
  rail: 'parkerized:#2a2c31', sup: 'parkerized:#2c2e33', knurl: 'knurl:#3a3d43', rubber: 'rubber:#1d1e22',
  hole: 'flat:#0b0c0e', wood: 'wood:#6e4326/#352012', brass: 'brass', shell: 'polymer:#9c2f2a', copper: 'brass:#b8733d/#6b3d20',
  tank: 'hazard:#c9412f/#1b1c1f', tape: 'tape:#3a3c34', limb: 'carbon', bolt: 'carbon', blade: 'rust', horn: 'brass:#c9a24e/#6b5424',
  warhead: 'cerakote:#4f5a3a', void: 'flat:#050507',
  glow: '#a6e3a1', glow2: null, lens: '#3b2f6b',
});

/** Resuelve un rol de la paleta a una spec de acabado (los glow y lens son atajos por color). */
function roleSpec(look, role) {
  let spec = look[role] ?? BASE_LOOK[role];
  if (role === 'glow2' && !spec) spec = look.glow ?? BASE_LOOK.glow;
  if (spec == null) spec = BASE_LOOK.body;
  if (role === 'glow' || role === 'glow2') return typeof spec === 'string' && spec.startsWith('#') ? { f: 'flat', c: spec, glow: role === 'glow' ? 2.0 : 1.6 } : spec;
  if (role === 'lens') return typeof spec === 'string' && spec.startsWith('#') ? { f: 'flat', c: spec, lens: 0.16 } : spec;
  return spec;
}

/**
 * Proyección de caja en el espacio del modelo, en metros: por triángulo se
 * elige el eje dominante de la normal y se proyecta sobre los otros dos (u a
 * lo largo del arma siempre que se pueda). O(vértices).
 */
function boxProjectUV(geo, ou, ov) {
  const pos = geo.attributes.position.array, n = pos.length / 3;
  const uv = new Float32Array(n * 2);
  for (let t = 0; t < n; t += 3) {
    const i = t * 3;
    const ax = pos[i + 3] - pos[i], ay = pos[i + 4] - pos[i + 1], az = pos[i + 5] - pos[i + 2];
    const bx = pos[i + 6] - pos[i], by = pos[i + 7] - pos[i + 1], bz = pos[i + 8] - pos[i + 2];
    const nx = Math.abs(ay * bz - az * by), ny = Math.abs(az * bx - ax * bz), nz = Math.abs(ax * by - ay * bx);
    for (let k = 0; k < 3; k++) {
      const x = pos[i + k * 3], y = pos[i + k * 3 + 1], z = pos[i + k * 3 + 2];
      let u, v;
      if (nx >= ny && nx >= nz) { u = z; v = y; }        // costados: u a lo largo del arma
      else if (ny >= nz) { u = z; v = x; }               // arriba/abajo: también
      else { u = x; v = y; }                              // frente/atrás
      uv[(t + k) * 2] = u + ou; uv[(t + k) * 2 + 1] = v + ov;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/**
 * Junta geometrías no indexadas (posición y normal) en una, y descarta los
 * triángulos de área cero (los perfiles con agujero y bisel dejan algunos, y
 * su normal es 0/0). O(total de vértices).
 */
const MIN_AREA2 = 1e-16;          // (2·área)² mínima: 1e-8 m², muy por debajo de cualquier pieza real
function mergeParts(list) {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) {
    const gi = g.index ? g.toNonIndexed() : g;
    if (!gi.attributes.normal) gi.computeVertexNormals();
    const P = gi.attributes.position.array, N = gi.attributes.normal.array;
    for (let t = 0; t < P.length; t += 9) {
      const ax = P[t + 3] - P[t], ay = P[t + 4] - P[t + 1], az = P[t + 5] - P[t + 2];
      const bx = P[t + 6] - P[t], by = P[t + 7] - P[t + 1], bz = P[t + 8] - P[t + 2];
      const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
      if (cx * cx + cy * cy + cz * cz < MIN_AREA2) continue;
      // una normal rota en un triángulo sano (un vértice degenerado del torno): la de la cara
      let ok = true;
      for (let k = 0; k < 9; k += 3) { const l = N[t + k] * N[t + k] + N[t + k + 1] * N[t + k + 1] + N[t + k + 2] * N[t + k + 2]; if (!(l > 0.25)) { ok = false; break; } }
      for (let k = 0; k < 9; k++) pos[o * 3 + k] = P[t + k];
      if (ok) for (let k = 0; k < 9; k++) nor[o * 3 + k] = N[t + k];
      else { const inv = 1 / Math.sqrt(cx * cx + cy * cy + cz * cz); for (let k = 0; k < 9; k += 3) { nor[o * 3 + k] = cx * inv; nor[o * 3 + k + 1] = cy * inv; nor[o * 3 + k + 2] = cz * inv; } }
      o += 3;
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, o * 3), 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor.slice(0, o * 3), 3));
  return out;
}

const PROTOS = new Map();

/**
 * Construye (o devuelve de la caché) el prototipo del modelo de un arma.
 * `def` es la definición del catálogo: usa def.model (constructor y
 * parámetros) y def.look (paleta). O(piezas + vértices).
 */
export function buildWeaponModel(def) {
  let proto = PROTOS.get(def.key);
  if (proto) return proto;
  const M = def.model || {};
  const builder = BUILDERS[M.b];
  if (!builder) throw new Error(`arma ${def.key}: constructor de modelo desconocido "${M.b}"`);
  const R = new Rig(hashKey(def.key));
  builder(R, M);
  const look = def.look || {};
  // agrupar por (animación, rol)
  const buckets = new Map();
  for (const p of R.parts) {
    const k = p.anim + '|' + p.role;
    let b = buckets.get(k);
    if (!b) buckets.set(k, b = { anim: p.anim, role: p.role, geos: [] });
    b.geos.push(p.g);
  }
  const group = new THREE.Group();
  group.name = 'weapon:' + def.key;
  const anims = {};
  const ou = R.rng() * 3, ov = R.rng() * 3;
  let tris = 0, draws = 0;
  const box = new THREE.Box3(), tmp = new THREE.Box3();
  for (const b of buckets.values()) {
    const geo = mergeParts(b.geos);
    boxProjectUV(geo, ou, ov);
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, finishMaterial(roleSpec(look, b.role)));
    mesh.castShadow = true; mesh.receiveShadow = false;
    mesh.name = b.role;
    tris += geo.attributes.position.count / 3; draws++;
    tmp.copy(geo.boundingBox); box.union(tmp);
    let parent = group;
    if (b.anim) {
      let a = anims[b.anim];
      if (!a) {
        a = new THREE.Group(); a.name = 'anim:' + b.anim;
        const pv = R.anchor.pivot[b.anim] || [0, 0, 0];
        a.position.set(pv[0], pv[1], pv[2]);
        a.userData.pivot = pv;
        group.add(a); anims[b.anim] = a;
      }
      mesh.position.set(-a.position.x, -a.position.y, -a.position.z);   // la pieza queda donde estaba; el grupo gira en el pivote
      parent = a;
    }
    parent.add(mesh);
  }
  const A = R.anchor;
  proto = {
    key: def.key, group, anims: Object.keys(anims),
    muzzle: new THREE.Vector3(...A.muzzle),
    muzzles: (A.muzzles || [A.muzzle]).map(m => new THREE.Vector3(...m)),
    eject: new THREE.Vector3(...A.eject),
    sight: new THREE.Vector3(...A.sight),
    rear: new THREE.Vector3(...A.rear),
    pilot: A.pilot ? new THREE.Vector3(...A.pilot) : null,
    fore: A.fore, foreY: A.foreY || 0,
    slideTravel: A.slideTravel || 0,
    backblast: !!A.backblast, loaded: !!A.loaded, spinAxis: A.spinAxis || 'z',
    bounds: box, length: box.max.z - box.min.z,
    stats: { tris, draws, parts: R.parts.length },
  };
  PROTOS.set(def.key, proto);
  return proto;
}

/**
 * Una instancia usable del modelo: clon del grupo (comparte geometría y
 * materiales) con referencias a los grupos animables y las anclas.
 */
export function instantiateWeapon(def) {
  const P = buildWeaponModel(def);
  const group = P.group.clone(true);
  const anim = {};
  group.traverse((o) => { if (o.name && o.name.startsWith('anim:')) anim[o.name.slice(5)] = o; });
  return {
    key: def.key, proto: P, group, anim,
    muzzle: P.muzzle, muzzles: P.muzzles, eject: P.eject, sight: P.sight, rear: P.rear, pilot: P.pilot,
    muzzleIdx: 0, spin: 0, spinV: 0, cylT: 0, cylA: 0, slide: 0, pump: 0, bolt: 0,
  };
}

/**
 * Anima una instancia (la del juego y la de la galería usan esto mismo):
 * la corredera vuelve, el tambor gira un sexto suavizado, los cañones
 * rotativos siguen el giro previo `spin` (0..1), la bomba va y viene, el
 * cerrojo sube y baja. Los disparadores (inst.slide/cylT/pump/bolt) los pone
 * quien dispara. O(1).
 */
export function animateWeapon(inst, dt, spin = 0) {
  const A = inst.anim, P = inst.proto;
  if (A.slide) A.slide.position.z = -P.slideTravel * inst.slide * inst.slide;
  inst.slide = Math.max(0, inst.slide - dt * 12);
  if (A.cyl) { inst.cylA += (inst.cylT - inst.cylA) * Math.min(1, dt * 16); A.cyl.rotation.z = inst.cylA; }
  if (A.spin) {
    const target = P.spinAxis === 'y' ? 14 : spin * 40;          // el disco del lanzasierras gira siempre
    inst.spinV += (target - inst.spinV) * Math.min(1, dt * 3.5);
    if (P.spinAxis === 'y') A.spin.rotation.y += inst.spinV * dt; else A.spin.rotation.z += inst.spinV * dt;
  }
  if (A.pump) A.pump.position.z = inst.pump > 0 ? -0.075 * Math.sin(Math.PI * (1 - inst.pump)) : 0;
  if (inst.pump > 0) inst.pump = Math.max(0, inst.pump - dt / 0.45);
  if (A.bolt) A.bolt.rotation.z = inst.bolt > 0 ? -1.1 * Math.sin(Math.PI * (1 - inst.bolt)) : 0;
  if (inst.bolt > 0) inst.bolt = Math.max(0, inst.bolt - dt / 0.6);
}
/** Dispara las animaciones de un tiro en una instancia. */
export function kickWeapon(inst) { inst.slide = 1; inst.cylT += Math.PI / 3; inst.pump = 1; inst.bolt = 1; }

/** Borra la caché de prototipos (las pruebas la usan para medir construcciones en frío). */
export function clearWeaponModels() { PROTOS.clear(); }

/**
 * Las specs de acabado que puede pedir el modelo de un arma (cada rol de su
 * paleta y los de la base), sin armar la geometría: sirven para calcular sus
 * texturas de antemano. Puede sobrar alguna de la base (son compartidas). O(roles).
 */
export function weaponFinishSpecs(def) {
  const look = def.look || {};
  const roles = new Set([...Object.keys(BASE_LOOK), ...Object.keys(look)]);
  return [...roles].map(role => roleSpec(look, role));
}
export function weaponModelCount() { return PROTOS.size; }

function hashKey(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export { parseFinish };
