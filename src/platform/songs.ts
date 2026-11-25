// Song library: files live in the app data folder (see src-tauri/src/songs.rs).
import { invoke } from "@tauri-apps/api/core";
import { SongAnalysis, toMono } from "../core/beatTrack";
import { SongMeta } from "../core/songChart";

export const songs = {
  async list(): Promise<SongMeta[]> {
    const raw = await invoke<string[]>("song_list");
    const out: SongMeta[] = [];
    for (const r of raw) {
      try {
        out.push(JSON.parse(r));
      } catch {
        /* skip corrupt entries */
      }
    }
    return out.sort((a, b) => b.importedAt - a.importedAt);
  },
  async read(id: string): Promise<SongMeta> {
    return JSON.parse(await invoke<string>("song_read_meta", { id }));
  },
  save(meta: SongMeta) {
    return invoke("song_save_meta", { id: meta.id, meta: JSON.stringify(meta) });
  },
  loadAudio(id: string): Promise<ArrayBuffer> {
    return invoke<ArrayBuffer>("song_load_audio", { id });
  },
  remove(id: string) {
    return invoke("song_delete", { id });
  },
};

export type ImportStage = { stage: "decoding" } | { stage: "analyzing"; progress: number };

function analyzeInWorker(samples: Float32Array, sr: number, onProgress: (p: number) => void): Promise<SongAnalysis> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./analyzeWorker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e) => {
      if (e.data.progress !== undefined) onProgress(e.data.progress);
      else {
        w.terminate();
        if (e.data.result) resolve(e.data.result);
        else reject(new Error(e.data.error ?? "analysis failed"));
      }
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message));
    };
    w.postMessage({ samples, sr }, [samples.buffer]);
  });
}

/** Decode, analyze and store an audio file. Throws "decode" if it isn't readable audio. */
export async function importSong(file: File, onStage: (s: ImportStage) => void): Promise<SongMeta> {
  onStage({ stage: "decoding" });
  const bytes = await file.arrayBuffer();
  let audio: AudioBuffer;
  try {
    // Decoding resamples to the context rate; analysis runs at half of it.
    audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes.slice(0));
  } catch {
    throw new Error("decode");
  }
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  const factor = audio.sampleRate >= 44100 ? 2 : 1;
  const mono = toMono(channels, factor);
  const analysis = await analyzeInWorker(mono, audio.sampleRate / factor, (p) => onStage({ stage: "analyzing", progress: p }));

  const dot = file.name.lastIndexOf(".");
  const meta: SongMeta = {
    ...analysis,
    id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    // drop leading "[site][source]" style tags that download tools add
    name: (dot > 0 ? file.name.slice(0, dot) : file.name).replace(/^(\s*[\[【][^\]】]*[\]】])+\s*/, "") || file.name,
    ext: dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "",
    importedAt: Date.now(),
  };
  await invoke("song_save_audio", new Uint8Array(bytes), { headers: { "x-song-id": meta.id } });
  await songs.save(meta);
  return meta;
}
