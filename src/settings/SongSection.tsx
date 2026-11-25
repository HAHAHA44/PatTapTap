import { useEffect, useMemo, useState } from "react";
import { rescaleTempo, shiftDownbeat } from "../core/beatTrack";
import { Settings } from "../core/settings";
import { buildChart, chartNoteCount, SONG_LEVELS, SongMeta } from "../core/songChart";
import { t } from "../i18n";
import { ImportStage, importSong, songs } from "../platform/songs";

const fmtDur = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

function confidence(c: number) {
  return c >= 0.6 ? t("song.conf.high") : c >= 0.35 ? t("song.conf.mid") : t("song.conf.low");
}

export default function SongSection({ s, update }: { s: Settings; update: (p: Partial<Settings>) => void }) {
  const [list, setList] = useState<SongMeta[] | null>(null);
  const [stage, setStage] = useState<ImportStage | null>(null);
  const [err, setErr] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    songs.list().then(setList).catch(() => setList([]));
  }, []);

  const selected = list?.find((m) => m.id === s.songId) ?? null;
  const counts = useMemo(
    () => (selected ? Object.fromEntries(SONG_LEVELS.map((l) => [l, chartNoteCount(buildChart(selected, l))])) : null),
    [selected],
  );

  const onFile = async (f: File) => {
    setErr("");
    try {
      const m = await importSong(f, setStage);
      setList((l) => [m, ...(l ?? [])]);
      update({ songId: m.id });
    } catch (e) {
      setErr((e as Error).message === "decode" ? t("song.decodeError") : t("song.analyzeError"));
    } finally {
      setStage(null);
    }
  };

  /** Apply a correction to the stored analysis; restarts practice if it's the current song. */
  const edit = async (m: SongMeta, fix: (m: SongMeta) => SongMeta) => {
    const next = fix(m);
    await songs.save(next);
    setList((l) => (l ?? []).map((x) => (x.id === next.id ? next : x)));
    if (s.songId === next.id) update({ songRev: s.songRev + 1 });
  };

  const remove = async (m: SongMeta) => {
    await songs.remove(m.id);
    setList((l) => (l ?? []).filter((x) => x.id !== m.id));
    setConfirmDelete(null);
    if (s.songId === m.id) update({ songId: null });
  };

  return (
    <>
      <section>
        <div className="row">
          <label className={`filebtn ${stage ? "disabled" : ""}`}>
            {t("song.import")}
            <input
              type="file"
              accept="audio/*,.mp3,.m4a,.aac,.wav,.flac"
              disabled={!!stage}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) onFile(f);
              }}
            />
          </label>
          {stage && (
            <span className="note">
              {stage.stage === "decoding" ? t("song.decoding") : t("song.analyzing", { p: Math.round(stage.progress * 100) })}
            </span>
          )}
          {err && <span className="note warn-text">{err}</span>}
        </div>
        {list && !list.length && <p className="note">{t("song.empty")}</p>}
        <div className="songs">
          {list?.map((m) => (
            <div key={m.id} className={`song ${m.id === s.songId ? "on" : ""}`} onClick={() => update({ songId: m.id })}>
              <div className="song-main">
                <div className="song-name">{m.name}</div>
                <div className="note">
                  {m.bpm} BPM · {fmtDur(m.durationSec)} ·{" "}
                  <span className={m.confidence < 0.35 ? "warn-text" : ""}>{confidence(m.confidence)}</span>
                </div>
              </div>
              {m.id === s.songId && (
                <div className="pact" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => edit(m, (x) => ({ ...x, ...rescaleTempo(x, 2) }))}>{t("song.double")}</button>
                  <button onClick={() => edit(m, (x) => ({ ...x, ...rescaleTempo(x, 0.5) }))}>{t("song.half")}</button>
                  <button onClick={() => edit(m, (x) => ({ ...x, ...shiftDownbeat(x) }))}>{t("song.shift")}</button>
                  {confirmDelete === m.id ? (
                    <button className="danger" onClick={() => remove(m)}>
                      {t("song.deleteConfirm", { name: m.name })}
                    </button>
                  ) : (
                    <button onClick={() => setConfirmDelete(m.id)}>{t("common.delete")}</button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
      <section>
        <h3>{t("song.level")}</h3>
        <div className="seg">
          {SONG_LEVELS.map((l) => (
            <button key={l} className={s.songLevel === l ? "on" : ""} onClick={() => update({ songLevel: l })}>
              {t(`level.${l}`)}
              {counts && <span className="seg-note"> · {t("song.notes", { n: counts[l] })}</span>}
            </button>
          ))}
        </div>
        <div className="row">
          <span>{t("song.volume")}</span>
          <input type="range" min={0} max={1} step={0.05} value={s.songVolume} onChange={(e) => update({ songVolume: Number(e.target.value) })} />
          <span className="note">{Math.round(s.songVolume * 100)}%</span>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={s.songClicks} onChange={(e) => update({ songClicks: e.target.checked })} />
          <span>{t("song.clicks")}</span>
        </label>
      </section>
    </>
  );
}
