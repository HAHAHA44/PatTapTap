// Runs song analysis off the UI thread:
// - beats and bar starts: the Beat This model (onnxruntime-web, single-threaded WASM)
// - drum onsets per band: signal processing (only used for the drum chart levels)
import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { detectOnsets } from "../core/beatTrack";
import { BT_SR, buildAnalysis, framesToBeats, logMel, predictFrames } from "../core/beatThis";

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
  session.catch(() => (session = null)); // allow a retry next time
  return session;
}

const post = (m: unknown) => self.postMessage(m);

self.onmessage = async (e: MessageEvent<{ samples: Float32Array; sr: number }>) => {
  const { samples, sr } = e.data;
  try {
    if (sr !== BT_SR) throw new Error(`expected ${BT_SR} Hz audio, got ${sr}`);
    const sess = await model();
    const info = detectOnsets(samples, sr, (p) => post({ progress: p * 0.15 }));
    const mel = logMel(samples);
    post({ progress: 0.2 });
    const pred = await predictFrames(
      mel,
      async (spect, frames) => {
        const r = await sess.run({ spect: new ort.Tensor("float32", spect, [1, frames, 128]) });
        return { beat: r.beat.data as Float32Array, downbeat: r.downbeat.data as Float32Array };
      },
      (p) => post({ progress: 0.2 + p * 0.8 }),
    );
    post({ result: buildAnalysis(info, framesToBeats(pred)) });
  } catch (err) {
    post({ error: String(err) });
  }
};
