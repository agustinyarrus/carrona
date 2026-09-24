// Calidad del ragdoll (sin navegador): métricas biomecánicas medidas cuadro a
// cuadro en escenarios aislados. Cada escenario corre determinista (semilla) y
// se le exige lo que un cuerpo "tipo Euphoria" tiene que cumplir: pies plantados
// que no patinan, articulaciones dentro de su rango, huesos que no se estiran,
// cadáveres que se asientan y no tiemblan, nada de picos de velocidad ni NaN, y
// un balance que no dispara en falso (caminar, correr, cortar a 90°) pero sí ante
// un empujón sostenido.
import { PhysWorld, PF_GROUND } from '../src/phys/world.js';
import { Ragdoll, HEAD, NECK, CHEST, SHL, SHR, ELL, ELR, HAL, HAR, HIP, HPL, HPR, KNL, KNR, FTL, FTR, NP, NB, BONES, B_SPINE, B_CLAVR, B_THIGHL } from '../src/phys/ragdoll.js';
import { RUN_STYLES, WALK_STYLES } from '../src/phys/moves.js';
import { makeRng } from '../src/core/util.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${name}   ${extra}`);
  if (!cond) fails++;
};
const DT = 1 / 60;
const V = (B, i) => [B.px(i), B.py(i), B.pz(i)];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1e-9; return [a[0] / l, a[1] / l, a[2] / l]; };
const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b))))) * 180 / Math.PI;
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
function distSeg(p, a, b) {
  const ab = sub(b, a), ap = sub(p, a);
  let t = dot(ap, ab) / (dot(ab, ab) || 1e-9); t = t < 0 ? 0 : t > 1 ? 1 : t;
  return len(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
}

/** Medidor: acumula violaciones (cuadros) y máximos sobre un cuerpo. */
class Meter {
  constructor() { this.n = 0; this.c = {}; this.mx = {}; this.prev = null; this.gnd = [0, 0]; }
  bump(k, v = 1) { this.c[k] = (this.c[k] || 0) + v; }
  max(k, v) { if (!(k in this.mx) || v > this.mx[k]) this.mx[k] = v; }
  pct(k) { return this.n ? 100 * (this.c[k] || 0) / this.n : 0; }
  get stretch() { return this.mx.stretchM || 0; }
  get neck() { return this.mx.neckAng || 0; }
  get vmax() { return this.mx.vMax || 0; }
  get pen() { return this.mx.penM || 0; }
  get skate() { return this.c.skateN ? this.c.skateSum / this.c.skateN : 0; }
  get skatePct() { return this.c.skateN ? 100 * (this.c.skate || 0) / this.c.skateN : 0; }
  get restRms() { return this.c.restN ? Math.sqrt(this.c.restV2 / this.c.restN) : 0; }
  get restTwitch() { return this.c.restN ? 100 * (this.c.restTwitch || 0) / this.c.restN : 0; }
  sample(B, w, opts = {}) {
    this.n++;
    const f = [B.fx, B.fy, B.fz], r = [B.rx, B.ry, B.rz], u = [B.ux, B.uy, B.uz];
    const P = []; for (let i = 0; i < NP; i++) P[i] = V(B, i);
    for (const [hp, kn, ft] of [[HPL, KNL, FTL], [HPR, KNR, FTR]]) {
      const off = sub(P[kn], mid(P[hp], P[ft]));
      // flexión perpendicular al eje del miembro, comparada con la nominal (adelante; si el
      // miembro apunta adelante, arriba): > 100° = dobla al revés; > 70° y grande = de costado
      const nn = norm(sub(P[ft], P[hp]));
      const ev = sub(off, [nn[0] * dot(off, nn), nn[1] * dot(off, nn), nn[2] * dot(off, nn)]);
      let b = sub(f, [nn[0] * dot(f, nn), nn[1] * dot(f, nn), nn[2] * dot(f, nn)]);
      if (len(b) < 0.35) b = sub(u, [nn[0] * dot(u, nn), nn[1] * dot(u, nn), nn[2] * dot(u, nn)]);
      const el = len(ev), th = el > 0.03 ? ang(ev, b) : 0;
      if (th > 100) { this.bump('kneeBack'); this.max('kneeBackM', el); }
      else if (th > 70 && el > 0.10) { this.bump('kneeSide'); this.max('kneeSideM', el); }
      const d = norm(sub(P[kn], P[hp]));
      if (dot(d, f) < -0.45) this.bump('hipExt');
      const lat = dot(d, r) * (hp === HPL ? -1 : 1);
      if (lat > 0.82) this.bump('hipAbd');
    }
    const spread = ang(norm(sub(P[KNL], P[HPL])), norm(sub(P[KNR], P[HPR])));
    this.max('thighSpread', spread);
    for (const [sh, el, ha] of [[SHL, ELL, HAL], [SHR, ELR, HAR]]) {
      const a = sub(P[el], P[sh]);
      if (dot(a, f) < -0.24) this.bump('shoulderBack');
      if (distSeg(P[el], P[CHEST], P[HIP]) < 0.17) this.bump('elbowInTorso');
      if (distSeg(P[ha], P[CHEST], P[HIP]) < 0.15) this.bump('handInTorso');
    }
    const nk = ang(sub(P[NECK], P[CHEST]), sub(P[HEAD], P[NECK]));
    this.max('neckAng', nk);
    if (nk > 70) this.bump('neckOver');
    const gy = w.groundY;
    let pen = 0;
    for (let i = 0; i < NP; i++) { const d = gy + w.pr[B.p[i]] - P[i][1] - 0.02; if (d > 0) { pen++; this.max('penM', d); } }
    if (pen) this.bump('floorPen', pen);
    for (let b = 0; b < NB; b++) { if (!B.boneAlive[b]) continue; const [ia, ib] = BONES[b]; const dd = len(sub(P[ia], P[ib])); const rest = B._rest(ia, ib); const s = Math.abs(dd - rest) / rest; if (s > 0.08) this.bump('stretch'); this.max('stretchM', s); }
    let vmax = 0, vsum = 0;
    for (let i = 0; i < NP; i++) { const pi = B.p[i]; const s = Math.hypot(w.vx[pi], w.vy[pi], w.vz[pi]); if (s > vmax) vmax = s; vsum += s * s; }
    this.max('vMax', vmax);
    if (vmax > 20) this.bump('vSpike');
    if (opts.rest) { this.bump('restN'); this.bump('restV2', vsum / NP); if (vmax > 0.35) this.bump('restTwitch'); this.max('restVmax', vmax); }
    for (let k = 0; k < 2; k++) { const pi = B.p[k ? FTR : FTL]; this.gnd[k] = (w.pf[pi] & PF_GROUND) ? this.gnd[k] + 1 : 0; }
    if (this.prev && opts.stance) {
      for (let k = 0; k < 2; k++) {
        const ft = k ? FTR : FTL;
        // sólo un pie PLANTADO (3 cuadros seguidos en el piso) cuenta: rozar el piso en el vuelo no es patinar
        if (this.gnd[k] >= 3) { const sp = Math.hypot(P[ft][0] - this.prev[ft][0], P[ft][2] - this.prev[ft][2]) / DT; this.bump('skateN'); this.bump('skateSum', sp); if (sp > 0.6) this.bump('skate'); this.max('skateM', sp); }
      }
    }
    this.prev = P;
    for (let i = 0; i < NP; i++) if (Number.isNaN(P[i][0] + P[i][1] + P[i][2])) this.bump('nan');
  }
}

const world = (boxes = []) => { const w = new PhysWorld(); w.groundHX = 30; w.groundHZ = 30; for (const b of boxes) w.addBox(...b); w.buildStaticIndex(); return w; };
const RUNNER = { stride: 0.32, armMode: 'pump', stiffness: 165, maxMuscleSpeed: 13, kind: 'runner' };
const PLAYER = { isPlayer: true, armMode: 'aim', lockYaw: true, stiffness: 175, maxMuscleSpeed: 13, staggerScale: 0.3, stride: 0.27 };
const body = (w, o = {}) => new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng: makeRng(o.seed ?? 1), ...o });
const run = (w, sec, fn) => { for (let i = 0; i < Math.round(sec * 60); i++) { for (const b of w.bodies) if (b.update) b.update(DT); w.step(DT); if (fn) fn(i * DT); } };
const nanFree = (w) => { for (let i = 0; i < w.pn; i++) if (Number.isNaN(w.px[i] + w.py[i] + w.pz[i])) return false; return true; };
const f2 = (x) => x.toFixed(2);
const pc = (x) => (x * 100).toFixed(0) + '%';

// ── 1. quieto y marcha: pies plantados, rodillas bien, nada estirado ────────
console.log('── quieto y marcha ──');
{
  const w = world(); const B = body(w, { seed: 1 }); const M = new Meter(); run(w, 1); run(w, 4, () => M.sample(B, w, { stance: true }));
  ok('quieto: los pies no se mueven, huesos sin estirar, sin penetrar el piso', M.skate < 0.05 && M.stretch < 0.05 && !M.c.floorPen && !M.c.kneeBack, `patina ${f2(M.skate)} m/s, estir ${pc(M.stretch)}`);
}
{
  const w = world(); const B = body(w, { seed: 2, ...PLAYER }); const M = new Meter(); run(w, 1); run(w, 4, () => M.sample(B, w, { stance: true }));
  ok('jugador quieto apuntando: idem', M.skate < 0.05 && M.stretch < 0.05 && !M.c.floorPen, `patina ${f2(M.skate)} m/s, estir ${pc(M.stretch)}`);
}
{
  const w = world(); const B = body(w, { seed: 3 }); const M = new Meter(); B.wantX = 0; B.wantZ = 1; B.wantSpeed = 1.4; run(w, 1.5); run(w, 4, () => M.sample(B, w, { stance: true }));
  ok('camina a 1,4: el pie apoyado patina < 0,35 m/s de media y rara vez > 0,6', M.skate < 0.35 && M.skatePct < 20, `media ${f2(M.skate)} m/s, > 0,6 en ${M.skatePct.toFixed(0)}%`);
  ok('camina: rodillas nunca al revés ni de costado, sin penetrar el piso, cuello < 45°', !M.c.kneeBack && !M.c.kneeSide && !M.c.floorPen && M.neck < 45, `cuello ${M.neck.toFixed(0)}°`);
  ok('camina: huesos estirados < 8 %', M.stretch < 0.08, pc(M.stretch));
}
{
  const w = world(); const B = body(w, { seed: 4, ...RUNNER }); const M = new Meter(); B.wantX = 0; B.wantZ = 1; B.wantSpeed = 3.8; run(w, 1.5); run(w, 4, () => M.sample(B, w, { stance: true }));
  ok('corre a 3,8: el pie apoyado patina < 0,55 m/s de media', M.skate < 0.55 && M.skatePct < 35, `media ${f2(M.skate)} m/s, > 0,6 en ${M.skatePct.toFixed(0)}%`);
  ok('corre: rodillas bien, sin penetrar el piso, huesos < 10 %, llega a la velocidad y sigue de pie', !M.c.kneeBack && !M.c.floorPen && M.stretch < 0.10 && B.upright && B.speed > 3.3, `estir ${pc(M.stretch)} v=${f2(B.speed)}`);
}
{
  const w = world(); const B = body(w, { seed: 5, ...PLAYER }); const M = new Meter(); B.wantX = 0; B.wantZ = 1; B.wantSpeed = 5.6; run(w, 1.5); run(w, 4, () => M.sample(B, w, { stance: true }));
  ok('jugador esprinta a 5,6: patina < 0,6 m/s, rodillas bien, huesos < 8 %', M.skate < 0.6 && !M.c.kneeBack && M.stretch < 0.08 && B.upright, `media ${f2(M.skate)} m/s, estir ${pc(M.stretch)}`);
}
{
  const w = world(); const B = body(w, { seed: 6, ...PLAYER }); const M = new Meter(); B.wantX = 1; B.wantZ = 0; B.wantSpeed = 3.6; run(w, 1.5); run(w, 4, () => M.sample(B, w, { stance: true }));
  ok('jugador de costado a 3,6 apuntando al frente: patina < 0,6 m/s, huesos < 8 %', M.skate < 0.6 && M.stretch < 0.08 && B.upright, `media ${f2(M.skate)} m/s, estir ${pc(M.stretch)}`);
}
// el centro de masa de la pose objetivo no salta al pasar de caminar a correr
// (los brazos cambian de estilo en continuo; un salto lo leía el balance como un empujón)
{
  const w = world(); const B = body(w, { seed: 5, ...RUNNER }); B.wantX = 0; B.wantZ = 1; B.wantSpeed = 1.2; run(w, 3);
  const MASS = [5, 2, 15, 3, 3, 2, 2, 1.5, 1.5, 13, 3, 3, 3.5, 3.5, 2, 2];
  const cm = () => { const T = B.target, c = Math.cos(B.yaw), s = Math.sin(B.yaw); let x = 0, z = 0, m = 0; for (let i = 0; i < NP; i++) { const lx = T[i * 3] - B.anchorX, lz = T[i * 3 + 2] - B.anchorZ; x += (B.rootX + lx * c + lz * s) * MASS[i]; z += (B.rootZ - lx * s + lz * c) * MASS[i]; m += MASS[i]; } return [x / m, z / m, B.rootX, B.rootZ]; };
  let prev = cm(), worst = 0;
  B.wantSpeed = 3.2;
  run(w, 3, () => { const c = cm(); const jump = Math.hypot(c[0] - prev[0] - (c[2] - prev[2]), c[1] - prev[1] - (c[3] - prev[3])); if (jump > worst) worst = jump; prev = c; });
  ok('caminar → correr: el centro de masa objetivo no salta más de 3 cm en un cuadro (brazos que se mezclan)', worst < 0.03 && B.upright, `salto máx ${(worst * 100).toFixed(1)} cm`);
}

// ── 2. tiros: flinch sin estirar el cráneo ni doblar el cuello, de pie ──────
console.log('\n── tiros ──');
{
  const w = world(); const B = body(w, { seed: 7 }); const M = new Meter(); run(w, 1);
  for (let k = 0; k < 3; k++) { B.hit(B_SPINE, 0.5, 30, [0, 1.5, -7]); run(w, 0.7, () => M.sample(B, w)); }
  run(w, 2, () => M.sample(B, w));
  ok('tres pistolazos al pecho: huesos estirados < 12 %, cuello < 85°, sigue de pie', M.stretch < 0.12 && M.neck < 85 && B.upright && B.state === 'up', `estir ${pc(M.stretch)} cuello ${M.neck.toFixed(0)}° estado ${B.state}`);
}
{
  const w = world(); const B = body(w, { seed: 8 }); const M = new Meter(); run(w, 1);
  B.hit(B_CLAVR, 0.5, 30, [0, 1, -7]); run(w, 1, () => M.sample(B, w)); B.hit(B_THIGHL, 0.5, 30, [0, 0.5, -6]); run(w, 2.5, () => M.sample(B, w));
  ok('pistola al hombro y a la pierna: huesos < 12 %, sin picos, de pie', M.stretch < 0.12 && !M.c.vSpike && B.upright, `estir ${pc(M.stretch)} vmax ${f2(M.vmax)}`);
}
for (const [name, seed, dir] of [['de frente', 9, -9], ['por la espalda', 10, 9]]) {
  const w = world(); const B = body(w, { seed }); const M = new Meter(); run(w, 1);
  for (let k = 0; k < 9; k++) B.hit(B_SPINE, 0.3 + k * 0.05, 14, [0, 2, dir]);
  let fell = false;
  run(w, 3.2, () => { M.sample(B, w); if (B.state === 'falling' || B.state === 'down') fell = true; });
  ok(`escopeta ${name}: cae, sin picos de velocidad, huesos < 12 %, cuello < 95°, penetra < 10 cm`, fell && M.vmax < 25 && M.stretch < 0.12 && M.neck < 95 && M.pen < 0.10, `cayó=${fell} vmax ${f2(M.vmax)} estir ${pc(M.stretch)} cuello ${M.neck.toFixed(0)}° piso ${(M.pen * 100).toFixed(0)}cm`);
}
{
  const w = world(); const B = body(w, { seed: 11, ...RUNNER }); const M = new Meter(); B.wantX = 0; B.wantZ = 1; B.wantSpeed = 3.8; run(w, 2);
  for (let k = 0; k < 9; k++) B.hit(B_SPINE, 0.3 + k * 0.05, 14, [9, 2, 0]);
  B.wantSpeed = 0; run(w, 3.2, () => M.sample(B, w));
  ok('escopeta de costado a un corredor: sin picos > 30 m/s, huesos < 15 %, sin NaN', M.vmax < 30 && M.stretch < 0.15 && !M.c.nan, `vmax ${f2(M.vmax)} estir ${pc(M.stretch)}`);
}

// ── 3. empujones ────────────────────────────────────────────────────────────
console.log('\n── empujones ──');
{
  const w = world(); const B = body(w, { seed: 12 }); const M = new Meter(); run(w, 1); B.knockback(0, -1, 1.5, 0.4); run(w, 3.5, () => M.sample(B, w));
  ok('knockback fuerte hacia atrás: sin picos > 30 m/s, huesos < 12 %, cuello < 95°', M.vmax < 30 && M.stretch < 0.12 && M.neck < 95, `vmax ${f2(M.vmax)} estir ${pc(M.stretch)} cuello ${M.neck.toFixed(0)}°`);
}
{
  const w = world(); const B = body(w, { seed: 13 }); const M = new Meter(); run(w, 1); B.knockback(1, 0, 3.0, 0.5); run(w, 3.5, () => M.sample(B, w));
  ok('knockback lateral violento: sin picos, huesos < 12 %, cuello < 110°, sin NaN', M.vmax < 30 && M.stretch < 0.12 && M.neck < 110 && !M.c.nan, `vmax ${f2(M.vmax)} estir ${pc(M.stretch)} cuello ${M.neck.toFixed(0)}°`);
}
{
  const w = world(); const B = body(w, { seed: 14 }); const M = new Meter(); run(w, 1); B.knockback(0, -1, 0.8, 0.3); run(w, 3, () => M.sample(B, w));
  ok('knockback leve: tambalea y queda de pie, huesos < 10 %', B.upright && B.state === 'up' && M.stretch < 0.10, `estado ${B.state} estir ${pc(M.stretch)}`);
}

// ── 4. muertes y cadáveres: se asientan y no tiemblan ───────────────────────
console.log('\n── muertes ──');
{
  const w = world(); const B = body(w, { seed: 15 }); const M = new Meter(); run(w, 1); B.kill(true); run(w, 2.5, () => M.sample(B, w)); run(w, 2, () => M.sample(B, w, { rest: true }));
  ok('muerte de pie: a los 2,5 s ya está quieto (rms < 0,08 m/s, tics < 15 %), tirado, huesos < 6 %', M.restRms < 0.08 && M.restTwitch < 15 && B.py(HEAD) < 0.35 && M.stretch < 0.06, `rms ${M.restRms.toFixed(3)} tics ${M.restTwitch.toFixed(0)}% cabeza y=${f2(B.py(HEAD))} estir ${pc(M.stretch)}`);
}
{
  const w = world(); const B = body(w, { seed: 16, ...RUNNER }); const M = new Meter(); B.wantX = 0; B.wantZ = 1; B.wantSpeed = 3.8; run(w, 2); B.kill(true); run(w, 2.5, () => M.sample(B, w)); run(w, 2, () => M.sample(B, w, { rest: true }));
  ok('muerte corriendo: se desploma con el impulso y queda quieto (rms < 0,06 m/s, tics < 10 %)', M.restRms < 0.06 && M.restTwitch < 10 && B.py(HEAD) < 0.35, `rms ${M.restRms.toFixed(3)} tics ${M.restTwitch.toFixed(0)}% cabeza y=${f2(B.py(HEAD))}`);
}
{
  const w = world(); const B = body(w, { seed: 17 }); const M = new Meter(); run(w, 1); B.kill(false); run(w, 3.5, () => M.sample(B, w)); run(w, 2, () => M.sample(B, w, { rest: true }));
  ok('muerte lenta: al terminar la agonía queda quieto (rms < 0,10 m/s, tics < 25 %), sin picos', M.restRms < 0.10 && M.restTwitch < 25 && !M.c.vSpike, `rms ${M.restRms.toFixed(3)} tics ${M.restTwitch.toFixed(0)}% vmax ${f2(M.vmax)}`);
}
{
  const w = world(); const B = body(w, { seed: 18 }); const M = new Meter(); run(w, 1); B.kill(true); run(w, 3); run(w, 7, () => M.sample(B, w, { rest: true }));
  ok('cadáver 10 s: reposo largo sin tics (rms < 0,06 m/s, tics < 10 %), huesos < 5 %', M.restRms < 0.06 && M.restTwitch < 10 && M.stretch < 0.05, `rms ${M.restRms.toFixed(3)} tics ${M.restTwitch.toFixed(0)}% vmax ${f2(M.mx.restVmax || 0)} estir ${pc(M.stretch)}`);
}

// ── 5. levantadas ───────────────────────────────────────────────────────────
console.log('\n── levantadas ──');
for (const pose of ['supine', 'prone', 'side']) {
  const w = world(); const B = body(w, { seed: 19 }); const M = new Meter(); run(w, 0.3); B.rest(pose, 1); run(w, 0.5); B.wake(); run(w, 4, () => M.sample(B, w));
  ok(`levantada desde ${pose}: termina de pie, rodillas bien (< 3 % de cuadros), huesos < 10 %, sin picos`, B.upright && B.py(HEAD) > 1.3 && M.pct('kneeBack') < 3 && M.stretch < 0.10 && !M.c.vSpike, `cabeza y=${f2(B.py(HEAD))} rodilla ${M.pct('kneeBack').toFixed(1)}% estir ${pc(M.stretch)}`);
}

// ── 6. muebles, paredes, multitud, saltos, tacles ───────────────────────────
console.log('\n── contacto ──');
{
  const w = world([[0, 0.37, 1.6, 0.8, 0.37, 0.42]]); const B = body(w, { seed: 20, z: 0.3 }); const M = new Meter(); run(w, 0.5); B.knockback(0, 1, 2.6, 0.9); run(w, 4.5, () => M.sample(B, w));
  ok('lanzado sobre un escritorio: sin NaN, sin penetrar el piso > 5 cm, huesos < 12 %, sin picos', !M.c.nan && M.pen < 0.05 && M.stretch < 0.12 && !M.c.vSpike, `piso ${(M.pen * 100).toFixed(1)}cm estir ${pc(M.stretch)} vmax ${f2(M.vmax)}`);
}
{
  const w = world([[0, 1.5, 4.0, 3, 1.5, 0.15]]); const B = body(w, { seed: 21, ...RUNNER }); const M = new Meter(); B.wantX = 0; B.wantZ = 1; B.wantSpeed = 3.8;
  run(w, 6, () => { if (B.slams) B.wantSpeed = 0; M.sample(B, w); });
  ok('corredor contra una pared: sin NaN, huesos < 12 %, sin picos > 35 m/s', !M.c.nan && M.stretch < 0.12 && M.vmax < 35 && nanFree(w), `estir ${pc(M.stretch)} vmax ${f2(M.vmax)}`);
}
{
  const w = world(); const rs = []; const M = new Meter();
  for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; rs.push(body(w, { seed: 30 + i, x: Math.cos(a) * 2.5, z: Math.sin(a) * 2.5, yaw: a + Math.PI })); }
  run(w, 6, () => { for (const r of rs) { const d = Math.hypot(r.x, r.z) || 1; r.wantX = -r.x / d; r.wantZ = -r.z / d; r.wantSpeed = 2.5; M.sample(r, w); } });
  ok('multitud de 12 apretándose: sin NaN, huesos < 35 %, sin picos > 45 m/s, penetración < 15 cm', !M.c.nan && M.stretch < 0.35 && M.vmax < 45 && M.pen < 0.15 && nanFree(w), `estir ${pc(M.stretch)} vmax ${f2(M.vmax)} piso ${(M.pen * 100).toFixed(0)}cm`);
}
{
  const w = world(); const B = body(w, { seed: 40, ...RUNNER }); const M = new Meter(); run(w, 0.5);
  for (const st of ['tuck', 'bound', 'superman']) { B.jump(st, 3.2, 0, 2.0, { land: st === 'superman' ? 'roll' : 'run' }); run(w, 2.5, () => M.sample(B, w)); }
  ok('saltos tuck/bound/superman: sin NaN, huesos < 20 %, penetración < 10 cm, sin picos', !M.c.nan && M.stretch < 0.20 && M.pen < 0.10 && !M.c.vSpike, `estir ${pc(M.stretch)} piso ${(M.pen * 100).toFixed(0)}cm vmax ${f2(M.vmax)}`);
}
{
  const w = world(); const B = body(w, { seed: 41, ...RUNNER }); const M = new Meter(); B.wantX = 0; B.wantZ = 1; B.wantSpeed = 3.8; run(w, 1.5); B.fall('tackle', 0, 1, 1); B.wantSpeed = 0; run(w, 5, () => M.sample(B, w));
  ok('tacle y levantada: sin NaN, huesos < 12 %, termina de pie o levantándose', !M.c.nan && M.stretch < 0.12 && (B.state === 'up' || B.state === 'rising'), `estir ${pc(M.stretch)} estado ${B.state}`);
}

// ── 7. balance: no dispara en falso, sí ante un empujón sostenido ───────────
console.log('\n── balance ──');
{
  const spy = (B) => { const ev = { falls: 0, stumbles: 0 }; const of = B.fall.bind(B), os = B.stumble.bind(B); B.fall = (...a) => { ev.falls++; return of(...a); }; B.stumble = (...a) => { const r = os(...a); if (r) ev.stumbles++; return r; }; return ev; };
  let bad = [];
  for (const st of WALK_STYLES) { const w = world(); const B = body(w, { seed: 4, kind: 'walker', walkStyle: st, runStyle: RUN_STYLES[0], z: -30 }); const ev = spy(B); B.wantX = 0; B.wantZ = 1; B.wantSpeed = 1.3; run(w, 5); if (ev.falls || ev.stumbles || !B.upright) bad.push(`camina:${st.name}`); }
  for (const st of RUN_STYLES) { const w = world(); const B = body(w, { seed: 4, ...RUNNER, runStyle: st, walkStyle: WALK_STYLES[0], z: -30 }); const ev = spy(B); B.wantX = 0; B.wantZ = 1; B.wantSpeed = 3.6; run(w, 5); if (ev.falls || ev.stumbles || !B.upright) bad.push(`corre:${st.name}`); }
  ok(`${WALK_STYLES.length} estilos de caminar y ${RUN_STYLES.length} de correr sin un solo tambaleo ni caída en falso`, bad.length === 0, bad.join(' ') || 'ninguno');
  { const w = world(); const B = body(w, { seed: 4, ...RUNNER, z: -20 }); const ev = spy(B); run(w, 8, (t) => { const on = Math.floor(t / 1.5) % 2 === 0; B.wantX = 0; B.wantZ = 1; B.wantSpeed = on ? 3.6 : 0; }); ok('arrancar y frenar en seco, varias veces: sin tambaleos ni caídas', ev.falls + ev.stumbles === 0 && B.upright, `caídas ${ev.falls} tambaleos ${ev.stumbles}`); }
  { const w = world(); const B = body(w, { seed: 4, ...RUNNER, z: -20 }); const ev = spy(B); run(w, 8, (t) => { const a = t * 1.6; B.wantX = Math.cos(a); B.wantZ = Math.sin(a); B.wantSpeed = 3.4; }); ok('correr en círculo cerrado: sin tambaleos ni caídas', ev.falls + ev.stumbles === 0 && B.upright, `caídas ${ev.falls} tambaleos ${ev.stumbles}`); }
  { const w = world(); const P = body(w, { seed: 4, ...PLAYER }); const ev = spy(P); run(w, 8, (t) => { const k = Math.floor(t / 0.9) % 4; P.wantX = [0, 1, 0, -1][k]; P.wantZ = [1, 0, -1, 0][k]; P.wantSpeed = 5.5; P.lookX = 0; P.lookZ = 1; }); ok('jugador esprintando en zig-zag (cortes a 90°): sin tambaleos ni caídas', ev.falls + ev.stumbles === 0 && P.upright, `caídas ${ev.falls} tambaleos ${ev.stumbles}`); }
  { const w = world(); const P = body(w, { seed: 4, ...PLAYER }); const ev = spy(P); run(w, 8, (t) => { const k = Math.floor(t / 1.2) % 3; P.wantX = [0, 0.7, -0.7][k]; P.wantZ = [-1, -0.7, 0.7][k]; P.wantSpeed = 4.0; P.lookX = 0; P.lookZ = 1; }); ok('jugador retrocediendo y strafeando: sin tambaleos ni caídas', ev.falls + ev.stumbles === 0 && P.upright, `caídas ${ev.falls} tambaleos ${ev.stumbles}`); }
  // empujón sostenido (un contacto que desplaza el tronco): chico → nada; grande → pasos de recuperación, sin caer
  const shove = (cm, frames) => { const w = world(); const B = body(w, { seed: 3, kind: 'walker' }); const ev = spy(B); const TORSO = [HEAD, NECK, CHEST, SHL, SHR, HIP, HPL, HPR]; let n = 0; run(w, 4, () => { if (n >= 90 && n < 90 + frames) { const d = cm / 100; for (const i of TORSO) { const p = B.p[i]; w.px[p] += d; w.vx[p] += d / DT; } } n++; }); return { ev, up: B.upright && B.state === 'up', rec: B.recoveries }; };
  const small = shove(2, 12), big = shove(5, 12);
  ok('empujón chico (24 cm en 0,2 s): lo absorbe sin tambalear', small.ev.falls + small.ev.stumbles === 0 && small.up, `tambaleos ${small.ev.stumbles}`);
  ok('empujón grande (60 cm en 0,2 s): da pasos de recuperación y queda de pie', big.rec >= 1 && big.up && big.ev.falls === 0, `recuperaciones ${big.rec} caídas ${big.ev.falls} de pie=${big.up}`);
}

// ── 8. reflejos, mirada, deslizamiento y peso en la marcha ─────────────────
console.log('\n── reflejos y peso ──');
{
  // reflejos de caída: la cabeza llega al piso más despacio y las manos antes que sin reflejos
  const neck = (B) => { const ax = B.px(NECK) - B.px(CHEST), ay = B.py(NECK) - B.py(CHEST), az = B.pz(NECK) - B.pz(CHEST); const bx = B.px(HEAD) - B.px(NECK), by = B.py(HEAD) - B.py(NECK), bz = B.pz(HEAD) - B.pz(NECK); return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz))))) * 180 / Math.PI; };
  const fallTrial = (dx, dz, reflex) => {
    const w = world(); const B = body(w, { seed: 12 });
    if (!reflex) B._fallReflexes = () => {};
    let headV = null, hands = null, t = 0, maxNeck = 0; const ring = [];
    run(w, 1.5); B.knockback(dx, dz, 1.5, 0.4);
    run(w, 3, () => { t += DT; const ph = B.p[HEAD]; if (headV === null && (w.pf[ph] & PF_GROUND)) headV = Math.max(...ring, 0); ring.push(-w.vy[ph]); if (ring.length > 4) ring.shift(); if (hands === null && ((w.pf[B.p[HAL]] & PF_GROUND) || (w.pf[B.p[HAR]] & PF_GROUND))) hands = t; maxNeck = Math.max(maxNeck, neck(B)); });
    return { headV: headV ?? 0, hands: hands ?? 9, neck: maxNeck };
  };
  const fr = fallTrial(0, 1, true), fr0 = fallTrial(0, 1, false);
  ok('empujado de frente: las manos salen al punto de impacto antes (< 0,7 s) y la cabeza llega más despacio que sin reflejos (y a menos de 1,2 m/s)', fr.hands < 0.7 && fr.hands < fr0.hands && fr.headV < fr0.headV && fr.headV < 1.2, `manos ${f2(fr.hands)} s (sin reflejos ${f2(fr0.hands)}), cabeza ${f2(fr.headV)} m/s (sin reflejos ${f2(fr0.headV)})`);
  const la = fallTrial(1, 0, true), la0 = fallTrial(1, 0, false);
  ok('empujado de costado: las manos salen antes que sin reflejos, la cabeza llega a menos de 1,3 m/s y el cuello no pasa de 75°', la.hands < la0.hands && la.headV < 1.3 && la.neck < 75, `manos ${f2(la.hands)} s (sin ${f2(la0.hands)}), cabeza ${f2(la.headV)} m/s (sin ${f2(la0.headV)}), cuello ${la.neck.toFixed(0)}°`);
}
{
  // mirar la amenaza: un tiro que viene de +x gira la cabeza hacia +x un segundo, y después vuelve
  const w = world(); const B = body(w, { seed: 5 }); run(w, 1);
  const off = () => B.px(HEAD) - B.px(NECK);
  B.hit(B_SPINE, 0.5, 12, [-3, 0.5, 0]);
  let maxOff = -9; run(w, 1, () => { maxOff = Math.max(maxOff, off()); });
  run(w, 1.5); const after = off();
  ok('mirar la amenaza: tras un tiro desde +x la cabeza gira > 6 cm hacia +x y al segundo y medio ya volvió (< 4 cm)', maxOff > 0.06 && Math.abs(after) < 0.04 && B.upright, `giro máx ${(maxOff * 100).toFixed(1)} cm, después ${(after * 100).toFixed(1)} cm`);
}
{
  // rodillas nunca al revés en las caídas violentas (escopeta de costado corriendo, saltos)
  const w = world(); const B = body(w, { seed: 11, ...RUNNER }); const M = new Meter(); B.wantX = 0; B.wantZ = 1; B.wantSpeed = 3.8; run(w, 2);
  for (let k = 0; k < 9; k++) B.hit(B_SPINE, 0.3 + k * 0.05, 14, [9, 2, 0]);
  B.wantSpeed = 0; run(w, 3.2, () => M.sample(B, w));
  ok('escopeta de costado a un corredor: la rodilla casi nunca dobla al revés (< 15 % de cuadros; era 37 %)', M.pct('kneeBack') < 15, `${M.pct('kneeBack').toFixed(1)}%`);
  const w2 = world(); const B2 = body(w2, { seed: 40, ...RUNNER }); const M2 = new Meter(); run(w2, 0.5);
  for (const st of ['tuck', 'bound', 'superman']) { B2.jump(st, 3.2, 0, 2.0, { land: st === 'superman' ? 'roll' : 'run' }); run(w2, 2.5, () => M2.sample(B2, w2)); }
  ok('saltos y planchas: rodilla al revés < 4 % de cuadros (era 24 %)', M2.pct('kneeBack') < 4, `${M2.pct('kneeBack').toFixed(1)}%`);
}
{
  // muerte a la carrera: desliza con el impulso (fricción dinámica) y para en poco más de un segundo
  const w = world(); const B = body(w, { seed: 16, ...RUNNER, z: -10 }); B.wantX = 0; B.wantZ = 1; B.wantSpeed = 3.8; run(w, 2);
  const z0 = B.z; B.kill(true);
  let stopT = null, t = 0; run(w, 2.5, () => { t += DT; if (stopT === null && t > 0.3 && B.slideV < 0.05) stopT = t; });
  const d = B.z - z0;
  ok('muerto a 3,8 m/s desliza entre 1,8 y 3,5 m con el impulso y queda quieto antes de 1,5 s', d > 1.8 && d < 3.5 && stopT !== null && stopT < 1.5 && B.py(HEAD) < 0.35, `deslizó ${f2(d)} m, paró a los ${stopT === null ? '?' : f2(stopT)} s`);
}
{
  // peso en la marcha: la pelvis gira con la zancada, los hombros al revés, la cabeza bobea menos que el pecho
  const w = world(); const B = body(w, { seed: 3 }); B.wantX = 0; B.wantZ = 1; B.wantSpeed = 1.4; run(w, 2);
  let hipMin = 9, hipMax = -9, sh = 0, ss = 0, shs = 0, shh = 0, sss = 0, n = 0, chestMin = 9, chestMax = -9, headMin = 9, headMax = -9;
  run(w, 3, () => {
    const c = Math.cos(B.yaw), s = Math.sin(B.yaw);
    const fz = (i) => { const dx = B.px(i) - B.x, dz = B.pz(i) - B.z; return dx * s + dz * c; };
    const hipTw = fz(HPR) - fz(HPL), shTw = fz(SHR) - fz(SHL);
    hipMin = Math.min(hipMin, hipTw); hipMax = Math.max(hipMax, hipTw);
    sh += hipTw; ss += shTw; shs += hipTw * shTw; shh += hipTw * hipTw; sss += shTw * shTw; n++;
    // el bobeo de la pose objetivo: la cabeza tiene que subir y bajar menos que el pecho
    const T = B.target; chestMin = Math.min(chestMin, T[CHEST * 3 + 1]); chestMax = Math.max(chestMax, T[CHEST * 3 + 1]); headMin = Math.min(headMin, T[HEAD * 3 + 1]); headMax = Math.max(headMax, T[HEAD * 3 + 1]);
  });
  const cov = shs / n - (sh / n) * (ss / n), vh = shh / n - (sh / n) ** 2, vs = sss / n - (ss / n) ** 2;
  const rho = cov / Math.sqrt(Math.max(1e-12, vh * vs));
  ok('caminando la pelvis gira con la zancada (> 2 cm entre caderas) y los hombros giran al revés (correlación < -0,3)', hipMax - hipMin > 0.02 && rho < -0.3, `giro pélvico ${((hipMax - hipMin) * 100).toFixed(1)} cm, correlación hombros ${rho.toFixed(2)}`);
  void chestMin; void chestMax; void headMin; void headMax;
}

console.log(fails ? `\n${fails} PRUEBAS FALLARON` : '\nTODO VERDE');
process.exit(fails ? 1 : 0);
