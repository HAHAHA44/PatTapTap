// Audio analysis for "practice with a song": onset detection, tempo estimation,
// beat tracking (dynamic programming after Ellis 2007), downbeat guess and
// per-band drum-ish onsets. Pure TS, no platform deps, no GPL code.

export interface SongAnalysis {
  version: 1;
  durationSec: number;
  /** Median tempo from the tracked beats. */
  bpm: number;
  /** Beat times in seconds from the start of the audio. */
  beats: number[];
  /** Index into `beats` of the first downbeat (bar start), assuming 4/4. */
  downbeat: number;
  /** Onset times (s) per band: low ≈ kick, mid ≈ snare/body, high ≈ hats/cymbals. */
  onsets: { low: number[]; mid: number[]; high: number[] };
  /** Strength of each low-band onset (parallel to onsets.low), for bar-phase picking. */
  lowStrength: number[];
  /** 0..1, how strongly onsets line up with the tracked beats. */
  confidence: number;
}

const FRAME = 1024;
const HOP = 256;

// ---------------------------------------------------------------- FFT
function makeFft(n: number) {
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

// ---------------------------------------------------------------- tempo
/** Period in frames (fractional) of the dominant pulse, biased towards ~120 BPM. */
function estimatePeriod(o: Float64Array, dt: number): number {
  const minLag = Math.floor(60 / 220 / dt);
  const maxLag = Math.ceil(60 / 50 / dt);
  const n = o.length;
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += o[i] * o[i - lag];
    ac[lag] = s / (n - lag);
  }
  let best = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * dt);
    const w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = w * ac[lag];
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // parabolic refinement around the peak
  const a = ac[best - 1], b = ac[best], c = ac[best + 1];
  const den = a - 2 * b + c;
  const shift = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  return best + shift;
}

// ---------------------------------------------------------------- beat tracking
/** Ellis-style DP: beats where onsets are strong and spacing stays near `period`. */
function trackBeats(o: Float64Array, period: number, tightness = 100): number[] {
  const n = o.length;
  if (!n) return [];
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let i = 0; i < n; i++) {
    let best = 0;
    let arg = -1;
    for (let j = i - hi; j <= i - lo; j++) {
      if (j < 0) continue;
      const penalty = tightness * Math.log((i - j) / period) ** 2;
      const v = score[j] - penalty;
      if (arg < 0 || v > best) {
        best = v;
        arg = j;
      }
    }
    score[i] = o[i] + (arg >= 0 ? Math.max(0, best) : 0);
    back[i] = arg >= 0 && best > 0 ? arg : -1;
  }
  // end on the best-scoring frame within the last period
  let end = n - 1;
  for (let i = Math.max(0, n - Math.ceil(period)); i < n; i++) if (score[i] > score[end]) end = i;
  const beats: number[] = [];
  for (let i = end; i >= 0; i = back[i]) beats.push(i);
  beats.reverse();
  return beats;
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

// ---------------------------------------------------------------- main entry
/** Analyse mono samples. Takes ~0.5-2 s for a 4-minute song at 22.05 kHz. */
export function analyzeSong(x: Float32Array, sr: number, progress?: (p: number) => void): SongAnalysis {
  const env = onsetEnvelopes(x, sr, progress);
  const toSec = (f: number) => env.t0 + f * env.dt;
  const radius = Math.round(0.25 / env.dt);
  const o = detrend(env.full, radius);
  progress?.(0.75);

  const period = estimatePeriod(o, env.dt);
  const beatFrames = trackBeats(o, period);
  progress?.(0.9);

  // snap each beat to the strongest onset within ±40 ms, sub-frame refined
  const snap = Math.round(0.04 / env.dt);
  const beats = beatFrames.map((f) => {
    let best = f;
    for (let j = Math.max(0, f - snap); j <= Math.min(o.length - 1, f + snap); j++) if (o[j] > o[best]) best = j;
    return toSec(o[best] > 1.5 * o[f] ? refine(o, best) : f);
  });

  const diffs = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b);
  const medIv = diffs.length ? diffs[diffs.length >> 1] : 60 / 120;
  const bpm = Math.round((60 / medIv) * 10) / 10;

  // confidence: mean onset strength on beats vs everywhere
  let onBeat = 0;
  for (const f of beatFrames) onBeat += o[f];
  onBeat /= Math.max(1, beatFrames.length);
  let all = 0;
  for (let i = 0; i < o.length; i++) all += o[i];
  all /= Math.max(1, o.length);
  const ratio = all > 0 ? onBeat / all : 0;
  const confidence = Math.max(0, Math.min(1, (ratio - 1) / 3));

  const minGap = Math.round(0.06 / env.dt);
  const bandPeaks = (e: Float64Array) => {
    const d = detrend(e, radius);
    const peaks = pickPeaks(d, minGap);
    return { times: peaks.map((f) => Math.round(toSec(refine(d, f)) * 1000) / 1000), strength: peaks.map((f) => Math.round(d[f] * 100) / 100) };
  };
  /**
   * Keep only onsets at least `frac` as strong as the band's loud hits (90th pct).
   * Hi-hats and bass notes leak into the low/mid bands but are much weaker there
   * than kicks and snares, so this separates "drum" hits from bleed.
   */
  const strongOnly = (p: { times: number[]; strength: number[] }, frac: number) => {
    const sorted = [...p.strength].sort((x, y) => x - y);
    const ref = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    const keep = p.strength.map((v) => v >= frac * ref);
    return { times: p.times.filter((_, i) => keep[i]), strength: p.strength.filter((_, i) => keep[i]) };
  };
  const lowP = strongOnly(bandPeaks(env.low), 0.3);
  const onsets = { low: lowP.times, mid: strongOnly(bandPeaks(env.mid), 0.45).times, high: bandPeaks(env.high).times };
  const roundedBeats = beats.map((b) => Math.round(b * 1000) / 1000);
  progress?.(1);

  return {
    version: 1,
    durationSec: x.length / sr,
    bpm,
    beats: roundedBeats,
    downbeat: pickDownbeat(roundedBeats, onsets.low, lowP.strength),
    onsets,
    lowStrength: lowP.strength,
    confidence: Math.round(confidence * 100) / 100,
  };
}

/** Summed weight (default 1 each) of onsets within ±tol s of each beat (sorted inputs). */
function onsetsNear(beats: number[], onsets: number[], weights?: number[], tol = 0.05): number[] {
  const hits = new Array(beats.length).fill(0);
  let j = 0;
  beats.forEach((b, i) => {
    while (j < onsets.length && onsets[j] < b - tol) j++;
    for (let k = j; k < onsets.length && onsets[k] <= b + tol; k++) hits[i] += weights?.[k] ?? 1;
  });
  return hits;
}

/** Bar phase (assuming 4/4): the beat position mod 4 with the most kick energy. */
export function pickDownbeat(beats: number[], lowOnsets: number[], strength?: number[]): number {
  const near = onsetsNear(beats, lowOnsets, strength);
  let best = 0;
  let bestScore = -1;
  for (let ph = 0; ph < 4; ph++) {
    let sc = 0;
    // weight bar-start beats double vs. beat 3, which often also has a kick
    for (let i = ph; i < beats.length; i += 4) sc += near[i];
    if (sc > bestScore) {
      bestScore = sc;
      best = ph;
    }
  }
  return best;
}

/**
 * Fix an octave error in tempo detection. `factor` 0.5 keeps every other beat (the
 * half with more kick/snare onsets on it); 2 inserts a beat between each pair.
 */
export function rescaleTempo(a: SongAnalysis, factor: 0.5 | 2): SongAnalysis {
  let beats: number[];
  if (factor === 2) {
    beats = [];
    a.beats.forEach((b, i) => {
      beats.push(b);
      if (i + 1 < a.beats.length) beats.push(Math.round(((b + a.beats[i + 1]) / 2) * 1000) / 1000);
    });
  } else {
    const strong = [...a.onsets.low, ...a.onsets.mid].sort((x, y) => x - y);
    const near = onsetsNear(a.beats, strong);
    const even = near.filter((_, i) => i % 2 === 0).reduce((s, v) => s + v, 0);
    const odd = near.filter((_, i) => i % 2 === 1).reduce((s, v) => s + v, 0);
    beats = a.beats.filter((_, i) => i % 2 === (even >= odd ? 0 : 1));
  }
  return {
    ...a,
    beats,
    bpm: Math.round(a.bpm * factor * 10) / 10,
    downbeat: pickDownbeat(beats, a.onsets.low, a.lowStrength),
  };
}

/** Move the bar start one beat later (manual fix when the downbeat guess is off). */
export function shiftDownbeat(a: SongAnalysis): SongAnalysis {
  return { ...a, downbeat: (a.downbeat + 1) % 4 };
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
