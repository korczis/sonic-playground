// Types of the site's browser code (static/js/*.js), checked by `npm run typecheck`
// (tsc --checkJs, tsconfig.json). The data shapes mirror what scripts/catalog.py and
// scripts/i18n.py derive (sonic-catalog/v1, sonic-search/v1, sonic-i18n/v1).

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

interface SonicTerm { term: string; slug: string; count: number }

interface SonicCatalog {
  schema: 'sonic-catalog/v1';
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
  /** 48 log-spaced bands, 40 Hz to 16 kHz, 0..1, gain-normalised. */
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
  source: 'tab' | 'mic' | 'clock';
}

/** A mode's own state, fresh at every mode change and resize. */
interface SonicVizScratch {
  /** Seconds since the mode started (slowed under reduced motion). */
  t: number;
  /** Every parameter of data/visualizer.json at its current value. */
  params: Record<string, number>;
  [key: string]: any;
}

interface SonicVizGLHandle {
  canvas: HTMLCanvasElement;
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
  SonicVisualizer: {
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
    analysis(): { level: number; kick: number; flux: number; centroid: number; bpm: number; source: string };
    source(): string;
    listen(kind: 'tab' | 'mic'): Promise<void>;
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
