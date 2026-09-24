// Opciones: el registro, la normalización de lo guardado (incluido el formato
// viejo), las teclas configurables y el input que las lee.
import { register } from 'node:module';
register('./_three_hooks.mjs', import.meta.url);

const { OPTIONS, OPTION_GROUPS, ACTION_ORDER, DEFAULT_KEYS, defaultSettings, normalizeSettings, normalizeKeys, loadSettings, saveSettings, rebind, boundCodes, SETTINGS_KEY } = await import('../src/game/options.js');
const { t, setLang, getLang, keyName, fmtTime, tx } = await import('../src/core/i18n.js');
const { Input } = await import('../src/core/input.js');

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${name}   ${extra}`);
  if (!cond) fails++;
};
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

// ── 1. el registro ────────────────────────────────────────────────────────────
{
  const keys = OPTIONS.map(o => o.key);
  ok('claves únicas', new Set(keys).size === keys.length);
  ok('cada opción tiene grupo conocido, tipo y apply', OPTIONS.every(o => OPTION_GROUPS.includes(o.group) && ['select', 'range', 'toggle'].includes(o.type) && typeof o.apply === 'function'));
  ok('los rangos tienen min < max y el defecto adentro', OPTIONS.filter(o => o.type === 'range').every(o => o.min < o.max && o.def >= o.min && o.def <= o.max && typeof o.fmt === 'function'));
  ok('los selects tienen el defecto entre los valores', OPTIONS.filter(o => o.type === 'select').every(o => o.values.includes(o.def)));
  ok('cada opción tiene su texto en los dos idiomas', OPTIONS.every(o => { setLang('es'); const a = t('options.' + o.key); setLang('en'); const b = t('options.' + o.key); return a !== 'options.' + o.key && b !== 'options.' + o.key; }));
  ok('cada valor de select tiene texto', OPTIONS.filter(o => o.type === 'select').every(o => o.values.every(v => t('options.' + o.key + '.' + v) !== 'options.' + o.key + '.' + v)));
  ok('cada acción tiene nombre', ACTION_ORDER.every(a => t('action.' + a) !== 'action.' + a));
  setLang('es');
}

// ── 2. defaults y normalización ───────────────────────────────────────────────
{
  const d = defaultSettings();
  ok('los defaults no traen la pantalla completa (volátil)', !('fullscreen' in d));
  ok('traen las teclas por defecto', JSON.stringify(d.keys) === JSON.stringify(DEFAULT_KEYS));
  const old = normalizeSettings({ shake: 0.5, quality: 'alto', volume: 0.3, camDist: 99, autoQuality: false });
  ok('el formato viejo se entiende', old.shake === 0.5 && old.quality === 'alto' && old.volume === 0.3 && old.autoQuality === false, JSON.stringify(old));
  ok('un valor fuera de rango se acota', old.camDist === 32);
  ok('lo que faltaba toma el defecto', old.sfx === 1 && old.lang === 'es' && old.shadows === true);
  const bad = normalizeSettings({ quality: 'ultra', lang: 'fr', volume: 'alto', shadows: 'no', keys: { fire: ['Mouse9'], pause: 'KeyX', run: 42 } });
  ok('valores inválidos vuelven al defecto', bad.quality === 'medio' && bad.lang === 'es' && bad.volume === 0.8 && bad.shadows === true);
  ok('tecla inválida vuelve al defecto', JSON.stringify(bad.keys.fire) === JSON.stringify(['Mouse0']));
  ok('una tecla como string se acepta y la pausa suma esc', JSON.stringify(bad.keys.pause) === JSON.stringify(['KeyX', 'Escape']));
  ok('una lista rota vuelve al defecto', JSON.stringify(bad.keys.run) === JSON.stringify(DEFAULT_KEYS.run));
  ok('normalizar null da los defaults', JSON.stringify(normalizeSettings(null)) === JSON.stringify(defaultSettings()));
  const st = mem();
  ok('guarda y carga', saveSettings(old, st) && JSON.stringify(loadSettings(st)) === JSON.stringify(old));
  st.setItem(SETTINGS_KEY, '{{{');
  ok('json roto → defaults', JSON.stringify(loadSettings(st)) === JSON.stringify(defaultSettings()));
}

// ── 3. rebindeo ───────────────────────────────────────────────────────────────
{
  const k = normalizeKeys(DEFAULT_KEYS);
  const k2 = rebind(k, 'reload', 'KeyF');
  ok('la tecla nueva queda primera', k2.reload[0] === 'KeyF');
  ok('… reemplaza a la principal vieja y se saca de la acción que la tenía (la linterna queda sin tecla)', JSON.stringify(k2.reload) === JSON.stringify(['KeyF']) && k2.flashlight.length === 0);
  ok('las secundarias se conservan', JSON.stringify(rebind(k, 'moveUp', 'KeyI').moveUp) === JSON.stringify(['KeyI', 'ArrowUp']));
  const k3 = rebind(k2, 'flashlight', 'KeyG');
  ok('ahora la linterna es G y recargar sigue en F', k3.flashlight[0] === 'KeyG' && k3.reload[0] === 'KeyF' && !k3.flashlight.includes('KeyF'));
  const k4 = rebind(k3, 'fire', 'Mouse2');
  ok('disparar con el botón derecho', JSON.stringify(k4.fire) === JSON.stringify(['Mouse2']));
  ok('una lista vacía guardada se respeta, salvo disparar', normalizeKeys({ flashlight: [] }).flashlight.length === 0 && normalizeKeys({ fire: [] }).fire[0] === 'Mouse0');
  ok('acción o código inválido no cambian nada', rebind(k4, 'volar', 'KeyA') === k4 && rebind(k4, 'run', 'tecla rara') === k4);
  ok('el original no se tocó', k.reload[0] === 'KeyR');
  const codes = boundCodes(k4);
  ok('boundCodes junta todo', codes.has('KeyW') && codes.has('Mouse2') && codes.has('Escape'));
  ok('la pausa nunca pierde esc', rebind(k, 'pause', 'KeyP').pause.includes('Escape'));
}

// ── 4. el input con acciones (DOM de mentira) ─────────────────────────────────
{
  const listeners = {};
  const target = { addEventListener: (ev, fn) => { listeners[ev] = fn; } };
  globalThis.window = { innerWidth: 800, innerHeight: 600 };
  globalThis.document = { activeElement: null };
  const I = new Input(target, normalizeKeys(DEFAULT_KEYS));
  const key = (code, type = 'keydown') => { let prevented = false; listeners[type]({ code, repeat: false, preventDefault: () => { prevented = true; } }); return prevented; };
  const mouse = (button, ui = false, type = 'mousedown') => { listeners[type]({ button, target: { closest: (sel) => ui ? {} : null } }); };
  ok('W = adelante', (key('KeyW'), I.axis('moveDown', 'moveUp') === 1) && I.act('moveUp'));
  ok('la flecha también', (key('KeyW', 'keyup'), key('ArrowUp'), I.axis('moveDown', 'moveUp') === 1));
  key('ArrowUp', 'keyup');
  ok('shift = correr, y es flanco una sola vez', (key('ShiftLeft'), I.act('run') && I.actPressed('run')) && (I.endFrame(), I.act('run') && !I.actPressed('run')));
  ok('las teclas ligadas se frenan en el navegador, otras no', key('KeyW') === true && key('KeyZ') === false);
  ok('un clic en el canvas dispara', (mouse(0), I.fire && I.actPressed('fire')));
  I.endFrame(); listeners.mouseup({ button: 0 });
  ok('un clic sobre el menú NO dispara', (mouse(0, true), !I.fire && !I.actPressed('fire')));
  let got = null;
  I.captureNext((c) => { got = c; });
  key('KeyJ');
  ok('captura la próxima tecla y no la cuenta como apretada', got === 'KeyJ' && !I.held('KeyJ'));
  I.captureNext((c) => { got = c; }); key('Escape');
  ok('esc cancela la captura', got === null);
  I.captureNext((c) => { got = c; }); mouse(2, true);
  ok('captura también un botón del mouse (aun sobre el menú)', got === 'Mouse2');
  I.setKeys(rebind(I.keys, 'reload', 'KeyJ'));
  key('KeyJ');
  ok('setKeys en caliente: J ahora recarga', I.actPressed('reload'));
  delete globalThis.window; delete globalThis.document;
}

// ── 5. i18n ───────────────────────────────────────────────────────────────────
{
  setLang('es');
  ok('interpola', t('hud.wave', { n: 3 }) === 'OLEADA 3');
  ok('clave desconocida devuelve la clave', t('no.existe') === 'no.existe');
  setLang('en');
  ok('inglés', t('hud.wave', { n: 3 }) === 'WAVE 3' && getLang() === 'en');
  ok('idioma desconocido cae a castellano', setLang('xx') === 'es' && t('hud.ready') === 'PREPARATE');
  ok('tx elige por idioma', tx({ es: 'hola', en: 'hi' }) === 'hola' && tx('pelado') === 'pelado');
  ok('fmtTime', fmtTime(65) === '1:05' && fmtTime(0) === '0:00');
  ok('keyName', keyName('KeyA') === 'A' && keyName('Digit3') === '3' && keyName('Mouse0') === 'clic' && keyName('Space') === 'espacio' && keyName('ArrowUp') === '↑');
}

// ── 6. la versión que muestra el menú es la del package.json ──────────────────
{
  const { VERSION } = await import('../src/core/version.js');
  const pkg = JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  ok('VERSION coincide con package.json', VERSION === pkg.version, `${VERSION} vs ${pkg.version}`);
}

console.log(fails ? `\n${fails} PRUEBAS FALLARON` : '\nTODO VERDE');
process.exit(fails ? 1 : 0);
