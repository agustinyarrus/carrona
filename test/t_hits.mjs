// Reacción física a los disparos: dirección, zona y momento.
import { PhysWorld } from '../src/phys/world.js';
import { Ragdoll, HEAD, CHEST, HIP, HAL, HAR, ELL, B_SPINE, B_SKULL, B_UARML, B_THIGHL, B_SHINR } from '../src/phys/ragdoll.js';
import { makeRng } from '../src/core/util.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${name}   ${extra}`);
  if (!cond) fails++;
};
const DT = 1 / 60;
const run = (w, sec, fn) => { for (let i = 0; i < sec * 60; i++) { for (const b of w.bodies) if (b.update) b.update(DT); w.step(DT); if (fn) fn(i * DT); } };
const nanFree = (w) => { for (let i = 0; i < w.pn; i++) if (Number.isNaN(w.px[i] + w.py[i] + w.pz[i])) return false; return true; };
const world = () => { const w = new PhysWorld(); w.groundHX = 30; w.groundHZ = 30; w.buildStaticIndex(); return w; };

// ── 1. pistola al pecho, de frente: se va hacia atrás y queda ahí ───────────
{
  const w = world();
  const B = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng: makeRng(1) });   // mira a +Z; el tiro viene de +Z
  run(w, 1);
  const z0 = B.z, root0 = B.rootZ, cz0 = B.pz(CHEST);
  B.hit(B_SPINE, 0.5, 30, [0, 1.5, -7]);
  let minZ = 9, fell = false;
  run(w, 2, () => { minZ = Math.min(minZ, B.pz(CHEST)); if (!B.upright) fell = true; });
  ok('el pecho se va hacia atrás (≥ 5 cm)', cz0 - minZ > 0.05, `${((cz0 - minZ) * 100).toFixed(1)} cm`);
  ok('el objetivo de equilibrio se movió con el empujón', B.rootZ < root0 - 0.02, `${((root0 - B.rootZ) * 100).toFixed(1)} cm`);
  ok('queda desplazado, no vuelve como una goma', B.z < z0 - 0.02, `${((z0 - B.z) * 100).toFixed(1)} cm atrás`);
  ok('un tiro de pistola no lo tira', !fell && B.upright);
}

// ── 2. pierna baleada corriendo: tropieza (mayoría de las veces) ────────────
{
  let trips = 0;
  for (let k = 0; k < 6; k++) {
    const w = world();
    const R = new Ragdoll(w, { x: 0, z: -10, yaw: 0, stride: 0.32, armMode: 'pump', stiffness: 165, maxMuscleSpeed: 13, rng: makeRng(10 + k) });
    R.wantX = 0; R.wantZ = 1; R.wantSpeed = 3.4;
    run(w, 2);
    R.hit(B_THIGHL, 0.5, 30, [0, 0.5, 7]);
    let fell = false;
    run(w, 1.5, () => { if (!R.upright) fell = true; });
    if (fell || R.tripped > 0) trips++;
  }
  ok('corriendo, un tiro en la pierna lo tropieza (≥ 4 de 6)', trips >= 4, `${trips}/6`);
}

// ── 3. pierna baleada parado: se le dobla la rodilla y después se endereza ──
{
  const w = world();
  const B = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng: makeRng(2) });
  run(w, 1);
  const hip0 = B.py(HIP);
  B.hit(B_SHINR, 0.5, 30, [0, 0.5, -5]);
  let minHip = 9, fell = false;
  run(w, 0.7, () => { minHip = Math.min(minHip, B.py(HIP)); if (!B.upright) fell = true; });
  ok('la cadera baja (rodilla doblada, ≥ 8 cm)', hip0 - minHip > 0.08, `${((hip0 - minHip) * 100).toFixed(1)} cm`);
  run(w, 2.5);
  ok('se endereza de nuevo', B.py(HIP) > hip0 - 0.06 && B.upright, `cadera ${B.py(HIP).toFixed(2)} vs ${hip0.toFixed(2)}`);
}

// ── 4. brazo baleado: cuelga y después vuelve ───────────────────────────────
{
  const w = world();
  const B = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng: makeRng(3) });   // brazos 'reach': manos a ~1.3 m
  run(w, 1);
  const hand0 = B.py(HAL);
  B.hit(B_UARML, 0.5, 30, [0, 0, -6]);
  let minHand = 9;
  run(w, 0.8, () => { minHand = Math.min(minHand, B.py(HAL)); });
  ok('la mano del brazo baleado cae (≥ 18 cm)', hand0 - minHand > 0.18, `${hand0.toFixed(2)} → ${minHand.toFixed(2)}`);
  ok('el otro brazo sigue arriba', B.py(HAR) > hand0 - 0.25, B.py(HAR).toFixed(2));
  run(w, 2.5);
  ok('el brazo vuelve a levantarse', B.py(HAL) > hand0 - 0.25, B.py(HAL).toFixed(2));
  ok('pero queda un poco más débil para siempre (piso < 1)', B.muscleFloor[HAL] < 1 && B.muscleFloor[HAL] >= 0.5, B.muscleFloor[HAL].toFixed(2));
}

// ── 5. escopeta: de frente cae hacia atrás; de atrás cae de boca ────────────
{
  const w = world();
  const A = new Ragdoll(w, { x: -3, z: 0, yaw: 0, rng: makeRng(4) });
  const C = new Ragdoll(w, { x: 3, z: 0, yaw: 0, rng: makeRng(5) });
  run(w, 1);
  const az0 = A.pz(CHEST), cz0 = C.pz(CHEST);
  for (let k = 0; k < 9; k++) { A.hit(B_SPINE, 0.3 + k * 0.05, 14, [0, 2, -9]); C.hit(B_SPINE, 0.3 + k * 0.05, 14, [0, 2, 9]); }
  let fellA = false, fellC = false;
  // "caído" = perdió la vertical o la cabeza bajó a menos de 90 cm (de rodillas, de boca)
  run(w, 1.2, () => { if (!A.upright || A.py(HEAD) < 0.9) fellA = true; if (!C.upright || C.py(HEAD) < 0.9) fellC = true; });
  ok('la escopeta de frente lo tira', fellA);
  ok('… hacia atrás (el pecho quedó detrás de donde estaba)', A.pz(CHEST) < az0 - 0.3, `${(A.pz(CHEST) - az0).toFixed(2)} m`);
  ok('la escopeta por la espalda lo tira', fellC);
  ok('… de boca (el pecho quedó adelante)', C.pz(CHEST) > cz0 + 0.3, `${(C.pz(CHEST) - cz0).toFixed(2)} m`);
  run(w, 4);
  ok('los dos se levantan después', A.upright && C.upright, `${A.upright} ${C.upright}`);
  ok('sin NaN', nanFree(w));
}

// ── 6. tiro en la cabeza no letal (bruto): la cabeza se va ──────────────────
{
  const w = world();
  const B = new Ragdoll(w, { x: 0, z: 0, yaw: 0, toughness: 8, scale: 1.2, massScale: 1.8, rng: makeRng(6) });
  run(w, 1);
  const h0 = B.pz(HEAD);
  B.hit(B_SKULL, 0.5, 30, [0, 1, -7]);
  let minH = 9;
  run(w, 0.3, () => { minH = Math.min(minH, B.pz(HEAD)); });
  ok('la cabeza se va hacia atrás (≥ 8 cm)', h0 - minH > 0.08, `${((h0 - minH) * 100).toFixed(1)} cm`);
  ok('sigue vivo y de pie (es un bruto)', !B.dead && B.upright);
}

// ── 7. ráfaga de subfusil sostenida: lo empuja y lo hace retroceder, y al final lo tira ─
{
  const w = world();
  const B = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng: makeRng(7) });
  run(w, 1);
  const z0 = B.z;
  let t = 0, shots = 0, fell = false;
  run(w, 2.0, (tt) => { if (tt - t >= 1 / 13) { t = tt; B.hit(B_SPINE, 0.5, 17, [0, 1, -4.5]); shots++; } if (!B.upright) fell = true; });
  ok('la ráfaga lo empuja hacia atrás (≥ 12 cm)', z0 - B.z > 0.12, `${((z0 - B.z) * 100).toFixed(0)} cm en ${shots} tiros`);
  ok('sin NaN', nanFree(w));
}

console.log(fails ? `\n${fails} PRUEBAS FALLARON` : '\nTODO VERDE');
process.exit(fails ? 1 : 0);
