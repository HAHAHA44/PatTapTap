// Runs song analysis off the UI thread.
import { analyzeSong } from "../core/beatTrack";

self.onmessage = (e: MessageEvent<{ samples: Float32Array; sr: number }>) => {
  const { samples, sr } = e.data;
  try {
    const result = analyzeSong(samples, sr, (p) => self.postMessage({ progress: p }));
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: String(err) });
  }
};
