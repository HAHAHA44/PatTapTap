import { meanStd } from "./stats";
import { SessionDetail, TraceHit } from "./types";

export interface GroupStats {
  count: number; // notes (hits + misses)
  hits: number;
  misses: number;
  mean: number;
  std: number;
}

/** Where a note sits in the bar: beat index, slot within the beat, subdivision. */
export interface NotePosition {
  beat: number;
  sub: number;
  of: number;
}

export interface PositionStats extends GroupStats {
  noteIndex: number;
  pos: NotePosition;
}

export interface SessionAnalysis {
  hits: TraceHit[]; // non-miss notes with offsets
  misses: TraceHit[];
  strays: TraceHit[];
  median: number;
  earliest: number;
  latest: number;
  earlyPct: number; // share of hits earlier than -perfect window
  latePct: number;
  onTimePct: number; // within perfect window
  /** Linear trend of offset over time, ms per minute (positive = drifting late = slowing down). */
  driftPerMin: number;
  firstHalf: GroupStats;
  secondHalf: GroupStats;
  /** Moving average of offsets (window of N hits), as [t, avg]. */
  movingAvg: [number, number][];
  positions: PositionStats[];
  /** Per key (alternate mode). Misses are attributed to a key only with strict alternation. */
  hands: GroupStats[] | null;
  wrongHand: number;
}

function group(items: TraceHit[]): GroupStats {
  const hits = items.filter((x) => x.off !== null);
  const { mean, std } = meanStd(hits.map((x) => x.off!));
  return {
    count: items.length,
    hits: hits.length,
    misses: items.length - hits.length,
    mean: round1(mean),
    std: round1(std),
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Position of every note in the bar, by note index (language-neutral; format in the UI). */
export function notePositions(cells: boolean[][]): NotePosition[] {
  const out: NotePosition[] = [];
  cells.forEach((c, b) =>
    c.forEach((on, j) => {
      if (on) out.push({ beat: b, sub: j, of: c.length });
    }),
  );
  return out;
}

export function analyze(d: SessionDetail, maWindow = 8): SessionAnalysis {
  const notes = d.trace.filter((x) => x.g !== "stray");
  const hits = notes.filter((x) => x.off !== null);
  const misses = notes.filter((x) => x.off === null);
  const strays = d.trace.filter((x) => x.g === "stray");
  const offs = hits.map((x) => x.off!);
  const pw = d.windows.perfect;

  // least-squares slope of offset vs time
  let drift = 0;
  if (hits.length >= 4) {
    const xs = hits.map((h) => h.t / 60000);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = offs.reduce((a, b) => a + b, 0) / offs.length;
    let num = 0;
    let den = 0;
    xs.forEach((x, i) => {
      num += (x - mx) * (offs[i] - my);
      den += (x - mx) ** 2;
    });
    drift = den > 0 ? num / den : 0;
  }

  const movingAvg: [number, number][] = [];
  let sum = 0;
  hits.forEach((h, i) => {
    sum += h.off!;
    if (i >= maWindow) sum -= hits[i - maWindow].off!;
    if (i >= maWindow - 1) movingAvg.push([h.t, sum / maWindow]);
  });

  const mid = notes.length ? notes[Math.floor(notes.length / 2)].t : 0;
  const positions: PositionStats[] = notePositions(d.cells).map((pos, i) => ({
    noteIndex: i,
    pos,
    ...group(notes.filter((x) => x.n === i)),
  }));

  // Which key a note belongs to: the key pressed; for misses only the expected key under
  // strict alternation (without it a missed note has no meaningful key). Older records
  // stored `h` in non-strict mode too, so ignore it there.
  const keyOf = (x: TraceHit): 0 | 1 | undefined => x.k ?? (d.strictAlternate ? x.h : undefined);
  const alt = notes.some((x) => keyOf(x) !== undefined);
  return {
    hits,
    misses,
    strays,
    median: round1(median(offs)),
    earliest: offs.length ? Math.min(...offs) : 0,
    latest: offs.length ? Math.max(...offs) : 0,
    earlyPct: offs.length ? offs.filter((o) => o < -pw).length / offs.length : 0,
    latePct: offs.length ? offs.filter((o) => o > pw).length / offs.length : 0,
    onTimePct: offs.length ? offs.filter((o) => Math.abs(o) <= pw).length / offs.length : 0,
    driftPerMin: round1(drift),
    firstHalf: group(notes.filter((x) => x.t < mid)),
    secondHalf: group(notes.filter((x) => x.t >= mid)),
    movingAvg,
    positions,
    hands: alt ? [group(notes.filter((x) => keyOf(x) === 0)), group(notes.filter((x) => keyOf(x) === 1))] : null,
    wrongHand: notes.filter((x) => x.wrong).length,
  };
}
