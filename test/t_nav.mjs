// Pruebas del campo de flujo: pared con un vano, zonas cerradas, rendimiento.
import { PhysWorld } from '../src/phys/world.js';
import { NavGrid } from '../src/game/nav.js';
import { makeRng } from '../src/core/util.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${name}   ${extra}`);
  if (!cond) fails++;
};

// ── nivel de prueba: losa 20x20, pared a lo largo de X en z=0 con un vano en x∈[-1,1]
const w = new PhysWorld();
w.groundHX = 10; w.groundHZ = 10;
w.addBox(-5.5, 1.2, 0, 4.5, 1.2, 0.15);   // x ∈ [-10, -1]
w.addBox(5.5, 1.2, 0, 4.5, 1.2, 0.15);    // x ∈ [1, 10]
w.addBox(6, 0.01, 5, 1.5, 0.01, 1.5);     // alfombra: se pisa
w.addCylinder(-6, 5, 0.3, 0, 1.0);        // una silla
// cuarto cerrado en la esquina: x∈[6,9], z∈[6,9]
w.addBox(7.5, 1, 6, 1.5, 1, 0.1); w.addBox(7.5, 1, 9, 1.5, 1, 0.1);
w.addBox(6, 1, 7.5, 0.1, 1, 1.5); w.addBox(9, 1, 7.5, 0.1, 1, 1.5);
w.buildStaticIndex();

const nav = new NavGrid(w, { cell: 0.4, margin: 0.3 });
console.log(`  grilla ${nav.W}x${nav.D}, transitables ${nav.walkableCount}`);

ok('la pared bloquea', !nav.walkable(-5, 0));
ok('el vano queda libre', nav.walkable(0, 0));
ok('la alfombra se pisa', nav.walkable(6, 5));
ok('la silla bloquea', !nav.walkable(-6, 5));
ok('el borde de la losa bloquea', !nav.walkable(-9.9, 0));

// ── flujo hacia un objetivo al sur de la pared
const t0 = performance.now();
ok('computeFlow devuelve true', nav.computeFlow(-4, -6));
const msFlow = performance.now() - t0;

ok('el objetivo tiene distancia 0', nav.distAt(-4, -6) < 0.6, nav.distAt(-4, -6).toFixed(2));
const dNorth = nav.distAt(-4, 6);
ok('un punto del otro lado es alcanzable', dNorth < Infinity, dNorth.toFixed(2));
// línea recta sería 12 m; por el vano en x=0: (-4,6)→(0,0)→(-4,-6) ≈ 14.4
ok('la distancia rodea la pared (no la atraviesa)', dNorth > 13.5 && dNorth < 17, dNorth.toFixed(2));

const dir = { x: 0, z: 0 };
nav.dirAt(-4, 6, dir);
ok('desde el norte, el flujo apunta hacia el vano (x crece, z baja)', dir.x > 0.3 && dir.z < 0, `${dir.x.toFixed(2)},${dir.z.toFixed(2)}`);

// ── seguir el flujo desde (-7, 8) hasta llegar, sin pisar celdas bloqueadas
let x = -7, z = 8, steps = 0, blocked = 0, arrived = false;
for (; steps < 800; steps++) {
  if (!nav.dirAt(x, z, dir)) break;
  if (dir.x === 0 && dir.z === 0) { arrived = true; break; }
  x += dir.x * 0.1; z += dir.z * 0.1;
  if (!nav.walkable(x, z)) blocked++;
  if (Math.hypot(x + 4, z + 6) < 0.5) { arrived = true; break; }
}
ok('siguiendo el flujo se llega al objetivo', arrived, `${steps} pasos, fin (${x.toFixed(1)},${z.toFixed(1)})`);
ok('nunca pisa una celda bloqueada', blocked === 0, `${blocked} pisadas`);
ok('cruzó por el vano (pasó cerca de x=0,z=0)', arrived);

// ── cuarto cerrado: sin camino
ok('el cuarto cerrado no es alcanzable', !nav.reachable(7.5, 7.5));
ok('dirAt en el cuarto cerrado devuelve false', !nav.dirAt(7.5, 7.5, dir));

// ── nearestWalkable y randomReachable
const rng = makeRng(7);
const ni = nav.nearestWalkable(-5, 0);
ok('nearestWalkable sale de la pared', ni >= 0 && nav.walk[ni] === 1);
const rp = nav.randomReachable(rng, -4, -6, 2, 5);
ok('randomReachable da un punto con camino', rp && nav.reachable(rp.x, rp.z));

// ── objetivo adentro de una pared: se usa la celda libre más cercana
ok('computeFlow con objetivo en la pared no falla', nav.computeFlow(-5, 0));
ok('… y el resto del mapa igual llega', nav.reachable(-4, -6));

// ── rendimiento en un nivel del tamaño real (44 x 30 m) con 300 estáticos
const big = new PhysWorld();
big.groundHX = 22; big.groundHZ = 15;
const R = makeRng(3);
for (let i = 0; i < 300; i++) {
  big.addBox(R.range(-20, 20), 0.5, R.range(-13, 13), R.range(0.2, 1.2), 0.5, R.range(0.2, 1.2), R() * 6.28);
}
big.buildStaticIndex();
const t1 = performance.now();
const bnav = new NavGrid(big, { cell: 0.4 });
const msBuild = performance.now() - t1;
const t2 = performance.now();
let n = 0;
for (let i = 0; i < 20; i++) { bnav.computeFlow(R.range(-20, 20), R.range(-13, 13)); n++; }
const msBig = (performance.now() - t2) / n;
console.log(`  nivel grande: ${bnav.W}x${bnav.D} = ${bnav.N} celdas · build ${msBuild.toFixed(2)} ms · flujo ${msBig.toFixed(2)} ms`);
ok('el flujo del nivel grande es barato (< 6 ms)', msBig < 6, msBig.toFixed(2) + ' ms');
ok('construir la grilla es barato (< 60 ms)', msBuild < 60, msBuild.toFixed(2) + ' ms');
console.log(`  flujo chico: ${msFlow.toFixed(2)} ms`);

console.log(fails ? `\n${fails} PRUEBAS FALLARON` : '\nTODO VERDE');
process.exit(fails ? 1 : 0);
