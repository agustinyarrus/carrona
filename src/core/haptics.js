// ─────────────────────────────────────────────────────────────────────────────
//  haptics.js — Vibración táctil (navigator.vibrate): pulsos cortos con nombre y un
//  techo de frecuencia, así una automática a quince tiros por segundo no satura el
//  motor ni el hilo principal. Sin soporte, apagada en opciones o en escritorio, no
//  hace nada y no tira. En la app de Android hace falta el permiso VIBRATE.
// ─────────────────────────────────────────────────────────────────────────────

/** Duración de cada pulso en ms. */
export const HAPTIC = Object.freeze({ shot: 12, heavy: 22, hurt: 45, pickup: 18 });
/** Mínimo entre pulsos: por debajo el motor no llega a arrancar y parar. */
const MIN_GAP_MS = 45;

let enabled = false;
let lastAt = -Infinity;

export function setHaptics(on) { enabled = !!on; }
export function hapticsOn() { return enabled; }

/** ¿Este aparato puede vibrar desde la página? */
export function canVibrate() {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

/**
 * Un pulso de `ms` (o un patrón [on, off, on…]). Devuelve si salió. `force` salta el techo de
 * frecuencia (un golpe recibido siempre se siente aunque se esté disparando).
 */
export function haptic(ms, force = false) {
  if (!enabled || !canVibrate()) return false;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (!force && now - lastAt < MIN_GAP_MS) return false;
  lastAt = now;
  try { return !!navigator.vibrate(ms); } catch { return false; }   // Chrome sin gesto del usuario devuelve false o tira
}
