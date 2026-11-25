import { ClickSynth, VoiceId } from "./audio";
import { expandBar } from "./pattern";
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

export interface EngineCallbacks {
  /** Fired when an event is scheduled (ahead of time). Use perfTime to render it. */
  onSchedule?(e: ScheduledEvent): void;
  onResult?(r: NoteResult, stats: LiveStats): void;
  onStray?(stats: LiveStats): void;
}

/**
 * Metronome + judge. Timing follows the "two clocks" pattern: a coarse timer
 * schedules sounds precisely on the AudioContext clock slightly ahead of time,
 * and audio time is mapped to performance.now() for visuals and judging.
 */
export class RhythmEngine {
  private ctx: AudioContext | null = null;
  private synth: ClickSynth | null = null;
  private ticker = new Ticker(TICK_MS, () => this.tick());
  private cfg!: EngineConfig;
  private slots: BarSlot[] = [];
  private slotIdx = 0;
  private bar = 0;
  private barStart = 0; // audio seconds
  private spb = 0.5;
  private pending: PendingNote[] = [];
  private noteCounter = 0;
  private clockOffset = 0; // perf ms = audio s * 1000 + clockOffset
  private clockReady = false;
  private startedAt = 0;
  private startToken = 0;
  private stats: LiveStats = emptyStats();
  private trace: TraceHit[] = [];
  private t0Perf = 0; // perf ms of bar 0 (after count-in)
  running = false;

  constructor(private cb: EngineCallbacks = {}) {}

  /** Must be awaited; may need a user gesture on some platforms. */
  async start(cfg: EngineConfig): Promise<boolean> {
    if (this.running) this.stop();
    // A newer start() (or a stop()) supersedes this one while we await the audio device.
    const token = ++this.startToken;
    this.cfg = cfg;
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
      this.synth = new ClickSynth(this.ctx);
    }
    try {
      await this.ctx.resume();
    } catch {
      /* ignore */
    }
    if (token !== this.startToken) return false;
    if (this.ctx.state !== "running") return false;
    this.synth!.setVolume(cfg.volume);
    this.synth!.setVoice(cfg.voice);
    this.clockReady = false;
    this.syncClock();
    this.slots = expandBar(cfg.pattern, cfg.beats);
    this.slotIdx = 0;
    this.bar = cfg.countIn ? -1 : 0;
    this.spb = 60 / cfg.bpm;
    this.barStart = this.ctx.currentTime + START_DELAY_S;
    this.pending = [];
    this.noteCounter = 0;
    this.stats = emptyStats();
    this.trace = [];
    this.t0Perf = this.audioToPerf(this.barStart + (cfg.countIn ? cfg.beats * this.spb : 0));
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
    // Notes already past their window count as misses; future ones are dropped.
    this.expireMisses(performance.now());
    this.pending = [];
    this.dropTrailingMisses();
    if (!this.cfg.judge || judgedCount(this.stats) + this.stats.stray === 0) return null;
    const summary = summarize(this.stats, this.cfg, this.startedAt);
    summary.detail = {
      trace: this.trace,
      truncated: this.trace.length >= MAX_TRACE,
      windows: { ...this.cfg.windows },
      calibrationMs: this.cfg.calibrationMs,
      cells: Array.from({ length: this.cfg.beats }, (_, i) => this.cfg.pattern.cells[i % this.cfg.pattern.cells.length]),
      strictAlternate: this.cfg.keyMode === "alternate" && this.cfg.strictAlternate,
    };
    return summary;
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

  get liveStats(): LiveStats {
    return this.stats;
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

  private tick() {
    if (!this.running || !this.ctx) return;
    this.syncClock();
    this.expireMisses(performance.now());
    const horizon = this.ctx.currentTime + LOOKAHEAD_S;
    const cfg = this.cfg;
    for (;;) {
      const slot = this.slots[this.slotIdx];
      const time = this.barStart + slot.pos * this.spb;
      if (time >= horizon) break;
      const countIn = this.bar < 0;

      if (cfg.cue !== "visual") {
        const beatKind = slot.beat === 0 && cfg.accent ? "accent" : "beat";
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
      if (this.slotIdx >= this.slots.length) {
        this.slotIdx = 0;
        this.bar++;
        this.barStart += cfg.beats * this.spb;
      }
    }
  }
}
