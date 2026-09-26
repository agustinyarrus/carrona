// ─────────────────────────────────────────────────────────────────────────────
//  finish_worker.js — El horno de texturas de acabados, fuera del hilo
//  principal. Corre el MISMO renderFinish que el juego (mismos bytes) y
//  devuelve los buffers transferidos: nada se copia de vuelta.
//
//    entra  { id, name, params }
//    sale   { id, px: {albedo, normal, rough, emissive, size} }   o   { id, error }
// ─────────────────────────────────────────────────────────────────────────────

import { renderFinish } from './finish_recipes.js';

const MAPS = Object.freeze(['albedo', 'normal', 'rough', 'emissive']);

self.onmessage = (e) => {
  const { id, name, params } = e.data;
  try {
    const px = renderFinish(name, params);
    const transfer = [];
    for (const k of MAPS) if (px[k]) transfer.push(px[k].buffer);
    self.postMessage({ id, px }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
