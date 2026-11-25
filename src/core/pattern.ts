import { BarSlot, MAX_BEATS, Pattern } from "./types";

const T = true;
const F = false;

export const PRESETS: Pattern[] = [
  { id: "quarter", name: "四分音符", cells: [[T]], builtin: true },
  { id: "eighth", name: "八分音符", cells: [[T, T]], builtin: true },
  { id: "offbeat", name: "反拍", cells: [[F, T]], builtin: true },
  { id: "triplet", name: "三连音", cells: [[T, T, T]], builtin: true },
  { id: "sixteenth", name: "十六分音符", cells: [[T, T, T, T]], builtin: true },
  { id: "8-16-16", name: "前八后十六", cells: [[T, F, T, T]], builtin: true },
  { id: "16-16-8", name: "前十六后八", cells: [[T, T, T, F]], builtin: true },
  { id: "dotted", name: "附点（八分附点 + 十六分）", cells: [[T, F, F, T]], builtin: true },
  { id: "synco", name: "切分", cells: [[T, F], [T, T], [F, T], [T, F]], builtin: true },
  { id: "tresillo", name: "3+3+2", cells: [[T, F], [F, T], [F, F], [T, F]], builtin: true },
];

/** Expand a pattern into the grid slots of one bar with `beats` beats. */
export function expandBar(pattern: Pattern, beats: number): BarSlot[] {
  const slots: BarSlot[] = [];
  let n = 0;
  const src = pattern.cells.length ? pattern.cells : [[true]];
  for (let b = 0; b < beats; b++) {
    const cells = src[b % src.length];
    const s = Math.max(1, cells.length);
    for (let j = 0; j < s; j++) {
      const isNote = !!cells[j];
      slots.push({
        beat: b,
        sub: j,
        subdivision: s,
        pos: b + j / s,
        isBeatStart: j === 0,
        isNote,
        noteIndex: isNote ? n++ : -1,
      });
    }
  }
  return slots;
}

/** Change the subdivision of one beat, keeping hits at positions that still exist. */
export function withSubdivision(cells: boolean[][], beat: number, sub: number): boolean[][] {
  const old = cells[beat];
  const next = Array.from({ length: sub }, (_, j) => {
    // keep a hit if an old hit lands on the same fraction of the beat
    const frac = j / sub;
    const oi = Math.round(frac * old.length);
    return Math.abs(oi / old.length - frac) < 1e-9 ? !!old[oi] : false;
  });
  if (!next.some(Boolean) && old.some(Boolean)) next[0] = true;
  return cells.map((c, i) => (i === beat ? next : c));
}

export function withBeatCount(cells: boolean[][], beats: number): boolean[][] {
  const n = Math.min(MAX_BEATS, Math.max(1, beats));
  return Array.from({ length: n }, (_, i) => cells[i] ?? [true]);
}

export function toggleCell(cells: boolean[][], beat: number, sub: number): boolean[][] {
  return cells.map((c, i) => (i === beat ? c.map((v, j) => (j === sub ? !v : v)) : c));
}

export function isValidPattern(p: unknown): p is Pattern {
  if (!p || typeof p !== "object") return false;
  const q = p as Pattern;
  return (
    typeof q.id === "string" &&
    typeof q.name === "string" &&
    Array.isArray(q.cells) &&
    q.cells.length >= 1 &&
    q.cells.length <= MAX_BEATS &&
    q.cells.every((c) => Array.isArray(c) && c.length >= 1 && c.length <= 8 && c.every((v) => typeof v === "boolean"))
  );
}

export function newPatternId(): string {
  return "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
