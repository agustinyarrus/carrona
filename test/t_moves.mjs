// Catálogo de movimientos: cada caída, levantada, muerte, sacudón, ataque, tic,
// estilo de marcha y estado de descanso se prueba uno por uno, con medidas.
import { PhysWorld } from '../src/phys/world.js';
import { Ragdoll, HEAD, CHEST, HIP, HAL, HAR, FTL, FTR, B_SPINE, B_CLAVR, NP } from '../src/phys/ragdoll.js';
import { SEQ, OVER, P, RUN_STYLES, WALK_STYLES, IDLE_OVERLAYS } from '../src/phys/moves.js';
import { NavGrid } from '../src/game/nav.js';
import { ZombieManager } from '../src/game/zombie.js';
import { makeRng } from '../src/core/util.js';

let fails = 0, total = 0;
const ok = (name, cond, extra = '') => { total++; console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${name}   ${extra}`); if (!cond) fails++; };
const DT = 1 / 60;
const run = (w, sec, fn) => { for (let i = 0; i < sec * 60; i++) { for (const b of w.bodies) if (b.update) b.update(DT); w.step(DT); if (fn) fn(i * DT); } };
const nanFree = (w) => { for (let i = 0; i < w.pn; i++) if (Number.isNaN(w.px[i] + w.py[i] + w.pz[i])) return false; return true; };
const world = () => { const w = new PhysWorld(); w.groundHX = 30; w.groundHZ = 30; w.buildStaticIndex(); return w; };
const body = (w, o = {}) => new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng: makeRng(o.seed ?? 1), ...o });
const orient = (B) => B.fy > 0.5 ? 'supine' : B.fy < -0.5 ? 'prone' : (B.uy < 0.5 ? 'side' : 'up');

// ── 1. LEVANTADAS: desde la pose de partida exacta, cada variante termina de pie ──
console.log('\n── levantadas ──');
{
  const restFor = { supine: 'supine', prone: 'prone', side: 'side', kneel: 'kneel', sit: 'sit' };
  for (const name in SEQ) {
    const def = SEQ[name];
    if (def.kind !== 'getup') continue;
    const w = world();
    const B = body(w, { seed: 7, kind: 'walker' });
    run(w, 0.3);
    B.rest(restFor[def.from], 1);
    run(w, 0.6);
    const x0 = B.x, z0 = B.z;
    B.dormant = false; B.seq = null; B.state = 'down';
    B._startGetUp(name);
    let upAt = -1;
    run(w, 5.5, (t) => { if (upAt < 0 && B.state === 'up') upAt = t; });
    const head = B.py(HEAD), moved = Math.hypot(B.x - x0, B.z - z0);
    ok(`${name.padEnd(20)} (${def.from}) termina de pie`, B.state === 'up' && B.upright && head > 1.4 && nanFree(w), `cabeza ${head.toFixed(2)} en ${upAt >= 0 ? upAt.toFixed(1) + ' s' : 'nunca'} se movió ${moved.toFixed(2)} m`);
  }
}

// ── 2. CAÍDAS: parado, cada variante cae y aterriza como corresponde, y después se levanta ──
console.log('\n── caídas ──');
{
  const expect = {
    fall_back_sit: { dir: [0, -1], land: 'supine' }, fall_back_plank: { dir: [0, -1], land: 'supine' },
    fall_front_face: { dir: [0, 1], land: 'prone' }, fall_front_knees: { dir: [0, 1], land: 'prone' },
    fall_side: { dir: [1, 0], land: 'side' }, fall_spin: { dir: [1, 0], land: 'any' },
    fall_collapse: { dir: [0, -1], land: 'any' }, fall_fly: { dir: [0, -1], land: 'any' },
    fall_trip_roll: { dir: [0, 1], land: 'any' }, fall_wall_bounce: { dir: [0, -1], land: 'supine' },
    tackle: { dir: [0, 1], land: 'prone' },
  };
  for (const name in expect) {
    const E = expect[name];
    const w = world();
    const B = body(w, { seed: 11, kind: 'walker' });
    run(w, 0.8);
    const okStart = B.fall('shot', E.dir[0], E.dir[1], 1, name);
    let minHead = 9, fellAt = -1, landO = null;
    run(w, 2.6, (t) => { minHead = Math.min(minHead, B.py(HEAD)); if (fellAt < 0 && !B.upright) fellAt = t; if (!landO && B.state === 'down') landO = orient(B); });
    const o = landO || orient(B);
    const landOK = E.land === 'any' || o === E.land;
    ok(`${name.padEnd(18)} cae y aterriza ${E.land === 'any' ? 'como sea' : E.land}`, okStart && minHead < 0.9 && landOK && nanFree(w), `cabeza mín ${minHead.toFixed(2)} cayó a ${fellAt >= 0 ? fellAt.toFixed(2) : '-'} s quedó ${o}`);
    run(w, 7);
    ok(`${name.padEnd(18)} se levanta después`, B.state === 'up' && B.upright && B.py(HEAD) > 1.4, `${B.lastGetUp} cabeza ${B.py(HEAD).toFixed(2)}`);
  }
}

// ── 3. MUERTES: cada variante termina muerto y en el piso ───────────────────
console.log('\n── muertes ──');
{
  for (const name in SEQ) {
    const def = SEQ[name];
    if (def.kind !== 'die') continue;
    const w = world();
    const B = body(w, { seed: 3, kind: 'walker' });
    B.wantX = 0; B.wantZ = 1; B.wantSpeed = 1.2;
    run(w, 1.5);
    B.fall('die', 0, -1, 1, name);
    let deadAt = -1;
    run(w, 3.5, (t) => { if (deadAt < 0 && B.dead) deadAt = t; });
    ok(`${name.padEnd(14)} muere en el piso`, B.dead && B.py(HEAD) < 0.7 && nanFree(w), `muerto a ${deadAt >= 0 ? deadAt.toFixed(2) : '-'} s cabeza ${B.py(HEAD).toFixed(2)}`);
  }
}

// ── 4. SACUDONES Y ATAQUES: se ven (mueven la pose) y no lo tiran ───────────
console.log('\n── sacudones / ataques / tics ──');
{
  for (const name in OVER) {
    const w = world();
    const B = body(w, { seed: 5, kind: 'walker', walkStyle: WALK_STYLES[4], runStyle: RUN_STYLES[3] });
    run(w, 1);
    const T0 = Float32Array.from(B.target);
    const ctx = { sx: 1, along: -1, lat: 0.3 };
    B.playOverlay(name, 1, ctx);
    let maxDev = 0, fell = false;
    run(w, Math.min(1.2, OVER[name].dur + 0.3), () => {
      const T = B.target;
      for (let i = 0; i < NP; i++) maxDev = Math.max(maxDev, Math.hypot(T[i * 3] - T0[i * 3], T[i * 3 + 1] - T0[i * 3 + 1], T[i * 3 + 2] - T0[i * 3 + 2]));
      if (!B.upright) fell = true;
    });
    ok(`${name.padEnd(14)} mueve la pose y no lo tira`, maxDev > 0.03 && !fell && nanFree(w), `desvío máx ${(maxDev * 100).toFixed(0)} cm`);
  }
}

// ── 5. TAMBALEO: un tiro de pistola lo desplaza y NO vuelve ─────────────────
console.log('\n── tambaleo ──');
{
  const w = world();
  const B = body(w, { seed: 8, kind: 'walker' });
  run(w, 1);
  const z0 = B.z;
  B.hit(B_SPINE, 0.4, 30, [0, 1.5, -7]);
  let d1 = 0;
  run(w, 1, () => { d1 = Math.max(d1, z0 - B.z); });
  ok('el tiro de pistola lo hace tambalear hacia atrás (≥ 25 cm)', d1 > 0.25 && B.stumbles >= 1, `${(d1 * 100).toFixed(0)} cm, tambaleos=${B.stumbles}, sacudón=${B.lastFlinch}`);
  run(w, 2);
  ok('y queda ahí: no vuelve a su lugar', z0 - B.z > 0.18 && B.upright, `${((z0 - B.z) * 100).toFixed(0)} cm después de 3 s`);
  // tiro en el hombro: gira
  const yaw0 = B.yaw;
  B.hit(B_CLAVR, 0.5, 30, [0, 1, -7]);
  run(w, 0.6);
  ok('un tiro en el hombro lo hace girar', Math.abs(B.yaw - yaw0) > 0.12, `giró ${(Math.abs(B.yaw - yaw0) * 57.3).toFixed(0)}°`);
  // corriendo hacia el tirador, un tiro al pecho lo frena y lo manda para atrás
  const w2 = world();
  const R = body(w2, { seed: 9, kind: 'runner', stride: 0.32, stiffness: 165, maxMuscleSpeed: 13 });
  R.wantX = 0; R.wantZ = 1; R.wantSpeed = 3.8;
  run(w2, 2.5);
  const zr = R.z;
  R.hit(B_SPINE, 0.4, 30, [0, 1.5, -7]);
  let minZ = 9;
  run(w2, 0.5, () => { minZ = Math.min(minZ, R.z); });
  ok('corriendo, el tiro de frente lo frena y lo empuja atrás', minZ < zr - 0.05, `retrocedió ${((zr - minZ) * 100).toFixed(0)} cm`);
}

// ── 6. ESTILOS: diez corredores distintos, todos corren y ninguno se cae ────
console.log('\n── estilos de marcha ──');
{
  const w = world();
  const runners = [];
  for (let k = 0; k < RUN_STYLES.length; k++) {
    const R = new Ragdoll(w, { x: (k - 5) * 2.2, z: -20, yaw: 0, rng: makeRng(20 + k), kind: 'runner', stride: 0.32, stiffness: 165, maxMuscleSpeed: 13, runStyle: RUN_STYLES[k], walkStyle: WALK_STYLES[k] });
    R.wantX = 0; R.wantZ = 1; R.wantSpeed = 3.8;
    runners.push(R);
  }
  const handY = runners.map(() => 0), handZ = runners.map(() => 0), fell = runners.map(() => false);
  let n = 0;
  run(w, 6, (t) => { if (t > 3) { n++; runners.forEach((R, i) => { handY[i] += (R.py(HAL) + R.py(HAR)) * 0.5; handZ[i] += R.pz(HAL) - R.z; if (!R.upright) fell[i] = true; }); } });
  const speeds = runners.map((R) => R.speed);
  const allRun = speeds.every((s) => s > 3.0), noneFell = fell.every((f) => !f);
  const my = handY.map((v) => v / n), mz = handZ.map((v) => v / n);
  const spread = (a) => { const m = a.reduce((x, y) => x + y) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
  ok('los diez corren a más de 3 m/s', allRun, speeds.map((s) => s.toFixed(1)).join(' '));
  ok('ninguno se cae en 6 s', noneFell);
  ok('los brazos van distinto según el estilo (dispersión > 8 cm)', spread(my) > 0.08 || spread(mz) > 0.08, `alto ±${(spread(my) * 100).toFixed(0)} cm, adelante ±${(spread(mz) * 100).toFixed(0)} cm`);
  ok('sin NaN', nanFree(w));
}

// ── 7. DORMIDOS: descansa, se despierta y se levanta ────────────────────────
console.log('\n── dormidos ──');
{
  for (const pose of ['sit', 'kneel', 'supine', 'prone', 'side']) {
    const w = world();
    const B = body(w, { seed: 30, kind: 'jogger' });
    run(w, 0.3);
    B.rest(pose, 0);
    run(w, 2);
    const still = B.state === 'rest' && B.dormant;
    const headRest = B.py(HEAD);
    B.wake();
    let upAt = -1;
    run(w, 5.5, (t) => { if (upAt < 0 && B.state === 'up') upAt = t; });
    ok(`${pose.padEnd(7)} descansa quieto y al despertar se levanta`, still && headRest < 1.3 && B.state === 'up' && B.upright && B.py(HEAD) > 1.4 && nanFree(w), `cabeza dormido ${headRest.toFixed(2)}, ${B.lastGetUp} en ${upAt >= 0 ? upAt.toFixed(1) : '-'} s`);
  }
}

// ── 8. IA: al alertarse TODOS corren al jugador (caminante incluido) ────────
console.log('\n── horda ──');
{
  const w = world();
  const nav = new NavGrid(w, { cell: 0.4, margin: 0.3, vaultTop: 1.05 });
  const zm = new ZombieManager(w, nav, makeRng(40));
  const player = { x: 0, z: 0, alive: true, body: body(w, { seed: 41, isPlayer: true, armMode: 'aim', lockYaw: true }) };
  const Zw = zm.spawn('walker', 0, -16, 0, true), Zr = zm.spawn('runner', 3, -16, 0, true, 'supine');
  const hooks = { onAttack: () => {}, onDeath: () => {}, onCorpse: () => {}, onMoan: () => {} };
  run(w, 1.0, () => zm.update(DT, player, hooks));
  ok('dormidos: el caminante deambula y el corredor está tirado', Zw.state === 'idle' && Zr.state === 'idle' && Zr.body.state === 'rest', `${Zw.state} ${Zr.state}/${Zr.body.state}`);
  zm.alertAll(0, 0, 30);
  let maxSpeedW = 0, maxSpeedR = 0, rUpAt = -1;
  run(w, 7.5, (t) => { zm.update(DT, player, hooks); maxSpeedW = Math.max(maxSpeedW, Zw.body.speed); maxSpeedR = Math.max(maxSpeedR, Zr.body.speed); if (rUpAt < 0 && Zr.body.state === 'up') rUpAt = t; });
  ok('el caminante CORRE al jugador (> 2.3 m/s)', maxSpeedW > 2.3 && Zw.state !== 'idle', `${maxSpeedW.toFixed(2)} m/s estado ${Zw.state}`);
  ok('el corredor dormido se levanta y corre (> 3 m/s)', rUpAt >= 0 && maxSpeedR > 3.0, `de pie a ${rUpAt >= 0 ? rUpAt.toFixed(1) : '-'} s, ${maxSpeedR.toFixed(2)} m/s`);
  ok('los dos se acercaron al jugador (el corredor arrancó tirado a 16 m)', Math.hypot(Zw.x, Zw.z) < 2.5 && Math.hypot(Zr.x, Zr.z) < 8, `${Math.hypot(Zw.x, Zw.z).toFixed(1)} m, ${Math.hypot(Zr.x, Zr.z).toFixed(1)} m`);
  ok('sin NaN', nanFree(w));
}

console.log(`\n${total} pruebas, ${fails} fallaron`);
console.log(fails ? `\n${fails} PRUEBAS FALLARON` : '\nTODO VERDE');
process.exit(fails ? 1 : 0);
