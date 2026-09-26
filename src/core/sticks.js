// ─────────────────────────────────────────────────────────────────────────────
//  sticks.js — La matemática de los controles táctiles, sin DOM: vectores de
//  stick con zona muerta, umbrales con histéresis (correr, disparar) y la
//  asistencia de puntería (el stick derecho "imanta" al zombi que tiene cerca
//  de la dirección). Corre en Node: las pruebas la cubren sin navegador.
//
//  Convención: un stick devuelve x hacia la DERECHA de la pantalla y y hacia
//  ARRIBA de la pantalla, los dos en -1..1, y `mag` 0..1 ya sin la zona muerta.
// ─────────────────────────────────────────────────────────────────────────────

export const STICK = Object.freeze({
  radius: 64,        // px CSS del recorrido completo del stick (a tamaño 1)
  dead: 0.12,        // zona muerta (fracción del radio)
  walkEnd: 0.70,     // hasta acá la velocidad crece hasta caminar; de acá al fondo, de caminar a correr
  runOn: 0.85, runOff: 0.70,     // la POSTURA de correr (arma abajo, esquive, salto), con histéresis
  fireOn: 0.55, fireOff: 0.40,   // el derecho más allá de esto = disparar (con histéresis)
});

/**
 * Velocidad continua de un stick analógico: de 0 a `walkEnd` crece lineal hasta la velocidad
 * de caminar; de ahí al fondo pasa suave (smoothstep) de caminar a correr. Sin escalones: con
 * el umbral duro, un dedo temblando en el borde de correr saltaba de 3,6 a 5,6 m/s («se mueve
 * lento y rápido»); ahora cambia unos cm/s. Monótona y continua en [0, 1]. O(1).
 */
export function analogSpeed(mag, walk, run, walkEnd = STICK.walkEnd) {
  const m = !(mag > 0) ? 0 : mag >= 1 ? 1 : mag;
  if (m <= walkEnd) return walk * (m / walkEnd);
  const t = (m - walkEnd) / (1 - walkEnd);
  return walk + (run - walk) * t * t * (3 - 2 * t);
}

/**
 * Stick que sigue al dedo: si el dedo se va más allá del radio, el origen se arrastra detrás
 * (queda justo a `radius`), así un cambio de dirección con el dedo afuera es inmediato en vez
 * de tener que volver hasta el centro. Devuelve el origen nuevo. O(1).
 */
export function followOrigin(ox, oy, x, y, radius = STICK.radius) {
  const dx = x - ox, dy = y - oy, d = Math.hypot(dx, dy);
  if (!(radius > 0) || !(d > radius)) return { ox, oy, moved: false };
  const k = (d - radius) / d;
  return { ox: ox + dx * k, oy: oy + dy * k, moved: true };
}

/** Asistencia de puntería: cono de 11° y 14 m; el imán gira la dirección hasta el zombi. */
export const AIM_ASSIST = Object.freeze({ angle: 0.19, dist: 14 });

/**
 * Vector de un stick a partir del desplazamiento del dedo desde el origen
 * (px, y de pantalla hacia ABAJO). La zona muerta se re-escala: apenas afuera
 * de ella la salida arranca en 0 y crece suave, sin salto. O(1).
 */
export function stickVector(dx, dy, radius = STICK.radius, dead = STICK.dead) {
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-9) || !(radius > 0)) return { x: 0, y: 0, mag: 0 };
  const m = Math.min(1, len / radius);
  const mag = m <= dead ? 0 : (m - dead) / (1 - dead);
  return { x: dx / len * mag, y: -dy / len * mag, mag };
}

/**
 * Umbral con histéresis: prende al pasar `on`, apaga recién por debajo de
 * `off` (off < on). Sin esto, el dedo temblando en el borde del umbral hacía
 * ráfagas de disparo o de correr/caminar. O(1).
 */
export class Latch {
  constructor(on, off) {
    if (!(off < on)) throw new Error(`Latch: off (${off}) tiene que ser menor que on (${on})`);
    this.on = on; this.off = off; this.state = false;
  }
  update(v) {
    if (!this.state && v >= this.on) this.state = true;
    else if (this.state && v < this.off) this.state = false;
    return this.state;
  }
  reset() { this.state = false; }
}

/**
 * Asistencia de puntería. Dada la dirección del stick (dx, dz, unitaria en
 * el mundo) desde (px, pz), busca entre `targets` (iterable de {x, z}) el que
 * quede a menos de `angle` radianes de la dirección y a menos de `dist` m; si
 * hay varios gana el de menor ángulo y, a igual ángulo, el más cercano. Devuelve
 * la dirección corregida (unitaria) y si imantó. O(targets).
 */
export function snapAim(dx, dz, px, pz, targets, angle = AIM_ASSIST.angle, dist = AIM_ASSIST.dist) {
  let best = null, bestAng = angle, bestD = Infinity;
  const cosMin = Math.cos(angle);
  for (const T of targets) {
    const vx = T.x - px, vz = T.z - pz;
    const d = Math.hypot(vx, vz);
    if (d < 0.3 || d > dist) continue;
    const c = (vx * dx + vz * dz) / d;
    if (c < cosMin) continue;
    const a = Math.acos(Math.min(1, c));
    if (a < bestAng - 1e-9 || (Math.abs(a - bestAng) <= 1e-9 && d < bestD)) { best = T; bestAng = a; bestD = d; }
  }
  if (!best) return { dx, dz, snapped: false };
  const vx = best.x - px, vz = best.z - pz, l = Math.hypot(vx, vz) || 1;
  return { dx: vx / l, dz: vz / l, snapped: true };
}

/**
 * Del stick (x derecha, y arriba de la pantalla) a una dirección en el plano
 * del mundo, con los ejes de la cámara (adelante y derecha en XZ). O(1).
 */
export function stickToWorld(sx, sy, fwd, rgt) {
  const x = rgt.x * sx + fwd.x * sy, z = rgt.z * sx + fwd.z * sy;
  const l = Math.hypot(x, z);
  return l > 1e-9 ? { x: x / l, z: z / l, mag: Math.min(1, l) } : { x: fwd.x, z: fwd.z, mag: 0 };
}
