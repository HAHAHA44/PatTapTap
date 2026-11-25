import { VOICES, VoiceId } from "./audio";
import { PRESETS, isValidPattern } from "./pattern";
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
  };
}

export function allPatterns(s: Settings): Pattern[] {
  return [...PRESETS, ...s.customPatterns];
}

export function currentPattern(s: Settings): Pattern {
  return allPatterns(s).find((p) => p.id === s.patternId) ?? PRESETS[0];
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
  };
}
