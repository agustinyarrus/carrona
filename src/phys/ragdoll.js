// ─────────────────────────────────────────────────────────────────────────────
//  ragdoll.js — Ragdoll humanoide con músculos activos. SIEMPRE es física.
//
//  La idea central: NO hay dos sistemas (animación y física). Hay uno solo.
//  El esqueleto siempre es física. Lo que cambia es cuánta fuerza hace cada
//  parte para alcanzar su pose objetivo:
//
//     músculo = 1  → se para, camina, trota, corre, pelea
//     músculo = 0  → trapo
//
//  El músculo es un controlador PD (posición + amortiguación de velocidad),
//  no un resorte: por eso una fuerza baja no oscila y un caído no "flota".
//
//  Sobre eso corre una máquina de estados con movimientos (moves.js):
//     up       → marcha procedural con estilo propio + overlays (sacudones
//                por tiro, manotazos, tics) + tambaleo con pasos reales
//     falling  → una CAÍDA elegida por causa y ángulo (sentarse de espaldas,
//                de tabla, de boca, de rodillas, de costado, girando,
//                desplomarse, volando, voltereta, rebote contra la pared…)
//     down     → tirado, física pura, aturdido
//     rising   → una LEVANTADA elegida por cómo quedó (boca arriba, boca
//                abajo, de costado, sentado, arrodillado) y por el tipo de
//                cuerpo (el corredor se levanta de un salto, el bruto se
//                arrastra)
//     rest     → dormido en el piso o sentado, hasta que algo lo despierta
//     dying    → una MUERTE (se desploma, camina herido, cae de rodillas…)
//
//  La marcha es procedural y mezcla caminar / trotar / correr según la
//  velocidad real; la fase avanza con la distancia recorrida, así los pies no
//  patinan. El paso va en la dirección del movimiento (pasos laterales si
//  el cuerpo mira a otro lado, como el jugador apuntando, o hacia atrás
//  cuando un tiro lo hace tambalear).
// ─────────────────────────────────────────────────────────────────────────────

import { CT_DIST, CT_MIN, CT_MAX, PF_GROUND, PF_HIT } from './world.js';
import { clamp, clamp01, lerp, angDelta, TAU } from '../core/util.js';
import { NP, POSE, HEAD, NECK, CHEST, SHL, SHR, ELL, ELR, HAL, HAR, HIP, HPL, HPR, KNL, KNR, FTL, FTR } from './skeleton.js';
import { SEQ, OVER, getUpsFor, pickWeighted, rotY, RUN_STYLES, WALK_STYLES, IDLE_OVERLAYS, JUMPS, VAULTS, DESCENTS, WOUNDS, HOP_STYLES, pickStyle, P as POSES } from './moves.js';

export { NP, POSE, HEAD, NECK, CHEST, SHL, SHR, ELL, ELR, HAL, HAR, HIP, HPL, HPR, KNL, KNR, FTL, FTR };

// masa (kg) y radio de colisión (m) por partícula
const MASS = new Float32Array([5.0, 2.0, 15.0, 3.0, 3.0, 2.0, 2.0, 1.5, 1.5, 13.0, 3.0, 3.0, 3.5, 3.5, 2.0, 2.0]);
const PRAD = new Float32Array([0.130, 0.075, 0.155, 0.095, 0.095, 0.070, 0.070, 0.062, 0.062, 0.145, 0.095, 0.095, 0.080, 0.080, 0.075, 0.075]);

// rigidez relativa del músculo por partícula (el torso manda, las manos flotan)
const MUS = new Float32Array([0.85, 0.95, 1.00, 0.90, 0.90, 0.55, 0.55, 0.40, 0.40, 1.00, 0.95, 0.95, 0.75, 0.75, 0.85, 0.85]);

// ── huesos: [a, b, radio de render/impacto, hp, zona] ────────────────────────
//  zona: 0 cabeza · 1 torso · 2 brazo · 3 pierna
export const B_SKULL = 0, B_NECK = 1, B_SPINE = 2, B_CLAVL = 3, B_CLAVR = 4,
  B_UARML = 5, B_UARMR = 6, B_FARML = 7, B_FARMR = 8, B_PELVL = 9, B_PELVR = 10,
  B_THIGHL = 11, B_THIGHR = 12, B_SHINL = 13, B_SHINR = 14;
export const NB = 15;

//  hp: cuánto daño acumulado corta el hueso. Un tiro de pistola (30) no saca un
//  brazo; una escopeta a quemarropa (9×14) o un fusil (44) sí; la cabeza vuela
//  con el fusil o la escopeta.
export const BONES = [
  [HEAD, NECK, 0.132, 34, 0],
  [NECK, CHEST, 0.088, 60, 1],
  [CHEST, HIP, 0.152, 999, 1],   // la columna no se corta
  [CHEST, SHL, 0.098, 90, 1],
  [CHEST, SHR, 0.098, 90, 1],
  [SHL, ELL, 0.072, 56, 2],
  [SHR, ELR, 0.072, 56, 2],
  [ELL, HAL, 0.058, 42, 2],
  [ELR, HAR, 0.058, 42, 2],
  [HIP, HPL, 0.108, 999, 1],
  [HIP, HPR, 0.108, 999, 1],
  [HPL, KNL, 0.090, 74, 3],
  [HPR, KNR, 0.090, 74, 3],
  [KNL, FTL, 0.072, 56, 3],
  [KNR, FTR, 0.072, 56, 3],
];

// al cortar un hueso, estas partículas quedan del lado que se desprende
const DISTAL = {
  [B_SKULL]: [HEAD],
  [B_UARML]: [ELL, HAL], [B_UARMR]: [ELR, HAR],
  [B_FARML]: [HAL], [B_FARMR]: [HAR],
  [B_THIGHL]: [KNL, FTL], [B_THIGHR]: [KNR, FTR],
  [B_SHINL]: [FTL], [B_SHINR]: [FTR],
};

// bisagras: [articulación, extremo A, extremo B, signo, hueso prox, hueso dist]
const HINGES = [
  [ELL, SHL, HAL, -1, B_UARML, B_FARML], [ELR, SHR, HAR, -1, B_UARMR, B_FARMR],
  [KNL, HPL, FTL, +1, B_THIGHL, B_SHINL], [KNR, HPR, FTR, +1, B_THIGHR, B_SHINR],
];

// pares del torso que lo vuelven un bloque casi rígido (cruces del cluster)
const TORSO = [
  [CHEST, HPL], [CHEST, HPR], [SHL, HIP], [SHR, HIP],
  [SHL, SHR], [HPL, HPR], [NECK, SHL], [NECK, SHR], [HEAD, CHEST],
  [SHL, HPL], [SHR, HPR],
];

// Límites de rango (estilo Verlet): distancias mínimas o máximas entre partes
// NO adyacentes que encierran los ángulos posibles de cada articulación.
const RANGE = [
  [HEAD, SHL, 0.78, CT_MIN], [HEAD, SHR, 0.78, CT_MIN],
  [HEAD, HIP, 0.72, CT_MIN],
  [KNL, CHEST, 0.62, CT_MIN], [KNR, CHEST, 0.62, CT_MIN],
  [KNL, KNR, 0.55, CT_MIN],
  [FTL, FTR, 0.45, CT_MIN], [FTL, FTR, 4.6, CT_MAX],
  [ELL, CHEST, 0.55, CT_MIN], [ELR, CHEST, 0.55, CT_MIN],
  [HEAD, HAL, 0.35, CT_MIN], [HEAD, HAR, 0.35, CT_MIN],
  [FTL, CHEST, 0.45, CT_MIN], [FTR, CHEST, 0.45, CT_MIN],
];

// parámetros de estilo que se mezclan entre caminar y correr según la marcha
const STYLE_LERP = ['lean', 'hunch', 'headDown', 'zigzag', 'shoulder', 'crouchRun', 'reachHi', 'strideMul', 'bobMul', 'lift', 'stomp'];
// rasgos que vienen del estilo de caminar (o del azar si el estilo no los fija)
const STYLE_TRAIT = ['jitter', 'lurch', 'limp', 'sway', 'wobble', 'headTilt', 'dragLeg'];

let NEXT_GROUP = 1;
const _out = {};
const bell = (u, peak = 0.25) => u < peak ? u / peak : Math.max(0, 1 - (u - peak) / (1 - peak));

export class Ragdoll {
  /**
   * @param {PhysWorld} world
   * @param {object} opt  {x,y,z,yaw,scale,massScale,toughness,armMode,stride,stiffness,
   *                       maxMuscleSpeed,isPlayer,lockYaw,staggerScale,rng,kind,
   *                       runStyle,walkStyle}
   */
  constructor(world, opt = {}) {
    const w = world;
    this.world = w;
    this.group = NEXT_GROUP++;
    this.scale = opt.scale ?? 1;
    this.massScale = opt.massScale ?? 1;
    this.rng = opt.rng;
    this.alive = true;
    this.dead = false;
    this.deadT = 0;
    this.isPlayer = !!opt.isPlayer;
    this.kind = opt.kind ?? (this.isPlayer ? 'player' : 'walker');   // para sortear movimientos
    this.lod = 0;

    const S = this.scale;
    const x = opt.x ?? 0, z = opt.z ?? 0, y = opt.y ?? 0;
    this.yaw = opt.yaw ?? 0;
    this.aimYaw = this.yaw;

    // ── partículas ──────────────────────────────────────────────────────────
    this.p = new Int32Array(NP);
    for (let i = 0; i < NP; i++) {
      const lx = POSE[i * 3] * S, ly = POSE[i * 3 + 1] * S, lz = POSE[i * 3 + 2] * S;
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      this.p[i] = w.addParticle(
        x + lx * c + lz * s, y + ly, z - lx * s + lz * c,
        MASS[i] * this.massScale * S * S * S, PRAD[i] * S, this.group, 0.1
      );
      w.setOwner(this.p[i], this);
    }

    // ── restricciones ───────────────────────────────────────────────────────
    this.boneC = new Int32Array(NB);      // restricción estructural de cada hueso
    this.extraC = [];                     // límites y cluster: [idx, a, b]
    for (let b = 0; b < NB; b++) {
      const [ia, ib] = BONES[b];
      this.boneC[b] = w.addConstraint(this.p[ia], this.p[ib], this._rest(ia, ib), 0.0000004);
    }
    for (const [ia, ib] of TORSO) {
      this.extraC.push([w.addConstraint(this.p[ia], this.p[ib], this._rest(ia, ib), 0.000002), ia, ib]);
    }
    this.limitC = [];
    const addLimit = (ia, ib, f, type) => {
      const idx = w.addConstraint(this.p[ia], this.p[ib], this._rest(ia, ib) * f, 0.00002, type);
      this.limitC.push([idx, ia, ib]);
      return idx;
    };
    this._limSh = [
      addLimit(SHL, HAL, 0.995, CT_MAX), addLimit(SHR, HAR, 0.995, CT_MAX),
      addLimit(HPL, FTL, 0.995, CT_MAX), addLimit(HPR, FTR, 0.995, CT_MAX),
      addLimit(SHL, HAL, 0.30, CT_MIN), addLimit(SHR, HAR, 0.30, CT_MIN),
      addLimit(HPL, FTL, 0.34, CT_MIN), addLimit(HPR, FTR, 0.34, CT_MIN),
    ];
    for (const [a, b, f, type] of RANGE) addLimit(a, b, f, type);

    // ── huesos de render / impacto ──────────────────────────────────────────
    this.bone = new Int32Array(NB);
    this.boneHP = new Float32Array(NB);
    this.boneAlive = new Uint8Array(NB).fill(1);
    for (let b = 0; b < NB; b++) {
      const [ia, ib, r, hp] = BONES[b];
      this.boneHP[b] = hp * (opt.toughness ?? 1);
      this.bone[b] = w.addBone(this.p[ia], this.p[ib], r * S, this.boneHP[b], this, b);
    }

    // ── músculo ─────────────────────────────────────────────────────────────
    this.muscle = new Float32Array(NP).fill(1);
    this.muscleGlobal = 1;
    this.stiffness = opt.stiffness ?? 130;
    this.maxMuscleSpeed = opt.maxMuscleSpeed ?? 9;

    // ── locomoción ──────────────────────────────────────────────────────────
    const R = this.rng || Math.random;
    this.phase = R() * TAU;
    this.stride = opt.stride ?? 0.24;
    this.speed = 0;
    this.wantX = 0; this.wantZ = 0;      // dirección deseada, normalizada
    this.wantSpeed = 0;                  // velocidad pedida por la IA/el jugador
    this.curSpeed = 0;                   // velocidad real con inercia (rampa)
    this.crawling = false;
    this.stagger = 0;
    this.staggerScale = opt.staggerScale ?? 1;
    this.groundY = 0;
    this.airborne = 0;
    this.lockYaw = !!opt.lockYaw;
    this.lunge = 0;
    this.gait = 0;                       // 0 camina … 1 corre (mezcla real)
    this.idleT = R() * 10;
    // sólo para 'aim' (el jugador): 1 apuntando / 0 corriendo; retroceso; recarga
    this.aimBlend = 1; this.recoil = 0; this.reloadT = 0;
    // heridas: cada miembro tiene un "piso" de músculo (baja con el daño, para
    // siempre) y una fuerza actual que se recupera hacia ese piso. Además una
    // pierna baleada se dobla un rato y un brazo baleado cuelga un rato.
    this.muscleFloor = new Float32Array(NP).fill(1);
    this.limbMul = new Float32Array(NP).fill(1);
    this.legBuckle = [0, 0]; this.armLimp = [0, 0];
    this.hitJ = 0;          // momento recibido recientemente (decae)
    this.lastHitX = 0; this.lastHitZ = 1;
    // trucos de Overgrowth: inclinarse hacia la aceleración, mirar al objetivo,
    // prepararse con los brazos al caer; agacharse; trepar; aterrizar flexionando
    this.accX = 0; this.accZ = 0; this._vpx = 0; this._vpz = 0;
    this.lookX = 0; this.lookZ = 0;
    this.brace = 0;
    this.vault = null; this.autoVault = !this.isPlayer; this.vaults = 0;
    this.crouch = 0; this.wantCrouch = false;
    this.landCrouch = 0; this.airT = 0;

    // ── estados físicos ─────────────────────────────────────────────────────
    this.state = 'up';     // up · falling · down · rising · rest
    this.seq = null;       // secuencia en curso (caída, levantada, muerte, descanso)
    this.overlay = null;   // sacudón / manotazo encima de la marcha
    this.idleOv = null;    // tic de quieto (bucle)
    this.idleNext = 1 + R() * 3;
    this.downT = 0;        // cuánto lleva tirado
    this.dazeT = 0;        // cuánto tiene que quedarse tirado antes de levantarse
    this.upT = 1;          // cuánto lleva erguido
    this.dying = 0;        // > 0 mientras corre una secuencia de muerte
    this.limp = 0;         // segundos con los músculos apagados (golpe corto)
    this.dormant = false;  // dormido: no se levanta hasta que lo despierten
    this.riseTries = 0;
    this.tripT = 0; this.tripped = 0;
    this.blockT = 0; this.slams = 0; this.slamCool = 0; this.bumpCool = 0; this.bumps = 0;
    this.falls = 0; this.getUps = 0; this.lastFall = ''; this.lastGetUp = ''; this.lastFlinch = '';
    this.canTrip = !this.isPlayer;
    this.canSlam = true;
    // tambaleo: pasos reales en la dirección del empujón
    this.stumbleT = 0; this.stumbleDur = 0; this.stumbleX = 0; this.stumbleZ = 1; this.stumbleV = 0; this.stumbles = 0;
    this.spin = 0;         // giro sobre sí mismo (rad/s) por un tiro en el hombro, decae

    // ── salto: arco balístico que ancla la pose, PD con velocidad objetivo ───
    this.flight = null;      // {t, dur, v0, y0, vx, vz, style, s, ph, land, target}
    this.jumpPrep = null;  // agachado previo: {t, dur, then: opciones del salto}
    this.tgtVY = 0;        // velocidad vertical objetivo del PD (0 salvo saltando)
    this.jumps = 0; this.lastJump = ''; this.hops = 0; this.pounces = 0; this.wallKicks = 0;
    this.airPeak = 0;      // altura máxima de la cadera sobre el piso en el último vuelo
    this.landT = 0;        // tiempo desde el último aterrizaje
    // ── ancla de la pose (por defecto la cadera; rodando, el centro) ─────────
    this.anchorX = 0; this.anchorZ = 0;
    // ── movimientos, bajadas, trepadas por estilo ────────────────────────────
    this.moves = 0; this.lastMove = ''; this.rolls = 0;
    this.descents = 0; this.lastDescent = ''; this.edgeCool = 0;
    this.vaultDef = null; this.lastVault = ''; this.vaultFails = 0;
    this.woundOv = null;   // herida sostenida: {def, t, k, ctx, life}
    // ── empuje pedido mientras está en el piso / levantándose (jugador ágil) ─
    this.driveX = 0; this.driveZ = 0; this.driveV = 0;
    this.scrambleCool = 0; this.rollChain = 0;

    // ── raíz virtual ────────────────────────────────────────────────────────
    this.rootX = x; this.rootZ = z;
    this.rootVX = 0; this.rootVZ = 0;
    this.leash = 0.30;
    this._hx = x; this._hz = z;          // cadera del frame anterior

    // ── personalidad + estilo de marcha ─────────────────────────────────────
    const runS = opt.runStyle ?? RUN_STYLES[Math.floor(R() * RUN_STYLES.length)];
    const walkS = opt.walkStyle ?? WALK_STYLES[Math.floor(R() * WALK_STYLES.length)];
    this.runStyle = runS; this.walkStyle = walkS;
    this.pers = {
      phaseOff: R() * TAU,
      lean: (R() - 0.5) * 0.10,
      sway: walkS.sway ?? (0.6 + R() * 0.9),
      headTilt: walkS.headTilt ?? (R() - 0.5) * 0.30,
      headBob: 0.5 + R(),
      limp: walkS.limp ?? (R() < 0.3 ? 0.4 + R() * 0.4 : 1),   // una pierna con menos amplitud
      limpSide: R() < 0.5 ? 0 : 1,
      armHi: (R() - 0.5) * 0.22,
      armSpread: 0.8 + R() * 0.5,
      wobble: walkS.wobble ?? (0.4 + R() * 1.2),
      lurch: walkS.lurch ?? (R() < 0.3 ? 0.3 + R() * 0.5 : 0),   // cadencia irregular
      hunch: R() * 0.04,
      armAsym: R() < 0.3 ? (R() < 0.5 ? 0 : 1) : -1,   // un brazo más vago
      jitter: walkS.jitter ?? R() * 0.6,
      dragLeg: walkS.dragLeg ?? 0,
      w: walkS, r: runS,
    };
    // el jugador apunta; el resto lleva los brazos según su estilo
    this.armMode = opt.armMode ?? 'reach';
    this.styledArms = this.armMode !== 'aim';

    // marco del cuerpo (se recalcula 1× por frame)
    this.fx = 0; this.fy = 0; this.fz = 1;
    this.rx = 1; this.ry = 0; this.rz = 0;
    this.ux = 0; this.uy = 1; this.uz = 0;

    // ── rasgos: quién pega saltitos, quién hace parkour, cuán ágil es ────────
    //  agility 0..1 pesa en todo lo que sea "atlético": estilo de trepada,
    //  rodar al caer, atrapar la pared con las manos en vez de estrellarse.
    //  (Se sortean al final: así un cuerpo sin rasgos consume los mismos
    //  números que antes y las pruebas con semilla fija no cambian.)
    const tr = opt.traits || {};
    this.traits = {
      hopper: !!tr.hopper, parkour: !!tr.parkour,
      agility: tr.agility ?? (this.isPlayer ? 0.95 : this.kind === 'runner' ? 0.6 : this.kind === 'jogger' ? 0.4 : this.kind === 'brute' ? 0.1 : 0.2),
      hopStyle: tr.hopStyle || (tr.hopper ? HOP_STYLES[Math.floor(R() * HOP_STYLES.length)] : 'hop'),
    };
    if (this.traits.parkour) this.traits.agility = Math.max(this.traits.agility, 0.85);
    this.agile = this.isPlayer || this.traits.parkour;

    this._dtLast = 0;
    this.target = new Float32Array(NP * 3);
    this._tA = new Float32Array(NP * 3); this._tB = new Float32Array(NP * 3); this._tU = new Float32Array(NP * 3);
    this._syncTarget(0);

    w.bodies.push(this);
  }

  _rest(ia, ib) {
    const S = this.scale;
    const dx = (POSE[ib * 3] - POSE[ia * 3]) * S;
    const dy = (POSE[ib * 3 + 1] - POSE[ia * 3 + 1]) * S;
    const dz = (POSE[ib * 3 + 2] - POSE[ia * 3 + 2]) * S;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // ═══ consultas ════════════════════════════════════════════════════════════
  px(i) { return this.world.px[this.p[i]]; }
  py(i) { return this.world.py[this.p[i]]; }
  pz(i) { return this.world.pz[this.p[i]]; }
  get x() { return this.world.px[this.p[HIP]]; }
  get y() { return this.world.py[this.p[HIP]]; }
  get z() { return this.world.pz[this.p[HIP]]; }
  centerY() { return (this.py(CHEST) + this.py(HIP)) * 0.5; }
  /** ¿Está de pie? Un ragdoll tirado tiene el pecho cerca del piso. */
  get upright() {
    const dy = this.py(CHEST) - this.py(HIP);
    return dy > 0.20 * this.scale;
  }
  /** ¿Tiene el control de su cuerpo? (no está muerto, cayendo, tirado, levantándose ni tambaleando) */
  get inControl() { return !this.dead && this.dying <= 0 && this.limp <= 0 && this.state === 'up' && this.stumbleT <= 0 && !this.flight && !this.jumpPrep; }
  /** ¿Está en el aire por un salto (o por agacharse a saltar)? */
  get jumping() { return !!(this.flight || this.jumpPrep); }
  /** Nombre del movimiento en curso (para depurar / pruebas). */
  get moveName() {
    if (this.seq) return this.seq.def.name;
    if (this.flight) return 'jump_' + this.flight.style;
    if (this.jumpPrep) return 'prep_' + this.jumpPrep.style;
    if (this.vault) return (this.vault.kind === 'descent' ? 'down_' : 'vault_') + this.vault.style;
    return this.stumbleT > 0 ? 'stumble' : (this.overlay ? this.overlay.def.name : '');
  }
  /** Parámetro de estilo mezclado caminar→correr según la marcha. */
  _sp(key, def = 0) { const w = this.pers.w[key], r = this.pers.r[key]; return lerp(w ?? def, r ?? def, this.gait); }

  // ═══ actualización por frame (no por substep) ═════════════════════════════
  update(dt) {
    const w = this.world;
    this._dtLast = dt;

    // — marco del cuerpo, de las propias partículas —
    let ux = this.px(CHEST) - this.px(HIP), uy = this.py(CHEST) - this.py(HIP), uz = this.pz(CHEST) - this.pz(HIP);
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-4) { ux = 0; uy = 1; uz = 0; ul = 1; }
    ux /= ul; uy /= ul; uz /= ul;
    let rx = this.px(HPR) - this.px(HPL), ry = this.py(HPR) - this.py(HPL), rz = this.pz(HPR) - this.pz(HPL);
    const d = rx * ux + ry * uy + rz * uz;
    rx -= ux * d; ry -= uy * d; rz -= uz * d;
    let rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-4) { rx = 1; ry = 0; rz = 0; rl = 1; }
    rx /= rl; ry /= rl; rz /= rl;
    this.ux = ux; this.uy = uy; this.uz = uz;
    this.rx = rx; this.ry = ry; this.rz = rz;
    this.fx = ry * uz - rz * uy;
    this.fy = rz * ux - rx * uz;
    this.fz = rx * uy - ry * ux;

    if (this.dead) { this.deadT += dt; return; }

    const hipP = this.p[HIP];
    const hx = w.px[hipP], hz = w.pz[hipP];

    // — altura del piso justo debajo de la cadera. Trepando o bajando la marca
    //   el guion del estilo; saltando, el ARCO BALÍSTICO del salto (nunca por
    //   debajo del piso que hay abajo: así se aterriza encima de un escritorio
    //   o se baja de uno y la pose acompaña al cuerpo en vez de tirar de él) —
    {
      const t = w.raycastStatic(hx, w.py[hipP] + 0.1, hz, 0, -1, 0, 3.2 * this.scale, _out);
      const floorY = t >= 0 ? _out.y : (Math.abs(hx) < w.groundHX && Math.abs(hz) < w.groundHZ ? w.groundY : -999);
      this.floorY = floorY;
      if (this.vault) {
        const V = this.vault, u = clamp01(V.t / V.dur);
        if (V.kind === 'descent') {
          // bajando, la altura sigue al AVANCE: el ancla recién baja cuando la raíz pasó el borde
          const f = V.def.trv(u, V), k = clamp01((f - V.edgeF) / Math.max(0.05, 1 - V.edgeF));
          this.groundY = lerp(V.y0, V.y1, k * k * (3 - 2 * k));
        } else this.groundY = lerp(V.y0, V.y1, V.def ? V.def.hgt(u) : clamp01((u - 0.3) / 0.4));
        this.tgtVY = 0;
      } else if (this.flight) {
        const J = this.flight;
        const arc = J.v0 * J.t + 0.5 * w.gravity * J.t * J.t;
        this.groundY = Math.max(floorY, J.y0 + arc);
        this.tgtVY = J.v0 + w.gravity * J.t;
        this.airPeak = Math.max(this.airPeak, w.py[hipP] - J.y0 - POSE[HIP * 3 + 1] * this.scale);
      } else {
        this.groundY = floorY;
        this.tgtVY = 0;
      }
    }

    // — ¿algún pie apoyado? —
    const grounded = (w.pf[this.p[FTL]] & PF_GROUND) || (w.pf[this.p[FTR]] & PF_GROUND) ||
      (w.pf[this.p[KNL]] & PF_GROUND) || (w.pf[this.p[KNR]] & PF_GROUND);
    this.airborne = grounded ? 0 : Math.min(1, this.airborne + dt * 2.5);

    // — agachado previo al salto → despegue; en el aire → aterrizaje —
    this.landT += dt;
    if (this.jumpPrep) {
      const JP = this.jumpPrep;
      JP.t += dt;
      if (JP.t >= JP.dur) { this.jumpPrep = null; this._takeoff(JP); }
    }
    if (this.flight) {
      const J = this.flight;
      J.t += dt;
      const arc = J.v0 * J.t + 0.5 * w.gravity * J.t * J.t;
      const landed = J.t > 0.10 && (J.y0 + arc <= this.floorY + 0.02 || (grounded && J.t > J.dur * 0.6));
      if (landed || J.t > J.dur + 0.7) this._land(J);
    }
    if (this.edgeCool > 0) this.edgeCool -= dt;
    if (this.scrambleCool > 0) this.scrambleCool -= dt;

    if (this.stagger > 0) this.stagger = Math.max(0, this.stagger - dt);
    if (this.lunge > 0) this.lunge = Math.max(0, this.lunge - dt);
    if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - dt * 7);
    this.hitJ *= Math.exp(-dt * 6);
    if (this.spin) { if (!this.lockYaw) this.yaw += this.spin * dt; this.spin *= Math.exp(-dt * 5); if (Math.abs(this.spin) < 0.05) this.spin = 0; }
    // — cuánto está girando (rad/s, suavizado): para inclinarse en las curvas y
    //   dar pasitos al pivotar en el lugar —
    if (dt > 0) {
      const raw = angDelta(this._prevYaw ?? this.yaw, this.yaw) / dt;
      this.yawRate = (this.yawRate || 0) + (clamp(raw, -12, 12) - (this.yawRate || 0)) * (1 - Math.pow(0.01, dt));
    }

    // — heridas: los miembros recuperan fuerza hasta su piso; pierna doblada, brazo colgando —
    const mus = this.muscle, floor = this.muscleFloor, LM = this.limbMul;
    for (let i = 0; i < NP; i++) if (mus[i] < floor[i]) mus[i] = Math.min(floor[i], mus[i] + dt * 0.5);
    LM.fill(1);
    if (this.pers.armAsym >= 0) { const s2 = this.pers.armAsym; LM[s2 ? ELR : ELL] = 0.45; LM[s2 ? HAR : HAL] = 0.45; }
    // estilo con los brazos sin músculo (cuelgan de verdad): sólo de pie y con la marcha
    if (this.state === 'up' && !this.overlay && !this.flight) {
      const am = this._sp('armMuscle', 1);
      if (am < 0.999) { LM[ELL] *= am; LM[ELR] *= am; LM[HAL] *= am; LM[HAR] *= am; }
    }
    for (let side = 0; side < 2; side++) {
      // un miembro herido va a CERO músculo: en PBD hasta un 4 % es un resorte
      // fuerte (la corrección de posición se vuelve velocidad) y el brazo
      // "flotaba" en vez de colgar
      if (this.legBuckle[side] > 0) {
        this.legBuckle[side] -= dt;
        LM[side ? HPR : HPL] = 0.15; LM[side ? KNR : KNL] = 0; LM[side ? FTR : FTL] = 0;
      }
      if (this.armLimp[side] > 0) {
        this.armLimp[side] -= dt;
        LM[side ? ELR : ELL] = 0; LM[side ? HAR : HAL] = 0;
      }
    }

    // — la máquina de estados: caídas, tirado, levantadas, descanso —
    this._stateStep(dt);
    const up = this.state === 'up';
    const control = up && this.limp <= 0 && !this.flight && !this.jumpPrep;
    const stumbling = this.stumbleT > 0;
    // — herida sostenida: entra en 0,25 s, se queda `life` segundos y se va —
    if (this.woundOv) {
      const Wd = this.woundOv;
      Wd.life -= dt;
      Wd.k += ((Wd.life > 0.4 ? 1 : 0) - Wd.k) * (1 - Math.pow(0.02, dt));
      if (Wd.life <= 0 || !up) this.woundOv = null;
    }
    if (this.seq) {
      const S = this.seq;
      if (S.legs < 0.999) { LM[HPL] *= S.legs; LM[HPR] *= S.legs; LM[KNL] *= S.legs; LM[KNR] *= S.legs; LM[FTL] *= S.legs; LM[FTR] *= S.legs; }
      if (S.arms < 0.999) { LM[ELL] *= S.arms; LM[ELR] *= S.arms; LM[HAL] *= S.arms; LM[HAR] *= S.arms; }
    }

    // — orientación: girar hacia donde quiere ir —
    if (!this.lockYaw && this.wantSpeed > 0.05 && control && !stumbling) {
      // algunos corren medio de costado (estilo `yawOff`): el cuerpo mira desviado de donde va
      const goal = Math.atan2(this.wantX, this.wantZ) + this._sp('yawOff');
      const turn = (this.crawling ? 2.2 : (4.5 + this.gait * 2.5)) * dt;
      this.yaw += clamp(angDelta(this.yaw, goal), -turn, turn);
    }

    this.rootBlocked = false;
    // — velocidad con inercia: no se pasa de 0 a tope en un frame. Acelera a
    //   ~9 m/s² y frena a ~14: arrancar y parar toman tiempo (menos robótico) y
    //   dejan ver la inclinación. curSpeed es la que de verdad mueve al cuerpo. —
    {
      // agachándose para saltar no frena (el brinco es parte de la carrera); en
      // el aire la velocidad es la del salto
      const tgt = (control || this.jumpPrep) && !stumbling ? this.wantSpeed : (this.flight ? Math.hypot(this.flight.vx, this.flight.vz) : 0);
      const rate = (tgt > this.curSpeed ? 9 : 14) * dt;
      this.curSpeed += clamp(tgt - this.curSpeed, -rate, rate);
      if (this.flight) this.curSpeed = tgt;
    }
    // — trepando: la raíz sigue un guion (adelante y arriba), nada de IA —
    if (this.vault) {
      const V = this.vault;
      V.t += dt;
      const u = clamp01(V.t / V.dur);
      const e = V.def ? V.def.trv(u, V) : u * u * (3 - 2 * u);
      this.rootX = V.x0 + V.dx * V.travel * e;
      this.rootZ = V.z0 + V.dz * V.travel * e;
      if (u >= 1) {
        if (V.kind === 'descent') { this.landCrouch = Math.max(this.landCrouch, 0.3); this.landT = 0; }
        this.vault = null;
      }
    }
    // La raíz NO se mueve acá de un salto: se decide cuánto puede avanzar y el
    // avance se reparte por substep en preSolve (movimiento continuo: el
    // músculo no tiene que alcanzar un objetivo que salta 2 cm por frame).
    this.rootVX = 0; this.rootVZ = 0;
    if (this.flight && up) {
      // — EN EL AIRE: la raíz vuela con la velocidad del salto. El jugador
      //   tiene un poco de control en el aire; el resto va adonde saltó —
      const J = this.flight;
      if (this.isPlayer && this.wantSpeed > 0.1) {
        const k = 2.5 * dt;
        J.vx += (this.wantX * this.wantSpeed - J.vx) * k; J.vz += (this.wantZ * this.wantSpeed - J.vz) * k;
      }
      this.rootVX = J.vx; this.rootVZ = J.vz;
    } else if (this.jumpPrep && up) {
      // agachándose para saltar: sigue moviéndose a la velocidad que traía
      this.rootVX = this.wantX * this.curSpeed; this.rootVZ = this.wantZ * this.curSpeed;
    } else if (stumbling && up) {
      // — TAMBALEO: la raíz se va con el empujón y las piernas la siguen a
      //   los pasos. La velocidad decae; queda DESPLAZADO (no vuelve) —
      this.stumbleT -= dt;
      const v = this.stumbleV * clamp01(this.stumbleT / this.stumbleDur);
      this.rootVX = this.stumbleX * v; this.rootVZ = this.stumbleZ * v;
      this.curSpeed = v;
      if (this.stumbleT <= 0) { this.stumbleT = 0; this.curSpeed = 0; }
    } else if (this.wantSpeed > 0.01 && control && !this.vault) {
      const step = this.curSpeed * dt;
      const nx = this.rootX + this.wantX * step, nz = this.rootZ + this.wantZ * step;
      // La raíz NO entra en otro cuerpo que esté de pie: si no, dos cuerpos
      // cinemáticos se funden y pasan uno a través del otro. Así un corredor
      // que embiste a otro se frena (y si venía rápido, se estrella), y una
      // fila de zombis se embotella en vez de superponerse.
      const bodies = w.bodies;
      let blocker = null;
      for (let i = 0; i < bodies.length; i++) {
        const o = bodies[i];
        if (o === this || !o.p || o.dead || o.state !== 'up' || typeof o.knockback !== 'function' || !o.upright) continue;
        const dx = o.x - nx, dz = o.z - nz;
        const rr = 0.42 * (this.scale + o.scale) * 0.5;
        if (dx * dx + dz * dz > rr * rr) continue;
        if (dx * this.wantX + dz * this.wantZ > 0) { blocker = o; break; }
      }
      if (!blocker) { this.rootVX = this.wantX * this.curSpeed; this.rootVZ = this.wantZ * this.curSpeed; }
      else {
        // bloqueado: seguir a la velocidad del de adelante en su dirección y
        // resbalar por la tangente, como una multitud que se escurre alrededor
        let bx = blocker.x - this.rootX, bz = blocker.z - this.rootZ;
        const bl = Math.hypot(bx, bz) || 1; bx /= bl; bz /= bl;
        const dot = this.wantX * bx + this.wantZ * bz;
        let tx = this.wantX - bx * dot, tz = this.wantZ - bz * dot;
        const tl = Math.hypot(tx, tz);
        if (tl > 0.05) { tx /= tl; tz /= tl; this.rootX += tx * step * 0.8; this.rootZ += tz * step * 0.8; }
        const follow = Math.min(step, Math.max(0, blocker.wantSpeed || 0) * dt) * Math.max(0, dot);
        this.rootX += this.wantX * follow; this.rootZ += this.wantZ * follow;
        this.rootBlocked = true;
        // choque a la carrera contra alguien de pie: variantes según velocidad
        // y ángulo — un hombrazo lo hace girar, un choque de frente tira a
        // los dos, por la espalda el de adelante cae de boca y yo me tropiezo
        if (this.bumpCool > 0) this.bumpCool -= dt;
        if (this.speed > 2.3 && this.bumpCool <= 0 && blocker.inControl) {
          this.bumpCool = 1.0;
          this.bumps = (this.bumps || 0) + 1;
          this._bumpInto(blocker, bx, bz);
        }
      }
    }
    const lx0 = this.rootX - hx, lz0 = this.rootZ - hz;
    const ld = Math.hypot(lx0, lz0);
    if (up) {
      const leash = (this.wantSpeed > 0.01 || stumbling ? this.leash : this.leash * 3.5) * this.scale;
      // — empujón externo: si la cadera se fue MUCHO más allá de la correa en
      //   un solo frame, lo empujaron fuerte (multitud, escopeta) → tambalea o cae
      if (control && this.upright && ld > leash + 0.07) {
        const over = ld - leash;
        this.stagger = Math.min(0.9, this.stagger + over * 2.5);
        if (over > 0.16) this.fall('knockback', hx - this.rootX, hz - this.rootZ, 1.2 + over);
        else if (!stumbling) this.stumble(hx - this.rootX, hz - this.rootZ, 1.2 + over * 4, 0.35);
      }
      if (ld > leash) {
        const f = leash / ld;
        this.rootX = hx + lx0 * f;
        this.rootZ = hz + lz0 * f;
      }
    } else if (this.state === 'down') {
      // tirado la raíz va con el cuerpo: nada tira de él
      this.rootX = hx; this.rootZ = hz;
    }
    // La raíz nunca queda del otro lado de una pared: si no, los músculos
    // tirarían del cuerpo a través de ella (y lo lograrían). Si lo que frena
    // es bajo (escritorio, mesa, caja grande), se trepa.
    if (!this.vault && up) {
      const rx2 = this.rootX - hx, rz2 = this.rootZ - hz;
      const rd = Math.hypot(rx2, rz2);
      // mira hacia la raíz si está adelantada; si no, hacia donde quiere ir
      let ddx = 0, ddz = 0;
      if (rd > 0.04) { ddx = rx2 / rd; ddz = rz2 / rd; }
      else if (stumbling) { ddx = this.stumbleX; ddz = this.stumbleZ; }
      else if (this.wantSpeed > 0.05 && control) { ddx = this.wantX; ddz = this.wantZ; }
      if (ddx || ddz) {
        const reach = Math.max(rd, 0.25) + 0.2;
        const tt0 = w.raycastStatic(hx, w.py[hipP], hz, ddx, 0, ddz, reach, _out);
        if (tt0 >= 0 && tt0 < reach) {
          if (rd > 0.04) {
            const tt = Math.max(0, tt0 - 0.22);
            this.rootX = hx + ddx * Math.min(tt, rd);
            this.rootZ = hz + ddz * Math.min(tt, rd);
          }
          if (tt0 < 0.26) { this.rootVX = 0; this.rootVZ = 0; }   // pegado a la pared: no empujar más
        }
      }
      // trepar: un probe BAJO (a la altura de las rodillas) hacia adelante, que
      // sí ve un escritorio o una mesa (el probe de pared va a la altura de la
      // cadera y pasa por encima de los muebles bajos)
      if (this.autoVault && control && !stumbling && this.upright && this.wantSpeed > 0.4) {
        const gy = this.groundY > -900 ? this.groundY : 0;
        // los que hacen parkour ven el obstáculo desde más lejos (arrancan la trepada a la carrera)
        const reachV = (this.traits.parkour ? 1.0 : 0.7) * this.scale;
        const t2 = w.raycastStatic(hx, gy + 0.35 * this.scale, hz, this.wantX, 0, this.wantZ, reachV, _out);
        if (t2 >= 0 && _out.box) this.tryVault(this.wantX, this.wantZ);
      }
      // — BAJAR: si medio metro adelante el piso cae más de 40 cm (el borde de
      //   un escritorio, una mesa), elegir CÓMO bajar según quién es —
      if (control && !stumbling && this.upright && this.wantSpeed > 0.3 && this.edgeCool <= 0 && this.groundY > -900 && this.groundY > w.groundY + 0.3) {
        const ax = hx + this.wantX * 0.45 * this.scale, az = hz + this.wantZ * 0.45 * this.scale;
        const ta = w.raycastStatic(ax, this.groundY + 0.05, az, 0, -1, 0, 3.0, _out);
        const yA = ta >= 0 ? _out.y : (Math.abs(ax) < w.groundHX && Math.abs(az) < w.groundHZ ? w.groundY : this.groundY);
        const drop = this.groundY - yA;
        if (drop > 0.40 * this.scale && drop < 2.2) {
          // ¿a qué distancia exacta está el borde? (rayos cada 9 cm)
          let edge = 0.45 * this.scale;
          for (let k = 1; k <= 4; k++) {
            const d = k * 0.09 * this.scale;
            const tb = w.raycastStatic(hx + this.wantX * d, this.groundY + 0.05, hz + this.wantZ * d, 0, -1, 0, 3.0, _out);
            const yb = tb >= 0 ? _out.y : w.groundY;
            if (this.groundY - yb > 0.3) { edge = d; break; }
          }
          this._atEdge(drop, this.wantX, this.wantZ, edge);
        }
      }
    }

    // — velocidad real horizontal de la cadera, para sincronizar el paso.
    //   Por DESPLAZAMIENTO, no por la variable de velocidad: esa queda con el
    //   valor del último substep y subestima (1.1 cuando avanza a 1.4) —
    const vx = w.vx[hipP], vz = w.vz[hipP];
    const raw = dt > 0 ? Math.hypot(hx - this._hx, hz - this._hz) / dt : 0;
    this.speed = lerp(this.speed, Math.min(raw, 12), 1 - Math.pow(0.02, dt));
    // — inclinarse hacia el ESFUERZO (Overgrowth): la diferencia entre la
    //   velocidad que pide y la que tiene. Grande al arrancar (se echa
    //   adelante), negativa al frenar (se echa atrás), y cuando choca contra
    //   algo (empuja). Es más estable y más visible que derivar la velocidad. —
    if (dt > 0) {
      const kA = 1 - Math.pow(0.02, dt);
      // sólo cuando trata de moverse: parado y empujado NO se inclina contra el
      // empujón (si no, el músculo lo trae de vuelta y anula el knockback)
      const moving2 = control && !stumbling && (this.wantSpeed > 0.1 || this.curSpeed > 0.1);
      const ex = moving2 ? this.wantX * this.wantSpeed - vx : 0;
      const ez = moving2 ? this.wantZ * this.wantSpeed - vz : 0;
      this.accX += (clamp(ex * 4.5, -14, 14) - this.accX) * kA;
      this.accZ += (clamp(ez * 4.5, -14, 14) - this.accZ) * kA;
    }
    this._vpx = vx; this._vpz = vz;
    // — aterrizaje: después de un vuelo, las rodillas absorben —
    if (this.airborne > 0) this.airT += dt;
    else { if (this.airT > 0.12) this.landCrouch = Math.min(0.55, 0.12 + this.airT * 0.5); this.airT = 0; }
    if (this.landCrouch > 0) this.landCrouch -= dt;
    // — agacharse (jugador): mezcla suave —
    this.crouch += ((this.wantCrouch ? 1 : 0) - this.crouch) * (1 - Math.pow(0.002, dt));
    // — prepararse al caer: si va de cabeza al piso, los brazos salen a frenar —
    const braceOK = !this.seq || this.seq.def.brace !== false;
    if (!this.dead && braceOK && (this.limp > 0 || this.state === 'falling' || this.state === 'down')) {
      const vyC = w.vy[this.p[CHEST]];
      if (this.brace <= 0 && vyC < -1.0 && this.py(HEAD) < 1.35 && this.py(HEAD) > 0.45) this.brace = 0.5;
    }
    if (!braceOK) this.brace = 0;
    if (this.brace > 0) this.brace -= dt;

    // — ESTRELLARSE: venía corriendo DE VERDAD y de golpe no avanza (pared,
    //   mueble, otro cuerpo). El torso sigue con su inercia, sin músculos.
    if (this.slamCool > 0) this.slamCool -= dt;
    if (this.canSlam && control && !stumbling && this.upright && !this.rootBlocked && !this.vault && this.wantSpeed > 2.0 && this.lunge <= 0 && this.slamCool <= 0 && dt > 0) {
      const adv = ((hx - this._hx) * this.wantX + (hz - this._hz) * this.wantZ) / dt;
      if (adv < this.wantSpeed * 0.35 && this.speed > 1.8) this.blockT += dt; else this.blockT = 0;
      if (this.blockT > 0.05) {
        this.blockT = 0;
        this.slam(this.wantX, this.wantZ, this.speed);
      }
    } else this.blockT = 0;
    this._hx = hx; this._hz = hz;

    // — tropiezo: un pie o una rodilla CHOCA con algo que no es piso (el
    //   costado de una caja, un cadáver, la pierna de otro) y queda trabado
    //   atrás mientras el torso sigue. Hace falta el contacto: en piso liso los
    //   pies se atrasan solos al correr y eso no es tropezar.
    //   (trepando o saltando los pies tocan cosas a propósito: ahí no se evalúa)
    if (this.canTrip && this.wantSpeed > 0.5 && this.upright && control && !stumbling && !this.crawling && !this.vault && this.landT > 0.25) {
      let contact = false;
      for (const i of [FTL, FTR, KNL, KNR]) {
        const f = w.pf[this.p[i]];
        if ((f & PF_HIT) && !(f & PF_GROUND)) { contact = true; break; }
      }
      let lag = 0;
      if (contact) {
        const c0 = Math.cos(this.yaw), s0 = Math.sin(this.yaw);
        const T = this.target;
        const baseY = this.groundY > -900 ? this.groundY : 0;
        for (const f of [FTL, FTR]) {
          const lx = T[f * 3] - T[HIP * 3], lz = T[f * 3 + 2] - T[HIP * 3 + 2];
          const tx = this.rootX + lx * c0 + lz * s0, tz = this.rootZ - lx * s0 + lz * c0;
          const ty = baseY + T[f * 3 + 1];
          lag = Math.max(lag, Math.hypot(tx - this.px(f), ty - this.py(f), tz - this.pz(f)));
        }
      }
      const hipLag = Math.hypot(this.rootX - hx, this.rootZ - hz);
      const lagThr = 0.28 * this.scale, timeThr = 0.20 - 0.08 * this.gait;
      if (contact && lag > lagThr && hipLag < 0.25 * this.scale) this.tripT += dt; else this.tripT = Math.max(0, this.tripT - dt * 2);
      if (this.tripT > timeThr) {
        this.tripT = 0;
        this.tripped++;
        this.fall('trip', this.fx, this.fz, 0.8 + this.speed * 0.15);
      }
    } else this.tripT = 0;

    // — fase del ciclo: avanza con la distancia recorrida, no con el tiempo —
    const v = stumbling ? this.curSpeed : Math.max(this.speed, this.wantSpeed * 0.6);
    this.gait = lerp(this.gait, stumbling ? 0.5 : clamp01((v - 0.7) / 2.3), 1 - Math.pow(0.05, dt));
    // un ciclo cubre 4 zancadas (el pie en apoyo va de +st a -st mientras el
    // cuerpo avanza 2·st, dos veces): así el pie apoyado no patina
    const st = this.stride * this.scale * lerp(0.8, 2.0, this.gait) * (stumbling ? 0.7 : 1);
    const strideLen = Math.max(0.12, st * 4);
    let cadence = this.speed / strideLen;
    if (this.pers.lurch && this.gait < 0.5) cadence *= 1 + Math.sin(this.phase * 0.5) * this.pers.lurch * 0.5;
    const idle = this.wantSpeed > 0.05 || stumbling ? 0.35 : 0.13;
    // pivotando en el lugar los pies dan pasitos (la fase avanza aunque no se traslade)
    const pivotCad = this.state === 'up' && Math.abs(this.yawRate || 0) > 1.2 && this.speed < 0.8 ? clamp01((Math.abs(this.yawRate) - 1.2) / 3) * 1.3 : 0;
    this.phase = (this.phase + (cadence + idle + pivotCad) * TAU * dt) % TAU;
    this.idleT += dt;

    // — de pie y se cayó sin director (lo aplastaron, lo pisaron, física pura):
    //   pasa a tirado y se levantará —
    this.upT = this.upright ? this.upT + dt : 0;
    // (trepando de panza o volando en plancha el torso va horizontal a propósito: no cuenta)
    if (up && !this.crawling && !this.vault && !this.flight) {
      if (!this.upright) { this.downT += dt; if (this.downT > 0.25) this._enterDown(false, 'physics'); }
      else this.downT = 0;
    }

    // — tics de quieto (bucle): se sortea uno cada tanto, se apaga al moverse —
    if (up && !stumbling && this.styledArms && !this.overlay) {
      if (this.wantSpeed < 0.05 && this.speed < 0.3) {
        if (!this.idleOv) { this.idleNext -= dt; if (this.idleNext <= 0) { const R = this.rng || Math.random; this.idleOv = { def: OVER[IDLE_OVERLAYS[Math.floor(R() * IDLE_OVERLAYS.length)]], t: 0, k: 1 }; this.idleNext = 2 + R() * 5; } }
      } else this.idleOv = null;
    } else this.idleOv = null;

    // — músculo global —
    let m = 1;
    if (this.seq) {
      m = this.seq.mus;
    } else {
      if (this.stagger > 0) m *= lerp(0.22, 1, 1 - clamp01(this.stagger / 0.55));
      if (stumbling) m *= 0.85;
      if (this.state === 'down') m = 0;                     // tirado: física pura
      if (this.limp > 0) { this.limp -= dt; m = 0; }         // golpe: física pura un instante
      // en el aire no hay de dónde hacer fuerza… salvo que el vuelo sea a
      // propósito (salto, trepada): ahí el cuerpo sostiene su figura
      if (!this.flight && !this.vault) m *= 1 - this.airborne * 0.55;
    }
    this.muscleGlobal = m;

    this._syncTarget(dt);
    // — cayendo o muriendo la pose se ancla al PECHO, no a la cadera: el torso
    //   vuela con el impulso que recibió y las piernas lo siguen. Anclada a la
    //   cadera, el músculo tiraba del pecho de vuelta y anulaba el golpe —
    if (this.state === 'falling' || this.state === 'dying') {
      // ancla en el CENTRO DE MASA: la pose se arma alrededor de donde está el
      // cuerpo de verdad, así el músculo da forma sin empujar el conjunto (la
      // suma de los tirones es cero) y el momento que traía se conserva
      const T = this.target, c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      let mx = 0, mz = 0, lx = 0, lz = 0, mt = 0;
      for (let i = 0; i < NP; i++) {
        const pi = this.p[i]; if (w.iw[pi] === 0) continue;
        const mi = MASS[i];
        mx += w.px[pi] * mi; mz += w.pz[pi] * mi;
        lx += (T[i * 3] - this.anchorX) * mi; lz += (T[i * 3 + 2] - this.anchorZ) * mi;
        mt += mi;
      }
      if (mt > 0) {
        mx /= mt; mz /= mt; lx /= mt; lz /= mt;
        this.rootX = mx - (lx * c + lz * s);
        this.rootZ = mz - (-lx * s + lz * c);
      }
    }
    // el empuje desde el piso vale por un frame: hay que pedirlo cada vez
    this.driveV = 0;
    this._prevYaw = this.yaw;
  }

  _daze() {
    const R = this.rng || Math.random;
    const base = this.isPlayer ? 0.28 : this.kind === 'runner' ? 0.35 : this.kind === 'brute' ? 1.3 : this.kind === 'jogger' ? 0.6 : 0.9;
    return base * (0.7 + R() * 0.7) * (1 + this.pers.wobble * 0.15) * (this.traits.parkour ? 0.6 : 1);
  }

  // ═══ máquina de estados y secuencias ══════════════════════════════════════
  _stateStep(dt) {
    const w = this.world;
    const S = this.seq;
    if (S) {
      const def = S.def, keys = def.keys;
      S.t += dt;
      // avanzar de clave: al ENTRAR a una clave se aplican su giro de marco y su patada
      while (S.key + 1 < keys.length && S.t >= keys[S.key + 1].t) {
        S.key++;
        const k = keys[S.key];
        if (S.pendingYaw) { this._reframe(S.pendingYaw); S.pendingYaw = 0; }
        if (k.kick) this._kick(k.kick);
        // la clave siguiente pide un giro de marco: se calcula ahora (con el
        // cuerpo como está) y se aplica cuando se llegue a ella
        const nk = keys[S.key + 1];
        S.pendingYaw = nk && nk.yawAdd ? this._yawDelta(nk.yawAdd) : 0;
      }
      if (S.key < 0) { S.key = 0; const nk = keys[1]; S.pendingYaw = nk && nk.yawAdd ? this._yawDelta(nk.yawAdd) : 0; if (keys[0].kick) this._kick(keys[0].kick); }
      const a = keys[S.key], b = keys[Math.min(S.key + 1, keys.length - 1)];
      const span = Math.max(1e-4, b.t - a.t);
      const u = b === a ? 1 : clamp01((S.t - a.t) / span);
      S.u = u;
      S.mus = lerp(a.mus ?? 1, b.mus ?? 1, u);
      S.legs = lerp(a.legs ?? 1, b.legs ?? 1, u);
      S.arms = lerp(a.arms ?? 1, b.arms ?? 1, u);
      S.fwd = lerp(a.fwd ?? 0, b.fwd ?? 0, u);
      // lateral (+X local = derecha): el signo lo da el lado del movimiento
      S.lat = lerp(a.lat ?? 0, b.lat ?? 0, u) * (S.ctx.s ? -1 : 1);
      // empuje pedido desde afuera mientras está en el piso (el jugador ágil
      // que se arrastra hacia donde aprieta): se suma al avance de la secuencia
      let dvx = 0, dvz = 0;
      if (this.driveV > 0 && (def.kind === 'getup' || def.kind === 'move')) {
        const k = def.kind === 'move' ? 1 : 0.55;
        dvx = this.driveX * this.driveV * k; dvz = this.driveZ * this.driveV * k;
      }
      if (S.fwd || S.lat || dvx || dvz) {
        // la raíz avanza (+Z local, +X local y empuje), sin cruzar paredes
        const sx = Math.sin(this.yaw), cz = Math.cos(this.yaw);
        const mx = sx * S.fwd + cz * S.lat + dvx, mz = cz * S.fwd - sx * S.lat + dvz;
        const ml = Math.hypot(mx, mz);
        if (ml > 1e-4) {
          const step = ml * dt, ux = mx / ml, uz = mz / ml;
          const t = w.raycastStatic(this.rootX, this.py(HIP) + 0.2, this.rootZ, ux, 0, uz, step + 0.35, _out);
          if (t < 0 || t > step + 0.3) { this.rootX += ux * step; this.rootZ += uz * step; }
        }
        S.vx = mx; S.vz = mz;
      } else { S.vx = 0; S.vz = 0; }
      // ¿se aquietó? (para cerrar caídas y muertes antes de tiempo)
      const settled = () => {
        const vc = Math.hypot(w.vx[this.p[CHEST]], w.vy[this.p[CHEST]], w.vz[this.p[CHEST]]);
        const vh = Math.hypot(w.vx[this.p[HIP]], w.vy[this.p[HIP]], w.vz[this.p[HIP]]);
        return vc < 0.5 && vh < 0.5;
      };
      if (def.kind === 'fall') {
        const low = !this.upright || this.py(HEAD) - (this.groundY > -900 ? this.groundY : 0) < 0.9 * this.scale;
        if (S.t >= def.dur * 1.6 || (S.t >= def.minT && low && settled())) this._enterDown(!!def.quickUp, def.name);
      } else if (def.kind === 'die') {
        if (S.t >= def.dur || (S.t >= def.minT && settled())) this._die();
      } else if (def.kind === 'getup') {
        if (S.t >= def.dur) {
          this.seq = null;
          if (this.upright && this.py(HEAD) - (this.groundY > -900 ? this.groundY : 0) > 1.15 * this.scale) {
            this.state = 'up'; this.getUps++; this.riseTries = 0; this.downT = 0;
            // el ágil se levanta ya firme; el resto, aturdido un instante
            this.stagger = Math.min(0.9, this.stagger + (this.agile ? 0.08 : 0.25));
            // si la levantada ya venía corriendo (gatear y salir), conserva el envión
            if (S.fwd > 1.0) this.curSpeed = Math.min(this.curSpeed + S.fwd, 3.5);
          } else if (++this.riseTries >= 3) {
            // atascado (abajo de algo): que los músculos lo saquen como puedan
            this.state = 'up'; this.riseTries = 0; this.downT = 0;
          } else this._enterDown(true, 'retry');
        }
      } else if (def.kind === 'move') {
        // un movimiento termina de pie (o tirado si lo pide: rodar de costado)
        if (S.t >= def.dur) {
          this.seq = null;
          if (def.end === 'down') this._enterDown(true, def.name);
          else {
            this.state = 'up'; this.downT = 0;
            if (S.fwd > 0.5) this.curSpeed = Math.min(Math.max(this.curSpeed, S.fwd), 4.5);
            if (!this.upright) this.downT = 0.2;   // no quedó parado: que la física decida y se levante
          }
        }
      }
      // 'rest' no termina solo: lo termina wake()
      return;
    }
    if (this.state === 'down') {
      this.downT += dt;
      // el jugador ágil que aprieta hacia un lado no espera aturdido: rueda o gatea para allá
      if (!this.dormant && this.driveV > 0 && this.downT > 0.12 && this.scrambleCool <= 0 && this.limp <= 0) { this._scrambleFromDown(); return; }
      if (!this.dormant && this.downT >= this.dazeT) this._startGetUp();
    }
  }

  /** Giro de marco pedido por una clave: número (radianes) o 'toHead' / 'toFeet'. */
  _yawDelta(spec) {
    if (typeof spec === 'number') return spec;
    // dirección horizontal de la cabeza (cadera → cabeza)
    let hx = this.px(HEAD) - this.px(HIP), hz = this.pz(HEAD) - this.pz(HIP);
    const l = Math.hypot(hx, hz);
    if (l < 0.05) return 0;
    hx /= l; hz /= l;
    const goal = spec === 'toHead' ? Math.atan2(hx, hz) : Math.atan2(-hx, -hz);
    return angDelta(this.yaw, goal);
  }
  _reframe(dyaw) {
    if (!dyaw) return;
    this.yaw += dyaw;
    this.rootX = this.x; this.rootZ = this.z;
  }
  _kick(list) {
    const w = this.world, c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    for (const [i, vx, vy, vz] of list) {
      const pi = this.p[i];
      if (w.iw[pi] === 0) continue;
      w.vx[pi] += vx * c + vz * s; w.vy[pi] += vy; w.vz[pi] += -vx * s + vz * c;
    }
  }

  /** Arranca una secuencia (caída, levantada, muerte, descanso, movimiento). */
  _playSeq(def, ctx = {}) {
    this.seq = { def, t: 0, key: -1, u: 0, ctx, mus: def.keys[0].mus ?? 1, legs: def.keys[0].legs ?? 1, arms: def.keys[0].arms ?? 1, fwd: 0, lat: 0, vx: 0, vz: 0, pendingYaw: 0 };
    this.overlay = null; this.idleOv = null; this.woundOv = null;
    this.stumbleT = 0; this.limp = 0;
    this.vault = null; this.lunge = 0;
    this.flight = null; this.jumpPrep = null; this.tgtVY = 0;
    this.wantSpeed = 0; this.curSpeed = 0;
    if (def.turn) this._reframe(def.turn);
    if (def.imp) {
      // impulsos en el marco del empujón: [partícula, a lo largo, arriba, lateral]
      let dx = ctx.dx ?? this.fx, dz = ctx.dz ?? this.fz;
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const lx = dz, lz = -dx;                       // la derecha del empujón
      const k = 0.7 + 0.5 * clamp(ctx.power ?? 1, 0.4, 2.4);
      const w = this.world;
      for (const [i, al, upv, lat] of def.imp) {
        const pi = this.p[i];
        if (w.iw[pi] === 0) continue;
        w.vx[pi] += (dx * al + lx * lat) * k; w.vy[pi] += upv * k; w.vz[pi] += (dz * al + lz * lat) * k;
      }
    }
  }

  _enterDown(quick, why) {
    this.seq = null;
    this.state = 'down';
    this.downT = 0;
    this.dazeT = quick ? 0.12 : this._daze();
    this.overlay = null; this.idleOv = null;
    this.stumbleT = 0;
    this.wantSpeed = 0; this.curSpeed = 0;
    this.lastDownWhy = why || '';
  }

  /**
   * Cómo quedó el cuerpo: 'supine' (boca arriba), 'prone' (boca abajo),
   * 'side' (de costado, con `s`: 1 = sobre el lado derecho, cabeza a +X del
   * marco), 'kneel', 'sit' o 'up'.
   */
  orientation() {
    const gy = this.groundY > -900 ? this.groundY : 0;
    const hipH = this.py(HIP) - gy, headH = this.py(HEAD) - gy;
    if (this.uy > 0.55) {
      // el tronco está vertical: ¿parado, arrodillado o sentado?
      if (hipH > 0.72 * this.scale) return { from: 'up', s: 1 };
      if (hipH < 0.36 * this.scale) return { from: 'sit', s: 1 };
      return { from: 'kneel', s: 1 };
    }
    if (headH < 0.6 * this.scale || this.uy < 0.55) {
      if (this.fy > 0.5) return { from: 'supine', s: 1 };
      if (this.fy < -0.5) return { from: 'prone', s: 1 };
      // de costado: la derecha del cuerpo apunta al piso → sobre el lado derecho
      return { from: 'side', s: this.ry < 0 ? 1 : 0 };
    }
    return { from: 'kneel', s: 1 };
  }

  /** Marco para una levantada: +Z local hacia donde va a mirar al pararse. */
  _frameForGetUp(from, s) {
    let hx = this.px(HEAD) - this.px(HIP), hz = this.pz(HEAD) - this.pz(HIP);
    const l = Math.hypot(hx, hz);
    if (l > 0.05) { hx /= l; hz /= l; } else { hx = this.fx; hz = this.fz; }
    let yaw;
    if (from === 'supine') yaw = Math.atan2(-hx, -hz);          // hacia los pies
    else if (from === 'prone') yaw = Math.atan2(hx, hz);        // hacia la cabeza
    else if (from === 'side') {
      // la panza mira a +Z: hacia donde apunta el frente del cuerpo, en el plano
      let fx = this.fx, fz = this.fz; const fl = Math.hypot(fx, fz);
      if (fl > 0.05) { fx /= fl; fz /= fl; } else { fx = -hz; fz = hx; }
      yaw = Math.atan2(fx, fz);
    } else yaw = this.yaw;
    this.yaw = yaw;
    this.rootX = this.x; this.rootZ = this.z;
  }

  /** Elige y arranca una levantada según cómo quedó (o la que le pidan). */
  _startGetUp(forceName = null) {
    if (this.dead || this.crawling) return false;
    const o = this.orientation();
    let def = forceName ? SEQ[forceName] : null;
    // el jugador que está apretando una dirección quiere salir YA: la levantada más rápida de cada postura
    if (!def && this.isPlayer && this.driveV > 0) def = SEQ[{ supine: 'gu_kip', prone: 'gu_spring', side: 'gu_side_kick', kneel: 'gu_knee_hop', sit: 'gu_sit' }[o.from]] || null;
    if (!def) {
      if (o.from === 'up') { this.seq = null; this.state = 'up'; this.downT = 0; return true; }
      const list = getUpsFor(o.from);
      if (!list.length) { this.state = 'up'; return true; }
      def = pickWeighted(list, this.kind, this.rng || Math.random, this.traits.parkour);
    }
    this._frameForGetUp(o.from, o.s);
    // si lo empujan hacia un lado mientras se levanta, que la levantada mire para allá
    if (this.driveV > 0 && (o.from === 'supine' || o.from === 'prone') && this.isPlayer) {
      const goal = Math.atan2(this.driveX, this.driveZ);
      if (Math.abs(angDelta(this.yaw, goal)) < 1.2) { this.yaw = goal; this.rootX = this.x; this.rootZ = this.z; }
    }
    this._playSeq(def, { s: o.s, from: o.from });
    this.state = 'rising';
    this.lastGetUp = def.name;
    // aturdido: sacude la cabeza mientras arranca (no los corredores enojados ni el ágil)
    const R = this.rng || Math.random;
    if (this.kind !== 'runner' && !this.agile && R() < 0.55) this.overlay = { def: OVER.headshake, t: 0, k: 1, ctx: { sx: 1, along: 0, lat: 0 } };
    return true;
  }

  /**
   * El jugador (o cualquiera ágil) tirado que aprieta hacia un lado: en vez
   * de esperar aturdido, gatea rápido hacia allá y se levanta en la carrera.
   * Si está boca arriba primero rueda de costado para ponerse boca abajo.
   */
  _scrambleFromDown() {
    const o = this.orientation();
    this.scrambleCool = 0.9;
    // una rodada de costado para zafar; si sigue apretando, ya se levanta (no rueda sin fin)
    if (o.from === 'supine' && this.rollChain < 1) {
      this.rollChain++;
      // rodar hacia el lado que aprieta (en el marco del cuerpo: +X local = derecha)
      const L = this._local(this.driveX, this.driveZ);
      this.rootX = this.x; this.rootZ = this.z;
      // el marco de un boca arriba: +Z hacia los pies
      this._frameForGetUp('supine', 1);
      const Ls = this._local(this.driveX, this.driveZ);
      this.playMove('roll_side', { s: Ls.lat > 0 ? 0 : 1 });
      this.dazeT = 0.05;
      return;
    }
    if (o.from === 'side') { this._frameForGetUp('side', o.s); this._startGetUp('gu_side_kick'); return; }
    if (o.from === 'kneel' || o.from === 'sit' || o.from === 'supine') { this._startGetUp(); return; }
    // boca abajo: gatear hacia donde aprieta (una vez; después, levantarse)
    if (this.rollChain >= 2) { this._startGetUp(); return; }
    this.rollChain++;
    const goal = Math.atan2(this.driveX, this.driveZ);
    this.yaw = goal; this.rootX = this.x; this.rootZ = this.z;
    this.playMove('scramble', { s: 1 });
  }

  /**
   * Dormido en el piso o sentado: el cuerpo se acomoda YA en esa pose (sin
   * animar) y se queda hasta que lo despierten. `pose`: 'sit', 'kneel',
   * 'supine', 'prone', 'side'.
   */
  rest(pose = 'sit', s = 1) {
    const name = 'rest_' + pose;
    const def = SEQ[name] || SEQ.rest_sit;
    const T = this._tA;
    def.keys[0].pose(T, this, { s });
    // colocar las partículas directamente en la pose (mundo)
    const w = this.world, S = this.scale, c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    const gy = this.groundY > -900 ? this.groundY : 0;
    for (let i = 0; i < NP; i++) {
      const lx = (T[i * 3] - T[HIP * 3]) * S, ly = T[i * 3 + 1] * S, lz = (T[i * 3 + 2] - T[HIP * 3 + 2]) * S;
      w.setPos(this.p[i], this.rootX + lx * c + lz * sn, gy + ly + 0.02, this.rootZ - lx * sn + lz * c);
      w.vx[this.p[i]] = 0; w.vy[this.p[i]] = 0; w.vz[this.p[i]] = 0;
    }
    this._playSeq(def, { s });
    this.state = 'rest';
    this.dormant = true;
    return true;
  }
  /** Despierta: si estaba descansando, se levanta como corresponda. */
  wake() {
    if (!this.dormant) return;
    this.dormant = false;
    if (this.state === 'rest') {
      const from = this.seq ? this.seq.def.from : 'sit';
      this.seq = null;
      this.state = 'down';
      if (from === 'sit' || from === 'kneel') { this._startGetUp(from === 'sit' ? 'gu_sit' : 'gu_kneel'); }
      else this._startGetUp();
    }
  }

  // ═══ pose objetivo ════════════════════════════════════════════════════════
  //  Todo en el espacio local del cuerpo: +Z adelante (hacia donde MIRA), +X
  //  derecha. El paso va en la dirección del MOVIMIENTO, que puede no ser +Z.
  _syncTarget(dt) {
    const T = this.target, S = this.scale, P = this.pers;
    for (let i = 0; i < NP * 3; i++) T[i] = POSE[i] * S;

    if (this.crawling) { this._poseCrawl(); this._applyOverlays(); return; }
    if (this.seq) { this._seqPose(); this._applyOverlays(); return; }
    if (this.flight) { this._jumpPose(); this._applyOverlays(); return; }
    if (this.vault && this.vault.def) { this._vaultPose(); this._applyOverlays(); return; }

    const g = this.gait;
    const stumbling = this.stumbleT > 0;
    // un poco de irregularidad en el ciclo: nadie camina como un metrónomo
    const ph = this.phase + P.phaseOff + Math.sin(this.idleT * 1.7 + P.phaseOff) * P.jitter * 0.22;
    // pivotar en el lugar: pasitos laterales hacia donde gira (los pies no patinan al darse vuelta)
    const yr = this.yawRate || 0;
    const pivot = this.wantSpeed < 0.3 && !stumbling ? clamp01((Math.abs(yr) - 1.2) / 3) * (1 - clamp01(this.speed / 0.8)) : 0;
    const moving = stumbling ? 1 : Math.max(clamp01(this.wantSpeed / 1.0), pivot * 0.55);   // 0 quieto … 1 caminando
    // zancada (medio paso, desde la cadera) y altura del pie en vuelo
    const st = this.stride * S * lerp(0.8, 2.0, g) * this._sp('strideMul', 1) * (stumbling ? 0.7 : 1);
    const lift = lerp(0.05, 0.30, g) * S * (this.isPlayer ? 1.2 : 1) * this._sp('lift', 1) * (1 + this._sp('stomp') * 0.5);

    // — agacharse / aterrizar / trepar / correr agachado: el tronco baja y las rodillas doblan (IK) —
    let crouch = Math.max(this.crouch * 0.36, this.landCrouch > 0 ? Math.min(0.5, this.landCrouch) * 0.6 : 0) * S;
    crouch = Math.max(crouch, this._sp('crouchRun') * g * S);
    let vaultU = -1;
    if (this.vault) {
      vaultU = clamp01(this.vault.t / this.vault.dur);
      // primero se agacha para tomar impulso, después se estira arriba
      crouch = Math.max(crouch, Math.sin(Math.PI * clamp01(vaultU / 0.5)) * 0.3 * S);
    }
    // agachándose para saltar: las rodillas se cargan sin cortar la marcha
    let prepK = 0;
    if (this.jumpPrep) {
      prepK = clamp01(this.jumpPrep.t / this.jumpPrep.dur);
      crouch = Math.max(crouch, prepK * 0.30 * S);
    }
    if (crouch > 0) {
      for (const i of [HIP, HPL, HPR, CHEST, NECK, HEAD, SHL, SHR]) T[i * 3 + 1] -= crouch;
      T[CHEST * 3 + 2] += crouch * 0.45; T[NECK * 3 + 2] += crouch * 0.6; T[HEAD * 3 + 2] += crouch * 0.7;
    }

    // dirección del paso en coordenadas locales (pasos laterales / hacia atrás / tambaleo / pivote)
    let sdx = 0, sdz = 1;
    if (stumbling || this.wantSpeed > 0.05) {
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      const wx = stumbling ? this.stumbleX : this.wantX, wz = stumbling ? this.stumbleZ : this.wantZ;
      sdz = wx * s + wz * c;
      sdx = wx * c - wz * s;
      const l = Math.hypot(sdx, sdz) || 1; sdx /= l; sdz /= l;
    } else if (pivot > 0.05) { sdx = yr > 0 ? 1 : -1; sdz = 0; }

    // — piernas: trayectoria del pie + rodilla por IK de dos huesos —
    //  Apoyo [0,π): el pie va de +st a -st LINEAL (a la velocidad del cuerpo:
    //  cero patinaje). Vuelo [π,2π): vuelve de -st a +st con suavizado y sube
    //  en arco. La rodilla se calcula con el largo real de muslo y pantorrilla
    //  y se dobla hacia adelante: por eso SE VE la flexión al trotar y correr.
    const zig = this._sp('zigzag') * S * Math.sin(ph * 0.5) * moving;
    // galope: la segunda pierna no va exactamente a contrafase
    const legPh = Math.PI * this._sp('legPhase', 1);
    for (let side = 0; side < 2; side++) {
      const ft = side ? FTR : FTL, hp = side ? HPR : HPL;
      const isLimp = P.limpSide === side;
      const amp = (isLimp ? P.limp : 1) * moving;
      let lp = (ph + (side ? legPh : 0)) % TAU; if (lp < 0) lp += TAU;
      let fz, fy;
      if (lp < Math.PI) { const u = lp / Math.PI; fz = st * (1 - 2 * u); fy = 0; }
      else { const u = (lp - Math.PI) / Math.PI; const e = u * u * (3 - 2 * u); fz = st * (2 * e - 1); fy = lift * Math.sin(u * Math.PI); }
      fz *= amp; fy *= amp * (isLimp && P.dragLeg ? 0.15 : 1);   // la pierna que arrastra casi no se levanta
      let footX = POSE[ft * 3] * S + sdx * fz - zig;
      let footY = POSE[ft * 3 + 1] * S + fy;
      let footZ = POSE[ft * 3 + 2] * S + sdz * fz;
      if (vaultU >= 0) {
        // trepando: las piernas se recogen (rodillas al pecho) mientras el
        // cuerpo sube, y se estiran para apoyar arriba
        const tuck = Math.sin(Math.PI * clamp01((vaultU - 0.25) / 0.6));
        footY += tuck * 0.55 * S; footZ += tuck * 0.30 * S;
      }
      // la cadera del lado que vuela baja apenas
      T[hp * 3 + 1] -= fy * 0.12;
      this._legIK(T, side, footX, footY, footZ, side ? 0.12 : -0.12, 0, 1);
    }

    // — pierna baleada: el cuerpo se agacha de ese lado (la rodilla cede) —
    const buckle = Math.max(this.legBuckle[0], this.legBuckle[1]);
    if (buckle > 0) {
      const cr = clamp01(buckle / 0.25) * 0.24 * S;
      const sideX = (this.legBuckle[1] > this.legBuckle[0] ? 1 : -1) * cr * 0.35;
      for (const i of [HIP, HPL, HPR, CHEST, NECK, HEAD, SHL, SHR]) { T[i * 3 + 1] -= cr; T[i * 3] += sideX; }
      T[HEAD * 3 + 2] += cr * 0.5; T[CHEST * 3 + 2] += cr * 0.3;   // se va un poco hacia adelante
    }

    // — inclinarse hacia la aceleración (arranca, frena, gira): el torso se
    //   adelanta al empezar a correr y se echa atrás al frenar —
    {
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      const alx = this.accX * c - this.accZ * s, alz = this.accX * s + this.accZ * c;
      const kL = 0.016 * S;
      const lx = clamp(alx * kL, -0.10 * S, 0.10 * S), lz = clamp(alz * kL, -0.12 * S, 0.12 * S);
      T[CHEST * 3] += lx * 0.6; T[CHEST * 3 + 2] += lz * 0.6;
      T[NECK * 3] += lx * 0.9; T[NECK * 3 + 2] += lz * 0.9;
      T[HEAD * 3] += lx * 1.2; T[HEAD * 3 + 2] += lz * 1.2;
      T[SHL * 3] += lx * 0.7; T[SHL * 3 + 2] += lz * 0.7; T[SHR * 3] += lx * 0.7; T[SHR * 3 + 2] += lz * 0.7;
    }
    // — tambaleo: latigazo. El torso primero se queda atrás del empujón y
    //   después lo sigue; los brazos suben a buscar equilibrio —
    if (stumbling) {
      const u = 1 - this.stumbleT / this.stumbleDur;
      const whip = (u < 0.3 ? -(1 - u / 0.3) : (u - 0.3) / 0.7 * 0.5) * 0.10 * S;
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      const ldx = this.stumbleX * c - this.stumbleZ * s, ldz = this.stumbleX * s + this.stumbleZ * c;
      T[CHEST * 3] += ldx * whip * 0.7; T[CHEST * 3 + 2] += ldz * whip * 0.7;
      T[NECK * 3] += ldx * whip * 1.1; T[NECK * 3 + 2] += ldz * whip * 1.1;
      T[HEAD * 3] += ldx * whip * 1.5; T[HEAD * 3 + 2] += ldz * whip * 1.5;
      const armsUp = bell(u, 0.3) * 0.18 * S;
      T[HAL * 3 + 1] += armsUp; T[HAR * 3 + 1] += armsUp; T[HAL * 3] -= armsUp * 0.8; T[HAR * 3] += armsUp * 0.8;
    }
    // — inclinarse EN LAS CURVAS: el tronco y la cabeza se van hacia el lado al que
    //   gira, más cuanto más rápido corre (un corredor que dobla no va derecho) —
    {
      const bank = clamp(yr * this.speed * 0.014, -0.11, 0.11) * S * (1 - this.airborne);
      if (bank) {
        T[CHEST * 3] += bank * 0.5; T[NECK * 3] += bank * 0.8; T[HEAD * 3] += bank * 1.0;
        T[SHL * 3] += bank * 0.65; T[SHR * 3] += bank * 0.65;
        T[HEAD * 3 + 1] -= Math.abs(bank) * 0.25;
      }
      // — la cabeza ANTICIPA el giro: mira hacia donde quiere ir antes de que el cuerpo llegue —
      if (!this.lockYaw && this.wantSpeed > 0.1 && !this.lookX && !this.lookZ) {
        const ant = clamp(angDelta(this.yaw, Math.atan2(this.wantX, this.wantZ)), -0.7, 0.7) * moving;
        T[HEAD * 3] += Math.sin(ant) * 0.07 * S; T[HEAD * 3 + 2] += (Math.cos(ant) - 1) * 0.07 * S;
        T[NECK * 3] += Math.sin(ant) * 0.03 * S;
      }
    }
    // — mirar al objetivo: la cabeza se orienta hacia donde está el jugador —
    if (this.lookX || this.lookZ) {
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      const llx = this.lookX * c - this.lookZ * s, llz = this.lookX * s + this.lookZ * c;
      T[HEAD * 3] += clamp(llx, -1, 1) * 0.06 * S;
      T[HEAD * 3 + 2] += clamp(llz, -1, 1) * 0.03 * S;
      T[NECK * 3] += clamp(llx, -1, 1) * 0.025 * S;
    }

    // — torso: balanceo lateral (menos al correr), bob vertical, inclinación —
    const sw = Math.sin(ph) * P.sway * lerp(0.035, 0.018, g) * S * (0.3 + moving);
    const bob = Math.cos(ph * 2) * lerp(0.022, 0.05, g) * S * (0.2 + moving) * this._sp('bobMul', 1);
    T[CHEST * 3] += sw * 0.55 + zig * 0.6; T[NECK * 3] += sw * 0.3 + zig * 0.8; T[HEAD * 3] += sw * 0.15 + zig;
    T[FTL * 3] -= sw; T[FTR * 3] -= sw; T[KNL * 3] -= sw * 0.6; T[KNR * 3] -= sw * 0.6;
    T[CHEST * 3 + 1] -= bob * 0.7; T[NECK * 3 + 1] -= bob * 0.6; T[HEAD * 3 + 1] -= bob * 0.5;
    T[FTL * 3 + 1] += bob * 0.3; T[FTR * 3 + 1] += bob * 0.3;
    // inclinación hacia adelante: caminando poco, corriendo mucho; el estilo suma lo suyo
    const hunch = P.hunch + this._sp('hunch');
    const lean = (0.04 + moving * 0.05 + g * 0.16 + P.lean + this._sp('lean') + hunch) * S;
    T[CHEST * 3 + 2] += lean * 0.55; T[SHL * 3 + 2] += lean * 0.6; T[SHR * 3 + 2] += lean * 0.6;
    T[NECK * 3 + 2] += lean * 0.9;
    T[HEAD * 3 + 2] += lean * 1.25;
    T[HEAD * 3 + 1] -= hunch * 0.6 * S + g * 0.03 * S;
    // cabeza gacha (estilo) y un hombro adelante; cabeza echada atrás (gritando); rebote extra
    const hd = this._sp('headDown') * S;
    if (hd) { T[HEAD * 3 + 1] -= hd; T[HEAD * 3 + 2] += hd * 0.6; T[NECK * 3 + 1] -= hd * 0.4; T[NECK * 3 + 2] += hd * 0.3; }
    const hb = this._sp('headBack') * S;
    if (hb) { T[HEAD * 3 + 1] += hb * 0.3; T[HEAD * 3 + 2] -= hb; T[NECK * 3 + 2] -= hb * 0.4; T[CHEST * 3 + 2] -= hb * 0.15; }
    const bnc = this._sp('bounce') * S * moving * (0.5 - 0.5 * Math.cos(ph * 2));
    if (bnc) for (const i of [HIP, HPL, HPR, CHEST, NECK, HEAD, SHL, SHR]) T[i * 3 + 1] += bnc;
    const shd = this._sp('shoulder') * S;
    if (shd) { T[SHR * 3 + 2] += shd; T[SHL * 3 + 2] -= shd * 0.5; }
    T[HEAD * 3] += P.headTilt * 0.10 * S + Math.sin(ph * 0.7) * 0.02 * P.headBob * S;
    T[HEAD * 3 + 1] -= Math.abs(P.headTilt) * 0.05 * S;
    // hombros en contrarrotación con las piernas (al correr se nota)
    const tw = Math.sin(ph) * lerp(0.02, 0.06, g) * S * moving;
    T[SHL * 3 + 2] -= tw; T[SHR * 3 + 2] += tw;

    // — quieto: respirar y cambiar el peso de pie —
    if (moving < 0.2) {
      const q = 1 - moving / 0.2;
      const br = Math.sin(this.idleT * 1.4) * 0.006 * S * q;
      T[CHEST * 3 + 1] += br; T[NECK * 3 + 1] += br * 1.2; T[HEAD * 3 + 1] += br * 1.3;
      T[SHL * 3 + 1] += br; T[SHR * 3 + 1] += br;
      const ws = Math.sin(this.idleT * 0.45 + P.phaseOff) * 0.02 * S * q * P.sway;
      T[CHEST * 3] += ws; T[NECK * 3] += ws * 1.2; T[HEAD * 3] += ws * 1.4;
    }

    // — brazos —
    this._arms(T, ph, g, st, moving, vaultU);
    // agachándose para saltar: los brazos van atrás a tomar envión
    if (prepK > 0) { const e = prepK * 0.22 * S; T[HAL * 3 + 2] -= e; T[HAR * 3 + 2] -= e; T[HAL * 3 + 1] -= e * 0.4; T[HAR * 3 + 1] -= e * 0.4; T[ELL * 3 + 2] -= e * 0.5; T[ELR * 3 + 2] -= e * 0.5; }
    this._applyOverlays();
  }

  /** Pose en el aire: la del estilo del salto; cerca del piso las piernas bajan a buscarlo. */
  _jumpPose() {
    const J = this.flight, U = this._tA, T = this.target, sc = this.scale;
    const u = clamp01(J.t / J.dur);
    J.def.pose(U, u, J);
    if (u > 0.72 && !J.dive) {
      // preparar el aterrizaje: se mezcla con la pose de caer (pies abajo, rodillas listas)
      const k = clamp01((u - 0.72) / 0.28) * 0.7;
      const L = this._tB; POSES.land(L, 0.25);
      for (let i = 0; i < NP * 3; i++) U[i] += (L[i] - U[i]) * k;
    }
    for (let i = 0; i < NP * 3; i++) T[i] = U[i] * sc;
    // la cabeza sigue mirando al objetivo
    if (this.lookX || this.lookZ) {
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      const llx = this.lookX * c - this.lookZ * s;
      T[HEAD * 3] += clamp(llx, -1, 1) * 0.05 * sc;
    }
  }
  /** Pose trepando o bajando: la del estilo, con la tapa a `rel` del ancla. */
  _vaultPose() {
    const V = this.vault, U = this._tA, T = this.target, sc = this.scale;
    const u = clamp01(V.t / V.dur);
    const top = V.kind === 'descent' ? V.y0 : V.y1;
    V.rel = (top - this.groundY) / sc; V.u = u;
    V.def.pose(U, u, V);
    for (let i = 0; i < NP * 3; i++) T[i] = U[i] * sc;
  }

  /** Brazos según el modo (jugador: apuntar) o el estilo de marcha del cuerpo. */
  _arms(T, ph, g, st, moving, vaultU) {
    const S = this.scale, P = this.pers;
    const sp = P.armSpread;
    if (vaultU >= 0) {
      // trepando: las manos van al borde (adelante y abajo) y empujan
      const push = Math.sin(Math.PI * clamp01(vaultU / 0.7));
      for (let side = 0; side < 2; side++) {
        const sgn = side ? 1 : -1;
        this._armIK(T, side, sgn * 0.24 * S, (1.05 - push * 0.25) * S, (0.45 + push * 0.15) * S, sgn * 0.8, -0.3, -0.5);
      }
      return;
    }
    if (this.armMode === 'aim') {
      // el jugador. Dos poses que se mezclan (aimBlend): APUNTANDO (arma al
      // frente, manos casi quietas con un bob leve) y CORRIENDO (arma baja,
      // cruzada al pecho, las manos bombean con el paso). Retroceso: las manos
      // van atrás y arriba y vuelven. Recarga: la mano izquierda baja al
      // cargador y vuelve al guardamanos.
      const ab = this.aimBlend, rb = 1 - ab;
      const bobA = Math.cos(ph * 2) * (0.005 + g * 0.012) * S * moving;
      const swA = Math.sin(ph) * (0.003 + g * 0.008) * S * moving;
      const pumpY = Math.abs(Math.cos(ph)) * 0.04 * S * moving * rb;
      const pumpZ = Math.sin(ph * 2) * 0.035 * S * moving * rb;
      const rc = this.recoil;
      const rl = this.reloadT;
      const dip = rl > 0 ? Math.sin(Math.PI * clamp01((rl - 0.1) / 0.62)) : 0;
      const hrx = lerp(0.17, 0.07, ab) * S + swA;
      const hry = lerp(1.02, 1.30, ab) * S + bobA + pumpY + rc * 0.035 * S;
      const hrz = lerp(0.16, 0.36, ab) * S + pumpZ - rc * 0.06 * S;
      const hlx = lerp(-0.07, -0.03, ab) * S + swA + dip * 0.11 * S;
      const hly = lerp(1.11, 1.27, ab) * S + bobA + pumpY - dip * 0.24 * S + rc * 0.02 * S;
      const hlz = lerp(0.28, 0.50, ab) * S + pumpZ - rc * 0.05 * S - dip * 0.20 * S;
      this._armIK(T, 1, hrx, hry, hrz, 0.9, -0.5, -0.3);
      this._armIK(T, 0, hlx, hly, hlz, -0.9, -0.6, -0.2);
      T[SHR * 3 + 2] += 0.03 * S * ab; T[SHL * 3 + 2] -= 0.02 * S * ab;
      // corriendo el torso se adelanta más y la cabeza mira al frente del paso
      T[CHEST * 3 + 2] += 0.03 * S * rb * moving; T[HEAD * 3 + 2] += 0.04 * S * rb * moving;
      return;
    }
    // estilo: caminando el de caminar, corriendo el de correr
    const style = g > 0.5 ? (P.r.armStyle || this.armMode) : (P.w.armStyle || this.armMode);
    const tr = Math.sin(ph * 1.7) * 0.035 * P.wobble * S;
    const lg = this.lunge > 0 ? Math.sin(Math.min(1, this.lunge / 0.35) * Math.PI) : 0;
    const reach = (side) => {
      // el clásico: brazos hacia adelante, temblando; con `lunge` se disparan
      // más lejos y más bajo (la manotada); corriendo van más altos y bombean.
      const sh = side ? SHR : SHL, sgn = side ? 1 : -1;
      const lp = ph + (side ? 0 : Math.PI);
      const pump = Math.sin(lp) * st * 0.3 * g;
      const hx = (POSE[(side ? HAR : HAL) * 3] * S) * sp * (0.9 - lg * 0.35);
      const hy = POSE[sh * 3 + 1] * S - 0.14 * S + P.armHi * S - lg * 0.10 * S + g * 0.08 * S + this._sp('reachHi') * S;
      const hz = (0.50 + 0.1 * (1 - g)) * S + tr * 1.6 + lg * 0.22 * S + pump * 1.2;
      this._armIK(T, side, hx, hy, hz, sgn * 0.7, -0.8, -0.2);
    };
    const pump = (side, amp = 1, hiY = 0) => {
      // corriendo: brazos en oposición a la pierna del mismo lado, codos a 90°,
      // manos a la altura del pecho; caminando cuelgan y se mecen
      const sh = side ? SHR : SHL, ha = side ? HAR : HAL, sgn = side ? 1 : -1;
      const lp = ph + (side ? Math.PI : 0);
      const sw2 = -Math.sin(lp) * moving * amp;
      const hx = POSE[ha * 3] * S * sp * (1 - 0.15 * g);
      const hy = POSE[sh * 3 + 1] * S - lerp(0.58, 0.30, g) * S + Math.abs(sw2) * 0.06 * S * g + hiY * S;
      const hz = sw2 * st * lerp(0.6, 0.75, g) + 0.10 * g * S;
      this._armIK(T, side, hx, hy, hz, sgn * 0.45, -0.35, -0.9);
    };
    const low = (side) => {
      const ha = side ? HAR : HAL, sgn = side ? 1 : -1;
      const lp = ph + (side ? Math.PI : 0);
      const hx = POSE[ha * 3] * S * sp, hy = POSE[ha * 3 + 1] * S, hz = -Math.sin(lp) * st * 0.5 * moving + 0.03 * S;
      this._armIK(T, side, hx, hy, hz, sgn * 0.4, -0.2, -0.95);
    };
    switch (style) {
      case 'pump': pump(0); pump(1); break;
      case 'low': low(0); low(1); break;
      case 'flail': {
        // brazos que se agitan: bombeo grande, manos altas y temblonas
        for (let side = 0; side < 2; side++) {
          const sgn = side ? 1 : -1, lp = ph + (side ? Math.PI : 0);
          const sw2 = -Math.sin(lp) * moving;
          const hx = sgn * (0.34 + 0.10 * Math.sin(ph * 3.1 + side)) * S;
          const hy = (1.15 + 0.20 * sw2 + 0.08 * Math.sin(ph * 2.3 + side * 2)) * S;
          const hz = (0.20 + sw2 * 0.35) * S;
          this._armIK(T, side, hx, hy, hz, sgn * 0.6, -0.5, -0.6);
        }
        break;
      }
      case 'back': {
        // brazos hacia atrás, como si el cuerpo entero fuera adelante de ellos
        for (let side = 0; side < 2; side++) {
          const sgn = side ? 1 : -1, lp = ph + (side ? Math.PI : 0);
          const sw2 = Math.sin(lp) * moving * 0.10;
          const hx = sgn * 0.30 * S, hy = (0.88 + Math.abs(sw2) * 0.5) * S, hz = (-0.28 - 0.18 * g + sw2) * S;
          this._armIK(T, side, hx, hy, hz, sgn * 0.6, 0.3, -0.7);
        }
        break;
      }
      case 'clutch': {
        // codos pegados, manos al pecho (corre como aferrando algo)
        for (let side = 0; side < 2; side++) {
          const sgn = side ? 1 : -1, lp = ph + (side ? Math.PI : 0);
          const sw2 = Math.sin(lp) * moving * 0.04 * S;
          this._armIK(T, side, sgn * 0.13 * S, 1.18 * S + sw2, 0.24 * S + sw2 * 0.5, sgn * 0.9, -0.4, -0.2);
        }
        break;
      }
      case 'wide': {
        // brazos abiertos a 45°, balanceándose
        for (let side = 0; side < 2; side++) {
          const sgn = side ? 1 : -1, lp = ph + (side ? Math.PI : 0);
          const sw2 = -Math.sin(lp) * moving;
          this._armIK(T, side, sgn * 0.52 * S, (1.12 + sw2 * 0.08) * S, (0.18 + sw2 * 0.22) * S, sgn * 0.3, -1, -0.2);
        }
        break;
      }
      case 'one': { reach(1); low(0); break; }
      case 'windmill': {
        // las manos dibujan círculos
        for (let side = 0; side < 2; side++) {
          const sgn = side ? 1 : -1, a = ph * 1.5 + (side ? Math.PI : 0);
          this._armIK(T, side, sgn * 0.32 * S, (1.25 + 0.30 * Math.sin(a) * moving) * S, (0.30 + 0.30 * Math.cos(a) * moving) * S, sgn * 0.8, -0.3, -0.5);
        }
        break;
      }
      case 'high': {
        // manos altas y adelante, codos afuera (bombeo alto)
        for (let side = 0; side < 2; side++) {
          const sgn = side ? 1 : -1, lp = ph + (side ? Math.PI : 0);
          const sw2 = -Math.sin(lp) * moving;
          this._armIK(T, side, sgn * 0.30 * S, (1.50 + sw2 * 0.10) * S, (0.30 + sw2 * 0.18) * S, sgn * 1, -0.2, -0.3);
        }
        break;
      }
      case 'claw': {
        // las dos manos como garras adelante, altas, temblando
        for (let side = 0; side < 2; side++) {
          const sgn = side ? 1 : -1, lp = ph + (side ? Math.PI : 0);
          const tr2 = Math.sin(ph * 4.1 + side * 1.7) * 0.03 * S;
          this._armIK(T, side, sgn * 0.26 * S + tr2, (1.25 + 0.06 * Math.sin(lp)) * S, (0.48 + 0.05 * Math.sin(lp)) * S + tr2, sgn * 0.8, 0.2, -0.4);
        }
        break;
      }
      case 'zombie': {
        // brazos al frente, tiesos (el clásico), apenas se mecen; el codo con
        // una flexión mínima hacia abajo (si no, la mano se queda corta y el
        // codo parece doblar al revés)
        for (let side = 0; side < 2; side++) {
          const sgn = side ? 1 : -1;
          const sw2 = Math.sin(ph + (side ? Math.PI : 0)) * 0.03 * moving;
          this._armIK(T, side, sgn * 0.21 * S, (1.30 + sw2) * S, 0.56 * S, sgn * 0.2, -0.9, -0.4);
        }
        break;
      }
      case 'limp': {
        // brazos SIN músculo (armMuscle 0): cuelgan y se sacuden con la carrera, física pura
        for (let side = 0; side < 2; side++) { const sgn = side ? 1 : -1; this._armIK(T, side, sgn * 0.27 * S, 0.80 * S, 0.02 * S, sgn * 0.5, -0.3, -0.8); }
        break;
      }
      case 'one_up': {
        // un brazo en alto, el otro bombea
        const sw2 = Math.sin(ph) * 0.06 * moving;
        this._armIK(T, 1, 0.22 * S, (1.85 + sw2) * S, (0.12 + sw2 * 0.5) * S, 0.9, 0.3, -0.3);
        pump(0);
        break;
      }
      case 'hug': {
        // brazos cruzados sobre el pecho, aferrándose
        for (let side = 0; side < 2; side++) {
          const sgn = side ? 1 : -1;
          const sw2 = Math.sin(ph * 2) * 0.02 * moving * S;
          this._armIK(T, side, -sgn * 0.12 * S, (1.22 + (side ? 0.05 : -0.05)) * S + sw2, 0.20 * S, sgn * 0.9, -0.3, -0.3);
        }
        break;
      }
      case 'head_hold': {
        // las manos en la cabeza (le duele)
        for (let side = 0; side < 2; side++) {
          const sgn = side ? 1 : -1;
          const sw2 = Math.sin(ph * 2 + side) * 0.02 * moving * S;
          this._armIK(T, side, sgn * 0.13 * S, 1.70 * S + sw2, 0.06 * S, sgn * 1, 0.2, -0.1);
        }
        break;
      }
      case 'gorilla': {
        // brazos largos casi al piso, los nudillos tocan al pasar
        for (let side = 0; side < 2; side++) {
          const sgn = side ? 1 : -1, lp = ph + (side ? Math.PI : 0);
          const sw2 = -Math.sin(lp) * moving;
          this._armIK(T, side, sgn * 0.30 * S, (0.38 + Math.max(0, sw2) * 0.35) * S, (0.20 + sw2 * 0.45) * S, sgn * 0.4, -0.2, -0.9);
        }
        break;
      }
      case 'scream': {
        // brazos abiertos atrás y arriba, gritando
        for (let side = 0; side < 2; side++) {
          const sgn = side ? 1 : -1, lp = ph + (side ? Math.PI : 0);
          const sw2 = Math.sin(lp) * 0.08 * moving;
          this._armIK(T, side, sgn * 0.48 * S, (1.35 + sw2) * S, (-0.22 + sw2) * S, sgn * 0.6, 0.5, -0.5);
        }
        break;
      }
      case 'trailing': {
        // brazos atrás y estirados, como alas
        for (let side = 0; side < 2; side++) {
          const sgn = side ? 1 : -1, lp = ph + (side ? Math.PI : 0);
          const sw2 = Math.sin(lp) * 0.06 * moving;
          this._armIK(T, side, sgn * 0.34 * S, (1.05 + sw2) * S, (-0.50 - 0.1 * g) * S, sgn * 0.6, 0.6, -0.5);
        }
        break;
      }
      case 'reach_high': {
        // los dos brazos altos adelante, a agarrarte
        for (let side = 0; side < 2; side++) {
          const sgn = side ? 1 : -1, lp = ph + (side ? Math.PI : 0);
          const sw2 = Math.sin(lp) * 0.05 * moving;
          this._armIK(T, side, sgn * 0.22 * S, (1.65 + sw2) * S, (0.45 + sw2) * S, sgn * 0.8, 0.5, -0.2);
        }
        break;
      }
      case 'sprinter': {
        // bombeo de atleta: codos a 90°, manos altas, amplitud grande
        for (let side = 0; side < 2; side++) {
          const sgn = side ? 1 : -1, lp = ph + (side ? Math.PI : 0);
          const sw2 = -Math.sin(lp) * moving;
          this._armIK(T, side, sgn * 0.24 * S, (1.05 + Math.abs(sw2) * 0.12 + Math.max(0, sw2) * 0.25) * S, (sw2 * 0.42) * S, sgn * 0.5, -0.3, -0.9);
        }
        break;
      }
      case 'chest': {
        // brazos cruzados sobre el pecho, tiesos
        this._armIK(T, 0, 0.14 * S, 1.26 * S, 0.16 * S, -0.9, -0.4, -0.2);
        this._armIK(T, 1, -0.14 * S, 1.18 * S, 0.18 * S, 0.9, -0.4, -0.2);
        break;
      }
      default: reach(0); reach(1);
    }
  }

  /** IK de pierna: pie en (fx,fy,fz), rodilla doblando hacia (bx,by,bz). */
  _legIK(T, side, fx, fy, fz, bx, by, bz) {
    const kn = side ? KNR : KNL, ft = side ? FTR : FTL, hp = side ? HPR : HPL;
    const L1 = this._legL1 || (this._legL1 = this._rest(HPL, KNL));
    const L2 = this._legL2 || (this._legL2 = this._rest(KNL, FTL));
    T[ft * 3] = fx; T[ft * 3 + 1] = fy; T[ft * 3 + 2] = fz;
    const hpx = T[hp * 3], hpy = T[hp * 3 + 1], hpz = T[hp * 3 + 2];
    let dx = fx - hpx, dy = fy - hpy, dz = fz - hpz;
    let d = Math.hypot(dx, dy, dz) || 1e-4;
    const maxD = (L1 + L2) * 0.985;
    if (d > maxD) { const f = maxD / d; dx *= f; dy *= f; dz *= f; d = maxD; }
    const ux = dx / d, uy = dy / d, uz = dz / d;
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const hh = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    const dot = bx * ux + by * uy + bz * uz;
    bx -= ux * dot; by -= uy * dot; bz -= uz * dot;
    const bl = Math.hypot(bx, by, bz);
    if (bl > 1e-4) { bx /= bl; by /= bl; bz /= bl; } else { bx = 0; by = 0; bz = 1; }
    T[kn * 3] = hpx + ux * a + bx * hh;
    T[kn * 3 + 1] = hpy + uy * a + by * hh;
    T[kn * 3 + 2] = hpz + uz * a + bz * hh;
  }
  /** IK de brazo: mano en (hx,hy,hz), codo doblando hacia (bx,by,bz). */
  _armIK(T, side, hx, hy, hz, bx, by, bz) {
    const sh = side ? SHR : SHL, el = side ? ELR : ELL, ha = side ? HAR : HAL;
    const A1 = this._armL1 || (this._armL1 = this._rest(SHL, ELL));
    const A2 = this._armL2 || (this._armL2 = this._rest(ELL, HAL));
    T[ha * 3] = hx; T[ha * 3 + 1] = hy; T[ha * 3 + 2] = hz;
    const sx = T[sh * 3], sy = T[sh * 3 + 1], sz = T[sh * 3 + 2];
    let dx = hx - sx, dy = hy - sy, dz = hz - sz;
    let d = Math.hypot(dx, dy, dz) || 1e-4;
    const maxD = (A1 + A2) * 0.98;
    if (d > maxD) { const f = maxD / d; dx *= f; dy *= f; dz *= f; d = maxD; }
    const ux = dx / d, uy = dy / d, uz = dz / d;
    const a = (A1 * A1 - A2 * A2 + d * d) / (2 * d);
    const hh = Math.sqrt(Math.max(0, A1 * A1 - a * a));
    const dot = bx * ux + by * uy + bz * uz;
    bx -= ux * dot; by -= uy * dot; bz -= uz * dot;
    const bl = Math.hypot(bx, by, bz);
    if (bl > 1e-4) { bx /= bl; by /= bl; bz /= bl; } else { bx = side ? 1 : -1; by = 0; bz = 0; }
    T[el * 3] = sx + ux * a + bx * hh; T[el * 3 + 1] = sy + uy * a + by * hh; T[el * 3 + 2] = sz + uz * a + bz * hh;
  }

  /** Pose de una secuencia: mezcla suave entre la clave actual y la siguiente (en unidad, luego escala). */
  _seqPose() {
    const S = this.seq, T = this.target, sc = this.scale;
    const keys = S.def.keys;
    const A = this._tA, B = this._tB;
    // pose continua (rodadas, giros): la da una función del tiempo
    if (S.def.dyn) {
      S.def.dyn(A, this, S.ctx, S.t, clamp01(S.t / S.def.dur));
      for (let i = 0; i < NP * 3; i++) T[i] = A[i] * sc;
      return;
    }
    const a = keys[Math.max(0, S.key)], b = keys[Math.min(Math.max(0, S.key) + 1, keys.length - 1)];
    a.pose(A, this, S.ctx);
    if (b === a) { for (let i = 0; i < NP * 3; i++) T[i] = A[i] * sc; return; }
    b.pose(B, this, S.ctx);
    // la clave siguiente puede estar en un marco girado: se expresa en el actual
    if (S.pendingYaw) rotY(B, S.pendingYaw, 0, 0);
    const u = S.u, e = u * u * (3 - 2 * u);
    for (let i = 0; i < NP * 3; i++) T[i] = (A[i] + (B[i] - A[i]) * e) * sc;
  }

  /** Overlays (sacudón / manotazo / tic / herida) sumados a la pose, en espacio unidad. */
  _applyOverlays() {
    const ov = this.overlay, io = this.idleOv, wd = this.woundOv;
    this._setAnchor();
    if (!ov && !io && !wd) return;
    const T = this.target, U = this._tU, sc = this.scale, inv = 1 / sc;
    for (let i = 0; i < NP * 3; i++) U[i] = T[i] * inv;
    if (wd && wd.k > 0.01) { wd.t += this._dtLast; wd.def.fn(U, (wd.t / wd.def.dur) % 1, wd.k, wd.ctx); }
    if (ov) {
      ov.t += this._dtLast;
      const u = ov.t / ov.def.dur;
      if (u >= 1) this.overlay = null;
      else ov.def.fn(U, u, ov.k, ov.ctx);
    }
    if (io) {
      io.t += this._dtLast;
      let u = io.t / io.def.dur;
      if (u >= 1) { if (io.def.loop) { io.t -= io.def.dur; u -= 1; } else this.idleOv = null; }
      if (this.idleOv) io.def.fn(U, u, io.k, io.ctx || {});
    }
    for (let i = 0; i < NP * 3; i++) T[i] = U[i] * sc;
    this._setAnchor();
  }

  /** Ancla de la pose en XZ: la cadera, o el centro de la pose si la secuencia lo pide (rodar). */
  _setAnchor() {
    const T = this.target;
    if (this.seq && this.seq.def.anchor === 'center') {
      let x = 0, z = 0;
      for (let i = 0; i < NP; i++) { x += T[i * 3]; z += T[i * 3 + 2]; }
      this.anchorX = x / NP; this.anchorZ = z / NP;
    } else { this.anchorX = T[HIP * 3]; this.anchorZ = T[HIP * 3 + 2]; }
  }

  /** Pose de arrastre: sin piernas útiles, tracción con los brazos. */
  _poseCrawl() {
    const T = this.target, S = this.scale;
    const ph = this.phase + this.pers.phaseOff;
    const H = 0.34 * S;
    T[HIP * 3 + 1] = H; T[CHEST * 3 + 1] = H + 0.06 * S;
    T[NECK * 3 + 1] = H + 0.14 * S; T[HEAD * 3 + 1] = H + 0.20 * S;
    T[CHEST * 3 + 2] = 0.22 * S; T[NECK * 3 + 2] = 0.36 * S; T[HEAD * 3 + 2] = 0.48 * S;
    T[SHL * 3 + 1] = H + 0.10 * S; T[SHR * 3 + 1] = H + 0.10 * S;
    T[SHL * 3 + 2] = 0.14 * S; T[SHR * 3 + 2] = 0.14 * S;
    T[HPL * 3 + 1] = H - 0.04 * S; T[HPR * 3 + 1] = H - 0.04 * S;
    for (let side = 0; side < 2; side++) {
      const el = side ? ELR : ELL, ha = side ? HAR : HAL;
      const lp = ph + (side ? Math.PI : 0);
      const reach = (Math.sin(lp) * 0.5 + 0.5);
      T[el * 3 + 1] = H + 0.02 * S; T[el * 3 + 2] = (0.34 + reach * 0.20) * S;
      T[ha * 3 + 1] = 0.07 * S;     T[ha * 3 + 2] = (0.58 + reach * 0.34) * S;
      const kn = side ? KNR : KNL, ft = side ? FTR : FTL;
      T[kn * 3 + 1] = 0.12 * S; T[kn * 3 + 2] = -0.34 * S;
      T[ft * 3 + 1] = 0.08 * S; T[ft * 3 + 2] = -0.66 * S;
    }
  }

  // ═══ motor: se llama por substep ══════════════════════════════════════════
  preSolve(h, w) {
    const mg = this.muscleGlobal;
    // — cayendo sin control: las manos salen a frenar la caída (Euphoria).
    //   Sólo mientras el pecho está alto y bajando; suave (si tira fuerte,
    //   arrastra el cuerpo entero por el piso); sólo las manos; hacia donde
    //   MIRA, no hacia donde se mueve (la velocidad rebota al tocar el piso) —
    if (this.brace > 0 && !this.dead) {
      const P = this.p;
      const pc = P[CHEST];
      const cy = w.py[pc];
      if (cy > 0.4 && cy < 1.35 && w.vy[pc] < 0.6) {
        // hacia donde CAE si lo dirige una caída (de costado: al costado); si no, hacia donde mira
        let fx = this.fx, fz = this.fz;
        const cx = this.seq && this.seq.ctx;
        if (cx && cx.dx !== undefined) { fx = cx.dx; fz = cx.dz; }
        const gy = this.groundY > -900 ? this.groundY : 0;
        const k = (1 - Math.exp(-55 * h)) * 0.3;
        const maxStep = 6 * h;
        for (let side = 0; side < 2; side++) {
          const ph = P[side ? HAR : HAL];
          if (w.iw[ph] === 0) continue;
          const sgn = side ? 1 : -1;
          const tx = w.px[pc] + fx * 0.45 - fz * sgn * 0.22, tz = w.pz[pc] + fz * 0.45 + fx * sgn * 0.22, ty = gy + 0.1;
          let dx = (tx - w.px[ph]) * k, dy = (ty - w.py[ph]) * k, dz = (tz - w.pz[ph]) * k;
          const dl = Math.hypot(dx, dy, dz);
          if (dl > maxStep) { const f = maxStep / dl; dx *= f; dy *= f; dz *= f; }
          w.px[ph] += dx; w.py[ph] += dy; w.pz[ph] += dz;
        }
      }
    }
    if (mg <= 0.002 || this.dead) return;

    // la raíz avanza de forma continua, un pedacito por substep
    if (this.rootVX || this.rootVZ) { this.rootX += this.rootVX * h; this.rootZ += this.rootVZ * h; }

    const T = this.target, P = this.p, mus = this.muscle;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const ox = this.rootX, oz = this.rootZ;
    const baseY = this.groundY > -900 ? this.groundY : w.py[P[HIP]] - POSE[HIP * 3 + 1] * this.scale;
    const hipLX = this.anchorX, hipLZ = this.anchorZ;

    const k = 1 - Math.exp(-this.stiffness * h);
    const maxStep0 = this.maxMuscleSpeed * h;
    const LM = this.limbMul;

    for (let i = 0; i < NP; i++) {
      const m = mus[i] * mg * MUS[i] * LM[i];
      if (m <= 0.002) continue;
      const pi = P[i];
      if (w.iw[pi] === 0) continue;
      const lx = T[i * 3] - hipLX, ly = T[i * 3 + 1], lz = T[i * 3 + 2] - hipLZ;
      const tx = ox + lx * c + lz * s;
      const ty = baseY + ly;
      const tz = oz - lx * s + lz * c;
      let dx = (tx - w.px[pi]) * k * m;
      let dy = (ty - w.py[pi]) * k * m;
      let dz = (tz - w.pz[pi]) * k * m;
      // techo por substep proporcional a la fuerza: un músculo débil mueve despacio
      const maxStep = maxStep0 * Math.min(1, 2.5 * m);
      const dl2 = dx * dx + dy * dy + dz * dz;
      if (dl2 > maxStep * maxStep) {
        const f = maxStep / Math.sqrt(dl2);
        dx *= f; dy *= f; dz *= f;
      }
      w.px[pi] += dx; w.py[pi] += dy; w.pz[pi] += dz;
    }
  }

  // ═══ amortiguación: por substep, después de calcular velocidades ══════════
  //  Cada partícula con músculo funde su velocidad hacia la del cuerpo: un
  //  controlador PD, no un resorte. Cuando está aturdido, la física manda y
  //  se ve el impacto.
  postVelocity(h, w) {
    const mg = this.muscleGlobal;
    if (mg <= 0.002 || this.dead) return;
    if (this.seq && (this.seq.def.kind === 'fall' || this.seq.def.kind === 'die')) return;   // cayendo: la inercia manda
    const phys = this.limp > 0 ? 1 : (this.stagger > 0 ? clamp01(this.stagger / 0.55) * 0.9 : 0);
    if (phys >= 0.999) return;
    const stumbling = this.stumbleT > 0;
    // velocidad objetivo: la del tambaleo, la de la secuencia (rodar, gatear,
    // deslizarse), la del salto, o la de la marcha. Vertical: el arco del
    // salto (si no, cero: el PD frena los rebotes)
    let vtx, vtz;
    if (stumbling) { vtx = this.rootVX; vtz = this.rootVZ; }
    else if (this.seq) { vtx = this.seq.vx; vtz = this.seq.vz; }
    else if (this.flight) { vtx = this.flight.vx; vtz = this.flight.vz; }
    else { vtx = this.wantX * this.curSpeed; vtz = this.wantZ * this.curSpeed; }
    const vty = this.tgtVY;
    const P = this.p, mus = this.muscle, LM = this.limbMul;
    // Amortiguación CRÍTICA, no infinita: con k (rigidez por substep) y m, el
    // resorte tiene ω = sqrt(k·m)/h; amortiguar a = 1.45·sqrt(k·m) por substep
    // da ζ ≈ 0.7: el torso queda firme, los brazos y la cabeza siguen con un
    // poco de retraso y sobrepaso. Eso es el "movimiento secundario" que
    // separa un cuerpo de un robot.
    const kSub = 1 - Math.exp(-this.stiffness * h);
    for (let i = 0; i < NP; i++) {
      const m = mus[i] * mg * MUS[i] * LM[i];
      if (m <= 0.002) continue;
      const pi = P[i];
      if (w.iw[pi] === 0) continue;
      // un miembro casi sin músculo (< 2 %) no amortigua: cuelga y cae con la
      // gravedad de verdad, no flota
      const a = (1 - phys) * Math.min(1, Math.max(0, (m - 0.02) * 14)) * Math.min(1, 1.45 * Math.sqrt(kSub * m));
      if (a <= 0) continue;
      w.vx[pi] += (vtx - w.vx[pi]) * a;
      w.vy[pi] += (vty - w.vy[pi]) * a;
      w.vz[pi] += (vtz - w.vz[pi]) * a;
    }
  }

  // ═══ bisagras: después de las restructurales, cada substep ════════════════
  solve(h, w) {
    const P = this.p;
    const fx = this.fx, fy = this.fy, fz = this.fz;
    const cap = 0.010 * this.scale;
    for (let n = 0; n < HINGES.length; n++) {
      const H = HINGES[n];
      if (!this.boneAlive[H[4]] || !this.boneAlive[H[5]]) continue;
      const jm = H[0], ja = H[1], jb = H[2], sgn = H[3];
      const pm = P[jm], pa = P[ja], pb = P[jb];
      if (w.iw[pm] === 0) continue;
      const ax = w.px[pa], ay = w.py[pa], az = w.pz[pa];
      const bx = w.px[pb], by = w.py[pb], bz = w.pz[pb];
      const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5, mz = (az + bz) * 0.5;
      const ex = w.px[pm] - mx, ey = w.py[pm] - my, ez = w.pz[pm] - mz;
      const dx = fx * sgn, dy = fy * sgn, dz = fz * sgn;
      const proj = ex * dx + ey * dy + ez * dz;
      const span = Math.hypot(bx - ax, by - ay, bz - az);
      const full = this._hingeFull || (this._hingeFull = this._hingeLens());
      const bend = clamp01(1 - span / full[n]);
      const need = 0.010 * this.scale + bend * full[n] * 0.34;
      if (proj >= need) continue;
      let corr = need - proj;
      if (corr > cap) corr = cap;
      w.px[pm] += dx * corr * 0.62; w.py[pm] += dy * corr * 0.62; w.pz[pm] += dz * corr * 0.62;
      if (w.iw[pa] > 0) { w.px[pa] -= dx * corr * 0.19; w.py[pa] -= dy * corr * 0.19; w.pz[pa] -= dz * corr * 0.19; }
      if (w.iw[pb] > 0) { w.px[pb] -= dx * corr * 0.19; w.py[pb] -= dy * corr * 0.19; w.pz[pb] -= dz * corr * 0.19; }
    }
  }
  _hingeLens() {
    const out = [];
    for (const [jm, ja, jb] of HINGES) out.push(this._rest(ja, jm) + this._rest(jm, jb));
    return out;
  }

  // ═══ reacciones físicas ═══════════════════════════════════════════════════
  /** Dirección del empujón en el marco del cuerpo: along (+ adelante) y lat (+ derecha). */
  _local(dx, dz) {
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return { along: dx * s + dz * c, lat: dx * c - dz * s, dx, dz };
  }

  /**
   * Tambaleo: pasos reales en la dirección del empujón, con latigazo del
   * torso; la raíz se va con él y el cuerpo QUEDA desplazado. `v0` en m/s.
   */
  stumble(dx, dz, v0 = 1.8, dur = 0.35) {
    if (this.dead || this.state !== 'up' || this.crawling) return false;
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    if (this.stumbleT > 0) {
      // ya tambalea: se suma (acotado), no se reinicia el latigazo
      this.stumbleX = this.stumbleX * 0.5 + dx * 0.5; this.stumbleZ = this.stumbleZ * 0.5 + dz * 0.5;
      const nl = Math.hypot(this.stumbleX, this.stumbleZ) || 1; this.stumbleX /= nl; this.stumbleZ /= nl;
      this.stumbleV = Math.min(3.2, this.stumbleV + v0 * 0.5);
      this.stumbleT = Math.max(this.stumbleT, dur * 0.7); this.stumbleDur = Math.max(this.stumbleDur, this.stumbleT);
      return true;
    }
    this.stumbleX = dx; this.stumbleZ = dz;
    this.stumbleV = Math.min(3.2, v0); this.stumbleT = dur; this.stumbleDur = dur;
    this.stumbles++;
    this.lunge = 0;
    return true;
  }

  /** Sacudón (overlay) encima de la marcha. `k` intensidad, `ctx` {sx, along, lat}. */
  playOverlay(name, k = 1, ctx = null) {
    const def = OVER[name];
    if (!def) return false;
    this.overlay = { def, t: 0, k, ctx: ctx || { sx: 1, along: 0, lat: 0 } };
    this.idleOv = null;
    this.lastFlinch = name;
    return true;
  }

  /**
   * Empujón de cuerpo entero (multitud, empujón del jugador, manotazo del
   * bruto): impulso a todas las partículas y, según la fuerza, tambaleo o
   * una caída elegida por el ángulo.
   */
  knockback(dx, dz, strength = 1, up = 0.35) {
    const w = this.world;
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    if (this.dead) return;
    // ya va volando: un segundo empujón suma poco (no se acumula sin techo)
    if (this.state !== 'up') strength *= 0.3;
    const v = 3.2 * strength;
    for (let i = 0; i < NP; i++) {
      const pi = this.p[i];
      if (w.iw[pi] === 0) continue;
      const hf = 0.5 + clamp01((POSE[i * 3 + 1]) / 1.7);
      w.vx[pi] += dx * v * hf * 0.8; w.vz[pi] += dz * v * hf * 0.8;
      w.vy[pi] += v * up * (i === HEAD || i === CHEST ? 1.2 : 0.6) * 0.7;
    }
    this.lastHitX = dx; this.lastHitZ = dz;
    this.stagger = Math.min(0.95, this.stagger + 0.35 + 0.3 * strength);
    if (strength >= 1.2 && this.state === 'up') { this.fall('knockback', dx, dz, strength); return; }
    if (this.state === 'up') {
      const L = this._local(dx, dz);
      this.stumble(dx, dz, 1.4 + 1.2 * strength, 0.3 + 0.15 * strength);
      this.playOverlay(L.along < -0.3 ? 'fl_chest_fold' : L.along > 0.3 ? 'fl_back_arch' : 'fl_side_lean', Math.min(1.6, 0.6 + strength * 0.5), { sx: L.lat > 0 ? 1 : -1, along: L.along, lat: L.lat });
      this.rootX += dx * 0.25 * strength; this.rootZ += dz * 0.25 * strength;
    }
    this.lunge = 0;
    this.wantSpeed = 0;
  }

  /** Choque a la carrera contra otro cuerpo de pie: variantes por ángulo y velocidad. */
  _bumpInto(o, bx, bz) {
    const R = this.rng || Math.random;
    const L = o._local(this.wantX, this.wantZ);   // el empujón visto desde el otro
    const sp = this.speed;
    // — el ÁGIL (el jugador) no se cae por chocar a alguien: lo lleva puesto con el
    //   hombro y sigue medio girado; el otro es el que tambalea o cae —
    if (this.agile) {
      o.knockback(this.wantX, this.wantZ, 0.7 + 0.25 * sp, 0.25);
      const sgn = L.lat > 0 ? 1 : -1;
      this.spin -= sgn * (0.8 + sp * 0.2);
      this.stagger = Math.min(0.6, this.stagger + 0.15);
      this.playOverlay('fl_shoulder', 0.9, { sx: -sgn, along: 0.5, lat: sgn * 0.5 });
      return;
    }
    if (L.along > 0.5) {
      // por la espalda: el de adelante cae de boca, yo me tropiezo con él
      o.knockback(this.wantX, this.wantZ, 0.9 + 0.3 * sp, 0.2);
      if (sp > 3.2 && R() < 0.5) this.fall('trip', this.wantX, this.wantZ, 1);
      else { this.stumble(-this.wantX, -this.wantZ, 1.2, 0.25); this.stagger = Math.min(0.9, this.stagger + 0.4); }
    } else if (L.along < -0.5) {
      // de frente: a más velocidad los dos se van al piso; si no, rebote mutuo
      if (sp > 3.4 && R() < 0.6) { o.knockback(this.wantX, this.wantZ, 1.3 + 0.2 * sp, 0.3); this.fall('knockback', -this.wantX, -this.wantZ, 1.1); }
      else { o.knockback(this.wantX, this.wantZ, 0.7 + 0.25 * sp, 0.25); this.stumble(-this.wantX, -this.wantZ, 1.5, 0.3); this.playOverlay('fl_chest_fold', 1, { sx: 1, along: -1, lat: 0 }); }
    } else {
      // hombrazo: el otro gira y tambalea de costado; yo sigo medio girado
      const sgn = L.lat > 0 ? 1 : -1;
      o.spin += sgn * (2.5 + sp * 0.6);
      o.knockback(this.wantX, this.wantZ, 0.6 + 0.2 * sp, 0.15);
      this.spin -= sgn * 1.5;
      this.stagger = Math.min(0.9, this.stagger + 0.35);
      this.limp = Math.max(this.limp, 0.08);
    }
  }

  /**
   * Se estrelló corriendo contra algo estático. De frente (normal de la pared
   * casi opuesta a la carrera) rebota y cae; de refilón raspa el hombro, gira y
   * sigue tambaleando a lo largo de la pared (y sólo se cae si venía muy rápido).
   */
  slam(dx, dz, speed) {
    const w = this.world;
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const v = Math.max(1.5, speed);
    // normal de lo que tiene adelante
    let nx = -dx, nz = -dz, hitBox = null;
    const t = w.raycastStatic(this.x, this.py(HIP), this.z, dx, 0, dz, 0.9 * this.scale, _out);
    if (t >= 0 && _out.nx !== undefined) { const nl = Math.hypot(_out.nx, _out.nz) || 1; nx = _out.nx / nl; nz = _out.nz / nl; hitBox = _out.box; }
    const headOn = -(dx * nx + dz * nz);       // 1 = de frente, 0 = de refilón
    const R = this.rng || Math.random;
    const ag = this.traits.agility;
    this.slams++;
    this.lunge = 0;
    this.lastHitX = -dx; this.lastHitZ = -dz;
    // ¿pegó con la cadera contra algo BAJO (el borde de un escritorio que no llegó a trepar)? → vuelca encima
    const base = this.groundY > -900 ? this.groundY : 0;
    const lowEdge = hitBox && (hitBox.cy + hitBox.hy - base) < 1.15 * this.scale && (hitBox.cy + hitBox.hy - base) > 0.45 * this.scale;
    if (lowEdge && speed > 2.6 && R() < 0.75) { this.slamCool = 1.5; return this.fall('vault_fail', dx, dz, 1); }
    // — el que hace parkour, rápido y no de frente del todo: planta un pie en la pared y se impulsa —
    if (this.traits.parkour && !lowEdge && speed > 2.8 && headOn > 0.4 && R() < 0.65) { if (this.wallKick(nx, nz, speed)) return; }
    // — el ÁGIL atrapa la pared con las manos: rebota, tambalea hacia atrás y NO se cae
    //   (el jugador siempre, salvo estrellarse de frente muy rápido; de los zombis sólo
    //   los de parkour, y no siempre: el resto se la lleva por delante, que es el show) —
    const catches = !lowEdge && (this.isPlayer ? !(headOn > 0.85 && speed > 5.0 && R() < 0.35) : (ag >= 0.8 && R() < 0.6));
    if (catches) {
      this.slamCool = 0.8;
      const L = this._local(nx, nz);
      this.playOverlay('wall_catch', 1 + speed * 0.1, { sx: L.lat > 0 ? 1 : -1, along: L.along, lat: L.lat });
      // las manos frenan el torso: el impulso que traía se amortigua, y rebota hacia atrás
      for (const i of [HEAD, NECK, CHEST, SHL, SHR, HIP]) {
        const pi = this.p[i]; if (w.iw[pi] === 0) continue;
        const cur = w.vx[pi] * dx + w.vz[pi] * dz;
        if (cur > 0) { w.vx[pi] -= dx * cur * 0.8; w.vz[pi] -= dz * cur * 0.8; }
      }
      this.stumble(nx, nz, 0.8 + speed * 0.22, 0.28);
      this.stagger = Math.min(0.9, this.stagger + (this.isPlayer ? 0.15 : 0.3));
      if (speed > 4.0) this.flinch(0.05);
      return;
    }
    this.slamCool = 1.5;
    // el torso conserva (o recupera) la velocidad que traía; las piernas se traban
    for (const i of [HEAD, NECK, CHEST, SHL, SHR, ELL, ELR, HAL, HAR, HIP]) {
      const pi = this.p[i];
      if (w.iw[pi] === 0) continue;
      const cur = w.vx[pi] * dx + w.vz[pi] * dz;
      const add = Math.max(0, v - cur) * (headOn > 0.7 ? 1 : 0.5);
      w.vx[pi] += dx * add; w.vz[pi] += dz * add;
      w.vy[pi] += 0.4 * (i === HEAD ? 1.6 : 1);
    }
    for (const i of [HPL, HPR, KNL, KNR, FTL, FTR]) {
      const pi = this.p[i];
      if (w.iw[pi] === 0) continue;
      w.vx[pi] *= 0.25; w.vz[pi] *= 0.25;
    }
    // a quien tenía adelante se lo lleva puesto
    const bodies = w.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const o = bodies[i];
      if (o === this || !o.p || o.dead || typeof o.knockback !== 'function' || !o.upright) continue;
      const ox = o.x - this.x, oz = o.z - this.z;
      const d = Math.hypot(ox, oz);
      if (d > 0.95 * this.scale || d < 1e-4) continue;
      if ((ox * dx + oz * dz) / d < 0.5) continue;
      o.knockback(dx, dz, 0.55 + speed * 0.28, 0.3);
    }
    if (headOn > 0.72 || speed < 2.2) {
      this.fall('wall', dx, dz, 0.6 + speed * 0.2);
    } else {
      // de refilón: gira hacia la tangente, raspa y tambalea a lo largo de la pared
      let tx = dx - nx * (dx * nx + dz * nz), tz = dz - nz * (dx * nx + dz * nz);
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const L = this._local(nx, nz);
      this.spin += (L.lat > 0 ? -1 : 1) * (3 + speed * 0.5);
      this.stagger = Math.min(0.95, 0.5 + speed * 0.1);
      this.stumble(tx * 0.8 + nx * 0.6, tz * 0.8 + nz * 0.6, 1.2 + speed * 0.3, 0.45);
      this.playOverlay('fl_shoulder', 1.3, { sx: L.lat > 0 ? 1 : -1, along: 0.5, lat: -L.lat });
      if (speed > 3.6 && R() < 0.5) this.fall('shot', nx * 0.3 + tx, nz * 0.3 + tz, 1);
    }
  }

  /** Sacudón corto: física pura `t` segundos (un tiro, un golpe). */
  flinch(t) { this.limp = Math.max(this.limp, t); }

  /**
   * DIRECTOR DE CAÍDAS. `cause`: 'shot' | 'knockback' | 'wall' | 'trip' |
   * 'collapse' | 'tackle' | 'die'. (dx,dz): hacia dónde va el empujón.
   * `power` ~1 normal, 2 enorme. Elige la variante por causa y ángulo
   * (de espaldas, de tabla, de boca, de rodillas, de costado, girando…).
   */
  fall(cause, dx = this.fx, dz = this.fz, power = 1, forceName = null) {
    if (this.dead || this.crawling) return false;
    if (this.seq && (this.seq.def.kind === 'fall' || this.seq.def.kind === 'die')) return false;
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const L = this._local(dx, dz);
    const R = this.rng || Math.random;
    const runner = this.kind === 'runner', moving = this.speed > 1.5;
    let def = forceName ? SEQ[forceName] : null;
    let s = L.lat > 0 ? 1 : 0;
    if (!def) {
      const pick = (opts) => {
        let tot = 0; for (const [, w] of opts) tot += w;
        let r = R() * tot;
        for (const [n, w] of opts) if ((r -= w) <= 0) return SEQ[n];
        return SEQ[opts[opts.length - 1][0]];
      };
      const sideW = Math.abs(L.lat) > 0.45 ? 2.5 : 0.4;
      const agile = this.agile;
      if (cause === 'die') {
        def = pick([['die_collapse', 2], ['die_stagger', moving ? 3 : 0.8], ['die_knees', 2], ['die_back', L.along < -0.3 ? 3 : 0.3], ['die_spin', sideW], ['die_slump', 1.5]]);
      } else if (cause === 'tackle') {
        def = SEQ.tackle;
      } else if (cause === 'vault_fail') {
        def = SEQ.fall_over_edge;
      } else if (cause === 'pounce_miss') {
        def = SEQ.fall_pounce_miss;
      } else if (cause === 'pounce_hit') {
        def = SEQ.fall_pounce_hit;
      } else if (cause === 'slip') {
        def = SEQ.fall_slip;
      } else if (power >= 1.9 && cause !== 'trip') {
        def = pick([['fall_fly', 3], ['fall_cartwheel', sideW * 0.8], ['fall_helicopter', sideW * 0.5]]);
      } else if (cause === 'wall') {
        def = pick([['fall_wall_bounce', 3], ['fall_wall_face', moving ? 2 : 0.5], ['fall_wall_slide', 1.5], ['fall_wall_crumple', 1.2], ['fall_back_plank', 0.6], ['fall_side', 0.6]]);
        if (def === SEQ.fall_side) s = R() < 0.5 ? 1 : 0;
        // la pared lo frena: el cuerpo va contra ella, cae hacia atrás
        dx = -dx; dz = -dz;
      } else if (cause === 'trip') {
        // el ágil sale rodando del tropezón casi siempre
        def = pick([['fall_front_face', agile ? 0.6 : 2.5], ['fall_front_knees', agile ? 0.4 : 1.2], ['fall_trip_roll', runner || agile ? 3.5 : 0.4], ['fall_faceplant', moving && !agile ? 1.5 : 0.1], ['fall_spin', 0.3]]);
      } else if (cause === 'collapse') {
        def = pick([['fall_collapse', 3], ['fall_front_knees', 1.5], ['fall_side', 0.8], ['fall_knees_slide', moving ? 2 : 0.3]]);
      } else if (L.along < -0.35) {
        // lo empujan hacia atrás (con mucha energía, las caídas que no viajan pesan poco)
        const strong = power > 1.25;
        def = pick([['fall_back_sit', 3], ['fall_back_plank', agile ? 0.6 : 2], ['fall_spin', sideW], ['fall_collapse', strong ? 0.15 : 0.8], ['fall_side', sideW * 0.5], ['fall_helicopter', agile ? 0.1 : sideW * 0.6], ['fall_slip', agile || strong ? 0.15 : 0.5]]);
      } else if (L.along > 0.35) {
        // lo empujan hacia adelante
        def = pick([['fall_front_face', agile ? 1 : 3], ['fall_front_knees', 1.5], ['fall_trip_roll', (runner || agile) && moving ? 2.5 : 0.2], ['fall_spin', sideW], ['fall_side', sideW * 0.5], ['fall_faceplant', moving && !agile ? 1.2 : 0.2], ['fall_stumble_long', moving && cause === 'shot' && !agile ? 1.5 : 0.1], ['fall_knees_slide', moving && !agile ? 0.8 : 0.1]]);
      } else {
        def = pick([['fall_side', 3], ['fall_spin', 2], ['fall_back_sit', 0.5], ['fall_cartwheel', power > 1.3 && !agile ? 1.5 : 0.1], ['fall_helicopter', agile ? 0.2 : 1]]);
      }
    }
    if (!def) return false;
    this.state = cause === 'die' ? 'dying' : 'falling';
    if (cause === 'die') this.dying = 1;
    this.falls++;
    this.rollChain = 0;
    this.lastFall = def.name;
    this.lastHitX = dx; this.lastHitZ = dz;
    this._playSeq(def, { dx, dz, power, s, cause, along: L.along, lat: L.lat });
    this.stagger = 0.9;
    return true;
  }

  /**
   * Trepar a lo que tenga adelante si es bajo (escritorio, mesa, mostrador,
   * caja grande): rayo al frente a media altura; si pega en una caja estática
   * con la tapa entre 0.35 y 1.05 m, arranca el guion de subida (agacharse,
   * manos al borde, recoger las piernas, estirarse arriba). Devuelve true si
   * arrancó. El cuerpo queda ARRIBA; bajar es caminar hasta el borde y caer,
   * y las rodillas absorben.
   */
  tryVault(dx, dz, forceStyle = null) {
    if (this.vault || this.flight || this.jumpPrep || this.dead || this.dying > 0 || this.crawling || this.state !== 'up') return false;
    const w = this.world;
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const hip = this.p[HIP];
    const ox = w.px[hip], oz = w.pz[hip], oy = this.groundY > -900 ? this.groundY + 0.55 * this.scale : w.py[hip] - 0.4;
    // a media altura (escritorios, mesas) y, si no hay nada, bajo (bancos, cajas, cadáveres altos)
    let t = w.raycastStatic(ox, oy, oz, dx, 0, dz, 1.1 * this.scale, _out);
    if (t < 0 || !_out.box) t = w.raycastStatic(ox, oy - 0.30 * this.scale, oz, dx, 0, dz, 1.1 * this.scale, _out);
    if (t < 0 || !_out.box) return false;
    const B = _out.box;
    const top = B.cy + B.hy;
    const base = this.groundY > -900 ? this.groundY : 0;
    const h = top - base;
    if (h > 1.05 * this.scale || h < 0.3) return false;
    const R = this.rng || Math.random;
    const sp = this.speed, parkour = this.traits.parkour, ag = this.traits.agility;
    // — algo bajo (banco, caja, cadáver alto) a la carrera: se salta en VALLA, sin manos —
    if (!forceStyle && h < 0.55 * this.scale && sp > 2.4 && (parkour || R() < 0.3 + ag * 0.6)) {
      const v0 = Math.sqrt(2 * 16 * (h + 0.25));
      const fv = Math.max(sp, 2.6);
      if (this.jump('hurdle', v0, dx * fv, dz * fv, { land: 'run', prep: 0.05 })) return true;
    }
    // — el que hace parkour, rápido: se tira de cabeza POR ENCIMA y rueda al caer —
    if (!forceStyle && parkour && h < 0.92 * this.scale && sp > 3.2 && R() < 0.35) {
      const depth = Math.min(1.2, Math.abs(B.hx * dx * B.c - B.hz * dz * B.s) + Math.abs(B.hx * dz * B.s + B.hz * dx * B.c) + 0.3);
      const v0 = Math.sqrt(2 * 16 * (h + 0.35));
      const fl = 2 * v0 / 16;
      const need = (t + depth + 0.6) / fl;
      if (this.jump('superman', v0, dx * Math.max(need, sp), dz * Math.max(need, sp), { land: 'roll', dive: true, prep: 0.06 })) return true;
    }
    // — trepada por estilo: según el tipo, el rasgo y la velocidad —
    let def = forceStyle ? VAULTS[forceStyle] : null;
    if (!def) def = pickStyle(VAULTS, this.kind, parkour, R, (s) => sp >= s.minSpeed && h <= s.maxH * this.scale);
    if (!def) def = VAULTS.clamber;
    // — a veces sale mal: rápido y torpe → se lleva el borde por delante y vuelca encima —
    const clumsy = (1 - ag) * clamp01((sp - 2.2) / 2.5) * 0.35;
    if (!forceStyle && !this.isPlayer && R() < clumsy) {
      this.vaultFails++;
      return this.fall('vault_fail', dx, dz, 1);
    }
    // cuánto hay que avanzar para quedar arriba: hasta el borde + un paso (los que vuelan, más)
    const travel = t + (0.55 + (def.name === 'kong' || def.name === 'dash' ? 0.35 : 0)) * this.scale;
    this.vault = { t: 0, dur: def.dur, x0: this.rootX, z0: this.rootZ, dx, dz, travel, y0: base, y1: top, def, style: def.name, kind: 'vault', s: R() < 0.5 ? 1 : 0, rel: 0, u: 0 };
    this.vaults++;
    this.lastVault = def.name;
    this.stagger = 0; this.lunge = 0; this.stumbleT = 0;
    return true;
  }

  // ═══ saltar ═══════════════════════════════════════════════════════════════
  /**
   * Salto: `v0` velocidad vertical de despegue (m/s), (vx,vz) velocidad
   * horizontal que lleva en el aire. Primero se agacha `prep` segundos (la
   * marcha sigue), después despega con una patada real a todas las partículas
   * y la pose se ancla al arco balístico. `opt.land`: 'crouch' | 'run' |
   * 'roll' | 'pounce'. `opt.dive`: se tira de cabeza (si no agarra, cae de panza).
   */
  jump(style, v0, vx, vz, opt = {}) {
    if (this.dead || this.dying > 0 || this.crawling || this.state !== 'up' || this.flight || this.jumpPrep || this.vault) return false;
    const def = JUMPS[style] || JUMPS.hop;
    const R = this.rng || Math.random;
    const g = -this.world.gravity;
    const J = { style: def.name, def, v0, vx, vz, y0: this.groundY > -900 ? this.groundY : 0, t: 0, dur: Math.max(0.05, 2 * v0 / g),
      s: opt.s ?? (R() < 0.5 ? 1 : 0), ph: R() * TAU, land: opt.land || 'crouch', dive: !!opt.dive, attack: opt.attack || null, target: opt.target || null, hit: false };
    const prep = opt.prep ?? def.prep;
    if (prep > 0.001) this.jumpPrep = { t: 0, dur: prep, style: def.name, J };
    else this._takeoff({ J });
    this.lunge = 0; this.stumbleT = 0; this.idleOv = null;
    return true;
  }
  _takeoff(JP) {
    const J = JP.J, w = this.world;
    J.y0 = this.groundY > -900 ? this.groundY : 0;
    this.flight = J; this.jumps++; this.lastJump = J.style; this.airPeak = 0; this.airT = 0;
    // patada real: todas las partículas salen con la velocidad del salto
    for (let i = 0; i < NP; i++) {
      const pi = this.p[i]; if (w.iw[pi] === 0) continue;
      w.vy[pi] += J.v0;
      w.vx[pi] += (J.vx - w.vx[pi]) * 0.6; w.vz[pi] += (J.vz - w.vz[pi]) * 0.6;
    }
    this.rootVX = J.vx; this.rootVZ = J.vz;
  }
  _land(J) {
    this.flight = null; this.tgtVY = 0; this.landT = 0; this.landedJump = J;
    const R = this.rng || Math.random;
    const gy = this.groundY > -900 ? this.groundY : 0;
    const drop = Math.max(0, J.y0 - gy) + Math.max(0, this.airPeak);   // cuánto cayó en total
    this.lastLandDrop = drop;
    this.landCrouch = Math.max(this.landCrouch, Math.min(0.6, J.def.land + drop * 0.25));
    const fwdV = J.vx * Math.sin(this.yaw) + J.vz * Math.cos(this.yaw);
    if (J.land === 'run') this.curSpeed = Math.hypot(J.vx, J.vz);
    // se tiró de cabeza (pounce, dive)
    if (J.dive) {
      // ¿cayó encima de lo que buscaba? → lo agarra: cae sobre él y se queda un instante
      const hit = J.target && Math.hypot(this.x - J.target.x, this.z - J.target.z) < 1.05 * this.scale;
      this.pounceHit = !!hit;
      if (hit && J.attack) { this.fall('pounce_hit', J.vx, J.vz, 1); return; }
      // falló: el de parkour rueda; el corredor cae parado, tambalea y SIGUE corriendo; el resto de panza
      if (J.land === 'roll' && fwdV > 1.2 && this.upright) { this.playMove(this.traits.parkour ? 'roll_shoulder' : 'roll_fwd', { s: J.s }); return; }
      if (this.traits.agility >= 0.5 && this.upright && R() < 0.65) {
        this.landCrouch = Math.max(this.landCrouch, 0.55);
        this.stagger = Math.min(0.9, this.stagger + 0.4);
        this.curSpeed = Math.hypot(J.vx, J.vz) * 0.6;
        this.stumble(J.vx, J.vz, 2.4, 0.4);
        this.playOverlay('fl_balance_arms', 1, { sx: 1, along: 1, lat: 0 });
        return;
      }
      this.fall('pounce_miss', J.vx, J.vz, 1);
      return;
    }
    // rodar al caer (parkour, o pedido)
    if (J.land === 'roll' && fwdV > 1.0 && this.upright) { this.playMove(this.traits.parkour ? 'roll_shoulder' : 'roll_fwd', { s: J.s }); return; }
    // aterrizaje feo: mucha altura y poca agilidad → se desploma
    if (drop > 0.9 && R() > this.traits.agility) { this.fall('collapse', this.fx, this.fz, 0.8); return; }
    if (drop > 0.6) this.stagger = Math.min(0.9, this.stagger + 0.25 * (1 - this.traits.agility));
  }
  /** Brinco a la carrera con el estilo propio (los que "pegan saltitos"). */
  hop(style = null) {
    if (!this.inControl || this.vault) return false;
    const st = style || this.traits.hopStyle;
    const R = this.rng || Math.random;
    const v0 = st === 'bound' ? 3.2 + R() * 0.6 : st === 'excited' ? 2.0 + R() * 0.4 : 2.4 + R() * 0.7;
    const sp = Math.max(this.curSpeed, this.wantSpeed * 0.8);
    const dx = sp > 0.3 ? this.wantX : Math.sin(this.yaw), dz = sp > 0.3 ? this.wantZ : Math.cos(this.yaw);
    const fwd = st === 'bound' ? Math.max(sp, 3.0) : st === 'excited' ? sp * 0.3 : sp;
    if (!this.jump(st, v0, dx * fwd, dz * fwd, { land: 'run' })) return false;
    this.hops++;
    return true;
  }
  /** Se lanza en plancha hacia un punto (el jugador): vuela y cae encima. */
  pounce(tx, tz, opt = {}) {
    const dx = tx - this.x, dz = tz - this.z;
    const d = Math.hypot(dx, dz) || 1;
    // arco más alto cuanto más lejos, así el vuelo dura y se ve la plancha
    const v0 = clamp(2.0 + d * 0.55, 2.4, 4.0);
    const fl = 2 * v0 / -this.world.gravity;
    const sp = Math.min(7.5, (d + 0.25) / fl);
    if (!this.jump('superman', v0, dx / d * sp, dz / d * sp, { land: opt.roll ? 'roll' : 'pounce', dive: true, attack: 'pounce', prep: 0.10, target: { x: tx, z: tz } })) return false;
    this.pounces++;
    return true;
  }
  /** Contra la pared a la carrera, en vez de estrellarse: planta un pie y se impulsa hacia atrás y arriba. */
  wallKick(nx, nz, speed) {
    const sp = Math.max(2.0, speed * 0.55);
    const vx = nx * sp, vz = nz * sp;
    if (!this.jump('wallkick', 3.0, vx, vz, { land: this.traits.parkour ? 'run' : 'crouch', prep: 0 })) return false;
    this.wallKicks++;
    // gira en el aire para caer mirando adonde va
    if (!this.lockYaw) this.spin += angDelta(this.yaw, Math.atan2(vx, vz)) * 5;
    this.slamCool = 1.2;
    return true;
  }
  /** Arranca un movimiento (rodar, deslizarse, embestir, gatear, agacharse). */
  playMove(name, ctx = {}) {
    const def = SEQ[name];
    if (!def || def.kind !== 'move' || this.dead || this.dying > 0 || this.crawling) return false;
    if (this.seq && this.seq.def.kind !== 'move' && this.state !== 'down' && this.state !== 'rising') return false;
    this.rootX = this.x; this.rootZ = this.z;
    this._playSeq(def, { s: 1, ...ctx });
    this.state = 'move';
    this.moves++; this.lastMove = name;
    if (name.startsWith('roll')) this.rolls++;
    return true;
  }
  /** Rodada de esquive en una dirección (el jugador con C corriendo). */
  roll(dx, dz) {
    if (!this.inControl || this.vault) return false;
    const l = Math.hypot(dx, dz) || 1;
    this.yaw = Math.atan2(dx / l, dz / l);
    return this.playMove(this.traits.parkour ? 'roll_shoulder' : 'roll_fwd', { s: (this.rng || Math.random)() < 0.5 ? 1 : 0 });
  }
  /**
   * Empuje pedido mientras está en el piso o levantándose (el jugador que
   * aprieta una dirección): vale por un frame, hay que pedirlo cada vez.
   */
  groundDrive(dx, dz, v = 1.4) {
    const l = Math.hypot(dx, dz);
    if (l < 0.2) { this.driveV = 0; return; }
    this.driveX = dx / l; this.driveZ = dz / l; this.driveV = v;
  }

  // ═══ bajar de algo ════════════════════════════════════════════════════════
  /** Medio metro adelante el piso cae `drop`: elegir cómo bajar según quién es. */
  _atEdge(drop, dx, dz, edge = 0.3) {
    const R = this.rng || Math.random;
    const kind = this.kind, pk = this.traits.parkour;
    const sp = Math.max(this.curSpeed, 0.5);
    this.edgeCool = 1.6;
    const r = R();
    let style;
    if (this.isPlayer) style = sp > 3.0 ? 'jump' : 'hop';
    else if (pk) style = r < 0.55 ? 'roll' : r < 0.85 ? 'jump' : 'hop';
    else if (kind === 'runner') style = r < 0.45 ? 'jump' : r < 0.75 ? 'hop' : r < 0.9 ? 'roll' : 'walk';
    else if (kind === 'jogger') style = r < 0.35 ? 'hop' : r < 0.6 ? 'jump' : r < 0.85 ? 'step' : 'walk';
    else if (kind === 'brute') style = r < 0.45 ? 'step' : r < 0.75 ? 'sit' : r < 0.9 ? 'walk' : 'trip';
    else style = r < 0.35 ? 'step' : r < 0.55 ? 'sit' : r < 0.8 ? 'walk' : r < 0.92 ? 'hop' : 'trip';
    // bajar con cuidado sólo si es bajo (un escritorio); de más alto se salta o se cae
    if ((style === 'step' || style === 'sit') && drop > 0.85 * this.scale) style = kind === 'brute' || kind === 'walker' ? 'walk' : 'hop';
    this.descents++; this.lastDescent = style;
    switch (style) {
      case 'walk': this.edgeCool = 0.9; return true;   // se deja caer caminando; las rodillas absorben
      case 'trip': this.edgeCool = 2.0; return this.fall('trip', dx, dz, 0.9);
      case 'hop': return this.jump('drop', 1.4, dx * Math.max(sp, 1.2), dz * Math.max(sp, 1.2), { land: 'run', prep: 0.04 });
      case 'jump': return this.jump('drop', 2.4, dx * Math.max(sp, 1.8), dz * Math.max(sp, 1.8), { land: 'run', prep: 0.08 });
      case 'roll': return this.jump(sp > 2.5 ? 'superman' : 'drop', 2.2, dx * Math.max(sp, 2.2), dz * Math.max(sp, 2.2), { land: 'roll', prep: 0.08, dive: sp > 2.5 });
      default: return this._startDescent(DESCENTS[style], dx, dz, drop, edge);
    }
  }
  _startDescent(def, dx, dz, drop, edge = 0.3) {
    const R = this.rng || Math.random;
    const base = this.groundY;
    // la raíz va hasta el borde y un paso más allá; la altura recién baja al pasar el borde
    const travel = edge + 0.55 * this.scale;
    this.vault = { t: 0, dur: def.dur, x0: this.rootX, z0: this.rootZ, dx, dz, travel, edgeF: edge / travel, y0: base, y1: base - drop, def, style: def.name, kind: 'descent', s: R() < 0.5 ? 1 : 0, rel: 0, u: 0 };
    this.stagger = 0; this.lunge = 0; this.stumbleT = 0;
    return true;
  }

  /** Herida sostenida: una mano a la zona golpeada un rato, mientras sigue andando. */
  _setWound(zone, sx, dmg) {
    const name = WOUNDS[zone];
    if (!name || !OVER[name]) return;
    const k0 = this.woundOv ? this.woundOv.k : 0;
    this.woundOv = { def: OVER[name], t: 0, k: k0, ctx: { sx, along: 0, lat: 0 }, life: 1.2 + Math.min(3, dmg * 0.04) };
  }

  // ═══ daño ═════════════════════════════════════════════════════════════════
  /**
   * @param {number} boneIdx  índice de hueso del cuerpo (0..NB-1)
   * @param {number} s        posición a lo largo del hueso (0..1)
   * @param {number} dmg      daño base
   * @param {number[]} imp    impulso [x,y,z] en N·s
   * @returns {{zone:number, killed:boolean, severed:boolean, damage:number}}
   */
  //  Reacción al impacto, al estilo "physical animation" (Unreal/Euphoria):
  //   1. impulso LOCAL en el punto del hueso (repartido entre sus dos
  //      partículas según dónde pegó): el miembro se va, el torso gira si el
  //      impacto fue descentrado;
  //   2. un SACUDÓN elegido por zona y ángulo (la cabeza se va, el pecho se
  //      pliega, la espalda se arquea, se dobla por el estómago, el hombro
  //      gira el cuerpo, el brazo vuela, la cadera se va, se ladea, la pierna
  //      da un saltito) encima de lo que estuviera haciendo;
  //   3. un TAMBALEO con pasos reales en la dirección del tiro: la raíz se va
  //      con él y el cuerpo queda desplazado (no vuelve como una goma);
  //   4. mucho momento en poco tiempo (escopeta, ráfaga) lo tira, con una
  //      caída elegida por el ángulo; un tiro en la pierna corriendo lo
  //      tropieza; un tiro fuerte en la pierna parado lo desploma.
  hit(boneIdx, s, dmg, imp) {
    const w = this.world;
    const res = { zone: BONES[boneIdx][4], killed: false, severed: false, damage: 0 };
    if (!this.boneAlive[boneIdx]) return res;

    const [ia, ib] = BONES[boneIdx];
    const pa = this.p[ia], pb = this.p[ib];
    const S = this.scale;
    let J = 0, dx = 0, dy = 0, dz = 0;
    if (imp) {
      J = Math.hypot(imp[0], imp[1], imp[2]);
      if (J > 1e-6) { dx = imp[0] / J; dy = imp[1] / J; dz = imp[2] / J; }
      w.addImpulse(pa, imp[0] * (1 - s), imp[1] * (1 - s), imp[2] * (1 - s));
      w.addImpulse(pb, imp[0] * s, imp[1] * s, imp[2] * s);
      if (!this.dead && J > 0) {
        const M = 70 * this.massScale * S * S * S;
        const dv = (J / M) * 1.8;
        for (let i = 0; i < NP; i++) {
          const pi = this.p[i];
          if (w.iw[pi] === 0) continue;
          // las piernas están plantadas: reciben menos, y de ahí sale el vuelco
          const f = (i >= HPL) ? 0.3 : 1.0;
          w.vx[pi] += dx * dv * f; w.vz[pi] += dz * dv * f;
        }
        this.hitJ += J;
      }
    }

    const zone = res.zone;
    const mult = zone === 0 ? 4.0 : zone === 1 ? 1.0 : 0.6;
    res.damage = dmg * mult;
    this.boneHP[boneIdx] -= dmg;

    if (!this.dead) {
      const hl = Math.hypot(dx, dz);
      const hdx = hl > 1e-4 ? dx / hl : this.fx, hdz = hl > 1e-4 ? dz / hl : this.fz;
      this.lastHitX = hdx; this.lastHitZ = hdz;
      const L = this._local(hdx, hdz);
      const R = this.rng || Math.random;
      const kk = clamp(J / 7, 0.5, 2.2) * this.staggerScale;     // pistola = 1
      const ctx = { sx: L.lat > 0 ? 1 : -1, along: L.along, lat: L.lat };
      this.stagger = Math.min(0.9, this.stagger + dmg * 0.006 * this.staggerScale);
      // recién baleado nadie se rasca la cabeza: los tics de quieto esperan
      this.idleOv = null; this.idleNext = Math.max(this.idleNext, 2.0);
      this.flinch(clamp((0.03 + J * 0.006) * this.staggerScale, 0.02, 0.3));
      this._weakenAround(boneIdx, clamp01(dmg * 0.012));
      const up = this.state === 'up' && !this.crawling;
      let fell = false;
      // sorteo entre variantes de sacudón (para que dos tiros iguales no se vean iguales)
      const pickOv = (opts) => { let tot = 0; for (const [, wgt] of opts) tot += wgt; let r = R() * tot; for (const [n, wgt] of opts) if ((r -= wgt) <= 0) return n; return opts[0][0]; };
      const big = J >= 11 || dmg >= 40;
      if (zone === 0) {
        // la cabeza se va con el tiro
        const ph = this.p[HEAD];
        if (w.iw[ph] > 0) { w.vx[ph] += dx * J * 0.35; w.vy[ph] += 0.4; w.vz[ph] += dz * J * 0.35; }
        this.stagger = Math.min(0.9, this.stagger + 0.25 * this.staggerScale);
        if (up) this.playOverlay(pickOv([['fl_head_snap', big ? 0.5 : 3], ['fl_whiplash', 2], ['fl_jolt', big ? 3 : 0.3], ['fl_clutch_face', 1.2], ['fl_convulse', big ? 1 : 0.1]]), kk, ctx);
        if (up && dmg >= 18 && R() < 0.5) this._setWound(0, ctx.sx, dmg);
      } else if (zone === 1) {
        if (up) {
          if (boneIdx === B_CLAVL || boneIdx === B_CLAVR) {
            ctx.sx = boneIdx === B_CLAVR ? 1 : -1;
            this.playOverlay(pickOv([['fl_shoulder', 3], ['fl_spin_shoulder', 2], ['fl_shrug_roll', 1.2]]), kk, ctx);
            // el hombro empujado gira el cuerpo alrededor del otro
            if (!this.lockYaw) this.spin += (boneIdx === B_CLAVR ? -1 : 1) * L.along * J * 0.22 + ctx.sx * L.lat * J * 0.1;
            if (dmg >= 20 && R() < 0.5) this._setWound(2, ctx.sx, dmg);
          } else if (boneIdx === B_PELVL || boneIdx === B_PELVR) {
            this.playOverlay(pickOv([[Math.abs(L.lat) > 0.5 ? 'fl_side_lean' : 'fl_hip_thrust', 3], ['fl_hip_twist', 2], ['fl_knee_dip', 1]]), kk, ctx);
          } else if (boneIdx === B_SPINE && s > 0.55) {
            // bajo vientre: de frente se dobla; por la espalda la cadera se va
            this.playOverlay(pickOv([[L.along < 0 ? 'fl_gut' : 'fl_hip_thrust', 3], ['fl_clutch_gut', L.along < 0 ? 2 : 0.3], ['fl_knee_dip', 1]]), kk, ctx);
            if (dmg >= 20 && R() < 0.6) this._setWound(1, ctx.sx, dmg);
          } else {
            const base = L.along < -0.3 ? 'fl_chest_fold' : L.along > 0.3 ? 'fl_back_arch' : 'fl_side_lean';
            this.playOverlay(pickOv([[base, 3], ['fl_knee_dip', 1.2], ['fl_balance_arms', 1], ['fl_convulse', big ? 1.5 : 0.2], ['fl_crumple_partial', big ? 2 : 0.3], ['fl_whiplash', 0.6]]), kk, ctx);
            if (dmg >= 22 && R() < 0.45) this._setWound(1, ctx.sx, dmg);
          }
        }
      } else if (zone === 2) {
        const side = (boneIdx === B_UARMR || boneIdx === B_FARMR) ? 1 : 0;
        this.armLimp[side] = Math.max(this.armLimp[side], 0.5 + dmg * 0.012);
        ctx.sx = side ? 1 : -1;
        if (up) this.playOverlay(pickOv([['fl_arm_swing', 3], ['fl_clutch_arm', 2]]), kk, ctx);
        if (up && dmg >= 18 && R() < 0.5) this._setWound(2, ctx.sx, dmg);
      } else if (zone === 3) {
        const side = (boneIdx === B_THIGHR || boneIdx === B_SHINR) ? 1 : 0;
        ctx.sx = side ? 1 : -1;
        if (up && this.speed > 1.6 && this.upright && R() < (this.agile ? 0.6 : 0.85)) {
          // corriendo, una pierna baleada = tropezón (el corredor da la voltereta)
          this.tripped++;
          fell = this.fall('trip', this.fx, this.fz, 0.9);
        } else if (up && big && R() < 0.4) {
          // un tiro fuerte en la pierna parado: se desploma de ese lado
          fell = this.fall('collapse', hdx, hdz, 0.8);
        } else {
          this.legBuckle[side] = Math.max(this.legBuckle[side], 0.45 + dmg * 0.01);
          if (up) this.playOverlay(pickOv([['fl_leg_hop', 3], ['fl_knee_dip', 1.5], ['fl_crumple_partial', 1]]), kk, ctx);
          if (up && dmg >= 18 && R() < 0.4) this._setWound(3, ctx.sx, dmg);
        }
      }
      // tambaleo: pasos en la dirección del tiro (las piernas no tambalean
      // por un tiro en la pierna: se doblan, que es otra cosa)
      if (up && !fell && zone !== 3) {
        const v0 = (1.2 + J * 0.16) * this.staggerScale;
        this.stumble(hdx, hdz, v0, 0.30 + J * 0.014);
      }
      // mucho momento en poco tiempo (escopeta, ráfaga): se cae, con una
      // caída elegida por el ángulo
      const M0 = 70 * this.massScale * S * S * S;
      if (up && !fell && this.hitJ / M0 > 0.42) {
        this.fall('shot', hdx, hdz, 0.8 + (this.hitJ / M0));
        this.hitJ = 0;
      }
    }

    if (this.boneHP[boneIdx] <= 0 && DISTAL[boneIdx]) {
      this.sever(boneIdx);
      res.severed = true;
    }
    return res;
  }

  _weakenAround(boneIdx, amt) {
    // herida: la fuerza cae ya (y se recupera hacia el piso) y el piso baja un
    // poco para siempre (un brazo baleado tres veces ya no vuelve a ser el mismo)
    const [ia, ib] = BONES[boneIdx];
    const hurt = (i, f) => {
      this.muscle[i] = Math.max(0, this.muscle[i] - amt * f);
      this.muscleFloor[i] = Math.max(0.5, this.muscleFloor[i] - amt * f * 0.25);
    };
    hurt(ia, 1); hurt(ib, 1.4);
    const dist = DISTAL[boneIdx];
    if (dist) for (const i of dist) hurt(i, 1.8);
  }

  /** Corta un hueso: el pedazo distal se desprende y sigue simulado. */
  sever(boneIdx) {
    if (!this.boneAlive[boneIdx]) return null;
    const dist = DISTAL[boneIdx];
    if (!dist) return null;
    const w = this.world;
    this.boneAlive[boneIdx] = 0;
    w.breakConstraint(this.boneC[boneIdx]);
    w.killBone(this.bone[boneIdx]);

    const cut = new Set(dist);
    for (const [idx, a, b] of this.limitC) if (cut.has(a) !== cut.has(b)) w.breakConstraint(idx);
    for (const [idx, a, b] of this.extraC) if (cut.has(a) !== cut.has(b)) w.breakConstraint(idx);

    const g = NEXT_GROUP++;
    for (const i of dist) {
      this.muscle[i] = 0;
      this.muscleFloor[i] = 0;      // un pedazo cortado no se recupera
      w.pg[this.p[i]] = g;
      const R = this.rng || Math.random;
      w.vx[this.p[i]] += (R() - 0.5) * 5;
      w.vy[this.p[i]] += R() * 3.5 + 1;
      w.vz[this.p[i]] += (R() - 0.5) * 5;
    }

    if (boneIdx === B_SKULL) { this.kill(); }
    if (boneIdx === B_THIGHL || boneIdx === B_THIGHR) {
      this.crawling = true;
      this.stride *= 0.6;
      // sin pierna no hay caídas ni levantadas: se arrastra
      this.seq = null; this.state = 'up'; this.stumbleT = 0;
    }
    const p0 = this.p[BONES[boneIdx][1]];
    return { x: w.px[p0], y: w.py[p0], z: w.pz[p0] };
  }

  /**
   * Muerte. Instantánea (tiro en la cabeza, escopeta a quemarropa): los
   * músculos se apagan ya y cae con la inercia que traía. Lenta: una
   * secuencia de muerte elegida por el ángulo del último golpe (se desploma,
   * camina herido y cae, cae de rodillas, se arquea de espaldas, gira…).
   */
  kill(instant = true) {
    if (this.dead) return;
    if (instant || this.dying > 0 || this.crawling || this.state !== 'up') { this._die(); return; }
    if (!this.fall('die', this.lastHitX, this.lastHitZ, 1)) this._die();
  }
  _die() {
    this.dead = true;
    this.dying = 0;
    this.deadT = 0;
    this.seq = null; this.overlay = null; this.idleOv = null;
    this.stumbleT = 0;
    this.wantSpeed = 0;
    this.muscleGlobal = 0;
    this.muscle.fill(0);
  }

  // ═══ compactación del mundo ═══════════════════════════════════════════════
  remapConstraints(map) {
    for (let b = 0; b < NB; b++) { const n = map.get(this.boneC[b]); if (n !== undefined) this.boneC[b] = n; }
    for (const e of this.extraC) { const n = map.get(e[0]); if (n !== undefined) e[0] = n; }
    for (const e of this.limitC) { const n = map.get(e[0]); if (n !== undefined) e[0] = n; }
    for (let k = 0; k < this._limSh.length; k++) { const n = map.get(this._limSh[k]); if (n !== undefined) this._limSh[k] = n; }
  }
  remapBones(map) {
    for (let b = 0; b < NB; b++) { const n = map.get(this.bone[b]); if (n !== undefined) this.bone[b] = n; }
  }

  /** Posición de un punto a lo largo de un hueso (0 = extremo A, 1 = extremo B). */
  bonePoint(b, s, out) {
    const w = this.world, [ia, ib] = BONES[b];
    const pa = this.p[ia], pb = this.p[ib];
    out.x = w.px[pa] + (w.px[pb] - w.px[pa]) * s;
    out.y = w.py[pa] + (w.py[pb] - w.py[pa]) * s;
    out.z = w.pz[pa] + (w.pz[pb] - w.pz[pa]) * s;
    return out;
  }

  /** Saca el cuerpo del mundo por completo. */
  dispose() {
    const w = this.world;
    for (let b = 0; b < NB; b++) {
      if (this.boneAlive[b]) { w.killBone(this.bone[b]); this.boneAlive[b] = 0; }
      w.breakConstraint(this.boneC[b]);
    }
    for (const [idx] of this.extraC) w.breakConstraint(idx);
    for (const [idx] of this.limitC) w.breakConstraint(idx);
    for (let i = 0; i < NP; i++) w.removeParticle(this.p[i]);
    const k = w.bodies.indexOf(this);
    if (k >= 0) w.bodies.splice(k, 1);
    this.alive = false;
  }
}
