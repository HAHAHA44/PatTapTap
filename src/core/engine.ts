import { ClickSynth, VoiceId } from "./audio";
import { expandBar } from "./pattern";
import type { ChartBar } from "./songChart";
import { emptyStats, record, recordStray, summarize, judgedCount } from "./stats";
import { Ticker } from "./ticker";
import {
  BarSlot,
  EngineConfig,
  Grade,
  LiveStats,
  NoteResult,
  ScheduledEvent,
  SessionSummary,
  TraceHit,
} from "./types";

const LOOKAHEAD_S = 0.12; // schedule this far ahead on the audio clock
const TICK_MS = 20;
const START_DELAY_S = 0.15;
const MAX_TRACE = 6000;

interface PendingNote {
  bar: number;
  noteIndex: number;
  expected: number; // perf ms, calibration applied
  hand: 0 | 1;
}

/** A song to play along with: the audio plus the chart of notes to tap. */
export interface SongPlayback {
  id: string;
  name: string;
  bpm: number;
  buffer: AudioBuffer;
  bars: ChartBar[];
  volume: number;
  /** Overlay click sounds on the chart's notes (lets you hear just the rhythm). */
  clicks: boolean;
}

/** One bar as the scheduler sees it. Times are seconds from the session origin. */
interface PlayBar {
  start: number;
  beats: number[];
  end: number;
  slots: BarSlot[];
  countIn: boolean;
}

export interface EngineCallbacks {
  /** Fired when an event is scheduled (ahead of time). Use perfTime to render it. */
  onSchedule?(e: ScheduledEvent): void;
  onResult?(r: NoteResult, stats: LiveStats): void;
  onStray?(stats: LiveStats): void;
  /** The song finished playing (song mode only). */
  onEnd?(): void;
}

/** Slots of a bar whose notes are indexed by grid position, so the same position
 *  keeps the same index in every bar (song charts vary bar to bar). */
function gridSlots(cells: boolean[][]): BarSlot[] {
  const slots: BarSlot[] = [];
  cells.forEach((c, b) =>
    c.forEach((on, j) =>
      slots.push({ beat: b, sub: j, subdivision: c.length, pos: b + j / c.length, isBeatStart: j === 0, isNote: on, noteIndex: on ? b * c.length + j : -1 }),
    ),
  );
  return slots;
}

/**
 * Metronome / song player + judge. Timing follows the "two clocks" pattern: a coarse
 * timer schedules sounds precisely on the AudioContext clock slightly ahead of time,
 * and audio time is mapped to performance.now() for visuals and judging. Both modes
 * are driven bar by bar through `barAt()`.
 */
export class RhythmEngine {
  private ctx: AudioContext | null = null;
  private synth: ClickSynth | null = null;
  private ticker = new Ticker(TICK_MS, () => this.tick());
  private cfg!: EngineConfig;
  private song: SongPlayback | null = null;
  private songSrc: AudioBufferSourceNode | null = null;
  private songGain: GainNode | null = null;
  private curBar: PlayBar | null = null;
  private slotIdx = 0;
  private bar = 0;
  private origin = 0; // audio seconds of session time 0
  private patternSlots: BarSlot[] = [];
  private barLen = 2;
  private songEnded = false;
  private pending: PendingNote[] = [];
  private noteCounter = 0;
  private clockOffset = 0; // perf ms = audio s * 1000 + clockOffset
  private clockReady = false;
  private startedAt = 0;
  private startToken = 0;
  private stats: LiveStats = emptyStats();
  private trace: TraceHit[] = [];
  private t0Perf = 0; // perf ms of bar 0 (after count-in / song start)
  running = false;

  constructor(private cb: EngineCallbacks = {}) {}

  /** Decode audio file bytes with this engine's audio context. */
  async decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    this.ensureContext();
    return this.ctx!.decodeAudioData(bytes);
  }

  private ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
      this.synth = new ClickSynth(this.ctx);
    }
  }

  /** Must be awaited; may need a user gesture on some platforms. */
  async start(cfg: EngineConfig, song: SongPlayback | null = null): Promise<boolean> {
    if (this.running) this.stop();
    // A newer start() (or a stop()) supersedes this one while we await the audio device.
    const token = ++this.startToken;
    this.cfg = cfg;
    this.ensureContext();
    const ctx = this.ctx!;
    try {
      await ctx.resume();
    } catch {
      /* ignore */
    }
    if (token !== this.startToken) return false;
    if (ctx.state !== "running") return false;
    this.synth!.setVolume(cfg.volume);
    this.synth!.setVoice(cfg.voice);
    this.clockReady = false;
    this.syncClock();

    this.song = song;
    this.songEnded = false;
    this.origin = ctx.currentTime + START_DELAY_S;
    this.patternSlots = expandBar(cfg.pattern, cfg.beats);
    this.barLen = (cfg.beats * 60) / cfg.bpm;
    this.bar = !song && cfg.countIn ? -1 : 0;
    this.curBar = null;
    this.slotIdx = 0;
    if (song) {
      const g = ctx.createGain();
      g.gain.value = song.volume;
      g.connect(ctx.destination);
      const src = ctx.createBufferSource();
      src.buffer = song.buffer;
      src.connect(g);
      src.start(this.origin);
      this.songSrc = src;
      this.songGain = g;
    }
    this.pending = [];
    this.noteCounter = 0;
    this.stats = emptyStats();
    this.trace = [];
    this.t0Perf = this.audioToPerf(this.origin + (!song && cfg.countIn ? this.barLen : 0));
    this.startedAt = Date.now();
    this.running = true;
    this.tick();
    this.ticker.start();
    return true;
  }

  /** Stops playback. Returns a summary if anything was judged. */
  stop(): SessionSummary | null {
    this.startToken++; // cancel any start() still awaiting the audio device
    if (!this.running) return null;
    this.running = false;
    this.ticker.stop();
    this.synth?.cut();
    this.stopSong();
    // Notes already past their window count as misses; future ones are dropped.
    this.expireMisses(performance.now());
    this.pending = [];
    this.dropTrailingMisses();
    const song = this.song;
    this.song = null; // release the decoded audio
    if (!this.cfg.judge || judgedCount(this.stats) + this.stats.stray === 0) return null;
    const summary = summarize(this.stats, this.cfg, this.startedAt);
    const cfg = this.cfg;
    summary.detail = {
      trace: this.trace,
      truncated: this.trace.length >= MAX_TRACE,
      windows: { ...cfg.windows },
      calibrationMs: cfg.calibrationMs,
      cells: song
        ? Array.from({ length: 4 }, (_, i) => new Array(song.bars[0]?.cells[i].length ?? 1).fill(true))
        : Array.from({ length: cfg.beats }, (_, i) => cfg.pattern.cells[i % cfg.pattern.cells.length]),
      strictAlternate: cfg.keyMode === "alternate" && cfg.strictAlternate,
    };
    if (song) {
      summary.patternName = song.name;
      summary.patternId = `song:${song.id}`;
      summary.patternBuiltin = false;
      summary.bpm = song.bpm;
      summary.beats = 4;
      summary.detail.barStarts = song.bars.map((b) => Math.round(b.start * 1000));
    }
    return summary;
  }

  private stopSong() {
    try {
      this.songSrc?.stop();
    } catch {
      /* already stopped */
    }
    this.songSrc?.disconnect();
    this.songGain?.disconnect();
    this.songSrc = null;
    this.songGain = null;
  }

  /**
   * The run of misses right before stopping means the player had already stopped
   * tapping; don't count it against them.
   */
  private dropTrailingMisses() {
    let n = 0;
    while (this.trace.length && this.trace[this.trace.length - 1].g === "miss") {
      this.trace.pop();
      n++;
    }
    this.stats.miss -= n;
  }

  private addTrace(h: TraceHit) {
    if (this.trace.length < MAX_TRACE) this.trace.push(h);
  }

  setVolume(v: number) {
    this.synth?.setVolume(v);
  }

  setVoice(v: VoiceId) {
    this.synth?.setVoice(v);
  }

  setSongVolume(v: number) {
    if (this.songGain) this.songGain.gain.value = v;
    if (this.song) this.song.volume = v;
  }

  get liveStats(): LiveStats {
    return this.stats;
  }

  /** Grid slots of bar `i` as displayed and judged (null if there is no such bar). */
  slotsOf(i: number): BarSlot[] | null {
    if (this.song) {
      const b = this.song.bars[i];
      return b ? gridSlots(b.cells) : null;
    }
    return this.patternSlots;
  }

  /** Feed a tap. `code` is a DOM KeyboardEvent.code; `t` a performance.now() timestamp. */
  hit(code: string, t: number = performance.now()) {
    if (!this.running || !this.cfg.judge) return;
    const { keys, keyMode, strictAlternate, windows } = this.cfg;
    let hand: 0 | 1;
    if (code === keys[0]) hand = 0;
    else if (keyMode === "alternate" && code === keys[1]) hand = 1;
    else return;

    this.expireMisses(t);
    let best = -1;
    let bestAbs = Infinity;
    for (let i = 0; i < this.pending.length; i++) {
      const d = Math.abs(t - this.pending[i].expected);
      if (d <= windows.good && d < bestAbs) {
        best = i;
        bestAbs = d;
      }
    }
    if (best < 0) {
      recordStray(this.stats);
      this.addTrace({
        t: Math.round(t - this.t0Perf),
        off: null,
        g: "stray",
        n: -1,
        ...(keyMode === "alternate" ? { k: hand } : {}),
      });
      this.cb.onStray?.(this.stats);
      return;
    }
    const note = this.pending.splice(best, 1)[0];
    const offset = t - note.expected;
    let grade: Grade;
    let wrongHand = false;
    if (keyMode === "alternate" && strictAlternate && hand !== note.hand) {
      grade = "miss";
      wrongHand = true;
    } else if (bestAbs <= windows.perfect) grade = "perfect";
    else if (bestAbs <= windows.great) grade = "great";
    else grade = "good";
    record(this.stats, grade, grade === "miss" ? null : offset);
    this.addTrace({
      t: Math.round(note.expected - this.cfg.calibrationMs - this.t0Perf),
      off: grade === "miss" ? null : Math.round(offset * 10) / 10,
      g: grade,
      n: note.noteIndex,
      ...(keyMode === "alternate" ? { k: hand } : {}),
      ...(keyMode === "alternate" && strictAlternate ? { h: note.hand } : {}),
      ...(wrongHand ? { wrong: true } : {}),
    });
    this.cb.onResult?.(
      { bar: note.bar, noteIndex: note.noteIndex, grade, offset: grade === "miss" ? null : offset, wrongHand },
      this.stats,
    );
  }

  /** Audio seconds -> performance.now() ms of when it is heard. */
  audioToPerf(t: number): number {
    return t * 1000 + this.clockOffset;
  }

  private syncClock() {
    const ctx = this.ctx!;
    let sample: number | null = null;
    const ts = typeof ctx.getOutputTimestamp === "function" ? ctx.getOutputTimestamp() : null;
    if (ts && ts.performanceTime && ts.contextTime !== undefined && ts.performanceTime > 0 && ts.contextTime > 0) {
      sample = ts.performanceTime - ts.contextTime * 1000;
    }
    if (sample === null) {
      const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
      sample = performance.now() - (ctx.currentTime - lat) * 1000;
    }
    if (!this.clockReady || Math.abs(sample - this.clockOffset) > 50) {
      this.clockOffset = sample;
      this.clockReady = true;
    } else {
      this.clockOffset += (sample - this.clockOffset) * 0.05;
    }
  }

  private expireMisses(now: number) {
    const w = this.cfg.windows.good;
    while (this.pending.length && now > this.pending[0].expected + w) {
      const n = this.pending.shift()!;
      record(this.stats, "miss", null);
      this.addTrace({
        t: Math.round(n.expected - this.cfg.calibrationMs - this.t0Perf),
        off: null,
        g: "miss",
        n: n.noteIndex,
        ...(this.cfg.keyMode === "alternate" && this.cfg.strictAlternate ? { h: n.hand } : {}),
      });
      this.cb.onResult?.({ bar: n.bar, noteIndex: n.noteIndex, grade: "miss", offset: null }, this.stats);
    }
  }

  /** Bar `i` in session time. Metronome bars are uniform; song bars follow the chart. */
  private barAt(i: number): PlayBar | null {
    if (this.song) {
      const b = this.song.bars[i];
      if (!b) return null;
      return { start: b.start, beats: b.beats, end: b.end, slots: gridSlots(b.cells), countIn: false };
    }
    const first = this.cfg.countIn ? -1 : 0;
    const start = (i - first) * this.barLen;
    const spb = this.barLen / this.cfg.beats;
    return {
      start,
      beats: Array.from({ length: this.cfg.beats }, (_, k) => start + k * spb),
      end: start + this.barLen,
      slots: this.patternSlots,
      countIn: i < 0,
    };
  }

  private tick() {
    if (!this.running || !this.ctx) return;
    this.syncClock();
    this.expireMisses(performance.now());
    const ctx = this.ctx;
    const horizon = ctx.currentTime + LOOKAHEAD_S;
    const cfg = this.cfg;
    const song = this.song;

    if (song && this.songEnded) {
      // all notes scheduled: finish once the audio is over and the last note judged
      if (!this.pending.length && ctx.currentTime > this.origin + song.buffer.duration) this.cb.onEnd?.();
      return;
    }

    for (;;) {
      if (!this.curBar) {
        this.curBar = this.barAt(this.bar);
        if (!this.curBar) {
          this.songEnded = true;
          return;
        }
      }
      const bar = this.curBar;
      const slot = bar.slots[this.slotIdx];
      const bs = bar.beats[slot.beat];
      const be = bar.beats[slot.beat + 1] ?? bar.end;
      const time = this.origin + bs + (slot.sub / slot.subdivision) * (be - bs);
      if (time >= horizon) break;
      const countIn = bar.countIn;

      const beatKind = slot.beat === 0 && cfg.accent ? "accent" : "beat";
      if (song) {
        // overlay the chart itself (beats or drum notes), bar starts accented
        if (song.clicks && slot.isNote) this.synth!.click(time, slot.isBeatStart ? beatKind : "note");
      } else if (cfg.cue !== "visual") {
        if (countIn) {
          if (slot.isBeatStart) this.synth!.click(time, beatKind);
        } else if (cfg.muteBeatClick) {
          // Only the rhythm itself sounds; downbeat note keeps its accent.
          if (slot.isNote) this.synth!.click(time, slot.isBeatStart ? beatKind : "beat");
        } else if (slot.isBeatStart) this.synth!.click(time, beatKind);
        else if (cfg.soundPattern && slot.isNote) this.synth!.click(time, "note");
      }
      const perfTime = this.audioToPerf(time);
      this.cb.onSchedule?.({ bar: this.bar, slot, audioTime: time, perfTime, countIn });
      if (cfg.judge && !countIn && slot.isNote) {
        this.pending.push({
          bar: this.bar,
          noteIndex: slot.noteIndex,
          expected: perfTime + cfg.calibrationMs,
          hand: (this.noteCounter++ % 2) as 0 | 1,
        });
      }

      this.slotIdx++;
      if (this.slotIdx >= bar.slots.length) {
        this.slotIdx = 0;
        this.bar++;
        this.curBar = null;
      }
    }
  }
}
