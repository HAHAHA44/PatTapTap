// Beat + downbeat tracking with the "Beat This!" model (small0 checkpoint, MIT license,
// https://github.com/CPJKU/beat_this). This file holds the parts that must match the
// reference implementation exactly: the log-mel frontend, chunking and peak picking.
// Running the network itself is injected (`RunModel`), so this stays platform-free.

import { beatSlope, makeFft, OnsetInfo, smoothBeats, SongAnalysis } from "./beatTrack";
import melBands from "./model/melfb.json";

export const BT_SR = 22050;
const N_FFT = 1024;
const HOP = 441; // 50 frames per second
const FPS = BT_SR / HOP;
const N_MELS = 128;
const CHUNK = 1500;
const BORDER = 6;

/** Runs the network on one (T x 128) spectrogram chunk; returns per-frame logits. */
export type RunModel = (spect: Float32Array, frames: number) => Promise<{ beat: Float32Array; downbeat: Float32Array }>;

/**
 * Log-mel spectrogram identical to torchaudio's MelSpectrogram(n_fft=1024, hop=441,
 * f_min=30, f_max=11000, n_mels=128, slaney, normalized="frame_length", power=1)
 * followed by log1p(1000 * x). Input: mono audio at 22.05 kHz. Output: frames x 128.
 */
export function logMel(x: Float32Array): { data: Float32Array; frames: number } {
  const pad = N_FFT / 2;
  const frames = 1 + Math.floor(x.length / HOP);
  const fft = makeFft(N_FFT);
  const win = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT); // periodic Hann
  // torchaudio's normalized="frame_length" divides the magnitude by sqrt(n_fft)
  const norm = 1 / Math.sqrt(N_FFT);
  // centred frames with reflect padding, like torch.stft(center=True, pad_mode="reflect")
  const at = (i: number) => {
    let j = i - pad;
    const n = x.length;
    if (n === 1) return x[0];
    while (j < 0 || j >= n) j = j < 0 ? -j : 2 * (n - 1) - j;
    return x[j];
  };
  const buf = new Float64Array(N_FFT);
  const mag = new Float64Array(N_FFT / 2 + 1);
  const out = new Float32Array(frames * N_MELS);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N_FFT; i++) buf[i] = at(off + i) * win[i];
    fft(buf, mag);
    for (let m = 0; m < N_MELS; m++) {
      const band = melBands[m];
      let s = 0;
      for (let k = 0; k < band.w.length; k++) s += band.w[k] * mag[band.start + k];
      out[f * N_MELS + m] = Math.log1p(1000 * s * norm);
    }
  }
  return { data: out, frames };
}

/** Run the model over the whole piece in overlapping chunks (keep-first aggregation). */
export async function predictFrames(
  mel: { data: Float32Array; frames: number },
  run: RunModel,
  progress?: (p: number) => void,
): Promise<{ beat: Float32Array; downbeat: Float32Array }> {
  const T = mel.frames;
  const beat = new Float32Array(T).fill(-1000);
  const down = new Float32Array(T).fill(-1000);
  const starts: number[] = [];
  for (let s = -BORDER; s < T - BORDER; s += CHUNK - 2 * BORDER) starts.push(s);
  if (T > CHUNK - 2 * BORDER) starts[starts.length - 1] = T - (CHUNK - BORDER);
  const written = new Uint8Array(T);
  for (let c = 0; c < starts.length; c++) {
    const start = starts[c];
    const from = Math.max(start, 0);
    const to = Math.min(start + CHUNK, T);
    const left = Math.max(0, -start);
    const right = Math.max(0, Math.min(BORDER, start + CHUNK - T));
    const len = left + (to - from) + right;
    const chunk = new Float32Array(len * N_MELS);
    chunk.set(mel.data.subarray(from * N_MELS, to * N_MELS), left * N_MELS);
    const pred = await run(chunk, len);
    // drop the border on both sides, earlier chunks win where chunks overlap
    for (let i = BORDER; i < len - BORDER; i++) {
      const t = start + i;
      if (t < 0 || t >= T || written[t]) continue;
      written[t] = 1;
      beat[t] = pred.beat[i];
      down[t] = pred.downbeat[i];
    }
    progress?.((c + 1) / starts.length);
  }
  return { beat, downbeat: down };
}

/** Frames that are local maxima (window 7) with positive logit, adjacent ones averaged. */
function peaks(logits: Float32Array): number[] {
  const idx: number[] = [];
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] <= 0) continue;
    let isMax = true;
    for (let k = Math.max(0, i - 3); k <= Math.min(logits.length - 1, i + 3); k++) {
      if (logits[k] > logits[i]) {
        isMax = false;
        break;
      }
    }
    if (isMax) idx.push(i);
  }
  const out: number[] = [];
  let p = idx[0];
  let c = 1;
  for (let k = 1; k < idx.length; k++) {
    if (idx[k] - p <= 1) {
      c++;
      p += (idx[k] - p) / c;
    } else {
      out.push(p);
      p = idx[k];
      c = 1;
    }
  }
  if (idx.length) out.push(p);
  // sub-frame position from a parabola through the peak and its neighbours: the
  // network's 20 ms frames otherwise round every beat by up to ±10 ms
  return out.map((q) => {
    const i = Math.round(q);
    if (i !== q || i <= 0 || i >= logits.length - 1) return q;
    const a = logits[i - 1], b = logits[i], c = logits[i + 1];
    const den = a - 2 * b + c;
    return den < 0 ? i + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : i;
  });
}

/** Beat and downbeat times (s); downbeats snapped onto the nearest beat. */
export function framesToBeats(pred: { beat: Float32Array; downbeat: Float32Array }): { beats: number[]; downbeats: number[]; meanProb: number } {
  const beatFrames = peaks(pred.beat);
  const beats = beatFrames.map((f) => f / FPS);
  const sig = (v: number) => 1 / (1 + Math.exp(-v));
  const meanProb = beatFrames.length ? beatFrames.reduce((s, f) => s + sig(pred.beat[Math.round(f)]), 0) / beatFrames.length : 0;
  let downbeats = peaks(pred.downbeat).map((f) => f / FPS);
  if (beats.length) {
    downbeats = downbeats.map((d) => beats.reduce((best, b) => (Math.abs(b - d) < Math.abs(best - d) ? b : best), beats[0]));
    downbeats = [...new Set(downbeats)].sort((a, b) => a - b);
  }
  return { beats, downbeats, meanProb };
}

/**
 * Combine the model's beats and bar starts with the detected drum onsets. Beat times
 * are smoothed to remove the model's 20 ms frame rounding. Throws if the model found
 * no usable beat grid (e.g. silence or non-music).
 */
export function buildAnalysis(info: OnsetInfo, m: { beats: number[]; downbeats: number[]; meanProb: number }): SongAnalysis {
  if (m.beats.length < 8) throw new Error("no beats found");
  const beats = m.beats.slice();
  // bar starts as beat indices (downbeats were snapped onto beats); first one anchors
  const nearest = (t: number) => {
    let idx = 0;
    for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i] - t) < Math.abs(beats[idx] - t)) idx = i;
    return idx;
  };
  const bars = [...new Set(m.downbeats.map(nearest))].sort((a, b) => a - b);
  const idx = bars[0] ?? 0;
  smoothBeats(beats);
  return {
    version: 2,
    durationSec: info.durationSec,
    beats: beats.map((b) => Math.round(b * 1000) / 1000),
    bpm: Math.round((60 / beatSlope(beats)) * 10) / 10,
    downbeat: idx,
    bars,
    onsets: info.onsets,
    confidence: Math.round(m.meanProb * 100) / 100,
    beatSource: "model",
  };
}
