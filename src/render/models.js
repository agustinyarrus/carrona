// ─────────────────────────────────────────────────────────────────────────────
//  models.js — Modelos low poly armados con cajas y cilindros: linterna, cono
//  de luz, la base de las sillas, las plantas. Nada de archivos: la silueta la
//  dan 4 o 5 primitivas bien proporcionadas. (Las armas viven en gunsmith.js.)
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';

const MATS = {};
function mat(name, color, rough = 0.6, metal = 0.0, extra = {}) {
  const k = name;
  if (!MATS[k]) MATS[k] = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
  return MATS[k];
}
const RUBBER = () => mat('rubber', 0x2c2f36, 0.9, 0.0);

/** Cilindro a lo largo de Z (un caño). */
function tube(parent, m, r, len, x, y, z, seg = 8) {
  const g = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), m);
  g.rotation.x = Math.PI / 2;
  g.position.set(x, y, z);
  g.castShadow = true;
  parent.add(g);
  return g;
}

/** Linterna: cuerpo, cabeza y lente que brilla. Apunta a +Z. */
export function flashlightModel() {
  const grp = new THREE.Group();
  tube(grp, RUBBER(), 0.017, 0.15, 0, 0, 0.04, 10);
  tube(grp, mat('flHead', 0x3b3f48, 0.5, 0.5), 0.026, 0.05, 0, 0, 0.135, 12);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.022, 12),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.95, 0.8).multiplyScalar(4) }));
  lens.position.set(0, 0, 0.161);
  grp.add(lens);
  grp.userData.lens = lens;
  return grp;
}

/**
 * Cono de luz visible de la linterna: un cono aditivo que se apaga hacia la
 * base y hacia el borde. No es volumétrico de verdad, pero desde arriba es
 * exactamente el look que busca el juego. Apunta a +Z, ápice en el origen.
 */
export function beamCone(length = 9, radius = 3.2) {
  const geo = new THREE.ConeGeometry(1, 1, 28, 6, true);
  // ConeGeometry apunta a +Y con la base en y=-0.5 y el ápice en y=+0.5: lo giramos a +Z
  geo.rotateX(-Math.PI / 2);      // +Y → +Z … el ápice queda en z = +0.5
  geo.translate(0, 0, -0.5);       // ápice al origen, base en z = -1
  geo.scale(radius, radius, -length);   // base en z = +length
  const m = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(1.0, 0.93, 0.75) }, uIntensity: { value: 0.26 } },
    vertexShader: /* glsl */`
      varying float vT; varying vec3 vN; varying vec3 vV;
      void main() {
        vT = clamp(position.z / ${length.toFixed(2)}, 0.0, 1.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uIntensity;
      varying float vT; varying vec3 vN; varying vec3 vV;
      void main() {
        float rim = abs(dot(normalize(vN), normalize(vV)));
        float a = pow(1.0 - vT, 1.7) * pow(rim, 1.4) * uIntensity;
        a *= smoothstep(0.0, 0.08, vT);
        gl_FragColor = vec4(uColor * a, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, m);
  mesh.renderOrder = 4;
  mesh.frustumCulled = false;
  return mesh;
}

/** Une varias geometrías (con su matriz) en una sola no indexada. */
export function mergeGeoms(list) {
  const pos = [], nor = [], uv = [];
  for (const { geo, matrix } of list) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    pos.push(g.attributes.position.array);
    nor.push(g.attributes.normal.array);
    uv.push(g.attributes.uv ? g.attributes.uv.array : new Float32Array(g.attributes.position.count * 2));
  }
  const cat = (arrs) => {
    let n = 0; for (const a of arrs) n += a.length;
    const out = new Float32Array(n); let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  };
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(cat(pos), 3));
  out.setAttribute('normal', new THREE.BufferAttribute(cat(nor), 3));
  out.setAttribute('uv', new THREE.BufferAttribute(cat(uv), 2));
  return out;
}

/** Base de silla de oficina: columna, cubo y 5 patas con rueditas. Origen en el piso. */
export function chairBaseGeometry() {
  const parts = [];
  const M = new THREE.Matrix4();
  const add = (geo, x, y, z, ry = 0, rx = 0) => {
    parts.push({ geo, matrix: M.clone().makeRotationY(ry).multiply(new THREE.Matrix4().makeRotationX(rx)).setPosition(x, y, z) });
  };
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.38, 8), 0, 0.27, 0);
  add(new THREE.CylinderGeometry(0.05, 0.06, 0.06, 8), 0, 0.075, 0);
  for (let k = 0; k < 5; k++) {
    const a = k * (Math.PI * 2 / 5) + 0.3;
    const g = new THREE.BoxGeometry(0.28, 0.028, 0.04);
    g.translate(0.14, 0, 0);
    // el eje X local de la pata apunta a (cos a, ·, sin a): rotación Y = -a
    add(g, 0, 0.055, 0, -a);
    add(new THREE.SphereGeometry(0.028, 6, 5), Math.cos(a) * 0.29, 0.028, Math.sin(a) * 0.29);
  }
  return mergeGeoms(parts);
}

/** Maceta con hojas: se usa desde el constructor del nivel como grupo de mallas. */
export function plantModel(rng, potColor = 0xe6e1d3, leafColor = 0x4f8a3a) {
  const grp = new THREE.Group();
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.12, 0.34, 10), mat('pot' + potColor, potColor, 0.8));
  pot.position.y = 0.17; pot.castShadow = true; pot.receiveShadow = true;
  grp.add(pot);
  const soil = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.03, 10), mat('soil', 0x2a1e14, 1));
  soil.position.y = 0.335; grp.add(soil);
  const leafM = mat('leaf' + leafColor, leafColor, 0.75, 0, { side: THREE.DoubleSide });
  const n = 6 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 7, 5), leafM);
    const a = rng() * Math.PI * 2, tilt = 0.5 + rng() * 0.7, L = 0.26 + rng() * 0.22;
    leaf.scale.set(0.055, 0.02, L);
    leaf.position.set(Math.cos(a) * L * 0.65, 0.42 + Math.sin(tilt) * L * 0.5, Math.sin(a) * L * 0.65);
    leaf.rotation.set(-tilt * 0.6, -a + Math.PI / 2, 0);
    leaf.castShadow = true;
    grp.add(leaf);
  }
  return grp;
}
