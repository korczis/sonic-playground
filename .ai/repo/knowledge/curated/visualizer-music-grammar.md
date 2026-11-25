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

## Round 2: tempo at metrical multiples, onsets by kind (2026-11-25)

Measured on the same eight recordings (the page, 75 s, 1-3 runs a recording, against one run of
95d6f38c on a machine at load 74), on pass 1's replayed novelty (r2 pass 1), and on synthetic hits
in the page.

- **Tempo.**
  - The candidate search and the relatives pick were replaced by one metrical rule: every lag of
    every range scores comb(L) + 0.5 comb(2L) + 0.5 comb(L/2), times the 120 bpm / 0.9 octave
    prior, and the best wins. An odd lag's half lies between two steps: the better of the two
    counts. Read one step short, drum and bass's 174 bpm (17.2 steps) fell from .92 to .55.
  - Octave-correct share of the locked frames, before → after: techno .32 → .83 (166 still in
    3-23% of its locked frames), dnb .14 → 1.00, rock 1.00 → 1.00, hip-hop .99 → 1.00, jazz
    .77 → .82. Jazz locked in 12.6 and 27 s (26.6 before). Drum and bass locks only .13 of its
    frames: its true lag's comb, .07-.11, rarely passes the gates.
  - A first lock needs the ranges' shared support at 0.2, not 0.16. Replayed, Vivaldi's false
    lock fell from .14 to .08 of its frames and jazz's lock from .54 to .46. On the page Vivaldi
    read .09-.15 against .17-.18, within the runs' spread (.05).
  - Reading the double's multiples beyond 4 x 40 steps, which the comb leaves at 0, changed
    nothing beyond the runs' spread.
  - Known limit: a dotted-eighth riff low enough to share the kicks' range (a 110 Hz saw) builds
    its own hierarchy (3/4, 3/2 and 3 beats), and the rule reads 2/3 of the tempo there (83 for
    124). Adding half the bass range's score fixes it, and loses dnb (.93 → .60 replayed); the
    ranges' mean loses techno and dnb. A riff in the mids, as on the techno recording, reads right.
- **Onsets.**
  - Pass 1's misses (kicks 42%, snares 57%) were the sampler's, not the detector's. It read the
    envelope at 1 only, and ran before the analysis in 37% of frames, so it saw one decayed frame
    (0.92). Over 0.5, kicks were 100% found, snares 98%, clicks 97%.
  - The real defect was the kind. Every isolated kick also counted as a snare. Its spill into a
    few of the snare's bands, out of digital silence at -160 dB, rose the range's mean by the
    capped 24 dB.
  - Each band is now floored at the picture's floor before the range's mean. The lift over the
    last second still reads the unfloored level: floored, a quiet snare just after the mix fell
    18 dB was lost while the ceiling caught up.
  - Floored, a kick's fundamental and attack still lit the snare's 200-1100 Hz bands by 10-34 dB,
    a 5-7 dB rise of the mean. A snare must therefore also rise over its bands above 1 kHz.
    Isolated kicks rose there by 0.8 dB at most, isolated snares by 11-19, and a quiet snare on a
    kick in the mastered mix by 4-6. Asked only within 30 ms of a kick, it let through a kick
    whose own onset came a frame after its spill. A plain 30 ms veto would drop every snare on two
    and four.
  - A floor 20 dB lower brought the kick-as-snare back (3 of 5 kicks).
  - The kick's level, a mean power that silent bins add nothing to, stays unfloored: floored, the
    quiet half's kicks came late while the ceiling fell, and half of them missed their window.
  - Isolated kicks counted as snares: 5 of 5 in silence and 4 of 4 over a noise floor before,
    0 after. Every hit is still found, and the mastered mix keeps all its hits with 0 stray.
- **Latency.** The two-frame rise costs nothing. A kick fires on the first frame its attack
  reaches; a snare or a click fires one frame later, because its first frame lies under the
  picture's floor. About 45-60 ms is the stream and the 43 ms window.
- **Key.** A minor bias on near ties (.01-.03) changed no excerpt's key accuracy by more than .02.
  Techno's Bb for Bbm is no tie: replayed, Bbm leads by a median .12, so the hold (0.05 for 2 s),
  not the profiles, keeps the Bb that won first (inferred, not yet measured).
- **Snares and hats drawn.**
  - The map had one impulse, on a beat or a kick. It now has two more:
    - `m.snap`, a latched snare impulse: about half a kick, decaying over 0.1 s, skipped within
      60 ms of a punch, and counted as a flash;
    - `m.shimmer`, a hat glint decaying over 0.07 s. It is not counted as a flash, so modes draw
      it as scattered light scaled by the flash gain.
  - A snare now moves all 25 modes on its own (20 before). The kick stays strongest: 25-58 ms
    from sound to frame. ripple's snare ring still takes 125 ms.
- **The flash governor counts events, and beat-locked brightness got past it.** starlane's
  streaks grew with the beat's pulse and the speed, unmetered: 3-4 flashes a second at 175 bpm,
  react 2. Everything that brightens on a beat is now multiplied by the flash gain: 0-2 a second.
- **A picture can't fix what the analysis gets wrong.** Bisected with hybrid file sets (one old
  file into a newer build), fold's and moire's drift against steady techno came from the analysis
  of 6487bee3:
  - the tempo flicked between metrical relatives (125, 166, 66, 79);
  - a new section was announced in a steady drop.
  Every mode's pace follows both. Easing the map's rate over 2 s recovered fold (+.33 to
  +.52-.66); moire waits on the tempo.
- **One 40 s run is not a measurement.** Its r(motion, loudness) varies by about +-.3 from run to
  run (veil .36-.73, choir .31-.72 across the same revisions). Repeat runs before calling a
  regression.
- **A kaleidoscope shows one wedge.** What is drawn outside the wedge it mirrors is never seen.
  prism's orbs landed there by chance, so its brightness fell when it was loud (0.84x). Folded
  into the wedge and lit by the loudness, it is now 1.85-2.04x.
- **Smoke windows.**
  - A window set against musicMic's scheduled times needs about 100 ms for the pipeline.
  - An event test must keep hats out of both of its windows.
  - A window locked to the detection lets any mode driven by the spectrum pass.
