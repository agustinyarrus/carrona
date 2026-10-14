<p align="right"><sub><b>English</b> · <a href="PUBLICAR.md">Español</a></sub></p>

# Publishing CARRONA on Google Play — the complete walkthrough

Everything Play asks for is already in this folder; the only thing that can't be done from outside your
account is creating the app in Play Console and answering its forms (or giving a service
account access so that `tools/play.mjs` uploads everything through the API). Estimated time: 40 minutes the first
time, plus Google's review (from hours to 7 days).

## 0. What you need to have

| What | Where it is |
|---|---|
| The signed AAB | `node tools/apk.mjs --aab` → `dist-android/CARRONA-x.y.z.aab` (signing: `mobile/android/keystore.properties`; a copy of the key in `Box\carrona-store-keys\`) |
| A release APK to try on the phone | `node tools/apk.mjs --release --install --run` |
| 512×512 icon | `store/icon-512.png` |
| 1024×500 feature graphic | `store/feature-graphic.png` |
| 1920×1080 phone screenshots (16:9, 24-bit) | `store/screenshots/phone/*.png` (8; Play asks for 2 to 8) |
| ES / EN texts | `store/es-AR/*.txt`, `store/en-US/*.txt` (title ≤ 30, short ≤ 80, full ≤ 4000) |
| Privacy policy (public URL) | `https://github.com/agustinyarrus/carrona/blob/main/store/PRIVACY.md` |
| Release notes | `store/listing.json` → `releaseNotes` |

Regenerating the art: `CARRONA_PORT=8767 node tools/store_shots.mjs && python tools/store_art.py`
(with `python serve.py 8767 --no-open` running; Chrome, and Python with Pillow).

## 1. The developer account

- https://play.google.com/console → a **personal** account (US$ 25, one time only) with identity
  verification (national ID) and phone verification. Approval takes anywhere from hours to days.
- 🚨 **Personal accounts created after Nov 13, 2023**: before you can publish to production
  you have to run a **closed test with at least 12 testers for 14 days in a row** and then
  apply for production access (Google reviews it). Plan for that: the *Closed testing* track is set up
  just like production (step 6) and the testers join through an opt-in link.
- The developer name shown on the listing is public (e.g. «Agustín Yarrus»).

## 2. Create the app

Play Console → **Create app**:

- App name: `CARRONA` · Default language: **Spanish (Latin America) – es-419**
- App or game: **Game** · Free (🚨 a free app can't be turned into a paid one later)
- Declarations: accept the Developer Program Policies and the US export laws

## 3. “Set up your app” (the dashboard with the task list)

Answer them in this order; the values are the right ones for this game as it stands:

| Task | Answer |
|---|---|
| Privacy policy | `https://github.com/agustinyarrus/carrona/blob/main/store/PRIVACY.md` |
| App access | **All functionality is available without any access restrictions** (there's no login) |
| Ads | **No, my app does not contain ads** |
| Content rating | IARC questionnaire, category **Game**. Violence: **yes**; against fantasy/non-human characters (zombies); **blood: yes** (impacts and pools); **dismemberment: yes** (limbs get severed); no sexual violence, no crude language, no drugs, no gambling, no purchases and no interaction between users, no location or personal data. Expected result: **PEGI 18 / ESRB Mature 17+ / 18+ in Latin America**. Answer exactly what the game shows: a misdeclared rating is grounds for suspension |
| Target audience and content | Age group: **18 and over**. Could the app unintentionally appeal to children? **No** (the texts, the icon and the screenshots aren't aimed at kids) |
| News apps | **No** |
| COVID-19 contact tracing and status apps | **No** |
| Data safety | **Does your app collect or share any of the required user data types? → No.** (everything stays in the device's `localStorage`; there's no network, no analytics and no account). Then: **no** independent security review. Save and **submit** |
| Government apps | **No** |
| Financial features | **My app doesn't provide any financial features** |
| Health | **It isn't a health app** |
| Advertising ID | **No** (the manifest doesn't request `com.google.android.gms.permission.AD_ID`: only INTERNET and VIBRATE). 🚨 It doesn't show up in the “Set up your app” list: only “Publishing overview” demands it later, as an *“Incomplete advertising ID declaration”*, and the submit button stays grayed out until you answer it |
| App category and contact details | Category **Action** (Games); tags: Shooter, Zombies, Survival; contact email (public); website: `https://github.com/agustinyarrus/carrona` |
| Play Store listing | step 4 |

## 4. The Play Store listing (Grow → Store presence → Main store listing)

- **Name**: `CARRONA`
- **Short description**: the content of `store/es-AR/descripcion-corta.txt`
- **Full description**: `store/es-AR/descripcion-completa.txt`
- **Icon**: `store/icon-512.png` · **Feature graphic**: `store/feature-graphic.png`
- **Phone screenshots**: the 8 in `store/screenshots/phone/` (in this order: menu, campaign, arsenal,
  office, ragdolls, parking garage, hospital, pause)
- 7" and 10" tablets: optional; the same screenshots work (16:9) if you want the listing to look
  good on tablets.
- **Translations** → Add language → **English (United States)** and paste `store/en-US/*.txt`.
- Save.
- 🚨 The name and the short description can't contain words that sound like store ranking or
  performance («top», «best», «#1», «nuevo»/«new», «gratis»/«free»): «Top-down» triggered the warning *«your app
  might not be promoted»* in both languages. That's why they ended up as «Shooter de zombis…» and
  «Twin-stick…». The warning is only recalculated when you save.
- Screenshots are added in the order they finished uploading; you reorder them by dragging the
  thumbnail (dropping it on the top half of position k leaves it in place k).

## 5. App integrity (Setup → App integrity)

- **Play App Signing**: when you upload the first AAB, choose **«Let Google manage and protect
  your app signing key»** (recommended). Our key (`carrona-upload.jks`) stays as the **upload
  key**; if it gets lost you can request a replacement, but it's a hassle: the copy is in
  `Box\carrona-store-keys\`.
- SHA-256 fingerprint of the upload key: `node tools/apk.mjs --aab` prints it (the «firma», signature, line); the
  current one is `33:6A:72:0A:F6:37:F5:A1:B2:61:DB:24:5C:F4:3D:5B:67:8F:29:5D:53:0A:D5:11:0F:57:0F:6E:19:22:82:CE`
  (alias `carrona`, RSA 4096, valid until 2053).

## 6. Upload the release

Production (or **Testing → Closed testing** if the account is new; it's worth setting up an
**Internal testing** track as well: it skips review and the install link is ready right away):

- 🚨 **Play requires `targetSdk 36` (Android 16)**: with 35 the release preview shows an error saying that
  *the app targets API level 35 … and must target at least API level 36*, and it won't
  let you save. The wrapper is already on 36 (`mobile/android/variables.gradle`); that's why the BACK button
  goes through `OnBackPressedCallback` (with 36, Android 16 doesn't call `onBackPressed`) and the manifest carries
  `PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY` so the landscape lock still holds on tablets.
- 🚨 Every AAB you upload uses up its `versionCode` even if the release is discarded: to upload again
  you have to bump the patch (2.1.0 → 2.1.1). The «there's no deobfuscation file» warning is
  harmless: the wrapper doesn't use R8.

1. **Countries / regions** → Add countries / regions → **All** (or the ones you want).
2. **Testers** (testing only): an email list (`CARRONA testers`) and the feedback email.
3. **Create new release** → upload `dist-android/CARRONA-x.y.z.aab`.
4. Release name: Play suggests it from the AAB (`20101 (2.1.1)`).
5. Release notes: `store/listing.json` → `releaseNotes` (es-419 and en-US), with the tags
   `<es-419>…</es-419>` and `<en-US>…</en-US>`.
6. **Next → Save → Go to publishing overview → Send for review**.
   On internal testing the button is **«Save and publish»**: it goes out without review and the install
   link is under *Testers → Copy link* (`play.google.com/apps/internaltest/…`).
   Play turns on the **Google Play Games on PC** form factor by itself (Advanced settings) and
   sends it in the same submission: the game is played with keyboard and mouse, so it's left on.

For every new version: bump `package.json` (`x.y.z`), `mobile/package.json` and `src/core/version.js`, run
`node tools/apk.mjs --aab` (the `versionCode` follows from the version: 2.1.1 → 20101, 2.1.2 → 20102) and
repeat step 6.

## 7. With the API (optional, so you don't have to click through the listing every time)

1. Play Console → Setup → **API access** → link a Google Cloud project →
   create a **service account** (role *Service Account User*) → download its JSON key →
   save it as `mobile/android/play-service-account.json` (the repo ignores it).
2. Play Console → Users and permissions → invite the service account's email with
   **release manager** and **store listing editing** permissions on CARRONA.
3. The app has to exist in the console already (step 2) and the forms from step 3 have to be answered: the API
   doesn't fill them in.
4. `node tools/play.mjs --listing --images` (texts, icon, graphic and screenshots in es-419, es-AR and en-US)
   `node tools/play.mjs --upload dist-android/CARRONA-2.1.0.aab --track internal` (uploads and publishes to
   internal testing; `--track production --status draft` leaves a draft to review in the console)
   `node tools/play.mjs --dry-run …` shows the plan without touching anything. `--selftest` tests the JWT signature offline.

## 8. After publishing

- Public listing: `https://play.google.com/store/apps/details?id=com.agustinyarrus.carrona`
- Reviews and crash reports (Android vitals) arrive in the console; the game doesn't send
  anything on its own.
- For the GitHub release to include the signed `.apk` you have to load the secrets
  `ANDROID_KEYSTORE_B64` (the `.jks` in base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and
  `ANDROID_KEY_PASSWORD` into the repo (and unblock GitHub Actions billing).

<!-- i18n source=PUBLICAR.md sha256=1eecc243bdc7 -->
