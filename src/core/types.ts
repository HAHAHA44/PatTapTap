// Pure data types for the rhythm core. No platform (Tauri/DOM) dependencies,
// so this folder can be reused by a future mobile or web build.

/** Supported subdivisions of one beat (quarter, 8th, triplet, 16th, sextuplet). */
export const SUBDIVISIONS = [1, 2, 3, 4, 6] as const;
export type Subdivision = (typeof SUBDIVISIONS)[number];

export const MAX_BEATS = 8;
export const MIN_BPM = 30;
export const MAX_BPM = 300;

/**
 * A rhythm pattern: one entry per beat, each entry is the grid of that beat
 * (length = subdivision), `true` = play/tap, `false` = rest.
 * A pattern shorter than the bar repeats (e.g. a 1-beat "8ths" pattern fills any meter).
 */
export interface Pattern {
  id: string;
  name: string;
  cells: boolean[][];
  builtin?: boolean;
}

export type CueMode = "sound" | "visual" | "both";
export type KeyMode = "single" | "alternate";
export type Grade = "perfect" | "great" | "good" | "miss";

export interface JudgeWindows {
  perfect: number; // ms, +/-
  great: number;
  good: number;
}

/** One grid position inside a bar. */
export interface BarSlot {
  beat: number;
  sub: number;
  subdivision: number;
  /** Position in beats from bar start. */
  pos: number;
  isBeatStart: boolean;
  isNote: boolean;
  /** Index among notes of the bar, -1 for rests. */
  noteIndex: number;
}

export interface ScheduledEvent {
  /** Bar number; negative during count-in. */
  bar: number;
  slot: BarSlot;
  audioTime: number;
  /** When the sound is heard, in performance.now() milliseconds. */
  perfTime: number;
  countIn: boolean;
}

export interface NoteResult {
  bar: number;
  noteIndex: number;
  grade: Grade;
  /** Signed ms (negative = early). null for misses. */
  offset: number | null;
  wrongHand?: boolean;
}

export interface EngineConfig {
  bpm: number;
  beats: number;
  pattern: Pattern;
  cue: CueMode;
  /** Also click on pattern notes (not only beats). */
  soundPattern: boolean;
  /** Only pattern notes make sound (no plain beat clicks). Count-in still clicks. */
  muteBeatClick: boolean;
  accent: boolean;
  volume: number;
  countIn: boolean;
  judge: boolean;
  keyMode: KeyMode;
  keys: [string, string];
  strictAlternate: boolean;
  windows: JudgeWindows;
  /** Added to expected hit times to compensate audio/input latency. */
  calibrationMs: number;
}

export interface LiveStats {
  perfect: number;
  great: number;
  good: number;
  miss: number;
  stray: number;
  combo: number;
  maxCombo: number;
  offsets: number[];
}

/** One judged event of a session, compact for storage. */
export interface TraceHit {
  /** ms from the first (non count-in) bar: expected time for notes, tap time for strays. */
  t: number;
  /** Signed offset in ms (negative = early); null for misses and strays. */
  off: number | null;
  g: Grade | "stray";
  /** Note index within the bar (-1 for strays). */
  n: number;
  /** Alternate mode: key actually pressed (0 = key 1, 1 = key 2); absent for misses. */
  k?: 0 | 1;
  /** Strict alternate only: key that should have been pressed. */
  h?: 0 | 1;
  wrong?: boolean;
}

export interface SessionDetail {
  trace: TraceHit[];
  /** True if trace was cut at MAX_TRACE entries. */
  truncated: boolean;
  windows: JudgeWindows;
  calibrationMs: number;
  /** Pattern grid as practiced, expanded to the bar. */
  cells: boolean[][];
  strictAlternate: boolean;
}

export interface SessionSummary {
  startedAt: number;
  durationSec: number;
  bpm: number;
  beats: number;
  patternName: string;
  /** Lets built-in pattern names be shown in the current language. */
  patternId?: string;
  patternBuiltin?: boolean;
  keyMode: KeyMode;
  perfect: number;
  great: number;
  good: number;
  miss: number;
  stray: number;
  maxCombo: number;
  /** 0..1 weighted accuracy. */
  accuracy: number;
  meanOffset: number;
  stdOffset: number;
  detail?: SessionDetail;
}
