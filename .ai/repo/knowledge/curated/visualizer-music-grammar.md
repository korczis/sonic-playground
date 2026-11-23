---
schema: knowledge/v1
id: visualizer-music-grammar
kind: knowledge
class: lesson
title: "How the visualiser hears music and maps it to pictures: the measured defects, the browser's limits, and the grammar every mode follows"
description: "Before changing static/js/viz-audio.js, static/js/viz-map.js or a mode in viz-2d.js / viz-gl.js, or when the pictures seem not to follow the music."
status: verified
epistemics: observed
date: 2026-11-23
tags:
  - visualiser
  - audio
  - testing
provenance:
  origin: authored
---

# How the visualiser hears music and maps it to pictures

Ordered by the owner on 2026-11-22/23 ([[owner-answers-2026-11-23]]).

## The defect, measured

The analysis read `getByteFrequencyData` with `maxDecibels -20` and smoothing 0.6, then scaled
every band to the loudest. Mastered music clips at -20 dB, so the bass bands sat pinned at the
top (0.90 +- 0.00), the spectral flux was near zero, and the onset detectors had nothing to rise
above. On a synthesized mastered mix at 124 bpm (bass line, pad, hiss, kick, snare, hats,
compressor) it found 1 of 25 kicks and no tempo. The fix (2026-11-22): a float spectrum in dB,
bands as mean bin power with a 3 dB/octave tilt, automatic gain in dB, onsets on the rise of a
range's level over 25-40 ms with robust statistics and a lift over the last second, and a tempo
only from kicks that agree and fill the beat grid. Result: 12/12 kicks, 6/6 snares, 124 bpm; a
room without music gives no tempo. The e2e checks with these signals live in test/e2e/smoke.cjs.

## The browser's limits (measured, not assumed)

- A cross-origin iframe's audio (the YouTube player) is never readable by the page without the
  reader's consent: tab capture, a screen share with system audio, or an input device.
- Tab capture works in a real Chrome window. Stopping its video track keeps the audio.
  `--mute-audio` silences the capture.
- Headless Chrome has no audio output, so captured tab audio is silent there. Tests hand
  synthesized WebAudio streams over as the microphone instead.
- Headless Chrome on a Mac reads every shown WebGL frame back ("GPU stall due to ReadPixels").
  The smoke runs with `--use-angle=metal` there ([[console-clean-by-construction]]).
- A remembered device can start only after the reader's first interaction (autoplay), and its
  label is empty until the microphone permission was granted once.

## The grammar (static/js/viz-map.js)

From research of 2026-11-23:

- **Relative levels.** Every scalar is read against its own last ~4 s, as MilkDrop and
  Butterchurn do: 1 is normal, below 0.7 quiet, above 1.3 loud. `react` scales only the swing.
- **Envelopes.** Each feature follows with its own attack and release, frame-rate independent.
- **Colour.** The hue is the key on the circle of fifths (keys a fifth apart are neighbours),
  smoothed over seconds and turned by the hue control. Saturation is the tonal clarity, lower for
  minor keys and noise. Lightness follows the timbre's brightness. The accent is the leading note.
- **Time.** Shapes are phase-locked to the beat and the bar. Big events are latched for a
  quarter beat.
- **Form.** A new section draws a new variant, crossfaded.
- **Safety.** Brightness rides the slow loudness only. Impulses move, scale and colour, and their
  brightness share falls to 0.3 after two flashes within a second (WCAG 2.3.1). Reduced motion
  caps motion and turns impulses into colour. No synchronous GPU readback is used for any of it.

Sources: Geiss, MilkDrop preset authoring guide; Butterchurn's audioLevels.js; W3C, Understanding
SC 2.3.1; Spence (2011) and Evans & Treisman (2010) on cross-modal correspondences; Klemenc et
al., Visualization of Harmony in Music with Colour; Itoh et al. (2017); EBU R 128 / Tech 3341;
Richan & Rouat (2020) on timbre visualisation; Quilez, Domain Warping; Bridson et al. (2007),
Curl-noise; MDN, prefers-reduced-motion.
