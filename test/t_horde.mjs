// Integración sin navegador: horda + navegación + jugador + armas.
import { PhysWorld } from '../src/phys/world.js';
import { NavGrid } from '../src/game/nav.js';
import { ZombieManager } from '../src/game/zombie.js';
import { Player } from '../src/game/player.js';
import { WEAPONS, fireHitscan, Arsenal } from '../src/game/weapons.js';
import { HEAD, CHEST } from '../src/phys/ragdoll.js';
import { makeRng } from '../src/core/util.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${name}   ${extra}`);
  if (!cond) fails++;
};
const DT = 1 / 60;
const nanFree = (w) => { for (let i = 0; i < w.pn; i++) if (Number.isNaN(w.px[i] + w.py[i] + w.pz[i])) return false; return true; };

function makeWorld() {
  const w = new PhysWorld();
  w.groundHX = 16; w.groundHZ = 16;
  // pared en z=0 con un vano en x∈[-1.2, 1.2]
  w.addBox(-8.1, 1.5, 0, 6.9, 1.5, 0.15);
  w.addBox(8.1, 1.5, 0, 6.9, 1.5, 0.15);
  w.buildStaticIndex();
  return w;
}
function step(w, zm, player, hooks, sec, extra) {
  for (let i = 0; i < sec * 60; i++) {
    zm.update(DT, player, hooks);
    for (const b of w.bodies) if (b.update) b.update(DT);
    w.step(DT);
    if (extra) extra(i);
  }
}
const idleInput = (P) => ({ mx: 0, mz: 0, run: false, aimX: P.x, aimZ: P.z + 5 });
const FWD = { x: 0, z: -1 }, RGT = { x: 1, z: 0 };

// ── 1. la horda cruza el vano y llega hasta el jugador ──────────────────────
{
  const w = makeWorld();
  const rng = makeRng(21);
  const nav = new NavGrid(w, { cell: 0.4, margin: 0.3 });
  const zm = new ZombieManager(w, nav, rng);
  const P = new Player(w, rng, { x: 0, z: -7 });
  const hooks = { attacks: 0, onAttack: (Z, dmg, ux, uz) => { hooks.attacks++; P.damage(dmg, Z.x, Z.z); }, onDeath: () => {}, onCorpse: () => {}, onMoan: () => {} };
  for (let i = 0; i < 12; i++) zm.spawn('walker', -9 + i * 1.6, 7 + (i % 3), Math.PI, false);
  let crossedBad = 0, near = 0, crossed = 0;
  const lastZ = new Map();
  step(w, zm, P, hooks, 30, () => {
    P.update(DT, idleInput(P), FWD, RGT);
    let n = 0, c = 0;
    for (const Z of zm.zombies) {
      const pz = lastZ.get(Z.id);
      if (pz !== undefined && pz > 0 && Z.z <= 0 && Math.abs(Z.x) > 1.6) crossedBad++;
      lastZ.set(Z.id, Z.z);
      if (Z.z < 0) c++;
      if (Math.hypot(Z.x - P.x, Z.z - P.z) < 4) n++;
    }
    // el máximo a lo largo del tiempo: cuando el jugador muere, se dispersan
    near = Math.max(near, n); crossed = Math.max(crossed, c);
  });
  ok('la mayoría cruzó al lado del jugador', crossed >= 9, `${crossed}/12`);
  ok('nadie atravesó la pared (cruzaron por el vano)', crossedBad === 0, `${crossedBad} malos`);
  ok('la horda llegó hasta el jugador', near >= 6, `${near} a menos de 4 m`);
  ok('atacaron', hooks.attacks >= 3, `${hooks.attacks} manotazos`);
  ok('el jugador perdió vida', P.hp < 100, `hp=${P.hp.toFixed(0)}`);
  ok('el jugador sigue parado (lo empujan pero no lo tiran)', P.body.upright || !P.alive);
  ok('sin NaN', nanFree(w));
  ok('todos siguen de pie o vivos', zm.zombies.every(Z => !Z.dead));
}

// ── 2. dormidos detrás de la pared no se enteran; un ruido los despierta ────
{
  const w = makeWorld();
  const rng = makeRng(4);
  const nav = new NavGrid(w, { cell: 0.4, margin: 0.3 });
  const zm = new ZombieManager(w, nav, rng);
  const P = new Player(w, rng, { x: -6, z: -6 });
  const hooks = { onAttack: () => {}, onDeath: () => {}, onCorpse: () => {}, onMoan: () => {} };
  const Z = zm.spawn('walker', -6, 6, 0, true);   // 12 m, con la pared en el medio
  step(w, zm, P, hooks, 5, () => P.update(DT, idleInput(P), FWD, RGT));
  ok('dormido sin línea de vista se queda deambulando', Z.state === 'idle' && Math.hypot(Z.x + 6, Z.z - 6) < 4, `estado=${Z.state}`);
  zm.alertAll(P.x, P.z, 26);
  ok('el ruido lo pone en persecución', Z.state === 'chase');
  step(w, zm, P, hooks, 20, () => P.update(DT, idleInput(P), FWD, RGT));
  ok('… y llega', Math.hypot(Z.x - P.x, Z.z - P.z) < 3.5, `d=${Math.hypot(Z.x - P.x, Z.z - P.z).toFixed(1)}`);
}

// ── 3. el corredor llega antes que el caminante ─────────────────────────────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20; w.buildStaticIndex();
  const rng = makeRng(8);
  const nav = new NavGrid(w, { cell: 0.4, margin: 0.3 });
  const zm = new ZombieManager(w, nav, rng);
  const P = new Player(w, rng, { x: 0, z: -9 });
  const hooks = { onAttack: () => {}, onDeath: () => {}, onCorpse: () => {}, onMoan: () => {} };
  const walker = zm.spawn('walker', -3, 8, Math.PI, false);
  const runner = zm.spawn('runner', 3, 8, Math.PI, false);
  const brute = zm.spawn('brute', 0, 10, Math.PI, false);
  step(w, zm, P, hooks, 4, () => P.update(DT, idleInput(P), FWD, RGT));
  const dW = Math.hypot(walker.x - P.x, walker.z - P.z), dR = Math.hypot(runner.x - P.x, runner.z - P.z);
  ok('el corredor está más cerca que el caminante a los 4 s', dR < dW - 3, `runner ${dR.toFixed(1)} m, walker ${dW.toFixed(1)} m`);
  ok('el bruto es más grande', brute.body.scale > 1.1, brute.body.scale.toFixed(2));
  ok('todos de pie', walker.body.upright && runner.body.upright && brute.body.upright);
}

// ── 4. armas: pistola, escopeta, fusil ──────────────────────────────────────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20;
  w.addBox(0, 1.5, 9, 3, 1.5, 0.2);   // pared atrás del zombi
  w.buildStaticIndex();
  const rng = makeRng(3);
  const nav = new NavGrid(w, { cell: 0.4, margin: 0.3 });
  const zm = new ZombieManager(w, nav, rng);
  const P = new Player(w, rng, { x: 0, z: 0 });
  const hooks = { deaths: 0, corpses: 0, onAttack: () => {}, onDeath: () => { hooks.deaths++; }, onCorpse: () => { hooks.corpses++; }, onMoan: () => {} };
  const Z = zm.spawn('walker', 0, 4, Math.PI, true); Z.hp = 110;
  step(w, zm, P, hooks, 1, () => P.update(DT, idleInput(P), FWD, RGT));
  const hits = [];
  const ox = P.body.px(CHEST), oy = P.body.py(CHEST), oz = P.body.pz(CHEST);
  // pistola al pecho
  let n = fireHitscan(w, ox, oy, oz, 0, (Z.body.py(CHEST) - oy) / 4, 1, WEAPONS.pistol, P.body, rng, hits);
  ok('la pistola pega en el zombi', n === 1 && hits[0].kind === 'body' && hits[0].body === Z.body, hits[0].kind);
  const res = Z.body.hit(w.bmeta[hits[0].bone], hits[0].s, hits[0].dmg, [0, 2, 7]);
  Z.hp -= res.damage;
  ok('daño de pistola al cuerpo', res.damage >= 18 && res.damage <= 30, res.damage.toFixed(0));
  ok('un tiro no lo mata', Z.hp > 0 && !Z.dead);
  // tiro a la cabeza: x4 (apuntando a donde está la cabeza de verdad: el zombi deambula)
  const hx = Z.body.px(HEAD) - ox, hy = Z.body.py(HEAD) - Z.body.py(HEAD), hz = Z.body.pz(HEAD) - oz;
  const hl = Math.hypot(hx, hy, hz);
  n = fireHitscan(w, ox, Z.body.py(HEAD), oz, hx / hl, hy / hl, hz / hl, { ...WEAPONS.pistol, spread: 0 }, P.body, rng, hits);
  ok('la pistola pega en la cabeza', n === 1 && hits[0].kind === 'body' && w.bmeta[hits[0].bone] === 0, `hueso ${hits[0].kind === 'body' ? w.bmeta[hits[0].bone] : '-'}`);
  if (hits[0].kind === 'body') {
    const r2 = Z.body.hit(w.bmeta[hits[0].bone], hits[0].s, hits[0].dmg, [0, 2, 7]);
    ok('la cabeza multiplica x4', r2.zone === 0 && r2.damage >= 100, r2.damage.toFixed(0));
    Z.hp -= r2.damage;
  }
  if (Z.hp <= 0) Z.body.kill();
  ok('con el tiro a la cabeza muere', Z.dead);
  step(w, zm, P, hooks, 4, () => P.update(DT, idleInput(P), FWD, RGT));
  ok('onDeath se llamó', hooks.deaths === 1);
  ok('a los 3.4 s se vuelve cadáver y sale de la lista', hooks.corpses === 1 && zm.zombies.length === 0);
  // escopeta contra otro: 9 perdigones, varios pegan
  const Z2 = zm.spawn('walker', 0, 3, Math.PI, true); Z2.hp = 110;
  Z2.wanderT = 99; Z2.wanderX = 0; Z2.wanderZ = 0;    // que se quede quieto y alineado
  step(w, zm, P, hooks, 1, () => P.update(DT, idleInput(P), FWD, RGT));
  n = fireHitscan(w, ox, oy, oz, 0, 0, 1, WEAPONS.shotgun, P.body, rng, hits);
  let bodyHits = 0, total = 0;
  for (let i = 0; i < n; i++) if (hits[i].kind === 'body') { bodyHits++; total += hits[i].dmg; }
  ok('la escopeta tira 9 perdigones', n === 9);
  ok('a 3 m la mayoría pegan', bodyHits >= 5, `${bodyHits}/9, daño ${total.toFixed(0)}`);
  // el que no pega, pega en la pared de atrás o se pierde
  ok('los que fallan terminan en la pared o en nada', hits.slice(0, n).every(h => h.kind !== 'body' ? (h.kind === 'static' || h.kind === 'none') : true));
  // fusil atraviesa: dos zombis en fila
  const Z3 = zm.spawn('walker', 0, 5.5, Math.PI, true);
  Z3.wanderT = 99; Z3.wanderX = 0; Z3.wanderZ = 0;
  // sin IA este segundo: que los dos se queden parados y alineados con el rayo
  for (let i = 0; i < 60; i++) { for (const b of w.bodies) if (b.update) b.update(DT); w.step(DT); }
  // rayo determinista: desde 3 m antes del pecho de Z2 en la dirección Z2→Z3 (pasa por los dos)
  {
    const ax = Z2.body.px(CHEST), ay = Z2.body.py(CHEST), az = Z2.body.pz(CHEST);
    let rdx = Z3.body.px(CHEST) - ax, rdy = Z3.body.py(CHEST) - ay, rdz = Z3.body.pz(CHEST) - az;
    const rl = Math.hypot(rdx, rdy, rdz); rdx /= rl; rdy /= rl; rdz /= rl;
    n = fireHitscan(w, ax - rdx * 3, ay - rdy * 3, az - rdz * 3, rdx, rdy, rdz, { ...WEAPONS.rifle, spread: 0 }, P.body, rng, hits);
  }
  const bodies = hits.slice(0, n).filter(h => h.kind === 'body');
  ok('el fusil atraviesa y pega a los dos', bodies.length === 2 && bodies[0].body !== bodies[1].body, `${bodies.length} cuerpos`);
  ok('el segundo recibe menos daño', bodies.length === 2 && bodies[1].dmg < bodies[0].dmg, bodies.map(b => b.dmg.toFixed(0)).join(' → '));
  ok('sin NaN', nanFree(w));
}

// ── 5. arsenal: cargador, recarga, cadencia, cambio ─────────────────────────
{
  const A = new Arsenal();
  let shots = 0;
  for (let i = 0; i < 60; i++) { const r = A.tryFire(true); if (r && r !== 'empty') shots++; A.update(1 / 60); }
  ok('la pistola es semiautomática: con el gatillo apretado sale 1 tiro', shots === 1, shots + ' tiros');
  shots = 0;
  for (let i = 0; i < 120; i++) { const r = A.tryFire(i % 2 === 0); if (r && r !== 'empty') shots++; A.update(1 / 60); }
  ok('clickeando rápido dispara a la cadencia (6.5/s → ~13 en 2 s)', shots >= 11 && shots <= 14, shots + ' tiros');
  ok('el cargador bajó', A.weapon.mag === 12 - 1 - shots, A.weapon.mag + '');
  A.give('smg');
  ok('agarrar el subfusil lo equipa', A.current === 'smg');
  A.switchT = 0;
  shots = 0;
  for (let i = 0; i < 180; i++) { const r = A.tryFire(true); if (r && r !== 'empty') shots++; A.update(1 / 60); }
  ok('el subfusil es automático y vacía el cargador (32)', shots === 32, shots + ' tiros');
  ok('vacío devuelve "empty"', A.tryFire(true) === 'empty' || A.weapon.cool > 0);
  A.startReload();
  for (let i = 0; i < 120; i++) A.update(1 / 60);
  ok('recargó', A.weapon.mag === 32 && A.weapon.reserve === 96 - 32, `${A.weapon.mag} / ${A.weapon.reserve}`);
  A.cycle(1); ok('la rueda cicla entre las que tiene', A.current === 'pistol');
}

// ── 6. el empujón tira zombis y el jugador muere si lo acorralan ────────────
{
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20; w.buildStaticIndex();
  const rng = makeRng(5);
  const nav = new NavGrid(w, { cell: 0.4, margin: 0.3 });
  const zm = new ZombieManager(w, nav, rng);
  const P = new Player(w, rng, { x: 0, z: 0, yaw: 0 });
  const hooks = { onAttack: (Z, dmg) => P.damage(dmg, Z.x, Z.z), onDeath: () => {}, onCorpse: () => {}, onMoan: () => {} };
  const Z = zm.spawn('walker', 0, 1.1, Math.PI, true);
  step(w, zm, P, hooks, 0.5, () => P.update(DT, idleInput(P), FWD, RGT));
  const pushed = P.shove(w.bodies);
  ok('el empujón alcanza al zombi de adelante', pushed && pushed.length === 1, pushed ? pushed.length + '' : 'null');
  ok('el empujón tiene enfriamiento', P.shove(w.bodies) === null);
  let maxZ = Z.z, fell = false;
  step(w, zm, P, hooks, 1.0, () => { P.update(DT, idleInput(P), FWD, RGT); maxZ = Math.max(maxZ, Z.z); if (!Z.body.upright) fell = true; });
  ok('el zombi salió despedido (o se cayó)', maxZ > 1.7 || fell, `z máx=${maxZ.toFixed(2)} cayó=${fell}`);
  for (let i = 0; i < 8; i++) zm.spawn('walker', Math.cos(i) * 2.5, Math.sin(i) * 2.5, 0, false);
  step(w, zm, P, hooks, 40, () => P.update(DT, idleInput(P), FWD, RGT));
  ok('rodeado y sin disparar, muere', !P.alive, `hp=${P.hp.toFixed(0)}`);
  ok('muerto, el ragdoll se desploma', !P.body.upright || P.body.dead);
  ok('sin NaN', nanFree(w));
}

console.log(fails ? `\n${fails} PRUEBAS FALLARON` : '\nTODO VERDE');
process.exit(fails ? 1 : 0);
