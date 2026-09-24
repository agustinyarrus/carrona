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

/** Fracción [t0,t1] de un tramo a..b (para los vanos de `wall`). */
const frac = (a, b, t0, t1) => [(t0 - a) / (b - a), (t1 - a) / (b - a)];
/** Punto local (lx, lz) de una pieza en (x, z) con orientación `yaw` (+X largo, +Z frente). */
const local = (x, z, yaw, lx, lz) => {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [x + lx * c + lz * s, z - lx * s + lz * c];
};

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
    this.spawns = [];          // {x, z, yaw, name}: por dónde entran los zombis
    this.points = {};          // puntos con nombre para las misiones: 'exit', 'obj1'…
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
  /** Puerta por donde entran los zombis. `name` es lo que el juego muestra ("puerta oeste"). */
  spawn(x, z, yaw, name) { this.spawns.push({ x, z, yaw, name }); }
  /** Punto con nombre para las misiones ('exit', 'obj1'…). Tiene que ser transitable. */
  point(name, x, z) { this.points[name] = { x, z }; }
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

  // ═══ piezas de los otros lugarcitos ═══════════════════════════════════════
  /** Cilindro acostado (caño, riel de cortina, brazo). `yaw` = hacia dónde apunta; centro en `y`. */
  pipe(x, y, z, yaw, r, len, color = 0x8a8f96) {
    this.cyl(x, y - len / 2, z, r, len, { yaw, roll: Math.PI / 2, color, solid: false });
  }
  /** Cartel encendido: rectángulo que brilla sobre una chapa oscura. Mira a +Z local. */
  sign(x, y, z, yaw, w, h, color, opt = {}) {
    const [bx, bz] = local(x, z, yaw, 0, -0.025);
    if (opt.back !== false) this.box(bx, y - 0.04, bz, w + 0.1, h + 0.08, 0.04, { yaw, color: opt.backColor ?? 0x24262b, solid: false });
    this.glow(x, y, z, w, h, 0.03, { yaw, color, k: opt.k ?? 1.8 });
  }
  /** Marco oscuro sobre un vano. `yaw` = orientación de la pared (0: pared a lo largo de Z). */
  doorFrame(x, z, yaw, w = 2.2, opt = {}) {
    this.box(x, opt.y ?? 2.3, z, opt.thick ?? 0.34, opt.h ?? 0.7, w, { yaw, color: opt.color ?? 0x2a282e, solid: false });
  }
  /** Puertas vaivén entreabiertas en un vano: dos hojas finas, sin colisión. `yaw` = orientación de la pared. */
  swingDoors(x, z, yaw, w = 2.0, color = 0xbfc8c4) {
    for (const side of [-1, 1]) {
      const [hx, hz] = local(x, z, yaw, 0, side * (w / 2 - 0.05));
      const [px, pz] = local(hx, hz, yaw + side * 0.75, 0, -side * (w / 4 - 0.05));
      this.box(px, 0, pz, 0.05, 2.05, w / 2 - 0.1, { yaw: yaw + side * 0.75, color, solid: false });
      const [gx, gz] = local(px, pz, yaw + side * 0.75, 0.03, 0);
      this.glow(gx, 1.3, gz, 0.01, 0.4, 0.22, { yaw: yaw + side * 0.75, color: 0xcfe2ff, k: 0.5 });   // ojo de buey
    }
  }
  /** Columna de hormigón con banda de aviso amarilla a la altura del paragolpes. */
  pillar(x, z, w = 0.55, h = 2.8, opt = {}) {
    this.box(x, 0, z, w, h, w, { color: opt.color ?? 0x76767a });
    if (opt.band !== false) {
      this.box(x, 0.8, z, w + 0.03, 0.34, w + 0.03, { color: opt.band ?? 0xd9b32a, solid: false });
      this.box(x, 1.14, z, w + 0.03, 0.12, w + 0.03, { color: 0x1e1e22, solid: false });
    }
  }
  /** Auto estacionado: cuerpo bajo, cabina angosta de vidrios oscuros, ruedas y luces. Frente = +Z local. */
  car(x, z, yaw, color, opt = {}) {
    const w = 1.8, len = 4.4, hb = 0.62;
    this.box(x, 0.26, z, w, hb - 0.26, len, { yaw, color });
    const [cx, cz] = local(x, z, yaw, 0, -0.3);
    this.box(cx, hb, cz, w - 0.3, 0.52, 2.3, { yaw, color: 0x1a2028 });
    this.box(cx, hb + 0.52, cz, w - 0.36, 0.06, 2.1, { yaw, color, solid: false });
    this.box(x, hb - 0.02, z, w - 0.08, 0.04, len - 0.1, { yaw, color, solid: false });   // el canto del capó y el baúl
    for (const [lx, lz] of [[-0.82, 1.4], [0.82, 1.4], [-0.82, -1.4], [0.82, -1.4]]) {
      const [px, pz] = local(x, z, yaw, lx, lz);
      this.cyl(px, 0.2, pz, 0.31, 0.22, { yaw, roll: Math.PI / 2, color: 0x141416, solid: false });
    }
    const lit = !!opt.lights;
    for (const side of [-1, 1]) {
      const [fx, fz] = local(x, z, yaw, side * 0.62, len / 2 + 0.01);
      this.glow(fx, 0.42, fz, 0.34, 0.12, 0.03, { yaw, color: lit ? 0xfff0c8 : 0x9a9890, k: lit ? 2.6 : 0.35 });
      const [tx, tz] = local(x, z, yaw, side * 0.66, -len / 2 - 0.01);
      this.glow(tx, 0.42, tz, 0.28, 0.1, 0.03, { yaw, color: 0xff3a30, k: lit ? 1.6 : 0.3 });
    }
    if (lit) {
      const [lx, lz] = local(x, z, yaw, 0, len / 2 + 1.6);
      this.light(lx, 0.6, lz, 0xfff0c8, opt.intensity ?? 7, 8, { flicker: 0.03 });
    }
  }
  /** Casilla de cobro o boletería: base, vidrio, techito, mostrador y pantalla. Frente = +Z local. */
  booth(x, z, yaw, w = 1.8, d = 2.0, opt = {}) {
    this.box(x, 0, z, w, 1.05, d, { yaw, color: opt.color ?? 0x9a968c });
    this.box(x, 1.05, z, w, 1.15, d, { yaw, color: opt.glass ?? 0x2b3a44 });
    this.box(x, 2.2, z, w + 0.12, 0.1, d + 0.12, { yaw, color: opt.roof ?? 0x5e5b56, solid: false });
    const [mx, mz] = local(x, z, yaw, 0, d / 2 + 0.16);
    this.box(mx, 0.95, mz, w * 0.8, 0.05, 0.32, { yaw, color: 0xcfc9b8, solid: false });
    const [sx, sz] = local(x, z, yaw, 0.3, d / 2 + 0.02);
    this.screen(sx, 1.25, sz, 0.42, 0.28, yaw);
    if (opt.light) this.light(x, 1.9, z, opt.light, 4, 5, { flicker: 0.04, hz: 7 });
  }
  /** Barrera de estacionamiento: poste amarillo y brazo a rayas hacia +X local (o levantado). */
  barrier(x, z, yaw, len = 3.2, opt = {}) {
    this.box(x, 0, z, 0.32, 1.0, 0.36, { yaw, color: 0xd9b32a });
    this.box(x, 1.0, z, 0.36, 0.08, 0.4, { yaw, color: 0x2a2a2e, solid: false });
    const n = 4, seg = len / n;
    for (let k = 0; k < n; k++) {
      const color = k % 2 ? 0xe8e2d2 : 0xc8302a;
      if (opt.open) this.box(x, 1.04 + seg * k, z, 0.1, seg, 0.1, { yaw, color, solid: false });
      else {
        const [px, pz] = local(x, z, yaw, 0.2 + seg * (k + 0.5), 0);
        this.box(px, 0.86, pz, seg, 0.1, 0.1, { yaw, color, solid: false });
      }
    }
    if (!opt.open) {
      const [mx, mz] = local(x, z, yaw, 0.2 + len / 2, 0);
      this.world.addBox(mx, 0.91, mz, len / 2, 0.05, 0.05, yaw);
    }
  }
  cone(x, z) {
    this.box(x, 0, z, 0.36, 0.03, 0.36, { color: 0x1e1e22, solid: false });
    this.cyl(x, 0.03, z, 0.13, 0.6, { color: 0xe0602a, solid: false });
    this.cyl(x, 0.3, z, 0.14, 0.09, { color: 0xf2eee4, solid: false });
  }
  trash(x, z, color = 0x2f3a2f) {
    this.cyl(x, 0, z, 0.3, 0.9, { color });
    this.cyl(x, 0.9, z, 0.32, 0.06, { color: 0x1e1e22, solid: false });
  }
  /** Charco: dos manchones oscuros cruzados, se pisan. */
  puddle(x, z, r = 1.0, color = 0x0d1014) {
    this.rug(x, z, r * 2, r * 1.2, color, this.rng() * TAU);
    this.rug(x + r * 0.2, z - r * 0.1, r * 1.3, r * 1.5, color, this.rng() * TAU);
  }
  /** Escalera decorativa: escalones sólidos que suben hacia +X local, con baranda. */
  stairs(x, z, yaw, w = 1.6, len = 3.2, steps = 4, opt = {}) {
    const sl = len / steps, top = opt.h ?? 1.8, sh = top / steps;
    for (let k = 0; k < steps; k++) {
      const [px, pz] = local(x, z, yaw, -len / 2 + sl * (k + 0.5), 0);
      this.box(px, 0, pz, sl, sh * (k + 1), w, { yaw, color: opt.color ?? 0x8a8a86 });
    }
    const roll = Math.atan2(top, len);
    for (const side of opt.rails ?? [-1, 1]) {
      const [rx, rz] = local(x, z, yaw, 0, side * (w / 2 + 0.02));
      this.box(rx, top / 2 + 0.85, rz, Math.hypot(len, top), 0.05, 0.05, { yaw, roll, color: 0xbfc3c8, solid: false });
      for (const t of [-0.42, 0.42]) {
        const [qx, qz] = local(x, z, yaw, t * len, side * (w / 2 + 0.02));
        this.cyl(qx, sh * Math.ceil((t + 0.5) * steps), qz, 0.02, 0.9, { color: 0xbfc3c8, solid: false });
      }
    }
  }
  /** Pallet de madera, con una pila de cajas encima si `stack` > 0 (de 1 se trepa, de 2 bloquea). */
  pallet(x, z, yaw, stack = 0) {
    this.box(x, 0, z, 1.2, 0.14, 1.0, { yaw, color: 0x8a6a40, solid: false });
    for (const lz of [-0.36, 0, 0.36]) {
      const [px, pz] = local(x, z, yaw, 0, lz);
      this.box(px, 0.14, pz, 1.2, 0.02, 0.2, { yaw, color: 0xb08a55, solid: false });
    }
    if (!stack) return;
    this.box(x, 0.16, z, 1.1, 0.5 * stack, 0.9, { yaw, color: 0xc4a068 });
    for (let k = 0; k <= stack; k++) this.box(x, 0.16 + 0.5 * k - 0.015, z, 1.12, 0.03, 0.92, { yaw, color: 0x8a6a40, solid: false });
    this.box(x, 0.16 + 0.5 * stack - 0.05, z, 0.5, 0.02, 0.92, { yaw, color: 0x8a6a40, solid: false });   // cinta de embalar
  }
  /** Góndola de supermercado: dos caras de estantes llenas de productos de colores. Larga en X local. */
  shelf(x, z, yaw, len = 8, opt = {}) {
    const R = this.rng, h = opt.h ?? 1.7, w = 0.9;
    this.box(x, 0, z, len, h, 0.3, { yaw, color: opt.color ?? 0xd6d3cc, solid: false });
    this.box(x, 0, z, len, 0.12, w, { yaw, color: 0x3a3a3e, solid: false });
    this.world.addBox(x, h / 2, z, len / 2, h / 2, w / 2, yaw);
    const cols = opt.colors ?? [0xd94b3a, 0xe8b23a, 0x3a8fd9, 0x5fb35a, 0xe8e2d2, 0x8a4ad9, 0xf07a2a, 0x2b2d33, 0xf0d8a8];
    const levels = 4, step = (h - 0.16) / levels;
    for (const side of [-1, 1]) {
      for (let k = 0; k < levels; k++) {
        const y = 0.12 + k * step;
        const [sx, sz] = local(x, z, yaw, 0, side * (w / 2 - 0.15));
        this.box(sx, y, sz, len, 0.03, 0.3, { yaw, color: 0xbfbcb4, solid: false });
        let lx = -len / 2 + 0.06;
        while (lx < len / 2 - 0.5) {
          const pw = 0.5 + R() * 0.9, ph = 0.14 + R() * (step - 0.2);
          const [px, pz] = local(x, z, yaw, lx + pw / 2, side * (w / 2 - 0.16));
          this.box(px, y + 0.03, pz, pw - 0.05, ph, 0.24, { yaw, color: cols[R.int(0, cols.length - 1)], solid: false });
          lx += pw;
        }
      }
    }
    for (const e of [-1, 1]) {
      const [ex, ez] = local(x, z, yaw, e * (len / 2 + 0.03), 0);
      this.glow(ex, 1.2, ez, 0.04, 0.32, 0.5, { yaw, color: opt.signColor ?? 0xffd24a, k: 1.5 });
    }
  }
  /** Caja registradora: mostrador con cinta, registradora, pantalla y el número encendido. Larga en X local, el cliente pasa por +Z. */
  checkout(x, z, yaw, opt = {}) {
    this.box(x, 0, z, 2.6, 0.88, 0.7, { yaw, color: opt.color ?? 0x8c8f96 });
    this.box(x, 0.88, z, 2.64, 0.05, 0.74, { yaw, color: 0xd3cfc4, solid: false });
    const [bx, bz] = local(x, z, yaw, -0.5, 0);
    this.box(bx, 0.93, bz, 1.4, 0.02, 0.44, { yaw, color: 0x1a1b1f, solid: false });
    const [rx, rz] = local(x, z, yaw, 0.85, -0.1);
    this.box(rx, 0.93, rz, 0.4, 0.14, 0.36, { yaw, color: 0x2a2c33, solid: false });
    this.monitor(rx, 1.07, rz, yaw + Math.PI);
    const [px, pz] = local(x, z, yaw, 1.15, 0.2);
    this.cyl(px, 0.93, pz, 0.02, 1.4, { color: 0x8a8f96, solid: false });
    this.glow(px, 2.3, pz, 0.28, 0.28, 0.06, { yaw, color: opt.numColor ?? 0xffd24a, k: 1.8 });
    const [cx, cz] = local(x, z, yaw, 0.7, -0.8);
    this.chair(cx, cz, yaw + Math.PI, 0x3d4652);
  }
  /** Molinete: gabinete bajo con el trípode. Se pasa a lo largo de X local por el lado +Z. */
  turnstile(x, z, yaw) {
    this.box(x, 0, z, 1.0, 0.95, 0.28, { yaw, color: 0x8f959c });
    this.box(x, 0.95, z, 1.02, 0.04, 0.3, { yaw, color: 0x2a2c33, solid: false });
    const [hx, hz] = local(x, z, yaw, 0, 0.14);
    this.cyl(hx, 0.78, hz, 0.05, 0.1, { color: 0x2a2c33, solid: false });
    for (const a of [0, 2.1, -2.1]) {
      const [px, pz] = local(hx, hz, yaw, 0, Math.cos(a) * 0.22);
      this.cyl(px, 0.83 + Math.sin(a) * 0.22 - 0.22, pz, 0.018, 0.44, { yaw, pitch: Math.PI / 2 - a, color: 0xbfc3c8, solid: false });
    }
  }
  /** Changuito de super: canasto de rejilla sobre ruedas, manija roja atrás. Frente = +Z local. */
  cart(x, z, yaw, color = 0x9aa0a8) {
    this.box(x, 0.42, z, 0.54, 0.02, 0.9, { yaw, color, solid: false });
    for (const [lx, lz, w, d] of [[-0.26, 0, 0.03, 0.9], [0.26, 0, 0.03, 0.9], [0, 0.44, 0.54, 0.03], [0, -0.44, 0.54, 0.03]]) {
      const [px, pz] = local(x, z, yaw, lx, lz);
      this.box(px, 0.42, pz, w, 0.44, d, { yaw, color, solid: false });
    }
    this.world.addBox(x, 0.43, z, 0.27, 0.43, 0.45, yaw);
    for (const [lx, lz] of [[-0.2, 0.36], [0.2, 0.36], [-0.2, -0.36], [0.2, -0.36]]) {
      const [px, pz] = local(x, z, yaw, lx, lz);
      this.cyl(px, 0.2, pz, 0.018, 0.22, { color: 0x6a6e74, solid: false });
      this.cyl(px, 0.1, pz, 0.05, 0.06, { color: 0x1e1e22, solid: false });
    }
    const [hx, hz] = local(x, z, yaw, 0, -0.5);
    this.pipe(hx, 0.95, hz, yaw, 0.022, 0.58, 0xc8302a);
  }
  /** Estantería metálica de depósito: cuatro parantes, estantes y cajas. Larga en X local. */
  rack(x, z, yaw, len = 3.6, opt = {}) {
    const R = this.rng, d = 0.9, h = 2.4;
    for (const [lx, lz] of [[-len / 2 + 0.04, -d / 2 + 0.04], [len / 2 - 0.04, -d / 2 + 0.04], [-len / 2 + 0.04, d / 2 - 0.04], [len / 2 - 0.04, d / 2 - 0.04]]) {
      const [px, pz] = local(x, z, yaw, lx, lz);
      this.box(px, 0, pz, 0.07, h, 0.07, { yaw, color: opt.color ?? 0x3d4a6a, solid: false });
    }
    this.world.addBox(x, h / 2, z, len / 2, h / 2, d / 2, yaw);
    const cols = opt.colors ?? [0xcaa66b, 0xbf9a5f, 0xd2ae78, 0x8a8fa0];
    for (let k = 0; k < 4; k++) {
      const y = 0.15 + k * 0.72;
      this.box(x, y, z, len, 0.05, d, { yaw, color: 0x8a6a40, solid: false });
      let lx = -len / 2 + 0.1;
      while (lx < len / 2 - 0.4) {
        const bw = 0.4 + R() * 0.5;
        if (R() < 0.8) {
          const [px, pz] = local(x, z, yaw, lx + bw / 2, (R() - 0.5) * 0.25);
          this.box(px, y + 0.05, pz, bw - 0.08, 0.28 + R() * 0.3, 0.5 + R() * 0.3, { yaw: yaw + (R() - 0.5) * 0.15, color: cols[R.int(0, cols.length - 1)], solid: false });
        }
        lx += bw;
      }
    }
  }
  /** Mostrador de frutas: cajones sobre una mesa baja, llenos de esferas de colores. Largo en X local. */
  fruitStand(x, z, yaw, len = 2.4, opt = {}) {
    const R = this.rng;
    this.box(x, 0, z, len, 0.72, 1.1, { yaw, color: opt.color ?? 0x3f5a3a });
    this.box(x, 0.72, z, len + 0.04, 0.06, 1.14, { yaw, color: 0x8a6a40, solid: false });
    const cols = opt.colors ?? [0xe08a2a, 0xc83a3a, 0x7ab04a, 0xe8c83a, 0x6a3a8a, 0xd8d0a0];
    const nb = Math.round(len / 0.6);
    for (let k = 0; k < nb; k++) {
      const lx = -len / 2 + (k + 0.5) * (len / nb);
      for (const lz of [-0.28, 0.28]) {
        const [bx, bz] = local(x, z, yaw, lx, lz);
        this.box(bx, 0.78, bz, 0.54, 0.16, 0.5, { yaw, color: 0x8a6a40, solid: false });
        const fc = cols[R.int(0, cols.length - 1)];
        for (let i = 0; i < 6; i++) {
          const [fx, fz] = local(x, z, yaw, lx + (R() - 0.5) * 0.36, lz + (R() - 0.5) * 0.32);
          this.sphere(fx, 0.94 + (R() < 0.3 ? 0.06 : 0), fz, 0.07, 0.07, 0.07, { color: fc });
        }
      }
    }
  }
  /** Heladera de supermercado: mueble blanco con la vidriera encendida. Frente = +Z local. */
  fridgeCase(x, z, yaw, len = 2.4, opt = {}) {
    const R = this.rng;
    this.box(x, 0, z, len, 2.0, 0.85, { yaw, color: opt.color ?? 0xe4e4e0 });
    const [fx, fz] = local(x, z, yaw, 0, 0.43);
    this.glow(fx, 0.35, fz, len - 0.2, 1.45, 0.02, { yaw, color: opt.glow ?? 0xbfe6ff, k: opt.k ?? 0.8 });
    for (let k = 0; k < 3; k++) {
      const [px, pz] = local(x, z, yaw, 0, 0.46);
      this.box(px, 0.5 + k * 0.45, pz, len - 0.3, 0.16, 0.03, { yaw, color: [0xd94b3a, 0x3a8fd9, 0xe8e2d2, 0x5fb35a][R.int(0, 3)], solid: false });
    }
    this.box(fx, 1.84, fz, len - 0.1, 0.12, 0.06, { yaw, color: 0x2a2c33, solid: false });
    if (opt.light) {
      const [lx, lz] = local(x, z, yaw, 0, 1.1);
      this.light(lx, 1.2, lz, opt.glow ?? 0xbfe6ff, 5, 5, { flicker: 0.05, hz: 11 });
    }
  }
  /** Cajero automático contra una pared. Frente = +Z local. */
  atm(x, z, yaw, color = 0x2b3a5c) {
    this.box(x, 0, z, 0.7, 1.6, 0.6, { yaw, color });
    const [fx, fz] = local(x, z, yaw, 0, 0.31);
    this.glow(fx, 1.05, fz, 0.32, 0.24, 0.02, { yaw, color: 0x8ad0ff, k: 1.3 });
    this.box(fx, 0.72, fz, 0.5, 0.22, 0.14, { yaw, color: 0x1e1e22, solid: false });
  }
  /** Vías: cama de balasto oscura, durmientes y dos rieles. Nada bloquea. De x0 a x1 en z. */
  railTrack(x0, x1, z, opt = {}) {
    const len = x1 - x0, cx = (x0 + x1) / 2;
    this.rug(cx, z, len, opt.w ?? 3.8, opt.bed ?? 0x1a191c);
    const step = 0.7, n = Math.floor(len / step);
    for (let k = 0; k < n; k++) this.box(x0 + (k + 0.5) * step, 0.012, z, 0.24, 0.1, 2.4, { color: 0x4a3c30, solid: false });
    for (const dz of [-0.72, 0.72]) this.box(cx, 0.11, z + dz, len, 0.09, 0.08, { color: 0x8a8f96, solid: false });
  }
  /** Vagón detenido: caja grande sólida, ventanas encendidas y puertas abiertas oscuras. Largo en X; el andén queda a +Z. */
  train(x, z, len = 15, opt = {}) {
    const w = 2.9, h = 3.1, color = opt.color ?? 0x9aa0a6;
    this.box(x, 0.35, z, len, h - 0.35, w, { color });
    this.box(x, 0.1, z, len - 0.4, 0.3, w - 0.6, { color: 0x2a2c33, solid: false });
    this.box(x, h, z, len - 0.3, 0.12, w - 0.5, { color: 0x6f757c, solid: false });
    this.box(x, 1.05, z + w / 2 + 0.01, len, 0.22, 0.02, { color: opt.band ?? 0xc8302a, solid: false });
    const doors = opt.doors ?? [-len / 4, len / 4];
    for (let wx = -len / 2 + 0.9; wx < len / 2 - 0.6; wx += 1.5) {
      if (doors.some(d => Math.abs(wx - d) < 1.25)) continue;
      this.glow(x + wx, 1.45, z + w / 2 + 0.02, 1.0, 0.75, 0.03, { color: 0xffd98a, k: 1.5 });
      this.glow(x + wx, 1.45, z - w / 2 - 0.02, 1.0, 0.75, 0.03, { color: 0xffd98a, k: 0.8 });
    }
    for (const d of doors) {
      this.box(x + d, 0.35, z + w / 2 + 0.03, 1.4, 2.0, 0.04, { color: 0x08080a, solid: false });
      this.glow(x + d, 2.4, z + w / 2 + 0.03, 1.4, 0.08, 0.03, { color: 0xff8a3a, k: 1.6 });   // luz de puerta abierta
    }
    for (const e of [-1, 1]) this.glow(x + e * (len / 2 + 0.01), 1.2, z, 0.03, 0.3, 0.4, { color: e === (opt.front ?? 1) ? 0xfff0c8 : 0xff3a30, k: 2.2 });
  }
  /** Cama de hospital: base con ruedas, colchón, almohada, frazada, respaldo y barandas. Cabecera = -Z local. */
  bed(x, z, yaw, opt = {}) {
    const w = 0.95, len = 2.1;
    this.box(x, 0.12, z, w - 0.1, 0.36, len - 0.2, { yaw, color: 0x6e7278 });
    this.box(x, 0.48, z, w, 0.2, len, { yaw, color: opt.sheet ?? 0xe8e6e0, solid: false });
    const [px, pz] = local(x, z, yaw, 0, -len / 2 + 0.3);
    this.box(px, 0.68, pz, 0.5, 0.1, 0.34, { yaw, color: 0xf2f0ea, solid: false });
    const [bx, bz] = local(x, z, yaw, 0, 0.32);
    this.box(bx, 0.68, bz, w + 0.02, 0.06, len - 0.9, { yaw, color: opt.blanket ?? 0x7aa0c8, solid: false });
    if (opt.patient) this.box(bx, 0.74, bz, 0.42, 0.14, len - 1.1, { yaw, color: opt.blanket ?? 0x7aa0c8, solid: false });
    for (const [lz, h] of [[-len / 2 - 0.03, 1.0], [len / 2 + 0.03, 0.85]]) {
      const [hx, hz] = local(x, z, yaw, 0, lz);
      this.box(hx, 0.2, hz, w, h - 0.2, 0.06, { yaw, color: 0xbfc3c8, solid: false });
    }
    for (const side of [-1, 1]) {
      const [rx, rz] = local(x, z, yaw, side * (w / 2 + 0.02), 0.1);
      this.box(rx, 0.72, rz, 0.04, 0.22, 1.2, { yaw, color: 0xbfc3c8, solid: false });
    }
    for (const [lx, lz] of [[-0.35, 0.8], [0.35, 0.8], [-0.35, -0.8], [0.35, -0.8]]) {
      const [qx, qz] = local(x, z, yaw, lx, lz);
      this.cyl(qx, 0, qz, 0.06, 0.12, { color: 0x1e1e22, solid: false });
    }
  }
  /** Camilla: colchoneta sobre un bastidor con ruedas. Larga en Z local. */
  gurney(x, z, yaw, opt = {}) {
    this.box(x, 0.74, z, 0.7, 0.06, 2.0, { yaw, color: 0xbfc3c8, solid: false });
    this.box(x, 0.8, z, 0.66, 0.1, 1.95, { yaw, color: opt.color ?? 0x3d5a7a, solid: false });
    if (opt.sheet) this.box(x, 0.9, z, 0.6, 0.05, 1.3, { yaw, color: 0xe8e6e0, solid: false });
    for (const [lx, lz] of [[-0.28, 0.82], [0.28, 0.82], [-0.28, -0.82], [0.28, -0.82]]) {
      const [px, pz] = local(x, z, yaw, lx, lz);
      this.cyl(px, 0.08, pz, 0.02, 0.66, { color: 0x8a8f96, solid: false });
      this.cyl(px, 0, pz, 0.06, 0.08, { color: 0x1e1e22, solid: false });
    }
    this.world.addBox(x, 0.44, z, 0.35, 0.44, 1.0, yaw);
  }
  /** Cortina de hospital colgada de su riel: fina, no bloquea. Larga en X local. */
  curtain(x, z, yaw, len = 2.2, color = 0xa8c8b8) {
    this.box(x, 0.35, z, len, 2.0, 0.04, { yaw, color, solid: false });
    this.pipe(x, 2.38, z, yaw, 0.015, len + 0.2);
  }
  /** Monitor de signos vitales en un poste con ruedas: pantalla verde. Mira a +Z local. */
  vitals(x, z, yaw, color = 0x2aff7a) {
    this.cyl(x, 0, z, 0.28, 0.05, { color: 0x3a3a40, solid: false });
    this.cyl(x, 0.05, z, 0.025, 1.1, { color: 0xbfc3c8 });
    this.box(x, 1.12, z, 0.42, 0.34, 0.3, { yaw, color: 0xd6d6d2, solid: false });
    const [gx, gz] = local(x, z, yaw, 0, 0.16);
    this.glow(gx, 1.17, gz, 0.34, 0.24, 0.01, { yaw, color, k: 1.4 });
  }
  /** Pie de suero: poste fino con la bolsa colgando. */
  ivStand(x, z) {
    this.cyl(x, 0, z, 0.22, 0.04, { color: 0x3a3a40, solid: false });
    this.cyl(x, 0.04, z, 0.014, 1.9, { color: 0xbfc3c8, solid: false });
    this.box(x, 1.55, z, 0.12, 0.22, 0.05, { color: 0xdde8ee, solid: false });
  }
  /** Carro de remedios: cajonera con ruedas y frascos encima. Frente = +Z local. */
  medCart(x, z, yaw, color = 0xd6d6d2) {
    this.box(x, 0.1, z, 0.6, 0.8, 0.46, { yaw, color });
    const [fx, fz] = local(x, z, yaw, 0, 0.235);
    for (let k = 0; k < 4; k++) this.box(fx, 0.16 + k * 0.18, fz, 0.5, 0.13, 0.02, { yaw, color: [0xc83a3a, 0x3a8fd9, 0xe8c83a, 0x5fb35a][k], solid: false });
    const R = this.rng;
    for (let k = 0; k < 3; k++) {
      const [px, pz] = local(x, z, yaw, -0.18 + k * 0.18, (R() - 0.5) * 0.2);
      this.cyl(px, 0.9, pz, 0.03, 0.06 + R() * 0.06, { color: [0xe8e2d2, 0x8ad0ff, 0xc8302a][k], solid: false });
    }
  }
  /** Lámpara de quirófano: pie con brazo y el plato grande que alumbra hacia abajo. La cabeza queda sobre (hx, hz). */
  opLamp(x, z, hx, hz) {
    this.cyl(x, 0, z, 0.45, 0.08, { color: 0x8a8f96 });
    this.cyl(x, 0.08, z, 0.06, 2.3, { color: 0xbfc3c8 });
    const dx = hx - x, dz = hz - z, len = Math.hypot(dx, dz);
    this.pipe((x + hx) / 2, 2.35, (z + hz) / 2, Math.atan2(dx, dz) + Math.PI / 2, 0.035, len, 0xbfc3c8);
    this.cyl(hx, 2.1, hz, 0.5, 0.14, { color: 0xe8ecef, solid: false });
    this.glow(hx, 2.08, hz, 0.7, 0.02, 0.7, { color: 0xfff6e0, k: 2.8 });
    this.light(hx, 1.9, hz, 0xfff6e0, 12, 7, { flicker: 0.02 });
  }
  /** Mesa de operaciones: columna y tabla con sábana verde. Larga en Z local. */
  opTable(x, z, yaw) {
    this.box(x, 0, z, 0.6, 0.3, 0.9, { yaw, color: 0x8a8f96, solid: false });
    this.box(x, 0.3, z, 0.4, 0.5, 0.5, { yaw, color: 0xbfc3c8, solid: false });
    this.box(x, 0.8, z, 0.7, 0.1, 2.0, { yaw, color: 0xd6d6d2 });
    this.box(x, 0.9, z, 0.66, 0.05, 1.6, { yaw, color: 0x5a8a7a, solid: false });
    this.world.addBox(x, 0.45, z, 0.35, 0.45, 1.0, yaw);
  }
  /** Lavamanos: mueble bajo con la bacha. Contra una pared (fondo = -Z local). */
  sink(x, z, yaw) {
    this.box(x, 0, z, 0.6, 0.85, 0.5, { yaw, color: 0xe4e4e0 });
    this.box(x, 0.85, z, 0.44, 0.02, 0.36, { yaw, color: 0x9aa0a8, solid: false });
    const [tx, tz] = local(x, z, yaw, 0, -0.2);
    this.cyl(tx, 0.87, tz, 0.015, 0.22, { color: 0xbfc3c8, solid: false });
  }
  /** Dispenser de alcohol o jabón en la pared. `yaw` = orientación de la pared; mira a +Z local. */
  dispenser(x, y, z, yaw, color = 0xe8e6e0) {
    this.box(x, y, z, 0.12, 0.26, 0.1, { yaw, color, solid: false });
    this.box(x, y + 0.1, z, 0.06, 0.04, 0.16, { yaw, color: 0x2a2c33, solid: false });
  }
  /** Lavarropas industrial: caja blanca con ojo de buey redondo. Frente = +Z local. */
  washer(x, z, yaw) {
    this.box(x, 0, z, 0.7, 0.95, 0.68, { yaw, color: 0xe8e8e4 });
    const [fx, fz] = local(x, z, yaw, 0, 0.35);
    this.cyl(fx, 0.43, fz, 0.22, 0.04, { yaw, pitch: Math.PI / 2, color: 0x1e1e22, solid: false });
    this.cyl(fx, 0.425, fz, 0.16, 0.06, { yaw, pitch: Math.PI / 2, color: 0x3a5a7a, solid: false });
    this.box(fx, 0.82, fz, 0.5, 0.08, 0.03, { yaw, color: 0x2a2c33, solid: false });
  }
  /** Tubo de oxígeno: cilindro alto con la válvula. */
  gasTank(x, z, color = 0x3a6a8a) {
    this.cyl(x, 0, z, 0.12, 1.4, { color, solid: false });
    this.cyl(x, 1.4, z, 0.05, 0.14, { color: 0xbfc3c8, solid: false });
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
  L.wall(X0, Z0, X1, Z0, { ...OUT, gaps: [frac(X0, X1, 12.0, 14.0)] });          // norte
  L.wall(X0, Z1, X1, Z1, { ...OUT, gaps: [frac(X0, X1, -11.0, -9.0)] });         // sur
  L.wall(X0, Z0, X0, Z1, { ...OUT, gaps: [frac(Z0, Z1, -9.4, -7.4)] });          // oeste
  L.wall(X1, Z0, X1, Z1, { ...OUT, gaps: [frac(Z0, Z1, 6.0, 8.0)] });            // este
  // afuera de cada puerta nacen los zombis
  L.spawn(-20.7, -8.4, Math.PI / 2, 'oeste');
  L.spawn(13.0, -14.7, Math.PI, 'norte');
  L.spawn(-10.0, 14.7, 0, 'sur');
  L.spawn(20.7, 7.0, -Math.PI / 2, 'este');
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
  // misiones: la salida es la puerta sur; los objetivos, uno por ambiente
  L.point('exit', -10, 12.9);
  L.point('obj1', -12, -10.5);      // hall
  L.point('obj2', 13.7, -11.2);     // sala A
  L.point('obj3', -11.6, 7.3);      // cubículos
  L.point('obj4', 8, 11);           // sala B
  L.point('obj5', 16.6, 9);         // cocina
  return L.finish();
}

// ═════════════════════════════════════════════════════════════════════════════
//  EL ESTACIONAMIENTO — subsuelo: columnas, autos, tubos verdosos, muy oscuro
// ═════════════════════════════════════════════════════════════════════════════
export function buildParking(L) {
  const R = L.rng;
  const X0 = -22.6, X1 = 22.6, Z0 = -13.6, Z1 = 13.6;
  L.slab(25, 16);
  L.bounds = { x0: X0, z0: Z0, x1: X1, z1: Z1 };

  // ── paredes exteriores: rampa (norte), escalera (oeste), montacargas (este), salida peatonal (sur)
  const OUT = { h: 2.8, thick: 0.3, color: 0x66666a, capColor: 0x85858a };
  const IN = { h: 2.8, thick: 0.24, color: 0x737175, capColor: 0x8c8a8e };
  const TUBE = { color: 0xcdf5d2, light: true, intensity: 10, distance: 9 };   // los que alumbran de verdad
  L.wall(X0, Z0, X1, Z0, { ...OUT, gaps: [frac(X0, X1, 5.5, 7.5)] });
  L.wall(X0, Z1, X1, Z1, { ...OUT, gaps: [frac(X0, X1, -6, -4)] });
  L.wall(X0, Z0, X0, Z1, { ...OUT, gaps: [frac(Z0, Z1, -11.5, -9.5)] });
  L.wall(X1, Z0, X1, Z1, { ...OUT, gaps: [frac(Z0, Z1, -2, 0)] });
  L.spawn(6.5, -14.7, Math.PI, 'rampa');
  L.spawn(-23.7, -10.5, Math.PI / 2, 'escalera');
  L.spawn(23.7, -1.0, -Math.PI / 2, 'montacargas');
  L.spawn(-5.0, 14.7, 0, 'sur');
  L.doorFrame(6.5, Z0, Math.PI / 2, 2.2, { y: 2.1 });
  L.doorFrame(X0, -10.5, 0, 2.2, { y: 2.1 });
  L.doorFrame(X1, -1.0, 0, 2.2, { y: 2.1, color: 0x4a4e55 });
  L.doorFrame(-5.0, Z1, Math.PI / 2, 2.2, { y: 2.1 });

  // ── columnas en grilla y las bahías pintadas ──────────────────────────────
  const COLS = [-13.3, -5.2, 2.9, 11.0];
  for (const x of COLS) for (const z of [-8.3, 1.3, 6.4]) L.pillar(x, z);
  const bays = (z, x0, n) => { for (let k = 0; k <= n; k++) L.rug(x0 + k * 2.7, z, 0.1, 4.6, 0xd8d8d0); };
  bays(-10.9, -16, 8); bays(-1.2, -16, 10); bays(3.8, -16, 10);
  L.rug(-5, -5.9, 30, 0.4, 0x46484b); L.rug(-3, 8.0, 26, 0.4, 0x46484b);     // marcas de neumáticos
  for (const [x, z, dir] of [[-8, -5.9, 1], [4, -5.9, 1], [-6, 8.0, -1], [7, 8.0, -1]]) {   // flechas pintadas
    L.rug(x, z, 2.4, 0.16, 0xd8d8d0);
    L.rug(x + dir * 1.0, z - 0.3, 0.9, 0.16, 0xd8d8d0, dir * 0.75); L.rug(x + dir * 1.0, z + 0.3, 0.9, 0.16, 0xd8d8d0, -dir * 0.75);
  }

  // ── autos: fila norte contra la pared, doble fila en el medio, unos pocos al sur
  const CAR = [0x5b6068, 0x6e2f2a, 0x2f3d55, 0x8a8a7a, 0x2d3a2d, 0x1e1f24, 0xb9b9b0, 0x7a5a2a];
  const carAt = (x, z, yaw, opt) => L.car(x, z, yaw + (R() - 0.5) * 0.08, CAR[R.int(0, CAR.length - 1)], opt);
  for (const x of [-14.65, -6.55, -3.85, 1.55, 4.25]) carAt(x, -10.9, Math.PI);
  carAt(-11.95, -10.9, Math.PI, { lights: true });
  for (const x of [-14.65, -9.25, -6.55, -1.15, 4.25, 9.65]) carAt(x, -1.2, Math.PI);
  for (const x of [-11.95, -3.85, 1.55, 6.95]) carAt(x, 3.8, 0);
  carAt(-9.25, 3.8, 0, { lights: true });
  for (const x of [-12.5, -9.0]) carAt(x, 11.0, 0);
  L.car(16.6, 0.4, 0.42, 0x6e2f2a);                                            // uno cruzado, abandonado
  L.puddle(-9.25, -10.6, 1.1); L.puddle(-3.2, -5.6, 0.8); L.puddle(6.4, 4.6, 1.3); L.puddle(-18.5, 3.5, 0.9);
  L.cone(-1.3, -11.6); L.cone(-0.8, -10.3); L.cone(16.0, -2.6); L.cone(18.4, 2.3);

  // ── caja de escalera (noroeste) ───────────────────────────────────────────
  L.wall(-17.6, Z0, -17.6, -7.6, { ...IN, gaps: [frac(Z0, -7.6, -11, -9)] });
  L.wall(X0, -7.6, -17.6, -7.6, IN);
  L.stairs(-20.1, -12.55, 0, 1.5, 4.2, 4, { h: 2.0, rails: [1] });
  L.sign(-22.4, 2.25, -10.5, Math.PI / 2, 0.9, 0.28, 0x3ddc84);              // SALIDA sobre la puerta
  L.cyl(-18.0, 0, -8.2, 0.08, 0.55, { color: 0xc8302a, solid: false });       // matafuego
  L.cardboard(-19.5, -9.2, 0.4, 0.5); L.cardboard(-18.6, -8.4, 1.1, 0.45);
  L.tube(-17.78, 2.4, -10.5, Math.PI / 2, 1.3, { ...TUBE, flicker: 0.4 });
  L.sign(-17.78, 1.7, -8.6, -Math.PI / 2, 0.5, 0.5, 0x3a6fd6, { k: 1.2 });  // la "P" azul
  L.puddle(-21.0, -9.0, 0.7);

  // ── franja oeste: motos, cartelería, un tablero eléctrico ─────────────────
  for (let k = 0; k < 3; k++) {
    const x = -21.7, z = -4.6 + k * 1.1, yaw = Math.PI / 2 + (R() - 0.5) * 0.2;
    L.box(x, 0.28, z, 0.42, 0.5, 1.9, { yaw, color: [0x1e1f24, 0x8a2a2a, 0x2f3d55][k] });
    L.box(x, 0.78, z - 0.2, 0.36, 0.1, 0.7, { yaw, color: 0x1a1a1c, solid: false });
    for (const lx of [-0.75, 0.75]) L.cyl(x + lx * Math.cos(yaw), 0.16, z - lx * Math.sin(yaw), 0.28, 0.14, { yaw, roll: Math.PI / 2, color: 0x141416, solid: false });
  }
  L.box(-22.2, 0, 1.2, 0.4, 1.9, 0.8, { color: 0x8a8d92 });                    // tablero eléctrico
  L.glow(-21.98, 1.5, 1.0, 0.02, 0.05, 0.05, { color: 0x3aff6a, k: 2.2 });
  L.sign(-22.4, 2.2, 4.5, Math.PI / 2, 1.6, 0.35, 0xd8d8d0, { k: 0.9 });     // cartel de sector
  L.trash(-22.0, 6.8, 0x3a3f3a);
  L.tube(-22.45, 2.4, -2.5, Math.PI / 2, 1.3, { color: 0xcdf5d2 });
  L.tube(-22.45, 2.4, 5.5, Math.PI / 2, 1.3, { ...TUBE, flicker: 0.35 });

  // ── rampa de salida (noreste) con su cabina de cobro y barreras ───────────
  L.box(15.5, 0.955, -11.1, 12, 0.25, 4.4, { roll: 0.16, color: 0x6e6e72, solid: false });
  L.world.addBox(15.5, 1.0, -11.1, 6, 1.0, 2.2);                                // la rampa es maciza
  L.box(15.5, 0, -8.75, 12.2, 0.32, 0.2, { color: 0xd9b32a });                  // cordón amarillo
  L.box(21.9, 2.2, -11.1, 1.2, 0.6, 4.4, { color: 0x0a0b0d, solid: false });    // boca del túnel de la rampa
  L.sign(22.4, 2.5, -11.1, -Math.PI / 2, 1.2, 0.3, 0x3ddc84);
  L.barrier(9.3, -13.1, -Math.PI / 2, 3.6);                                     // cerrada: nadie sube
  for (let k = 0; k < 4; k++) L.rug(7.4, -12.6 + k * 1.1, 1.6, 0.16, 0xd9b32a, 0.55);   // chevrones de la playa
  L.rug(7.4, -12.6 + 1.65, 1.6, 0.16, 0xd9b32a, -0.55); L.rug(7.4, -12.6 + 2.75, 1.6, 0.16, 0xd9b32a, -0.55);
  L.booth(10.8, -6.6, -Math.PI / 2, 1.8, 2.2, { color: 0x8f8b80, glass: 0x2a3a3f, light: 0xd7ffe0 });
  L.barrier(9.5, -8.0, Math.PI, 3.4, { open: true });                            // levantada: la playa
  L.sign(7.4, 2.25, -13.4, 0, 0.9, 0.5, 0x3a6fd6, { k: 1.4 });
  L.cone(8.6, -10.4); L.cone(8.9, -9.4);
  L.tube(-9, 2.5, -13.45, 0, 1.4, { ...TUBE, flicker: 0.45 });
  L.tube(0, 2.5, -13.45, 0, 1.4, { ...TUBE, flicker: 0.3 });
  L.tube(-13.3, 2.5, -7.95, 0, 1.2, { ...TUBE, flicker: 0.4 });
  L.tube(-5.2, 2.5, 1.65, 0, 1.2, { ...TUBE, flicker: 0.5 });
  L.tube(2.9, 2.5, 6.75, 0, 1.2, { ...TUBE, flicker: 0.3 });
  L.tube(11.0, 2.5, 1.65, 0, 1.2, { color: 0xcdf5d2 });
  L.tube(-13.3, 2.5, 6.75, 0, 1.2, { color: 0xcdf5d2 });
  L.tube(2.9, 2.5, -7.95, 0, 1.2, { color: 0xcdf5d2 });

  // ── el fondo este: montacargas, cajero de pago, cachivaches ───────────────
  L.glow(22.44, 2.05, -1.0, 0.05, 0.1, 2.4, { color: 0xffd24a, k: 1.6 });
  for (const z of [-2.15, 0.15]) L.box(22.35, 0, z, 0.2, 2.05, 0.14, { color: 0x4a4e55, solid: false });
  L.sign(22.4, 2.5, -1.0, -Math.PI / 2, 1.4, 0.3, 0xffd24a, { k: 1.2 });
  L.light(21.6, 2.3, -1.0, 0xff4a3a, 3.5, 6, { flicker: 0.6, hz: 3 });          // baliza roja
  L.atm(21.85, 2.8, -Math.PI / 2, 0x3a4a5c);
  L.trash(21.9, -4.6); L.trash(21.9, 4.2);
  L.box(22.3, 1.0, -6.2, 0.2, 0.7, 0.6, { color: 0xc8302a, solid: false });    // gabinete de manguera
  for (let k = 0; k < 3; k++) L.cyl(19.6, k * 0.22, -6.4, 0.35, 0.22, { color: 0x1a1a1c, solid: k === 0 });
  for (let k = 0; k < 3; k++) L.cyl(20.4, k * 0.22, -6.9, 0.35, 0.22, { color: 0x1a1a1c, solid: k === 0 });
  L.cardboard(20.6, -8.0, 0.3, 0.6); L.cardboard(21.3, -7.4, 1.0, 0.5); L.cardboard(13.5, 4.9, 0.6, 0.55);
  L.tube(22.45, 2.4, -5.5, Math.PI / 2, 1.3, { ...TUBE, flicker: 0.3 });
  L.tube(22.45, 2.4, 4.0, Math.PI / 2, 1.3, { color: 0xcdf5d2 });
  L.puddle(17.5, -5.0, 1.0);

  // ── franja sur: salida peatonal, motos, contenedor, depósito de limpieza ──
  L.rug(-5, 10.1, 1.4, 6.6, 0x2f5a3a);
  L.rug(-5.75, 10.1, 0.08, 6.6, 0xd8d8d0); L.rug(-4.25, 10.1, 0.08, 6.6, 0xd8d8d0);
  L.sign(-5, 2.3, 13.4, Math.PI, 0.9, 0.28, 0x3ddc84);
  L.atm(-9.4, 13.05, Math.PI, 0x8a3a2a);                                        // máquina de pago
  for (let k = 0; k < 3; k++) {
    const x = 2.2 + k * 1.0, z = 12.2, yaw = (R() - 0.5) * 0.25;
    L.box(x, 0.28, z, 0.42, 0.5, 1.9, { yaw, color: [0x1e1f24, 0x2f3d55, 0x8a2a2a][k] });
    L.box(x, 0.78, z - 0.2, 0.36, 0.1, 0.7, { yaw, color: 0x1a1a1c, solid: false });
    for (const lz of [-0.75, 0.75]) L.cyl(x + lz * Math.sin(yaw), 0.16, z + lz * Math.cos(yaw), 0.28, 0.14, { yaw: yaw + Math.PI / 2, roll: Math.PI / 2, color: 0x141416, solid: false });
  }
  L.box(8.5, 0, 12.5, 2.0, 1.3, 1.1, { color: 0x2f5a3a });                      // contenedor
  L.box(8.5, 1.3, 12.5, 2.04, 0.1, 1.14, { color: 0x24482e, solid: false });
  L.cardboard(7.0, 12.4, 0.5, 0.6); L.cardboard(10.1, 12.6, 0.2, 0.5); L.cardboard(6.6, 11.6, 1.3, 0.45);
  L.trash(0.6, 12.9);
  L.wall(-18.6, 8.6, -18.6, Z1, { ...IN, gaps: [frac(8.6, Z1, 10.0, 12.0)] });
  L.wall(X0, 8.6, -18.6, 8.6, IN);
  L.rack(-20.6, 12.9, 0, 2.4, { colors: [0xe8e2d2, 0x3a8fd9, 0xd9b32a] });
  L.sink(-21.9, 9.4, Math.PI / 2);
  L.cyl(-19.3, 0, 12.6, 0.2, 0.32, { color: 0xd9b32a, solid: false });          // balde
  L.cyl(-19.3, 0.32, 12.6, 0.015, 1.3, { color: 0x8a6a40, solid: false });      // el palo del secador
  L.cardboard(-21.5, 11.0, 0.7, 0.45);
  L.tube(-20.6, 2.4, 13.45, 0, 1.2, { color: 0xcdf5d2 });
  L.tube(-12, 2.4, 13.45, 0, 1.4, { ...TUBE, flicker: 0.35 });
  L.tube(-3, 2.4, 13.45, 0, 1.4, { color: 0xcdf5d2 });

  // ── sala de máquinas (sudeste) ────────────────────────────────────────────
  L.wall(14, 6, X1, 6, { ...IN, gaps: [frac(14, X1, 15.5, 17.5)] });
  L.wall(14, 6, 14, Z1, IN);
  L.doorFrame(16.5, 6, Math.PI / 2, 2.2, { y: 2.1, thick: 0.28 });
  L.box(19.5, 0, 10.6, 2.6, 1.3, 1.4, { color: 0x3d5a3a });                     // grupo electrógeno
  L.box(19.5, 1.3, 10.6, 2.2, 0.3, 1.0, { color: 0x4f7048, solid: false });
  L.cyl(20.5, 1.6, 10.9, 0.08, 1.2, { color: 0x3a3a40, solid: false });
  for (let k = 0; k < 3; k++) L.glow(18.4 + k * 0.2, 1.0, 9.88, 0.08, 0.08, 0.02, { color: k === 1 ? 0xff3030 : 0x3aff6a, k: 2 });
  L.cyl(16.0, 0, 12.1, 0.9, 2.3, { color: 0x6a6e73 });                          // tanque
  L.cyl(16.0, 2.3, 12.1, 0.3, 0.2, { color: 0x4a4e55, solid: false });
  L.cyl(18.6, 0, 8.4, 0.35, 0.7, { color: 0x3a5a8a });                          // bomba
  L.box(18.6, 0.7, 8.4, 0.5, 0.3, 0.3, { color: 0x8a8d92, solid: false });
  for (let k = 0; k < 3; k++) L.box(22.1, 0, 7.5 + k * 0.9, 0.5, 1.9, 0.8, { color: 0x8a8d92 });
  for (let k = 0; k < 3; k++) L.glow(21.84, 1.5, 7.5 + k * 0.9, 0.02, 0.05, 0.05, { color: k === 2 ? 0xff3030 : 0x3aff6a, k: 2.2 });
  L.pipe(18.3, 2.3, 6.3, 0, 0.06, 8.4, 0x8a3a2a);
  L.pipe(18.3, 2.05, 6.42, 0, 0.05, 8.4, 0x8a8f96);
  L.cyl(14.2, 0, 6.3, 0.1, 2.3, { color: 0x8a3a2a, solid: false });
  L.glow(15.2, 1.6, 13.42, 0.5, 0.42, 0.02, { color: 0xffd24a, k: 1.0 });      // cartel de peligro
  L.puddle(17.3, 10.8, 1.0, 0x0e1416);
  L.cardboard(14.9, 12.6, 0.3, 0.5);
  L.tube(18, 2.4, 13.45, 0, 1.4, { ...TUBE, flicker: 0.5 });

  // ── cajas sueltas en los rincones ─────────────────────────────────────────
  for (let i = 0; i < 4; i++) L.cardboard(-16.5 + R() * 3, -6.6 + R() * 1.6, R() * TAU, 0.5);
  for (let i = 0; i < 3; i++) L.cardboard(12.5 + R() * 3, -6.0 + R() * 1.8, R() * TAU, 0.45);
  L.cardboard(-16.8, 7.2, 0.4, 0.55); L.cardboard(-16.0, 7.6, 1.0, 0.5);

  L.playerStart = { x: -4, z: -6 };
  L.point('exit', 6.5, -12.2);      // la playa al pie de la rampa
  L.point('obj1', -19.8, -3.6);     // franja oeste
  L.point('obj2', 13.5, -5.4);      // la cabina de cobro
  L.point('obj3', 16.5, 8.0);       // sala de máquinas
  L.point('obj4', -16, 10.5);       // fondo sudoeste
  L.point('obj5', -2, 8.5);         // la salida peatonal
  return L.finish();
}

// ═════════════════════════════════════════════════════════════════════════════
//  EL SUPERMERCADO — góndolas en fila, heladeras encendidas, cajas, depósito
// ═════════════════════════════════════════════════════════════════════════════
export function buildSuper(L) {
  const R = L.rng;
  const X0 = -21.6, X1 = 21.6, Z0 = -14.6, Z1 = 14.6;
  L.slab(24, 17);
  L.bounds = { x0: X0, z0: Z0, x1: X1, z1: Z1 };

  // ── paredes: entrada (sur), depósito (norte), carga y salida de emergencia (este)
  const OUT = { h: 3.0, thick: 0.3, color: 0xb5b1a6, capColor: 0xd2cec4 };
  const IN = { h: 3.0, thick: 0.24, color: 0xc2beb2, capColor: 0xd8d4ca };
  L.wall(X0, Z0, X1, Z0, { ...OUT, gaps: [frac(X0, X1, 13, 15)] });
  L.wall(X0, Z1, X1, Z1, { ...OUT, gaps: [frac(X0, X1, -8, -6)] });
  L.wall(X0, Z0, X0, Z1, OUT);
  L.wall(X1, Z0, X1, Z1, { ...OUT, gaps: [frac(Z0, Z1, -11, -9), frac(Z0, Z1, 3, 5)] });
  L.spawn(-7.0, 15.7, 0, 'entrada');
  L.spawn(14.0, -15.7, Math.PI, 'depósito');
  L.spawn(22.7, -10.0, -Math.PI / 2, 'carga');
  L.spawn(22.7, 4.0, -Math.PI / 2, 'este');
  L.doorFrame(-7.0, Z1, Math.PI / 2, 2.2, { color: 0x3a3c40 });
  L.doorFrame(14.0, Z0, Math.PI / 2);
  L.doorFrame(X1, -10.0, 0, 2.4, { color: 0x4a4e55, h: 0.9, y: 2.1 });        // portón de carga
  L.doorFrame(X1, 4.0, 0);
  L.wall(6, Z0, 6, -4, { ...IN, gaps: [frac(Z0, -4, -9.5, -7.5)] });
  L.wall(6, -4, X1, -4, { ...IN, gaps: [frac(6, X1, 10, 12)] });
  L.swingDoors(11, -4, Math.PI / 2, 2.0, 0x8a8f96);
  L.doorFrame(11, -4, Math.PI / 2, 2.2, { thick: 0.28 });
  L.doorFrame(6, -8.5, 0, 2.2, { thick: 0.28 });

  // ── pisos ─────────────────────────────────────────────────────────────────
  L.floor(X0, Z0, -9, -6, 'woodSlats');          // frutas y verduras
  L.floor(-9, Z0, 6, -6, 'tileBeige');           // promos y heladeras
  L.floor(X0, -6, 6, Z1, 'tileBeige');           // góndolas, cajas, entrada
  L.floor(6, -4, X1, Z1, 'tileTeal');            // fiambrería y panadería

  // ── heladeras contra la pared norte ───────────────────────────────────────
  for (let k = 0; k < 5; k++) L.fridgeCase(-7.8 + k * 2.5, -14.0, 0, 2.4, { light: k === 1 || k === 4 });
  L.sign(-2.8, 2.45, -14.4, 0, 3.0, 0.4, 0xbfe6ff, { k: 1.2 });               // LÁCTEOS

  // ── frutas y verduras (noroeste, piso de madera) ──────────────────────────
  L.fruitStand(-18.6, -12.6, 0, 2.4); L.fruitStand(-15.2, -12.6, 0, 2.4);
  L.fruitStand(-16.6, -8.8, 0, 3.0, { color: 0x4a5a3a }); L.fruitStand(-12.2, -8.8, 0, 2.4, { color: 0x4a5a3a });
  L.sign(-15, 2.35, -14.4, 0, 2.6, 0.42, 0x5fd66a, { k: 1.6 });               // FRUTAS Y VERDURAS
  L.cyl(-11.4, 0, -12.8, 0.03, 1.3, { color: 0x8a8f96, solid: false });        // balanza
  L.box(-11.4, 1.3, -12.8, 0.3, 0.2, 0.2, { color: 0xe8e2d2, solid: false });
  L.glow(-11.4, 1.35, -12.68, 0.2, 0.08, 0.02, { color: 0x3aff6a, k: 1.6 });
  for (const [x, z] of [[-20.6, -10.6], [-19.9, -7.0], [-10.2, -10.4]]) L.cyl(x, 0, z, 0.32, 0.8, { color: 0x6a4a2a });   // barricas
  L.cardboard(-20.8, -13.4, 0.3, 0.55); L.cardboard(-13.0, -13.6, 0.8, 0.5); L.cardboard(-10.0, -7.2, 0.2, 0.45);
  for (let i = 0; i < 5; i++) L.sphere(-19 + R() * 4, 0.07, -10.4 + R() * 1.6, 0.07, 0.07, 0.07, { color: [0xe08a2a, 0xc83a3a, 0x7ab04a][i % 3] });   // fruta rodada
  L.tube(-21.45, 2.5, -10, Math.PI / 2, 1.4, { color: 0xeaf4ff, light: true, flicker: 0.05 });

  // ── promos y panadería chica (norte, centro) ──────────────────────────────
  L.pallet(-3.1, -9.5, 0, 2); L.pallet(-1.9, -9.5, 0, 2);
  L.cyl(-2.5, 0, -10.3, 0.03, 2.6, { color: 0x8a8f96, solid: false });
  L.sign(-2.5, 2.4, -10.3, 0, 1.6, 0.5, 0xff3a3a, { k: 2.2 });                 // OFERTA
  L.sign(-2.5, 2.4, -10.36, Math.PI, 1.6, 0.5, 0xff3a3a, { k: 2.2, back: false });
  L.light(-2.5, 2.2, -9.4, 0xff5a4a, 5, 6, { flicker: 0.15, hz: 5 });
  for (const [x, z, c] of [[-6.6, -9.2, 0xd94b3a], [-5.5, -9.2, 0xe8b23a], [-6.6, -11.4, 0x5fb35a], [-5.5, -11.4, 0x3a8fd9]]) {
    L.cyl(x, 0, z, 0.42, 0.9, { color: 0xe4e4e0 });                            // bines de granel
    L.cyl(x, 0.9, z, 0.38, 0.06, { color: c, solid: false });
  }
  L.counter(3.5, -11.5, 0, 3.0, { color: 0xd9d3c4, top: 0x8a6a40, stuff: 4 });
  L.papers(3.5, 0.92, -11.5, 2, 0.6);
  L.cart(1.0, -7.6, 0.6); L.cardboard(4.8, -6.0, 0.3, 0.5); L.cardboard(-8.2, -7.0, 1.0, 0.5);
  L.tube(5.85, 2.5, -11, Math.PI / 2, 1.4, { color: 0xeaf4ff, light: true, flicker: 0.08 });
  L.tube(5.85, 2.5, -6.0, Math.PI / 2, 1.2, { color: 0xeaf4ff });

  // ── góndolas: cuatro filas en dos bancos ──────────────────────────────────
  let gi = 0;
  for (const z of [-5.0, -1.9, 1.2, 4.3]) {
    L.shelf(-13.5, z, 0, 9, { signColor: gi % 2 ? 0xff5a4a : 0xffd24a });
    L.shelf(-1.25, z, 0, 10.5, { signColor: gi % 2 ? 0xffd24a : 0xff5a4a });
    gi++;
  }
  L.rack(-21.0, -3.5, Math.PI / 2, 3.6, { colors: [0x4a1f2a, 0x2a3a1f, 0x6a3a2a, 0x8a6a2a] });   // vinoteca
  L.rack(-21.0, 0.5, Math.PI / 2, 3.6, { colors: [0x4a1f2a, 0x2a3a1f, 0x6a3a2a, 0x8a6a2a] });
  L.sign(-21.4, 2.4, -1.5, Math.PI / 2, 1.8, 0.4, 0xd9a0c0, { k: 1.3 });      // VINOS
  L.cart(-7.8, -3.4, 1.4); L.cart(-7.6, 2.8, -0.4);
  for (let i = 0; i < 5; i++) L.cardboard(-8.5 + R() * 1.6, -4.5 + R() * 9, R() * TAU, 0.45);
  L.papers(-4, 0.004, 6.5, 4, 2.5);
  L.tube(-21.45, 2.5, 4.5, Math.PI / 2, 1.4, { color: 0xeaf4ff, light: true, flicker: 0.06 });
  L.tube(-21.45, 2.5, -6.5, Math.PI / 2, 1.4, { color: 0xeaf4ff });

  // ── cajas registradoras y la entrada ──────────────────────────────────────
  for (let k = 0; k < 5; k++) L.checkout(-13.5 + k * 3.2, 10.6, Math.PI / 2, { numColor: k === 2 ? 0x3aff6a : 0xffd24a });
  L.cardboard(-12.2, 8.2, 0.4, 0.5); L.cardboard(-2.6, 9.6, 1.1, 0.5);
  for (const x of [-9.9, -8.85, -7.8]) L.turnstile(x, 12.7, Math.PI / 2);
  L.box(-7.2, 0, 12.7, 0.06, 1.0, 1.0, { color: 0xbfc8c4, solid: false });     // portón de salida abierto
  for (let k = 0; k < 4; k++) L.cart(-4.6 + k * 0.7, 13.3, Math.PI / 2);
  L.cart(2.0, 8.0, 0.7);
  L.atm(-13.0, 14.05, Math.PI); L.atm(-13.8, 14.05, Math.PI, 0x8a3a2a);
  L.booth(2.5, 13.4, Math.PI, 1.6, 1.4, { color: 0x8a3a2a, glass: 0x2b3a44, light: 0xffd6a0 });   // lotería
  L.sign(-7, 2.4, 14.4, Math.PI, 2.0, 0.4, 0xffffff, { k: 1.2 });             // BIENVENIDOS
  L.trash(-16.8, 13.9, 0x3a3f3a); L.trash(-0.2, 13.9, 0x3a3f3a);
  L.plant(-20.9, 13.8, true); L.plant(-1.6, 12.4);
  L.papers(-8, 0.004, 12.2, 3, 1.5);
  L.tube(-9, 2.5, 14.45, 0, 1.4, { color: 0xeaf4ff, light: true, flicker: 0.1 });
  L.tube(-2, 2.5, 14.45, 0, 1.4, { color: 0xeaf4ff });
  L.tube(-16, 2.5, 14.45, 0, 1.4, { color: 0xeaf4ff });

  // ── atención al cliente (sudoeste) ────────────────────────────────────────
  L.counter(-21.0, 9.5, Math.PI / 2, 4.0, { color: 0xd9d3c4, top: 0x6f6a62, stuff: 3 });
  L.monitor(-20.9, 0.91, 8.6, -Math.PI / 2 + 0.2);
  L.chair(-19.9, 9.2, Math.PI / 2 + 0.3, 0x3d4652);
  L.sign(-21.4, 2.3, 9.5, Math.PI / 2, 1.8, 0.36, 0xffd24a, { k: 1.3 });      // ATENCIÓN AL CLIENTE
  L.cardboard(-20.6, 6.2, 0.4, 0.55); L.cardboard(-20.0, 5.6, 1.2, 0.45);

  // ── fiambrería, panadería y el cafecito (este) ────────────────────────────
  L.counter(20.9, -0.8, Math.PI / 2, 4.6, { color: 0xd9d3c4, top: 0x8a8378, stuff: 4 });
  L.counter(20.9, 9.0, Math.PI / 2, 5.0, { color: 0xd9d3c4, top: 0x8a8378, stuff: 4 });
  L.glow(20.5, 0.92, -0.8, 0.6, 0.5, 4.2, { color: 0xffe0c0, k: 0.55 });      // vidriera de la fiambrería
  L.sign(21.4, 2.4, -0.8, -Math.PI / 2, 2.4, 0.4, 0xffb060, { k: 1.4 });      // FIAMBRERÍA
  L.sign(21.4, 2.3, 4.0, -Math.PI / 2, 0.9, 0.28, 0x3ddc84);                  // SALIDA
  L.box(8.5, 0, -3.2, 1.6, 1.9, 0.9, { color: 0x3a3c40 });                     // horno de la panadería
  L.glow(8.5, 0.8, -2.74, 1.0, 0.4, 0.02, { color: 0xff9a3a, k: 1.6 });
  L.light(8.5, 1.0, -2.0, 0xff9a3a, 5, 5, { flicker: 0.12, hz: 5 });
  L.rack(15.5, -3.2, 0, 3.0, { colors: [0xc8a060, 0xb08a50, 0xd8b878] });   // el pan
  L.counter(14, 1.0, 0, 4.0, { color: 0xd9d3c4, top: 0x8a6a40, stuff: 3 });
  L.sign(12, 2.4, -3.8, 0, 2.2, 0.4, 0xffb060, { k: 1.4 });                    // PANADERÍA
  L.shelf(12.5, 4.6, 0, 5.5, { signColor: 0x5fd6ff, colors: [0xe8e2d2, 0x3a8fd9, 0x8a8fa0, 0xd94b3a, 0x2b2d33, 0xf0d8a8] });   // bazar
  L.shelf(12.5, 8.0, 0, 5.5, { signColor: 0x5fd6ff, colors: [0xe8e2d2, 0x5fb35a, 0x8a4ad9, 0xe8b23a, 0x2b2d33] });
  for (const [x, z] of [[14.5, 12.6], [17.6, 12.6]]) {                          // el cafecito del rincón
    L.cyl(x, 0, z, 0.05, 0.72, { color: 0x3a3a40 });
    L.cyl(x, 0.72, z, 0.5, 0.05, { color: 0xd3c5a5, solid: false });
    L.world.addCylinder(x, z, 0.5, 0, 0.77);
    L.cyl(x + 0.2, 0.77, z - 0.1, 0.04, 0.09, { color: 0xe8e2d2, solid: false });
    L.chair(x - 0.9, z, Math.PI / 2, 0x3f9aa0); L.chair(x + 0.9, z + 0.2, -Math.PI / 2, 0x3f9aa0);
  }
  L.sign(16, 2.3, 14.4, Math.PI, 1.6, 0.36, 0xffb060, { k: 1.3 });            // CAFÉ
  for (let k = 0; k < 5; k++) L.box(8.2, 0.05 + k * 0.12, 5.5, 0.5, 0.12, 0.36, { yaw: 0.2 + k * 0.05, color: [0xd94b3a, 0x3a8fd9][k % 2], solid: k === 0 });   // canastos apilados
  L.box(18.6, 0, -2.0, 1.4, 0.8, 0.7, { color: 0x3f5a3a });                     // florería
  for (let k = 0; k < 6; k++) {
    const fx = 18.1 + (k % 3) * 0.5, fz = -2.2 + Math.floor(k / 3) * 0.4;
    L.cyl(fx, 0.8, fz, 0.07, 0.25, { color: 0x8a8f96, solid: false });
    L.sphere(fx, 1.12, fz, 0.13, 0.11, 0.13, { color: [0xe04a6a, 0xf0d040, 0xf2f0ea, 0xd85a2a, 0xa060d0, 0xe04a6a][k] });
  }
  L.sign(18.6, 2.3, -3.8, 0, 1.4, 0.36, 0xe04a6a, { k: 1.4 });                 // FLORES
  L.box(8.3, 0, 12.2, 1.6, 1.4, 0.4, { yaw: 0.1, color: 0x8a8fa0 });            // exhibidor de revistas
  for (let k = 0; k < 4; k++) L.box(7.75 + k * 0.38, 0.5 + (k % 2) * 0.45, 12.42, 0.3, 0.4, 0.02, { yaw: 0.1, color: [0xd94b3a, 0x3a8fd9, 0xe8b23a, 0x5fb35a][k], solid: false });
  L.pallet(17.5, 5.0, 0.3, 1); L.cart(11.5, 11.8, 2.4); L.cart(19.2, 4.0, -1.2);
  L.cardboard(19.5, 13.6, 0.5, 0.55); L.cardboard(20.3, 12.9, 1.2, 0.5); L.cardboard(7.2, 13.2, 0.3, 0.5);
  L.plant(7.0, 0.4); L.plant(20.6, 13.7);
  L.papers(10, 0.004, 4, 3, 2);
  L.tube(21.45, 2.5, 7.0, Math.PI / 2, 1.4, { color: 0xeaf4ff, light: true, flicker: 0.07 });
  L.tube(21.45, 2.5, 12.5, Math.PI / 2, 1.4, { color: 0xeaf4ff });
  L.tube(14, 2.5, 14.45, 0, 1.4, { color: 0xeaf4ff });

  // ── depósito (noreste): estanterías, pallets, portón de carga ─────────────
  L.rack(8.5, -12.3, 0, 3.6); L.rack(8.5, -8.2, 0, 3.6); L.rack(15.0, -8.2, 0, 3.6);
  L.pallet(19.5, -13.0, 0.1, 2); L.pallet(18.2, -13.1, -0.2, 1); L.pallet(12.0, -13.0, 0.3, 2);
  L.pallet(20.3, -6.0, 0.2, 1); L.pallet(12.5, -5.3, 0, 0);
  L.box(17, 0, -5.8, 0.6, 0.2, 1.6, { yaw: 0.4, color: 0xe0602a });            // zorra
  L.box(17.55, 0, -5.1, 0.06, 1.1, 0.06, { yaw: 0.4, color: 0x2a2c33, solid: false });
  L.box(22.45, 2.1, -10, 0.12, 0.9, 2.6, { color: 0x4a4e55, solid: false });    // cortina del portón, enrollada
  L.glow(22.44, 0.02, -10, 0.05, 0.03, 2.4, { color: 0xffd24a, k: 1.2 });
  L.sign(22.4, 2.55, -7.0, -Math.PI / 2, 1.2, 0.3, 0xffd24a, { k: 1.2 });      // CARGA
  L.whiteboard(6.15, 1.2, -5.8, Math.PI / 2, 1.2, 0.8);
  for (let i = 0; i < 8; i++) L.cardboard(7 + R() * 14, -11.5 + R() * 6, R() * TAU, 0.45 + R() * 0.3);
  L.cardboard(14.2, -13.2, 0.5, 0.7); L.cardboard(15.1, -13.4, 1.1, 0.5);
  L.trash(20.9, -4.8, 0x3a3f3a);
  L.tube(13, 2.5, -14.45, 0, 1.4, { color: 0xeaf4ff, light: true, flicker: 0.2 });
  L.tube(21.45, 2.5, -13, Math.PI / 2, 1.2, { color: 0xeaf4ff });
  L.tube(6.15, 2.5, -12, Math.PI / 2, 1.2, { color: 0xeaf4ff });

  L.playerStart = { x: -8, z: 7.0 };
  L.point('exit', -7, 13.2);
  L.point('obj1', -14.3, -10.6);    // frutas y verduras
  L.point('obj2', 12, -6.5);        // depósito
  L.point('obj3', 17, 9);           // el cafecito
  L.point('obj4', 2.5, -8.0);       // promos
  L.point('obj5', -19.2, 7.6);      // atención al cliente
  return L.finish();
}

// ═════════════════════════════════════════════════════════════════════════════
//  LA ESTACIÓN — andén largo, vías, un vagón detenido, molinetes y boletería
// ═════════════════════════════════════════════════════════════════════════════
export function buildSubte(L) {
  const R = L.rng;
  const X0 = -23.6, X1 = 23.6, Z0 = -11.6, Z1 = 11.6;
  L.slab(26, 14);
  L.bounds = { x0: X0, z0: Z0, x1: X1, z1: Z1 };

  // ── paredes: túneles a los dos lados de la vía, escalera (este) y boletería (sur)
  const OUT = { h: 3.0, thick: 0.3, color: 0x5d6266, capColor: 0x7d8286 };
  const IN = { h: 3.0, thick: 0.24, color: 0x7f9690, capColor: 0x9fb6b0 };
  L.wall(X0, Z0, X1, Z0, OUT);
  L.wall(X0, Z1, X1, Z1, { ...OUT, gaps: [frac(X0, X1, -13, -11)] });
  L.wall(X0, Z0, X0, Z1, { ...OUT, gaps: [frac(Z0, Z1, -10.5, -8.5)] });
  L.wall(X1, Z0, X1, Z1, { ...OUT, gaps: [frac(Z0, Z1, -10.5, -8.5), frac(Z0, Z1, 6, 8)] });
  L.spawn(-24.7, -9.5, Math.PI / 2, 'túnel norte');
  L.spawn(24.7, -9.5, -Math.PI / 2, 'túnel sur');
  L.spawn(24.7, 7.0, -Math.PI / 2, 'escalera');
  L.spawn(-12.0, 12.7, 0, 'boletería');
  for (const x of [X0, X1]) {                                                    // bocas de túnel
    L.box(x, 2.3, -9.5, 0.36, 0.75, 2.6, { color: 0x08080a, solid: false });
    L.glow(x + (x < 0 ? 0.2 : -0.2), 2.55, -9.5, 0.05, 0.12, 0.3, { color: 0xff3030, k: 2.0 });
  }
  L.doorFrame(X1, 7.0, 0); L.doorFrame(-12.0, Z1, Math.PI / 2);
  L.wall(X0, 3, X1, 3, { ...IN, gaps: [frac(X0, X1, -4, 2), frac(X0, X1, -16, -14)] });
  L.box(-15, 0, 3.0, 0.06, 1.05, 1.6, { yaw: 0.9, color: 0x8f959c, solid: false });    // portón de emergencia, abierto

  // ── pisos, vías y borde del andén ─────────────────────────────────────────
  L.floor(X0, -7.6, X1, 3, 'tileBeige');
  L.floor(X0, 3, X1, Z1, 'tileTeal');
  L.railTrack(-23.45, 23.45, -9.5);
  L.glow(0, 0.005, -7.45, 47.2, 0.012, 0.12, { color: 0xffd24a, k: 1.4 });
  L.rug(0, -7.05, 47.2, 0.5, 0x9a9a80);
  L.box(-22.3, 0, -7.7, 2.6, 1.1, 0.08, { color: 0xd9b32a });                   // barandas en las puntas
  L.box(22.3, 0, -7.7, 2.6, 1.1, 0.08, { color: 0xd9b32a });
  L.train(0, -9.5, 15, { doors: [-3.8, 3.8] });

  // ── andén: columnas de azulejo, bancos, kioscos, carteles ─────────────────
  for (const x of [-18, -11, -4, 3, 10, 17]) {
    L.texBox(x, 0, -3.4, 0.7, 3.0, 0.7, { mat: 'tileTeal', solid: true });
    L.box(x, 2.98, -3.4, 0.82, 0.08, 0.82, { color: 0x4a4e55, solid: false });
    L.box(x, 0, -3.4, 0.78, 0.12, 0.78, { color: 0x4a4e55, solid: false });
  }
  for (const x of [-11, 3, 17]) L.tube(x, 2.55, -3.8, 0, 1.2, { color: 0xffc766, light: true, intensity: 9, distance: 9, flicker: 0.08, hz: 11 });
  for (const x of [-18, -4, 10]) L.tube(x, 2.55, -3.8, 0, 1.2, { color: 0xffc766 });
  for (const x of [-20, -12, -8, 6, 14, 20]) L.bench(x, 2.55, Math.PI, [0x5a3a2a, 0x3d4652][R.int(0, 1)]);
  for (const [x, c, sign] of [[-20.5, 0x2f5a3a, 0xffd24a], [19, 0x2f3d55, 0x5fd6ff]]) {
    L.box(x, 0, 1.6, 2.4, 2.4, 2.2, { color: c });                             // kiosco
    L.box(x, 0.9, 0.42, 2.4, 0.06, 0.4, { color: 0x8a6a40, solid: false });     // mostradorcito
    L.box(x, 2.4, 0.9, 2.6, 0.06, 1.0, { color: 0xd8d8d0, solid: false });      // toldito
    L.sign(x, 2.05, 0.48, Math.PI, 1.6, 0.36, sign, { k: 1.6 });
    for (let k = 0; k < 6; k++) L.box(x - 1.0 + k * 0.4, 0.96, 0.4, 0.3, 0.02, 0.24, { color: [0xd94b3a, 0x3a8fd9, 0xe8e2d2][k % 3], solid: false });
  }
  L.vending(-18.5, 2.48, Math.PI); L.vending(9.5, 2.48, Math.PI);
  for (const x of [-14, -7, 8, 15]) {
    L.sign(x, 2.15, 2.85, Math.PI, 2.2, 0.45, 0xffffff, { k: 1.1 });          // el nombre de la estación
    L.box(x, 1.95, 2.85, 2.3, 0.1, 0.04, { color: 0xc8302a, solid: false });
  }
  for (const [x, c] of [[-16.5, 0x3a5a8a], [-9.5, 0xc8a04a], [4.5, 0x8a3a5a], [11.5, 0x3a8a6a], [21.5, 0xd94b3a]]) {
    L.box(x, 0.7, 2.86, 1.2, 1.6, 0.03, { color: c, solid: false });          // afiches
    L.box(x + 0.3, 0.9, 2.85, 0.5, 0.7, 0.03, { color: 0xe8e2d2, solid: false });
  }
  L.whiteboard(-17.62, 1.0, -3.4, Math.PI / 2, 1.0, 0.8);                      // mapa de la línea en una columna
  L.trash(-22.4, -6.0); L.trash(-2.2, -0.4); L.trash(13.8, -6.2); L.trash(22.3, 1.9);
  L.cardboard(-22.6, 0.8, 0.5, 0.5); L.cardboard(21.9, -4.6, 1.2, 0.45); L.cardboard(-8.8, -6.2, 0.2, 0.4);
  L.papers(-6, 0.004, -1.5, 4, 3); L.papers(12, 0.004, -5.5, 3, 2);
  L.tube(-20, 2.55, 2.85, 0, 1.4, { color: 0xffc766, light: true, intensity: 9, distance: 9, flicker: 0.1, hz: 9 });
  L.tube(12, 2.55, 2.85, 0, 1.4, { color: 0xffc766, light: true, intensity: 9, distance: 9, flicker: 0.06, hz: 9 });
  L.tube(-5, 2.55, 2.85, 0, 1.2, { color: 0xffc766 }); L.tube(21, 2.55, 2.85, 0, 1.2, { color: 0xffc766 });
  L.tube(-23.45, 2.4, -3.5, Math.PI / 2, 1.2, { color: 0xffc766 }); L.tube(23.45, 2.4, -3.5, Math.PI / 2, 1.2, { color: 0xffc766 });
  L.sign(-21.5, 2.5, -7.9, 0, 1.0, 0.3, 0xffd24a, { k: 1.4 });                // señales de vía
  L.sign(21.5, 2.5, -7.9, 0, 1.0, 0.3, 0xffd24a, { k: 1.4 });

  // ── molinetes entre el andén y el vestíbulo ───────────────────────────────
  for (const x of [-3.2, -2.1, -1.0, 0.1]) L.turnstile(x, 3.0, Math.PI / 2);
  L.box(1.0, 0, 3.0, 0.05, 1.0, 1.2, { yaw: 1.1, color: 0x8f959c, solid: false });   // el portón ancho, abierto
  L.sign(-1.5, 2.5, 3.6, 0, 3.0, 0.4, 0x5fd6ff, { k: 1.3 });                  // ANDÉN
  L.sign(-1.5, 2.5, 2.4, Math.PI, 3.0, 0.4, 0x3ddc84, { k: 1.3 });            // SALIDA

  // ── vestíbulo: boletería, mapa, cajeros, escaleras, kiosco de diarios ─────
  L.booth(-8.5, 10.5, Math.PI, 2.6, 1.6, { color: 0xb9c4bc, glass: 0x2b3a44, roof: 0x8a3a2a, light: 0xffe0b0 });
  L.sign(-8.5, 2.5, 11.42, Math.PI, 2.0, 0.4, 0xffd24a, { k: 1.4 });          // BOLETERÍA
  for (let k = 0; k < 3; k++) {
    L.cyl(-9.8 + k * 1.3, 0, 8.4, 0.04, 0.95, { color: 0x8a8f96, solid: false });
    L.cyl(-9.8 + k * 1.3, 0, 8.4, 0.16, 0.03, { color: 0x2a2c33, solid: false });
  }
  L.pipe(-8.5, 0.9, 8.4, 0, 0.02, 2.6, 0xc8302a);                              // el cordón de la cola
  L.whiteboard(-3, 1.0, 11.42, 0, 2.0, 1.2);                                    // mapa de la red
  L.sign(-3, 2.4, 11.42, Math.PI, 1.4, 0.3, 0xffffff, { k: 1.0 });
  L.atm(1.5, 11.15, Math.PI); L.atm(2.3, 11.15, Math.PI, 0x8a3a2a);
  L.vending(5.0, 11.05, Math.PI);
  L.stairs(10, 8.4, -Math.PI / 2, 3.6, 5.4, 6, { h: 2.6 });
  L.sign(10, 2.75, 11.42, Math.PI, 1.6, 0.35, 0x3ddc84);
  L.box(15.5, 0, 10.25, 2.4, 2.2, 2.4, { color: 0x8a3a2a });                    // kiosco de diarios
  L.box(15.5, 0.9, 8.95, 2.4, 0.06, 0.4, { color: 0x8a6a40, solid: false });
  L.sign(15.5, 1.9, 9.0, Math.PI, 1.8, 0.36, 0xffd24a, { k: 1.5 });
  for (let k = 0; k < 6; k++) L.box(14.5 + k * 0.4, 0.96, 8.9, 0.3, 0.02, 0.24, { color: [0xd94b3a, 0x3a8fd9, 0xe8e2d2][k % 3], solid: false });
  L.booth(18.5, 4.2, 0, 1.8, 2.0, { color: 0x2f3d55, glass: 0x2b3a44 });      // seguridad
  L.stairs(22.3, 9.9, -Math.PI / 2, 2.2, 3.0, 4, { h: 2.0, rails: [1] });
  L.sign(23.4, 2.4, 7.0, -Math.PI / 2, 1.0, 0.3, 0x3ddc84);
  L.bench(-19, 3.42, 0, 0x5a3a2a); L.bench(5.5, 3.42, 0, 0x3d4652);
  L.plant(-23.0, 4.0); L.plant(7.0, 11.0, true);
  L.trash(-14.6, 11.0); L.trash(13.0, 4.0); L.trash(-22.6, 11.0);
  for (let i = 0; i < 5; i++) L.cardboard(-6 + R() * 12, 5 + R() * 3, R() * TAU, 0.45);
  L.papers(-13, 0.004, 6, 5, 3); L.papers(20, 0.004, 5.5, 3, 2);
  L.tube(-5, 2.55, 11.42, 0, 1.4, { color: 0xffc766, light: true, intensity: 9, distance: 9, flicker: 0.1, hz: 9 });
  L.tube(14, 2.55, 11.42, 0, 1.4, { color: 0xffc766, light: true, intensity: 9, distance: 9, flicker: 0.07, hz: 9 });
  L.tube(-14.5, 2.55, 11.42, 0, 1.2, { color: 0xffc766, light: true, intensity: 8, distance: 8, flicker: 0.2, hz: 7 });
  L.tube(3.5, 2.55, 11.42, 0, 1.2, { color: 0xffc766, light: true, intensity: 8, distance: 8, flicker: 0.05, hz: 9 });
  L.tube(-19, 2.55, 11.42, 0, 1.2, { color: 0xffc766 }); L.tube(19, 2.55, 11.42, 0, 1.2, { color: 0xffc766 });
  L.tube(-23.45, 2.4, 6.5, Math.PI / 2, 1.2, { color: 0xffc766 });
  // depósito cerrado en el rincón sudoeste (nadie entra: no cuenta para el nav)
  L.wall(-19.6, 7.6, -19.6, Z1, IN); L.wall(X0, 7.6, -19.6, 7.6, IN);
  L.box(-19.48, 0, 9.6, 0.04, 2.1, 1.0, { color: 0x3a3c40, solid: false });
  L.world.addBox(-21.6, 1.5, 9.6, 1.9, 1.5, 1.9);

  L.playerStart = { x: -6.5, z: -2.0 };
  L.point('exit', 3.8, -7.4);       // la puerta del vagón
  L.point('obj1', -20.5, -5.0);     // punta oeste del andén
  L.point('obj2', 14, -9.5);        // sobre las vías
  L.point('obj3', -9, 7.5);         // la cola de la boletería
  L.point('obj4', 16.5, 7.0);       // vestíbulo este
  L.point('obj5', 5.5, -2.0);       // andén, frente al vagón
  return L.finish();
}

// ═════════════════════════════════════════════════════════════════════════════
//  EL HOSPITAL — pasillo central, sala de internación, quirófano, terapia
// ═════════════════════════════════════════════════════════════════════════════
export function buildHospital(L) {
  const R = L.rng;
  const X0 = -21.6, X1 = 21.6, Z0 = -14.6, Z1 = 14.6;
  L.slab(24, 17);
  L.bounds = { x0: X0, z0: Z0, x1: X1, z1: Z1 };

  // ── paredes: guardia (oeste), ambulancias y terapia (sur), ascensor (este) ─
  const OUT = { h: 3.0, thick: 0.3, color: 0xcfd3cd, capColor: 0xe6ebe6 };
  const IN = { h: 3.0, thick: 0.24, color: 0xb3d3c8, capColor: 0xdde9e4 };
  L.wall(X0, Z0, X1, Z0, OUT);
  L.wall(X0, Z1, X1, Z1, { ...OUT, gaps: [frac(X0, X1, -17, -15), frac(X0, X1, 15, 17)] });
  L.wall(X0, Z0, X0, Z1, { ...OUT, gaps: [frac(Z0, Z1, -9, -7)] });
  L.wall(X1, Z0, X1, Z1, { ...OUT, gaps: [frac(Z0, Z1, -9, -7)] });
  L.spawn(-22.7, -8.0, Math.PI / 2, 'guardia');
  L.spawn(-16.0, 15.7, 0, 'ambulancias');
  L.spawn(22.7, -8.0, -Math.PI / 2, 'ascensor');
  L.spawn(16.0, 15.7, 0, 'terapia');
  L.doorFrame(X0, -8.0, 0, 2.2, { color: 0x3a4a44 });
  L.doorFrame(-16.0, Z1, Math.PI / 2, 2.2, { color: 0x3a4a44 });
  L.doorFrame(16.0, Z1, Math.PI / 2, 2.2, { color: 0x3a4a44 });
  L.doorFrame(X1, -8.0, 0, 2.4, { color: 0x5a6068 });
  // pasillo central con puertas a cada ambiente
  L.wall(X0, -1.6, X1, -1.6, { ...IN, gaps: [frac(X0, X1, -17, -15), frac(X0, X1, -8, -6), frac(X0, X1, 0, 2), frac(X0, X1, 7.5, 9.5), frac(X0, X1, 16, 18)] });
  L.wall(X0, 1.6, X1, 1.6, { ...IN, gaps: [frac(X0, X1, -17, -15), frac(X0, X1, -6, -4), frac(X0, X1, 4, 6), frac(X0, X1, 14, 16)] });
  for (const [x, z] of [[-16, -1.6], [-7, -1.6], [1, -1.6], [8.5, -1.6], [17, -1.6], [-16, 1.6], [-5, 1.6], [5, 1.6], [15, 1.6]]) {
    L.doorFrame(x, z, Math.PI / 2, 2.2, { thick: 0.28, color: 0x3a4a44 });
  }
  for (const [x, z] of [[-7, -1.6], [1, -1.6], [8.5, -1.6], [-16, 1.6], [15, 1.6]]) L.swingDoors(x, z, Math.PI / 2);
  L.wall(-10, Z0, -10, -1.6, IN);
  L.wall(-10, 1.6, -10, Z1, { ...IN, gaps: [frac(1.6, Z1, 10, 12)] });
  L.wall(4, Z0, 4, -1.6, IN);
  L.wall(13, Z0, 13, -1.6, { ...IN, gaps: [frac(Z0, -1.6, -12, -10)] });
  L.wall(4, -6.6, 13, -6.6, { ...IN, gaps: [frac(4, 13, 7.5, 9.5)] });
  L.swingDoors(8.5, -6.6, Math.PI / 2);
  L.wall(0, 1.6, 0, Z1, IN);
  L.wall(10, 1.6, 10, Z1, IN);

  // ── pisos ─────────────────────────────────────────────────────────────────
  L.floor(X0, Z0, -10, -1.6, 'carpetGrey');      // sala de espera
  L.floor(X0, 1.6, -10, Z1, 'tileBeige');        // ingreso de ambulancias
  L.floor(X0, -1.6, X1, 1.6, 'tileBeige');       // pasillo
  L.floor(-10, Z0, X1, -1.6, 'tileBeige');       // internación, quirófano, ascensores
  L.floor(4, Z0, 13, -6.6, 'tileTeal', 0.008);   // quirófano
  L.floor(-10, 1.6, X1, Z1, 'tileBeige');        // farmacia, lavadero, terapia
  L.rug(0, -1.0, 43, 0.12, 0x3a6fc8); L.rug(0, 1.0, 43, 0.12, 0xc83a3a);     // las líneas del piso

  // ── pasillo ───────────────────────────────────────────────────────────────
  L.light(0, 2.6, 0, 0xff2a2a, 4, 9, { flicker: 0.6, hz: 4 });                 // baliza de emergencia
  L.glow(0, 2.55, -1.42, 0.2, 0.12, 0.1, { color: 0xff3030, k: 2.0 });
  L.tube(-12, 2.6, -1.45, 0, 1.4, { color: 0xe8f2ff, light: true, flicker: 0.12, hz: 13 });
  L.tube(12, 2.6, 1.45, 0, 1.4, { color: 0xe8f2ff, light: true, flicker: 0.08, hz: 13 });
  L.tube(-4, 2.6, 1.45, 0, 1.4, { color: 0xe8f2ff }); L.tube(4, 2.6, -1.45, 0, 1.4, { color: 0xe8f2ff }); L.tube(19.5, 2.6, -1.45, 0, 1.2, { color: 0xe8f2ff });
  for (const [x, z, yaw] of [[-11, -1.44, 0], [3, 1.44, Math.PI], [11, -1.44, 0], [19, 1.44, Math.PI]]) L.dispenser(x, 1.2, z, yaw);
  L.sign(-12.5, 2.3, 1.44, Math.PI, 1.4, 0.3, 0x3ddc84); L.sign(12.5, 2.3, -1.44, 0, 1.4, 0.3, 0x3ddc84);
  L.gurney(-19.5, 1.05, Math.PI / 2, { sheet: true });
  for (const [x0, x1, z] of [[-14.5, -9, -1.44], [3, 6.9, -1.44], [10.2, 15.4, -1.44], [-14.5, -7, 1.44], [-3.4, 3.4, 1.44], [6.6, 13.4, 1.44]]) {
    L.box((x0 + x1) / 2, 0.85, z, x1 - x0, 0.05, 0.06, { color: 0x8a9aa0, solid: false });   // pasamanos
  }
  L.plant(20.8, 0.0); L.plant(-20.8, -1.0);
  L.cyl(21.3, 0, 1.0, 0.08, 0.55, { color: 0xc8302a, solid: false });          // matafuego
  L.papers(9, 0.004, -0.3, 3, 2);

  // ── sala de espera y guardia (noroeste, alfombra gris) ────────────────────
  L.counter(-15.0, -12.8, 0, 4.0, { color: 0xd9d3c4, top: 0x6f6a62, stuff: 3 });
  L.monitor(-14.2, 0.91, -12.7, Math.PI + 0.2);
  L.chair(-15.3, -13.7, 0.2, 0x3d4652);
  L.sign(-15, 2.4, -14.4, 0, 1.8, 0.45, 0xff3a3a, { k: 2.0 });                 // GUARDIA
  L.screen(-19.5, 1.9, -14.4, 1.3, 0.75, 0);                                    // la tele
  L.box(-19.5, 1.86, -14.43, 1.4, 0.83, 0.05, { color: 0x1e1f24, solid: false });
  for (const z of [-9.4, -7.0, -4.6]) for (let k = 0; k < 5; k++) L.chair(-18.4 + k * 1.0 + (R() - 0.5) * 0.15, z + (R() - 0.5) * 0.15, Math.PI + (R() - 0.5) * 0.3, 0x3f9aa0);
  L.vending(-10.55, -5.0, -Math.PI / 2);
  L.cyl(-10.6, 0, -8.0, 0.16, 1.0, { color: 0xe8e8e4 });                       // dispenser de agua
  L.sphere(-10.6, 1.18, -8.0, 0.16, 0.2, 0.16, { color: 0x8ad0ff });
  L.cyl(-12.5, 0, -7.5, 0.04, 0.45, { color: 0x3a3a40 });                      // mesita de revistas
  L.cyl(-12.5, 0.45, -7.5, 0.45, 0.04, { color: 0xd3c5a5, solid: false });
  L.papers(-12.5, 0.49, -7.5, 3, 0.4);
  L.plant(-21.0, -13.8, true); L.plant(-10.7, -2.3);
  L.rug(-12.6, -3.6, 2.4, 2.0, 0x8a2a2a);
  L.trash(-21.0, -2.6, 0x8a8d92);
  L.glow(-10.16, 2.3, -10.0, 0.02, 0.3, 0.3, { color: 0xffffff, k: 1.0 });     // reloj
  L.dispenser(-21.44, 1.2, -5.5, Math.PI / 2);
  L.cardboard(-20.5, -12.0, 0.3, 0.5); L.cardboard(-11.2, -13.8, 1.1, 0.5);
  L.tube(-21.45, 2.6, -4.0, Math.PI / 2, 1.4, { color: 0xe8f2ff, light: true, flicker: 0.1, hz: 13 });
  L.tube(-13, 2.6, -14.45, 0, 1.4, { color: 0xe8f2ff });

  // ── ingreso de ambulancias (sudoeste) ─────────────────────────────────────
  L.rug(-16, 8.0, 1.0, 12.6, 0x8a2a2a);
  L.glow(-16, 2.15, 14.4, 0.24, 0.8, 0.04, { color: 0xff3a3a, k: 2.2 });      // la cruz roja
  L.glow(-16, 2.43, 14.4, 0.8, 0.24, 0.04, { color: 0xff3a3a, k: 2.2 });
  L.gurney(-20.3, 5.0, 0, { sheet: true }); L.gurney(-20.3, 9.0, 0);
  L.gurney(-13.0, 4.5, 0.4, { color: 0x8a3a3a });
  L.desk(-12.5, 11.5, -Math.PI / 2, { papers: true });
  L.chair(-11.6, 11.3, Math.PI / 2 + 0.3, 0x3d4652);
  for (let k = 0; k < 4; k++) L.gasTank(-12.6 + k * 0.3, 13.9, [0x3a6a8a, 0x3a6a8a, 0x2f7a4a, 0x3a6a8a][k]);
  L.cabinet(-19.5, 14.1, 0, 1.9, 0xe4e4e0); L.cabinet(-18.9, 14.1, 0, 1.9, 0xe4e4e0);
  L.medCart(-10.4, 8.0, -Math.PI / 2); L.medCart(-18.2, 12.0, 0.3);
  L.box(-10.16, 1.2, 5.5, 0.06, 0.4, 0.3, { color: 0xc8302a, solid: false });   // desfibrilador
  L.glow(-10.18, 1.55, 5.5, 0.02, 0.05, 0.1, { color: 0x3aff6a, k: 2 });
  L.dispenser(-21.44, 1.2, 7.5, Math.PI / 2); L.dispenser(-10.16, 1.2, 3.0, -Math.PI / 2);
  L.trash(-11.0, 13.8, 0x8a8d92);
  L.cardboard(-20.8, 12.2, 0.6, 0.5); L.cardboard(-20.2, 11.4, 1.3, 0.45);
  L.papers(-15, 0.004, 11, 3, 1.5);
  L.tube(-13, 2.6, 14.45, 0, 1.4, { color: 0xe8f2ff, light: true, flicker: 0.15, hz: 13 });
  L.tube(-21.45, 2.6, 5.0, Math.PI / 2, 1.4, { color: 0xe8f2ff });

  // ── sala de internación (norte, centro) ───────────────────────────────────
  let bi = 0;
  for (const x of [-8.0, -5.0, -2.0, 1.0]) {
    L.bed(x, -13.35, 0, { patient: bi % 2 === 0, blanket: [0x7aa0c8, 0x9ab8a0, 0x7aa0c8, 0xc8a07a][bi] });
    L.vitals(x + 0.72, -13.85, 0);
    L.box(x - 0.7, 0, -13.95, 0.42, 0.7, 0.42, { color: 0xd6d6d2 });            // mesita
    L.ivStand(x - 0.66, -12.8);
    bi++;
  }
  for (const x of [-6.5, -3.5, -0.5]) L.curtain(x, -13.3, Math.PI / 2, 2.4);
  for (const [x, z, yaw] of [[-8.8, -9.0, Math.PI / 2], [-8.8, -5.5, Math.PI / 2], [2.8, -9.0, -Math.PI / 2], [2.8, -5.5, -Math.PI / 2]]) {
    L.bed(x, z, yaw, { patient: bi % 3 === 0, blanket: [0x9ab8a0, 0x7aa0c8][bi % 2] });
    const s = yaw > 0 ? 1 : -1;
    L.vitals(x - s * 0.65, z - 0.72, yaw);
    L.ivStand(x - s * 0.62, z + 0.75);
    bi++;
  }
  L.curtain(-8.8, -7.25, 0, 2.4); L.curtain(2.8, -7.25, 0, 2.4);
  L.desk(-3.0, -7.0, 0, { w: 1.6, lamp: true, lampColor: 0xdfffe8 });
  L.chair(-3.0, -6.2, Math.PI, 0x3f9aa0);
  L.medCart(-5.5, -8.5, 1.0); L.medCart(-0.2, -9.6, -0.6, 0xbfc3c8);
  L.sink(-4.0, -1.97, Math.PI); L.cabinet(-2.9, -2.1, Math.PI, 1.9, 0xe4e4e0);
  L.trash(3.3, -2.2, 0x8a8d92);
  L.sign(-3, 2.4, -14.4, 0, 2.4, 0.4, 0xbfe6ff, { k: 1.3 });                 // INTERNACIÓN
  L.dispenser(-9.86, 1.2, -3.0, Math.PI / 2); L.dispenser(3.86, 1.2, -3.0, -Math.PI / 2);
  L.papers(-3, 0.004, -10.5, 3, 2);
  L.tube(-4.5, 2.6, -14.4, 0, 1.4, { color: 0xe8f2ff, light: true, flicker: 0.12, hz: 13 });
  L.tube(3.86, 2.6, -8, Math.PI / 2, 1.2, { color: 0xe8f2ff });

  // ── quirófano y prequirúrgico (norte, este) ───────────────────────────────
  L.opTable(8.5, -10.6, 0);
  L.opLamp(10.6, -12.6, 8.5, -10.6);
  L.box(7.0, 0, -12.3, 0.6, 1.4, 0.6, { yaw: 0.4, color: 0xd6d6d2 });           // anestesia
  L.glow(6.75, 1.1, -12.1, 0.3, 0.2, 0.02, { yaw: 0.4, color: 0x4aa0ff, k: 1.5 });
  L.medCart(10.2, -9.2, -Math.PI / 2, 0xbfc3c8); L.medCart(6.8, -9.0, Math.PI / 2, 0xbfc3c8);
  L.gasTank(12.55, -13.9); L.gasTank(12.25, -13.9, 0x2f7a4a);
  L.cabinet(5.0, -14.1, 0, 1.9, 0xe4e4e0); L.cabinet(5.6, -14.1, 0, 1.9, 0xe4e4e0);
  L.sink(11.5, -14.2, 0);
  L.sign(4.15, 1.7, -11.5, Math.PI / 2, 1.0, 0.6, 0xdfe9ff, { k: 1.4 });      // negatoscopio
  L.glow(8.5, 2.6, -6.5, 0.4, 0.14, 0.08, { color: 0xff3030, k: 2.0 });       // luz de "en cirugía"
  L.sign(8.5, 2.4, -14.4, 0, 2.0, 0.4, 0xbfe6ff, { k: 1.3 });                  // QUIRÓFANO
  L.tube(12.86, 2.6, -10.5, Math.PI / 2, 1.2, { color: 0xe8f2ff });
  L.gurney(6.0, -4.0, 0, { sheet: true }); L.gurney(11.5, -4.2, 0);
  L.sink(12.63, -3.5, -Math.PI / 2);
  for (const z of [-5.2, -4.7, -4.2]) L.cabinet(4.43, z, Math.PI / 2, 1.9, 0x8a9096);   // lockers
  L.bench(10.5, -2.0, Math.PI, 0x3d4652);
  L.trash(4.6, -2.2, 0x8a8d92);
  L.dispenser(4.14, 1.2, -3.0, Math.PI / 2);
  L.cardboard(12.4, -5.8, 0.3, 0.5);

  // ── ascensores y escalera (noreste) ───────────────────────────────────────
  for (const z of [-9.1, -6.9]) L.box(21.4, 0, z, 0.36, 2.3, 0.15, { color: 0x5a6068, solid: false });
  L.glow(21.38, 2.45, -8.0, 0.06, 0.16, 0.5, { color: 0x3ddc84, k: 2.0 });
  L.box(21.4, 0, -11.3, 0.06, 2.3, 2.0, { color: 0x8a9096, solid: false });     // el otro ascensor, cerrado
  L.box(21.36, 0, -11.3, 0.03, 2.3, 0.04, { color: 0x3a3c40, solid: false });
  L.doorFrame(X1, -11.3, 0, 2.4, { color: 0x5a6068 });
  L.glow(21.38, 2.45, -11.3, 0.06, 0.16, 0.5, { color: 0xff3030, k: 2.0 });
  L.box(21.38, 1.1, -9.9, 0.04, 0.2, 0.12, { color: 0xbfc3c8, solid: false }); // botonera
  L.stairs(17.5, -13.2, 0, 1.6, 4.4, 4, { h: 1.9, rails: [1] });
  L.bench(14.5, -2.0, Math.PI, 0x3d4652);
  L.plant(20.8, -2.3, true);
  L.cyl(13.6, 0, -8.0, 0.16, 1.0, { color: 0xe8e8e4 });
  L.sphere(13.6, 1.18, -8.0, 0.16, 0.2, 0.16, { color: 0x8ad0ff });
  L.whiteboard(13.15, 1.1, -5.0, Math.PI / 2, 1.2, 0.9);                       // directorio
  L.trash(20.9, -13.0, 0x8a8d92);
  L.cardboard(14.0, -13.6, 0.5, 0.55); L.cardboard(14.8, -12.9, 1.2, 0.45);
  L.sign(17, 2.5, -14.4, 0, 1.4, 0.35, 0x3ddc84);                             // SALIDA sobre la escalera
  L.tube(15, 2.6, -14.4, 0, 1.4, { color: 0xe8f2ff, light: true, flicker: 0.06, hz: 13 });

  // ── farmacia (sur, oeste del centro) ──────────────────────────────────────
  L.counter(-5, 4.6, 0, 3.6, { color: 0xd9d3c4, top: 0x6f6a62, stuff: 3 });
  L.monitor(-4.2, 0.91, 4.5, 0.2);
  L.chair(-5.5, 5.6, Math.PI, 0x3d4652);
  const MED = [0xe8e6e0, 0xdfe9ff, 0xf0d8a8, 0xc8e8d0];
  L.rack(-5, 8.2, 0, 3.6, { colors: MED, color: 0x8a9096 }); L.rack(-5, 11.7, 0, 3.6, { colors: MED, color: 0x8a9096 });
  for (const z of [6.5, 7.0, 7.5]) L.cabinet(-0.43, z, -Math.PI / 2, 1.9, 0xe4e4e0);
  L.fridge(-8.0, 14.05, Math.PI);
  L.sign(-5, 2.4, 1.72, Math.PI, 1.8, 0.4, 0x3ddc84, { k: 1.4 });              // FARMACIA
  L.trash(-9.5, 2.2, 0x8a8d92);
  L.papers(-3.8, 0.004, 6.4, 3, 1.2);
  L.cardboard(-9.4, 13.8, 0.3, 0.5); L.cardboard(-1.0, 13.6, 0.9, 0.5);
  L.tube(-4, 2.6, 14.45, 0, 1.4, { color: 0xe8f2ff, light: true, flicker: 0.1, hz: 13 });

  // ── lavadero y depósito (sur, centro) ─────────────────────────────────────
  for (let k = 0; k < 3; k++) L.washer(2.0 + k * 0.8, 14.11, Math.PI);
  L.cyl(8.8, 0, 13.5, 0.5, 2.0, { color: 0x8a8d92 });                          // caldera
  L.pipe(8.8, 2.3, 11.6, Math.PI / 2, 0.05, 3.6, 0x8a3a2a);
  L.cyl(8.8, 0.9, 10.0, 0.05, 1.4, { color: 0x8a3a2a, solid: false });
  L.rack(7.5, 8.5, Math.PI / 2, 3.0, { colors: [0xe8e6e0, 0xdfe9ff, 0xe8e6e0], color: 0x8a9096 });
  for (const [x, z, yaw] of [[2.5, 8.0, 0.3], [3.4, 9.3, -0.2], [1.8, 11.0, 0.8]]) {
    L.cart(x, z, yaw, 0x8a9096);
    L.box(x, 0.5, z, 0.44, 0.34, 0.8, { yaw, color: 0xe8e6e0, solid: false });   // la ropa
  }
  L.cyl(8.5, 0, 3.5, 0.2, 0.32, { color: 0xd9b32a, solid: false });            // balde con el trapo
  L.cyl(8.5, 0.32, 3.5, 0.015, 1.3, { color: 0x8a6a40, solid: false });
  for (let i = 0; i < 6; i++) L.cardboard(1.0 + R() * 8, 3.0 + R() * 3.5, R() * TAU, 0.45 + R() * 0.25);
  L.box(4.5, 0, 12.6, 1.2, 0.5, 0.9, { yaw: 0.3, color: 0xe8e6e0, solid: false });    // la pila de sábanas
  L.box(4.7, 0.5, 12.4, 0.8, 0.25, 0.7, { yaw: 0.6, color: 0xdfe9ff, solid: false });
  L.sign(5, 2.4, 1.72, Math.PI, 1.6, 0.4, 0xffd24a, { k: 1.2 });               // LAVADERO
  L.tube(0.14, 2.6, 8, Math.PI / 2, 1.2, { color: 0xe8f2ff });

  // ── terapia intensiva (sudeste) ───────────────────────────────────────────
  for (const [x, z, yaw] of [[11.2, 5.0, Math.PI / 2], [11.2, 9.0, Math.PI / 2], [20.4, 5.0, -Math.PI / 2], [20.4, 9.0, -Math.PI / 2]]) {
    L.bed(x, z, yaw, { patient: true, blanket: 0x9ab8a0 });
    const s = yaw > 0 ? 1 : -1;
    L.vitals(x - s * 0.65, z - 0.75, yaw);
    L.ivStand(x - s * 0.62, z + 0.78);
    L.box(x + s * 0.55, 0, z + 1.4, 0.5, 1.2, 0.5, { color: 0xd6d6d2 });        // respirador
    L.glow(x + s * 0.55 - s * 0.26, 0.85, z + 1.4, 0.02, 0.2, 0.3, { color: 0x4aa0ff, k: 1.4 });
  }
  for (const x of [11.4, 20.2]) {
    L.box(x, 0, 7.0, 2.6, 0.9, 0.05, { color: 0xa8c4cc, solid: false });      // mamparas bajas
    L.glow(x, 0.9, 7.0, 2.6, 0.5, 0.03, { color: 0xbfe0f0, k: 0.3 });         // con el vidrio arriba
    L.pipe(x, 1.42, 7.0, 0, 0.02, 2.6);
  }
  L.desk(15.43, 7.6, -Math.PI / 2, { monitor: true, papers: true });
  L.desk(16.18, 7.6, Math.PI / 2, { monitor: true, papers: false });
  L.chair(14.6, 7.7, Math.PI / 2, 0x3d4652); L.chair(17.0, 7.4, -Math.PI / 2, 0x3d4652);
  L.light(15.8, 2.4, 7.6, 0xbfe6ff, 5, 8, { flicker: 0.03 });
  L.medCart(13.0, 12.0, 0.5); L.medCart(18.8, 12.2, -0.4, 0xbfc3c8);
  L.cabinet(10.43, 12.5, Math.PI / 2, 1.9, 0xe4e4e0); L.cabinet(10.43, 13.0, Math.PI / 2, 1.9, 0xe4e4e0);
  L.sink(21.35, 12.0, -Math.PI / 2);
  L.sign(15, 2.4, 1.72, Math.PI, 2.4, 0.4, 0x4aa0ff, { k: 1.4 });              // TERAPIA INTENSIVA
  L.sign(16, 2.35, 14.4, Math.PI, 0.9, 0.28, 0x3ddc84);
  L.trash(19.8, 2.3, 0x8a8d92);
  L.dispenser(10.14, 1.2, 3.0, Math.PI / 2); L.dispenser(21.44, 1.2, 12.9, -Math.PI / 2);
  L.papers(14, 0.004, 11, 2, 1.5);
  L.tube(10.14, 2.6, 5.0, Math.PI / 2, 1.4, { color: 0xe8f2ff, light: true, flicker: 0.1, hz: 13 });
  L.tube(19, 2.6, 14.45, 0, 1.4, { color: 0xe8f2ff });

  L.playerStart = { x: 0, z: 0 };
  L.point('exit', -16, 13.2);       // la puerta de las ambulancias
  L.point('obj1', -3, -8);          // internación
  L.point('obj2', 11.0, -12.5);     // quirófano
  L.point('obj3', 16, 4.5);         // terapia
  L.point('obj4', -5, 6.5);         // farmacia
  L.point('obj5', -16, 8);          // ingreso de ambulancias
  L.point('obj6', 17.5, -5);        // ascensores
  return L.finish();
}
