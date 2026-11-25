// The visualiser's WebGL modes (data/visualizer.json, engine "gl"), on three.js. static/js/
// visualizer.js loads this file, after three.js, only when one of these modes is shown, and calls
// SonicVizGL.mount(el) once per picture; the handle draws one frame per call of frame(a, s), where
// `a` is the frame's analysis of the sound (SonicVizAnalysis) and `s` the mode's scratch with its
// live parameters and the shared grammar's signals `s.m` (static/js/viz-map.js).
//
// three.js is vendored as a custom build of exactly the names this file uses (scripts/vendor.mjs
// reads every `THREE.<Name>` here), so three is referenced only as THREE.<Name>.
//
// Every mode speaks the one grammar of static/js/viz-map.js through one set of uniforms:
//   colour      the palette is the key's hue on the circle of fifths plus the hue control (tone(),
//               an analogous spread around it), its saturation how clearly one key sounds, its
//               lightness the timbre's brightness, the accent the leading note; the twelve pitch
//               classes (uChroma) colour the voices by their own place on the circle.
//   brightness  only the slow loudness (uExpo) brightens the whole screen; an onset moves, scales
//               and colours, and whatever brightness share it has is scaled by uFlash.
//   time        a clock paced by the tempo, the beat and bar phases and their pulses; a big event
//               (uPunch) also starts a shockwave (uShock, its age) and a step of symmetry (uTurn);
//               a snare is a smaller impulse (uSnap), the hats a shimmer of scattered glints
//               (uShimmer), their brightness shares scaled by uFlash too.
//   form        a new section of the song draws a new variant of the scene (uVariant, uPrevVariant,
//               crossfaded by uMorph): a warp field, a fold, a cross-section, a camera path.
//   space       the stereo balance moves the centre (uPan), the width spreads the scene.
//   safety      reduced motion caps every zoom, turn and scale (uMotion); react 0 is a resting
//               picture that the music no longer moves.
//
// Four kinds of picture share the uniforms and one GLSL prelude:
//   feedback  MilkDrop's idea: every frame reads the last one through a warp (zoom, rotation, a
//             flow field), lets it fade by the trails control, draws new light on top, and a
//             composite pass blooms it (from the buffer's own mipmaps) and tones it for the
//             screen. liquid, patchbay, prism, ember, whirlpool, silk.
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
  // Each mode's palette around the key's hue, in turns: its own offset, then its harmony's two
  // hues (analogous +-1/12, complementary 1/2, split-complementary 5/12 and 7/12, triadic +-1/3).
  // The offsets spread the modes round the wheel, so in one key no two look alike, and the whole
  // palette still turns with the key and the hue control.
  var ANALOG = [-1 / 12, 1 / 12], COMPL = [1 / 2, 1 / 24], SPLIT = [5 / 12, 7 / 12], TRIAD = [-1 / 3, 1 / 3];
  var PALETTE = {
    liquid: [0, TRIAD], patchbay: [0.7, SPLIT], prism: [0.5, COMPL], ember: [-0.04, ANALOG],
    tidal: [0.58, SPLIT], hyperloop: [0.83, COMPL], chrome: [0.25, ANALOG], whirlpool: [0.67, TRIAD],
    choir: [0.42, SPLIT], garden: [0.17, TRIAD], silk: [0.75, SPLIT], cathedral: [0.33, SPLIT],
    reef: [0.45, TRIAD], mercury: [0.92, COMPL], fold: [0.12, SPLIT],
  };
  var SCALES = [1, 0.85, 0.7, 0.58, 0.47, 0.38, 0.3, 0.25];

  // ---- GLSL. -------------------------------------------------------------------------------------

  var QUAD_VS = [
    'varying vec2 vUv;',
    'void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  ].join('\n');

  // The uniforms every picture shares (see updateUniforms for what each carries).
  var SHARED = [
    'uTime', 'uPace', 'uBeats', 'uPhase', 'uBar', 'uTravel', 'uShock', 'uTurn', 'uFr',
    'uBass', 'uMid', 'uHigh', 'uLevel', 'uFlux', 'uEnergy', 'uKick', 'uSnare', 'uHat',
    'uPulse', 'uPre', 'uBarPulse', 'uPunch', 'uSnap', 'uShimmer', 'uFlash', 'uMotion', 'uDrift',
    'uExpo', 'uReact',
    'uHueK', 'uAccent', 'uSat', 'uLight', 'uHueP', 'uRough', 'uHalo', 'uPan', 'uSpread', 'uContrast',
    'uVariant', 'uPrevVariant', 'uMorph', 'uHueOff', 'uHarmA', 'uHarmB',
    'uWarp', 'uTrails', 'uGlow', 'uZoom', 'uSymmetry', 'uDetail', 'uDensity',
  ];

  var PRELUDE = [
    'precision highp float;',
    'uniform float ' + SHARED.join(', ') + ';',
    'uniform float uChroma[12];',
    'uniform vec3 uNoteCol;',
    'uniform vec2 uRes;',
    'uniform sampler2D uSpec;',
    'varying vec2 vUv;',
    '#define PI 3.14159265',
    '#define TAU 6.2831853',
    // The spectrum and the waveform, scaled by react: at react 0 nothing the music does shows.
    'float spec(float x) { return texture2D(uSpec, vec2(clamp(x, 0.0, 1.0), 0.25)).r * uReact; }',
    'float wave(float x) { return (texture2D(uSpec, vec2(clamp(x, 0.0, 1.0), 0.75)).r * 2.0 - 1.0) * min(uReact, 1.5); }',
    'float lvl() { return clamp(1.0 + uLevel, 0.0, 2.0); }',
    'float flx() { return clamp(1.0 + uFlux, 0.0, 2.5); }',
    'vec3 hsv(float h, float s, float v) {',
    '  vec3 k = clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);',
    '  return v * mix(vec3(1.0), k, s);',
    '}',
    // The mode's palette: its base is the key's hue turned by the mode's own offset (uHueOff), and
    // its harmony (analogous, complementary, split or triadic) the two hues uHarmA and uHarmB away
    // from it. t -1..1 runs from the first harmony hue through the base to the second; the base
    // keeps the larger share. The saturation is how clearly one key sounds, a brighter timbre a
    // lighter colour.
    'float satK() { return 0.42 + 0.58 * uSat; }',
    'float baseH() { return uHueK + uHueOff; }',
    'vec3 tone(float t) {',
    '  float s = satK() * (1.0 - 0.3 * uLight);',
    '  vec3 c = hsv(baseH() + 0.04 * t, s, 1.0);',
    '  c = mix(c, hsv(baseH() + uHarmA, s, 1.0), 0.8 * smoothstep(0.35, 1.0, -t));',
    '  return mix(c, hsv(baseH() + uHarmB, s, 1.0), 0.8 * smoothstep(0.35, 1.0, t));',
    '}',
    // The events' colours stand out of the base wash: the leading note (accent), pushed at least
    // a quarter turn from the base, and the notes, each lighter and brighter than the base.
    'vec3 accentC() {',
    '  float d = fract(uAccent - uHueK + 0.5) - 0.5;',
    '  float h = baseH() + (abs(d) < 0.25 ? (d < 0.0 ? -0.25 : 0.25) : d);',
    '  return hsv(h, satK() * 0.7, 1.0) * 1.35;',
    '}',
    // A colour brought halfway to one luminance: a palette that turns with the key went several
    // times darker from yellow to blue whatever the music did, and a mode with long trails read
    // its key changes as loud and quiet passages (analysis pass 3: silk, patchbay).
    'vec3 even(vec3 c) { return c * sqrt(0.45 / max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.05)); }',
    // How loud the passage is, 0..1: the slow loudness the exposure carries (uExpo, undone).
    'float loud() { return clamp((uExpo - 0.36) / 0.6, 0.0, 1.0); }',
    // The ground: dark, in the base hue, a little more saturated than the light.
    'vec3 deep(float v) { return hsv(baseH() + 0.02, min(1.0, satK() * 1.1), v); }',
    // A pitch class's own hue, its place on the circle of fifths turned by the hue control and the
    // mode's offset.
    'float pcHue(int i) { return fract(float((i * 7) % 12) / 12.0 + uHueP + uHueOff); }',
    'vec3 note(int i) { return hsv(pcHue(i), satK() * 0.8, 1.0) * 1.25; }',
    'float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    'float h1(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }',
    // A section's own value k of its variant, crossfaded from the last section's.
    'float vary(float k) { return mix(h1(uPrevVariant * 91.7 + k), h1(uVariant * 91.7 + k), smoothstep(0.0, 1.0, uMorph)); }',
    // The same without the crossfade, for the feedback modes, whose trails crossfade by themselves.
    'float varyNow(float k) { return h1(uVariant * 91.7 + k); }',
    'float noise(vec2 p) {',
    '  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),',
    '    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);',
    '}',
    'float fbm(vec2 p) {',
    '  float v = 0.0, a = 0.5;',
    '  for (int i = 0; i < 4; i++) { v += a * noise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 1.7; a *= 0.5; }',
    '  return v;',
    '}',
    'float fbm2(vec2 p) { return 0.66 * noise(p) + 0.34 * noise(mat2(1.6, 1.2, -1.2, 1.6) * p + 3.1); }',
    // A divergence-free flow (curl noise): colour carried along it never clumps.
    'vec2 curl(vec2 p) {',
    '  float e = 0.06;',
    '  float a = fbm2(p + vec2(0.0, e)), b = fbm2(p - vec2(0.0, e));',
    '  float c = fbm2(p + vec2(e, 0.0)), d = fbm2(p - vec2(e, 0.0));',
    '  return vec2(a - b, d - c) / (2.0 * e);',
    '}',
    'vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }',
    'float line(float d, float w) { return 1.0 - smoothstep(0.0, w, abs(d)); }',
    'float glowl(float d, float w) { return w / (abs(d) + w); }',
    'vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }',
    // The short side spans -0.5..0.5 whatever the screen: a phone in portrait sees the same picture.
    'vec2 centred(vec2 uv) { return (uv - 0.5) * uRes / min(uRes.x, uRes.y); }',
    'vec2 uncentred(vec2 p) { return p * min(uRes.x, uRes.y) / uRes + 0.5; }',
    // Where the sound stands: the balance as an offset in centred units.
    'vec2 panC() { return vec2(uPan * uRes.x / min(uRes.x, uRes.y), 0.0); }',
    // The screen: the slow loudness exposes, a filmic curve tones, a vignette, grain as rough as
    // the sound.
    'vec3 finish(vec3 c, vec2 uv) {',
    '  c = aces(c * uExpo);',
    '  vec2 q = uv - 0.5; c *= 1.0 - dot(q, q) * 0.8;',
    '  c = pow(max(c, 0.0), vec3(0.4545));',
    '  return c + (hash(uv * uRes + fract(uTime * 7.0) * 91.0) - 0.5) * (0.012 + 0.025 * uRough);',
    '}',
    '',
  ].join('\n');

  // The composite of a feedback mode: the buffer and a bloom of it from its own mipmaps, wider as
  // the treble reaches higher, toned for the screen.
  var BLOOM = [
    'uniform sampler2D uTex;',
    'vec3 bloom(vec2 uv) {',
    '  float r = 0.6 + 1.2 * uHalo; vec2 px = 1.0 / uRes;',
    '  vec3 b = textureLod(uTex, uv, 1.5 + r * 0.5).rgb * 0.45;',
    '  for (int i = 0; i < 4; i++) {',
    '    vec2 o = vec2(float(i / 2) * 2.0 - 1.0, float(i % 2) * 2.0 - 1.0) * px * 5.0 * r;',
    '    b += textureLod(uTex, uv + o, 3.0 + r).rgb * 0.12 + textureLod(uTex, uv + o * 3.0, 4.5 + r).rgb * 0.09;',
    '  }',
    '  return b;',
    '}',
  ];
  var COMPOSITE = BLOOM.concat([
    'void main() {',
    '  vec3 c = texture2D(uTex, vUv).rgb;',
    '  c += bloom(vUv) * 0.45 * uGlow;',
    '  gl_FragColor = vec4(finish(c, vUv), 1.0);',
    '}',
  ]);

  // ---- Feedback modes: the warp pass of each (reads uPrev, writes the next frame). -------------

  var FEED = [
    'uniform sampler2D uPrev;',
    'vec3 prev(vec2 p) { return texture2D(uPrev, uncentred(p)).rgb; }',
    'vec3 prevLod(vec2 p, float l) { return textureLod(uPrev, uncentred(p), l).rgb; }',
    // The trails control, per 60th of a second whatever the frame rate.
    'float fade(float lo, float hi) { return pow(mix(lo, hi, uTrails), uFr); }',
  ];

  var WARP = {
    // MilkDrop 1: the last frame zooms on the beat with the bass, turns over the bar and flows
    // along a curl field of this section; a ring of the waveform, mirrored into the section's
    // lobes, burns into it with the twelve notes as nodes on the circle of fifths; a big event
    // sends a shockwave out.
    liquid: [
      'void main() {',
      '  vec2 C = panC() * 0.5;',
      '  vec2 p = centred(vUv) - C; float r = length(p); float ang = atan(p.y, p.x);',
      '  float zoomF = 1.0 + ((0.004 + 0.005 * uWarp) * uPace + 0.025 * max(uBass, 0.0) * uPulse + 0.02 * uPunch + 0.025 * uSnap) * uMotion * uDrift * uFr;',
      '  float rotF = (0.006 * sin(uBar * TAU + varyNow(1.0) * TAU) * uPace + 0.03 * uSnare * (uPan < 0.0 ? -1.0 : 1.0)) * uMotion * uFr;',
      '  vec2 q = rot(p, rotF) / zoomF;',
      '  q += uWarp * 0.004 * uFr * curl(q * (1.5 + 3.0 * varyNow(2.0)) + vec2(uTime * 0.11, -uTime * 0.07)) * (0.3 + 0.7 * flx());',
      '  vec3 col = mix(prev(q + C), prevLod(q + C, 1.5), 0.12) * fade(0.8, 0.965);',
      '  float lobes = 1.0 + floor(varyNow(3.0) * 4.0);',
      '  float u = abs(fract(ang / TAU * lobes) * 2.0 - 1.0);',
      // A snare throws the ring out (it drew no snare at all, round 2 pass 1); the hats glint
      // along it.
      '  float R = 0.19 + 0.012 * sin(ang * 3.0 + uTime) + (0.05 * max(uBass, 0.0) + 0.03 * uPulse + 0.05 * uSnap) * uMotion + wave(u) * (0.025 + 0.03 * lvl());',
      '  float w = 0.004 + 0.003 * max(uLevel, 0.0);',
      '  float edge = line(r - R, w) + 0.3 * glowl(r - R, 0.008);',
      '  float glint = step(0.7, hash(vec2(floor(ang * 9.0), floor(uTime * 23.0))));',
      '  col += tone(sin(ang * lobes + uTime * 0.3)) * edge * (0.06 + (0.12 * uPunch + 0.08 * uSnap + 0.5 * uShimmer * glint) * uFlash) * uFr;',
      '  for (int i = 0; i < 12; i++) {',
      '    float a = pcHue(i) * TAU; vec2 c = p - vec2(cos(a), sin(a)) * R;',
      '    col += note(i) * uChroma[i] * 0.08 * exp(-dot(c, c) / 0.0002) * uFr;',
      '  }',
      '  float sr = R + uShock * 0.55 * uMotion;',
      '  col += accentC() * line(r - sr, 0.005) * exp(-uShock * 3.0) * (0.08 + 0.15 * uFlash) * uFr;',
      '  col += deep(0.0012) * uFr;',
      '  gl_FragColor = vec4(min(col, vec3(4.0)), 1.0);',
      '}',
    ],
    // AVS: a "dynamic movement" (a pull on the beat, a twist that breathes over the bar, one of
    // three fields per section: spiral, pull, ripple) and a blur under a superscope of the
    // waveform folded into the symmetry's mirrored sectors, which turn a sector per bar and a
    // half step on a big event; a wide stereo image draws a Lissajous figure at the centre.
    patchbay: [
      'void main() {',
      '  vec2 C = panC() * 0.5;',
      '  vec2 p = centred(vUv) - C; float r = length(p); float a = atan(p.y, p.x);',
      '  float v = varyNow(1.0);',
      '  float pull = (0.008 * uPace + 0.02 * max(uBass, 0.0) * uPulse + 0.012 * uPunch + 0.008 * uSnap) * uMotion * uDrift;',
      '  float twist = (0.01 * sin(uBar * TAU) * uPace + 0.02 * max(uMid, 0.0) * sin(r * 6.0 + uTime)) * uMotion;',
      '  float r2 = r * pow(1.0 - pull, uFr) + 0.004 * v * sin(r * 22.0 - uTime * 2.0) * uMotion * uPace;',
      '  float a2 = a + (twist + 0.012 * (1.0 - v) / (r + 0.3) * uMotion * uPace) * uFr;',
      '  vec2 q = vec2(cos(a2), sin(a2)) * r2 + C;',
      // A lighter blur and shorter trails than a fog: blurred over and over in one hue, the trails
      // filled the screen with an olive haze (analysis pass 3).
      '  vec3 col = mix(prev(q), prevLod(q, 1.2), 0.08) * fade(0.74, 0.94);',
      '  float n = floor(uSymmetry); float sector = TAU / n;',
      '  float spin = uTime * 0.12 * uMotion + uTurn * sector * 0.5 * step(0.5, uMotion);',
      '  float fa = abs(mod(a - spin, sector) - sector * 0.5);',
      '  vec2 f = vec2(cos(fa), sin(fa)) * r;',
      '  float x = clamp(f.x / 0.62, 0.0, 1.0);',
      // The scope springs up on a snare and thickens on the hats (neither drew: round 2 pass 1).
      '  float y = abs(wave(x)) * (0.05 + 0.08 * lvl()) + 0.012 + (0.03 * uKick + 0.025 * uSnap) * uMotion;',
      '  float on = step(0.03, f.x) * (1.0 - smoothstep(0.58, 0.64, f.x));',
      '  float ln = (line(f.y - y, 0.0025 + 0.004 * lvl() + 0.004 * uShimmer * uMotion) + 0.15 * glowl(f.y - y, 0.004)) * on;',
      '  int pc = int(floor(x * 11.99));',
      // The scope runs through the harmony's three hues along its length, each as bright.
      '  float tt = x * 2.0 - 1.0;',
      '  vec3 ink = even(mix(tone(sign(tt) * sqrt(abs(tt))), note(pc), 0.6 * uChroma[pc]));',
      '  col += ink * ln * (0.11 + (0.08 * uPunch + 0.05 * uSnap + 0.06 * uShimmer) * uFlash) * uFr;',
      '  float liss = smoothstep(0.2, 0.5, uSpread);',
      '  if (liss > 0.0) {',
      '    float dm = 1.0;',
      '    for (int i = 0; i < 48; i++) {',
      '      float t = float(i) / 47.0;',
      '      vec2 s = vec2(wave(t), wave(fract(t + 0.25))) * 0.25 * liss;',
      '      dm = min(dm, length(p - s));',
      '    }',
      '    col += accentC() * line(dm, 0.004) * 0.1 * uFr;',
      '  }',
      '  col += deep(0.0005) * uFr;',
      '  gl_FragColor = vec4(min(col, vec3(4.0)), 1.0);',
      '}',
    ],
    // MilkDrop 2: a swirling history; twelve orbs, one for each note on the circle of fifths, on
    // Lissajous paths, large and lit while their note sounds, and larger as the passage is exposed;
    // a horizon of the waveform. The composite adds prism fringes and a kaleidoscope that folds in
    // on a big event.
    prism: [
      'void main() {',
      '  vec2 p = centred(vUv); float r = length(p);',
      '  float rotF = (0.006 * sin(uTime * 0.21) + 0.012 * max(uMid, 0.0) + 0.02 * uSnare) * uMotion * uFr;',
      '  float zoomF = 1.0 + (0.006 * uPace + 0.03 * max(uBass, 0.0) * uPulse) * uMotion * uDrift * uFr;',
      '  vec2 q = rot(p, rotF) / zoomF;',
      '  q += 0.004 * uWarp * uFr * vec2(sin(r * 14.0 - uTime * 1.3), cos(r * 11.0 + uTime)) * (0.4 + 0.6 * flx());',
      '  vec3 col = prev(q) * fade(0.84, 0.965);',
      '  vec2 C = panC() * 0.4;',
      '  float ph = vary(1.0) * 3.0;',
      // The composite shows one wedge of this buffer (angles 0 to a half sector), mirrored: an orb
      // wandering outside it was not seen at all, so the screen went dark or lit by where the orbs
      // happened to be, 0.25x as bright in a loud chorus as in the quiet verse before it (round 2
      // pass 1). Each orb is drawn folded into the wedge, so every orb always shows; as large and
      // as bright as the passage is loud.
      '  float sec = TAU / (3.0 + floor(varyNow(2.0) * 5.0));',
      '  float ld = loud();',
      '  for (int i = 0; i < 12; i++) {',
      '    float fi = float(i); float k = uChroma[i];',
      '    vec2 c = C + vec2(0.36, 0.28) * vec2(sin(uTime * 0.35 * (0.5 + fi * 0.071) + fi * 2.0 + ph), cos(uTime * 0.35 * (0.4 + fi * 0.093) + fi + ph));',
      '    float ca = abs(mod(atan(c.y, c.x), sec) - sec * 0.5);',
      '    c = vec2(cos(ca), sin(ca)) * max(length(c), 0.06);',
      '    float s = (0.008 + 0.026 * k * (0.7 + 0.5 * uPulse + 0.3 * uSnap)) * (0.6 + 0.9 * ld);',
      '    float d = length(p - c);',
      // Dimmer each than when most were hidden: folded together they overlap, and at the old
      // strength they piled up into a white bloom.
      '    col += mix(note(i), vec3(1.0), 0.3 * exp(-d * d / (s * s * 0.15))) * (k + 0.1) * exp(-d * d / (s * s)) * (0.07 + 0.28 * ld) * uFr;',
      '  }',
      '  col += tone(0.5) * line(p.y - wave(vUv.x) * 0.12, 0.003 + 0.004 * uExpo) * (0.06 + 0.1 * max(uLevel, 0.0)) * uFr;',
      '  gl_FragColor = vec4(min(col, vec3(4.0)), 1.0);',
      '}',
    ],
    // Geiss: smoke in the key's own flame colours rises and curls along this section's wind;
    // a bed of coals glows with the spectrum (placed by the balance, as wide as the stereo);
    // sparks fly on the kick and the hats; the waveform smoulders low.
    ember: [
      'vec3 fire(float x) {',
      '  x = clamp(x, 0.0, 1.5);',
      '  return hsv(baseH() - 0.06 + 0.1 * x, satK() * (1.0 - 0.55 * smoothstep(0.6, 1.4, x)), 1.0) * (x * x * 1.6);',
      '}',
      'void main() {',
      '  vec2 p = centred(vUv);',
      '  float v = varyNow(1.0);',
      '  float bot = -0.5 * uRes.y / min(uRes.x, uRes.y); float hw = 0.5 * uRes.x / min(uRes.x, uRes.y);',
      '  vec2 cf = curl(p * (2.0 + 2.0 * v) + vec2(0.0, -uTime * 0.25));',
      // A snare is a gust: the smoke leaps up and sways; the hats throw sparks (neither drew:
      // round 2 pass 1).
      '  vec2 q = p - vec2((v - 0.5) * 0.002 + 0.02 * uSnap * sin(p.y * 7.0 + uTime * 2.0) * uMotion, 0.0026 + 0.002 * lvl() + 0.016 * uSnap * uMotion) * uFr * uDrift;',
      '  q -= cf * 0.0016 * uFr * (0.6 + 0.8 * flx());',
      '  vec3 col = mix(prev(q), prevLod(q, 1.0), 0.25) * fade(0.84, 0.975);',
      '  float xs = (p.x - panC().x * 0.5) / (hw * (0.7 + 0.3 * uSpread)) * 0.5 + 0.5;',
      '  float b = spec(xs) * step(0.0, xs) * step(xs, 1.0);',
      '  col += fire(0.5 + 0.8 * b + 0.3 * uSnap) * exp(-(p.y - bot) * (12.0 - 6.0 * b - 3.0 * uSnap * uMotion)) * smoothstep(0.42, 0.75, fbm(vec2(p.x * 7.0, p.y * 2.5 - uTime * 1.8)) + 0.25 * b) * 0.022 * (1.0 + 0.8 * uSnap * uFlash) * uFr;',
      '  float h = hash(floor(vUv * uRes / 3.0) + floor(uTime * 40.0));',
      '  float rate = 0.0002 + (uKick * 0.004 + uSnap * 0.003 + uShimmer * 0.008) * (0.4 + b);',
      '  col += mix(fire(1.2), accentC(), 0.6) * step(1.0 - rate, h) * (1.0 - smoothstep(bot, bot + 0.3, p.y)) * 0.5 * uFr;',
      '  float wv = bot + 0.18 + wave(vUv.x) * (0.04 + 0.05 * lvl());',
      '  col += fire(0.8 + 0.4 * uLight) * (line(p.y - wv, 0.003) + 0.25 * glowl(p.y - wv, 0.01)) * (0.05 + 0.1 * uPunch * uFlash) * uFr;',
      '  gl_FragColor = vec4(min(col, vec3(4.0)), 1.0);',
      '}',
    ],
    // Goom: a vortex (its eye placed by the balance) that turns faster near the eye and jolts on
    // the snare, zooms with the bass on the beat; three to five tentacles per section, each a
    // band's sine in its own turning frame.
    whirlpool: [
      'void main() {',
      '  vec2 C = panC() * 0.6;',
      '  vec2 p = centred(vUv) - C; float r = length(p);',
      // A snare also pumps the zoom: its jolt of the swirl alone showed 175 ms late, as the
      // feedback carried it out from the eye (round 2 pass 1).
      '  float swirl = (0.01 + 0.03 * max(uMid, 0.0) + 0.04 * uSnare) * uMotion / (r + 0.22);',
      '  float zoomF = 1.0 + (0.01 * uPace + 0.04 * max(uBass, 0.0) * uPulse + 0.03 * uPunch + 0.025 * uSnap) * uMotion * uDrift;',
      '  vec2 q = rot(p, swirl * uFr) / pow(zoomF, uFr);',
      '  q += uWarp * 0.003 * uFr * vec2(sin(p.y * 10.0 + uTime), sin(p.x * 10.0 - uTime)) * (0.5 + 0.5 * flx());',
      '  vec3 col = prev(q + C) * fade(0.84, 0.975);',
      '  float n = 3.0 + floor(varyNow(1.0) * 3.0);',
      '  for (int i = 0; i < 5; i++) {',
      '    float fi = float(i);',
      '    if (fi >= n) break;',
      '    vec2 t = rot(p, uTime * (0.18 + fi * 0.05) + fi * TAU / n);',
      '    float amp = 0.035 + spec(0.08 + fi * 0.18) * 0.12 + 0.04 * uSnap * uMotion;',
      '    float y = sin(t.x * (5.0 + fi * 1.7) + uTime * (1.3 + fi * 0.4)) * amp * smoothstep(0.0, 0.25, abs(t.x));',
      '    float ln = (line(t.y - y, 0.003 + 0.002 * lvl() + 0.003 * uShimmer * uMotion) + 0.2 * glowl(t.y - y, 0.008)) * (1.0 - smoothstep(0.15, 0.75, abs(t.x)));',
      '    col += tone(fi / max(n - 1.0, 1.0) * 2.0 - 1.0) * ln * (0.05 + (0.1 * uPunch + 0.06 * uSnap + 0.06 * uShimmer) * uFlash) * uFr;',
      '  }',
      '  col += accentC() * 0.012 * exp(-r * r * 150.0) * (0.5 + max(uBass, 0.0)) * uFr;',
      '  gl_FragColor = vec4(min(col, vec3(4.0)), 1.0);',
      '}',
    ],
    // Krash: colour carried along a curl-noise flow that stirs harder with the flux; two to four
    // silk strands of the waveform per section, spread by the stereo width, thicker on the kick,
    // swaying and swelling on the beat, as bold as the passage is exposed. The strands sway, swell
    // and stir the flow as far as the passage is loud, in their harmony's distinct hues, over a
    // dark ground: long trails of one hue, washed with white, read as an olive fog, and a strand
    // held still burnt in brighter than a moving one, so the loud parts went dark (analysis pass
    // 3: r -0.18 on techno from 12 s).
    silk: [
      'void main() {',
      '  vec2 p = centred(vUv);',
      '  float ld = 0.35 + 0.65 * loud();',
      '  vec2 v = curl(p * (1.2 + 1.2 * varyNow(1.0)) + uTime * 0.05) * (0.0012 + 0.002 * uWarp * (0.5 + 0.5 * flx()) + 0.004 * uPulse * uMotion) * ld * uFr;',
      '  vec3 col = prev(p - v) * fade(0.8, 0.95);',
      '  float n = 2.0 + floor(varyNow(2.0) * 3.0);',
      '  for (int i = 0; i < 4; i++) {',
      '    float fi = float(i);',
      '    if (fi >= n) break;',
      '    vec2 t = rot(p - panC() * 0.5, uTime * 0.06 + (uTurn * 0.4 + 0.12 * uPulse * (fi - 1.5)) * uMotion + fi * PI / n * (0.6 + 0.8 * uSpread));',
      '    float y = (wave(t.x * 0.7 + 0.5) * (0.03 + 0.045 * lvl()) + 0.03 * sin(t.x * 3.0 + uTime + fi)) * (0.5 + 0.5 * ld + (0.9 * uPulse + 0.7 * min(uKick, 1.0) + 0.5 * uSnap) * uMotion * ld);',
      '    float ln = (line(t.y - y, (0.0032 + 0.0016 * uExpo) * (1.0 + 0.6 * uPulse) + (0.006 * uKick + 0.003 * uShimmer) * uMotion) + 0.25 * glowl(t.y - y, 0.006)) * (1.0 - smoothstep(0.3, 0.75, abs(t.x)));',
      '    vec3 ink = even(mix(tone(fi / max(n - 1.0, 1.0) * 2.0 - 1.0), accentC(), 0.4 * uPunch));',
      '    col += mix(ink, vec3(1.0), 0.06 + 0.1 * uLight) * ln * (0.045 + 0.03 * uExpo + 0.04 * uPunch * uFlash) * uFr;',
      '  }',
      '  col += deep(0.0002) * uFr;',
      '  gl_FragColor = vec4(min(col, vec3(3.0)), 1.0);',
      '}',
    ],
  };

  // MilkDrop 2's composite: prism fringes that widen with the glow, the kick and the stereo, and
  // a kaleidoscope of this section's fold count that folds in on a big event, over the bloom.
  var PRISM_COMPOSITE = BLOOM.concat([
    'vec2 kal(vec2 uv, float n) {',
    '  vec2 p = centred(uv); float r = length(p), s = TAU / n;',
    '  float a = atan(p.y, p.x) + uTime * 0.03 + uTurn * s * 0.5 * uMotion;',
    '  a = abs(mod(a, s) - s * 0.5); return uncentred(vec2(cos(a), sin(a)) * r);',
    '}',
    'void main() {',
    '  vec2 uv = kal(vUv, 3.0 + floor(varyNow(2.0) * 5.0));',
    '  vec2 off = (uv - 0.5) * (0.003 + 0.01 * uGlow * (0.4 + (uKick + 0.8 * uShimmer) * uMotion) + 0.006 * uSpread);',
    '  vec3 c = vec3(texture2D(uTex, uv + off).r, texture2D(uTex, uv).g, texture2D(uTex, uv - off).b);',
    '  c += bloom(uv) * 0.5 * uGlow;',
    '  gl_FragColor = vec4(finish(c, vUv), 1.0);',
    '}',
  ]);

  // ---- Shader modes. -----------------------------------------------------------------------------

  var SHADER = {
    // Tripex: a neon tunnel flown through at the tempo's pace, its cross-section morphing per
    // section (round to square), its walls bulging with the spectrum nearest you, its rings lit
    // by the bands; a big event sends a ring of light down it; fog in the key, the light at its
    // end in the accent; sparks on the hats.
    hyperloop: [
      'void main() {',
      '  vec2 p = (centred(vUv) - panC() * 0.4) * (1.0 - (0.1 * uPunch + 0.06 * uSnap) * uMotion);',
      '  float k = mix(2.0, 6.0, vary(1.0));',
      '  float r = pow(pow(abs(p.x), k) + pow(abs(p.y), k) + 1e-9, 1.0 / k) + 1e-4;',
      '  float a = atan(p.y, p.x);',
      '  float depth = 0.3 / r;',
      '  r *= 1.0 - 0.18 * spec(abs(a) / PI) * exp(-depth * 0.35);',
      '  depth = 0.3 / r;',
      '  float z = depth + uTravel * 1.4;',
      // A snare twists the tunnel for a moment.
      '  a += 0.25 * sin(uBar * TAU) * uMotion * uPace * depth * 0.3 + (uTurn * TAU / 16.0 + 0.3 * uSnap) * uMotion;',
      '  float ringId = floor(z * 2.0); float ring = fract(z * 2.0);',
      '  float edge = smoothstep(0.43, 0.5, abs(ring - 0.5)) + 0.25 * smoothstep(0.25, 0.5, abs(ring - 0.5));',
      '  float segs = 8.0 + floor(vary(2.0) * 3.0) * 4.0;',
      '  float tw = a / TAU * segs + ringId * 0.5;',
      '  float seg = smoothstep(0.43, 0.5, abs(fract(tw) - 0.5));',
      // A snare lights the rings, the hats the segments between them (neither drew: round 2
      // pass 1).
      '  float lit = 0.25 + 0.5 * uExpo + (0.9 * spec(fract(ringId * 0.137)) + 0.5 * uSnap) * uFlash;',
      '  vec3 col = tone(sin(ringId * 0.7)) * (edge * lit + seg * 0.3 * (0.45 + (0.15 * uHat + 0.6 * uShimmer) * uFlash));',
      '  col += accentC() * exp(-abs(depth - 0.4 - uShock * 3.0) * 14.0) * exp(-uShock * 2.5) * (0.3 + 0.4 * uFlash);',
      '  col = mix(col, deep(0.025), 1.0 - exp(-depth * 0.16));',
      '  col += accentC() * exp(-r * r * 90.0) * (0.35 + 0.4 * max(uBass, 0.0));',
      '  vec2 g = vec2(a / TAU * 48.0, z * 5.0);',
      '  float star = step(0.986 - 0.012 * uHat - 0.03 * uShimmer, hash(floor(g))) * (1.0 - smoothstep(0.0, 0.45, length(fract(g) - 0.5)));',
      '  col += mix(vec3(1.0), tone(1.0), 0.4) * star * 0.8 * smoothstep(0.08, 0.4, r);',
      '  gl_FragColor = vec4(finish(col, vUv), 1.0);',
      '}',
    ],
    // Jheriko: a garden of polar roses on a ground of the key's colour, one per layer, each with
    // this section's petal count (the shapes blend into the next section's), swelling with its
    // band and blooming on the beat, turning a petal per bar, in a plane the flux warps.
    garden: [
      'void main() {',
      '  vec2 p = centred(vUv) * 1.15 - panC() * 0.4;',
      '  p += 0.03 * vec2(fbm(p * 3.0 + uTime * 0.2) - 0.5, fbm(p * 3.0 - uTime * 0.2 + 4.0) - 0.5) * (0.4 + flx());',
      '  float r = length(p), a = atan(p.y, p.x);',
      '  vec3 col = deep(0.008) * (0.4 + 2.0 * fbm(p * 2.0 + uTime * 0.04));',
      '  int layers = int(3.0 + uDetail * 3.0);',
      '  float mo = smoothstep(0.0, 1.0, uMorph);',
      '  for (int i = 0; i < 9; i++) {',
      '    if (i >= layers) break;',
      '    float fi = float(i);',
      '    float s = spec(fi / 9.0 + 0.03);',
      '    float dir = mod(fi, 2.0) * 2.0 - 1.0;',
      '    float kN = 3.0 + floor(h1(fi * 7.3 + uVariant * 97.0) * 6.0);',
      '    float kP = 3.0 + floor(h1(fi * 7.3 + uPrevVariant * 97.0) * 6.0);',
      // The petals swing as far as the passage is loud and kick out on the kick, and the roses
      // run through the whole harmony, one hue to each, as bright as each other: one blue rose,
      // as large in a quiet passage as in a loud one, read the same in both (analysis pass 3).
      '    float ph = (uTime * (0.25 + fi * 0.04) + step(0.5, uMotion) * uBar * TAU / kN + 0.2 * uPulse * uMotion) * dir;',
      '    float sw = 0.03 * (1.0 + s * 2.0) * (0.45 + 0.75 * loud()) * (1.0 + (0.4 * uPulse + 0.5 * min(uKick, 1.0)) * uMotion);',
      '    float base = (0.09 + fi * 0.052) * (0.9 + 0.15 * loud()) + 0.01 * max(uBass, 0.0) * uMotion;',
      '    float R = base + sw * mix(cos(kP * (a + ph)), cos(kN * (a + ph)), mo);',
      '    vec3 ink = even(mix(tone(fi / max(float(layers) - 1.0, 1.0) * 2.0 - 1.0), accentC(), 0.3 * smoothstep(5.0, 8.0, fi)));',
      '    col += ink * (0.0016 + s * 0.003) / (abs(r - R) + 0.0035) * (0.3 + 0.25 * loud() + 0.3 * uPunch * uFlash);',
      '  }',
      '  col += accentC() * 0.12 * exp(-r * r * 30.0) * (0.4 + 0.6 * uExpo + 0.3 * max(uBass, 0.0) * uFlash);',
      '  gl_FragColor = vec4(finish(col, vUv), 1.0);',
      '}',
    ],
    // Rovastar: a kaleidoscopic fractal of stained-glass panes, folded by the symmetry and
    // stepping half a sector on a big event, its fold offsets this section's: each pane coloured
    // by the fold that came closest and glowing with its band, rays through the glass, leading
    // that glints on the beat.
    cathedral: [
      'void main() {',
      '  vec2 cp = centred(vUv) - panC() * 0.3;',
      '  vec2 p = cp * 1.5 / uZoom * (1.0 - 0.06 * uPunch * uMotion);',
      '  float n = floor(uSymmetry);',
      '  float r = length(p), a = atan(p.y, p.x); float s = TAU / n;',
      '  a = abs(mod(a + uTime * 0.04 + uTurn * s * 0.5 * uMotion, s) - s * 0.5);',
      '  p = vec2(cos(a), sin(a)) * r;',
      '  float o1 = 0.36 + 0.12 * vary(1.0), o2 = 0.18 + 0.12 * vary(2.0), tw = 0.42 + 0.3 * vary(3.0);',
      '  float trap = 10.0, lead = 10.0, id = 0.0, scale = 1.0;',
      '  for (int i = 0; i < 7; i++) {',
      '    float fi = float(i);',
      '    p = abs(p) - vec2(o1 + 0.04 * sin(uTime * 0.2), o2 + 0.05 * max(uBass, 0.0) * uMotion);',
      '    p = rot(p, tw + 0.06 * sin(uTime * 0.13 + fi) + max(uMid, 0.0) * 0.06 * uMotion);',
      '    p *= 1.25; scale *= 1.25;',
      '    float d = length(p) / scale;',
      '    if (d < trap) { trap = d; id = fi; }',
      '    lead = min(lead, abs(p.y) / scale);',
      '  }',
      '  float b = spec(id / 7.0);',
      '  vec3 glass = tone(sin(id * 1.9 + trap * 9.0)) * (0.07 + b * 0.6) * exp(-trap * 7.0);',
      '  float ca = atan(cp.y, cp.x);',
      // The rays light the middle and the outer panes recede, so the eye has a centre: lit evenly
      // to the edges the tiling read cluttered (round 2 pass 1).
      '  glass *= 0.12 + (0.7 + 0.6 * sin(ca * n * 2.0 + uTime * 0.3)) * exp(-length(cp) * 2.6);',
      '  float ld = 1.0 - smoothstep(0.0, 0.007, lead);',
      '  vec3 col = glass * (1.0 - ld * 0.9) + mix(vec3(1.0, 0.92, 0.75), accentC(), 0.4) * ld * (0.006 + (0.3 * uPunch + 0.1 * uPulse) * uFlash);',
      '  col += accentC() * 0.14 * (0.3 + 0.6 * uExpo + 0.3 * max(uBass, 0.0) * uFlash) * exp(-dot(cp, cp) * 8.0);',
      '  gl_FragColor = vec4(finish(col * 1.1, vUv), 1.0);',
      '}',
    ],
    // Flexi: liquid metal, eight blobs orbiting on this section's paths, sized by their bands and
    // swelling on the beat, apart as wide as the stereo, reflecting a studio of the key's
    // colours: two soft boxes (the key and the leading note), the voices' colour along the
    // horizon, a highlight rougher as the sound is noisier.
    mercury: [
      'float field(vec2 p, out vec2 g) {',
      '  float f = 0.0; g = vec2(0.0);',
      // The blobs fly apart and swell as far as the passage is loud, and every other one is
      // thrown out on the kick: on fixed orbits at one size the metal looked the same quiet and
      // loud (analysis pass 3).
      '  float ld = loud();',
      '  float orbit = (0.2 + 0.08 * uSpread + 0.06 * vary(1.0)) * (0.7 + 0.45 * ld);',
      '  vec2 C = panC() * 0.4;',
      '  for (int i = 0; i < 8; i++) {',
      '    float fi = float(i);',
      '    float ph = vary(2.0 + fi) * 2.0;',
      '    float kick = 1.0 + 0.25 * min(uKick, 1.0) * mod(fi, 2.0) * uMotion;',
      '    vec2 c = C + vec2(sin(uTime * (0.31 + fi * 0.07) + fi * 1.7 + ph), cos(uTime * (0.27 + fi * 0.05) + fi * 2.3 + ph)) * orbit * kick;',
      '    float rr = (0.045 + 0.02 * ld) + spec(fi / 8.0 + 0.03) * 0.06 * uDetail + (0.015 * max(uBass, 0.0) + 0.025 * uPulse + 0.015 * uPunch) * uMotion;',
      '    vec2 d = p - c; float q = dot(d, d) + 1e-4;',
      '    float w = rr * rr / q;',
      '    f += w; g -= 2.0 * w / q * d;',
      '  }',
      '  return f;',
      '}',
      'void main() {',
      '  vec2 p = centred(vUv);',
      '  vec2 g; float f = field(p, g);',
      '  vec3 n = normalize(vec3(-g / max(f * f, 1e-3) * 0.035, 1.0));',
      '  float inside = smoothstep(0.96, 1.06, f);',
      '  vec3 R = reflect(vec3(0.0, 0.0, -1.0), n);',
      '  vec3 env = mix(deep(0.12), tone(0.4) * 0.85, smoothstep(-0.3, 0.9, R.y));',
      '  env += accentC() * 1.4 * smoothstep(0.75, 0.95, dot(R, normalize(vec3(-0.6, 0.5, 0.6))));',
      '  env += tone(-0.8) * 1.2 * smoothstep(0.8, 0.97, dot(R, normalize(vec3(0.7, 0.3, 0.5))));',
      '  env += uNoteCol * 0.35 * smoothstep(0.3, -0.2, abs(R.y));',
      '  float fres = pow(1.0 - n.z, 2.0);',
      '  vec3 L = normalize(vec3(-0.5 + uPan, 0.7, 0.6));',
      '  float sp = pow(max(dot(R, L), 0.0), 80.0 / (1.0 + 3.0 * uRough));',
      '  vec3 metal = mix(vec3(0.04), env, 0.45 + fres * 0.55) + vec3(sp) * (0.8 + uPunch * uFlash * 1.2);',
      '  vec3 halo = tone(uLight * 2.0 - 1.0) * pow(min(f, 1.0), 3.0) * 0.12 * uGlow;',
      '  vec3 col = mix(halo + deep(0.006), metal, inside);',
      '  gl_FragColor = vec4(finish(col, vUv), 1.0);',
      '}',
    ],
    // Martin: a flight at the tempo's pace down the corridor of a folded Menger lattice whose
    // fold angle is this section's and breathes with the bass; a roll over the bar, the camera
    // placed by the balance; the edges glow in the accent with the treble, the fog is the key,
    // a big event sends a wall of light down the corridor.
    fold: [
      'float gRot;',
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
      '    p.xy = rot(p.xy, gRot);',
      '    p = p * 3.0 - 2.0;',
      '    if (p.z < -1.0) p.z += 2.0;',
      '    s *= 3.0;',
      '  }',
      '  return length(max(abs(p) - 1.0, 0.0)) / s;',
      '}',
      'void main() {',
      '  gRot = 0.08 + 0.08 * vary(1.0) + (0.05 * max(uBass, 0.0) + 0.04 * uPulse) * uMotion;',
      '  vec2 sp = centred(vUv);',
      '  vec3 ro = vec3(0.12 * sin(uTime * 0.11) + uPan * 0.15, 0.1 * cos(uTime * 0.13), uTravel * 0.5);',
      '  vec3 rd = normalize(vec3(rot(sp, uTime * 0.04 + 0.12 * sin(uBar * TAU) * uMotion * uPace), 1.2));',
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
      // Saturated panes on a dark ground, deep occlusion in the lattice's recesses and a rim of the
      // accent where a pane turns away: it read pale, a grey wash (a browser review, 2026-11-23).
      // The panes' hue drifts along the corridor slowly (a turn of the harmony every 50 units of
      // flight, not every 18): flown at the tempo's pace, it changed the whole tunnel's colour
      // every few seconds (round 2 pass 1).
      '  vec3 hue = tone(sin(pos.z * 0.12 + pos.x * 0.6));',
      '  vec3 base = clamp(mix(vec3(dot(hue, vec3(0.333))), hue, 1.6), 0.0, 1.0) * 0.8;',
      '  float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 3.0);',
      // The recesses glow in the key's own harmony, the accent only on the rims: the accent follows
      // the leading note (a new hue every note or two) and, glowing in every recess, it outweighed
      // the panes, so the whole tunnel changed colour about once a second (round 2 pass 1).
      '  vec3 col = base * (0.03 + pow(dif, 1.6) * 0.9) * ao * ao * ao + accentC() * rim * 0.12 * ao;',
      '  col += even(tone(-0.7)) * (1.0 - ao) * 0.3 * (0.4 + 0.4 * max(uHigh, 0.0) * uFlash);',
      '  col = mix(deep(0.02), col, exp(-t * 0.38));',
      '  col += accentC() * exp(-abs(t - uShock * 4.0) * 2.5) * exp(-uShock * 1.5) * 0.35 * (0.4 + 0.6 * uFlash);',
      '  gl_FragColor = vec4(finish(col * 0.42, vUv), 1.0);',
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
  // The reef lit from the top left: its growth in the key's palette (young edges towards the
  // accent while a big event rings), wet highlights, a dark sea of the key between.
  var REEF_SHOW = [
    'uniform sampler2D uState; uniform vec2 uSim;',
    'void main() {',
    '  vec2 px = 1.0 / uSim;',
    '  vec2 uv = (vUv - 0.5) * (1.0 - (0.015 * uPulse + 0.03 * uPunch) * uMotion) + 0.5;',
    '  float b = texture2D(uState, uv).g;',
    '  float bx = texture2D(uState, uv + vec2(px.x, 0.0)).g - texture2D(uState, uv - vec2(px.x, 0.0)).g;',
    '  float by = texture2D(uState, uv + vec2(0.0, px.y)).g - texture2D(uState, uv - vec2(0.0, px.y)).g;',
    '  vec3 n = normalize(vec3(-bx * 3.0, -by * 3.0, 1.0));',
    '  float light = clamp(dot(n, normalize(vec3(-0.4, 0.6, 0.7))), 0.0, 1.0);',
    '  float v = smoothstep(0.08, 0.4, b);',
    // The growth runs through all three hues of its triad, thin film to thick coral: in one hue
    // band (an analogous palette over half its range) the reef read monotone pink (round 2 pass 1).
    // Not evened: the thick growth of a loud passage is the brighter hue, and evened the reef no
    // longer brightened with the chorus (2.4x before, 1.2x evened).
    '  vec3 ink = mix(tone(b * 4.0 - 1.0), accentC(), 0.6 * uPunch * smoothstep(0.02, 0.2, length(vec2(bx, by))));',
    '  vec3 col = mix(deep(0.008), ink, v) * (0.35 + 0.9 * light);',
    '  col += pow(light, 24.0) * v * (0.4 + 0.3 * uLight);',
    '  gl_FragColor = vec4(finish(col, vUv), 1.0);',
    '}',
  ];

  // ---- Scenes. -----------------------------------------------------------------------------------

  // The sky behind the 3D scenes, drawn first at the far plane: the key's colour low, darker
  // high, a sun in the leading note's colour whose halo reaches as far as the treble.
  var SKY_VS = [
    'varying vec2 vUv;',
    'void main() { vUv = uv; gl_Position = vec4(position.xy, 0.9999, 1.0); }',
  ].join('\n');
  var SKY = [
    'void main() {',
    '  vec2 p = centred(vUv);',
    '  vec3 c = mix(deep(0.025), deep(0.002), smoothstep(-0.3, 0.5, p.y));',
    '  c += accentC() * 0.3 * exp(-length(p - vec2(0.0, 0.14)) * (9.0 - 4.0 * uHalo));',
    '  gl_FragColor = vec4(finish(c, vUv), 1.0);',
    '}',
  ];

  // WhiteCap: the spectrum's last seconds as a terrain running away to the horizon, its ridges
  // drawn as lines of light in the key's palette (low bands on one side of the key's hue, high on
  // the other), peaks in the accent; as wide as the stereo, placed by the balance.
  var TIDAL_VS = [
    'attribute vec2 grid;',
    'uniform sampler2D uHist; uniform float uHead, uTime, uKick, uSnap, uPulse, uMotion, uPan, uSpread;',
    'varying float vH; varying float vDepth; varying float vBand; varying float vRow; varying vec2 vUv;',
    'void main() {',
    '  float band = grid.x / 47.0; float row = grid.y / 63.0;',
    '  float tv = fract(uHead - grid.y / 64.0 + 0.5 / 64.0);',
    '  float h = texture2D(uHist, vec2(band * (47.0 / 48.0) + 0.5 / 48.0, tv)).r;',
    '  float x = (band - 0.5) * 2.4 * (0.85 + 0.3 * uSpread) + uPan * 0.8;',
    // A snare heaves the land (it drew no snare: round 2 pass 1).
    '  float y = h * (0.42 + (uKick * 0.3 + uPulse * 0.35 + uSnap * 0.3) * uMotion) + (0.025 + 0.03 * uSnap * uMotion) * sin(x * 3.0 + uTime + row * 6.0);',
    '  vH = h; vDepth = row; vBand = band; vRow = grid.y; vUv = vec2(0.0);',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(x, y, -row * 3.2, 1.0);',
    '}',
  ].join('\n');
  var TIDAL = [
    'varying float vH; varying float vDepth; varying float vBand; varying float vRow;',
    'void main() {',
    '  float fade = (1.0 - vDepth); fade *= fade;',
    '  float ridge = 1.0 - smoothstep(0.0, fwidth(vRow) * 1.5, abs(fract(vRow + 0.5) - 0.5));',
    '  float bb = vBand * 47.0 / 4.0;',
    '  float rib = 1.0 - smoothstep(0.0, fwidth(bb) * 1.2, abs(fract(bb + 0.5) - 0.5));',
    '  vec3 ink = tone(vBand * 2.0 - 1.0);',
    '  vec3 c = deep(0.006 + vH * 0.08) + ink * (ridge * (0.25 + vH * 1.6) + rib * 0.08 * (0.2 + vH));',
    '  c += accentC() * smoothstep(0.5, 1.0, vH) * ridge * (0.5 + 0.4 * uFlash);',
    // The hats glint on a scattered fifth of the ridge cells.
    '  float glint = step(0.8, hash(vec2(floor(vBand * 47.0), floor(vRow) + floor(uTime * 17.0))));',
    '  c += ink * ridge * glint * 0.9 * uShimmer * uFlash;',
    '  c = mix(deep(0.006), c, fade);',
    '  gl_FragColor = vec4(finish(c, gl_FragCoord.xy / uRes), 1.0);',
    '}',
  ];

  // Morphyre: a sphere pushed out of shape (this section's directions, the bands, the spectrum
  // from low at the bottom to high at the top), in iridescent chrome: a thin film shifting
  // around the key's hue, soft boxes in the key and the accent, rougher as the sound is noisier.
  var CHROME_VS = [
    'uniform float uTime, uBass, uMid, uHigh, uLevel, uPulse, uPunch, uWarp, uMotion, uReact, uVariant, uPrevVariant, uMorph, uSpecMean;',
    'uniform sampler2D uSpec;',
    'varying vec3 vPos; varying vec3 vNorm; varying float vDisp; varying vec2 vUv;',
    'float h1(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }',
    'vec3 dirOf(float v, float k) { return normalize(vec3(h1(v * 91.7 + k), h1(v * 91.7 + k + 1.0), h1(v * 91.7 + k + 2.0)) - 0.5); }',
    'vec3 dir(float k) { return normalize(mix(dirOf(uPrevVariant, k), dirOf(uVariant, k), smoothstep(0.0, 1.0, uMorph))); }',
    // The push out of shape in the direction n of the sphere.
    'float disp(vec3 n) {',
    // As loud as the passage is: the level against its last seconds (1 at its usual level).
    '  float lv = clamp(1.0 + uLevel, 0.25, 1.75);',
    '  float d = sin(dot(n, dir(1.0)) * 3.2 + uTime * 1.1) * (0.03 + 0.03 * lv + max(uBass, 0.0) * 0.14);',
    '  d += sin(dot(n, dir(4.0)) * 5.5 - uTime * 1.6) * (0.015 + 0.015 * lv + max(uMid, 0.0) * 0.08);',
    '  d += sin(dot(n, dir(7.0)) * 9.0 + uTime * 2.3) * (0.005 + 0.005 * lv + max(uHigh, 0.0) * 0.04);',
    // The spectrum's relief against its mean: a dense passage lifts every band to the top, and
    // drawn as it was it only swelled the sphere evenly, which does not move.
    // Smoothed over about ten bands: band by band, its ridges were as fine as the mesh and drew
    // zigzags along them; over four, a ridge still rose within a few triangles and its silhouette
    // and reflections were serrated (round 2 pass 1).
    '  float u = n.y * 0.5 + 0.5, sp = 0.0;',
    '  for (int i = -4; i <= 4; i++) sp += texture2D(uSpec, vec2(u + float(i) * 0.025, 0.25)).r * (5.0 - abs(float(i)));',
    '  sp /= 25.0;',
    '  return d + (0.4 * sp + 0.6 * (sp - uSpecMean) * 3.0 * lv) * 0.12 * uWarp * min(uReact, 1.5);',
    '}',
    'vec3 surf(vec3 n, out float d) { d = disp(n); return n * (1.0 + d + (0.09 * uPulse + 0.05 * uPunch) * uMotion); }',
    'void main() {',
    '  vec3 n = normalize(position);',
    '  float d, d1, d2;',
    '  vec3 P = surf(n, d);',
    // The normal of the displaced surface itself, from two neighbours a step away along it: the
    // face normals of the triangles (dFdx/dFdy in the fragment shader) made the reflections a
    // faceted mosaic under the sharp highlight (analysis pass 3).
    '  vec3 t1 = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));',
    '  vec3 t2 = cross(n, t1);',
    '  vec3 P1 = surf(normalize(n + t1 * 0.01), d1), P2 = surf(normalize(n + t2 * 0.01), d2);',
    '  vNorm = normalize(mat3(modelMatrix) * cross(P1 - P, P2 - P));',
    '  vec4 w = modelMatrix * vec4(P, 1.0);',
    '  vPos = w.xyz; vDisp = d; vUv = vec2(0.0);',
    '  gl_Position = projectionMatrix * viewMatrix * w;',
    '}',
  ].join('\n');
  var CHROME = [
    'uniform vec3 uLamp, uLamp2;',
    'varying vec3 vPos; varying vec3 vNorm; varying float vDisp;',
    'void main() {',
    '  vec3 N = normalize(vNorm);',
    '  vec3 V = normalize(cameraPosition - vPos);',
    '  if (dot(N, V) < 0.0) N = -N;',
    '  vec3 R = reflect(-V, N);',
    '  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);',
    // A studio lit as brightly in every key (even()): in blue and violet keys the metal read
    // near black, a mean luminance of 0.02 (round 2 pass 1).
    '  vec3 env = mix(deep(0.16), even(tone(0.3)) * 0.95, smoothstep(-0.5, 0.7, R.y));',
    '  env += even(tone(-0.9)) * smoothstep(0.8, 0.98, dot(R, normalize(vec3(-0.8, 0.4, 0.4))));',
    '  vec3 film = hsv(baseH() + 0.09 * cos(fres * 7.0 + vDisp * 9.0), satK(), 1.0);',
    '  float rough = 1.0 + 3.0 * uRough;',
    '  float sp = pow(max(dot(R, normalize(uLamp - vPos)), 0.0), 50.0 / rough);',
    '  float sp2 = pow(max(dot(R, normalize(uLamp2 - vPos)), 0.0), 30.0 / rough) * (0.3 + 0.7 * uSpread);',
    '  vec3 c = env * (0.35 + fres * 1.2 * uGlow) * mix(vec3(1.0), film, 0.6) + vec3(sp) * (0.9 + uPunch * uFlash * 1.5) + accentC() * sp2;',
    '  gl_FragColor = vec4(finish(c, gl_FragCoord.xy / uRes), 1.0);',
    '}',
  ];

  // UnConeD's Whacko AVS: a choir of points that morphs between a sphere, a torus knot, a helix
  // and a torus, a new shape for each section and every 32 beats; every point is one of the
  // twelve voices (pitch classes), lit and swelling while its note sounds, and swells with its
  // band; the cloud breathes on the beat and spreads with the stereo.
  var CHOIR_VS = [
    'attribute vec2 seed;',
    'uniform float uPixel, uCount, uBeats, uKick, uPulse, uPunch, uSnap, uShimmer, uMotion, uVariant, uPrevVariant, uMorph, uReact, uSpread, uFlash;',
    'uniform float uChroma[12];',
    'uniform sampler2D uSpec;',
    'varying float vU; varying float vS; varying float vK; varying float vPc; varying vec2 vUv;',
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
    'vec3 torus(float u, float v) {',
    '  float a = u * 6.2831853 * 23.0, b = u * 6.2831853;',
    '  return vec3((0.7 + 0.25 * cos(a)) * cos(b), 0.25 * sin(a), (0.7 + 0.25 * cos(a)) * sin(b));',
    '}',
    'vec3 shape(float i, float u, float v) {',
    '  i = mod(i, 4.0);',
    '  return i < 0.5 ? sphere(u) : i < 1.5 ? knot(u, v) : i < 2.5 ? helix(u, v) : torus(u, v);',
    '}',
    'vec3 drift(float vi, float u, float v) {',
    '  float dr = uBeats / 32.0; float i = floor(vi * 4.0) + floor(dr);',
    '  return mix(shape(i, u, v), shape(i + 1.0, u, v), smoothstep(0.75, 1.0, fract(dr)));',
    '}',
    'void main() {',
    '  float u = seed.x; float sp = texture2D(uSpec, vec2(fract(u * 3.0), 0.25)).r * uReact;',
    '  int pc = int(mod(floor(u * 60.0), 12.0));',
    '  float k = uChroma[pc];',
    '  vec3 pos = mix(drift(uPrevVariant, u, seed.y), drift(uVariant, u, seed.y), smoothstep(0.0, 1.0, uMorph));',
    '  pos *= 1.0 + sp * 0.25 + k * 0.06 + (0.1 * uPulse + 0.08 * uPunch + 0.06 * uSnap) * uMotion;',
    '  pos.x *= 1.0 + 0.3 * uSpread;',
    '  vec4 mv = modelViewMatrix * vec4(pos, 1.0);',
    // The hats twinkle a scattered quarter of the voices, another quarter each eighth of a beat.
    '  float tw = step(0.75, fract(sin(u * 9187.3 + floor(uBeats * 8.0) * 17.1) * 43758.5));',
    '  gl_PointSize = (2.2 + sp * 5.0 + k * 3.0 + (uKick * 2.0 + uSnap * 1.2) * uMotion * uFlash + tw * 3.0 * uShimmer * uFlash) * uPixel * (3.0 / -mv.z);',
    '  vU = u; vS = sp; vK = k; vPc = float(pc); vUv = vec2(0.0);',
    '  gl_Position = projectionMatrix * mv;',
    '}',
  ].join('\n');
  var CHOIR = [
    'varying float vU; varying float vS; varying float vK; varying float vPc;',
    'void main() {',
    '  vec2 c = gl_PointCoord - 0.5; float d = dot(c, c);',
    '  if (d > 0.25) discard;',
    '  vec3 col = mix(tone(sin(vU * 12.0)), note(int(vPc + 0.5)), 0.3 + 0.6 * vK) * exp(-d * 12.0) * (0.3 + vS * 0.9 + vK * 0.9);',
    '  gl_FragColor = vec4(pow(aces(col * uExpo * 0.9), vec3(0.4545)), 1.0);',
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
    SHARED.forEach(function (k) { u[k] = { value: 0 }; });
    u.uChroma = { value: new Float32Array(12) };
    u.uNoteCol = { value: new THREE.Vector3() };
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
  /** A render target; `mips` keeps a mipmap chain (a feedback buffer's bloom reads it). */
  function target(ctx, w, h, wrap, mips) {
    var rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      type: ctx.half ? THREE.HalfFloatType : THREE.UnsignedByteType,
      minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: !!mips,
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
      var w = pass(ctx, FEED.concat(warp).join('\n'), { uPrev: { value: null } });
      var c = pass(ctx, (composite || COMPOSITE).join('\n'), { uTex: { value: null } });
      var a = null, b = null;
      function make(W, H) {
        if (a) { a.dispose(); b.dispose(); }
        a = target(ctx, W, H, false, true);
        b = target(ctx, W, H, false, true);
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

  /** The section's value crossfaded from the last one's (the scenes' camera paths). */
  function varied(m) { return m.prevVariant + (m.variant - m.prevVariant) * m.morph; }

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

    // Gray-Scott on a small grid: where in its pattern-forming crescent it sits (spots to coral)
    // is this section's place plus the passage's energy, changed only on the bar line; a big
    // event seeds new growth where the sound stands, a noisy sound scatters fine seeds.
    reef: function (ctx) {
      var init = pass(ctx, REEF_INIT.join('\n'), { uSim: { value: new THREE.Vector2(1, 1) } });
      var sim = pass(ctx, REEF_STEP.join('\n'), {
        uState: { value: null }, uSim: { value: new THREE.Vector2(1, 1) },
        uSeed: { value: new THREE.Vector4(0, 0, 0, 0) }, uFeed: { value: 0.046 }, uKill: { value: 0.063 },
      });
      var show = pass(ctx, REEF_SHOW.join('\n'), { uState: { value: null }, uSim: { value: new THREE.Vector2(1, 1) } });
      var a = null, b = null, detail = -1, bar = 0, axis = 0.4, along = 0.4, punch = 0;
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
          var m = s.m;
          // The bar line: the next place on the crescent (mitosis 0 .. coral 1).
          if (an.bar < bar - 0.5) axis = Math.max(0, Math.min(1, 0.15 + 0.6 * m.variant + 0.35 * Math.max(0, m.drive.energy)));
          bar = an.bar;
          along += (axis - along) * (1 - Math.exp(-an.dt / 1.5));
          sim.u.uFeed.value = 0.0367 + (0.0545 - 0.0367) * along;
          sim.u.uKill.value = 0.0649 + (0.062 - 0.0649) * along;
          var rise = m.punch > punch + 0.2 && s.params.react > 0;
          punch = m.punch;
          var steps = Math.max(1, Math.min(16, Math.round(7 * s.params.speed * ctx.pace * ctx.pace)));
          for (var i = 0; i < steps; i++) {
            if (i === 0 && rise) sim.u.uSeed.value.set(0.5 + m.pan * 1.6 + (Math.random() - 0.5) * (0.3 + 0.6 * m.spread), Math.random(), 0.03 + 0.03 * Math.max(0, m.drive.bass), 0);
            else if (i === 0 && an.hat > 0.9 && m.rough > 0.3 && s.params.react > 0) sim.u.uSeed.value.set(Math.random(), Math.random(), 0.008, 0);
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
      // A surface of the grid: two triangles per cell, the depth test hiding the far ridges.
      var grid = new Float32Array(COLS * ROWS * 2);
      var index = [];
      for (var r = 0; r < ROWS; r++) {
        for (var i = 0; i < COLS; i++) {
          grid[(r * COLS + i) * 2] = i;
          grid[(r * COLS + i) * 2 + 1] = r;
          if (i < COLS - 1 && r < ROWS - 1) {
            var o = r * COLS + i;
            index.push(o, o + 1, o + COLS, o + 1, o + COLS + 1, o + COLS);
          }
        }
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COLS * ROWS * 3), 3));
      geo.setAttribute('grid', new THREE.BufferAttribute(grid, 2));
      geo.setIndex(index);
      var mat = new THREE.ShaderMaterial({ vertexShader: TIDAL_VS, fragmentShader: PRELUDE + TIDAL.join('\n'),
        uniforms: Object.assign({}, ctx.U, { uHist: { value: tex }, uHead: { value: 0 } }),
        side: THREE.DoubleSide, depthTest: true, depthWrite: true });
      var land = new THREE.Mesh(geo, mat);
      land.frustumCulled = false;
      var st = stage(ctx, 55);
      st.scene.add(land);
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
          var m = s.m, U = ctx.U;
          // The camera: this section's height and side, a sway at the tempo's pace, a swing on
          // the downbeat and a push on a big event (both held back under reduced motion).
          var v = varied(m), t = U.uTime.value;
          var back = st.fit() / s.params.zoom;
          // The beat and the kick dip the camera towards the ridges (the beat barely showed with
          // the downbeat and the big events alone).
          var swing = ((m.barPulse * 0.06 + m.punch * 0.1 + m.snap * 0.15) * Math.min(1, react)
            + U.uPulse.value * 0.16 + Math.min(1, U.uKick.value) * 0.1) * m.motion;
          st.cam.position.set(Math.sin(t * 0.07) * 0.3 + (v - 0.5) * 0.6, 0.65 + 0.35 * v + 0.1 * Math.sin(t * 0.05), 0.35 + 0.5 * back - swing);
          st.cam.lookAt(0, -0.05 - swing * 0.3, -1.1);
          st.render();
        },
        resize: st.resize,
        dispose: function () { geo.dispose(); mat.dispose(); tex.dispose(); st.dispose(); },
      };
    },

    chrome: function (ctx) {
      var geo = new THREE.IcosahedronGeometry(1, ctx.small ? 24 : 48);
      var mat = new THREE.ShaderMaterial({ vertexShader: CHROME_VS, fragmentShader: PRELUDE + CHROME.join('\n'),
        uniforms: Object.assign({}, ctx.U, { uLamp: { value: new THREE.Vector3(2, 2, 3) }, uLamp2: { value: new THREE.Vector3(-2, 1, 3) },
          uSpecMean: { value: 0 } }) });
      var mesh = new THREE.Mesh(geo, mat);
      var st = stage(ctx, 45);
      st.scene.add(mesh);
      var spin = 0;
      return {
        frame: function (an, s) {
          var m = s.m, t = ctx.U.uTime.value, v = varied(m), rr = Math.min(1, s.params.react);
          var sum = 0;
          for (var i = 0; i < an.bands.length; i++) sum += an.bands[i];
          mat.uniforms.uSpecMean.value = sum / an.bands.length;
          // This section's axis of turn, turning as fast as the passage is loud (the tempo's clock
          // alone ran as fast in a quiet break as in the drop); the lights placed by the balance.
          spin += Math.max(0, Math.min(0.1, an.dt)) * ctx.pace * m.rate * s.params.speed * 0.25 * (0.6 + 0.8 * v)
            * ((1 - rr) + rr * (0.4 + 0.6 * Math.min(1.75, m.level)));
          mesh.rotation.set(Math.sin(t * 0.1) * 0.4 + v, spin, 0);
          mat.uniforms.uLamp.value.set(Math.cos(t * 0.6) * 3 + m.pan * 6, 1.5 + Math.sin(t * 0.4), Math.sin(t * 0.6) * 3);
          mat.uniforms.uLamp2.value.set(-Math.cos(t * 0.45) * 3, -1 + Math.cos(t * 0.3), 3);
          // Close enough that the metal fills a third of the frame (it read near black at 3.4).
          st.cam.position.set(0, 0, 3.0 * st.fit());
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
        uniforms: Object.assign({}, ctx.U, { uPixel: { value: 1 }, uCount: { value: 1 } }),
        transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false });
      var geo = null, points = null, density = -1, spin = 0, tilt = 0;
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
          var m = s.m, rr = Math.min(1, s.params.react);
          mat.uniforms.uPixel.value = ctx.renderer.getPixelRatio();
          // A turn and a tilt at the tempo's pace, as fast as the passage is loud (the grammar's
          // loudness: the exposure from half the song's peak to the peak): at the tempo's pace
          // alone the choir moved half as much in the loud chorus as in the verse before it
          // (round 2 pass 1). A snare gives the turn a push.
          var lk = rr * Math.max(0, Math.min(1, (m.exposure - 0.5) / 0.5)) + (1 - rr) * 0.5;
          var paced = Math.max(0, Math.min(0.1, an.dt)) * ctx.pace * m.rate * s.params.speed;
          spin += paced * (0.3 * (0.35 + 1.3 * lk) + 1.5 * m.snap * rr);
          tilt += paced * 0.13 * (0.5 + lk);
          points.rotation.set(Math.sin(tilt) * 0.5, spin, 0);
          st.cam.position.set(s.m.pan * 1.2, 0, 3.6 * st.fit());
          st.cam.lookAt(0, 0, 0);
          st.render();
        },
        resize: st.resize,
        dispose: function () { if (geo) geo.dispose(); mat.dispose(); st.dispose(); },
      };
    },
  };

  /** Adds a pitch class's colour, weighted, to out: its hue on the circle of fifths. */
  function noteRgb(pc, hueP, weight, out) {
    var h = ((((pc * 7) % 12) / 12 + hueP) % 1 + 1) % 1;
    [0, 2 / 3, 1 / 3].forEach(function (o, c) {
      out[c] += weight * Math.min(1, Math.max(0, Math.abs(((h + o) % 1) * 6 - 3) - 1));
    });
  }

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
      small: Math.min(window.innerWidth, window.innerHeight) < 600, pace: 1,
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

    // The clocks the modes share: time paced by the tempo (and slowed with the picture under
    // reduced motion), the beats counted, the age of the last big event's shockwave, the
    // symmetry steps it took, and the exposure.
    var clock = { last: 0, t: 0, travel: 0, beats: 0, phase: 0, shock: 9, punch: 0, turn: 0, turnTo: 0, expo: 0.7 };
    var noteSum = [0, 0, 0];
    function updateUniforms(a, s) {
      var p = s.params, m = s.m, U = ctx.U;
      var r = p.react, rr = Math.min(1, r);
      // Reduced motion: feedback zoom and travel at most a few percent a second.
      var drift = m.reduced ? 0.05 : 1;
      var dt = Math.max(0, Math.min(0.1, s.t - clock.last));
      clock.last = s.t;
      // The pace: the tempo's, calmer as the music falls quiet (the level against its last
      // seconds); at react 0 the resting pace.
      ctx.pace = (1 - rr) + rr * (0.3 + 0.7 * Math.min(1, m.level));
      var paced = dt * p.speed * m.rate * ctx.pace;
      clock.t += paced;
      clock.travel += dt * p.speed * m.rate * ((1 - rr) * 0.8 + rr * (0.05 + 0.7 * Math.min(1.5, m.level) + 0.8 * a.kick)) * drift;
      if (a.phase < clock.phase - 0.5) clock.beats += 1;
      clock.phase = a.phase;
      // A big event: the shockwave starts again and the symmetry takes a step.
      if (m.punch > clock.punch + 0.2 && r > 0) { clock.shock = 0; clock.turnTo += 1; }
      clock.punch = m.punch;
      clock.shock = Math.min(9, clock.shock + paced);
      clock.turn += (clock.turnTo - clock.turn) * (1 - Math.exp(-dt / 0.12));
      // Brightness rides the slow loudness only, with a limited slew; at react 0 it rests.
      var expo = rr * (0.36 + 0.6 * m.exposure) + (1 - rr) * 0.7;
      clock.expo += Math.max(-0.6 * a.dt, Math.min(0.6 * a.dt, (expo - clock.expo) * (1 - Math.exp(-a.dt / 0.3))));
      U.uTime.value = clock.t;
      U.uPace.value = ctx.pace;
      U.uBeats.value = clock.beats + a.phase;
      U.uPhase.value = a.phase;
      U.uBar.value = a.bar || 0;
      U.uTravel.value = clock.travel;
      U.uShock.value = clock.shock;
      U.uTurn.value = clock.turn;
      U.uFr.value = Math.max(0.25, Math.min(3, a.dt * 60));
      U.uBass.value = m.drive.bass;
      U.uMid.value = m.drive.mid;
      U.uHigh.value = m.drive.high;
      U.uLevel.value = m.drive.level;
      U.uFlux.value = m.drive.flux;
      U.uEnergy.value = m.drive.energy;
      U.uKick.value = Math.min(2, a.kick * r);
      U.uSnare.value = Math.min(2, a.snare * r);
      U.uHat.value = Math.min(2, a.hat * r);
      // The beat's shapes only while music sounds: the beat clock runs on through a silence.
      var heard = rr * Math.min(1, Math.max(0, (m.level - 0.1) / 0.5));
      U.uPulse.value = m.pulse * heard;
      U.uPre.value = m.pre * heard;
      U.uBarPulse.value = m.barPulse * heard;
      U.uPunch.value = m.punch * rr;
      U.uSnap.value = m.snap * rr;
      U.uShimmer.value = m.shimmer * rr;
      U.uFlash.value = m.flashGain;
      U.uMotion.value = m.motion;
      U.uDrift.value = drift;
      U.uExpo.value = clock.expo;
      U.uReact.value = Math.min(2, r);
      U.uHueK.value = m.hue;
      U.uAccent.value = m.accent;
      U.uSat.value = m.sat;
      U.uLight.value = m.light;
      U.uHueP.value = (p.hue || 0) / 360;
      U.uRough.value = m.rough;
      U.uHalo.value = m.halo;
      U.uPan.value = m.pan;
      U.uSpread.value = m.spread;
      U.uContrast.value = m.contrast;
      U.uVariant.value = m.variant;
      U.uPrevVariant.value = m.prevVariant;
      U.uMorph.value = m.morph;
      U.uWarp.value = p.warp;
      U.uTrails.value = p.trails;
      U.uGlow.value = p.glow;
      U.uZoom.value = p.zoom;
      U.uSymmetry.value = p.symmetry;
      U.uDetail.value = p.detail;
      U.uDensity.value = p.density;
      // The notes sounding, sharpened (power 2), and their mean colour.
      var ch = a.chroma || [], total = 0;
      noteSum[0] = noteSum[1] = noteSum[2] = 0;
      for (var i = 0; i < 12; i++) {
        var k = (ch[i] || 0) * (ch[i] || 0);
        U.uChroma.value[i] = k;
        total += k;
        if (k > 0.05) noteRgb(i, U.uHueP.value + U.uHueOff.value, k, noteSum);
      }
      U.uNoteCol.value.set(noteSum[0], noteSum[1], noteSum[2]).multiplyScalar(1 / Math.max(1, total));
    }

    var handle = {
      canvas: canvas,
      /** What the renderer holds on the GPU, and the share of the full resolution it draws at now
       *  (below 1 where frames ran long: a slow device, a software GPU). */
      memory: function () { return { textures: renderer.info.memory.textures, geometries: renderer.info.memory.geometries, scale: SCALES[level] }; },
      set: function (next) {
        if (next === id || !MODES[next]) return;
        if (mode) { try { mode.dispose(); } catch (e) { console.error('viz-gl: dispose ' + id, e); } }
        id = next;
        level = HEAVY[next] ? 2 : 0;
        ctx.U.uHueOff.value = PALETTE[next][0];
        ctx.U.uHarmA.value = PALETTE[next][1][0];
        ctx.U.uHarmB.value = PALETTE[next][1][1];
        slow = 0;
        calmSince = performance.now();
        // The disposed mode is forgotten before the resize: resizing it would allocate its render
        // targets again inside a mode nothing will dispose (a review, 2026-11-23).
        mode = null;
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
