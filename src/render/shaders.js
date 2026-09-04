// ─────────────────────────────────────────────────────────────────────────────
//  shaders.js — El pase final: gradación suave, viñeta, grano fino, daño.
//
//  Nada de dither ni cuantización: el estilo es limpio, low poly con luces
//  reales. Lo que hace el pase es cerrar la imagen: sombras apenas azuladas,
//  luces apenas cálidas, bordes que se van a negro, y un grano casi invisible
//  para que los degradados de la linterna no se vean en bandas.
// ─────────────────────────────────────────────────────────────────────────────

export const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse:    { value: null },
    uRes:        { value: [1280, 720] },
    uTime:       { value: 0 },
    uGrain:      { value: 0.028 },
    uVignette:   { value: 0.55 },
    uAberration: { value: 0.0007 },
    uLift:       { value: [0.006, 0.008, 0.016] },
    uGain:       { value: [1.02, 1.00, 0.98] },
    uGamma:      { value: 1.0 },
    uSaturation: { value: 1.04 },
    uContrast:   { value: 1.05 },
    uDamage:     { value: 0.0 },
    uFlash:      { value: 0.0 },
    uTintA:      { value: [0.62, 0.68, 0.86] },  // sombras frías
    uTintB:      { value: [1.00, 0.97, 0.92] },  // luces cálidas
    uFade:       { value: 0.0 },                 // fundido a negro (menú, muerte)
  },

  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2  uRes;
    uniform float uTime, uGrain, uVignette, uAberration;
    uniform float uGamma, uSaturation, uContrast, uDamage, uFlash, uFade;
    uniform vec3  uLift, uGain, uTintA, uTintB;
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;
      vec2 c  = uv - 0.5;
      float r2 = dot(c, c);

      // aberración cromática mínima, sólo en los bordes
      float ab = uAberration * (r2 * 4.0);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ab).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ab).b;

      // lift / gain / gamma
      col = col * uGain + uLift;
      col = pow(max(col, 0.0), vec3(uGamma));

      // tinte dividido, muy sutil
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      vec3 tint = mix(uTintA, uTintB, smoothstep(0.02, 0.65, lum));
      col = mix(col, col * tint * 1.25, 0.30);

      // contraste y saturación
      col = (col - 0.5) * uContrast + 0.5;
      lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(lum), col, uSaturation);

      // daño: los bordes se van a rojo, con pulso
      if (uDamage > 0.001) {
        float edge = smoothstep(0.03, 0.30, r2);
        float pulse = 0.85 + 0.15 * sin(uTime * 9.0);
        vec3 blood = vec3(0.42, 0.015, 0.02);
        col = mix(col, mix(col * 0.35 + blood, blood, 0.35), edge * uDamage * pulse);
      }

      // fogonazo
      col += uFlash * vec3(1.0, 0.94, 0.80);

      // grano fino animado
      float g = hash12(gl_FragCoord.xy + fract(uTime) * 431.0);
      col += (g - 0.5) * uGrain;

      // viñeta
      col *= 1.0 - uVignette * smoothstep(0.12, 0.85, r2);

      // fundido
      col *= 1.0 - uFade;

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};
