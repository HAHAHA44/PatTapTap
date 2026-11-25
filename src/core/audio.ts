export type ClickKind = "accent" | "beat" | "note";

/** Available cue sounds. All synthesized, so no audio assets ship with the app. */
export const VOICES = ["wood", "soft", "classic", "tick", "drum"] as const;
export type VoiceId = (typeof VOICES)[number];

interface ToneSpec {
  type: OscillatorType;
  freq: number;
  /** Pitch glides to this frequency over `glide` seconds (drums, wood). */
  freqEnd?: number;
  glide?: number;
  gain: number;
  attack: number;
  decay: number;
  lowpass?: number;
}

interface NoiseSpec {
  gain: number;
  decay: number;
  filter: BiquadFilterType;
  freq: number;
  q?: number;
}

type Layer = { tone: ToneSpec } | { noise: NoiseSpec };

/** Each voice: the layers played for an accent, a plain beat and a pattern note. */
const VOICE_DEFS: Record<VoiceId, Record<ClickKind, Layer[]>> = {
  // Bright, sharp electronic metronome.
  classic: {
    accent: [{ tone: { type: "triangle", freq: 1760, gain: 1, attack: 0.002, decay: 0.06 } }],
    beat: [{ tone: { type: "triangle", freq: 1175, gain: 0.75, attack: 0.002, decay: 0.05 } }],
    note: [{ tone: { type: "triangle", freq: 2350, gain: 0.35, attack: 0.002, decay: 0.035 } }],
  },
  // Gentle rounded "boop", low-passed.
  soft: {
    accent: [{ tone: { type: "sine", freq: 880, gain: 0.82, attack: 0.006, decay: 0.14, lowpass: 2000 } }],
    beat: [{ tone: { type: "sine", freq: 660, gain: 0.7, attack: 0.006, decay: 0.12, lowpass: 2000 } }],
    note: [{ tone: { type: "sine", freq: 990, gain: 0.3, attack: 0.005, decay: 0.08, lowpass: 2000 } }],
  },
  // Woodblock: short pitched knock with a little noise for the attack.
  wood: {
    accent: [
      { tone: { type: "sine", freq: 1700, freqEnd: 1050, glide: 0.006, gain: 0.85, attack: 0.001, decay: 0.07 } },
      { noise: { gain: 0.25, decay: 0.012, filter: "bandpass", freq: 2400, q: 2 } },
    ],
    beat: [
      { tone: { type: "sine", freq: 1300, freqEnd: 800, glide: 0.006, gain: 0.8, attack: 0.001, decay: 0.06 } },
      { noise: { gain: 0.2, decay: 0.01, filter: "bandpass", freq: 2000, q: 2 } },
    ],
    note: [
      { tone: { type: "sine", freq: 1900, freqEnd: 1250, glide: 0.005, gain: 0.35, attack: 0.001, decay: 0.045 } },
    ],
  },
  // Quiet mechanical tick-tock.
  tick: {
    accent: [{ noise: { gain: 3.4, decay: 0.02, filter: "bandpass", freq: 2600, q: 3 } }],
    beat: [{ noise: { gain: 4.2, decay: 0.015, filter: "bandpass", freq: 1800, q: 3 } }],
    note: [{ noise: { gain: 0.22, decay: 0.01, filter: "highpass", freq: 4000 } }],
  },
  // Drum kit: kick on the accent, snare-ish rim on beats, closed hi-hat on notes.
  drum: {
    accent: [
      { tone: { type: "sine", freq: 150, freqEnd: 45, glide: 0.12, gain: 1, attack: 0.002, decay: 0.28 } },
      { noise: { gain: 0.15, decay: 0.01, filter: "lowpass", freq: 3000 } },
    ],
    beat: [
      { noise: { gain: 0.55, decay: 0.12, filter: "bandpass", freq: 1800, q: 0.7 } },
      { tone: { type: "triangle", freq: 200, freqEnd: 160, glide: 0.05, gain: 0.45, attack: 0.002, decay: 0.08 } },
    ],
    note: [{ noise: { gain: 0.3, decay: 0.04, filter: "highpass", freq: 7000 } }],
  },
};

/** Synthesized cue voices; schedules sample-accurate sounds on the audio clock. */
export class ClickSynth {
  private master: GainNode;
  private noiseBuf: AudioBuffer;
  private voice: VoiceId = "wood";

  constructor(private ctx: AudioContext) {
    this.master = this.makeMaster();
    // One second of white noise, reused by every noise layer.
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const ch = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  }

  private makeMaster(): GainNode {
    const g = this.ctx.createGain();
    g.connect(this.ctx.destination);
    return g;
  }

  setVolume(v: number) {
    this.master.gain.value = Math.max(0, Math.min(1, v));
  }

  setVoice(v: VoiceId) {
    this.voice = VOICE_DEFS[v] ? v : "wood";
  }

  /** Silence everything already scheduled (used on stop). */
  cut() {
    const vol = this.master.gain.value;
    this.master.disconnect();
    this.master = this.makeMaster();
    this.master.gain.value = vol;
  }

  click(time: number, kind: ClickKind) {
    for (const layer of VOICE_DEFS[this.voice][kind]) {
      if ("tone" in layer) this.tone(time, layer.tone);
      else this.noise(time, layer.noise);
    }
  }

  /** A short "accent, beat, beat, note" phrase so the user can hear a voice. */
  preview() {
    const t0 = this.ctx.currentTime + 0.05;
    const kinds: ClickKind[] = ["accent", "note", "beat", "note", "beat", "note", "beat"];
    kinds.forEach((k, i) => this.click(t0 + i * 0.18, k));
  }

  private envelope(time: number, gain: number, attack: number, decay: number): GainNode {
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, time);
    env.gain.exponentialRampToValueAtTime(gain, time + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, time + attack + decay);
    env.connect(this.master);
    return env;
  }

  private tone(time: number, s: ToneSpec) {
    const osc = this.ctx.createOscillator();
    osc.type = s.type;
    osc.frequency.setValueAtTime(s.freq, time);
    if (s.freqEnd && s.glide) osc.frequency.exponentialRampToValueAtTime(s.freqEnd, time + s.glide);
    const env = this.envelope(time, s.gain, s.attack, s.decay);
    if (s.lowpass) {
      const lp = this.ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = s.lowpass;
      osc.connect(lp).connect(env);
    } else osc.connect(env);
    osc.start(time);
    osc.stop(time + s.attack + s.decay + 0.02);
  }

  private noise(time: number, s: NoiseSpec) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = s.filter;
    f.frequency.value = s.freq;
    if (s.q) f.Q.value = s.q;
    src.connect(f).connect(this.envelope(time, s.gain, 0.001, s.decay));
    src.start(time, Math.random() * 0.5);
    src.stop(time + s.decay + 0.02);
  }
}
