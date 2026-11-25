import { EngineConfig, Grade, LiveStats, SessionSummary } from "./types";

const WEIGHT: Record<Grade, number> = { perfect: 1, great: 0.7, good: 0.4, miss: 0 };

export function emptyStats(): LiveStats {
  return { perfect: 0, great: 0, good: 0, miss: 0, stray: 0, combo: 0, maxCombo: 0, offsets: [] };
}

export function record(s: LiveStats, grade: Grade, offset: number | null) {
  s[grade]++;
  if (grade === "miss") s.combo = 0;
  else {
    s.combo++;
    s.maxCombo = Math.max(s.maxCombo, s.combo);
  }
  if (offset !== null) s.offsets.push(offset);
}

export function recordStray(s: LiveStats) {
  s.stray++;
  s.combo = 0;
}

export function judgedCount(s: LiveStats) {
  return s.perfect + s.great + s.good + s.miss;
}

export function accuracy(s: LiveStats): number {
  const n = judgedCount(s) + s.stray;
  if (!n) return 0;
  return (s.perfect * WEIGHT.perfect + s.great * WEIGHT.great + s.good * WEIGHT.good) / n;
}

export function meanStd(xs: number[]): { mean: number; std: number } {
  if (!xs.length) return { mean: 0, std: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return { mean, std: Math.sqrt(v) };
}

export function summarize(s: LiveStats, cfg: EngineConfig, startedAt: number): SessionSummary {
  const { mean, std } = meanStd(s.offsets);
  return {
    startedAt,
    durationSec: Math.round((Date.now() - startedAt) / 1000),
    bpm: cfg.bpm,
    beats: cfg.beats,
    patternName: cfg.pattern.name,
    patternId: cfg.pattern.id,
    patternBuiltin: !!cfg.pattern.builtin,
    keyMode: cfg.keyMode,
    perfect: s.perfect,
    great: s.great,
    good: s.good,
    miss: s.miss,
    stray: s.stray,
    maxCombo: s.maxCombo,
    accuracy: accuracy(s),
    meanOffset: Math.round(mean * 10) / 10,
    stdOffset: Math.round(std * 10) / 10,
  };
}
