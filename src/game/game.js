// ─────────────────────────────────────────────────────────────────────────────
//  game.js — Orquesta todo: mundo, mapa, jugador, horda, armas, oleadas,
//  misiones, progreso, efectos, sonido y HUD. main.js sólo arranca, arma las
//  pantallas y hace girar el bucle.
//
//  Estados: 'menu' (cámara cinemática sobre el mapa, zombis paseando),
//  'playing', 'paused' (nada se simula, el audio se congela), 'dead' y 'won'.
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { PhysWorld } from '../phys/world.js';
import { HEAD, CHEST, HIP, HAR } from '../phys/ragdoll.js';
import { NavGrid } from './nav.js';
import { LevelBuilder } from './level.js';
import { getMap, MAPS, MAP_ORDER } from './maps.js';
import { PropSystem } from './props.js';
import { ZombieManager, ATTACKS } from './zombie.js';
import { Player } from './player.js';
import { WEAPONS, WEAPON_ORDER, fireHitscan } from './weapons.js';
import { CAMPAIGN, missionById, infiniteMission, MissionManager, ITEM_STYLE } from './mission.js';
import { loadProgress, saveProgress, recordAttempt, recordResult, recordInfinite, isMissionUnlocked, isInfiniteUnlocked, nextMission, missionsDone } from './progress.js';
import { OPTIONS, optionByKey, defaultSettings, normalizeSettings, saveSettings, rebind, DEFAULT_KEYS } from './options.js';
import { t, tx, setLang, getLang } from '../core/i18n.js';
import { Materials } from '../render/materials.js';
import { BodyRenderer, CorpseBuffer, paintBody, bloodyBone } from '../render/bodies.js';
import { PropRenderer } from '../render/props_render.js';
import { FX } from '../render/fx.js';
import { weaponModel, flashlightModel, beamCone } from '../render/models.js';
import { makeRng, clamp, clamp01, TAU } from '../core/util.js';

const SKIN_PLAYER = [0.79, 0.45, 0.28];
const _c = new THREE.Color();
function lin(hex) { _c.setHex(hex); return [_c.r, _c.g, _c.b]; }

export class Game {
  /**
   * @param settings ajustes ya normalizados (ver options.js); el juego los aplica y los guarda
   */
  constructor(renderer, audio, ui, input, settings = null) {
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
    this.map = null; this.mapId = null;
    this.state = 'menu';
    this.time = 0;
    this.hits = [];
    this._aim = { x: 0, y: 1.0, z: 0 };
    this._dir = { x: 0, z: 0 };
    this._fwd = { x: 0, z: -1 }; this._rgt = { x: 1, z: 0 };
    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3();
    this._scr = { x: 0, y: 0, visible: false };
    this.settings = settings || defaultSettings();
    this.perf = { phys: 0, frame: 0, fps: 0, _acc: 0, _n: 0 };
    this.stats = { kills: 0, headshots: 0, severs: 0, wave: 0, time: 0, shots: 0, hits: 0 };
    this.best = this._loadBest();
    this.progress = loadProgress();
    this.missionDef = null; this.mission = null;
    this._timers = [];

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

    // pickups y el faro del objetivo
    this.pickups = [];
    this.pickupGroup = new THREE.Group();
    this.scene.add(this.pickupGroup);
    this.beacon = this._beaconMesh();
    this.scene.add(this.beacon);

    // oleadas
    this.wave = 0; this.waveT = 0; this.waveLeft = 0; this.waveTotal = 0; this.spawnT = 0;
    this.betweenT = 0; this.waveActive = false; this.wavesCleared = 0;
    this.stampede = null; this.stampedeT = null;
    this.wcfg = null;

    this.buildLevel(this._startMapId());
    // el menú lo abre main.js (`startMenu()`) cuando la UI ya conoce al juego
  }

  _loadBest() {
    try { return JSON.parse(localStorage.getItem('carrona.best') || '{"wave":0,"kills":0}'); } catch { return { wave: 0, kills: 0 }; }
  }
  _saveBest() {
    try { localStorage.setItem('carrona.best', JSON.stringify(this.best)); } catch { /* nada */ }
  }
  _saveProgress() { saveProgress(this.progress); }

  /** El menú arranca sobre el mapa de la última misión jugada. */
  _startMapId() {
    const last = this.progress.last;
    if (!last) return 'office';
    if (last.startsWith('inf_')) return MAPS[last.slice(4)] ? last.slice(4) : 'office';
    const m = missionById(last);
    return m && MAPS[m.mapId] ? m.mapId : 'office';
  }

  /** Algo para dentro de un rato (anuncios encadenados); se descarta al cambiar de partida. */
  later(fn, sec) { this._timers.push({ t: sec, fn }); }
  _tickTimers(dt) {
    for (let i = this._timers.length - 1; i >= 0; i--) {
      const T = this._timers[i];
      T.t -= dt;
      if (T.t <= 0) { this._timers.splice(i, 1); T.fn(); }
    }
  }

  // ═══ nivel ════════════════════════════════════════════════════════════════
  /** Arma un mapa del registro. Tira abajo el anterior: mallas, luces, estáticos, cuerpos, grilla. */
  buildLevel(mapId) {
    const map = getMap(mapId);
    const w = this.world;
    if (this.level) {
      this._clearBodies();
      this._clearPickups();
      this.props.clear();
      this.level.dispose();
    }
    w.reset();
    this.level = new LevelBuilder(this.scene, w, this.materials, makeRng(map.seed));
    map.build(this.level);
    this.nav = new NavGrid(w, map.nav);
    this.zm = new ZombieManager(w, this.nav, this.rng);   // la horda captura la grilla: se recrea con ella
    this.R.applyMood(map.mood);
    this.map = map; this.mapId = map.id;
    this._spawnProps();
  }

  _spawnProps() {
    this.props.clear();
    for (const s of this.level.propSpecs) {
      if (s.kind === 'chair') this.props.addChair(s.x, s.z, s.yaw, s.color);
      else this.props.addBox(s.x, 0.001, s.z, s.w, s.h, s.d, s.yaw, s.mass, s.color);
    }
  }

  _clearBodies() {
    if (this.zm) this.zm.clear();
    if (this.player && this.player.body.alive) this.player.body.dispose();
    this.corpses.clear();
    for (const b of this.corpseBoxes) if (b) b.dead = true;
    this.corpseBoxes.fill(null);
    this.world.boxes = this.world.boxes.filter(b => !b.dead);
    this.world._staticDirty = true;
    this.fx.clear();
    this.world.compact();
  }

  _makePlayer() {
    const st = this.level.playerStart;
    this.player = new Player(this.world, this.rng, { x: st.x, z: st.z, yaw: 0 });
    paintBody(this.player.body, this.rng, { skin: SKIN_PLAYER, shirt: lin(0x6c7a8c), pants: lin(0x2b3242), shoes: lin(0x1b1b1f), sleeves: true });
    return this.player;
  }

  startMenu() {
    this.state = 'menu';
    this._timers.length = 0;
    this.mission = null; this.missionDef = null;
    this.stampede = null; this.stampedeT = null; this.waveActive = false; this.wave = 0;
    this._clearBodies();
    this._spawnProps();
    this._clearPickups();
    this._makePlayer();
    this.player.alive = false;    // en el menú nadie lo persigue
    // zombis deambulando por todos lados
    const n = this.map.menuZombies ?? 24;
    for (let i = 0; i < n; i++) {
      const p = this.nav.randomWalkable(this.rng);
      if (!p) continue;
      const Z = this.zm.spawn(this.rng() < 0.12 ? 'brute' : 'walker', p.x, p.z, this.rng() * TAU, true, this._restPose());
      paintBody(Z.body, this.rng, { zombie: true });
      Z.hp = 1e9;
    }
    this.R.cinematic = true;
    this.R.setFade(0);
    this.R.setDamage(0);
    this.beacon.visible = false;
    this._setWeaponVisible(null);
    this.audio.setIntensity(0);
    this.ui.showMenu(this.menuInfo());
  }

  /** Lo que muestra el menú principal. */
  menuInfo() {
    const nxt = nextMission(this.progress, CAMPAIGN);
    const done = missionsDone(this.progress, CAMPAIGN);
    return {
      best: this.best, map: this.map, done, total: CAMPAIGN.length,
      next: nxt && done < CAMPAIGN.length ? { id: nxt.id, name: tx(nxt.name) } : null,
    };
  }

  /** Las misiones de la campaña con su estado, para la pantalla de campaña. */
  campaignEntries() {
    return CAMPAIGN.map(m => {
      const p = this.progress.missions[m.id];
      const unlocked = isMissionUnlocked(this.progress, CAMPAIGN, m.id);
      return {
        id: m.id, name: tx(m.name), brief: tx(m.brief), map: getMap(m.mapId).name, mapId: m.mapId,
        unlocked, done: !!(p && p.done), bestTime: p ? p.bestTime : null, attempts: p ? p.attempts : 0,
      };
    });
  }

  /** Los mapas del modo infinito con sus récords. */
  infiniteEntries() {
    return MAP_ORDER.map(id => {
      const m = MAPS[id], r = this.progress.infinite[id];
      return { mapId: id, name: m.name, sub: m.sub, unlocked: isInfiniteUnlocked(this.progress, CAMPAIGN, id), best: r && r.runs ? r : null };
    });
  }

  // ═══ partidas ═════════════════════════════════════════════════════════════
  startMission(id) {
    const def = missionById(id);
    if (!def || !isMissionUnlocked(this.progress, CAMPAIGN, id)) return false;
    this.newGame(def);
    return true;
  }
  startInfinite(mapId) {
    if (!MAPS[mapId] || !isInfiniteUnlocked(this.progress, CAMPAIGN, mapId)) return false;
    this.newGame(infiniteMission(mapId));
    return true;
  }
  /** Reintentar lo mismo (muerte, victoria, pausa). */
  retry() { if (this.missionDef) this.newGame(this.missionDef); else this.startMenu(); }
  /** La misión que sigue en la campaña (o el menú si no queda ninguna). */
  nextMission() {
    const i = this.missionDef ? CAMPAIGN.findIndex(m => m.id === this.missionDef.id) : -1;
    const nxt = i >= 0 && i + 1 < CAMPAIGN.length ? CAMPAIGN[i + 1] : null;
    if (nxt && isMissionUnlocked(this.progress, CAMPAIGN, nxt.id)) this.newGame(nxt);
    else this.startMenu();
  }

  newGame(def) {
    this.audio.init(); this.audio.resume();
    if (def.mapId !== this.mapId) this.buildLevel(def.mapId);
    this.missionDef = def;
    this.state = 'playing';
    this._timers.length = 0;
    this._clearBodies();
    this._spawnProps();
    this._clearPickups();
    const P = this._makePlayer();
    const st = this.level.playerStart;
    // arsenal inicial de la misión
    const weapons = (def.start && def.start.weapons) || ['pistol'];
    for (const k of weapons) if (k !== 'pistol') P.arsenal.give(k);
    P.arsenal.switchTo(weapons[0]); P.arsenal.switchT = 0;
    this.stats = { kills: 0, headshots: 0, severs: 0, wave: 0, time: 0, shots: 0, hits: 0 };
    this.wcfg = def.waves || null;
    this.wave = 0; this.waveActive = false; this.waveLeft = 0; this.wavesCleared = 0;
    this.betweenT = this.wcfg ? this.wcfg.firstDelay : 0;
    this.stampede = null; this.stampedeT = null;       // una estampida a medias no pasa a la partida siguiente
    // unos cuantos dormidos por el edificio, lejos del jugador
    const sleepers = def.sleepers ?? 9;
    for (let i = 0; i < sleepers; i++) {
      const p = this.nav.randomReachable(this.rng, st.x, st.z, 9, 26) || this.nav.randomWalkable(this.rng);
      if (!p) continue;
      this._spawnZombie(this.rng() < 0.3 ? 'jogger' : 'walker', p.x, p.z, this.rng() * TAU, true);
    }
    this.R.cinematic = false;
    this.R.camYawTarget = -0.42; this.R.camYaw = -0.42;
    this.R.camDist = this.R.camDistTarget;
    this.R.setFade(0);
    this.R.setDamage(0);
    this._setWeaponVisible(P.arsenal.current);
    this.ui.hideAll();
    // progreso: cuenta el intento
    if (!def.infinite) { recordAttempt(this.progress, def.id); this._saveProgress(); }
    else { this.progress.last = def.id; this._saveProgress(); }
    // la misión
    this.mission = new MissionManager(def, this._missionHost());
    if (def.infinite) this.ui.announce(t('ann.start'), getLang() === 'es' && this.map.texts ? this.map.texts.start : t('ann.startSub'));
    else this.ui.announce(tx(def.name), tx(def.brief));
    this.mission.start();
    this.audio.setIntensity(0.15);
  }

  /** Lo que la misión necesita del juego. */
  _missionHost() {
    return {
      points: this.level.points || {},
      kills: () => this.stats.kills,
      wavesCleared: () => this.wavesCleared,
      waveActive: () => this.waveActive,
      playerPos: () => this.player,
      randomSpot: () => this.nav.randomReachable(this.rng, this.player.x, this.player.z, 8, 30) || this.nav.randomWalkable(this.rng),
      spawnObjective: (x, z, item) => this.spawnPickup('objective', item, x, z),
      announce: (big, small) => { this.ui.announce(big, small); this.audio.objectiveSting(); },
      toast: (txt) => this.ui.toast(txt),
      later: (fn, sec) => this.later(fn, sec),
      onWon: () => this._missionWon(),
    };
  }

  /** Pose de descanso para un zombi dormido (o null: deambula). */
  _restPose() {
    const r = this.rng();
    return r < 0.45 ? null : r < 0.6 ? 'sit' : r < 0.7 ? 'kneel' : r < 0.82 ? 'supine' : r < 0.92 ? 'prone' : 'side';
  }

  /** Dormidos por el lugar, lejos del jugador: se despiertan cuando los ves o hacés ruido. */
  _spawnSleepers(n) {
    const P = this.player;
    for (let k = 0, tries = 0; k < n && tries < 60; tries++) {
      const p = this.nav.randomWalkable(this.rng);
      if (!p || Math.hypot(p.x - P.x, p.z - P.z) < 11) continue;
      const r = this.rng();
      const type = (this.wave >= 4 && r < 0.1) ? 'brute' : r < 0.45 ? 'runner' : r < 0.75 ? 'jogger' : 'walker';
      this._spawnZombie(type, p.x, p.z, this.rng() * TAU, true, this._restPose() || 'sit');
      k++;
    }
  }

  _spawnZombie(type, x, z, yaw, asleep, rest = null, traits = null) {
    const Z = this.zm.spawn(type, x, z, yaw, asleep, rest, traits);
    paintBody(Z.body, this.rng, { zombie: true });
    return Z;
  }

  // ═══ pickups ══════════════════════════════════════════════════════════════
  _clearPickups() {
    for (const p of this.pickups) this.pickupGroup.remove(p.mesh);
    this.pickups.length = 0;
  }
  _pickupMesh(kind, weapon) {
    const g = new THREE.Group();
    const colors = { ammo: 0x6d7a3a, health: 0xe8e2d2, weapon: 0x2a2c33, objective: 0x3a3630 };
    const glowC = { ammo: 0xffd24a, health: 0xff3b4a, weapon: 0x5aa0ff, objective: (ITEM_STYLE[weapon] || {}).color || 0xffd24a };
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
    if (kind === 'objective') {
      // una cosa de misión: un bloque más alto con una columna de luz finita que se ve de lejos
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.12, 2.4, 6, 1, true),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(glowC.objective).multiplyScalar(1.6), toneMapped: false, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
      col.position.y = 1.4; g.add(col);
    }
    // sin luz puntual: cada luz cuesta en todos los píxeles; alcanza con el brillo
    return g;
  }
  spawnPickup(kind, weapon, x, z) {
    const mesh = this._pickupMesh(kind, weapon);
    mesh.position.set(x, 0.01, z);
    this.pickupGroup.add(mesh);
    this.pickups.push({ kind, weapon, x, z, mesh, t: this.rng() * 6, life: kind === 'objective' ? Infinity : 90 });
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
        if (p.kind === 'ammo') { P.arsenal.ammoAll(1); this.ui.toast(t('toast.ammo')); }
        else if (p.kind === 'health') { P.hp = Math.min(P.maxHp, P.hp + 50); this.ui.toast(t('toast.health')); }
        else if (p.kind === 'weapon') {
          const fresh = P.arsenal.give(p.weapon);
          this.ui.toast(fresh ? t('weapon.' + p.weapon) : t('toast.weaponAmmo', { weapon: t('weapon.' + p.weapon) }));
          if (fresh) this._setWeaponVisible(p.weapon);
        } else if (p.kind === 'objective') {
          if (this.mission) this.mission.onPickup(p);
        }
        this.audio.pickup(p.kind === 'objective' ? 'weapon' : p.kind);
        this.fx.sparks(p.x, 0.3, p.z, 0, 1, 0, 14, 1, 0.9, 0.5);
        this.pickupGroup.remove(p.mesh); this.pickups.splice(i, 1);
      }
    }
  }

  // ═══ oleadas ══════════════════════════════════════════════════════════════
  /** Puerta lejos del jugador, entre `k` al azar. */
  _farDoor(k) {
    const P = this.player, spawns = this.level.spawns;
    let best = null, bd = -1;
    for (let i = 0; i < k; i++) {
      const s = k >= spawns.length ? spawns[i] : spawns[this.rng.int(0, spawns.length - 1)];
      if (!s) break;
      const d = Math.hypot(s.x - P.x, s.z - P.z);
      if (d > bd) { bd = d; best = s; }
    }
    return best || spawns[0];
  }

  _updateWaves(dt) {
    const W = this.wcfg;
    if (!W || W.enabled === false || !this.player.alive) return;
    if (!this.waveActive) {
      this.betweenT -= dt;
      if (this.betweenT <= 0) this._startWave(this.wave + 1);
      return;
    }
    // ── estampida: cada tanto, una ráfaga de corredores por UNA puerta ──
    const S = W.stampede;
    if (S && this.wave >= S.from) {
      if (this.stampedeT === null) this.stampedeT = S.first[0] + this.rng() * (S.first[1] - S.first[0]);
      if (!this.stampede) {
        this.stampedeT -= dt;
        if (this.stampedeT <= 0) {
          this.stampedeT = S.every[0] + this.rng() * (S.every[1] - S.every[0]);
          const door = this._farDoor(this.level.spawns.length);
          this.stampede = { door, left: S.count(this.wave), t: 0 };
          this.ui.announce(t('ann.stampede'), t('ann.stampedeSub', { door: door.name || '' }));
          this.audio.waveSting(this.wave + 2);
        }
      }
    }
    if (this.stampede) {
      const St = this.stampede;
      St.t -= dt;
      if (St.t <= 0) {
        St.t = 0.18 + this.rng() * 0.2;
        const d = St.door;
        const Z = this._spawnZombie('runner', d.x + (this.rng() - 0.5) * 1.2, d.z + (this.rng() - 0.5) * 1.2, d.yaw, false);
        Z.alert = true;
        if (--St.left <= 0) this.stampede = null;
      }
    }
    // ir soltando zombis por las puertas
    if (this.waveLeft > 0) {
      this.spawnT -= dt;
      const maxAlive = W.maxAlive(this.wave);
      if (this.spawnT <= 0 && this.zm.alive < maxAlive) {
        this.spawnT = W.interval(this.wave) * (0.6 + this.rng() * 0.8);
        const door = this._farDoor(3);
        const type = W.mix(this.wave, this.rng());
        const jx = (this.rng() - 0.5) * 0.8, jz = (this.rng() - 0.5) * 0.8;
        this._spawnZombie(type, door.x + jx, door.z + jz, door.yaw, false);
        this.waveLeft--;
      }
    } else if (this.zm.alive === 0) {
      this.waveActive = false;
      this.wavesCleared++;
      this.betweenT = W.between;
      this.ui.announce(t('ann.waveClear', { n: this.wave }), t('ann.waveClearSub'));
      if (W.rewards) this._dropRewards();
      this.audio.setIntensity(0.15);
    }
  }
  _startWave(n) {
    const W = this.wcfg;
    this.wave = n; this.stats.wave = n;
    this.waveActive = true;
    this.waveTotal = W.total(n);
    this.waveLeft = this.waveTotal;
    this.spawnT = 0.5;
    this.ui.announce(t('ann.wave', { n }), n === 1 ? t('ann.wave1') : t('ann.waveSub' + (n % 4)));
    this.audio.waveSting(n);
    this.zm.alertAll(this.player.x, this.player.z, 30);
    // y algunos dormidos por los rincones, que se despiertan cuando los ves o hacés ruido
    this._spawnSleepers(W.sleepers(n));
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
          if (!Z.alert) { Z.wakeUp(); Z.reactT = 0.08; }   // un tiro despierta ya
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
    this.zm.alertAll(P.x, P.z, 16);
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
      onAttack: (Z, dmg, ux, uz, kind = 'swipe') => {
        const P = this.player;
        if (this.state === 'won') return;             // ya está: nadie te muerde en la foto final
        const A = ATTACKS[kind] || ATTACKS.swipe;
        const eff = A.effect || 'shove';
        const died = P.damage(dmg, Z.x, Z.z, eff === 'grab' ? 'grab' : kind);
        // qué le hace además del daño: tumbar (mazazo, molinete, puños, embestida, rodillazo
        // volador, caer encima), tacle (los dos al piso), levantarlo (gancho), tambaleo grande
        if (!died) {
          const B = P.body;
          if (eff === 'knockdown') { B.knockback(ux, uz, 1.5 + (Z.type === 'brute' ? 0.2 : 0), 0.4); this.R.addShake(0.4 * this.settings.shake); }
          else if (eff === 'tackle') { B.knockback(ux, uz, 1.35, 0.4); this.R.addShake(0.4 * this.settings.shake); }
          else if (eff === 'launch') { B.knockback(ux, uz, 1.25, 1.2); this.R.addShake(0.5 * this.settings.shake); }
          else if (eff === 'stagger') { B.stagger = Math.min(0.9, B.stagger + 0.35); B.stumble(ux, uz, 2.4, 0.45); }
        }
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

  // ═══ fin de partida ═══════════════════════════════════════════════════════
  _playerDied() {
    this.state = 'dead';
    this._timers.length = 0;
    this.audio.death();
    this.audio.setIntensity(0);
    this.best.wave = Math.max(this.best.wave, this.stats.wave);
    this.best.kills = Math.max(this.best.kills, this.stats.kills);
    this._saveBest();
    this._recordEnd(false);
    this._setWeaponVisible(null);
    this.beacon.visible = false;
    const def = this.missionDef;
    this.later(() => { if (this.state === 'dead') this.ui.showDeath(this.stats, this.best, { map: this.map, mission: def }); }, 1.8);
  }

  _missionWon() {
    if (this.state !== 'playing') return;
    this.state = 'won';
    this.audio.winSting();
    this.audio.setIntensity(0);
    this.best.wave = Math.max(this.best.wave, this.stats.wave);
    this.best.kills = Math.max(this.best.kills, this.stats.kills);
    this._saveBest();
    const res = this._recordEnd(true);
    this.beacon.visible = false;
    this.later(() => this.ui.announce(t('ann.won'), t('ann.wonSub')), 2.0);
    const def = this.missionDef;
    const p = this.progress.missions[def.id];
    const i = CAMPAIGN.findIndex(m => m.id === def.id);
    const hasNext = i >= 0 && i + 1 < CAMPAIGN.length;
    this.later(() => {
      if (this.state === 'won') this.ui.showWin(this.stats, { map: this.map, mission: def, bestTime: p ? p.bestTime : null, newBest: res.newBest, hasNext, campaignDone: missionsDone(this.progress, CAMPAIGN) === CAMPAIGN.length });
    }, 4.4);
  }

  /** Guarda el resultado en el progreso (misión o infinito). */
  _recordEnd(won) {
    const def = this.missionDef;
    if (!def) return { firstTime: false, newBest: false };
    let res = { firstTime: false, newBest: false };
    if (def.infinite) recordInfinite(this.progress, def.mapId, { wave: this.stats.wave, kills: this.stats.kills });
    else res = recordResult(this.progress, def.id, { won, time: this.stats.time, kills: this.stats.kills });
    this._saveProgress();
    return res;
  }

  // ═══ pausa y pantallas ════════════════════════════════════════════════════
  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.audio.suspend();
    this.ui.showPause();
  }
  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.audio.resume();
    this.ui.hideAll();
  }
  /** Volver al menú desde donde sea. */
  quitToMenu() {
    if (this.state === 'playing' || this.state === 'paused') this._recordEnd(false);
    this.audio.resume();
    this.startMenu();
  }
  setFullscreen(on) {
    try {
      if (on && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
      else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    } catch { /* sin API de pantalla completa */ }
  }

  // ═══ bucle ════════════════════════════════════════════════════════════════
  update(dt) {
    const I = this.input, P = this.player, R = this.R, w = this.world;
    this.time += dt;
    const t0 = performance.now();

    // ── entrada global ──
    if (I.pressed('F3')) this.applySettings({ showFps: !this.settings.showFps });
    if (this.state === 'paused') {
      if (I.actPressed('pause')) { if (this.ui.optionsOpen) this.ui.back(); else this.resume(); }
    } else if (this.state === 'playing') {
      if (I.actPressed('pause')) this.pause();
    } else if (this.state === 'dead' || this.state === 'won') {
      if (I.actPressed('pause') && this.ui.endScreenOn) this.startMenu();
    } else if (this.state === 'menu') {
      if (I.actPressed('pause')) this.ui.back();
    }
    if (this.state === 'paused') { this._render(0); I.endFrame(); return; }
    this._tickTimers(dt);

    // ── cámara: giro y zoom (el zoom se recuerda) ──
    if (I.actPressed('camLeft')) R.rotateCamera(Math.PI / 4);
    if (I.actPressed('camRight')) R.rotateCamera(-Math.PI / 4);
    if (I.wheel) { R.zoomCamera(I.wheel * 1.6); this.settings.camDist = R.camDistTarget; saveSettings(this.settings); }

    // ── jugador ──
    const playing = this.state === 'playing';
    R.screenToGround(I.nx, I.ny, 1.0, this._aim);
    if (playing) {
      R.forwardXZ(this._fwd); R.rightXZ(this._rgt);
      const inp = {
        mx: I.axis('moveLeft', 'moveRight'),
        mz: I.axis('moveDown', 'moveUp'),
        run: I.act('run'),
        crouch: I.act('crouch'),
        aimX: this._aim.x, aimZ: this._aim.z,
      };
      // rodar tocado mientras corre = rodada de esquive (agacharse mantenido sin correr = agacharse)
      inp.roll = I.actPressed('roll') && inp.run;
      inp.mx = clamp(inp.mx, -1, 1); inp.mz = clamp(inp.mz, -1, 1);
      P.update(dt, inp, this._fwd, this._rgt);

      if (P.alive) {
        const A = P.arsenal;
        // tirado en el piso o sacudido no se dispara ni se empuja
        const canAct = P.body.inControl && P.body.upright;
        // armas
        for (let k = 0; k < 4; k++) if (I.actPressed('weapon' + (k + 1)) && A.switchTo(WEAPON_ORDER[k])) { this._setWeaponVisible(A.current); this.audio.switchWeapon(); }
        if (I.actPressed('reload') && canAct && A.startReload()) this.audio.reload(A.current);
        if (I.actPressed('flashlight')) { P.flashlight = !P.flashlight; this.beam.visible = P.flashlight; }
        // interactuar: trepar lo que tenga adelante (escritorio, mesa); si no hay nada,
        // corriendo salta (vallas, cadáveres, huecos), si no, empujón. En el piso: levantarse ya
        if (I.actPressed('interact')) {
          const B = P.body;
          if (canAct) {
            const d = P.aimDir(this._dir);
            const mv = Math.hypot(B.wantX, B.wantZ) > 0.1 ? { x: B.wantX, z: B.wantZ } : d;
            if (!B.tryVault(mv.x, mv.z)) {
              if (inp.run && P.moving > 0.3 && B.speed > 2.4) {
                const sp = Math.max(B.speed, 3.2);
                B.jump(B.speed > 4.6 ? 'bound' : 'tuck', 3.6, mv.x * sp, mv.z * sp, { land: 'run', prep: 0.07 });
              } else this._shove();
            }
          } else if ((B.state === 'down' && B.downT > 0.12) || B.state === 'rest') B._startGetUp();
        }
        const shot = A.tryFire(I.fire && canAct);
        if (shot === 'empty') { this.audio.empty(); if (A.weapon.canReload) { A.startReload(); this.audio.reload(A.current); } }
        else if (shot) this.fire(shot);
        // recarga automática al vaciar
        if (A.weapon.mag === 0 && A.weapon.canReload && !I.fire) { A.startReload(); this.audio.reload(A.current); }
      }
      this._updatePickups(dt);
      this._updateWaves(dt);
      if (this.mission) this.mission.update(dt);
      this.stats.time += dt;
    } else if (this.state === 'dead' || this.state === 'won') {
      P.update(dt, { mx: 0, mz: 0, run: false, aimX: P.aim.x, aimZ: P.aim.z }, this._fwd, this._rgt);
    }

    // ── horda ──
    this.zm.update(dt, P, this._hooks());

    // ── física ──
    for (let i = 0; i < w.bodies.length; i++) {
      const b = w.bodies[i];
      if (!b.update) continue;
      b.update(dt);
      // aterrizó recién (salto, brinco, bajada): golpe sordo según la altura
      if (b.landT === 0 && b.lastLandDrop !== undefined && b.p) this.audio.thud(b.x, b.z, 0.35 + Math.min(1.2, b.lastLandDrop));
    }
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
      // calidad adaptativa: si no llega a 45 fps sostenidos, baja un escalón (nunca sube sola)
      if (this.settings.autoQuality && playing) {
        this.perf.lowT = this.perf.fps < 45 ? (this.perf.lowT || 0) + 0.5 : 0;
        if (this.perf.lowT >= 3 && this.R.qualityName !== 'bajo') {
          const next = this.R.qualityName === 'alto' ? 'medio' : 'bajo';
          this.perf.lowT = 0;
          this.applySettings({ quality: next });
          this.ui.toast(t('toast.quality', { q: t('options.quality.' + next).toUpperCase() }));
        }
      }
    }
    if (this.settings.showFps) this.ui.perf(this._perfText());
    I.endFrame();
  }

  _perfText() {
    const w = this.world, s = w.stats;
    return `${this.perf.fps.toFixed(0)} fps · frame ${this.perf.frame.toFixed(1)} ms · física ${this.perf.phys.toFixed(1)} ms\n` +
      `${s.particles} partículas · ${s.constraints} restricciones · ${s.bones} huesos · ${s.pairs} pares\n` +
      `zombis ${this.zm.alive} vivos / ${this.zm.zombies.length} · cadáveres ${this.corpses.n} · props despiertos ${this.props.awakeCount}\n` +
      `huesos dibujados ${this.bodies.drawnBones} · calidad ${this.R.qualityName} · mapa ${this.mapId}`;
  }

  _hud() {
    const P = this.player, A = P.arsenal, W = A.weapon, M = this.mission;
    let objective = '', progress = '';
    if (M && M.current) { objective = M.describe(); progress = M.progress(); }
    this.ui.hud({
      hp: P.hp, maxHp: P.maxHp, wave: this.wave, kills: this.stats.kills,
      weapon: t('weapon.' + W.def.key), mag: W.mag, reserve: W.reserve, reloading: W.reloading > 0 ? 1 - W.reloading / W.def.reload : 0,
      left: this.waveActive ? this.waveLeft + this.zm.alive : 0, between: this.waveActive ? 0 : this.betweenT,
      owned: WEAPON_ORDER.filter(k => A.has(k)), current: A.current, flashlight: P.flashlight,
      objective, progress, flashKey: this.settings.keys.flashlight[0] || '',
    });
    this.ui.crosshair(this.input.mouseX, this.input.mouseY, W.def.spread, P.moving);
    // marcador del objetivo: proyectado a pantalla, pegado al borde si queda afuera
    const tg = M ? M.target() : null;
    if (tg) {
      const s = this.R.worldToScreen(tg.x, 0.8, tg.z, this._scr);
      this.ui.marker(s.x, s.y, s.visible, progress);
    } else this.ui.marker(0, 0, false, '');
  }

  _beaconMesh() {
    const g = new THREE.Group();
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.42, 7, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd24a).multiplyScalar(1.4), toneMapped: false, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
    col.position.y = 3.5;
    g.add(col);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.15, 24),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd24a).multiplyScalar(2), toneMapped: false, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
    g.add(ring);
    g.visible = false;
    return g;
  }

  _render(dt) {
    const P = this.player, R = this.R, w = this.world;
    // daño en pantalla
    const dmg = this.state === 'playing' ? clamp01((1 - P.hp / P.maxHp) * 0.7 + P.damageFlash * 0.6) : (this.state === 'dead' ? clamp01(0.5 + P.deathT * 0.3) : 0);
    R.setDamage(dmg);
    if (this.state === 'dead') R.setFade(clamp01((P.deathT - 1.0) * 0.35));

    // el faro del objetivo (sólo para llegar a un punto; las cosas a juntar tienen su propia columna)
    const M = this.mission;
    const tg = this.state === 'playing' && M && M.current && M.current.type === 'reach' ? M.target() : null;
    if (tg) { this.beacon.visible = true; this.beacon.position.set(tg.x, 0, tg.z); this.beacon.rotation.y += dt * 0.6; }
    else this.beacon.visible = false;

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
  /**
   * Aplica y guarda ajustes parciales `{clave: valor}` según el registro de
   * opciones. `save=false` para la carga inicial.
   */
  applySettings(s, save = true) {
    for (const key in s) {
      const o = optionByKey(key);
      if (!o) continue;
      if (!o.volatile) this.settings[key] = s[key];
      o.apply(this, s[key]);
    }
    if (save) saveSettings(this.settings);
  }
  /** Aplica todos los ajustes guardados (al arrancar). */
  applyAllSettings() {
    setLang(this.settings.lang);
    for (const o of OPTIONS) if (!o.volatile) o.apply(this, this.settings[o.key]);
    this.input.setKeys(this.settings.keys);
  }
  rebindKey(action, code) {
    this.settings.keys = rebind(this.settings.keys, action, code);
    this.input.setKeys(this.settings.keys);
    saveSettings(this.settings);
  }
  resetKeys() {
    this.settings.keys = {};
    for (const a in DEFAULT_KEYS) this.settings.keys[a] = DEFAULT_KEYS[a].slice();
    this.input.setKeys(this.settings.keys);
    saveSettings(this.settings);
  }
  resetSettings() {
    const d = defaultSettings();
    this.settings = normalizeSettings({ ...d, lang: this.settings.lang });
    this.applyAllSettings();
    saveSettings(this.settings);
  }
}
