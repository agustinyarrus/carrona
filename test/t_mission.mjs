// Misiones: el manager de objetivos con un juego de mentira (matar, juntar,
// aguantar, llegar, oleadas, en orden, victoria una sola vez), las
// configuraciones de oleadas, y la campaña contra los mapas reales (cada
// punto que pide una misión existe en su mapa y es alcanzable).
import { register } from 'node:module';
register('./_three_hooks.mjs', import.meta.url);

const THREE = await import('three');
const { MissionManager, CAMPAIGN, WAVES_CLASSIC, WAVES_LIGHT, WAVES_HEAVY, infiniteMission, missionById, ITEM_STYLE } = await import('../src/game/mission.js');
const { MAPS, MAP_ORDER, getMap } = await import('../src/game/maps.js');
const { LevelBuilder } = await import('../src/game/level.js');
const { NavGrid } = await import('../src/game/nav.js');
const { PhysWorld } = await import('../src/phys/world.js');
const { makeRng } = await import('../src/core/util.js');
const { setLang, t } = await import('../src/core/i18n.js');
const { WEAPONS } = await import('../src/game/weapons.js');

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${name}   ${extra}`);
  if (!cond) fails++;
};
setLang('es');

/** Un juego de mentira para el manager. */
function fakeHost(points = {}) {
  const H = {
    points, _kills: 0, _waves: 0, _active: false, P: { x: 0, z: 0 }, spawned: [], anns: [], toasts: [], won: 0, timers: [],
    kills: () => H._kills, wavesCleared: () => H._waves, waveActive: () => H._active, playerPos: () => H.P,
    randomSpot: () => ({ x: 5, z: 5 }),
    spawnObjective: (x, z, item) => H.spawned.push({ x, z, item }),
    announce: (b, s) => H.anns.push(b + ' | ' + s),
    toast: (txt) => H.toasts.push(txt),
    later: (fn, sec) => H.timers.push({ fn, sec }),
    onWon: () => H.won++,
  };
  H.flush = () => { const tm = H.timers.splice(0); for (const x of tm) x.fn(); };
  return H;
}
const run = (M, sec) => { for (let i = 0; i < sec * 60; i++) M.update(1 / 60); };

// ── 1. una misión de cuatro objetivos, en orden ───────────────────────────────
{
  const def = { id: 'x', mapId: 'office', infinite: false, objectives: [
    { type: 'kill', n: 3 },
    { type: 'collect', n: 2, item: 'item.fuel', points: ['obj1', 'obj2'] },
    { type: 'survive', sec: 2 },
    { type: 'reach', point: 'exit', place: 'place.exit', r: 1.5 },
  ] };
  const H = fakeHost({ obj1: { x: 3, z: 0 }, obj2: { x: 0, z: 3 }, exit: { x: 10, z: 10 } });
  const M = new MissionManager(def, H);
  M.start();
  ok('arranca en el primer objetivo', M.current && M.current.type === 'kill' && M.idx === 0);
  ok('el anuncio del objetivo se difiere (deja pasar el nombre de la misión)', H.anns.length === 0 && H.timers.length === 1);
  H.flush();
  ok('… y después se anuncia', H.anns.length === 1 && H.anns[0].startsWith('OBJETIVO | matá 3 zombis'), H.anns[0]);
  ok('describe y progresa', M.describe() === 'matá 3 zombis' && M.progress() === '0/3');
  H._kills = 2; run(M, 0.1);
  ok('dos bajas no alcanzan', M.idx === 0 && M.progress() === '2/3');
  H._kills = 3; run(M, 0.1);
  ok('tres bajas cumplen y pasa a juntar', M.idx === 1 && M.current.type === 'collect');
  ok('anunció el "listo" del anterior y difirió el nuevo', H.anns[1] === 'LISTO | matá 3 zombis' && H.timers.length === 1);
  H.flush();
  ok('el nuevo se anuncia', H.anns[2].startsWith('OBJETIVO | juntá 2 bidones de nafta'), H.anns[2]);
  ok('las dos cosas aparecieron en los puntos del mapa', H.spawned.length === 2 && H.spawned[0].x === 3 && H.spawned[1].z === 3 && H.spawned[0].item === 'item.fuel');
  const tg1 = M.target();
  ok('el marcador apunta a la más cercana (las dos a 3 m: la primera)', tg1 && tg1.x === 3);
  M.onPickup({ x: 3, z: 0 }); run(M, 0.05);
  ok('una juntada: 1/2 y el marcador pasa a la otra', M.progress() === '1/2' && M.target().z === 3 && H.toasts[0] === 'BIDÓN 1/2', H.toasts[0]);
  M.onPickup({ x: 0, z: 3 }); run(M, 0.05);
  ok('las dos: pasa a aguantar', M.idx === 2 && M.current.type === 'survive');
  ok('sin marcador mientras aguanta', M.target() === null);
  run(M, 1.0);
  ok('al segundo falta 0:01', M.progress() === 'faltan 0:01', M.progress());
  run(M, 1.2);
  ok('pasados los 2 s: llegar a la salida (último objetivo)', M.idx === 3 && M.current.type === 'reach');
  H.flush();
  ok('el último se anuncia como tal', H.anns[H.anns.length - 1].startsWith('ÚLTIMO OBJETIVO | llegá a la salida'), H.anns[H.anns.length - 1]);
  ok('el marcador apunta a la salida y el progreso es la distancia', M.target().x === 10 && M.progress() === '14 m', M.progress());
  H.P = { x: 9.2, z: 9.2 }; run(M, 0.05);
  ok('a 1,1 m cumple: ganó UNA vez', M.done && H.won === 1);
  run(M, 1);
  ok('después de ganar no pasa nada más', H.won === 1 && M.current === null);
}

// ── 2. oleadas como objetivo, y el infinito no gana nunca ─────────────────────
{
  const H = fakeHost();
  const M = new MissionManager({ id: 'w', objectives: [{ type: 'waves', n: 2 }] }, H);
  M.start(); H.flush();
  H._active = true; run(M, 0.1);
  ok('en la primera oleada: "oleada 1 de 2"', M.progress() === 'oleada 1 de 2', M.progress());
  H._waves = 1; H._active = false; run(M, 0.1);
  ok('una limpia no alcanza', !M.done);
  H._waves = 2; run(M, 0.1);
  ok('dos limpias: misión cumplida', M.done && H.won === 1);
  const H2 = fakeHost();
  const inf = new MissionManager(infiniteMission('office'), H2);
  inf.start(); run(inf, 5);
  ok('el infinito no tiene objetivos ni gana', !inf.done && H2.won === 0 && inf.current === null && H2.anns.length === 0);
  ok('infiniteMission apunta al mapa pedido', infiniteMission('subte').mapId === 'subte' && infiniteMission('subte').infinite === true);
}

// ── 3. juntar sin puntos en el mapa: cae en un lugar cualquiera ───────────────
{
  const H = fakeHost({});
  const M = new MissionManager({ id: 'c', objectives: [{ type: 'collect', n: 2, item: 'item.meds', points: ['nada'] }] }, H);
  M.start();
  ok('sin puntos igual aparecen las dos cosas', H.spawned.length === 2 && H.spawned.every(s => s.x === 5));
}

// ── 4. las configuraciones de oleadas ─────────────────────────────────────────
{
  for (const [name, W] of [['clásica', WAVES_CLASSIC], ['liviana', WAVES_LIGHT], ['pesada', WAVES_HEAVY]]) {
    let good = true;
    for (let n = 1; n <= 12; n++) {
      if (!(W.total(n) > 0 && W.maxAlive(n) >= 4 && W.maxAlive(n) <= 44 && W.interval(n) >= 0.2 && W.sleepers(n) >= 0)) good = false;
      for (let k = 0; k < 20; k++) if (!['walker', 'jogger', 'runner', 'brute'].includes(W.mix(n, k / 20))) good = false;
      if (!(W.stampede.count(n) > 0)) good = false;
    }
    ok(`oleadas ${name}: valores sanos hasta la 12`, good && W.firstDelay > 0 && W.between > 0);
    ok(`oleadas ${name}: crecen`, W.total(6) > W.total(1) && W.maxAlive(6) > W.maxAlive(1));
  }
  ok('la liviana es más liviana y la pesada más pesada que la clásica', WAVES_LIGHT.total(4) < WAVES_CLASSIC.total(4) && WAVES_HEAVY.total(4) > WAVES_CLASSIC.total(4));
  ok('la pesada trae brutos desde la segunda', WAVES_HEAVY.mix(2, 0.01) === 'brute' && WAVES_CLASSIC.mix(2, 0.01) !== 'brute');
}

// ── 5. la campaña contra los mapas reales ─────────────────────────────────────
{
  const ids = CAMPAIGN.map(m => m.id);
  ok('ids únicos', new Set(ids).size === ids.length && ids.length >= 6);
  ok('cada misión tiene nombre y resumen en los dos idiomas', CAMPAIGN.every(m => m.name && m.name.es && m.name.en && m.brief && m.brief.es && m.brief.en));
  ok('cada misión tiene mapa del registro, oleadas y objetivos', CAMPAIGN.every(m => MAPS[m.mapId] && m.waves && m.objectives.length >= 1));
  ok('las armas iniciales existen y empiezan con la pistola', CAMPAIGN.every(m => m.start.weapons[0] === 'pistol' && m.start.weapons.every(w => WEAPONS[w])));
  ok('todos los mapas del registro aparecen en la campaña', MAP_ORDER.every(id => CAMPAIGN.some(m => m.mapId === id)));
  ok('cada objetivo es de un tipo conocido y bien formado', CAMPAIGN.every(m => m.objectives.every(o =>
    (o.type === 'waves' && o.n > 0) || (o.type === 'kill' && o.n > 0) || (o.type === 'survive' && o.sec > 0) ||
    (o.type === 'reach' && o.point && t(o.place) !== o.place) || (o.type === 'collect' && o.n > 0 && ITEM_STYLE[o.item] && t(o.item) !== o.item && t(o.item + '.one') !== o.item + '.one'))));
  ok('missionById', missionById('m1') === CAMPAIGN[0] && missionById('zzz') === null);
  // construir cada mapa una vez y verificar los puntos que piden las misiones
  const mats = { tex: new Proxy({}, { get: () => ({ userData: { meters: 1 } }) }), mat: new Proxy({}, { get: () => new THREE.MeshBasicMaterial() }) };
  const built = {};
  for (const id of MAP_ORDER) {
    const map = getMap(id), w = new PhysWorld();
    const L = new LevelBuilder(new THREE.Scene(), w, mats, makeRng(map.seed));
    map.build(L);
    const nav = new NavGrid(w, map.nav);
    nav.computeFlow(L.playerStart.x, L.playerStart.z);
    built[id] = { L, nav };
  }
  for (const m of CAMPAIGN) {
    const { L, nav } = built[m.mapId];
    let good = true, why = '';
    for (const o of m.objectives) {
      const names = o.type === 'reach' ? [o.point] : o.type === 'collect' ? o.points.slice(0, o.n) : [];
      for (const n of names) {
        const p = L.points && L.points[n];
        if (!p) { good = false; why += ` falta ${n}`; continue; }
        if (!nav.reachable(p.x, p.z)) { good = false; why += ` ${n} inalcanzable`; }
      }
      if (o.type === 'collect' && o.points.length < o.n) { good = false; why += ' pide más puntos de los que lista'; }
    }
    ok(`${m.id} (${m.mapId}): los puntos que pide existen y se llega`, good, why);
  }
}

console.log(fails ? `\n${fails} PRUEBAS FALLARON` : '\nTODO VERDE');
process.exit(fails ? 1 : 0);
