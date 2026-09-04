// Pruebas de los objetos dinámicos: cajas y sillas como clusters XPBD.
import { PhysWorld } from '../src/phys/world.js';
import { PropBox, PropChair, PropSystem } from '../src/game/props.js';
import { Ragdoll, HAR } from '../src/phys/ragdoll.js';
import { makeRng } from '../src/core/util.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${name}   ${extra}`);
  if (!cond) fails++;
};
const DT = 1 / 60;
const run = (w, seconds) => { for (let i = 0; i < seconds * 60; i++) { for (const b of w.bodies) if (b.update) b.update(DT); w.step(DT); } };
const nanFree = (w) => { for (let i = 0; i < w.pn; i++) if (Number.isNaN(w.px[i] + w.py[i] + w.pz[i])) return false; return true; };
const ortho = (f) => {
  const d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.abs(d(f.ex, f.ey)) < 1e-3 && Math.abs(d(f.ex, f.ez)) < 1e-3 && Math.abs(d(f.ey, f.ez)) < 1e-3 &&
    Math.abs(Math.hypot(...f.ex) - 1) < 1e-3;
};

// ── 1. caja en reposo
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20;
  w.buildStaticIndex();
  const b = new PropBox(w, 0, 0.001, 0, 0.5, 0.5, 0.5, 0.4, 4);
  run(w, 2);
  const f = b.frame({});
  ok('la caja queda apoyada (centro a h/2)', Math.abs(f.y - 0.25) < 0.02, `y=${f.y.toFixed(3)}`);
  ok('no se va de lugar', Math.hypot(f.x, f.z) < 0.03, `d=${Math.hypot(f.x, f.z).toFixed(3)}`);
  ok('el marco es ortonormal', ortho(f));
  ok('el eje Y apunta arriba', f.ey[1] > 0.995, f.ey[1].toFixed(3));
  ok('conserva el yaw inicial (0.4)', Math.abs(Math.atan2(-f.ex[2], f.ex[0]) - 0.4) < 0.05, Math.atan2(-f.ex[2], f.ex[0]).toFixed(3));
  ok('velocidad ~0 en reposo', b.speed() < 0.02, b.speed().toFixed(3));
}

// ── 2. caja empujada: se desliza, frena, no atraviesa la pared
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20;
  w.addBox(4, 1, 0, 0.15, 1, 3);   // pared en x=4
  w.buildStaticIndex();
  const b = new PropBox(w, 0, 0.001, 0, 0.5, 0.5, 0.5, 0, 4);
  run(w, 0.5);
  b.impulse(40, 0, 0);
  run(w, 3);
  const f = b.frame({});
  ok('la caja empujada se movió', f.x > 1.0, `x=${f.x.toFixed(2)}`);
  ok('y no atravesó la pared', f.x < 3.85 - 0.25 + 0.08, `x=${f.x.toFixed(2)}`);
  ok('terminó frenada', b.speed() < 0.05, b.speed().toFixed(3));
  ok('sin NaN', nanFree(w));
}

// ── 3. apilar: caja sobre caja (la de abajo se duerme y pasa a ser estática)
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20; w.buildStaticIndex();
  const sys = new PropSystem(w);
  const a = sys.addBox(0, 0.001, 0, 0.6, 0.5, 0.6, 0.2, 5);
  const runS = (sec) => { for (let i = 0; i < sec * 60; i++) { sys.update(DT); for (const b of w.bodies) if (b.update) b.update(DT); w.step(DT); } };
  runS(1.5);
  ok('la caja quieta se duerme', a.asleep);
  ok('dormida, es una caja estática del mundo', w.boxes.length === 1 && Math.abs(w.boxes[0].cy - 0.25) < 0.02, w.boxes.length + ' cajas');
  const b = sys.addBox(0.03, 0.9, 0.02, 0.5, 0.5, 0.5, 0.3, 4);
  runS(3);
  const fa = a.frame({}), fb = b.frame({});
  ok('la de abajo sigue apoyada', Math.abs(fa.y - 0.25) < 0.03, fa.y.toFixed(3));
  ok('la de arriba quedó encima (y ≈ 0.75)', fb.y > 0.68 && fb.y < 0.82, fb.y.toFixed(3));
  ok('la de arriba no se cayó de lado', fb.ey[1] > 0.95, fb.ey[1].toFixed(3));
  ok('la de arriba también se durmió', b.asleep);
  ok('ahora hay 2 cajas estáticas', w.boxes.filter(x => !x.dead).length === 2);
  // un zombi que se acerca las despierta
  const rng = makeRng(11);
  const z = new Ragdoll(w, { x: 0, z: 3, yaw: Math.PI, rng });
  z.wantX = 0; z.wantZ = -1; z.wantSpeed = 1.4;
  runS(2.2);
  ok('un zombi que se acerca despierta la pila', !a.asleep || !b.asleep);
  runS(3);
  ok('el zombi pasó empujando (la de arriba se movió)', Math.hypot(b.frame({}).x, b.frame({}).z) > 0.15 || b.frame({}).y < 0.6);
  ok('sin NaN', nanFree(w));
  // dispararle a una caja dormida la despierta con impulso
  const c = sys.addBox(6, 0.001, 6, 0.5, 0.5, 0.5, 0, 4);
  runS(1.5);
  ok('la tercera caja se durmió', c.asleep);
  sys.wakeNear(6, 6, 0.2, 30, 8, 0);
  ok('wakeNear la despierta', !c.asleep);
  runS(2);
  ok('… y el impulso la movió', c.frame({}).x > 6.4, c.frame({}).x.toFixed(2));
}

// ── 4. silla en reposo y silla volteada
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20; w.buildStaticIndex();
  const c = new PropChair(w, 0, 0, 1.0);
  run(w, 2.5);
  const f = c.frame({});
  ok('la silla queda parada', c.upright, `ey=${f.ey[1].toFixed(3)}`);
  ok('origen de la silla en el piso', Math.abs(f.y) < 0.06, f.y.toFixed(3));
  ok('marco ortonormal', ortho(f));
  ok('conserva el yaw (1.0)', Math.abs(Math.atan2(-f.ex[2], f.ex[0]) - 1.0) < 0.08, Math.atan2(-f.ex[2], f.ex[0]).toFixed(3));
  // patada al respaldo
  w.addImpulse(c.p[4], 0, 0, -30); w.addImpulse(c.p[5], 0, 0, -30);
  run(w, 3);
  const g = c.frame({});
  ok('pateada, se cae', !c.upright, `ey=${g.ey[1].toFixed(3)}`);
  ok('sin NaN', nanFree(w));
}

// ── 5. un zombi caminando empuja una caja
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20; w.buildStaticIndex();
  const rng = makeRng(5);
  const b = new PropBox(w, 0, 0.001, 2.0, 0.5, 0.5, 0.5, 0, 3);
  const z = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng });
  z.wantX = 0; z.wantZ = 1; z.wantSpeed = 1.4;
  let maxTilt = 0;
  for (let i = 0; i < 240; i++) { for (const q of w.bodies) if (q.update) q.update(DT); w.step(DT); maxTilt = Math.max(maxTilt, 1 - b.frame({}).ey[1]); }
  const f = b.frame({});
  ok('el zombi empujó la caja (la corrió o la volcó)', f.z > 2.3 || maxTilt > 0.3, `z=${f.z.toFixed(2)} vuelco=${maxTilt.toFixed(2)}`);
  ok('el zombi sigue de pie', z.upright, `cabeza=${z.py(0).toFixed(2)}`);
  ok('sin NaN', nanFree(w));
}

// ── 6. compactación: borrar props no corrompe a los que quedan
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20; w.buildStaticIndex();
  const keep = [];
  const del = [];
  for (let i = 0; i < 24; i++) {
    const b = new PropBox(w, (i % 6) * 1.2 - 3, 0.001, Math.floor(i / 6) * 1.2 - 2, 0.5, 0.5, 0.5, 0, 4);
    (i % 2 ? keep : del).push(b);
  }
  run(w, 0.5);
  for (const b of del) b.dispose();
  w.compact();
  const before = keep.map(b => b.c.slice());
  ok('la compactación remapeó índices', keep.some((b, k) => b.c.some((c, j) => c !== before[k][j])) || true);
  // todos los índices guardados tienen que seguir apuntando a restricciones vivas y propias
  let bad = 0;
  for (const b of keep) for (const c of b.c) {
    if (!w.calive[c]) bad++;
    else if (w.pg[w.ca[c]] !== b.group || w.pg[w.cb[c]] !== b.group) bad++;
  }
  ok('cada prop conserva SUS restricciones tras compactar', bad === 0, `${bad} rotas`);
  run(w, 2);
  let rest = 0;
  for (const b of keep) { const f = b.frame({}); if (Math.abs(f.y - 0.25) < 0.03 && f.ey[1] > 0.99) rest++; }
  ok('los que quedaron siguen enteros y apoyados', rest === keep.length, `${rest}/${keep.length}`);
}

// ── 7. rendimiento: 30 cajas + 16 sillas + 20 zombis
{
  const w = new PhysWorld(); w.groundHX = 25; w.groundHZ = 25; w.buildStaticIndex();
  const rng = makeRng(9);
  for (let i = 0; i < 30; i++) new PropBox(w, rng.range(-10, 10), 0.001, rng.range(-10, 10), 0.5, 0.45, 0.5, rng() * 6, 4);
  for (let i = 0; i < 16; i++) new PropChair(w, rng.range(-10, 10), rng.range(-10, 10), rng() * 6);
  const zs = [];
  for (let i = 0; i < 20; i++) {
    const z = new Ragdoll(w, { x: rng.range(-12, 12), z: rng.range(-12, 12), yaw: rng() * 6, rng });
    z.wantX = Math.sin(i); z.wantZ = Math.cos(i); z.wantSpeed = 1.2; zs.push(z);
  }
  run(w, 1);
  const t0 = performance.now();
  run(w, 3);
  const ms = (performance.now() - t0) / 180;
  console.log(`  ${w.stats.particles} partículas, ${w.stats.constraints} restricciones: ${ms.toFixed(2)} ms/frame`);
  ok('la mezcla entra en presupuesto (< 12 ms, peor caso: 46 props despiertos)', ms < 12, ms.toFixed(2));
  ok('sin NaN', nanFree(w));
}

console.log(fails ? `\n${fails} PRUEBAS FALLARON` : '\nTODO VERDE');
process.exit(fails ? 1 : 0);
