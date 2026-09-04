// ─────────────────────────────────────────────────────────────────────────────
//  moves.js — Biblioteca de movimientos del ragdoll activo.
//
//  No hay clips. Un "movimiento" es una secuencia de POSES OBJETIVO (generadas
//  por funciones, en el espacio local del cuerpo: +Z adelante, +X derecha, Y
//  arriba, origen en el piso bajo la raíz) más un perfil de músculo, más, a
//  veces, movimiento de raíz, un giro de marco o un impulso puntual. Los
//  músculos tiran hacia esas poses y la física hace el resto: por eso una
//  levantada choca con el escritorio de al lado y un tambaleo pisa un cadáver.
//
//  Tres familias:
//   · SECUENCIAS (`SEQ`): caídas, levantadas, muertes, embestidas. Toman el
//     control del cuerpo mientras duran.
//   · OVERLAYS (`OVER`): sacudones por tiro, manotazos, tics de quieto. Se
//     SUMAN a la pose base (la marcha) sin interrumpirla.
//   · ESTILOS (`RUN_STYLES`, `WALK_STYLES`): parámetros que deforman la marcha
//     procedural para que cada cuerpo corra y camine distinto.
// ─────────────────────────────────────────────────────────────────────────────

import { POSE, NP, HEAD, NECK, CHEST, SHL, SHR, ELL, ELR, HAL, HAR, HIP, HPL, HPR, KNL, KNR, FTL, FTR } from './skeleton.js';
import { clamp, clamp01, lerp } from '../core/util.js';

const HALF = Math.PI / 2;
// radios de colisión (unidad) para que ninguna pose pida atravesar el piso
const PRAD_U = [0.130, 0.075, 0.155, 0.095, 0.095, 0.070, 0.070, 0.062, 0.062, 0.145, 0.095, 0.095, 0.080, 0.080, 0.075, 0.075];

// ── largos de miembro en unidad (de la POSE) ─────────────────────────────────
const dist = (a, b) => Math.hypot(POSE[b * 3] - POSE[a * 3], POSE[b * 3 + 1] - POSE[a * 3 + 1], POSE[b * 3 + 2] - POSE[a * 3 + 2]);
const L1 = dist(HPL, KNL), L2 = dist(KNL, FTL);     // muslo, pantorrilla
const A1 = dist(SHL, ELL), A2 = dist(ELL, HAL);     // brazo, antebrazo

// ═══ primitivas sobre la pose T (unidad; se escala al final) ═════════════════
const set = (T, i, x, y, z) => { T[i * 3] = x; T[i * 3 + 1] = y; T[i * 3 + 2] = z; };
const add = (T, i, x, y, z) => { T[i * 3] += x; T[i * 3 + 1] += y; T[i * 3 + 2] += z; };

/** IK de dos huesos genérico: articulación media entre a y c, doblando hacia `bend`. */
function ik2(ax, ay, az, cx, cy, cz, l1, l2, bx, by, bz, out) {
  let dx = cx - ax, dy = cy - ay, dz = cz - az;
  let d = Math.hypot(dx, dy, dz) || 1e-4;
  const maxD = (l1 + l2) * 0.985;
  if (d > maxD) { const f = maxD / d; dx *= f; dy *= f; dz *= f; d = maxD; }
  const ux = dx / d, uy = dy / d, uz = dz / d;
  const a = clamp((l1 * l1 - l2 * l2 + d * d) / (2 * d), -l1, l1);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const dot = bx * ux + by * uy + bz * uz;
  bx -= ux * dot; by -= uy * dot; bz -= uz * dot;
  const bl = Math.hypot(bx, by, bz);
  if (bl > 1e-4) { bx /= bl; by /= bl; bz /= bl; } else { bx = 0; by = 0; bz = 1; }
  out[0] = ax + ux * a + bx * h; out[1] = ay + uy * a + by * h; out[2] = az + uz * a + bz * h;
  return out;
}
const _k = [0, 0, 0];

/** Pierna: pie en (fx,fy,fz), rodilla por IK doblando hacia (kx,ky,kz). */
export function leg(T, side, fx, fy, fz, kx = 0, ky = 0, kz = 1) {
  const hp = side ? HPR : HPL, kn = side ? KNR : KNL, ft = side ? FTR : FTL;
  set(T, ft, fx, fy, fz);
  ik2(T[hp * 3], T[hp * 3 + 1], T[hp * 3 + 2], fx, fy, fz, L1, L2, kx, ky, kz, _k);
  set(T, kn, _k[0], _k[1], _k[2]);
}
/** Brazo: mano en (hx,hy,hz), codo por IK doblando hacia (bx,by,bz). */
export function arm(T, side, hx, hy, hz, bx = 0, by = -1, bz = -0.3) {
  const sh = side ? SHR : SHL, el = side ? ELR : ELL, ha = side ? HAR : HAL;
  set(T, ha, hx, hy, hz);
  ik2(T[sh * 3], T[sh * 3 + 1], T[sh * 3 + 2], hx, hy, hz, A1, A2, bx, by, bz, _k);
  set(T, el, _k[0], _k[1], _k[2]);
}

/**
 * Bloque del tronco (cadera, caderas laterales, pecho, cuello, cabeza, hombros)
 * como cuerpo rígido: cadera en (hx,hy,hz), inclinado `pitch` hacia adelante
 * (radianes, + = se dobla hacia adelante), `roll` lateral (+ = hacia la
 * izquierda) y `yaw` (+ = gira a la izquierda).
 */
export function torso(T, hx, hy, hz, pitch = 0, roll = 0, yaw = 0) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll), cy = Math.cos(yaw), sy = Math.sin(yaw);
  const put = (i, x, y, z) => {
    // yaw → roll → pitch, todo alrededor de la cadera
    let x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
    let x2 = x1 * cr - y * sr, y2 = x1 * sr + y * cr;
    let y3 = y2 * cp - z1 * sp, z3 = y2 * sp + z1 * cp;
    set(T, i, hx + x2, hy + y3, hz + z3);
  };
  put(HIP, 0, 0, 0);
  put(HPL, -0.110, -0.035, 0); put(HPR, 0.110, -0.035, 0);
  put(CHEST, 0, 0.360, 0); put(NECK, 0, 0.590, 0); put(HEAD, 0, 0.760, 0);
  put(SHL, -0.190, 0.490, 0); put(SHR, 0.190, 0.490, 0);
}

/** Rota TODA la pose alrededor del eje X que pasa por (py, pz). */
export function rotX(T, ang, py, pz) {
  const c = Math.cos(ang), s = Math.sin(ang);
  for (let i = 0; i < NP; i++) {
    const y = T[i * 3 + 1] - py, z = T[i * 3 + 2] - pz;
    T[i * 3 + 1] = py + y * c - z * s; T[i * 3 + 2] = pz + y * s + z * c;
  }
}
/** Rota toda la pose alrededor del eje Z que pasa por (px, py). */
export function rotZ(T, ang, px, py) {
  const c = Math.cos(ang), s = Math.sin(ang);
  for (let i = 0; i < NP; i++) {
    const x = T[i * 3] - px, y = T[i * 3 + 1] - py;
    T[i * 3] = px + x * c - y * s; T[i * 3 + 1] = py + x * s + y * c;
  }
}
/** Rota toda la pose alrededor del eje Y que pasa por (px, pz). */
export function rotY(T, ang, px, pz) {
  const c = Math.cos(ang), s = Math.sin(ang);
  for (let i = 0; i < NP; i++) {
    const x = T[i * 3] - px, z = T[i * 3 + 2] - pz;
    T[i * 3] = px + x * c + z * s; T[i * 3 + 2] = pz - x * s + z * c;
  }
}
export function translate(T, dx, dy, dz) { for (let i = 0; i < NP; i++) { T[i * 3] += dx; T[i * 3 + 1] += dy; T[i * 3 + 2] += dz; } }
/** Nada por debajo del piso: cada partícula al menos a su radio. */
export function floorClamp(T, extra = 0.005) { for (let i = 0; i < NP; i++) { const m = PRAD_U[i] + extra; if (T[i * 3 + 1] < m) T[i * 3 + 1] = m; } }
/** Deja la cadera a la altura `hy` moviendo toda la pose. */
function hipTo(T, hy) { translate(T, 0, hy - T[HIP * 3 + 1], 0); }

// ═══ POSES (unidad) ══════════════════════════════════════════════════════════
//  Cada una escribe la pose completa en T. `s` = lado (0 izq, 1 der) para las
//  asimétricas; `ctx` trae parámetros del movimiento.
export const P = {};

P.stand = (T) => { for (let i = 0; i < NP * 3; i++) T[i] = POSE[i]; };

/** Agachado k (0 parado … 1 muy agachado). */
P.crouch = (T, k = 1) => {
  if (typeof k !== 'number') k = 1;
  torso(T, 0, 0.96 - 0.40 * k, -0.02 * k, 0.40 * k);
  leg(T, 0, -0.15, 0.062, 0.06 * k, -0.15, 0, 1); leg(T, 1, 0.15, 0.062, 0.06 * k, 0.15, 0, 1);
  arm(T, 0, -0.26, 0.86 - 0.15 * k, 0.30 * k + 0.05, -0.8, -0.5, -0.3); arm(T, 1, 0.26, 0.86 - 0.15 * k, 0.30 * k + 0.05, 0.8, -0.5, -0.3);
};
/** Cuclillas profundas, manos adelante en el piso (la posición previa a pararse). */
P.squat = (T) => {
  torso(T, 0, 0.46, -0.04, 0.65);
  leg(T, 0, -0.18, 0.062, 0.14, -0.2, 0.3, 1); leg(T, 1, 0.18, 0.062, 0.14, 0.2, 0.3, 1);
  arm(T, 0, -0.30, 0.10, 0.42, -0.9, -0.2, 0.1); arm(T, 1, 0.30, 0.10, 0.42, 0.9, -0.2, 0.1);
};
/** De rodillas, tronco derecho, pantorrillas hacia atrás en el piso. */
P.kneelUp = (T) => {
  torso(T, 0, 0.50, 0, 0.05);
  set(T, KNL, -0.12, 0.09, 0.02); set(T, KNR, 0.12, 0.09, 0.02);
  set(T, FTL, -0.12, 0.08, -0.44); set(T, FTR, 0.12, 0.08, -0.44);
  arm(T, 0, -0.27, 0.42, 0.10, -0.8, -0.4, -0.3); arm(T, 1, 0.27, 0.42, 0.10, 0.8, -0.4, -0.3);
};
/** Una rodilla en el piso y el otro pie plantado adelante; la mano sobre esa rodilla. */
P.kneelOne = (T, s = 1) => {
  if (typeof s !== 'number') s = 1;
  const sx = s ? 1 : -1;
  torso(T, 0, 0.55, 0.02, 0.28);
  // pierna plantada
  leg(T, s, sx * 0.17, 0.062, 0.32, sx * 0.2, 0.2, 1);
  // pierna de rodillas
  set(T, s ? KNL : KNR, -sx * 0.12, 0.09, -0.06); set(T, s ? FTL : FTR, -sx * 0.12, 0.08, -0.52);
  arm(T, s, sx * 0.22, 0.56, 0.34, sx * 0.9, -0.2, 0.2); arm(T, s ? 0 : 1, -sx * 0.27, 0.72, 0.30, -sx * 0.8, -0.5, -0.2);
};
/** En cuatro patas. `reach` (−1..1) alterna manos y rodillas para gatear. */
P.allFours = (T, reach = 0) => {
  if (typeof reach !== 'number') reach = 0;
  torso(T, 0, 0.55, 0, 1.30);
  add(T, HEAD, 0, 0.10, 0.02); add(T, NECK, 0, 0.05, 0);
  arm(T, 0, -0.22, 0.065, 0.52 + reach * 0.18, -0.6, 0.3, -0.8); arm(T, 1, 0.22, 0.065, 0.52 - reach * 0.18, 0.6, 0.3, -0.8);
  set(T, KNL, -0.12, 0.09, -0.02 - reach * 0.12); set(T, FTL, -0.12, 0.08, -0.47 - reach * 0.12);
  set(T, KNR, 0.12, 0.09, -0.02 + reach * 0.12); set(T, FTR, 0.12, 0.08, -0.47 + reach * 0.12);
};
/** Boca abajo con las manos bajo los hombros (flexión baja). */
P.pushupLow = (T) => {
  torso(T, 0, 0.17, 0, 1.55);
  arm(T, 0, -0.28, 0.07, 0.40, -0.5, 1, -0.3); arm(T, 1, 0.28, 0.07, 0.40, 0.5, 1, -0.3);
  set(T, KNL, -0.12, 0.10, -0.40); set(T, KNR, 0.12, 0.10, -0.40);
  set(T, FTL, -0.12, 0.08, -0.85); set(T, FTR, 0.12, 0.08, -0.85);
  floorClamp(T);
};
/** Cobra: pecho arriba con los brazos, caderas todavía en el piso. */
P.pushupHigh = (T) => {
  torso(T, 0, 0.24, 0, 1.05);
  arm(T, 0, -0.26, 0.07, 0.42, -0.4, 0.5, -0.8); arm(T, 1, 0.26, 0.07, 0.42, 0.4, 0.5, -0.8);
  set(T, KNL, -0.12, 0.10, -0.40); set(T, KNR, 0.12, 0.10, -0.40);
  set(T, FTL, -0.12, 0.08, -0.85); set(T, FTR, 0.12, 0.08, -0.85);
  floorClamp(T);
};
/** Sentado, rodillas dobladas, manos al piso a los costados. */
P.sit = (T, lean = 0.15) => {
  if (typeof lean !== 'number') lean = 0.15;
  torso(T, 0, 0.20, 0, lean);
  set(T, KNL, -0.13, 0.40, 0.36); set(T, KNR, 0.13, 0.40, 0.36);
  set(T, FTL, -0.14, 0.062, 0.62); set(T, FTR, 0.14, 0.062, 0.62);
  arm(T, 0, -0.33, 0.07, -0.10, -0.9, 0.3, -0.3); arm(T, 1, 0.33, 0.07, -0.10, 0.9, 0.3, -0.3);
  floorClamp(T);
};
/** Sentado echado atrás, manos apoyadas detrás. */
P.sitBack = (T) => {
  P.sit(T, -0.25);
  arm(T, 0, -0.30, 0.07, -0.32, -0.9, 0.4, -0.3); arm(T, 1, 0.30, 0.07, -0.32, 0.9, 0.4, -0.3);
  floorClamp(T);
};
/** Sentado desplomado hacia adelante (manos en el piso entre las rodillas). */
P.sitSlump = (T) => {
  P.sit(T, 0.7);
  add(T, HEAD, 0, -0.06, 0.06);
  arm(T, 0, -0.22, 0.07, 0.34, -0.9, -0.2, 0); arm(T, 1, 0.22, 0.07, 0.34, 0.9, -0.2, 0);
  floorClamp(T);
};
/** Boca arriba, brazos a los costados. Cabeza hacia −Z. */
P.supine = (T) => { P.stand(T); rotX(T, -HALF, 0.96, 0); hipTo(T, 0.18); floorClamp(T); };
/** Boca arriba con las rodillas levantadas y los pies apoyados; manos que empujan el piso. */
P.supineKnees = (T) => {
  P.supine(T);
  set(T, KNL, -0.13, 0.42, 0.40); set(T, KNR, 0.13, 0.42, 0.40);
  set(T, FTL, -0.14, 0.062, 0.62); set(T, FTR, 0.14, 0.062, 0.62);
  arm(T, 0, -0.36, 0.07, 0.05, -1, 0, 0); arm(T, 1, 0.36, 0.07, 0.05, 1, 0, 0);
  add(T, HEAD, 0, 0.10, 0.08); add(T, NECK, 0, 0.05, 0.03);
  floorClamp(T);
};
/** Boca arriba hecho un bollo: rodillas al pecho, manos a las rodillas. */
P.supineTuck = (T) => {
  P.supine(T);
  set(T, KNL, -0.13, 0.50, -0.05); set(T, KNR, 0.13, 0.50, -0.05);
  set(T, FTL, -0.14, 0.30, 0.22); set(T, FTR, 0.14, 0.30, 0.22);
  arm(T, 0, -0.20, 0.45, -0.02, -1, 0.2, 0); arm(T, 1, 0.20, 0.45, -0.02, 1, 0.2, 0);
  add(T, HEAD, 0, 0.14, 0.12); add(T, NECK, 0, 0.07, 0.05);
  floorClamp(T);
};
/** Boca arriba rodando `ang` sobre su eje largo (Z): ±90° de costado con la cabeza a −Z, 180° boca abajo con la cabeza a −Z. */
P.supineRoll = (T, ang = HALF) => { if (typeof ang !== 'number') ang = HALF; P.supine(T); rotZ(T, ang, 0, T[HIP * 3 + 1]); hipTo(T, Math.abs(Math.sin(ang)) > 0.5 ? 0.21 : 0.18); add(T, KNL, 0, 0, 0.06); add(T, KNR, 0, 0, 0.06); floorClamp(T); };
/** Boca abajo rodando `ang` sobre su eje largo: 180° = boca arriba con la cabeza a +Z. */
P.proneRoll = (T, ang = HALF) => { if (typeof ang !== 'number') ang = HALF; P.prone(T); rotZ(T, ang, 0, T[HIP * 3 + 1]); hipTo(T, Math.abs(Math.sin(ang)) > 0.5 ? 0.21 : 0.18); floorClamp(T); };
/** Boca abajo, brazos a los costados. Cabeza hacia +Z. */
P.prone = (T) => { P.stand(T); rotX(T, HALF, 0.96, 0); hipTo(T, 0.18); floorClamp(T); };
/** Boca abajo con una rodilla recogida debajo y las manos bajo los hombros. */
P.proneKnee = (T, s = 1) => {
  if (typeof s !== 'number') s = 1;
  const sx = s ? 1 : -1;
  P.pushupLow(T);
  set(T, s ? KNR : KNL, sx * 0.20, 0.12, 0.02); set(T, s ? FTR : FTL, sx * 0.24, 0.09, -0.28);
  floorClamp(T);
};
/** De costado: sobre el lado derecho (s=1: cabeza a +X) o izquierdo (s=0: cabeza a −X); la panza mira a +Z. */
P.side = (T, s = 1) => {
  if (typeof s !== 'number') s = 1;
  P.stand(T); rotZ(T, s ? -HALF : HALF, 0, 0.96); hipTo(T, 0.21);
  // las piernas se doblan un poco (nadie queda tieso de costado)
  const sx = s ? 1 : -1;
  add(T, KNL, 0, 0, 0.10); add(T, KNR, 0, 0, 0.10); add(T, FTL, 0, 0, 0.16); add(T, FTR, 0, 0, 0.16);
  add(T, s ? HAR : HAL, -sx * 0.10, 0.02, 0.18);   // el brazo de abajo, adelante
  floorClamp(T);
};
/** De costado apoyado en el codo de abajo, la cadera despegando. */
P.sideProp = (T, s = 1) => {
  if (typeof s !== 'number') s = 1;
  P.side(T, s);
  const sx = s ? 1 : -1;
  // el tronco se levanta girando alrededor del codo: cabeza y pecho suben
  add(T, HEAD, -sx * 0.06, 0.30, 0.02); add(T, NECK, -sx * 0.04, 0.24, 0.01); add(T, CHEST, -sx * 0.02, 0.14, 0);
  add(T, SHL, 0, 0.14, 0); add(T, SHR, 0, 0.14, 0); add(T, HIP, 0, 0.08, 0); add(T, HPL, 0, 0.08, 0); add(T, HPR, 0, 0.08, 0);
  set(T, s ? ELR : ELL, sx * 0.30, 0.08, 0.12); set(T, s ? HAR : HAL, sx * 0.08, 0.07, 0.30);
  set(T, s ? HAL : HAR, sx * 0.10, 0.07, 0.42);   // la mano de arriba también empuja
  floorClamp(T);
};
/** Tabla hacia atrás: el cuerpo parado pivota sobre los pies `ang` radianes (cabeza a −Z). */
P.dominoBack = (T, ang = 0.9) => { if (typeof ang !== 'number') ang = 0.9; P.armsOut(T); rotX(T, -ang, 0.06, 0.03); floorClamp(T); };
/** Tabla hacia adelante, manos al frente para frenar. */
P.dominoFront = (T, ang = 0.9) => {
  if (typeof ang !== 'number') ang = 0.9;
  P.stand(T); arm(T, 0, -0.26, 1.10, 0.55, -0.6, 0.8, -0.3); arm(T, 1, 0.26, 1.10, 0.55, 0.6, 0.8, -0.3);
  rotX(T, ang, 0.06, 0.03); floorClamp(T);
};
/** Tabla de costado (s=1 cae a la derecha), el brazo de ese lado sale a frenar. */
P.dominoSide = (T, s = 1, ang = 0.9) => {
  if (typeof s !== 'number') s = 1; if (typeof ang !== 'number') ang = 0.9;
  const sx = s ? 1 : -1;
  P.stand(T); arm(T, s, sx * 0.62, 1.05, 0.10, 0, -1, 0); arm(T, s ? 0 : 1, -sx * 0.30, 1.30, 0.15, -sx * 0.5, 0.8, 0);
  rotZ(T, -sx * ang, sx * 0.12, 0.06); floorClamp(T);
};
/** Parado con los brazos en cruz (objetivo débil para una caída "de tabla"). */
P.armsOut = (T) => { P.stand(T); arm(T, 0, -0.62, 1.40, 0.04, 0, -1, 0); arm(T, 1, 0.62, 1.40, 0.04, 0, -1, 0); };
/** Parado doblado por el estómago, manos a la panza. */
P.doubleOver = (T) => {
  torso(T, 0, 0.90, -0.04, 1.0);
  leg(T, 0, -0.14, 0.062, 0.04, -0.1, 0, 1); leg(T, 1, 0.14, 0.062, 0.04, 0.1, 0, 1);
  arm(T, 0, -0.10, 0.92, 0.18, -0.9, -0.3, 0.3); arm(T, 1, 0.10, 0.92, 0.18, 0.9, -0.3, 0.3);
};
/** Rodillas al pecho y cabeza metida: la voltereta. */
P.tuck = (T) => {
  torso(T, 0, 0.55, 0, 1.15);
  set(T, KNL, -0.13, 0.55, 0.30); set(T, KNR, 0.13, 0.55, 0.30);
  set(T, FTL, -0.14, 0.20, 0.20); set(T, FTR, 0.14, 0.20, 0.20);
  arm(T, 0, -0.22, 0.40, 0.40, -1, 0, 0); arm(T, 1, 0.22, 0.40, 0.40, 1, 0, 0);
  add(T, HEAD, 0, -0.12, 0.06);
};
/** Tirado en plancha hacia adelante, brazos extendidos (tacle en el aire). */
P.dive = (T) => {
  torso(T, 0, 0.75, 0.10, 1.35);
  arm(T, 0, -0.24, 0.80, 0.85, -0.5, 1, 0); arm(T, 1, 0.24, 0.80, 0.85, 0.5, 1, 0);
  set(T, KNL, -0.12, 0.60, -0.35); set(T, KNR, 0.12, 0.60, -0.35);
  set(T, FTL, -0.12, 0.50, -0.78); set(T, FTR, 0.12, 0.50, -0.78);
};
/** Sentado contra una pared / en el piso, manos en las rodillas, cabeza gacha. */
P.sitRest = (T) => {
  P.sit(T, 0.35);
  add(T, HEAD, 0, -0.08, 0.05);
  arm(T, 0, -0.16, 0.44, 0.34, -0.9, -0.3, 0.2); arm(T, 1, 0.16, 0.44, 0.34, 0.9, -0.3, 0.2);
  floorClamp(T);
};
/** Arrodillado inclinado sobre algo adelante (comiendo). */
P.kneelFeed = (T) => {
  P.kneelUp(T);
  torso(T, 0, 0.50, 0.04, 0.95);
  arm(T, 0, -0.16, 0.16, 0.48, -0.9, -0.2, 0.2); arm(T, 1, 0.16, 0.16, 0.48, 0.9, -0.2, 0.2);
  floorClamp(T);
};

// ── mezcla de dos poses (para transiciones continuas) ────────────────────────
const _pa = new Float32Array(NP * 3), _pb = new Float32Array(NP * 3);
/** T = a·(1−u) + b·u, con `a` y `b` funciones de pose (ya con sus parámetros). */
export function blend(T, a, b, u) {
  u = clamp01(u);
  a(_pa); b(_pb);
  for (let i = 0; i < NP * 3; i++) T[i] = _pa[i] + (_pb[i] - _pa[i]) * u;
}
/** Suavizado 0..1 → 0..1 con derivada nula en los extremos. */
const ss = (u) => { u = clamp01(u); return u * u * (3 - 2 * u); };
/** Tramo: u ∈ [a,b] → 0..1 suavizado. */
const seg = (u, a, b) => ss((u - a) / (b - a));

// ═══ POSES EN EL AIRE (saltos, brincos, lanzarse) ════════════════════════════
//  La altura del salto la pone el arco balístico del ragdoll (la pose se ancla
//  a esa altura): acá la cadera va a 0.96 como parado y las piernas hacen la
//  figura. `s` = lado que va adelante.

/** Agachado para saltar: brazos atrás, tronco adelante (k = cuánto). */
P.leapPrep = (T, k = 1) => {
  if (typeof k !== 'number') k = 1;
  torso(T, 0, 0.96 - 0.34 * k, -0.02 * k, 0.45 * k);
  leg(T, 0, -0.15, 0.062, 0.02, -0.15, 0, 1); leg(T, 1, 0.15, 0.062, 0.02, 0.15, 0, 1);
  arm(T, 0, -0.30, 0.66, -0.32 * k, -0.8, 0.2, -0.6); arm(T, 1, 0.30, 0.66, -0.32 * k, 0.8, 0.2, -0.6);
};
/** Saltito con los dos pies: rodillas apenas recogidas, brazos un poco afuera. */
P.airHop = (T, k = 1) => {
  if (typeof k !== 'number') k = 1;
  torso(T, 0, 0.96, 0, 0.12);
  leg(T, 0, -0.14, 0.30 + 0.05 * k, 0.12, -0.2, 0.3, 1); leg(T, 1, 0.14, 0.30 + 0.05 * k, 0.12, 0.2, 0.3, 1);
  arm(T, 0, -0.40, 0.95, 0.10, -0.9, -0.4, -0.3); arm(T, 1, 0.40, 0.95, 0.10, 0.9, -0.4, -0.3);
};
/** Bollo: rodillas al pecho, brazos adelante y abajo. */
P.airTuck = (T) => {
  torso(T, 0, 0.96, 0, 0.32);
  leg(T, 0, -0.14, 0.58, 0.18, 0, 0.6, 1); leg(T, 1, 0.14, 0.58, 0.18, 0, 0.6, 1);
  arm(T, 0, -0.28, 0.98, 0.38, -0.8, -0.3, -0.4); arm(T, 1, 0.28, 0.98, 0.38, 0.8, -0.3, -0.4);
};
/** Zancada larga en el aire: una pierna estirada adelante, la otra atrás; brazos en oposición. */
P.airSplit = (T, s = 1) => {
  if (typeof s !== 'number') s = 1;
  const sx = s ? 1 : -1;
  torso(T, 0, 0.96, 0, 0.22);
  leg(T, s, sx * 0.13, 0.55, 0.60, 0, 0.7, 1);          // adelante
  leg(T, s ? 0 : 1, -sx * 0.13, 0.70, -0.52, 0, 1, -0.4); // atrás, doblada
  arm(T, s, sx * 0.30, 0.92, -0.35, sx * 0.7, 0.2, -0.7);          // brazo del lado de la pierna adelantada: atrás
  arm(T, s ? 0 : 1, -sx * 0.28, 1.25, 0.42, -sx * 0.7, -0.3, -0.5); // el otro: adelante
};
/** Plancha: brazos estirados al frente, tronco echado adelante, piernas atrás. */
P.airSuperman = (T) => {
  torso(T, 0, 0.96, 0, 0.80);
  leg(T, 0, -0.13, 0.55, -0.52, 0, 0.5, -1); leg(T, 1, 0.13, 0.55, -0.52, 0, 0.5, -1);
  arm(T, 0, -0.20, 1.42, 0.88, -0.5, 0.8, 0); arm(T, 1, 0.20, 1.42, 0.88, 0.5, 0.8, 0);
  add(T, HEAD, 0, 0.04, 0.02);
};
/** Patada voladora: una pierna estirada al frente y arriba, la otra recogida. */
P.airKick = (T, s = 1) => {
  if (typeof s !== 'number') s = 1;
  const sx = s ? 1 : -1;
  torso(T, 0, 0.96, 0, -0.22);
  leg(T, s, sx * 0.12, 0.92, 0.68, 0, 1, 0.3);
  leg(T, s ? 0 : 1, -sx * 0.14, 0.45, 0.10, -sx * 0.3, 0.3, 1);
  arm(T, 0, -0.55, 1.20, -0.10, -0.6, -0.6, -0.5); arm(T, 1, 0.55, 1.20, -0.10, 0.6, -0.6, -0.5);
};
/** Rodillazo volador: una rodilla alta, brazos que agarran adelante. */
P.airKnee = (T, s = 1) => {
  if (typeof s !== 'number') s = 1;
  const sx = s ? 1 : -1;
  torso(T, 0, 0.96, 0, 0.30);
  leg(T, s, sx * 0.13, 0.72, 0.36, 0, 1, 1);
  leg(T, s ? 0 : 1, -sx * 0.13, 0.55, -0.35, 0, 0.6, -1);
  arm(T, 0, -0.24, 1.28, 0.46, -0.8, -0.3, -0.3); arm(T, 1, 0.24, 1.28, 0.46, 0.8, -0.3, -0.3);
};
/** Estrella: brazos y piernas abiertos. */
P.airStar = (T) => {
  torso(T, 0, 0.96, 0, 0.05);
  leg(T, 0, -0.45, 0.42, 0.05, -1, 0, 0.3); leg(T, 1, 0.45, 0.42, 0.05, 1, 0, 0.3);
  arm(T, 0, -0.60, 1.65, 0.05, -0.5, 1, 0); arm(T, 1, 0.60, 1.65, 0.05, 0.5, 1, 0);
};
/** Manotea el aire: piernas pedaleando y brazos en molino (ph = fase). */
P.airFlail = (T, ph = 0) => {
  if (typeof ph !== 'number') ph = 0;
  torso(T, 0, 0.96, 0, 0.18);
  for (let side = 0; side < 2; side++) {
    const sx = side ? 1 : -1, p = ph + (side ? Math.PI : 0);
    leg(T, side, sx * 0.13, 0.42 + 0.22 * Math.sin(p), 0.32 * Math.cos(p), 0, 0.6, 1);
    const a = p * 1.3 + 1;
    arm(T, side, sx * 0.34, 1.30 + 0.32 * Math.sin(a), 0.32 * Math.cos(a), sx * 0.7, 0.3, -0.3);
  }
};
/** Brinco a la carrera (skip): una pierna doblada adelante, la otra atrás; brazos bombeando. */
P.airSkip = (T, s = 1) => {
  if (typeof s !== 'number') s = 1;
  const sx = s ? 1 : -1;
  torso(T, 0, 0.96, 0, 0.16);
  leg(T, s, sx * 0.13, 0.52, 0.38, 0, 0.5, 1);
  leg(T, s ? 0 : 1, -sx * 0.13, 0.34, -0.26, 0, 0.8, -0.6);
  arm(T, s, sx * 0.28, 0.95, -0.22, sx * 0.6, 0.2, -0.8);
  arm(T, s ? 0 : 1, -sx * 0.26, 1.18, 0.34, -sx * 0.6, -0.4, -0.6);
};
/** Cayendo de una altura: brazos afuera, rodillas listas, mirando abajo. */
P.airDrop = (T) => {
  torso(T, 0, 0.96, 0, 0.28);
  leg(T, 0, -0.16, 0.30, 0.14, -0.2, 0.4, 1); leg(T, 1, 0.16, 0.30, 0.14, 0.2, 0.4, 1);
  arm(T, 0, -0.52, 1.28, 0.12, -0.6, -0.4, -0.5); arm(T, 1, 0.52, 1.28, 0.12, 0.6, -0.4, -0.5);
  add(T, HEAD, 0, -0.04, 0.06);
};
/** Valla: pierna guía doblada y alta, pierna de atrás recogida de costado. */
P.hurdle = (T, s = 1) => {
  if (typeof s !== 'number') s = 1;
  const sx = s ? 1 : -1;
  torso(T, 0, 0.96, 0, 0.40);
  leg(T, s, sx * 0.15, 0.62, 0.48, 0, 1, 0.8);
  leg(T, s ? 0 : 1, -sx * 0.40, 0.70, -0.15, -sx * 1, 0.5, 0);
  arm(T, s, sx * 0.30, 0.80, -0.30, sx * 0.6, 0.3, -0.7);
  arm(T, s ? 0 : 1, -sx * 0.25, 1.30, 0.50, -sx * 0.5, -0.3, -0.5);
};
/** Aterrizar: cuclillas profundas, brazos adelante y abajo para equilibrar (k = profundidad). */
P.land = (T, k = 1) => {
  if (typeof k !== 'number') k = 1;
  torso(T, 0, 0.96 - 0.42 * k, -0.02 * k, 0.55 * k);
  leg(T, 0, -0.17, 0.062, 0.05, -0.2, 0, 1); leg(T, 1, 0.17, 0.062, 0.05, 0.2, 0, 1);
  arm(T, 0, -0.32, 0.90 - 0.22 * k, 0.40, -0.7, -0.5, -0.3); arm(T, 1, 0.32, 0.90 - 0.22 * k, 0.40, 0.7, -0.5, -0.3);
};

// ═══ RODAR ═══════════════════════════════════════════════════════════════════
//  Bollo compacto girando sobre su centro. Estas poses se anclan al CENTRO de
//  la pose (`anchor: 'center'` en la secuencia): el centro avanza y el cuerpo
//  gira alrededor, como una pelota.
const BALL_Y = 0.36, BALL_Z = 0.06;
/** El bollo apoyado en el piso, sin girar (cabeza metida, manos en las rodillas). */
P.ball = (T) => {
  torso(T, 0, 0.36, 0.02, 1.25);
  leg(T, 0, -0.14, 0.12, 0.28, -0.2, 0.8, 0.6); leg(T, 1, 0.14, 0.12, 0.28, 0.2, 0.8, 0.6);
  arm(T, 0, -0.22, 0.28, 0.40, -1, 0.2, 0.2); arm(T, 1, 0.22, 0.28, 0.40, 1, 0.2, 0.2);
  add(T, HEAD, 0, -0.10, 0.04); add(T, NECK, 0, -0.05, 0.02);
};
/** Rodada hacia adelante: el bollo girado `ang` (el frente baja primero). */
P.roll = (T, ang = 0) => { if (typeof ang !== 'number') ang = 0; P.ball(T); rotX(T, ang, BALL_Y, BALL_Z); floorClamp(T, 0.0); };
/** Rodada hacia atrás: la espalda baja primero. */
P.rollBack = (T, ang = 0) => { if (typeof ang !== 'number') ang = 0; P.ball(T); rotX(T, -ang, BALL_Y, BALL_Z); floorClamp(T, 0.0); };
/** Rodada de hombro (parkour): el bollo inclinado, rueda por la diagonal del hombro. */
P.rollShoulder = (T, ang = 0, s = 1) => {
  if (typeof ang !== 'number') ang = 0; if (typeof s !== 'number') s = 1;
  P.ball(T);
  rotY(T, (s ? -1 : 1) * 0.55, 0, BALL_Z);
  rotX(T, ang, BALL_Y, BALL_Z);
  floorClamp(T, 0.0);
};

// ═══ TREPAR / BAJAR ══════════════════════════════════════════════════════════
//  El ancla sube del piso a la tapa mientras dura el movimiento (o baja, al
//  descender). `rel` = altura de la tapa RESPECTO del ancla en este instante:
//  las manos que se apoyan van a `rel` (+ un poco).
const H = (rel, o = 0.05) => Math.max(0.10, rel + o);
/** Trepada clásica: manos al borde, una rodilla arriba, se estira. */
P.clamber = (T, u = 0, rel = 0.7, s = 1) => {
  if (typeof u !== 'number') u = 0; if (typeof rel !== 'number') rel = 0.7; if (typeof s !== 'number') s = 1;
  const sx = s ? 1 : -1;
  if (u < 0.35) {
    // agacharse y poner las manos
    const k = seg(u, 0, 0.35);
    torso(T, 0, 0.96 - 0.28 * k, -0.02 * k, 0.55 * k);
    leg(T, 0, -0.15, 0.062, 0.05, -0.2, 0, 1); leg(T, 1, 0.15, 0.062, 0.05, 0.2, 0, 1);
    arm(T, 0, -0.22, lerp(0.90, H(rel), k), lerp(0.30, 0.48, k), -0.8, -0.3, -0.4); arm(T, 1, 0.22, lerp(0.90, H(rel), k), lerp(0.30, 0.48, k), 0.8, -0.3, -0.4);
  } else if (u < 0.75) {
    // rodilla guía a la tapa, la otra pierna empuja abajo
    const k = seg(u, 0.35, 0.75);
    torso(T, 0, 0.70 + 0.10 * k, -0.02, 0.85 - 0.25 * k);
    leg(T, s, sx * 0.16, H(rel, 0.08) * (1 - k) + 0.062 * k, 0.40 + 0.10 * k, sx * 0.3, 1, 0.8);
    leg(T, s ? 0 : 1, -sx * 0.14, 0.062 * (1 - k) + H(rel, 0.10) * k, -0.10 + 0.45 * k, -sx * 0.3, 0.8, 0.5);
    arm(T, 0, -0.24, H(rel), 0.42, -0.8, -0.3, -0.3); arm(T, 1, 0.24, H(rel), 0.42, 0.8, -0.3, -0.3);
  } else {
    const k = seg(u, 0.75, 1);
    torso(T, 0, 0.80 + 0.16 * k, 0, 0.60 - 0.55 * k);
    leg(T, 0, -0.15, 0.062, 0.12 * (1 - k), -0.2, 0, 1); leg(T, 1, 0.15, 0.062, 0.05, 0.2, 0, 1);
    arm(T, 0, -0.26, lerp(0.40, 0.86, k), lerp(0.40, 0.10, k), -0.8, -0.4, -0.3); arm(T, 1, 0.26, lerp(0.40, 0.86, k), lerp(0.40, 0.10, k), 0.8, -0.4, -0.3);
  }
  floorClamp(T, 0.0);
};
/** Pasada rápida: una mano apoyada, las piernas cruzan de costado por encima, el cuerpo casi horizontal. */
P.speedVault = (T, u = 0, rel = 0.7, s = 1) => {
  if (typeof u !== 'number') u = 0; if (typeof rel !== 'number') rel = 0.7; if (typeof s !== 'number') s = 1;
  const sx = s ? 1 : -1;
  const k = seg(u, 0.15, 0.55), k2 = seg(u, 0.55, 1);
  // el tronco se inclina hacia la mano y gira un poco
  torso(T, sx * 0.10 * k * (1 - k2), 0.96 - 0.20 * k * (1 - k2), 0.02, 0.55 * k * (1 - k2), sx * 0.45 * k * (1 - k2), -sx * 0.35 * k * (1 - k2));
  // piernas: cruzan del lado opuesto a la mano, estiradas y altas
  leg(T, s, sx * 0.05 - sx * 0.35 * k * (1 - k2), lerp(0.062, 0.80, k) * (1 - k2) + 0.062 * k2, lerp(0.10, 0.30, k), -sx * 0.6, 0.8, 0.4);
  leg(T, s ? 0 : 1, -sx * 0.12 - sx * 0.40 * k * (1 - k2), lerp(0.062, 0.70, k) * (1 - k2) + 0.062 * k2, lerp(-0.05, 0.15, k), -sx * 0.8, 0.6, 0.3);
  // mano de apoyo del lado `s`; la otra afuera para equilibrar
  arm(T, s, sx * 0.30, lerp(0.95, H(rel, 0.04), k) * (1 - k2) + 0.86 * k2, lerp(0.25, 0.30, k), sx * 0.9, -0.2, -0.3);
  arm(T, s ? 0 : 1, -sx * 0.45, lerp(1.0, 1.35, k) * (1 - k2) + 0.86 * k2, 0.15, -sx * 0.6, -0.6, -0.4);
  floorClamp(T, 0.0);
};
/** Kong: dos manos adelante, cadera arriba, las piernas pasan recogidas entre los brazos. */
P.kong = (T, u = 0, rel = 0.7) => {
  if (typeof u !== 'number') u = 0; if (typeof rel !== 'number') rel = 0.7;
  const dive = seg(u, 0, 0.35), thru = seg(u, 0.35, 0.75), land = seg(u, 0.75, 1);
  torso(T, 0, 0.96 - 0.12 * dive + 0.10 * thru - 0.05 * land, 0, 1.10 * dive - 0.30 * thru - 0.55 * land);
  const hy = lerp(1.0, H(rel, 0.04), dive) * (1 - land) + 0.90 * land;
  arm(T, 0, -0.22, hy, lerp(0.45, 0.50, dive) * (1 - land) + 0.25 * land, -0.5, 0.5, -0.6);
  arm(T, 1, 0.22, hy, lerp(0.45, 0.50, dive) * (1 - land) + 0.25 * land, 0.5, 0.5, -0.6);
  // piernas: atrás y estiradas → recogidas al pecho → adelante para apoyar
  const fy = 0.062 * (1 - dive) + 0.45 * dive * (1 - thru) + 0.62 * thru * (1 - land) + 0.062 * land;
  const fz = -0.15 * dive * (1 - thru) + 0.12 * thru * (1 - land) + 0.30 * land;
  leg(T, 0, -0.13, fy, fz, 0, 0.9, 0.6); leg(T, 1, 0.13, fy, fz, 0, 0.9, 0.6);
  floorClamp(T, 0.0);
};
/** Dash: primero saltan las piernas adelante (como sentándose en el aire), las manos tocan después atrás. */
P.dashVault = (T, u = 0, rel = 0.7) => {
  if (typeof u !== 'number') u = 0; if (typeof rel !== 'number') rel = 0.7;
  const up = seg(u, 0, 0.4), dn = seg(u, 0.6, 1);
  torso(T, 0, 0.96, 0, -0.30 * up * (1 - dn) + 0.30 * dn);
  leg(T, 0, -0.14, lerp(0.062, 0.62, up) * (1 - dn) + 0.062 * dn, lerp(0.05, 0.62, up) * (1 - dn) + 0.15 * dn, 0, 0.8, 1);
  leg(T, 1, 0.14, lerp(0.062, 0.62, up) * (1 - dn) + 0.062 * dn, lerp(0.05, 0.62, up) * (1 - dn) + 0.15 * dn, 0, 0.8, 1);
  const touch = seg(u, 0.3, 0.6) * (1 - dn);
  arm(T, 0, -0.30, lerp(1.05, H(rel, 0.04), touch) * (1 - dn) + 0.90 * dn, lerp(0.20, -0.15, touch) * (1 - dn) + 0.30 * dn, -0.9, 0.2, -0.4);
  arm(T, 1, 0.30, lerp(1.05, H(rel, 0.04), touch) * (1 - dn) + 0.90 * dn, lerp(0.20, -0.15, touch) * (1 - dn) + 0.30 * dn, 0.9, 0.2, -0.4);
  floorClamp(T, 0.0);
};
/** Boca abajo por encima: manos al borde, se tira de panza sobre la tapa y resbala, después baja las piernas. */
P.rollOver = (T, u = 0, rel = 0.7) => {
  if (typeof u !== 'number') u = 0; if (typeof rel !== 'number') rel = 0.7;
  if (u < 0.35) {
    const k = seg(u, 0, 0.35);
    torso(T, 0, 0.96 - 0.35 * k, 0, 1.15 * k);
    leg(T, 0, -0.14, 0.062, 0.05 - 0.10 * k, -0.2, 0.2, 1); leg(T, 1, 0.14, 0.062, 0.05 - 0.10 * k, 0.2, 0.2, 1);
    arm(T, 0, -0.24, lerp(0.95, H(rel), k), lerp(0.30, 0.55, k), -0.5, 0.6, -0.5); arm(T, 1, 0.24, lerp(0.95, H(rel), k), lerp(0.30, 0.55, k), 0.5, 0.6, -0.5);
  } else if (u < 0.7) {
    // de panza sobre la tapa, brazos adelante
    P.prone(T);
    arm(T, 0, -0.26, 0.08, 0.80, -0.5, 0.8, 0); arm(T, 1, 0.26, 0.08, 0.80, 0.5, 0.8, 0);
    add(T, HEAD, 0, 0.14, 0.04); add(T, NECK, 0, 0.07, 0.02);
    const k = seg(u, 0.35, 0.7);
    add(T, KNL, 0, 0.10 * k, 0); add(T, KNR, 0, 0.10 * k, 0);
  } else {
    blend(T, (X) => P.allFours(X, 0), (X) => P.crouch(X, 0.6), seg(u, 0.7, 1));
  }
  floorClamp(T, 0.0);
};
/** Trepada frenética: cuatro miembros, rodillas al borde, todo tiembla. */
P.scrambleVault = (T, u = 0, rel = 0.7) => {
  if (typeof u !== 'number') u = 0; if (typeof rel !== 'number') rel = 0.7;
  const j = Math.sin(u * 34) * 0.03, j2 = Math.cos(u * 27) * 0.03;
  if (u < 0.5) {
    const k = seg(u, 0, 0.5);
    torso(T, j, 0.96 - 0.32 * k, -0.02 * k, 0.95 * k, j2);
    leg(T, 0, -0.15, lerp(0.062, H(rel, 0.08), k) + j, 0.30 * k, -0.3, 1, 0.6); leg(T, 1, 0.15, lerp(0.062, H(rel, 0.08), k * 0.7) - j, 0.18 * k, 0.3, 1, 0.6);
    arm(T, 0, -0.24 + j2, lerp(0.95, H(rel), k), lerp(0.30, 0.50, k), -0.8, 0, -0.4); arm(T, 1, 0.24 - j2, lerp(0.95, H(rel), k * 1.2), lerp(0.30, 0.55, k), 0.8, 0, -0.4);
  } else {
    blend(T, (X) => P.allFours(X, Math.sin(u * 20)), (X) => P.crouch(X, 0.55), seg(u, 0.5, 1));
    add(T, HEAD, j, j2, 0);
  }
  floorClamp(T, 0.0);
};
/** Bajar sentado: se sienta en el borde con las piernas colgando y se deja caer. */
P.sitDrop = (T, u = 0, rel = -0.7) => {
  if (typeof u !== 'number') u = 0; if (typeof rel !== 'number') rel = -0.7;
  // rel < 0: la tapa queda por DEBAJO del ancla original… acá rel = tapa − ancla actual
  if (u < 0.4) {
    const k = seg(u, 0, 0.4);
    torso(T, 0, lerp(0.96, 0.14, k), 0, lerp(0.1, 0.15, k));
    leg(T, 0, -0.13, lerp(0.062, -0.55, k), lerp(0.05, 0.30, k), -0.1, 0.3, 1); leg(T, 1, 0.13, lerp(0.062, -0.55, k), lerp(0.05, 0.30, k), 0.1, 0.3, 1);
    arm(T, 0, -0.34, lerp(0.86, 0.10, k), -0.05, -0.9, 0.3, -0.3); arm(T, 1, 0.34, lerp(0.86, 0.10, k), -0.05, 0.9, 0.3, -0.3);
  } else if (u < 0.8) {
    // resbala: la cadera sale del borde y baja con el ancla; los pies buscan el piso
    const k = seg(u, 0.4, 0.8);
    torso(T, 0, lerp(0.14, 0.96, k) + rel * (1 - k) * 0, 0, 0.35 * k);
    leg(T, 0, -0.15, 0.062 + 0.10 * (1 - k), 0.12, -0.2, 0.3, 1); leg(T, 1, 0.15, 0.062 + 0.10 * (1 - k), 0.12, 0.2, 0.3, 1);
    arm(T, 0, -0.32, lerp(0.10, 0.95, k), lerp(-0.10, 0.20, k), -0.8, 0.2, -0.5); arm(T, 1, 0.32, lerp(0.10, 0.95, k), lerp(-0.10, 0.20, k), 0.8, 0.2, -0.5);
  } else {
    P.land(T, 0.45 * (1 - seg(u, 0.8, 1)));
  }
};
/** Bajar con cuidado: agachado, un pie busca el piso, después el otro. */
P.stepDown = (T, u = 0, rel = -0.7, s = 1) => {
  if (typeof u !== 'number') u = 0; if (typeof rel !== 'number') rel = -0.7; if (typeof s !== 'number') s = 1;
  const sx = s ? 1 : -1;
  if (u < 0.45) {
    const k = seg(u, 0, 0.45);
    torso(T, 0, 0.96 - 0.30 * k, -0.03 * k, 0.5 * k);
    // el pie guía baja por adelante del borde
    leg(T, s, sx * 0.14, lerp(0.062, -0.40, k), lerp(0.05, 0.28, k), sx * 0.2, 0.6, 1);
    leg(T, s ? 0 : 1, -sx * 0.15, 0.062, -0.05, -sx * 0.2, 0, 1);
    arm(T, 0, -0.34, 0.75, 0.15, -0.9, -0.3, -0.4); arm(T, 1, 0.34, 0.75, 0.15, 0.9, -0.3, -0.4);
  } else {
    const k = seg(u, 0.45, 1);
    torso(T, 0, 0.66 + 0.30 * k, -0.03 * (1 - k), 0.5 - 0.4 * k);
    leg(T, s, sx * 0.14, 0.062, 0.25 - 0.15 * k, sx * 0.2, 0.2, 1);
    leg(T, s ? 0 : 1, -sx * 0.15, 0.062 + 0.30 * (1 - k), -0.05 + 0.10 * k, -sx * 0.2, 0.5, 1);
    arm(T, 0, -0.34, lerp(0.75, 0.86, k), 0.10, -0.9, -0.3, -0.4); arm(T, 1, 0.34, lerp(0.75, 0.86, k), 0.10, 0.9, -0.3, -0.4);
  }
};

// ═══ CONTRA LA PARED / EL BORDE ══════════════════════════════════════════════
/** Atrapa la pared con las manos: brazos al frente, pecho adelante, un pie adelantado. */
P.wallCatch = (T, k = 1) => {
  if (typeof k !== 'number') k = 1;
  torso(T, 0, 0.93, 0.02, 0.14 * k);
  leg(T, 0, -0.14, 0.062, 0.22, -0.2, 0, 1); leg(T, 1, 0.14, 0.062, -0.12, 0.2, 0, 1);
  arm(T, 0, -0.22, 1.28, 0.30 + 0.25 * k, -0.5, -0.4, -0.5); arm(T, 1, 0.22, 1.28, 0.30 + 0.25 * k, 0.5, -0.4, -0.5);
  add(T, HEAD, 0, -0.02 * k, -0.05 * k);
};
/** La cara contra la pared: cabeza echada atrás por el golpe, manos arriba a los costados. */
P.wallFace = (T) => {
  torso(T, 0, 0.94, 0.02, -0.08);
  leg(T, 0, -0.15, 0.062, 0.04, -0.2, 0, 1); leg(T, 1, 0.15, 0.062, 0.04, 0.2, 0, 1);
  arm(T, 0, -0.32, 1.55, 0.22, -0.9, 0.3, -0.2); arm(T, 1, 0.32, 1.55, 0.22, 0.9, 0.3, -0.2);
  add(T, HEAD, 0, -0.02, -0.10); add(T, NECK, 0, 0, -0.04);
};
/** Resbala por la pared hasta sentarse: espalda derecha, pies adelante. */
P.wallSlideSit = (T, k = 1) => {
  if (typeof k !== 'number') k = 1;
  torso(T, 0, 0.96 - 0.55 * k, -0.02 * k, -0.12);
  leg(T, 0, -0.16, 0.062, 0.12 + 0.35 * k, -0.15, 0.4, 1); leg(T, 1, 0.16, 0.062, 0.12 + 0.35 * k, 0.15, 0.4, 1);
  arm(T, 0, -0.30, 0.90 - 0.55 * k, 0.05, -0.9, -0.2, -0.3); arm(T, 1, 0.30, 0.90 - 0.55 * k, 0.05, 0.9, -0.2, -0.3);
  floorClamp(T);
};
/** Se desploma contra la pared: de rodillas, el pecho apoyado, las manos altas en la pared. */
P.crumpleKneel = (T) => {
  P.kneelUp(T);
  torso(T, 0, 0.50, 0, 0.30);
  arm(T, 0, -0.28, 1.05, 0.30, -0.9, 0.2, -0.2); arm(T, 1, 0.28, 1.05, 0.30, 0.9, 0.2, -0.2);
  add(T, HEAD, 0, -0.06, 0.06);
  floorClamp(T);
};
/** Vuelco sobre un borde: la cadera queda en el borde, el tronco cae del otro lado, las piernas suben. */
P.overEdge = (T, u = 0.5) => {
  if (typeof u !== 'number') u = 0.5;
  torso(T, 0, 0.80 - 0.20 * u, 0, 0.9 + 0.7 * u);
  leg(T, 0, -0.13, 0.55 + 0.30 * u, -0.45 - 0.15 * u, 0, 1, -0.4); leg(T, 1, 0.13, 0.50 + 0.35 * u, -0.45 - 0.15 * u, 0, 1, -0.4);
  arm(T, 0, -0.25, 0.30 - 0.25 * u, 0.70, -0.5, 0.6, 0); arm(T, 1, 0.25, 0.30 - 0.25 * u, 0.70, 0.5, 0.6, 0);
};
/** Boca abajo con los brazos estirados al frente (resbalando de panza). */
P.bellySlide = (T) => {
  P.prone(T);
  arm(T, 0, -0.25, 0.08, 0.85, -0.5, 0.8, 0); arm(T, 1, 0.25, 0.08, 0.85, 0.5, 0.8, 0);
  add(T, HEAD, 0, 0.10, 0.03); add(T, NECK, 0, 0.05, 0.01);
  floorClamp(T);
};

// ═══ EN EL PISO Y LEVANTARSE, VARIANTES ÁGILES ════════════════════════════════
/** Deslizada (baseball): una pierna estirada adelante, la otra doblada, una mano atrás en el piso. */
P.slide = (T, s = 1) => {
  if (typeof s !== 'number') s = 1;
  const sx = s ? 1 : -1;
  torso(T, 0, 0.30, -0.02, -0.35);
  leg(T, s ? 0 : 1, -sx * 0.14, 0.08, 0.72, 0, 1, 0.3);
  leg(T, s, sx * 0.20, 0.10, 0.12, sx * 0.9, 0.3, 0);
  arm(T, s, sx * 0.36, 0.07, -0.28, sx * 0.9, 0.3, -0.3);
  arm(T, s ? 0 : 1, -sx * 0.30, 0.82, 0.38, -sx * 0.6, 0.6, 0.2);
  floorClamp(T);
};
/** Posición de salida (sprinter): manos en el piso, piernas coiladas bajo la cadera, listo para explotar. */
P.spring = (T) => {
  torso(T, 0, 0.55, 0, 1.10);
  leg(T, 0, -0.16, 0.062, 0.02, -0.2, 0.4, 1); leg(T, 1, 0.16, 0.062, -0.12, 0.2, 0.4, 1);
  arm(T, 0, -0.26, 0.07, 0.55, -0.5, 0.6, -0.5); arm(T, 1, 0.26, 0.07, 0.55, 0.5, 0.6, -0.5);
  add(T, HEAD, 0, 0.06, 0.04);
  floorClamp(T);
};
/** Gateo transformándose en carrera: entre cuatro patas y agachado, mirando al frente. */
P.crawlRun = (T, u = 0.5, reach = 0) => {
  if (typeof u !== 'number') u = 0.5; if (typeof reach !== 'number') reach = 0;
  blend(T, (X) => P.allFours(X, reach), (X) => P.crouch(X, 0.65), u);
  add(T, HEAD, 0, 0.06 * (1 - u), 0.04 * (1 - u));
  floorClamp(T);
};
/** Rugido: brazos abiertos y arriba, cabeza atrás, pecho afuera (de rodillas). */
P.roar = (T) => {
  P.kneelUp(T);
  torso(T, 0, 0.52, 0, -0.18);
  arm(T, 0, -0.58, 1.22, -0.08, -0.5, 1, 0); arm(T, 1, 0.58, 1.22, -0.08, 0.5, 1, 0);
  add(T, HEAD, 0, -0.02, -0.10);
};
/** Rugido de pie. */
P.roarUp = (T) => {
  torso(T, 0, 0.98, 0, -0.22);
  leg(T, 0, -0.18, 0.062, 0.02, -0.2, 0, 1); leg(T, 1, 0.18, 0.062, 0.02, 0.2, 0, 1);
  arm(T, 0, -0.60, 1.70, -0.10, -0.5, 1, 0); arm(T, 1, 0.60, 1.70, -0.10, 0.5, 1, 0);
  add(T, HEAD, 0, -0.02, -0.12);
};
/** Agachado inestable, ladeado (se levanta mareado). */
P.crouchTilt = (T, k = 0.5, s = 1) => {
  if (typeof k !== 'number') k = 0.5; if (typeof s !== 'number') s = 1;
  P.crouch(T, k);
  rotZ(T, (s ? -1 : 1) * 0.18, 0, 0.5);
  add(T, s ? HAR : HAL, (s ? 1 : -1) * 0.20, 0.20, 0.05);
  floorClamp(T);
};
/** Agachado de perfil, con las manos en el piso a un lado (giro sentado→rodilla). */
P.kneelTwist = (T, s = 1) => {
  if (typeof s !== 'number') s = 1;
  P.kneelOne(T, s);
  rotY(T, (s ? -1 : 1) * 0.5, 0, 0);
  floorClamp(T);
};
/** Cabeza gacha, hombros caídos, manos colgando (aturdido de pie). */
P.dazedStand = (T) => {
  P.stand(T);
  add(T, HEAD, 0, -0.10, 0.12); add(T, NECK, 0, -0.04, 0.06);
  add(T, SHL, 0, -0.03, 0.04); add(T, SHR, 0, -0.03, 0.04);
  arm(T, 0, -0.27, 0.80, 0.08, -0.9, -0.4, -0.3); arm(T, 1, 0.27, 0.80, 0.08, 0.9, -0.4, -0.3);
};
/** Con el hombro bajo, embistiendo. */
P.chargeLow = (T, s = 1) => {
  if (typeof s !== 'number') s = 1;
  const sx = s ? 1 : -1;
  torso(T, 0, 0.86, 0, 0.55, sx * 0.12, sx * 0.35);
  leg(T, 0, -0.15, 0.062, 0.20, -0.2, 0, 1); leg(T, 1, 0.15, 0.062, -0.20, 0.2, 0, 1);
  arm(T, s, sx * 0.20, 0.95, 0.20, sx * 0.9, -0.4, -0.2);
  arm(T, s ? 0 : 1, -sx * 0.35, 0.85, -0.30, -sx * 0.7, 0.2, -0.7);
};

// ═══ SECUENCIAS ══════════════════════════════════════════════════════════════
//  key = { t, pose(T, B, ctx), mus, legs, arms, fwd, up, yawAdd, kick, brace }
//   · mus: músculo global en esa clave (se interpola) · legs/arms: multiplicador
//     de esos miembros · fwd: velocidad de la raíz a lo largo de +Z local (m/s)
//   · yawAdd: giro del marco al llegar a la clave (la pose siguiente se
//     expresa en el marco nuevo; en el mundo es la misma) · kick: impulsos
//     [partícula, vx, vy, vz] en local, una vez · brace: manos al piso al caer
//  `kind`: 'getup' | 'fall' | 'die' | 'move'  ·  `from`: orientación de salida
//  `w`: pesos por tipo de cuerpo para el sorteo {runner, walker, brute, player}
const K = (t, pose, o = {}) => ({ t, pose, ...o });

export const SEQ = {};

// ── levantadas desde BOCA ARRIBA (marco: +Z = hacia los pies) ────────────────
SEQ.gu_situp = {
  kind: 'getup', from: 'supine', dur: 2.1, w: { runner: 1, walker: 2, brute: 1, player: 2 },
  keys: [
    K(0.00, P.supine, { mus: 0.30 }),
    K(0.35, P.supineKnees, { mus: 0.50 }),
    K(0.85, P.sitBack, { mus: 0.75 }),
    K(1.30, P.squat, { mus: 0.85 }),
    K(1.75, (T) => P.crouch(T, 0.45), { mus: 0.95 }),
    K(2.10, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_roll_push = {
  kind: 'getup', from: 'supine', dur: 2.7, w: { runner: 1, walker: 2, brute: 1, player: 0.3 },
  keys: [
    K(0.00, P.supine, { mus: 0.30 }),
    K(0.45, (T) => P.supineRoll(T, HALF), { mus: 0.45 }),
    K(0.80, (T) => P.supineRoll(T, Math.PI), { mus: 0.50 }),
    // ya está boca abajo con la cabeza a −Z: el marco gira 180° y sigue como boca abajo estándar
    K(1.10, P.pushupLow, { mus: 0.55, yawAdd: Math.PI }),
    K(1.45, P.pushupHigh, { mus: 0.70 }),
    K(1.85, P.allFours, { mus: 0.80 }),
    K(2.25, (T) => P.kneelOne(T, 1), { mus: 0.90 }),
    K(2.70, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_kip = {
  kind: 'getup', from: 'supine', dur: 1.15, w: { runner: 4, walker: 0.2, brute: 0, player: 3 },
  keys: [
    K(0.00, P.supine, { mus: 0.35 }),
    K(0.30, P.supineTuck, { mus: 0.70 }),
    // patada: las piernas bajan de golpe y el tronco sube
    K(0.50, P.squat, { mus: 0.95, kick: [[CHEST, 0, 3.2, 1.6], [HEAD, 0, 3.0, 1.8], [HIP, 0, 2.0, 0.8], [FTL, 0, -1.5, 1.0], [FTR, 0, -1.5, 1.0]] }),
    K(0.85, (T) => P.crouch(T, 0.5), { mus: 1 }),
    K(1.15, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_back_heavy = {
  kind: 'getup', from: 'supine', dur: 3.1, w: { runner: 0, walker: 1, brute: 4, player: 0 },
  keys: [
    K(0.00, P.supine, { mus: 0.25 }),
    K(0.70, P.supineKnees, { mus: 0.40 }),
    K(1.40, P.sitBack, { mus: 0.60 }),
    K(2.00, (T) => P.kneelOne(T, 0), { mus: 0.75, yawAdd: 0 }),
    K(2.60, (T) => P.crouch(T, 0.55), { mus: 0.85 }),
    K(3.10, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_back_crawl = {
  kind: 'getup', from: 'supine', dur: 3.3, w: { runner: 1.5, walker: 1, brute: 0.3, player: 0 },
  keys: [
    K(0.00, P.supine, { mus: 0.30 }),
    K(0.40, (T) => P.supineRoll(T, -HALF), { mus: 0.45 }),
    K(0.70, (T) => P.supineRoll(T, -Math.PI), { mus: 0.50 }),
    K(1.00, P.pushupLow, { mus: 0.55, yawAdd: Math.PI }),
    K(1.25, (T) => P.allFours(T, 1), { mus: 0.75, fwd: 0.9 }),
    K(1.75, (T) => P.allFours(T, -1), { mus: 0.80, fwd: 0.9 }),
    K(2.25, (T) => P.allFours(T, 1), { mus: 0.85, fwd: 0.6 }),
    K(2.75, P.squat, { mus: 0.95 }),
    K(3.30, P.stand, { mus: 1 }),
  ],
};
// ── levantadas desde BOCA ABAJO (marco: +Z = hacia la cabeza) ────────────────
SEQ.gu_pushup = {
  kind: 'getup', from: 'prone', dur: 2.0, w: { runner: 1, walker: 2, brute: 1.5, player: 0.8 },
  keys: [
    K(0.00, P.prone, { mus: 0.30 }),
    K(0.35, P.pushupLow, { mus: 0.55 }),
    K(0.80, P.pushupHigh, { mus: 0.70 }),
    K(1.20, P.allFours, { mus: 0.80 }),
    K(1.60, P.squat, { mus: 0.92 }),
    K(2.00, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_knee_first = {
  kind: 'getup', from: 'prone', dur: 1.9, w: { runner: 2, walker: 2, brute: 1, player: 2 },
  keys: [
    K(0.00, P.prone, { mus: 0.30 }),
    K(0.40, (T) => P.proneKnee(T, 1), { mus: 0.55 }),
    K(0.90, (T) => P.kneelOne(T, 1), { mus: 0.80 }),
    K(1.45, (T) => P.crouch(T, 0.5), { mus: 0.95 }),
    K(1.90, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_prone_roll_sit = {
  kind: 'getup', from: 'prone', dur: 2.7, w: { runner: 0.5, walker: 1.5, brute: 1, player: 0.15 },
  keys: [
    K(0.00, P.prone, { mus: 0.30 }),
    K(0.45, (T) => P.proneRoll(T, HALF), { mus: 0.45 }),
    K(0.80, (T) => P.proneRoll(T, Math.PI), { mus: 0.50 }),
    K(1.10, P.supineKnees, { mus: 0.50, yawAdd: Math.PI }),
    K(1.45, P.sitBack, { mus: 0.72 }),
    K(1.90, P.squat, { mus: 0.85 }),
    K(2.30, (T) => P.crouch(T, 0.45), { mus: 0.95 }),
    K(2.70, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_prone_crawl = {
  kind: 'getup', from: 'prone', dur: 2.9, w: { runner: 1.5, walker: 1, brute: 0.5, player: 0 },
  keys: [
    K(0.00, P.prone, { mus: 0.30 }),
    K(0.40, P.pushupLow, { mus: 0.55 }),
    K(0.85, (T) => P.allFours(T, 1), { mus: 0.75, fwd: 1.0 }),
    K(1.35, (T) => P.allFours(T, -1), { mus: 0.80, fwd: 1.0 }),
    K(1.85, (T) => P.allFours(T, 1), { mus: 0.85, fwd: 0.7 }),
    K(2.35, P.squat, { mus: 0.95 }),
    K(2.90, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_prone_fast = {
  kind: 'getup', from: 'prone', dur: 1.25, w: { runner: 4, walker: 0.3, brute: 0, player: 1.5 },
  keys: [
    K(0.00, P.prone, { mus: 0.40 }),
    K(0.30, P.pushupHigh, { mus: 0.80 }),
    K(0.65, P.squat, { mus: 1, kick: [[HIP, 0, 2.2, 0.4], [CHEST, 0, 2.0, 0.4], [FTL, 0, 1.0, 1.4], [FTR, 0, 1.0, 1.4]] }),
    K(0.95, (T) => P.crouch(T, 0.4), { mus: 1 }),
    K(1.25, P.stand, { mus: 1 }),
  ],
};
// ── levantadas DE COSTADO (marco: +Z = hacia donde mira la panza; cabeza a ±X) ─
SEQ.gu_side_prone = {
  kind: 'getup', from: 'side', dur: 2.3, w: { runner: 1.5, walker: 1.5, brute: 1, player: 1.5 },
  keys: [
    K(0.00, (T, B, c) => P.side(T, c.s), { mus: 0.30 }),
    K(0.45, P.pushupLow, { mus: 0.55, yawAdd: 'toHead' }),
    K(0.90, P.pushupHigh, { mus: 0.70 }),
    K(1.30, P.allFours, { mus: 0.80 }),
    K(1.80, P.squat, { mus: 0.92 }),
    K(2.30, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_side_supine = {
  kind: 'getup', from: 'side', dur: 2.5, w: { runner: 0.7, walker: 1.5, brute: 1.5, player: 0.3 },
  keys: [
    K(0.00, (T, B, c) => P.side(T, c.s), { mus: 0.30 }),
    K(0.50, P.supineKnees, { mus: 0.50, yawAdd: 'toFeet' }),
    K(1.00, P.sitBack, { mus: 0.72 }),
    K(1.50, P.squat, { mus: 0.85 }),
    K(2.05, (T) => P.crouch(T, 0.45), { mus: 0.95 }),
    K(2.50, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_side_elbow = {
  kind: 'getup', from: 'side', dur: 2.0, w: { runner: 2, walker: 1, brute: 1, player: 2 },
  keys: [
    K(0.00, (T, B, c) => P.side(T, c.s), { mus: 0.30 }),
    K(0.45, (T, B, c) => P.sideProp(T, c.s), { mus: 0.60 }),
    K(1.00, (T, B, c) => P.kneelOne(T, c.s ? 0 : 1), { mus: 0.85, yawAdd: 'toHead' }),
    K(1.55, (T) => P.crouch(T, 0.5), { mus: 0.95 }),
    K(2.00, P.stand, { mus: 1 }),
  ],
};
// ── desde ARRODILLADO / SENTADO (caídas parciales, tiro en la pierna, dormidos) ─
SEQ.gu_kneel = {
  kind: 'getup', from: 'kneel', dur: 1.2, w: { runner: 1, walker: 1, brute: 1, player: 1 },
  keys: [
    K(0.00, P.kneelUp, { mus: 0.60 }),
    K(0.45, (T) => P.kneelOne(T, 1), { mus: 0.85 }),
    K(0.85, (T) => P.crouch(T, 0.45), { mus: 0.95 }),
    K(1.20, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_sit = {
  kind: 'getup', from: 'sit', dur: 1.4, w: { runner: 1, walker: 1, brute: 1, player: 1 },
  keys: [
    K(0.00, P.sitRest, { mus: 0.60 }),
    K(0.40, P.sitSlump, { mus: 0.80 }),
    K(0.85, P.squat, { mus: 0.92 }),
    K(1.40, P.stand, { mus: 1 }),
  ],
};

// ── CAÍDAS (terminan en 'down' cuando el cuerpo se aquieta) ──────────────────
//  `imp`: impulsos iniciales en el marco del EMPUJÓN: [partícula, along, up, lateral]
//  (along = dirección del empujón, lateral = a su derecha)
SEQ.fall_back_sit = {
  kind: 'fall', dur: 1.4, minT: 0.6, brace: false,
  imp: [[CHEST, 2.8, 0.3, 0], [HEAD, 3.2, 0.5, 0], [HIP, 1.4, 0.1, 0], [FTL, -0.6, 0.2, 0], [FTR, -0.6, 0.2, 0], [KNL, 0.4, 0.2, 0], [KNR, 0.4, 0.2, 0]],
  keys: [
    K(0.00, P.stand, { mus: 0.12, legs: 0.3, arms: 5 }),
    K(0.30, P.sitBack, { mus: 0.18, legs: 0.9, arms: 3 }),
    K(0.70, P.supineKnees, { mus: 0.10 }),
    K(1.40, P.supine, { mus: 0.03 }),
  ],
};
SEQ.fall_back_plank = {
  kind: 'fall', dur: 1.2, minT: 0.5, brace: false,
  imp: [[HEAD, 3.0, 0.8, 0], [NECK, 2.6, 0.6, 0], [CHEST, 2.2, 0.4, 0], [FTL, 1.2, 0.2, 0], [FTR, 1.2, 0.2, 0]],
  keys: [
    K(0.00, P.armsOut, { mus: 0.05, arms: 6, legs: 0.5 }),
    K(0.35, (T) => P.dominoBack(T, 0.95), { mus: 0.06, arms: 4, legs: 0.3 }),
    K(0.85, P.supine, { mus: 0.03 }),
    K(1.20, P.supine, { mus: 0.02 }),
  ],
};
SEQ.fall_front_face = {
  kind: 'fall', dur: 1.3, minT: 0.5, brace: true,
  imp: [[HEAD, 2.8, 0.3, 0], [CHEST, 2.6, 0.4, 0], [SHL, 2.4, 0.3, 0], [SHR, 2.4, 0.3, 0], [FTL, -0.6, 0, 0], [FTR, -0.6, 0, 0]],
  keys: [
    K(0.00, P.stand, { mus: 0.06, legs: 0.1, arms: 8 }),
    K(0.30, (T) => P.dominoFront(T, 0.9), { mus: 0.07, legs: 0.1, arms: 7 }),
    K(0.75, P.pushupLow, { mus: 0.06, arms: 5 }),
    K(1.30, P.prone, { mus: 0.03 }),
  ],
};
SEQ.fall_front_knees = {
  kind: 'fall', dur: 1.5, minT: 0.7, brace: true,
  imp: [[HIP, 0.4, -1.5, 0], [KNL, 0.6, -1.0, 0], [KNR, 0.6, -1.0, 0]],
  keys: [
    K(0.00, P.stand, { mus: 0.55, legs: 0.0 }),
    K(0.30, P.kneelUp, { mus: 0.45, legs: 0.1 }),
    K(0.55, P.kneelUp, { mus: 0.30, legs: 0.1 }),
    K(0.95, P.pushupLow, { mus: 0.10, arms: 0.5 }),
    K(1.50, P.prone, { mus: 0.03 }),
  ],
};
SEQ.fall_side = {
  kind: 'fall', dur: 1.3, minT: 0.5, brace: true,
  imp: [[HEAD, 2.6, 0.4, 0], [CHEST, 2.3, 0.3, 0], [HIP, 1.0, 0.2, 0], [FTL, 0, 0.1, 0], [FTR, 0, 0.1, 0]],
  keys: [
    K(0.00, P.stand, { mus: 0.06, legs: 0.3, arms: 5 }),
    K(0.35, (T, B, c) => P.dominoSide(T, c.s, 0.9), { mus: 0.07, legs: 0.2, arms: 6 }),
    K(0.85, (T, B, c) => P.side(T, c.s), { mus: 0.04 }),
    K(1.30, (T, B, c) => P.side(T, c.s), { mus: 0.03 }),
  ],
};
SEQ.fall_spin = {
  kind: 'fall', dur: 1.5, minT: 0.6, brace: true,
  // giro: un hombro adelante y el otro atrás; después cae de costado
  imp: [[SHL, 1.2, 0.3, 2.6], [SHR, 1.2, 0.3, -2.6], [HEAD, 1.8, 0.4, 1.2], [CHEST, 1.6, 0.2, 0]],
  keys: [
    K(0.00, P.stand, { mus: 0.06, legs: 0.5, arms: 5 }),
    K(0.30, P.armsOut, { mus: 0.05, legs: 0.2, arms: 4 }),
    K(0.80, P.armsOut, { mus: 0.04 }),
    K(1.50, (T, B, c) => P.side(T, c.s), { mus: 0.03 }),
  ],
};
SEQ.fall_collapse = {
  kind: 'fall', dur: 1.6, minT: 0.7, brace: false,
  imp: [[HIP, 0, -1.2, 0], [CHEST, 0, -0.6, 0]],
  keys: [
    K(0.00, P.stand, { mus: 0.50, legs: 0.0 }),
    K(0.25, P.squat, { mus: 0.35, legs: 0.0 }),
    K(0.55, P.kneelUp, { mus: 0.20, legs: 0.0 }),
    K(0.95, P.sitSlump, { mus: 0.08 }),
    K(1.60, P.supine, { mus: 0.02 }),
  ],
};
SEQ.fall_fly = {
  kind: 'fall', dur: 1.8, minT: 0.8, brace: true,
  imp: [[HEAD, 4.8, 2.6, 0], [NECK, 4.5, 2.4, 0], [CHEST, 4.2, 2.1, 0], [SHL, 4.0, 2.0, 0], [SHR, 4.0, 2.0, 0], [HIP, 3.2, 1.4, 0], [HPL, 3.0, 1.3, 0], [HPR, 3.0, 1.3, 0], [KNL, 2.0, 0.9, 0], [KNR, 2.0, 0.9, 0], [FTL, 1.2, 0.8, 0], [FTR, 1.2, 0.8, 0]],
  keys: [
    // en el aire no hay de dónde hacer fuerza: trapo puro hasta que aterriza
    K(0.00, P.armsOut, { mus: 0.0 }),
    K(0.70, P.armsOut, { mus: 0.0 }),
    K(1.10, P.supine, { mus: 0.02 }),
    K(1.80, P.supine, { mus: 0.02 }),
  ],
};
SEQ.fall_trip_roll = {
  kind: 'fall', dur: 1.3, minT: 0.5, brace: false, quickUp: true,
  imp: [[HEAD, 2.4, -0.8, 0], [CHEST, 2.6, -0.4, 0], [SHL, 2.4, -0.6, 0], [SHR, 2.4, -0.6, 0], [HIP, 1.6, 0.8, 0], [FTL, -1.0, 1.2, 0], [FTR, -1.0, 1.2, 0]],
  keys: [
    K(0.00, P.tuck, { mus: 0.45 }),
    K(0.45, P.tuck, { mus: 0.40 }),
    K(0.85, P.supineTuck, { mus: 0.25 }),
    K(1.30, P.supineKnees, { mus: 0.15 }),
  ],
};
SEQ.fall_wall_bounce = {
  kind: 'fall', dur: 1.4, minT: 0.6, brace: false,
  // ya viene contra la pared: los brazos suben a protegerse, rebota y se sienta
  imp: [[HAL, 1.6, 1.4, 0], [HAR, 1.6, 1.4, 0], [HEAD, 0.8, 0.6, 0]],
  keys: [
    K(0.00, P.stand, { mus: 0.08, arms: 8, legs: 0.4 }),
    K(0.30, P.sitBack, { mus: 0.15, legs: 0.8, arms: 3 }),
    K(0.75, P.supineKnees, { mus: 0.08 }),
    K(1.40, P.supine, { mus: 0.03 }),
  ],
};
SEQ.tackle = {
  kind: 'fall', dur: 1.1, minT: 0.6, brace: false, quickUp: true,
  imp: [[HEAD, 3.6, 1.4, 0], [CHEST, 3.8, 1.5, 0], [SHL, 3.6, 1.4, 0], [SHR, 3.6, 1.4, 0], [HAL, 3.4, 1.6, 0], [HAR, 3.4, 1.6, 0], [HIP, 3.0, 1.0, 0], [KNL, 1.6, 0.4, 0], [KNR, 1.6, 0.4, 0]],
  keys: [
    K(0.00, P.dive, { mus: 0.55, fwd: 2.5 }),
    K(0.40, P.dive, { mus: 0.30, fwd: 1.5 }),
    K(0.75, P.pushupLow, { mus: 0.15 }),
    K(1.10, P.prone, { mus: 0.05 }),
  ],
};

// ── MUERTES (terminan en muerto cuando el cuerpo se aquieta o al final) ──────
SEQ.die_collapse = {
  kind: 'die', dur: 1.5, minT: 0.6, brace: false,
  imp: [[HIP, 0, -1.0, 0]],
  keys: [
    K(0.00, P.stand, { mus: 0.45, legs: 0.0 }),
    K(0.30, P.squat, { mus: 0.25, legs: 0.0 }),
    K(0.60, P.kneelUp, { mus: 0.10 }),
    K(1.50, P.sitSlump, { mus: 0.0 }),
  ],
};
SEQ.die_stagger = {
  kind: 'die', dur: 2.2, minT: 1.0, brace: true,
  keys: [
    K(0.00, P.stand, { mus: 0.70, fwd: 1.1 }),
    K(0.50, P.doubleOver, { mus: 0.55, fwd: 0.9 }),
    K(1.10, P.doubleOver, { mus: 0.35, fwd: 0.5 }),
    K(1.50, P.kneelUp, { mus: 0.15, fwd: 0 }),
    K(2.20, P.prone, { mus: 0.0 }),
  ],
};
SEQ.die_knees = {
  kind: 'die', dur: 2.0, minT: 1.0, brace: false,
  imp: [[HIP, 0, -1.2, 0], [KNL, 0, -0.8, 0], [KNR, 0, -0.8, 0]],
  keys: [
    K(0.00, P.stand, { mus: 0.55, legs: 0.0 }),
    K(0.35, P.kneelUp, { mus: 0.45, legs: 0.1 }),
    K(1.10, P.kneelUp, { mus: 0.30, legs: 0.1 }),
    K(1.45, P.kneelFeed, { mus: 0.12 }),
    K(2.00, P.prone, { mus: 0.0 }),
  ],
};
SEQ.die_back = {
  kind: 'die', dur: 1.4, minT: 0.6, brace: false,
  imp: [[HEAD, -2.6, 0.9, 0], [NECK, -2.2, 0.7, 0], [CHEST, -1.8, 0.5, 0], [HAL, -1.0, 1.6, 0], [HAR, -1.0, 1.6, 0]],
  keys: [
    K(0.00, P.armsOut, { mus: 0.06, legs: 0.3, arms: 5 }),
    K(0.45, (T) => P.dominoBack(T, 1.0), { mus: 0.05, arms: 3 }),
    K(0.90, P.supine, { mus: 0.02 }),
    K(1.40, P.supine, { mus: 0.0 }),
  ],
};
SEQ.die_spin = {
  kind: 'die', dur: 1.5, minT: 0.6, brace: false,
  imp: [[SHL, 0.8, 0.4, 3.0], [SHR, 0.8, 0.4, -3.0], [HEAD, 1.2, 0.5, 1.6], [HIP, 0, -0.6, 0]],
  keys: [
    K(0.00, P.stand, { mus: 0.30, legs: 0.2 }),
    K(0.35, P.armsOut, { mus: 0.12, legs: 0.0 }),
    K(1.50, P.prone, { mus: 0.0 }),
  ],
};
SEQ.die_slump = {
  kind: 'die', dur: 1.9, minT: 0.8, brace: true,
  keys: [
    K(0.00, P.stand, { mus: 0.60 }),
    K(0.45, P.doubleOver, { mus: 0.45 }),
    K(0.95, P.squat, { mus: 0.25, legs: 0.05 }),
    K(1.35, P.sitSlump, { mus: 0.10 }),
    K(1.90, (T) => P.side(T, 1), { mus: 0.0 }),
  ],
};

// ── quieto en el piso (dormidos): poses que se sostienen ─────────────────────
SEQ.rest_sit = { kind: 'rest', dur: 1e9, keys: [K(0, P.sitRest, { mus: 0.55 }), K(1e9, P.sitRest, { mus: 0.55 })], from: 'sit' };
SEQ.rest_kneel = { kind: 'rest', dur: 1e9, keys: [K(0, P.kneelFeed, { mus: 0.55 }), K(1e9, P.kneelFeed, { mus: 0.55 })], from: 'kneel' };
SEQ.rest_supine = { kind: 'rest', dur: 1e9, keys: [K(0, P.supine, { mus: 0.10 }), K(1e9, P.supine, { mus: 0.10 })], from: 'supine' };
SEQ.rest_prone = { kind: 'rest', dur: 1e9, keys: [K(0, P.prone, { mus: 0.10 }), K(1e9, P.prone, { mus: 0.10 })], from: 'prone' };
SEQ.rest_side = { kind: 'rest', dur: 1e9, keys: [K(0, (T, B, c) => P.side(T, c.s), { mus: 0.10 }), K(1e9, (T, B, c) => P.side(T, c.s), { mus: 0.10 })], from: 'side' };

// ── LEVANTADAS ÁGILES Y CON CARÁCTER ─────────────────────────────────────────
//  `w.parkour`: peso para los que tienen el rasgo parkour (pisa al del tipo).
SEQ.gu_roll_up = {
  // boca arriba: voltereta hacia atrás sobre los hombros y queda en cuclillas mirando al revés
  kind: 'getup', from: 'supine', dur: 1.5, anchor: 'center', w: { runner: 2, jogger: 0.8, walker: 0, brute: 0, player: 2.5, parkour: 4 },
  keys: [
    K(0.00, P.supine, { mus: 0.35 }),
    K(0.25, P.supineTuck, { mus: 0.70 }),
    K(0.45, (T) => P.rollBack(T, 1.2), { mus: 0.80, fwd: -1.2, kick: [[FTL, 0, 3.0, -2.0], [FTR, 0, 3.0, -2.0], [KNL, 0, 2.2, -1.5], [KNR, 0, 2.2, -1.5], [HIP, 0, 1.5, -1.0]] }),
    K(0.75, (T) => P.rollBack(T, 2.6), { mus: 0.85, fwd: -1.0 }),
    K(1.00, P.squat, { mus: 0.95, yawAdd: Math.PI }),
    K(1.25, (T) => P.crouch(T, 0.4), { mus: 1 }),
    K(1.50, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_spring = {
  // boca abajo: posición de salida y explota a los pies
  kind: 'getup', from: 'prone', dur: 0.95, w: { runner: 4, jogger: 1.5, walker: 0.2, brute: 0, player: 3, parkour: 4 },
  keys: [
    K(0.00, P.prone, { mus: 0.40 }),
    K(0.25, P.spring, { mus: 0.90 }),
    K(0.45, (T) => P.crouch(T, 0.7), { mus: 1, kick: [[HIP, 0, 2.6, 0.8], [CHEST, 0, 2.4, 0.6], [HEAD, 0, 2.2, 0.5], [SHL, 0, 2.2, 0.5], [SHR, 0, 2.2, 0.5]] }),
    K(0.70, (T) => P.crouch(T, 0.3), { mus: 1 }),
    K(0.95, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_side_kick = {
  // de costado: se apoya en el codo y barre las piernas por debajo hasta arrodillarse, rápido
  kind: 'getup', from: 'side', dur: 1.3, w: { runner: 3, jogger: 1.5, walker: 0.3, brute: 0, player: 3, parkour: 3 },
  keys: [
    K(0.00, (T, B, c) => P.side(T, c.s), { mus: 0.35 }),
    K(0.30, (T, B, c) => P.sideProp(T, c.s), { mus: 0.70 }),
    K(0.60, (T, B, c) => P.kneelOne(T, c.s ? 0 : 1), { mus: 0.90, yawAdd: 'toHead', kick: [[HIP, 0, 2.0, 0], [KNL, 0, 1.5, 0], [KNR, 0, 1.5, 0]] }),
    K(0.95, (T) => P.crouch(T, 0.4), { mus: 1 }),
    K(1.30, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_knee_hop = {
  // arrodillado: un salto a los pies
  kind: 'getup', from: 'kneel', dur: 0.8, w: { runner: 3, jogger: 1.5, walker: 0.5, brute: 0, player: 3, parkour: 3 },
  keys: [
    K(0.00, P.kneelUp, { mus: 0.70 }),
    K(0.25, (T) => P.kneelOne(T, 1), { mus: 0.95 }),
    K(0.45, (T) => P.crouch(T, 0.6), { mus: 1, kick: [[HIP, 0, 2.4, 0.5], [CHEST, 0, 2.2, 0.4], [FTL, 0, 1.2, 0.5], [FTR, 0, 1.2, 0.5]] }),
    K(0.80, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_crawl_run = {
  // boca abajo: gatea y se va parando mientras ya corre
  kind: 'getup', from: 'prone', dur: 2.0, w: { runner: 4, jogger: 2, walker: 0.5, brute: 0, player: 0.5, parkour: 2 },
  keys: [
    K(0.00, P.prone, { mus: 0.35 }),
    K(0.30, P.pushupLow, { mus: 0.65 }),
    K(0.55, (T) => P.allFours(T, 1), { mus: 0.80, fwd: 1.4 }),
    K(0.85, (T) => P.allFours(T, -1), { mus: 0.85, fwd: 1.8 }),
    K(1.15, (T) => P.crawlRun(T, 0.35, 1), { mus: 0.92, fwd: 2.2 }),
    K(1.45, (T) => P.crawlRun(T, 0.75, -1), { mus: 1, fwd: 2.5 }),
    K(1.75, (T) => P.crouch(T, 0.3), { mus: 1, fwd: 2.6 }),
    K(2.00, P.stand, { mus: 1, fwd: 2.4 }),
  ],
};
SEQ.gu_stumble_up = {
  // boca arriba: se levanta mareado, ladeado, y tarda en enderezarse
  kind: 'getup', from: 'supine', dur: 2.6, w: { runner: 0.3, jogger: 1, walker: 3, brute: 1, player: 0, parkour: 0 },
  keys: [
    K(0.00, P.supine, { mus: 0.30 }),
    K(0.40, P.supineKnees, { mus: 0.50 }),
    K(0.85, P.sitBack, { mus: 0.70 }),
    K(1.25, P.squat, { mus: 0.80 }),
    K(1.65, (T) => P.crouchTilt(T, 0.55, 1), { mus: 0.85 }),
    K(2.05, (T) => P.crouchTilt(T, 0.30, 0), { mus: 0.90 }),
    K(2.35, P.dazedStand, { mus: 0.95 }),
    K(2.60, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_brute_roar = {
  // boca arriba (bruto): se sienta, se arrodilla, ruge y se para
  kind: 'getup', from: 'supine', dur: 3.2, w: { runner: 0, jogger: 0, walker: 0.2, brute: 5, player: 0, parkour: 0 },
  keys: [
    K(0.00, P.supine, { mus: 0.25 }),
    K(0.60, P.supineKnees, { mus: 0.45 }),
    K(1.20, P.sitBack, { mus: 0.65 }),
    K(1.70, P.kneelUp, { mus: 0.80 }),
    K(2.10, P.roar, { mus: 1 }),
    K(2.60, P.roarUp, { mus: 1 }),
    K(3.20, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_flop_retry = {
  // boca abajo (caminante): empuja, se le aflojan los brazos, cae, y a la segunda sale
  kind: 'getup', from: 'prone', dur: 3.4, w: { runner: 0, jogger: 0.3, walker: 2.5, brute: 0.5, player: 0, parkour: 0 },
  keys: [
    K(0.00, P.prone, { mus: 0.30 }),
    K(0.40, P.pushupLow, { mus: 0.55 }),
    K(0.85, P.pushupHigh, { mus: 0.65 }),
    K(1.10, P.pushupLow, { mus: 0.15, arms: 0.2 }),
    K(1.55, P.prone, { mus: 0.25 }),
    K(2.00, P.pushupLow, { mus: 0.60 }),
    K(2.40, P.allFours, { mus: 0.80 }),
    K(2.85, P.squat, { mus: 0.92 }),
    K(3.40, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_sit_twist = {
  // sentado: gira sobre una rodilla y se para
  kind: 'getup', from: 'sit', dur: 1.3, w: { runner: 1, jogger: 1, walker: 1, brute: 1, player: 1, parkour: 1 },
  keys: [
    K(0.00, P.sitRest, { mus: 0.60 }),
    K(0.45, (T) => P.kneelTwist(T, 1), { mus: 0.85 }),
    K(0.90, (T) => P.crouch(T, 0.45), { mus: 0.95, yawAdd: -0.5 }),
    K(1.30, P.stand, { mus: 1 }),
  ],
};
SEQ.gu_kneel_lunge = {
  // arrodillado (corredor): se lanza hacia adelante y sale ya corriendo
  kind: 'getup', from: 'kneel', dur: 1.0, w: { runner: 3, jogger: 1.5, walker: 0.3, brute: 0, player: 1, parkour: 2 },
  keys: [
    K(0.00, P.kneelUp, { mus: 0.70 }),
    K(0.30, (T) => P.kneelOne(T, 1), { mus: 0.95, fwd: 0.6 }),
    K(0.60, (T) => P.crouch(T, 0.5), { mus: 1, fwd: 1.6 }),
    K(1.00, P.stand, { mus: 1, fwd: 2.2 }),
  ],
};

// ── CAÍDAS NUEVAS: pared, borde, tropezones feos, impactos enormes ───────────
SEQ.fall_wall_face = {
  // de cara contra la pared: la cabeza rebota atrás, manos a la cara, se sienta
  kind: 'fall', dur: 1.4, minT: 0.6, brace: false,
  imp: [[HEAD, 2.4, 0.9, 0], [NECK, 1.8, 0.6, 0], [CHEST, 1.0, 0.3, 0], [HAL, 0.5, 1.8, 0], [HAR, 0.5, 1.8, 0]],
  keys: [
    K(0.00, P.wallFace, { mus: 0.25, arms: 4 }),
    K(0.30, (T) => P.dominoBack(T, 0.45), { mus: 0.10, arms: 3 }),
    K(0.70, P.sitBack, { mus: 0.12 }),
    K(1.40, P.supine, { mus: 0.03 }),
  ],
};
SEQ.fall_wall_slide = {
  // rebota, gira y resbala por la pared con la espalda hasta quedar sentado
  kind: 'fall', dur: 1.6, minT: 0.7, brace: false,
  imp: [[HIP, 0.5, -1.0, 0], [CHEST, 0.9, 0.2, 0], [HEAD, 1.3, 0.4, 0], [SHL, 0.6, 0.2, 1.4], [SHR, 0.6, 0.2, -1.4]],
  keys: [
    K(0.00, (T) => P.wallCatch(T, 1), { mus: 0.30, arms: 3 }),
    K(0.35, (T) => P.wallSlideSit(T, 0.35), { mus: 0.26, legs: 0.3, yawAdd: Math.PI }),
    K(0.80, (T) => P.wallSlideSit(T, 1), { mus: 0.18, legs: 0.2 }),
    K(1.20, P.sitSlump, { mus: 0.08 }),
    K(1.60, (T, B, c) => P.side(T, c.s), { mus: 0.03 }),
  ],
};
SEQ.fall_wall_crumple = {
  // contra la pared las piernas ceden: de rodillas con el pecho apoyado, y de costado
  kind: 'fall', dur: 1.7, minT: 0.8, brace: false,
  imp: [[HIP, -0.3, -1.4, 0], [KNL, 0, -0.8, 0], [KNR, 0, -0.8, 0], [HEAD, 0.4, 0.3, 0]],
  keys: [
    K(0.00, P.wallCatch, { mus: 0.45, legs: 0.05, arms: 3 }),
    K(0.35, P.crumpleKneel, { mus: 0.35, legs: 0.1, arms: 2 }),
    K(0.85, P.kneelFeed, { mus: 0.18 }),
    K(1.25, (T, B, c) => P.side(T, c.s), { mus: 0.06 }),
    K(1.70, (T, B, c) => P.side(T, c.s), { mus: 0.03 }),
  ],
};
SEQ.fall_over_edge = {
  // vuelca sobre un borde a la altura de la cadera: el tronco pasa, las piernas suben, cae de panza encima
  kind: 'fall', dur: 1.5, minT: 0.7, brace: false, quickUp: true,
  imp: [[HEAD, 3.2, 1.2, 0], [CHEST, 3.0, 1.4, 0], [SHL, 2.8, 1.2, 0], [SHR, 2.8, 1.2, 0], [HIP, 1.6, 1.6, 0], [KNL, 0.6, 2.4, 0], [KNR, 0.6, 2.4, 0], [FTL, 0.2, 2.6, 0], [FTR, 0.2, 2.6, 0]],
  keys: [
    K(0.00, (T) => P.overEdge(T, 0.2), { mus: 0.30, legs: 1.5 }),
    K(0.35, (T) => P.overEdge(T, 0.9), { mus: 0.22, legs: 1.2 }),
    K(0.80, P.bellySlide, { mus: 0.12 }),
    K(1.50, P.prone, { mus: 0.04 }),
  ],
};
SEQ.fall_faceplant = {
  // tropezón sin sacar las manos: de tabla hacia adelante y la cara al piso
  kind: 'fall', dur: 1.2, minT: 0.5, brace: false,
  imp: [[HEAD, 3.0, 0.2, 0], [CHEST, 2.8, 0.3, 0], [SHL, 2.6, 0.2, 0], [SHR, 2.6, 0.2, 0], [FTL, -0.8, 0.3, 0], [FTR, -0.8, 0.3, 0]],
  keys: [
    K(0.00, P.stand, { mus: 0.05, legs: 0.1, arms: 0.2 }),
    K(0.30, (T) => P.dominoFront(T, 1.0), { mus: 0.05, arms: 0.1 }),
    K(0.70, P.prone, { mus: 0.04, arms: 0.2 }),
    K(1.20, P.prone, { mus: 0.02 }),
  ],
};
SEQ.fall_cartwheel = {
  // un impacto lateral enorme: gira como rueda de costado y cae
  kind: 'fall', dur: 1.7, minT: 0.8, brace: false,
  imp: [[HEAD, 2.0, 3.6, 0], [NECK, 1.8, 3.2, 0], [SHL, 1.6, 3.0, 0], [SHR, 1.6, 3.0, 0], [CHEST, 1.5, 2.6, 0], [HIP, 1.2, 1.4, 0], [FTL, 0.4, -0.6, 0], [FTR, 0.4, -0.6, 0]],
  dyn: (T, B, c, t, u) => { P.armsOut(T); rotZ(T, (c.s ? -1 : 1) * Math.min(3.0, t * 4.5), 0, 0.90); floorClamp(T); },
  keys: [K(0.00, P.armsOut, { mus: 0.05 }), K(0.9, P.armsOut, { mus: 0.03 }), K(1.7, P.armsOut, { mus: 0.02 })],
};
SEQ.fall_helicopter = {
  // tiro en el hombro con mucha energía: gira sobre sí mismo mientras cae
  kind: 'fall', dur: 1.6, minT: 0.7, brace: true,
  imp: [[SHL, 1.5, 0.6, 3.4], [SHR, 1.5, 0.6, -3.4], [HAL, 1.0, 1.2, 4.0], [HAR, 1.0, 1.2, -4.0], [HEAD, 1.4, 0.5, 1.5], [CHEST, 1.2, 0.3, 0]],
  dyn: (T, B, c, t, u) => { P.armsOut(T); rotY(T, (c.s ? 1 : -1) * t * 7.0, 0, 0); rotX(T, ss(t / 1.0) * 1.2, 0.06, 0.03); floorClamp(T); },
  keys: [K(0.00, P.armsOut, { mus: 0.08, legs: 0.4 }), K(0.8, P.armsOut, { mus: 0.05 }), K(1.6, P.armsOut, { mus: 0.02 })],
};
SEQ.fall_slip = {
  // resbalón: los pies se van adelante y cae de espaldas
  kind: 'fall', dur: 1.3, minT: 0.5, brace: false,
  imp: [[FTL, 3.5, 0.6, 0], [FTR, 3.5, 0.6, 0], [KNL, 2.6, 0.5, 0], [KNR, 2.6, 0.5, 0], [HIP, 0.8, -0.5, 0], [HEAD, -1.0, 0.2, 0], [HAL, -0.5, 1.5, 0], [HAR, -0.5, 1.5, 0]],
  keys: [
    K(0.00, P.armsOut, { mus: 0.10, legs: 0.2 }),
    K(0.30, P.sitBack, { mus: 0.10 }),
    K(0.70, P.supineKnees, { mus: 0.08 }),
    K(1.30, P.supine, { mus: 0.03 }),
  ],
};
SEQ.fall_stumble_long = {
  // herido: tres pasos tambaleantes doblado hacia adelante y recién ahí cae
  kind: 'fall', dur: 1.9, minT: 1.0, brace: true,
  keys: [
    K(0.00, P.stand, { mus: 0.65, fwd: 1.6 }),
    K(0.40, P.doubleOver, { mus: 0.55, fwd: 1.4 }),
    K(0.90, (T) => P.crouchTilt(T, 0.5, 1), { mus: 0.40, fwd: 1.0 }),
    K(1.30, P.kneelUp, { mus: 0.20, fwd: 0.3 }),
    K(1.90, P.prone, { mus: 0.04 }),
  ],
};
SEQ.fall_knees_slide = {
  // se desploma de rodillas resbalando hacia adelante y termina de cara
  kind: 'fall', dur: 1.4, minT: 0.6, brace: true,
  imp: [[HIP, 1.2, -1.8, 0], [KNL, 1.2, -1.2, 0], [KNR, 1.2, -1.2, 0], [CHEST, 1.6, -0.4, 0]],
  keys: [
    K(0.00, P.stand, { mus: 0.50, legs: 0.0, fwd: 1.2 }),
    K(0.25, P.kneelUp, { mus: 0.40, legs: 0.1, fwd: 0.9 }),
    K(0.65, P.kneelUp, { mus: 0.25, legs: 0.1, fwd: 0.3 }),
    K(1.00, P.pushupLow, { mus: 0.10 }),
    K(1.40, P.prone, { mus: 0.03 }),
  ],
};
SEQ.fall_pounce_miss = {
  // se lanzó y no agarró a nadie: aterriza de panza y resbala
  kind: 'fall', dur: 1.1, minT: 0.5, brace: false, quickUp: true,
  imp: [[HEAD, 2.0, -0.5, 0], [CHEST, 2.2, -0.6, 0], [HAL, 2.6, -0.4, 0], [HAR, 2.6, -0.4, 0], [HIP, 1.8, -0.2, 0]],
  keys: [
    K(0.00, P.airSuperman, { mus: 0.45, fwd: 2.0 }),
    K(0.35, P.bellySlide, { mus: 0.20, fwd: 1.2 }),
    K(0.75, P.pushupLow, { mus: 0.15 }),
    K(1.10, P.prone, { mus: 0.05 }),
  ],
};

// ── MOVIMIENTOS: toman el cuerpo un instante y devuelven el control de pie ───
//  kind:'move'. `dyn(T, B, ctx, t, u)` da la pose continua (las claves sólo
//  llevan músculo y avance). anchor:'center' ancla la pose a su centro (para
//  rodar). vel: la velocidad objetivo del PD sigue a fwd/lat (la física
//  acompaña el movimiento en vez de frenarlo). end:'down' termina tirado.
SEQ.roll_fwd = {
  kind: 'move', dur: 0.95, anchor: 'center', vel: true, brace: false,
  dyn: (T, B, c, t, u) => {
    if (u < 0.12) blend(T, (X) => P.crouch(X, 0.7), (X) => P.roll(X, 0), u / 0.12);
    else if (u < 0.78) P.roll(T, seg(u, 0.12, 0.78) * Math.PI * 2);
    else blend(T, (X) => P.roll(X, Math.PI * 2), (X) => P.crouch(X, 0.35), seg(u, 0.78, 1));
  },
  keys: [K(0, null, { mus: 0.9, fwd: 2.8 }), K(0.15, null, { mus: 0.85, fwd: 2.6 }), K(0.75, null, { mus: 0.9, fwd: 1.6 }), K(0.95, null, { mus: 1, fwd: 0.8 })],
};
SEQ.roll_shoulder = {
  // rodada de hombro (parkour): entra por la diagonal, sale corriendo
  kind: 'move', dur: 0.85, anchor: 'center', vel: true, brace: false,
  dyn: (T, B, c, t, u) => {
    if (u < 0.10) blend(T, (X) => P.crouch(X, 0.8), (X) => P.rollShoulder(X, 0, c.s), u / 0.10);
    else if (u < 0.75) P.rollShoulder(T, seg(u, 0.10, 0.75) * Math.PI * 2, c.s);
    else blend(T, (X) => P.rollShoulder(X, Math.PI * 2, c.s), (X) => P.crouch(X, 0.25), seg(u, 0.75, 1));
  },
  keys: [K(0, null, { mus: 0.9, fwd: 3.2 }), K(0.7, null, { mus: 0.9, fwd: 2.2 }), K(0.85, null, { mus: 1, fwd: 1.8 })],
};
SEQ.roll_back = {
  // rodada hacia atrás: cae de espaldas y sale rodando a los pies
  kind: 'move', dur: 1.0, anchor: 'center', vel: true, brace: false,
  dyn: (T, B, c, t, u) => {
    if (u < 0.15) blend(T, P.supineTuck, (X) => P.rollBack(X, 0.3), u / 0.15);
    else if (u < 0.80) P.rollBack(T, 0.3 + seg(u, 0.15, 0.80) * (Math.PI * 2 - 0.3));
    else blend(T, (X) => P.rollBack(X, Math.PI * 2), (X) => P.crouch(X, 0.4), seg(u, 0.80, 1));
  },
  keys: [K(0, null, { mus: 0.85, fwd: -2.2 }), K(0.8, null, { mus: 0.9, fwd: -1.2 }), K(1.0, null, { mus: 1, fwd: 0 })],
};
SEQ.roll_side = {
  // rodar de costado por el piso (sacarse a alguien de encima): gira sobre el eje largo
  kind: 'move', dur: 0.8, anchor: 'center', vel: true, brace: false, end: 'down',
  dyn: (T, B, c, t, u) => { P.supineRoll(T, (c.s ? 1 : -1) * seg(u, 0, 0.85) * Math.PI * 2); },
  keys: [K(0, null, { mus: 0.7, lat: 2.2 }), K(0.6, null, { mus: 0.6, lat: 1.6 }), K(0.8, null, { mus: 0.5, lat: 0 })],
};
SEQ.scramble = {
  // gatear rápido hacia un lado y levantarse en la carrera
  kind: 'move', dur: 1.15, vel: true, brace: false,
  dyn: (T, B, c, t, u) => {
    const reach = Math.sin(t * 15);
    if (u < 0.55) { P.allFours(T, reach); add(T, HEAD, 0, 0.08, 0.05); }
    else P.crawlRun(T, seg(u, 0.55, 1), reach * (1 - seg(u, 0.55, 1)));
  },
  keys: [K(0, null, { mus: 0.85, fwd: 1.6 }), K(0.5, null, { mus: 0.95, fwd: 2.2 }), K(1.15, null, { mus: 1, fwd: 2.4 })],
};
SEQ.slide = {
  // deslizada de béisbol: pasa por abajo, frena y se levanta en un paso
  kind: 'move', dur: 0.9, vel: true, brace: false,
  dyn: (T, B, c, t, u) => {
    if (u < 0.2) blend(T, (X) => P.crouch(X, 0.6), (X) => P.slide(X, c.s), u / 0.2);
    else if (u < 0.6) P.slide(T, c.s);
    else blend(T, (X) => P.slide(X, c.s), (X) => P.crouch(X, 0.3), seg(u, 0.6, 1));
  },
  keys: [K(0, null, { mus: 0.9, fwd: 4.0 }), K(0.5, null, { mus: 0.85, fwd: 2.0 }), K(0.9, null, { mus: 1, fwd: 0.6 })],
};
SEQ.charge = {
  // embestida con el hombro bajo
  kind: 'move', dur: 0.7, vel: true, brace: true,
  dyn: (T, B, c, t, u) => { if (u < 0.75) P.chargeLow(T, c.s); else blend(T, (X) => P.chargeLow(X, c.s), P.stand, seg(u, 0.75, 1)); },
  keys: [K(0, null, { mus: 1, fwd: 4.2 }), K(0.5, null, { mus: 1, fwd: 4.0 }), K(0.7, null, { mus: 1, fwd: 2.0 })],
};
SEQ.duck = {
  // agacharse de golpe (esquivar) y volver
  kind: 'move', dur: 0.45, brace: false,
  dyn: (T, B, c, t, u) => { P.crouch(T, Math.sin(u * Math.PI) * 0.95); },
  keys: [K(0, null, { mus: 1 }), K(0.45, null, { mus: 1 })],
};
SEQ.stagger_steps = {
  // pasos tambaleantes hacia adelante, doblado, sin llegar a caer
  kind: 'move', dur: 1.0, vel: true, brace: true,
  dyn: (T, B, c, t, u) => { blend(T, P.doubleOver, (X) => P.crouchTilt(X, 0.5, c.s), 0.35 + 0.65 * Math.sin(u * Math.PI)); },
  keys: [K(0, null, { mus: 0.7, fwd: 1.8 }), K(0.6, null, { mus: 0.75, fwd: 1.0 }), K(1.0, null, { mus: 1, fwd: 0.2 })],
};

for (const name in SEQ) SEQ[name].name = name;

// ═══ SALTOS: pose en el aire por estilo ══════════════════════════════════════
//  pose(T, u, c): u = 0 despegue … 1 aterrizaje; c = { s, ph }. `prep`:
//  segundos agachado antes de despegar; `land`: cuánto flexiona al caer.
export const JUMPS = {
  hop:      { pose: (T, u, c) => P.airHop(T, Math.sin(u * Math.PI)), prep: 0.10, land: 0.22 },
  skip:     { pose: (T, u, c) => P.airSkip(T, c.s), prep: 0.05, land: 0.15 },
  bound:    { pose: (T, u, c) => P.airSplit(T, c.s), prep: 0.12, land: 0.35 },
  tuck:     { pose: (T, u, c) => blend(T, P.airHop, P.airTuck, Math.sin(u * Math.PI)), prep: 0.14, land: 0.45 },
  superman: { pose: (T, u, c) => P.airSuperman(T), prep: 0.12, land: 0.5 },
  kick:     { pose: (T, u, c) => blend(T, (X) => P.airHop(X, 0.5), (X) => P.airKick(X, c.s), seg(u, 0.1, 0.5)), prep: 0.12, land: 0.4 },
  knee:     { pose: (T, u, c) => P.airKnee(T, c.s), prep: 0.12, land: 0.4 },
  star:     { pose: (T, u, c) => blend(T, P.airHop, P.airStar, Math.sin(u * Math.PI)), prep: 0.12, land: 0.35 },
  flail:    { pose: (T, u, c) => P.airFlail(T, c.ph + u * 9), prep: 0.08, land: 0.45 },
  drop:     { pose: (T, u, c) => P.airDrop(T), prep: 0.0, land: 0.55 },
  hurdle:   { pose: (T, u, c) => P.hurdle(T, c.s), prep: 0.06, land: 0.3 },
  wallkick: { pose: (T, u, c) => blend(T, (X) => P.airKick(X, c.s), P.airTuck, seg(u, 0.2, 0.8)), prep: 0.0, land: 0.4 },
  excited:  { pose: (T, u, c) => { P.airHop(T, 1); add(T, HAL, -0.10, 0.35, 0.10); add(T, HAR, 0.10, 0.35, 0.10); }, prep: 0.06, land: 0.15 },
};
for (const name in JUMPS) JUMPS[name].name = name;
/** Estilos de brinco de los que "pegan saltitos" al correr. */
export const HOP_STYLES = ['hop', 'skip', 'bound', 'kick', 'flail', 'excited'];

// ═══ TREPADAS y BAJADAS: pose por estilo, curvas de avance y de altura ═══════
//  pose(T, u, c): c = { rel (tapa − ancla ahora), s }. trv(u): fracción del
//  avance; hgt(u): fracción de la altura (0 = de salida, 1 = de llegada).
//  minSpeed: hace falta venir al menos así de rápido. w: pesos por tipo
//  (`parkour` pisa al tipo cuando el cuerpo tiene el rasgo).
export const VAULTS = {
  clamber:  { dur: 1.05, pose: (T, u, c) => P.clamber(T, u, c.rel, c.s), trv: ss, hgt: (u) => seg(u, 0.30, 0.75), minSpeed: 0, maxH: 1.05, w: { walker: 3, jogger: 2, runner: 0.6, brute: 3, player: 1.5, parkour: 0.2 } },
  speed:    { dur: 0.62, pose: (T, u, c) => P.speedVault(T, u, c.rel, c.s), trv: (u) => u, hgt: (u) => seg(u, 0.15, 0.55), minSpeed: 2.2, maxH: 0.95, w: { walker: 0.2, jogger: 1.5, runner: 3, brute: 0, player: 3, parkour: 3 } },
  kong:     { dur: 0.60, pose: (T, u, c) => P.kong(T, u, c.rel), trv: (u) => u, hgt: (u) => seg(u, 0.10, 0.50), minSpeed: 2.6, maxH: 1.05, w: { walker: 0, jogger: 0.4, runner: 1.5, brute: 0, player: 2, parkour: 5 } },
  dash:     { dur: 0.62, pose: (T, u, c) => P.dashVault(T, u, c.rel), trv: (u) => u, hgt: (u) => seg(u, 0.05, 0.40), minSpeed: 2.8, maxH: 0.9, w: { walker: 0, jogger: 0.3, runner: 1, brute: 0, player: 1.5, parkour: 4 } },
  rollover: { dur: 1.10, pose: (T, u, c) => P.rollOver(T, u, c.rel), trv: ss, hgt: (u) => seg(u, 0.15, 0.45), minSpeed: 1.0, maxH: 1.05, w: { walker: 1.5, jogger: 2, runner: 1, brute: 2, player: 0.5, parkour: 0.5 } },
  scramble: { dur: 1.25, pose: (T, u, c) => P.scrambleVault(T, u, c.rel), trv: ss, hgt: (u) => seg(u, 0.25, 0.65), minSpeed: 0, maxH: 1.05, w: { walker: 2.5, jogger: 1, runner: 1, brute: 1.5, player: 0, parkour: 0 } },
};
for (const name in VAULTS) VAULTS[name].name = name;
//  Bajadas: trv(u, V) recibe V.edgeF = fracción del avance donde está el borde
//  (primero se llega al borde, después se baja).
export const DESCENTS = {
  step: { dur: 1.0, pose: (T, u, c) => P.stepDown(T, u, c.rel, c.s), trv: (u, V) => { const e = V ? V.edgeF : 0.4; return u < 0.45 ? e * ss(u / 0.45) : e + (1 - e) * seg(u, 0.45, 1); }, hgt: (u) => seg(u, 0.45, 1), w: { walker: 3, jogger: 1.5, runner: 0.4, brute: 3, player: 0.5, parkour: 0 } },
  sit:  { dur: 1.3, pose: (T, u, c) => P.sitDrop(T, u, c.rel), trv: (u, V) => { const e = V ? V.edgeF : 0.4; return u < 0.4 ? e * ss(u / 0.4) : e + (1 - e) * seg(u, 0.4, 0.85); }, hgt: (u) => seg(u, 0.4, 0.85), w: { walker: 2, jogger: 0.8, runner: 0.1, brute: 2, player: 0, parkour: 0 } },
};
for (const name in DESCENTS) DESCENTS[name].name = name;
/** Sorteo con pesos por tipo; `parkour` reemplaza al tipo cuando el rasgo está. */
export function pickStyle(table, kind, parkour, rng, filter = null) {
  let tot = 0; const list = [];
  for (const name in table) {
    const s = table[name];
    if (filter && !filter(s)) continue;
    const w = s.w ? ((parkour && s.w.parkour != null) ? s.w.parkour : (s.w[kind] ?? 1)) : 1;
    if (w <= 0) continue;
    list.push([s, w]); tot += w;
  }
  if (!list.length) return null;
  let r = rng() * tot;
  for (const [s, w] of list) if ((r -= w) <= 0) return s;
  return list[list.length - 1][0];
}

/** Levantadas disponibles para una orientación, con peso por tipo de cuerpo. */
export function getUpsFor(from) {
  const out = [];
  for (const name in SEQ) { const s = SEQ[name]; if (s.kind === 'getup' && s.from === from) out.push(s); }
  return out;
}
export function pickWeighted(list, kind, rng, parkour = false) {
  const wOf = (s) => !s.w ? 1 : (parkour && s.w.parkour != null) ? s.w.parkour : (s.w[kind] != null ? s.w[kind] : 1);
  let tot = 0;
  for (const s of list) tot += wOf(s);
  if (tot <= 0) return list[Math.floor(rng() * list.length)];
  let r = rng() * tot;
  for (const s of list) { const w = wOf(s); if ((r -= w) <= 0) return s; }
  return list[list.length - 1];
}

// ═══ OVERLAYS: deltas sobre la pose base ═════════════════════════════════════
//  fn(T, u, k, c): u = tiempo normalizado 0..1, k = intensidad, c = contexto
//  ({sx: lado ±1, along/lat: dirección del golpe en local}). La campana e(u)
//  hace que el sacudón entre rápido y salga suave.
const bell = (u, peak = 0.25) => u < peak ? u / peak : Math.max(0, 1 - (u - peak) / (1 - peak));
const smooth = (u) => u * u * (3 - 2 * u);

export const OVER = {};
// — sacudones por tiro (flinch) — `along` = hacia dónde empuja el tiro en local (z+ adelante), `lat` = lateral
OVER.fl_head_snap = { dur: 0.42, fn: (T, u, k, c) => { const e = bell(u, 0.18) * k; add(T, HEAD, c.lat * 0.10 * e, -0.03 * e, c.along * 0.16 * e); add(T, NECK, c.lat * 0.05 * e, 0, c.along * 0.07 * e); add(T, CHEST, 0, 0, c.along * 0.03 * e); } };
OVER.fl_chest_fold = { dur: 0.5, fn: (T, u, k, c) => { const e = bell(u, 0.2) * k; add(T, CHEST, 0, -0.04 * e, c.along * 0.12 * e); add(T, NECK, 0, -0.06 * e, c.along * 0.16 * e); add(T, HEAD, 0, -0.10 * e, c.along * 0.20 * e); add(T, SHL, 0, -0.02 * e, c.along * 0.12 * e); add(T, SHR, 0, -0.02 * e, c.along * 0.12 * e); add(T, HAL, 0, 0.12 * e, -c.along * 0.22 * e); add(T, HAR, 0, 0.12 * e, -c.along * 0.22 * e); } };
OVER.fl_back_arch = { dur: 0.5, fn: (T, u, k, c) => { const e = bell(u, 0.2) * k; add(T, CHEST, 0, 0.02 * e, c.along * 0.10 * e); add(T, HEAD, 0, -0.02 * e, -c.along * 0.06 * e); add(T, SHL, 0, 0.04 * e, c.along * 0.10 * e); add(T, SHR, 0, 0.04 * e, c.along * 0.10 * e); add(T, HAL, -0.08 * e, 0.28 * e, c.along * 0.10 * e); add(T, HAR, 0.08 * e, 0.28 * e, c.along * 0.10 * e); add(T, ELL, -0.06 * e, 0.16 * e, 0); add(T, ELR, 0.06 * e, 0.16 * e, 0); } };
OVER.fl_gut = { dur: 0.6, fn: (T, u, k, c) => { const e = bell(u, 0.22) * k; add(T, CHEST, 0, -0.10 * e, 0.10 * e); add(T, NECK, 0, -0.16 * e, 0.16 * e); add(T, HEAD, 0, -0.22 * e, 0.20 * e); add(T, SHL, 0, -0.10 * e, 0.10 * e); add(T, SHR, 0, -0.10 * e, 0.10 * e); set(T, HAL, T[HAL * 3] * (1 - e) + (-0.10) * e, T[HAL * 3 + 1] * (1 - e) + 0.92 * e, T[HAL * 3 + 2] * (1 - e) + 0.16 * e); set(T, HAR, T[HAR * 3] * (1 - e) + 0.10 * e, T[HAR * 3 + 1] * (1 - e) + 0.92 * e, T[HAR * 3 + 2] * (1 - e) + 0.16 * e); } };
OVER.fl_shoulder = { dur: 0.45, fn: (T, u, k, c) => { const e = bell(u, 0.2) * k, sx = c.sx; const sh = sx > 0 ? SHR : SHL, el = sx > 0 ? ELR : ELL, ha = sx > 0 ? HAR : HAL; add(T, sh, c.lat * 0.06 * e, -0.02 * e, c.along * 0.14 * e); add(T, el, c.lat * 0.08 * e, 0.04 * e, c.along * 0.16 * e); add(T, ha, c.lat * 0.10 * e, 0.10 * e, c.along * 0.18 * e); add(T, HEAD, sx * 0.05 * e, 0, c.along * 0.05 * e); add(T, CHEST, 0, 0, c.along * 0.05 * e); } };
OVER.fl_arm_swing = { dur: 0.5, fn: (T, u, k, c) => { const e = bell(u, 0.15) * k, sx = c.sx; const el = sx > 0 ? ELR : ELL, ha = sx > 0 ? HAR : HAL; add(T, el, sx * 0.10 * e, 0.10 * e, c.along * 0.18 * e); add(T, ha, sx * 0.16 * e, 0.22 * e, c.along * 0.30 * e); } };
OVER.fl_hip_thrust = { dur: 0.45, fn: (T, u, k, c) => { const e = bell(u, 0.2) * k; add(T, HIP, 0, -0.03 * e, c.along * 0.10 * e); add(T, HPL, 0, -0.03 * e, c.along * 0.10 * e); add(T, HPR, 0, -0.03 * e, c.along * 0.10 * e); add(T, CHEST, 0, -0.02 * e, -c.along * 0.04 * e); add(T, HEAD, 0, -0.02 * e, -c.along * 0.08 * e); } };
OVER.fl_side_lean = { dur: 0.5, fn: (T, u, k, c) => { const e = bell(u, 0.2) * k; add(T, CHEST, c.lat * 0.08 * e, -0.02 * e, 0); add(T, NECK, c.lat * 0.12 * e, -0.03 * e, 0); add(T, HEAD, c.lat * 0.17 * e, -0.05 * e, 0); add(T, SHL, c.lat * 0.10 * e, 0, 0); add(T, SHR, c.lat * 0.10 * e, 0, 0); add(T, c.lat > 0 ? HAL : HAR, -c.lat * 0.06 * e, 0.16 * e, 0.04 * e); } };
OVER.fl_leg_hop = { dur: 0.5, fn: (T, u, k, c) => { const e = bell(u, 0.2) * k, sx = c.sx; const kn = sx > 0 ? KNR : KNL, ft = sx > 0 ? FTR : FTL; add(T, ft, 0, 0.16 * e, 0.06 * e); add(T, kn, sx * 0.04 * e, 0.10 * e, 0.10 * e); add(T, HIP, -sx * 0.04 * e, -0.03 * e, 0); add(T, CHEST, -sx * 0.06 * e, -0.02 * e, 0); add(T, HEAD, -sx * 0.06 * e, -0.02 * e, 0); } };
OVER.fl_jolt = { dur: 0.35, fn: (T, u, k, c) => { const e = bell(u, 0.12) * k; const j = Math.sin(u * 40) * 0.03 * e; add(T, HEAD, c.lat * 0.06 * e + j, 0, c.along * 0.10 * e); add(T, CHEST, j * 0.5, -0.02 * e, c.along * 0.07 * e); add(T, HAL, -j, 0.10 * e, c.along * 0.08 * e); add(T, HAR, j, 0.10 * e, c.along * 0.08 * e); add(T, SHL, 0, 0, c.along * 0.06 * e); add(T, SHR, 0, 0, c.along * 0.06 * e); } };

// — manotazos / ataques — (c.sx: lado que ataca)
OVER.atk_swipe = { dur: 0.48, fn: (T, u, k, c) => { const sx = c.sx, e = smooth(clamp01(u / 0.45)), r = bell(u, 0.45); const ha = sx > 0 ? HAR : HAL, el = sx > 0 ? ELR : ELL;
  // la mano va de afuera-atrás a adelante-cruzada, a la altura del pecho
  set(T, ha, sx * (0.55 - 1.0 * e), 1.05 + 0.15 * r, 0.10 + 0.55 * e); add(T, el, sx * (0.25 - 0.3 * e), 0.10 * r, 0.15 * e);
  add(T, CHEST, -sx * 0.06 * e, 0, 0.06 * e); add(T, SHL, sx * -0.04 * e, 0, 0.05 * e); add(T, SHR, sx * -0.04 * e, 0, 0.05 * e); add(T, HEAD, -sx * 0.05 * e, -0.02 * e, 0.06 * e); } };
OVER.atk_double = { dur: 0.55, fn: (T, u, k, c) => { const up = smooth(clamp01(u / 0.3)), dn = smooth(clamp01((u - 0.3) / 0.25));
  for (let s = 0; s < 2; s++) { const sx = s ? 1 : -1, ha = s ? HAR : HAL, el = s ? ELR : ELL; set(T, ha, sx * 0.22, 1.55 * up - 0.75 * dn, 0.15 + 0.10 * up + 0.50 * dn); add(T, el, 0, 0.22 * up - 0.18 * dn, 0.10 * dn); }
  add(T, CHEST, 0, 0.02 * up - 0.06 * dn, 0.02 * up + 0.10 * dn); add(T, HEAD, 0, 0.02 * up - 0.10 * dn, 0.12 * dn); } };
OVER.atk_grab = { dur: 0.7, fn: (T, u, k, c) => { const e = smooth(clamp01(u / 0.25)), hold = u > 0.25 ? 1 : e;
  for (let s = 0; s < 2; s++) { const sx = s ? 1 : -1, ha = s ? HAR : HAL, el = s ? ELR : ELL; set(T, ha, sx * (0.28 - 0.30 * hold), 1.10, 0.20 + 0.45 * hold); add(T, el, sx * 0.08 * hold, 0, 0.12 * hold); }
  add(T, CHEST, 0, 0, 0.08 * hold); add(T, HEAD, 0, 0, 0.10 * hold); } };
OVER.atk_bite = { dur: 0.45, fn: (T, u, k, c) => { const e = bell(u, 0.35); add(T, HEAD, 0, -0.12 * e, 0.26 * e); add(T, NECK, 0, -0.06 * e, 0.14 * e); add(T, CHEST, 0, -0.02 * e, 0.06 * e);
  for (let s = 0; s < 2; s++) { const sx = s ? 1 : -1, ha = s ? HAR : HAL; set(T, ha, sx * 0.12, 1.20 - 0.10 * e, 0.30 + 0.30 * e); } } };
OVER.atk_overhead = { dur: 0.75, fn: (T, u, k, c) => { const up = smooth(clamp01(u / 0.4)), dn = smooth(clamp01((u - 0.4) / 0.2));
  for (let s = 0; s < 2; s++) { const sx = s ? 1 : -1, ha = s ? HAR : HAL, el = s ? ELR : ELL; set(T, ha, sx * 0.18, 1.85 * up - 1.05 * dn, -0.10 * up + 0.75 * dn); set(T, el, sx * 0.26, 1.55 * up - 0.75 * dn + (1 - up) * 1.15, -0.05 * up + 0.35 * dn + (1 - up) * 0.02); }
  add(T, CHEST, 0, 0.04 * up - 0.14 * dn, -0.06 * up + 0.16 * dn); add(T, HEAD, 0, 0.04 * up - 0.16 * dn, -0.08 * up + 0.22 * dn); add(T, NECK, 0, 0.03 * up - 0.12 * dn, -0.05 * up + 0.16 * dn); } };

// — tics de quieto — (bucle; u cíclico)
OVER.id_twitch = { dur: 2.4, loop: true, fn: (T, u, k, c) => { const t = u * 2.4; const j1 = Math.exp(-((t - 0.6) ** 2) * 40), j2 = Math.exp(-((t - 1.7) ** 2) * 60); add(T, HEAD, 0.05 * j1 - 0.04 * j2, -0.02 * j2, 0.02 * j1); add(T, SHR, 0, 0.05 * j1, 0); add(T, HAR, 0.04 * j1, 0.08 * j1, 0); add(T, SHL, 0, 0.04 * j2, 0); add(T, HAL, -0.03 * j2, 0.06 * j2, 0); } };
OVER.id_look = { dur: 3.6, loop: true, fn: (T, u, k, c) => { const a = Math.sin(u * Math.PI * 2) * 0.12, b = Math.sin(u * Math.PI * 4 + 1) * 0.03; add(T, HEAD, a, 0, -Math.abs(a) * 0.3); add(T, NECK, a * 0.4, 0, 0); add(T, CHEST, a * 0.15, 0, 0); add(T, HEAD, 0, b, 0); } };
OVER.id_scratch = { dur: 2.8, loop: true, fn: (T, u, k, c) => { const e = smooth(clamp01(u / 0.25)) * smooth(clamp01((0.85 - u) / 0.25)); const w = Math.sin(u * 40) * 0.02 * e; set(T, HAR, T[HAR * 3] * (1 - e) + (0.12 + w) * e, T[HAR * 3 + 1] * (1 - e) + 1.62 * e, T[HAR * 3 + 2] * (1 - e) + 0.10 * e); add(T, ELR, 0.12 * e, 0.28 * e, 0.06 * e); add(T, HEAD, 0.04 * e, -0.02 * e, 0); } };
OVER.id_hunch = { dur: 4.0, loop: true, fn: (T, u, k, c) => { const e = 0.5 - 0.5 * Math.cos(u * Math.PI * 2); add(T, CHEST, 0, -0.05 * e, 0.06 * e); add(T, NECK, 0, -0.08 * e, 0.10 * e); add(T, HEAD, 0, -0.12 * e, 0.14 * e); add(T, SHL, 0, -0.04 * e, 0.06 * e); add(T, SHR, 0, -0.04 * e, 0.06 * e); add(T, HAL, 0, -0.04 * e, 0.02 * e); add(T, HAR, 0, -0.04 * e, 0.02 * e); } };
OVER.id_spasm = { dur: 3.2, loop: true, fn: (T, u, k, c) => { const t = u * 3.2; const e = t > 1.2 && t < 1.7 ? Math.sin((t - 1.2) / 0.5 * Math.PI) : 0; const j = Math.sin(t * 70) * 0.05 * e; add(T, HEAD, j, -0.03 * e, j * 0.5); add(T, CHEST, j * 0.6, 0, 0); add(T, HAL, -j, 0.12 * e, j); add(T, HAR, j, 0.12 * e, -j); add(T, SHL, j * 0.5, 0.03 * e, 0); add(T, SHR, -j * 0.5, 0.03 * e, 0); } };
OVER.id_retch = { dur: 4.4, loop: true, fn: (T, u, k, c) => { const t = u * 4.4; const e = t > 1.0 && t < 2.6 ? Math.sin((t - 1.0) / 1.6 * Math.PI) : 0; const h = Math.sin(t * 18) * 0.03 * e; add(T, CHEST, 0, -0.10 * e, 0.12 * e); add(T, NECK, 0, -0.18 * e, 0.20 * e + h); add(T, HEAD, 0, -0.26 * e, 0.26 * e + h * 1.5); add(T, SHL, 0, -0.10 * e, 0.10 * e); add(T, SHR, 0, -0.10 * e, 0.10 * e); set(T, HAL, T[HAL * 3] * (1 - e) - 0.12 * e, T[HAL * 3 + 1] * (1 - e) + 0.95 * e, T[HAL * 3 + 2] * (1 - e) + 0.18 * e); set(T, HAR, T[HAR * 3] * (1 - e) + 0.12 * e, T[HAR * 3 + 1] * (1 - e) + 0.95 * e, T[HAR * 3 + 2] * (1 - e) + 0.18 * e); } };
OVER.id_sway = { dur: 5.0, loop: true, fn: (T, u, k, c) => { const a = Math.sin(u * Math.PI * 2) * 0.05, b = Math.sin(u * Math.PI * 4 + 0.7) * 0.02; add(T, CHEST, a, 0, b); add(T, NECK, a * 1.4, 0, b * 1.3); add(T, HEAD, a * 1.9, 0, b * 1.6); add(T, SHL, a, 0, b); add(T, SHR, a, 0, b); } };
OVER.id_headhang = { dur: 6.0, loop: true, fn: (T, u, k, c) => { const e = 0.6 + 0.4 * Math.sin(u * Math.PI * 2); add(T, HEAD, 0.02 * e, -0.14 * e, 0.14 * e); add(T, NECK, 0, -0.06 * e, 0.08 * e); add(T, HAL, 0, -0.02 * e, -0.04 * e); add(T, HAR, 0, -0.02 * e, -0.04 * e); } };
// — sacudir la cabeza al levantarse (aturdido) —
OVER.headshake = { dur: 0.9, fn: (T, u, k, c) => { const e = bell(u, 0.3); const a = Math.sin(u * 22) * 0.07 * e; add(T, HEAD, a, -0.02 * e, 0); add(T, NECK, a * 0.4, 0, 0); } };

// — más sacudones por golpe: latigazo, rodillas que ceden, agarrarse la herida, convulsión… —
OVER.fl_whiplash = { dur: 0.55, fn: (T, u, k, c) => { const e1 = bell(u, 0.15) * k, e2 = bell(clamp01((u - 0.2) / 0.8), 0.3) * k; add(T, HEAD, c.lat * 0.06 * e1, -0.02 * e1, c.along * 0.18 * e1 - c.along * 0.12 * e2); add(T, NECK, 0, 0, c.along * 0.08 * e1 - c.along * 0.05 * e2); add(T, CHEST, 0, 0, c.along * 0.04 * e1); } };
OVER.fl_knee_dip = { dur: 0.5, fn: (T, u, k, c) => { const e = bell(u, 0.25) * k * 0.16; for (const i of [HIP, HPL, HPR, CHEST, NECK, HEAD, SHL, SHR]) add(T, i, 0, -e, 0); add(T, KNL, 0, -e * 0.3, e * 0.5); add(T, KNR, 0, -e * 0.3, e * 0.5); add(T, HEAD, 0, -e * 0.4, e * 0.6); } };
OVER.fl_clutch_arm = { dur: 0.9, fn: (T, u, k, c) => { const e = smooth(clamp01(u / 0.2)) * smooth(clamp01((1 - u) / 0.25)), sx = c.sx; const el = sx > 0 ? ELR : ELL, ha = sx > 0 ? HAL : HAR;
  set(T, ha, T[ha * 3] * (1 - e) + sx * 0.24 * e, T[ha * 3 + 1] * (1 - e) + 1.20 * e, T[ha * 3 + 2] * (1 - e) + 0.12 * e); add(T, el, sx * 0.04 * e, -0.04 * e, 0.08 * e); add(T, HEAD, sx * 0.05 * e, -0.05 * e, 0.06 * e); add(T, CHEST, sx * 0.03 * e, -0.02 * e, 0.03 * e); } };
OVER.fl_clutch_face = { dur: 0.8, fn: (T, u, k, c) => { const e = smooth(clamp01(u / 0.15)) * smooth(clamp01((1 - u) / 0.3)); for (let s = 0; s < 2; s++) { const ha = s ? HAR : HAL, sx = s ? 1 : -1; set(T, ha, T[ha * 3] * (1 - e) + sx * 0.10 * e, T[ha * 3 + 1] * (1 - e) + 1.62 * e, T[ha * 3 + 2] * (1 - e) + 0.16 * e); } add(T, HEAD, 0, -0.06 * e, c.along * 0.10 * e); add(T, CHEST, 0, -0.03 * e, 0.04 * e); } };
OVER.fl_clutch_gut = { dur: 1.4, fn: (T, u, k, c) => { const e = smooth(clamp01(u / 0.15)) * smooth(clamp01((1 - u) / 0.35)); for (let s = 0; s < 2; s++) { const ha = s ? HAR : HAL, sx = s ? 1 : -1; set(T, ha, T[ha * 3] * (1 - e) + sx * 0.08 * e, T[ha * 3 + 1] * (1 - e) + 0.98 * e, T[ha * 3 + 2] * (1 - e) + 0.15 * e); } add(T, CHEST, 0, -0.08 * e, 0.10 * e); add(T, NECK, 0, -0.13 * e, 0.15 * e); add(T, HEAD, 0, -0.18 * e, 0.18 * e); add(T, SHL, 0, -0.08 * e, 0.08 * e); add(T, SHR, 0, -0.08 * e, 0.08 * e); } };
OVER.fl_spin_shoulder = { dur: 0.5, fn: (T, u, k, c) => { const e = bell(u, 0.2) * k, sx = c.sx; const sh = sx > 0 ? SHR : SHL, osh = sx > 0 ? SHL : SHR, ha = sx > 0 ? HAR : HAL; add(T, sh, 0, 0.02 * e, c.along * 0.20 * e); add(T, osh, 0, 0, -c.along * 0.12 * e); add(T, HEAD, sx * 0.08 * e, 0, c.along * 0.08 * e); add(T, CHEST, sx * 0.03 * e, 0, c.along * 0.05 * e); add(T, ha, sx * 0.12 * e, 0.16 * e, c.along * 0.25 * e); } };
OVER.fl_convulse = { dur: 0.6, fn: (T, u, k, c) => { const e = bell(u, 0.1) * k; const j = Math.sin(u * 55) * 0.045 * e, j2 = Math.cos(u * 47) * 0.035 * e; add(T, HEAD, j, -0.03 * e + j2 * 0.5, c.along * 0.08 * e); add(T, CHEST, j * 0.6, j2 * 0.4, c.along * 0.05 * e); add(T, HAL, -j * 1.5, 0.14 * e + j2, j); add(T, HAR, j * 1.5, 0.14 * e - j2, -j); add(T, KNL, j * 0.5, 0.04 * e, 0); add(T, KNR, -j * 0.5, 0.04 * e, 0); } };
OVER.fl_hip_twist = { dur: 0.5, fn: (T, u, k, c) => { const e = bell(u, 0.2) * k, sx = c.sx; add(T, HPL, -sx * 0.03 * e, 0, sx * c.lat * 0.10 * e); add(T, HPR, sx * 0.03 * e, 0, -sx * c.lat * 0.10 * e); add(T, HIP, c.lat * 0.06 * e, -0.02 * e, c.along * 0.06 * e); add(T, CHEST, -c.lat * 0.04 * e, 0, 0); add(T, HEAD, -c.lat * 0.06 * e, 0, 0); } };
OVER.fl_shrug_roll = { dur: 0.55, fn: (T, u, k, c) => { const e = bell(u, 0.2) * k, sx = c.sx; const sh = sx > 0 ? SHR : SHL; add(T, sh, 0, 0.10 * e, -0.04 * e); add(T, HEAD, -sx * 0.10 * e, -0.03 * e, 0); add(T, NECK, -sx * 0.05 * e, -0.02 * e, 0); add(T, CHEST, -sx * 0.02 * e, 0, c.along * 0.05 * e); } };
OVER.fl_balance_arms = { dur: 0.7, fn: (T, u, k, c) => { const e = bell(u, 0.3) * k; add(T, HAL, -0.28 * e, 0.42 * e, -0.08 * e); add(T, HAR, 0.28 * e, 0.42 * e, -0.08 * e); add(T, ELL, -0.14 * e, 0.22 * e, -0.05 * e); add(T, ELR, 0.14 * e, 0.22 * e, -0.05 * e); add(T, CHEST, 0, 0, -c.along * 0.05 * e); } };
OVER.fl_crumple_partial = { dur: 0.8, fn: (T, u, k, c) => { const e = bell(u, 0.3) * k * 0.30, sx = c.sx; for (const i of [HIP, HPL, HPR, CHEST, NECK, HEAD, SHL, SHR]) add(T, i, 0, -e, 0); add(T, sx > 0 ? KNR : KNL, 0, -e * 0.4, e * 0.6); add(T, CHEST, sx * 0.04 * e, 0, e * 0.4); add(T, HEAD, sx * 0.06 * e, -e * 0.3, e * 0.6); add(T, HAL, 0, -e * 0.5, e); add(T, HAR, 0, -e * 0.5, e); } };

// — heridas sostenidas (bucle): una mano apretando la herida mientras sigue andando; k = cuánto —
OVER.wd_gut = { dur: 2.0, loop: true, fn: (T, u, k, c) => { const e = k, sx = c.sx; const ha = sx > 0 ? HAR : HAL; set(T, ha, T[ha * 3] * (1 - e) + sx * 0.06 * e, T[ha * 3 + 1] * (1 - e) + 0.98 * e, T[ha * 3 + 2] * (1 - e) + 0.14 * e); add(T, CHEST, 0, -0.04 * e, 0.06 * e); add(T, NECK, 0, -0.07 * e, 0.09 * e); add(T, HEAD, 0, -0.10 * e, 0.10 * e); } };
OVER.wd_shoulder = { dur: 2.0, loop: true, fn: (T, u, k, c) => { const e = k, sx = c.sx; const ha = sx > 0 ? HAL : HAR; set(T, ha, T[ha * 3] * (1 - e) + sx * 0.20 * e, T[ha * 3 + 1] * (1 - e) + 1.42 * e, T[ha * 3 + 2] * (1 - e) + 0.08 * e); add(T, sx > 0 ? SHR : SHL, 0, -0.03 * e, 0.04 * e); add(T, HEAD, sx * 0.03 * e, -0.02 * e, 0); } };
OVER.wd_neck = { dur: 2.0, loop: true, fn: (T, u, k, c) => { const e = k, sx = c.sx; const ha = sx > 0 ? HAR : HAL; set(T, ha, T[ha * 3] * (1 - e) + sx * 0.07 * e, T[ha * 3 + 1] * (1 - e) + 1.52 * e, T[ha * 3 + 2] * (1 - e) + 0.08 * e); add(T, HEAD, sx * 0.06 * e, -0.03 * e, 0); add(T, NECK, sx * 0.03 * e, 0, 0); } };
OVER.wd_thigh = { dur: 2.0, loop: true, fn: (T, u, k, c) => { const e = k, sx = c.sx; const ha = sx > 0 ? HAR : HAL; set(T, ha, T[ha * 3] * (1 - e) + sx * 0.20 * e, T[ha * 3 + 1] * (1 - e) + 0.72 * e, T[ha * 3 + 2] * (1 - e) + 0.16 * e); add(T, CHEST, sx * 0.02 * e, -0.03 * e, 0.04 * e); add(T, HEAD, sx * 0.03 * e, -0.05 * e, 0.05 * e); } };
OVER.wd_head = { dur: 2.0, loop: true, fn: (T, u, k, c) => { const e = k, sx = c.sx; const ha = sx > 0 ? HAR : HAL; set(T, ha, T[ha * 3] * (1 - e) + sx * 0.11 * e, T[ha * 3 + 1] * (1 - e) + 1.70 * e, T[ha * 3 + 2] * (1 - e) + 0.06 * e); add(T, HEAD, sx * 0.02 * e, -0.03 * e, 0.03 * e); } };
/** Herida sostenida por zona del hueso: 0 cabeza · 1 torso · 2 brazo · 3 pierna. */
export const WOUNDS = { 0: 'wd_head', 1: 'wd_gut', 2: 'wd_shoulder', 3: 'wd_thigh' };

// — más ataques — (c.sx: lado que ataca)
OVER.atk_headbutt = { dur: 0.5, fn: (T, u, k, c) => { const w = smooth(clamp01(u / 0.3)), h = smooth(clamp01((u - 0.3) / 0.15)) * (1 - smooth(clamp01((u - 0.6) / 0.4))); add(T, HEAD, 0, 0.03 * w - 0.10 * h, -0.10 * w + 0.32 * h); add(T, NECK, 0, 0.02 * w - 0.05 * h, -0.05 * w + 0.16 * h); add(T, CHEST, 0, 0, -0.03 * w + 0.08 * h); for (let s = 0; s < 2; s++) { const ha = s ? HAR : HAL, sx = s ? 1 : -1; set(T, ha, sx * 0.22, 1.25, 0.30 + 0.15 * h); } } };
OVER.atk_claw = { dur: 0.5, fn: (T, u, k, c) => { const sx = c.sx, e = smooth(clamp01(u / 0.4)); const ha = sx > 0 ? HAR : HAL, el = sx > 0 ? ELR : ELL; set(T, ha, sx * (0.20 - 0.35 * e), 1.75 - 1.05 * e, 0.10 + 0.50 * e); add(T, el, sx * 0.10, 0.25 * (1 - e), 0.10 * e); add(T, CHEST, 0, 0.02 * (1 - e) - 0.05 * e, 0.06 * e); add(T, HEAD, 0, -0.04 * e, 0.08 * e); } };
OVER.atk_uppercut = { dur: 0.5, fn: (T, u, k, c) => { const sx = c.sx, wind = smooth(clamp01(u / 0.28)), up = smooth(clamp01((u - 0.28) / 0.18)), rel = smooth(clamp01((u - 0.7) / 0.3)), e = 1 - rel; const ha = sx > 0 ? HAR : HAL, el = sx > 0 ? ELR : ELL;
  set(T, ha, sx * (0.30 - 0.20 * up) * e + T[ha * 3] * rel, (0.70 - 0.15 * wind + 1.05 * up) * e + T[ha * 3 + 1] * rel, (0.05 + 0.55 * up) * e + T[ha * 3 + 2] * rel); add(T, el, sx * 0.06 * e, (-0.10 * wind + 0.35 * up) * e, 0.25 * up * e);
  for (const i of [HIP, HPL, HPR, CHEST, NECK, HEAD, SHL, SHR]) add(T, i, 0, (-0.12 * wind * (1 - up) + 0.06 * up) * e, 0); add(T, CHEST, 0, 0, 0.08 * up * e); add(T, HEAD, 0, 0.02 * up * e, -0.04 * up * e); } };
OVER.atk_haymaker = { dur: 0.85, fn: (T, u, k, c) => { const sx = c.sx, wind = smooth(clamp01(u / 0.45)), sw = smooth(clamp01((u - 0.45) / 0.2)), rel = smooth(clamp01((u - 0.75) / 0.25)), e = 1 - rel; const ha = sx > 0 ? HAR : HAL, el = sx > 0 ? ELR : ELL;
  const hx = sx * (0.55 * wind - 1.0 * sw), hy = 1.20 + 0.40 * wind - 0.15 * sw, hz = -0.35 * wind + 0.95 * sw;
  set(T, ha, hx * e + T[ha * 3] * rel, hy * e + T[ha * 3 + 1] * rel, hz * e + T[ha * 3 + 2] * rel);
  add(T, el, sx * 0.20 * wind * (1 - sw) * e, 0.25 * wind * e, (-0.10 * wind + 0.25 * sw) * e);
  const tw = (-0.08 * wind + 0.10 * sw) * e;
  add(T, CHEST, sx * tw, 0, (-0.04 * wind + 0.10 * sw) * e); add(T, SHR, sx * tw * 0.6, 0, sx * tw); add(T, SHL, sx * tw * 0.6, 0, -sx * tw); add(T, HEAD, sx * tw * 0.8, 0, 0.06 * sw * e); } };
OVER.atk_backhand = { dur: 0.42, fn: (T, u, k, c) => { const sx = c.sx, e = smooth(clamp01(u / 0.35)), r = bell(u, 0.35); const ha = sx > 0 ? HAR : HAL, el = sx > 0 ? ELR : ELL; set(T, ha, sx * (-0.35 + 1.05 * e), 1.20 + 0.10 * r, 0.25 + 0.30 * e); add(T, el, sx * (-0.15 + 0.30 * e), 0.10 * r, 0.10 * e); add(T, CHEST, sx * 0.06 * e, 0, 0.04 * e); add(T, HEAD, sx * 0.06 * e, 0, 0.03 * e); } };
OVER.atk_knee = { dur: 0.55, fn: (T, u, k, c) => { const sx = c.sx, e = smooth(clamp01(u / 0.3)) * (1 - smooth(clamp01((u - 0.6) / 0.4))); const kn = sx > 0 ? KNR : KNL, ft = sx > 0 ? FTR : FTL; add(T, kn, 0, 0.45 * e, 0.30 * e); add(T, ft, 0, 0.40 * e, 0.05 * e); for (let s = 0; s < 2; s++) { const ha = s ? HAR : HAL, hx = s ? 1 : -1; set(T, ha, T[ha * 3] * (1 - e) + hx * 0.22 * e, T[ha * 3 + 1] * (1 - e) + 1.30 * e, T[ha * 3 + 2] * (1 - e) + 0.45 * e); } add(T, CHEST, 0, -0.04 * e, 0.06 * e); add(T, HEAD, 0, -0.06 * e, 0.08 * e); add(T, HIP, -sx * 0.03 * e, 0, 0.04 * e); } };
OVER.atk_kick = { dur: 0.6, fn: (T, u, k, c) => { const sx = c.sx, ch = smooth(clamp01(u / 0.25)), ext = smooth(clamp01((u - 0.25) / 0.15)) * (1 - smooth(clamp01((u - 0.6) / 0.4))); const kn = sx > 0 ? KNR : KNL, ft = sx > 0 ? FTR : FTL; add(T, kn, 0, 0.40 * ch, 0.25 * ch + 0.15 * ext); add(T, ft, 0, 0.30 * ch + 0.35 * ext, 0.05 * ch + 0.60 * ext); add(T, HIP, 0, 0, -0.06 * ext); add(T, CHEST, 0, 0.02 * ext, -0.12 * ext); add(T, HEAD, 0, 0.02 * ext, -0.14 * ext); add(T, HAL, -0.15 * ch, 0.25 * ch, -0.10 * ext); add(T, HAR, 0.15 * ch, 0.25 * ch, -0.10 * ext); } };
OVER.atk_stomp = { dur: 0.7, fn: (T, u, k, c) => { const sx = c.sx, lift = smooth(clamp01(u / 0.4)) * (1 - smooth(clamp01((u - 0.4) / 0.12))), dn = smooth(clamp01((u - 0.4) / 0.12)) * (1 - smooth(clamp01((u - 0.75) / 0.25))); const kn = sx > 0 ? KNR : KNL, ft = sx > 0 ? FTR : FTL; add(T, kn, 0, 0.45 * lift, 0.28 * lift); add(T, ft, 0, 0.55 * lift, 0.25 * lift); for (const i of [HIP, HPL, HPR, CHEST, NECK, HEAD, SHL, SHR]) add(T, i, 0, 0.04 * lift - 0.10 * dn, 0.04 * dn); add(T, HAL, -0.10 * lift, 0.30 * lift, 0); add(T, HAR, 0.10 * lift, 0.30 * lift, 0); add(T, HEAD, 0, -0.06 * dn, 0.10 * dn); } };
OVER.atk_frenzy = { dur: 0.95, fn: (T, u, k, c) => { const t = u * 0.95; for (let s = 0; s < 2; s++) { const ha = s ? HAR : HAL, el = s ? ELR : ELL, sx = s ? 1 : -1; const sw = Math.sin(t * 7.5 + (s ? Math.PI : 0)); set(T, ha, sx * (0.45 - 0.55 * Math.max(0, sw)), 1.10 + 0.20 * Math.max(0, -sw), 0.10 + 0.55 * Math.max(0, sw)); add(T, el, sx * (0.15 - 0.20 * Math.max(0, sw)), 0.05, 0.10 * Math.max(0, sw)); } const lean = smooth(clamp01(u / 0.2)) * (1 - smooth(clamp01((u - 0.8) / 0.2))); add(T, CHEST, 0, -0.03 * lean, 0.10 * lean); add(T, HEAD, Math.sin(t * 15) * 0.03, -0.04 * lean, 0.12 * lean); } };
OVER.atk_shake = { dur: 0.9, fn: (T, u, k, c) => { const grab = smooth(clamp01(u / 0.2)), sh = u > 0.2 && u < 0.8 ? Math.sin((u - 0.2) * 40) : 0; for (let s = 0; s < 2; s++) { const ha = s ? HAR : HAL, el = s ? ELR : ELL, sx = s ? 1 : -1; set(T, ha, sx * (0.28 - 0.30 * grab) + sh * 0.06, 1.15 + sh * 0.05, 0.20 + 0.45 * grab); add(T, el, sx * 0.08 * grab, sh * 0.04, 0.12 * grab); } add(T, CHEST, sh * 0.04, 0, 0.08 * grab); add(T, HEAD, sh * 0.06, -0.02 * grab, 0.12 * grab); add(T, SHL, sh * 0.04, 0, 0.04 * grab); add(T, SHR, sh * 0.04, 0, 0.04 * grab); } };
OVER.atk_spin_swipe = { dur: 0.8, fn: (T, u, k, c) => { const sx = c.sx, e = smooth(clamp01(u / 0.2)) * (1 - smooth(clamp01((u - 0.75) / 0.25))); const ha = sx > 0 ? HAR : HAL, el = sx > 0 ? ELR : ELL, oh = sx > 0 ? HAL : HAR; set(T, ha, T[ha * 3] * (1 - e) + sx * 0.70 * e, T[ha * 3 + 1] * (1 - e) + 1.35 * e, T[ha * 3 + 2] * (1 - e) + 0.15 * e); add(T, el, sx * 0.30 * e, 0.20 * e, 0.05 * e); add(T, oh, -sx * 0.10 * e, 0.35 * e, 0); add(T, CHEST, sx * 0.04 * e, -0.03 * e, 0); add(T, HEAD, sx * 0.05 * e, -0.02 * e, 0); } };
OVER.atk_slam_fists = { dur: 0.9, fn: (T, u, k, c) => { const up = smooth(clamp01(u / 0.4)), dn = smooth(clamp01((u - 0.4) / 0.15)) * (1 - smooth(clamp01((u - 0.7) / 0.3))); for (let s = 0; s < 2; s++) { const ha = s ? HAR : HAL, el = s ? ELR : ELL, sx = s ? 1 : -1; set(T, ha, sx * 0.20, 1.95 * up - 1.35 * dn + (1 - up) * 0.86, -0.15 * up + 0.85 * dn); set(T, el, sx * 0.28, 1.55 * up - 0.75 * dn + (1 - up) * 1.15, -0.10 * up + 0.45 * dn); } for (const i of [HIP, HPL, HPR, CHEST, NECK, HEAD, SHL, SHR]) add(T, i, 0, 0.05 * up - 0.22 * dn, 0.12 * dn); add(T, CHEST, 0, 0, -0.06 * up + 0.10 * dn); add(T, HEAD, 0, 0.02 * up - 0.10 * dn, -0.08 * up + 0.22 * dn); add(T, KNL, 0, 0, 0.10 * dn); add(T, KNR, 0, 0, 0.10 * dn); } };
OVER.atk_bite_neck = { dur: 0.75, fn: (T, u, k, c) => { const grab = smooth(clamp01(u / 0.25)), bite = bell(clamp01((u - 0.25) / 0.5), 0.4); for (let s = 0; s < 2; s++) { const ha = s ? HAR : HAL, sx = s ? 1 : -1; set(T, ha, sx * (0.28 - 0.32 * grab), 1.35 - 0.05 * bite, 0.20 + 0.42 * grab); } add(T, HEAD, c.sx * 0.06 * bite, -0.08 * bite + 0.02 * grab, 0.10 * grab + 0.24 * bite); add(T, NECK, 0, -0.04 * bite, 0.06 * grab + 0.12 * bite); add(T, CHEST, 0, -0.02 * bite, 0.08 * grab + 0.05 * bite); } };
OVER.atk_lunge_grab = { dur: 0.7, fn: (T, u, k, c) => { const e = smooth(clamp01(u / 0.2)), hold = u > 0.2 ? 1 : e; for (let s = 0; s < 2; s++) { const ha = s ? HAR : HAL, el = s ? ELR : ELL, sx = s ? 1 : -1; set(T, ha, sx * (0.32 - 0.22 * hold), 1.20 + 0.15 * hold, 0.25 + 0.60 * hold); add(T, el, sx * 0.05 * hold, 0.10 * hold, 0.25 * hold); } add(T, CHEST, 0, -0.02 * hold, 0.14 * hold); add(T, NECK, 0, 0, 0.18 * hold); add(T, HEAD, 0, -0.03 * hold, 0.22 * hold); } };
OVER.atk_double_rake = { dur: 0.6, fn: (T, u, k, c) => { const e = smooth(clamp01(u / 0.4)); for (let s = 0; s < 2; s++) { const ha = s ? HAR : HAL, el = s ? ELR : ELL, sx = s ? 1 : -1; set(T, ha, sx * (0.45 - 0.20 * e), 1.80 - 1.10 * e, 0.10 + 0.50 * e); add(T, el, sx * 0.15, 0.20 * (1 - e), 0.10 * e); } add(T, CHEST, 0, 0.03 * (1 - e) - 0.06 * e, 0.08 * e); add(T, HEAD, 0, -0.06 * e, 0.10 * e); } };

// — atrapar la pared con las manos (el ágil que se estrella no se cae: frena con los brazos y rebota) —
OVER.wall_catch = { dur: 0.6, fn: (T, u, k, c) => { const e = smooth(clamp01(u / 0.12)) * (1 - smooth(clamp01((u - 0.45) / 0.55))); for (let s = 0; s < 2; s++) { const ha = s ? HAR : HAL, el = s ? ELR : ELL, sx = s ? 1 : -1; set(T, ha, T[ha * 3] * (1 - e) + sx * 0.24 * e, T[ha * 3 + 1] * (1 - e) + 1.30 * e, T[ha * 3 + 2] * (1 - e) + 0.62 * e); add(T, el, sx * 0.06 * e, 0.06 * e, 0.25 * e); } const rec = bell(u, 0.25) * k; add(T, HEAD, 0, -0.03 * rec, -0.12 * rec); add(T, NECK, 0, 0, -0.06 * rec); add(T, CHEST, 0, -0.02 * rec, -0.04 * rec); add(T, SHL, 0, 0, 0.06 * e); add(T, SHR, 0, 0, 0.06 * e); } };

// — más tics de quieto —
OVER.id_stretch = { dur: 4.2, loop: true, fn: (T, u, k, c) => { const e = smooth(clamp01((u - 0.2) / 0.3)) * smooth(clamp01((0.9 - u) / 0.3)); add(T, HAL, -0.05 * e, 0.75 * e, 0.05 * e); add(T, HAR, 0.05 * e, 0.75 * e, 0.05 * e); add(T, ELL, -0.08 * e, 0.40 * e, 0); add(T, ELR, 0.08 * e, 0.40 * e, 0); add(T, CHEST, 0, 0.03 * e, -0.04 * e); add(T, HEAD, 0, 0.02 * e, -0.08 * e); } };
OVER.id_stomp = { dur: 3.0, loop: true, fn: (T, u, k, c) => { const t = u * 3.0; const e = t > 0.8 && t < 1.4 ? Math.sin((t - 0.8) / 0.6 * Math.PI) : 0; add(T, FTR, 0, 0.18 * e, 0.06 * e); add(T, KNR, 0.02 * e, 0.14 * e, 0.10 * e); add(T, HIP, -0.03 * e, -0.02 * e, 0); add(T, CHEST, -0.04 * e, -0.02 * e, 0); add(T, HEAD, -0.03 * e, -0.03 * e, 0.03 * e); } };
OVER.id_claw_air = { dur: 2.6, loop: true, fn: (T, u, k, c) => { const t = u * 2.6; const e = t > 0.5 && t < 2.0 ? Math.sin((t - 0.5) / 1.5 * Math.PI) : 0; const g = Math.sin(t * 9) * 0.05 * e; set(T, HAR, T[HAR * 3] * (1 - e) + (0.30 + g) * e, T[HAR * 3 + 1] * (1 - e) + (1.35 + g * 0.6) * e, T[HAR * 3 + 2] * (1 - e) + 0.45 * e); add(T, ELR, 0.10 * e, 0.10 * e, 0.10 * e); add(T, HEAD, 0.03 * e, -0.02 * e, 0.06 * e); } };
OVER.id_bob = { dur: 1.6, loop: true, fn: (T, u, k, c) => { const e = 0.5 - 0.5 * Math.cos(u * Math.PI * 2); const dy = -0.07 * e; for (const i of [HIP, HPL, HPR, CHEST, NECK, HEAD, SHL, SHR]) add(T, i, 0, dy, 0); add(T, KNL, 0, dy * 0.3, 0.05 * e); add(T, KNR, 0, dy * 0.3, 0.05 * e); add(T, HAL, 0, -dy * 0.5, 0); add(T, HAR, 0, -dy * 0.5, 0); } };

for (const name in OVER) OVER[name].name = name;
export const IDLE_OVERLAYS = ['id_twitch', 'id_look', 'id_scratch', 'id_hunch', 'id_spasm', 'id_retch', 'id_sway', 'id_headhang', 'id_stretch', 'id_stomp', 'id_claw_air'];

// ═══ ESTILOS DE MARCHA ═══════════════════════════════════════════════════════
//  Parámetros que `_syncTarget` lee. Cada cuerpo sortea uno al nacer.
//   lean/hunch: inclinación y encorvamiento extra · armStyle: cómo van los
//   brazos corriendo (pump, flail, back, reach, clutch, wide, one, low,
//   windmill, high) · headDown: cabeza gacha · zigzag: bandeo lateral
//   · dragLeg: un pie que casi no se levanta · stomp: pisadas altas
//   · shoulder: un hombro adelante · crouchRun: corre agachado
export const RUN_STYLES = [
  { name: 'sprint',   lean: 0.06, armStyle: 'pump',    strideMul: 1.10, bobMul: 0.9 },
  { name: 'charge',   lean: 0.16, hunch: 0.06, armStyle: 'back', strideMul: 1.05, headDown: 0.10, bobMul: 1.2 },
  { name: 'flail',    lean: 0.04, armStyle: 'flail',   strideMul: 1.00, bobMul: 1.3, jitter: 0.5 },
  { name: 'lunge',    lean: 0.12, armStyle: 'reach',   strideMul: 1.25, bobMul: 1.4, lift: 1.3 },
  { name: 'bull',     lean: 0.20, hunch: 0.08, armStyle: 'clutch', strideMul: 0.95, headDown: 0.16, shoulder: 0.08 },
  { name: 'wild',     lean: 0.05, armStyle: 'windmill', strideMul: 1.05, bobMul: 1.2, zigzag: 0.10 },
  { name: 'limp',     lean: 0.08, armStyle: 'one',     strideMul: 0.95, limp: 0.55, bobMul: 1.6 },
  { name: 'crouched', lean: 0.10, armStyle: 'wide',    strideMul: 1.00, crouchRun: 0.22, bobMul: 0.8 },
  { name: 'stomp',    lean: 0.06, armStyle: 'high',    strideMul: 0.90, stomp: 1.5, bobMul: 1.5 },
  { name: 'loping',   lean: 0.09, armStyle: 'low',     strideMul: 1.30, bobMul: 1.1, lift: 1.4, jitter: 0.3 },
  //  segunda tanda: brazos que cuelgan de verdad (sin músculo), garras, cabeza
  //  atrás gritando, gorila, galope, de costado, en puntas de pie, borracho…
  { name: 'claws',    lean: 0.10, armStyle: 'claw',    strideMul: 1.05, bobMul: 1.1, headDown: 0.04 },
  { name: 'classic',  lean: 0.02, armStyle: 'zombie',  strideMul: 0.95, bobMul: 0.9, lift: 0.6 },
  { name: 'ragarms',  lean: 0.12, armStyle: 'limp',    strideMul: 1.10, bobMul: 1.3, armMuscle: 0 },
  { name: 'salute',   lean: 0.06, armStyle: 'one_up',  strideMul: 1.05, bobMul: 1.0, zigzag: 0.05 },
  { name: 'hugger',   lean: 0.09, armStyle: 'hug',     strideMul: 1.00, bobMul: 1.1, hunch: 0.05 },
  { name: 'headache', lean: 0.07, armStyle: 'head_hold', strideMul: 0.95, bobMul: 1.2, headDown: 0.08, zigzag: 0.12 },
  { name: 'gorilla',  lean: 0.24, hunch: 0.14, armStyle: 'gorilla', strideMul: 1.15, bobMul: 1.6, lift: 1.3, crouchRun: 0.18 },
  { name: 'screamer', lean: 0.02, armStyle: 'scream',  strideMul: 1.05, bobMul: 1.1, headBack: 0.14 },
  { name: 'trailing', lean: 0.18, armStyle: 'trailing', strideMul: 1.20, bobMul: 1.0, headDown: 0.06 },
  { name: 'grabby',   lean: 0.08, armStyle: 'reach_high', strideMul: 1.00, bobMul: 1.0, reachHi: 0.25 },
  { name: 'athlete',  lean: 0.10, armStyle: 'sprinter', strideMul: 1.30, bobMul: 0.8, lift: 1.6 },
  { name: 'crossed',  lean: 0.05, armStyle: 'chest',   strideMul: 0.90, bobMul: 1.2, zigzag: 0.08, jitter: 0.4 },
  { name: 'sidewind', lean: 0.06, armStyle: 'wide',    strideMul: 1.00, bobMul: 1.1, yawOff: 0.55 },
  { name: 'gallop',   lean: 0.12, armStyle: 'pump',    strideMul: 1.15, bobMul: 1.5, legPhase: 0.62, lift: 1.3 },
  { name: 'bouncy',   lean: 0.05, armStyle: 'flail',   strideMul: 0.95, bobMul: 1.0, bounce: 0.05, lift: 1.5 },
  { name: 'tiptoe',   lean: 0.04, armStyle: 'high',    strideMul: 0.70, bobMul: 0.6, lift: 2.0, jitter: 0.2 },
  { name: 'shuffle',  lean: 0.03, armStyle: 'reach',   strideMul: 0.55, bobMul: 0.8, lift: 0.4, jitter: 0.7 },
  { name: 'drunk',    lean: 0.06, armStyle: 'windmill', strideMul: 1.00, bobMul: 1.3, zigzag: 0.22, sway: 2.2, wobble: 1.8 },
  { name: 'backlean', lean: -0.08, armStyle: 'back',   strideMul: 1.10, bobMul: 1.2, headBack: 0.08 },
  { name: 'stiffleg', lean: 0.05, armStyle: 'zombie',  strideMul: 0.85, bobMul: 1.4, lift: 0.3 },
];
export const WALK_STYLES = [
  { name: 'shamble',  lean: 0.03, hunch: 0.06, armStyle: 'reach', strideMul: 0.85, bobMul: 0.9, lurch: 0.5 },
  { name: 'drag',     lean: 0.04, hunch: 0.05, armStyle: 'reach', strideMul: 0.80, dragLeg: 1, limp: 0.5, lurch: 0.3 },
  { name: 'stiff',    lean: -0.02, armStyle: 'low',    strideMul: 0.75, bobMul: 0.4, jitter: 0.1 },
  { name: 'hunched',  lean: 0.05, hunch: 0.12, armStyle: 'low', strideMul: 0.85, headDown: 0.14, bobMul: 1.0 },
  { name: 'reaching', lean: 0.02, armStyle: 'reach',   strideMul: 0.95, reachHi: 0.12, bobMul: 0.8 },
  { name: 'twitchy',  lean: 0.03, armStyle: 'reach',   strideMul: 0.90, jitter: 0.8, lurch: 0.6, bobMul: 1.2 },
  { name: 'swaying',  lean: 0.02, armStyle: 'low',     strideMul: 0.85, sway: 1.9, zigzag: 0.14 },
  { name: 'tilted',   lean: 0.04, armStyle: 'one',     strideMul: 0.88, headTilt: 0.28, shoulder: 0.06 },
  { name: 'wobble',   lean: 0.03, armStyle: 'wide',    strideMul: 0.90, wobble: 1.6, sway: 1.4, bobMul: 1.3 },
  { name: 'limping',  lean: 0.05, armStyle: 'reach',   strideMul: 0.85, limp: 0.35, bobMul: 1.8, lurch: 0.4 },
  { name: 'crawlish', lean: 0.16, hunch: 0.16, armStyle: 'gorilla', strideMul: 0.90, bobMul: 1.2, headDown: 0.10 },
  { name: 'migraine', lean: 0.04, hunch: 0.05, armStyle: 'head_hold', strideMul: 0.80, bobMul: 1.0, zigzag: 0.10, lurch: 0.5 },
  { name: 'huggy',    lean: 0.05, hunch: 0.08, armStyle: 'hug',     strideMul: 0.85, bobMul: 0.9, jitter: 0.5 },
  { name: 'clawing',  lean: 0.05, armStyle: 'claw',    strideMul: 0.90, bobMul: 1.0, reachHi: 0.05 },
  { name: 'proud',    lean: -0.05, armStyle: 'back',   strideMul: 0.95, bobMul: 0.8, headBack: 0.10 },
  { name: 'crab',     lean: 0.03, armStyle: 'wide',    strideMul: 0.85, bobMul: 1.0, yawOff: 0.9 },
  { name: 'dainty',   lean: 0.02, armStyle: 'high',    strideMul: 0.65, bobMul: 0.7, lift: 1.8 },
  { name: 'springy',  lean: 0.04, armStyle: 'low',     strideMul: 0.90, bobMul: 1.2, bounce: 0.04, lift: 1.3 },
  { name: 'dragging', lean: 0.10, hunch: 0.06, armStyle: 'trailing', strideMul: 0.85, bobMul: 1.1, dragLeg: 1, limp: 0.6 },
  { name: 'howler',   lean: 0.00, armStyle: 'scream',  strideMul: 0.90, bobMul: 1.0, headBack: 0.16, jitter: 0.3 },
];
