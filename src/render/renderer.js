// ─────────────────────────────────────────────────────────────────────────────
//  renderer.js — Escena, luces, cámara y post.
//
//  El look: low poly de colores planos con iluminación real. Resolución
//  completa, MSAA, sombras suaves, tone mapping ACES, un bloom muy contenido
//  que sólo levanta las luces (pantallas, tubos, la linterna) y un pase final
//  de gradación. Nada pixelado.
//
//  Cámara: top-down inclinada (~60°) que sigue al jugador y se adelanta un
//  poco hacia donde apunta el mouse. Se puede girar con Q/E y acercar con la
//  rueda. La luz "de luna" fría sigue al jugador para que la sombra tenga
//  siempre resolución; la linterna del jugador es un foco con sombra propia.
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GradeShader } from './shaders.js';
import { ShaderWarmup } from './warmup.js';
import { clamp, clamp01, damp, noise2, TAU } from '../core/util.js';

//  Medido en una Iris Xe a 1686x906: "bajo" 60 fps, dpr 1.0 + MSAA 4 → 32 fps.
//  Por eso "medio" baja un poco la resolución y usa MSAA 2; el juego además
//  baja solo de calidad si los fps no llegan (ver Game.update).
//  "movil": en un teléfono los px CSS ya vienen multiplicados (dpr 2,5–3,5), así que el preset
//  no se define por dpr sino por ANCHO de render en píxeles de dispositivo (maxWidth): 1100 px
//  en cualquier pantalla, que es lo que una GPU de teléfono mueve con bloom y sombras.
//  "minimo": el piso para GPUs de teléfono chicas (una Mali-G57 dibujaba "movil" a 35 fps):
//  900 px de ancho, sin bloom y mapas de sombra chicos. Conserva las sombras a propósito: apagarlas
//  cambia los programas y recompila TODOS los materiales (segundos congelado en un teléfono), y la
//  calidad adaptativa cae acá en medio de la partida. La caída pasa antes por la resolución
//  dinámica (RENDER_SCALES); sombras sí/no queda como decisión del usuario.
export const QUALITY = {
  minimo: { dpr: 1.0, msaa: 0, moonMap: 512, flashMap: 256, bloom: 0, shadows: true, maxWidth: 900 },
  movil: { dpr: 1.25, msaa: 0, moonMap: 1024, flashMap: 512,  bloom: 0.5, shadows: true, maxWidth: 1100 },
  bajo:  { dpr: 0.70, msaa: 0, moonMap: 1024, flashMap: 512,  bloom: 0.5, shadows: true },
  medio: { dpr: 0.90, msaa: 2, moonMap: 2048, flashMap: 1024, bloom: 0.5, shadows: true },
  alto:  { dpr: 1.25, msaa: 4, moonMap: 4096, flashMap: 2048, bloom: 0.5, shadows: true },
};
export const QUALITY_ORDER = ['minimo', 'movil', 'bajo', 'medio', 'alto'];

/** Escalas de resolución que la calidad adaptativa recorre antes de bajar de preset (menos de 0,7 se ve borroso). */
export const RENDER_SCALES = Object.freeze([1, 0.85, 0.7]);
/**
 * Un escalón menos: primero baja la resolución de render (RENDER_SCALES), después el preset
 * (QUALITY_ORDER; setQuality vuelve la resolución a 1). Pura: dice qué cambiar, o {} si ya está
 * en el piso. O(1).
 */
export function adaptiveStepDown(qualityName, renderScale = 1) {
  const si = Math.max(0, RENDER_SCALES.findIndex((s) => s <= renderScale + 1e-6));
  const next = RENDER_SCALES[si + 1];
  if (next !== undefined) return { renderScale: next };
  const qi = QUALITY_ORDER.indexOf(qualityName);
  return qi > 0 ? { quality: QUALITY_ORDER[qi - 1] } : {};
}
/**
 * Luces puntuales visibles en TODOS los mapas: la oficina tiene 19 más el
 * fogonazo. Los demás se completan con luces de repuesto apagadas (ver
 * fixLightTopology): así comparten los mismos programas de shader.
 */
export const POINT_LIGHT_BUDGET = 20;
/** Niebla de los mapas que no la piden: más allá del plano lejano (140 m), no se ve pero el programa es el mismo. */
const FOG_NONE = Object.freeze({ near: 1000, far: 2000 });

export class Renderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.qualityName = opts.quality ?? 'medio';
    const Q = QUALITY[this.qualityName];

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x06070a, 1);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x06070a);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.4, 140);

    // ── luces ───────────────────────────────────────────────────────────────
    this.hemi = new THREE.HemisphereLight(0x2c3856, 0x141210, 0.62);
    this.scene.add(this.hemi);

    this.moon = new THREE.DirectionalLight(0x8fa3cc, 0.55);
    this.moon.castShadow = true;
    const ms = this.moon.shadow;
    ms.mapSize.set(Q.moonMap, Q.moonMap);
    ms.camera.left = -30; ms.camera.right = 30; ms.camera.top = 30; ms.camera.bottom = -30;
    ms.camera.near = 2; ms.camera.far = 90;
    ms.bias = -0.0009; ms.normalBias = 0.035;
    this.scene.add(this.moon); this.scene.add(this.moon.target);
    this.moonDir = new THREE.Vector3(-9, 30, 13);

    // la linterna del jugador
    this.flash = new THREE.SpotLight(0xfff0d4, 0, 30, 0.44, 0.62, 1.4);
    this.flash.castShadow = Q.shadows && Q.flashMap > 0;
    const fs = this.flash.shadow;
    fs.mapSize.set(Q.flashMap, Q.flashMap);
    fs.camera.near = 0.4; fs.camera.far = 32; fs.camera.fov = 60;
    fs.bias = -0.0022; fs.normalBias = 0.025;
    this.scene.add(this.flash); this.scene.add(this.flash.target);
    this.flashOn = true;

    // el fogonazo: SIEMPRE visible, apagado con intensidad 0. Prenderlo con
    // `visible` cambiaba la cantidad de luces y recompilaba todos los materiales
    // en el primer tiro (segundos de pantalla congelada)
    this.muzzle = new THREE.PointLight(0xffd39a, 0, 16, 2);
    this.spareLights = [];             // luces de repuesto (apagadas) que completan la cuenta de cada mapa
    this.scene.add(this.muzzle);
    this._muzzleT = 0;

    // ── post ────────────────────────────────────────────────────────────────
    const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: Q.msaa });
    this.composer = new EffectComposer(this.renderer, rt);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1280, 720), 0.30, 0.55, 0.86);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.grade.renderToScreen = true;
    this.composer.addPass(this.grade);

    // ── cámara ──────────────────────────────────────────────────────────────
    this.camYaw = -0.42;
    this.camYawTarget = -0.42;
    this.camPitch = 1.04;          // radianes sobre el horizonte (≈60°)
    this.camDist = 20.5;
    this.camDistTarget = 20.5;
    this.camTarget = new THREE.Vector3(0, 0.9, 0);
    this.camPos = new THREE.Vector3(0, 14, 8);
    this.shake = 0; this.shakeT = 0;
    this.kick = new THREE.Vector3();
    this.fovBase = 38; this.fovPunch = 0;
    this.time = 0;
    this.cinematic = false; this.cineAngle = 0;
    this.lookAhead = 0.32;
    this.scopeTarget = 0; this.scope = 0;      // mira telescópica: la cámara se adelanta más hacia el mouse
    this.shadowsOn = true; this.bloomOn = true;   // lo que pide el usuario; el preset puede negarlo (minimo)
    this._prOverride = null;                  // la armería fuerza una resolución más alta
    this.renderScale = 1;                     // resolución dinámica (RENDER_SCALES): la baja la calidad adaptativa
    this.warmup = new ShaderWarmup(this.renderer);

    this._applyPresetFlags();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  get quality() { return QUALITY[this.qualityName]; }

  /** Resolución dinámica: factor sobre el dpr del preset (RENDER_SCALES); lo maneja la calidad adaptativa. */
  setRenderScale(s) { this.renderScale = Math.max(0.5, Math.min(1, +s || 1)); this.resize(); }

  setQuality(name) {
    if (!QUALITY[name]) return;
    this.qualityName = name;
    this.renderScale = 1;                     // un preset nuevo arranca a resolución completa
    const Q = QUALITY[name];
    this.moon.shadow.mapSize.set(Q.moonMap, Q.moonMap);
    if (this.moon.shadow.map) { this.moon.shadow.map.dispose(); this.moon.shadow.map = null; }
    this.flash.shadow.mapSize.set(Q.flashMap, Q.flashMap);
    if (this.flash.shadow.map) { this.flash.shadow.map.dispose(); this.flash.shadow.map = null; }
    this._applyPresetFlags();
    // el render target con MSAA hay que recrearlo
    const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: Q.msaa });
    this.composer.renderTarget1.dispose(); this.composer.renderTarget2.dispose();
    this.composer.renderTarget1 = rt; this.composer.renderTarget2 = rt.clone();
    this.composer.writeBuffer = this.composer.renderTarget1;
    this.composer.readBuffer = this.composer.renderTarget2;
    this.resize();
  }

  resize() {
    const Q = QUALITY[this.qualityName];
    const w = Math.max(320, window.innerWidth), h = Math.max(240, window.innerHeight);
    let dpr = this._prOverride || Math.min(window.devicePixelRatio || 1, Q.dpr);
    if (!this._prOverride && Q.maxWidth) dpr = Math.min(dpr, Q.maxWidth / w);
    if (!this._prOverride) dpr *= this.renderScale;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.bloom.setSize(Math.round(w * dpr * 0.5), Math.round(h * dpr * 0.5));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.grade.uniforms.uRes.value = [w * dpr, h * dpr];
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.width = w; this.height = h;
  }

  /**
   * Resolución forzada (la armería la sube para que la vista previa se vea
   * nítida aunque el juego esté en calidad baja); null vuelve a la de la calidad.
   */
  setPixelRatioOverride(pr) {
    this._prOverride = pr || null;
    this.resize();
  }

  /** Sombras sí/no (las de la luna y las de la linterna). Cambiarlo obliga a recompilar materiales. */
  setShadows(on) {
    on = !!on;
    if (this.shadowsOn === on) return;
    this.shadowsOn = on;
    this._applyPresetFlags();
  }

  /** Bloom sí/no (el pase queda armado; sólo se saltea). */
  setBloom(on) { this.bloomOn = !!on; this._applyPresetFlags(); }

  /**
   * Sombras y bloom EFECTIVOS = lo que pide el usuario Y lo que permite el preset («minimo» apaga
   * los dos). Prender o apagar sombras cambia los programas: se marcan los materiales para
   * recompilar (un tirón de una vez; en el teléfono pasa sólo al caer a «minimo»).
   */
  _applyPresetFlags() {
    const Q = QUALITY[this.qualityName];
    const sh = this.shadowsOn && !!Q.shadows;
    const changed = this.renderer.shadowMap.enabled !== sh || this.moon.castShadow !== sh;
    this.renderer.shadowMap.enabled = sh;
    this.moon.castShadow = sh;
    this.flash.castShadow = sh && Q.flashMap > 0;
    this.bloom.enabled = this.bloomOn && Q.bloom > 0;
    if (changed) this.scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
  }

  /** Paleta y clima del lugarcito. */
  applyMood(m = {}) {
    if (m.background !== undefined) this.scene.background = new THREE.Color(m.background);
    // niebla del color del fondo: los mapas grandes o sucios la piden. SIEMPRE hay una
    // (prenderla o apagarla cambia el programa de todos los materiales): sin `fog`,
    // queda más allá del plano lejano
    const fg = m.fog || FOG_NONE;
    this.scene.fog = new THREE.Fog(new THREE.Color(fg.color ?? m.background ?? 0x06070a), fg.near ?? 30, fg.far ?? 90);
    if (m.hemiSky !== undefined) this.hemi.color.set(m.hemiSky);
    if (m.hemiGround !== undefined) this.hemi.groundColor.set(m.hemiGround);
    if (m.hemiIntensity !== undefined) this.hemi.intensity = m.hemiIntensity;
    if (m.moonColor !== undefined) this.moon.color.set(m.moonColor);
    if (m.moonIntensity !== undefined) this.moon.intensity = m.moonIntensity;
    if (m.moonDir) this.moonDir.set(...m.moonDir);
    if (m.bloom !== undefined) this.bloom.strength = m.bloom;
    if (m.exposure !== undefined) this.renderer.toneMappingExposure = m.exposure;
    const g = this.grade.uniforms;
    if (m.vignette !== undefined) g.uVignette.value = m.vignette;
    if (m.saturation !== undefined) g.uSaturation.value = m.saturation;
    if (m.contrast !== undefined) g.uContrast.value = m.contrast;
    if (m.tintA) g.uTintA.value = m.tintA;
    if (m.tintB) g.uTintB.value = m.tintB;
  }

  // ── sacudidas y golpes ─────────────────────────────────────────────────────
  addShake(a) { this.shake = Math.min(1.2, this.shake + a); }
  addKick(x, y, z) { this.kick.x += x; this.kick.y += y; this.kick.z += z; }
  flashScreen(a) { this.grade.uniforms.uFlash.value = Math.min(0.6, this.grade.uniforms.uFlash.value + a); }
  setDamage(d) { this.grade.uniforms.uDamage.value = clamp01(d); }
  setFade(f) { this.grade.uniforms.uFade.value = clamp01(f); }
  muzzleFlash(x, y, z, power = 1) {
    this.lightPulse(x, y, z, 0xffd39a, 22 * power, 10 * power, 0.06);
  }
  /**
   * Pulso de luz de color (fogonazo, rayo, explosión). Reusa la ÚNICA luz
   * puntual del fogonazo: agregar luces cambia el shader de todos los
   * materiales y cuesta en cada píxel. Si ya hay un pulso más fuerte, gana ése.
   */
  lightPulse(x, y, z, color, intensity, distance, dur = 0.07) {
    if (this._muzzleT > 0 && this.muzzle.intensity > intensity * 1.2) return;
    this.muzzle.position.set(x, y + 0.05, z);
    this.muzzle.color.set(color);
    this.muzzle.intensity = intensity;
    this.muzzle.distance = distance;
    this._muzzleT = dur;
  }

  // ── programas de shader: topología fija y precompilado ───────────────────
  /**
   * Topología de luces fija. Un programa de shader depende de CUÁNTAS luces
   * visibles hay (no de su intensidad): cada mapa se completa con luces de
   * repuesto apagadas hasta POINT_LIGHT_BUDGET puntuales, así lo que compila
   * el menú vale para cualquier mapa y en la partida no se recompila nada.
   * Devuelve cuántas de repuesto quedaron prendidas. O(nodos de la escena).
   */
  fixLightTopology() {
    for (const L of this.spareLights) L.visible = false;
    let n = 0;
    this.scene.traverseVisible((o) => { if (o.isPointLight) n++; });
    const need = POINT_LIGHT_BUDGET - n;
    if (need < 0) console.warn(`mapa con ${n} luces puntuales: el tope es ${POINT_LIGHT_BUDGET} (los shaders se recompilan al entrar)`);
    while (this.spareLights.length < need) {
      const L = new THREE.PointLight(0x000000, 0, 0.01, 2);
      L.name = 'repuesto';
      L.position.set(0, -60, 0);          // bajo el piso: apagada y lejos de todo
      this.scene.add(L);
      this.spareLights.push(L);
    }
    for (let i = 0; i < this.spareLights.length; i++) this.spareLights[i].visible = i < need;
    return Math.max(0, need);
  }

  /**
   * Todo lo de la escena que entra en la clave de un programa de shader:
   * luces visibles por tipo, las que dan sombra, el tipo de sombra y la
   * niebla. Si cambia (sombras apagadas, otra calidad), lo precompilado ya
   * no sirve y hay que volver a precompilar. O(nodos de la escena).
   */
  shaderTopologyKey() {
    const c = { p: 0, s: 0, d: 0, h: 0, a: 0, sh: 0 };
    this.scene.traverseVisible((o) => {
      if (!o.isLight) return;
      if (o.isPointLight) c.p++; else if (o.isSpotLight) c.s++; else if (o.isDirectionalLight) c.d++; else if (o.isHemisphereLight) c.h++; else if (o.isAmbientLight) c.a++;
      if (o.castShadow) c.sh++;
    });
    const sm = this.renderer.shadowMap, f = this.scene.fog;
    return `${c.p}p${c.s}s${c.d}d${c.h}h${c.a}a·${c.sh}sh·${sm.enabled ? sm.type : 'off'}·${f ? (f.isFogExp2 ? 'exp2' : 'lin') : 'nofog'}`;
  }

  /** Precompila la escena del juego y las muestras sueltas (ver warmup.js). */
  warmScene(samples = [], opts = {}) { return this.warmup.run(this.scene, this.camera, samples, opts); }

  /** Linterna: desde dónde y hacia dónde. */
  setFlashlight(x, y, z, tx, ty, tz, intensity = 260) {
    this.flash.position.set(x, y, z);
    this.flash.target.position.set(tx, ty, tz);
    this.flash.intensity = this.flashOn ? intensity : 0;
  }

  /** Dirección "arriba de la pantalla" en el plano XZ, para mover con WASD. */
  forwardXZ(out) {
    out.x = -Math.sin(this.camYaw); out.z = -Math.cos(this.camYaw);
    return out;
  }
  rightXZ(out) {
    out.x = Math.cos(this.camYaw); out.z = -Math.sin(this.camYaw);
    return out;
  }

  rotateCamera(d) { this.camYawTarget += d; }
  zoomCamera(d) { this.camDistTarget = clamp(this.camDistTarget + d, 12, 32); }

  /**
   * Sigue al jugador y se adelanta hacia el punto apuntado. En modo cinemático
   * (menú) orbita despacio sobre el nivel.
   */
  updateCamera(dt, px, py, pz, aimX, aimZ) {
    const t = this.camTarget;
    let yaw, pitch, dist;
    if (this.cinematic) {
      this.cineAngle += dt * 0.07;
      yaw = this.cineAngle;
      pitch = 0.98 + Math.sin(this.cineAngle * 0.5) * 0.06;
      dist = 19 + Math.sin(this.cineAngle * 0.31) * 2.5;
      t.x = damp(t.x, px, 0.02, dt); t.y = damp(t.y, 0.8, 0.02, dt); t.z = damp(t.z, pz, 0.02, dt);
      this.camYaw = yaw;
    } else {
      // adelanto hacia el mouse, acotado (con mira telescópica llega bastante más lejos)
      this.scope = damp(this.scope, this.scopeTarget, 0.02, dt);
      let ax = aimX - px, az = aimZ - pz;
      const al = Math.hypot(ax, az);
      const maxA = 4.5 + this.scope * 8;
      if (al > maxA) { ax *= maxA / al; az *= maxA / al; }
      const la = this.lookAhead + this.scope * 0.38;
      const gx = px + ax * la, gz = pz + az * la;
      t.x = damp(t.x, gx, 0.0015, dt);
      t.y = damp(t.y, py, 0.0015, dt);
      t.z = damp(t.z, gz, 0.0015, dt);
      this.camYaw = damp(this.camYaw, this.camYawTarget, 0.002, dt);
      this.camDist = damp(this.camDist, this.camDistTarget, 0.003, dt);
      yaw = this.camYaw; pitch = this.camPitch; dist = this.camDist;
    }

    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const wx = t.x + Math.sin(yaw) * cp * dist;
    const wy = t.y + sp * dist;
    const wz = t.z + Math.cos(yaw) * cp * dist;
    if (this.cinematic) {
      this.camPos.x = damp(this.camPos.x, wx, 0.05, dt);
      this.camPos.y = damp(this.camPos.y, wy, 0.05, dt);
      this.camPos.z = damp(this.camPos.z, wz, 0.05, dt);
    } else {
      this.camPos.set(wx, wy, wz);
    }

    // sacudida: ruido coherente
    this.shake = Math.max(0, this.shake - dt * 2.6);
    this.shakeT += dt * 30;
    const s = this.shake * this.shake * 0.35;
    const sx = noise2(this.shakeT, 0.5) * s;
    const sy = noise2(this.shakeT + 31.7, 1.5) * s;
    const sz = noise2(this.shakeT + 71.3, 2.5) * s * 0.6;
    this.kick.multiplyScalar(Math.pow(0.0003, dt));

    this.camera.position.set(this.camPos.x + sx + this.kick.x, this.camPos.y + sy + this.kick.y, this.camPos.z + sz + this.kick.z);
    this.camera.lookAt(t.x + sx * 0.6, t.y + sy * 0.6, t.z + sz * 0.6);

    this.fovPunch = damp(this.fovPunch, 0, 0.0002, dt);
    const fov = this.fovBase + this.fovPunch;
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
  }

  /** Punto del mundo bajo el mouse (nx, ny en -1..1), sobre un plano horizontal. */
  screenToGround(nx, ny, planeY = 1.0, out) {
    const v = this._ray || (this._ray = new THREE.Vector3());
    v.set(nx, ny, 0.5).unproject(this.camera);
    v.sub(this.camera.position).normalize();
    if (Math.abs(v.y) < 1e-5) return false;
    const t = (planeY - this.camera.position.y) / v.y;
    if (t < 0) return false;
    out.x = this.camera.position.x + v.x * t;
    out.y = planeY;
    out.z = this.camera.position.z + v.z * t;
    return true;
  }

  /** Proyección mundo → pantalla (px), para el HUD. */
  worldToScreen(x, y, z, out) {
    const v = this._proj || (this._proj = new THREE.Vector3());
    v.set(x, y, z).project(this.camera);
    out.x = (v.x * 0.5 + 0.5) * this.width;
    out.y = (-v.y * 0.5 + 0.5) * this.height;
    out.visible = v.z < 1;
    return out;
  }

  render(dt) {
    this.time += dt;
    const g = this.grade.uniforms;
    g.uTime.value = this.time;
    g.uFlash.value = Math.max(0, g.uFlash.value - dt * 9);

    if (this._muzzleT > 0) {
      this._muzzleT -= dt;
      this.muzzle.intensity *= Math.pow(0.0002, dt);
      if (this._muzzleT <= 0) { this.muzzle.intensity = 0; this.muzzle.color.set(0xffd39a); }
    }

    // la luna sigue al objetivo para que la sombra tenga siempre resolución
    this.moon.target.position.copy(this.camTarget);
    this.moon.position.set(this.camTarget.x + this.moonDir.x, this.moonDir.y, this.camTarget.z + this.moonDir.z);

    this.composer.render();
  }
}
