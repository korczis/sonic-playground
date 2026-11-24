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

## Measured on real recordings (three analysis passes, 2026-11-24)

Ordered by the owner as three analysis-and-reaction passes ([[owner-answers-2026-11-24]]). The
material was eight freely licensed recordings from Wikimedia Commons (techno, hip-hop, rock,
swing jazz, drum and bass, solo piano, Beethoven, Vivaldi), against librosa references.

- **Tempo.**
  - The kick intervals were replaced by per-range novelty autocorrelation (bass, mids, highs;
    SuperFlux rises, smoothed, averaged per 20 ms step, fed only by frames with new sound on the
    audio clock). Each lag is scored by a comb over 1-4 periods with a 120 bpm prior. The best
    range's lag is weighed against its metrical relatives by the highs, and accepted only with the
    ranges' shared support and an onset rate.
  - Hip-hop went from 0% to 99% right and jazz from 27% to 55-65%. Beethoven and a room's noise
    get none.
  - Known limit: a techno track with a dotted-eighth riff wavers between related tempos (166, 125,
    83).
- **Beat phase.**
  - It is an oscillator after algoglyph's Kuramoto plate (`kernels/signal/kuramoto.ts`), but
    with proportional, near-beat-only pulls: the sine coupling held a techno track's phase on the
    off-beat.
  - It is anchored on the last kick at a lock and runs through dropouts.
- **Key.** Krumhansl-Schmuckler profiles over about 8 s, with a 0.05 / 2 s hold: 1-9 changes a
  minute instead of 9-26, and rock 85% right. A lone major triad is ambiguous between keys (F#
  read A# minor); a cadence is not. The palette's hue follows the key's root.
- **Sections.** A two-sided Page-Hinkley test, algoglyph's page-hinkley plate
  (`kernels/stochastic/page-hinkley.ts`), on six z-scored features. Offline F1 0.49-0.53 against
  0.34 for the old 3 s / 6 s contrast. Live, a spread floor of 0.03, lambda 10, 3 s to learn and
  6 s between sections keep it at 1-4 a minute.
- **Picture.**
  - The relative levels warm up with the sound (a quiet opening read 2-3x its normal).
  - The exposure reads loudness against the song's recent peak, held at -10 LUFS for the first
    30 s.
  - Sections turn the palette by up to 30 degrees.
  - A 10-minute session showed no leak: heap 7.3-7.9 MB, GL textures constant, 60 fps.

These lessons were offered back to algoglyph as its curated note
`music-analysis-from-sonic-playground` (branch `chore/knowledge-music-analysis` in
~/dev/algoglyph), with three plates they suggest: tempo-autocorrelation, key-profiles and
superflux-onsets.
