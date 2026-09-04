// ─────────────────────────────────────────────────────────────────────────────
//  props_render.js — Dibuja cajas y sillas desde el marco que da la física.
//  Cajas: una InstancedMesh con textura de cartón. Sillas: asiento, respaldo
//  y base (columna + 5 patas) en tres InstancedMesh.
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { shadedBoxGeometry } from './materials.js';
import { chairBaseGeometry } from './models.js';

export class PropRenderer {
  constructor(scene, materials, propSystem, max = 160) {
    this.sys = propSystem;
    const cardboard = new THREE.MeshStandardMaterial({
      map: materials.tex.cardboard, roughness: 0.95, metalness: 0, vertexColors: true,
    });
    this.boxes = new THREE.InstancedMesh(shadedBoxGeometry(1.15, 1.0, 0.6), cardboard, max);
    this.seats = new THREE.InstancedMesh(shadedBoxGeometry(1.12, 1.0, 0.7), materials.mat.flat, max);
    this.backs = new THREE.InstancedMesh(shadedBoxGeometry(1.08, 1.0, 0.8), materials.mat.flat, max);
    this.bases = new THREE.InstancedMesh(chairBaseGeometry(),
      new THREE.MeshStandardMaterial({ color: 0x2a2c33, roughness: 0.6, metalness: 0.35 }), max);
    const c = new THREE.Color();
    for (const m of [this.boxes, this.seats, this.backs, this.bases]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true; m.receiveShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      m.setColorAt(0, c);
      scene.add(m);
    }
    this._m = new THREE.Matrix4();
    this._l = new THREE.Matrix4();
    this._ex = new THREE.Vector3(); this._ey = new THREE.Vector3(); this._ez = new THREE.Vector3();
    this._p = new THREE.Vector3(); this._s = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._c = new THREE.Color();
    this._f = { x: 0, y: 0, z: 0, ex: null, ey: null, ez: null };
  }

  update() {
    const m = this._m, l = this._l, col = this._c, f = this._f;
    let nb = 0, nc = 0;
    for (const P of this.sys.props) {
      if (!P.alive) continue;
      P.frame(f);
      this._ex.set(f.ex[0], f.ex[1], f.ex[2]);
      this._ey.set(f.ey[0], f.ey[1], f.ey[2]);
      this._ez.set(f.ez[0], f.ez[1], f.ez[2]);
      m.makeBasis(this._ex, this._ey, this._ez);
      m.setPosition(f.x, f.y, f.z);
      if (P.kind === 'box') {
        l.compose(this._p.set(0, 0, 0), this._q.identity(), this._s.set(P.w, P.h, P.d));
        this.boxes.setMatrixAt(nb, l.premultiply(m));
        col.setHex(P.color);
        this.boxes.setColorAt(nb, col);
        nb++;
      } else if (P.kind === 'chair') {
        col.setHex(P.color);
        l.compose(this._p.set(0, 0.47, 0), this._q.identity(), this._s.set(0.48, 0.07, 0.46));
        this.seats.setMatrixAt(nc, l.premultiply(m));
        this.seats.setColorAt(nc, col);
        l.compose(this._p.set(0, 0.76, -0.235), this._q.identity(), this._s.set(0.46, 0.52, 0.06));
        this.backs.setMatrixAt(nc, l.premultiply(m));
        this.backs.setColorAt(nc, col);
        this.bases.setMatrixAt(nc, m);
        nc++;
      }
    }
    this.boxes.count = nb;
    this.seats.count = nc; this.backs.count = nc; this.bases.count = nc;
    for (const im of [this.boxes, this.seats, this.backs, this.bases]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }
}
