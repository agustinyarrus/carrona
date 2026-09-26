// ─────────────────────────────────────────────────────────────────────────────
//  play.mjs — Publica CARRONA en Google Play por la API oficial (Google Play Developer
//  API v3), sin dependencias: JWT RS256 con node:crypto, `fetch` y una edición
//  transaccional (todo o nada: si algo falla, la edición no se confirma y Play queda igual).
//    node tools/play.mjs --listing --images            # textos, ícono, gráfico destacado y capturas
//    node tools/play.mjs --upload dist-android/CARRONA-2.1.0.aab --track internal [--status completed|draft]
//    node tools/play.mjs --status                       # qué hay en cada pista
//    node tools/play.mjs --dry-run …                    # el plan, sin tocar nada
//    node tools/play.mjs --selftest                     # firma y verifica un JWT sin red
//  Credenciales: PLAY_SERVICE_ACCOUNT=<clave JSON de la cuenta de servicio> (o
//  mobile/android/play-service-account.json). La app tiene que existir ya en Play Console y sus
//  formularios (clasificación, seguridad de datos, público) contestados: la API no los llena.
//  Lo que sube sale de store/listing.json. Reintentos con espera exponencial ante 429/5xx.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const TRACKS = new Set(['internal', 'alpha', 'beta', 'production']);
const IMAGE_TYPES = Object.freeze({ icon: 'icon', featureGraphic: 'featureGraphic', phoneScreenshots: 'phoneScreenshots' });
const REINTENTOS = 5;

// ── argumentos ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const DRY = flag('--dry-run');
const TTY = !process.env.NO_COLOR;
const tinta = (rgb) => (s) => (TTY ? `\x1b[38;2;${rgb}m${s}\x1b[0m` : String(s));
const K = { azul: tinta('122;162;247'), verde: tinta('158;206;106'), rojo: tinta('247;118;142'), gris: tinta('86;95;137'), lila: tinta('187;154;247'), crema: tinta('192;202;245'), ambar: tinta('224;175;104') };
const paso = (s) => console.log(`\n${K.azul('▸')} ${K.crema(s)}`);
const nota = (s) => console.log(`   ${K.gris('·')} ${s}`);
const morir = (s) => { console.error(`\n${K.rojo('✗')} ${s}\n`); process.exit(1); };

// ── JWT RS256 y el token de acceso ────────────────────────────────────────────
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** Arma y firma el JWT de la cuenta de servicio (RS256). Puro: sirve para el selftest. */
export function firmarJwt({ clientEmail, privateKey, scope = SCOPE, aud = TOKEN_URL, ahora = Math.floor(Date.now() / 1000), vidaS = 3600 }) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: clientEmail, scope, aud, iat: ahora, exp: ahora + vidaS }));
  const firma = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), privateKey);
  return `${header}.${claims}.${b64url(firma)}`;
}
/** Verifica un JWT contra la clave pública (para el selftest y para no confiar en la firma a ciegas). */
export function verificarJwt(jwt, publicKey) {
  const [h, c, s] = jwt.split('.');
  const firma = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, firma);
}
async function tokenDeAcceso(cuenta) {
  const jwt = firmarJwt({ clientEmail: cuenta.client_email, privateKey: cuenta.private_key });
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
  const j = await r.json();
  if (!r.ok || !j.access_token) morir(`OAuth: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j.access_token;
}

// ── HTTP con reintentos (429 y 5xx) ───────────────────────────────────────────
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function llamar(token, url, { method = 'GET', body = null, contentType = 'application/json' } = {}) {
  for (let intento = 0; ; intento++) {
    const r = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': contentType } : {}) }, body });
    if (r.status === 429 || r.status >= 500) {
      if (intento >= REINTENTOS) morir(`${method} ${url} → ${r.status} después de ${REINTENTOS} reintentos`);
      const espera = 800 * 2 ** intento + Math.random() * 300;
      nota(K.ambar(`${r.status}: reintento en ${(espera / 1000).toFixed(1)} s`));
      await dormir(espera);
      continue;
    }
    const texto = await r.text();
    let j = null; try { j = texto ? JSON.parse(texto) : null; } catch { j = { raw: texto }; }
    if (!r.ok) morir(`${method} ${url} → ${r.status}: ${(j && j.error && j.error.message) || texto.slice(0, 400)}`);
    return j;
  }
}

// ── el plan a partir de store/listing.json ────────────────────────────────────
const listing = JSON.parse(fs.readFileSync(path.join(ROOT, 'store', 'listing.json'), 'utf8'));
const PKG = opt('--package', listing.packageName);
const leer = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n').trim();
const LIMITES = { title: 30, shortDescription: 80, fullDescription: 4000 };

function textosDe(lang) {
  const L = listing.listings[lang];
  const out = { language: lang, title: leer(L.title), shortDescription: leer(L.shortDescription), fullDescription: leer(L.fullDescription) };
  for (const k of Object.keys(LIMITES)) if (out[k].length > LIMITES[k]) morir(`${lang}: «${k}» tiene ${out[k].length} caracteres y Play admite ${LIMITES[k]}`);
  return out;
}
function imagenesDe() {
  const I = listing.images;
  const capturas = fs.readdirSync(path.join(ROOT, I.phoneScreenshots)).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort().map((f) => path.join(ROOT, I.phoneScreenshots, f));
  if (capturas.length < 2 || capturas.length > 8) morir(`Play pide entre 2 y 8 capturas de teléfono; hay ${capturas.length}`);
  return { icon: [path.join(ROOT, I.icon)], featureGraphic: [path.join(ROOT, I.featureGraphic)], phoneScreenshots: capturas };
}
const mime = (f) => (/\.png$/i.test(f) ? 'image/png' : 'image/jpeg');

// ── selftest: sin red ─────────────────────────────────────────────────────────
if (flag('--selftest')) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwt = firmarJwt({ clientEmail: 'prueba@proyecto.iam.gserviceaccount.com', privateKey: pem, ahora: 1_700_000_000 });
  const [h, c] = jwt.split('.').slice(0, 2).map((p) => JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()));
  const ok = verificarJwt(jwt, publicKey) && h.alg === 'RS256' && c.scope === SCOPE && c.aud === TOKEN_URL && c.exp - c.iat === 3600;
  const otra = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
  const rechaza = !verificarJwt(jwt, otra);
  const textos = Object.keys(listing.listings).map(textosDe);
  const imgs = fs.existsSync(path.join(ROOT, listing.images.phoneScreenshots)) ? imagenesDe() : null;
  console.log(`\n  ${ok && rechaza ? K.verde('✓') : K.rojo('✗')} JWT RS256: firma verificable, rechazada con otra clave, claims correctos`);
  console.log(`  ${K.verde('✓')} textos dentro de los límites: ${textos.map((t) => `${t.language} (${t.title.length}/${t.shortDescription.length}/${t.fullDescription.length})`).join(' · ')}`);
  if (imgs) console.log(`  ${K.verde('✓')} imágenes: ícono, gráfico destacado y ${imgs.phoneScreenshots.length} capturas`);
  process.exit(ok && rechaza ? 0 : 1);
}

// ── credenciales ──────────────────────────────────────────────────────────────
const credPath = process.env.PLAY_SERVICE_ACCOUNT || path.join(ROOT, 'mobile', 'android', 'play-service-account.json');
let cuenta = null;
if (!DRY) {
  if (!fs.existsSync(credPath)) morir(`falta la clave de la cuenta de servicio: ${credPath} (Play Console → Configuración → Acceso a la API)`);
  cuenta = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  if (!cuenta.client_email || !cuenta.private_key) morir('la clave JSON no tiene client_email / private_key');
}
console.log(`\n${K.lila('CARRONA')} ${K.gris('·')} Google Play ${K.gris(PKG)}${DRY ? K.ambar('  (simulación: no se toca nada)') : ''}`);
const token = DRY ? 'simulado' : await tokenDeAcceso(cuenta);
const base = `${API}/${PKG}`;

// ── estado de las pistas ──────────────────────────────────────────────────────
if (flag('--status')) {
  paso('Pistas');
  if (DRY) { nota('GET edits → tracks'); process.exit(0); }
  const edit = await llamar(token, `${base}/edits`, { method: 'POST', body: '{}' });
  const tracks = await llamar(token, `${base}/edits/${edit.id}/tracks`);
  for (const t of tracks.tracks || []) nota(`${t.track.padEnd(11)} ${(t.releases || []).map((r) => `${r.name || '?'} [${r.status}] códigos ${(r.versionCodes || []).join(',')}`).join(' · ') || K.gris('vacía')}`);
  await llamar(token, `${base}/edits/${edit.id}`, { method: 'DELETE' });
  process.exit(0);
}

const quiereListing = flag('--listing'), quiereImagenes = flag('--images'), aab = opt('--upload');
if (!quiereListing && !quiereImagenes && !aab) morir('decime qué hacer: --listing, --images, --upload <aab> o --status');
const track = opt('--track', 'internal');
if (!TRACKS.has(track)) morir(`pista desconocida «${track}» (internal | alpha | beta | production)`);
const status = opt('--status-release', opt('--status', 'completed'));

// ── la edición: todo o nada ───────────────────────────────────────────────────
paso('Abro una edición');
const edit = DRY ? { id: 'simulada' } : await llamar(token, `${base}/edits`, { method: 'POST', body: '{}' });
nota(`edición ${edit.id}`);
try {
  if (quiereListing) {
    paso('Ficha: textos');
    for (const lang of Object.keys(listing.listings)) {
      const t = textosDe(lang);
      nota(`${lang}: «${t.title}» · corta ${t.shortDescription.length} · completa ${t.fullDescription.length}`);
      if (!DRY) await llamar(token, `${base}/edits/${edit.id}/listings/${lang}`, { method: 'PUT', body: JSON.stringify({ language: lang, title: t.title, shortDescription: t.shortDescription, fullDescription: t.fullDescription }) });
    }
  }
  if (quiereImagenes) {
    paso('Ficha: imágenes (se reemplazan las que haya)');
    const imgs = imagenesDe();
    for (const lang of Object.keys(listing.listings)) {
      for (const [tipo, archivos] of Object.entries(imgs)) {
        nota(`${lang} · ${tipo}: ${archivos.length} archivo(s)`);
        if (DRY) continue;
        await llamar(token, `${base}/edits/${edit.id}/listings/${lang}/${IMAGE_TYPES[tipo]}`, { method: 'DELETE' });
        for (const f of archivos) await llamar(token, `${UPLOAD}/${PKG}/edits/${edit.id}/listings/${lang}/${IMAGE_TYPES[tipo]}?uploadType=media`, { method: 'POST', body: fs.readFileSync(f), contentType: mime(f) });
      }
    }
  }
  if (aab) {
    paso(`Subo ${path.relative(ROOT, path.resolve(aab))} a la pista ${track} (${status})`);
    if (!fs.existsSync(aab)) morir(`no existe ${aab} (node tools/apk.mjs --aab)`);
    let versionCode = 0;
    if (!DRY) {
      const r = await llamar(token, `${UPLOAD}/${PKG}/edits/${edit.id}/bundles?uploadType=media`, { method: 'POST', body: fs.readFileSync(aab), contentType: 'application/octet-stream' });
      versionCode = r.versionCode;
    }
    nota(`versionCode ${versionCode || '(simulado)'}`);
    const releaseNotes = Object.entries(listing.releaseNotes || {}).map(([language, text]) => ({ language, text }));
    if (!DRY) await llamar(token, `${base}/edits/${edit.id}/tracks/${track}`, { method: 'PUT', body: JSON.stringify({ track, releases: [{ versionCodes: [String(versionCode)], status, releaseNotes }] }) });
  }
  paso('Confirmo la edición');
  if (!DRY) { await llamar(token, `${base}/edits/${edit.id}:commit`, { method: 'POST', body: '{}' }); }
  console.log(`\n  ${K.verde('✓')} ${DRY ? 'plan completo; nada se tocó' : 'publicado en Play Console (revisión de Google pendiente si corresponde)'}\n`);
} catch (e) {
  if (!DRY) { try { await llamar(token, `${base}/edits/${edit.id}`, { method: 'DELETE' }); } catch { /* la edición expira sola */ } }
  morir(`se abandonó la edición sin confirmar: ${e && e.message ? e.message : e}`);
}
