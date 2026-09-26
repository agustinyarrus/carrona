// Controles táctiles: la matemática de los sticks (zona muerta, histéresis, ejes de cámara,
// ayuda de puntería) y la capa virtual de Input (acciones mantenidas y tocadas, ejes analógicos,
// la última dirección del stick de puntería). Sin DOM: Input recibe un blanco de eventos de mentira.
//   node test/t_touch.mjs
import { register } from 'node:module';
register('./_three_hooks.mjs', import.meta.url);      // options.js y renderer.js importan Three

const { STICK, AIM_ASSIST, stickVector, Latch, snapAim, stickToWorld, followOrigin, analogSpeed } = await import('../src/core/sticks.js');
const { Input } = await import('../src/core/input.js');
const { OPTIONS, defaultSettings, normalizeSettings } = await import('../src/game/options.js');
const { QUALITY, QUALITY_ORDER, RENDER_SCALES, adaptiveStepDown } = await import('../src/render/renderer.js');
const { SIM, splitStep } = await import('../src/core/util.js');
const { haptic, setHaptics, canVibrate, HAPTIC } = await import('../src/core/haptics.js');

let fails = 0;
const ok = (name, cond, extra = '') => { console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${name}   ${extra}`); if (!cond) fails++; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const group = (s) => console.log(`\n  ── ${s} ${'─'.repeat(Math.max(2, 60 - s.length))}`);

group('stickVector: zona muerta y saturación');
{
  const z = stickVector(0, 0);
  ok('sin desplazamiento no hay vector', z.x === 0 && z.y === 0 && z.mag === 0);
  const d = stickVector(STICK.radius * STICK.dead * 0.9, 0);
  ok('dentro de la zona muerta sale cero', d.mag === 0 && d.x === 0);
  const e = stickVector(STICK.radius * (STICK.dead + 0.001), 0);
  ok('apenas afuera de la zona muerta arranca cerca de cero (sin salto)', e.mag > 0 && e.mag < 0.01, e.mag.toFixed(4));
  const f = stickVector(STICK.radius, 0);
  ok('al radio completo satura en 1', near(f.mag, 1) && near(f.x, 1) && near(f.y, 0));
  const g = stickVector(STICK.radius * 3, 0);
  ok('más allá del radio sigue en 1 (no crece)', near(g.mag, 1) && near(g.x, 1));
  const up = stickVector(0, -STICK.radius);
  ok('el dedo hacia ARRIBA de la pantalla da y positivo (adelante)', near(up.y, 1) && near(up.x, 0));
  const diag = stickVector(30, 30, 60);
  ok('la dirección se conserva (diagonal 45°)', near(diag.x, -diag.y) && diag.x > 0, `${diag.x.toFixed(3)}, ${diag.y.toFixed(3)}`);
  ok('radio inválido o NaN no revienta', stickVector(10, 10, 0).mag === 0 && stickVector(NaN, 3).mag === 0);
}

group('Latch: histéresis');
{
  const L = new Latch(0.55, 0.40);
  ok('empieza apagado', L.state === false);
  ok('por debajo de on sigue apagado', L.update(0.5) === false);
  ok('al pasar on prende', L.update(0.6) === true);
  ok('entre off y on sigue prendido (histéresis)', L.update(0.45) === true);
  ok('por debajo de off apaga', L.update(0.3) === false);
  let threw = false; try { new Latch(0.4, 0.5); } catch { threw = true; }
  ok('off ≥ on es un error ruidoso', threw);
  // sin histéresis el dedo temblando en el umbral haría ráfagas: con ella, una sola transición
  const M = new Latch(0.55, 0.40); let flips = 0, prev = false;
  for (let i = 0; i < 200; i++) { const v = 0.55 + Math.sin(i * 0.7) * 0.05; const s = M.update(v); if (s !== prev) flips++; prev = s; }
  ok('un dedo que tiembla ±0,05 alrededor del umbral no hace ráfagas', flips <= 1, `${flips} cambios en 200 muestras`);
}

group('stickToWorld: ejes de la cámara');
{
  const fwd = { x: 0, z: -1 }, rgt = { x: 1, z: 0 };
  const a = stickToWorld(0, 1, fwd, rgt);
  ok('stick adelante = adelante de la cámara', near(a.x, 0) && near(a.z, -1) && near(a.mag, 1));
  const b = stickToWorld(1, 0, fwd, rgt);
  ok('stick a la derecha = derecha de la cámara', near(b.x, 1) && near(b.z, 0));
  const c = stickToWorld(0, 0, fwd, rgt);
  ok('sin stick devuelve la dirección de la cámara con magnitud 0', near(c.x, 0) && near(c.z, -1) && c.mag === 0);
  const r = Math.SQRT1_2, f2 = { x: r, z: -r }, r2 = { x: r, z: r };
  const d = stickToWorld(0.5, 0.5, f2, r2);
  ok('con la cámara girada 45° el vector rota con ella (unitario)', near(Math.hypot(d.x, d.z), 1) && near(d.x, 1) && near(d.z, 0, 1e-9), `${d.x.toFixed(3)}, ${d.z.toFixed(3)}`);
}

group('snapAim: la ayuda de puntería');
{
  const targets = [{ x: 0, z: -8 }, { x: 1.2, z: -8 }, { x: -6, z: -8 }, { x: 0, z: -30 }];
  const s1 = snapAim(0.05, -0.99875, 0, 0, targets);
  ok('imanta al zombi que está casi en la dirección del stick', s1.snapped && near(s1.dx, 0) && near(s1.dz, -1));
  const s2 = snapAim(1, 0, 0, 0, targets);
  ok('no imanta a nadie fuera del cono', !s2.snapped && s2.dx === 1 && s2.dz === 0);
  const s3 = snapAim(0, -1, 0, 0, [{ x: 0, z: -30 }]);
  ok('ni al que está más lejos que el alcance de la ayuda', !s3.snapped);
  // stick 1,1° a la derecha del frente: el de (0,−8) queda a 1,1°, el de (1,2,−8) a 7,4° → gana el primero
  const s4 = snapAim(0.02, -0.9998, 0, 0, targets);
  ok('con dos en el cono gana el de menor ángulo', s4.snapped && near(s4.dx, 0, 1e-6) && near(s4.dz, -1, 1e-6), `${s4.dx.toFixed(3)}`);
  // y al revés: stick 7° a la derecha → gana el de (1,2,−8)
  const s4b = snapAim(Math.sin(0.122), -Math.cos(0.122), 0, 0, targets);
  ok('… y el otro cuando el stick está más cerca de él', s4b.snapped && near(s4b.dx, 1.2 / Math.hypot(1.2, 8), 1e-6), `${s4b.dx.toFixed(3)}`);
  const s5 = snapAim(0, -1, 0, 0, [{ x: 0, z: -8 }, { x: 0, z: -4 }]);
  ok('a igual ángulo gana el más cercano (misma dirección: da igual)', s5.snapped && near(s5.dz, -1));
  const s6 = snapAim(0, -1, 0, 0, [{ x: 0, z: -0.1 }]);
  ok('uno encima del jugador no cuenta', !s6.snapped);
  ok('el cono y el alcance son constantes con nombre', AIM_ASSIST.angle > 0.1 && AIM_ASSIST.angle < 0.35 && AIM_ASSIST.dist >= 8);
  ok('con una lista vacía devuelve la dirección tal cual', !snapAim(0.6, 0.8, 0, 0, []).snapped);
}

group('Input: la capa virtual');
{
  const fake = { addEventListener() {}, removeEventListener() {} };
  const I = new Input(fake, { fire: ['Mouse0'], reload: ['KeyR'], run: ['ShiftLeft'], moveLeft: ['KeyA'], moveRight: ['KeyD'], moveUp: ['KeyW'], moveDown: ['KeyS'], crouch: ['KeyC'], roll: ['KeyC'] });
  ok('sin nada, ninguna acción', !I.fire && !I.act('reload') && I.moveX() === 0 && I.moveZ() === 0 && !I.run);
  I.setVirtual('fire', true);
  ok('mantener fire: act y actPressed en el frame', I.fire && I.act('fire') && I.actPressed('fire'));
  I.endFrame();
  ok('al frame siguiente sigue mantenida pero ya no es "tocada"', I.fire && !I.actPressed('fire'));
  I.setVirtual('fire', false);
  ok('soltar la apaga', !I.fire);
  I.tapVirtual('reload');
  ok('un toque es un flanco (actPressed) sin mantener (act)', I.actPressed('reload') && !I.act('reload'));
  I.endFrame();
  ok('el flanco se limpia al final del frame', !I.actPressed('reload'));
  // el toque entre frames sobrevive hasta el update siguiente: tapVirtual → (endFrame del frame anterior ya pasó) → leído
  I.tapVirtual('reload'); ok('un toque hecho entre frames se lee en el próximo', I.actPressed('reload')); I.endFrame();
  I.setMove(0.3, -0.8, true, false);
  ok('el stick de movimiento es analógico', near(I.moveX(), 0.3) && near(I.moveZ(), -0.8) && !I.run);
  I.setMove(0, 1, true, true);
  ok('al fondo corre', I.run && near(I.moveZ(), 1));
  I.setMove(0, 0, false, true);
  ok('soltado no corre aunque se pida (run exige activo) y vuelve a las teclas', !I.run && I.moveX() === 0 && !I.move.active);
  I.setAim(0.6, 0.8, true);
  ok('el stick de puntería guarda la dirección unitaria', I.aimStick.active && near(I.aimStick.lastX, 0.6) && near(I.aimStick.lastY, 0.8));
  I.setAim(0, 0, false);
  ok('al soltarlo la última dirección queda', !I.aimStick.active && near(I.aimStick.lastX, 0.6) && near(I.aimStick.lastY, 0.8));
  I.setAim(0, 0, true);
  ok('activo pero en el centro no pisa la última dirección', near(I.aimStick.lastX, 0.6));
  // el teclado sigue andando por debajo de la capa virtual
  I.down.add('KeyD'); ok('las teclas siguen mandando cuando el stick no está activo', I.moveX() === 1);
  I.setMove(-1, 0, true); ok('con el stick activo, manda el stick', I.moveX() === -1);
}

group('opciones y calidad móvil');
{
  const names = OPTIONS.filter(o => o.group === 'controls').map(o => o.key);
  ok('las opciones táctiles están en el grupo controles', ['touch', 'touchFire', 'touchAssist', 'touchSize', 'touchOpacity', 'touchLefty', 'touchHaptics'].every(k => names.includes(k)), names.join(' '));
  const d = defaultSettings();
  ok('por defecto: táctil automático, disparo con el stick, ayuda de puntería, diestro, con vibración', d.touch === 'auto' && d.touchFire === 'stick' && d.touchAssist === true && d.touchLefty === false && d.touchHaptics === true);
  const n = normalizeSettings({ touch: 'x', touchFire: 3, touchSize: 9 });
  ok('valores rotos vuelven al defecto o se acotan', n.touch === 'auto' && n.touchFire === 'stick' && n.touchSize === 1.5);
  ok('el orden de calidades arranca en «minimo» y sigue «movil»', QUALITY_ORDER[0] === 'minimo' && QUALITY_ORDER[1] === 'movil' && QUALITY.movil.maxWidth === 1100);
  ok('«minimo» es el piso: 900 px, sin bloom, mapas de sombra chicos', QUALITY.minimo && QUALITY.minimo.bloom === 0 && QUALITY.minimo.moonMap <= 512 && QUALITY.minimo.flashMap <= 256 && QUALITY.minimo.maxWidth === 900);
  // la caída adaptativa a «minimo» ocurre jugando: si cambiara la topología de sombras recompilaría todos los materiales (segundos congelado)
  ok('«minimo» y «movil» tienen la misma topología de sombras (la caída no recompila shaders)', !!QUALITY.minimo.shadows === !!QUALITY.movil.shadows && (QUALITY.minimo.flashMap > 0) === (QUALITY.movil.flashMap > 0));
  ok('todos los presets del orden existen', QUALITY_ORDER.every(k => QUALITY[k]));
  ok('«movil» rinde igual en cualquier pantalla: el ancho de render manda, no el dpr', QUALITY.movil.msaa === 0 && QUALITY.movil.dpr >= 1);
}

group('splitStep: la simulación a tiempo real');
{
  ok('un cuadro normal es un paso', splitStep(1 / 60).n === 1 && near(splitStep(1 / 60).h, 1 / 60));
  ok('justo 1/30 sigue siendo un paso', splitStep(1 / 30).n === 1);
  const s = splitStep(0.05); ok('50 ms (20 fps) son dos pasos de 25 ms', s.n === 2 && near(s.h, 0.025));
  const s3 = splitStep(0.1); ok('100 ms son tres pasos de 1/30', s3.n === 3 && near(s3.h, 1 / 30));
  const s4 = splitStep(0.5); ok('más allá del tope se resigna: tres pasos más grandes (no espiral)', s4.n === 3 && near(s4.h, 0.5 / 3));
  ok('dt cero, negativo o NaN no revienta', splitStep(0).n === 1 && splitStep(-1).h === 0 && splitStep(NaN).n === 1);
  ok('el tope de cuadro del bucle es step × maxSteps = 0,1 s', near(SIM.step * SIM.maxSteps, 0.1));
  // la suma de los pasos es exactamente el dt: no se pierde ni se inventa tiempo
  for (const dt of [0.017, 0.034, 0.05, 0.081, 0.1]) { const r = splitStep(dt); if (!near(r.n * r.h, dt)) { ok(`los pasos suman el dt (${dt})`, false); break; } }
  ok('los pasos suman exactamente el dt', true);
}

group('followOrigin: el stick de mover sigue al dedo');
{
  const a = followOrigin(100, 100, 130, 100, 64); ok('adentro del radio el origen no se mueve', !a.moved && a.ox === 100 && a.oy === 100);
  const b = followOrigin(100, 100, 200, 100, 64); ok('afuera, el origen se arrastra hasta quedar a un radio del dedo', b.moved && near(b.ox, 136) && near(b.oy, 100));
  const c = followOrigin(0, 0, 60, 80, 50); ok('en diagonal conserva la dirección', c.moved && near(Math.hypot(60 - c.ox, 80 - c.oy), 50) && near(c.ox / c.oy, 0.75));
  ok('radio inválido: no se mueve', !followOrigin(0, 0, 500, 0, 0).moved && !followOrigin(0, 0, 500, 0, NaN).moved);
  const f = followOrigin(100, 100, 300, 100, 64); const v = stickVector(300 - f.ox, 100 - f.oy, 64);
  ok('después de seguir, el stick queda al fondo apuntando al dedo', near(v.mag, 1) && near(v.x, 1));
  // el dedo que pasó de largo y vuelve en la dirección opuesta cambia de sentido en un radio, no en dos
  const g = followOrigin(f.ox, f.oy, 300 - 2 * 64, 100, 64); const v2 = stickVector(300 - 2 * 64 - g.ox, 100 - g.oy, 64);
  ok('volver un diámetro ya invierte el sentido al fondo', near(v2.mag, 1) && near(v2.x, -1), `x ${v2.x.toFixed(2)}`);
}

group('analogSpeed: velocidad continua del stick');
{
  const W = 3.6, R = 5.6;
  ok('quieto es cero y al fondo es correr', analogSpeed(0, W, R) === 0 && near(analogSpeed(1, W, R), R));
  ok('al final de la zona de caminar es exactamente caminar', near(analogSpeed(STICK.walkEnd, W, R), W));
  ok('a mitad de la zona de caminar, la mitad', near(analogSpeed(STICK.walkEnd / 2, W, R), W / 2));
  let mono = true, maxJump = 0, prev = 0;
  for (let i = 1; i <= 1000; i++) { const s = analogSpeed(i / 1000, W, R); if (s < prev - 1e-9) mono = false; maxJump = Math.max(maxJump, s - prev); prev = s; }
  ok('monótona y sin saltos: el mayor escalón por milésima de stick es de un centímetro por segundo', mono && maxJump < 0.02, `${(maxJump * 100).toFixed(2)} cm/s`);
  ok('en el umbral de la postura de correr (0,85) va a mitad de camino entre caminar y correr', near(analogSpeed(STICK.runOn, W, R), (W + R) / 2, 1e-6), analogSpeed(STICK.runOn, W, R).toFixed(2));
  ok('fuera de rango se acota', analogSpeed(1.7, W, R) === R && analogSpeed(-2, W, R) === 0 && analogSpeed(NaN, W, R) === 0);
  ok('la postura de correr tiene histéresis debajo del umbral y arriba del fin de caminar', STICK.runOff >= STICK.walkEnd && STICK.runOn > STICK.runOff);
}

group('adaptiveStepDown: primero la resolución, después el preset');
{
  ok('desde movil a resolución completa baja a 0,85', adaptiveStepDown('movil', 1).renderScale === 0.85);
  ok('de 0,85 a 0,7', adaptiveStepDown('movil', 0.85).renderScale === 0.7);
  ok('en 0,7 cambia de preset: movil → minimo', adaptiveStepDown('movil', 0.7).quality === 'minimo');
  ok('en el piso (minimo a 0,7) no hay más que bajar', Object.keys(adaptiveStepDown('minimo', 0.7)).length === 0);
  ok('alto a 1 → alto a 0,85 (la resolución antes que el preset)', adaptiveStepDown('alto', 1).renderScale === 0.85);
  ok('una escala rara (0,9) cae al escalón siguiente por debajo', adaptiveStepDown('medio', 0.9).renderScale === 0.7);
  ok('las escalas son decrecientes y la última no baja de 0,7', RENDER_SCALES[0] === 1 && RENDER_SCALES.every((s, i) => i === 0 || s < RENDER_SCALES[i - 1]) && RENDER_SCALES[RENDER_SCALES.length - 1] >= 0.7);
}

group('haptics: sin navegador no hace nada y no tira');
{
  ok('en Node no hay vibración', !canVibrate());
  setHaptics(true);
  ok('haptic() devuelve false sin soporte, con y sin fuerza', haptic(HAPTIC.shot) === false && haptic(HAPTIC.hurt, true) === false);
  ok('los pulsos con nombre son cortos (≤ 60 ms) y el golpe es el más largo', Object.values(HAPTIC).every(ms => ms > 0 && ms <= 60) && HAPTIC.hurt > HAPTIC.shot);
  setHaptics(false);
}

console.log(fails ? `\n${fails} PRUEBAS FALLARON` : '\nTODO VERDE');
process.exit(fails ? 1 : 0);
