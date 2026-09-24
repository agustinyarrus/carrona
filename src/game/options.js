// ─────────────────────────────────────────────────────────────────────────────
//  options.js — El registro declarativo de opciones y las teclas.
//
//  Cada opción se describe UNA vez (clave, grupo, tipo, rango, valor por
//  defecto y cómo se aplica al juego) y de ahí salen la pantalla de opciones,
//  la validación de lo guardado y la persistencia. Sin DOM: se prueba en Node.
// ─────────────────────────────────────────────────────────────────────────────

import { QUALITY_ORDER } from '../render/renderer.js';
import { LANGS, setLang } from '../core/i18n.js';

export const SETTINGS_KEY = 'carrona.settings';

/** Acciones del juego y sus teclas por defecto (códigos `KeyboardEvent.code` o `MouseN`). */
export const DEFAULT_KEYS = {
  moveUp: ['KeyW', 'ArrowUp'],
  moveDown: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  run: ['ShiftLeft', 'ShiftRight'],
  crouch: ['ControlLeft', 'ControlRight', 'KeyC'],
  roll: ['KeyC'],
  interact: ['Space'],
  reload: ['KeyR'],
  flashlight: ['KeyF'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  weapon3: ['Digit3'],
  weapon4: ['Digit4'],
  camLeft: ['KeyQ'],
  camRight: ['KeyE'],
  pause: ['Escape', 'KeyP'],
  fire: ['Mouse0'],
};
export const ACTION_ORDER = Object.keys(DEFAULT_KEYS);

const pct = (v) => Math.round(v * 100) + '%';

/**
 * El registro. `apply(game, v)` deja el valor en el motor; `get(game)` lee
 * el estado real cuando no vive en settings (pantalla completa).
 */
export const OPTIONS = [
  { key: 'fullscreen', group: 'video', type: 'toggle', def: false, volatile: true,
    get: (g) => !!(typeof document !== 'undefined' && document.fullscreenElement),
    apply: (g, v) => g.setFullscreen(v) },
  { key: 'quality', group: 'video', type: 'select', values: QUALITY_ORDER, def: 'medio',
    apply: (g, v) => { if (g.R.qualityName !== v) g.R.setQuality(v); } },
  { key: 'autoQuality', group: 'video', type: 'toggle', def: true, apply: () => {} },
  { key: 'shadows', group: 'video', type: 'toggle', def: true, apply: (g, v) => g.R.setShadows(v) },
  { key: 'bloom', group: 'video', type: 'toggle', def: true, apply: (g, v) => g.R.setBloom(v) },
  { key: 'showFps', group: 'video', type: 'toggle', def: false, apply: (g, v) => g.ui.setPerf(v) },

  { key: 'volume', group: 'audio', type: 'range', min: 0, max: 1, step: 0.05, def: 0.8, fmt: pct, apply: (g, v) => g.audio.setVolume(v) },
  { key: 'sfx', group: 'audio', type: 'range', min: 0, max: 1, step: 0.05, def: 1, fmt: pct, apply: (g, v) => g.audio.setSfxVolume(v) },
  { key: 'music', group: 'audio', type: 'range', min: 0, max: 1, step: 0.05, def: 1, fmt: pct, apply: (g, v) => g.audio.setMusicVolume(v) },

  { key: 'shake', group: 'game', type: 'range', min: 0, max: 1.5, step: 0.05, def: 1, fmt: pct, apply: () => {} },
  { key: 'camDist', group: 'game', type: 'range', min: 12, max: 32, step: 1, def: 20.5, fmt: (v) => v + ' m',
    apply: (g, v) => { g.R.camDistTarget = v; if (g.state === 'menu') g.R.camDist = v; } },
  { key: 'camPitch', group: 'game', type: 'range', min: 0.8, max: 1.25, step: 0.01, def: 1.04, fmt: (v) => Math.round(v * 180 / Math.PI) + '°',
    apply: (g, v) => { g.R.camPitch = v; } },
  { key: 'lookAhead', group: 'game', type: 'range', min: 0, max: 0.8, step: 0.05, def: 0.32, fmt: pct, apply: (g, v) => { g.R.lookAhead = v; } },
  { key: 'lang', group: 'game', type: 'select', values: LANGS, def: 'es', apply: (g, v) => { setLang(v); g.ui.relabel(); } },
];
export const OPTION_GROUPS = ['video', 'audio', 'game', 'controls'];

export function optionByKey(key) { return OPTIONS.find(o => o.key === key) || null; }

/** Ajustes por defecto (teclas incluidas), copia fresca. */
export function defaultSettings() {
  const s = {};
  for (const o of OPTIONS) if (!o.volatile) s[o.key] = o.def;
  s.keys = {};
  for (const a of ACTION_ORDER) s.keys[a] = DEFAULT_KEYS[a].slice();
  return s;
}

const isCode = (c) => typeof c === 'string' && (/^Mouse[0-4]$/.test(c) || (!c.startsWith('Mouse') && /^[A-Z][A-Za-z0-9]{0,24}$/.test(c)));

/**
 * Teclas válidas: cada acción con a lo sumo tres códigos. Una lista que falta
 * o está rota vuelve al defecto; una lista vacía a propósito (el jugador le
 * sacó la tecla) se respeta, salvo disparar y pausar, que nunca quedan sin.
 */
export function normalizeKeys(raw) {
  const keys = {};
  for (const a of ACTION_ORDER) {
    const v = raw ? raw[a] : undefined;
    let list;
    if (Array.isArray(v)) list = v.filter(isCode);
    else if (typeof v === 'string' && isCode(v)) list = [v];
    else list = DEFAULT_KEYS[a].slice();
    list = [...new Set(list)].slice(0, 3);
    if (a === 'fire' && !list.length) list = DEFAULT_KEYS.fire.slice();
    // la pausa siempre responde a esc: si no, no hay forma de salir de una partida
    if (a === 'pause' && !list.includes('Escape')) list = [...list.slice(0, 2), 'Escape'];
    keys[a] = list;
  }
  return keys;
}

/**
 * Deja un objeto de ajustes completo y válido a partir de lo que haya
 * guardado (incluido el formato viejo, que sólo tenía shake/quality/volume/
 * camDist/autoQuality).
 */
export function normalizeSettings(raw) {
  const s = defaultSettings();
  if (!raw || typeof raw !== 'object') return s;
  for (const o of OPTIONS) {
    if (o.volatile || !(o.key in raw)) continue;
    const v = raw[o.key];
    if (o.type === 'toggle') s[o.key] = !!v;
    else if (o.type === 'select') { if (o.values.includes(v)) s[o.key] = v; }
    else if (o.type === 'range') { if (Number.isFinite(v)) s[o.key] = Math.min(o.max, Math.max(o.min, v)); }
  }
  s.keys = normalizeKeys(raw.keys);
  return s;
}

export function loadSettings(storage) {
  try {
    const st = storage || globalThis.localStorage;
    return normalizeSettings(JSON.parse(st.getItem(SETTINGS_KEY) || 'null'));
  } catch { return defaultSettings(); }
}

export function saveSettings(s, storage) {
  try { (storage || globalThis.localStorage).setItem(SETTINGS_KEY, JSON.stringify(s)); return true; } catch { return false; }
}

/**
 * Cambia la tecla principal de una acción: reemplaza la principal, deja las
 * secundarias, y saca la tecla nueva de cualquier otra acción para que no
 * choque (esa acción puede quedar sin tecla: se ve en las opciones).
 */
export function rebind(keys, action, code) {
  if (!ACTION_ORDER.includes(action) || !isCode(code)) return keys;
  const out = {};
  for (const a of ACTION_ORDER) out[a] = (keys[a] || DEFAULT_KEYS[a]).filter(c => c !== code);
  out[action] = [code, ...(keys[action] || DEFAULT_KEYS[action]).slice(1).filter(c => c !== code)].slice(0, 3);
  return normalizeKeys(out);
}

/** Todos los códigos ligados a alguna acción (para saber qué teclas frenar en el navegador). */
export function boundCodes(keys) {
  const set = new Set();
  for (const a in keys) for (const c of keys[a]) set.add(c);
  return set;
}
