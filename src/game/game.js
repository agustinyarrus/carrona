// ─────────────────────────────────────────────────────────────────────────────
//  game.js — Orquesta todo: mundo, nivel, jugador, horda, armas, oleadas,
//  efectos, sonido y HUD. main.js sólo arranca y hace girar el bucle.
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { PhysWorld } from '../phys/world.js';
import { HEAD, CHEST, HIP, HAR, HAL, BONES, B_SKULL } from '../phys/ragdoll.js';
import { NavGrid } from './nav.js';
import { LevelBuilder, buildOffice } from './level.js';
import { PropSystem } from './props.js';
import { ZombieManager } from './zombie.js';
import { Player } from './player.js';
import { WEAPONS, WEAPON_ORDER, fireHitscan } from './weapons.js';
import { Materials } from '../render/materials.js';
import { BodyRenderer, CorpseBuffer, paintBody, bloodyBone } from '../render/bodies.js';
import { PropRenderer } from '../render/props_render.js';
import { FX } from '../render/fx.js';
import { weaponModel, flashlightModel, beamCone } from '../render/models.js';
import { makeRng, clamp, clamp01, lerp, damp, TAU } from '../core/util.js';

const SKIN_PLAYER = [0.79, 0.45, 0.28];
const _c = new THREE.Color();
function lin(hex) { _c.setHex(hex); return [_c.r, _c.g, _c.b]; }

export class Game {
  constructor(renderer, audio, ui, input) {
    this.R = renderer;
    this.scene = renderer.scene;
    this.audio = audio;
    this.ui = ui;
    this.input = input;
    this.world = new PhysWorld();
    this.rng = makeRng(0xC0FFEE);
    this.materials = new Materials(7);
    this.fx = new FX(this.scene, this.world);
    this.bodies = new BodyRenderer(this.scene, this.materials.mat.body);
    this.corpses = new CorpseBuffer(120);
    this.corpseBoxes = new Array(120).fill(null);
    this.props = new PropSystem(this.world);
    this.propR = new PropRenderer(this.scene, this.materials, this.props);
    this.level = null; this.nav = null; this.zm = null; this.player = null;
    this.state = 'menu';
    this.time = 0;
    this.hits = [];
    this._aim = { x: 0, y: 1.0, z: 0 };
    this._dir = { x: 0, z: 0 };
    this._fwd = { x: 0, z: -1 }; this._rgt = { x: 1, z: 0 };
    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3();
    this.settings = { shake: 1, quality: renderer.qualityName, volume: 0.8, camDist: renderer.camDistTarget };
    this.perf = { phys: 0, frame: 0, fps: 0, _acc: 0, _n: 0 };
    this.stats = { kills: 0, headshots: 0, severs: 0, wave: 0, time: 0, shots: 0, hits: 0 };
    this.best = this._loadBest();

    // modelos del jugador
    this.weaponModels = {};
    for (const k of WEAPON_ORDER) {
      const m = weaponModel(k);
      m.group.visible = false;
      this.scene.add(m.group);
      this.weaponModels[k] = m;
    }
    this.flashModel = flashlightModel();
    this.scene.add(this.flashModel);
    this.beam = beamCone(8.5, 1.9);
    this.scene.add(this.beam);

    // pickups
    this.pickups = [];
    this.pickupGroup = new THREE.Group();
    this.scene.add(this.pickupGroup);

    // oleadas
    this.wave = 0; this.waveT = 0; this.waveLeft = 0; this.waveTotal = 0; this.spawnT = 0;
    this.betweenT = 0; this.waveActive = false;

    this.buildLevel();
    this.startMenu();
  }

  _loadBest() {
    try { return JSON.parse(localStorage.getItem('carrona.best') || '{"wave":0,"kills":0}'); } catch { return { wave: 0, kills: 0 }; }
  }
  _saveBest() {
    try { localStorage.setItem('carrona.best', JSON.stringify(this.best)); } catch { /* nada */ }
  }

  // ═══ nivel ════════════════════════════════════════════════════════════════
  buildLevel() {
    const w = this.world;
    w.reset();
    this.level = new LevelBuilder(this.scene, w, this.materials, makeRng(42));
    buildOffice(this.level);
    this.nav = new NavGrid(w, { cell: 0.4, margin: 0.30, vaultTop: 1.05 });   // escritorios y mesas se trepan
    this.zm = new ZombieManager(w, this.nav, this.rng);
    this.R.applyMood({
      background: 0x06070a, hemiSky: 0x33405f, hemiGround: 0x1a1713, hemiIntensity: 0.95,
      moonColor: 0x92a6cf, moonIntensity: 0.78, bloom: 0.26, exposure: 1.06, vignette: 0.5,
    });
    this._spawnProps();
  }

  _spawnProps() {
    this.props.clear();
    const R = this.rng;
    for (const s of this.level.propSpecs) {
      if (s.kind === 'chair') this.props.addChair(s.x, s.z, s.yaw, s.color);
      else this.props.addBox(s.x, 0.001, s.z, s.w, s.h, s.d, s.yaw, s.mass, s.color);
    }
  }

  _clearBodies() {
    this.zm.clear();
    if (this.player) { this.player.body.dispose(); }
    this.corpses.clear();
    for (const b of this.corpseBoxes) if (b) b.dead = true;
    this.corpseBoxes.fill(null);
    this.world.boxes = this.world.boxes.filter(b => !b.dead);
    this.world._staticDirty = true;
    this.fx.clear();
    this.world.compact();
  }

  startMenu() {
    this.state = 'menu';
    this._clearBodies();
    this._spawnProps();
    this._clearPickups();
    this.player = new Player(this.world, this.rng, { x: this.level.playerStart.x, z: this.level.playerStart.z, yaw: 0 });
    paintBody(this.player.body, this.rng, { skin: SKIN_PLAYER, shirt: lin(0x6c7a8c), pants: lin(0x2b3242), shoes: lin(0x1b1b1f), sleeves: true });
    this.player.alive = false;    // en el menú nadie lo persigue
    // zombis deambulando por todos lados
    for (let i = 0; i < 26; i++) {
      const p = this.nav.randomWalkable(this.rng);
      if (!p) continue;
      const Z = this.zm.spawn(this.rng() < 0.12 ? 'brute' : 'walker', p.x, p.z, this.rng() * TAU, true);
      paintBody(Z.body, this.rng, { zombie: true });
      Z.hp = 1e9;
    }
    this.R.cinematic = true;
    this.R.setFade(0);
    this.R.setDamage(0);
    this._setWeaponVisible(null);
    this.ui.showMenu(this.best);
  }

  newGame() {
    this.state = 'playing';
    this._clearBodies();
    this._spawnProps();
    this._clearPickups();
    const st = this.level.playerStart;
    this.player = new Player(this.world, this.rng, { x: st.x, z: st.z, yaw: 0 });
    paintBody(this.player.body, this.rng, { skin: SKIN_PLAYER, shirt: lin(0x6c7a8c), pants: lin(0x2b3242), shoes: lin(0x1b1b1f), sleeves: true });
    this.stats = { kills: 0, headshots: 0, severs: 0, wave: 0, time: 0, shots: 0, hits: 0 };
    this.wave = 0; this.waveActive = false; this.betweenT = 4.0; this.waveLeft = 0;
    // unos cuantos dormidos por el edificio, lejos del jugador
    for (let i = 0; i < 9; i++) {
      const p = this.nav.randomReachable(this.rng, st.x, st.z, 9, 26) || this.nav.randomWalkable(this.rng);
      if (!p) continue;
      this._spawnZombie(this.rng() < 0.3 ? 'jogger' : 'walker', p.x, p.z, this.rng() * TAU, true);
    }
    this.R.cinematic = false;
    this.R.camYawTarget = -0.42; this.R.camYaw = -0.42;
    this.R.setFade(0);
    this.R.setDamage(0);
    this._setWeaponVisible('pistol');
    this.ui.hideAll();
    this.ui.announce('SOBREVIVÍ', 'la oficina ya no es lo que era');
    this.audio.setIntensity(0.15);
  }

  _spawnZombie(type, x, z, yaw, asleep) {
    const Z = this.zm.spawn(type, x, z, yaw, asleep);
    paintBody(Z.body, this.rng, { zombie: true });
    Z.hp = type === 'brute' ? 300 : type === 'runner' ? 75 : type === 'jogger' ? 95 : 110;
    return Z;
  }

  // ═══ pickups ══════════════════════════════════════════════════════════════
  _clearPickups() {
    for (const p of this.pickups) this.pickupGroup.remove(p.mesh);
    this.pickups.length = 0;
  }
  _pickupMesh(kind, weapon) {
    const g = new THREE.Group();
    const colors = { ammo: 0x6d7a3a, health: 0xe8e2d2, weapon: 0x2a2c33 };
    const glowC = { ammo: 0xffd24a, health: 0xff3b4a, weapon: 0x5aa0ff };
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.28, 0.32), new THREE.MeshStandardMaterial({ color: colors[kind], roughness: 0.8 }));
    base.castShadow = true; base.position.y = 0.14;
    g.add(base);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.06, 0.34), new THREE.MeshBasicMaterial({ color: new THREE.Color(glowC[kind]).multiplyScalar(2.2), toneMapped: false }));
    stripe.position.y = 0.14;
    g.add(stripe);
    if (kind === 'weapon') {
      const m = weaponModel(weapon).group;
      m.position.set(0, 0.42, 0); m.rotation.set(0, Math.PI / 2, -0.15); m.scale.setScalar(1.4);
      g.add(m);
    }
    if (kind === 'health') {
      const cross1 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.06), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3b4a).multiplyScalar(2), toneMapped: false }));
      cross1.position.y = 0.30; g.add(cross1);
      const cross2 = cross1.clone(); cross2.rotation.y = Math.PI / 2; g.add(cross2);
    }
    // sin luz puntual: cada luz cuesta en todos los píxeles; alcanza con el brillo
    return g;
  }
  spawnPickup(kind, weapon, x, z) {
    const mesh = this._pickupMesh(kind, weapon);
    mesh.position.set(x, 0.01, z);
    this.pickupGroup.add(mesh);
    this.pickups.push({ kind, weapon, x, z, mesh, t: this.rng() * 6, life: 90 });
  }
  _dropRewards() {
    const P = this.player;
    const unlock = { 2: 'smg', 3: 'shotgun', 5: 'rifle' };
    const R = this.rng;
    const spot = () => this.nav.randomReachable(R, P.x, P.z, 3, 7) || { x: P.x + 2, z: P.z };
    const nextWave = this.wave + 1;
    if (unlock[nextWave] && !P.arsenal.has(unlock[nextWave])) { const s = spot(); this.spawnPickup('weapon', unlock[nextWave], s.x, s.z); }
    else if (nextWave > 5 && R() < 0.35) { const s = spot(); this.spawnPickup('weapon', WEAPON_ORDER[1 + R.int(0, 2)], s.x, s.z); }
    const s1 = spot(); this.spawnPickup('ammo', null, s1.x, s1.z);
    if (P.hp < 70 || R() < 0.35) { const s2 = spot(); this.spawnPickup('health', null, s2.x, s2.z); }
  }
  _updatePickups(dt) {
    const P = this.player;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      p.t += dt; p.life -= dt;
      p.mesh.position.y = 0.02 + Math.sin(p.t * 2.2) * 0.05;
      p.mesh.rotation.y = p.t * 0.9;
      if (p.life <= 0) { this.pickupGroup.remove(p.mesh); this.pickups.splice(i, 1); continue; }
      if (!P.alive) continue;
      const d = Math.hypot(p.x - P.x, p.z - P.z);
      if (d < 0.85) {
        if (p.kind === 'ammo') { P.arsenal.ammoAll(1); this.ui.toast('MUNICIÓN'); }
        else if (p.kind === 'health') { P.hp = Math.min(P.maxHp, P.hp + 50); this.ui.toast('BOTIQUÍN +50'); }
        else if (p.kind === 'weapon') {
          const fresh = P.arsenal.give(p.weapon);
          this.ui.toast(fresh ? WEAPONS[p.weapon].name : WEAPONS[p.weapon].name + ' · MUNICIÓN');
          if (fresh) this._setWeaponVisible(p.weapon);
        }
        this.audio.pickup(p.kind);
        this.fx.sparks(p.x, 0.3, p.z, 0, 1, 0, 14, 1, 0.9, 0.5);
        this.pickupGroup.remove(p.mesh); this.pickups.splice(i, 1);
      }
    }
  }

  // ═══ oleadas ══════════════════════════════════════════════════════════════
  _updateWaves(dt) {
    if (!this.player.alive) return;
    if (!this.waveActive) {
      this.betweenT -= dt;
      if (this.betweenT <= 0) this._startWave(this.wave + 1);
      return;
    }
    // ── estampida: cada tanto, una ráfaga de corredores por UNA puerta ──
    if (this.wave >= 1) {
      this.stampedeT = (this.stampedeT ?? (14 + this.rng() * 8)) - dt;
      if (this.stampedeT <= 0 && !this.stampede) {
        this.stampedeT = 22 + this.rng() * 12;
        const P = this.player, spawns = this.level.spawns;
        let best = null, bd = -1;
        for (const s of spawns) { const d = Math.hypot(s.x - P.x, s.z - P.z); if (d > bd) { bd = d; best = s; } }
        this.stampede = { door: best, left: 5 + this.wave, t: 0 };
        this.ui.announce('¡ESTAMPIDA!', 'corredores por la puerta ' + (best.x < -19 ? 'oeste' : best.x > 19 ? 'este' : best.z < 0 ? 'norte' : 'sur'));
        this.audio.waveSting(this.wave + 2);
      }
    }
    if (this.stampede) {
      const S = this.stampede;
      S.t -= dt;
      if (S.t <= 0) {
        S.t = 0.18 + this.rng() * 0.2;
        const d = S.door;
        const Z = this._spawnZombie('runner', d.x + (this.rng() - 0.5) * 1.2, d.z + (this.rng() - 0.5) * 1.2, d.yaw, false);
        Z.alert = true;
        if (--S.left <= 0) this.stampede = null;
      }
    }
    // ir soltando zombis por las puertas
    if (this.waveLeft > 0) {
      this.spawnT -= dt;
      const maxAlive = Math.min(12 + this.wave * 3, 44);
      if (this.spawnT <= 0 && this.zm.alive < maxAlive) {
        this.spawnT = Math.max(0.25, 1.3 - this.wave * 0.08) * (0.6 + this.rng() * 0.8);
        // puerta lejos del jugador
        const P = this.player, spawns = this.level.spawns;
        let best = null, bd = -1;
        for (let k = 0; k < 3; k++) {
          const s = spawns[this.rng.int(0, spawns.length - 1)];
          const d = Math.hypot(s.x - P.x, s.z - P.z);
          if (d > bd) { bd = d; best = s; }
        }
        // mezcla: desde la primera oleada hay corredores y trotadores; los
        // brutos aparecen en la 4; con las oleadas todo corre más
        // estilo Left 4 Dead: la mayoría corre. Brutos desde la 4.
        const r = this.rng();
        const type = (this.wave >= 4 && r < 0.06 + this.wave * 0.012) ? 'brute'
          : (r < 0.40 + this.wave * 0.04) ? 'runner'
          : (r < 0.78 + this.wave * 0.03) ? 'jogger' : 'walker';
        const jx = (this.rng() - 0.5) * 0.8, jz = (this.rng() - 0.5) * 0.8;
        this._spawnZombie(type, best.x + jx, best.z + jz, best.yaw, false);
        this.waveLeft--;
      }
    } else if (this.zm.alive === 0) {
      this.waveActive = false;
      this.betweenT = 9;
      this.ui.announce('OLEADA ' + this.wave + ' LIMPIA', 'respirá, que vienen más');
      this._dropRewards();
      this.audio.setIntensity(0.15);
    }
  }
  _startWave(n) {
    this.wave = n; this.stats.wave = n;
    this.waveActive = true;
    this.waveTotal = 6 + n * 4 + Math.floor(n * n * 0.4);
    this.waveLeft = this.waveTotal;
    this.spawnT = 0.5;
    this.ui.announce('OLEADA ' + n, n === 1 ? 'vienen por las puertas' : ['más y más rápido', 'no te quedes quieto', 'la horda crece', 'apuntá a la cabeza'][n % 4]);
    this.audio.waveSting(n);
    this.zm.alertAll(this.player.x, this.player.z, 30);
  }

  // ═══ disparo ══════════════════════════════════════════════════════════════
  _setWeaponVisible(kind) {
    for (const k in this.weaponModels) this.weaponModels[k].group.visible = (k === kind);
    this.flashModel.visible = !!kind;
    this.beam.visible = !!kind && this.player?.flashlight;
  }

  _muzzleWorld(out) {
    const wm = this.weaponModels[this.player.arsenal.current];
    out.copy(wm.muzzle).applyMatrix4(wm.group.matrixWorld);
    return out;
  }

  fire(def) {
    const P = this.player, B = P.body, w = this.world;
    const m = this._muzzleWorld(this._v);
    const dir = P.aimDir(this._dir);
    // El rayo nace en el PECHO del jugador (no en la boca del caño): un zombi
    // pegado al cuerpo queda más cerca que el caño y si no, no le pegás nunca.
    // El fogonazo y la trazadora sí salen del caño.
    const ox = B.px(CHEST) + dir.x * 0.15, oy = B.py(CHEST) + 0.02, oz = B.pz(CHEST) + dir.z * 0.15;
    const ad = Math.hypot(P.aim.x - ox, P.aim.z - oz);
    let dy = (1.05 - oy) / Math.max(4, ad);
    let dx = dir.x, dz = dir.z;
    const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
    const n = fireHitscan(w, ox, oy, oz, dx, dy, dz, def, B, this.rng, this.hits);
    P.shots++;
    this.stats.shots++;
    let hitSomething = false;
    for (let i = 0; i < n; i++) {
      const H = this.hits[i];
      // trazadora: desde el caño (el primer tramo) o desde donde siguió (fusil)
      const fromMuzzle = H.pierced === 0;
      this.fx.tracerLine(fromMuzzle ? m.x : H.ox, fromMuzzle ? m.y : H.oy, fromMuzzle ? m.z : H.oz,
        H.x, H.y, H.z, def.key === 'shotgun' ? 0.01 : 0.016, 1, 0.9, 0.62);
      if (H.kind === 'body') {
        const body = H.body;
        const b = w.bmeta[H.bone];
        const imp = def.impulse * (H.pierced ? 0.6 : 1);
        const res = body.hit(b, H.s, H.dmg, [H.dirx * imp, 0.25 * imp + 0.6, H.dirz * imp]);
        hitSomething = true;
        bloodyBone(body, b, 0.35 + H.dmg * 0.006);
        this.fx.bloodSpray(H.x, H.y, H.z, H.dirx, H.diry, H.dirz, 0.6 + H.dmg / 40);
        this.audio.fleshHit(H.x, H.z, res.zone === 0);
        const Z = body.zombie;
        if (res.severed) {
          this.fx.goreBurst(H.x, H.y, H.z, 1);
          this.audio.gore(H.x, H.z);
          P.severs++; this.stats.severs++;
        }
        if (Z && !body.dead) {
          Z.hp -= res.damage;
          Z.alert = true; if (Z.state === 'idle') Z.state = 'chase';
          if (Z.hp <= 0) {
            body.kill(res.zone === 0 || def.key === 'shotgun');
            // un tiro en la cabeza al morir la vuela un poco
            if (res.zone === 0) { P.headshots++; this.stats.headshots++; this.fx.bloodSpray(H.x, H.y, H.z, H.dirx, 0.4, H.dirz, 1.4); }
          }
        }
      } else if (H.kind === 'static') {
        if (H.obj && H.obj.isCorpse) {
          // un cadáver: sangre, no polvo
          this.fx.bloodSpray(H.x, H.y + 0.05, H.z, H.dirx, 0.5, H.dirz, 0.5);
          this.audio.fleshHit(H.x, H.z, false);
        } else {
          this.fx.impact(H.x, H.y, H.z, H.nx, H.ny, H.nz);
          this.audio.wallHit(H.x, H.z);
          this.props.wakeNear(H.x, H.z, 0.25, H.dirx * def.impulse * 3, def.impulse, H.dirz * def.impulse * 3);
        }
      }
    }
    if (hitSomething) { P.hitsLanded++; this.stats.hits++; }
    // fogonazo, casquillo, retroceso
    this.fx.muzzle(ox, oy, oz, dx, dy, dz, def.key === 'shotgun' ? 1.6 : 1);
    this.R.muzzleFlash(ox, oy, oz, def.key === 'shotgun' ? 1.5 : 1);
    const wm = this.weaponModels[def.key];
    const ej = this._v2.copy(wm.eject).applyMatrix4(wm.group.matrixWorld);
    this.fx.shell(ej.x, ej.y, ej.z, -dz * 0.6 + dx * 0.4, dx * 0.6 + dz * 0.4, def.key === 'shotgun' ? 1.6 : 1);
    this.R.addShake(def.shake * this.settings.shake);
    this.R.addKick(-dx * def.kick * 0.25, 0, -dz * def.kick * 0.25);
    this.R.fovPunch = Math.max(this.R.fovPunch, def.kick * 1.5);
    // retroceso en el cuerpo y en la pose de las manos
    w.addImpulse(B.p[HAR], -dx * 6 * def.kick, 2 * def.kick, -dz * 6 * def.kick);
    w.addImpulse(B.p[CHEST], -dx * 8 * def.kick, 0, -dz * 8 * def.kick);
    P.onFired(def);
    this.audio.shot(def.key);
    this.zm.alertAll(P.x, P.z, 26);
  }

  _shove() {
    const P = this.player;
    const hit = P.shove(this.world.bodies);
    if (!hit) return;
    this.audio.shove();
    this.R.addShake(0.2 * this.settings.shake);
    const fx = Math.sin(P.body.yaw), fz = Math.cos(P.body.yaw);
    this.fx.sparks(P.x + fx * 0.8, 1.1, P.z + fz * 0.8, fx, 0.2, fz, 6, 0.9, 0.9, 0.9);
    this.props.wakeNear(P.x + fx * 0.9, P.z + fz * 0.9, 0.7, fx * 60, 20, fz * 60);
    for (const O of hit) this.audio.thud(O.x, O.z, 0.8);
  }

  // ═══ ganchos de la horda ══════════════════════════════════════════════════
  _hooks() {
    if (this._hk) return this._hk;
    this._hk = {
      onAttack: (Z, dmg, ux, uz) => {
        const P = this.player;
        const died = P.damage(dmg, Z.x, Z.z);
        // el bruto tumba: física pura, se cae, y hay que levantarse
        if (Z.type === 'brute' && !died) { P.body.knockback(ux, uz, 1.6, 0.4); this.R.addShake(0.4 * this.settings.shake); }
        this.audio.bite(Z.x, Z.z);
        this.audio.hurt();
        this.R.addShake(0.45 * this.settings.shake);
        const cy = P.body.py(CHEST);
        this.fx.bloodSpray(P.x, cy, P.z, ux, 0.3, uz, 0.7);
        bloodyBone(P.body, 2, 0.25);
        if (died) this._playerDied();
      },
      onDeath: (Z) => {
        this.player.kills++; this.stats.kills++;
      },
      onCorpse: (Z) => { this._freezeCorpse(Z.body); },
      onMoan: (Z, dist) => { this.audio.groan(Z.x, Z.z, 0.9 + this.rng() * 0.3, Z.type); },
    };
    return this._hk;
  }

  /**
   * Un cadáver congelado deja de ser física, pero sigue estorbando: queda como
   * una caja baja estática con la forma del cuerpo. La horda tropieza con
   * ellos y las balas les pegan (con sangre). Si el buffer de cadáveres
   * pisa un slot viejo, su caja se va.
   */
  _freezeCorpse(body) {
    const k = this.corpses.add(body);
    const w = this.world;
    const old = this.corpseBoxes[k];
    if (old) { old.dead = true; }
    // eje principal del cuerpo en XZ (cadera → cabeza) y extensión de todas las partículas
    let ax = body.px(HEAD) - body.px(HIP), az = body.pz(HEAD) - body.pz(HIP);
    let al = Math.hypot(ax, az);
    if (al < 0.3) { ax = body.fx; az = body.fz; al = Math.hypot(ax, az) || 1; }
    ax /= al; az /= al;
    let cx = 0, cz = 0, n = 0;
    for (let i = 0; i < 16; i++) { if (!(w.pf[body.p[i]] & 1)) continue; cx += body.px(i); cz += body.pz(i); n++; }
    if (!n) return;
    cx /= n; cz /= n;
    let minA = 9, maxA = -9, minB = 9, maxB = -9;
    for (let i = 0; i < 16; i++) {
      if (!(w.pf[body.p[i]] & 1)) continue;
      const dx = body.px(i) - cx, dz = body.pz(i) - cz;
      const a = dx * ax + dz * az, b = -dx * az + dz * ax;
      minA = Math.min(minA, a); maxA = Math.max(maxA, a); minB = Math.min(minB, b); maxB = Math.max(maxB, b);
    }
    const hx = Math.max(0.3, (maxA - minA) / 2 + 0.1), hz = Math.max(0.2, Math.min(0.42, (maxB - minB) / 2 + 0.08));
    const mx = cx + ax * (minA + maxA) / 2 - az * (minB + maxB) / 2;
    const mz = cz + az * (minA + maxA) / 2 + ax * (minB + maxB) / 2;
    const yaw = Math.atan2(-az, ax);
    const idx = w.addBox(mx, 0.11, mz, hx, 0.11, hz, yaw);
    const box = w.boxes[idx];
    box.isCorpse = true;
    this.corpseBoxes[k] = box;
    if (old) { w.boxes = w.boxes.filter(b => !b.dead); w._staticDirty = true; }
  }

  _playerDied() {
    this.state = 'dead';
    this.audio.death();
    this.audio.setIntensity(0);
    this.best.wave = Math.max(this.best.wave, this.stats.wave);
    this.best.kills = Math.max(this.best.kills, this.stats.kills);
    this._saveBest();
    this._setWeaponVisible(null);
    setTimeout(() => { if (this.state === 'dead') this.ui.showDeath(this.stats, this.best); }, 1800);
  }

  // ═══ bucle ════════════════════════════════════════════════════════════════
  update(dt) {
    const I = this.input, P = this.player, R = this.R, w = this.world;
    this.time += dt;
    const t0 = performance.now();

    // ── entrada global ──
    if (I.pressed('F3')) this.ui.togglePerf();
    if (this.state === 'menu') {
      if (I.pressed('Mouse0') || I.pressed('Enter') || I.pressed('Space')) { this.audio.init(); this.audio.resume(); this.newGame(); }
    } else if (this.state === 'dead') {
      if (P.deathT > 2.2 && (I.pressed('Mouse0') || I.pressed('Enter') || I.pressed('Space'))) this.newGame();
      if (I.pressed('Escape')) this.startMenu();
    } else if (this.state === 'paused') {
      if (I.pressed('Escape') || I.pressed('KeyP')) { this.state = 'playing'; this.ui.hidePause(); this.audio.resume(); }
    } else if (this.state === 'playing') {
      if (I.pressed('Escape') || I.pressed('KeyP')) { this.state = 'paused'; this.ui.showPause(this.settings); }
    }
    if (this.state === 'paused') { this._render(0); I.endFrame(); return; }

    // ── cámara: giro y zoom (el zoom se recuerda) ──
    if (I.pressed('KeyQ')) R.rotateCamera(Math.PI / 4);
    if (I.pressed('KeyE')) R.rotateCamera(-Math.PI / 4);
    if (I.wheel) { R.zoomCamera(I.wheel * 1.6); this.settings.camDist = R.camDistTarget; try { localStorage.setItem('carrona.settings', JSON.stringify(this.settings)); } catch { /* nada */ } }

    // ── jugador ──
    const playing = this.state === 'playing';
    R.screenToGround(I.nx, I.ny, 1.0, this._aim);
    if (playing) {
      R.forwardXZ(this._fwd); R.rightXZ(this._rgt);
      const inp = {
        mx: I.axis('KeyA', 'KeyD') + I.axis('ArrowLeft', 'ArrowRight'),
        mz: I.axis('KeyS', 'KeyW') + I.axis('ArrowDown', 'ArrowUp'),
        run: I.held('ShiftLeft') || I.held('ShiftRight'),
        crouch: I.held('ControlLeft') || I.held('ControlRight') || I.held('KeyC'),
        aimX: this._aim.x, aimZ: this._aim.z,
      };
      inp.mx = clamp(inp.mx, -1, 1); inp.mz = clamp(inp.mz, -1, 1);
      P.update(dt, inp, this._fwd, this._rgt);

      if (P.alive) {
        const A = P.arsenal;
        // tirado en el piso o sacudido no se dispara ni se empuja
        const canAct = P.body.inControl && P.body.upright;
        // armas
        for (let k = 0; k < 4; k++) if (I.pressed('Digit' + (k + 1)) && A.switchTo(WEAPON_ORDER[k])) { this._setWeaponVisible(A.current); this.audio.switchWeapon(); }
        if (I.pressed('KeyR') && canAct && A.startReload()) this.audio.reload(A.current);
        if (I.pressed('KeyF')) { P.flashlight = !P.flashlight; this.beam.visible = P.flashlight; }
        // espacio: trepar lo que tenga adelante (escritorio, mesa); si no hay nada, empujón
        if (I.pressed('Space') && canAct) {
          const d = P.aimDir(this._dir);
          const mv = Math.hypot(P.body.wantX, P.body.wantZ) > 0.1 ? { x: P.body.wantX, z: P.body.wantZ } : d;
          if (!P.body.tryVault(mv.x, mv.z)) this._shove();
        }
        const shot = A.tryFire(I.fire && canAct);
        if (shot === 'empty') { this.audio.empty(); if (A.weapon.canReload) { A.startReload(); this.audio.reload(A.current); } }
        else if (shot) this.fire(shot);
        // recarga automática al vaciar
        if (A.weapon.mag === 0 && A.weapon.canReload && !I.fire) { A.startReload(); this.audio.reload(A.current); }
      }
      this._updatePickups(dt);
      this._updateWaves(dt);
      this.stats.time += dt;
    } else if (this.state === 'dead') {
      P.update(dt, { mx: 0, mz: 0, run: false, aimX: P.aim.x, aimZ: P.aim.z }, this._fwd, this._rgt);
    }

    // ── horda ──
    this.zm.update(dt, P, this._hooks());

    // ── física ──
    for (let i = 0; i < w.bodies.length; i++) { const b = w.bodies[i]; if (b.update) b.update(dt); }
    this.props.update(dt);
    w.step(dt);
    this.perf.phys = performance.now() - t0;

    // ── sonido ──
    this.audio.listener(P.x, P.z);
    if (playing) {
      let near = 0;
      for (const Z of this.zm.zombies) if (!Z.dead && Math.hypot(Z.x - P.x, Z.z - P.z) < 9) near++;
      this.audio.setIntensity(clamp01(0.15 + near * 0.12 + (this.waveActive ? 0.15 : 0)));
    }

    // ── efectos, HUD ──
    this.fx.update(dt);
    this.level.update(dt);
    if (playing) this._hud();
    this._render(dt);
    this.perf.frame = performance.now() - t0;
    this.perf._acc += dt; this.perf._n++;
    if (this.perf._acc >= 0.5) {
      this.perf.fps = this.perf._n / this.perf._acc; this.perf._acc = 0; this.perf._n = 0;
      // calidad adaptativa: si no llega a 45 fps sostenidos, baja un escalón
      // (nunca sube sola; si el usuario eligió a mano, no se toca)
      if (this.settings.autoQuality !== false && playing) {
        this.perf.lowT = this.perf.fps < 45 ? (this.perf.lowT || 0) + 0.5 : 0;
        if (this.perf.lowT >= 3 && this.R.qualityName !== 'bajo') {
          const next = this.R.qualityName === 'alto' ? 'medio' : 'bajo';
          this.R.setQuality(next); this.settings.quality = next; this.perf.lowT = 0;
          this.ui.toast('CALIDAD → ' + next.toUpperCase());
        }
      }
    }
    if (this.ui.perfVisible) this.ui.perf(this._perfText());
    I.endFrame();
  }

  _perfText() {
    const w = this.world, s = w.stats;
    return `${this.perf.fps.toFixed(0)} fps · frame ${this.perf.frame.toFixed(1)} ms · física ${this.perf.phys.toFixed(1)} ms\n` +
      `${s.particles} partículas · ${s.constraints} restricciones · ${s.bones} huesos · ${s.pairs} pares\n` +
      `zombis ${this.zm.alive} vivos / ${this.zm.zombies.length} · cadáveres ${this.corpses.n} · props despiertos ${this.props.awakeCount}\n` +
      `huesos dibujados ${this.bodies.drawnBones} · calidad ${this.R.qualityName}`;
  }

  _hud() {
    const P = this.player, A = P.arsenal, W = A.weapon;
    this.ui.hud({
      hp: P.hp, maxHp: P.maxHp, wave: this.wave, kills: this.stats.kills,
      weapon: W.def.name, mag: W.mag, reserve: W.reserve, reloading: W.reloading > 0 ? 1 - W.reloading / W.def.reload : 0,
      left: this.waveActive ? this.waveLeft + this.zm.alive : 0, between: this.waveActive ? 0 : this.betweenT,
      owned: WEAPON_ORDER.filter(k => A.has(k)), current: A.current, flashlight: P.flashlight,
    });
    this.ui.crosshair(this.input.mouseX, this.input.mouseY, W.def.spread, P.moving);
  }

  _render(dt) {
    const P = this.player, R = this.R, w = this.world;
    // daño en pantalla
    const dmg = this.state === 'playing' ? clamp01((1 - P.hp / P.maxHp) * 0.7 + P.damageFlash * 0.6) : (this.state === 'dead' ? clamp01(0.5 + P.deathT * 0.3) : 0);
    R.setDamage(dmg);
    if (this.state === 'dead') R.setFade(clamp01((P.deathT - 1.0) * 0.35));

    // arma y linterna en las manos
    if (P && this.state !== 'menu') {
      const B = P.body;
      const wm = this.weaponModels[P.arsenal.current];
      const hx = B.px(HAR), hy = B.py(HAR), hz = B.pz(HAR);
      const yaw = B.yaw;
      if (wm && wm.group.visible) {
        const dropped = !P.alive;
        // orientación del arma: apunta a donde mira el cuerpo; corriendo baja
        // (cruzada al pecho); el retroceso levanta la boca del caño; un bob y
        // un balanceo leves siguen el paso; en recarga se inclina un poco
        const ab = B.aimBlend, rc = B.recoil;
        const pitch = -0.62 * (1 - ab) - rc * 0.55 * P.lastKick + Math.cos(B.phase * 2) * 0.035 * B.gait * (1 - ab) * P.moving
          - Math.sin(Math.PI * clamp01((B.reloadT - 0.1) / 0.62)) * 0.25;
        const roll = -0.35 * (1 - ab) + Math.sin(B.phase) * 0.03 * P.moving;
        wm.group.position.set(hx, hy, hz);
        if (dropped) wm.group.rotation.set(1.2, yaw, 0.6);
        else wm.group.rotation.set(pitch, yaw, roll, 'YXZ');
        wm.group.updateMatrixWorld(true);
        const m = this._muzzleWorld(this._v);
        const dir = this._v2.set(0, 0, 1).applyQuaternion(wm.group.quaternion);
        // la linterna va debajo del caño y sigue su orientación
        this.flashModel.position.set(m.x - dir.x * 0.16, m.y - 0.045 - dir.y * 0.16, m.z - dir.z * 0.16);
        this.flashModel.quaternion.copy(wm.group.quaternion);
        this.beam.position.set(m.x, m.y - 0.04, m.z);
        this.beam.quaternion.copy(wm.group.quaternion);
        this.beam.visible = P.flashlight && P.alive;
        const ty = Math.max(0.1, m.y + dir.y * 10);
        R.setFlashlight(m.x, m.y + 0.05, m.z, m.x + dir.x * 10, ty, m.z + dir.z * 10, P.flashlight && P.alive ? 260 : 0);
      } else {
        R.setFlashlight(0, 0, 0, 0, 0, 0, 0);
        this.beam.visible = false;
      }
    } else {
      R.setFlashlight(0, 0, 0, 0, 0, 0, 0);
      this.beam.visible = false;
    }

    this.bodies.update(w, this.corpses);
    this.propR.update();
    const ax = this.state === 'menu' ? P.x : this._aim.x, az = this.state === 'menu' ? P.z : this._aim.z;
    R.updateCamera(dt, P.x, 0.9, P.z, ax, az);
    R.render(dt);
  }

  // ═══ ajustes ══════════════════════════════════════════════════════════════
  applySettings(s) {
    Object.assign(this.settings, s);
    if (s.quality && s.quality !== this.R.qualityName) { this.R.setQuality(s.quality); this.settings.autoQuality = false; }
    if (s.volume !== undefined) this.audio.setVolume(s.volume);
    try { localStorage.setItem('carrona.settings', JSON.stringify(this.settings)); } catch { /* nada */ }
  }
}
