// ─────────────────────────────────────────────────────────────────────────────
//  materials.js — Texturas procedurales dibujadas en canvas, cero archivos.
//
//  El estilo del juego es low poly de colores planos con luces reales. Las
//  texturas van sólo donde el ojo las pide: alfombras, baldosas, listones de
//  madera, pizarras, pantallas, cartón. Todo lo demás es color liso.
//
//  Cada textura se dibuja UNA vez al arrancar con un PRNG sembrado, así el
//  lugarcito se ve igual cada vez que lo abrís.
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { makeRng, TAU } from '../core/util.js';

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function rgba(r, g, b, a) { return `rgba(${r | 0},${g | 0},${b | 0},${a})`; }
function hexToRgb(h) { return [(h >> 16) & 255, (h >> 8) & 255, h & 255]; }

function makeTex(c, meters, opt = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = opt.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = opt.aniso ?? 8;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.userData.meters = meters;      // cuántos metros cubre una repetición
  t.needsUpdate = true;
  return t;
}

/** Manchas suaves para que un color liso no parezca plástico. */
function mottle(g, w, h, rng, colors, n, rMin, rMax, alpha) {
  for (let i = 0; i < n; i++) {
    const [r, gg, b] = colors[(rng() * colors.length) | 0];
    const x = rng() * w, y = rng() * h, rad = rMin + rng() * (rMax - rMin);
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, rgba(r, gg, b, alpha));
    grd.addColorStop(1, rgba(r, gg, b, 0));
    g.fillStyle = grd;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
}
/** Grano fino. */
function grain(g, w, h, rng, n, alpha, size = 2) {
  for (let i = 0; i < n; i++) {
    const v = rng() < 0.5 ? 0 : 255;
    g.fillStyle = rgba(v, v, v, alpha * rng());
    g.fillRect(rng() * w, rng() * h, size, size);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Pisos
// ═════════════════════════════════════════════════════════════════════════════

/** Alfombra verde con flores de seis pétalos y hojas de palma. 3 m por repetición. */
function carpetFloral(rng) {
  const S = 1024, c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#5a6650'; g.fillRect(0, 0, S, S);
  mottle(g, S, S, rng, [[104, 118, 92], [82, 96, 74], [96, 108, 88]], 260, 30, 110, 0.35);
  // hojas: curvas largas que cruzan (se dibujan con envoltura para que repita)
  const frond = (x0, y0, ang, len, col, wdt) => {
    for (const [ox, oy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) {
      g.strokeStyle = col; g.lineWidth = wdt; g.lineCap = 'round';
      g.beginPath();
      const cx = x0 + ox + Math.cos(ang + 0.7) * len * 0.5, cy = y0 + oy + Math.sin(ang + 0.7) * len * 0.5;
      g.moveTo(x0 + ox, y0 + oy);
      g.quadraticCurveTo(cx, cy, x0 + ox + Math.cos(ang) * len, y0 + oy + Math.sin(ang) * len);
      g.stroke();
    }
  };
  for (let i = 0; i < 26; i++) {
    const x = rng() * S, y = rng() * S, a = rng() * TAU, L = 180 + rng() * 260;
    frond(x, y, a, L, rgba(150, 172, 128, 0.55), 4 + rng() * 3);
    frond(x + 6, y + 4, a + 0.05, L * 0.9, rgba(120, 150, 126, 0.35), 2);
  }
  // flores: 6 pétalos finos alrededor de un centro
  const flower = (x, y, r, col, rot) => {
    for (const [ox, oy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S], [S, S], [-S, -S], [S, -S], [-S, S]]) {
      const fx = x + ox, fy = y + oy;
      if (fx < -r || fy < -r || fx > S + r || fy > S + r) continue;
      g.fillStyle = col;
      for (let k = 0; k < 6; k++) {
        const a = rot + k * (TAU / 6);
        g.save();
        g.translate(fx, fy); g.rotate(a);
        g.beginPath(); g.ellipse(r * 0.55, 0, r * 0.5, r * 0.16, 0, 0, TAU); g.fill();
        g.restore();
      }
      g.beginPath(); g.arc(fx, fy, r * 0.14, 0, TAU); g.fill();
    }
  };
  for (let i = 0; i < 40; i++) {
    const x = rng() * S, y = rng() * S, r = 34 + rng() * 26;
    const pal = rng();
    const col = pal < 0.45 ? rgba(176, 178, 150, 0.85) : pal < 0.75 ? rgba(206, 200, 168, 0.8) : rgba(120, 168, 150, 0.8);
    flower(x, y, r, col, rng() * TAU);
  }
  grain(g, S, S, rng, 9000, 0.06, 2);
  return makeTex(c, 3.0);
}

/** Baldosa de alfombra azul marino con guiones en espiga. 2 m por repetición (4x4 baldosas). */
function carpetNavy(rng) {
  const S = 1024, c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#1b2544'; g.fillRect(0, 0, S, S);
  mottle(g, S, S, rng, [[36, 48, 84], [22, 30, 56], [30, 42, 78]], 200, 30, 90, 0.35);
  const T = S / 4;
  for (let ty = 0; ty < 4; ty++) {
    for (let tx = 0; tx < 4; tx++) {
      const x0 = tx * T, y0 = ty * T;
      const horiz = (tx + ty) % 2 === 0;
      g.save();
      g.beginPath(); g.rect(x0 + 2, y0 + 2, T - 4, T - 4); g.clip();
      const step = 13;
      for (let k = 0; k < T / step + 2; k++) {
        const cnt = 3 + (rng() * 3) | 0;
        for (let j = 0; j < cnt; j++) {
          const len = 16 + rng() * 34, w = 2 + rng() * 2;
          const blue = rng() < 0.6;
          g.fillStyle = blue ? rgba(110, 150, 230, 0.35 + rng() * 0.35) : rgba(215, 200, 160, 0.16 + rng() * 0.22);
          const off = rng() * T;
          if (horiz) g.fillRect(x0 + off, y0 + k * step, len, w);
          else g.fillRect(x0 + k * step, y0 + off, w, len);
        }
      }
      g.restore();
      // borde de baldosa apenas más oscuro
      g.strokeStyle = rgba(10, 14, 30, 0.45); g.lineWidth = 2; g.strokeRect(x0 + 1, y0 + 1, T - 2, T - 2);
    }
  }
  grain(g, S, S, rng, 7000, 0.05, 2);
  return makeTex(c, 2.0);
}

/** Baldosas beige del hall, cuadradas, con rayones. 2.4 m por repetición (4x4). */
function tileBeige(rng) {
  const S = 1024, c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#8f8b74'; g.fillRect(0, 0, S, S);        // color de junta
  const T = S / 4, gap = 4;
  for (let ty = 0; ty < 4; ty++) {
    for (let tx = 0; tx < 4; tx++) {
      const f = 0.94 + rng() * 0.12;
      g.fillStyle = rgba(184 * f, 178 * f, 152 * f, 1);
      g.fillRect(tx * T + gap, ty * T + gap, T - gap * 2, T - gap * 2);
      // el patrón de la baldosa: líneas cruzadas finas
      g.save();
      g.beginPath(); g.rect(tx * T + gap, ty * T + gap, T - gap * 2, T - gap * 2); g.clip();
      g.strokeStyle = rgba(120, 112, 90, 0.18); g.lineWidth = 1.5;
      for (let k = 0; k < 9; k++) {
        const p = tx * T + gap + rng() * (T - gap * 2);
        g.beginPath(); g.moveTo(p, ty * T); g.lineTo(p + (rng() - 0.5) * 30, ty * T + T); g.stroke();
      }
      g.restore();
    }
  }
  mottle(g, S, S, rng, [[160, 150, 120], [200, 195, 170], [140, 136, 112]], 160, 40, 140, 0.16);
  // rayones oscuros cortos
  g.strokeStyle = rgba(60, 55, 40, 0.28); g.lineWidth = 1.2;
  for (let i = 0; i < 160; i++) {
    const x = rng() * S, y = rng() * S, a = rng() * TAU, L = 10 + rng() * 60;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L); g.stroke();
  }
  grain(g, S, S, rng, 8000, 0.05, 2);
  return makeTex(c, 2.4);
}

/** Azulejo verde agua chico (cocina). 1.6 m por repetición (8x8). */
function tileTeal(rng) {
  const S = 1024, c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#6f8a82'; g.fillRect(0, 0, S, S);
  const T = S / 8, gap = 3;
  for (let ty = 0; ty < 8; ty++) for (let tx = 0; tx < 8; tx++) {
    const f = 0.92 + rng() * 0.16;
    g.fillStyle = rgba(146 * f, 172 * f, 162 * f, 1);
    g.fillRect(tx * T + gap, ty * T + gap, T - gap * 2, T - gap * 2);
    g.fillStyle = rgba(255, 255, 255, 0.08);
    g.fillRect(tx * T + gap, ty * T + gap, T - gap * 2, 6);
  }
  grain(g, S, S, rng, 5000, 0.05, 2);
  return makeTex(c, 1.6);
}

/** Hormigón gris para la losa que asoma fuera de las paredes. 3 m. */
function concrete(rng) {
  const S = 512, c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#55575a'; g.fillRect(0, 0, S, S);
  mottle(g, S, S, rng, [[100, 102, 106], [70, 72, 76], [88, 86, 84]], 220, 20, 90, 0.35);
  g.strokeStyle = rgba(30, 30, 34, 0.35); g.lineWidth = 1;
  for (let i = 0; i < 14; i++) {
    const x = rng() * S, y = rng() * S; g.beginPath(); g.moveTo(x, y);
    let px = x, py = y;
    for (let k = 0; k < 6; k++) { px += (rng() - 0.5) * 60; py += (rng() - 0.5) * 60; g.lineTo(px, py); }
    g.stroke();
  }
  grain(g, S, S, rng, 8000, 0.08, 2);
  return makeTex(c, 3.0);
}

/** Alfombra gris verdosa lisa para los cubículos. 2 m. */
function carpetGrey(rng) {
  const S = 512, c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#6a6e5f'; g.fillRect(0, 0, S, S);
  mottle(g, S, S, rng, [[118, 122, 108], [92, 96, 84], [108, 110, 96]], 200, 20, 80, 0.35);
  g.strokeStyle = rgba(150, 154, 140, 0.16); g.lineWidth = 1;
  for (let i = 0; i < 400; i++) {
    const x = rng() * S, y = rng() * S, a = rng() * TAU, L = 6 + rng() * 22;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L); g.stroke();
  }
  grain(g, S, S, rng, 8000, 0.06, 2);
  return makeTex(c, 2.0);
}

// ═════════════════════════════════════════════════════════════════════════════
//  Paredes y muebles
// ═════════════════════════════════════════════════════════════════════════════

/** Listones verticales de madera rojiza. 1 m por repetición horizontal. */
function woodSlats(rng) {
  const S = 512, c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#1c100d'; g.fillRect(0, 0, S, S);
  const n = 11, sw = S / n;
  for (let i = 0; i < n; i++) {
    const f = 0.9 + rng() * 0.2;
    g.fillStyle = rgba(150 * f, 62 * f, 44 * f, 1);
    g.fillRect(i * sw + 3, 0, sw - 7, S);
    g.fillStyle = rgba(255, 220, 200, 0.10);
    g.fillRect(i * sw + 3, 0, 3, S);
    g.fillStyle = rgba(0, 0, 0, 0.18);
    g.fillRect(i * sw + sw - 7, 0, 3, S);
    // veta
    g.strokeStyle = rgba(60, 22, 14, 0.25); g.lineWidth = 1;
    for (let k = 0; k < 5; k++) {
      const x = i * sw + 6 + rng() * (sw - 12);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x + (rng() - 0.5) * 8, S); g.stroke();
    }
  }
  grain(g, S, S, rng, 4000, 0.05, 2);
  return makeTex(c, 1.0);
}

/** Laminado claro de escritorio. 1.2 m. */
function laminate(rng) {
  const S = 512, c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#d3c5a5'; g.fillRect(0, 0, S, S);
  mottle(g, S, S, rng, [[224, 212, 184], [196, 180, 148]], 120, 30, 120, 0.3);
  g.strokeStyle = rgba(120, 96, 64, 0.13); g.lineWidth = 1;
  for (let i = 0; i < 90; i++) {
    const y = rng() * S; g.beginPath(); g.moveTo(0, y);
    for (let x = 0; x <= S; x += 32) g.lineTo(x, y + Math.sin(x * 0.02 + i) * 3);
    g.stroke();
  }
  grain(g, S, S, rng, 3000, 0.04, 2);
  return makeTex(c, 1.2);
}

/** Cartón: cinta en el medio y una etiqueta. Una repetición por cara. */
function cardboard(rng) {
  const S = 256, c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#c4a068'; g.fillRect(0, 0, S, S);
  mottle(g, S, S, rng, [[214, 180, 122], [176, 140, 88]], 60, 20, 80, 0.3);
  // cinta
  g.fillStyle = rgba(150, 110, 64, 0.55); g.fillRect(S * 0.42, 0, S * 0.16, S);
  g.fillStyle = rgba(255, 240, 200, 0.12); g.fillRect(S * 0.42, 0, 4, S);
  // etiqueta
  g.fillStyle = '#e6dfcc'; g.fillRect(S * 0.62, S * 0.62, S * 0.28, S * 0.2);
  g.fillStyle = rgba(60, 60, 70, 0.6);
  for (let k = 0; k < 3; k++) g.fillRect(S * 0.65, S * 0.66 + k * 12, S * (0.12 + rng() * 0.1), 3);
  // bordes más oscuros
  g.strokeStyle = rgba(70, 45, 20, 0.35); g.lineWidth = 6; g.strokeRect(0, 0, S, S);
  grain(g, S, S, rng, 2500, 0.06, 2);
  return makeTex(c, 1.0);
}

/** Pizarra blanca con garabatos y post-its. Una repetición. */
function whiteboard(rng) {
  const W = 512, H = 256, c = canvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#e7eae5'; g.fillRect(0, 0, W, H);
  const cols = ['#2b5fc9', '#c93b3b', '#2f8f4e', '#1f1f28'];
  g.lineCap = 'round';
  for (let i = 0; i < 14; i++) {
    g.strokeStyle = cols[(rng() * cols.length) | 0]; g.lineWidth = 2 + rng() * 2;
    let x = 30 + rng() * (W - 80), y = 30 + rng() * (H - 80);
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 8; k++) { x += (rng() - 0.3) * 40; y += (rng() - 0.5) * 22; g.lineTo(x, y); }
    g.stroke();
  }
  // una tablita / gráfico
  g.strokeStyle = '#1f1f28'; g.lineWidth = 2;
  g.strokeRect(W * 0.62, H * 0.2, W * 0.28, H * 0.4);
  for (let k = 0; k < 4; k++) { g.beginPath(); g.moveTo(W * 0.62, H * (0.2 + 0.1 * k)); g.lineTo(W * 0.9, H * (0.2 + 0.1 * k)); g.stroke(); }
  // post-its
  const notes = ['#f2df70', '#f0a5c0', '#a5d8f0', '#b8e79a'];
  for (let i = 0; i < 7; i++) {
    g.fillStyle = notes[(rng() * notes.length) | 0];
    g.save(); g.translate(20 + rng() * (W - 40), 20 + rng() * (H - 40)); g.rotate((rng() - 0.5) * 0.3);
    g.fillRect(-14, -14, 28, 28); g.restore();
  }
  // bandeja y marco
  g.fillStyle = '#b3b7b2'; g.fillRect(0, H - 10, W, 10);
  g.strokeStyle = '#9aa09c'; g.lineWidth = 8; g.strokeRect(0, 0, W, H);
  return makeTex(c, 1.0, { aniso: 4 });
}

/** Pantalla de escritorio con dos ventanas. Emisiva. */
function screenDesktop(rng) {
  const W = 256, H = 160, c = canvas(W, H), g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, W, H);
  grd.addColorStop(0, '#2a63c8'); grd.addColorStop(1, '#10357a');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 2; i++) {
    const x = 20 + rng() * 60, y = 16 + rng() * 40, w = 100 + rng() * 80, h = 60 + rng() * 50;
    g.fillStyle = '#e9eef5'; g.fillRect(x, y, w, h);
    g.fillStyle = '#c9d2de'; g.fillRect(x, y, w, 10);
    g.fillStyle = '#8f9bb0';
    for (let k = 0; k < 5; k++) g.fillRect(x + 8, y + 18 + k * 9, w * (0.3 + rng() * 0.5), 3);
  }
  g.fillStyle = '#0d1a33'; g.fillRect(0, H - 12, W, 12);
  g.fillStyle = '#5d8fe0'; for (let k = 0; k < 6; k++) g.fillRect(6 + k * 16, H - 10, 10, 8);
  return makeTex(c, 1.0, { aniso: 4 });
}

/** Hoja de papel con renglones. */
function paper(rng) {
  const W = 128, H = 170, c = canvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#ece8dc'; g.fillRect(0, 0, W, H);
  g.fillStyle = rgba(60, 60, 80, 0.55);
  for (let k = 0; k < 12; k++) g.fillRect(14, 20 + k * 11, W * (0.4 + rng() * 0.45), 2);
  g.fillStyle = rgba(30, 30, 40, 0.8); g.fillRect(14, 8, 50, 4);
  return makeTex(c, 1.0, { aniso: 2 });
}

// ═════════════════════════════════════════════════════════════════════════════
//  Registro de materiales
// ═════════════════════════════════════════════════════════════════════════════
export class Materials {
  constructor(seed = 1234) {
    const rng = makeRng(seed);
    this.tex = {
      carpetFloral: carpetFloral(rng),
      carpetNavy: carpetNavy(rng),
      carpetGrey: carpetGrey(rng),
      tileBeige: tileBeige(rng),
      tileTeal: tileTeal(rng),
      concrete: concrete(rng),
      woodSlats: woodSlats(rng),
      laminate: laminate(rng),
      cardboard: cardboard(rng),
      whiteboard: whiteboard(rng),
      screen: screenDesktop(rng),
      paper: paper(rng),
    };
    this.mat = {};
    const std = (name, tex, extra = {}) => {
      this.mat[name] = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.94, metalness: 0.0, ...extra });
      return this.mat[name];
    };
    std('carpetFloral', this.tex.carpetFloral);
    std('carpetNavy', this.tex.carpetNavy);
    std('carpetGrey', this.tex.carpetGrey);
    std('tileBeige', this.tex.tileBeige, { roughness: 0.6 });
    std('tileTeal', this.tex.tileTeal, { roughness: 0.5 });
    std('concrete', this.tex.concrete);
    std('woodSlats', this.tex.woodSlats, { roughness: 0.75 });
    std('laminate', this.tex.laminate, { roughness: 0.55 });
    std('cardboard', this.tex.cardboard, { roughness: 0.95 });
    std('whiteboard', this.tex.whiteboard, { roughness: 0.35 });
    std('paper', this.tex.paper, { roughness: 0.9 });
    // pantallas: emisivas, sin sombra propia, con brillo que el bloom levanta
    this.mat.screen = new THREE.MeshStandardMaterial({
      map: this.tex.screen, emissive: 0xffffff, emissiveMap: this.tex.screen, emissiveIntensity: 1.35,
      roughness: 0.3, metalness: 0,
    });
    // colores lisos (compartidos por las instancias: el color va por instancia)
    this.mat.flat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0.0, vertexColors: true });
    this.mat.flatSmooth = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0.02 });
    this.mat.glow = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 2.4, roughness: 0.5, vertexColors: true });
    this.mat.body = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.78, metalness: 0.0 });
  }

  /** Escala los UV de una PlaneGeometry (w x h metros) para que la textura repita bien. */
  static fitPlaneUV(geo, tex, w, h) {
    const m = tex.userData.meters || 1;
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / m), uv.getY(i) * (h / m));
    uv.needsUpdate = true;
    return geo;
  }

  /** Escala los UV de una BoxGeometry(w,h,d) cara por cara. */
  static fitBoxUV(geo, tex, w, h, d) {
    const m = tex.userData.meters || 1;
    const uv = geo.attributes.uv;
    // orden de caras en BoxGeometry: +x -x +y -y +z -z ; 4 vértices por cara
    const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) {
      const [fw, fh] = dims[f];
      for (let k = 0; k < 4; k++) {
        const i = f * 4 + k;
        uv.setXY(i, uv.getX(i) * (fw / m), uv.getY(i) * (fh / m));
      }
    }
    uv.needsUpdate = true;
    return geo;
  }
}

/**
 * BoxGeometry con color por vértice: la cara de arriba más clara, la de abajo
 * más oscura. Al multiplicarse por el color de instancia, TODAS las cajas del
 * nivel ganan un canto luminoso gratis, que es lo que hace leer el volumen
 * desde arriba.
 */
export function shadedBoxGeometry(top = 1.22, side = 1.0, bottom = 0.55) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  // caras: +x -x +y -y +z -z
  for (let i = 0; i < n; i++) {
    const face = Math.floor(i / 4);
    let f = side;
    if (face === 2) f = top; else if (face === 3) f = bottom;
    else if (face === 0 || face === 1) f = side * 0.93;   // los laterales en x apenas distintos
    col[i * 3] = f; col[i * 3 + 1] = f; col[i * 3 + 2] = f;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Cilindro con la tapa más clara (mismo truco). */
export function shadedCylinderGeometry(seg = 12, top = 1.2) {
  const geo = new THREE.CylinderGeometry(1, 1, 1, seg, 1);
  const pos = geo.attributes.position, n = pos.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const f = pos.getY(i) > 0.49 ? top : (pos.getY(i) < -0.49 ? 0.6 : 1);
    col[i * 3] = f; col[i * 3 + 1] = f; col[i * 3 + 2] = f;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

export function hexColor(h) { return hexToRgb(h); }
