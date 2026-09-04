// ─────────────────────────────────────────────────────────────────────────────
//  models.js — Modelos low poly armados con cajas y cilindros: armas, linterna,
//  la base de las sillas. Nada de archivos: la silueta la dan 4 o 5 primitivas
//  bien proporcionadas, que es exactamente el look que busca el juego.
//
//  Convención de las armas: +Z es hacia el caño, +Y arriba, origen en la
//  empuñadura (donde va la mano derecha). Cada modelo devuelve también dónde
//  está la boca del caño y la ventana de expulsión, en coordenadas locales.
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';

const MATS = {};
function mat(name, color, rough = 0.6, metal = 0.0, extra = {}) {
  const k = name;
  if (!MATS[k]) MATS[k] = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
  return MATS[k];
}
const DARK = () => mat('dark', 0x22242a, 0.55, 0.45);
const STEEL = () => mat('steel', 0xb6bcc4, 0.35, 0.7);
const OLIVE = () => mat('olive', 0x6a6a3c, 0.7, 0.1);
const WOOD = () => mat('wood', 0x6d452a, 0.7, 0.0);
const PLASTIC = () => mat('plastic', 0x15161a, 0.7, 0.05);
const RUBBER = () => mat('rubber', 0x2c2f36, 0.9, 0.0);

/** Caja posicionada, con rotación opcional (pitch alrededor de X, en radianes). */
function box(parent, m, w, h, d, x, y, z, pitch = 0, yaw = 0) {
  const g = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  g.position.set(x, y, z);
  g.rotation.set(pitch, yaw, 0);
  g.castShadow = true;
  parent.add(g);
  return g;
}
/** Cilindro a lo largo de Z (un caño). */
function tube(parent, m, r, len, x, y, z, seg = 8) {
  const g = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), m);
  g.rotation.x = Math.PI / 2;
  g.position.set(x, y, z);
  g.castShadow = true;
  parent.add(g);
  return g;
}

export function weaponModel(kind) {
  const grp = new THREE.Group();
  let muzzle = new THREE.Vector3(0, 0.03, 0.2);
  let eject = new THREE.Vector3(0.02, 0.04, 0.06);
  switch (kind) {
    case 'pistol': {
      box(grp, STEEL(), 0.028, 0.030, 0.175, 0, 0.034, 0.075);      // corredera
      box(grp, DARK(), 0.026, 0.020, 0.150, 0, 0.012, 0.070);       // armazón
      box(grp, DARK(), 0.026, 0.075, 0.034, 0, -0.030, 0.005, 0.22); // empuñadura
      box(grp, DARK(), 0.006, 0.016, 0.030, 0, -0.004, 0.045);      // guardamonte
      tube(grp, DARK(), 0.006, 0.02, 0, 0.034, 0.17);               // boca
      muzzle = new THREE.Vector3(0, 0.034, 0.17);
      eject = new THREE.Vector3(0.02, 0.045, 0.06);
      break;
    }
    case 'smg': {
      box(grp, PLASTIC(), 0.045, 0.055, 0.30, 0, 0.032, 0.10);      // receptor
      box(grp, PLASTIC(), 0.050, 0.048, 0.12, 0, 0.030, 0.23);      // guardamanos
      tube(grp, DARK(), 0.010, 0.09, 0, 0.038, 0.335);              // caño
      box(grp, DARK(), 0.026, 0.150, 0.040, 0, -0.055, 0.135, 0.30); // cargador
      box(grp, PLASTIC(), 0.030, 0.080, 0.036, 0, -0.038, 0.005, 0.28); // empuñadura
      box(grp, DARK(), 0.026, 0.030, 0.20, 0, 0.040, -0.14);        // culata
      box(grp, DARK(), 0.034, 0.05, 0.02, 0, 0.030, -0.245);        // cantonera
      muzzle = new THREE.Vector3(0, 0.038, 0.38);
      eject = new THREE.Vector3(0.03, 0.05, 0.12);
      break;
    }
    case 'shotgun': {
      box(grp, DARK(), 0.044, 0.060, 0.22, 0, 0.030, 0.06);         // receptor
      tube(grp, DARK(), 0.011, 0.50, 0, 0.042, 0.42);               // caño
      tube(grp, DARK(), 0.011, 0.44, 0, 0.012, 0.40);               // tubo del cargador
      box(grp, WOOD(), 0.046, 0.050, 0.13, 0, 0.014, 0.36);         // bomba
      box(grp, WOOD(), 0.040, 0.068, 0.27, 0, 0.004, -0.18, -0.10); // culata
      muzzle = new THREE.Vector3(0, 0.042, 0.68);
      eject = new THREE.Vector3(0.03, 0.03, 0.08);
      break;
    }
    case 'rifle': {
      box(grp, OLIVE(), 0.040, 0.064, 0.30, 0, 0.032, 0.08);        // receptor
      box(grp, WOOD(), 0.046, 0.050, 0.17, 0, 0.030, 0.31);         // guardamanos
      tube(grp, DARK(), 0.009, 0.24, 0, 0.040, 0.50);               // caño
      tube(grp, DARK(), 0.007, 0.16, 0, 0.062, 0.34);               // tubo de gases
      box(grp, DARK(), 0.028, 0.090, 0.058, 0, -0.045, 0.135, 0.45); // cargador (curvo: 2 tramos)
      box(grp, DARK(), 0.028, 0.080, 0.056, 0, -0.112, 0.175, 0.85);
      box(grp, WOOD(), 0.030, 0.080, 0.040, 0, -0.038, -0.005, 0.28); // empuñadura
      box(grp, WOOD(), 0.036, 0.052, 0.25, 0, 0.022, -0.20, -0.06);  // culata
      muzzle = new THREE.Vector3(0, 0.040, 0.62);
      eject = new THREE.Vector3(0.03, 0.05, 0.10);
      break;
    }
  }
  return { group: grp, muzzle, eject };
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
