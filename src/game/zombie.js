// ─────────────────────────────────────────────────────────────────────────────
//  zombie.js — La IA de la horda, estilo Left 4 Dead 2.
//
//  Cada zombi es una máquina de estados chiquita sobre un ragdoll activo:
//    dormido (deambula o descansa en el piso) → alerta (te vio, te oyó o le
//    pegaste: se da vuelta, medio segundo de reacción) → persecución (TODOS
//    corren; el campo de flujo lejos, directo cerca; separación y flanqueo
//    para rodear) → ataque (manotazo derecho o izquierdo, doble, agarrón,
//    mordida, mazazo del bruto, o el tacle del corredor: se tira de cabeza y
//    los dos van al piso) → (caído, levantándose) → muerto → cadáver.
//
//  Lo que ve el jugador lo pone el ragdoll: correr con estilo propio, chocar,
//  tropezar, caer, levantarse. La IA sólo decide adónde y a qué velocidad.
// ─────────────────────────────────────────────────────────────────────────────

import { Ragdoll, HEAD, CHEST, HIP } from '../phys/ragdoll.js';
import { clamp, clamp01, lerp, angDelta, TAU } from '../core/util.js';

export const ZTYPES = {
  //  walk: deambulando · run: persiguiendo (todos corren, a su manera)
  walker: { walk: [0.35, 0.70], run: [2.3, 2.9], scale: [0.95, 1.06], mass: 1.0, tough: 1.0, arm: 'reach', stride: 0.26, dmg: 10, reach: 1.15, stiffness: 125, mms: 10 },
  jogger: { walk: [0.45, 0.85], run: [2.9, 3.5], scale: [0.94, 1.03], mass: 0.95, tough: 0.9, arm: 'reach', stride: 0.29, dmg: 9, reach: 1.15, stiffness: 145, mms: 11 },
  runner: { walk: [0.55, 1.00], run: [3.6, 4.4], scale: [0.92, 1.00], mass: 0.9, tough: 0.75, arm: 'pump', stride: 0.32, dmg: 8, reach: 1.10, stiffness: 165, mms: 13 },
  brute:  { walk: [0.35, 0.55], run: [1.7, 2.2], scale: [1.16, 1.25], mass: 1.8, tough: 2.6, arm: 'reach', stride: 0.23, dmg: 24, reach: 1.35, stiffness: 130, mms: 9 },
};

//  Ataques: overlay que se ve, cuándo pega (hitAt), cuánto dura, daño relativo
//  y qué le hace al jugador además del daño.
export const ATTACKS = {
  swipe:    { ov: 'atk_swipe',    hitAt: 0.24, dur: 0.50, dmg: 1.0, lunge: 0.32, effect: 'shove' },
  double:   { ov: 'atk_double',   hitAt: 0.40, dur: 0.60, dmg: 1.3, lunge: 0.36, effect: 'shove' },
  grab:     { ov: 'atk_grab',     hitAt: 0.22, dur: 0.75, dmg: 0.6, lunge: 0.30, effect: 'grab' },
  bite:     { ov: 'atk_bite',     hitAt: 0.20, dur: 0.48, dmg: 1.1, lunge: 0.28, effect: 'none' },
  overhead: { ov: 'atk_overhead', hitAt: 0.48, dur: 0.80, dmg: 1.4, lunge: 0.30, effect: 'knockdown' },
  tackle:   { ov: null,           hitAt: 0.22, dur: 1.10, dmg: 0.9, lunge: 0,    effect: 'tackle' },
};

let NEXT_ID = 1;

export class Zombie {
  constructor(world, opt) {
    const T = ZTYPES[opt.type] || ZTYPES.walker;
    const rng = opt.rng;
    this.id = NEXT_ID++;
    this.type = opt.type || 'walker';
    this.def = T;
    this.rng = rng;
    const scale = lerp(T.scale[0], T.scale[1], rng());
    this.body = new Ragdoll(world, {
      x: opt.x, z: opt.z, yaw: opt.yaw ?? rng() * TAU, scale, massScale: T.mass, toughness: T.tough,
      armMode: T.arm, stride: T.stride, rng, stiffness: T.stiffness, maxMuscleSpeed: T.mms, kind: this.type,
    });
    this.body.zombie = this;
    this.walkSpeed = lerp(T.walk[0], T.walk[1], rng());
    this.runSpeed = lerp(T.run[0], T.run[1], rng());
    this.speed = this.runSpeed;
    this.dmg = T.dmg;
    this.reach = T.reach * scale;
    this.state = opt.asleep ? 'idle' : 'chase';
    this.alert = !opt.asleep;
    this.reactT = 0;
    this.attack = null; this.attackT = 0; this.hitDone = false;
    this.cool = 0;
    this.losT = rng() * 0.3; this.los = false;
    this.moanT = 2 + rng() * 6;
    this.wanderT = 0; this.wanderX = 0; this.wanderZ = 0;
    this.dirX = 0; this.dirZ = 0;
    this.wobble = rng() * TAU;
    this.flank = (rng() - 0.5) * 0.7;          // lado por el que rodea
    this.corpse = false;
    this.killedBy = null;
    this.dormant = false;
    this.attacks = 0; this.tackles = 0;
  }
  get x() { return this.body.x; }
  get z() { return this.body.z; }
  get dead() { return this.body.dead; }

  /** Se queda dormido en el piso o sentado (se levanta cuando algo lo alerta). */
  restAs(pose) {
    this.body.rest(pose, this.rng() < 0.5 ? 1 : 0);
    this.dormant = true;
    this.state = 'idle';
    this.alert = false;
  }
  /** Algo lo alertó: reacciona (se da vuelta) y arranca a correr. */
  wakeUp() {
    if (this.alert) return;
    this.alert = true;
    if (this.dormant) { this.dormant = false; this.body.wake(); }
    this.state = 'react';
    this.reactT = 0.25 + this.rng() * 0.45;
  }
}

export class ZombieManager {
  constructor(world, nav, rng) {
    this.world = world;
    this.nav = nav;
    this.rng = rng;
    this.zombies = [];
    this.flowX = NaN; this.flowZ = NaN; this.flowT = 0;
    this._dir = { x: 0, z: 0 };
    this.alive = 0;
    this.maxMoans = 5; this.moaning = 0;
  }

  /** `asleep`: deambula; con `rest` ('sit','kneel','supine','prone','side') descansa en el piso. */
  spawn(type, x, z, yaw, asleep = false, rest = null) {
    const Z = new Zombie(this.world, { type, x, z, yaw, rng: this.rng, asleep });
    this.zombies.push(Z);
    if (asleep && rest) Z.restAs(rest);
    return Z;
  }

  /** Un ruido: todos los que están cerca se despiertan y van. */
  alertAll(x, z, r) {
    const r2 = r * r;
    for (const Z of this.zombies) {
      if (Z.dead || Z.alert) continue;
      const dx = Z.x - x, dz = Z.z - z;
      if (dx * dx + dz * dz < r2) Z.wakeUp();
    }
  }

  _updateFlow(px, pz, dt) {
    this.flowT -= dt;
    const moved = Number.isNaN(this.flowX) || Math.hypot(px - this.flowX, pz - this.flowZ) > 0.5;
    if (moved || this.flowT <= 0) {
      this.nav.computeFlow(px, pz);
      this.flowX = px; this.flowZ = pz; this.flowT = 0.6;
    }
  }

  /** Elige el ataque según el tipo, la velocidad y el azar. */
  _pickAttack(Z, dist) {
    const r = this.rng(), B = Z.body;
    if (Z.type === 'brute') return r < 0.7 ? 'overhead' : 'double';
    if (Z.type === 'runner') {
      if (B.speed > 2.6 && dist < Z.reach + 0.6 && r < 0.30) return 'tackle';
      return r < 0.55 ? 'swipe' : r < 0.75 ? 'double' : r < 0.9 ? 'bite' : 'grab';
    }
    return r < 0.45 ? 'swipe' : r < 0.60 ? 'double' : r < 0.78 ? 'grab' : 'bite';
  }

  /**
   * @param hooks {onAttack(Z, dmg, dirx, dirz, kind), onDeath(Z), onCorpse(Z), onMoan(Z)}
   */
  update(dt, player, hooks) {
    const w = this.world, nav = this.nav, rng = this.rng;
    const px = player.x, pz = player.z, py = player.body.py(CHEST);
    const playerAlive = player.alive;
    if (playerAlive) this._updateFlow(px, pz, dt);
    const dir = this._dir;
    const zs = this.zombies;
    let alive = 0;

    for (let i = zs.length - 1; i >= 0; i--) {
      const Z = zs[i], B = Z.body;

      // ── muerto: esperar a que se aquiete y congelarlo ──
      if (B.dead) {
        if (Z.state !== 'dead') { Z.state = 'dead'; if (hooks.onDeath) hooks.onDeath(Z); }
        if (B.deadT > 3.4 && !Z.corpse) {
          Z.corpse = true;
          if (hooks.onCorpse) hooks.onCorpse(Z);
          B.dispose();
          zs.splice(i, 1);
        }
        continue;
      }
      alive++;
      if (!B.alive) { zs.splice(i, 1); continue; }
      if (B.dying > 0) { B.wantSpeed = 0; continue; }   // se está muriendo: la secuencia manda
      // se cayó de la losa
      if (B.y < w.killY + 2) { B.kill(); continue; }

      const dx = px - Z.x, dz = pz - Z.z;
      const dist = Math.hypot(dx, dz);
      const ux = dist > 1e-4 ? dx / dist : 0, uz = dist > 1e-4 ? dz / dist : 1;
      // nivel de detalle físico: lejos del jugador no hacen falta las pasadas
      // finas de huesos (nadie las ve y cuestan)
      B.lod = dist > 22 ? 2 : dist > 13 ? 1 : 0;

      // línea de vista, escalonada para no hacer todos los rayos el mismo frame
      Z.losT -= dt;
      if (Z.losT <= 0) {
        Z.losT = 0.25 + rng() * 0.15;
        Z.los = dist < 18 && w.lineOfSight(Z.x, B.py(HEAD), Z.z, px, py, pz);
      }

      // gemidos
      Z.moanT -= dt;
      if (Z.moanT <= 0) {
        Z.moanT = 3 + rng() * 8;
        if (dist < 22 && hooks.onMoan) hooks.onMoan(Z, dist);
      }

      if (Z.cool > 0) Z.cool -= dt;
      // la cabeza mira al jugador cuando lo persigue
      if (Z.alert && playerAlive && dist < 12) { B.lookX = ux; B.lookZ = uz; } else { B.lookX = 0; B.lookZ = 0; }

      if (!playerAlive && Z.state !== 'idle') { Z.state = 'idle'; Z.alert = false; }

      // sin control del cuerpo (cayendo, tirado, levantándose, tambaleando) la IA espera
      if (!B.inControl && Z.state !== 'idle' && Z.state !== 'attack') { B.wantSpeed = 0; continue; }

      switch (Z.state) {
        case 'idle': {
          if (playerAlive && !Z.alert && ((dist < 13 && Z.los) || dist < 2.5)) { Z.wakeUp(); break; }
          if (playerAlive && Z.alert) { Z.state = 'chase'; break; }
          if (Z.dormant) { B.wantSpeed = 0; break; }
          if (!B.inControl) { B.wantSpeed = 0; break; }
          // deambular: cambia de rumbo cada tanto, se queda quieto a veces
          Z.wanderT -= dt;
          if (Z.wanderT <= 0) {
            Z.wanderT = 2 + rng() * 5;
            if (rng() < 0.45) { Z.wanderX = 0; Z.wanderZ = 0; }
            else { const a = rng() * TAU; Z.wanderX = Math.cos(a); Z.wanderZ = Math.sin(a); }
          }
          // no salirse de la losa ni meterse en paredes: si la celda de adelante no es transitable, girar
          if (Z.wanderX || Z.wanderZ) {
            if (!nav.walkable(Z.x + Z.wanderX * 0.8, Z.z + Z.wanderZ * 0.8)) { Z.wanderX = -Z.wanderX; Z.wanderZ = -Z.wanderZ; }
            B.wantX = Z.wanderX; B.wantZ = Z.wanderZ; B.wantSpeed = Z.walkSpeed;
          } else B.wantSpeed = 0;
          break;
        }
        case 'react': {
          // te vio: se da vuelta hacia vos, un instante, y arranca
          Z.reactT -= dt;
          B.wantX = ux; B.wantZ = uz; B.wantSpeed = 0.05;
          B.lookX = ux; B.lookZ = uz;
          if (Z.reactT <= 0) Z.state = 'chase';
          break;
        }
        case 'chase': {
          // rumbo: directo si está cerca y lo ve, si no el campo de flujo
          let tx, tz;
          if (dist < 6.5 && Z.los) { tx = ux; tz = uz; }
          else if (nav.dirAt(Z.x, Z.z, dir) && (dir.x || dir.z)) { tx = dir.x; tz = dir.z; }
          else { tx = ux; tz = uz; }

          // separación de vecinos: que la horda se abra
          let sx = 0, sz = 0;
          for (let j = 0; j < zs.length; j++) {
            const O = zs[j];
            if (O === Z || O.dead) continue;
            const ox = Z.x - O.x, oz = Z.z - O.z;
            const d2 = ox * ox + oz * oz;
            if (d2 > 1.0 || d2 < 1e-6) continue;
            const d = Math.sqrt(d2), f = (1 - d) / d;
            sx += ox * f; sz += oz * f;
          }
          // flanqueo: cerca, cada uno tira para su lado y te rodean en vez de hacer fila
          const fl = dist < 7 && dist > 1.8 ? Z.flank * clamp01((dist - 1.8) / 3) : 0;
          // un poco de bamboleo personal, para que no corran en línea
          Z.wobble += dt * 0.9;
          const wob = Math.sin(Z.wobble) * 0.14 + fl;
          let vx = tx + sx * 0.55 - tz * wob, vz = tz + sz * 0.55 + tx * wob;
          const vl = Math.hypot(vx, vz) || 1;
          vx /= vl; vz /= vl;
          // suavizado del rumbo
          const k = 1 - Math.pow(0.004, dt);
          Z.dirX += (vx - Z.dirX) * k; Z.dirZ += (vz - Z.dirZ) * k;
          const dl = Math.hypot(Z.dirX, Z.dirZ) || 1;
          B.wantX = Z.dirX / dl; B.wantZ = Z.dirZ / dl;
          // TODOS corren cuando persiguen (a lo Left 4 Dead); muy cerca frenan un poco para no pasarse
          const near = dist < Z.reach + 0.4 ? 0.55 : 1;
          B.wantSpeed = Z.runSpeed * near * (B.crawling ? 0.45 : 1);

          if (dist < Z.reach + 0.15 && Z.cool <= 0 && playerAlive) {
            const name = this._pickAttack(Z, dist);
            const A = ATTACKS[name];
            Z.state = 'attack'; Z.attack = name; Z.attackT = 0; Z.hitDone = false; Z.attacks++;
            if (name === 'tackle') { B.fall('tackle', ux, uz, 1); Z.tackles++; }
            else { B.playOverlay(A.ov, 1, { sx: rng() < 0.5 ? 1 : -1, along: 0, lat: 0 }); B.lunge = A.lunge; }
          }
          break;
        }
        case 'attack': {
          const A = ATTACKS[Z.attack];
          Z.attackT += dt;
          if (Z.attack !== 'tackle') {
            if (B.stagger > 0.4 || !B.upright || !B.inControl) { Z.state = 'chase'; Z.cool = 1.0; B.wantSpeed = 0; break; }
            // encarar al jugador y embestir un instante
            B.wantX = ux; B.wantZ = uz;
            B.wantSpeed = Z.attackT < 0.16 ? Z.runSpeed * 0.9 + 0.8 : 0.15;
          }
          if (!Z.hitDone && Z.attackT >= A.hitAt) {
            Z.hitDone = true;
            const reach = Z.attack === 'tackle' ? Z.reach + 0.55 : Z.reach + 0.35;
            if (dist < reach && playerAlive && hooks.onAttack) hooks.onAttack(Z, Z.dmg * A.dmg, ux, uz, Z.attack);
          }
          if (Z.attackT > A.dur) { Z.state = 'chase'; Z.cool = (Z.attack === 'tackle' ? 1.6 : 0.9) + rng() * 0.9; }
          break;
        }
      }
    }
    this.alive = alive;
  }

  /** El zombi vivo más cercano a un punto (para el empujón, etc.). */
  nearest(x, z, maxR = Infinity) {
    let best = null, bd = maxR * maxR;
    for (const Z of this.zombies) {
      if (Z.dead) continue;
      const dx = Z.x - x, dz = Z.z - z, d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = Z; }
    }
    return best;
  }

  clear() {
    for (const Z of this.zombies) if (Z.body.alive) Z.body.dispose();
    this.zombies.length = 0;
    this.alive = 0;
  }
}
