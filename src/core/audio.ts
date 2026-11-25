export type ClickKind = "accent" | "beat" | "note";

const VOICES: Record<ClickKind, { freq: number; gain: number; dur: number }> = {
  accent: { freq: 1760, gain: 1.0, dur: 0.06 },
  beat: { freq: 1175, gain: 0.75, dur: 0.05 },
  note: { freq: 2350, gain: 0.35, dur: 0.035 },
};

/** Tiny synthesized click voice; schedules sample-accurate blips on the audio clock. */
export class ClickSynth {
  private master: GainNode;

  constructor(private ctx: AudioContext) {
    this.master = this.makeMaster();
  }

  private makeMaster(): GainNode {
    const g = this.ctx.createGain();
    g.connect(this.ctx.destination);
    return g;
  }

  setVolume(v: number) {
    this.master.gain.value = Math.max(0, Math.min(1, v));
  }

  /** Silence everything already scheduled (used on stop). */
  cut() {
    const vol = this.master.gain.value;
    this.master.disconnect();
    this.master = this.makeMaster();
    this.master.gain.value = vol;
  }

  click(time: number, kind: ClickKind) {
    const v = VOICES[kind];
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(v.freq, time);
    env.gain.setValueAtTime(0.0001, time);
    env.gain.exponentialRampToValueAtTime(v.gain, time + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, time + v.dur);
    osc.connect(env).connect(this.master);
    osc.start(time);
    osc.stop(time + v.dur + 0.01);
  }
}
