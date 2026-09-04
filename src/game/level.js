// ─────────────────────────────────────────────────────────────────────────────
//  level.js — Constructor de lugarcitos y la oficina principal.
//
//  Un lugarcito es una losa que flota en la negrura con un pedazo de edificio
//  encima, visto desde arriba, sin techo. Paredes con canto claro, tabiques de
//  cubículo con borde malva, alfombras con flores, baldosas, listones de
//  madera, escritorios con monitores encendidos, sillas y cajas que se mueven
//  de verdad, plantas, pizarras, tubos de luz. Todo se apila en pocas
//  InstancedMesh: cajas lisas, cilindros, esferas y cajas que brillan.
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { Materials, shadedBoxGeometry, shadedCylinderGeometry } from '../render/materials.js';
import { plantModel } from '../render/models.js';
import { TAU } from '../core/util.js';

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class LevelBuilder {
  constructor(scene, world, materials, rng) {
    this.scene = scene;
    this.world = world;
    this.mats = materials;
    this.rng = rng;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.boxes = []; this.cyls = []; this.spheres = []; this.glows = [];
    this.lights = [];
    this.spawns = [];          // {x, z, yaw}
    this.propSpecs = [];       // {kind:'box'|'chair', ...}
    this.pickupSpots = [];     // dónde pueden caer cosas
    this.playerStart = { x: 0, z: 0 };
    this.bounds = { x0: -20, z0: -14, x1: 20, z1: 14 };
    this.tubes = [];           // tubos fluorescentes con parpadeo
  }

  // ═══ primitivas ═══════════════════════════════════════════════════════════
  /** Caja de color liso. `y` es la base. opt: {yaw, pitch, roll, color, solid} */
  box(x, y, z, w, h, d, opt = {}) {
    const yaw = opt.yaw || 0;
    _e.set(opt.pitch || 0, yaw, opt.roll || 0);
    _q.setFromEuler(_e);
    _m.compose(_v.set(x, y + h / 2, z), _q, _s.set(w, h, d));
    const entry = { m: _m.clone(), c: new THREE.Color(opt.color ?? 0x8a8a8a) };
    this.boxes.push(entry);
    if (opt.solid !== false && !opt.pitch && !opt.roll) this.world.addBox(x, y + h / 2, z, w / 2, h / 2, d / 2, yaw);
    return entry;
  }
  /** Cilindro vertical. `y` es la base. */
  cyl(x, y, z, r, h, opt = {}) {
    _q.setFromEuler(_e.set(opt.pitch || 0, opt.yaw || 0, opt.roll || 0));
    _m.compose(_v.set(x, y + h / 2, z), _q, _s.set(r, h, r));
    const entry = { m: _m.clone(), c: new THREE.Color(opt.color ?? 0x8a8a8a) };
    this.cyls.push(entry);
    if (opt.solid !== false && !opt.pitch && !opt.roll) this.world.addCylinder(x, z, r, y, y + h);
    return entry;
  }
  sphere(x, y, z, rx, ry, rz, opt = {}) {
    _q.setFromEuler(_e.set(opt.pitch || 0, opt.yaw || 0, opt.roll || 0));
    _m.compose(_v.set(x, y, z), _q, _s.set(rx, ry, rz));
    this.spheres.push({ m: _m.clone(), c: new THREE.Color(opt.color ?? 0x8a8a8a) });
  }
  /** Caja que brilla (tubos, pantallitas, carteles). Sin colisión. */
  glow(x, y, z, w, h, d, opt = {}) {
    _q.setFromEuler(_e.set(opt.pitch || 0, opt.yaw || 0, opt.roll || 0));
    _m.compose(_v.set(x, y + h / 2, z), _q, _s.set(w, h, d));
    const entry = { m: _m.clone(), c: new THREE.Color(opt.color ?? 0xffffff), k: opt.k ?? 1 };
    this.glows.push(entry);
    return entry;
  }
  /** Caja con textura (madera, laminado, pizarra, papel). Malla propia. */
  texBox(x, y, z, w, h, d, opt = {}) {
    const matName = opt.mat || 'laminate';
    const tex = this.mats.tex[opt.tex || matName];
    const geo = new THREE.BoxGeometry(w, h, d);
    if (tex && tex.userData.meters && !opt.stretch) Materials.fitBoxUV(geo, tex, w, h, d);
    const mesh = new THREE.Mesh(geo, this.mats.mat[matName]);
    mesh.position.set(x, y + h / 2, z);
    mesh.rotation.set(opt.pitch || 0, opt.yaw || 0, opt.roll || 0);
    mesh.castShadow = opt.shadow !== false;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    if (opt.solid && !opt.pitch && !opt.roll) this.world.addBox(x, y + h / 2, z, w / 2, h / 2, d / 2, opt.yaw || 0);
    return mesh;
  }
  /** Piso de una zona: plano con textura, apenas por encima de la losa. */
  floor(x0, z0, x1, z1, matName, y = 0.006) {
    const w = x1 - x0, d = z1 - z0;
    const geo = new THREE.PlaneGeometry(w, d, 1, 1);
    Materials.fitPlaneUV(geo, this.mats.tex[matName], w, d);
    const mesh = new THREE.Mesh(geo, this.mats.mat[matName]);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }
  light(x, y, z, color, intensity, distance, opt = {}) {
    const L = new THREE.PointLight(color, intensity, distance, opt.decay ?? 2);
    L.position.set(x, y, z);
    this.group.add(L);
    this.lights.push({ light: L, flicker: opt.flicker || 0, base: intensity, t: this.rng() * 100, hz: opt.hz || 9 });
    return L;
  }
  spawn(x, z, yaw) { this.spawns.push({ x, z, yaw }); }
  chair(x, z, yaw, color) { this.propSpecs.push({ kind: 'chair', x, z, yaw, color }); }
  cardboard(x, z, yaw, size = 0.5, h) {
    const R = this.rng;
    const s = size * (0.85 + R() * 0.3);
    this.propSpecs.push({ kind: 'box', x, z, yaw, w: s, h: h ?? s * (0.7 + R() * 0.5), d: s * (0.8 + R() * 0.4), mass: 2.5 + R() * 3, color: [0xcaa66b, 0xbf9a5f, 0xd2ae78][R.int(0, 2)] });
  }

  // ═══ piezas compuestas ════════════════════════════════════════════════════
  /** La losa: hormigón que asoma alrededor del edificio, y el bloque de abajo. */
  slab(hx, hz) {
    const w = this.world;
    w.groundHX = hx; w.groundHZ = hz; w.groundY = 0;
    this.floor(-hx, -hz, hx, hz, 'concrete', 0);
    const side = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, 2.6, hz * 2),
      new THREE.MeshStandardMaterial({ color: 0x1b1c22, roughness: 1 }));
    side.position.y = -1.31;
    this.group.add(side);
  }

  /**
   * Pared entre dos puntos. opt: {h, thick, color, cap, capColor, gaps:[[t0,t1],…]}
   * Los huecos van en fracción 0..1 del largo (puertas).
   */
  wall(x0, z0, x1, z1, opt = {}) {
    const h = opt.h ?? 3.0, th = opt.thick ?? 0.3, color = opt.color ?? 0x605e64;
    const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz) + Math.PI / 2;   // la caja es larga en X local
    const seg = (t0, t1) => {
      const len = (t1 - t0) * L;
      if (len < 0.01) return;
      const mid = (t0 + t1) / 2;
      const cx = x0 + dx * mid, cz = z0 + dz * mid;
      this.box(cx, 0, cz, len, h, th, { yaw, color, solid: opt.solid !== false });
      if (opt.cap !== false) {
        this.box(cx, h, cz, len + 0.02, 0.07, th + 0.08, { yaw, color: opt.capColor ?? 0x8a7690, solid: false });
      }
    };
    const gaps = (opt.gaps || []).slice().sort((a, b) => a[0] - b[0]);
    let t = 0;
    for (const [g0, g1] of gaps) { seg(t, g0); t = g1; }
    seg(t, 1);
  }

  /** Tabique de cubículo: bajo, gris, borde malva. */
  partition(x0, z0, x1, z1, opt = {}) {
    this.wall(x0, z0, x1, z1, { h: opt.h ?? 1.25, thick: 0.08, color: opt.color ?? 0x8b857a, capColor: 0x9e8898, ...opt });
  }

  /** Escritorio con monitor (o laptop), pedestal y cosas encima. Frente = +Z local. */
  desk(x, z, yaw, opt = {}) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const at = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    const w = opt.w ?? 1.6, d = opt.d ?? 0.75, h = 0.74;
    // tapa laminada
    this.texBox(x, h - 0.04, z, w, 0.04, d, { yaw, mat: 'laminate', solid: false });
    this.world.addBox(x, h / 2, z, w / 2, h / 2, d / 2, yaw);
    // pedestal y pata
    const [px, pz] = at(-w / 2 + 0.25, 0);
    this.box(px, 0, pz, 0.42, h - 0.05, d - 0.1, { yaw, color: opt.pedColor ?? 0x6c6862, solid: false });
    const [lx, lz] = at(w / 2 - 0.05, -d / 2 + 0.05);
    this.cyl(lx, 0, lz, 0.025, h - 0.04, { color: 0x3a3a40, solid: false, seg: 6 });
    const [lx2, lz2] = at(w / 2 - 0.05, d / 2 - 0.05);
    this.cyl(lx2, 0, lz2, 0.025, h - 0.04, { color: 0x3a3a40, solid: false, seg: 6 });
    // monitor o laptop
    if (opt.laptop) {
      const [mx, mz] = at(0.15, -0.05);
      this.laptop(mx, h, mz, yaw + (this.rng() - 0.5) * 0.5);
    } else if (opt.monitor !== false) {
      const [mx, mz] = at(0.1, -d / 2 + 0.2);
      this.monitor(mx, h, mz, yaw + (this.rng() - 0.5) * 0.3);
    }
    if (opt.lamp) {
      const [ax, az] = at(-w / 2 + 0.25, -d / 2 + 0.2);
      this.deskLamp(ax, h, az, yaw + 0.6, opt.lampColor);
    }
    if (opt.papers !== false) {
      const [qx, qz] = at(0.45, 0.12);
      this.papers(qx, h, qz, 1 + this.rng.int(0, 2), 0.25);
    }
    if (opt.mug !== false && this.rng() < 0.7) {
      const [gx, gz] = at(-0.35, 0.2);
      this.cyl(gx, h, gz, 0.04, 0.09, { color: [0xe8e2d2, 0x2a2a2e, 0xb83a3a][this.rng.int(0, 2)], solid: false, seg: 8 });
    }
    return { x, z, yaw };
  }

  monitor(x, y, z, yaw) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    this.box(x, y, z, 0.2, 0.02, 0.16, { yaw, color: 0x1e1f24, solid: false });
    this.cyl(x, y, z, 0.02, 0.16, { color: 0x1e1f24, solid: false, seg: 6 });
    // panel: mira a +Z local
    const px = x - s * 0.02, pz = z - c * 0.02;
    this.box(px, y + 0.14, pz, 0.56, 0.34, 0.03, { yaw, color: 0x1a1b20, solid: false });
    const sx = x + s * 0.0, sz = z + c * 0.0;
    this.screen(sx, y + 0.16, sz, 0.5, 0.29, yaw);
  }
  laptop(x, y, z, yaw) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    this.box(x, y, z, 0.34, 0.018, 0.24, { yaw, color: 0x2a2c33, solid: false });
    // tapa abierta, inclinada hacia atrás (-Z local)
    const bx = x - s * 0.11, bz = z - c * 0.11;
    this.box(bx, y + 0.01, bz, 0.34, 0.24, 0.012, { yaw, pitch: -0.32, color: 0x2a2c33, solid: false });
    const scx = x - s * 0.095, scz = z - c * 0.095;
    this.screen(scx, y + 0.03, scz, 0.29, 0.19, yaw, -0.32, 0.012);
  }
  /** Pantalla encendida: caja con la textura emisiva. */
  screen(x, y, z, w, h, yaw, pitch = 0, depth = 0.01) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.mats.mat.screen);
    mesh.position.set(x, y + h / 2, z);
    mesh.rotation.set(pitch, yaw, 0, 'YXZ');
    mesh.translateZ(depth);
    this.group.add(mesh);
    return mesh;
  }
  deskLamp(x, y, z, yaw, color = 0xffc98a) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    this.cyl(x, y, z, 0.07, 0.02, { color: 0x2c2d33, solid: false, seg: 8 });
    this.cyl(x, y, z, 0.012, 0.36, { color: 0x2c2d33, solid: false, seg: 6 });
    const hx = x + s * 0.14, hz = z + c * 0.14;
    this.box(hx, y + 0.30, hz, 0.16, 0.08, 0.16, { yaw, color: 0x2c2d33, solid: false });
    this.glow(hx, y + 0.29, hz, 0.12, 0.012, 0.12, { color, k: 1.8 });
    this.light(hx, y + 0.30, hz, color, 5.5, 6.5, { flicker: 0.02 });
  }
  /** Tubo fluorescente en una pared: brilla y alumbra un poco. `yaw` = orientación del tubo. */
  tube(x, y, z, yaw, len = 1.2, opt = {}) {
    const color = opt.color ?? 0xdfe9ff;
    this.glow(x, y, z, len, 0.05, 0.06, { yaw, color, k: opt.k ?? 2.6 });
    this.box(x, y - 0.015, z, len + 0.06, 0.03, 0.09, { yaw, color: 0xb9bcc4, solid: false });
    // cada luz puntual cuesta en TODOS los píxeles (render forward): sólo
    // algunos tubos alumbran de verdad, el resto sólo brilla.
    if (opt.light === true) {
      const L = this.light(x, y - 0.1, z, color, opt.intensity ?? 7, opt.distance ?? 7, { flicker: opt.flicker ?? 0.06, hz: 13 });
      this.tubes.push(L);
    }
  }
  /** Lucecita de emergencia: rectángulo blanco chico en lo alto de la pared. */
  wallLight(x, y, z, yaw) {
    this.glow(x, y, z, 0.28, 0.12, 0.05, { yaw, color: 0xffffff, k: 3.0 });
  }
  papers(x, y, z, n = 3, spread = 0.3) {
    for (let i = 0; i < n; i++) {
      const R = this.rng;
      this.texBox(x + (R() - 0.5) * spread, y + i * 0.003, z + (R() - 0.5) * spread, 0.21, 0.003, 0.297,
        { yaw: R() * TAU, mat: 'paper', stretch: true, shadow: false });
    }
  }
  plant(x, z, big = false) {
    const g = plantModel(this.rng, [0xe6e1d3, 0xd9d3c4, 0x9a9a9a][this.rng.int(0, 2)], [0x4f8a3a, 0x5f9a48, 0x3f7a3a][this.rng.int(0, 2)]);
    const sc = big ? 1.5 : 1.05 + this.rng() * 0.2;
    g.scale.setScalar(sc);
    g.position.set(x, 0, z);
    g.rotation.y = this.rng() * TAU;
    this.group.add(g);
    this.world.addCylinder(x, z, 0.18 * sc, 0, 0.6 * sc);
  }
  whiteboard(x, y, z, yaw, w = 1.6, h = 1.0) {
    this.texBox(x, y, z, w, h, 0.03, { yaw, mat: 'whiteboard', stretch: true, solid: false });
  }
  copier(x, z, yaw) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    this.box(x, 0, z, 0.9, 1.0, 0.7, { yaw, color: 0xd6d0c2 });
    this.box(x, 1.0, z, 0.94, 0.08, 0.74, { yaw, color: 0xc7c1b3, solid: false });
    const px = x + s * 0.36, pz = z + c * 0.36;
    this.box(px, 0.9, pz, 0.5, 0.06, 0.16, { yaw, color: 0x24262b, solid: false });
    this.glow(px, 0.96, pz, 0.12, 0.01, 0.06, { yaw, color: 0x7ad0ff, k: 1.6 });
    this.box(x - s * 0.2, 0.35, z - c * 0.2, 0.7, 0.04, 0.5, { yaw, color: 0xb9b3a5, solid: false });
  }
  cabinet(x, z, yaw, h = 1.3, color = 0x6f7277) {
    this.box(x, 0, z, 0.5, h, 0.62, { yaw, color });
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (let k = 0; k < 3; k++) {
      const y = 0.15 + k * (h - 0.3) / 3 + (h - 0.3) / 6;
      this.box(x + s * 0.32, y, z + c * 0.32, 0.18, 0.02, 0.02, { yaw, color: 0xbfc2c8, solid: false });
    }
  }
  rug(x, z, w, d, color, yaw = 0) {
    this.box(x, 0.004, z, w, 0.012, d, { yaw, color, solid: false });
  }
  bench(x, z, yaw, color = 0x3d4652) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    this.box(x, 0.2, z, 1.9, 0.12, 0.55, { yaw, color });
    this.box(x - s * 0.24, 0.32, z - c * 0.24, 1.9, 0.42, 0.08, { yaw, color, solid: false });
    for (const lx of [-0.8, 0.8]) {
      this.box(x + lx * c, 0, z - lx * s, 0.08, 0.2, 0.5, { yaw, color: 0x2a2f38, solid: false });
    }
    this.world.addBox(x, 0.35, z, 0.95, 0.35, 0.3, yaw);
  }
  meetingTable(x, z, yaw, len, wid, color) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    this.box(x, 0.70, z, len, 0.06, wid, { yaw, color, solid: false });
    this.world.addBox(x, 0.38, z, len / 2, 0.38, wid / 2, yaw);
    for (const [lx, lz] of [[-len / 2 + 0.3, 0], [len / 2 - 0.3, 0]]) {
      const px = x + lx * c + lz * s, pz = z - lx * s + lz * c;
      this.box(px, 0, pz, 0.12, 0.7, wid - 0.5, { yaw, color: 0x4a4c50, solid: false });
    }
  }
  /** Sillas alrededor de una mesa (props). */
  chairsAround(x, z, yaw, len, wid, nSide, color) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (let side = -1; side <= 1; side += 2) {
      for (let k = 0; k < nSide; k++) {
        const lx = -len / 2 + (k + 0.5) * (len / nSide) + (this.rng() - 0.5) * 0.2;
        const lz = side * (wid / 2 + 0.42) + (this.rng() - 0.5) * 0.15;
        const px = x + lx * c + lz * s, pz = z - lx * s + lz * c;
        // la silla mira hacia la mesa: su +Z local apunta a -side
        this.chair(px, pz, yaw + (side > 0 ? Math.PI : 0) + (this.rng() - 0.5) * 0.5, color);
      }
    }
  }
  /** Pared de listones de madera pegada a una pared existente. */
  slats(x0, z0, x1, z1, h = 3.0, opt = {}) {
    const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz) + Math.PI / 2;
    this.texBox((x0 + x1) / 2, 0, (z0 + z1) / 2, L, h, opt.thick ?? 0.1, { yaw, mat: 'woodSlats', solid: false });
  }
  vending(x, z, yaw) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    this.box(x, 0, z, 0.95, 1.9, 0.8, { yaw, color: 0x24262d });
    const fx = x + s * 0.41, fz = z + c * 0.41;
    this.glow(fx, 0.5, fz, 0.6, 1.1, 0.02, { yaw, color: 0x3d6fd6, k: 1.3 });
    this.box(fx, 0.15, fz, 0.7, 0.25, 0.04, { yaw, color: 0x141519, solid: false });
    this.light(fx + s * 0.3, 1.0, fz + c * 0.3, 0x5a8cff, 5, 4.5, { flicker: 0.12, hz: 17 });
  }
  fridge(x, z, yaw) {
    this.box(x, 0, z, 0.9, 1.85, 0.8, { yaw, color: 0xe2e0da });
    const c = Math.cos(yaw), s = Math.sin(yaw);
    this.box(x + s * 0.41, 0.9, z + c * 0.41, 0.03, 0.5, 0.03, { yaw, color: 0x9a9a9a, solid: false });
  }
  counter(x, z, yaw, len, opt = {}) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    this.box(x, 0, z, len, 0.86, 0.62, { yaw, color: opt.color ?? 0xd9d3c4 });
    this.box(x, 0.86, z, len + 0.04, 0.05, 0.66, { yaw, color: opt.top ?? 0x8a8378, solid: false });
    // cosas encima
    const R = this.rng;
    for (let k = 0; k < (opt.stuff ?? 3); k++) {
      const lx = (R() - 0.5) * (len - 0.4);
      const px = x + lx * c, pz = z - lx * s;
      if (R() < 0.5) this.cyl(px, 0.91, pz, 0.04, 0.1, { color: [0xe8e2d2, 0x2a2a2e][R.int(0, 1)], solid: false, seg: 8 });
      else this.box(px, 0.91, pz, 0.2, 0.15, 0.18, { yaw, color: [0xbfc2c8, 0x2b2d33][R.int(0, 1)], solid: false });
    }
  }

  // ═══ compilación ══════════════════════════════════════════════════════════
  finish() {
    const mk = (geo, list, mat, shadow = true) => {
      if (!list.length) return null;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      const c = new THREE.Color();
      for (let i = 0; i < list.length; i++) {
        im.setMatrixAt(i, list[i].m);
        c.copy(list[i].c);
        if (list[i].k) c.multiplyScalar(list[i].k);
        im.setColorAt(i, c);
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = shadow;
      im.receiveShadow = shadow;
      im.frustumCulled = false;
      this.group.add(im);
      return im;
    };
    mk(shadedBoxGeometry(1.2, 1.0, 0.55), this.boxes, this.mats.mat.flat);
    mk(shadedCylinderGeometry(12, 1.2), this.cyls, this.mats.mat.flat);
    mk(new THREE.SphereGeometry(1, 10, 8), this.spheres, this.mats.mat.flatSmooth);
    mk(new THREE.BoxGeometry(1, 1, 1), this.glows, new THREE.MeshBasicMaterial({ toneMapped: false }), false);
    this.world.buildStaticIndex();
    return this;
  }

  /** Parpadeo de luces. */
  update(dt) {
    for (const L of this.lights) {
      if (!L.flicker) continue;
      L.t += dt * L.hz;
      const n = Math.sin(L.t) * 0.5 + Math.sin(L.t * 2.7) * 0.3 + Math.sin(L.t * 6.1) * 0.2;
      L.light.intensity = L.base * (1 - L.flicker * (0.5 + n * 0.5));
    }
  }

  dispose() {
    this.group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
    });
    this.scene.remove(this.group);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  LA OFICINA — el lugarcito principal del juego
// ═════════════════════════════════════════════════════════════════════════════
export function buildOffice(L) {
  const R = L.rng;
  const X0 = -19.6, X1 = 19.6, Z0 = -13.6, Z1 = 13.6;   // línea de las paredes exteriores
  L.slab(22, 16);
  L.bounds = { x0: X0, z0: Z0, x1: X1, z1: Z1 };

  // ── paredes exteriores con las 4 puertas ──────────────────────────────────
  const OUT = { h: 3.0, thick: 0.3, color: 0x6f6d74, capColor: 0x8f7a99 };
  const frac = (a, b, t0, t1) => [(t0 - a) / (b - a), (t1 - a) / (b - a)];
  L.wall(X0, Z0, X1, Z0, { ...OUT, gaps: [frac(X0, X1, 12.0, 14.0)] });          // norte
  L.wall(X0, Z1, X1, Z1, { ...OUT, gaps: [frac(X0, X1, -11.0, -9.0)] });         // sur
  L.wall(X0, Z0, X0, Z1, { ...OUT, gaps: [frac(Z0, Z1, -9.4, -7.4)] });          // oeste
  L.wall(X1, Z0, X1, Z1, { ...OUT, gaps: [frac(Z0, Z1, 6.0, 8.0)] });            // este
  // afuera de cada puerta nacen los zombis
  L.spawn(-20.7, -8.4, Math.PI / 2);
  L.spawn(13.0, -14.7, Math.PI);
  L.spawn(-10.0, 14.7, 0);
  L.spawn(20.7, 7.0, -Math.PI / 2);
  // marcos oscuros de las puertas
  for (const [x, z, yaw] of [[-19.6, -8.4, 0], [13, -13.6, Math.PI / 2], [-10, 13.6, Math.PI / 2], [19.6, 7, 0]]) {
    L.box(x, 2.3, z, 0.34, 0.7, 2.2, { yaw, color: 0x2a282e, solid: false });
  }

  // ── pisos por zona ────────────────────────────────────────────────────────
  L.floor(X0, Z0, -6, -2, 'tileBeige');          // hall
  L.floor(-6, Z0, 8, -2, 'carpetFloral');        // oficina abierta
  L.floor(8, Z0, X1, -2, 'carpetFloral');        // sala A
  L.floor(X0, -2, X1, 1.5, 'carpetGrey');        // pasillo
  L.floor(X0, 1.5, 2, Z1, 'carpetGrey');         // cubículos
  L.floor(2, 1.5, 14, Z1, 'carpetNavy');         // sala B
  L.floor(14, 1.5, X1, Z1, 'tileTeal');          // cocina
  L.rug(0, -0.25, 38.4, 1.6, 0x8a2a2a);          // alfombra roja del pasillo

  // ── paredes interiores ────────────────────────────────────────────────────
  const IN = { h: 3.0, thick: 0.24, color: 0x8d8880, capColor: 0xa08f9a };
  L.wall(-6, Z0, -6, -2, { ...IN, gaps: [frac(Z0, -2, -9.0, -7.0)] });          // hall | oficina
  L.wall(8, Z0, 8, -2, { ...IN, gaps: [frac(Z0, -2, -6.0, -4.0)] });            // oficina | sala A
  L.wall(X0, -2, X1, -2, { ...IN, gaps: [frac(X0, X1, -14, -12), frac(X0, X1, -1, 1), frac(X0, X1, 12.5, 14.5)] });
  L.wall(X0, 1.5, X1, 1.5, { ...IN, gaps: [frac(X0, X1, -16, -14), frac(X0, X1, -4, -2), frac(X0, X1, 9, 11), frac(X0, X1, 16, 18)] });
  L.wall(2, 1.5, 2, Z1, { ...IN, gaps: [frac(1.5, Z1, 6.5, 8.5)] });            // cubículos | sala B
  L.wall(14, 1.5, 14, Z1, { ...IN, gaps: [frac(1.5, Z1, 9, 11)] });             // sala B | cocina

  // listones de madera (caras interiores)
  L.slats(19.45, -13.45, 19.45, -2.15, 3.0);                 // sala A, pared este
  L.slats(8.15, -13.45, 12.0, -13.45, 3.0);                  // sala A, pared norte hasta la puerta
  L.slats(2.15, 13.45, 14.0, 13.45, 3.0);                    // sala B, pared sur
  L.slats(-19.45, -13.45, -6.15, -13.45, 1.1);               // hall: zócalo alto de madera

  // ── HALL (baldosas beige) ─────────────────────────────────────────────────
  L.counter(-12.5, -6.2, 0, 4.2, { color: 0x8d7b6a, top: 0xd3c5a5, stuff: 4 });
  L.counter(-10.6, -8.6, Math.PI / 2, 3.6, { color: 0x8d7b6a, top: 0xd3c5a5, stuff: 2 });
  L.monitor(-12.0, 0.91, -6.3, Math.PI + 0.3);
  L.chair(-12.4, -7.6, Math.PI + 0.2, 0x4f86d2);
  L.copier(-17.9, -12.2, 0);
  L.cabinet(-16.4, -12.6, 0); L.cabinet(-15.8, -12.6, 0);
  L.bench(-14.5, -3.4, 0);
  L.bench(-17.6, -6.5, Math.PI / 2);
  L.plant(-7.0, -12.6, true); L.plant(-18.6, -3.2);
  for (let i = 0; i < 7; i++) L.cardboard(-17 + R() * 8, -11.5 + R() * 5, R() * TAU, 0.5 + R() * 0.3);
  L.cardboard(-9.2, -11.9, 0.2, 0.7); L.cardboard(-8.4, -12.2, 0.9, 0.55);
  L.tube(-19.4, 2.4, -11, Math.PI / 2, 1.3, { light: true }); L.tube(-19.4, 2.4, -4.5, Math.PI / 2, 1.3);
  L.wallLight(-12.5, 2.6, -13.4, 0); L.wallLight(-6.2, 2.6, -4.5, Math.PI / 2);
  L.deskLamp(-13.9, 0.91, -6.0, 0.4);
  L.papers(-15, 0.004, -8, 5, 1.2);

  // ── OFICINA ABIERTA (alfombra floral) ─────────────────────────────────────
  L.partition(-5.4, -8.6, -0.4, -8.6); L.partition(1.6, -8.6, 7.4, -8.6);
  const deskRow = (zc, yaw) => {
    for (const xc of [-3.2, 0.9, 4.9]) {
      const laptop = R() < 0.3;
      L.desk(xc, zc, yaw, { laptop, lamp: R() < 0.5 });
      // la silla del lado del frente (+Z local)
      const s = Math.sin(yaw), c = Math.cos(yaw);
      L.chair(xc + s * 0.75 + (R() - 0.5) * 0.3, zc + c * 0.75 + (R() - 0.5) * 0.2, yaw + Math.PI + (R() - 0.5) * 0.8,
        [0x4f86d2, 0x3f9aa0, 0x6a63c8][R.int(0, 2)]);
    }
  };
  deskRow(-11.2, Math.PI);   // frente hacia -Z … la silla queda al norte
  deskRow(-6.0, 0);          // frente hacia +Z … silla al sur
  L.whiteboard(-5.85, 1.0, -4.2, Math.PI / 2, 1.8, 1.0);
  L.plant(7.3, -2.7); L.plant(-5.4, -12.8);
  L.cabinet(7.5, -12.9, 0);
  L.tube(1, 2.5, -13.4, 0, 1.4, { light: true }); L.tube(-5.5, 2.5, -5.5, Math.PI / 2, 1.2, { color: 0xfff1d6 });
  L.wallLight(7.8, 2.6, -8.5, Math.PI / 2);
  for (let i = 0; i < 3; i++) L.cardboard(-2 + R() * 6, -3.3 + R() * 0.8, R() * TAU, 0.5);
  L.papers(2, 0.004, -8, 6, 2.5);

  // ── SALA DE REUNIONES A (mesa verde) ──────────────────────────────────────
  L.meetingTable(13.7, -7.7, 0, 6.0, 1.7, 0xb7c2a3);
  L.chairsAround(13.7, -7.7, 0, 6.0, 1.7, 4, 0x4f86d2);
  L.chair(10.2, -7.7, Math.PI / 2, 0x4f86d2); L.chair(17.2, -7.7, -Math.PI / 2, 0x3f9aa0);
  L.laptop(13.0, 0.73, -7.9, 0.4);
  L.papers(15, 0.73, -7.5, 3, 0.6);
  L.cyl(12.2, 0.73, -7.3, 0.04, 0.09, { color: 0xe8e2d2, solid: false, seg: 8 });
  L.cyl(15.6, 0.73, -8.1, 0.04, 0.09, { color: 0x2a2a2e, solid: false, seg: 8 });
  L.plant(18.7, -12.7, true); L.plant(8.7, -2.7);
  L.whiteboard(8.15, 1.0, -10.0, Math.PI / 2, 1.8, 1.0);
  L.tube(19.3, 2.4, -5.5, Math.PI / 2, 1.5, { color: 0xffe9c8, light: true });
  L.tube(19.3, 2.4, -11, Math.PI / 2, 1.5, { color: 0xffe9c8 });
  L.cabinet(18.9, -3.0, Math.PI / 2, 1.0);
  L.cardboard(17.9, -12.6, 0.3, 0.6); L.cardboard(17.2, -12.3, 1.2, 0.45);

  // ── PASILLO ───────────────────────────────────────────────────────────────
  L.bench(-7.5, 0.95, 0); L.bench(6.5, 0.95, 0);
  L.plant(-18.9, -0.2); L.plant(18.9, -0.2); L.plant(3.2, 0.9);
  L.cabinet(-9.6, 0.95, 0); L.cabinet(-9.0, 0.95, 0);
  for (let i = 0; i < 4; i++) L.cardboard(-5 + R() * 20, -1.5 + R() * 2.4, R() * TAU, 0.45);
  L.wallLight(-4.5, 2.6, -2.1, 0); L.wallLight(11, 2.6, 1.6, 0); L.wallLight(-16, 2.6, 1.6, 0);
  L.tube(15.5, 2.5, -2.1, 0, 1.4, { light: true }); L.tube(-11.5, 2.5, -2.1, 0, 1.4);
  L.papers(-13, 0.004, -0.5, 4, 2);

  // ── CUBÍCULOS ─────────────────────────────────────────────────────────────
  const rugColors = [0x8e2a2a, 0x1f2a5a, 0xc7692c, 0x6d7a3a, 0x5a2a4a, 0x2a5a5a];
  let ci = 0;
  for (const [zc, open] of [[4.3, +1], [10.3, -1]]) {
    for (const xc of [-16.2, -11.6, -7.0]) {
      const back = zc - open * 1.85;
      L.partition(xc - 1.8, back, xc + 1.8, back);
      L.partition(xc - 1.8, back, xc - 1.8, back + open * 3.6);
      L.partition(xc + 1.8, back, xc + 1.8, back + open * 3.6);
      L.rug(xc, zc, 3.0, 3.0, rugColors[ci % rugColors.length]);
      // escritorio en L contra el fondo, mirando hacia la abertura
      const yaw = open > 0 ? 0 : Math.PI;
      L.desk(xc - 0.3, back + open * 0.45, yaw, { w: 1.7, lamp: ci % 2 === 0, laptop: ci === 2 });
      const s = Math.sin(yaw), c = Math.cos(yaw);
      L.desk(xc + 1.35, zc, yaw + (open > 0 ? -Math.PI / 2 : Math.PI / 2), { w: 1.4, monitor: ci % 3 !== 1, papers: true });
      L.chair(xc - 0.3 + s * 0.8, back + open * 0.45 + c * 0.8 + (R() - 0.5) * 0.3, yaw + Math.PI + (R() - 0.5) * 0.6,
        [0x4f86d2, 0x33508c, 0x6a63c8, 0x3f9aa0][R.int(0, 3)]);
      if (R() < 0.6) L.cardboard(xc - 1.3, zc + open * 0.9, R() * TAU, 0.45);
      ci++;
    }
  }
  L.copier(-3.6, 12.4, Math.PI);
  L.cabinet(-2.9, 12.6, Math.PI); L.cabinet(-2.3, 12.6, Math.PI);
  L.plant(-18.8, 12.8); L.plant(1.3, 2.4);
  L.tube(-19.4, 2.4, 7.3, Math.PI / 2, 1.4, { light: true }); L.tube(-8, 2.5, 13.4, 0, 1.4); L.tube(-15, 2.5, 13.4, 0, 1.4);
  L.wallLight(1.8, 2.6, 4, Math.PI / 2);
  L.papers(-11, 0.004, 7.3, 8, 5);
  for (let i = 0; i < 3; i++) L.cardboard(-4.5 + R() * 5, 3 + R() * 8, R() * TAU, 0.5);

  // ── SALA DE REUNIONES B (alfombra azul) ───────────────────────────────────
  L.meetingTable(8.0, 7.6, 0, 5.0, 1.6, 0xa3a9a6);
  L.chairsAround(8.0, 7.6, 0, 5.0, 1.6, 3, 0x33508c);
  L.chair(5.0, 7.6, Math.PI / 2, 0x6a63c8);
  L.laptop(8.8, 0.73, 7.4, -0.3);
  L.papers(6.8, 0.73, 7.9, 2, 0.5);
  L.cyl(9.9, 0.73, 8.0, 0.04, 0.09, { color: 0xe8e2d2, solid: false, seg: 8 });
  L.plant(13.2, 12.8, true); L.plant(2.9, 12.9);
  L.whiteboard(2.15, 1.0, 5.0, Math.PI / 2, 1.8, 1.0);
  L.whiteboard(13.85, 1.0, 4.5, -Math.PI / 2, 1.6, 1.0);
  L.tube(8, 2.4, 13.3, 0, 1.6, { color: 0xffe9c8, light: true });
  L.tube(13.85, 2.5, 8, Math.PI / 2, 1.2);
  L.cabinet(13.4, 2.0, 0); L.cabinet(12.8, 2.0, 0);
  L.cardboard(3.0, 2.6, 0.5, 0.55); L.cardboard(3.6, 3.1, 1.4, 0.45);

  // ── COCINA (azulejo verde agua) ───────────────────────────────────────────
  L.counter(18.9, 4.2, Math.PI / 2, 4.6, { color: 0xd9d3c4, top: 0x6f6a62, stuff: 5 });
  L.fridge(18.9, 12.6, Math.PI / 2);
  L.box(18.9, 0.91, 10.6, 0.55, 0.32, 0.45, { yaw: Math.PI / 2, color: 0xcfd1d4 });         // microondas
  L.box(18.9, 0.91, 9.9, 0.35, 0.02, 0.3, { yaw: Math.PI / 2, color: 0x24262b, solid: false });
  L.vending(14.7, 12.6, Math.PI);
  L.cyl(16.6, 0, 6.5, 0.05, 0.72, { color: 0x3a3a40, seg: 8 });                            // mesita redonda
  L.cyl(16.6, 0.72, 6.5, 0.55, 0.05, { color: 0xd3c5a5, solid: false, seg: 14 });
  L.world.addCylinder(16.6, 6.5, 0.55, 0, 0.77);
  L.chair(16.6, 5.4, 0, 0x3f9aa0); L.chair(15.6, 6.9, -Math.PI / 2 + 0.4, 0x3f9aa0);
  L.cyl(16.4, 0.77, 6.3, 0.04, 0.09, { color: 0xe8e2d2, solid: false, seg: 8 });
  L.plant(14.6, 2.2);
  L.tube(17, 2.5, 1.6, 0, 1.4, { color: 0xe3f2ff, intensity: 9, light: true });
  L.tube(19.3, 2.4, 10, Math.PI / 2, 1.4, { color: 0xe3f2ff });
  L.cardboard(15.2, 3.8, 0.4, 0.55); L.cardboard(15.9, 3.4, 1.1, 0.5);
  L.cardboard(18.0, 8.3, 0.2, 0.55);

  // ── luces de ambiente extra (cálidas, pocas) ──────────────────────────────
  L.light(-12, 2.2, -8, 0xffd6a0, 5, 9, { flicker: 0.0 });     // hall
  L.light(13.7, 2.4, -7.7, 0xffe0b8, 6, 9);                    // sala A
  L.light(8, 2.4, 7.6, 0xc9d8ff, 4, 8);                        // sala B fría

  L.playerStart = { x: 0, z: -0.3 };
  L.pickupSpots = [
    { x: -12, z: -10 }, { x: 1, z: -4 }, { x: 13.7, z: -11 }, { x: -6, z: -0.3 }, { x: 10, z: -0.3 },
    { x: -11.6, z: 7.3 }, { x: 8, z: 11 }, { x: 16.6, z: 9 }, { x: -16, z: 7.3 }, { x: 4, z: -12 },
  ];
  return L.finish();
}
