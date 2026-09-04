// ─────────────────────────────────────────────────────────────────────────────
//  player.js — El jugador: un ragdoll activo más, con yaw bloqueado al mouse.
//
//  Se mueve con WASD relativo a la cámara y mira siempre a donde apunta el
//  mouse. Tiene vida que se regenera si lo dejan tranquilo, un arsenal, una
//  linterna y un empujón para sacarse zombis de encima. Cuando muere, muere
//  como todos: los músculos se apagan y se cae.
// ─────────────────────────────────────────────────────────────────────────────

import { Ragdoll, CHEST, HIP, HEAD, HAR, HAL } from '../phys/ragdoll.js';
import { Arsenal } from './weapons.js';
import { clamp, clamp01, angDelta, TAU } from '../core/util.js';

export class Player {
  constructor(world, rng, opt = {}) {
    this.world = world;
    this.rng = rng;
    this.body = new Ragdoll(world, {
      x: opt.x ?? 0, z: opt.z ?? 0, yaw: opt.yaw ?? 0, isPlayer: true,
      armMode: 'aim', lockYaw: true, stiffness: 175, maxMuscleSpeed: 13,
      staggerScale: 0.30, toughness: 60, stride: 0.27, rng, scale: 1.0,
    });
    this.body.player = this;
    this.hp = 100; this.maxHp = 100;
    this.hurtT = 99;
    this.alive = true;
    this.arsenal = new Arsenal();
    this.walkSpeed = 3.6; this.runSpeed = 5.6;
    this.sinceFire = 99;
    this.lastKick = 0.25;
    this.aim = { x: 0, y: 1.2, z: 5 };
    this.aimYaw = 0;
    this.moving = 0;
    this.flashlight = true;
    this.shoveCool = 0;
    this.kills = 0; this.headshots = 0; this.severs = 0; this.shots = 0; this.hitsLanded = 0;
    this.deathT = 0;
    this.damageFlash = 0;
  }

  get x() { return this.body.x; }
  get z() { return this.body.z; }
  get y() { return this.body.y; }

  /**
   * @param input  {mx, mz (−1..1 en ejes de pantalla: mx derecha, mz arriba), run, aimX, aimZ}
   * @param fwd,rgt  vectores XZ de la cámara
   */
  update(dt, input, fwd, rgt) {
    const B = this.body;
    if (this.shoveCool > 0) this.shoveCool -= dt;
    this.hurtT += dt;
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.6);
    if (!this.alive) { this.deathT += dt; B.wantSpeed = 0; return; }

    // regeneración lenta si lo dejan en paz
    if (this.hurtT > 6 && this.hp < this.maxHp) this.hp = Math.min(this.maxHp, this.hp + 5 * dt);

    // movimiento relativo a la cámara
    let vx = rgt.x * input.mx + fwd.x * input.mz;
    let vz = rgt.z * input.mx + fwd.z * input.mz;
    const vl = Math.hypot(vx, vz);
    if (vl > 1e-4) { vx /= vl; vz /= vl; }
    const mag = clamp01(vl);
    this.moving = mag;
    const slow = B.stagger > 0.25 ? 0.35 : 1;
    B.wantCrouch = !!input.crouch && !input.run;
    const crouchF = 1 - 0.5 * B.crouch;
    const speed = (input.run ? this.runSpeed : this.walkSpeed) * slow * crouchF * (B.crawling ? 0.4 : 1);
    B.wantX = vx; B.wantZ = vz; B.wantSpeed = mag * speed;

    // apuntar: el cuerpo mira al mouse
    this.aim.x = input.aimX; this.aim.z = input.aimZ;
    const ax = this.aim.x - this.x, az = this.aim.z - this.z;
    if (Math.hypot(ax, az) > 0.25) this.aimYaw = Math.atan2(ax, az);
    // giro suave pero rápido
    const turn = 14 * dt;
    B.yaw += clamp(angDelta(B.yaw, this.aimYaw), -turn, turn);

    this.arsenal.update(dt);

    // — pose de los brazos: corriendo (Shift, rápido, sin disparar hace medio
    //   segundo) el arma baja; apenas tocás el gatillo vuelve al frente —
    this.sinceFire += dt;
    const sprinting = input.run && mag > 0.5 && B.speed > 2.4 && this.sinceFire > 0.5;
    const target = sprinting ? 0 : 1;
    const rate = sprinting ? 0.02 : 0.0005;    // subir el arma es más rápido que bajarla
    B.aimBlend += (target - B.aimBlend) * (1 - Math.pow(rate, dt));
    const W = this.arsenal.weapon;
    B.reloadT = W.reloading > 0 ? 1 - W.reloading / W.def.reload : 0;
  }

  /** Avisar que disparó (retroceso en las manos, el arma vuelve al frente). */
  onFired(def) {
    this.sinceFire = 0;
    this.lastKick = def.kick;
    this.body.recoil = 1;
  }

  /** Dirección de disparo en XZ (desde la mano hacia el punto apuntado). */
  aimDir(out) {
    const ox = this.body.px(HAR), oz = this.body.pz(HAR);
    let dx = this.aim.x - ox, dz = this.aim.z - oz;
    const l = Math.hypot(dx, dz) || 1;
    // si el mouse está encima del muñeco, disparar hacia donde mira
    if (l < 0.6) { dx = Math.sin(this.body.yaw); dz = Math.cos(this.body.yaw); }
    else { dx /= l; dz /= l; }
    out.x = dx; out.z = dz;
    return out;
  }

  /** Daño recibido. Devuelve true si murió con este golpe. */
  damage(amount, fromX, fromZ) {
    if (!this.alive) return false;
    this.hp -= amount;
    this.hurtT = 0;
    this.damageFlash = Math.min(1, this.damageFlash + 0.45 + amount * 0.012);
    const B = this.body, w = this.world;
    // empujón lejos del atacante, que se sienta el golpe
    let dx = this.x - fromX, dz = this.z - fromZ;
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    w.addImpulse(B.p[CHEST], dx * 55, 14, dz * 55);
    w.addImpulse(B.p[HIP], dx * 30, 6, dz * 30);
    w.addImpulse(B.p[HEAD], dx * 12, 4, dz * 12);
    B.stagger = Math.min(0.6, B.stagger + 0.22);
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      B.kill();
      return true;
    }
    return false;
  }

  /** Empujón: devuelve la lista de ragdolls que empujó. */
  shove(bodies) {
    if (this.shoveCool > 0 || !this.alive) return null;
    this.shoveCool = 0.75;
    const B = this.body, w = this.world;
    const fx = Math.sin(B.yaw), fz = Math.cos(B.yaw);
    const hit = [];
    for (const O of bodies) {
      if (O === B || !O.p || O.isProp || O.dead) continue;
      const dx = O.x - this.x, dz = O.z - this.z;
      const d = Math.hypot(dx, dz);
      if (d > 1.7 || d < 1e-4) continue;
      const dot = (dx * fx + dz * fz) / d;
      if (dot < 0.35) continue;
      const k = 0.7 + (1 - d / 1.9) * 0.9;
      O.knockback(dx, dz, k, 0.4);
      hit.push(O);
    }
    // retroceso propio
    w.addImpulse(B.p[CHEST], -fx * 10, 2, -fz * 10);
    return hit;
  }

  reset(x, z) {
    // el cuerpo viejo lo saca el juego; acá se rearma el estado
    this.hp = this.maxHp; this.alive = true; this.hurtT = 99; this.deathT = 0;
    this.arsenal = new Arsenal();
    this.kills = 0; this.headshots = 0; this.severs = 0; this.shots = 0; this.hitsLanded = 0;
  }
}
