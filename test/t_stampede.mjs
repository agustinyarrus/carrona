// Ragdoll siempre activo, estilo Left 4 Dead: choques a toda velocidad contra
// paredes y cuerpos, tropiezos con cadáveres, marchas (caminar/correr/pasos
// laterales) y sacudones por disparo.
import { PhysWorld } from '../src/phys/world.js';
import { Ragdoll, HEAD, CHEST, HIP, FTL, FTR } from '../src/phys/ragdoll.js';
import { makeRng } from '../src/core/util.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${name}   ${extra}`);
  if (!cond) fails++;
};
const DT = 1 / 60;
const run = (w, sec, fn) => { for (let i = 0; i < sec * 60; i++) { for (const b of w.bodies) if (b.update) b.update(DT); w.step(DT); if (fn) fn(i * DT); } };
const nanFree = (w) => { for (let i = 0; i < w.pn; i++) if (Number.isNaN(w.px[i] + w.py[i] + w.pz[i])) return false; return true; };
const runner = (w, x, z, rng) => new Ragdoll(w, { x, z, yaw: 0, stride: 0.32, armMode: 'pump', stiffness: 165, maxMuscleSpeed: 13, rng });

// ── 1. corredor contra una pared: se estrella, cae, se levanta ─────────────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20;
  w.addBox(0, 1.5, 4.0, 3, 1.5, 0.15);
  w.buildStaticIndex();
  const R = runner(w, 0, 0, makeRng(1));
  R.wantX = 0; R.wantZ = 1; R.wantSpeed = 3.5;
  let fellAt = null, maxZ = -9, upAgain = null, upStreak = 0;
  run(w, 7, (t) => {
    for (let i = 0; i < 16; i++) maxZ = Math.max(maxZ, R.pz(i));
    if (R.slams > 0) R.wantSpeed = 0;      // después del choque deja de insistir contra la pared
    if (!R.upright && fellAt === null) fellAt = t;
    if (fellAt !== null && upAgain === null) { if (R.upright && R.py(HEAD) > 1.4) { upStreak += DT; if (upStreak > 0.5) upAgain = t; } else upStreak = 0; }
  });
  ok('se estrelló (slam registrado)', R.slams >= 1, `slams=${R.slams}`);
  ok('se cayó por el choque', fellAt !== null && fellAt < 3.5, `cayó a t=${fellAt?.toFixed(2)}`);
  ok('nunca atravesó la pared', maxZ < 3.85 + 0.03, `z máx=${maxZ.toFixed(2)}`);
  ok('se volvió a levantar', upAgain !== null, `de pie a t=${upAgain?.toFixed(2)}`);
  ok('sin NaN', nanFree(w));
}

// ── 2. caminante contra la pared: se frena, NO se cae ──────────────────────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20;
  w.addBox(0, 1.5, 4.0, 3, 1.5, 0.15);
  w.buildStaticIndex();
  const B = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng: makeRng(2) });
  B.wantX = 0; B.wantZ = 1; B.wantSpeed = 1.4;
  let fell = false;
  run(w, 6, () => { if (!B.upright) fell = true; });
  ok('caminando no se estrella', B.slams === 0 && !fell, `slams=${B.slams} cayó=${fell}`);
  ok('llegó hasta la pared', B.z > 3.1, `z=${B.z.toFixed(2)}`);
  ok('sigue de pie', B.upright && B.py(HEAD) > 1.5);
}

// ── 3. corredor choca a un caminante quieto ─────────────────────────────────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20; w.buildStaticIndex();
  const rng = makeRng(3);
  const W = new Ragdoll(w, { x: 0, z: 3.0, yaw: Math.PI, rng });
  const R = runner(w, 0, 0, rng);
  R.wantX = 0; R.wantZ = 1; R.wantSpeed = 3.5;
  let someoneFell = false, wallerFell = false, runnerFell = false;
  run(w, 3, () => { if (R.slams > 0 || R.bumps > 0) R.wantSpeed = 0; if (!W.upright) { someoneFell = true; wallerFell = true; } if (!R.upright) { someoneFell = true; runnerFell = true; } });
  ok('el choque se registra (tropezón mutuo)', R.bumps >= 1 || R.slams >= 1, `bumps=${R.bumps} slams=${R.slams}`);
  ok('el choque tira a alguno de los dos', someoneFell, `caminante=${wallerFell} corredor=${runnerFell}`);
  ok('el caminante fue desplazado', Math.hypot(W.x, W.z - 3.0) > 0.4, `d=${Math.hypot(W.x, W.z - 3.0).toFixed(2)}`);
  run(w, 5);
  ok('a los 8 s los dos están de pie otra vez', W.upright && R.upright, `${W.upright} ${R.upright}`);
  ok('sin NaN', nanFree(w));
}

// ── 4. cadáver como obstáculo bajo: se tropieza o lo pasa por arriba ───────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20;
  const corpse = w.boxes[w.addBox(0, 0.11, 3.0, 0.9, 0.11, 0.35, Math.PI / 2)];   // cuerpo cruzado en el camino
  corpse.isCorpse = true;
  w.buildStaticIndex();
  const rng = makeRng(4);
  const R = runner(w, 0, 0, rng);
  R.wantX = 0; R.wantZ = 1; R.wantSpeed = 3.5;
  let inside = 0;
  run(w, 4, () => {
    for (const f of [FTL, FTR]) {
      const dz = Math.abs(R.pz(f) - 3.0), dx = Math.abs(R.px(f));
      if (dz < 0.30 && dx < 0.85 && R.py(f) < 0.11) inside++;    // pie adentro del cadáver
    }
  });
  ok('el corredor tropieza con el cadáver o lo salta', R.tripped >= 1 || R.slams >= 1 || R.z > 4, `tropiezos=${R.tripped} slams=${R.slams} z=${R.z.toFixed(2)}`);
  ok('los pies no se hunden en el cadáver', inside < 6, `${inside} muestras adentro`);
  ok('sin NaN', nanFree(w));
}

// ── 5. marchas: correr ≠ caminar ───────────────────────────────────────────
{
  const w = new PhysWorld(); w.groundHX = 30; w.groundHZ = 30; w.buildStaticIndex();
  const R = runner(w, 0, -20, makeRng(5));
  const measure = (speed, sec) => {
    R.wantX = 0; R.wantZ = 1; R.wantSpeed = speed;
    let reach = 0, lean = 0, kneeLift = 0, n = 0;
    run(w, 1.0);
    run(w, sec, () => {
      for (const f of [FTL, FTR]) reach = Math.max(reach, Math.abs(R.pz(f) - R.z));
      kneeLift = Math.max(kneeLift, Math.max(R.py(12), R.py(13)));
      lean += (R.pz(HEAD) - R.pz(HIP)); n++;
    });
    return { reach, lean: lean / n, kneeLift, speed: R.speed, up: R.upright, gait: R.gait };
  };
  const walk = measure(1.2, 3);
  const sprint = measure(3.0, 3);
  console.log(`  caminar: zancada ${walk.reach.toFixed(2)} inclinación ${walk.lean.toFixed(2)} rodilla ${walk.kneeLift.toFixed(2)} v=${walk.speed.toFixed(2)} gait=${walk.gait.toFixed(2)}`);
  console.log(`  correr:  zancada ${sprint.reach.toFixed(2)} inclinación ${sprint.lean.toFixed(2)} rodilla ${sprint.kneeLift.toFixed(2)} v=${sprint.speed.toFixed(2)} gait=${sprint.gait.toFixed(2)}`);
  ok('corriendo la zancada es más larga', sprint.reach > walk.reach * 1.15);
  ok('corriendo se inclina más', sprint.lean > walk.lean + 0.05);
  ok('corriendo levanta más la rodilla', sprint.kneeLift > walk.kneeLift + 0.04);
  ok('corriendo llega a la velocidad pedida', sprint.speed > 2.6, sprint.speed.toFixed(2));
  ok('la mezcla de marcha responde a la velocidad', walk.gait < 0.4 && sprint.gait > 0.8);
  ok('sigue de pie en las dos', walk.up && sprint.up);
}

// ── 6. pasos laterales: mira a +Z, se mueve a +X ───────────────────────────
{
  const w = new PhysWorld(); w.groundHX = 30; w.groundHZ = 30; w.buildStaticIndex();
  const P = new Ragdoll(w, { x: 0, z: 0, yaw: 0, lockYaw: true, armMode: 'aim', stiffness: 175, maxMuscleSpeed: 13, stride: 0.27, rng: makeRng(6) });
  P.wantX = 1; P.wantZ = 0; P.wantSpeed = 1.6;
  let latAmp = 0, fwdAmp = 0, fell = false;
  run(w, 3, () => {
    for (const f of [FTL, FTR]) {
      latAmp = Math.max(latAmp, Math.abs(P.px(f) - P.x));
      fwdAmp = Math.max(fwdAmp, Math.abs(P.pz(f) - P.z));
    }
    if (!P.upright) fell = true;
  });
  ok('caminando de costado los pies se abren lateralmente', latAmp > 0.30, `lateral ${latAmp.toFixed(2)} m`);
  ok('… y casi no se adelantan', fwdAmp < 0.30, `adelante ${fwdAmp.toFixed(2)} m`);
  ok('sigue mirando a +Z', Math.abs(P.yaw) < 0.05, P.yaw.toFixed(2));
  ok('avanzó en X', P.x > 3.0, P.x.toFixed(2));
  ok('no se cayó', !fell);
}

// ── 7. sacudón por disparo: se ve, no tira; escopeta a quemarropa: tira ────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20; w.buildStaticIndex();
  const rng = makeRng(7);
  const A = new Ragdoll(w, { x: -3, z: 0, yaw: 0, rng });
  const B = new Ragdoll(w, { x: 3, z: 0, yaw: 0, rng });
  run(w, 1);
  const z0 = A.pz(CHEST);
  A.hit(2, 0.5, 30, [0, 2, 7]);         // pistola en la columna
  let maxDisp = 0, fellA = false;
  run(w, 1.5, () => { maxDisp = Math.max(maxDisp, A.pz(CHEST) - z0); if (!A.upright) fellA = true; });
  ok('un tiro de pistola sacude el torso (> 3 cm)', maxDisp > 0.03, `${(maxDisp * 100).toFixed(1)} cm`);
  ok('… pero no lo tira', !fellA && A.upright);
  B.hit(2, 0.5, 120, [0, 20, 80]);      // escopeta a quemarropa
  let fellB = false;
  run(w, 1.5, () => { if (!B.upright) fellB = true; });
  ok('la escopeta a quemarropa lo tira', fellB, `upright=${B.upright}`);
  run(w, 4);
  ok('se levanta después', B.upright && B.py(HEAD) > 1.4, `cabeza=${B.py(HEAD).toFixed(2)}`);
  ok('sin NaN', nanFree(w));
}

console.log(fails ? `\n${fails} PRUEBAS FALLARON` : '\nTODO VERDE');
process.exit(fails ? 1 : 0);
