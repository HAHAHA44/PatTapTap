// Challenges (daily challenge, PK): a fixed chart everyone plays, scored the same way
// on the client and on the server. Pure TS, shared with the server.

import { PRESETS } from "./pattern";
import type { Grade, JudgeWindows } from "./types";

/**
 * A challenge chart. `phrase` is a short rhythm (usually 2 bars) repeated for the
 * whole chart; each bar is written as beats separated by "|", each beat as hits "x"
 * and rests "." on that beat's grid (2 = 8ths, 3 = triplets, 4 = 16ths).
 * Older charts (before phrases) only had `patternId`, a built-in one-beat pattern.
 * A later "song" kind can add its own fields.
 */
export interface ChallengeSpec {
  bpm: number;
  beats: number;
  /** Bars to play after the count-in. */
  bars: number;
  phrase?: string[];
  patternId?: string;
}

/** Judge windows for challenges (same as practice). */
export const CHALLENGE_WINDOWS: JudgeWindows = { perfect: 30, great: 60, good: 100 };

const WEIGHT: Record<Grade, number> = { perfect: 1, great: 0.7, good: 0.4, miss: 0 };
const STRAY_WEIGHT = 1; // a stray tap counts like a missed note in the denominator

/** Deterministic 32-bit hash (FNV-1a) of a string. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small seeded PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Target length of a challenge. */
const TARGET_SECONDS = 120;

/**
 * Challenge pool, medium difficulty on purpose: syncopation and mixed 8th / 16th
 * figures at moderate tempos, no "every slot filled" runs.
 */
const POOL: { beats: number; bpm: [number, number]; phrase: string[] }[] = [
  // 8th-note syncopation
  { beats: 4, bpm: [100, 120], phrase: ["x.|.x|x.|x.", "x.|.x|.x|x."] },
  { beats: 4, bpm: [95, 115], phrase: ["x.|xx|.x|x.", "xx|.x|.x|x."] },
  { beats: 4, bpm: [100, 120], phrase: ["x.|.x|.x|.x", "x.|xx|x.|.."] },
  { beats: 4, bpm: [100, 120], phrase: ["x.|.x|..|x.", "..|x.|x.|.."] }, // 3-2 clave
  { beats: 4, bpm: [100, 115], phrase: ["x.|..|x.|xx", ".x|x.|.x|x."] },
  // 16th-note syncopation
  { beats: 4, bpm: [80, 95], phrase: ["x..x|..x.|x...|x.x.", "x..x|..x.|..x.|x..."] },
  { beats: 4, bpm: [80, 95], phrase: ["x.xx|x...|.xx.|x...", "x.xx|x.x.|.x.x|x..."] },
  { beats: 4, bpm: [85, 100], phrase: ["x..x|..x.|x..x|..x.", "x..x|..x.|x.x.|x..."] }, // 3+3+2
  // mixed 8ths and 16ths
  { beats: 4, bpm: [85, 100], phrase: ["x.xx|.x|x..x|x.", "x.|.xx.|x.|xx"] },
  { beats: 4, bpm: [90, 105], phrase: ["x.|x.xx|.x|x...", "xx.x|x.|..x.|x."] },
  // triplets against 8ths
  { beats: 4, bpm: [80, 95], phrase: ["xxx|x.|xxx|x.", "x.|xxx|.x|x."] },
  // 3/4
  { beats: 3, bpm: [100, 120], phrase: ["x.|.x|x.", "xx|.x|x."] },
  { beats: 3, bpm: [85, 100], phrase: ["x..x|..x.|x...", "x.xx|.x..|x..."] },
];

export const POOL_SIZE = POOL.length;

/** Chart for a seed: same seed, same chart on every device. */
export function specFromSeed(seed: string): ChallengeSpec {
  const r = rng(hash(seed));
  const entry = POOL[Math.floor(r() * POOL.length)];
  const steps = (entry.bpm[1] - entry.bpm[0]) / 5;
  const bpm = entry.bpm[0] + 5 * Math.floor(r() * (steps + 1));
  // about two minutes, in whole phrases
  const barSec = (entry.beats * 60) / bpm;
  const len = entry.phrase.length;
  const bars = Math.max(len, Math.round(TARGET_SECONDS / barSec / len) * len);
  return { bpm, beats: entry.beats, bars, phrase: entry.phrase };
}

/** Cells of one written bar: per beat, hit / rest on that beat's grid. */
function parseBar(bar: string): boolean[][] {
  return bar.split("|").map((beat) => [...beat].map((c) => c === "x"));
}

/** Every bar of the chart as per-beat cells (what the engine plays and both sides judge). */
export function chartCells(spec: ChallengeSpec): boolean[][][] {
  let phrase: boolean[][][];
  if (spec.phrase?.length) phrase = spec.phrase.map(parseBar);
  else {
    const p = PRESETS.find((x) => x.id === spec.patternId) ?? PRESETS[0];
    phrase = [Array.from({ length: spec.beats }, (_, b) => p.cells[b % p.cells.length].slice())];
  }
  return Array.from({ length: spec.bars }, (_, i) => phrase[i % phrase.length].map((c) => c.slice()));
}

/** One phrase of the chart (for previews). */
export function phraseCells(spec: ChallengeSpec): boolean[][][] {
  return chartCells({ ...spec, bars: spec.phrase?.length || 1 });
}

/** Today's challenge date "YYYY-MM-DD" in the given UTC offset (minutes). */
export function challengeDate(now: number, tzOffsetMin: number): string {
  return new Date(now + tzOffsetMin * 60000).toISOString().slice(0, 10);
}

export function dailySpec(date: string): ChallengeSpec {
  return specFromSeed(`daily:${date}`);
}

/** Expected time (ms after the first bar starts) of every note in the chart. */
export function noteTimes(spec: ChallengeSpec): number[] {
  const beatMs = 60000 / spec.bpm;
  const out: number[] = [];
  chartCells(spec).forEach((bar, i) =>
    bar.forEach((cells, b) => cells.forEach((on, j) => on && out.push((i * spec.beats + b + j / cells.length) * beatMs))),
  );
  return out;
}

/** Length of the chart (ms after the first bar starts). */
export function chartDurationMs(spec: ChallengeSpec): number {
  return (spec.bars * spec.beats * 60000) / spec.bpm;
}

export interface ChallengeResult {
  perfect: number;
  great: number;
  good: number;
  miss: number;
  stray: number;
  maxCombo: number;
  /** 0..1 over every note of the chart (stopping early doesn't help). */
  accuracy: number;
  /** accuracy x 10000, rounded: the leaderboard number. */
  score: number;
}

/**
 * Judge taps against expected note times, like the practice engine does live: each tap
 * takes the nearest still-open note within the "good" window, otherwise it is a stray;
 * notes nobody took are misses. Times in ms on the same clock (calibration already
 * applied to the taps).
 */
export function judgeTaps(notes: number[], taps: number[], windows: JudgeWindows = CHALLENGE_WINDOWS): ChallengeResult {
  const taken = new Uint8Array(notes.length);
  const grade: (Grade | null)[] = new Array(notes.length).fill(null);
  const res: ChallengeResult = { perfect: 0, great: 0, good: 0, miss: 0, stray: 0, maxCombo: 0, accuracy: 0, score: 0 };
  const sorted = taps.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const end = notes.length ? notes[notes.length - 1] + windows.good : 0;
  let lo = 0; // first note not yet expired
  // combo runs over notes and strays in time order
  const events: { t: number; ok: boolean }[] = [];
  for (const t of sorted) {
    if (t > end) break;
    while (lo < notes.length && notes[lo] + windows.good < t) lo++;
    let best = -1;
    let bestAbs = Infinity;
    for (let i = lo; i < notes.length && notes[i] - windows.good <= t; i++) {
      if (taken[i]) continue;
      const d = Math.abs(t - notes[i]);
      if (d <= windows.good && d < bestAbs) {
        best = i;
        bestAbs = d;
      }
    }
    if (best < 0) {
      res.stray++;
      events.push({ t, ok: false });
      continue;
    }
    taken[best] = 1;
    grade[best] = bestAbs <= windows.perfect ? "perfect" : bestAbs <= windows.great ? "great" : "good";
  }
  notes.forEach((t, i) => {
    const g = grade[i] ?? "miss";
    res[g]++;
    events.push({ t, ok: g !== "miss" });
  });
  events.sort((a, b) => a.t - b.t);
  let combo = 0;
  for (const e of events) {
    combo = e.ok ? combo + 1 : 0;
    res.maxCombo = Math.max(res.maxCombo, combo);
  }
  const weighted = res.perfect * WEIGHT.perfect + res.great * WEIGHT.great + res.good * WEIGHT.good;
  const denom = notes.length + res.stray * STRAY_WEIGHT;
  res.accuracy = denom ? weighted / denom : 0;
  res.score = Math.round(res.accuracy * 10000);
  return res;
}

/** Most taps a submission may contain (guards the server). */
export const MAX_TAPS = 4000;
