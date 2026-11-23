// Types of the site's browser code (static/js/*.js), checked by `npm run typecheck`
// (tsc --checkJs, tsconfig.json). The data shapes mirror what scripts/catalog.py and
// scripts/i18n.py derive (sonic-catalog/v1, sonic-search/v2, sonic-i18n/v1).

interface SonicTrack {
  source: string;
  path: string;
  title: string;
  artist: string;
  track: string;
  inferred: string;
  date: string;
  description: string;
  facets: { genre: string[]; sentiment: string[]; mood: string[] };
  youtube: string | null;
  video_gone: boolean;
  thumbnail: string;
  thumbnail_local: boolean;
  words: number;
  extra: Record<string, string>;
  related: { source: string; score: number; shared: string[] }[];
  /** The languages the review is in, the default first (ADR 0006). */
  langs: string[];
  /** Per language besides the default: what its translation says. */
  i18n: Record<string, { title: string; description: string; path: string }>;
}

/** How the explorer reads a word: catalog.json `search` for one language (scripts/catalog.py). */
interface SonicSearchRules {
  /** Letters NFKD does not decompose, to what they fold. */
  fold: Record<string, string>;
  /** The language's word forms (data/i18n/forms/<lang>.toml). */
  forms: { min_stem: number; suffixes: [string, string][] };
}

interface SonicTerm { term: string; slug: string; count: number }

interface SonicCatalog {
  schema: 'sonic-catalog/v1';
  /** The explorer's word reading: the fold table and every language's word forms. */
  search: { fold: Record<string, string>; forms: Record<string, SonicSearchRules['forms']> };
  stats: Record<string, number | string>;
  outline: { name: string; share: number; position: number; subsections: string[] }[];
  facets: { genre: SonicTerm[]; sentiment: SonicTerm[]; mood: SonicTerm[] };
  pairs: { genre: string; sentiment: string; count: number }[];
  months: { month: string; count: number }[];
  artists: SonicTerm[];
  lookup: Record<string, number>;
  tracks: SonicTrack[];
  languages: string[];
  /** Per language besides the default, per facet: the terms it has a page for. */
  lang_terms: Record<string, Record<string, string[]>>;
}

interface SonicApi {
  base: string;
  module(name: string, mount: () => (() => void) | null | undefined | void): void;
  unmountAll(): void;
  mountAll(): void;
  catalog(): Promise<SonicCatalog>;
  /** static/data/play.json: the catalogue's tracks projected onto what the player reads. */
  playIndex(): Promise<{ tracks: SonicTrack[] }>;
  emit(name: string, detail?: unknown): void;
  on(name: string, fn: (event: Event) => void): () => void;
  script(src: string): Promise<unknown>;
  t(key: string, vars?: Record<string, string | number>): string;
  locale(): string;
  term(kind: string, term: string): string;
  localPath(path: string): string;
  trackPath(t: { path?: string; i18n?: Record<string, { path: string }> }): string;
  termPath(kind: string, slug: string, term: string, catalog: SonicCatalog): string;
}

/** One frame's analysis of the sound (static/js/visualizer.js), read by every mode. */
interface SonicVizAnalysis {
  /** 48 log-spaced bands, 40 Hz to 16 kHz, 0..1: the last 40 dB below the loudest band of the last seconds. */
  bands: Float32Array;
  /** 256 samples of the waveform, -1..1. */
  wave: Float32Array;
  level: number; bass: number; mid: number; high: number;
  /** Onset envelopes: 1 on an onset in that range, decaying. */
  kick: number; snare: number; hat: number;
  /** True on the frame of a kick onset. */
  beat: boolean;
  /** Spectral flux (novelty) and centroid (brightness), 0..1. */
  flux: number; centroid: number;
  /** Tempo estimate (0 when unknown) and the position in the beat, 0..1. */
  bpm: number; phase: number;
  /** Loudness over the last few seconds, 0..1. */
  energy: number;
  /** Seconds since the page started; the frame's length in seconds (at most 0.1). */
  t: number; dt: number;
  source: SonicAudioSource;
  /** Stereo, over 0.2 s: the balance, -1 (left) .. 1 (right); the width, 0 (mono) .. 1 (out of
   *  phase), the side's share of the power (0.5: one side only, or two unrelated channels).
   *  A mono source and the clock read 0 and 0. */
  balance: number; width: number;
  /** 12 pitch classes (C = 0 .. B = 11) from 80 Hz to 5 kHz, 0..1 with the strongest at 1, over
   *  0.15 s; all 0 in silence and on the clock (it has no pitch). */
  chroma: Float32Array;
  /** The dominant pitch class, 0..11 (kept while nothing pitched is heard). */
  pitch: number;
  /** The key or chord colour of the last second: the best-matching triad's root (0..11), minor
   *  (1) or major (0), and how well it matches, 0..1 (0 on the clock). Changes only after the
   *  new triad has won for 0.8 s. */
  key: number; minor: number; keyStrength: number;
  /** Timbre, over 0.1 s: spectral flatness, 0 (a tone) .. 1 (white noise); the 85% rolloff on
   *  the bands' log axis, 0 (40 Hz) .. 1 (16 kHz); brightness, the power's share above 1.5 kHz,
   *  0..1. The clock reads its own bands (flatness 0). */
  flatness: number; rolloff: number; brightness: number;
  /** Approximate K-weighted loudness over 0.4 s, -54..-6 LUFS as 0..1 (no automatic gain); the
   *  dynamics, the loudest frame of the last 3 s over their mean, 0..20 dB as 0..1. The clock's
   *  loudness is its level, its dynamics 0. */
  loudness: number; dynamics: number;
  /** The position in a 4/4 bar, 0..1 (0 on the downbeat, the beat the kicks accent most); the
   *  downbeat's envelope, 1 on a kick on it, decaying. 3/4 is not told apart. */
  bar: number; downbeat: number;
  /** Structure: the last 3 s against the 6 s before them, 0..1; the sections counted since the
   *  page started (a new one at most every 6 s); 1 when one begins, decaying over 1.5 s. */
  novelty: number; section: number; change: number;
}

/** Where the visualiser's sound comes from (static/js/viz-audio.js). */
type SonicAudioSource = 'tab' | 'system' | 'device' | 'mic' | 'clock';

/** An audio input; a loopback device carries what the computer plays. */
interface SonicAudioDevice { id: string; label: string; loopback: boolean }

/** The signals a mode draws with (static/js/viz-map.js): the grammar shared by every mode. */
interface SonicVizMap {
  /** Each level against its own last 4 s: 1 normal, below 0.7 quiet, above 1.3 loud (0..3). */
  bass: number; mid: number; high: number; level: number; flux: number; energy: number;
  /** The same as deviations scaled by the react control, -1..2 (0 at rest). */
  drive: { bass: number; mid: number; high: number; level: number; flux: number; energy: number };
  /** The palette: base hue (the key on the circle of fifths plus the hue control), its
   *  saturation, the lightness (the timbre's brightness) and the accent (the leading note), 0..1. */
  hue: number; sat: number; light: number; accent: number;
  /** The global brightness, the slow loudness, 0..1: the only thing that brightens the screen. */
  exposure: number;
  /** Texture roughness (noise), halo size (the treble's reach), pan (-0.25..0.25 of the width),
   *  spread (stereo width) and contrast (punchy dynamics), 0..1. */
  rough: number; halo: number; pan: number; spread: number; contrast: number;
  /** Pace (tempo over 120 bpm, 0.6..1.6); after the beat, before it, after the downbeat (0..1);
   *  the latched big event (0..1, decaying). */
  rate: number; pulse: number; pre: number; barPulse: number; punch: number;
  /** The scene variant of this section and the last (0..1), and the crossfade into it (0..1). */
  variant: number; prevVariant: number; morph: number;
  /** An impulse's share of brightness (0.3 after two flashes within a second), the motion cap,
   *  and whether reduced motion is asked for. */
  flashGain: number; motion: number; reduced: boolean;
}

/** A mode's own state, fresh at every mode change and resize. */
interface SonicVizScratch {
  /** The frame's shared signals (static/js/viz-map.js). */
  m: SonicVizMap;
  /** Seconds since the mode started (slowed under reduced motion). */
  t: number;
  /** Every parameter of data/visualizer.json at its current value. */
  params: Record<string, number>;
  [key: string]: any;
}

interface SonicVizGLHandle {
  canvas: HTMLCanvasElement;
  /** What the renderer holds on the GPU (three.js renderer.info.memory). */
  memory(): { textures: number; geometries: number };
  set(id: string): void;
  frame(a: SonicVizAnalysis, s: SonicVizScratch): void;
  resize(): void;
  remove(): void;
}

interface SonicQueueItem { source: string; path: string; i18n: Record<string, { title: string; description: string; path: string }>; artist: string; track: string; youtube: string; thumbnail: string; auto?: boolean }

interface Window {
  Sonic: SonicApi;
  SonicRouter: { go(href: string): void };
  SonicPlayer: {
    playNow(track: unknown): void;
    playNext(track: unknown): void;
    toggleQueued(track: unknown): void;
    playList(tracks: unknown[], start?: number): void;
    remove(index: number): void;
    move(index: number, by: number): void;
    moveTo(from: number, to: number): void;
    clear(): void;
    shuffle(): void;
    next(): void;
    prev(): void;
    toggle(): void;
    stop(): void;
    jump(index: number): void;
    undo(): void;
    notify(text: string): void;
    queue?(open: boolean): void;
    /** Move a shown toast off the playing video (it measures the video's box). */
    placeToast(): void;
    seek(track: unknown, at: string): void;
    /** The URL of what is playing now (?play=…&t=…, the visualiser's keys kept). */
    link?(): string;
    state(): { queue: SonicQueueItem[]; index: number; time: number; repeat: string; view: string; video: string; autoplay: boolean };
  };
  SonicVizMap: { create(): { frame(a: SonicVizAnalysis, p: Record<string, number>): SonicVizMap; map: SonicVizMap }; fifths(pc: number): number };
  /** The sound the visualiser follows (static/js/viz-audio.js). */
  SonicAudio: {
    analyse(): SonicVizAnalysis;
    features: SonicVizAnalysis;
    source(): SonicAudioSource;
    /** The input heard (a device or the microphone), or null. */
    device(): { id: string; label: string } | null;
    /** Every audio input, loopback devices first (empty until the reader has allowed one). */
    devices(): Promise<SonicAudioDevice[]>;
    isLoopback(label: string): boolean;
    /** Start a remembered loopback device again where the browser already allows it. */
    resume(id: string): Promise<boolean>;
    canShare(): boolean;
    listening(): boolean;
    listen(kind: 'tab' | 'system' | 'device' | 'mic', id?: string): Promise<void>;
    stop(): void;
    bestSource(): 'tab' | 'mic';
    onChange(fn: () => void): void;
    snapshot(): ReturnType<Window['SonicVisualizer']['analysis']>;
  };
  SonicVisualizer: {
    /** A copy of the full screen's shared signals, or null while it is closed. */
    map(): SonicVizMap | null;
    /** The full screen's WebGL renderer holdings; null for a p5 picture or while closed. */
    memory(): { textures: number; geometries: number } | null;
    modes(): string[];
    open(mode?: string): void;
    close(): void;
    mode(): string | null;
    set(mode: string): void;
    /** The mode that draws (a gl mode's p5 fallback without WebGL 2) and its engine. */
    shown(): string | null;
    engine(): string | null;
    params(): Record<string, number> | null;
    param(name: string, value: number): void;
    /** Cinema (the video fills the screen, the picture around it); a boolean sets it. */
    cinema(on?: boolean): boolean;
    analysis(): {
      level: number; bass: number; mid: number; high: number; kick: number; snare: number; hat: number;
      flux: number; centroid: number; bpm: number; source: string; bands: number[];
      /** The last 64 onsets, with the page time (seconds) they were found at. */
      onsets: { name: string; t: number }[];
      balance: number; width: number; chroma: number[]; pitch: number; key: number; minor: number;
      keyStrength: number; flatness: number; rolloff: number; brightness: number; loudness: number;
      /** The loudness in LUFS and the dynamics in dB, unmapped. */
      lufs: number; dynamicsDb: number;
      dynamics: number; bar: number; downbeat: number; phase: number; novelty: number;
      section: number; change: number;
      /** The mean milliseconds a frame's analysis takes, over about 20 frames. */
      cost: number;
    };
    source(): string;
    listen(kind: 'tab' | 'system' | 'device' | 'mic', id?: string): Promise<void>;
    /** The audio inputs the settings list, loopback devices first. */
    devices(): SonicAudioDevice[];
    stop(): void;
    background(): boolean;
  };
  /** The 2D modes (static/js/viz-2d.js): one draw per frame on a p5 instance in HSB mode. */
  SonicViz2D: Record<string, (p: any, a: SonicVizAnalysis, s: SonicVizScratch) => void>;
  /** The WebGL modes (static/js/viz-gl.js) on three.js. */
  SonicVizGL: {
    supported(): boolean;
    modes(): string[];
    mount(el: HTMLElement, opt: { density: number; fps?: number }): SonicVizGLHandle | null;
  };
  echarts: any;
  p5: any;
  THREE: any;
  YT: any;
  FlowbiteInstances: any;
  onYouTubeIframeAPIReady: (() => void) | undefined;
  MediaMetadata: typeof MediaMetadata;
}
