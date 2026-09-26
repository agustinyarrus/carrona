# Publicar CARRONA en Google Play — el paso a paso completo

Todo lo que Play pide ya está en esta carpeta; lo único que no se puede hacer desde afuera de tu
cuenta es crear la app en Play Console y contestar sus formularios (o darle acceso a una cuenta de
servicio para que `tools/play.mjs` suba todo por la API). Tiempo estimado: 40 minutos la primera
vez, más la revisión de Google (de horas a 7 días).

## 0. Lo que hace falta tener

| Qué | Dónde está |
|---|---|
| El AAB firmado | `node tools/apk.mjs --aab` → `dist-android/CARRONA-x.y.z.aab` (firma: `mobile/android/keystore.properties`; copia de la clave en `Box\carrona-store-keys\`) |
| Un APK de release para probar en el teléfono | `node tools/apk.mjs --release --install --run` |
| Ícono 512×512 | `store/icon-512.png` |
| Gráfico destacado 1024×500 | `store/feature-graphic.png` |
| Capturas de teléfono 1920×1080 (16:9, 24 bits) | `store/screenshots/phone/*.png` (8; Play pide de 2 a 8) |
| Textos ES / EN | `store/es-AR/*.txt`, `store/en-US/*.txt` (título ≤ 30, corta ≤ 80, completa ≤ 4000) |
| Política de privacidad (URL pública) | `https://github.com/agustinyarrus/carrona/blob/main/store/PRIVACY.md` |
| Notas de la versión | `store/listing.json` → `releaseNotes` |

Regenerar el arte: `CARRONA_PORT=8767 node tools/store_shots.mjs && python tools/store_art.py`
(con `python serve.py 8767 --no-open` corriendo; Chrome y Python con Pillow).

## 1. La cuenta de desarrollador

- https://play.google.com/console → cuenta **personal** (US$ 25, una sola vez) con verificación de
  identidad (DNI) y de teléfono. Tarda de horas a días en aprobarse.
- 🚨 **Cuentas personales creadas después del 13-nov-2023**: antes de poder publicar en producción
  hay que correr una **prueba cerrada con al menos 12 testers durante 14 días seguidos** y después
  pedir el acceso a producción (Google lo revisa). Planificá eso: la pista *Prueba cerrada* se arma
  igual que producción (paso 6) y los testers entran con un enlace de opt-in.
- El nombre de desarrollador que se muestra en la ficha es público (p. ej. «Agustín Yarrus»).

## 2. Crear la app

Play Console → **Crear app**:

- Nombre de la app: `CARRONA` · Idioma predeterminado: **Español (Latinoamérica) – es-419**
- Tipo: **Juego** · Gratis (🚨 una app gratis no se puede volver paga después)
- Declaraciones: aceptar las políticas del programa y las leyes de exportación de EE. UU.

## 3. «Configurar la app» (el panel con la lista de tareas)

Contestar en este orden; los valores son los que corresponden a este juego tal como está:

| Tarea | Respuesta |
|---|---|
| Política de privacidad | `https://github.com/agustinyarrus/carrona/blob/main/store/PRIVACY.md` |
| Acceso a la app | **Todas las funciones están disponibles sin restricciones** (no hay login) |
| Anuncios | **No, mi app no contiene anuncios** |
| Clasificación de contenido | Cuestionario IARC, categoría **Juego**. Violencia: **sí**; contra personajes fantásticos/no humanos (zombis); **sangre: sí** (impactos y charcos); **desmembramiento: sí** (los miembros se cortan); sin violencia sexual, sin lenguaje soez, sin drogas, sin apuestas, sin compras ni interacción entre usuarios, sin ubicación ni datos personales. Resultado esperado: **PEGI 18 / ESRB Mature 17+ / +18 en Latinoamérica**. Contestá exactamente lo que el juego muestra: una clasificación mal declarada es motivo de suspensión |
| Público objetivo y contenido | Grupo etario: **18 y más**. ¿La app puede atraer involuntariamente a niños? **No** (los textos, el ícono y las capturas no son infantiles) |
| Apps de noticias | **No** |
| Apps de rastreo de contactos / estado de COVID-19 | **No** |
| Seguridad de los datos | **¿Recopila o comparte alguno de los tipos de datos requeridos? → No.** (todo queda en el `localStorage` del aparato; no hay red, ni analítica, ni cuenta). Después: **no** hay revisión de seguridad independiente. Guardar y **enviar** |
| Apps gubernamentales | **No** |
| Funciones financieras | **No ofrece funciones financieras** |
| Salud | **No es una app de salud** |
| Categoría y detalles de contacto | Categoría **Acción** (Juegos); etiquetas: Shooter, Zombis, Supervivencia; email de contacto (público); sitio web: `https://github.com/agustinyarrus/carrona` |
| Ficha de Play Store | paso 4 |

## 4. La ficha de Play Store (Crecimiento → Ficha de Play Store → Ficha principal)

- **Nombre**: `CARRONA`
- **Descripción breve**: el contenido de `store/es-AR/descripcion-corta.txt`
- **Descripción completa**: `store/es-AR/descripcion-completa.txt`
- **Ícono**: `store/icon-512.png` · **Gráfico destacado**: `store/feature-graphic.png`
- **Capturas de teléfono**: las 8 de `store/screenshots/phone/` (en orden: menú, campaña, arsenal,
  oficina, ragdolls, estacionamiento, hospital, pausa)
- Tablet de 7" y 10": opcionales; las mismas capturas sirven (16:9) si querés que la ficha se vea
  bien en tablets.
- **Traducciones** → Agregar idioma → **Inglés (Estados Unidos)** y pegar `store/en-US/*.txt`.
- Guardar.
- 🚨 En el nombre y la descripción breve no puede haber palabras que suenen a ranking o rendimiento
  de la tienda («top», «best», «#1», «nuevo», «gratis»): «Top-down» disparó la advertencia *«es
  posible que tu app no se promocione»* en los dos idiomas. Por eso quedaron «Shooter de zombis…» y
  «Twin-stick…». La advertencia se recalcula recién al guardar.
- Las capturas se agregan en el orden en que terminaron de subir; se reordenan arrastrando la
  miniatura (soltarla sobre la mitad de arriba de la posición k la deja en el lugar k).

## 5. Integridad de la app (Configuración → Integridad de la app)

- **Firma de apps de Play**: al subir el primer AAB, elegí **«Dejar que Google administre y proteja
  la clave de firma»** (recomendado). Nuestra clave (`carrona-upload.jks`) queda como **clave de
  subida**; si se pierde se pide un reemplazo, pero es un trámite: la copia está en
  `Box\carrona-store-keys\`.
- Huella SHA-256 de la clave de subida: la imprime `node tools/apk.mjs --aab` (línea «firma»); la
  actual es `33:6A:72:0A:F6:37:F5:A1:B2:61:DB:24:5C:F4:3D:5B:67:8F:29:5D:53:0A:D5:11:0F:57:0F:6E:19:22:82:CE`
  (alias `carrona`, RSA 4096, válida hasta 2053).

## 6. Subir la versión

Producción (o **Pruebas → Prueba cerrada** si la cuenta es nueva; conviene armar también una
**Prueba interna**: no pasa por revisión y el enlace de instalación sale al momento):

- 🚨 **Play exige `targetSdk 36` (Android 16)**: con 35 la vista previa de la versión muestra el error
  *«la app se orienta al nivel de API 35 … debe estar orientada, por lo menos, al nivel de API 36»* y no
  deja guardar. El envoltorio ya está en 36 (`mobile/android/variables.gradle`); por eso el botón ATRÁS
  va por `OnBackPressedCallback` (con 36, Android 16 no llama a `onBackPressed`) y el manifest lleva
  `PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY` para que el bloqueo apaisado siga valiendo en tablets.
- 🚨 Cada AAB que se sube consume su `versionCode` aunque la versión se descarte: para volver a subir
  hay que subir el parche (2.1.0 → 2.1.1). La advertencia «no hay archivo de desofuscación» es
  inofensiva: el envoltorio no usa R8.

1. **Países/regiones** → Agregar países → **Todos** (o los que quieras).
2. **Verificadores** (sólo pruebas): una lista de correos (`CARRONA testers`) y el correo para comentarios.
3. **Crear nueva versión** → subir `dist-android/CARRONA-x.y.z.aab`.
4. Nombre de la versión: la sugiere Play a partir del AAB (`20101 (2.1.1)`).
5. Notas de la versión: `store/listing.json` → `releaseNotes` (es-419 y en-US), con las etiquetas
   `<es-419>…</es-419>` y `<en-US>…</en-US>`.
6. **Siguiente → Guardar → Ir a la descripción general de la publicación → Enviar para revisión**.

Cada versión nueva: subir `package.json` (`x.y.z`), `mobile/package.json`, `src/core/version.js`,
`node tools/apk.mjs --aab` (el `versionCode` sale solo de la versión: 2.1.1 → 20101, 2.1.2 → 20102) y
repetir el paso 6.

## 7. Con la API (opcional, para no clickear la ficha cada vez)

1. Play Console → Configuración → **Acceso a la API** → vincular un proyecto de Google Cloud →
   crear una **cuenta de servicio** (rol *Service Account User*) → descargar su clave JSON →
   guardarla como `mobile/android/play-service-account.json` (el repo la ignora).
2. Play Console → Usuarios y permisos → invitar el email de la cuenta de servicio con permisos de
   **administrador de versiones** y **edición de la ficha** sobre CARRONA.
3. La app tiene que existir ya en la consola (paso 2) y los formularios del paso 3 contestados: la API
   no los llena.
4. `node tools/play.mjs --listing --images` (textos, ícono, gráfico y capturas en es-419, es-AR y en-US)
   `node tools/play.mjs --upload dist-android/CARRONA-2.1.0.aab --track internal` (sube y publica en
   pruebas internas; `--track production --status draft` deja un borrador para revisar en la consola)
   `node tools/play.mjs --dry-run …` muestra el plan sin tocar nada. `--selftest` prueba la firma del JWT sin red.

## 8. Después de publicar

- Ficha pública: `https://play.google.com/store/apps/details?id=com.agustinyarrus.carrona`
- Las reseñas y los informes de fallos (Android vitals) llegan a la consola; el juego no manda
  nada por su cuenta.
- Para que el release de GitHub incluya el `.apk` firmado hay que cargar los secrets
  `ANDROID_KEYSTORE_B64` (el `.jks` en base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` y
  `ANDROID_KEY_PASSWORD` en el repo (y destrabar la facturación de GitHub Actions).
