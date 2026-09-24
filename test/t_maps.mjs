// Pruebas de los lugarcitos: cada mapa del registro se construye en Node (sin
// canvas: materiales de mentira), se rasteriza su grilla de navegación y se
// verifica que sea jugable: spawns con nombre y alcanzables, puntos de misión
// transitables, presupuestos de dibujo/luces/estáticos y conectividad total.
import { register } from 'node:module';
register('./_three_hooks.mjs', import.meta.url);

const THREE = await import('three');
const { PhysWorld } = await import('../src/phys/world.js');
const { NavGrid } = await import('../src/game/nav.js');
const { makeRng } = await import('../src/core/util.js');
const { LevelBuilder } = await import('../src/game/level.js');
const { MAPS, MAP_ORDER, getMap } = await import('../src/game/maps.js');

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${name}   ${extra}`);
  if (!cond) fails++;
};
const f1 = (v) => v.toFixed(1);

// en Node no hay canvas: texturas y materiales de mentira
const mats = {
  tex: new Proxy({}, { get: () => ({ userData: { meters: 1 } }) }),
  mat: new Proxy({}, { get: () => new THREE.MeshBasicMaterial() }),
};

ok('el registro tiene los cinco mapas', MAP_ORDER.length === 5 && MAP_ORDER.every(id => MAPS[id] && MAPS[id].id === id), MAP_ORDER.join(', '));
ok('getMap cae en la oficina si el id no existe', getMap('nada') === MAPS.office && getMap('subte') === MAPS.subte);
ok('las semillas son distintas', new Set(MAP_ORDER.map(id => MAPS[id].seed)).size === MAP_ORDER.length);

const resumen = [];
for (const id of MAP_ORDER) {
  const map = MAPS[id];
  console.log(`\n── ${id} · ${map.name}`);
  ok('name, sub y textos en su lugar', typeof map.name === 'string' && map.name.length > 3 && typeof map.sub === 'string' && map.sub.length > 3
    && map.texts && typeof map.texts.start === 'string' && typeof map.texts.death === 'string' && map.texts.start.length > 5 && map.texts.death.length > 5);
  ok('mood y nav presentes', map.mood && typeof map.mood.background === 'number' && map.nav && map.nav.cell > 0 && map.nav.margin > 0);
  ok('build es una función', typeof map.build === 'function');
  ok('menuZombies razonable', Number.isInteger(map.menuZombies) && map.menuZombies >= 8 && map.menuZombies <= 40, String(map.menuZombies));

  // ── construir ──────────────────────────────────────────────────────────────
  const w = new PhysWorld();
  const scene = new THREE.Scene();
  const t0 = performance.now();
  const L = new LevelBuilder(scene, w, mats, makeRng(map.seed));
  map.build(L);
  const msBuild = performance.now() - t0;
  ok('construye rápido (< 200 ms)', msBuild < 200, f1(msBuild) + ' ms');
  const statics = w.boxes.length + w.cyls.length;
  ok('la losa entra en el presupuesto (hx ≤ 26, hz ≤ 18)', w.groundHX <= 26 && w.groundHZ <= 18, `${w.groundHX} x ${w.groundHZ}`);
  ok('sin NaN en los estáticos', w.boxes.every(B => [B.cx, B.cy, B.cz, B.hx, B.hy, B.hz, B.c, B.s].every(Number.isFinite))
    && w.cyls.every(C => [C.cx, C.cz, C.r, C.y0, C.y1].every(Number.isFinite)));
  ok('estáticos ≤ 420', statics <= 420, String(statics));
  ok('mallas del grupo ≤ 260', L.group.children.length <= 260, String(L.group.children.length));
  // la oficina ya venía con 19 (lámparas de escritorio al azar); los lugares nuevos entran en 14
  const maxLights = id === 'office' ? 19 : 14;
  ok(`luces puntuales ≤ ${maxLights}`, L.lights.length <= maxLights, String(L.lights.length));

  // ── navegación ─────────────────────────────────────────────────────────────
  const t1 = performance.now();
  const nav = new NavGrid(w, map.nav);
  const msGrid = performance.now() - t1;
  // el flujo se mide caliente: la primera corrida paga la compilación del JIT
  let flowOk = true, msFlow = Infinity;
  for (let k = 0; k < 8; k++) {
    const t2 = performance.now();
    flowOk = nav.computeFlow(L.playerStart.x, L.playerStart.z) && flowOk;
    msFlow = Math.min(msFlow, performance.now() - t2);
  }
  const walkPct = nav.walkableCount / nav.N * 100;
  ok('celdas ≤ 12.000', nav.N <= 12000, `${nav.W}x${nav.D} = ${nav.N}`);
  ok('transitables entre 25% y 75%', walkPct >= 25 && walkPct <= 75, f1(walkPct) + '%');
  ok('flujo < 8 ms', msFlow < 8, f1(msFlow) + ' ms');
  ok('computeFlow desde el playerStart', flowOk);
  ok('playerStart transitable', nav.walkable(L.playerStart.x, L.playerStart.z), `(${L.playerStart.x}, ${L.playerStart.z})`);

  // conectividad total: casi todas las celdas transitables se alcanzan desde el jugador
  let reach = 0;
  for (let i = 0; i < nav.N; i++) if (nav.walk[i] && nav.dist[i] < Infinity) reach++;
  const reachPct = reach / nav.walkableCount * 100;
  ok('conectividad ≥ 85% de las celdas transitables', reachPct >= 85, f1(reachPct) + '%');

  // ── spawns ─────────────────────────────────────────────────────────────────
  const S = L.spawns;
  ok('entre 3 y 5 spawns', S.length >= 3 && S.length <= 5, String(S.length));
  ok('nombres de spawn no vacíos y únicos', S.every(s => typeof s.name === 'string' && s.name.length > 0) && new Set(S.map(s => s.name)).size === S.length,
    S.map(s => s.name).join(' · '));
  const spawnReach = (s) => {
    if (nav.reachable(s.x, s.z)) return true;
    const i = nav.nearestWalkable(s.x, s.z, 3);
    return i >= 0 && Math.hypot(nav.cx(i) - s.x, nav.cz(i) - s.z) <= 1.0 && nav.dist[i] < Infinity;
  };
  for (const s of S) {
    const d = Math.hypot(s.x - L.playerStart.x, s.z - L.playerStart.z);
    ok(`spawn "${s.name}" alcanzable y lejos del jugador`, spawnReach(s) && d > 8 && Number.isFinite(s.yaw), `(${s.x}, ${s.z}) · ${f1(d)} m`);
    const edge = Math.min(w.groundHX - Math.abs(s.x), w.groundHZ - Math.abs(s.z));
    ok(`spawn "${s.name}" a ≥ 0.8 m del borde de la losa`, edge >= 0.8, f1(edge) + ' m');
  }

  // ── puntos de misión ───────────────────────────────────────────────────────
  const P = L.points || {};
  const objs = Object.keys(P).filter(k => /^obj\d+$/.test(k)).sort();
  ok('existe el punto exit, transitable y alcanzable', P.exit && nav.walkable(P.exit.x, P.exit.z) && nav.reachable(P.exit.x, P.exit.z),
    P.exit ? `(${P.exit.x}, ${P.exit.z})` : 'falta');
  ok('entre 4 y 6 objetivos', objs.length >= 4 && objs.length <= 6, objs.join(', '));
  let far = 0;
  for (const k of objs) {
    const p = P[k];
    const d = Math.hypot(p.x - L.playerStart.x, p.z - L.playerStart.z);
    if (d > 12) far++;
    ok(`${k} transitable y alcanzable`, nav.walkable(p.x, p.z) && nav.reachable(p.x, p.z), `(${p.x}, ${p.z}) · ${f1(d)} m del jugador`);
  }
  ok('varios objetivos a más de 12 m del jugador', far >= 2, `${far} lejanos`);
  let minPair = Infinity;
  for (let i = 0; i < objs.length; i++) for (let j = i + 1; j < objs.length; j++) {
    const a = P[objs[i]], b = P[objs[j]];
    minPair = Math.min(minPair, Math.hypot(a.x - b.x, a.z - b.z));
  }
  ok('objetivos a más de 8 m entre sí', minPair > 8, f1(minPair) + ' m');
  ok('el exit y los objetivos se pueden recorrer con el flujo', objs.every(k => nav.distAt(P[k].x, P[k].z) < 90), objs.map(k => f1(nav.distAt(P[k].x, P[k].z))).join(' '));

  resumen.push({ id, slab: `${w.groundHX}x${w.groundHZ}`, spawns: S.length, objs: objs.length, cells: nav.N, walk: f1(walkPct) + '%', reach: f1(reachPct) + '%',
    children: L.group.children.length, lights: L.lights.length, statics, build: f1(msBuild), grid: f1(msGrid), flow: f1(msFlow) });
}

console.log('\n  mapa      losa    spawns obj  celdas  transit  conect  mallas luces estát  build   grilla  flujo');
for (const r of resumen) {
  console.log(`  ${r.id.padEnd(9)} ${r.slab.padEnd(7)} ${String(r.spawns).padEnd(6)} ${String(r.objs).padEnd(4)} ${String(r.cells).padEnd(7)} ${r.walk.padEnd(8)} ${r.reach.padEnd(7)} ${String(r.children).padEnd(6)} ${String(r.lights).padEnd(5)} ${String(r.statics).padEnd(5)} ${(r.build + ' ms').padEnd(7)} ${(r.grid + ' ms').padEnd(7)} ${r.flow} ms`);
}

console.log(fails ? `\n${fails} PRUEBAS FALLARON` : '\nTODO VERDE');
process.exit(fails ? 1 : 0);
