import type { SongAnalysis } from "./beatTrack";

export type SongLevel = "beats" | "drums" | "all";
export const SONG_LEVELS: SongLevel[] = ["beats", "drums", "all"];

/** A stored song: analysis plus library info. */
export interface SongMeta extends SongAnalysis {
  id: string;
  name: string;
  /** Original file extension, for decoding hints. */
  ext: string;
  importedAt: number;
}

/** One bar of a song chart. Times are seconds from the start of the audio. */
export interface ChartBar {
  start: number;
  /** Start time of each beat in the bar (4/4 assumed). */
  beats: number[];
  end: number;
  /** Per beat: 16th-note grid (4 cells) for drum levels, or one cell for "beats". */
  cells: boolean[][];
}

const BEATS_PER_BAR = 4;
const GRID = 4; // 16th notes
/** Max distance from the 16th grid (in grid steps) for an onset to become a note. */
const MAX_QUANT_ERROR = 0.35;

function upperBound(xs: number[], v: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] <= v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/**
 * Turn an analysis into bars of notes to tap.
 * - beats: every beat
 * - drums: kick + snare-band onsets, snapped to the 16th grid
 * - all:   kick + snare + hi-hat-band onsets
 */
export function buildChart(a: SongAnalysis, level: SongLevel): ChartBar[] {
  const b = a.beats;
  const first = a.downbeat;
  const nBars = Math.floor((b.length - first) / BEATS_PER_BAR);
  if (nBars <= 0) return [];
  const beatAt = (k: number) => (k < b.length ? b[k] : b[b.length - 1] + (k - b.length + 1) * (b[b.length - 1] - b[b.length - 2]));

  const bars: ChartBar[] = [];
  for (let i = 0; i < nBars; i++) {
    const k0 = first + i * BEATS_PER_BAR;
    const beats = Array.from({ length: BEATS_PER_BAR }, (_, j) => beatAt(k0 + j));
    bars.push({
      start: beats[0],
      beats,
      end: beatAt(k0 + BEATS_PER_BAR),
      cells: Array.from({ length: BEATS_PER_BAR }, () => (level === "beats" ? [true] : new Array(GRID).fill(false))),
    });
  }
  if (level === "beats") return bars;

  const onsets = [...a.onsets.low, ...a.onsets.mid, ...(level === "all" ? a.onsets.high : [])].sort((x, y) => x - y);
  for (const o of onsets) {
    // fractional beat position of the onset
    const k = upperBound(b, o) - 1;
    if (k < 0 || k + 1 >= b.length) continue;
    const pos = ((o - b[k]) / (b[k + 1] - b[k])) * GRID;
    let j = Math.round(pos);
    if (Math.abs(pos - j) > MAX_QUANT_ERROR) continue;
    let beat = k;
    if (j === GRID) {
      beat++;
      j = 0;
    }
    const rel = beat - first;
    if (rel < 0) continue;
    const bar = bars[Math.floor(rel / BEATS_PER_BAR)];
    if (bar) bar.cells[rel % BEATS_PER_BAR][j] = true;
  }
  return bars;
}

/** Number of notes to tap in a chart. */
export function chartNoteCount(bars: ChartBar[]): number {
  return bars.reduce((s, bar) => s + bar.cells.reduce((t, c) => t + c.filter(Boolean).length, 0), 0);
}
