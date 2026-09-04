// ─────────────────────────────────────────────────────────────────────────────
//  zombie.js — La IA de la horda, estilo Left 4 Dead 2.
//
//  Cada zombi es una máquina de estados chiquita sobre un ragdoll activo:
//    dormido (deambula o descansa en el piso) → alerta (te vio, te oyó o le
//    pegaste: se da vuelta, medio segundo de reacción) → persecución (TODOS
//    corren; el campo de flujo lejos, directo cerca; separación y flanqueo
//    para rodear) → ataque (dos docenas: manotazos, garras, cabezazos,
//    rodillazos, patadas, molinetes, pisotones si estás en el piso, agarrar y
//    sacudir, morder el cuello, ráfagas; el tacle y la embestida a la carrera;
//    y los que VUELAN: se lanzan en plancha desde tres metros, rodillazo
//    volador, o se tiran encima desde un escritorio) → (caído, levantándose)
//    → muerto → cadáver.
//
//  Rasgos: uno de cada cinco "pega saltitos" (brinca mientras corre, salta de
//  emoción al verte); dos de cada diez hacen parkour (trepan en kong y dash,
//  ruedan al caer, rebotan en las paredes con el pie, se lanzan desde lejos).
//
//  Lo que ve el jugador lo pone el ragdoll: correr con estilo propio, chocar,
//  tropezar, caer, levantarse, saltar. La IA sólo decide adónde, a qué
//  velocidad y cuándo lanzarse.
// ─────────────────────────────────────────────────────────────────────────────

import { Ragdoll, HEAD, CHEST, HIP } from '../phys/ragdoll.js';
import { OVER, HOP_STYLES } from '../phys/moves.js';
import { clamp, clamp01, lerp, angDelta, TAU } from '../core/util.js';

export const ZTYPES = {
  //  walk: deambulando · run: persiguiendo (todos corren, a su manera) · agility: base del rasgo
  walker: { walk: [0.35, 0.70], run: [2.3, 2.9], scale: [0.95, 1.06], mass: 1.0, tough: 1.0, arm: 'reach', stride: 0.26, dmg: 10, reach: 1.15, stiffness: 125, mms: 10, agility: 0.20 },
  jogger: { walk: [0.45, 0.85], run: [2.9, 3.5], scale: [0.94, 1.03], mass: 0.95, tough: 0.9, arm: 'reach', stride: 0.29, dmg: 9, reach: 1.15, stiffness: 145, mms: 11, agility: 0.40 },
  runner: { walk: [0.55, 1.00], run: [3.6, 4.4], scale: [0.92, 1.00], mass: 0.9, tough: 0.75, arm: 'pump', stride: 0.32, dmg: 8, reach: 1.10, stiffness: 165, mms: 13, agility: 0.65 },
  brute:  { walk: [0.35, 0.55], run: [1.7, 2.2], scale: [1.16, 1.25], mass: 1.8, tough: 2.6, arm: 'reach', stride: 0.23, dmg: 24, reach: 1.35, stiffness: 130, mms: 9, agility: 0.10 },
};

//  Proporción de rasgos en la horda.
export const TRAIT_RATES = { hopper: 0.20, parkour: 0.20 };

//  Ataques: overlay que se ve, cuándo pega (hitAt, o hits: varios), cuánto
//  dura, daño relativo y qué le hace al jugador además del daño:
//   shove: empujón · grab: lo agarra (camina lento) · stagger: tambaleo grande
//   · knockdown: lo tira · tackle: los dos al piso · launch: lo levanta.
//  jump: el ataque es un salto (pega al aterrizar) · move: una secuencia
//  (embestida) · onDown: sólo cuando el jugador está en el piso.
export const ATTACKS = {
  swipe:       { ov: 'atk_swipe',       hitAt: 0.24, dur: 0.50, dmg: 1.0, lunge: 0.32, effect: 'shove' },
  double:      { ov: 'atk_double',      hitAt: 0.40, dur: 0.60, dmg: 1.3, lunge: 0.36, effect: 'shove' },
  grab:        { ov: 'atk_grab',        hitAt: 0.22, dur: 0.75, dmg: 0.6, lunge: 0.30, effect: 'grab' },
  bite:        { ov: 'atk_bite',        hitAt: 0.20, dur: 0.48, dmg: 1.1, lunge: 0.28, effect: 'none' },
  overhead:    { ov: 'atk_overhead',    hitAt: 0.48, dur: 0.80, dmg: 1.4, lunge: 0.30, effect: 'knockdown' },
  tackle:      { ov: null,              hitAt: 0.22, dur: 1.10, dmg: 0.9, lunge: 0,    effect: 'tackle' },
  headbutt:    { ov: 'atk_headbutt',    hitAt: 0.22, dur: 0.50, dmg: 1.2, lunge: 0.30, effect: 'stagger' },
  claw:        { ov: 'atk_claw',        hitAt: 0.22, dur: 0.50, dmg: 0.9, lunge: 0.32, effect: 'shove' },
  uppercut:    { ov: 'atk_uppercut',    hitAt: 0.30, dur: 0.50, dmg: 1.3, lunge: 0.28, effect: 'launch' },
  haymaker:    { ov: 'atk_haymaker',    hitAt: 0.52, dur: 0.85, dmg: 1.7, lunge: 0.30, effect: 'knockdown' },
  backhand:    { ov: 'atk_backhand',    hitAt: 0.18, dur: 0.42, dmg: 0.8, lunge: 0.30, effect: 'shove' },
  knee:        { ov: 'atk_knee',        hitAt: 0.22, dur: 0.55, dmg: 1.0, lunge: 0.26, effect: 'stagger' },
  kick:        { ov: 'atk_kick',        hitAt: 0.30, dur: 0.60, dmg: 1.1, lunge: 0.20, effect: 'shove' },
  stomp:       { ov: 'atk_stomp',       hitAt: 0.45, dur: 0.70, dmg: 1.3, lunge: 0,    effect: 'none', onDown: true },
  frenzy:      { ov: 'atk_frenzy',      hits: [0.18, 0.42, 0.66], dur: 0.95, dmg: 0.5, lunge: 0.34, effect: 'shove' },
  shake:       { ov: 'atk_shake',       hits: [0.25, 0.55], dur: 0.90, dmg: 0.6, lunge: 0.30, effect: 'grab' },
  spin_swipe:  { ov: 'atk_spin_swipe',  hitAt: 0.40, dur: 0.80, dmg: 1.5, lunge: 0.25, effect: 'knockdown', spin: 8 },
  slam_fists:  { ov: 'atk_slam_fists',  hitAt: 0.48, dur: 0.90, dmg: 1.8, lunge: 0.25, effect: 'knockdown' },
  bite_neck:   { ov: 'atk_bite_neck',   hitAt: 0.42, dur: 0.75, dmg: 1.3, lunge: 0.30, effect: 'grab' },
  lunge_grab:  { ov: 'atk_lunge_grab',  hitAt: 0.20, dur: 0.70, dmg: 0.7, lunge: 0.45, effect: 'grab' },
  double_rake: { ov: 'atk_double_rake', hitAt: 0.30, dur: 0.60, dmg: 1.2, lunge: 0.32, effect: 'shove' },
  charge:      { ov: null,              hitAt: 0.30, dur: 0.80, dmg: 1.2, lunge: 0,    effect: 'knockdown', move: 'charge' },
  pounce:      { ov: null,              hitAt: -1,   dur: 1.80, dmg: 1.1, lunge: 0,    effect: 'tackle', jump: true },
  flying_knee: { ov: null,              hitAt: -1,   dur: 1.30, dmg: 1.4, lunge: 0,    effect: 'knockdown', jump: true, style: 'knee' },
  drop:        { ov: null,              hitAt: -1,   dur: 1.80, dmg: 1.5, lunge: 0,    effect: 'knockdown', jump: true, fromHeight: true },
};

let NEXT_ID = 1;
const pickW = (rng, opts) => { let tot = 0; for (const [, w] of opts) tot += w; let r = rng() * tot; for (const [n, w] of opts) if ((r -= w) <= 0) return n; return opts[opts.length - 1][0]; };

export class Zombie {
  constructor(world, opt) {
    const T = ZTYPES[opt.type] || ZTYPES.walker;
    const rng = opt.rng;
    this.id = NEXT_ID++;
    this.type = opt.type || 'walker';
    this.def = T;
    this.rng = rng;
    const scale = lerp(T.scale[0], T.scale[1], rng());
    // — rasgos: 1 de cada 5 pega saltitos, 2 de cada 10 hace parkour (sorteos independientes) —
    const hopper = opt.traits?.hopper ?? rng() < TRAIT_RATES.hopper;
    const parkour = opt.traits?.parkour ?? rng() < TRAIT_RATES.parkour;
    const hopStyles = this.type === 'runner' ? ['skip', 'bound', 'kick', 'flail'] : this.type === 'brute' ? ['hop', 'hop', 'excited'] : ['hop', 'skip', 'flail', 'excited', 'star'];
    this.traits = {
      hopper, parkour,
      agility: clamp01(T.agility + (rng() - 0.5) * 0.3 + (parkour ? 0.45 : 0)),
      hopStyle: opt.traits?.hopStyle || hopStyles[Math.floor(rng() * hopStyles.length)],
    };
    this.body = new Ragdoll(world, {
      x: opt.x, z: opt.z, yaw: opt.yaw ?? rng() * TAU, scale, massScale: T.mass, toughness: T.tough,
      armMode: T.arm, stride: T.stride, rng, stiffness: T.stiffness, maxMuscleSpeed: T.mms, kind: this.type,
      traits: this.traits,
    });
    this.body.zombie = this;
    this.walkSpeed = lerp(T.walk[0], T.walk[1], rng());
    this.runSpeed = lerp(T.run[0], T.run[1], rng()) * (parkour ? 1.08 : 1);
    this.speed = this.runSpeed;
    this.dmg = T.dmg;
    this.reach = T.reach * scale;
    this.state = opt.asleep ? 'idle' : 'chase';
    this.alert = !opt.asleep;
    this.reactT = 0;
    this.attack = null; this.attackT = 0; this.hitDone = false; this.hitIdx = 0;
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
    this.attacks = 0; this.tackles = 0; this.pounces = 0; this.charges = 0; this.dropAttacks = 0;
    this.attackKinds = {};
    // ritmo de los brincos y de los vuelos (los vuelos son un evento, no la regla:
    // la mayoría te llega corriendo, y si te movés se estrella contra lo que haya)
    this.hopT = 0.8 + rng() * 2.5;
    this.excitedHops = 0;
    this.pounceCool = 4 + rng() * 6;
    this.chargeCool = 3 + rng() * 5;
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
    // el que pega saltitos se emociona: dos o tres brincos en el lugar antes de salir
    this.excitedHops = this.traits.hopper ? 1 + Math.floor(this.rng() * 3) : 0;
    if (this.excitedHops) this.reactT += 0.25 * this.excitedHops;
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
    this.stats = { hops: 0, pounces: 0, drops: 0, charges: 0, vaults: 0, rolls: 0, wallKicks: 0, flyingKnees: 0 };
  }

  /** `asleep`: deambula; con `rest` ('sit','kneel','supine','prone','side') descansa en el piso. */
  spawn(type, x, z, yaw, asleep = false, rest = null, traits = null) {
    const Z = new Zombie(this.world, { type, x, z, yaw, rng: this.rng, asleep, traits });
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

  /** Elige el ataque cuerpo a cuerpo según el tipo, la velocidad, el rasgo, si estás en el piso y el azar. */
  _pickAttack(Z, dist, player) {
    const rng = this.rng, B = Z.body;
    const PB = player.body;
    const playerDown = PB && (PB.state !== 'up' || !PB.upright);
    if (playerDown) return pickW(rng, [['stomp', 5], ['bite', 2], ['double_rake', 1.5], ['slam_fists', Z.type === 'brute' ? 4 : 0]]);
    if (Z.type === 'brute') return pickW(rng, [['overhead', 3.5], ['slam_fists', 2.5], ['spin_swipe', 1.5], ['haymaker', 1.5], ['double', 1], ['backhand', 0.8]]);
    const fast = B.speed > 2.6 && dist < Z.reach + 0.6;
    if (Z.traits.parkour && fast && rng() < 0.12) return 'flying_knee';
    if (Z.type === 'runner') {
      if (fast && rng() < 0.22) return 'tackle';
      return pickW(rng, [['swipe', 3], ['double', 1.5], ['claw', 1.5], ['bite', 1], ['frenzy', 1.2], ['lunge_grab', 1], ['knee', 0.8], ['headbutt', 0.8], ['uppercut', 0.5], ['kick', 0.6]]);
    }
    if (Z.type === 'jogger') return pickW(rng, [['swipe', 3], ['double', 1.2], ['claw', 1.5], ['grab', 1], ['bite_neck', 1], ['backhand', 1], ['uppercut', 0.6], ['kick', 0.8], ['double_rake', 0.8], ['haymaker', 0.4]]);
    return pickW(rng, [['swipe', 3], ['double', 1], ['grab', 1.2], ['bite', 1.2], ['backhand', 1], ['shake', 1], ['double_rake', 1], ['headbutt', 0.8], ['claw', 0.8], ['haymaker', 0.5]]);
  }

  /** Arranca un ataque (overlay, tacle, salto o embestida). */
  _startAttack(Z, name, ux, uz, dist) {
    const B = Z.body, A = ATTACKS[name], rng = this.rng;
    Z.state = 'attack'; Z.attack = name; Z.attackT = 0; Z.hitDone = false; Z.hitIdx = 0; Z.attacks++;
    Z.attackKinds[name] = (Z.attackKinds[name] || 0) + 1;
    if (name === 'tackle') { B.fall('tackle', ux, uz, 1); Z.tackles++; return; }
    if (A.jump) {
      B.landedJump = null;
      if (name === 'flying_knee') {
        const sp = Math.max(B.speed, 2.5), fl = 2 * 3.0 / -this.world.gravity;
        B.jump('knee', 3.0, ux * Math.max(sp, (dist + 0.3) / fl), uz * Math.max(sp, (dist + 0.3) / fl), { land: 'crouch', prep: 0.06, attack: name });
        this.stats.flyingKnees++;
      } else {
        // pounce y drop: plancha hacia el jugador (los que hacen parkour ruedan si fallan)
        B.pounce(Z.px, Z.pz, { roll: Z.traits.parkour });
        if (A.fromHeight) { Z.dropAttacks++; this.stats.drops++; } else { Z.pounces++; this.stats.pounces++; }
      }
      return;
    }
    if (A.move) { B.playMove(A.move, { s: rng() < 0.5 ? 1 : 0 }); Z.charges++; this.stats.charges++; return; }
    B.playOverlay(A.ov, 1, { sx: rng() < 0.5 ? 1 : -1, along: 0, lat: 0 });
    B.lunge = A.lunge;
    if (A.spin && !B.lockYaw) B.spin += (rng() < 0.5 ? 1 : -1) * A.spin;
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
    // ¿cuántos están volando hacia el jugador ahora? (de a uno: un vuelo es un evento)
    let fliers = 0;
    for (let i = 0; i < zs.length; i++) { const Z = zs[i]; if (Z.state === 'attack' && ATTACKS[Z.attack] && ATTACKS[Z.attack].jump) fliers++; }

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
      Z.px = px; Z.pz = pz;
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
      if (Z.pounceCool > 0) Z.pounceCool -= dt;
      if (Z.chargeCool > 0) Z.chargeCool -= dt;
      // la cabeza mira al jugador cuando lo persigue
      if (Z.alert && playerAlive && dist < 12) { B.lookX = ux; B.lookZ = uz; } else { B.lookX = 0; B.lookZ = 0; }

      if (!playerAlive && Z.state !== 'idle') { Z.state = 'idle'; Z.alert = false; }

      // sin control del cuerpo (cayendo, tirado, levantándose, tambaleando, volando) la IA espera
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
            // el que pega saltitos, parado, se mece sobre las rodillas
            if (Z.traits.hopper && !Z.wanderX && !Z.wanderZ && rng() < 0.6) B.idleOv = { def: OVER.id_bob, t: 0, k: 1, ctx: { sx: 1, along: 0, lat: 0 } };
          }
          // no salirse de la losa ni meterse en paredes: si la celda de adelante no es transitable, girar
          if (Z.wanderX || Z.wanderZ) {
            if (!nav.walkable(Z.x + Z.wanderX * 0.8, Z.z + Z.wanderZ * 0.8)) { Z.wanderX = -Z.wanderX; Z.wanderZ = -Z.wanderZ; }
            B.wantX = Z.wanderX; B.wantZ = Z.wanderZ; B.wantSpeed = Z.walkSpeed;
          } else B.wantSpeed = 0;
          break;
        }
        case 'react': {
          // te vio: se da vuelta hacia vos, un instante, y arranca. El que pega
          // saltitos brinca de emoción un par de veces antes de salir
          Z.reactT -= dt;
          B.wantX = ux; B.wantZ = uz; B.wantSpeed = 0.05;
          B.lookX = ux; B.lookZ = uz;
          if (Z.excitedHops > 0 && B.inControl && B.landT > 0.15) {
            Z.excitedHops--;
            B.jump('excited', 2.0 + rng() * 0.5, ux * 0.2, uz * 0.2, { land: 'crouch', prep: 0.05 });
            this.stats.hops++;
          }
          if (Z.reactT <= 0 && Z.excitedHops <= 0) Z.state = 'chase';
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
          // TODOS corren cuando persiguen (a lo Left 4 Dead). Los lentos frenan un
          // poco muy cerca para no pasarse; el corredor NO: si te movés, te pasa de
          // largo y se estrella contra lo que haya atrás
          const near = dist < Z.reach + 0.4 && Z.type !== 'runner' ? 0.55 : 1;
          B.wantSpeed = Z.runSpeed * near * (B.crawling ? 0.45 : 1);

          const playerUp = player.body.state === 'up' && player.body.upright;
          // — desde ARRIBA de algo (escritorio, mesa) y vos cerca y abajo: se tira encima —
          const high = B.groundY > w.groundY + 0.4 && B.groundY - player.body.groundY > 0.4;
          if (high && playerAlive && playerUp && fliers === 0 && dist > 0.9 && dist < 3.2 && Z.los && Z.pounceCool <= 0 && !B.vault && B.inControl) {
            const p = Z.traits.parkour ? 0.6 : Z.type === 'runner' ? 0.35 : Z.type === 'brute' ? 0.03 : 0.15;
            if (rng() < p) { Z.pounceCool = 6 + rng() * 5; fliers++; this._startAttack(Z, 'drop', ux, uz, dist); break; }
            Z.pounceCool = 1.5;
          }
          // — a la carrera y a dos-tres metros, cada tanto y de a uno: se LANZA en plancha —
          if (playerAlive && playerUp && fliers === 0 && dist > 2.4 && dist < 3.6 && Z.los && B.speed > 2.4 && Z.pounceCool <= 0 && B.inControl && !B.vault && !B.crawling) {
            const rate = Z.traits.parkour ? 0.45 : Z.type === 'runner' ? 0.12 : Z.type === 'jogger' ? 0.04 : 0.01;
            if (rng() < rate * dt) { Z.pounceCool = 7 + rng() * 6; fliers++; this._startAttack(Z, 'pounce', ux, uz, dist); break; }
          }
          // — el bruto (y algún corredor) EMBISTE con el hombro desde tres metros —
          if (playerAlive && playerUp && dist > 2.2 && dist < 4.0 && Z.los && B.speed > 1.6 && Z.chargeCool <= 0 && B.inControl && !B.vault && Math.abs(angDelta(B.yaw, Math.atan2(ux, uz))) < 0.4) {
            const rate = Z.type === 'brute' ? 0.6 : Z.type === 'runner' ? 0.08 : 0.02;
            if (rng() < rate * dt) { Z.chargeCool = 5 + rng() * 5; this._startAttack(Z, 'charge', ux, uz, dist); break; }
          }
          // — el que pega saltitos: brinca cada tanto mientras corre —
          if (Z.traits.hopper) {
            Z.hopT -= dt;
            if (Z.hopT <= 0 && B.inControl && B.speed > 1.2 && dist > 2.2 && !B.vault) {
              Z.hopT = 1.2 + rng() * 2.6;
              if (B.hop()) this.stats.hops++;
            }
          }

          if (dist < Z.reach + 0.15 && Z.cool <= 0 && playerAlive) {
            const name = this._pickAttack(Z, dist, player);
            this._startAttack(Z, name, ux, uz, dist);
          }
          break;
        }
        case 'attack': {
          const A = ATTACKS[Z.attack];
          Z.attackT += dt;
          if (A.jump) {
            // ataque volador: pega al aterrizar si cayó cerca; termina cuando el cuerpo vuelve
            if (B.landedJump && !Z.hitDone) {
              Z.hitDone = true; B.landedJump = null;
              if (dist < Z.reach + 0.7 && playerAlive && hooks.onAttack) hooks.onAttack(Z, Z.dmg * A.dmg, ux, uz, Z.attack);
            }
            const flying = B.flight || B.jumpPrep;
            if (Z.attackT > A.dur || (!flying && Z.attackT > 0.35 && (B.inControl || B.state === 'down' || B.state === 'falling' || B.state === 'rising' || B.state === 'move'))) { Z.state = 'chase'; Z.cool = 1.2 + rng() * 0.8; }
            break;
          }
          if (A.move) {
            // embestida: encara, y si llega pega y tira
            B.wantX = ux; B.wantZ = uz;
            if (!Z.hitDone && Z.attackT >= A.hitAt && dist < Z.reach + 0.5 && playerAlive && hooks.onAttack) { Z.hitDone = true; hooks.onAttack(Z, Z.dmg * A.dmg, ux, uz, Z.attack); }
            if (Z.attackT > A.dur || (Z.attackT > 0.3 && B.state !== 'move')) { Z.state = 'chase'; Z.cool = 1.0 + rng() * 0.8; }
            break;
          }
          if (Z.attack !== 'tackle') {
            if (B.stagger > 0.4 || !B.upright || !B.inControl) { Z.state = 'chase'; Z.cool = 1.0; B.wantSpeed = 0; break; }
            // encarar al jugador y embestir un instante; el corredor manotea EN
            // CARRERA y sigue de largo (si te corriste, se lleva puesta la pared)
            B.wantX = ux; B.wantZ = uz;
            B.wantSpeed = Z.attackT < 0.16 ? Z.runSpeed * 0.9 + 0.8 : (Z.type === 'runner' ? Z.runSpeed * 0.8 : 0.15);
          }
          // uno o varios golpes (ráfaga, sacudida)
          const times = A.hits || [A.hitAt];
          if (Z.hitIdx < times.length && Z.attackT >= times[Z.hitIdx]) {
            Z.hitIdx++;
            const reach = Z.attack === 'tackle' ? Z.reach + 0.55 : Z.reach + 0.35;
            if (dist < reach && playerAlive && hooks.onAttack) hooks.onAttack(Z, Z.dmg * A.dmg, ux, uz, Z.attack);
            Z.hitDone = Z.hitIdx >= times.length;
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
