// ─────────────────────────────────────────────────────────────────────────────
//  skeleton.js — Índices de partícula y pose de referencia del humanoide.
//  Vive aparte para que ragdoll.js y moves.js lo compartan sin ciclo.
// ─────────────────────────────────────────────────────────────────────────────

export const HEAD = 0, NECK = 1, CHEST = 2, SHL = 3, SHR = 4, ELL = 5, ELR = 6,
  HAL = 7, HAR = 8, HIP = 9, HPL = 10, HPR = 11, KNL = 12, KNR = 13, FTL = 14, FTR = 15;
export const NP = 16;

// pose de referencia, de pie, en metros. Origen en el piso, entre los pies
export const POSE = new Float32Array([
  0.000, 1.720, 0.000,   // head
  0.000, 1.550, 0.000,   // neck
  0.000, 1.320, 0.000,   // chest
  -0.190, 1.450, 0.000,  // shoulder L
  0.190, 1.450, 0.000,   // shoulder R
  -0.225, 1.145, 0.020,  // elbow L
  0.225, 1.145, 0.020,   // elbow R
  -0.245, 0.865, 0.055,  // hand L
  0.245, 0.865, 0.055,   // hand R
  0.000, 0.960, 0.000,   // hip (raíz)
  -0.110, 0.925, 0.000,  // hip L
  0.110, 0.925, 0.000,   // hip R
  -0.120, 0.520, 0.010,  // knee L
  0.120, 0.520, 0.010,   // knee R
  -0.120, 0.062, 0.055,  // foot L  (apoyado: 13 mm por debajo del radio,
  0.120, 0.062, 0.055,   // foot R   así el pie PRESIONA el piso y agarra)
]);
