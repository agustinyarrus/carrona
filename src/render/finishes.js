// ─────────────────────────────────────────────────────────────────────────────
//  finishes.js — Los acabados de las armas del lado de Three: texturas (con
//  caché), materiales, muestras para precompilar shaders, el horno que las
//  calcula en un Worker y el reflejo de estudio que hace brillar el metal.
//  Las recetas en sí (JS puro) viven en finish_recipes.js.
//
//  Las texturas se calculan recién cuando un arma las necesita, o antes, en
//  segundo plano (bakeFinishes), y quedan en caché: una por receta+colores+
//  semilla; las recetas «tint» comparten píxeles para cualquier color.
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { RECIPES, renderFinish, parseFinish, rgb } from './finish_recipes.js';
import { programSignature } from './warmup.js';

export { RECIPES, renderFinish, parseFinish, rgb };

// ═════════════════════════════════════════════════════════════════════════════
//  Texturas y materiales (caché)
// ═════════════════════════════════════════════════════════════════════════════

const TEX_CACHE = new Map();     // clave de textura → {map, normalMap, roughnessMap, emissiveMap}
const MAT_CACHE = new Map();     // clave de material → material
let ENV = null, ENV_INTENSITY = 0.35;

function dataTex(data, S, srgb) {
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

//  Recetas de un solo color ("tint"): la textura se calcula UNA vez en gris
//  neutro y el color va en material.color. Albedo sRGB = c·k; con la ley de
//  potencia de sRGB, lin(c·k) = lin(c)·lin(T·k)/lin(T): el material lleva
//  lin(c)/lin(T) y la textura guarda T·k. Todas las variantes de polímero,
//  cerakote, cepillado… comparten los mismos píxeles (de 105 texturas a ~45).
const TINT_GRAY = '#c4c4c4';
const TINT_GAIN = 1 / 0.55203;          // 1 / lin(196/255)

/** Clave de las texturas de un acabado: las recetas «tint» comparten píxeles para cualquier color. */
function textureKey(F) {
  const R = RECIPES[F.f];
  const colors = R.tint ? TINT_GRAY : `${F.c}|${F.c2 || ''}|${F.c3 || ''}|${(F.cols || []).join(',')}`;
  return `${F.f}|${colors}|${F.seed || 1}|${F.scale || ''}`;
}

/** Parámetros de renderFinish para un acabado (las «tint» se calculan en gris neutro). */
function renderParams(F) {
  return { ...F, ...(RECIPES[F.f].tint ? { c: TINT_GRAY } : null), seed: F.seed || 1 };
}

/** Los píxeles de una receta hechos texturas de Three (comparten los buffers, no copian). */
function texSet(px) {
  return {
    map: dataTex(px.albedo, px.size, true),
    normalMap: px.normal ? dataTex(px.normal, px.size, false) : null,
    roughnessMap: px.rough ? dataTex(px.rough, px.size, false) : null,
    emissiveMap: px.emissive ? dataTex(px.emissive, px.size, false) : null,
  };
}

/**
 * Texturas de un acabado (una vez por receta+colores+semilla). Si el horno
 * en segundo plano ya las trajo, salen de la caché; si no, se calculan acá.
 */
function finishTextures(F) {
  const key = textureKey(F);
  let T = TEX_CACHE.get(key);
  if (T) return T;
  T = texSet(renderFinish(F.f, renderParams(F)));
  TEX_CACHE.set(key, T);
  return T;
}

//  Un solo programa de shader para todas las armas. La clave del programa depende de QUÉ
//  mapas tiene el material (no de su contenido): con color, normales, rugosidad y emisión
//  SIEMPRE puestos, las 104 armas comparten uno (antes eran 17 combinaciones, y con veinte
//  luces cada una tardaba ~1,5 s en compilar en una Iris Xe). A los mapas que la receta no
//  trae los reemplaza un neutro de 1×1 compartido: blanco (color, rugosidad y emisión: la
//  emisión la apaga el color negro del material) o la normal plana (0,0,1).
const NEUTRAL = Object.freeze({ white: neutralTex([255, 255, 255, 255], true), normal: neutralTex([128, 128, 255, 255], false) });

function neutralTex(rgba, srgb) {
  const t = new THREE.DataTexture(new Uint8Array(rgba), 1, 1, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Material estándar de arma con los cuatro mapas (los que faltan, neutros). O(1). */
function standardFinish(params, maps = {}) {
  const M = new THREE.MeshStandardMaterial(params);
  M.map = maps.map || NEUTRAL.white;
  M.normalMap = maps.normalMap || NEUTRAL.normal;
  M.roughnessMap = maps.roughnessMap || NEUTRAL.white;
  M.emissiveMap = maps.emissiveMap || NEUTRAL.white;
  return M;
}

/** Repite una textura cada `meters` (los UV del arma están en metros). Clon liviano: comparte los píxeles. */
function scaled(tex, meters) {
  if (!tex) return null;
  const t = tex.clone();
  t.repeat.set(1 / meters, 1 / meters);
  t.needsUpdate = true;
  return t;
}

/**
 * Material para un acabado. Los emisivos ('glow:#hex') son MeshBasicMaterial
 * sin tone mapping, con el color multiplicado: pasan el umbral del bloom y
 * se ven como luz. Lentes: vidrio oscuro con un reflejo teñido.
 */
export function finishMaterial(spec) {
  const F = parseFinish(spec);
  const key = JSON.stringify(F);
  let M = MAT_CACHE.get(key);
  if (M) return M;
  M = buildFinishMaterial(F, F.f === 'flat' ? null : finishTextures(F));
  MAT_CACHE.set(key, M);
  return M;
}

/** Arma el material de un acabado ya interpretado con sus texturas (null en los lisos). Sin caché. */
function buildFinishMaterial(F, T) {
  let M;
  const flatColor = F.c ?? '#808080';
  if (F.f === 'flat' && F.glow) {
    M = new THREE.MeshBasicMaterial({ color: new THREE.Color(flatColor).multiplyScalar(F.glow), toneMapped: false });
  } else if (F.f === 'flat' && F.lens) {
    M = standardFinish({ color: 0x07080b, roughness: 0.06, metalness: 0.9, emissive: new THREE.Color(flatColor), emissiveIntensity: F.lens });
  } else if (F.f === 'flat') {
    M = standardFinish({ color: new THREE.Color(flatColor), roughness: F.rough ?? 0.6, metalness: F.metal ?? 0.2 });
  } else {
    const R = RECIPES[F.f], tile = F.tile ?? R.tile;
    const glow = !!(T.emissiveMap && F.glowColor);
    M = standardFinish({ color: 0xffffff, roughness: F.rough ?? R.rough, metalness: F.metal ?? R.metal }, {
      map: scaled(T.map, tile),
      normalMap: scaled(T.normalMap, tile),
      roughnessMap: scaled(T.roughnessMap, tile),
      emissiveMap: glow ? scaled(T.emissiveMap, tile) : null,
    });
    M.normalScale.set(1, 1);
    if (R.tint) M.color.set(F.c ?? '#808080').multiplyScalar(TINT_GAIN);
    if (glow) {
      M.emissive = new THREE.Color(F.glowColor);
      M.emissiveIntensity = F.glowIntensity ?? 2.2;
    }
  }
  if (M.isMeshStandardMaterial && ENV) { M.envMap = ENV; M.envMapIntensity = ENV_INTENSITY; }
  M.userData.finish = F;
  return M;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Para que ningún arma trabe la partida: muestras para precompilar sus
//  shaders y texturas calculadas de antemano en los ratos libres del menú
// ═════════════════════════════════════════════════════════════════════════════

/** Lado de las texturas de muestra: la clave del programa ve QUÉ mapas hay, no cuántos píxeles tienen. */
const PROXY_SIZE = 8;
/** Paleta completa para las muestras (hay recetas de dos, tres y cuatro colores). */
const PROXY_PALETTE = Object.freeze({ c: '#8a8d93', c2: '#5d6066', c3: '#34363b', cols: Object.freeze(['#8a8d93', '#5d6066', '#34363b', '#1d1e22']) });
let PROXIES = null;

/**
 * Un material por cada ESTRUCTURA que puede tener un arma: cada receta (con
 * brillo y sin), el liso, la lente y el emisivo; texturas de 8×8 hechas por
 * el mismo camino que las de verdad y el mismo reflejo. Con los cuatro mapas
 * siempre puestos se deduplican a dos (estándar y emisivo), pero se arman
 * todas: si mañana una receta cambiara la estructura, la muestra la cubre
 * igual (y la prueba lo detecta). Viven para siempre: liberarlos soltaría
 * sus programas. Necesita el reflejo ya puesto (setWeaponEnvironment). O(recetas).
 */
export function finishProxyMaterials() {
  if (PROXIES) return PROXIES;
  const out = [], seen = new Set();
  const push = (M) => { const k = programSignature(M); if (seen.has(k)) M.dispose(); else { seen.add(k); out.push(M); } };
  push(buildFinishMaterial({ f: 'flat', c: PROXY_PALETTE.c, glow: 2 }, null));
  push(buildFinishMaterial({ f: 'flat', c: PROXY_PALETTE.c, lens: 0.16 }, null));
  push(buildFinishMaterial({ f: 'flat', c: PROXY_PALETTE.c }, null));
  for (const name of Object.keys(RECIPES)) {
    const T = texSet(renderFinish(name, { ...PROXY_PALETTE, cols: PROXY_PALETTE.cols.slice() }, PROXY_SIZE));
    push(buildFinishMaterial({ f: name, ...PROXY_PALETTE }, T));
    if (T.emissiveMap) push(buildFinishMaterial({ f: name, ...PROXY_PALETTE, glowColor: '#ffffff' }, T));
  }
  PROXIES = Object.freeze(out);
  return PROXIES;
}

let PROXY_MESHES = null;
/** Una malla chica por material de muestra (dan sombra, como las armas). Las usan el juego y la armería, de a una corrida por vez. */
export function finishProxyMeshes() {
  if (PROXY_MESHES) return PROXY_MESHES;
  const box = new THREE.BoxGeometry(0.1, 0.1, 0.1);
  PROXY_MESHES = Object.freeze(finishProxyMaterials().map((M) => { const m = new THREE.Mesh(box, M); m.castShadow = true; m.name = 'muestra'; return m; }));
  return PROXY_MESHES;
}

/** Las texturas de un acabado si ya están en caché (null si faltan o si es liso). O(1). */
export function cachedFinishTextures(spec) {
  const F = parseFinish(spec);
  return F.f === 'flat' ? null : TEX_CACHE.get(textureKey(F)) || null;
}

//  El horno: Workers con el MISMO renderFinish (mismos bytes) calculan las
//  texturas en otros hilos y las devuelven como buffers transferidos. El menú
//  no tiene ratos libres (24 ragdolls por cuadro): en el hilo principal la
//  precarga o no avanzaba o trababa el fondo; en los Workers cuesta cero.
//  Las 46 texturas de las 104 armas: 5,2 s con un Worker, ~1,8 s con tres.

/** Workers del horno: hasta 3, dejando dos núcleos para el juego y el navegador. */
const OVEN_MAX_WORKERS = 3;
let OVEN = null;                 // null: sin crear · false: no hay Worker (se calcula acá) · {workers, jobs, next}

function oven() {
  if (OVEN !== null) return OVEN;
  if (typeof Worker === 'undefined') return (OVEN = false);
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  const n = Math.max(1, Math.min(OVEN_MAX_WORKERS, cores - 2));
  try {
    const O = { workers: [], jobs: new Map(), next: 1 };
    for (let i = 0; i < n; i++) {
      const worker = new Worker(new URL('./finish_worker.js', import.meta.url), { type: 'module' });
      const slot = { worker, load: 0 };
      worker.onmessage = (e) => ovenDone(O, slot, e.data);
      worker.onerror = (e) => ovenFailed(O, e);
      O.workers.push(slot);
    }
    OVEN = O;
  } catch (err) {
    console.warn('horno de texturas sin Worker:', err);
    OVEN = false;
  }
  return OVEN;
}

/** Llegó una textura horneada: a la caché (si nadie la calculó acá mientras tanto) y a quien la esperaba. */
function ovenDone(O, slot, { id, px, error }) {
  const job = O.jobs.get(id);
  if (!job) return;
  O.jobs.delete(id);
  slot.load--;
  if (error) { job.reject(new Error(`horno: ${job.key}: ${error}`)); return; }
  if (!TEX_CACHE.has(job.key)) TEX_CACHE.set(job.key, texSet(px));
  job.resolve(TEX_CACHE.get(job.key));
}

/** Un Worker no arrancó o se cayó: lo pendiente se calcula acá y el horno no se usa más. */
function ovenFailed(O, e) {
  console.warn('horno de texturas sin Worker:', e.message || e);
  if (e.preventDefault) e.preventDefault();
  const pending = [...O.jobs.values()];
  O.jobs.clear();
  for (const s of O.workers) s.worker.terminate();
  OVEN = false;
  for (const job of pending) { try { job.resolve(finishTextures(job.F)); } catch (err) { job.reject(err); } }
}

/** Manda un trabajo al Worker menos cargado. O(workers). */
function ovenPost(O, key, F) {
  return new Promise((resolve, reject) => {
    let best = O.workers[0];
    for (const s of O.workers) if (s.load < best.load) best = s;
    const id = O.next++;
    O.jobs.set(id, { key, F, resolve, reject });
    best.load++;
    best.worker.postMessage({ id, name: F.f, params: renderParams(F) });
  });
}

/**
 * Hornea en segundo plano las texturas que falten de estas specs y las deja
 * en la caché (una por clave: las «tint» se piden una sola vez). Resuelve
 * con {baked, cached, sets}: cuántas se hornearon, cuántas ya estaban y los
 * juegos de texturas (para subirlos a la placa de a uno). Sin Worker, las
 * calcula acá de a una por tarea. O(specs) mensajes; el cálculo, en otro hilo.
 */
export async function bakeFinishes(specs) {
  const byKey = new Map(), seen = new Set();
  let cached = 0;
  for (const spec of specs) {
    const F = parseFinish(spec);
    if (F.f === 'flat') continue;
    const key = textureKey(F);
    if (seen.has(key)) continue;          // una clave, una vez (las «tint» comparten para cualquier color)
    seen.add(key);
    if (TEX_CACHE.has(key)) cached++; else byKey.set(key, F);
  }
  const O = oven();
  const jobs = [...byKey].map(([key, F]) => (O
    ? ovenPost(O, key, F)
    : new Promise((resolve) => setTimeout(resolve, 0)).then(() => finishTextures(F))));
  const sets = await Promise.all(jobs);
  return { baked: sets.length, cached, sets };
}

/** Cuántas texturas y materiales hay en caché (para el HUD de rendimiento y las pruebas). */
export function finishStats() {
  let bytes = 0;
  for (const T of TEX_CACHE.values()) for (const k of ['map', 'normalMap', 'roughnessMap', 'emissiveMap']) if (T[k]) bytes += T[k].image.data.length * 4 / 3;
  return { textures: TEX_CACHE.size, materials: MAT_CACHE.size, bytes: Math.round(bytes) };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Reflejo de estudio: un domo con degradé y tres cajas de luz, prefiltrado
//  con PMREM una sola vez. Sólo lo usan las armas: el metal deja de verse
//  negro sin cambiar la iluminación del nivel.
// ═════════════════════════════════════════════════════════════════════════════

export function makeStudioEnvironment(renderer) {
  const scene = new THREE.Scene();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: /* glsl */`varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`varying vec3 vP;
      void main(){
        float y = vP.y;
        vec3 floorC = vec3(0.035, 0.037, 0.045), horizon = vec3(0.24, 0.25, 0.28), sky = vec3(0.52, 0.54, 0.58);
        vec3 c = y < 0.0 ? mix(horizon, floorC, smoothstep(0.0, -0.5, y)) : mix(horizon, sky, smoothstep(0.0, 0.8, y));
        gl_FragColor = vec4(c, 1.0);
      }`,
  }));
  scene.add(dome);
  const box = (w, h, color, k, x, y, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(x, y, z); m.lookAt(0, 0, 0); scene.add(m);
  };
  box(6, 2.2, 0xfff4e6, 7.0, 0, 7, 2);        // principal, arriba y adelante
  box(2.2, 6, 0xcfe0ff, 3.6, -7, 1.5, -3);    // contraluz frío
  box(2.2, 4, 0xffd9b0, 2.4, 7, 0.5, 1);      // relleno cálido
  box(8, 0.5, 0xffffff, 3.0, 0, 2.5, 8);      // tira horizontal al frente: la línea de brillo que recorre caños y correderas
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(scene, 0.035);
  pm.dispose();
  dome.geometry.dispose(); dome.material.dispose();
  return rt.texture;
}

/** El reflejo de estudio para todos los materiales de armas (los que ya existen y los que vengan). */
export function setWeaponEnvironment(tex, intensity = ENV_INTENSITY) {
  ENV = tex; ENV_INTENSITY = intensity;
  for (const M of MAT_CACHE.values()) if (M.isMeshStandardMaterial) { M.envMap = tex; M.envMapIntensity = intensity; M.needsUpdate = true; }
}

/** Intensidad del reflejo (la galería la sube; en el juego queda baja para no desentonar de noche). */
export function setWeaponEnvIntensity(k) {
  ENV_INTENSITY = k;
  for (const M of MAT_CACHE.values()) if (M.isMeshStandardMaterial && M.envMap) M.envMapIntensity = k;
}
