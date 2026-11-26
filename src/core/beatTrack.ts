// Audio analysis helpers for "practice with a song": per-band drum-ish onset
// detection plus beat-list utilities. Beats and bar starts come from the Beat This
// model (beatThis.ts). Pure TS, no platform deps.

export interface SongAnalysis {
  version: 2;
  durationSec: number;
  /** Median tempo from the tracked beats. */
  bpm: number;
  /** Beat times in seconds from the start of the audio. */
  beats: number[];
  /** Index into `beats` of the first bar start (4/4); beats before it are a pickup. */
  downbeat: number;
  /** Onset times (s) per band: low ≈ kick, mid ≈ snare/body, high ≈ hats/cymbals. */
  onsets: { low: number[]; mid: number[]; high: number[] };
  /** 0..1, the model's mean beat probability at the detected beats. */
  confidence: number;
  /** "model" for every current analysis; older stored songs lack it (re-analyze them). */
  beatSource?: "model";
}

const FRAME = 1024;
const HOP = 256;

// ---------------------------------------------------------------- FFT
export function makeFft(n: number) {
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  /** In-place real FFT of `input`; returns magnitudes of bins 0..n/2. */
  return (input: Float64Array, mag: Float64Array) => {
    for (let i = 0; i < n; i++) {
      re[rev[i]] = input[i];
      im[rev[i]] = 0;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const tr = re[i + j + half] * cos[k] + im[i + j + half] * sin[k];
          const ti = -re[i + j + half] * sin[k] + im[i + j + half] * cos[k];
          re[i + j + half] = re[i + j] - tr;
          im[i + j + half] = im[i + j] - ti;
          re[i + j] += tr;
          im[i + j] += ti;
        }
      }
    }
    for (let i = 0; i <= n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  };
}

// ---------------------------------------------------------------- onset envelopes
interface Envelopes {
  full: Float64Array;
  low: Float64Array;
  mid: Float64Array;
  high: Float64Array;
  /** seconds per envelope frame */
  dt: number;
  /** time (s) of envelope frame 0 */
  t0: number;
}

/** Log-magnitude spectral flux, overall and in three bands. */
function onsetEnvelopes(x: Float32Array, sr: number, progress?: (p: number) => void): Envelopes {
  const nFrames = Math.max(0, Math.floor((x.length - FRAME) / HOP) + 1);
  const fft = makeFft(FRAME);
  const win = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  const buf = new Float64Array(FRAME);
  const bins = FRAME / 2 + 1;
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  // Band envelopes use linear magnitude: log compression would make a quiet
  // hi-hat look as strong as a snare in the mid band.
  let prevLin = new Float64Array(bins);
  let curLin = new Float64Array(bins);
  const hz = sr / FRAME;
  const lowEnd = Math.round(150 / hz);
  const midEnd = Math.round(3000 / hz);
  const highStart = Math.round(5000 / hz);
  const full = new Float64Array(nFrames);
  const low = new Float64Array(nFrames);
  const mid = new Float64Array(nFrames);
  const high = new Float64Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) buf[i] = x[off + i] * win[i];
    fft(buf, curLin);
    for (let i = 0; i < bins; i++) cur[i] = Math.log1p(1000 * curLin[i]);
    if (f > 0) {
      let a = 0, l = 0, m = 0, h = 0;
      for (let i = 1; i < bins; i++) {
        const d = cur[i] - prev[i];
        if (d > 0) a += d;
        const dl = curLin[i] - prevLin[i];
        if (dl <= 0) continue;
        if (i <= lowEnd) l += dl;
        else if (i <= midEnd) m += dl;
        else if (i >= highStart) h += dl;
      }
      full[f] = a;
      low[f] = l;
      mid[f] = m;
      high[f] = h;
    }
    [prev, cur] = [cur, prev];
    [prevLin, curLin] = [curLin, prevLin];
    if (progress && f % 2000 === 0) progress((0.7 * f) / nFrames);
  }
  // An attack produces its flux peak once it is ~80% into the Hann window (calibrated
  // against synthetic drum hits; using the window centre read ~20 ms early).
  return { full, low, mid, high, dt: HOP / sr, t0: (FRAME * 0.8) / sr };
}

/** Subtract a local mean (high-pass) and half-wave rectify, then normalise. */
function detrend(e: Float64Array, radius: number): Float64Array {
  const n = e.length;
  const out = new Float64Array(n);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + e[i];
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius);
    const b = Math.min(n, i + radius + 1);
    const v = Math.max(0, e[i] - (pre[b] - pre[a]) / (b - a));
    out[i] = v;
    sq += v * v;
  }
  const sd = Math.sqrt(sq / Math.max(1, n)) || 1;
  for (let i = 0; i < n; i++) out[i] /= sd;
  return out;
}

/** Peaks above an adaptive threshold, at least `minGap` frames apart. */
function pickPeaks(e: Float64Array, minGap: number, k = 1.5): number[] {
  const n = e.length;
  const peaks: number[] = [];
  const R = 20; // ~0.23 s local window at 22.05 kHz / 256 hop
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + e[i];
  let mean = pre[n] / Math.max(1, n);
  for (let i = 1; i < n - 1; i++) {
    if (e[i] < e[i - 1] || e[i] < e[i + 1]) continue;
    const a = Math.max(0, i - R), b = Math.min(n, i + R + 1);
    const local = (pre[b] - pre[a]) / (b - a);
    if (e[i] < k * local + 0.3 * mean) continue;
    if (peaks.length && i - peaks[peaks.length - 1] < minGap) {
      if (e[i] > e[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i;
      continue;
    }
    peaks.push(i);
  }
  return peaks;
}

/** Sub-frame peak position via parabola through the neighbours. */
function refine(e: Float64Array, i: number): number {
  if (i <= 0 || i >= e.length - 1) return i;
  const a = e[i - 1], b = e[i], c = e[i + 1];
  const den = a - 2 * b + c;
  return den !== 0 ? i + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : i;
}

/** Least-squares slope of beat time vs. index = mean beat interval (s). */
export function beatSlope(beats: number[]): number {
  const n = beats.length;
  if (n < 2) return 0.5;
  const mx = (n - 1) / 2;
  const my = beats.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  beats.forEach((y, x) => {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  });
  return num / den;
}

/**
 * Beats sit on whole analysis frames (~11.6 ms). Replace each with a local linear
 * fit over its neighbours: removes that rounding but still follows tempo drift.
 */
export function smoothBeats(beats: number[], radius = 4) {
  const src = beats.slice();
  for (let i = 0; i < src.length; i++) {
    const a = Math.max(0, i - radius), b = Math.min(src.length - 1, i + radius);
    if (b - a < 2) continue;
    const xs: number[] = [], ys: number[] = [];
    for (let k = a; k <= b; k++) {
      xs.push(k);
      ys.push(src[k]);
    }
    const mx = xs.reduce((p, q) => p + q, 0) / xs.length, my = ys.reduce((p, q) => p + q, 0) / ys.length;
    let num = 0, den = 0;
    xs.forEach((x, j) => {
      num += (x - mx) * (ys[j] - my);
      den += (x - mx) ** 2;
    });
    beats[i] = my + (num / den) * (i - mx);
  }
}

// ---------------------------------------------------------------- drum onsets
/** What the signal-processing part contributes: drum-ish onsets per band. Beats and
 *  bar starts come from the Beat This model (see beatThis.ts). */
export interface OnsetInfo {
  durationSec: number;
  onsets: { low: number[]; mid: number[]; high: number[] };
}

/** Detect drum-ish onsets in mono samples (~0.3 s for a 4-minute song at 22.05 kHz). */
export function detectOnsets(x: Float32Array, sr: number, progress?: (p: number) => void): OnsetInfo {
  const env = onsetEnvelopes(x, sr, progress);
  const toSec = (f: number) => env.t0 + f * env.dt;
  const radius = Math.round(0.25 / env.dt);
  const minGap = Math.round(0.06 / env.dt);
  const bandPeaks = (e: Float64Array) => {
    const d = detrend(e, radius);
    const peaks = pickPeaks(d, minGap);
    return { times: peaks.map((f) => Math.round(toSec(refine(d, f)) * 1000) / 1000), strength: peaks.map((f) => d[f]) };
  };
  /**
   * Keep only onsets at least `frac` as strong as the band's loud hits (90th pct).
   * Hi-hats and bass notes leak into the low/mid bands but are much weaker there
   * than kicks and snares, so this separates "drum" hits from bleed.
   */
  const strongOnly = (p: { times: number[]; strength: number[] }, frac: number) => {
    const sorted = [...p.strength].sort((q, r) => q - r);
    const ref = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    return p.times.filter((_, i) => p.strength[i] >= frac * ref);
  };
  const onsets = {
    low: strongOnly(bandPeaks(env.low), 0.3),
    mid: strongOnly(bandPeaks(env.mid), 0.45),
    high: bandPeaks(env.high).times,
  };
  progress?.(1);
  return { durationSec: x.length / sr, onsets };
}

/**
 * Fix an octave error in tempo detection, anchored on the bar start: the beat at
 * index `downbeat` stays a bar start at the same time. `factor` 2 inserts a beat
 * between each pair; 0.5 keeps every other beat counting from the anchor. So x2
 * followed by /2 gives back exactly the original beats.
 */
export function rescaleTempo(a: SongAnalysis, factor: 0.5 | 2): SongAnalysis {
  const anchor = a.downbeat;
  let beats: number[];
  let anchorNew: number;
  if (factor === 2) {
    beats = [];
    a.beats.forEach((b, i) => {
      beats.push(b);
      if (i + 1 < a.beats.length) beats.push(Math.round(((b + a.beats[i + 1]) / 2) * 1000) / 1000);
    });
    anchorNew = anchor * 2;
  } else {
    const parity = anchor % 2;
    beats = a.beats.filter((_, i) => i % 2 === parity);
    anchorNew = (anchor - parity) / 2;
  }
  // Keep the anchor's absolute index (not mod 4): after x2 a bar spans only half the
  // old one, and the exact anchor is what lets /2 pick the right beats back.
  return { ...a, beats, bpm: Math.round(a.bpm * factor * 10) / 10, downbeat: anchorNew };
}

/** Average stereo/multi-channel to mono and decimate by an integer factor. */
export function toMono(channels: Float32Array[], factor = 1): Float32Array {
  const n = Math.floor(channels[0].length / factor);
  const out = new Float32Array(n);
  const k = 1 / (channels.length * factor);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const ch of channels) for (let j = 0; j < factor; j++) s += ch[i * factor + j];
    out[i] = s * k;
  }
  return out;
}
