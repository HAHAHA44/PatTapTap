// Challenges (daily challenge, PK): a fixed chart everyone plays, scored the same way
// on the client and on the server. Pure TS, shared with the server.

import { expandBar, PRESETS } from "./pattern";
import type { Grade, JudgeWindows } from "./types";

export interface ChallengeSpec {
  /** Built-in pattern id (see PRESETS). */
  patternId: string;
  bpm: number;
  beats: number;
  /** Bars to play after the count-in. */
  bars: number;
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

/** Patterns used for challenges, roughly easy to hard. */
const CHALLENGE_PATTERNS = ["eighth", "offbeat", "triplet", "8-16-16", "16-16-8", "dotted", "synco", "tresillo", "sixteenth"];

/** Chart for a seed: same seed, same chart on every device. */
export function specFromSeed(seed: string): ChallengeSpec {
  const r = rng(hash(seed));
  const patternId = CHALLENGE_PATTERNS[Math.floor(r() * CHALLENGE_PATTERNS.length)];
  const dense = patternId === "sixteenth" || patternId === "triplet";
  const bpm = (dense ? 70 : 85) + 5 * Math.floor(r() * (dense ? 9 : 12));
  const beats = r() < 0.8 ? 4 : 3;
  return { patternId, bpm, beats, bars: 16 };
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
  const pattern = PRESETS.find((p) => p.id === spec.patternId) ?? PRESETS[0];
  const slots = expandBar(pattern, spec.beats).filter((s) => s.isNote);
  const beatMs = 60000 / spec.bpm;
  const out: number[] = [];
  for (let bar = 0; bar < spec.bars; bar++) for (const s of slots) out.push((bar * spec.beats + s.pos) * beatMs);
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
