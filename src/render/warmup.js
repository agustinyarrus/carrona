// ─────────────────────────────────────────────────────────────────────────────
//  warmup.js — Que ningún shader se compile en medio de la partida.
//
//  Three compila el programa de un material la primera vez que lo dibuja, y
//  ese programa depende del material Y de la escena: cuántas luces visibles
//  hay, si hay niebla, si se dibuja a un render target (el compositor: sin
//  tone mapping, salida lineal). En esta máquina un programa con veinte luces
//  tarda 150–300 ms en compilar y el primer tiro (fogonazo, casquillos,
//  chispas, estela) congelaba la pantalla varios segundos.
//
//  La receta tiene tres partes y las tres hacen falta:
//   1. topología de luces fija (Renderer.fixLightTopology): ninguna luz se
//      prende ni se apaga con `visible`, sólo cambia su intensidad, y todos
//      los mapas tienen la misma cantidad de luces puntuales;
//   2. compilar la escena ENTERA, con lo invisible (piscinas de efectos sin
//      instancias) y muestras de lo que todavía no existe (un arma con cada
//      estructura de material, los carteles de premio), con un render target
//      puesto como en el pase real; en tandas por cuadro, cada raíz con las
//      luces de la escena (compile(raíz, cámara, escena));
//   3. KHR_parallel_shader_compile compila en otros hilos: mientras tanto el
//      juego sigue dibujando, porque las muestras nunca están en la escena
//      mientras compilan (si estuvieran, se dibujarían y el cuadro se
//      trabaría esperándolas).
//  Después, el estreno de cada programa (Three le pregunta a la placa por cada
//  uniforme: una ida y vuelta por uniforme) va de a unos por cuadro, y al
//  final UN cuadro de ensayo de 16×16 con las muestras a la vista sube las
//  texturas, arma los VAO y compila los programas de sombra, que compile()
//  no ve.
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';

/** Lado del blanco de ensayo: para la clave del programa sólo importa que HAYA un render target. */
const PROBE_SIZE = 16;
/** Adelante de la cámara: ahí las sombras de la luna (que sigue al objetivo) ven las muestras. */
const SAMPLE_AHEAD = 3;
/** Milisegundos de trabajo por cuadro (pedir compilación, estrenar programas) si nadie pide otro presupuesto. */
const COMPILE_BUDGET_MS = 8;
/** Espera máxima por cuadro (si la pestaña no dibuja, igual se sigue) y cada cuánto se pregunta si la placa terminó. */
const PRIME_WAIT_MS = 50;
const READY_POLL_MS = 10;

const _dir = new THREE.Vector3();

export class ShaderWarmup {
  /** @param {THREE.WebGLRenderer} renderer */
  constructor(renderer) {
    this.renderer = renderer;
    this.probe = new THREE.WebGLRenderTarget(PROBE_SIZE, PROBE_SIZE, { type: THREE.HalfFloatType, depthBuffer: true });
    this.runs = 0;
    this.last = null;
    this._chain = Promise.resolve();
  }

  /**
   * Compila en segundo plano todo lo que `scene` puede dibujar desde
   * `camera`, más las `samples` (objetos sueltos que todavía no están en la
   * escena), y después ensaya un cuadro. Las corridas se encadenan: dos
   * pedidos seguidos no pelean por la escena. `budgetMs`: milisegundos de
   * trabajo por cuadro (chico si hay algo a la vista que no se puede trabar,
   * grande detrás de una cortina o de la compuerta). O(materiales).
   * @returns {Promise<{programs:number, fresh:number, materials:number, compileMs:number, primeMs:number, renderMs:number}>}
   *   compileMs: hasta que la placa terminó (en otros hilos) · primeMs: el estreno repartido en
   *   cuadros · renderMs: el cuadro de ensayo hasta que la placa lo terminó (ahí arma los
   *   ejecutables de cada programa) · at: marcas de performance.now() [inicio, pedido,
   *   compilado, estrenado, ensayado]
   */
  run(scene, camera, samples = [], { budgetMs = COMPILE_BUDGET_MS } = {}) {
    const job = this._chain.then(() => this._run(scene, camera, samples, budgetMs));
    this._chain = job.catch(() => null);     // un error no traba las corridas que siguen (y lo ve el que esperaba ésta)
    return job;
  }

  async _run(scene, camera, samples, budgetMs) {
    const r = this.renderer, t0 = performance.now();
    const before = r.info.programs.length;

    // 1) pedir la compilación en tandas (los hijos de la escena y cada muestra suelta), con las
    //    luces y la niebla de la escena: mandar el código de veinte programas juntos trababa un
    //    cuadro. compile(raíz, cámara, escena) suma las luces de la escena Y las de la raíz, y el
    //    nivel es UN grupo con sus luces adentro: contadas dos veces salían programas para 38
    //    luces que nadie usa. La raíz postiza de materialsOnly recorre materiales y no luces.
    //    Tamaño de tanda AIMD (como el control de congestión de TCP): crece de a una mientras
    //    entra en el presupuesto, se parte a la mitad cuando se pasa
    const roots = [...scene.children, ...samples];
    let i = 0, batch = 1, slice = performance.now();
    while (i < roots.length) {
      const part = roots.slice(i, i + batch), a = performance.now();
      this._withTarget(() => r.compile(materialsOnly(part), camera, scene));
      i += part.length;
      batch = performance.now() - a > budgetMs ? Math.max(1, batch >> 1) : batch + 1;
      if (i < roots.length && performance.now() - slice > budgetMs) { await nextFrame(); slice = performance.now(); }
    }
    // 2) la placa compila en otros hilos (KHR_parallel_shader_compile): se pregunta sin bloquear
    const tAsked = performance.now();
    const fresh = r.info.programs.slice(before);
    await allReady(fresh);
    const t1 = performance.now();

    // 3) estreno de a poco: la primera vez que se usa un programa, Three le pregunta a la
    //    placa por cada uniforme (una ida y vuelta por uniforme: 15–60 ms con veinte luces).
    //    Todos juntos en el cuadro de ensayo trababan medio segundo; de a unos por cuadro, no
    await primeInSlices(fresh, budgetMs);
    const t2 = performance.now();

    // 4) cuadro de ensayo con las muestras y todo lo que PUEDE aparecer a la vista (piscinas con
    //    cero instancias, lo invisible): texturas, VAO, ejecutables de la placa y los programas
    //    de sombra, que compile() no ve. Sin esto, el primer proyectil (una malla instanciada SIN
    //    color por instancia, a diferencia de los cuerpos) estrenaba un programa de sombra en el tiro
    const holder = new THREE.Group();
    holder.name = 'warmup';
    camera.getWorldDirection(_dir);
    holder.position.copy(camera.position).addScaledVector(_dir, SAMPLE_AHEAD);
    for (const o of samples) holder.add(o);
    holder.traverse((o) => { o.frustumCulled = false; });
    this._withTarget(() => {
      scene.add(holder);
      const shown = revealAll(scene);
      try { r.render(scene, camera); } finally { unreveal(shown); scene.remove(holder); }
    });
    for (const o of samples) holder.remove(o);
    // el ensayo hace que la placa arme los ejecutables de cada programa (ANGLE sobre D3D11: en su
    // hilo principal, cientos de ms): se espera a que termine, así nadie abre con la placa trabada
    await gpuSettled(r.getContext());
    const t3 = performance.now();
    this.runs++;
    this.last = { programs: r.info.programs.length, fresh: fresh.length, materials: countMaterials([scene, ...samples]), compileMs: t1 - t0, primeMs: t2 - t1, renderMs: t3 - t2, at: [t0, tAsked, t1, t2, t3].map(Math.round) };
    return this.last;
  }

  /** Corre `fn` con el blanco de ensayo puesto y deja el render target como estaba. */
  _withTarget(fn) {
    const r = this.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(this.probe);
    try { return fn(); } finally { r.setRenderTarget(prev); }
  }

  dispose() { this.probe.dispose(); }
}

/**
 * Estrena programas (uniformes y atributos) con `budgetMs` por cuadro:
 * entre tanda y tanda se dibuja un cuadro (o pasan PRIME_WAIT_MS si la
 * pestaña no está dibujando). O(programas).
 */
async function primeInSlices(programs, budgetMs) {
  let t0 = performance.now();
  for (const p of programs) {
    p.getUniforms();              // dispara el estreno: diagnóstico, uniformes y atributos, en caché
    if (performance.now() - t0 > budgetMs) { await nextFrame(); t0 = performance.now(); }
  }
}

/**
 * Espera a que la placa termine de compilar estos programas, preguntando cada
 * READY_POLL_MS sin bloquear (sin la extensión, isReady dice que sí de una y
 * el costo aparece en el estreno, que igual va en tandas). O(programas) por consulta.
 */
function allReady(programs) {
  const pending = new Set(programs);
  return new Promise((resolve) => {
    const check = () => {
      for (const p of pending) if (p.isReady()) pending.delete(p);
      if (pending.size === 0) resolve(); else setTimeout(check, READY_POLL_MS);
    };
    check();
  });
}

/**
 * Espera, sin bloquear, a que la placa termine todo lo pedido hasta ahora:
 * un fence de WebGL2 que se consulta con tiempo 0 cada READY_POLL_MS. Sin
 * fences (WebGL1) no espera. O(consultas).
 */
function gpuSettled(gl) {
  if (typeof gl.fenceSync !== 'function') return Promise.resolve();
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  return new Promise((resolve) => {
    const check = () => {
      if (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) { setTimeout(check, READY_POLL_MS); return; }
      gl.deleteSync(sync);
      resolve();
    };
    check();
  });
}

/** El próximo cuadro (o un rato, si la pestaña no dibuja: nunca se queda esperando para siempre). */
function nextFrame() {
  return new Promise((resolve) => {
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
    setTimeout(go, PRIME_WAIT_MS);
  });
}

/**
 * Muestra para el ensayo todo lo que puede aparecer: lo invisible se hace
 * visible y las mallas instanciadas vacías pasan a tener una instancia. Las
 * luces NO se tocan (prender una de repuesto cambiaría la topología y el
 * ensayo compilaría programas que nadie usa). Devuelve qué deshacer. O(nodos).
 */
function revealAll(scene) {
  const hidden = [], empty = [];
  scene.traverse((o) => {
    if (o.isLight) return;
    if (!o.visible) { o.visible = true; hidden.push(o); }
    if (o.isInstancedMesh && o.count === 0) { o.count = 1; empty.push(o); }
  });
  return { hidden, empty };
}
function unreveal({ hidden, empty }) {
  for (const o of hidden) o.visible = false;
  for (const o of empty) o.count = 0;
}

/**
 * Raíz postiza para compile(): recorre los materiales de varias raíces y
 * ninguna luz (las luces las pone la escena destino, una sola vez). O(1).
 */
function materialsOnly(roots) {
  return { traverse(fn) { for (const o of roots) o.traverse(fn); }, traverseVisible() { /* las luces ya las cuenta la escena */ } };
}

/** Materiales distintos en una lista de árboles. O(nodos). */
function countMaterials(roots) {
  const set = new Set();
  for (const root of roots) root.traverse((n) => { const m = n.material; if (Array.isArray(m)) m.forEach(x => set.add(x)); else if (m) set.add(m); });
  return set.size;
}

/**
 * Firma de lo que decide el programa de shader de un material de arma:
 * tipo, qué mapas tiene (no su contenido), reflejo, tone mapping, caras,
 * transparencia. Dos materiales con la misma firma comparten programa. O(1).
 */
export function programSignature(M) {
  return [M.type, !!M.map, !!M.normalMap, !!M.roughnessMap, !!M.metalnessMap, !!M.emissiveMap, !!M.envMap, M.toneMapped, M.transparent, M.side, M.vertexColors, M.flatShading, M.alphaTest > 0].join('|');
}
