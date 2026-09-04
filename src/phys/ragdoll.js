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
//  Lo que lo hace un ragdoll de verdad todo el tiempo:
//   · cada tiro es un sacudón físico (limp corto) antes de que los músculos
//     vuelvan a tomar el control;
//   · un cuerpo que corre y se estrella (pared, mueble, otro cuerpo) pierde el
//     control, se estrella con su inercia real, cae y se levanta;
//   · si lo empujan fuerte (multitud, escopeta, empujón) se cae;
//   · si los pies se traban en algo bajo mientras el torso sigue, tropieza;
//   · tirado queda aturdido ~1 s y se levanta en ~1 s con los músculos
//     subiendo en curva.
//
//  La marcha es procedural y mezcla caminar / trotar / correr según la
//  velocidad real; la fase avanza con la distancia recorrida, así los pies no
//  patinan. El paso va en la dirección del movimiento (pasos laterales si
//  el cuerpo mira a otro lado, como el jugador apuntando).
// ─────────────────────────────────────────────────────────────────────────────

import { CT_DIST, CT_MIN, CT_MAX, PF_GROUND, PF_HIT } from './world.js';
import { clamp, clamp01, lerp, angDelta, TAU } from '../core/util.js';

// ── índices de partícula ─────────────────────────────────────────────────────
export const HEAD = 0, NECK = 1, CHEST = 2, SHL = 3, SHR = 4, ELL = 5, ELR = 6,
  HAL = 7, HAR = 8, HIP = 9, HPL = 10, HPR = 11, KNL = 12, KNR = 13, FTL = 14, FTR = 15;
export const NP = 16;

// ── pose de referencia, de pie, en metros. Origen en el piso, entre los pies ──
export const POSE = new Float32Array([
  0.000, 1.720, 0.000,   // head
  0.000, 1.550, 0.000,   // neck
  0.000, 1.320, 0.000,   // chest
  -0.190, 1.450, 0.000,  // shoulder L
  0.190, 1.450, 0.000,   // shoulder R
  -0.225, 1.145, 0.020,  // elbow L
  0.225, 1.145, 0.020,   // elbow R
  -0.245, 0.865, 0.055,  // hand L
  0.245, 0.865, 0.055,   // hand R
  0.000, 0.960, 0.000,   // hip (raíz)
  -0.110, 0.925, 0.000,  // hip L
  0.110, 0.925, 0.000,   // hip R
  -0.120, 0.520, 0.010,  // knee L
  0.120, 0.520, 0.010,   // knee R
  -0.120, 0.062, 0.055,  // foot L  (apoyado: 13 mm por debajo del radio,
  0.120, 0.062, 0.055,   // foot R   así el pie PRESIONA el piso y agarra)
]);

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

let NEXT_GROUP = 1;
const _out = {};

export class Ragdoll {
  /**
   * @param {PhysWorld} world
   * @param {object} opt  {x,y,z,yaw,scale,massScale,toughness,armMode,stride,stiffness,
   *                       maxMuscleSpeed,isPlayer,lockYaw,staggerScale,rng}
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
    this.phase = (this.rng ? this.rng() : Math.random()) * TAU;
    this.stride = opt.stride ?? 0.24;
    this.armMode = opt.armMode ?? 'reach';
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
    this.idleT = (this.rng ? this.rng() : Math.random()) * 10;
    // sólo para 'aim' (el jugador): 1 apuntando / 0 corriendo; retroceso; recarga
    this.aimBlend = 1; this.recoil = 0; this.reloadT = 0;
    // heridas: cada miembro tiene un "piso" de músculo (baja con el daño, para
    // siempre) y una fuerza actual que se recupera hacia ese piso. Además una
    // pierna baleada se dobla un rato y un brazo baleado cuelga un rato.
    this.muscleFloor = new Float32Array(NP).fill(1);
    this.limbMul = new Float32Array(NP).fill(1);
    this.legBuckle = [0, 0]; this.armLimp = [0, 0];
    this.hitJ = 0;          // momento recibido recientemente (decae)
    // trucos de Overgrowth: inclinarse hacia la aceleración, mirar al objetivo,
    // prepararse con los brazos al caer; agacharse; trepar; aterrizar flexionando
    this.accX = 0; this.accZ = 0; this._vpx = 0; this._vpz = 0;
    this.lookX = 0; this.lookZ = 0;
    this.brace = 0;
    this.vault = null; this.autoVault = !this.isPlayer; this.vaults = 0;
    this.crouch = 0; this.wantCrouch = false;
    this.landCrouch = 0; this.airT = 0;

    // ── estados físicos ─────────────────────────────────────────────────────
    this.downT = 0;        // cuánto lleva tirado
    this.upT = 1;          // cuánto lleva erguido
    this.dying = 0;        // muerte lenta: cuánto falta
    this.limp = 0;         // segundos con los músculos apagados (golpe, choque)
    this.riseBlend = 0; this.riseFrom = 1;
    this.tripT = 0; this.tripped = 0;
    this.blockT = 0; this.slams = 0; this.slamCool = 0; this.bumpCool = 0; this.bumps = 0;
    this.canTrip = !this.isPlayer;
    this.canSlam = true;

    // ── raíz virtual ────────────────────────────────────────────────────────
    this.rootX = x; this.rootZ = z;
    this.leash = 0.30;
    this._hx = x; this._hz = z;          // cadera del frame anterior

    // ── personalidad ────────────────────────────────────────────────────────
    const R = this.rng || Math.random;
    this.pers = {
      phaseOff: R() * TAU,
      lean: (R() - 0.5) * 0.16,
      sway: 0.6 + R() * 0.9,
      headTilt: (R() - 0.5) * 0.30,
      headBob: 0.5 + R(),
      limp: R() < 0.35 ? 0.35 + R() * 0.4 : 1,   // una pierna con menos amplitud
      limpSide: R() < 0.5 ? 0 : 1,
      armHi: (R() - 0.5) * 0.22,
      armSpread: 0.8 + R() * 0.5,
      wobble: 0.4 + R() * 1.2,
      lurch: R() < 0.4 ? 0.3 + R() * 0.5 : 0,      // cadencia irregular
      hunch: R() * 0.08,                          // encorvado
      strideMul: 0.85 + R() * 0.3,                // zancada propia
      bobMul: 0.7 + R() * 0.7,                    // cuánto sube y baja
      armAsym: R() < 0.3 ? (R() < 0.5 ? 0 : 1) : -1,   // un brazo más vago
      jitter: R() * 0.6,                          // irregularidad del ciclo
    };

    // marco del cuerpo (se recalcula 1× por frame)
    this.fx = 0; this.fy = 0; this.fz = 1;
    this.rx = 1; this.ry = 0; this.rz = 0;
    this.ux = 0; this.uy = 1; this.uz = 0;

    this.target = new Float32Array(NP * 3);
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
  /** ¿Tiene el control de su cuerpo? (no está muerto, tirado ni sacudido) */
  get inControl() { return !this.dead && this.dying <= 0 && this.limp <= 0 && this.downT <= 0; }

  // ═══ actualización por frame (no por substep) ═════════════════════════════
  update(dt) {
    const w = this.world;

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
    if (this.dying > 0) {
      this.dying -= dt;
      this.wantSpeed = 0;
      if (this.dying <= 0) { this._die(); return; }
    }

    const hipP = this.p[HIP];
    const hx = w.px[hipP], hz = w.pz[hipP];

    // — altura del piso justo debajo de la cadera (trepando, la marca el guion) —
    if (this.vault) {
      const V = this.vault, u = clamp01(V.t / V.dur);
      const r = clamp01((u - 0.3) / 0.4);
      this.groundY = lerp(V.y0, V.y1, r * r * (3 - 2 * r));
    } else {
      const t = w.raycastStatic(hx, w.py[hipP] + 0.1, hz, 0, -1, 0, 3.2 * this.scale, _out);
      this.groundY = t >= 0 ? _out.y : (Math.abs(hx) < w.groundHX && Math.abs(hz) < w.groundHZ ? w.groundY : -999);
    }

    // — ¿algún pie apoyado? —
    const grounded = (w.pf[this.p[FTL]] & PF_GROUND) || (w.pf[this.p[FTR]] & PF_GROUND) ||
      (w.pf[this.p[KNL]] & PF_GROUND) || (w.pf[this.p[KNR]] & PF_GROUND);
    this.airborne = grounded ? 0 : Math.min(1, this.airborne + dt * 2.5);

    if (this.stagger > 0) this.stagger = Math.max(0, this.stagger - dt);
    if (this.lunge > 0) this.lunge = Math.max(0, this.lunge - dt);
    if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - dt * 7);
    this.hitJ *= Math.exp(-dt * 6);

    // — heridas: los miembros recuperan fuerza hasta su piso; pierna doblada, brazo colgando —
    const mus = this.muscle, floor = this.muscleFloor, LM = this.limbMul;
    for (let i = 0; i < NP; i++) if (mus[i] < floor[i]) mus[i] = Math.min(floor[i], mus[i] + dt * 0.5);
    LM.fill(1);
    if (this.pers.armAsym >= 0) { const s2 = this.pers.armAsym; LM[s2 ? ELR : ELL] = 0.45; LM[s2 ? HAR : HAL] = 0.45; }
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

    // — orientación: girar hacia donde quiere ir —
    if (!this.lockYaw && this.wantSpeed > 0.05) {
      const goal = Math.atan2(this.wantX, this.wantZ);
      const turn = (this.crawling ? 2.2 : (4.5 + this.gait * 2.5)) * dt;
      this.yaw += clamp(angDelta(this.yaw, goal), -turn, turn);
    }

    // — la raíz avanza; la correa la ata al cuerpo real —
    //   La raíz NO entra en otro cuerpo que esté de pie: si no, dos cuerpos
    //   cinemáticos se funden y pasan uno a través del otro. Así un corredor
    //   que embiste a otro se frena (y si venía rápido, se estrella), y una
    //   fila de zombis se embotella en vez de superponerse. Los tirados se
    //   pisan o se tropiezan, no bloquean.
    const control = this.limp <= 0 && this.downT <= 0;
    this.rootBlocked = false;
    // — velocidad con inercia: no se pasa de 0 a tope en un frame. Acelera a
    //   ~9 m/s² y frena a ~14: arrancar y parar toman tiempo (menos robótico) y
    //   dejan ver la inclinación. curSpeed es la que de verdad mueve al cuerpo. —
    {
      const tgt = this.wantSpeed;
      const rate = (tgt > this.curSpeed ? 9 : 14) * dt;
      this.curSpeed += clamp(tgt - this.curSpeed, -rate, rate);
    }
    // — trepando: la raíz sigue un guion (adelante y arriba), nada de IA —
    if (this.vault) {
      const V = this.vault;
      V.t += dt;
      const u = clamp01(V.t / V.dur);
      const e = u * u * (3 - 2 * u);
      this.rootX = V.x0 + V.dx * V.travel * e;
      this.rootZ = V.z0 + V.dz * V.travel * e;
      if (u >= 1) this.vault = null;
    }
    // La raíz NO se mueve acá de un salto: se decide cuánto puede avanzar y el
    // avance se reparte por substep en preSolve (movimiento continuo: el
    // músculo no tiene que alcanzar un objetivo que salta 2 cm por frame).
    this.rootVX = 0; this.rootVZ = 0;
    if (this.wantSpeed > 0.01 && control && !this.vault) {
      const step = this.curSpeed * dt;
      const nx = this.rootX + this.wantX * step, nz = this.rootZ + this.wantZ * step;
      const bodies = w.bodies;
      let blocker = null;
      for (let i = 0; i < bodies.length; i++) {
        const o = bodies[i];
        if (o === this || !o.p || o.dead || o.downT > 0.2 || !o.upright) continue;
        const dx = o.x - nx, dz = o.z - nz;
        const rr = 0.42 * (this.scale + o.scale) * 0.5;
        if (dx * dx + dz * dz > rr * rr) continue;
        if (dx * this.wantX + dz * this.wantZ > 0) { blocker = o; break; }
      }
      if (!blocker) { this.rootVX = this.wantX * this.curSpeed; this.rootVZ = this.wantZ * this.curSpeed; }
      else {
        // bloqueado: seguir a la velocidad del de adelante en su dirección y
        // resbalar por la tangente, como una multitud que se escurre alrededor
        // (y no una fila clavada)
        let bx = blocker.x - this.rootX, bz = blocker.z - this.rootZ;
        const bl = Math.hypot(bx, bz) || 1; bx /= bl; bz /= bl;
        const dot = this.wantX * bx + this.wantZ * bz;
        let tx = this.wantX - bx * dot, tz = this.wantZ - bz * dot;
        const tl = Math.hypot(tx, tz);
        if (tl > 0.05) { tx /= tl; tz /= tl; this.rootX += tx * step * 0.8; this.rootZ += tz * step * 0.8; }
        const follow = Math.min(step, Math.max(0, blocker.wantSpeed || 0) * dt) * Math.max(0, dot);
        this.rootX += this.wantX * follow; this.rootZ += this.wantZ * follow;
        this.rootBlocked = true;
        // choque a la carrera contra alguien de pie: tropezón mutuo (yo
        // tambaleo, el otro sale empujado y puede caerse). Una vez por segundo.
        if (this.bumpCool > 0) this.bumpCool -= dt;
        if (this.speed > 2.3 && this.bumpCool <= 0 && blocker.inControl) {
          this.bumpCool = 1.0;
          this.stagger = Math.min(0.9, this.stagger + 0.5);
          this.limp = Math.max(this.limp, 0.12);
          blocker.knockback(this.wantX, this.wantZ, 0.6 + 0.26 * this.speed, 0.25);
          this.bumps = (this.bumps || 0) + 1;
        }
      }
    }
    const lx0 = this.rootX - hx, lz0 = this.rootZ - hz;
    const ld = Math.hypot(lx0, lz0);
    const leash = (this.wantSpeed > 0.01 ? this.leash : this.leash * 3.5) * this.scale;
    // — empujón externo: si la cadera se fue MUCHO más allá de la correa en
    //   un solo frame, lo empujaron fuerte (multitud, escopeta) → tambalea o cae
    if (control && this.upright && ld > leash + 0.07) {
      const over = ld - leash;
      this.stagger = Math.min(0.9, this.stagger + over * 2.5);
      if (over > 0.13) this.limp = Math.max(this.limp, 0.22 + over);
    }
    if (ld > leash) {
      const f = leash / ld;
      this.rootX = hx + lx0 * f;
      this.rootZ = hz + lz0 * f;
    }
    // La raíz nunca queda del otro lado de una pared: si no, los músculos
    // tirarían del cuerpo a través de ella (y lo lograrían). Si lo que frena
    // es bajo (escritorio, mesa, caja grande), se trepa.
    if (!this.vault) {
      const rx2 = this.rootX - hx, rz2 = this.rootZ - hz;
      const rd = Math.hypot(rx2, rz2);
      // mira hacia la raíz si está adelantada; si no, hacia donde quiere ir
      let ddx = 0, ddz = 0;
      if (rd > 0.04) { ddx = rx2 / rd; ddz = rz2 / rd; }
      else if (this.wantSpeed > 0.05 && control) { ddx = this.wantX; ddz = this.wantZ; }
      if (ddx || ddz) {
        const reach = Math.max(rd, 0.25) + 0.2;
        const tt0 = w.raycastStatic(hx, w.py[hipP], hz, ddx, 0, ddz, reach, _out);
        if (tt0 >= 0 && tt0 < reach) {
          const box = _out.box;
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
      if (this.autoVault && control && this.upright && this.wantSpeed > 0.4) {
        const gy = this.groundY > -900 ? this.groundY : 0;
        const t2 = w.raycastStatic(hx, gy + 0.35 * this.scale, hz, this.wantX, 0, this.wantZ, 0.7 * this.scale, _out);
        if (t2 >= 0 && _out.box) this.tryVault(this.wantX, this.wantZ);
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
      const moving2 = this.wantSpeed > 0.1 || this.curSpeed > 0.1;
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
    if (!this.dead && (this.limp > 0 || this.downT > 0)) {
      const vyC = w.vy[this.p[CHEST]];
      if (this.brace <= 0 && vyC < -1.0 && this.py(HEAD) < 1.35 && this.py(HEAD) > 0.45) this.brace = 0.5;
    }
    if (this.brace > 0) this.brace -= dt;

    // — ESTRELLARSE: venía corriendo DE VERDAD y de golpe no avanza (pared,
    //   mueble, otro cuerpo). El torso sigue con su inercia, sin músculos.
    //   Se exige velocidad real (no la deseada), no estar en plena manotada, y
    //   hay enfriamiento: si no, un cuerpo bloqueado se "estrellaba" 20 veces
    //   por segundo sumando velocidad y salía volando.
    if (this.slamCool > 0) this.slamCool -= dt;
    if (this.canSlam && control && this.upright && !this.rootBlocked && this.wantSpeed > 2.0 && this.lunge <= 0 && this.slamCool <= 0 && dt > 0) {
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
    if (this.canTrip && this.wantSpeed > 0.5 && this.upright && control && !this.crawling) {
      let contact = false;
      for (const i of [FTL, FTR, KNL, KNR]) {
        const f = w.pf[this.p[i]];
        if ((f & PF_HIT) && !(f & PF_GROUND)) { contact = true; break; }
      }
      let lag = 0;
      if (contact) {
        const c0 = Math.cos(this.yaw), s0 = Math.sin(this.yaw);
        const T = this.target, S = this.scale;
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
        this.knockback(this.fx, this.fz, 1.35, 0.15);
        this.tripped++;
      }
    } else this.tripT = 0;

    // — fase del ciclo: avanza con la distancia recorrida, no con el tiempo —
    const v = Math.max(this.speed, this.wantSpeed * 0.6);
    this.gait = lerp(this.gait, clamp01((v - 0.7) / 2.3), 1 - Math.pow(0.05, dt));
    // un ciclo cubre 4 zancadas (el pie en apoyo va de +st a -st mientras el
    // cuerpo avanza 2·st, dos veces): así el pie apoyado no patina
    const st = this.stride * this.scale * lerp(0.8, 2.0, this.gait);
    const strideLen = Math.max(0.12, st * 4);
    let cadence = this.speed / strideLen;
    if (this.pers.lurch && this.gait < 0.5) cadence *= 1 + Math.sin(this.phase * 0.5) * this.pers.lurch * 0.5;
    const idle = this.wantSpeed > 0.05 ? 0.35 : 0.13;
    this.phase = (this.phase + (cadence + idle) * TAU * dt) % TAU;
    this.idleT += dt;

    // — caído: primero queda tirado (aturdido), después se levanta de a poco —
    const up = this.upright;
    this.upT = up ? this.upT + dt : 0;
    if (!up && !this.crawling) this.downT += dt;
    else if (this.downT > 0 && (this.upT > 0.3 || this.crawling)) {
      const daze = this._daze();
      const tt = this.downT - daze;
      const r = tt > 0 ? clamp01(tt / 1.3) : 0;
      this.riseFrom = tt > 0 ? lerp(0.02, 0.9, r * r) : 0.02;
      this.riseBlend = 0.5;
      this.downT = 0;
    }
    if (this.riseBlend > 0) this.riseBlend -= dt;

    // — músculo global —
    let m = 1;
    if (this.stagger > 0) m *= lerp(0.22, 1, 1 - clamp01(this.stagger / 0.55));
    if (this.downT > 0) {
      const tt = this.downT - this._daze();
      if (tt < 0) m = 0;                                  // tirado: física pura
      else { const r = clamp01(tt / 1.3); m *= lerp(0.02, 0.9, r * r); }
    } else if (this.riseBlend > 0) {
      m *= lerp(1, this.riseFrom, clamp01(this.riseBlend / 0.5));
    }
    if (this.dying > 0) m *= Math.pow(clamp01(this.dying / 0.32), 1.5);
    if (this.limp > 0) { this.limp -= dt; m = 0; }         // golpe / choque: física pura
    m *= 1 - this.airborne * 0.55;                         // en el aire no hay de dónde hacer fuerza
    this.muscleGlobal = m;

    this._syncTarget(dt);
  }

  _daze() { return this.isPlayer ? 0.45 : 0.8 + this.pers.wobble * 0.45; }

  // ═══ pose objetivo ════════════════════════════════════════════════════════
  //  Todo en el espacio local del cuerpo: +Z adelante (hacia donde MIRA), +X
  //  derecha. El paso va en la dirección del MOVIMIENTO, que puede no ser +Z.
  _syncTarget(dt) {
    const T = this.target, S = this.scale, P = this.pers;
    for (let i = 0; i < NP * 3; i++) T[i] = POSE[i] * S;

    if (this.crawling) { this._poseCrawl(); return; }

    const g = this.gait;
    // un poco de irregularidad en el ciclo: nadie camina como un metrónomo
    const ph = this.phase + P.phaseOff + Math.sin(this.idleT * 1.7 + P.phaseOff) * P.jitter * 0.22;
    const moving = clamp01(this.wantSpeed / 1.0);        // 0 quieto … 1 caminando
    // zancada (medio paso, desde la cadera) y altura del pie en vuelo
    const st = this.stride * S * lerp(0.8, 2.0, g) * P.strideMul;
    const lift = lerp(0.05, 0.30, g) * S * (this.isPlayer ? 1.2 : 1);

    // — agacharse / aterrizar / trepar: el tronco baja y las rodillas doblan (IK) —
    let crouch = Math.max(this.crouch * 0.36, this.landCrouch > 0 ? Math.min(0.5, this.landCrouch) * 0.6 : 0) * S;
    let vaultU = -1;
    if (this.vault) {
      vaultU = clamp01(this.vault.t / this.vault.dur);
      // primero se agacha para tomar impulso, después se estira arriba
      crouch = Math.max(crouch, Math.sin(Math.PI * clamp01(vaultU / 0.5)) * 0.3 * S);
    }
    if (crouch > 0) {
      for (const i of [HIP, HPL, HPR, CHEST, NECK, HEAD, SHL, SHR]) T[i * 3 + 1] -= crouch;
      T[CHEST * 3 + 2] += crouch * 0.45; T[NECK * 3 + 2] += crouch * 0.6; T[HEAD * 3 + 2] += crouch * 0.7;
    }

    // dirección del paso en coordenadas locales (pasos laterales / hacia atrás)
    let sdx = 0, sdz = 1;
    if (this.wantSpeed > 0.05) {
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      sdz = this.wantX * s + this.wantZ * c;
      sdx = this.wantX * c - this.wantZ * s;
      const l = Math.hypot(sdx, sdz) || 1; sdx /= l; sdz /= l;
    }

    // — piernas: trayectoria del pie + rodilla por IK de dos huesos —
    //  Apoyo [0,π): el pie va de +st a -st LINEAL (a la velocidad del cuerpo:
    //  cero patinaje). Vuelo [π,2π): vuelve de -st a +st con suavizado y sube
    //  en arco. La rodilla se calcula con el largo real de muslo y pantorrilla
    //  y se dobla hacia adelante: por eso SE VE la flexión al trotar y correr.
    const L1 = this._legL1 || (this._legL1 = this._rest(HPL, KNL));
    const L2 = this._legL2 || (this._legL2 = this._rest(KNL, FTL));
    for (let side = 0; side < 2; side++) {
      const kn = side ? KNR : KNL, ft = side ? FTR : FTL, hp = side ? HPR : HPL;
      const amp = (P.limpSide === side ? P.limp : 1) * moving;
      let lp = (ph + (side ? Math.PI : 0)) % TAU; if (lp < 0) lp += TAU;
      let fz, fy;
      if (lp < Math.PI) { const u = lp / Math.PI; fz = st * (1 - 2 * u); fy = 0; }
      else { const u = (lp - Math.PI) / Math.PI; const e = u * u * (3 - 2 * u); fz = st * (2 * e - 1); fy = lift * Math.sin(u * Math.PI); }
      fz *= amp; fy *= amp;
      let footX = POSE[ft * 3] * S + sdx * fz;
      let footY = POSE[ft * 3 + 1] * S + fy;
      let footZ = POSE[ft * 3 + 2] * S + sdz * fz;
      if (vaultU >= 0) {
        // trepando: las piernas se recogen (rodillas al pecho) mientras el
        // cuerpo sube, y se estiran para apoyar arriba
        const tuck = Math.sin(Math.PI * clamp01((vaultU - 0.25) / 0.6));
        footY += tuck * 0.55 * S; footZ += tuck * 0.30 * S;
      }
      T[ft * 3] = footX; T[ft * 3 + 1] = footY; T[ft * 3 + 2] = footZ;
      // la cadera del lado que vuela baja apenas
      T[hp * 3 + 1] -= fy * 0.12;
      // IK: cadera lateral → pie
      const hpx = T[hp * 3], hpy = T[hp * 3 + 1], hpz = T[hp * 3 + 2];
      let dx = footX - hpx, dy = footY - hpy, dz = footZ - hpz;
      let d = Math.hypot(dx, dy, dz) || 1e-4;
      const maxD = (L1 + L2) * 0.985;
      if (d > maxD) { const f = maxD / d; dx *= f; dy *= f; dz *= f; d = maxD; }
      const ux = dx / d, uy = dy / d, uz = dz / d;
      const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
      const hh = Math.sqrt(Math.max(0, L1 * L1 - a * a));
      // la rodilla dobla hacia ADELANTE del cuerpo (+Z local), apenas hacia afuera
      let bx = side ? 0.12 : -0.12, by = 0, bz = 1;
      const dot = bx * ux + by * uy + bz * uz;
      bx -= ux * dot; by -= uy * dot; bz -= uz * dot;
      const bl = Math.hypot(bx, by, bz);
      if (bl > 1e-4) { bx /= bl; by /= bl; bz /= bl; } else { bx = 0; by = 0; bz = 1; }
      T[kn * 3] = hpx + ux * a + bx * hh;
      T[kn * 3 + 1] = hpy + uy * a + by * hh;
      T[kn * 3 + 2] = hpz + uz * a + bz * hh;
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
    const bob = Math.cos(ph * 2) * lerp(0.022, 0.05, g) * S * (0.2 + moving) * P.bobMul;
    T[CHEST * 3] += sw * 0.55; T[NECK * 3] += sw * 0.3; T[HEAD * 3] += sw * 0.15;
    T[FTL * 3] -= sw; T[FTR * 3] -= sw; T[KNL * 3] -= sw * 0.6; T[KNR * 3] -= sw * 0.6;
    T[CHEST * 3 + 1] -= bob * 0.7; T[NECK * 3 + 1] -= bob * 0.6; T[HEAD * 3 + 1] -= bob * 0.5;
    T[FTL * 3 + 1] += bob * 0.3; T[FTR * 3 + 1] += bob * 0.3;
    // inclinación hacia adelante: caminando poco, corriendo mucho; el zombi además encorvado
    const lean = (0.04 + moving * 0.05 + g * 0.16 + P.lean + P.hunch) * S;
    T[CHEST * 3 + 2] += lean * 0.55; T[SHL * 3 + 2] += lean * 0.6; T[SHR * 3 + 2] += lean * 0.6;
    T[NECK * 3 + 2] += lean * 0.9;
    T[HEAD * 3 + 2] += lean * 1.25;
    T[HEAD * 3 + 1] -= P.hunch * 0.6 * S + g * 0.03 * S;
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

    // — brazos: la mano se pone, el codo sale por IK doblando hacia atrás/afuera —
    const sp = P.armSpread;
    const A1 = this._armL1 || (this._armL1 = this._rest(SHL, ELL));
    const A2 = this._armL2 || (this._armL2 = this._rest(ELL, HAL));
    const elbowIK = (side, hx, hy, hz, bx, by, bz) => {
      const sh = side ? SHR : SHL, el = side ? ELR : ELL, ha = side ? HAR : HAL;
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
    };
    if (vaultU >= 0) {
      // trepando: las manos van al borde (adelante y abajo) y empujan
      const push = Math.sin(Math.PI * clamp01(vaultU / 0.7));
      for (let side = 0; side < 2; side++) {
        const sgn = side ? 1 : -1;
        elbowIK(side, sgn * 0.24 * S, (1.05 - push * 0.25) * S, (0.45 + push * 0.15) * S, sgn * 0.8, -0.3, -0.5);
      }
    } else if (this.armMode === 'reach') {
      // el clásico: brazos hacia adelante, temblando; con `lunge` se disparan
      // más lejos y más bajo (la manotada); corriendo van más altos y bombean.
      const tr = Math.sin(ph * 1.7) * 0.035 * P.wobble * S;
      const lg = this.lunge > 0 ? Math.sin(Math.min(1, this.lunge / 0.35) * Math.PI) : 0;
      for (let side = 0; side < 2; side++) {
        const sh = side ? SHR : SHL, sgn = side ? 1 : -1;
        const lp = ph + (side ? 0 : Math.PI);
        const pump = Math.sin(lp) * st * 0.3 * g;
        const hx = (POSE[(side ? HAR : HAL) * 3] * S) * sp * (0.9 - lg * 0.35);
        const hy = POSE[sh * 3 + 1] * S - 0.14 * S + P.armHi * S - lg * 0.10 * S + g * 0.08 * S;
        const hz = (0.50 + 0.1 * (1 - g)) * S + tr * 1.6 + lg * 0.22 * S + pump * 1.2;
        // el codo cae hacia abajo y afuera
        elbowIK(side, hx, hy, hz, sgn * 0.7, -0.8, -0.2);
      }
    } else if (this.armMode === 'aim') {
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
      elbowIK(1, hrx, hry, hrz, 0.9, -0.5, -0.3);
      elbowIK(0, hlx, hly, hlz, -0.9, -0.6, -0.2);
      T[SHR * 3 + 2] += 0.03 * S * ab; T[SHL * 3 + 2] -= 0.02 * S * ab;
      // corriendo el torso se adelanta más y la cabeza mira al frente del paso
      T[CHEST * 3 + 2] += 0.03 * S * rb * moving; T[HEAD * 3 + 2] += 0.04 * S * rb * moving;
    } else if (this.armMode === 'pump') {
      // corriendo: brazos en oposición a la pierna del mismo lado, codos a 90°,
      // manos a la altura del pecho; caminando cuelgan y se mecen
      for (let side = 0; side < 2; side++) {
        const sh = side ? SHR : SHL, ha = side ? HAR : HAL, sgn = side ? 1 : -1;
        const lp = ph + (side ? Math.PI : 0);            // opuesto a la pierna del mismo lado
        const sw2 = -Math.sin(lp) * moving;
        const hx = POSE[ha * 3] * S * sp * (1 - 0.15 * g);
        const hy = POSE[sh * 3 + 1] * S - lerp(0.58, 0.30, g) * S + Math.abs(sw2) * 0.06 * S * g;
        const hz = sw2 * st * lerp(0.6, 0.75, g) + 0.10 * g * S;
        elbowIK(side, hx, hy, hz, sgn * 0.45, -0.35, -0.9);
      }
    } else {
      // 'low': brazos colgando, apenas se mecen
      for (let side = 0; side < 2; side++) {
        const sh = side ? SHR : SHL, ha = side ? HAR : HAL, sgn = side ? 1 : -1;
        const lp = ph + (side ? Math.PI : 0);
        const hx = POSE[ha * 3] * S * sp, hy = POSE[ha * 3 + 1] * S, hz = -Math.sin(lp) * st * 0.5 * moving + 0.03 * S;
        elbowIK(side, hx, hy, hz, sgn * 0.4, -0.2, -0.95);
      }
    }
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
        const fx = this.fx, fz = this.fz;
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
    const hipLX = T[HIP * 3], hipLZ = T[HIP * 3 + 2];

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
    const phys = this.limp > 0 ? 1 : (this.stagger > 0 ? clamp01(this.stagger / 0.55) * 0.9 : 0);
    if (phys >= 0.999) return;
    const vtx = this.wantX * this.curSpeed, vtz = this.wantZ * this.curSpeed;
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
      w.vy[pi] -= w.vy[pi] * a;
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
  /**
   * Empujón de cuerpo entero: impulso a todas las partículas, la raíz virtual
   * se muda con el cuerpo y queda aturdido. Con fuerza ≥ 1.2 se apagan los
   * músculos un instante y se cae.
   */
  knockback(dx, dz, strength = 1, up = 0.35) {
    const w = this.world;
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    // ya va volando: un segundo empujón suma poco (no se acumula sin techo)
    if (this.limp > 0.1) strength *= 0.3;
    const v = 3.2 * strength;
    const tip = strength >= 1.3;
    for (let i = 0; i < NP; i++) {
      const pi = this.p[i];
      if (w.iw[pi] === 0) continue;
      const hf = 0.5 + clamp01((POSE[i * 3 + 1]) / 1.7);
      w.vx[pi] += dx * v * hf; w.vz[pi] += dz * v * hf;
      w.vy[pi] += v * up * (i === HEAD || i === CHEST ? 1.2 : 0.6);
    }
    // TUMBAR: al torso alto le sumamos empuje extra y a los pies les damos un
    // barrido hacia adelante — las piernas salen de abajo y el cuerpo cae de
    // espaldas, en vez de salir volando rígido y aterrizar parado.
    if (tip) {
      for (const i of [HEAD, NECK, CHEST]) w.addImpulse(this.p[i], dx * v * 4, v * 1.2, dz * v * 4);
      for (const i of [FTL, FTR, KNL, KNR]) { const pi = this.p[i]; if (w.iw[pi] > 0) { w.vx[pi] += dx * v * 1.4; w.vz[pi] += dz * v * 1.4; w.vy[pi] += 0.5; } }
    }
    this.rootX += dx * 0.9 * strength; this.rootZ += dz * 0.9 * strength;
    this.stagger = Math.min(0.95, this.stagger + 0.45 + 0.3 * strength);
    if (strength >= 1.2) this.limp = Math.max(this.limp, 0.45 + 0.18 * strength);
    this.lunge = 0;
    this.wantSpeed = 0;
  }

  /**
   * Se estrelló corriendo: el torso conserva la velocidad que traía, los
   * músculos se apagan un rato y el cuerpo pega contra lo que sea que lo
   * frenó. Más velocidad, más tiempo tirado.
   */
  slam(dx, dz, speed) {
    const w = this.world;
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const v = Math.max(1.5, speed);
    // el torso conserva (o recupera) la velocidad que traía; las piernas se
    // traban: de ahí el vuelco hacia adelante
    for (const i of [HEAD, NECK, CHEST, SHL, SHR, ELL, ELR, HAL, HAR, HIP]) {
      const pi = this.p[i];
      if (w.iw[pi] === 0) continue;
      const cur = w.vx[pi] * dx + w.vz[pi] * dz;
      const add = Math.max(0, v - cur);
      w.vx[pi] += dx * add; w.vz[pi] += dz * add;
      w.vy[pi] += 0.5 * (i === HEAD ? 1.6 : 1);
    }
    for (const i of [HPL, HPR, KNL, KNR, FTL, FTR]) {
      const pi = this.p[i];
      if (w.iw[pi] === 0) continue;
      w.vx[pi] *= 0.15; w.vz[pi] *= 0.15;
    }
    this.limp = Math.max(this.limp, 0.35 + speed * 0.1);
    this.stagger = 0.9;
    this.lunge = 0;
    this.slamCool = 1.5;
    this.slams++;
    // a quien tenía adelante se lo lleva puesto
    const bodies = w.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const o = bodies[i];
      if (o === this || !o.p || o.dead || !o.upright) continue;
      const ox = o.x - this.x, oz = o.z - this.z;
      const d = Math.hypot(ox, oz);
      if (d > 0.95 * this.scale || d < 1e-4) continue;
      if ((ox * dx + oz * dz) / d < 0.5) continue;
      o.knockback(dx, dz, 0.55 + speed * 0.28, 0.3);
    }
  }

  /** Sacudón corto: física pura `t` segundos (un tiro, un golpe). */
  flinch(t) { this.limp = Math.max(this.limp, t); }

  /**
   * Trepar a lo que tenga adelante si es bajo (escritorio, mesa, mostrador,
   * caja grande): rayo al frente a media altura; si pega en una caja estática
   * con la tapa entre 0.35 y 1.05 m, arranca el guion de subida (agacharse,
   * manos al borde, recoger las piernas, estirarse arriba). Devuelve true si
   * arrancó. El cuerpo queda ARRIBA; bajar es caminar hasta el borde y caer,
   * y las rodillas absorben.
   */
  tryVault(dx, dz) {
    if (this.vault || this.dead || this.dying > 0 || this.crawling) return false;
    const w = this.world;
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const hip = this.p[HIP];
    const ox = w.px[hip], oz = w.pz[hip], oy = this.groundY > -900 ? this.groundY + 0.55 * this.scale : w.py[hip] - 0.4;
    const t = w.raycastStatic(ox, oy, oz, dx, 0, dz, 1.1 * this.scale, _out);
    if (t < 0 || !_out.box) return false;
    const B = _out.box;
    const top = B.cy + B.hy;
    const base = this.groundY > -900 ? this.groundY : 0;
    if (top - base > 1.05 * this.scale || top - base < 0.3) return false;
    // cuánto hay que avanzar para quedar arriba: hasta el borde + un paso
    const travel = t + 0.55 * this.scale;
    this.vault = { t: 0, dur: 0.85, x0: this.rootX, z0: this.rootZ, dx, dz, travel, y0: base, y1: top };
    this.vaults++;
    this.stagger = 0; this.lunge = 0;
    return true;
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
  //   2. momento al CUERPO ENTERO (J/M, exagerado ×1.8 como en cualquier
  //      juego) y el objetivo de equilibrio (la raíz) se muda con el empujón:
  //      el cuerpo queda desplazado, no vuelve como una goma;
  //   3. la cadena golpeada queda sin músculo un instante (flinch) y, por
  //      zona: la cabeza se va hacia atrás; una pierna baleada se dobla si
  //      estaba parado o lo tropieza si venía corriendo; un brazo baleado
  //      cuelga un rato;
  //   4. mucho momento en poco tiempo (escopeta, ráfaga) lo tira.
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
        this.rootX += dx * dv * 0.28; this.rootZ += dz * dv * 0.28;
        this.hitJ += J;
      }
    }

    const zone = res.zone;
    const mult = zone === 0 ? 4.0 : zone === 1 ? 1.0 : 0.6;
    res.damage = dmg * mult;
    this.boneHP[boneIdx] -= dmg;

    if (!this.dead) {
      this.stagger = Math.min(0.9, this.stagger + dmg * 0.006 * this.staggerScale);
      this.flinch(clamp((0.05 + J * 0.012) * this.staggerScale, 0.02, 0.5));
      this._weakenAround(boneIdx, clamp01(dmg * 0.012));
      const R = this.rng || Math.random;
      if (zone === 0) {
        // la cabeza se va con el tiro
        const ph = this.p[HEAD];
        if (w.iw[ph] > 0) { w.vx[ph] += dx * J * 0.35; w.vy[ph] += 0.4; w.vz[ph] += dz * J * 0.35; }
        this.stagger = Math.min(0.9, this.stagger + 0.25 * this.staggerScale);
      } else if (zone === 2) {
        const side = (boneIdx === B_UARMR || boneIdx === B_FARMR) ? 1 : 0;
        this.armLimp[side] = Math.max(this.armLimp[side], 0.5 + dmg * 0.012);
      } else if (zone === 3) {
        const side = (boneIdx === B_THIGHR || boneIdx === B_SHINR) ? 1 : 0;
        if (this.speed > 1.6 && this.upright && R() < 0.7) {
          // corriendo, una pierna baleada = tropezón
          this.knockback(this.fx, this.fz, 1.3, 0.1);
          this.tripped++;
        } else {
          this.legBuckle[side] = Math.max(this.legBuckle[side], 0.45 + dmg * 0.01);
        }
      }
      // mucho momento en poco tiempo (escopeta, ráfaga): se cae, y cuanto más
      // momento, más tiempo sin control
      const M0 = 70 * this.massScale * S * S * S;
      if (this.hitJ / M0 > 0.42) {
        this.limp = Math.max(this.limp, 0.3 + (this.hitJ / M0) * 0.45);
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
    }
    const p0 = this.p[BONES[boneIdx][1]];
    return { x: w.px[p0], y: w.py[p0], z: w.pz[p0] };
  }

  /**
   * Muerte. Instantánea (tiro en la cabeza): los músculos se apagan ya.
   * Lenta (tiros al cuerpo): tambalea un tercio de segundo y recién ahí cae.
   */
  kill(instant = true) {
    if (this.dead) return;
    if (instant || this.dying > 0) { this._die(); return; }
    this.dying = 0.32;
    this.wantSpeed = 0;
  }
  _die() {
    this.dead = true;
    this.dying = 0;
    this.deadT = 0;
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
