import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { emit } from "@tauri-apps/api/event";
import { RhythmEngine } from "../core/engine";
import { PRESETS } from "../core/pattern";
import { EV } from "../platform/bridge";

const TAPS_NEEDED = 16;
const WARMUP = 4;

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Plays steady clicks and measures how far the user's taps land from them.
 * The median offset becomes the calibration that the judge adds to expected times.
 */
export default function Calibration({ current, onApply }: { current: number; onApply: (ms: number) => void }) {
  const [phase, setPhase] = useState<"idle" | "run" | "done">("idle");
  const [offsets, setOffsets] = useState<number[]>([]);
  const offsetsRef = useRef<number[]>([]);
  const [lit, setLit] = useState(false);

  const engine = useMemo(
    () =>
      new RhythmEngine({
        onSchedule: (e) => {
          if (!e.slot.isBeatStart) return;
          const delay = Math.max(0, e.perfTime - performance.now());
          setTimeout(() => {
            setLit(true);
            setTimeout(() => setLit(false), 90);
          }, delay);
        },
        onResult: (r) => {
          if (r.offset === null) return;
          offsetsRef.current = [...offsetsRef.current, r.offset];
          setOffsets(offsetsRef.current);
          if (offsetsRef.current.length >= TAPS_NEEDED + WARMUP) {
            engine.stop();
            setPhase("done");
          }
        },
      }),
    [],
  );

  useEffect(() => () => void engine.stop(), [engine]);

  const begin = async () => {
    await emit(EV.cmd, "stop"); // make sure the widget isn't also playing
    offsetsRef.current = [];
    setOffsets([]);
    const ok = await engine.start({
      bpm: 90,
      beats: 4,
      pattern: PRESETS[0],
      cue: "both",
      soundPattern: false,
      muteBeatClick: false,
      accent: false,
      volume: 0.8,
      voice: "wood",
      countIn: true,
      judge: true,
      keyMode: "single",
      keys: ["Space", "Space"],
      strictAlternate: false,
      windows: { perfect: 300, great: 300, good: 300 },
      calibrationMs: 0,
      mode: "metronome",
      songId: null,
      songLevel: "beats",
      songClicks: false,
      songVolume: 0,
      songRev: 0,
    });
    if (ok) setPhase("run");
  };

  const tap = (t: number) => engine.hit("Space", t);

  useEffect(() => {
    if (phase !== "run") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      e.preventDefault();
      tap(e.timeStamp > 0 ? e.timeStamp : performance.now());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase]);

  const used = offsets.slice(WARMUP);
  const result = used.length ? Math.round(median(used)) : null;
  const spread = used.length ? Math.round(Math.max(...used) - Math.min(...used)) : 0;

  return (
    <div className="calib">
      <p className="note">
        {t("calib.intro", { n: TAPS_NEEDED + WARMUP })} {t("calib.current", { ms: current })}
      </p>
      <div className="calib-row">
        <button
          className={`calib-pad ${lit ? "lit" : ""}`}
          disabled={phase !== "run"}
          onPointerDown={(e) => tap(e.timeStamp > 0 ? e.timeStamp : performance.now())}
        >
          {phase === "run" ? `${Math.max(0, offsets.length)}/${TAPS_NEEDED + WARMUP}` : "●"}
        </button>
        <div>
          {phase !== "run" && <button onClick={begin}>{phase === "done" ? t("calib.again") : t("calib.start")}</button>}
          {phase === "run" && (
            <button
              onClick={() => {
                engine.stop();
                setPhase("idle");
              }}
            >
              {t("common.cancel")}
            </button>
          )}
          {phase === "done" && result !== null && (
            <div className="calib-result">
              {t("calib.result", { ms: result, spread })}
              {spread > 120 && <div className="note warn-text">{t("calib.unstable")}</div>}
              <button className="primary" onClick={() => onApply(result)}>
                {t("calib.apply")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
