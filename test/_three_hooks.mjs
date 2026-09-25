// Hook de resolución para Node: `three` y `three/addons/` viven en vendor/ y
// en el navegador los resuelve el importmap. Registrar con
//   import { register } from 'node:module'; register('./_three_hooks.mjs', import.meta.url);
// ANTES de los `await import()` que toquen Three.
const ROOT = new URL('../vendor/three/', import.meta.url).href;
export async function resolve(spec, ctx, next) {
  if (spec === 'three') return { url: ROOT + 'three.module.js', shortCircuit: true };
  if (spec.startsWith('three/addons/')) return { url: ROOT + 'addons/' + spec.slice('three/addons/'.length), shortCircuit: true };
  return next(spec, ctx);
}
