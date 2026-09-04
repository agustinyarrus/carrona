import { PhysWorld } from '../src/phys/world.js';
import { Ragdoll, HEAD, CHEST, HIP, FTL, FTR, HAL, KNL, ELL, SHL, HPL,
         B_UARML, B_THIGHL, B_SKULL, NP, NB } from '../src/phys/ragdoll.js';
import { makeRng } from '../src/core/util.js';

let fails = 0;
const ok = (n, c, e = '') => { console.log((c ? '  OK   ' : '  FALLA') + ' ' + n + (e ? '   ' + e : '')); if (!c) fails++; };
const sim = (w, rs, n) => { for (let i = 0; i < n; i++) { for (const r of rs) r.update(1 / 60); w.step(1 / 60); } };

// ── 1. se para solo ──────────────────────────────────────────────────────────
{
  const w = new PhysWorld();
  const r = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng: makeRng(1) });
  sim(w, [r], 180);
  console.log('  altura cabeza: ' + r.py(HEAD).toFixed(3) + '  pecho: ' + r.py(CHEST).toFixed(3) + '  cadera: ' + r.py(HIP).toFixed(3));
  ok('se para (cabeza arriba de 1.55)', r.py(HEAD) > 1.55, 'y=' + r.py(HEAD).toFixed(3));
  ok('el torso queda vertical', r.py(CHEST) - r.py(HIP) > 0.28, 'd=' + (r.py(CHEST) - r.py(HIP)).toFixed(3));
  ok('los pies en el piso', r.py(FTL) < 0.16 && r.py(FTR) < 0.16, r.py(FTL).toFixed(3) + ' / ' + r.py(FTR).toFixed(3));
  ok('no se va de lugar quieto', Math.hypot(r.x, r.z) < 0.35, 'd=' + Math.hypot(r.x, r.z).toFixed(3));
  ok('upright=true', r.upright);
  let nan = 0; for (let i = 0; i < NP; i++) if (Number.isNaN(r.px(i))) nan++;
  ok('sin NaN', nan === 0);
}

// ── 2. camina hacia donde se le pide ─────────────────────────────────────────
{
  const w = new PhysWorld();
  const r = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng: makeRng(7) });
  sim(w, [r], 90);
  const z0 = r.z;
  r.wantX = 0; r.wantZ = 1; r.wantSpeed = 1.4;
  sim(w, [r], 240);           // 4 segundos
  const adv = r.z - z0;
  console.log('  avanzo ' + adv.toFixed(2) + ' m en 4 s  → ' + (adv / 4).toFixed(2) + ' m/s  (pedido 1.4)');
  ok('camina hacia adelante', adv > 2.6, adv.toFixed(2) + ' m');
  ok('velocidad cerca de la pedida', Math.abs(adv / 4 - 1.4) < 0.55, (adv / 4).toFixed(2));
  ok('sigue de pie mientras camina', r.upright && r.py(HEAD) > 1.45, 'cabeza=' + r.py(HEAD).toFixed(3));
  ok('no se desvia de lado', Math.abs(r.x) < 1.0, 'x=' + r.x.toFixed(2));
  ok('la fase avanzo', r.phase !== 0);

  // gira y camina para el otro lado
  r.wantX = 1; r.wantZ = 0;
  const x0 = r.x;
  sim(w, [r], 240);
  ok('gira y camina en la nueva direccion', r.x - x0 > 2.2, 'dx=' + (r.x - x0).toFixed(2));
  ok('sigue parado tras girar', r.upright, 'dy=' + (r.py(CHEST) - r.py(HIP)).toFixed(3));
}

// ── 3. rodillas y codos doblan para el lado correcto ────────────────────────
{
  const w = new PhysWorld();
  const r = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng: makeRng(3) });
  r.wantX = 0; r.wantZ = 1; r.wantSpeed = 1.6;
  let kneeBad = 0, elbowBad = 0, samples = 0;
  for (let i = 0; i < 420; i++) {
    r.update(1 / 60); w.step(1 / 60);
    if (i < 120) continue;
    samples++;
    // rodilla: debe estar del lado +fwd respecto de la linea cadera-pie
    const mx = (r.px(HPL) + r.px(FTL)) / 2, my = (r.py(HPL) + r.py(FTL)) / 2, mz = (r.pz(HPL) + r.pz(FTL)) / 2;
    const p = (r.px(KNL) - mx) * r.fx + (r.py(KNL) - my) * r.fy + (r.pz(KNL) - mz) * r.fz;
    if (p < -0.05) kneeBad++;
    const ex = (r.px(SHL) + r.px(HAL)) / 2, ey = (r.py(SHL) + r.py(HAL)) / 2, ez = (r.pz(SHL) + r.pz(HAL)) / 2;
    const q = (r.px(ELL) - ex) * r.fx + (r.py(ELL) - ey) * r.fy + (r.pz(ELL) - ez) * r.fz;
    if (q > 0.05) elbowBad++;
  }
  ok('la rodilla nunca dobla al reves', kneeBad === 0, kneeBad + '/' + samples + ' frames malos');
  ok('el codo nunca dobla al reves', elbowBad === 0, elbowBad + '/' + samples + ' frames malos');
}

// ── 4. muerte = colapso total ────────────────────────────────────────────────
{
  const w = new PhysWorld();
  const r = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng: makeRng(11) });
  sim(w, [r], 150);
  const hBefore = r.py(HEAD);
  r.kill();
  sim(w, [r], 150);
  console.log('  cabeza antes ' + hBefore.toFixed(3) + ' → despues ' + r.py(HEAD).toFixed(3));
  ok('se desploma al morir', r.py(HEAD) < 0.55, 'y=' + r.py(HEAD).toFixed(3));
  ok('el pecho tambien cae', r.py(CHEST) < 0.5, 'y=' + r.py(CHEST).toFixed(3));
  ok('upright=false tirado', !r.upright);
  ok('el cuerpo no se desarma', Math.hypot(r.px(HEAD) - r.px(HIP), r.py(HEAD) - r.py(HIP), r.pz(HEAD) - r.pz(HIP)) < 1.0);
}

// ── 5. impacto → aturdimiento → recuperacion ────────────────────────────────
{
  const w = new PhysWorld();
  const r = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng: makeRng(13) });
  sim(w, [r], 150);
  const before = r.muscleGlobal;
  r.hit(2, 0.5, 40, [0, 0, 260]);       // escopetazo al torso
  r.update(1 / 60);
  ok('un impacto aturde', r.muscleGlobal < before * 0.9, 'musculo=' + r.muscleGlobal.toFixed(3));
  ok('el impulso lo empuja', w.vz[r.p[2]] > 3, 'vz=' + w.vz[r.p[2]].toFixed(2));
  // un impulso de ~9 m/s ahora lo TIRA (ragdoll siempre activo): tarda en levantarse
  sim(w, [r], 330);
  ok('se recupera del aturdimiento', r.stagger < 0.05 && r.muscleGlobal > 0.85, 'musculo=' + r.muscleGlobal.toFixed(3));
  ok('vuelve a pararse', r.py(HEAD) > 1.4, 'y=' + r.py(HEAD).toFixed(3));
}

// ── 6. desmembramiento ───────────────────────────────────────────────────────
{
  const w = new PhysWorld();
  const r = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng: makeRng(17) });
  sim(w, [r], 150);
  const bonesBefore = w.bn - (w.bDead);
  const at = r.sever(B_UARML);
  ok('sever devuelve la posicion del corte', at && typeof at.x === 'number');
  ok('el hueso queda muerto', r.boneAlive[B_UARML] === 0);
  ok('la mano cambia de grupo', w.pg[r.p[HAL]] !== r.group);
  ok('el musculo del brazo se anula', r.muscle[HAL] === 0 && r.muscle[ELL] === 0);
  sim(w, [r], 180);
  const armDist = Math.hypot(r.px(HAL) - r.px(SHL), r.py(HAL) - r.py(SHL), r.pz(HAL) - r.pz(SHL));
  ok('el brazo se separo del cuerpo', armDist > 0.75, 'd=' + armDist.toFixed(2));
  ok('el codo y la mano siguen unidos', Math.hypot(r.px(HAL) - r.px(ELL), r.py(HAL) - r.py(ELL), r.pz(HAL) - r.pz(ELL)) < 0.45);
  ok('el cuerpo sigue de pie sin un brazo', r.py(HEAD) > 1.45, 'y=' + r.py(HEAD).toFixed(3));
  void bonesBefore;
}

// ── 7. perder una pierna → se arrastra ───────────────────────────────────────
{
  const w = new PhysWorld();
  const r = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng: makeRng(19) });
  sim(w, [r], 150);
  r.sever(B_THIGHL);
  ok('pasa a modo arrastre', r.crawling);
  r.wantX = 0; r.wantZ = 1; r.wantSpeed = 1.0;
  const z0 = r.z;
  sim(w, [r], 300);
  ok('se arrastra pegado al piso', r.py(CHEST) < 0.75, 'pecho=' + r.py(CHEST).toFixed(3));
  ok('igual avanza arrastrandose', r.z - z0 > 0.6, 'dz=' + (r.z - z0).toFixed(2));
}

// ── 8. tiro en la cabeza = muerte instantanea ───────────────────────────────
{
  const w = new PhysWorld();
  const r = new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng: makeRng(23) });
  sim(w, [r], 150);
  const res = r.hit(B_SKULL, 0.5, 200, [0, 0, 90]);
  ok('el craneo cuenta como zona 0', res.zone === 0);
  ok('multiplicador de cabeza x4', Math.abs(res.damage - 800) < 1, 'dmg=' + res.damage);
  ok('se corta el craneo', res.severed);
  ok('muere al instante', r.dead);
  sim(w, [r], 120);
  ok('la cabeza sale del cuerpo', Math.hypot(r.px(HEAD) - r.px(CHEST), r.pz(HEAD) - r.pz(CHEST)) > 0.35,
     'd=' + Math.hypot(r.px(HEAD) - r.px(CHEST), r.pz(HEAD) - r.pz(CHEST)).toFixed(2));
}

// ── 9. explosion manda cuerpos por el aire ──────────────────────────────────
{
  const w = new PhysWorld();
  const rs = [];
  for (let i = 0; i < 6; i++) rs.push(new Ragdoll(w, { x: -2 + i * 0.8, z: 0, yaw: 0, rng: makeRng(100 + i) }));
  sim(w, rs, 150);
  const y0 = rs[0].py(CHEST);
  for (const r of rs) r.kill();
  w.explode(0, 0.5, 0, 6, 900);
  sim(w, rs, 25);
  let maxY = 0; for (const r of rs) maxY = Math.max(maxY, r.py(CHEST));
  ok('los cuerpos vuelan', maxY > y0 + 0.6, 'maxY=' + maxY.toFixed(2) + ' vs ' + y0.toFixed(2));
  sim(w, rs, 250);
  let nan = 0; for (const r of rs) for (let i = 0; i < NP; i++) if (Number.isNaN(r.px(i))) nan++;
  ok('nada exploto en NaN', nan === 0);
}

// ── 10. dispose limpia todo ──────────────────────────────────────────────────
{
  const w = new PhysWorld();
  const r = new Ragdoll(w, { rng: makeRng(31) });
  sim(w, [r], 30);
  const bodiesBefore = w.bodies.length, freeBefore = w.pFree.length;
  r.dispose();
  ok('se saca de la lista de cuerpos', w.bodies.length === bodiesBefore - 1);
  ok('devuelve sus 16 particulas', w.pFree.length === freeBefore + NP, '+' + (w.pFree.length - freeBefore));
  ok('sus huesos quedan muertos', r.boneAlive.every(v => v === 0));
  w.step(1 / 60);
  ok('el mundo sigue andando sin el', true);
}

// ── 11. multitud: rendimiento y que no se atraviesen ────────────────────────
{
  const w = new PhysWorld();
  w.groundHX = 30; w.groundHZ = 30;
  // un lugarcito con obstaculos, como un nivel real
  for (let i = 0; i < 40; i++) w.addBox((i % 8) * 6 - 21, 1, ((i / 8) | 0) * 6 - 15, 1.2, 1, 1.2, i * 0.3);
  for (let i = 0; i < 12; i++) w.addCylinder((i % 4) * 8 - 12, ((i / 4) | 0) * 8 - 8, 0.35, 0, 4);
  w.buildStaticIndex();
  const rs = [];
  const rng = makeRng(999);
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2, rad = 8 + (i % 5) * 1.4;
    rs.push(new Ragdoll(w, { x: Math.cos(a) * rad, z: Math.sin(a) * rad, yaw: a + Math.PI, rng: makeRng(i * 77 + 5) }));
  }
  // todos caminan al centro: se apilan, se empujan
  for (const r of rs) { const d = Math.hypot(r.x, r.z) || 1; r.wantX = -r.x / d; r.wantZ = -r.z / d; r.wantSpeed = 1.5; }
  for (let i = 0; i < 60; i++) { for (const r of rs) r.update(1 / 60); w.step(1 / 60); }

  const t0 = performance.now();
  const N = 180;
  for (let i = 0; i < N; i++) {
    for (const r of rs) {
      const d = Math.hypot(r.x, r.z) || 1;
      r.wantX = -r.x / d; r.wantZ = -r.z / d; r.wantSpeed = 1.5;
      r.update(1 / 60);
    }
    w.step(1 / 60);
  }
  const ms = (performance.now() - t0) / N;
  console.log('');
  console.log('  40 zombis + 40 cajas + 12 cilindros: ' + ms.toFixed(2) + ' ms/frame');
  console.log('  ' + w.stats.particles + ' particulas, ' + w.stats.constraints + ' restricciones, ' + w.stats.bones + ' huesos, ' + w.stats.pairs + ' pares');
  ok('la multitud entra en presupuesto', ms < 9.5, ms.toFixed(2) + ' ms');

  let standing = 0, nan = 0;
  for (const r of rs) { if (r.upright) standing++; for (let i = 0; i < NP; i++) if (Number.isNaN(r.px(i))) nan++; }
  console.log('  siguen de pie: ' + standing + '/40');
  ok('la mayoria sigue de pie tras apilarse', standing >= 32, standing + '/40');
  ok('nadie exploto', nan === 0, nan + ' NaN');

  // se apilan sin ocupar el mismo lugar
  let tooClose = 0;
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    if (Math.hypot(rs[i].x - rs[j].x, rs[i].z - rs[j].z) < 0.16) tooClose++;
  }
  ok('no se atraviesan entre si', tooClose === 0, tooClose + ' pares encimados');
}

console.log('');
console.log(fails === 0 ? 'TODO VERDE' : (fails + ' PRUEBAS FALLARON'));
process.exit(fails ? 1 : 0);
