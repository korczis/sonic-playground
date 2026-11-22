// The visualiser's WebGL modes (data/visualizer.json, engine "gl"), on three.js. static/js/
// visualizer.js loads this file, after three.js, only when one of these modes is shown, and calls
// SonicVizGL.mount(el) once per picture; the handle draws one frame per call of frame(a, s), where
// `a` is the frame's analysis of the sound (SonicVizAnalysis) and `s` the mode's scratch with its
// live parameters.
//
// three.js is vendored as a custom build of exactly the names this file uses (scripts/vendor.mjs
// reads every `THREE.<Name>` here), so three is referenced only as THREE.<Name>.
//
// Four kinds of picture share one set of uniforms (the sound, already scaled by the mode's
// "react" control, and the parameters) and one GLSL prelude (palettes rotated by the hue control,
// noise, a filmic tone curve with vignette and grain):
//   feedback  MilkDrop's idea: every frame reads the last one through a warp (zoom, rotation, a
//             flow field), lets it fade by the trails control, draws new light on top, and a
//             composite pass tones it for the screen. liquid, patchbay, prism, ember, whirlpool,
//             silk.
//   shader    one fragment shader per pixel: hyperloop, garden, cathedral, mercury, fold.
//   sim       a Gray-Scott reaction-diffusion simulated on a small grid, seeded by kicks: reef.
//   scene     real geometry: tidal (a terrain of the spectrum's history), chrome (a displaced
//             sphere), choir (a morphing point cloud).
// Resolution adapts: the render scale steps down when frames run long and back up after a few
// calm seconds, so a phone and SwiftShader keep moving. Every render target and material is
// disposed when the mode or the picture goes.
(function () {
  'use strict';
  var THREE = window.THREE;
  var IDS = ['liquid', 'patchbay', 'prism', 'ember', 'tidal', 'hyperloop', 'chrome', 'whirlpool',
    'choir', 'garden', 'silk', 'cathedral', 'reef', 'mercury', 'fold'];
  var HEAVY = { fold: 1, mercury: 1, cathedral: 1, garden: 1, hyperloop: 1 };
  var SCALES = [1, 0.85, 0.7, 0.58, 0.47, 0.38, 0.3, 0.25];

  // ---- GLSL. -------------------------------------------------------------------------------------

  var QUAD_VS = [
    'varying vec2 vUv;',
    'void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  ].join('\n');

  var PRELUDE = [
    'precision highp float;',
    'uniform float uTime, uTravel, uBass, uMid, uHigh, uLevel, uKick, uSnare, uHat, uFlux;',
    'uniform float uCentroid, uPhase, uEnergy, uHue, uWarp, uTrails, uGlow, uZoom, uSymmetry;',
    'uniform float uDetail, uDensity;',
    'uniform vec2 uRes;',
    'uniform sampler2D uSpec;',
    'varying vec2 vUv;',
    '#define PI 3.14159265',
    '#define TAU 6.2831853',
    'float spec(float x) { return texture2D(uSpec, vec2(clamp(x, 0.0, 1.0), 0.25)).r; }',
    'float wave(float x) { return texture2D(uSpec, vec2(clamp(x, 0.0, 1.0), 0.75)).r * 2.0 - 1.0; }',
    'vec3 pal(float t, vec3 d) { return 0.5 + 0.5 * cos(TAU * (t + d + uHue / 360.0)); }',
    'vec3 pal(float t) { return pal(t, vec3(0.0, 0.33, 0.67)); }',
    'vec3 hueRot(vec3 c, float deg) {',
    '  float a = deg * PI / 180.0; vec3 k = vec3(0.57735); float ca = cos(a);',
    '  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);',
    '}',
    'float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    'float noise(vec2 p) {',
    '  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),',
    '    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);',
    '}',
    'float fbm(vec2 p) {',
    '  float v = 0.0, a = 0.5;',
    '  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 1.7; a *= 0.5; }',
    '  return v;',
    '}',
    'vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }',
    'vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }',
    // The short side spans -0.5..0.5 whatever the screen: a phone in portrait sees the same picture.
    'vec2 centred(vec2 uv) { return (uv - 0.5) * uRes / min(uRes.x, uRes.y); }',
    'vec2 uncentred(vec2 p) { return p * min(uRes.x, uRes.y) / uRes + 0.5; }',
    'vec3 finish(vec3 c, vec2 uv) {',
    '  c = aces(c);',
    '  vec2 q = uv - 0.5; c *= 1.0 - dot(q, q) * 0.85;',
    '  c += (hash(uv * uRes + fract(uTime * 7.0) * 91.0) - 0.5) * 0.02;',
    '  return pow(max(c, 0.0), vec3(0.4545));',
    '}',
    'vec3 blur4(sampler2D t, vec2 uv, float r) {',
    '  vec2 px = r / uRes;',
    '  return (texture2D(t, uv + vec2(px.x, 0.0)).rgb + texture2D(t, uv - vec2(px.x, 0.0)).rgb',
    '    + texture2D(t, uv + vec2(0.0, px.y)).rgb + texture2D(t, uv - vec2(0.0, px.y)).rgb) * 0.25;',
    '}',
    '',
  ].join('\n');

  // The composite of a feedback mode: the buffer, a soft glow of itself, toned for the screen.
  var COMPOSITE = [
    'uniform sampler2D uTex;',
    'void main() {',
    '  vec3 c = texture2D(uTex, vUv).rgb;',
    '  vec3 g = vec3(0.0);',
    '  for (int i = 0; i < 6; i++) { float a = float(i) * TAU / 6.0; g += texture2D(uTex, vUv + vec2(cos(a), sin(a)) * 6.0 / uRes).rgb; }',
    '  c += g / 6.0 * 0.45;',
    '  gl_FragColor = vec4(finish(c * 1.1, vUv), 1.0);',
    '}',
  ];

  // ---- Feedback modes: the warp pass of each (reads uPrev, writes the next frame). -------------

  var WARP = {
    // MilkDrop 1: zoom, turn and ripple the last frame; a ring of the waveform burns into it.
    liquid: [
      'void main() {',
      '  vec2 p = centred(vUv); float r = length(p); float ang = atan(p.y, p.x);',
      '  vec2 q = rot(p, 0.004 + uMid * 0.02) * (0.988 - uBass * 0.025 - uKick * 0.02);',
      '  q += uWarp * 0.01 * vec2(sin(q.y * 7.0 + uTime * 0.9), cos(q.x * 6.0 - uTime * 0.7)) * (0.5 + uLevel);',
      '  float decay = mix(0.8, 0.985, uTrails);',
      '  vec3 col = texture2D(uPrev, uncentred(q)).rgb * decay;',
      '  float R = 0.2 + 0.07 * uBass + wave(abs(ang) / PI) * (0.04 + 0.09 * uLevel);',
      '  float line = smoothstep(0.012, 0.0, abs(r - R));',
      '  col += pal(uTime * 0.05 + uCentroid + abs(ang) / PI * 0.5) * line * (0.35 + uKick * 0.8);',
      '  col += pal(uTime * 0.05 + 0.5) * uKick * 0.05 * smoothstep(0.55, 0.0, r);',
      '  gl_FragColor = vec4(min(col, vec3(4.0)), 1.0);',
      '}',
    ],
    // AVS: a "dynamic movement" (radial pull, breathing twist) and a blur under a superscope of
    // the waveform folded into mirrored sectors.
    patchbay: [
      'void main() {',
      '  vec2 p = centred(vUv); float r = length(p); float a = atan(p.y, p.x);',
      '  float r2 = r * (0.985 - 0.02 * uBass) + 0.002 * sin(r * 18.0 - uTime * 2.0);',
      '  float a2 = a + 0.01 * sin(uTime * 0.3) + 0.02 * uMid * sin(r * 6.0);',
      '  vec2 q = vec2(cos(a2), sin(a2)) * r2;',
      '  vec2 at = uncentred(q);',
      '  vec3 col = mix(texture2D(uPrev, at).rgb, blur4(uPrev, at, 1.5), 0.5) * mix(0.82, 0.975, uTrails);',
      '  float n = floor(uSymmetry); float sector = TAU / n;',
      '  float fa = abs(mod(a + uTime * 0.2, sector) - sector * 0.5);',
      '  vec2 f = vec2(cos(fa), sin(fa)) * r;',
      '  float y = abs(wave(clamp(f.x / 0.7, 0.0, 1.0)) * (0.05 + 0.1 * uLevel)) + 0.04 * uKick;',
      '  float line = smoothstep(0.007, 0.0, abs(f.y - y)) * step(f.x, 0.7) * step(0.03, f.x);',
      '  col += pal(uTime * 0.07 + r + uCentroid) * line * (0.3 + 0.7 * uKick);',
      '  gl_FragColor = vec4(min(col, vec3(4.0)), 1.0);',
      '}',
    ],
    // MilkDrop 2: a swirling history whose hue drifts, orbs on Lissajous paths sized by their
    // bands, a horizon of the waveform; the composite adds prism fringes and a kaleidoscope.
    prism: [
      'void main() {',
      '  vec2 p = centred(vUv); float r = length(p);',
      '  vec2 q = rot(p, 0.01 * sin(uTime * 0.21) + 0.015 * uMid) * (0.99 - 0.02 * uBass);',
      '  q += 0.006 * uWarp * vec2(sin(r * 14.0 - uTime * 1.3), cos(r * 11.0 + uTime));',
      '  vec3 col = texture2D(uPrev, uncentred(q)).rgb * 0.94;',
      '  col = col.gbr * 0.05 + col * 0.95;',
      '  for (int i = 0; i < 6; i++) {',
      '    float fi = float(i);',
      '    vec2 c = 0.32 * vec2(sin(uTime * (0.5 + fi * 0.13) + fi * 2.0), cos(uTime * (0.4 + fi * 0.17) + fi));',
      '    float s = spec(fi / 6.0 + 0.05);',
      '    col += pal(fi / 6.0 + uTime * 0.04) * smoothstep(0.02 + s * 0.05, 0.0, length(p - c)) * (0.15 + s * 0.6);',
      '  }',
      '  col += pal(uCentroid + 0.5) * smoothstep(0.006, 0.0, abs(p.y - wave(vUv.x) * 0.12)) * 0.25 * (0.3 + uLevel);',
      '  gl_FragColor = vec4(min(col, vec3(4.0)), 1.0);',
      '}',
    ],
    // Geiss: warm smoke that rises and curls; sparks fly on the kick and the hats; the waveform
    // smoulders low.
    ember: [
      'vec3 fire(float x) { return hueRot(vec3(1.6 * x, 1.1 * x * x, 0.6 * x * x * x), uHue); }',
      'void main() {',
      '  vec2 p = centred(vUv);',
      '  vec2 flow = vec2(fbm(p * 3.0 + uTime * 0.2) - 0.5, fbm(p * 3.0 - uTime * 0.17 + 7.0) - 0.5);',
      '  vec2 q = (p - vec2(0.0, 0.003 + 0.006 * uLevel) - flow * 0.01 * (1.0 + uMid * 2.0)) * 0.998;',
      '  vec2 at = uncentred(q);',
      '  vec3 col = mix(texture2D(uPrev, at).rgb, blur4(uPrev, at, 1.0), 0.6) * mix(0.86, 0.985, uTrails);',
      '  float band = spec(vUv.x);',
      '  float h = hash(floor(vUv * uRes / 3.0) + floor(uTime * 30.0));',
      '  float rate = 0.0006 + uKick * 0.012 + uHat * 0.004;',
      '  col += fire(0.6 + band * 0.4) * step(1.0 - rate * (0.3 + band * 2.0), h) * 2.0 * step(p.y, 0.05);',
      '  float wv = wave(vUv.x) * (0.06 + 0.1 * uLevel) - 0.28;',
      '  col += fire(0.5 + uCentroid * 0.5) * smoothstep(0.012, 0.0, abs(p.y - wv)) * (0.1 + uKick * 0.3);',
      '  gl_FragColor = vec4(min(col, vec3(4.0)), 1.0);',
      '}',
    ],
    // Goom: a vortex that turns faster near its eye, three tentacles of sine in turning frames.
    whirlpool: [
      'void main() {',
      '  vec2 p = centred(vUv); float r = length(p);',
      '  float swirl = (0.012 + uMid * 0.04 + uKick * 0.03) / (r + 0.25);',
      '  vec2 q = rot(p, swirl) * (0.986 - uBass * 0.02);',
      '  q += uWarp * 0.004 * vec2(sin(p.y * 10.0 + uTime), sin(p.x * 10.0 - uTime));',
      '  vec3 col = texture2D(uPrev, uncentred(q)).rgb * mix(0.85, 0.98, uTrails);',
      '  for (int i = 0; i < 3; i++) {',
      '    float fi = float(i);',
      '    vec2 t = rot(p, uTime * (0.2 + fi * 0.07) + fi * 2.094);',
      '    float y = sin(t.x * (5.0 + fi * 2.0) + uTime * (1.5 + fi)) * (0.05 + spec(0.1 + fi * 0.3) * 0.15);',
      '    float line = smoothstep(0.01, 0.0, abs(t.y - y)) * smoothstep(0.75, 0.2, abs(t.x));',
      '    col += pal(fi * 0.33 + uTime * 0.05) * line * (0.12 + uLevel * 0.35);',
      '  }',
      '  gl_FragColor = vec4(min(col, vec3(4.0)), 1.0);',
      '}',
    ],
    // Krash: colour carried along a curl-noise flow, two silk strands of the waveform.
    silk: [
      'vec2 curl(vec2 p) {',
      '  float e = 0.02;',
      '  float a = fbm(p + vec2(0.0, e)), b = fbm(p - vec2(0.0, e));',
      '  float c = fbm(p + vec2(e, 0.0)), d = fbm(p - vec2(e, 0.0));',
      '  return vec2(a - b, -(c - d)) / (2.0 * e);',
      '}',
      'void main() {',
      '  vec2 p = centred(vUv);',
      '  vec2 v = curl(p * 1.6 + uTime * 0.05) * (0.0015 + 0.003 * uWarp * (0.5 + uLevel));',
      '  vec3 col = texture2D(uPrev, uncentred(p - v)).rgb * mix(0.9, 0.992, uTrails);',
      '  for (int i = 0; i < 2; i++) {',
      '    float fi = float(i);',
      '    vec2 t = rot(p, uTime * 0.07 + fi * 1.57);',
      '    float y = wave(t.x * 0.7 + 0.5) * (0.08 + 0.12 * uLevel);',
      '    float line = smoothstep(0.02, 0.0, abs(t.y - y)) * smoothstep(0.7, 0.3, abs(t.x));',
      '    col += mix(pal(fi * 0.5 + uTime * 0.02), vec3(1.0), 0.35) * line * (0.03 + uKick * 0.07 + uSnare * 0.04);',
      '  }',
      '  gl_FragColor = vec4(min(col, vec3(3.0)), 1.0);',
      '}',
    ],
  };

  // MilkDrop 2's composite: prism fringes that widen on the kick and a kaleidoscope that folds in
  // with the flux, over the buffer's own glow.
  var PRISM_COMPOSITE = [
    'uniform sampler2D uTex;',
    'vec2 kal(vec2 uv, float n) {',
    '  vec2 p = uv - 0.5; float r = length(p), a = atan(p.y, p.x); float s = TAU / n;',
    '  a = abs(mod(a, s) - s * 0.5); return vec2(cos(a), sin(a)) * r + 0.5;',
    '}',
    'void main() {',
    '  float k = smoothstep(0.25, 0.9, uKick * 0.6 + uFlux * 0.6);',
    '  vec2 uv = mix(vUv, kal(vUv, 6.0), k);',
    '  vec2 off = (uv - 0.5) * (0.004 + 0.012 * uGlow * (0.4 + uKick));',
    '  vec3 c = vec3(texture2D(uTex, uv + off).r, texture2D(uTex, uv).g, texture2D(uTex, uv - off).b);',
    '  vec3 g = vec3(0.0);',
    '  for (int i = 0; i < 8; i++) { float a = float(i) * TAU / 8.0; g += texture2D(uTex, uv + vec2(cos(a), sin(a)) * 0.012).rgb; }',
    '  c += g / 8.0 * 0.6 * uGlow;',
    '  gl_FragColor = vec4(finish(c, vUv), 1.0);',
    '}',
  ];

  // ---- Shader modes. -----------------------------------------------------------------------------

  var SHADER = {
    // Tripex: a neon tunnel flown through, its rings lit by the bands, sparks streaking past.
    hyperloop: [
      'void main() {',
      '  vec2 p = centred(vUv) * (1.0 - 0.12 * uKick);',
      '  float r = length(p) + 1e-4; float a = atan(p.y, p.x);',
      '  float depth = 0.32 / r;',
      '  float z = depth + uTravel * 1.4;',
      '  float ringId = floor(z * 2.0); float ring = fract(z * 2.0);',
      '  float lit = spec(fract(ringId * 0.137));',
      '  float edge = smoothstep(0.41, 0.5, abs(ring - 0.5));',
      '  float tw = a / TAU * 12.0 + ringId * 0.25 + uWarp * sin(z * 0.5) * 0.4;',
      '  float seg = smoothstep(0.45, 0.5, abs(fract(tw) - 0.5));',
      '  vec3 col = pal(ringId * 0.07 + uTime * 0.02) * (edge * (0.25 + lit * 1.6) + seg * 0.25 * (0.3 + uHat));',
      '  col *= smoothstep(0.0, 0.3, r);',
      '  col += pal(0.6) * 0.6 * smoothstep(0.12, 0.0, r) * (0.25 + uBass);',
      '  vec2 g = vec2(a / TAU * 48.0, z * 5.0);',
      '  float star = step(0.986 - 0.012 * uHat, hash(floor(g))) * smoothstep(0.45, 0.0, length(fract(g) - 0.5));',
      '  col += vec3(star) * 0.9 * smoothstep(0.08, 0.4, r);',
      '  col /= 1.0 + depth * 0.12;',
      '  gl_FragColor = vec4(finish(col, vUv), 1.0);',
      '}',
    ],
    // Jheriko: a garden of polar roses, one per layer, each petal count its own, swelling with
    // its band, in a gently warped plane.
    garden: [
      'void main() {',
      '  vec2 p = centred(vUv) * 1.15;',
      '  p += 0.03 * vec2(sin(p.y * 7.0 + uTime), cos(p.x * 7.0 - uTime * 0.8)) * (0.5 + uMid);',
      '  float r = length(p), a = atan(p.y, p.x);',
      '  vec3 col = vec3(0.0);',
      '  int layers = int(3.0 + uDetail * 3.0);',
      '  for (int i = 0; i < 9; i++) {',
      '    if (i >= layers) break;',
      '    float fi = float(i);',
      '    float s = spec(fi / 9.0);',
      '    float dir = mod(fi, 2.0) * 2.0 - 1.0;',
      '    float R = 0.1 + fi * 0.055 + 0.035 * cos((3.0 + fi) * a + uTime * (0.3 + fi * 0.05) * dir) * (1.0 + s * 2.0) + uKick * 0.02;',
      '    col += pal(fi * 0.11 + uTime * 0.03 + s * 0.2) * (0.0018 + s * 0.004) / (abs(r - R) + 0.004);',
      '  }',
      '  col *= 0.4;',
      '  col += pal(0.7) * 0.15 * uBass * smoothstep(0.3, 0.0, r);',
      '  gl_FragColor = vec4(finish(col, vUv), 1.0);',
      '}',
    ],
    // Rovastar: a kaleidoscopic fractal of stained-glass panes: each pane coloured by the fold
    // that came closest, glowing with its band, set in dark leading that glints on the kick.
    cathedral: [
      'void main() {',
      '  vec2 p = centred(vUv) * 1.5 / uZoom * (1.0 - 0.08 * uKick);',
      '  float n = floor(uSymmetry);',
      '  float r = length(p), a = atan(p.y, p.x); float s = TAU / n;',
      '  a = abs(mod(a + uTime * 0.05, s) - s * 0.5);',
      '  p = vec2(cos(a), sin(a)) * r;',
      '  float trap = 10.0, lead = 10.0, id = 0.0, scale = 1.0;',
      '  for (int i = 0; i < 7; i++) {',
      '    float fi = float(i);',
      '    p = abs(p) - vec2(0.42 + 0.05 * sin(uTime * 0.2), 0.24 + 0.06 * uBass);',
      '    p = rot(p, 0.55 + 0.08 * sin(uTime * 0.13 + fi) + uMid * 0.1);',
      '    p *= 1.25; scale *= 1.25;',
      '    float d = length(p) / scale;',
      '    if (d < trap) { trap = d; id = fi; }',
      '    lead = min(lead, abs(p.y) / scale);',
      '  }',
      '  float b = spec(id / 7.0);',
      '  vec3 glass = pal(id * 0.13 + trap * 2.0 + uTime * 0.02) * (0.18 + b * 0.9) * exp(-trap * 6.0);',
      '  float line = smoothstep(0.006, 0.0, lead);',
      '  vec3 col = glass * (1.0 - line * 0.85) + vec3(1.0, 0.9, 0.7) * line * uKick * 0.25;',
      '  col += pal(0.6) * 0.12 * uBass * smoothstep(0.35, 0.0, r);',
      '  gl_FragColor = vec4(finish(col * 1.05, vUv), 1.0);',
      '}',
    ],
    // Flexi: liquid metal, eight blobs whose size follows their bands, mirroring a coloured sky.
    mercury: [
      'float field(vec2 p) {',
      '  float f = 0.0;',
      '  for (int i = 0; i < 8; i++) {',
      '    float fi = float(i);',
      '    vec2 c = vec2(sin(uTime * (0.31 + fi * 0.07) + fi * 1.7), cos(uTime * (0.27 + fi * 0.05) + fi * 2.3)) * (0.26 + 0.06 * sin(fi));',
      '    float r = 0.06 + spec(fi / 8.0 + 0.03) * 0.08 * uDetail + uKick * 0.015;',
      '    vec2 d = p - c; f += r * r / (dot(d, d) + 1e-4);',
      '  }',
      '  return f;',
      '}',
      'void main() {',
      '  vec2 p = centred(vUv);',
      '  float e = 2.0 / min(uRes.x, uRes.y);',
      '  float f = field(p);',
      '  float h = 1.0 - 1.0 / max(f, 1e-3);',
      '  float hx = 1.0 - 1.0 / max(field(p + vec2(e, 0.0)), 1e-3);',
      '  float hy = 1.0 - 1.0 / max(field(p + vec2(0.0, e)), 1e-3);',
      '  vec3 n = normalize(vec3(-(hx - h) / e * 0.03, -(hy - h) / e * 0.03, 1.0));',
      '  float inside = smoothstep(0.98, 1.06, f);',
      '  vec3 R = reflect(vec3(0.0, 0.0, -1.0), n);',
      '  vec3 env = pal(R.y * 0.4 + R.x * 0.2 + uTime * 0.02) * (0.5 + 0.5 * R.y);',
      '  float fres = pow(1.0 - n.z, 2.0);',
      '  vec3 L = normalize(vec3(-0.5, 0.7, 0.6));',
      '  float sp = pow(max(dot(R, L), 0.0), 60.0);',
      '  vec3 metal = mix(vec3(0.05), env * 1.2, 0.35 + fres * 0.8) + vec3(sp) * (1.0 + uKick * 2.0);',
      '  vec3 glow = pal(0.6 + uCentroid * 0.4) * min(f, 1.0) * 0.18 * uGlow;',
      '  vec3 col = mix(glow, metal, inside);',
      '  gl_FragColor = vec4(finish(col, vUv), 1.0);',
      '}',
    ],
    // Martin: a flight down the corridor of a folded Menger lattice, turning with the bass.
    fold: [
      'float de(vec3 p) {',
      '  p = mod(p + 1.5, 3.0) - 1.5;',
      '  float s = 1.0;',
      '  int it = int(2.0 + uDetail * 2.0);',
      '  for (int i = 0; i < 6; i++) {',
      '    if (i >= it) break;',
      '    p = abs(p);',
      '    if (p.x < p.y) p.xy = p.yx;',
      '    if (p.x < p.z) p.xz = p.zx;',
      '    if (p.y < p.z) p.yz = p.zy;',
      '    p.xy = rot(p.xy, 0.1 + 0.15 * uBass);',
      '    p = p * 3.0 - 2.0;',
      '    if (p.z < -1.0) p.z += 2.0;',
      '    s *= 3.0;',
      '  }',
      '  return length(max(abs(p) - 1.0, 0.0)) / s;',
      '}',
      'void main() {',
      '  vec2 sp = centred(vUv);',
      '  vec3 ro = vec3(0.12 * sin(uTime * 0.11), 0.1 * cos(uTime * 0.13), uTravel * 0.5);',
      '  vec3 rd = normalize(vec3(rot(sp, uTime * 0.04), 1.2));',
      '  float t = 0.02; float steps = 0.0;',
      '  int maxSteps = int(36.0 + uDetail * 28.0);',
      '  for (int i = 0; i < 92; i++) {',
      '    if (i >= maxSteps) break;',
      '    float d = de(ro + rd * t);',
      '    if (d < 0.0008 * t || t > 12.0) break;',
      '    t += d * 0.9; steps += 1.0;',
      '  }',
      '  vec3 pos = ro + rd * t;',
      '  vec2 k = vec2(0.002, -0.002);',
      '  vec3 n = normalize(k.xyy * de(pos + k.xyy) + k.yyx * de(pos + k.yyx) + k.yxy * de(pos + k.yxy) + k.xxx * de(pos + k.xxx));',
      '  float ao = 1.0 - steps / float(maxSteps);',
      '  float dif = clamp(dot(n, normalize(vec3(0.3, 0.6, -0.7))), 0.0, 1.0);',
      '  vec3 base = mix(vec3(0.5), pal(pos.z * 0.03 + t * 0.05 + uCentroid * 0.3), 0.7);',
      '  vec3 col = base * (0.15 + dif * 0.9) * ao * ao;',
      '  col += pal(0.55) * (1.0 - ao) * 0.25 * (0.4 + uHigh);',
      '  vec3 fogc = pal(uTime * 0.02 + 0.3) * (0.04 + uKick * 0.25 + uBass * 0.08);',
      '  col = mix(fogc, col, exp(-t * 0.28));',
      '  gl_FragColor = vec4(finish(col * 0.95, vUv), 1.0);',
      '}',
    ],
  };

  // ---- The reaction-diffusion (reef). -----------------------------------------------------------

  var REEF_INIT = [
    'uniform vec2 uSim;',
    'void main() {',
    '  float b = step(0.992, hash(floor(vUv * uSim / 4.0))) * 0.9;',
    '  gl_FragColor = vec4(1.0, b, 0.0, 1.0);',
    '}',
  ];
  var REEF_STEP = [
    'uniform sampler2D uState; uniform vec2 uSim; uniform vec4 uSeed; uniform float uFeed, uKill;',
    'void main() {',
    '  vec2 px = 1.0 / uSim; vec2 uv = vUv;',
    '  vec2 s = texture2D(uState, uv).rg;',
    '  vec2 lap = -s;',
    '  lap += 0.2 * (texture2D(uState, uv + vec2(px.x, 0.0)).rg + texture2D(uState, uv - vec2(px.x, 0.0)).rg',
    '    + texture2D(uState, uv + vec2(0.0, px.y)).rg + texture2D(uState, uv - vec2(0.0, px.y)).rg);',
    '  lap += 0.05 * (texture2D(uState, uv + px).rg + texture2D(uState, uv - px).rg',
    '    + texture2D(uState, uv + vec2(px.x, -px.y)).rg + texture2D(uState, uv - vec2(px.x, -px.y)).rg);',
    '  float A = s.x, B = s.y; float r = A * B * B;',
    '  A += lap.x - r + uFeed * (1.0 - A);',
    '  B += 0.5 * lap.y + r - (uKill + uFeed) * B;',
    '  vec2 d = (uv - uSeed.xy) * uSim / min(uSim.x, uSim.y);',
    '  if (length(d) < uSeed.z) B = 0.9;',
    '  gl_FragColor = vec4(clamp(A, 0.0, 1.0), clamp(B, 0.0, 1.0), 0.0, 1.0);',
    '}',
  ];
  var REEF_SHOW = [
    'uniform sampler2D uState; uniform vec2 uSim;',
    'void main() {',
    '  vec2 px = 1.0 / uSim;',
    '  float b = texture2D(uState, vUv).g;',
    '  float bx = texture2D(uState, vUv + vec2(px.x, 0.0)).g - texture2D(uState, vUv - vec2(px.x, 0.0)).g;',
    '  float by = texture2D(uState, vUv + vec2(0.0, px.y)).g - texture2D(uState, vUv - vec2(0.0, px.y)).g;',
    '  vec3 n = normalize(vec3(-bx * 3.0, -by * 3.0, 1.0));',
    '  float light = clamp(dot(n, normalize(vec3(-0.4, 0.6, 0.7))), 0.0, 1.0);',
    '  float v = smoothstep(0.08, 0.4, b);',
    '  vec3 col = mix(vec3(0.01, 0.015, 0.04), pal(b * 1.4 + uTime * 0.02 + uCentroid * 0.3), v) * (0.35 + 0.9 * light);',
    '  col += pow(light, 24.0) * v * 0.5;',
    '  col *= 1.0 + uKick * 0.3;',
    '  gl_FragColor = vec4(finish(col, vUv), 1.0);',
    '}',
  ];

  // ---- Scenes. -----------------------------------------------------------------------------------

  // A dark sky behind the 3D scenes, drawn first at the far plane.
  var SKY_VS = [
    'varying vec2 vUv;',
    'void main() { vUv = uv; gl_Position = vec4(position.xy, 0.9999, 1.0); }',
  ].join('\n');
  var SKY = [
    'void main() {',
    '  float r = length(centred(vUv));',
    '  vec3 c = mix(pal(uTime * 0.02 + 0.6) * 0.035, vec3(0.002, 0.002, 0.008), smoothstep(0.0, 0.8, r));',
    '  c += pal(0.6) * uKick * 0.03;',
    '  gl_FragColor = vec4(pow(c, vec3(0.4545)), 1.0);',
    '}',
  ];

  // WhiteCap: the spectrum's last seconds as ridges of light running away to the horizon.
  var TIDAL_VS = [
    'attribute vec2 grid;',
    'uniform sampler2D uHist; uniform float uHead, uTime, uKick;',
    'varying float vH; varying float vDepth; varying float vBand; varying vec2 vUv;',
    'void main() {',
    '  float band = grid.x / 47.0; float row = grid.y / 63.0;',
    '  float tv = fract(uHead - grid.y / 64.0 + 0.5 / 64.0);',
    '  float h = texture2D(uHist, vec2(band * (47.0 / 48.0) + 0.5 / 48.0, tv)).r;',
    '  float x = (band - 0.5) * 2.4;',
    '  float y = h * (0.42 + uKick * 0.12) + 0.025 * sin(x * 3.0 + uTime + row * 6.0);',
    '  vH = h; vDepth = row; vBand = band; vUv = vec2(0.0);',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(x, y, -row * 3.2, 1.0);',
    '}',
  ].join('\n');
  var TIDAL = [
    'varying float vH; varying float vDepth; varying float vBand;',
    'void main() {',
    '  float fade = (1.0 - vDepth) * (1.0 - vDepth);',
    '  vec3 c = pal(vBand * 0.5 + vH * 0.6 + uTime * 0.03) * (0.3 + vH * 1.8) * fade;',
    '  gl_FragColor = vec4(pow(c, vec3(0.4545)), 1.0);',
    '}',
  ];

  // Morphyre: a sphere the bands push out of shape, in iridescent chrome.
  var CHROME_VS = [
    'uniform float uTime, uBass, uMid, uHigh, uKick, uWarp; uniform sampler2D uSpec;',
    'varying vec3 vPos; varying float vDisp; varying vec2 vUv;',
    'void main() {',
    '  vec3 n = normalize(position);',
    '  float d = sin(dot(n, vec3(3.1, 1.7, 2.3)) * 3.0 + uTime * 1.1) * (0.05 + uBass * 0.16);',
    '  d += sin(dot(n, vec3(-2.3, 3.7, 1.1)) * 5.0 - uTime * 1.6) * (0.03 + uMid * 0.1);',
    '  d += sin(dot(n, vec3(1.3, -2.1, 4.7)) * 9.0 + uTime * 2.3) * (0.01 + uHigh * 0.05);',
    '  float u = fract(atan(n.z, n.x) / 6.2831853 + 0.5) * 0.5 + abs(n.y) * 0.5;',
    '  d += texture2D(uSpec, vec2(u, 0.25)).r * 0.1 * uWarp;',
    '  vec4 w = modelMatrix * vec4(n * (1.0 + d + uKick * 0.07), 1.0);',
    '  vPos = w.xyz; vDisp = d; vUv = vec2(0.0);',
    '  gl_Position = projectionMatrix * viewMatrix * w;',
    '}',
  ].join('\n');
  var CHROME = [
    'uniform vec3 uLight;',
    'varying vec3 vPos; varying float vDisp;',
    'void main() {',
    '  vec3 N = normalize(cross(dFdx(vPos), dFdy(vPos)));',
    '  vec3 V = normalize(cameraPosition - vPos);',
    '  if (dot(N, V) < 0.0) N = -N;',
    '  vec3 R = reflect(-V, N);',
    '  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);',
    '  vec3 env = pal(R.y * 0.35 + R.x * 0.15 + uTime * 0.03) * (0.35 + 0.65 * smoothstep(-0.2, 0.8, R.y));',
    '  float sp = pow(max(dot(R, normalize(uLight - vPos)), 0.0), 40.0);',
    '  vec3 c = env * (0.3 + fres * 1.3 * uGlow) + vec3(sp) * (1.0 + uKick * 2.0) + pal(vDisp * 2.0 + 0.5) * 0.12;',
    '  gl_FragColor = vec4(finish(c, gl_FragCoord.xy / uRes), 1.0);',
    '}',
  ];

  // UnConeD's Whacko AVS: a point cloud that morphs between a sphere, a torus knot and a helix,
  // every point swelling with its band.
  var CHOIR_VS = [
    'attribute vec2 seed;',
    'uniform float uTime, uKick, uMorph, uPixel, uCount; uniform sampler2D uSpec;',
    'varying float vU; varying float vS; varying vec2 vUv;',
    'vec3 sphere(float u) {',
    '  float y = 1.0 - 2.0 * u; float r = sqrt(max(0.0, 1.0 - y * y)); float a = u * uCount * 2.399963;',
    '  return vec3(cos(a) * r, y, sin(a) * r);',
    '}',
    'vec3 knot(float u, float v) {',
    '  float t = u * 6.2831853; float r = 0.62 + 0.24 * cos(3.0 * t);',
    '  vec3 c = vec3(r * cos(2.0 * t), 0.42 * sin(3.0 * t), r * sin(2.0 * t));',
    '  return c + 0.07 * vec3(cos(v * 6.2831853), sin(v * 6.2831853), cos(v * 12.566));',
    '}',
    'vec3 helix(float u, float v) {',
    '  float t = u * 6.2831853 * 5.0; float side = step(0.5, v) * 3.14159;',
    '  return vec3(cos(t + side) * 0.65, (u - 0.5) * 2.0, sin(t + side) * 0.65);',
    '}',
    'void main() {',
    '  float u = seed.x; float sp = texture2D(uSpec, vec2(fract(u * 3.0), 0.25)).r;',
    '  vec3 a = sphere(u), b = knot(u, seed.y), c = helix(u, seed.y);',
    '  float m = uMorph;',
    '  vec3 pos = m < 1.0 ? mix(a, b, smoothstep(0.0, 1.0, m))',
    '    : m < 2.0 ? mix(b, c, smoothstep(0.0, 1.0, m - 1.0)) : mix(c, a, smoothstep(0.0, 1.0, m - 2.0));',
    '  pos *= 1.0 + sp * 0.3 + uKick * 0.12;',
    '  vec4 mv = modelViewMatrix * vec4(pos, 1.0);',
    '  gl_PointSize = (2.6 + sp * 6.0 + uKick * 2.5) * uPixel * (3.0 / -mv.z);',
    '  vU = u; vS = sp; vUv = vec2(0.0);',
    '  gl_Position = projectionMatrix * mv;',
    '}',
  ].join('\n');
  var CHOIR = [
    'varying float vU; varying float vS;',
    'void main() {',
    '  vec2 c = gl_PointCoord - 0.5; float d = dot(c, c);',
    '  if (d > 0.25) discard;',
    '  vec3 col = pal(vU * 0.6 + uTime * 0.05) * exp(-d * 12.0) * (0.55 + vS * 1.4);',
    '  gl_FragColor = vec4(pow(col, vec3(0.4545)), 1.0);',
    '}',
  ];

  // ---- The machinery. -----------------------------------------------------------------------------

  var supported = null;
  function webgl2() {
    if (supported === null) {
      try {
        var c = document.createElement('canvas');
        var g = c.getContext('webgl2');
        supported = !!g;
        var lose = g && g.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } catch (e) { supported = false; }
    }
    return supported;
  }

  function uniforms() {
    var u = {};
    ['uTime', 'uTravel', 'uBass', 'uMid', 'uHigh', 'uLevel', 'uKick', 'uSnare', 'uHat', 'uFlux',
      'uCentroid', 'uPhase', 'uEnergy', 'uHue', 'uWarp', 'uTrails', 'uGlow', 'uZoom', 'uSymmetry',
      'uDetail', 'uDensity'].forEach(function (k) { u[k] = { value: 0 }; });
    u.uRes = { value: new THREE.Vector2(1, 1) };
    u.uSpec = { value: null };
    return u;
  }

  /** @param {any} ctx @param {string} frag @param {object=} own @param {object=} extra */
  function material(ctx, frag, own, extra) {
    return new THREE.ShaderMaterial(Object.assign({
      vertexShader: QUAD_VS,
      fragmentShader: PRELUDE + frag,
      uniforms: Object.assign({}, ctx.U, own || {}),
      depthTest: false,
      depthWrite: false,
    }, extra || {}));
  }
  /** A fullscreen pass: one quad, one material, rendered into a target or the screen. */
  function pass(ctx, frag, own) {
    var mat = material(ctx, frag, own);
    var mesh = new THREE.Mesh(ctx.quad, mat);
    mesh.frustumCulled = false;
    var scene = new THREE.Scene();
    scene.add(mesh);
    return {
      u: mat.uniforms,
      render: function (target) {
        ctx.renderer.setRenderTarget(target || null);
        ctx.renderer.render(scene, ctx.ortho);
      },
      dispose: function () { mat.dispose(); },
    };
  }
  function target(ctx, w, h, wrap) {
    var rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      type: ctx.half ? THREE.HalfFloatType : THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
      wrapS: wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping,
      wrapT: wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping,
    });
    ctx.renderer.setRenderTarget(rt);
    ctx.renderer.setClearColor(0x000000, 1);
    ctx.renderer.clear();
    ctx.renderer.setRenderTarget(null);
    return rt;
  }

  /** A MilkDrop-style feedback mode: warp the last frame into the next, then composite it. */
  function feedback(warp, composite) {
    return function (ctx) {
      var w = pass(ctx, 'uniform sampler2D uPrev;\n' + warp.join('\n'), { uPrev: { value: null } });
      var c = pass(ctx, (composite || COMPOSITE).join('\n'), { uTex: { value: null } });
      var a = null, b = null;
      function make(W, H) {
        if (a) { a.dispose(); b.dispose(); }
        a = target(ctx, W, H);
        b = target(ctx, W, H);
      }
      make(ctx.w, ctx.h);
      return {
        frame: function () {
          w.u.uPrev.value = a.texture;
          w.render(b);
          c.u.uTex.value = b.texture;
          c.render(null);
          var t = a; a = b; b = t;
        },
        resize: make,
        dispose: function () { a.dispose(); b.dispose(); w.dispose(); c.dispose(); },
      };
    };
  }
  function shader(frag) {
    return function (ctx) {
      var p = pass(ctx, frag.join('\n'));
      return { frame: function () { p.render(null); }, resize: function () {}, dispose: p.dispose };
    };
  }

  /** The 3D scenes' shared parts: a perspective camera framed for the screen and the sky. */
  function stage(ctx, fov) {
    var scene = new THREE.Scene();
    var cam = new THREE.PerspectiveCamera(fov, ctx.w / ctx.h, 0.01, 40);
    var skyMat = new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: PRELUDE + SKY.join('\n'),
      uniforms: Object.assign({}, ctx.U), depthTest: false, depthWrite: false });
    var sky = new THREE.Mesh(ctx.quad, skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -1;
    scene.add(sky);
    return {
      scene: scene, cam: cam,
      // A phone in portrait sees the whole object: the camera backs off as the screen narrows.
      fit: function () { return 1 / Math.pow(Math.min(1, ctx.w / ctx.h), 0.85); },
      resize: function (W, H) { cam.aspect = W / H; cam.updateProjectionMatrix(); },
      render: function () { ctx.renderer.setRenderTarget(null); ctx.renderer.render(scene, cam); },
      dispose: function () { skyMat.dispose(); },
    };
  }

  var MODES = {
    liquid: feedback(WARP.liquid),
    patchbay: feedback(WARP.patchbay),
    prism: feedback(WARP.prism, PRISM_COMPOSITE),
    ember: feedback(WARP.ember),
    whirlpool: feedback(WARP.whirlpool),
    silk: feedback(WARP.silk),
    hyperloop: shader(SHADER.hyperloop),
    garden: shader(SHADER.garden),
    cathedral: shader(SHADER.cathedral),
    mercury: shader(SHADER.mercury),
    fold: shader(SHADER.fold),

    reef: function (ctx) {
      var init = pass(ctx, REEF_INIT.join('\n'), { uSim: { value: new THREE.Vector2(1, 1) } });
      var sim = pass(ctx, REEF_STEP.join('\n'), {
        uState: { value: null }, uSim: { value: new THREE.Vector2(1, 1) },
        uSeed: { value: new THREE.Vector4(0, 0, 0, 0) }, uFeed: { value: 0.046 }, uKill: { value: 0.063 },
      });
      var show = pass(ctx, REEF_SHOW.join('\n'), { uState: { value: null }, uSim: { value: new THREE.Vector2(1, 1) } });
      var a = null, b = null, detail = -1;
      function make() {
        if (a) { a.dispose(); b.dispose(); }
        var long = Math.round(150 + 110 * detail);
        var W = ctx.w >= ctx.h ? long : Math.round(long * ctx.w / ctx.h);
        var H = ctx.w >= ctx.h ? Math.round(long * ctx.h / ctx.w) : long;
        a = target(ctx, W, H, true);
        b = target(ctx, W, H, true);
        [init, sim, show].forEach(function (p) { p.u.uSim.value.set(W, H); });
        init.render(a);
      }
      return {
        frame: function (an, s) {
          if (Math.abs(s.params.detail - detail) > 0.05) { detail = s.params.detail; make(); }
          var react = s.params.react;
          sim.u.uFeed.value = 0.042 + 0.01 * Math.min(1, an.mid * react);
          sim.u.uKill.value = 0.062 + 0.002 * Math.min(1, an.high * react);
          var steps = Math.max(1, Math.min(16, Math.round(7 * s.params.speed)));
          for (var i = 0; i < steps; i++) {
            if (i === 0 && an.beat && react > 0) sim.u.uSeed.value.set(Math.random(), Math.random(), 0.02 + 0.02 * an.bass, 0);
            else if (i === 0 && an.hat > 0.9 && react > 0) sim.u.uSeed.value.set(Math.random(), Math.random(), 0.008, 0);
            else sim.u.uSeed.value.set(0, 0, 0, 0);
            sim.u.uState.value = a.texture;
            sim.render(b);
            var t = a; a = b; b = t;
          }
          show.u.uState.value = a.texture;
          show.render(null);
        },
        resize: function () { detail = -1; },
        // The grid is made on the first frame: a mode left before it drew has none to dispose.
        dispose: function () { if (a) a.dispose(); if (b) b.dispose(); init.dispose(); sim.dispose(); show.dispose(); },
      };
    },

    tidal: function (ctx) {
      var COLS = 48, ROWS = 64;
      var hist = new Uint8Array(COLS * ROWS * 4);
      var tex = new THREE.DataTexture(hist, COLS, ROWS, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapT = THREE.RepeatWrapping;
      tex.needsUpdate = true;
      var grid = [];
      for (var r = 0; r < ROWS; r++) {
        for (var i = 0; i < COLS - 1; i++) {
          grid.push(i, r, i + 1, r);
          if (i % 4 === 0 && r < ROWS - 1) grid.push(i, r, i, r + 1);
        }
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(grid.length / 2 * 3), 3));
      geo.setAttribute('grid', new THREE.BufferAttribute(new Float32Array(grid), 2));
      var mat = new THREE.ShaderMaterial({ vertexShader: TIDAL_VS, fragmentShader: PRELUDE + TIDAL.join('\n'),
        uniforms: Object.assign({}, ctx.U, { uHist: { value: tex }, uHead: { value: 0 } }),
        transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false });
      var lines = new THREE.LineSegments(geo, mat);
      lines.frustumCulled = false;
      var st = stage(ctx, 55);
      st.scene.add(lines);
      var head = 0;
      return {
        frame: function (an, s) {
          head = (head + 1) % ROWS;
          var react = s.params.react;
          for (var k = 0; k < COLS; k++) {
            var o = (head * COLS + k) * 4;
            hist[o] = hist[o + 1] = hist[o + 2] = Math.min(255, an.bands[k] * react * 255);
            hist[o + 3] = 255;
          }
          tex.needsUpdate = true;
          mat.uniforms.uHead.value = head / ROWS;
          var t = s.t * s.params.speed;
          var back = st.fit() / s.params.zoom;
          st.cam.position.set(Math.sin(t * 0.07) * 0.3, 0.8 + 0.1 * Math.sin(t * 0.05), 0.35 + 0.5 * back);
          st.cam.lookAt(0, -0.05, -1.1);
          st.render();
        },
        resize: st.resize,
        dispose: function () { geo.dispose(); mat.dispose(); tex.dispose(); st.dispose(); },
      };
    },

    chrome: function (ctx) {
      var geo = new THREE.IcosahedronGeometry(1, ctx.small ? 20 : 32);
      var mat = new THREE.ShaderMaterial({ vertexShader: CHROME_VS, fragmentShader: PRELUDE + CHROME.join('\n'),
        uniforms: Object.assign({}, ctx.U, { uLight: { value: new THREE.Vector3(2, 2, 3) } }) });
      var mesh = new THREE.Mesh(geo, mat);
      var st = stage(ctx, 45);
      st.scene.add(mesh);
      return {
        frame: function (an, s) {
          var t = s.t * s.params.speed;
          mesh.rotation.set(Math.sin(t * 0.1) * 0.4, t * 0.25, 0);
          mat.uniforms.uLight.value.set(Math.cos(t * 0.6) * 3, 1.5 + Math.sin(t * 0.4), Math.sin(t * 0.6) * 3);
          st.cam.position.set(0, 0, 3.4 * st.fit());
          st.cam.lookAt(0, 0, 0);
          st.render();
        },
        resize: st.resize,
        dispose: function () { geo.dispose(); mat.dispose(); st.dispose(); },
      };
    },

    choir: function (ctx) {
      var st = stage(ctx, 50);
      var mat = new THREE.ShaderMaterial({ vertexShader: CHOIR_VS, fragmentShader: PRELUDE + CHOIR.join('\n'),
        uniforms: Object.assign({}, ctx.U, { uMorph: { value: 0 }, uPixel: { value: 1 }, uCount: { value: 1 } }),
        transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false });
      var geo = null, points = null, density = -1;
      function build(d) {
        if (points) { st.scene.remove(points); geo.dispose(); }
        var n = Math.round((ctx.small ? 3500 : 7000) * d);
        var seed = new Float32Array(n * 2);
        for (var i = 0; i < n; i++) { seed[i * 2] = i / n; seed[i * 2 + 1] = Math.random(); }
        geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        geo.setAttribute('seed', new THREE.BufferAttribute(seed, 2));
        points = new THREE.Points(geo, mat);
        points.frustumCulled = false;
        st.scene.add(points);
        mat.uniforms.uCount.value = n;
        density = d;
      }
      return {
        frame: function (an, s) {
          if (Math.abs(s.params.density - density) > 0.05) build(s.params.density);
          var t = s.t * s.params.speed;
          mat.uniforms.uMorph.value = (t / 9) % 3;
          mat.uniforms.uPixel.value = ctx.renderer.getPixelRatio();
          points.rotation.set(Math.sin(t * 0.13) * 0.5, t * 0.3, 0);
          st.cam.position.set(0, 0, 3.6 * st.fit());
          st.cam.lookAt(0, 0, 0);
          st.render();
        },
        resize: st.resize,
        dispose: function () { if (geo) geo.dispose(); mat.dispose(); st.dispose(); },
      };
    },
  };

  /**
   * A WebGL picture in an element, or null where WebGL 2 cannot be had.
   * @param {HTMLElement} el @param {{density: number, fps?: number}} opt
   */
  function mount(el, opt) {
    if (!webgl2()) return null;
    var canvas = document.createElement('canvas');
    canvas.className = 'block h-full w-full';
    canvas.setAttribute('aria-hidden', 'true');
    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, alpha: false,
        preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    } catch (e) {
      return null; // untested: a context the WebGL 2 probe allowed and the browser then refused; the host falls back (no-WebGL test)
    }
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setClearColor(0x000000, 1);
    el.insertBefore(canvas, el.firstChild);
    var dpr = Math.min(window.devicePixelRatio || 1, opt.density || 1);
    var ctx = {
      renderer: renderer, U: uniforms(), quad: new THREE.PlaneGeometry(2, 2),
      ortho: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), w: 1, h: 1,
      half: renderer.extensions.has('EXT_color_buffer_half_float') || renderer.extensions.has('EXT_color_buffer_float'),
      small: Math.min(window.innerWidth, window.innerHeight) < 600,
    };
    // The spectrum (row 0) and the waveform (row 1), 256 wide, refreshed every frame.
    var specData = new Uint8Array(256 * 2 * 4);
    var specTex = new THREE.DataTexture(specData, 256, 2, THREE.RGBAFormat, THREE.UnsignedByteType);
    specTex.minFilter = THREE.LinearFilter;
    specTex.magFilter = THREE.LinearFilter;
    specTex.needsUpdate = true;
    ctx.U.uSpec.value = specTex;

    var id = '';
    var mode = null;
    var level = 0;          // index into SCALES
    var slow = 0;           // an average of the frame's length, in ms
    var calmSince = performance.now();
    var changedAt = 0;

    function size() {
      var W = el.clientWidth || 1, H = el.clientHeight || 1;
      renderer.setPixelRatio(dpr * SCALES[level]);
      renderer.setSize(W, H, false);
      var buf = renderer.getDrawingBufferSize(new THREE.Vector2());
      ctx.w = buf.x;
      ctx.h = buf.y;
      ctx.U.uRes.value.set(buf.x, buf.y);
      if (mode) mode.resize(buf.x, buf.y);
    }
    // Fewer pixels when frames run long (quickly), more after three calm seconds (slowly).
    function adapt(dt) {
      var ms = dt * 1000;
      slow = slow ? slow * 0.9 + ms * 0.1 : ms;
      var now = performance.now();
      var budget = Math.max(22, 1000 / (opt.fps || 60) * 1.35);
      if (slow < budget * 0.7) { if (now - calmSince > 3000 && level > 0 && now - changedAt > 3000) { level -= 1; changedAt = now; size(); } }
      else calmSince = now;
      if (slow > budget && level < SCALES.length - 1 && now - changedAt > 500) {
        level += 1;
        changedAt = now;
        slow = budget * 0.8;
        size();
      }
    }

    function updateSpectrum(a) {
      for (var x = 0; x < 256; x++) {
        var f = x / 255 * 47;
        var i = Math.floor(f);
        var v = a.bands[i] + (a.bands[Math.min(47, i + 1)] - a.bands[i]) * (f - i);
        specData[x * 4] = Math.min(255, v * 255);
        specData[(256 + x) * 4] = Math.max(0, Math.min(255, (a.wave[x] * 0.5 + 0.5) * 255));
      }
      specTex.needsUpdate = true;
    }
    var travel = 0;
    function updateUniforms(a, s) {
      var p = s.params;
      var r = p.react;
      var U = ctx.U;
      U.uTime.value = s.t * p.speed;
      travel += a.dt * p.speed * (0.6 + Math.min(1.5, a.energy * r) * 2.2 + a.kick * r * 0.5);
      U.uTravel.value = travel;
      U.uBass.value = Math.min(2, a.bass * r);
      U.uMid.value = Math.min(2, a.mid * r);
      U.uHigh.value = Math.min(2, a.high * r);
      U.uLevel.value = Math.min(2, a.level * r);
      U.uKick.value = Math.min(2, a.kick * r);
      U.uSnare.value = Math.min(2, a.snare * r);
      U.uHat.value = Math.min(2, a.hat * r);
      U.uFlux.value = Math.min(2, a.flux * r);
      U.uEnergy.value = Math.min(2, a.energy * r);
      U.uCentroid.value = a.centroid;
      U.uPhase.value = a.phase;
      U.uHue.value = p.hue;
      U.uWarp.value = p.warp;
      U.uTrails.value = p.trails;
      U.uGlow.value = p.glow;
      U.uZoom.value = p.zoom;
      U.uSymmetry.value = p.symmetry;
      U.uDetail.value = p.detail;
      U.uDensity.value = p.density;
    }

    var handle = {
      canvas: canvas,
      set: function (next) {
        if (next === id || !MODES[next]) return;
        if (mode) { try { mode.dispose(); } catch (e) { console.error('viz-gl: dispose ' + id, e); } }
        id = next;
        level = HEAVY[next] ? 2 : 0;
        slow = 0;
        calmSince = performance.now();
        size();
        // A mode that cannot be built draws nothing and says why, once, in the console.
        try { mode = MODES[next](ctx); } catch (e) { mode = null; console.error('viz-gl: ' + next, e); }
        renderer.setRenderTarget(null);
        renderer.clear();
      },
      frame: function (a, s) {
        if (!mode) return;
        adapt(a.dt);
        updateSpectrum(a);
        updateUniforms(a, s);
        mode.frame(a, s);
      },
      resize: size,
      remove: function () {
        if (mode) { try { mode.dispose(); } catch (e) { console.error('viz-gl: dispose ' + id, e); } }
        mode = null;
        specTex.dispose();
        ctx.quad.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        canvas.remove();
      },
    };
    return handle;
  }

  window.SonicVizGL = {
    supported: webgl2,
    modes: function () { return IDS.slice(); },
    mount: mount,
  };
})();
