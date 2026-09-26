// ─────────────────────────────────────────────────────────────────────────────
//  pwa.js — Instalación como app, service worker y detección del servidor local.
//  Cero acoplamiento con el juego: main.js llama initPwa() con dos callbacks y
//  con eso muestra u oculta un botón INSTALAR.
//
//  initPwa({ onInstallable, onInstalled, onUpdate })
//    · no hace nada desde file:// ni sin serviceWorker
//    · captura beforeinstallprompt y llama onInstallable(prompt): `prompt()` muestra
//      el diálogo del navegador y devuelve la promesa de userChoice
//      ({ outcome: 'accepted' | 'dismissed' })
//    · appinstalled → onInstalled()
//    · pide almacenamiento persistente (sin esperar la respuesta)
//    · registra ./sw.js SOLO si existe <meta name="carrona-build"> (la inyecta
//      tools/build.mjs en dist/index.html): en el repo no está, así que el SW nunca
//      cachea el código de desarrollo
//    · cuando un SW nuevo toma la página (actualización), llama onUpdate(reload);
//      sin callback, recarga sola si la página tiene menos de 3 s (todavía cargando)
//    · si el juego corre en localhost avisa al lanzador con un beacon a /__bye
//      cuando la página se cierra (el lanzador apaga el servidor)
//  isStandalone()  true si corre como app instalada (o en ventana --app)
//  pingServer()    fetch('/__carrona') → { app, version, port } o null si no hay servidor
// ─────────────────────────────────────────────────────────────────────────────

let deferredPrompt = null;

/** ¿Corre dentro de la app nativa (Capacitor)? Ahí no hay INSTALAR ni PANTALLA COMPLETA: ya lo es. */
export function isNative() {
  try { const C = window.Capacitor; return !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform()); } catch { return false; }
}

export function isStandalone() {
  try {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  } catch {
    return false;
  }
}

export async function pingServer() {
  try {
    const r = await fetch('/__carrona', { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.app === 'carrona' ? j : null;
  } catch {
    return null;
  }
}

export function initPwa({ onInstallable, onInstalled, onUpdate } = {}) {
  if (typeof window === 'undefined' || location.protocol === 'file:' || !('serviceWorker' in navigator)) return;

  // ── instalación ──
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (onInstallable) {
      onInstallable(() => {
        const ev = deferredPrompt;
        deferredPrompt = null;
        if (!ev) return Promise.resolve({ outcome: 'dismissed', platform: '' });
        ev.prompt();
        return ev.userChoice;
      });
    }
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    if (onInstalled) onInstalled();
  });
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch { /* nada */ }

  // ── aviso de cierre al lanzador (sólo en localhost: es quien lo escucha) ──
  if (location.hostname === 'localhost' && navigator.sendBeacon) {
    window.addEventListener('pagehide', () => {
      try { navigator.sendBeacon('/__bye', ''); } catch { /* nada */ }
    });
  }

  // ── service worker: sólo en el build ──
  if (!document.querySelector('meta[name="carrona-build"]')) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;   // primera instalación: el SW toma la página, no hay nada que recargar
    const reload = () => location.reload();
    if (onUpdate) onUpdate(reload);
    else if (performance.now() < 3000) reload();
  });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => { /* sin SW se juega igual */ });
}
