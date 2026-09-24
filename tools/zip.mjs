// ─────────────────────────────────────────────────────────────────────────────
//  zip.mjs — Escritor de ZIP mínimo y determinista, sin dependencias:
//  cabeceras locales + directorio central + EOCD, deflate con zlib.deflateRawSync
//  y CRC32 propio. Alcanza para el zip portable (archivos chicos, sin ZIP64).
//    makeZip([{ name: 'CARRONA/index.html', data: Buffer }, ...]) → Buffer
//  Las entradas se ordenan por nombre y llevan una fecha fija, así el mismo
//  contenido produce siempre el mismo zip byte a byte.
// ─────────────────────────────────────────────────────────────────────────────

import zlib from 'node:zlib';

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// fecha y hora DOS fijas: 2024-01-01 00:00:00
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

export function makeZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of sorted) {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const store = deflated.length >= data.length;      // si no comprime, se guarda tal cual
    const body = store ? data : deflated;
    const method = store ? 0 : 8;
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);   // firma de cabecera local
    local.writeUInt16LE(20, 4);           // versión necesaria: 2.0
    local.writeUInt16LE(0x0800, 6);       // bandera: nombres en UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // sin extra
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); // firma de entrada del directorio central
    central.writeUInt16LE(20, 4);         // creado por: 2.0 (FAT)
    central.writeUInt16LE(20, 6);         // versión necesaria
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comentario
    central.writeUInt16LE(0, 34);         // disco
    central.writeUInt16LE(0, 36);         // atributos internos
    central.writeUInt32LE(0x20, 38);      // atributos externos: FILE_ATTRIBUTE_ARCHIVE
    central.writeUInt32LE(offset, 42);    // desplazamiento de la cabecera local
    nameBuf.copy(central, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);               // este disco
  eocd.writeUInt16LE(0, 6);               // disco del directorio central
  eocd.writeUInt16LE(sorted.length, 8);   // entradas en este disco
  eocd.writeUInt16LE(sorted.length, 10);  // entradas totales
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);         // desplazamiento del directorio central
  eocd.writeUInt16LE(0, 20);              // comentario
  return Buffer.concat([...locals, ...centrals, eocd]);
}
