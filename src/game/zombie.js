// ─────────────────────────────────────────────────────────────────────────────
//  zombie.js — La IA de la horda.
//
//  Cada zombi es una máquina de estados chiquita sobre un ragdoll activo:
//    dormido → alerta → persecución → manotazo → (aturdido) → muerto → cadáver
//  La persecución lee el campo de flujo (nav.js); cerca y con línea de vista
//  va directo. Una separación barata entre vecinos hace que la horda se
//  desparrame como multitud y no como fila india. El ataque es una embestida:
//  los brazos se lanzan (ragdoll.lunge) y si las manos llegan, duele.
// ─────────────────────────────────────────────────────────────────────────────

import { Ragdoll, HEAD, CHEST, HIP } from '../phys/ragdoll.js';
import { clamp, clamp01, lerp, angDelta, TAU } from '../core/util.js';

export const ZTYPES = {
  walker: { speed: [0.9, 1.5], scale: [0.95, 1.06], mass: 1.0, tough: 1.0, arm: 'reach', stride: 0.24, dmg: 12, reach: 1.15, hp: 1 },
  jogger: { speed: [2.0, 2.7], scale: [0.94, 1.03], mass: 0.95, tough: 0.9, arm: 'reach', stride: 0.28, dmg: 11, reach: 1.15, hp: 1 },
  runner: { speed: [3.4, 4.2], scale: [0.92, 1.0], mass: 0.9, tough: 0.75, arm: 'pump', stride: 0.32, dmg: 10, reach: 1.1, hp: 1 },
  brute:  { speed: [0.8, 1.05], scale: [1.16, 1.25], mass: 1.8, tough: 2.6, arm: 'reach', stride: 0.22, dmg: 26, reach: 1.35, hp: 1 },
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
      armMode: T.arm, stride: T.stride, rng, stiffness: opt.type === 'runner' ? 165 : opt.type === 'jogger' ? 140 : 120,
      maxMuscleSpeed: opt.type === 'runner' ? 13 : opt.type === 'jogger' ? 11 : 9,
    });
    this.body.zombie = this;
    this.speed = lerp(T.speed[0], T.speed[1], rng());
    this.dmg = T.dmg;
    this.reach = T.reach * scale;
    this.state = opt.asleep ? 'idle' : 'chase';
    this.alert = !opt.asleep;
    this.attackT = 0; this.hitDone = false;
    this.cool = 0;
    this.losT = rng() * 0.3; this.los = false;
    this.moanT = 2 + rng() * 6;
    this.wanderT = 0; this.wanderX = 0; this.wanderZ = 0;
    this.dirX = 0; this.dirZ = 0;
    this.wobble = rng() * TAU;
    this.corpse = false;
    this.killedBy = null;
  }
  get x() { return this.body.x; }
  get z() { return this.body.z; }
  get dead() { return this.body.dead; }
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

  spawn(type, x, z, yaw, asleep = false) {
    const Z = new Zombie(this.world, { type, x, z, yaw, rng: this.rng, asleep });
    this.zombies.push(Z);
    return Z;
  }

  /** Un ruido: todos los que están cerca se despiertan y van. */
  alertAll(x, z, r) {
    const r2 = r * r;
    for (const Z of this.zombies) {
      if (Z.dead || Z.alert) continue;
      const dx = Z.x - x, dz = Z.z - z;
      if (dx * dx + dz * dz < r2) { Z.alert = true; Z.state = 'chase'; }
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

  /**
   * @param hooks {onAttack(Z, dmg, dirx, dirz), onDeath(Z), onCorpse(Z), onMoan(Z)}
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
      if (B.dying > 0) { B.wantSpeed = 0; continue; }   // se está muriendo: tambalea y cae
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

      if (!playerAlive) {
        // sin jugador: deambular lento alrededor del cuerpo
        Z.state = 'idle';
      }

      switch (Z.state) {
        case 'idle': {
          if (playerAlive && !Z.alert && ((dist < 13 && Z.los) || dist < 2.5)) { Z.alert = true; Z.state = 'chase'; break; }
          if (playerAlive && Z.alert) { Z.state = 'chase'; break; }
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
            B.wantX = Z.wanderX; B.wantZ = Z.wanderZ; B.wantSpeed = 0.35;
          } else B.wantSpeed = 0;
          break;
        }
        case 'chase': {
          // sin control del cuerpo (tirado, sacudido) no se puede correr; un
          // simple tambaleo NO frena: el ragdoll se encarga de que se note
          if (!B.upright || !B.inControl) { B.wantSpeed = 0; break; }
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
          // un poco de bamboleo personal, para que no caminen en línea
          Z.wobble += dt * 0.9;
          const wob = Math.sin(Z.wobble) * 0.18;
          let vx = tx + sx * 0.55 - tz * wob, vz = tz + sz * 0.55 + tx * wob;
          const vl = Math.hypot(vx, vz) || 1;
          vx /= vl; vz /= vl;
          // suavizado del rumbo
          const k = 1 - Math.pow(0.004, dt);
          Z.dirX += (vx - Z.dirX) * k; Z.dirZ += (vz - Z.dirZ) * k;
          const dl = Math.hypot(Z.dirX, Z.dirZ) || 1;
          B.wantX = Z.dirX / dl; B.wantZ = Z.dirZ / dl;
          // los caminantes se lanzan al trote los últimos metros cuando te ven
          const rush = (Z.type === 'walker' && Z.los && dist < 5.5) ? 1.55 : 1;
          B.wantSpeed = Z.speed * rush * (B.crawling ? 0.45 : 1);

          if (dist < Z.reach && Z.cool <= 0 && playerAlive) {
            Z.state = 'attack'; Z.attackT = 0; Z.hitDone = false;
            B.lunge = 0.36;
          }
          break;
        }
        case 'attack': {
          Z.attackT += dt;
          if (B.stagger > 0.4 || !B.upright) { Z.state = 'chase'; Z.cool = 1.0; B.wantSpeed = 0; break; }
          // encarar al jugador y embestir un instante
          B.wantX = ux; B.wantZ = uz;
          B.wantSpeed = Z.attackT < 0.18 ? Z.speed * 1.6 + 1.2 : 0.2;
          if (!Z.hitDone && Z.attackT > 0.15 && Z.attackT < 0.30) {
            if (dist < Z.reach + 0.35 && playerAlive) {
              Z.hitDone = true;
              if (hooks.onAttack) hooks.onAttack(Z, Z.dmg, ux, uz);
            }
          }
          if (Z.attackT > 0.55) { Z.state = 'chase'; Z.cool = 0.8 + rng() * 0.7; }
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
