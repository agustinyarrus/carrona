// ─────────────────────────────────────────────────────────────────────────────
//  bodies.js — Dibuja todos los cuerpos (vivos y muertos) en 2 draw calls.
//
//  El muñeco es un maniquí: huesos como cilindros lisos, articulaciones como
//  esferas, cabeza redonda sin cara, pies alargados, torso ancho. Es la
//  silueta buscada y además la física la mueve gratis: el hueso se
//  dibuja entre sus dos partículas, donde sea que estén.
//
//  Los muertos se congelan: después de unos segundos el ragdoll se saca del
//  motor y sus huesos quedan copiados en un buffer de cadáveres. Así el piso se
//  llena de cuerpos sin que la física pague nada.
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { NB, NP, BONES, HEAD, NECK, CHEST, HIP, FTL, FTR, HAL, HAR, HPL, HPR } from '../phys/ragdoll.js';
import { clamp01 } from '../core/util.js';

const UP = new THREE.Vector3(0, 1, 0);
const IDENT_Q = new THREE.Quaternion();

// escala de la esfera de cada articulación (x, y, z) respecto a su radio
const JOINT_SCALE = new Float32Array([
  1.06, 1.16, 1.08,   // cabeza: apenas ovalada
  0.9, 0.9, 0.9,      // cuello
  1.35, 0.95, 1.0,    // pecho: ancho
  1.0, 1.0, 1.0, 1.0, 1.0, 1.0,   // hombros
  0.95, 0.95, 0.95, 0.95, 0.95, 0.95, // codos
  1.0, 0.85, 1.05, 1.0, 0.85, 1.05, // manos
  1.25, 0.9, 1.0,     // cadera
  1.0, 1.0, 1.0, 1.0, 1.0, 1.0,   // caderas laterales
  0.95, 0.95, 0.95, 0.95, 0.95, 0.95, // rodillas
  0.95, 0.62, 1.75, 0.95, 0.62, 1.75, // pies: alargados hacia adelante
]);
// radio del hueso de render por hueso (x, z): el torso es más ancho que profundo
const BONE_RX = new Float32Array([1, 1, 1.18, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
const BONE_RZ = new Float32Array([1, 1, 0.80, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
const ORIENTED_JOINT = new Uint8Array(NP);   // articulaciones que se orientan con el cuerpo
ORIENTED_JOINT[HEAD] = 1; ORIENTED_JOINT[CHEST] = 1; ORIENTED_JOINT[HIP] = 1;
ORIENTED_JOINT[FTL] = 1; ORIENTED_JOINT[FTR] = 1; ORIENTED_JOINT[HAL] = 1; ORIENTED_JOINT[HAR] = 1;

// ═════════════════════════════════════════════════════════════════════════════
//  Cadáveres congelados
// ═════════════════════════════════════════════════════════════════════════════
export class CorpseBuffer {
  constructor(max = 120) {
    this.max = max;
    this.n = 0; this.head = 0;
    // por cadáver: NB huesos (a, b, r, color) + NP articulaciones (pos, r, escala, yaw, color)
    this.bA = new Float32Array(max * NB * 3); this.bB = new Float32Array(max * NB * 3);
    this.bR = new Float32Array(max * NB); this.bC = new Float32Array(max * NB * 3);
    this.bAlive = new Uint8Array(max * NB);
    this.jP = new Float32Array(max * NP * 3); this.jR = new Float32Array(max * NP);
    this.jYaw = new Float32Array(max * NP); this.jC = new Float32Array(max * NP * 3);
    this.jAlive = new Uint8Array(max * NP);
  }
  /** Congela un ragdoll tal como está ahora. Devuelve el slot que ocupó. */
  add(body) {
    const w = body.world;
    const k = this.head;
    this.head = (this.head + 1) % this.max;
    if (this.n < this.max) this.n++;
    this.lastSlot = k;
    const yaw = Math.atan2(body.fx, body.fz);
    for (let b = 0; b < NB; b++) {
      const i = k * NB + b;
      this.bAlive[i] = body.boneAlive[b] ? 1 : 0;
      if (!this.bAlive[i]) continue;
      const [ia, ib, r] = BONES[b];
      const pa = body.p[ia], pb = body.p[ib];
      this.bA[i * 3] = w.px[pa]; this.bA[i * 3 + 1] = w.py[pa]; this.bA[i * 3 + 2] = w.pz[pa];
      this.bB[i * 3] = w.px[pb]; this.bB[i * 3 + 1] = w.py[pb]; this.bB[i * 3 + 2] = w.pz[pb];
      this.bR[i] = r * body.scale;
      const pal = body.palette;
      this.bC[i * 3] = pal[b * 3] * 0.9; this.bC[i * 3 + 1] = pal[b * 3 + 1] * 0.9; this.bC[i * 3 + 2] = pal[b * 3 + 2] * 0.9;
    }
    for (let j = 0; j < NP; j++) {
      const i = k * NP + j;
      const pi = body.p[j];
      this.jAlive[i] = (w.pf[pi] & 1) ? 1 : 0;
      if (!this.jAlive[i]) continue;
      this.jP[i * 3] = w.px[pi]; this.jP[i * 3 + 1] = w.py[pi]; this.jP[i * 3 + 2] = w.pz[pi];
      this.jR[i] = w.pr[pi];
      this.jYaw[i] = yaw;
      const jp = body.jointPalette;
      this.jC[i * 3] = jp[j * 3] * 0.9; this.jC[i * 3 + 1] = jp[j * 3 + 1] * 0.9; this.jC[i * 3 + 2] = jp[j * 3 + 2] * 0.9;
    }
    return k;
  }
  clear() { this.n = 0; this.head = 0; }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Render instanciado
// ═════════════════════════════════════════════════════════════════════════════
export class BodyRenderer {
  constructor(scene, material, maxBones = 3000, maxJoints = 3400) {
    const limbGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1);
    const jointGeo = new THREE.SphereGeometry(1, 12, 9);
    this.limbs = new THREE.InstancedMesh(limbGeo, material, maxBones);
    this.joints = new THREE.InstancedMesh(jointGeo, material, maxJoints);
    for (const m of [this.limbs, this.joints]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
    }
    const c = new THREE.Color();
    this.limbs.setColorAt(0, c); this.joints.setColorAt(0, c);
    this.limbs.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.joints.instanceColor.setUsage(THREE.DynamicDrawUsage);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this._f = new THREE.Vector3();
    this._c = new THREE.Color();
    this.maxBones = maxBones;
    this.maxJoints = maxJoints;
    this.drawnBones = 0; this.drawnJoints = 0;
  }

  _bone(bi, ax, ay, az, bx, by, bz, r, rxF, rzF, rightX, rightY, rightZ) {
    const m = this._m, q = this._q, p = this._p, s = this._s, d = this._d;
    d.set(bx - ax, by - ay, bz - az);
    const len = d.length();
    if (len < 1e-5) return false;
    d.multiplyScalar(1 / len);
    if (rxF !== 1 || rzF !== 1) {
      // orientado: base (derecha, dir, adelante) para que el torso sea más ancho que profundo
      const rgt = this._r.set(rightX, rightY, rightZ);
      const dd = rgt.dot(d); rgt.addScaledVector(d, -dd);
      if (rgt.lengthSq() < 1e-6) rgt.set(1, 0, 0).addScaledVector(d, -d.x);
      rgt.normalize();
      const fwd = this._f.crossVectors(rgt, d);
      m.makeBasis(rgt, d, fwd);
      m.scale(s.set(r * rxF, len, r * rzF));
      m.setPosition(ax + d.x * len * 0.5, ay + d.y * len * 0.5, az + d.z * len * 0.5);
    } else {
      q.setFromUnitVectors(UP, d);
      p.set(ax + d.x * len * 0.5, ay + d.y * len * 0.5, az + d.z * len * 0.5);
      s.set(r, len, r);
      m.compose(p, q, s);
    }
    this.limbs.setMatrixAt(bi, m);
    return true;
  }

  _joint(ji, x, y, z, r, j, yaw) {
    const m = this._m, p = this._p, s = this._s;
    const sx = JOINT_SCALE[j * 3], sy = JOINT_SCALE[j * 3 + 1], sz = JOINT_SCALE[j * 3 + 2];
    s.set(r * sx, r * sy, r * sz);
    if (ORIENTED_JOINT[j]) {
      this._q2.setFromAxisAngle(UP, yaw);
      m.compose(p.set(x, y, z), this._q2, s);
    } else {
      m.compose(p.set(x, y, z), IDENT_Q, s);
    }
    this.joints.setMatrixAt(ji, m);
  }

  /**
   * Reconstruye las instancias: primero los cuerpos vivos del mundo, después
   * los cadáveres congelados.
   */
  update(world, corpses) {
    const px = world.px, py = world.py, pz = world.pz;
    const col = this._c;
    let bi = 0, ji = 0;

    for (let n = 0; n < world.bodies.length; n++) {
      const B = world.bodies[n];
      if (!B.p || !B.boneAlive || !B.palette) continue;      // no es un ragdoll pintado
      const pal = B.palette, jp = B.jointPalette;
      const yaw = Math.atan2(B.fx, B.fz);
      const rx = B.rx, ry = B.ry, rz = B.rz;

      for (let b = 0; b < NB; b++) {
        if (!B.boneAlive[b] || bi >= this.maxBones) continue;
        const spec = BONES[b];
        const ia = B.p[spec[0]], ib = B.p[spec[1]];
        if (!this._bone(bi, px[ia], py[ia], pz[ia], px[ib], py[ib], pz[ib], spec[2] * B.scale,
          BONE_RX[b], BONE_RZ[b], rx, ry, rz)) continue;
        col.setRGB(pal[b * 3], pal[b * 3 + 1], pal[b * 3 + 2]);
        this.limbs.setColorAt(bi, col);
        bi++;
      }
      for (let j = 0; j < NP; j++) {
        if (ji >= this.maxJoints) break;
        const pi = B.p[j];
        if (!(world.pf[pi] & 1)) continue;
        this._joint(ji, px[pi], py[pi], pz[pi], world.pr[pi], j, yaw);
        col.setRGB(jp[j * 3], jp[j * 3 + 1], jp[j * 3 + 2]);
        this.joints.setColorAt(ji, col);
        ji++;
      }
    }

    if (corpses) {
      const C = corpses;
      for (let k = 0; k < C.n; k++) {
        for (let b = 0; b < NB; b++) {
          const i = k * NB + b;
          if (!C.bAlive[i] || bi >= this.maxBones) continue;
          if (!this._bone(bi, C.bA[i * 3], C.bA[i * 3 + 1], C.bA[i * 3 + 2], C.bB[i * 3], C.bB[i * 3 + 1], C.bB[i * 3 + 2],
            C.bR[i], 1, 1, 1, 0, 0)) continue;
          col.setRGB(C.bC[i * 3], C.bC[i * 3 + 1], C.bC[i * 3 + 2]);
          this.limbs.setColorAt(bi, col);
          bi++;
        }
        for (let j = 0; j < NP; j++) {
          const i = k * NP + j;
          if (!C.jAlive[i] || ji >= this.maxJoints) continue;
          this._joint(ji, C.jP[i * 3], C.jP[i * 3 + 1], C.jP[i * 3 + 2], C.jR[i], j, C.jYaw[i]);
          col.setRGB(C.jC[i * 3], C.jC[i * 3 + 1], C.jC[i * 3 + 2]);
          this.joints.setColorAt(ji, col);
          ji++;
        }
      }
    }

    this.limbs.count = bi;
    this.joints.count = ji;
    this.limbs.instanceMatrix.needsUpdate = true;
    this.joints.instanceMatrix.needsUpdate = true;
    this.limbs.instanceColor.needsUpdate = true;
    this.joints.instanceColor.needsUpdate = true;
    this.drawnBones = bi; this.drawnJoints = ji;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Paletas: piel, remera, pantalón, zapatos. Cada cuerpo sale distinto.
// ═════════════════════════════════════════════════════════════════════════════
const _col = new THREE.Color();
function lin(hex) { _col.setHex(hex); return [_col.r, _col.g, _col.b]; }   // sRGB → lineal

const SKINS = [0xe8b48f, 0xdda37c, 0xc98f65, 0xb07a55, 0x8b5a3c, 0x6b4630, 0xf0cbaa, 0xd6a07a].map(lin);
const SHIRTS = [0x4f8fd1, 0xd07a2e, 0x7a8f3c, 0xb83a3a, 0x6f5fc3, 0x2e4a7a, 0x8d8d8d, 0xc9a63a,
  0xd98aa8, 0x3f9f92, 0x2a2a2e, 0xe8e2d2, 0x5c8a5e, 0xa04a6a].map(lin);
const PANTS = [0x2c3a5e, 0x4a4a50, 0x8a7a5a, 0x1e1e22, 0x5a3e2a, 0x3b4e7a, 0x6b6b60].map(lin);
const SHOES = [0x1b1b1f, 0x3a2a20, 0x2b2f3a, 0x14141a].map(lin);
const ZOMBIE_TINT = lin(0x8c9a86);

// material de cada hueso: 0 piel · 1 remera · 2 pantalón · 3 zapato
const BONE_MAT = [0, 0, 1, 1, 1, 1, 1, 0, 0, 2, 2, 2, 2, 2, 2];
const JOINT_MAT = [0, 0, 1, 1, 1, 0, 0, 0, 0, 2, 2, 2, 2, 2, 3, 3];

function mix3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function mul3(a, f) { return [a[0] * f, a[1] * f, a[2] * f]; }

/**
 * Pinta un ragdoll entero. opts: {zombie, skin, shirt, pants, shoes, sleeves}
 * Los zombis salen con la piel tirando a gris verdoso y la ropa más sucia.
 */
export function paintBody(body, rng, opts = {}) {
  let skin = opts.skin || SKINS[rng.int(0, SKINS.length - 1)];
  let shirt = opts.shirt || SHIRTS[rng.int(0, SHIRTS.length - 1)];
  let pants = opts.pants || PANTS[rng.int(0, PANTS.length - 1)];
  let shoes = opts.shoes || SHOES[rng.int(0, SHOES.length - 1)];
  if (opts.zombie) {
    const z = 0.22 + rng() * 0.22;
    skin = mul3(mix3(skin, ZOMBIE_TINT, z), 0.9);
    shirt = mul3(mix3(shirt, [0.25, 0.24, 0.2], 0.25), 0.85);
    pants = mul3(mix3(pants, [0.2, 0.18, 0.15], 0.2), 0.9);
  }
  // mangas largas: el brazo superior lleva remera; cortas: piel
  const sleeves = opts.sleeves ?? (rng() < 0.55);
  const mats = [skin, shirt, pants, shoes];
  const v = () => 0.9 + rng() * 0.2;

  body.palette = new Float32Array(NB * 3);
  for (let b = 0; b < NB; b++) {
    let mi = BONE_MAT[b];
    if ((b === 5 || b === 6) && !sleeves) mi = 0;
    const c = mats[mi], f = v();
    body.palette[b * 3] = c[0] * f; body.palette[b * 3 + 1] = c[1] * f; body.palette[b * 3 + 2] = c[2] * f;
  }
  body.jointPalette = new Float32Array(NP * 3);
  for (let i = 0; i < NP; i++) {
    let mi = JOINT_MAT[i];
    if ((i === 3 || i === 4) && !sleeves) mi = 1;    // hombros siempre remera
    const c = mats[mi], f = v() * 0.97;
    body.jointPalette[i * 3] = c[0] * f; body.jointPalette[i * 3 + 1] = c[1] * f; body.jointPalette[i * 3 + 2] = c[2] * f;
  }
  body.skinColor = skin;
  return body;
}

const BLOOD = [0.30, 0.012, 0.015];

/** Ensangrienta un hueso y sus dos articulaciones: se nota dónde le pegaste. */
export function bloodyBone(body, boneIdx, amount = 0.6) {
  if (!body.palette) return;
  const p = body.palette, i = boneIdx * 3;
  p[i] = p[i] * (1 - amount) + BLOOD[0] * amount;
  p[i + 1] = p[i + 1] * (1 - amount) + BLOOD[1] * amount;
  p[i + 2] = p[i + 2] * (1 - amount) + BLOOD[2] * amount;
  const [ia, ib] = BONES[boneIdx];
  const jp = body.jointPalette, a2 = amount * 0.7;
  for (const j of [ia, ib]) {
    const k = j * 3;
    jp[k] = jp[k] * (1 - a2) + BLOOD[0] * a2;
    jp[k + 1] = jp[k + 1] * (1 - a2) + BLOOD[1] * a2;
    jp[k + 2] = jp[k + 2] * (1 - a2) + BLOOD[2] * a2;
  }
}
