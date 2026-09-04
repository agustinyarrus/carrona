import { PhysWorld, CT_MAX, PF_ALIVE } from '../src/phys/world.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log((cond ? '  OK   ' : '  FALLA') + ' ' + name + (extra ? '   ' + extra : ''));
  if (!cond) fails++;
};

// ── 1. caída libre y reposo ──────────────────────────────────────────────────
{
  const w = new PhysWorld();
  const a = w.addParticle(0, 5, 0, 1, 0.15, 1);
  const b = w.addParticle(0, 5.5, 0, 1, 0.15, 1);
  w.addConstraint(a, b, 0.5, 0);
  for (let i = 0; i < 240; i++) w.step(1 / 60);
  ok('reposo sobre el piso', Math.abs(w.py[a] - 0.15) < 0.01, 'y=' + w.py[a].toFixed(4));
  ok('cadena mantiene largo', Math.abs((w.py[b] - w.py[a]) - 0.5) < 0.01, 'L=' + (w.py[b] - w.py[a]).toFixed(4));
  ok('sin NaN', !Number.isNaN(w.py[a]) && !Number.isNaN(w.py[b]));
  ok('velocidad casi cero en reposo', Math.abs(w.vy[a]) < 0.2, 'vy=' + w.vy[a].toFixed(4));
}

// ── 2. compliance = rigidez blanda medible ───────────────────────────────────
{
  const w = new PhysWorld();
  const anchor = w.addParticle(0, 4, 0, 0, 0.1, 1);      // masa 0 = estático
  const hang = w.addParticle(0, 3, 0, 10, 0.1, 1);
  w.addConstraint(anchor, hang, 1.0, 0);                  // rígido
  for (let i = 0; i < 300; i++) w.step(1 / 60);
  const rigid = Math.abs((w.py[anchor] - w.py[hang]) - 1.0);
  ok('restriccion rigida casi no estira', rigid < 0.02, 'estiro=' + rigid.toFixed(5));

  const w2 = new PhysWorld();
  const an2 = w2.addParticle(0, 4, 0, 0, 0.1, 1);
  const hg2 = w2.addParticle(0, 3, 0, 10, 0.1, 1);
  w2.addConstraint(an2, hg2, 1.0, 0.002);                 // blando
  for (let i = 0; i < 300; i++) w2.step(1 / 60);
  const soft = Math.abs((w2.py[an2] - w2.py[hg2]) - 1.0);
  ok('compliance genera estiramiento mayor', soft > rigid * 3, 'blando=' + soft.toFixed(5) + ' vs rigido=' + rigid.toFixed(5));
}

// ── 3. tipos MIN / MAX ───────────────────────────────────────────────────────
{
  const w = new PhysWorld();
  w.gravity = 0;
  const a = w.addParticle(-2, 2, 0, 1, 0.05, 1);
  const b = w.addParticle(2, 2, 0, 1, 0.05, 2);
  w.addConstraint(a, b, 1.0, 0, CT_MAX);   // deben acercarse hasta 1.0
  for (let i = 0; i < 200; i++) w.step(1 / 60);
  const d = Math.abs(w.px[b] - w.px[a]);
  ok('CT_MAX junta hasta el limite', Math.abs(d - 1.0) < 0.02, 'd=' + d.toFixed(4));
}

// ── 4. colisión con caja ─────────────────────────────────────────────────────
{
  const w = new PhysWorld();
  w.addBox(0, 1, 0, 2, 1, 2, 0);                 // caja de 4x2x4 centrada en y=1 → tapa en y=2
  const p = w.addParticle(0, 6, 0, 1, 0.2, 1);
  for (let i = 0; i < 200; i++) w.step(1 / 60);
  ok('descansa sobre la caja', Math.abs(w.py[p] - 2.2) < 0.02, 'y=' + w.py[p].toFixed(4));
}

// ── 5. caja rotada ───────────────────────────────────────────────────────────
{
  const w = new PhysWorld();
  w.addBox(0, 1, 0, 3, 1, 0.5, Math.PI / 4);     // pared fina a 45°
  const p = w.addParticle(0, 5, 0, 1, 0.2, 1);
  for (let i = 0; i < 200; i++) w.step(1 / 60);
  ok('caja rotada tambien frena', w.py[p] > 2.0, 'y=' + w.py[p].toFixed(3));
}

// ── 6. cilindro ──────────────────────────────────────────────────────────────
{
  const w = new PhysWorld();
  w.gravity = 0;
  w.addCylinder(0, 0, 1.0, 0, 4);
  const p = w.addParticle(0.2, 2, 0, 1, 0.15, 1);
  w.vx[p] = 0;
  for (let i = 0; i < 120; i++) w.step(1 / 60);
  const rad = Math.hypot(w.px[p], w.pz[p]);
  ok('expulsado del cilindro', rad > 1.1 && rad < 4, 'r=' + rad.toFixed(3));
  const sp = Math.hypot(w.vx[p], w.vy[p], w.vz[p]);
  ok('la expulsion es suave, no un disparo', sp < 5, 'v=' + sp.toFixed(3) + ' m/s');
}

// ── 7. raycast contra hueso ──────────────────────────────────────────────────
{
  const w = new PhysWorld();
  w.gravity = 0;
  const a = w.addParticle(0, 2, -0.5, 1, 0.1, 1);
  const b = w.addParticle(0, 2, 0.5, 1, 0.1, 1);
  const fakeBody = { name: 'test' };
  w.addBone(a, b, 0.12, 100, fakeBody, 0);
  const out = {};
  // rayo desde x=-5 hacia +x, debería pegarle al medio del hueso
  const hit = w.raycastBones(-5, 2, 0, 1, 0, 0, 20, out);
  ok('raycast pega al hueso', hit, hit ? ('t=' + out.t.toFixed(3) + ' s=' + out.s.toFixed(3)) : '');
  ok('t correcto (superficie)', hit && Math.abs(out.t - (5 - 0.12)) < 0.02, hit ? out.t.toFixed(4) : '');
  ok('s en el medio', hit && Math.abs(out.s - 0.5) < 0.05, hit ? out.s.toFixed(4) : '');
  ok('devuelve el cuerpo', hit && out.body === fakeBody);
  const miss = w.raycastBones(-5, 6, 0, 1, 0, 0, 20, out);
  ok('raycast que erra no reporta', !miss);
  // saltear el propio cuerpo
  const skip = w.raycastBones(-5, 2, 0, 1, 0, 0, 20, out, fakeBody);
  ok('skipBody funciona', !skip);
}

// ── 8. raycast estático + linea de vision ────────────────────────────────────
{
  const w = new PhysWorld();
  w.addBox(0, 1.5, 0, 0.5, 1.5, 4, 0);           // pared
  const out = {};
  const t = w.raycastStatic(-5, 1.5, 0, 1, 0, 0, 20, out);
  ok('raycast estatico pega a la pared', t > 0 && Math.abs(t - 4.5) < 0.05, 't=' + t.toFixed(3));
  ok('normal apunta al rayo', Math.abs(out.nx + 1) < 0.01, 'nx=' + (out.nx || 0).toFixed(3));
  ok('sin linea de vision a traves de la pared', !w.lineOfSight(-5, 1.5, 0, 5, 1.5, 0));
  ok('con linea de vision por arriba', w.lineOfSight(-5, 5, 0, 5, 5, 0));
}

// ── 9. colisión partícula-partícula entre grupos distintos ───────────────────
{
  const w = new PhysWorld();
  w.gravity = 0;
  const a = w.addParticle(-0.05, 2, 0, 1, 0.2, 1);
  const b = w.addParticle(0.05, 2, 0, 1, 0.2, 2);
  for (let i = 0; i < 90; i++) w.step(1 / 60);
  const d = Math.abs(w.px[b] - w.px[a]);
  ok('grupos distintos se separan', d > 0.35 && d < 3, 'd=' + d.toFixed(3));
  const sp2 = Math.hypot(w.vx[b], w.vy[b], w.vz[b]);
  ok('separacion sin salir disparados', sp2 < 5, 'v=' + sp2.toFixed(3) + ' m/s');

  const w2 = new PhysWorld();
  w2.gravity = 0;
  const c = w2.addParticle(-0.05, 2, 0, 1, 0.2, 7);
  const d2 = w2.addParticle(0.05, 2, 0, 1, 0.2, 7);   // mismo grupo
  for (let i = 0; i < 90; i++) w2.step(1 / 60);
  ok('mismo grupo se ignora', Math.abs(w2.px[d2] - w2.px[c]) < 0.15);
}

// ── 10. explosión ────────────────────────────────────────────────────────────
{
  const w = new PhysWorld();
  const p = w.addParticle(2, 1, 0, 1, 0.15, 1);
  w.explode(0, 1, 0, 6, 40);
  ok('la explosion empuja hacia afuera', w.vx[p] > 1, 'vx=' + w.vx[p].toFixed(3));
  ok('y hacia arriba', w.vy[p] > 0, 'vy=' + w.vy[p].toFixed(3));
}

// ── 11. caída al vacío fuera de la losa ──────────────────────────────────────
{
  const w = new PhysWorld();
  w.groundHX = 5; w.groundHZ = 5; w.killY = -20;
  const inside = w.addParticle(0, 1, 0, 1, 0.15, 1);
  const outside = w.addParticle(9, 1, 0, 1, 0.15, 2);
  for (let i = 0; i < 300; i++) w.step(1 / 60);
  ok('adentro de la losa se apoya', Math.abs(w.py[inside] - 0.15) < 0.02);
  ok('afuera se cae al vacio y muere', !(w.pf[outside] & PF_ALIVE));
}

// ── 12. rendimiento con carga de multitud ────────────────────────────────────
{
  const w = new PhysWorld();
  const NB = 60, NP = 16;
  for (let b = 0; b < NB; b++) {
    const x = (b % 10) * 1.5 - 7, z = ((b / 10) | 0) * 1.5 - 4;
    const idx = [];
    for (let p = 0; p < NP; p++) idx.push(w.addParticle(x + Math.random() * .2, 0.3 + p * 0.1, z + Math.random() * .2, 4, 0.11, b));
    for (let p = 0; p + 1 < NP; p++) w.addConstraint(idx[p], idx[p + 1], 0.1, 0);
    for (let p = 0; p + 2 < NP; p++) w.addConstraint(idx[p], idx[p + 2], 0.2, 0.00002);
    for (let p = 0; p + 1 < NP; p++) w.addBone(idx[p], idx[p + 1], 0.1, 40, { id: b }, p);
  }
  for (let i = 0; i < 20; i++) w.step(1 / 60);       // calentar el JIT
  const t0 = performance.now();
  for (let i = 0; i < 120; i++) w.step(1 / 60);
  const ms = (performance.now() - t0) / 120;
  console.log('');
  console.log('  carga: ' + NB + ' cuerpos, ' + w.stats.particles + ' particulas, ' + w.stats.constraints + ' restricciones, ' + w.stats.bones + ' huesos');
  console.log('  substeps=' + w.substeps + '  →  ' + ms.toFixed(3) + ' ms/frame  (presupuesto 16.7)');
  ok('rendimiento dentro del presupuesto', ms < 6.0, ms.toFixed(3) + ' ms');

  // raycast bajo carga
  const out = {};
  const t1 = performance.now();
  let hits = 0;
  for (let i = 0; i < 2000; i++) if (w.raycastBones(-20, 0.16, -4 + (i % 9) * 1.5, 1, 0, 0, 60, out)) hits++;
  const rms = (performance.now() - t1) / 2000;
  console.log('  raycast contra ' + w.stats.bones + ' huesos: ' + (rms * 1000).toFixed(1) + ' us  (' + hits + '/2000 impactos)');
  ok('raycast rapido', rms < 0.2 && hits > 100, (rms * 1000).toFixed(1) + ' us');

  let nan = 0;
  for (let i = 0; i < w.pn; i++) if (Number.isNaN(w.px[i]) || Number.isNaN(w.py[i])) nan++;
  ok('nada exploto', nan === 0, nan + ' NaN');
}

// ── 13. no hay tunneling a alta velocidad ───────────────────────────────────
{
  const w = new PhysWorld();
  w.gravity = 0;
  w.addBox(3, 2, 0, 0.4, 4, 6, 0);          // pared en x=3, de 2.6 a 3.4
  const p = w.addParticle(-3, 2, 0, 4, 0.18, 1);
  w.vx[p] = 45;                              // 45 m/s: 0.107 m por substep
  for (let i = 0; i < 90; i++) w.step(1 / 60);
  ok('no atraviesa la pared a 45 m/s', w.px[p] < 2.7, 'x=' + w.px[p].toFixed(3));
  ok('quedo apoyado, no clavado', w.px[p] > 2.3, 'x=' + w.px[p].toFixed(3));
}

// ── 14. lo que se apoya sobre una caja no se hunde con el tiempo ────────────
{
  const w = new PhysWorld();
  w.addBox(0, 1, 0, 3, 1, 3, 0);
  const ps = [];
  for (let i = 0; i < 8; i++) ps.push(w.addParticle(-1 + i * 0.3, 2.6, 0, 3, 0.16, i));
  for (let i = 0; i < 900; i++) w.step(1 / 60);   // 15 segundos
  let minY = Infinity;
  for (const p of ps) minY = Math.min(minY, w.py[p]);
  ok('nada se hunde tras 15 s', minY > 2.13, 'minY=' + minY.toFixed(4));
}

// ── 15. la convencion de yaw coincide con Three.js ──────────────────────────
{
  // Three: rotar +90 grados en Y lleva el +X local a (0,0,-1).
  // Una caja larga en X rotada 90 grados debe quedar larga en Z, y su cara
  // ancha debe frenar un rayo que viene por X a 2 m del centro.
  const w = new PhysWorld();
  w.addBox(0, 1, 0, 4, 1, 0.25, Math.PI / 2);   // 8 m en X, rotada a 90
  const out = {};
  const alongZ = w.raycastStatic(0, 1, -6, 0, 0, 1, 20, out);
  const alongX = w.raycastStatic(-6, 1, 3, 1, 0, 0, 20, out);
  // rotada 90: el largo de 8 m pasa a Z (de -4 a +4) y el grosor a X (+-0.25)
  ok('rotada 90: larga en Z', alongZ > 0 && Math.abs(alongZ - (6 - 4)) < 0.02, 't=' + alongZ.toFixed(3));
  ok('rotada 90: fina en X', alongX > 0 && Math.abs(alongX - (6 - 0.25)) < 0.02, 't=' + alongX.toFixed(3));
  // y a 45 grados el largo apunta a (sin45, cos45) desde el +X local -> (cos,-sin)
  const w2 = new PhysWorld();
  w2.addBox(0, 1, 0, 4, 1, 0.25, Math.PI / 4);
  const p1 = w2.raycastStatic(2.8, 4, -2.8, 0, -1, 0, 20, out);  // sobre (cos45,-sin45)*4
  const p2 = w2.raycastStatic(2.8, 4, 2.8, 0, -1, 0, 20, out);   // el otro diagonal
  // la caja termina en y=2; el piso en y=0. Pegarle a la caja da t=2, errarle t=4.
  ok('a 45 el largo va hacia (+x,-z)', Math.abs(p1 - 2) < 0.02, 't=' + p1.toFixed(2));
  ok('y NO hacia (+x,+z): pasa de largo al piso', Math.abs(p2 - 4) < 0.02, 't=' + p2.toFixed(2));
}

console.log('');
console.log(fails === 0 ? 'TODO VERDE' : (fails + ' PRUEBAS FALLARON'));
process.exit(fails ? 1 : 0);
