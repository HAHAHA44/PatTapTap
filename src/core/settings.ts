import { VOICES, VoiceId } from "./audio";
import { PRESETS, isValidPattern } from "./pattern";
import { SONG_LEVELS, SongLevel } from "./songChart";
import { CueMode, EngineConfig, JudgeWindows, KeyMode, MAX_BEATS, MAX_BPM, MIN_BPM, Pattern } from "./types";

export interface Settings {
  beats: number;
  bpm: number;
  patternId: string;
  customPatterns: Pattern[];
  cue: CueMode;
  soundPattern: boolean;
  /** With soundPattern on: drop the plain beat clicks, only pattern notes sound. */
  muteBeatClick: boolean;
  accent: boolean;
  volume: number;
  voice: VoiceId;
  countIn: boolean;
  iconFeedback: boolean;
  keyMode: KeyMode;
  keys: [string, string];
  strictAlternate: boolean;
  calibrationMs: number;
  clickThrough: boolean;
  /** Widget size multiplier (set in settings; the widget itself is not resizable). */
  widgetScale: number;
  hotkeys: { toggle: string; boss: string };
  language: "auto" | "zh" | "en";
  mode: "metronome" | "song";
  /** Practice queue of song ids (the same song may appear more than once). */
  playlist: string[];
  /** Index into `playlist` of the song being practiced. */
  playIndex: number;
  playMode: PlayMode;
  songLevel: SongLevel;
  songClicks: boolean;
  songVolume: number;
  songRev: number;
}

/** Built-in judge windows (ms, ±). Not user-configurable, so scores stay comparable. */
export const JUDGE_WINDOWS: JudgeWindows = { perfect: 30, great: 60, good: 100 };

export const MIN_SCALE = 0.7;
export const MAX_SCALE = 2;

export const DEFAULT_SETTINGS: Settings = {
  beats: 4,
  bpm: 90,
  patternId: "quarter",
  customPatterns: [],
  cue: "both",
  soundPattern: false,
  muteBeatClick: false,
  accent: true,
  volume: 0.6,
  voice: "wood",
  countIn: true,
  iconFeedback: true,
  keyMode: "single",
  keys: ["KeyF", "KeyJ"],
  strictAlternate: false,
  calibrationMs: 0,
  clickThrough: false,
  widgetScale: 1,
  hotkeys: { toggle: "Alt+Shift+B", boss: "Alt+Shift+H" },
  language: "auto",
  mode: "metronome",
  playlist: [],
  playIndex: 0,
  playMode: "loop",
  songLevel: "beats",
  songClicks: false,
  songVolume: 0.8,
  songRev: 0,
};

const clamp = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

/** Merge stored (possibly old or partial) settings over defaults, validating ranges. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Settings>;
  const d = DEFAULT_SETTINGS;
  const pick = <T,>(v: T | undefined, ok: (v: T) => boolean, def: T) => (v !== undefined && ok(v) ? v : def);
  return {
    beats: Math.round(clamp(r.beats, 1, MAX_BEATS, d.beats)),
    bpm: Math.round(clamp(r.bpm, MIN_BPM, MAX_BPM, d.bpm)),
    patternId: typeof r.patternId === "string" ? r.patternId : d.patternId,
    customPatterns: Array.isArray(r.customPatterns) ? r.customPatterns.filter(isValidPattern) : [],
    cue: pick(r.cue, (v) => ["sound", "visual", "both"].includes(v), d.cue),
    soundPattern: pick(r.soundPattern, (v) => typeof v === "boolean", d.soundPattern),
    muteBeatClick: pick(r.muteBeatClick, (v) => typeof v === "boolean", d.muteBeatClick),
    accent: pick(r.accent, (v) => typeof v === "boolean", d.accent),
    volume: clamp(r.volume, 0, 1, d.volume),
    voice: pick(r.voice, (v) => (VOICES as readonly string[]).includes(v), d.voice),
    countIn: pick(r.countIn, (v) => typeof v === "boolean", d.countIn),
    iconFeedback: pick(r.iconFeedback, (v) => typeof v === "boolean", d.iconFeedback),
    keyMode: pick(r.keyMode, (v) => v === "single" || v === "alternate", d.keyMode),
    keys:
      Array.isArray(r.keys) && r.keys.length === 2 && r.keys.every((k) => typeof k === "string")
        ? [r.keys[0], r.keys[1]]
        : d.keys,
    strictAlternate: pick(r.strictAlternate, (v) => typeof v === "boolean", d.strictAlternate),
    calibrationMs: clamp(r.calibrationMs, -300, 300, d.calibrationMs),
    clickThrough: pick(r.clickThrough, (v) => typeof v === "boolean", d.clickThrough),
    widgetScale: clamp(r.widgetScale, MIN_SCALE, MAX_SCALE, d.widgetScale),
    hotkeys: {
      toggle: typeof r.hotkeys?.toggle === "string" ? r.hotkeys.toggle : d.hotkeys.toggle,
      boss: typeof r.hotkeys?.boss === "string" ? r.hotkeys.boss : d.hotkeys.boss,
    },
    language: pick(r.language, (v) => v === "auto" || v === "zh" || v === "en", d.language),
    mode: pick(r.mode, (v) => v === "metronome" || v === "song", d.mode),
    // older versions stored a single selected song instead of a playlist
    playlist: Array.isArray(r.playlist)
      ? r.playlist.filter((x): x is string => typeof x === "string")
      : typeof (r as { songId?: unknown }).songId === "string"
        ? [(r as { songId: string }).songId]
        : [],
    playIndex: Math.max(0, Math.round(clamp(r.playIndex, 0, 1e6, 0))),
    playMode: pick(r.playMode, (v) => v === "loop" || v === "one" || v === "shuffle", d.playMode),
    songLevel: pick(r.songLevel, (v) => SONG_LEVELS.includes(v), d.songLevel),
    songClicks: pick(r.songClicks, (v) => typeof v === "boolean", d.songClicks),
    songVolume: clamp(r.songVolume, 0, 1, d.songVolume),
    songRev: clamp(r.songRev, 0, 1e9, 0),
  };
}

export function allPatterns(s: Settings): Pattern[] {
  return [...PRESETS, ...s.customPatterns];
}

export function currentPattern(s: Settings): Pattern {
  return allPatterns(s).find((p) => p.id === s.patternId) ?? PRESETS[0];
}

export type PlayMode = "loop" | "one" | "shuffle";
export const PLAY_MODES: PlayMode[] = ["loop", "one", "shuffle"];

/** Song currently up in the playlist, if any. */
export function currentSongId(s: Settings): string | null {
  return s.playlist[Math.min(s.playIndex, s.playlist.length - 1)] ?? null;
}

/** Playlist index to play after the current song ends. */
export function nextPlayIndex(s: Settings, rand: () => number = Math.random): number {
  const n = s.playlist.length;
  if (n <= 1) return 0;
  const i = Math.min(s.playIndex, n - 1);
  if (s.playMode === "one") return i;
  if (s.playMode === "loop") return (i + 1) % n;
  const j = Math.floor(rand() * (n - 1)); // shuffle: any other entry
  return j >= i ? j + 1 : j;
}

/** Beats shown per bar: song charts are always 4/4. */
export function beatsPerBar(s: Settings): number {
  return s.mode === "song" ? 4 : s.beats;
}

export function toEngineConfig(s: Settings): EngineConfig {
  return {
    bpm: s.bpm,
    beats: s.beats,
    pattern: currentPattern(s),
    cue: s.cue,
    soundPattern: s.soundPattern,
    muteBeatClick: s.soundPattern && s.muteBeatClick,
    accent: s.accent,
    volume: s.volume,
    voice: s.voice,
    countIn: s.countIn,
    judge: true,
    keyMode: s.keyMode,
    keys: s.keys,
    strictAlternate: s.strictAlternate,
    windows: { ...JUDGE_WINDOWS },
    calibrationMs: s.calibrationMs,
    mode: s.mode,
    songId: currentSongId(s),
    songLevel: s.songLevel,
    songClicks: s.songClicks,
    songVolume: s.songVolume,
    songRev: s.songRev,
  };
}
