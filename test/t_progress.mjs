// Progreso guardado: misiones cumplidas, mejores tiempos, desbloqueos, récords
// del infinito, y que lo guardado roto o viejo no rompa nada.
import { emptyProgress, normalizeProgress, loadProgress, saveProgress, recordAttempt, recordResult, recordInfinite,
  isMissionUnlocked, nextMission, missionsDone, isInfiniteUnlocked, PROGRESS_KEY } from '../src/game/progress.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${name}   ${extra}`);
  if (!cond) fails++;
};
/** localStorage de mentira. */
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m }; };
const CAMP = [{ id: 'm1', mapId: 'office' }, { id: 'm2', mapId: 'parking' }, { id: 'm3', mapId: 'super' }, { id: 'm4', mapId: 'parking' }];

// ── 1. vacío y desbloqueo inicial ─────────────────────────────────────────────
{
  const p = emptyProgress();
  ok('la primera misión está abierta', isMissionUnlocked(p, CAMP, 'm1'));
  ok('la segunda no', !isMissionUnlocked(p, CAMP, 'm2'));
  ok('una misión inexistente no', !isMissionUnlocked(p, CAMP, 'zzz'));
  ok('la siguiente es la primera', nextMission(p, CAMP).id === 'm1');
  ok('cero cumplidas', missionsDone(p, CAMP) === 0);
  ok('el infinito de la oficina siempre abierto', isInfiniteUnlocked(p, CAMP, 'office'));
  ok('el infinito de otro mapa cerrado', !isInfiniteUnlocked(p, CAMP, 'parking'));
}

// ── 2. intentos, derrota, victoria, récords ───────────────────────────────────
{
  const p = emptyProgress();
  recordAttempt(p, 'm1');
  recordResult(p, 'm1', { won: false, time: 40, kills: 12 });
  ok('un intento perdido cuenta el intento y no cumple', p.missions.m1.attempts === 1 && !p.missions.m1.done && p.missions.m1.bestTime === null);
  ok('las bajas se recuerdan aunque pierda', p.missions.m1.bestKills === 12);
  recordAttempt(p, 'm1');
  const r1 = recordResult(p, 'm1', { won: true, time: 130.5, kills: 30 });
  ok('la victoria cumple y es la primera vez', p.missions.m1.done && r1.firstTime && r1.newBest, JSON.stringify(r1));
  ok('el mejor tiempo queda', p.missions.m1.bestTime === 130.5);
  const r2 = recordResult(p, 'm1', { won: true, time: 200, kills: 5 });
  ok('un tiempo peor no es récord', !r2.firstTime && !r2.newBest && p.missions.m1.bestTime === 130.5);
  const r3 = recordResult(p, 'm1', { won: true, time: 99, kills: 5 });
  ok('un tiempo mejor sí', r3.newBest && p.missions.m1.bestTime === 99);
  ok('ahora la segunda está abierta y la tercera no', isMissionUnlocked(p, CAMP, 'm2') && !isMissionUnlocked(p, CAMP, 'm3'));
  ok('la siguiente es la segunda', nextMission(p, CAMP).id === 'm2');
  ok('una cumplida', missionsDone(p, CAMP) === 1);
  ok('last apunta a la última jugada', p.last === 'm1');
  recordResult(p, 'm2', { won: true, time: 50, kills: 1 });
  ok('cumplir m2 abre el infinito del estacionamiento (m4 también es ahí, sin cumplir)', isInfiniteUnlocked(p, CAMP, 'parking'));
  ok('el super sigue cerrado', !isInfiniteUnlocked(p, CAMP, 'super'));
  recordResult(p, 'm3', { won: true, time: 50, kills: 1 }); recordResult(p, 'm4', { won: true, time: 50, kills: 1 });
  ok('con todo cumplido, la siguiente es la última', nextMission(p, CAMP).id === 'm4' && missionsDone(p, CAMP) === 4);
}

// ── 3. infinito ───────────────────────────────────────────────────────────────
{
  const p = emptyProgress();
  ok('primer récord mejora', recordInfinite(p, 'office', { wave: 3, kills: 40 }) && p.infinite.office.runs === 1);
  ok('una partida peor no mejora pero cuenta', !recordInfinite(p, 'office', { wave: 2, kills: 10 }) && p.infinite.office.runs === 2);
  ok('más oleadas mejora', recordInfinite(p, 'office', { wave: 5, kills: 10 }) && p.infinite.office.wave === 5 && p.infinite.office.kills === 40);
}

// ── 4. guardar y cargar, con basura ───────────────────────────────────────────
{
  const st = mem();
  const p = emptyProgress();
  recordResult(p, 'm1', { won: true, time: 12, kills: 3 });
  recordInfinite(p, 'office', { wave: 2, kills: 9 });
  ok('guarda', saveProgress(p, st));
  const q = loadProgress(st);
  ok('carga lo mismo', JSON.stringify(q) === JSON.stringify(p));
  st.setItem(PROGRESS_KEY, '{esto no es json');
  ok('json roto → vacío', JSON.stringify(loadProgress(st)) === JSON.stringify(emptyProgress()));
  st.setItem(PROGRESS_KEY, JSON.stringify({ v: 0, missions: { m1: { done: 'sí', attempts: -3, bestTime: 'x', bestKills: 2.7 }, m2: null, m3: 4 }, infinite: { office: { wave: 'a', kills: 3 } }, last: 12 }));
  const n = loadProgress(st);
  ok('lo viejo o raro se normaliza', n.missions.m1.done === true && n.missions.m1.attempts === 0 && n.missions.m1.bestTime === null && n.missions.m1.bestKills === 2 && !n.missions.m2 && !n.missions.m3 && n.infinite.office.wave === 0 && n.infinite.office.kills === 3 && n.last === null, JSON.stringify(n));
  ok('normalizar null da vacío', JSON.stringify(normalizeProgress(null)) === JSON.stringify(emptyProgress()));
  const broken = { getItem: () => { throw new Error('sin storage'); }, setItem: () => { throw new Error('sin storage'); } };
  ok('sin storage no revienta', JSON.stringify(loadProgress(broken)) === JSON.stringify(emptyProgress()) && saveProgress(p, broken) === false);
}

console.log(fails ? `\n${fails} PRUEBAS FALLARON` : '\nTODO VERDE');
process.exit(fails ? 1 : 0);
