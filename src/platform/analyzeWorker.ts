// Runs song analysis off the UI thread:
// 1. built-in DSP analysis (drum onsets per band; beats as a fallback)
// 2. the Beat This model for beats and downbeats (onnxruntime-web, single-threaded WASM)
import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { analyzeSong } from "../core/beatTrack";
import { BT_SR, framesToBeats, logMel, predictFrames, withModelBeats } from "../core/beatThis";

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = 1; // no cross-origin isolation in the webview, so no threads

let session: Promise<ort.InferenceSession> | null = null;
function model() {
  session ??= fetch("/models/beat_this_small.onnx")
    .then((r) => {
      if (!r.ok) throw new Error(`model fetch ${r.status}`);
      return r.arrayBuffer();
    })
    .then((buf) => ort.InferenceSession.create(buf, { executionProviders: ["wasm"] }));
  return session;
}

const post = (m: unknown) => self.postMessage(m);

self.onmessage = async (e: MessageEvent<{ samples: Float32Array; sr: number }>) => {
  const { samples, sr } = e.data;
  try {
    // DSP part: 0 .. 25 %
    const dsp = analyzeSong(samples, sr, (p) => post({ progress: p * 0.25 }));
    let result = { ...dsp, beatSource: "dsp" as const };
    if (sr === BT_SR) {
      try {
        const sess = await model();
        const mel = logMel(samples);
        post({ progress: 0.3 });
        const pred = await predictFrames(
          mel,
          async (spect, frames) => {
            const r = await sess.run({ spect: new ort.Tensor("float32", spect, [1, frames, 128]) });
            return { beat: r.beat.data as Float32Array, downbeat: r.downbeat.data as Float32Array };
          },
          (p) => post({ progress: 0.3 + p * 0.7 }),
        );
        result = withModelBeats(dsp, framesToBeats(pred)) as typeof result;
      } catch (err) {
        // keep the DSP beats; the song is still usable
        post({ warning: `model unavailable: ${String(err)}` });
      }
    }
    post({ result });
  } catch (err) {
    post({ error: String(err) });
  }
};
