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
import { HEAD, CHEST, HIP, HAR, BONES } from '../phys/ragdoll.js';
import { NavGrid } from './nav.js';
import { LevelBuilder } from './level.js';
import { getMap, MAPS, MAP_ORDER } from './maps.js';
import { PropSystem } from './props.js';
import { ZombieManager, ATTACKS } from './zombie.js';
import { Player } from './player.js';
import { WEAPONS, WEAPON_ORDER } from './weapons.js';
import { RARITY, SLOT_COUNT, rollWeapon, NEW_WEAPON_COUNT } from './catalog.js';
import { Ballistics, AIM_CHEST, AIM_MIN_DIST } from './ballistics.js';
import { StatusBoard } from './status.js';
import { CAMPAIGN, missionById, infiniteMission, rangeMission, MissionManager, ITEM_STYLE } from './mission.js';
import { loadProgress, saveProgress, recordAttempt, recordResult, recordInfinite, recordWeapon, weaponsFound, isMissionUnlocked, isInfiniteUnlocked, nextMission, missionsDone, equip, startWeapons } from './progress.js';
import { OPTIONS, optionByKey, defaultSettings, normalizeSettings, saveSettings, rebind, DEFAULT_KEYS } from './options.js';
import { t, tx, setLang, getLang } from '../core/i18n.js';
import { Materials } from '../render/materials.js';
import { BodyRenderer, CorpseBuffer, paintBody, bloodyBone } from '../render/bodies.js';
import { PropRenderer } from '../render/props_render.js';
import { FX } from '../render/fx.js';
import { flashlightModel, beamCone } from '../render/models.js';
import { ShotFX } from '../render/shotfx.js';
import { instantiateWeapon, animateWeapon, kickWeapon, weaponFinishSpecs } from '../render/gunsmith.js';
import { makeStudioEnvironment, setWeaponEnvironment, finishProxyMeshes, bakeFinishes } from '../render/finishes.js';

/** Texturas horneadas que se suben a la placa por cuadro del menú (cada juego: hasta 4 texturas de 256²). */
const UPLOADS_PER_FRAME = 1;
/** Fundido de la cortina de arranque, en segundos. */
const CURTAIN_S = 0.8;
/**
 * Trabajo de precompilado por cuadro: detrás de la cortina de arranque no se ve nada (el menú
 * del DOM sigue respondiendo) y en la compuerta la pantalla espera igual; en el menú a la vista,
 * el de siempre (8 ms).
 */
const WARM_BUDGET_CURTAIN_MS = 48;
const WARM_BUDGET_GATE_MS = 250;
import { HUMS } from '../audio/audio.js';
import { makeRng, rnd, clamp, clamp01, TAU, splitStep } from '../core/util.js';
import { snapAim, stickToWorld } from '../core/sticks.js';
import { haptic, setHaptics, HAPTIC } from '../core/haptics.js';
import { coarsePointer } from '../core/touch.js';
import { isNative } from '../core/pwa.js';
import { adaptiveStepDown } from '../render/renderer.js';

/** Con el stick de puntería el punto apuntado está a esta distancia del jugador (m). */
const TOUCH_AIM_DIST = 6;

const SKIN_PLAYER = [0.79, 0.45, 0.28];
// cómo se sostiene cada tipo de arma: mano izquierda adelante (lo da el modelo), altura y lado
const HOLD = Object.freeze({
  pistol: { up: 0.0, side: 0.06, foreMax: 0.05 },
  rifle: { up: 0.0, side: 0.0, foreMax: 0.3 },
  heavy: { up: -0.16, side: 0.02, foreMax: 0.32 },
  shoulder: { up: 0.06, side: 0.0, foreMax: 0.3 },
});
const SWAP_RADIUS = 1.05;       // a esta distancia de un arma en el piso aparece el cartel de cambiar
const PICKUP_RADIUS = 0.85;
const SELF_BLAST_FACTOR = 0.35; // lo que te hace tu propia explosión
const FLESH_SOUNDS_PER_FRAME = 4;
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
    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._v3 = new THREE.Vector3();
    this._scr = { x: 0, y: 0, visible: false };
    this.settings = settings || defaultSettings();
    this.perf = { phys: 0, frame: 0, fps: 0, _acc: 0, _n: 0 };
    this.stats = { kills: 0, headshots: 0, severs: 0, wave: 0, time: 0, shots: 0, hits: 0 };
    this.best = this._loadBest();
    this.progress = loadProgress();
    this.missionDef = null; this.mission = null;
    this._timers = [];

    // armas: el modelo de cada una se arma la primera vez que hace falta (104 en el
    // catálogo) y queda en caché; en la mano va UNA instancia que se cambia con el arma
    setWeaponEnvironment(makeStudioEnvironment(renderer.renderer), 0.35);
    this.heldInst = null;
    this._held = new Map();
    this.shotfx = new ShotFX(this.scene, { light: (x, y, z, c, k, d) => this.R.lightPulse(x, y, z, c, k, d), rng: rnd });
    this.status = new StatusBoard(this.shotfx, rnd);
    this.ballistics = new Ballistics({ world: this.world, sink: this._sink(), fx: this.shotfx, rng: this.rng });
    this._tAlive = []; this._tAll = [];           // blancos de las áreas: se arman una vez por cuadro
    this._fleshSounds = 0; this._shotHit = false;
    this._swapTarget = null;
    // shaders: la partida no arranca hasta tenerlos compilados (ver warmup.js y ensureWarm)
    this.warm = { key: null, pending: null, stats: null };
    this.gate = 'open';                 // 'closed' mientras la partida espera sus shaders
    this._gateToken = 0;
    this._samples = null;
    this._prefetch = null;
    // cortina de arranque: el menú se ve enseguida sobre negro y la escena entra con un fundido
    // cuando los shaders están listos (las trabas de la placa al estrenarlos quedan detrás del negro)
    this.curtain = { phase: 'closed', t: 0 };
    renderer.setFade(1);
    // controles táctiles (main.js engancha la capa DOM en `touch`; acá sólo el modo)
    this.touch = null; this.touchMode = false; this._touchDir = { x: 0, z: 1 };
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
    this.R.fixLightTopology();          // todos los mapas con la misma cantidad de luces: los mismos shaders
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
    this.shotfx.clear();
    this.ballistics.clear();
    this.status.clear();
    this.audio.humStop();
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
    this.R.setFade(this.curtain.phase === 'open' ? 0 : 1);
    this.R.setDamage(0);
    this.beacon.visible = false;
    this._setWeaponVisible(null);
    this.audio.setIntensity(0);
    this.ui.showMenu(this.menuInfo());
    // en segundo plano, mientras el menú se mira (detrás de la cortina, con más trabajo por cuadro)
    const warm = this.ensureWarm(false, this.curtain.phase === 'closed' ? WARM_BUDGET_CURTAIN_MS : undefined);
    if (this.curtain.phase === 'closed') warm.finally(() => { if (this.curtain.phase === 'closed') this.curtain.phase = 'opening'; });
    this._prefetchWeapons();
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

  // ═══ shaders: nada se compila en medio de la partida ══════════════════════
  /**
   * Lo que todavía no está en la escena pero va a aparecer: un arma con cada
   * estructura de material (texturas de 8×8) y el cartel de cada premio, con
   * la columna de luz de las épicas. Se arma una vez. O(recetas).
   */
  _warmSamples() {
    if (this._samples) return this._samples;
    const out = [...finishProxyMeshes()];
    const epic = WEAPON_ORDER.find(k => WEAPONS[k].rarity >= 3);
    for (const kind of ['ammo', 'health', 'objective']) out.push(this._pickupMesh(kind, null, false));
    out.push(this._pickupMesh('weapon', epic, false));
    this._samples = out;
    return out;
  }

  /**
   * Precompila la escena con las muestras si la topología de shaders cambió
   * (luces, sombras, niebla) o si se fuerza (un nivel recién armado puede
   * traer materiales nuevos; con todo en caché la corrida tarda milisegundos).
   * Devuelve la promesa de la corrida en curso. O(materiales).
   */
  ensureWarm(force = false, budgetMs = undefined) {
    const key = this.R.shaderTopologyKey();
    if (!force && this.warm.key === key && this.warm.pending) return this.warm.pending;
    this.warm.key = key;
    const job = this.R.warmScene(this._warmSamples(), { budgetMs }).then((st) => { this.warm.stats = st; return st; });
    this.warm.pending = job;
    return job;
  }

  /** Cierra la compuerta hasta que termine el precompilado: ni simulación ni dibujo con shaders a medio compilar. */
  _closeGate(job) {
    const token = ++this._gateToken;
    this.gate = 'closed';
    job.catch((e) => console.error('precompilado de shaders:', e))
      .finally(() => { if (this._gateToken === token) this.gate = 'open'; });
  }

  /**
   * Las texturas de las 104 armas, horneadas en un Worker mientras se mira el
   * menú y subidas a la placa de a un juego por cuadro: cuando un zombi suelta
   * un arma nueva, no se calcula ni se sube nada en pleno tiroteo. O(acabados).
   */
  _prefetchWeapons() {
    if (this._prefetch) return;
    const specs = [];
    for (const k of WEAPON_ORDER) specs.push(...weaponFinishSpecs(WEAPONS[k]));
    const P = this._prefetch = { phase: 'baking', specs: specs.length, baked: 0, cached: 0, uploads: [], uploaded: 0, bakeMs: 0 };
    const t0 = performance.now();
    bakeFinishes(specs).then((r) => {
      P.baked = r.baked; P.cached = r.cached; P.bakeMs = performance.now() - t0;
      P.uploads = r.sets; P.phase = 'uploading';
    }).catch((e) => { P.phase = 'failed'; console.error('horno de texturas:', e); });
  }

  /** El fundido de la cortina de arranque (suave al principio y al final). */
  _openCurtain(dt) {
    const C = this.curtain;
    if (C.phase !== 'opening') return;
    C.t += dt;
    const k = clamp01(C.t / CURTAIN_S);
    this.R.setFade(1 - k * k * (3 - 2 * k));
    if (k >= 1) C.phase = 'open';
  }

  /** Sube a la placa lo horneado, de a poco y sólo en el menú (un juego de texturas cuesta 2–6 ms). */
  _uploadPrefetched() {
    const P = this._prefetch;
    if (!P || P.phase !== 'uploading') return;
    for (let n = 0; n < UPLOADS_PER_FRAME && P.uploaded < P.uploads.length; n++) {
      const T = P.uploads[P.uploaded++];
      for (const tex of [T.map, T.normalMap, T.roughnessMap, T.emissiveMap]) if (tex) this.R.renderer.initTexture(tex);
    }
    if (P.uploaded >= P.uploads.length) { P.phase = 'done'; P.uploads = []; }
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
  /** El polígono: el arma elegida en la armería, en la oficina, con horda liviana. */
  startRange(key) {
    if (!WEAPONS[key]) return false;
    this.newGame(rangeMission(key));
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
    // el arsenal inicial es el EQUIPO del jugador: las cinco ranuras desde la primera misión (todas las
    // armas están disponibles desde el arranque); el polígono pone en la mano el arma a probar
    const S = startWeapons(this.progress, def.start);
    for (const k of S.weapons) { if (k !== 'pistol') P.arsenal.give(k); this._found(k); }
    P.arsenal.dropped = null;                 // la pistola de fábrica reemplazada no cae al piso
    P.arsenal.switchTo(S.hold); P.arsenal.switchT = 0;
    this.killsBy = Object.create(null);
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
    this.curtain.phase = 'open';
    this.R.setFade(0);
    this.R.setDamage(0);
    this._setWeaponVisible(P.arsenal.current);
    this.ui.hideAll();
    // progreso: cuenta el intento (el polígono no cuenta para nada)
    if (def.practice) { /* práctica: sin récords */ }
    else if (!def.infinite) { recordAttempt(this.progress, def.id); this._saveProgress(); }
    else { this.progress.last = def.id; this._saveProgress(); }
    // la misión
    this.mission = new MissionManager(def, this._missionHost());
    // no se dibuja ni se simula hasta que los shaders de ESTA escena estén listos (ver warmup.js)
    this._closeGate(this.ensureWarm(true, WARM_BUDGET_GATE_MS));
    if (def.practice) this.ui.announce(t('ann.range'), this.weaponLabel(WEAPONS[def.start.hold]));
    else if (def.infinite) this.ui.announce(t('ann.start'), getLang() === 'es' && this.map.texts ? this.map.texts.start : t('ann.startSub'));
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
  /** El premio en el piso. Con withModel=false arma sólo el cartel (las muestras del precompilado). */
  _pickupMesh(kind, weapon, withModel = true) {
    const g = new THREE.Group();
    const colors = { ammo: 0x6d7a3a, health: 0xe8e2d2, weapon: 0x2a2c33, objective: 0x3a3630 };
    const rar = kind === 'weapon' && WEAPONS[weapon] ? RARITY[WEAPONS[weapon].rarity] : null;
    const glowC = { ammo: 0xffd24a, health: 0xff3b4a, weapon: rar ? new THREE.Color(rar.color).getHex() : 0x5aa0ff, objective: (ITEM_STYLE[weapon] || {}).color || 0xffd24a };
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.28, 0.32), new THREE.MeshStandardMaterial({ color: colors[kind], roughness: 0.8 }));
    base.castShadow = true; base.position.y = 0.14;
    g.add(base);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.06, 0.34), new THREE.MeshBasicMaterial({ color: new THREE.Color(glowC[kind]).multiplyScalar(2.2), toneMapped: false }));
    stripe.position.y = 0.14;
    g.add(stripe);
    if (kind === 'weapon') {
      // el modelo del catálogo (se arma acá, entre oleadas: cuando lo agarrás ya existe)
      if (withModel) {
        const inst = instantiateWeapon(WEAPONS[weapon]);
        const m = inst.group, len = inst.proto.length;
        m.position.set(0, 0.42, 0); m.rotation.set(0, Math.PI / 2, -0.15); m.scale.setScalar(clamp(0.95 / Math.max(0.2, len), 1.0, 1.6));
        g.add(m);
      }
      if (WEAPONS[weapon].rarity >= 3) {
        // épicas y legendarias: una columna de luz que se ve de lejos
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.1, 2.2, 6, 1, true),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(glowC.weapon).multiplyScalar(1.5), toneMapped: false, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }));
        col.position.y = 1.3; g.add(col);
      }
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
  /** Algo en el piso. `ammo` ({mag, reserve}) viaja con un arma soltada: nadie gana ni pierde balas. */
  spawnPickup(kind, weapon, x, z, ammo = null) {
    const mesh = this._pickupMesh(kind, weapon);
    mesh.position.set(x, 0.01, z);
    this.pickupGroup.add(mesh);
    // nada que compilar: las 104 armas comparten el programa que ya precompiló el menú (ver warmup.js)
    this.pickups.push({ kind, weapon, x, z, mesh, ammo, t: this.rng() * 6, life: kind === 'objective' ? Infinity : kind === 'weapon' ? 120 : 90 });
  }
  _dropRewards() {
    const P = this.player;
    const unlock = { 2: 'smg', 3: 'shotgun', 5: 'rifle' };
    const R = this.rng;
    const spot = () => this.nav.randomReachable(R, P.x, P.z, 3, 7) || { x: P.x + 2, z: P.z };
    const nextWave = this.wave + 1;
    if (unlock[nextWave] && !P.arsenal.has(unlock[nextWave])) { const s = spot(); this.spawnPickup('weapon', unlock[nextWave], s.x, s.z); }
    // y una del arsenal nuevo, sorteada por rareza (las raras se abren con las oleadas)
    const owned = new Set(P.arsenal.owned());
    const k1 = rollWeapon(R, this.wave, { exclude: owned });
    if (k1) { const s = spot(); this.spawnPickup('weapon', k1, s.x, s.z); owned.add(k1); }
    if (this.wave >= 3 && R() < 0.3 + this.wave * 0.03) { const k2 = rollWeapon(R, this.wave + 2, { exclude: owned, minRarity: 1 }); if (k2) { const s = spot(); this.spawnPickup('weapon', k2, s.x, s.z); } }
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
          // sólo se levanta sola si no hay que soltar nada; si no, cartel y tecla (ver _updateSwap)
          if (!P.arsenal.canTake(p.weapon)) continue;
          const fresh = P.arsenal.give(p.weapon, p.ammo);
          this._announceWeapon(p.weapon, fresh);
          if (fresh) this._setWeaponVisible(p.weapon);
        } else if (p.kind === 'objective') {
          if (this.mission) this.mission.onPickup(p);
        }
        this.audio.pickup(p.kind === 'objective' ? 'weapon' : p.kind);
        haptic(HAPTIC.pickup);
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
  /** Nombre visible de un arma (las clásicas tienen el suyo, traducido). */
  weaponLabel(def) { return def.classic ? t('weapon.' + def.key) : def.name; }

  /** El arma en la mano: una instancia por arma (se arma la primera vez) enganchada a la escena. */
  _setWeaponVisible(kind) {
    if (this.heldInst) { this.scene.remove(this.heldInst.group); this.heldInst = null; }
    this.flashModel.visible = !!kind;
    this.beam.visible = !!kind && !!this.player?.flashlight;
    if (!kind || !WEAPONS[kind]) return;
    let inst = this._held.get(kind);
    if (!inst) { inst = instantiateWeapon(WEAPONS[kind]); this._held.set(kind, inst); }
    this.scene.add(inst.group);
    this.heldInst = inst;
    // cómo lo sostiene: la mano izquierda va donde el modelo tiene el guardamanos
    const def = WEAPONS[kind], H = HOLD[def.hold] || HOLD.rifle, B = this.player && this.player.body;
    if (B) { B.aimFore = clamp(inst.proto.fore, 0, H.foreMax); B.aimUp = H.up; B.aimSide = H.side; }
  }

  /** Boca del caño en el mundo (las de varios caños alternan). */
  _muzzleWorld(out, idx = 0) {
    const inst = this.heldInst;
    if (!inst) return out.set(this.player.x, 1.2, this.player.z);
    return out.copy(inst.muzzles[idx % inst.muzzles.length]).applyMatrix4(inst.group.matrixWorld);
  }

  fire(def) {
    haptic(HAPTIC.shot);   // con techo de frecuencia: una automática no satura el motor
    const P = this.player, B = P.body, w = this.world, inst = this.heldInst;
    if (inst) inst.group.updateMatrixWorld(true);
    const m = this._muzzleWorld(this._v, inst ? inst.muzzleIdx++ : 0);
    const dir = P.aimDir(this._dir);
    // El rayo nace en el PECHO del jugador (no en la boca del caño): un zombi
    // pegado al cuerpo queda más cerca que el caño y si no, no le pegás nunca.
    // El fogonazo y la trazadora sí salen del caño.
    const ox = B.px(CHEST) + dir.x * 0.15, oy = B.py(CHEST) + 0.02, oz = B.pz(CHEST) + dir.z * 0.15;
    const ad = Math.hypot(P.aim.x - ox, P.aim.z - oz);
    let dy = (AIM_CHEST - oy) / Math.max(AIM_MIN_DIST, ad);
    let dx = dir.x, dz = dir.z;
    const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
    let ej = null, rear = null;
    if (inst) {
      ej = this._v2.copy(inst.eject).applyMatrix4(inst.group.matrixWorld);
      if (inst.proto.backblast) rear = this._v3.copy(inst.rear).applyMatrix4(inst.group.matrixWorld);
    }
    P.shots++; this.stats.shots++;
    this._shotHit = false;
    this.ballistics.fire(def, { shooter: B, mx: m.x, my: m.y, mz: m.z, ox, oy, oz, dx, dy, dz, aimX: this._aim.x, aimZ: this._aim.z, rear });
    if (this._shotHit) { P.hitsLanded++; this.stats.hits++; }
    // casquillo, cámara, retroceso en el cuerpo y en las manos, animación del arma
    const cas = def.shot.casing;
    if (ej && cas && cas !== 'none') this.fx.shell(ej.x, ej.y, ej.z, -dz * 0.6 + dx * 0.4, dx * 0.6 + dz * 0.4, 1, cas);
    this.R.addShake(def.shake * this.settings.shake);
    this.R.addKick(-dx * def.kick * 0.25, 0, -dz * def.kick * 0.25);
    this.R.fovPunch = Math.max(this.R.fovPunch, def.kick * 1.5);
    w.addImpulse(B.p[HAR], -dx * 6 * def.kick, 2 * def.kick, -dz * 6 * def.kick);
    w.addImpulse(B.p[CHEST], -dx * 8 * def.kick, 0, -dz * 8 * def.kick);
    if (inst) kickWeapon(inst);
    P.onFired(def);
    this.audio.shot(def);
  }

  // ═══ controles táctiles ═══════════════════════════════════════════════════
  /**
   * El punto apuntado con el stick derecho: a TOUCH_AIM_DIST del jugador en la
   * dirección del stick (ejes de la cámara); al soltarlo queda la última. Con
   * la ayuda de puntería, la dirección se imanta al zombi vivo que tenga a
   * menos de 11° y 14 m. O(horda) sólo con el stick activo.
   */
  _touchAim(I, P) {
    const a = I.aimStick;
    const sx = a.active ? a.x : a.lastX, sy = a.active ? a.y : a.lastY;
    const d = stickToWorld(sx, sy, this._fwd, this._rgt);
    let dx = d.x, dz = d.z;
    if (P && a.active && this.settings.touchAssist && this.zm) {
      const alive = [];
      for (const Z of this.zm.zombies) if (!Z.dead && Z.body.alive) alive.push(Z);
      const s = snapAim(dx, dz, P.x, P.z, alive);
      dx = s.dx; dz = s.dz;
    }
    this._touchDir.x = dx; this._touchDir.z = dz;
    const ox = P ? P.x : 0, oz = P ? P.z : 0;
    this._aim.x = ox + dx * TOUCH_AIM_DIST; this._aim.y = 1.0; this._aim.z = oz + dz * TOUCH_AIM_DIST;
    // con el stick activo, un hilo tenue del jugador a la mira: en una pantalla chica se ve a dónde se apunta
    if (P && a.active && this.state === 'playing' && this.shotfx) this.shotfx.segment(ox, 1.0, oz, this._aim.x, 1.0, this._aim.z, 0.004, 0xe6e3dc, 0.35, 0.03);
  }

  /** 'auto' | 'si' | 'no': con 'auto', el dedo manda si el puntero principal es grueso o en la app nativa. */
  setTouchMode(v) {
    const on = v === 'si' || (v !== 'no' && (coarsePointer() || isNative()));
    this.touchMode = on;
    setHaptics(on && this.settings.touchHaptics !== false);   // la vibración es cosa del dedo
    if (typeof document !== 'undefined') document.body.classList.toggle('touch', on);
    if (this.touch) this.touch.enable(on);
  }

  /** El botón ATRÁS de Android: cierra lo que esté arriba; en el menú principal devuelve 'exit'. */
  backButton() {
    if (this.state === 'playing') { this.pause(); return 'handled'; }
    if (this.state === 'paused') { if (this.ui.screen && this.ui.screen !== 'pause') this.ui.back(); else this.resume(); return 'handled'; }
    if (this.state === 'dead' || this.state === 'won') { if (this.ui.endScreenOn) this.startMenu(); return 'handled'; }
    if (this.ui.screen && this.ui.screen !== 'menu') { this.ui.back(); return 'handled'; }
    return 'exit';
  }

  /** Mira láser: un hilo de luz de la boca hasta lo primero que toca, y el punto. */
  _laserSight(m, color) {
    const P = this.player, d = P.aimDir(this._dir), w = this.world;
    let L = 30;
    if (w.raycastBones(m.x, m.y, m.z, d.x, 0, d.z, L, this._lb || (this._lb = {}), P.body)) L = this._lb.t;
    const tS = w.raycastStatic(m.x, m.y, m.z, d.x, 0, d.z, L, this._ls || (this._ls = {}));
    if (tS >= 0) L = tS;
    const ex = m.x + d.x * L, ez = m.z + d.z * L;
    this.shotfx.segment(m.x, m.y, m.z, ex, m.y, ez, 0.005, color, 1.1, 0.03, 8, 0);
    this.shotfx.billboard(ex, m.y, ez, 0.07, color, 2.6, 0.03, 0, 0);
  }

  // ═══ el sumidero de la balística: lo que un tiro le hace al juego ═════════
  _sink() {
    return {
      hitBody: (body, bone, s, dmg, imp, def, info) => this._hitBody(body, bone, s, dmg, imp, def, info),
      hitStatic: (H, def, info) => this._hitStatic(H, def, info),
      targets: (includeDead) => (includeDead ? this._tAll : this._tAlive),
      applyStatus: (body, kind, amount, def) => { const Z = body.zombie; if (Z && !Z.dead) this.status.apply(Z, kind, amount, def); },
      selfBlast: (x, y, z, r, dmg, force, def) => this._selfBlast(x, y, z, r, dmg, force, def),
      onExplosion: (x, y, z, r, def, kind) => this._onExplosion(x, y, z, r, def, kind),
      alert: (x, z, r) => this.zm.alertAll(x, z, r),
    };
  }

  /** Los blancos de las áreas (explosión, relámpago, chorro): los zombis en el mundo. O(horda), una vez por cuadro. */
  _buildTargets() {
    const A = this._tAlive, L = this._tAll;
    A.length = 0; L.length = 0;
    if (!this.zm) return;
    for (const Z of this.zm.zombies) {
      const B = Z.body;
      if (!B.alive) continue;
      L.push(B);
      if (!B.dead) A.push(B);
    }
  }

  /**
   * Un impacto en un cuerpo: multiplicadores (cabeza, miembros, congelado,
   * ácido), la reacción física del ragdoll, sangre, sonido, mutilaciones,
   * vida del zombi, los estados que deja el arma y la baja atribuida.
   */
  _hitBody(body, bone, s, dmg, imp, def, info) {
    const fx = def.shot.fx || {};
    const zone = BONES[bone] ? BONES[bone][4] : 1;
    const Z = body.zombie;
    let mult = 1;
    if (Z) mult *= this.status.vulnerability(Z);
    if (fx.hs && zone === 0) mult *= fx.hs;
    if (fx.sever && zone >= 2) mult *= fx.sever;
    const res = body.hit(bone, s, dmg * mult, imp, info.x, info.y, info.z);
    if (body.player) {
      // tu propio disco que rebota o tu arpón también duelen (menos)
      if (info.kind === 'proj' && this.player && this.player.alive) { if (this.player.damage(dmg * 0.35, info.x - info.dirx, info.z - info.dirz)) this._playerDied(); }
      return res;
    }
    const soft = info.kind === 'spray' || info.kind === 'wave';
    if (!soft) {
      bloodyBone(body, bone, 0.35 + res.damage * 0.006);
      if (info.kind !== 'arc') this.fx.bloodSpray(info.x, info.y, info.z, info.dirx, info.diry, info.dirz, info.kind === 'blast' ? 1.2 : 0.6 + Math.min(2, dmg / 40));
      if (this._fleshSounds++ < FLESH_SOUNDS_PER_FRAME) this.audio.fleshHit(info.x, info.z, res.zone === 0);
    }
    if (res.severed) {
      this.fx.goreBurst(info.x, info.y, info.z, 1);
      this.audio.gore(info.x, info.z);
      this.player.severs++; this.stats.severs++;
    }
    if (info.kind !== 'blast' && !info.limb) this._shotHit = true;
    if (info.kind === 'arc') this.audio.zap(info.x, info.z);
    if (Z && !body.dead) {
      Z.hp -= res.damage;
      if (!Z.alert) { Z.wakeUp(); Z.reactT = 0.08; }       // un tiro despierta ya
      // lo que deja el arma además del daño (el chorro y el relámpago ya lo aplicaron)
      if (!soft && info.kind !== 'arc' && info.kind !== 'blast') {
        if (fx.burn) this.status.apply(Z, 'burn', fx.burn, def);
        if (fx.freeze) this.status.apply(Z, 'freeze', fx.freeze, def);
        if (fx.acid) this.status.apply(Z, 'acid', fx.acid, def);
        if (fx.shock && this.rng() < fx.shock) {
          this.status.apply(Z, 'shock', 0.6, def);
          // el choque salta al zombi de al lado (una sola vez)
          const n = this._nearestTarget(body, 2.6);
          if (n) { this.shotfx.arc(info.x, info.y, info.z, n.px(CHEST), n.py(CHEST), n.pz(CHEST), def.shot.tracer || '#cba6f7', 0.012, 0.1); this.status.apply(n.zombie, 'shock', 0.5, def); }
        }
      }
      if (Z.hp <= 0) {
        const frozen = this.status.isFrozen(Z);
        body.kill(res.zone === 0 || def.pellets > 1 || info.kind === 'blast' || dmg >= 90 || frozen);
        this._credit(Z, def);
        if (res.zone === 0) { this.player.headshots++; this.stats.headshots++; this.fx.bloodSpray(info.x, info.y, info.z, info.dirx, 0.4, info.dirz, 1.4); }
        if (frozen) this._shatter(body);
      }
    }
    return res;
  }

  _nearestTarget(from, r) {
    let best = null, bd = r;
    const x = from.px(CHEST), z = from.pz(CHEST);
    for (const B of this._tAlive) {
      if (B === from || !B.zombie) continue;
      const d = Math.hypot(B.px(CHEST) - x, B.pz(CHEST) - z);
      if (d < bd) { bd = d; best = B; }
    }
    return best;
  }

  _hitStatic(H, def, info) {
    const obj = H.box || H.obj || null;
    if (obj && obj.isCorpse) {
      // un cadáver: sangre, no polvo
      this.fx.bloodSpray(H.x, H.y + 0.05, H.z, info.dirx, 0.5, info.dirz, 0.5);
      this.audio.fleshHit(H.x, H.z, false);
      return;
    }
    const k = def.shot.kind;
    if (info.kind === 'bounce' || info.kind === 'stick') { this.audio.thunk(H.x, H.z, info.kind === 'bounce' || (def.shot.proj && def.shot.proj.look === 'nail')); return; }
    if (k === 'beam' || k === 'rail') this.fx.scorch(H.x, H.y, H.z, k === 'rail' ? 0.22 : 0.1, H.nx, H.ny, H.nz);
    else this.fx.impact(H.x, H.y, H.z, H.nx, H.ny, H.nz);
    if (k === 'bullet') this.shotfx.sparks(H.x, H.y, H.z, H.nx, H.ny, H.nz, def.pellets > 1 ? 2 : 5, '#ffcf8a', 0.8);
    this.audio.wallHit(H.x, H.z);
    const imp = def.impulse || 6;
    this.props.wakeNear(H.x, H.z, 0.25, info.dirx * imp * 3, imp, info.dirz * imp * 3);
  }

  /** Tu propia explosión: si estás en el radio y a la vista, te empuja y te lastima (un tercio). */
  _selfBlast(x, y, z, r, dmg, force, def) {
    const P = this.player;
    if (!P || !P.alive) return;
    const cy = P.body.py(CHEST), d = Math.hypot(P.x - x, cy - y, P.z - z);
    if (d > r || !this.world.lineOfSight(x, y + 0.2, z, P.x, cy, P.z)) return;
    const f = 1 - (d / r) ** 2;
    const died = P.damage(dmg * SELF_BLAST_FACTOR * f, x, z);
    if (died) { this._playerDied(); return; }
    if (f > 0.4) P.body.knockback((P.x - x) / (d || 1), (P.z - z) / (d || 1), 0.8 + f, 0.5);
  }

  _onExplosion(x, y, z, r, def, kind) {
    const P = this.player;
    const d = P ? Math.hypot(P.x - x, P.z - z) : 10;
    this.R.addShake(Math.min(1.1, (r / 3) * 0.9 * clamp01(1.4 - d / (r * 5))) * this.settings.shake);
    if (kind !== 'acid') this.fx.scorch(x, 0.001, z, r * 0.45, 0, 1, 0);
    this.audio.explosion(x, z, r / 3);
    this.props.wakeNear(x, z, r, 0, r * 6, 0);
    this.zm.alertAll(x, z, 22);
  }

  /** Daño por tiempo (fuego, ácido): sin reacción física, sólo la vida; la baja es del arma que lo prendió. */
  _statusDamage(Z, dmg, def, kind) {
    if (Z.dead || Z.body.dead) return;
    Z.hp -= dmg * this.status.vulnerability(Z);
    if (kind === 'burn' && this.rng() < 0.08) this.audio.fleshHit(Z.x, Z.z, false);
    if (Z.hp <= 0) { Z.body.kill(false); if (def) this._credit(Z, def); }
  }

  /** Congelado y muerto: se parte en esquirlas de hielo. */
  _shatter(body) {
    const x = body.px(CHEST), y = body.py(CHEST), z = body.pz(CHEST);
    for (let i = 0; i < 26; i++) {
      const a = this.rng() * TAU, sp = 2 + this.rng() * 6;
      this.shotfx.spark(x, y, z, Math.cos(a) * sp, 1 + this.rng() * 4, Math.sin(a) * sp, 0.02, '#dff4ff', 2.4, 0.5 + this.rng() * 0.4, 0.02, 14, 1);
    }
    this.shotfx.billboard(x, y, z, 0.8, '#bfe8ff', 2.2, 0.2, 14, 1, this.rng() * TAU);
  }

  /** La baja se anota al arma (colección, estadística) y, si el arma cura, cura. */
  _credit(Z, def) {
    if (!def || Z.creditedTo) return;
    Z.creditedTo = def.key;
    if (this.killsBy) this.killsBy[def.key] = (this.killsBy[def.key] || 0) + 1;
    recordWeapon(this.progress, def.key, { kills: 1 });
    const ls = def.shot.fx && def.shot.fx.lifesteal;
    if (ls && this.player && this.player.alive) this.player.hp = Math.min(this.player.maxHp, this.player.hp + ls);
  }

  /** Premio al morir: el bruto suelta un arma seguido; el resto, muy de vez en cuando. */
  _deathDrop(Z) {
    if (this.state !== 'playing' || !this.missionDef || this.missionDef.practice) return;
    const brute = Z.type === 'brute';
    if (this.rng() > (brute ? 0.4 : 0.018)) return;
    const k = rollWeapon(this.rng, this.wave + (brute ? 2 : 0), { exclude: new Set(this.player.arsenal.owned()), minRarity: brute ? 1 : 0, maxRarity: brute ? 4 : 2 });
    if (k) this.spawnPickup('weapon', k, Z.x, Z.z);
  }

  /** Un arma nueva (o munición): cartel con el color de la rareza y a la colección. */
  _announceWeapon(key, fresh) {
    const d = WEAPONS[key], R = RARITY[d.rarity];
    this._found(key);
    if (fresh) this.ui.toast(this.weaponLabel(d) + ' · ' + tx(R.name).toUpperCase(), R.color);
    else this.ui.toast(t('toast.weaponAmmo', { weapon: this.weaponLabel(d) }));
  }
  _found(key) {
    if (!WEAPONS[key]) return;
    if (recordWeapon(this.progress, key, { found: true })) this._saveProgress();
  }

  /** El arma del piso más cercana que NO se levanta sola (hay que soltar otra): cartel y tecla. */
  _updateSwap() {
    const P = this.player;
    this._swapTarget = null;
    if (!P || !P.alive) { this.ui.prompt(null); return; }
    let best = null, bd = SWAP_RADIUS;
    for (const p of this.pickups) {
      if (p.kind !== 'weapon' || P.arsenal.canTake(p.weapon)) continue;
      const d = Math.hypot(p.x - P.x, p.z - P.z);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) { this.ui.prompt(null); return; }
    this._swapTarget = best;
    const d = WEAPONS[best.weapon], R = RARITY[d.rarity];
    const out = P.arsenal.inSlot(d.slot - 1);
    const s = this.R.worldToScreen(best.x, 0.95, best.z, this._scr);
    this.ui.prompt({ key: this.settings.keys.swap[0] || '', name: this.weaponLabel(d), color: R.color, rarity: tx(R.name), out: out ? this.weaponLabel(WEAPONS[out]) : '' }, s.x, s.y);
  }

  /** Cambio: el arma del piso a la mano; la de esa ranura, al piso con sus balas. */
  _swapPickup(p) {
    const P = this.player, A = P.arsenal;
    const i = this.pickups.indexOf(p);
    if (i < 0) return;
    this.pickupGroup.remove(p.mesh); this.pickups.splice(i, 1);
    const fresh = A.give(p.weapon, p.ammo);
    const drop = A.dropped;
    if (drop) {
      const a = P.body.yaw + Math.PI * (0.6 + this.rng() * 0.8);
      this.spawnPickup('weapon', drop.def.key, P.x + Math.sin(a) * 0.9, P.z + Math.cos(a) * 0.9, drop.ammo);
      A.dropped = null;
    }
    this._announceWeapon(p.weapon, fresh);
    this._setWeaponVisible(A.current);
    this.audio.pickup('weapon');
    haptic(HAPTIC.pickup);
    this.audio.humStop();
    this.fx.sparks(p.x, 0.3, p.z, 0, 1, 0, 14, 1, 0.9, 0.5);
    this._swapTarget = null;
    this.ui.prompt(null);
  }

  /** Zumbidos continuos del arma en la mano: giro de la rotativa, carga del riel, siseo del chorro. */
  _weaponHums(firing) {
    const A = this.player.arsenal, d = A.def, W = A.weapon;
    if (d.windup) this.audio.hum(d.auto ? 'spin' : 'charge', W.spin, d.auto ? HUMS.spin : HUMS.charge);
    if (d.shot.kind === 'spray') {
      const on = firing && W.mag >= 1 && W.reloading <= 0 ? 1 : 0;
      const cryo = d.shot.spray.type === 'cryo';
      this.audio.hum(cryo ? 'cryo' : 'flame', on, cryo ? HUMS.cryo : HUMS.flame);
    }
  }

  /** Lo que muestra la armería: las 104 con su estado en la colección. */
  armoryEntries() {
    const L = this.progress.loadout || [];
    return WEAPON_ORDER.map(k => {
      const d = WEAPONS[k], rec = this.progress.weapons ? this.progress.weapons[k] : null;
      return { key: k, def: d, name: this.weaponLabel(d), found: !!(rec && rec.found), kills: rec ? rec.kills || 0 : 0, equipped: L[d.slot - 1] === k };
    });
  }
  /** El equipo actual, en orden de ranura, con nombre para mostrar. */
  loadoutInfo() { return (this.progress.loadout || []).map(k => ({ key: k, name: this.weaponLabel(WEAPONS[k]) })); }
  /**
   * EQUIPAR desde el arsenal: el arma pasa a ocupar su ranura del equipo, ahora y en todas las
   * partidas que vengan. En una partida en curso (desde la pausa) cambia en la mano al instante.
   */
  equipWeapon(key) {
    if (!WEAPONS[key]) return false;
    if (equip(this.progress, key)) saveProgress(this.progress);
    const P = this.player;
    if (P && P.alive && (this.state === 'playing' || this.state === 'paused')) {
      const A = P.arsenal;
      if (!A.has(key)) { A.give(key); A.dropped = null; }
      A.switchTo(key, true); A.switchT = 0;
      this._setWeaponVisible(A.current);
      this._found(key);
      this.audio.switchWeapon();
    }
    return true;
  }
  armoryCounts() { return { found: weaponsFound(this.progress), total: WEAPON_ORDER.length, fresh: NEW_WEAPON_COUNT }; }

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
        this._deathDrop(Z);
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
    if (this.state === 'dead') return;          // dos golpes en el mismo cuadro (tu explosión y un zombi)
    this.state = 'dead';
    this._timers.length = 0;
    this.audio.death();
    this.audio.setIntensity(0);
    this.audio.humStop();
    if (!(this.missionDef && this.missionDef.practice)) {
      this.best.wave = Math.max(this.best.wave, this.stats.wave);
      this.best.kills = Math.max(this.best.kills, this.stats.kills);
      this._saveBest();
    }
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
    if (def.practice) { this._saveProgress(); return { firstTime: false, newBest: false }; }   // el polígono: sólo guarda la colección
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
    this.audio.humStop();
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
      if (I.actPressed('pause')) { if (this.ui.screen && this.ui.screen !== 'pause') this.ui.back(); else this.resume(); }
    } else if (this.state === 'playing') {
      if (I.actPressed('pause')) this.pause();
    } else if (this.state === 'dead' || this.state === 'won') {
      if (I.actPressed('pause') && this.ui.endScreenOn) this.startMenu();
    } else if (this.state === 'menu') {
      if (I.actPressed('pause')) this.ui.back();
    }
    // en pausa nada se mueve (dt 0)… salvo el arsenal abierto desde la pausa, que anima su vista previa
    if (this.state === 'paused') { this._render(this.armory && this.armory.active ? dt : 0); I.endFrame(); return; }
    // esperando shaders: ni simulación ni dibujo (queda el último cuadro; son milisegundos con todo en caché)
    if (this.gate === 'closed' && this.state !== 'menu') { I.endFrame(); return; }
    this._tickTimers(dt);

    // ── cámara: giro y zoom (el zoom se recuerda) ──
    if (I.actPressed('camLeft')) R.rotateCamera(Math.PI / 4);
    if (I.actPressed('camRight')) R.rotateCamera(-Math.PI / 4);
    if (I.wheel) { R.zoomCamera(I.wheel * 1.6); this.settings.camDist = R.camDistTarget; saveSettings(this.settings); }

    // ── jugador ──
    const playing = this.state === 'playing';
    R.forwardXZ(this._fwd); R.rightXZ(this._rgt);
    if (this.touchMode) this._touchAim(I, P); else R.screenToGround(I.nx, I.ny, 1.0, this._aim);
    if (playing) {
      const inp = {
        mx: I.moveX(),
        mz: I.moveZ(),
        run: I.run,
        analog: I.move.active,        // stick táctil: la velocidad sigue una curva continua (player.js)
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
        for (let k = 0; k < SLOT_COUNT; k++) if (I.actPressed('weapon' + (k + 1)) && A.switchSlot(k)) { this._setWeaponVisible(A.current); this.audio.switchWeapon(); this.audio.humStop(); }
        if (I.actPressed('swap') && this._swapTarget) this._swapPickup(this._swapTarget);
        if (I.actPressed('reload') && canAct && A.startReload()) this.audio.reload(A.def);
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
        this._buildTargets();
        // el gatillo táctil (stick empujado o botón FUEGO) repite las semiautomáticas; un mouse en el teléfono, no
        const shot = A.tryFire(I.fire && canAct, dt, this.touchMode && I.virtual.has('fire'));
        if (shot === 'empty') { this.audio.empty(); if (A.weapon.canReload) { A.startReload(); this.audio.reload(A.def); } }
        else if (shot) this.fire(shot);
        // recarga automática al vaciar
        if (A.weapon.mag < 1 && A.weapon.canReload && !I.fire) { A.startReload(); this.audio.reload(A.def); }
        this._weaponHums(I.fire && canAct);
      }
      this._updatePickups(dt);
      this._updateSwap();
      this._updateWaves(dt);
      if (this.mission) this.mission.update(dt);
      this.stats.time += dt;
    } else if (this.state === 'dead' || this.state === 'won') {
      P.update(dt, { mx: 0, mz: 0, run: false, aimX: P.aim.x, aimZ: P.aim.z }, this._fwd, this._rgt);
    }

    // con la armería abierta el menú no se ve: ni horda ni física (el cuadro es de las miniaturas)
    if (!(this.state === 'menu' && this.armory && this.armory.active)) {
      // la simulación va en pasos de a lo sumo SIM.step: un cuadro lento (un teléfono a 25 fps) se
      // parte en dos o tres pasos y el juego sigue a tiempo real en vez de ir en cámara lenta
      const { n, h } = splitStep(dt);
      const hooks = this._hooks();
      const statusDmg = (Z, dmg, def, kind) => this._statusDamage(Z, dmg, def, kind);
      for (let k = 0; k < n; k++) {
        // ── horda (y después lo que le dejaron los tiros: fuego, frío, ácido, choque) ──
        this.zm.update(h, P, hooks);
        this._buildTargets();
        this.status.update(h, statusDmg);
        this.status.applySlows();

        // ── física ──
        for (let i = 0; i < w.bodies.length; i++) {
          const b = w.bodies[i];
          if (!b.update) continue;
          b.update(h);
          // aterrizó recién (salto, brinco, bajada): golpe sordo según la altura
          if (b.landT === 0 && b.lastLandDrop !== undefined && b.p) this.audio.thud(b.x, b.z, 0.35 + Math.min(1.2, b.lastLandDrop));
        }
        this.props.update(h);
        w.step(h);
        // proyectiles DESPUÉS del paso: barren contra los huesos donde quedaron este paso
        this.ballistics.update(h);
      }
      this.perf.simSteps = n;
    }
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
    this.shotfx.update(dt);
    this.shotfx.drawProjectiles(this.ballistics.projectiles);
    this._fleshSounds = 0;
    this.level.update(dt);
    if (playing) this._hud();
    this._render(dt);
    if (this.state === 'menu') { this._uploadPrefetched(); this._openCurtain(dt); }
    this.perf.frame = performance.now() - t0;
    this.perf._acc += dt; this.perf._n++;
    if (this.perf._acc >= 0.5) {
      this.perf.fps = this.perf._n / this.perf._acc; this.perf._acc = 0; this.perf._n = 0;
      // calidad adaptativa: si no llega a 45 fps sostenidos, baja un escalón (nunca sube sola):
      // primero la resolución de render (sin aviso, es fino), después el preset (con aviso)
      if (this.settings.autoQuality && playing) {
        this.perf.lowT = this.perf.fps < 45 ? (this.perf.lowT || 0) + 0.5 : 0;
        if (this.perf.lowT >= 3) {
          this.perf.lowT = 0;
          const step = adaptiveStepDown(this.R.qualityName, this.R.renderScale);
          if (step.renderScale !== undefined) this.R.setRenderScale(step.renderScale);
          else if (step.quality) {
            this.applySettings({ quality: step.quality });
            this.ui.toast(t('toast.quality', { q: t('options.quality.' + step.quality).toUpperCase() }));
          }
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
      `huesos dibujados ${this.bodies.drawnBones} · calidad ${this.R.qualityName} · mapa ${this.mapId}\n` +
      `proyectiles ${this.ballistics.projectiles.length} · sprites ${this.shotfx.live} · estados ${this.status.count} · arma ${this.player ? this.player.arsenal.current : '-'}`;
  }

  _hud() {
    const P = this.player, A = P.arsenal, W = A.weapon, M = this.mission;
    let objective = '', progress = '';
    if (M && M.current) { objective = M.describe(); progress = M.progress(); }
    const D = W.def, R = RARITY[D.rarity];
    const slots = [];
    for (let i = 0; i < SLOT_COUNT; i++) { const k = A.inSlot(i); slots.push(k ? { key: k, color: RARITY[WEAPONS[k].rarity].color, cur: k === A.current } : null); }
    this.ui.hud({
      hp: P.hp, maxHp: P.maxHp, wave: this.wave, kills: this.stats.kills,
      weapon: this.weaponLabel(D), weaponColor: R.color, weaponSub: tx(D.familyName).toLowerCase() + ' · ' + tx(R.name),
      mag: Math.floor(W.mag), reserve: W.reserve, battery: D.regen ? W.mag / D.mag : -1, overheat: W.overheat > 0,
      reloading: A.busy, spin: D.windup ? W.spin : -1,
      left: this.waveActive ? this.waveLeft + this.zm.alive : 0, between: this.waveActive ? 0 : this.betweenT,
      slots, flashlight: P.flashlight,
      objective, progress, flashKey: this.settings.keys.flashlight[0] || '',
    });
    if (this.touchMode) { const s = this.R.worldToScreen(this._aim.x, 1.0, this._aim.z, this._scr); this.ui.crosshair(s.x, s.y, W.def.spread, P.moving); }
    else this.ui.crosshair(this.input.mouseX, this.input.mouseY, W.def.spread, P.moving);
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
    // la armería abierta dibuja lo suyo (y el juego no gasta en su escena, tapada por el menú)
    if (this.armory && this.armory.active) { this.armory.draw(dt); return; }
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
      const inst = this.heldInst;
      const hx = B.px(HAR), hy = B.py(HAR), hz = B.pz(HAR);
      const yaw = B.yaw;
      if (inst) {
        const g = inst.group, dropped = !P.alive;
        // orientación del arma: apunta a donde mira el cuerpo; corriendo baja
        // (cruzada al pecho); el retroceso levanta la boca del caño; un bob y
        // un balanceo leves siguen el paso; en recarga se inclina un poco
        const ab = B.aimBlend, rc = B.recoil;
        const pitch = -0.62 * (1 - ab) - rc * 0.55 * P.lastKick + Math.cos(B.phase * 2) * 0.035 * B.gait * (1 - ab) * P.moving
          - Math.sin(Math.PI * clamp01((B.reloadT - 0.1) / 0.62)) * 0.25;
        const roll = -0.35 * (1 - ab) + Math.sin(B.phase) * 0.03 * P.moving;
        g.position.set(hx, hy, hz);
        if (dropped) g.rotation.set(1.2, yaw, 0.6);
        else g.rotation.set(pitch, yaw, roll, 'YXZ');
        const W = P.arsenal.weapon;
        animateWeapon(inst, dt, W && W.def.key === inst.key && W.def.windup ? W.spin : 0);
        g.updateMatrixWorld(true);
        const m = this._muzzleWorld(this._v, inst.muzzleIdx);
        const dir = this._v2.set(0, 0, 1).applyQuaternion(g.quaternion);
        // la linterna va debajo del caño y sigue su orientación
        this.flashModel.position.set(m.x - dir.x * 0.16, m.y - 0.045 - dir.y * 0.16, m.z - dir.z * 0.16);
        this.flashModel.quaternion.copy(g.quaternion);
        this.beam.position.set(m.x, m.y - 0.04, m.z);
        this.beam.quaternion.copy(g.quaternion);
        this.beam.visible = P.flashlight && P.alive;
        const ty = Math.max(0.1, m.y + dir.y * 10);
        R.setFlashlight(m.x, m.y + 0.05, m.z, m.x + dir.x * 10, ty, m.z + dir.z * 10, P.flashlight && P.alive ? 260 : 0);
        // mira láser (un hilo de luz hasta lo primero que toca) y telescópica (la cámara se adelanta)
        const def = P.arsenal.def;
        if (P.alive && this.state === 'playing') {
          if (def.shot.fx.laser && B.aimBlend > 0.6) this._laserSight(m, def.shot.fx.laser);
          R.scopeTarget = def.shot.scope && B.aimBlend > 0.7 ? def.shot.scope : 0;
          // piloto del lanzallamas: una llamita siempre prendida
          if (inst.proto.pilot && this.rng() < 0.7) { const pp = this._v3.copy(inst.proto.pilot).applyMatrix4(g.matrixWorld); this.shotfx.billboard(pp.x, pp.y, pp.z, 0.035, def.look.glow || '#fab387', 2.6, 0.05, 13, 0, this.rng() * 6); }
        } else R.scopeTarget = 0;
      } else {
        R.setFlashlight(0, 0, 0, 0, 0, 0, 0);
        this.beam.visible = false;
        R.scopeTarget = 0;
      }
    } else {
      R.setFlashlight(0, 0, 0, 0, 0, 0, 0);
      this.beam.visible = false;
      R.scopeTarget = 0;
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
    if (this.warm.key !== null) this.ensureWarm();     // sombras u otra calidad: otra topología de shaders
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
