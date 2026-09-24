// ─────────────────────────────────────────────────────────────────────────────
//  icons.mjs — Genera los íconos de CARRONA con Node puro (zlib + CRC32, sin
//  canvas ni dependencias) y los escribe en icons/:
//    icon-192.png, icon-512.png, favicon-32.png     emblema con esquinas redondeadas
//    icon-maskable-512.png                          cuadrado opaco, contenido al 80 % (zona segura)
//    carrona.ico                                    16 / 32 / 48 / 256, entradas PNG (Vista+)
//  El emblema: fondo #06070a, anillo de mira blanco fino, punto central y una "C"
//  gruesa amarilla (#ffd24a) hecha como anillo con el sector derecho abierto.
//  Todo son funciones de distancia por píxel con antialiasing por supersampling 4×.
//  Es determinista: la misma salida siempre.
//    node tools/icons.mjs
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'icons');

// ── colores ──────────────────────────────────────────────────────────────────
const BG = [0x06, 0x07, 0x0a];
const WHITE = [0xf2, 0xef, 0xe8];
const YELLOW = [0xff, 0xd2, 0x4a];

// ── CRC32 y PNG ──────────────────────────────────────────────────────────────
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
export function crc32(buf, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Codifica RGBA (Uint8Array de w*h*4) como PNG de 8 bits con filtro 0 en cada fila. */
export function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8 bits, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── el emblema ───────────────────────────────────────────────────────────────
// Devuelve el color [r,g,b,a] de un punto (x,y) en píxeles del lienzo de lado `size`.
// `scale` achica el emblema (0.8 para el maskable); `rounded` recorta las esquinas.
function shade(x, y, size, { scale, rounded }) {
  const c = size / 2;
  const R = c * scale;                       // radio del emblema
  const dx = x - c, dy = y - c;
  const d = Math.hypot(dx, dy);
  // fondo: cuadrado redondeado (radio 22 %) o cuadrado entero
  let inBg = true;
  if (rounded) {
    const r = size * 0.22, hx = Math.abs(dx) - (c - r), hy = Math.abs(dy) - (c - r);
    const qx = Math.max(hx, 0), qy = Math.max(hy, 0);
    inBg = Math.hypot(qx, qy) + Math.min(Math.max(hx, hy), 0) <= r;
  }
  if (!inBg) return [0, 0, 0, 0];
  // punto central
  if (d <= Math.max(R * 0.075, 1.0)) return [...WHITE, 255];
  // la "C": anillo entre 0.40 R y 0.66 R con el sector derecho abierto (±42°)
  const ang = Math.atan2(dy, dx);                    // 0 = derecha
  if (d >= R * 0.40 && d <= R * 0.66 && Math.abs(ang) > (42 * Math.PI) / 180) return [...YELLOW, 255];
  // anillo de mira: círculo fino de radio 0.87 R, con cuatro marcas cortas
  const ringW = Math.max(R * 0.04, 1.0);
  if (Math.abs(d - R * 0.87) <= ringW / 2) return [...WHITE, 255];
  if (size >= 48) {   // en 16 y 32 px las marcas son ruido
    const tickW = Math.max(R * 0.05, 1.0), tickIn = R * 0.74, tickOut = R * 0.80;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if ((ax <= tickW / 2 && ay >= tickIn && ay <= tickOut) || (ay <= tickW / 2 && ax >= tickIn && ax <= tickOut)) return [...WHITE, 255];
  }
  return [...BG, 255];
}

/** Renderiza el emblema en `size` px con supersampling 4×4 (16 muestras por píxel). */
export function renderIcon(size, opts = {}) {
  const { scale = 1, rounded = true } = opts;
  const SS = 4;
  const rgba = new Uint8Array(size * size * 4);
  const acc = [0, 0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      acc[0] = acc[1] = acc[2] = acc[3] = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const p = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, size, { scale, rounded });
          // acumulación premultiplicada para que los bordes transparentes no se oscurezcan
          acc[0] += p[0] * p[3]; acc[1] += p[1] * p[3]; acc[2] += p[2] * p[3]; acc[3] += p[3];
        }
      }
      const o = (y * size + x) * 4;
      const a = acc[3] / (SS * SS);
      if (acc[3] > 0) {
        rgba[o] = Math.round(acc[0] / acc[3]);
        rgba[o + 1] = Math.round(acc[1] / acc[3]);
        rgba[o + 2] = Math.round(acc[2] / acc[3]);
      }
      rgba[o + 3] = Math.round(a);
    }
  }
  return rgba;
}

/** ICO con entradas PNG (lo aceptan Windows Vista en adelante). `pngs` = [{ size, png }]. */
export function encodeIco(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let off = 6 + dir.length;
  pngs.forEach(({ size, png }, i) => {
    const e = i * 16;
    dir[e] = size >= 256 ? 0 : size;          // 0 = 256
    dir[e + 1] = size >= 256 ? 0 : size;
    dir[e + 2] = 0; dir[e + 3] = 0;           // paleta, reservado
    dir.writeUInt16LE(1, e + 4);              // planos
    dir.writeUInt16LE(32, e + 6);             // bits por píxel
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(off, e + 12);
    off += png.length;
  });
  return Buffer.concat([head, dir, ...pngs.map(p => p.png)]);
}

// ── main ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(OUT, { recursive: true });
  const png = (size, opts) => encodePng(size, size, renderIcon(size, opts));
  const files = {
    'icon-192.png': png(192),
    'icon-512.png': png(512),
    'favicon-32.png': png(32),
    'icon-maskable-512.png': png(512, { scale: 0.8, rounded: false }),
    'carrona.ico': encodeIco([16, 32, 48, 256].map(size => ({ size, png: png(size) }))),
  };
  let total = 0;
  for (const [name, buf] of Object.entries(files)) {
    fs.writeFileSync(path.join(OUT, name), buf);
    total += buf.length;
    console.log(`  ${name.padEnd(24)} ${String(buf.length).padStart(7)} bytes`);
  }
  console.log(`  ${Object.keys(files).length} archivos en icons/ (${total} bytes)`);
}
