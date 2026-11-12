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
}

interface SonicApi {
  base: string;
  module(name: string, mount: () => (() => void) | null | undefined | void): void;
  unmountAll(): void;
  mountAll(): void;
  catalog(): Promise<SonicCatalog>;
  emit(name: string, detail?: unknown): void;
  on(name: string, fn: (event: Event) => void): () => void;
  script(src: string): Promise<unknown>;
  t(key: string, vars?: Record<string, string | number>): string;
  locale(): string;
}

interface SonicQueueItem { source: string; path: string; artist: string; track: string; youtube: string; thumbnail: string }

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
    clear(): void;
    shuffle(): void;
    next(): void;
    prev(): void;
    toggle(): void;
    stop(): void;
    jump(index: number): void;
    undo(): void;
    state(): { queue: SonicQueueItem[]; index: number; time: number; repeat: string; view: string; video: string };
  };
  echarts: any;
  YT: any;
  FlowbiteInstances: any;
  onYouTubeIframeAPIReady: (() => void) | undefined;
  MediaMetadata: typeof MediaMetadata;
}
