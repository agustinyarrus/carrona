// ─────────────────────────────────────────────────────────────────────────────
//  maps.js — Registro de lugarcitos: quién los construye, cómo se navegan,
//  con qué luz se ven y qué dice el juego al entrar y al morir en cada uno.
//
//  `mood` va derecho a Renderer.applyMood; `fog` (opcional) es {near, far}
//  para una THREE.Fog del color del fondo. `nav` son las opciones de NavGrid.
// ─────────────────────────────────────────────────────────────────────────────

import { buildOffice, buildParking, buildSuper, buildSubte, buildHospital } from './level.js';

export const MAPS = {
  office: {
    id: 'office', name: 'LA OFICINA', sub: 'UN LUGARCITO · MUCHOS ZOMBIS', seed: 42,
    build: buildOffice,
    nav: { cell: 0.4, margin: 0.30, vaultTop: 1.05 },
    mood: { background: 0x06070a, hemiSky: 0x33405f, hemiGround: 0x1a1713, hemiIntensity: 0.95, moonColor: 0x92a6cf, moonIntensity: 0.78, bloom: 0.26, exposure: 1.06, vignette: 0.5 },
    menuZombies: 26,
    texts: { start: 'la oficina ya no es lo que era', death: 'TE COMIERON EN LA OFICINA' },
  },
  parking: {
    id: 'parking', name: 'EL ESTACIONAMIENTO', sub: 'SUBSUELO 2 · NO HAY LUGAR', seed: 1917,
    build: buildParking,
    nav: { cell: 0.4, margin: 0.30, vaultTop: 1.05 },
    mood: {
      background: 0x030504, hemiSky: 0x3a4a40, hemiGround: 0x15181a, hemiIntensity: 1.05, moonColor: 0x8aa896, moonIntensity: 0.55,
      bloom: 0.32, exposure: 1.05, vignette: 0.6, fog: { near: 26, far: 78 },
    },
    menuZombies: 22,
    texts: { start: 'el subsuelo huele a nafta y a otra cosa', death: 'TE COMIERON EN EL ESTACIONAMIENTO' },
  },
  super: {
    id: 'super', name: 'EL SUPERMERCADO', sub: 'OFERTAS QUE MATAN · CAJA 3 ABIERTA', seed: 7331,
    build: buildSuper,
    nav: { cell: 0.4, margin: 0.30, vaultTop: 1.05 },
    mood: { background: 0x07080c, hemiSky: 0x56607a, hemiGround: 0x2a2824, hemiIntensity: 1.3, moonColor: 0xb4c0d6, moonIntensity: 0.95, bloom: 0.22, exposure: 1.15, vignette: 0.42 },
    menuZombies: 26,
    texts: { start: 'la oferta del día sos vos', death: 'TE COMIERON EN EL SUPERMERCADO' },
  },
  subte: {
    id: 'subte', name: 'LA ESTACIÓN', sub: 'ÚLTIMO TREN · SERVICIO INTERRUMPIDO', seed: 2604,
    build: buildSubte,
    nav: { cell: 0.4, margin: 0.30, vaultTop: 1.05 },
    mood: {
      background: 0x06050a, hemiSky: 0x554c66, hemiGround: 0x221e14, hemiIntensity: 1.05, moonColor: 0xa89060, moonIntensity: 0.72,
      bloom: 0.3, exposure: 1.04, vignette: 0.55, fog: { near: 28, far: 90 },
    },
    menuZombies: 24,
    texts: { start: 'el tren no sale; los de adentro tampoco', death: 'TE COMIERON EN LA ESTACIÓN' },
  },
  hospital: {
    id: 'hospital', name: 'EL HOSPITAL', sub: 'GUARDIA 24 HS · NO HAY CAMAS', seed: 9012,
    build: buildHospital,
    nav: { cell: 0.4, margin: 0.30, vaultTop: 1.05 },
    mood: { background: 0x07090b, hemiSky: 0x4c5c66, hemiGround: 0x1e1f1c, hemiIntensity: 1.15, moonColor: 0xa8c0cc, moonIntensity: 0.85, bloom: 0.24, exposure: 1.1, vignette: 0.48 },
    menuZombies: 24,
    texts: { start: 'acá no se cura nadie', death: 'TE COMIERON EN EL HOSPITAL' },
  },
};

export const MAP_ORDER = ['office', 'parking', 'super', 'subte', 'hospital'];

export function getMap(id) { return MAPS[id] || MAPS.office; }
