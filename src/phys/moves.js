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
  kind: 'getup', from: 'supine', dur: 2.7, w: { runner: 1, walker: 2, brute: 1, player: 1 },
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
  kind: 'getup', from: 'supine', dur: 1.15, w: { runner: 4, walker: 0.2, brute: 0, player: 1 },
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
  kind: 'getup', from: 'prone', dur: 2.0, w: { runner: 1, walker: 2, brute: 1.5, player: 2 },
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
  kind: 'getup', from: 'prone', dur: 2.7, w: { runner: 0.5, walker: 1.5, brute: 1, player: 0.5 },
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
  kind: 'getup', from: 'side', dur: 2.5, w: { runner: 0.7, walker: 1.5, brute: 1.5, player: 1 },
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

for (const name in SEQ) SEQ[name].name = name;

/** Levantadas disponibles para una orientación, con peso por tipo de cuerpo. */
export function getUpsFor(from) {
  const out = [];
  for (const name in SEQ) { const s = SEQ[name]; if (s.kind === 'getup' && s.from === from) out.push(s); }
  return out;
}
export function pickWeighted(list, kind, rng) {
  let tot = 0;
  for (const s of list) tot += (s.w && s.w[kind] != null) ? s.w[kind] : 1;
  let r = rng() * tot;
  for (const s of list) { const w = (s.w && s.w[kind] != null) ? s.w[kind] : 1; if ((r -= w) <= 0) return s; }
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

for (const name in OVER) OVER[name].name = name;
export const IDLE_OVERLAYS = ['id_twitch', 'id_look', 'id_scratch', 'id_hunch', 'id_spasm', 'id_retch', 'id_sway', 'id_headhang'];

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
];
