// ─────────────────────────────────────────────────────────────────────────────
//  ballistics.js — Lo que HACE un tiro. Balas y rayos (hitscan con
//  perdigones, perforación y rebote), rieles que atraviesan todo, relámpagos
//  que saltan de zombi en zombi, proyectiles con física (cohetes que
//  aceleran, granadas que rebotan, virotes que se clavan, discos que
//  rebotan en las paredes, micro cohetes que buscan), chorros de fuego y
//  frío, ondas sónicas, explosiones, vórtices y charcos de ácido.
//
//  No sabe nada del juego. El MUNDO le da la geometría (raycasts contra
//  huesos y estáticos, línea de visión, partículas) y el SUMIDERO las
//  consecuencias (daño, sangre, estados, sonido, cámara). La galería usa
//  esta misma clase con un mundo de mentira (una pared y un blanco) y un
//  sumidero que sólo dibuja: el tiro que se ve en el menú es EL tiro.
//
//  Contrato del sumidero:
//    hitBody(body, bone, s, dmg, imp[3]|null, def, info) → {killed, zone, damage, severed}
//    hitStatic(hit, def, info)          hit = {x,y,z,nx,ny,nz,box}
//    targets(includeDead) → iterable de ragdolls que las áreas pueden tocar
//    applyStatus(body, kind, amount, def)
//    selfBlast(x, y, z, r, dmg, force, def)     (el que dispara, si está en el radio)
//    onExplosion(x, y, z, r, def, kind)
//    alert(x, z, r)
// ─────────────────────────────────────────────────────────────────────────────

import { fireHitscan } from './weapons.js';
import { CHEST, B_SPINE, B_UARML, B_UARMR, B_FARML, B_FARMR, B_THIGHL, B_THIGHR, B_SHINL, B_SHINR, B_SKULL } from '../phys/ragdoll.js';

const LIMBS = Object.freeze([B_UARML, B_UARMR, B_FARML, B_FARMR, B_THIGHL, B_THIGHR, B_SHINL, B_SHINR, B_SKULL]);
/** Altura a la que apuntan las balas a la distancia del mouse (el rayo sale del pecho del jugador). */
export const AIM_CHEST = 1.05;
/**
 * Altura a la que llega un proyectil directo: la mitad del torso de un zombi
 * parado. Sale de la boca (~1,35 m), así que la línea casi no baja: un arpón
 * apuntado al primero de una fila pasa por el pecho del tercero y no entre
 * sus piernas (con 1,05 bajaba 8 cm por metro).
 */
export const AIM_TORSO = 1.25;
/** Distancia mínima de apuntado: con el mouse encima del jugador el tiro no se clava en el piso. */
export const AIM_MIN_DIST = 4;
const LOB_FLOOR = 0.2;            // altura donde cae una parábola (apenas sobre el piso)
const LOB_MIN_DIST = 1.5;         // una granada a los pies igual sale con algo de arco
const SHOOTER_GRACE = 0.12;       // segundos en que el proyectil no puede pegarle a quien lo tiró
const STUCK_LIFE = 8;             // cuánto queda clavado un virote en la pared
const MAX_PROJECTILES = 160;
const TRAIL_STEP = { rocket: 0.09, smoke: 0.16, glow: 0.07, flare: 0.05, sparks: 0.12, drip: 0.1, blink: 0.3, none: 0 };
const _b = {}, _s = {};

/**
 * Ángulo de salida para llegar a (D, h) con velocidad v y gravedad g: el
 * arco BAJO. La fórmula de libro, tan θ = (v² − √Δ) / (gD), resta dos
 * números casi iguales cuando g es chica (un virote, un clavo) y con g = 0
 * divide por cero. Racionalizada no pierde nada:
 *
 *   tan θ = (gD² + 2hv²) / (D · (v² + √Δ)),     Δ = v⁴ − g(gD² + 2hv²)
 *
 * y con g = 0 da la recta, tan θ = h / D. Si no llega, 45° (el tiro más
 * largo que tiene). O(1).
 */
export function launchAngle(v, g, D, h) {
  if (!(D > 1e-3) || !(v > 0)) return 0;
  const gg = Math.max(0, g), v2 = v * v;
  const q = gg * D * D + 2 * h * v2, disc = v2 * v2 - gg * q;
  if (disc < 0) return Math.PI / 4;
  return Math.atan(q / (D * (v2 + Math.sqrt(disc))));
}

export class Ballistics {
  /**
   * @param {{world, sink, fx?, rng?}} o  mundo (PhysWorld o su imitación), sumidero, efectos visuales (ShotFX) y azar
   */
  constructor({ world, sink, fx = null, rng = Math.random }) {
    this.world = world; this.sink = sink; this.fx = fx; this.rng = rng;
    this.projectiles = [];
    this.zones = [];
    this.hits = [];
    this.stats = { shots: 0, projectiles: 0, explosions: 0 };
  }

  clear() { this.projectiles.length = 0; this.zones.length = 0; }

  // ═══ disparo ══════════════════════════════════════════════════════════════
  /**
   * Un disparo del arma `def`. `S` trae: shooter (ragdoll o null), boca
   * (mx,my,mz), origen del rayo (ox,oy,oz: el pecho, así un zombi pegado
   * al cuerpo también recibe), dirección unitaria (dx,dy,dz), punto
   * apuntado (aimX, aimZ) y parte de atrás (rear: {x,y,z} o null, para el
   * contragolpe del lanzacohetes). Opcionales para los proyectiles
   * directos: aimY, la altura a la que tienen que llegar (el torso), y
   * aimMin, la distancia mínima a la que se resuelve (4 m: el mouse del
   * juego); la galería, que sabe exactamente dónde está el blanco, los pasa.
   */
  fire(def, S) {
    this.stats.shots++;
    const sh = def.shot;
    const kind = sh.kind;
    if (kind === 'bullet' || kind === 'beam' || kind === 'rail') this._hitscan(def, S);
    else if (kind === 'arc') this._arc(def, S);
    else if (kind === 'proj') this._launch(def, S);
    else if (kind === 'spray') this._spray(def, S);
    else if (kind === 'wave') this._wave(def, S);
    this._muzzle(def, S);
    if (this.sink.alert) this.sink.alert(S.mx, S.mz, sh.fx && sh.fx.silenced ? 5 : kind === 'proj' && !(sh.proj && sh.proj.radius) ? 9 : 16);
  }

  _muzzle(def, S) {
    const fx = this.fx; if (!fx) return;
    const sh = def.shot;
    const col = sh.tracer || '#ffd39a';
    fx.flash(sh.flash || 'std', S.mx, S.my, S.mz, S.dx, S.dy, S.dz, sh.flash === 'energy' || sh.flash === 'plasma' || sh.flash === 'rail' || sh.flash === 'beam' ? col : '#ffd39a', def.pellets > 1 ? 1.15 : 1, S.rear ? [S.rear.x, S.rear.y, S.rear.z] : null);
    if (sh.smoke && fx.puff) for (let i = 0; i < 2; i++) fx.puff(S.mx + S.dx * 0.1, S.my + 0.02, S.mz + S.dz * 0.1, S.dx * 0.6 + (this.rng() - 0.5) * 0.3, 0.3, S.dz * 0.6 + (this.rng() - 0.5) * 0.3, 0.09, 1.1, 0x9ea2aa, 0.28);
  }

  // ── balas, rayos y rieles ────────────────────────────────────────────────
  _hitscan(def, S) {
    const w = this.world, sh = def.shot, fx = this.fx;
    const n = fireHitscan(w, S.ox, S.oy, S.oz, S.dx, S.dy, S.dz, def, S.shooter, this.rng, this.hits);
    const col = sh.tracer || '#ffd79a', width = sh.width || 0.014;
    // por perdigón: el primer tramo sale de la boca; los siguientes de donde siguió
    let pelletStart = 0;
    for (let i = 0; i < n; i++) {
      const H = this.hits[i];
      const fromMuzzle = H.pierced === 0;
      if (fromMuzzle) pelletStart = i;
      const x0 = fromMuzzle ? S.mx : H.ox, y0 = fromMuzzle ? S.my : H.oy, z0 = fromMuzzle ? S.mz : H.oz;
      const lastOfPellet = i === n - 1 || this.hits[i + 1].pierced === 0;
      if (fx) {
        if (sh.kind === 'beam') { if (fromMuzzle) this._beamFx(def, x0, y0, z0, i, n); }
        else if (sh.kind === 'rail') { if (fromMuzzle) this._railFx(def, x0, y0, z0, i, n); }
        else fx.tracer(x0, y0, z0, H.x, H.y, H.z, col, width, { speed: sh.trail ? 420 : 300, tail: sh.trail ? 6 : 3, k: sh.trail ? 3.2 : 2.6, fadeLine: sh.trail ? 0.22 : 0.05 });
      }
      const info = { kind: sh.kind, x: H.x, y: H.y, z: H.z, dirx: H.dirx, diry: H.diry, dirz: H.dirz, pierced: H.pierced };
      if (H.kind === 'body') {
        const k = def.impulse * (H.pierced ? 0.6 : 1);
        this.sink.hitBody(H.body, w.bmeta[H.bone], H.s, H.dmg, [H.dirx * k, 0.25 * k + 0.6, H.dirz * k], def, info);
        if (fx && sh.kind !== 'bullet') fx.impactGlow(H.x, H.y, H.z, -H.dirx, -H.diry, -H.dirz, col, 0.12);
      } else if (H.kind === 'static') {
        this.sink.hitStatic(H, def, info);
        if (fx && sh.kind !== 'bullet') fx.impactGlow(H.x, H.y, H.z, H.nx, H.ny, H.nz, col, sh.kind === 'rail' ? 0.4 : 0.2);
        const rc = sh.fx && sh.fx.ricochet;
        if (rc && sh.kind === 'bullet') this._ricochet(def, H, rc);
      }
      // balas explosivas: estallan donde terminó el tramo (o sólo al final de la cadena)
      const he = sh.fx && sh.fx.he;
      if (he && H.kind !== 'none' && (!he.last || lastOfPellet)) this.explode(H.x - H.dirx * 0.05, H.y - H.diry * 0.05, H.z - H.dirz * 0.05, { radius: he.r, blast: he.dmg, force: he.force }, def, S.shooter, 'small');
    }
    void pelletStart;
  }

  /** Rayo: del cañón al final de la cadena de ese perdigón (los que perfora quedan en la línea). */
  _beamFx(def, x0, y0, z0, i, n) {
    let j = i;
    while (j + 1 < n && this.hits[j + 1].pierced > 0) j++;
    const E = this.hits[j];
    this.fx.beam(x0, y0, z0, E.x, E.y, E.z, def.shot.tracer, def.shot.width || 0.02, def.shot.life || 0.09);
  }
  _railFx(def, x0, y0, z0, i, n) {
    let j = i;
    while (j + 1 < n && this.hits[j + 1].pierced > 0) j++;
    const E = this.hits[j];
    this.fx.rail(x0, y0, z0, E.x, E.y, E.z, def.shot.tracer, def.shot.width || 0.03);
  }

  /** Rebote de bala: refleja la dirección en la normal y sigue con 60 % del daño. */
  _ricochet(def, H, bounces) {
    const d = H.dirx * H.nx + H.diry * H.ny + H.dirz * H.nz;
    let rx = H.dirx - 2 * d * H.nx, ry = H.diry - 2 * d * H.ny, rz = H.dirz - 2 * d * H.nz;
    const l = Math.hypot(rx, ry, rz) || 1; rx /= l; ry /= l; rz /= l;
    const sub = { ...def, pellets: 1, spread: 0.01, dmg: def.dmg * 0.6, range: def.range * 0.5, pierce: 0, shot: { ...def.shot, fx: { ...def.shot.fx, ricochet: bounces - 1 } } };
    this._hitscan(sub, { shooter: null, mx: H.x + H.nx * 0.02, my: H.y + H.ny * 0.02, mz: H.z + H.nz * 0.02, ox: H.x + H.nx * 0.02, oy: H.y + H.ny * 0.02, oz: H.z + H.nz * 0.02, dx: rx, dy: ry, dz: rz });
    if (this.fx) this.fx.sparks(H.x, H.y, H.z, H.nx, H.ny, H.nz, 6, '#ffd08a', 1.2);
  }

  // ── relámpago en cadena ───────────────────────────────────────────────────
  _arc(def, S) {
    const w = this.world, sh = def.shot, col = sh.tracer || '#94e2d5';
    const hit = w.raycastBones(S.ox, S.oy, S.oz, S.dx, S.dy, S.dz, def.range, _b, S.shooter);
    const tS = w.raycastStatic(S.ox, S.oy, S.oz, S.dx, S.dy, S.dz, def.range, _s);
    let first = null, fx0 = 0, fy0 = 0, fz0 = 0;
    if (hit && (tS < 0 || _b.t < tS)) { first = _b.body; fx0 = _b.x; fy0 = _b.y; fz0 = _b.z; }
    else {
      // el rayo busca: el zombi más cercano dentro de un cono de 20° con línea de visión
      let best = null, bd = def.range;
      for (const B of this.sink.targets(false)) {
        if (B === S.shooter || B.dead || !B.p) continue;
        const cx = B.px(CHEST), cy = B.py(CHEST), cz = B.pz(CHEST);
        const vx = cx - S.ox, vz = cz - S.oz, d = Math.hypot(vx, vz);
        if (d > bd || d < 0.1) continue;
        if ((vx * S.dx + vz * S.dz) / d < Math.cos(0.35)) continue;
        if (!w.lineOfSight(S.mx, S.my, S.mz, cx, cy, cz)) continue;
        best = B; bd = d;
      }
      if (best) { first = best; fx0 = best.px(CHEST); fy0 = best.py(CHEST); fz0 = best.pz(CHEST); }
    }
    if (!first) {
      // al aire o a la pared: igual se ve el relámpago
      const L = tS >= 0 ? tS : Math.min(def.range, 6);
      const ex = S.ox + S.dx * L, ey = S.oy + S.dy * L, ez = S.oz + S.dz * L;
      if (this.fx) { this.fx.arc(S.mx, S.my, S.mz, ex, ey, ez, col, 0.018); if (tS >= 0) this.fx.impactGlow(ex, ey, ez, _s.nx, _s.ny, _s.nz, col, 0.25); }
      return;
    }
    const chain = sh.chain || 4, chainR = sh.chainR || 4.5;
    const done = new Set([first]);
    let ax = S.mx, ay = S.my, az = S.mz, cur = first, bx = fx0, by = fy0, bz = fz0, dmg = def.dmg;
    for (let hop = 0; hop < chain && cur; hop++) {
      if (this.fx) this.fx.arc(ax, ay, az, bx, by, bz, col, hop === 0 ? 0.02 : 0.015);
      const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1;
      this.sink.hitBody(cur, B_SPINE, 0.4, dmg, [dx / l * 2, 1.2, dz / l * 2], def, { kind: 'arc', x: bx, y: by, z: bz, dirx: dx / l, diry: 0, dirz: dz / l, pierced: hop });
      this.sink.applyStatus(cur, 'shock', 1, def);
      // siguiente: el más cercano sin tocar, a menos de chainR y a la vista
      let next = null, nd = chainR;
      for (const B of this.sink.targets(false)) {
        if (done.has(B) || B.dead || !B.p) continue;
        const d = Math.hypot(B.px(CHEST) - bx, B.pz(CHEST) - bz);
        if (d < nd && w.lineOfSight(bx, by, bz, B.px(CHEST), B.py(CHEST), B.pz(CHEST))) { nd = d; next = B; }
      }
      if (!next) break;
      done.add(next);
      ax = bx; ay = by; az = bz; cur = next; bx = next.px(CHEST); by = next.py(CHEST); bz = next.pz(CHEST);
      dmg *= 0.8;
    }
  }

  // ── chorro (fuego, frío) ──────────────────────────────────────────────────
  _spray(def, S) {
    const w = this.world, sh = def.shot, sp = sh.spray, fx = this.fx;
    const range = def.range, ang = sp.angle || 0.2;
    // la pared corta el chorro: las llamas no pasan del primer estático
    const tS = w.raycastStatic(S.mx, S.my, S.mz, S.dx, S.dy, S.dz, range, _s);
    const reach = tS >= 0 ? Math.max(0.4, tS) : range;
    if (fx) {
      const n = sp.n || 6;
      for (let i = 0; i < n; i++) {
        const spd = 9 + this.rng() * 3, jit = ang * 0.9;
        const vx = (S.dx + (this.rng() - 0.5) * jit * 2) * spd, vy = (S.dy + (this.rng() - 0.3) * jit) * spd, vz = (S.dz + (this.rng() - 0.5) * jit * 2) * spd;
        const life = Math.min(0.7, reach / spd * 1.9);
        if (sp.type === 'cryo') fx.frost(S.mx, S.my, S.mz, vx, vy, vz, life, 0.07);
        else fx.flame(S.mx, S.my, S.mz, vx, vy, vz, life, 0.07);
      }
      if (tS >= 0 && this.rng() < 0.5) {
        const hx = S.mx + S.dx * tS, hy = S.my + S.dy * tS, hz = S.mz + S.dz * tS;
        if (sp.type === 'cryo') fx.frost(hx, hy, hz, _s.nx * 2 + (this.rng() - 0.5) * 3, 1, _s.nz * 2 + (this.rng() - 0.5) * 3, 0.5, 0.1);
        else fx.flame(hx, hy, hz, _s.nx * 2 + (this.rng() - 0.5) * 3, 1.2, _s.nz * 2 + (this.rng() - 0.5) * 3, 0.45, 0.12);
      }
    }
    // daño: a los que están dentro del cono, al alcance y a la vista
    const cosA = Math.cos(ang * 1.6);
    for (const B of this.sink.targets(false)) {
      if (B === S.shooter || B.dead || !B.p) continue;
      const cx = B.px(CHEST), cy = B.py(CHEST), cz = B.pz(CHEST);
      const vx = cx - S.mx, vz = cz - S.mz, d = Math.hypot(vx, vz);
      if (d > reach + 0.3 || d < 1e-3) continue;
      if ((vx * S.dx + vz * S.dz) / d < cosA && d > 0.9) continue;
      if (!w.lineOfSight(S.mx, S.my, S.mz, cx, cy, cz)) continue;
      const k = 1 - d / (reach + 0.3) * 0.5;
      this.sink.hitBody(B, B_SPINE, 0.3 + this.rng() * 0.4, def.dmg * k, [vx / d * 0.6, 0.1, vz / d * 0.6], def, { kind: 'spray', x: cx, y: cy, z: cz, dirx: vx / d, diry: 0, dirz: vz / d, pierced: 0 });
      this.sink.applyStatus(B, sp.type === 'cryo' ? 'freeze' : 'burn', sp.type === 'cryo' ? (def.shot.fx.freeze || 0.06) : (def.shot.fx.burn || 3), def);
    }
  }

  // ── onda sónica ───────────────────────────────────────────────────────────
  _wave(def, S) {
    const w = this.world, sh = def.shot, wv = sh.wave || {}, fx = this.fx, col = sh.tracer || '#cba6f7';
    const range = def.range, ang = wv.angle || 0.5, force = wv.force || 1.5;
    if (fx) for (let r = 0; r < 3; r++) fx.shockRing(S.mx + S.dx * r * 0.25, S.my, S.mz + S.dz * r * 0.25, S.dx, S.dy, S.dz, col, 11 - r * 2, 0.18 + r * 0.06);
    const cosA = Math.cos(ang);
    for (const B of this.sink.targets(false)) {
      if (B === S.shooter || B.dead || !B.p) continue;
      const cx = B.px(CHEST), cy = B.py(CHEST), cz = B.pz(CHEST);
      const vx = cx - S.mx, vz = cz - S.mz, d = Math.hypot(vx, vz);
      if (d > range || d < 1e-3 || (vx * S.dx + vz * S.dz) / d < cosA) continue;
      if (!w.lineOfSight(S.mx, S.my, S.mz, cx, cy, cz)) continue;
      const k = 1 - d / range;
      this.sink.hitBody(B, B_SPINE, 0.5, def.dmg * (0.4 + k * 0.6), [vx / d * 4 * k, 2, vz / d * 4 * k], def, { kind: 'wave', x: cx, y: cy, z: cz, dirx: vx / d, diry: 0, dirz: vz / d, pierced: 0 });
      if (B.knockback) B.knockback(vx / d, vz / d, force * (0.6 + k * 0.8), 0.35 + k * 0.3);
    }
  }

  // ═══ proyectiles ══════════════════════════════════════════════════════════
  /**
   * Elevación de salida (tan θ) hacia lo apuntado, según cómo apunta el
   * proyectil (P.aim, lo fija el catálogo):
   *   lob     cae en el piso bajo el mouse: granadas, ácido, pegajosas, vórtices
   *   direct  llega a la altura del torso a esa distancia, gravedad compensada:
   *           virotes, arpones, bengalas, clavos, cohetes, esferas
   * Sin punto apuntado (rebotes, pruebas) sale por la dirección que vino. O(1).
   */
  _elevation(def, P, S) {
    const hx = Math.hypot(S.dx, S.dz) || 1;
    if (S.aimX === undefined) return S.dy / hx;
    const dist = Math.hypot(S.aimX - S.mx, S.aimZ - S.mz);
    if (P.aim === 'lob') return Math.tan(launchAngle(P.speed, P.grav || 0, Math.min(def.range, Math.max(LOB_MIN_DIST, dist)), LOB_FLOOR - S.my));
    const D = Math.min(def.range, Math.max(S.aimMin ?? AIM_MIN_DIST, dist));
    return Math.tan(launchAngle(P.speed, P.grav || 0, D, (S.aimY ?? AIM_TORSO) - S.my));
  }

  _launch(def, S) {
    const w = this.world, P = def.shot.proj;
    const n = Math.max(1, def.pellets | 0);
    // un zombi pegado al cuerpo, entre el pecho y la boca: el proyectil ya le pega ahí
    const mx = S.mx - S.ox, my = S.my - S.oy, mz = S.mz - S.oz, ml = Math.hypot(mx, my, mz);
    let blocked = null;
    if (ml > 0.05 && w.raycastBones(S.ox, S.oy, S.oz, mx / ml, my / ml, mz / ml, ml, _b, S.shooter)) blocked = { x: _b.x, y: _b.y, z: _b.z };
    const x0 = blocked ? blocked.x : S.mx, y0 = blocked ? blocked.y : S.my, z0 = blocked ? blocked.z : S.mz;
    // rumbo horizontal unitario + elevación: la dispersión se suma en ese espacio (no deforma el arco)
    const hx = Math.hypot(S.dx, S.dz) || 1, ux = S.dx / hx, uz = S.dz / hx;
    const tan0 = this._elevation(def, P, S);
    for (let k = 0; k < n; k++) {
      let dx = ux, dz = uz, tanT = tan0;
      if (def.spread > 0) {
        const sp = def.spread;
        dx += (this.rng() + this.rng() - 1) * sp; dz += (this.rng() + this.rng() - 1) * sp; tanT += (this.rng() + this.rng() - 1) * sp * 0.4;
      }
      const hl = Math.hypot(dx, dz) || 1;
      const s = P.speed / Math.hypot(1, tanT);       // |(dx/hl, tanT, dz/hl)| = √(1 + tan²θ)
      const p = this.spawn(def, P, S.shooter, x0, y0, z0, dx / hl * s, tanT * s, dz / hl * s, k);
      if (blocked) p.t = SHOOTER_GRACE;      // el que está pegado recibe; el tirador sigue protegido por el rayo inicial
    }
  }

  /** Alta de un proyectil (también lo usan las granadas de racimo). */
  spawn(def, P, shooter, x, y, z, vx, vy, vz, idx = 0) {
    if (this.projectiles.length >= MAX_PROJECTILES) this.projectiles.shift();
    const p = {
      alive: true, def, P, look: P.look, shooter, x, y, z, vx, vy, vz, fx: 0, fy: 0, fz: 1, t: 0,
      bounces: 0, pierceLeft: P.pierce || 0, stuck: null, fuseT: P.fuse || 0, armed: false,
      spin: this.rng() * 6.28, spinV: P.look === 'disc' ? 28 : P.look === 'bolt' || P.look === 'harpoon' ? 3 : P.look === 'mini' ? 12 : 0,
      size: P.size || 1, hitSet: null, trailAcc: 0, target: null, retarget: 0, life: P.life || Math.max(3, (def.range / P.speed) * 2.5), idx,
    };
    this.projectiles.push(p);
    this.stats.projectiles++;
    return p;
  }

  update(dt) {
    const list = this.projectiles;
    for (let i = 0; i < list.length; i++) { const p = list[i]; if (p.alive) this._stepProjectile(p, dt); }
    // compactar sin alocar
    let j = 0;
    for (let i = 0; i < list.length; i++) if (list[i].alive) list[j++] = list[i];
    list.length = j;
    this._stepZones(dt);
  }

  _stepProjectile(p, dt) {
    const w = this.world, P = p.P, fx = this.fx;
    p.t += dt;
    p.spin += p.spinV * dt;
    // ── clavado ──
    if (p.stuck) {
      const st = p.stuck;
      if (st.body) {
        const B = st.body;
        if (!B.alive || !(w.pf[st.pi] & 1)) { p.stuck = { body: null }; }       // el cuerpo se congeló: queda donde estaba
        else { p.x = w.px[st.pi] + st.ox; p.y = w.py[st.pi] + st.oy; p.z = w.pz[st.pi] + st.oz; }
      }
      if (P.stickAll || (P.radius > 0 && p.fuseT > 0)) {
        p.fuseT -= dt;
        if (fx && P.look === 'sticky' && Math.floor(p.t * 6) !== Math.floor((p.t - dt) * 6)) fx.billboard(p.x, p.y + 0.02, p.z, 0.12, '#f38ba8', 3, 0.1);
        if (p.fuseT <= 0) { this.explode(p.x, p.y, p.z, P, p.def, p.shooter); p.alive = false; }
        return;
      }
      if (P.burn && st.body && st.body.alive && Math.floor(p.t * 4) !== Math.floor((p.t - dt) * 4)) this.sink.applyStatus(st.body, 'burn', 1.2, p.def);
      if (P.look === 'flare' && fx && this.rng() < 0.6) fx.mote(p.x, p.y, p.z, (this.rng() - 0.5) * 0.6, 0.6 + this.rng(), (this.rng() - 0.5) * 0.6, 0.05, '#ffb36b', 2.4, 0.5, { drag: 1, grav: -0.5 });
      if (p.t > p.stuckUntil) p.alive = false;
      return;
    }
    // ── motor, búsqueda, gravedad, arrastre ──
    let sp = Math.hypot(p.vx, p.vy, p.vz);
    if (P.accel && sp < P.maxSpeed) {
      const ns = Math.min(P.maxSpeed, sp + P.accel * dt), k = ns / (sp || 1);
      p.vx *= k; p.vy *= k; p.vz *= k; sp = ns;
    }
    if (P.homing) this._home(p, dt, sp);
    if (P.grav) p.vy -= P.grav * dt;
    if (P.drag) { const k = Math.max(0, 1 - P.drag * dt); p.vx *= k; p.vy *= k; p.vz *= k; }
    sp = Math.hypot(p.vx, p.vy, p.vz);
    if (sp > 1e-4) { p.fx = p.vx / sp; p.fy = p.vy / sp; p.fz = p.vz / sp; }
    // ── barrido del paso: huesos y estáticos, gana el más cercano ──
    let remaining = sp * dt;
    let guard = 0;
    while (remaining > 1e-5 && p.alive && guard++ < 6) {
      const dx = p.vx / sp, dy = p.vy / sp, dz = p.vz / sp;
      const skip = p.t < SHOOTER_GRACE ? p.shooter : null;
      // los que ya atravesó no cuentan: el barrido sigue buscando detrás de ellos
      const hitB = w.raycastBones(p.x, p.y, p.z, dx, dy, dz, remaining, _b, skip, p.hitSet);
      const tS = w.raycastStatic(p.x, p.y, p.z, dx, dy, dz, remaining, _s);
      if (hitB && (tS < 0 || _b.t < tS)) {
        remaining -= _b.t;
        p.x = _b.x; p.y = _b.y; p.z = _b.z;
        this._hitBodyProjectile(p, _b.body, w.bmeta[_b.bone], _b.s, dx, dy, dz);
        if (p.alive && !p.stuck) { p.x += dx * 0.05; p.y += dy * 0.05; p.z += dz * 0.05; remaining -= 0.05; }
        continue;
      }
      if (tS >= 0) {
        p.x = _s.x + _s.nx * 0.01; p.y = _s.y + _s.ny * 0.01; p.z = _s.z + _s.nz * 0.01;
        remaining -= tS;
        this._hitStaticProjectile(p, _s, dx, dy, dz, sp);
        sp = Math.hypot(p.vx, p.vy, p.vz);
        if (sp < 0.05) break;
        continue;
      }
      p.x += dx * remaining; p.y += dy * remaining; p.z += dz * remaining;
      remaining = 0;
    }
    if (!p.alive || p.stuck) return;
    // ── estela ──
    if (fx) this._trail(p, sp * dt);
    // ── espoleta y vida ──
    if (p.fuseT > 0 && p.t >= p.fuseT && !P.stickAll) { this._detonate(p); return; }
    if (p.t > p.life || p.y < -5) { if (P.radius > 0) this._detonate(p); else p.alive = false; }
  }

  /** Micro cohetes: giran hacia el zombi más cercano delante suyo (re-elige cada 0.2 s). */
  _home(p, dt, sp) {
    p.retarget -= dt;
    if (p.retarget <= 0 || (p.target && p.target.dead)) {
      p.retarget = 0.2;
      let best = null, bd = 26;
      for (const B of this.sink.targets(false)) {
        if (B === p.shooter || B.dead || !B.p) continue;
        const vx = B.px(CHEST) - p.x, vz = B.pz(CHEST) - p.z, d = Math.hypot(vx, vz);
        if (d > bd || d < 0.2 || (vx * p.fx + vz * p.fz) / d < 0.2) continue;
        best = B; bd = d;
      }
      p.target = best;
    }
    if (!p.target || p.t < 0.15) return;
    const tx = p.target.px(CHEST) - p.x, ty = p.target.py(CHEST) - p.y, tz = p.target.pz(CHEST) - p.z, tl = Math.hypot(tx, ty, tz) || 1;
    const turn = Math.min(1, p.P.homing * dt);
    const nx = p.vx / sp + (tx / tl - p.vx / sp) * turn, ny = p.vy / sp + (ty / tl - p.vy / sp) * turn, nz = p.vz / sp + (tz / tl - p.vz / sp) * turn;
    const nl = Math.hypot(nx, ny, nz) || 1;
    p.vx = nx / nl * sp; p.vy = ny / nl * sp; p.vz = nz / nl * sp;
  }

  _hitBodyProjectile(p, body, bone, s, dx, dy, dz) {
    const P = p.P, def = p.def;
    if (P.stickAll) { this._stickToBody(p, body); p.fuseT = P.fuse || 1; return; }
    if (P.radius > 0) {
      if (P.contact) { this._detonate(p); return; }
      // sin espoleta de contacto (bombitas de racimo): rebota en el cuerpo y sigue contando
      p.vx *= -0.3; p.vz *= -0.3; p.vy = Math.abs(p.vy) * 0.3 + 0.5;
      (p.hitSet || (p.hitSet = new Set())).add(body);
      return;
    }
    const imp = def.impulse || P.dmg * 0.08;
    const dmg = P.dmg * (p.bounces ? 0.85 : 1);
    this.sink.hitBody(body, bone, s, dmg, [dx * imp, 0.3 * imp + 0.4, dz * imp], def, { kind: 'proj', x: p.x, y: p.y, z: p.z, dirx: dx, diry: dy, dirz: dz, pierced: (P.pierce || 0) - p.pierceLeft });
    if (P.burn) this.sink.applyStatus(body, 'burn', P.burn, def);
    if (P.acid) this.sink.applyStatus(body, 'acid', P.acid, def);
    if (this.fx && p.look === 'orb') { this.fx.impactGlow(p.x, p.y, p.z, -dx, -dy, -dz, def.shot.tracer || '#ffffff', 0.2); }
    if (p.pierceLeft > 0) {
      p.pierceLeft--;
      (p.hitSet || (p.hitSet = new Set())).add(body);
      return;
    }
    if (P.stick) { this._stickToBody(p, body); p.stuckUntil = p.t + STUCK_LIFE; return; }
    p.alive = false;
  }

  _stickToBody(p, body) {
    const w = this.world;
    let best = -1, bd = 1e9;
    for (let i = 0; i < body.p.length; i++) {
      const pi = body.p[i];
      if (!(w.pf[pi] & 1)) continue;
      const d = (w.px[pi] - p.x) ** 2 + (w.py[pi] - p.y) ** 2 + (w.pz[pi] - p.z) ** 2;
      if (d < bd) { bd = d; best = pi; }
    }
    if (best < 0) { p.stuck = { body: null }; return; }
    p.stuck = { body, pi: best, ox: p.x - w.px[best], oy: p.y - w.py[best], oz: p.z - w.pz[best] };
    p.vx = p.fx * 0.001; p.vy = p.fy * 0.001; p.vz = p.fz * 0.001;
    if (p.stuckUntil === undefined) p.stuckUntil = p.t + STUCK_LIFE;
  }

  _hitStaticProjectile(p, H, dx, dy, dz, sp) {
    const P = p.P, def = p.def, fx = this.fx;
    const canBounce = P.bounce > 0 && (P.bounces === undefined || p.bounces < P.bounces) && !(P.radius > 0 && P.contact && !P.fuse);
    if (canBounce) {
      const d = p.vx * H.nx + p.vy * H.ny + p.vz * H.nz;
      p.vx = (p.vx - 2 * d * H.nx) * P.bounce; p.vy = (p.vy - 2 * d * H.ny) * P.bounce; p.vz = (p.vz - 2 * d * H.nz) * P.bounce;
      // la granada contra el piso pierde más (rueda); el disco conserva
      if (H.ny > 0.7 && P.look !== 'disc') { p.vx *= 0.7; p.vz *= 0.7; p.vy *= 0.6; }
      p.bounces++;
      p.hitSet = null;                      // tras rebotar puede volver a pegarle al mismo
      if (fx) fx.sparks(H.x, H.y, H.z, H.nx, H.ny, H.nz, P.look === 'disc' ? 10 : 3, '#ffd08a', P.look === 'disc' ? 1.3 : 0.6);
      this.sink.hitStatic(H, def, { kind: 'bounce', x: H.x, y: H.y, z: H.z, dirx: dx, diry: dy, dirz: dz, pierced: 0, soft: true });
      return;
    }
    if (P.radius > 0 && !P.stickAll && (P.contact || !P.fuse)) { this._detonate(p); return; }
    if (P.stick || P.stickAll) {
      p.stuck = { body: null };
      p.vx = dx * 0.001; p.vy = dy * 0.001; p.vz = dz * 0.001;
      p.stuckUntil = p.t + STUCK_LIFE;
      if (P.stickAll) p.fuseT = P.fuse || 1;
      if (fx) fx.sparks(H.x, H.y, H.z, H.nx, H.ny, H.nz, 4, '#ffd08a', 0.7);
      this.sink.hitStatic(H, def, { kind: 'stick', x: H.x, y: H.y, z: H.z, dirx: dx, diry: dy, dirz: dz, pierced: 0 });
      return;
    }
    if (P.radius > 0) { this._detonate(p); return; }
    if (fx && p.look === 'orb') fx.impactGlow(H.x, H.y, H.z, H.nx, H.ny, H.nz, def.shot.tracer || '#ffffff', 0.25);
    this.sink.hitStatic(H, def, { kind: 'proj', x: H.x, y: H.y, z: H.z, dirx: dx, diry: dy, dirz: dz, pierced: 0 });
    p.alive = false;
  }

  _detonate(p) {
    const P = p.P;
    p.alive = false;
    if (P.pull) { this.zones.push({ type: 'vortex', x: p.x, y: Math.max(0.4, p.y), z: p.z, r: P.pull, t: P.pullT || 1.2, t0: P.pullT || 1.2, P, def: p.def, shooter: p.shooter }); return; }
    if (P.radius > 0) this.explode(p.x, p.y, p.z, P, p.def, p.shooter, P.look === 'ion' ? 'ion' : P.look === 'orb' ? 'plasma' : P.look === 'glob' ? 'acid' : 'fire');
    if (P.split) {
      for (let k = 0; k < P.split; k++) {
        const a = (k / P.split) * Math.PI * 2 + this.rng(), s = 3.5 + this.rng() * 2.5;
        const bomb = { ...P, split: 0, radius: P.radius * 0.75, blast: P.blast * 0.6, fuse: 0.45 + this.rng() * 0.35, speed: s, contact: false, size: 0.7 };
        this.spawn(p.def, bomb, p.shooter, p.x, Math.max(0.3, p.y + 0.1), p.z, Math.cos(a) * s, 3 + this.rng() * 2, Math.sin(a) * s);
      }
    }
  }

  _trail(p, dist) {
    const fx = this.fx, P = p.P, kind = P.trail || 'none', step = TRAIL_STEP[kind];
    if (!step) return;
    p.trailAcc += dist;
    const col = p.def.shot.tracer || '#ffd39a';
    while (p.trailAcc >= step) {
      p.trailAcc -= step;
      const bx = p.x - p.fx * p.trailAcc, by = p.y - p.fy * p.trailAcc, bz = p.z - p.fz * p.trailAcc;
      if (kind === 'rocket') {
        fx.billboard(bx - p.fx * 0.14, by - p.fy * 0.14, bz - p.fz * 0.14, 0.12 * p.size, '#ffcf8a', 3, 0.06, 0, 2, this.rng() * 6.28);
        fx.puff(bx - p.fx * 0.2, by, bz - p.fz * 0.2, (this.rng() - 0.5) * 0.4, 0.2 + this.rng() * 0.3, (this.rng() - 0.5) * 0.4, 0.09 * p.size, 1.6 + this.rng(), 0xa6aab2, 0.45);
      } else if (kind === 'smoke') {
        fx.puff(bx, by, bz, 0, 0.15, 0, 0.05, 0.7, 0x9a9ea6, 0.3);
      } else if (kind === 'glow') {
        fx.billboard(bx, by, bz, 0.09 * p.size, col, 2.2, 0.18, 0, 1, 0, -2.5);
        if (P.look === 'vortex' || P.look === 'ion') fx.billboard(bx, by, bz, 0.22, col, 1.4, 0.3, 11, 1, this.rng() * 6.28, -1);
      } else if (kind === 'flare') {
        fx.billboard(bx, by, bz, 0.16, '#ffb36b', 2.6, 0.25, 0, 1, 0, -2);
        fx.puff(bx, by, bz, 0, 0.3, 0, 0.05, 1, 0xc9c0b8, 0.3);
      } else if (kind === 'sparks') {
        fx.spark(bx, by, bz, (this.rng() - 0.5) * 4, 1 + this.rng() * 2, (this.rng() - 0.5) * 4, 0.008, '#ffd08a', 2.4, 0.2);
      } else if (kind === 'drip') {
        fx.bubble(bx, by, bz, 0.03, col);
      } else if (kind === 'blink') {
        fx.billboard(bx, by, bz, 0.1, '#f38ba8', 2.6, 0.08);
      }
    }
  }

  // ═══ explosiones y zonas ══════════════════════════════════════════════════
  /**
   * Estallido en (x,y,z) con {radius, blast, force}. Daño con caída
   * cuadrática y bloqueado por paredes (línea de visión al pecho); miembros
   * que se cortan cerca del centro; empujón radial a TODAS las partículas
   * del mundo (cuerpos, cadáveres, sillas); el que disparó también la come.
   * O(cuerpos + partículas).
   */
  explode(x, y, z, P, def, shooter = null, kind = 'fire') {
    const w = this.world, r = P.radius, R2 = r * r * 1.3;
    this.stats.explosions++;
    const yy = Math.max(0.25, y);
    for (const B of this.sink.targets(true)) {
      if (!B.p || B === shooter) continue;
      const cx = B.px(CHEST), cy = B.py(CHEST), cz = B.pz(CHEST);
      const d2 = (cx - x) ** 2 + (cy - yy) ** 2 + (cz - z) ** 2;
      if (d2 > R2) continue;
      if (!w.lineOfSight(x, yy + 0.2, z, cx, cy, cz)) continue;
      const d = Math.sqrt(d2) + 1e-3, f = Math.max(0.12, 1 - d2 / (r * r));
      const ux = (cx - x) / d, uz = (cz - z) / d;
      const kf = (P.force || 20) * f;
      const info = { kind: 'blast', x, y: yy, z, dirx: ux, diry: 0, dirz: uz, pierced: 0 };
      this.sink.hitBody(B, B_SPINE, 0.5, P.blast * f, [ux * kf * 1.6, kf * 0.9 + 3, uz * kf * 1.6], def, info);
      // cerca del centro se van miembros
      if (f > 0.5 && !B.dead) {
        for (let k = 0; k < 2; k++) this.sink.hitBody(B, LIMBS[Math.floor(this.rng() * LIMBS.length)], 0.5, P.blast * f * 0.55, null, def, { ...info, limb: true });
      }
      if (P.shock) this.sink.applyStatus(B, 'shock', 1, def);
    }
    if (w.explode) w.explode(x, yy, z, r * 1.25, (P.force || 20) * 0.9);
    if (shooter && this.sink.selfBlast) this.sink.selfBlast(x, yy, z, r, P.blast, P.force || 20, def);
    const col = kind === 'ion' ? (def.shot.tracer || '#b4befe') : kind === 'plasma' ? (def.shot.tracer || '#a6e3a1') : kind === 'acid' ? '#b5f25a' : kind === 'vortex' ? (def.shot.tracer || '#b4befe') : '#ffb35a';
    if (this.fx) {
      if (kind === 'acid') { for (let i = 0; i < 18; i++) this.fx.bubble(x + (this.rng() - 0.5) * r, 0.1, z + (this.rng() - 0.5) * r, 0.05, col); this.fx.plane(x, 0.03, z, 0, 1, 0, r * 0.5, col, 1.6, 0.6, 4, 1, 2.4); }
      else if (kind === 'small') this.fx.explosion(x, yy, z, Math.max(1.2, r), '#ffb35a', 'fire');
      else this.fx.explosion(x, yy, z, r, col, kind === 'fire' ? 'fire' : kind);
    }
    if (this.sink.onExplosion) this.sink.onExplosion(x, yy, z, r, def, kind);
    if (P.pool) this.zones.push({ type: 'acid', x, y: 0, z, r: r * 0.8, t: P.pool, t0: P.pool, tick: 0, def });
  }

  _stepZones(dt) {
    const w = this.world, fx = this.fx;
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const Z = this.zones[i];
      Z.t -= dt;
      if (Z.type === 'vortex') {
        // chupa: velocidad hacia el centro a todas las partículas vivas en el radio (cuerpos y sillas)
        const r2 = Z.r * Z.r, pull = 26 * dt;
        if (w.pn !== undefined) for (let k = 0; k < w.pn; k++) {
          if (!(w.pf[k] & 1) || w.iw[k] === 0) continue;
          const dx = Z.x - w.px[k], dy = Z.y - w.py[k], dz = Z.z - w.pz[k], d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2 || d2 < 1e-4) continue;
          const d = Math.sqrt(d2), f = pull * (1 - d / Z.r * 0.6) / d;
          w.vx[k] += dx * f; w.vy[k] += dy * f + 0.4 * dt; w.vz[k] += dz * f;
        }
        for (const B of this.sink.targets(false)) { if (!B.dead && B.flinch && Math.hypot(B.x - Z.x, B.z - Z.z) < Z.r) B.flinch(0.25); }
        if (fx) {
          for (let k = 0; k < 4; k++) {
            const a = this.rng() * 6.283, rr = Z.r * (0.4 + this.rng() * 0.6);
            fx.mote(Z.x + Math.cos(a) * rr, Z.y + (this.rng() - 0.5), Z.z + Math.sin(a) * rr, -Math.cos(a) * rr * 2.2 - Math.sin(a) * 3, 0, -Math.sin(a) * rr * 2.2 + Math.cos(a) * 3, 0.06, Z.def.shot.tracer || '#b4befe', 2.2, 0.45, { drag: 0.5 });
          }
          fx.billboard(Z.x, Z.y, Z.z, 0.5 + (1 - Z.t / Z.t0) * 0.6, Z.def.shot.tracer || '#b4befe', 1.6, 0.06, 11, 1, this.rng() * 6.28);
        }
        if (Z.t <= 0) { this.zones.splice(i, 1); this.explode(Z.x, Z.y, Z.z, Z.P, Z.def, Z.shooter, 'vortex'); }
        continue;
      }
      if (Z.type === 'acid') {
        Z.tick -= dt;
        if (Z.tick <= 0) {
          Z.tick = 0.3;
          for (const B of this.sink.targets(false)) {
            if (B.dead || !B.p) continue;
            if (Math.hypot(B.x - Z.x, B.z - Z.z) < Z.r) this.sink.applyStatus(B, 'acid', 1.2, Z.def);
          }
        }
        if (fx && this.rng() < 0.8) fx.bubble(Z.x + (this.rng() - 0.5) * Z.r * 1.6, 0.05, Z.z + (this.rng() - 0.5) * Z.r * 1.6, 0.04, '#b5f25a');
        if (Z.t <= 0) this.zones.splice(i, 1);
      }
    }
  }
}
