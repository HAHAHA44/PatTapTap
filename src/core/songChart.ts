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
  /** The analysis result before any manual fixes (tempo x2 etc.), for "Restore". */
  auto?: { beats: number[]; downbeat: number; bpm: number };
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
 *
 * Drum levels use one rhythm per section. The section boundaries come from the
 * "all" view (most information) and are shared by both drum levels, so "drums"
 * never has more sections than "all"; adjacent sections whose kick+snare rhythm is
 * the same simply read as one longer section.
 */
export function buildChart(a: SongAnalysis, level: SongLevel): ChartBar[] {
  const bars = rawBars(a, level);
  if (level === "beats" || !bars.length) return bars;
  const structure = findSections(level === "all" ? bars : rawBars(a, "all"));
  for (const sec of structure) {
    const cells = level === "all" ? sec.cells : withFallback(majority(bars, sec.firstBar, sec.lastBar));
    for (let i = sec.firstBar; i <= sec.lastBar; i++) bars[i].cells = cells.map((c) => c.slice());
  }
  return bars;
}

/** Bars with every detected note (before sectioning). */
function rawBars(a: SongAnalysis, level: SongLevel): ChartBar[] {
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

/** A run of bars that all use one rhythm. Bar indices are inclusive. */
export interface ChartSection {
  firstBar: number;
  lastBar: number;
  cells: boolean[][];
}

const PHRASE_BARS = 4;
/** Sections shorter than this (fills, transitions) are folded into a neighbour. */
const MIN_SECTION_BARS = 8;
/** Fewer notes than this in a section's rhythm: fall back to one per beat. */
const MIN_SECTION_NOTES = 2;

/** Slot is a hit if it is hit in at least half of the bars (ties count as hits). */
function majority(bars: ChartBar[], from: number, to: number): boolean[][] {
  const n = to - from + 1;
  return bars[from].cells.map((c, b) =>
    c.map((_, j) => {
      let hits = 0;
      for (let i = from; i <= to; i++) if (bars[i].cells[b][j]) hits++;
      return hits * 2 >= n;
    }),
  );
}

function diff(a: boolean[][], b: boolean[][]): number {
  let d = 0;
  a.forEach((c, i) => c.forEach((v, j) => (d += v !== b[i][j] ? 1 : 0)));
  return d;
}

function noteCount(cells: boolean[][]): number {
  return cells.reduce((t, c) => t + c.filter(Boolean).length, 0);
}

/**
 * Split a detected chart into sections and give each section a single repeating
 * one-bar rhythm, so a player can learn it instead of chasing bar-to-bar noise.
 *
 * Rhythms that recur in the song (as a 4-bar phrase's majority rhythm, at least twice)
 * form the vocabulary; one-off phrases (fills, detection noise) snap to the closest
 * recurring rhythm. Runs of the same rhythm become sections, and sections shorter
 * than MIN_SECTION_BARS fold into their more similar neighbour.
 */
export function findSections(bars: ChartBar[]): ChartSection[] {
  if (!bars.length) return [];
  const key = (c: boolean[][]) => c.map((b) => b.map((v) => (v ? 1 : 0)).join("")).join("|");
  const phrases: ChartSection[] = [];
  for (let i = 0; i < bars.length; i += PHRASE_BARS) {
    const last = Math.min(bars.length - 1, i + PHRASE_BARS - 1);
    phrases.push({ firstBar: i, lastBar: last, cells: majority(bars, i, last) });
  }
  // vocabulary of recurring rhythms (ignore the short tail phrase when counting)
  const counts = new Map<string, { cells: boolean[][]; n: number }>();
  for (const p of phrases) {
    if (p.lastBar - p.firstBar + 1 < PHRASE_BARS) continue;
    const k = key(p.cells);
    const e = counts.get(k);
    if (e) e.n++;
    else counts.set(k, { cells: p.cells, n: 1 });
  }
  let vocab = [...counts.values()].filter((e) => e.n >= 2);
  if (!vocab.length) vocab = [{ cells: majority(bars, 0, bars.length - 1), n: 1 }];
  vocab.sort((x, y) => y.n - x.n);
  const nearest = (c: boolean[][]) => {
    let best = vocab[0];
    for (const v of vocab) if (diff(v.cells, c) < diff(best.cells, c)) best = v;
    return best.cells;
  };
  // runs of the same assigned rhythm
  let secs: ChartSection[] = [];
  for (const p of phrases) {
    const cells = nearest(p.cells);
    const prev = secs[secs.length - 1];
    if (prev && diff(prev.cells, cells) === 0) prev.lastBar = p.lastBar;
    else secs.push({ firstBar: p.firstBar, lastBar: p.lastBar, cells });
  }
  // fold short sections into the more similar neighbour, shortest first
  for (;;) {
    if (secs.length < 2) break;
    let idx = -1;
    let shortest = Infinity;
    secs.forEach((sc, i) => {
      const len = sc.lastBar - sc.firstBar + 1;
      if (len < MIN_SECTION_BARS && len < shortest) {
        shortest = len;
        idx = i;
      }
    });
    if (idx < 0) break;
    const sc = secs[idx];
    const prev = secs[idx - 1];
    const next = secs[idx + 1];
    const intoPrev = !next || (prev && diff(prev.cells, sc.cells) <= diff(next.cells, sc.cells));
    const host = intoPrev ? prev : next;
    host.firstBar = Math.min(host.firstBar, sc.firstBar);
    host.lastBar = Math.max(host.lastBar, sc.lastBar);
    secs.splice(idx, 1);
    // neighbours that now touch with the same rhythm become one section
    secs = secs.reduce<ChartSection[]>((acc, x) => {
      const p = acc[acc.length - 1];
      if (p && diff(p.cells, x.cells) === 0) p.lastBar = x.lastBar;
      else acc.push(x);
      return acc;
    }, []);
  }
  return secs.map((sec) => ({ ...sec, cells: withFallback(sec.cells) }));
}

/** A rhythm with almost no notes (e.g. a drumless intro) becomes one hit per beat. */
function withFallback(cells: boolean[][]): boolean[][] {
  return noteCount(cells) < MIN_SECTION_NOTES ? cells.map((c) => c.map((_, j) => j === 0)) : cells.map((c) => c.slice());
}

/** Sections of a finished chart (consecutive bars with identical rhythm). */
export function chartSections(bars: ChartBar[]): ChartSection[] {
  const out: ChartSection[] = [];
  bars.forEach((bar, i) => {
    const prev = out[out.length - 1];
    if (prev && diff(prev.cells, bar.cells) === 0) prev.lastBar = i;
    else out.push({ firstBar: i, lastBar: i, cells: bar.cells });
  });
  return out;
}

/** Number of notes to tap in a chart. */
export function chartNoteCount(bars: ChartBar[]): number {
  return bars.reduce((s, bar) => s + bar.cells.reduce((t, c) => t + c.filter(Boolean).length, 0), 0);
}
