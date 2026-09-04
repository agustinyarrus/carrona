// Animación: trepar, agacharse, aterrizar, inclinarse al acelerar, brazos al caer,
// y que el movimiento secundario no rompa la marcha.
import { PhysWorld } from '../src/phys/world.js';
import { Ragdoll, HEAD, CHEST, HIP, HAL, HAR, FTL, FTR, KNL, KNR } from '../src/phys/ragdoll.js';
import { NavGrid } from '../src/game/nav.js';
import { makeRng } from '../src/core/util.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${name}   ${extra}`);
  if (!cond) fails++;
};
const DT = 1 / 60;
const run = (w, sec, fn) => { for (let i = 0; i < sec * 60; i++) { for (const b of w.bodies) if (b.update) b.update(DT); w.step(DT); if (fn) fn(i * DT); } };
const nanFree = (w) => { for (let i = 0; i < w.pn; i++) if (Number.isNaN(w.px[i] + w.py[i] + w.pz[i])) return false; return true; };

// ── 1. trepar un escritorio y bajar del otro lado ───────────────────────────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20;
  w.addBox(0, 0.37, 3.0, 1.0, 0.37, 0.4);     // escritorio: tapa a 0.74, 80 cm de fondo
  w.buildStaticIndex();
  const nav = new NavGrid(w, { cell: 0.4, margin: 0.3, vaultTop: 1.05 });
  ok('con vaultTop el escritorio no corta el camino', nav.walkable(0, 3.0));
  const Z = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng: makeRng(1) });
  Z.wantX = 0; Z.wantZ = 1; Z.wantSpeed = 1.4;
  let maxHip = 0, onTop = false, fell = false;
  run(w, 7, () => {
    maxHip = Math.max(maxHip, Z.py(HIP));
    if (Z.z > 2.7 && Z.z < 3.3 && Z.py(FTL) > 0.7 && Z.py(FTR) > 0.7) onTop = true;
    if (!Z.upright) fell = true;
  });
  ok('arrancó a trepar', Z.vaults >= 1, `vaults=${Z.vaults}`);
  ok('se subió al escritorio (los dos pies arriba)', onTop, `cadera máx ${maxHip.toFixed(2)}`);
  ok('siguió y bajó del otro lado', Z.z > 4.5, `z=${Z.z.toFixed(2)}`);
  ok('terminó de pie', Z.upright && Z.py(HEAD) > 1.4, `cabeza ${Z.py(HEAD).toFixed(2)}`);
  ok('sin NaN', nanFree(w));
}

// ── 2. agacharse (jugador) ──────────────────────────────────────────────────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20; w.buildStaticIndex();
  const P = new Ragdoll(w, { x: 0, z: 0, yaw: 0, lockYaw: true, armMode: 'aim', stiffness: 175, maxMuscleSpeed: 13, rng: makeRng(2) });
  run(w, 1);
  const head0 = P.py(HEAD), knee0 = Math.min(P.py(KNL), P.py(KNR));
  P.wantCrouch = true;
  run(w, 1.5);
  const headC = P.py(HEAD);
  ok('agachado la cabeza baja (≥ 25 cm)', head0 - headC > 0.25, `${head0.toFixed(2)} → ${headC.toFixed(2)}`);
  ok('las rodillas se doblan (rodilla más baja)', Math.min(P.py(KNL), P.py(KNR)) < knee0 - 0.05, `${knee0.toFixed(2)} → ${Math.min(P.py(KNL), P.py(KNR)).toFixed(2)}`);
  ok('sigue de pie (no se cae)', P.upright);
  P.wantCrouch = false;
  run(w, 1.5);
  ok('se vuelve a parar', P.py(HEAD) > head0 - 0.05, P.py(HEAD).toFixed(2));
}

// ── 3. caer de una altura: aterriza flexionando y sigue de pie ──────────────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20;
  w.addBox(0, 0.5, -1.0, 2.0, 0.5, 1.5);       // plataforma de 1 m, borde en z=0.5
  w.buildStaticIndex();
  const Z = new Ragdoll(w, { x: 0, z: -0.8, y: 1.0, yaw: 0, rng: makeRng(3) });
  run(w, 0.8);
  ok('arranca parado sobre la plataforma', Z.upright && Z.py(FTL) > 0.95, `pie ${Z.py(FTL).toFixed(2)}`);
  Z.wantX = 0; Z.wantZ = 1; Z.wantSpeed = 1.2;
  let minHead = 9, landCrouchSeen = 0, fell = false;
  run(w, 4, () => { if (Z.z > 0.9) { minHead = Math.min(minHead, Z.py(HEAD)); landCrouchSeen = Math.max(landCrouchSeen, Z.landCrouch); if (!Z.upright) fell = true; } });
  ok('llegó abajo', Z.z > 1.2 && Z.py(FTL) < 0.2, `z=${Z.z.toFixed(2)} pie=${Z.py(FTL).toFixed(2)}`);
  ok('al aterrizar flexionó (cabeza bajó de 1.55)', minHead < 1.55, `cabeza mín ${minHead.toFixed(2)} landCrouch ${landCrouchSeen.toFixed(2)}`);
  ok('y no se cayó', !fell && Z.upright);
}

// ── 4. inclinarse al acelerar y al frenar ───────────────────────────────────
{
  const w = new PhysWorld(); w.groundHX = 30; w.groundHZ = 30; w.buildStaticIndex();
  const R = new Ragdoll(w, { x: 0, z: -15, yaw: 0, stride: 0.32, armMode: 'pump', stiffness: 165, maxMuscleSpeed: 13, rng: makeRng(4) });
  run(w, 1);
  const lean0 = R.pz(HEAD) - R.pz(HIP);
  R.wantX = 0; R.wantZ = 1; R.wantSpeed = 3.5;
  let leanAcc = -9, accPeak = 0;
  run(w, 0.5, () => { leanAcc = Math.max(leanAcc, R.pz(HEAD) - R.pz(HIP)); accPeak = Math.max(accPeak, R.accZ); });
  run(w, 2);
  const leanCruise = R.pz(HEAD) - R.pz(HIP);
  R.wantSpeed = 0;
  let leanBrake = 9;
  run(w, 0.6, () => { leanBrake = Math.min(leanBrake, R.pz(HEAD) - R.pz(HIP)); });
  // al arrancar la marcha todavía es lenta (poca inclinación de carrera) y aun así
  // se inclina casi como en crucero: eso es la inclinación por aceleración
  ok('al arrancar se inclina hacia adelante (aceleración medida)', accPeak > 2.5 && leanAcc > 0.24, `arranque ${leanAcc.toFixed(2)} crucero ${leanCruise.toFixed(2)} acc ${accPeak.toFixed(1)} m/s²`);
  ok('al frenar se echa atrás respecto del crucero', leanBrake < leanCruise - 0.03, `freno ${leanBrake.toFixed(2)}`);
  ok('quieto vuelve a la postura normal', Math.abs((R.pz(HEAD) - R.pz(HIP)) - lean0) < 0.12, `${(R.pz(HEAD) - R.pz(HIP)).toFixed(2)} vs ${lean0.toFixed(2)}`);
}

// ── 5. al caer de boca saca los brazos ──────────────────────────────────────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20; w.buildStaticIndex();
  const Z = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng: makeRng(5) });
  run(w, 1);
  Z.knockback(0, 1, 2.6, 0.2);   // empujón fuerte hacia adelante: cae de boca
  let braced = false, handsAhead = false;
  run(w, 1.2, () => {
    if (Z.brace > 0) braced = true;
    // manos más adelante y más abajo que el pecho mientras cae
    if (Z.py(CHEST) < 1.0 && Z.py(CHEST) > 0.4 && Z.pz(HAL) > Z.pz(CHEST) + 0.15 && Z.py(HAL) < Z.py(CHEST)) handsAhead = true;
  });
  ok('se activó la preparación de brazos', braced);
  ok('las manos van adelante y abajo a frenar la caída', handsAhead);
  ok('sin NaN', nanFree(w));
}

// ── 6. movimiento secundario sin romper la marcha ───────────────────────────
{
  const w = new PhysWorld(); w.groundHX = 30; w.groundHZ = 30; w.buildStaticIndex();
  const rng = makeRng(6);
  const A = new Ragdoll(w, { x: -3, z: -20, yaw: 0, rng });
  const R = new Ragdoll(w, { x: 3, z: -20, yaw: 0, stride: 0.32, armMode: 'pump', stiffness: 165, maxMuscleSpeed: 13, rng });
  A.wantX = 0; A.wantZ = 1; A.wantSpeed = 1.4;
  R.wantX = 0; R.wantZ = 1; R.wantSpeed = 3.5;
  let fellA = false, fellR = false;
  run(w, 6, () => { if (!A.upright) fellA = true; if (!R.upright) fellR = true; });
  ok('el caminante avanza a ~1.4 m/s', Math.abs(A.speed - 1.4) < 0.15, A.speed.toFixed(2));
  ok('el corredor avanza a ~3.5 m/s', Math.abs(R.speed - 3.5) < 0.25, R.speed.toFixed(2));
  ok('ninguno se cae', !fellA && !fellR);
  ok('sin NaN', nanFree(w));
}

console.log(fails ? `\n${fails} PRUEBAS FALLARON` : '\nTODO VERDE');
process.exit(fails ? 1 : 0);
