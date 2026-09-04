// Realismo del ragdoll: cuerpos colgados sobre muebles, levantarse de a poco,
// muerte con desplome, límites articulares, huesos que chocan con cosas.
import { PhysWorld } from '../src/phys/world.js';
import { Ragdoll, HEAD, NECK, CHEST, HIP, SHL, SHR, KNL, KNR, FTL, FTR, ELL, ELR, BONES, NB } from '../src/phys/ragdoll.js';
import { PropBox, PropSystem } from '../src/game/props.js';
import { makeRng } from '../src/core/util.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${name}   ${extra}`);
  if (!cond) fails++;
};
const DT = 1 / 60;
const run = (w, sec, fn) => { for (let i = 0; i < sec * 60; i++) { for (const b of w.bodies) if (b.update) b.update(DT); w.step(DT); if (fn) fn(i * DT); } };
const nanFree = (w) => { for (let i = 0; i < w.pn; i++) if (Number.isNaN(w.px[i] + w.py[i] + w.pz[i])) return false; return true; };
const dist = (B, i, j) => Math.hypot(B.px(i) - B.px(j), B.py(i) - B.py(j), B.pz(i) - B.pz(j));
/** ¿Cuántos puntos medios de hueso quedaron ADENTRO de una caja del mundo? */
const bonesInside = (w, B, box, tol = 0.03) => {
  let n = 0;
  for (let b = 0; b < NB; b++) {
    if (!B.boneAlive[b]) continue;
    const [ia, ib] = BONES[b];
    const x = (B.px(ia) + B.px(ib)) / 2, y = (B.py(ia) + B.py(ib)) / 2, z = (B.pz(ia) + B.pz(ib)) / 2;
    const rx = x - box.cx, rz = z - box.cz;
    const lx = rx * box.c + rz * box.s, lz = -rx * box.s + rz * box.c, ly = y - box.cy;
    if (Math.abs(lx) < box.hx - tol && Math.abs(ly) < box.hy - tol && Math.abs(lz) < box.hz - tol) n++;
  }
  return n;
};

// ── 1. muerto sobre un escritorio: queda colgado, no lo atraviesa ──────────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20;
  const desk = w.boxes[w.addBox(0, 0.37, 1.05, 0.8, 0.37, 0.42)];   // tapa a 0.74 m, 84 cm de fondo
  w.buildStaticIndex();
  const rng = makeRng(2);
  const B = new Ragdoll(w, { x: 0, z: 0.35, yaw: 0, rng });
  run(w, 0.5);
  B.kill();
  // lo empujan hacia adelante sobre el escritorio
  for (const i of [HEAD, NECK, CHEST, SHL, SHR]) w.addImpulse(B.p[i], 0, 3, 30);
  run(w, 3);
  const chestY = B.py(CHEST), footMin = Math.min(B.py(FTL), B.py(FTR)), headY = B.py(HEAD);
  ok('el torso quedó arriba del escritorio', chestY > 0.72, `pecho y=${chestY.toFixed(2)}`);
  ok('las piernas cuelgan hacia el piso', footMin < 0.45, `pie más bajo y=${footMin.toFixed(2)}`);
  ok('ningún hueso quedó adentro del escritorio', bonesInside(w, B, desk) === 0, bonesInside(w, B, desk) + ' adentro');
  ok('la cabeza no atraviesa la tapa', headY > 0.7 || B.pz(HEAD) > 1.25, `cabeza y=${headY.toFixed(2)} z=${B.pz(HEAD).toFixed(2)}`);
  ok('sin NaN', nanFree(w));
}

// ── 2. tirado contra una pared: los huesos no la cruzan ────────────────────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20;
  const wall = w.boxes[w.addBox(0, 1.5, 1.5, 3, 1.5, 0.15)];
  w.buildStaticIndex();
  const rng = makeRng(3);
  const B = new Ragdoll(w, { x: 0, z: 0.3, yaw: 0, rng });
  run(w, 0.5);
  B.knockback(0, 1, 3.0, 0.5);
  run(w, 3);
  let maxZ = -9; for (let i = 0; i < 16; i++) maxZ = Math.max(maxZ, B.pz(i));
  ok('ninguna partícula pasó la pared', maxZ < 1.5 - 0.15 + 0.02, `z máx=${maxZ.toFixed(2)}`);
  ok('ningún hueso quedó adentro de la pared', bonesInside(w, B, wall) === 0);
  ok('el empujón lo tiró o lo estrelló', !B.upright || B.z > 0.9, `upright=${B.upright} z=${B.z.toFixed(2)}`);
  ok('sin NaN', nanFree(w));
}

// ── 3. levantarse: primero tirado, después de pie ──────────────────────────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20; w.buildStaticIndex();
  const rng = makeRng(4);
  const B = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng });
  run(w, 0.5);
  B.knockback(1, 0, 3.2, 0.25);
  let downAt = null, upAgainAt = null, minMuscle = 1, upStreak = 0;
  run(w, 5, (t) => {
    if (!B.upright && downAt === null) downAt = t;
    // "de pie" de verdad = erguido y estable medio segundo (un tumbo no cuenta)
    if (downAt !== null && upAgainAt === null) {
      minMuscle = Math.min(minMuscle, B.muscleGlobal);
      if (B.upright && B.py(HEAD) > 1.3) { upStreak += DT; if (upStreak > 0.5) upAgainAt = t - 0.5; } else upStreak = 0;
    }
  });
  ok('el golpe lo tira', downAt !== null && downAt < 0.8, `cayó a t=${downAt?.toFixed(2)}`);
  ok('tirado, los músculos casi se apagan', minMuscle < 0.05, `mínimo ${minMuscle.toFixed(3)}`);
  ok('se queda en el piso al menos 0.8 s', upAgainAt === null || upAgainAt - downAt > 0.8, `arriba a t=${upAgainAt?.toFixed(2)}`);
  ok('y se vuelve a parar antes de los 5 s', upAgainAt !== null, `arriba a t=${upAgainAt?.toFixed(2)}`);
  ok('termina de pie y erguido', B.upright && B.py(HEAD) > 1.5, `cabeza=${B.py(HEAD).toFixed(2)}`);
}

// ── 4. muerte lenta: tambalea y cae; instantánea: cae ya ───────────────────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20; w.buildStaticIndex();
  const rng = makeRng(5);
  const A = new Ragdoll(w, { x: -2, z: 0, yaw: 0, rng });
  const C = new Ragdoll(w, { x: 2, z: 0, yaw: 0, rng });
  run(w, 0.5);
  A.kill(false); C.kill(true);
  ok('kill(false) no mata en el acto', !A.dead && A.dying > 0);
  ok('kill(true) mata en el acto', C.dead);
  const m0 = A.muscleGlobal;
  run(w, 0.15);
  ok('mientras muere los músculos bajan', A.muscleGlobal < m0 && !A.dead, `${m0.toFixed(2)} → ${A.muscleGlobal.toFixed(2)}`);
  run(w, 0.3);
  ok('a los 0.45 s está muerto', A.dead);
  run(w, 2.5);
  ok('los dos terminan en el piso', A.py(HEAD) < 0.35 && C.py(HEAD) < 0.35, `${A.py(HEAD).toFixed(2)} / ${C.py(HEAD).toFixed(2)}`);
}

// ── 5. límites articulares tras caídas violentas ───────────────────────────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20;
  w.addBox(0, 0.5, 0, 0.6, 0.5, 0.6);   // un cubo para que caiga torcido
  w.buildStaticIndex();
  const rng = makeRng(6);
  let viol = 0, tests = 0, worst = '';
  for (let k = 0; k < 6; k++) {
    const B = new Ragdoll(w, { x: (rng() - 0.5) * 0.6, z: (rng() - 0.5) * 0.6, y: 2.2 + rng(), yaw: rng() * 6, rng });
    B.kill();
    for (let i = 0; i < 16; i++) { w.vx[B.p[i]] += (rng() - 0.5) * 12; w.vz[B.p[i]] += (rng() - 0.5) * 12; w.vy[B.p[i]] += rng() * 4; }
    run(w, 3);
    const checks = [
      ['cabeza-hombro L', dist(B, HEAD, SHL), 0.22, Infinity],
      ['cabeza-hombro R', dist(B, HEAD, SHR), 0.22, Infinity],
      ['cabeza-cadera', dist(B, HEAD, HIP), 0.50, Infinity],
      ['rodilla L-pecho', dist(B, KNL, CHEST), 0.44, Infinity],
      ['rodilla R-pecho', dist(B, KNR, CHEST), 0.44, Infinity],
      ['rodillas', dist(B, KNL, KNR), 0.10, Infinity],
      ['pies', dist(B, FTL, FTR), 0.08, 1.25],
      ['codo L-pecho', dist(B, ELL, CHEST), 0.13, Infinity],
    ];
    for (const [name, d, lo, hi] of checks) { tests++; if (d < lo - 0.02 || d > hi + 0.02) { viol++; worst = `${name}=${d.toFixed(2)}`; } }
    B.dispose();
  }
  ok('los cadáveres respetan los límites articulares', viol === 0, `${viol}/${tests} violaciones ${worst}`);
  ok('sin NaN', nanFree(w));
}

// ── 6. la pierna empuja una caja (cápsula vs partícula) ────────────────────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20; w.buildStaticIndex();
  const sys = new PropSystem(w);
  const rng = makeRng(7);
  const box = sys.addBox(0, 0.001, 2.0, 0.5, 0.5, 0.5, 0, 3);
  const Z = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng });
  Z.wantX = 0; Z.wantZ = 1; Z.wantSpeed = 1.4;
  let maxTilt = 0;
  for (let i = 0; i < 4 * 60; i++) { sys.update(DT); for (const b of w.bodies) if (b.update) b.update(DT); w.step(DT); const f = box.frame({}); maxTilt = Math.max(maxTilt, 1 - f.ey[1]); }
  const f = box.frame({});
  ok('la caja fue pateada (se corrió o se tumbó)', f.z > 2.3 || maxTilt > 0.2, `z=${f.z.toFixed(2)} vuelco máx=${maxTilt.toFixed(2)}`);
  ok('el zombi sigue de pie o se tropezó (ambas valen)', true, `upright=${Z.upright}`);
  ok('sin NaN', nanFree(w));
}

// ── 7. dos cuerpos: uno cae sobre otro y no lo atraviesa ──────────────────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20; w.buildStaticIndex();
  const rng = makeRng(8);
  const A = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng }); A.kill();
  run(w, 2);
  const C = new Ragdoll(w, { x: 0.0, z: 0.0, y: 1.2, yaw: 0, rng }); C.kill();
  let landedOnTop = 0, minGap = 9;
  run(w, 3, (t) => {
    if (t < 0.5) return;
    const top = Math.max(...[HEAD, CHEST, HIP].map(i => C.py(i)));
    if (top > 0.4 && t > 0.6 && t < 1.2) landedOnTop = Math.max(landedOnTop, top);
    // ninguna partícula del de arriba se mete en el torso del de abajo
    for (const i of [HEAD, CHEST, HIP]) {
      const dx = C.px(i) - A.px(CHEST), dy = C.py(i) - A.py(CHEST), dz = C.pz(i) - A.pz(CHEST);
      minGap = Math.min(minGap, Math.hypot(dx, dy, dz));
    }
  });
  ok('nunca se metió dentro del torso del de abajo', minGap > 0.20, `gap mín=${minGap.toFixed(2)} (aterrizó a ${landedOnTop.toFixed(2)})`);
  ok('sin NaN', nanFree(w));
}

console.log(fails ? `\n${fails} PRUEBAS FALLARON` : '\nTODO VERDE');
process.exit(fails ? 1 : 0);
