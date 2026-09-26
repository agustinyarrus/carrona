// ─────────────────────────────────────────────────────────────────────────────
//  progress.js — Lo que el jugador ya hizo: misiones cumplidas, mejores
//  tiempos, intentos, récords del modo infinito por mapa, y la colección de
//  armas (cuáles encontró y cuántas bajas hizo con cada una). Se guarda en
//  localStorage bajo una sola clave; sin DOM, así se prueba en Node.
// ─────────────────────────────────────────────────────────────────────────────

export const PROGRESS_KEY = 'carrona.progress';
export const PROGRESS_VERSION = 1;

export function emptyProgress() {
  return { v: PROGRESS_VERSION, missions: {}, infinite: {}, weapons: {}, last: null };
}

/** Deja un objeto de progreso bien formado aunque venga roto o viejo. */
export function normalizeProgress(raw) {
  const p = emptyProgress();
  if (!raw || typeof raw !== 'object') return p;
  if (raw.missions && typeof raw.missions === 'object') {
    for (const id in raw.missions) {
      const m = raw.missions[id];
      if (!m || typeof m !== 'object') continue;
      p.missions[id] = {
        done: !!m.done,
        attempts: Number.isFinite(m.attempts) ? Math.max(0, Math.floor(m.attempts)) : 0,
        bestTime: Number.isFinite(m.bestTime) && m.bestTime > 0 ? m.bestTime : null,
        bestKills: Number.isFinite(m.bestKills) ? Math.max(0, Math.floor(m.bestKills)) : 0,
      };
    }
  }
  if (raw.infinite && typeof raw.infinite === 'object') {
    for (const id in raw.infinite) {
      const r = raw.infinite[id];
      if (!r || typeof r !== 'object') continue;
      p.infinite[id] = {
        wave: Number.isFinite(r.wave) ? Math.max(0, Math.floor(r.wave)) : 0,
        kills: Number.isFinite(r.kills) ? Math.max(0, Math.floor(r.kills)) : 0,
        runs: Number.isFinite(r.runs) ? Math.max(0, Math.floor(r.runs)) : 0,
      };
    }
  }
  if (raw.weapons && typeof raw.weapons === 'object') {
    for (const k in raw.weapons) {
      const w = raw.weapons[k];
      if (!w || typeof w !== 'object' || !/^[a-z0-9]{1,24}$/.test(k)) continue;
      p.weapons[k] = { found: !!w.found, kills: Number.isFinite(w.kills) ? Math.max(0, Math.floor(w.kills)) : 0 };
    }
  }
  if (typeof raw.last === 'string') p.last = raw.last;
  return p;
}

/**
 * La colección: marca un arma como encontrada y/o le suma bajas. Devuelve
 * true si es la primera vez que se encuentra (para guardar enseguida).
 */
export function recordWeapon(p, key, { found = false, kills = 0 } = {}) {
  const w = p.weapons[key] || (p.weapons[key] = { found: false, kills: 0 });
  const fresh = found && !w.found;
  if (found) w.found = true;
  if (kills > 0) w.kills += Math.floor(kills);
  return fresh;
}

/** Cuántas armas distintas encontró. */
export function weaponsFound(p) {
  let n = 0;
  for (const k in p.weapons) if (p.weapons[k].found) n++;
  return n;
}

export function loadProgress(storage) {
  try {
    const s = storage || globalThis.localStorage;
    return normalizeProgress(JSON.parse(s.getItem(PROGRESS_KEY) || 'null'));
  } catch { return emptyProgress(); }
}

export function saveProgress(p, storage) {
  try { (storage || globalThis.localStorage).setItem(PROGRESS_KEY, JSON.stringify(p)); return true; } catch { return false; }
}

function slot(p, id) {
  return p.missions[id] || (p.missions[id] = { done: false, attempts: 0, bestTime: null, bestKills: 0 });
}

/** Se empezó una misión: cuenta el intento. */
export function recordAttempt(p, missionId) {
  slot(p, missionId).attempts++;
  p.last = missionId;
  return p;
}

/**
 * Terminó una misión. Devuelve `{ firstTime, newBest }`: si es la primera vez
 * que se cumple y si el tiempo fue récord.
 */
export function recordResult(p, missionId, { won, time = 0, kills = 0 }) {
  const m = slot(p, missionId);
  const out = { firstTime: false, newBest: false };
  m.bestKills = Math.max(m.bestKills, Math.floor(kills));
  if (won) {
    if (!m.done) { m.done = true; out.firstTime = true; }
    if (time > 0 && (m.bestTime === null || time < m.bestTime)) { m.bestTime = time; out.newBest = true; }
  }
  p.last = missionId;
  return out;
}

/** Récord del modo infinito en un mapa. Devuelve true si mejoró algo. */
export function recordInfinite(p, mapId, { wave = 0, kills = 0 }) {
  const r = p.infinite[mapId] || (p.infinite[mapId] = { wave: 0, kills: 0, runs: 0 });
  r.runs++;
  let better = false;
  if (wave > r.wave) { r.wave = wave; better = true; }
  if (kills > r.kills) { r.kills = kills; better = true; }
  return better;
}

/**
 * Una misión está abierta si es la primera de la campaña o si la anterior ya
 * se cumplió. `campaign` es la lista ordenada de definiciones ({id}).
 */
export function isMissionUnlocked(p, campaign, missionId) {
  const i = campaign.findIndex(m => m.id === missionId);
  if (i < 0) return false;
  if (i === 0) return true;
  return !!(p.missions[campaign[i - 1].id] && p.missions[campaign[i - 1].id].done);
}

/** La primera misión que todavía no se cumplió (o la última si están todas). */
export function nextMission(p, campaign) {
  for (const m of campaign) if (!(p.missions[m.id] && p.missions[m.id].done)) return m;
  return campaign[campaign.length - 1] || null;
}

export function missionsDone(p, campaign) {
  let n = 0;
  for (const m of campaign) if (p.missions[m.id] && p.missions[m.id].done) n++;
  return n;
}

/** El infinito se abre en la oficina siempre, y en los demás mapas al cumplir una misión ahí. */
export function isInfiniteUnlocked(p, campaign, mapId) {
  if (mapId === 'office') return true;
  return campaign.some(m => m.mapId === mapId && p.missions[m.id] && p.missions[m.id].done);
}
