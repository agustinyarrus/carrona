// ─────────────────────────────────────────────────────────────────────────────
//  armory.js — La armería: las 104 armas en miniaturas 3D y una vista previa
//  en vivo donde el arma elegida DISPARA contra un blanco de acero.
//
//  La vista previa no es un video: es el mismo armero (gunsmith), los mismos
//  efectos (shotfx, fx) y la MISMA balística del juego, corriendo sobre un
//  mundo de mentira (piso, blanco y pared) con un sumidero que sólo dibuja.
//  Lo que ves acá es exactamente lo que dispara el juego.
//
//  Cómo se dibuja sin un segundo contexto WebGL: mientras la armería está
//  abierta el juego no dibuja su escena; este módulo limpia el lienzo,
//  renderiza la vista previa en un render target con MSAA y la pasa por el
//  OutputPass (tone mapping + sRGB) directo al rectángulo de pantalla que
//  ocupa el panel del DOM (viewport + scissor). Las miniaturas van a otro
//  target y se leen SIN esperar a la placa (WebGL2: readPixels a un PBO y un
//  fence; se cosechan cuadros después, cuando la placa terminó) y se pintan
//  en un <canvas> por carta, con un presupuesto de milisegundos por cuadro:
//  se llenan de a poco sin trabar el menú. El readPixels síncrono de antes
//  esperaba a la placa en cada foto: 650 ms de cada 2,5 s.
//
//  La primera vez que se abre, sus dos escenas (otras luces que el juego:
//  otros programas de shader) se precompilan en segundo plano con las
//  muestras de todos los acabados; hasta que terminan, el panel queda en el
//  color de fondo en vez de congelar la pantalla compilando.
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { WEAPONS } from '../game/catalog.js';
import { Ballistics } from '../game/ballistics.js';
import { instantiateWeapon, animateWeapon, kickWeapon } from './gunsmith.js';
import { setWeaponEnvIntensity, finishProxyMeshes } from './finishes.js';
import { ShotFX } from './shotfx.js';
import { FX } from './fx.js';

const BG = 0x06070a;
const FLOOR_Y = -0.3;
const THUMB_W = 256, THUMB_H = 128;
const THUMB_BUDGET_MS = 10;               // por cuadro: el menú sigue a 60 aunque falten miniaturas
const THUMB_INFLIGHT = 3;                 // lecturas de miniatura en vuelo (cada una en su PBO)
const IDLE_BETWEEN = 1.9;                 // segundos entre ráfagas de muestra

/**
 * Mundo de mentira para la balística: cajas alineadas a los ejes y el piso.
 * Sin huesos (nadie a quien pegarle): raycastBones siempre falla.
 */
class PreviewWorld {
  constructor() { this.boxes = []; this.bmeta = []; this.groundY = FLOOR_Y; this.groundHX = 40; this.groundHZ = 40; }
  raycastBones() { return false; }
  lineOfSight() { return true; }
  /** Rayo contra el piso y las cajas (prueba de losas). Devuelve t o -1. O(cajas). */
  raycastStatic(ox, oy, oz, dx, dy, dz, maxT, out) {
    let best = maxT, found = false;
    if (dy < -1e-6) {
      const t = (FLOOR_Y - oy) / dy;
      if (t > 0 && t < best) { best = t; found = true; out.t = t; out.x = ox + dx * t; out.y = FLOOR_Y; out.z = oz + dz * t; out.nx = 0; out.ny = 1; out.nz = 0; out.box = null; }
    }
    for (const B of this.boxes) {
      let tmin = 0, tmax = best, axis = -1, sg = 1;
      const o = [ox - B.cx, oy - B.cy, oz - B.cz], d = [dx, dy, dz], e = [B.hx, B.hy, B.hz];
      let ok = true;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(d[k]) < 1e-9) { if (o[k] < -e[k] || o[k] > e[k]) { ok = false; break; } continue; }
        let t1 = (-e[k] - o[k]) / d[k], t2 = (e[k] - o[k]) / d[k], s = -1;
        if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
        if (t1 > tmin) { tmin = t1; axis = k; sg = s; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) { ok = false; break; }
      }
      if (!ok || tmin <= 0 || tmin >= best) continue;
      best = tmin; found = true;
      out.t = tmin; out.x = ox + dx * tmin; out.y = oy + dy * tmin; out.z = oz + dz * tmin; out.box = B;
      out.nx = axis === 0 ? sg : 0; out.ny = axis === 1 ? sg : 0; out.nz = axis === 2 ? sg : 0;
    }
    return found ? best : -1;
  }
}

export class Armory {
  /**
   * @param R      el Renderer del juego (se comparte el contexto WebGL)
   * @param audio  GameAudio (los tiros de muestra suenan)
   */
  constructor(R, audio) {
    this.R = R; this.audio = audio;
    this.active = false;
    this.key = null; this.inst = null;
    this.viewEl = null;
    this.thumbQueue = [];
    this.thumbDone = new Map();          // clave → canvas ya pintado
    this.orbitAz = -0.18; this.orbitEl = 0.3; this.zoom = 1;
    this.t = 0; this.phase = 'idle'; this.phaseT = 0.6; this.shotsLeft = 0; this.spin = 0;
    this.sound = true;
    this._built = false;
    this.ready = false;                  // shaders de sus escenas compilados (ver _warm)
    this.warmStats = null;
  }

  // ── escena (se arma la primera vez que se abre) ──────────────────────────
  _build() {
    if (this._built) return;
    this._built = true;
    const scene = this.scene = new THREE.Scene();
    // ciclorama oscuro: degradé vertical, el piso se funde con el fondo
    const dome = new THREE.Mesh(new THREE.SphereGeometry(30, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      vertexShader: /* glsl */`varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`varying vec3 vP; void main(){ float y = vP.y; vec3 c = mix(vec3(0.012,0.013,0.018), vec3(0.05,0.055,0.07), smoothstep(-0.1, 0.5, y)); gl_FragColor = vec4(c, 1.0); }`,
    }));
    scene.add(dome);
    this.dome = dome;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(12, 48), new THREE.MeshStandardMaterial({ color: 0x0d0e12, roughness: 0.92, metalness: 0.0 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = FLOOR_Y; floor.receiveShadow = true;
    scene.add(floor);
    this.floor = floor;
    scene.add(new THREE.HemisphereLight(0x8e9ab8, 0x16140f, 0.5));
    const key = this.keyLight = new THREE.DirectionalLight(0xfff1dc, 2.2);
    key.position.set(-1.5, 4, 3); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -4, right: 6, top: 4, bottom: -4, near: 0.5, far: 14 });
    key.shadow.bias = -0.0006; key.shadow.normalBias = 0.02;
    scene.add(key); scene.add(key.target);
    const rim = new THREE.DirectionalLight(0xb8ccff, 1.3); rim.position.set(3, 2, -4); scene.add(rim);
    this.flashLight = new THREE.PointLight(0xffd39a, 0, 6, 2);
    scene.add(this.flashLight);
    this._flashT = 0;
    // blanco de acero con su poste, y una pared de hormigón atrás
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa1aa, roughness: 0.35, metalness: 0.85 });
    this.plate = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.46, 0.46), steel);
    this.plate.castShadow = true;
    this.pole = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.5, 0.03), new THREE.MeshStandardMaterial({ color: 0x2a2c31, roughness: 0.7 }));
    this.wall = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.6, 7), new THREE.MeshStandardMaterial({ color: 0x3b3d42, roughness: 0.95 }));
    this.wall.receiveShadow = true;
    scene.add(this.plate); scene.add(this.pole); scene.add(this.wall);
    this.cam = new THREE.PerspectiveCamera(30, 1.6, 0.05, 60);
    // la balística de verdad sobre el mundo de mentira
    this.world = new PreviewWorld();
    this.fx = new FX(scene, this.world);
    this.shotfx = new ShotFX(scene, { glow: 2048, smoke: 512, projectiles: 24, light: (x, y, z, c, k, d) => this._pulse(x, y, z, c, k, d) });
    this.ballistics = new Ballistics({ world: this.world, fx: this.shotfx, sink: this._sink(), rng: Math.random });
    this.out = new OutputPass();
    this.out.renderToScreen = true;
    this.thumbOut = new OutputPass();
    this.thumbOut.renderToScreen = false;
    this.rt = null;
    this.thumbRT = new THREE.WebGLRenderTarget(THUMB_W, THUMB_H, { type: THREE.HalfFloatType, samples: 4 });
    this.thumbRead = new THREE.WebGLRenderTarget(THUMB_W, THUMB_H, { type: THREE.UnsignedByteType });
    this.thumbPx = new Uint8Array(THUMB_W * THUMB_H * 4);
    this.thumbImg = new ImageData(THUMB_W, THUMB_H);      // uno solo, reusado (antes: 128 KB de basura por foto)
    const gl = this.R.renderer.getContext();
    this.pbo = Array.from({ length: THUMB_INFLIGHT }, () => {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, THUMB_W * THUMB_H * 4, gl.STREAM_READ);
      return { buf, sync: null, key: null, canvas: null };
    });
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.thumbCam = new THREE.PerspectiveCamera(20, THUMB_W / THUMB_H, 0.05, 20);
    // las miniaturas salen de ESTA escena con todo apagado menos las luces y el arma (ver
    // _isolate): lo que vuela en la vista previa no se cuela en la foto, y como las luces son
    // las mismas, los programas de shader también (antes, una escena aparte con otras luces
    // pedía otra tanda de programas y la placa se trababa medio segundo compilándolos)
    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._v3 = new THREE.Vector3();
    this._warm();
  }

  /**
   * Precompila en segundo plano la escena (vista previa y miniaturas) con las
   * muestras de todos los acabados, compartiendo el precompilador del juego
   * (las corridas se encadenan). Si falla, se dibuja igual, compilando en el cuadro.
   */
  _warm() {
    this.R.warmup.run(this.scene, this.cam, finishProxyMeshes())
      .then((st) => { this.warmStats = st; })
      .catch((e) => console.error('precompilado de la armería:', e))
      .finally(() => { this.ready = true; });
  }

  _sink() {
    return {
      hitBody: () => ({ killed: false, zone: 1, damage: 0, severed: false }),
      hitStatic: (H, def, info) => {
        if (info.kind === 'bounce' || info.kind === 'stick') { if (this.sound) this.audio.thunk(undefined, undefined, true); return; }
        const k = def.shot.kind;
        if (k === 'beam' || k === 'rail') this.fx.scorch(H.x, H.y, H.z, k === 'rail' ? 0.12 : 0.06, H.nx, H.ny, H.nz);
        else {
          this.fx.splat(H.x, H.y, H.z, 0.025 + Math.random() * 0.02, 0.07, 0.07, 0.08, H.nx, H.ny, H.nz);
          this.shotfx.sparks(H.x, H.y, H.z, H.nx, H.ny, H.nz, 6, '#ffcf8a', 0.55);
          this.shotfx.puff(H.x + H.nx * 0.03, H.y + H.ny * 0.03, H.z + H.nz * 0.03, H.nx * 0.4, 0.2, H.nz * 0.4, 0.05, 0.8, 0xa9adb5, 0.3);
        }
      },
      targets: () => [],
      applyStatus: () => {}, selfBlast: () => {}, alert: () => {},
      onExplosion: (x, y, z, r) => { this.fx.scorch(x, FLOOR_Y + 0.001, z, r * 0.3, 0, 1, 0); if (this.sound) this.audio.explosion(undefined, undefined, Math.min(1, r / 3)); },
    };
  }

  _pulse(x, y, z, color, k, dist) {
    const L = this.flashLight;
    L.position.set(x, y + 0.05, z); L.color.set(color); L.intensity = Math.min(8, k * 0.12); L.distance = Math.min(6, dist * 0.5);
    this._flashT = 0.07;
  }

  // ── abrir, cerrar, elegir ─────────────────────────────────────────────────
  open(viewEl) {
    this._build();
    this.viewEl = viewEl;
    this.active = true;
    setWeaponEnvIntensity(1.0);            // en el estudio el metal brilla de verdad
    this.R.setPixelRatioOverride(Math.min(window.devicePixelRatio || 1, 1.5));
  }
  close() {
    this.active = false;
    setWeaponEnvIntensity(0.35);
    this.R.setPixelRatioOverride(null);
    this.ballistics.clear(); this.shotfx.clear(); this.fx.clear();
  }

  /** Muestra un arma: la instancia en el estudio, el blanco a la distancia justa y la ráfaga arranca. */
  select(key) {
    if (!WEAPONS[key] || !this._built) return;
    if (this.inst) this.scene.remove(this.inst.group);
    this.key = key;
    this.def = WEAPONS[key];
    this.inst = instantiateWeapon(this.def);
    const g = this.inst.group;
    g.rotation.set(0, Math.PI / 2, 0);     // +Z del arma → +X del estudio (apunta al blanco)
    g.position.set(-this.inst.proto.bounds.max.z * 0.35, 0, 0);
    this.scene.add(g);
    g.traverse(o => { if (o.isMesh) o.castShadow = true; });
    const len = this.inst.proto.length;
    this.len = len;
    // encuadre: ancho visible W con el arma en la mitad izquierda y el blanco a la derecha;
    // los explosivos llevan el blanco más lejos (la bola de fuego no se come el arma)
    const explosive = (this.def.shot.kind === 'proj' && this.def.shot.proj.radius > 0) || !!(this.def.shot.fx && this.def.shot.fx.he);
    const gap = explosive ? 2.4 : Math.max(0.55, len * 0.75);
    const W = Math.max(0.95, len * 2.05, (len + gap) / 0.82);
    const x0 = g.position.x + this.inst.proto.bounds.min.z, x1 = g.position.x + this.inst.proto.bounds.max.z;
    const px = x1 + gap;
    this.frameW = W;
    this.camTX = x0 - W * 0.08 + W * 0.5;
    const ps = Math.min(1.4, Math.max(0.5, W * 0.2 / 0.46));      // el blanco se ve del mismo tamaño en cualquier encuadre
    this.plate.scale.set(1, ps, ps);
    this.plate.position.set(px, 0.02, -0.05);
    this.pole.position.set(px + 0.02, FLOOR_Y + 0.14, -0.05);
    this.wall.position.set(px + 1.4 + W * 0.2, FLOOR_Y + 1.3, 0);
    this.world.boxes = [
      { cx: px, cy: 0.02, cz: -0.05, hx: 0.0175, hy: 0.23 * ps, hz: 0.23 * ps },
      { cx: this.wall.position.x, cy: FLOOR_Y + 1.3, cz: 0, hx: 0.15, hy: 1.3, hz: 3.5 },
    ];
    this.keyLight.target.position.set(px * 0.4, 0, 0);
    this.ballistics.clear(); this.shotfx.clear(); this.fx.clear();
    this.phase = 'idle'; this.phaseT = 0.45; this.spin = 0;
  }

  /** Ráfaga ya (botón DISPARAR). */
  fireNow() { if (this.def) { this.phase = 'idle'; this.phaseT = 0; } }
  /** Arrastrar sobre la vista previa: orbita la cámara. */
  orbit(dx, dy) {
    this.orbitAz = THREE.MathUtils.clamp(this.orbitAz + dx * 0.006, -1.4, 0.9);
    this.orbitEl = THREE.MathUtils.clamp(this.orbitEl + dy * 0.004, 0.02, 1.2);
  }
  zoomBy(k) { this.zoom = THREE.MathUtils.clamp(this.zoom * k, 0.55, 1.8); }

  /** Pide la miniatura de un arma para un <canvas> (se pinta cuando le toca en la cola). */
  requestThumb(key, canvas) {
    const done = this.thumbDone.get(key);
    if (done) { canvas.getContext('2d').drawImage(done, 0, 0); canvas.dataset.ready = '1'; return; }
    this.thumbQueue.push({ key, canvas });
  }
  get thumbsPending() { return this.thumbQueue.length + (this.pbo ? this.pbo.reduce((n, s) => n + (s.sync ? 1 : 0), 0) : 0); }

  // ── el ciclo de muestra: esperar, disparar una ráfaga típica del arma ─────
  _step(dt) {
    const d = this.def, inst = this.inst;
    if (!d || !inst) return;
    this.t += dt;
    // flota apenas: se nota que está viva
    inst.group.position.y = Math.sin(this.t * 1.3) * 0.012;
    let wantSpin = 0;
    this.phaseT -= dt;
    if (this.phase === 'idle') {
      if (this.phaseT <= 0) {
        this.phase = 'burst';
        const k = d.shot.kind;
        this.shotsLeft = k === 'spray' ? Math.round(d.rate * 1.3) : d.burst ? d.burst : d.windup && d.auto ? 18 : d.auto ? Math.min(d.mag, Math.max(5, Math.round(d.rate * 0.7))) : Math.min(d.mag, d.rate > 3 ? 3 : d.mag >= 2 ? 2 : 1);
        this.phaseT = d.windup ? d.windup : 0;
      }
    } else if (this.phase === 'burst') {
      wantSpin = 1;
      if (this.phaseT <= 0 && (!d.windup || this.spin >= 0.98)) {
        this._fire();
        this.shotsLeft--;
        const cad = d.burst ? 1 / d.burstRate : 1 / d.rate;
        this.phaseT = cad;
        if (this.shotsLeft <= 0) { this.phase = 'idle'; this.phaseT = IDLE_BETWEEN + (d.shot.kind === 'proj' ? 0.8 : 0); }
      }
    }
    if (d.windup) this.spin = THREE.MathUtils.clamp(this.spin + (wantSpin ? dt / d.windup : -dt / (d.windup * 1.6)), 0, 1);
    animateWeapon(inst, dt, this.spin);
    this.ballistics.update(dt);
    this.fx.update(dt);
    this.shotfx.update(dt);
    this.shotfx.drawProjectiles(this.ballistics.projectiles);
    if (this._flashT > 0) { this._flashT -= dt; if (this._flashT <= 0) this.flashLight.intensity = 0; }
  }

  _fire() {
    const d = this.def, inst = this.inst, g = inst.group;
    g.updateMatrixWorld(true);
    const m = this._v.copy(inst.muzzles[inst.muzzleIdx++ % inst.muzzles.length]).applyMatrix4(g.matrixWorld);
    // apunta al blanco con un poco de dispersión de mano
    const tx = this.plate.position.x, ty = this.plate.position.y + (Math.random() - 0.5) * 0.18, tz = this.plate.position.z + (Math.random() - 0.5) * 0.18;
    let dx = tx - m.x, dy = ty - m.y, dz = tz - m.z;
    const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
    let rear = null;
    if (inst.proto.backblast) rear = this._v3.copy(inst.rear).applyMatrix4(g.matrixWorld);
    // el blanco está a un metro o dos: los proyectiles directos se resuelven hasta él, sin el mínimo del mouse
    this.ballistics.fire(d, { shooter: null, mx: m.x, my: m.y, mz: m.z, ox: m.x, oy: m.y, oz: m.z, dx, dy, dz, aimX: tx, aimY: ty, aimZ: tz, aimMin: 0, rear });
    const cas = d.shot.casing;
    if (cas && cas !== 'none') { const e = this._v2.copy(inst.eject).applyMatrix4(g.matrixWorld); this.fx.shell(e.x, e.y, e.z, -dz * 0.6 + dx * 0.4, dx * 0.6 + dz * 0.4 + 0.5, 1, cas); }
    kickWeapon(inst);
    if (this.sound) this.audio.shot(d);
  }

  // ── cámara: orbita alrededor del punto entre el arma y el blanco ─────────
  _camera(aspect) {
    const c = this.cam;
    c.aspect = aspect; c.updateProjectionMatrix();
    // distancia para que entre el ancho W del encuadre (el campo horizontal sale del vertical y el aspecto)
    const hf = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(c.fov) / 2) * aspect);
    const W = this.frameW || 1.2, tx = this.camTX ?? 0.4;
    const dist = (W / 2) / Math.tan(hf / 2) * this.zoom;
    const ce = Math.cos(this.orbitEl);
    c.position.set(tx + Math.sin(this.orbitAz) * ce * dist, 0.02 + Math.sin(this.orbitEl) * dist, Math.cos(this.orbitAz) * ce * dist);
    c.lookAt(tx, 0.0, 0);
  }

  // ── miniaturas: un arma por vez, con presupuesto por cuadro ──────────────
  /**
   * Cosecha las fotos que la placa ya terminó y siembra nuevas mientras haya
   * PBO libre y presupuesto. Nunca espera a la placa: clientWaitSync con
   * tiempo 0 sólo pregunta. O(miniaturas por cuadro).
   */
  _thumbs(budgetMs) {
    const r = this.R.renderer, gl = r.getContext(), t0 = performance.now();
    for (const slot of this.pbo) {
      if (!slot.sync) continue;
      const st = gl.clientWaitSync(slot.sync, 0, 0);
      if (st === gl.TIMEOUT_EXPIRED) continue;
      if (st === gl.WAIT_FAILED) console.warn('miniatura: el fence falló, se lee igual');
      gl.deleteSync(slot.sync); slot.sync = null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buf);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.thumbPx);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this._paintThumb(slot.key, slot.canvas, this.thumbPx);
      slot.key = null; slot.canvas = null;
    }
    if (!this.thumbQueue.length) return;
    const scene = this.scene;
    let sown = false, hidden = null;
    while (this.thumbQueue.length && performance.now() - t0 < budgetMs) {
      const slot = this.pbo.find(s => !s.sync);
      if (!slot) break;
      const { key, canvas } = this.thumbQueue.shift();
      if (this.thumbDone.has(key)) { canvas.getContext('2d').drawImage(this.thumbDone.get(key), 0, 0); canvas.dataset.ready = '1'; continue; }
      const inst = instantiateWeapon(WEAPONS[key]);
      const g = inst.group, b = inst.proto.bounds;
      if (!hidden) hidden = this._isolate();
      scene.add(g);
      const c = new THREE.Vector3(); b.getCenter(c); const size = new THREE.Vector3(); b.getSize(size);
      const cam = this.thumbCam;
      const dir = new THREE.Vector3(-0.92, 0.36, 0.14).normalize();
      const vf = THREE.MathUtils.degToRad(cam.fov), hf = 2 * Math.atan(Math.tan(vf / 2) * cam.aspect);
      const dist = Math.max((Math.max(size.z, size.x) * 0.5 + 0.02) / Math.tan(hf / 2), (size.y * 0.5 + 0.02) / Math.tan(vf / 2)) * 1.05 + size.x;
      cam.position.copy(c).addScaledVector(dir, dist); cam.lookAt(c);
      r.setRenderTarget(this.thumbRT);
      r.setClearColor(0x000000, 0); r.clear(true, true, true);
      r.render(scene, cam);
      this.thumbOut.render(r, this.thumbRead, this.thumbRT);
      scene.remove(g);
      // lectura al PBO: la placa la hace en orden, después de dibujar; el fence avisa cuándo terminó
      r.setRenderTarget(this.thumbRead);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buf);
      gl.readPixels(0, 0, THUMB_W, THUMB_H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      slot.key = key; slot.canvas = canvas;
      sown = true;
    }
    if (hidden) this._unisolate(hidden);
    if (sown) gl.flush();                  // que la placa arranque ya con lo pedido
    r.setRenderTarget(null);
  }

  /** Para la foto: apaga todo lo que no es luz (blanco, piso, efectos, el arma de la vista previa) y el fogonazo. */
  _isolate() {
    const off = [];
    for (const o of this.scene.children) if (!o.isLight && o.visible) { o.visible = false; off.push(o); }
    const flash = this.flashLight.intensity;
    this.flashLight.intensity = 0;
    return { off, flash };
  }
  _unisolate({ off, flash }) {
    for (const o of off) o.visible = true;
    this.flashLight.intensity = flash;
  }

  /** Una foto leída (filas de abajo hacia arriba) a su carta y a la caché. O(píxeles). */
  _paintThumb(key, canvas, src) {
    const img = this.thumbImg, dst = img.data, row = THUMB_W * 4;
    for (let y = 0; y < THUMB_H; y++) dst.set(src.subarray((THUMB_H - 1 - y) * row, (THUMB_H - y) * row), y * row);
    const off = document.createElement('canvas'); off.width = THUMB_W; off.height = THUMB_H;
    off.getContext('2d').putImageData(img, 0, 0);
    this.thumbDone.set(key, off);
    canvas.getContext('2d').drawImage(off, 0, 0);
    canvas.dataset.ready = '1';
  }

  /**
   * Un cuadro de la armería: lienzo limpio, miniaturas pendientes y la vista
   * previa en el rectángulo del panel. Deja el renderer como lo encontró.
   */
  draw(dt) {
    if (!this.active || !this._built) return;
    const r = this.R.renderer, R = this.R;
    // el rectángulo del panel se lee ANTES de tocar el DOM en este cuadro (las miniaturas lo
    // tocan): leído después, obligaba a recalcular el layout de las 104 cartas en cada cuadro
    const rect = this.viewEl ? this.viewEl.getBoundingClientRect() : null;
    if (!this.ready) {
      // compilando en segundo plano: el lienzo al color de fondo, sin dibujar nada que espere un shader
      r.setRenderTarget(null); r.setScissorTest(false); r.setViewport(0, 0, R.width, R.height);
      r.setClearColor(BG, 1); r.clear(true, true, false);
      return;
    }
    const exposure = r.toneMappingExposure;
    r.toneMappingExposure = 1.05;
    this._thumbs(THUMB_BUDGET_MS);
    this._step(dt);
    // todo el lienzo al color de fondo (el juego no dibuja mientras la armería está abierta)
    r.setRenderTarget(null);
    r.setScissorTest(false);
    r.setViewport(0, 0, R.width, R.height);
    r.setClearColor(BG, 1); r.clear(true, true, false);
    if (rect && this.inst) {
      const w = Math.max(2, Math.floor(rect.width)), h = Math.max(2, Math.floor(rect.height));
      const pr = r.getPixelRatio();
      const W = Math.floor(w * pr), H = Math.floor(h * pr);
      if (!this.rt || this.rt.width !== W || this.rt.height !== H) {
        if (this.rt) this.rt.dispose();
        this.rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 });
      }
      this._camera(w / h);
      r.setRenderTarget(this.rt);
      r.setClearColor(BG, 1); r.clear(true, true, true);
      r.render(this.scene, this.cam);
      // al rectángulo del panel: viewport + scissor (coordenadas de GL: y desde abajo)
      const y = R.height - rect.bottom;
      r.setRenderTarget(null);
      r.setViewport(rect.left, y, w, h);
      r.setScissor(rect.left, y, w, h);
      r.setScissorTest(true);
      this.out.render(r, null, this.rt);
      r.setScissorTest(false);
      r.setViewport(0, 0, R.width, R.height);
    }
    r.toneMappingExposure = exposure;
  }
}
