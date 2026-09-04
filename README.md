<div align="center">

# CARRONA

**Zombis top-down en una oficina de noche. Todos los cuerpos son ragdoll activo, todo el tiempo.**

Motor de física propio, músculos que son controladores PD, marcha por cinemática inversa y una
biblioteca de movimientos físicos: veinticinco maneras de levantarse, veintidós de caer, seis de
morir, trece de saltar, seis de trepar, veintiún sacudones por tiro, veinte ataques, once tics y
seiscientas combinaciones de estilo de marcha. Uno de cada cinco zombis pega saltitos; dos de
cada diez hacen parkour.
Un `index.html`, módulos ES, Three.js vendorizado. Cero dependencias que instalar, cero archivos
de textura o de sonido: todo es procedural.

![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?logo=javascript&logoColor=black)
![Three.js](https://img.shields.io/badge/Three.js-r160-000000?logo=three.js&logoColor=white)
![Física](https://img.shields.io/badge/F%C3%ADsica-XPBD%20propia-8a2be2)
![Dependencias](https://img.shields.io/badge/dependencias-0-2ea44f)
![Licencia](https://img.shields.io/badge/licencia-MIT-blue)

![CARRONA](docs/juego.jpg)

</div>

## Qué es

Un shooter de oleadas visto desde arriba. La gracia no está en las armas sino en los cuerpos:
no hay ni un solo clip de animación en el proyecto. Cada zombi y el jugador son un esqueleto
de partículas que la física mueve, y lo único que cambia entre "camina", "corre", "se estrella
contra la pared" y "muere" es cuánta fuerza hace cada músculo para llegar a su pose. Un tiro
en el brazo apaga ese brazo. Un tiro en el pecho lo hace tambalear dos pasos hacia atrás y ahí
se queda. Un tiro en el hombro lo hace girar. Una escopeta de frente lo sienta de espaldas; por
la espalda, lo tira de boca. Un corredor que pega contra un escritorio queda colgado de él,
y después se levanta: rodando y empujando con los brazos, o de un salto si tiene apuro.

<div align="center">

| ![pelea](docs/pelea.jpg) | ![estampida](docs/estampida.jpg) |
|:--:|:--:|
| linterna, sangre y cuerpos que caen con su inercia | estampida de corredores por una puerta |

</div>

## Jugar

Doble clic en **`Jugar CARRONA.bat`**: levanta un servidor local en el puerto 8765 y abre el
navegador. `Jugar CARRONA (sin consola).vbs` hace lo mismo sin ventana negra. Hace falta
Python 3 en el PATH y Chrome o Edge. Los módulos ES no cargan desde `file://`, por eso el servidor.

| Tecla | Acción |
|---|---|
| WASD / flechas | moverse (relativo a la cámara) |
| Shift | correr (el arma baja, el cuerpo se inclina al arrancar) |
| C / Ctrl | agacharse. C tocada mientras corrés: **rodada de esquive** |
| mouse | apuntar. Click dispara (mantener en las automáticas) |
| R | recargar |
| 1 a 4 | cambiar de arma |
| Espacio | trepar lo que tenga adelante; corriendo sin nada adelante, **saltar**; si no, empujón. En el piso: levantarse ya |
| Q / E | girar la cámara 45° |
| rueda | acercar o alejar la cámara |
| F | linterna |
| Esc | pausa: calidad gráfica, volumen, sacudida de cámara |
| F3 | panel de rendimiento |

Armas: pistola (munición infinita), subfusil desde la oleada 2, escopeta desde la 3, fusil desde
la 5 (atraviesa un cuerpo). La cabeza recibe daño ×4. Los miembros se cortan con daño acumulado
y sin una pierna el zombi se arrastra. Entre oleadas caen munición, botiquines y armas.

El jugador es **ágil**: contra una pared a toda velocidad atrapa con las manos y rebota (no se
desarma), se lleva puesto a un zombi con el hombro sin caerse, y tirado en el piso no espera:
apretando una dirección rueda de costado o gatea hacia allá y se levanta en la carrera.

## El core

Diez mil líneas de JavaScript sin framework. Estas son las piezas y por qué son así.

### 1. Motor de física XPBD (`src/phys/world.js`)

Position Based Dynamics extendido, escrito desde cero para este juego.

- **Partículas en arreglos planos** (`px, py, pz, vx, vy, vz, invMass, flags`), nada de objetos
  por partícula. Un solo `Float32Array` por atributo, así el bucle caliente no persigue punteros.
- **Substepping**: 7 substeps por cuadro a 60 Hz, o sea 420 Hz de física. Las restricciones se
  resuelven una vez por substep en vez de iterar muchas veces por cuadro; es la variante que
  mejor conserva la rigidez sin que la energía explote.
- **Restricciones de distancia con compliance** (la "X" de XPBD): huesos casi rígidos, límites de
  rango mínimo y máximo para codos y rodillas, y restricciones blandas para el torso.
- **Colisión**: partículas contra piso, cajas orientadas y cilindros, con hash espacial de celda
  0.55 m para las partículas entre sí. Además **los huesos chocan como cápsulas**, no sólo sus
  puntas: contra el mundo (un cuerpo puede quedar colgado del borde de un escritorio) y contra
  partículas ajenas (una pierna patea una caja, un brazo se apoya en otro torso).
- **Ganancia por dueño**: cada partícula sabe de qué cuerpo es. Un cuerpo sin músculo no puede
  empujar a uno con músculo más de un 10 % por substep, y hay un tope de 9 m/s para cuerpos
  sin control. Sin eso una estampida funcionaba de topadora y mandaba cuerpos a 60 metros.
- **Expulsión limitada**: la corrección de penetración se acota al movimiento real del substep,
  así una superposición grande se resuelve en varios pasos y no como un disparo.
- **Raycast contra estáticos** para la puntería y para la raíz de los cuerpos, y `compact()`
  para reciclar partículas de cuerpos que ya no existen.

Costo medido con la CPU libre: 40 ragdolls más 40 cajas y 12 cilindros en 9 ms por cuadro;
916 partículas con 3250 restricciones en 11 ms.

### 2. Ragdoll activo (`src/phys/ragdoll.js`)

Un humanoide de **16 partículas y 15 huesos** (cabeza, cuello, pecho, hombros, codos, manos,
cadera, rodillas, pies) con una pose de referencia en metros (`skeleton.js`). Sobre esa base:

**Músculos como controlador PD, no como resorte.** Cada partícula tiene un objetivo (su lugar en
la pose, ya orientado y desplazado con la raíz). En cada substep el músculo tira la posición
hacia el objetivo (término proporcional) y después fusiona la velocidad de la partícula con la
velocidad del cuerpo (término derivativo), con **amortiguación crítica**:

```
a = (1 - phys) · min(1, max(0, (m - 0.02) · 14)) · min(1, 1.45 · sqrt(kSub · m))
```

`m` es la fuerza del músculo de esa partícula, `kSub` la ganancia de posición del substep. Con
amortiguación infinita el cuerpo llegaba exacto a su pose y parecía un maniquí; con menos que
crítica oscilaba a 18 rad/s alrededor de la pose aun al 1 % de fuerza y cada empujón rebotaba.
Con esto el torso queda firme y la cabeza y los brazos llegan con un retraso y un pequeño
sobrepaso, que es lo que se lee como movimiento secundario. Cayendo o muriendo la
amortiguación se apaga del todo: la inercia manda.

**Raíz virtual con correa.** El cuerpo no se mueve empujando partículas: se mueve un punto
invisible (la raíz) al que la pose está anclada, y los músculos lo siguen. La raíz avanza por
substep (no por cuadro, para que no haya dientes de sierra), nunca cruza una pared (raycast
antes de cada paso), no entra en otro cuerpo de pie (resbala tangencialmente a su alrededor y
los dos se dan un topetazo) y tiene una correa: si el cuerpo se queda atrás más de cierto largo,
la raíz espera. Cayendo, la pose se ancla al **centro de masa** del cuerpo real: el músculo da
forma a los miembros sin empujar al conjunto, y el momento que traía se conserva.

**Velocidad con inercia.** La velocidad pedida por la IA o el jugador se rampa a 9 m/s² al
acelerar y 14 al frenar. Arrancar y parar toman tiempo y el cuerpo se **inclina al esfuerzo**:
la diferencia entre la velocidad que quiere y la que tiene se convierte en una inclinación del
torso, adelante al arrancar, atrás al frenar.

**Marcha por cinemática inversa.** No hay ciclo de caminata grabado. Cada pie sigue una
trayectoria: apoyo lineal a la velocidad del cuerpo y vuelo en arco, con zancada proporcional a
la velocidad y en la dirección del movimiento (el jugador da pasos laterales mientras apunta a
otro lado; un tiro hace dar pasos hacia atrás). La rodilla se resuelve con IK de dos huesos
usando el largo real de muslo y pantorrilla, doblando siempre hacia adelante. Caminar, trotar y
correr son la misma marcha mezclada por velocidad: rodilla mínima de 125°, 103° y 89°, pie que
sube 16, 26 y 34 cm. Los codos también salen por IK.

**Estilos de marcha** (`moves.js`): cada cuerpo sortea al nacer un estilo de caminar y uno de
correr, y los mezcla según la marcha. **Treinta de correr**: sprint, carga con los brazos
atrás, agitando los brazos, a zancadas, como un toro con la cabeza gacha, molinete, rengo,
agachado, pisando fuerte, a saltos, garras al frente, el clásico con los brazos tiesos,
**brazos sin músculo que cuelgan y se sacuden** (física pura), un brazo en alto, abrazándose,
las manos en la cabeza, gorila con los nudillos rozando el piso, gritando con la cabeza atrás,
brazos como alas hacia atrás, manos altas a agarrarte, atleta, brazos cruzados, medio de
costado, galope (las piernas fuera de contrafase), rebotando, en puntas de pie, arrastrando
los pies, borracho en zigzag, echado atrás, piernas tiesas. **Veinte de caminar**: arrastrando
los pies, arrastrando una pierna, tieso, encorvado, brazos extendidos, con tics, bamboleándose,
ladeado, tambaleante, rengo, gateando casi, con jaqueca, abrazado, garras, orgulloso, cangrejo,
delicado, elástico, arrastrando, aullando. Seiscientas combinaciones: una horda no se ve clonada.

**Máquina de estados y biblioteca de movimientos** (`moves.js`). Un movimiento es una
secuencia de poses objetivo generadas por funciones, con un perfil de músculo por miembro,
movimiento de raíz, giros de marco e impulsos puntuales. Los músculos tiran hacia esas poses y
la física hace el resto: por eso una levantada choca con el escritorio de al lado.

| Estado | Qué corre |
|---|---|
| de pie | la marcha con su estilo, más **overlays** que se suman sin interrumpirla: **veintiún sacudones** por tiro (la cabeza se va, latigazo, el pecho se pliega, la espalda se arquea, se dobla por el estómago, el hombro lo gira, el brazo vuela, la cadera se va o se tuerce, se ladea, la pierna da un saltito, las rodillas ceden, se agarra el brazo, la cara o la panza, convulsión, encogerse de hombros, brazos buscando el equilibrio, casi se desploma), **cinco heridas sostenidas** (una mano apretando la cabeza, la panza, el hombro o el muslo mientras sigue andando), **veinte ataques** y once tics de quieto |
| tambaleo | pasos reales en la dirección del golpe con latigazo del torso; la raíz se va con él y el cuerpo **queda desplazado**, no vuelve como una goma |
| saltando | agachada previa sin cortar la marcha, patada real a todas las partículas y la pose **anclada al arco balístico** (el controlador PD persigue la velocidad vertical del arco, así el cuerpo vuela de verdad y aterriza con impacto). **Trece figuras**: saltito, brinco, zancada, bollo, plancha, patada voladora, rodillazo volador, estrella, manoteando el aire, dejándose caer, valla, rebote en la pared, saltito de emoción. Al caer flexiona según la altura; el ágil rueda; el torpe se desploma |
| trepando / bajando | el ancla sube del piso a la tapa (o baja) con la curva del estilo. **Seis trepadas**: clásica (manos, rodilla, arriba), pasada rápida con una mano y las piernas cruzando de costado, kong (dos manos, cadera arriba, piernas entre los brazos), dash (las piernas primero, las manos atrás), de panza por encima, frenética a cuatro patas. Una valla baja a la carrera se salta sin manos; el de parkour se tira de cabeza por encima y rueda. A veces sale mal: se lleva el borde por delante y vuelca encima. **Bajar**: ve el borde medio metro antes y elige: paso a paso, sentarse y dejarse caer, saltito, salto, salto y rodada, o tropezar |
| movimiento | secuencias cortas que devuelven el control de pie: rodada hacia adelante, de hombro (parkour), hacia atrás, de costado por el piso, gateo rápido que se vuelve carrera, deslizada de béisbol, embestida con el hombro, agacharse de golpe, pasos tambaleantes |
| cayendo | una de **veintidós caídas** elegida por causa y ángulo: sentarse de espaldas, de tabla, de boca, de rodillas y de boca, de costado, girando, desplomarse, volando, voltereta (el corredor), rebote contra la pared, de cara contra la pared, girar y resbalar por la pared, desplomarse contra la pared, volcar sobre un borde, de cara sin manos, rueda de costado, helicóptero, resbalón, tres pasos y cae, de rodillas resbalando, plancha fallida, tacle |
| tirado | física pura, aturdido un tiempo que depende del tipo (el corredor 0.35 s, el bruto 1.3 s, el jugador 0.28 s) |
| levantándose | una de **veinticinco levantadas** elegida por cómo quedó. Boca arriba: abdominal, rodar y empujar, de un salto, pesada, rodar y gatear, voltereta hacia atrás, mareado y ladeado, el bruto que ruge. Boca abajo: flexión, rodilla primero, rodar y sentarse, gatear, rápida, explosiva desde la posición de salida, gatear y salir corriendo, la que falla a mitad y vuelve a intentar. De costado: a boca abajo, a boca arriba, sobre el codo, barrer las piernas. Desde arrodillado: normal, de un salto, lanzándose a correr. Desde sentado: normal, girando sobre una rodilla. El peso de cada una depende del tipo de cuerpo y del rasgo parkour |
| descansando | dormido en el piso o sentado contra la pared hasta que algo lo despierte; entonces se levanta como corresponda |
| muriendo | una de **seis muertes**: se desploma, camina herido y cae, cae de rodillas y de boca, se arquea de espaldas, gira y cae, se dobla y se va de costado. Un tiro en la cabeza es instantáneo |

**Reacción al disparo**, el patrón de "physical animation":

1. Impulso local en el punto del hueso donde pegó: el miembro se va y el torso gira si el
   tiro fue descentrado.
2. Un sacudón elegido por zona y ángulo (la tabla de arriba), encima de lo que estuviera haciendo.
3. Un tambaleo con pasos reales en la dirección del tiro; el objetivo de equilibrio se muda.
4. Un tiro en el hombro hace girar el cuerpo. Un tiro en la pierna corriendo lo tropieza (el
   corredor da la voltereta y sigue); parado, se le dobla la rodilla o se desploma si fue fuerte.
5. Mucho momento en poco tiempo (escopeta, ráfaga) lo tira, con una caída elegida por el ángulo.

**Colisiones a la carrera.** Contra una pared de frente, según quién: el ágil (el jugador, el
de parkour) **la atrapa con las manos**, rebota y tambalea hacia atrás sin caer; el de parkour
rápido planta un pie y **se impulsa hacia atrás y arriba** girando en el aire; el resto rebota y
cae, se estrella de cara, gira y resbala por la pared hasta sentarse, o se le doblan las
piernas contra ella. Contra el borde de un escritorio que no llegó a trepar: vuelca encima. De
refilón: raspa el hombro, gira y sigue tambaleando a lo largo de la pared. Contra otro cuerpo:
por la espalda, el de adelante cae de boca y el de atrás se tropieza con él; de frente, a más
velocidad los dos se van al piso; de costado, un hombrazo que hace girar al otro; el ágil se lo
lleva puesto con el hombro y sigue. Los pies que se traban en un cadáver o una caja tropiezan.

### 3. Navegación (`src/game/nav.js`)

El nivel se rasteriza a una grilla de 0.4 m con 0.30 m de margen y se calcula un **campo de
flujo** con Dijkstra desde el jugador. Cada zombi lee la dirección de su celda: cien cuerpos
cuestan lo mismo que uno. Los muebles con tapa por debajo de 1.05 m no cortan el camino, así que
el flujo pasa por encima de escritorios y mesas y los zombis los trepan en vez de rodearlos.

### 4. La horda (`src/game/zombie.js`, `src/game/game.js`)

Estilo Left 4 Dead: **todos corren** cuando te persiguen, cada uno a su manera.

| Tipo | Deambulando | Persiguiendo | Rasgo |
|---|---|---|---|
| caminante | 0.35 a 0.7 m/s | 2.6 a 3.3 m/s | arrastra los pies hasta que te ve |
| trotador | 0.45 a 0.85 m/s | 3.0 a 3.7 m/s | la mayoría de la horda desde la oleada 2 |
| corredor | 0.55 a 1.0 m/s | 3.7 a 4.6 m/s | liviano, se estrella contra todo, tacle |
| bruto | 0.35 a 0.55 m/s | 1.7 a 2.2 m/s | 1.8 de masa, resiste 2.6 veces más, mazazo que tumba |

Estados: dormido (deambula, o descansa sentado, arrodillado o tirado en el piso), alerta (te
vio, te oyó o le pegaste: se da vuelta, medio segundo de reacción, y arranca), persecución
(flujo lejos, directo cerca, separación entre cuerpos y flanqueo para rodearte), ataque.

**Rasgos.** Uno de cada cinco **pega saltitos**: brinca mientras corre con su figura propia
(brinco, zancada, patada, manoteando el aire), salta de emoción dos o tres veces al verte y se
mece sobre las rodillas cuando está quieto. Dos de cada diez hacen **parkour**: cruzan los
escritorios en kong o dash, o se tiran de cabeza por encima y ruedan; bajan saltando y ruedan
al caer; rebotan en las paredes con el pie; se lanzan en plancha desde tres metros; se levantan
con voltereta o de un salto; y se les nota la agilidad en todo lo demás.

| Ataque | Quién | Qué hace |
|---|---|---|
| manotazo derecho o izquierdo, revés, garra, doble garra | todos | empujón |
| doble manotazo | todos | empujón fuerte |
| agarrón, agarrón lanzado, agarrar y sacudir, morder el cuello | caminante, trotador | te frena un instante |
| mordida | todos | la cabeza va al cuello |
| cabezazo, rodillazo | todos | tambaleo grande |
| patada | trotador, corredor | empujón con la pierna |
| gancho | trotador, corredor | te levanta |
| molinete | todos, poco | vuelta entera del brazo: te tumba |
| ráfaga | corredor | tres manotazos seguidos |
| pisotón | todos | sólo si estás en el piso |
| mazazo, puños al piso, molinete del bruto | bruto | te tumba |
| embestida | bruto, corredor | baja el hombro desde tres metros: te tumba |
| tacle | corredor | se tira de cabeza: los dos al piso |
| **plancha** | corredor, parkour | se lanza en el aire desde tres metros y cae encima: los dos al piso |
| rodillazo volador | parkour | salta con la rodilla al frente: te tumba |
| caer encima | cualquiera arriba de un mueble | se tira desde el escritorio sobre vos |

Los cuerpos lejos del jugador se saltan las pasadas de colisión de huesos (`lod`). Desde la
primera oleada hay **estampidas**: un grupo de corredores entra junto por una puerta cada 14 a
34 s. Cada oleada deja además unos dormidos por los rincones.

### 5. Props y cadáveres (`src/game/props.js`)

Cajas, sillas y macetas son clusters rígidos de partículas. Cuando se quedan quietos **duermen
y pasan a ser colisionadores estáticos** del mundo: se apilan, sostienen cuerpos y cuestan cero.
Se despiertan cuando alguien se acerca o les pegan un tiro. Un muerto que dejó de moverse se
congela igual: sus huesos pasan a un buffer de cadáveres y queda como obstáculo bajo, que los
vivos tienen que sortear o pisar.

### 6. Armas (`src/game/weapons.js`)

Hitscan contra huesos (cápsulas) y estáticos, con perdigones, dispersión, retroceso, caída de
daño en la escopeta y perforación en el fusil (atraviesa un cuerpo con 60 % del daño). Cada
hueso tiene puntos de vida propios; sólo escopeta y fusil llegan a cortar un miembro.

| Arma | Daño | Cadencia | Cargador | Impulso |
|---|---|---|---|---|
| pistola | 30 | 6.5/s | 12, reserva infinita | 7 |
| subfusil | 17 | 13/s | 32 | 4.5 |
| escopeta | 14 × 9 perdigones | 1.3/s | 6 | 9 |
| fusil | 44 | 8.5/s | 30 | 13, atraviesa |

### 7. Jugador (`src/game/player.js`)

Es un ragdoll más, con el yaw bloqueado al mouse y los brazos en modo "apuntar". Camina a 3.6
m/s, corre a 5.6, agachado a la mitad. Corriendo sin disparar el arma baja y los brazos bombean;
al primer tiro vuelve al frente. Retroceso y recarga mueven las manos por física, no por clip.
Un manotazo lo hace tambalear con el torso plegado; un mazazo o un tacle lo tiran y tiene que
levantarse. Empujón para sacarse zombis de encima, vida que regenera si lo dejan tranquilo, y
muere como todos: los músculos se apagan.

### 8. Render (`src/render/`)

- Three.js r160 vendorizado (sin CDN), pipeline ACES, MSAA, sombras suaves PCF, bloom.
- **Maniquíes instanciados**: cada hueso es una cápsula low poly posicionada desde las
  partículas; una sola llamada de dibujo para toda la horda. Los cadáveres congelados viven en
  un buffer aparte que no se vuelve a tocar.
- **Materiales procedurales**: baldosa beige, alfombras floral, gris y azul, azulejo verde agua,
  listones de madera y la alfombra roja del pasillo se pintan en canvas al arrancar.
- Modelos low poly de colores planos: escritorios, sillas, monitores, plantas, cajas, puertas,
  luces de tubo. Estilo minimalista con iluminación real: luna, tubos fluorescentes, linterna
  con sombras.
- FX: sangre en decals y partículas, fogonazo, trazadoras, casquillos.
- **Calidad adaptativa**: tres presets (`bajo` dpr 0.70, `medio` dpr 0.90 con MSAA 2, `alto`
  dpr 1.25 con MSAA 4). Si no llega a 45 fps sostenidos baja sola un escalón.

### 9. Audio (`src/audio/audio.js`)

Todo sintetizado con Web Audio en tiempo real: disparos, recarga, gruñidos, impactos, ambiente.
No hay un solo archivo de sonido.

## Estructura

```
index.html                 HUD, menús, importmap
src/main.js                arranque: canvas, renderer, audio, bucle
src/core/                  util (rng, clamp, ángulos), input
src/phys/world.js          motor XPBD
src/phys/skeleton.js       índices de partícula y pose de referencia
src/phys/ragdoll.js        ragdoll activo: músculos PD, raíz virtual, marcha IK, estados, reacciones
src/phys/moves.js          poses, caídas, levantadas, muertes, sacudones, ataques, tics, estilos
src/game/level.js          constructor de lugares y la oficina (hall, oficina abierta, dos salas,
                           pasillo, cubículos, cocina; 4 puertas)
src/game/nav.js            campo de flujo
src/game/zombie.js         IA de la horda
src/game/props.js          props rígidos que duermen
src/game/weapons.js        armas e hitscan
src/game/player.js         jugador
src/game/game.js           oleadas, estampidas, dormidos, pickups, disparo, cadáveres, HUD
src/render/                renderer, materiales, cuerpos instanciados, props, FX, modelos, shaders
src/audio/audio.js         síntesis
vendor/three/              Three.js r160 y los addons de postprocesado que se usan
test/                      suites en Node y arneses de navegador
docs/                      capturas
```

## Pruebas

Las suites corren en Node sin navegador y miden comportamiento físico real: distancias, ángulos,
tiempos, velocidades.

```
npm test                       # las once suites
node test/t_world.mjs          # motor: estabilidad, colisiones, expulsión suave, rendimiento
node test/t_ragdoll.mjs        # ragdoll: de pie, marcha a 1.4 m/s, muerte, desmembrado, 40 cuerpos
node test/t_nav.mjs            # campo de flujo, muebles trepables
node test/t_props.mjs          # dormir, despertar, apilar
node test/t_realism.mjs        # colgado de un escritorio, choque de pared, levantarse, límites
node test/t_horde.mjs          # horda + armas + jugador, perforación determinista
node test/t_stampede.mjs       # choques a la carrera, tropezones, marchas, pasos laterales
node test/t_hits.mjs           # reacción a los tiros por dirección, zona y momento
node test/t_anim.mjs           # trepar, agacharse, aterrizar, inclinarse, brazos al caer
node test/t_moves.mjs          # el catálogo: cada levantada, caída, muerte, sacudón, ataque, tic,
                               # estilo y descanso, uno por uno (131 pruebas)
node test/t_parkour.mjs        # saltos, trepadas por estilo, bajadas, rodadas, plancha, pared,
                               # el jugador ágil, heridas, los cincuenta estilos, rasgos (53 pruebas)
```

Ejemplos de lo que se comprueba: que las quince levantadas terminan de pie desde su pose exacta
de partida; que cada caída aterriza como dice (de espaldas boca arriba, de boca boca abajo, de
costado de costado) y que el cuerpo se levanta después; que un tiro de pistola lo hace
tambalear más de 25 cm y que tres segundos después sigue ahí; que un tiro en el hombro lo hace
girar; que diez corredores con diez estilos corren todos a más de 3 m/s sin caerse y con los
brazos a alturas distintas; que un caminante alertado corre a más de 2.3 m/s; que un corredor
dormido en el piso se levanta y llega.

Los umbrales de rendimiento se miden con la CPU libre: con el juego corriendo en Chrome al
mismo tiempo fallan por contención, no por el código.

Arneses de navegador (Chrome con puerto de depuración):

```
node test/browser_drive.mjs    # abre Chrome, juega solo y saca capturas a shots/
node test/browser_probe.mjs --all --runners --hit --player   # fps por calidad, corredores, tiros
```

## Decisiones que importan

- **No hay animación aparte de la física.** Cambia la fuerza, no el esqueleto. Cualquier golpe,
  tiro, empujón o caída se compone solo con la marcha, porque son la misma cosa.
- **Los movimientos son poses, no clips.** Una levantada son seis poses encadenadas y un perfil
  de músculo; la física decide el camino entre una y otra. Por eso se pueden tener quince sin
  capturar nada y por eso chocan con lo que tienen alrededor.
- **Amortiguación crítica** en los músculos, y **ninguna** cayendo. Es la diferencia entre un
  maniquí y un cuerpo, y entre un golpe que se siente y uno que se anula.
- **Inercia en la velocidad, lean por esfuerzo y tambaleo con pasos**, para que arrancar,
  frenar, girar y recibir un tiro se vean.
- **La raíz nunca cruza paredes ni entra en otro cuerpo.** Sin eso los músculos empujaban el
  cuerpo a través de las cosas y las hordas se fundían en un solo bulto.
- **Los huesos también chocan**, no sólo las partículas. De ahí que un cuerpo quede colgado de
  un borde o una pierna empuje una caja.
- **Props que duermen y cadáveres congelados**: el mundo se llena de obstáculos sin costo.
- **Todo procedural**: el repo pesa lo que pesa el código más Three.js.

## Licencia

MIT. Ver `LICENSE`.
