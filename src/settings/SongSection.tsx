import { useEffect, useMemo, useState } from "react";
import { rescaleTempo } from "../core/beatTrack";
import { currentSongId, PLAY_MODES, Settings } from "../core/settings";
import { buildChart, chartNoteCount, chartSections, SONG_LEVELS, SongMeta } from "../core/songChart";
import { t } from "../i18n";
import { ImportStage, importSong, reanalyzeSong, songs } from "../platform/songs";
import { PatternPreview } from "./PatternEditor";

const fmtDur = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

function confidence(c: number) {
  return c >= 0.6 ? t("song.conf.high") : c >= 0.35 ? t("song.conf.mid") : t("song.conf.low");
}

/** Remove the entries at `drop` from a playlist and keep pointing at the same entry
 *  (or the one that slid into its place). */
function withoutEntries(list: string[], index: number, drop: (i: number) => boolean) {
  const playlist: string[] = [];
  let playIndex = 0;
  list.forEach((id, i) => {
    if (i === index) playIndex = playlist.length;
    if (!drop(i)) playlist.push(id);
  });
  return { playlist, playIndex: Math.min(playIndex, Math.max(0, playlist.length - 1)) };
}

export default function SongSection({ s, update }: { s: Settings; update: (p: Partial<Settings>) => void }) {
  const [library, setLibrary] = useState<SongMeta[] | null>(null);
  const [stage, setStage] = useState<ImportStage | null>(null);
  const [err, setErr] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const currentId = currentSongId(s);
  /** Library row whose actions and rhythm overview are shown. */
  const [focusId, setFocusId] = useState<string | null>(currentId);

  useEffect(() => {
    songs.list().then(setLibrary).catch(() => setLibrary([]));
  }, []);

  const byId = useMemo(() => new Map((library ?? []).map((m) => [m.id, m])), [library]);
  const current = currentId ? byId.get(currentId) ?? null : null;
  const focus = (focusId && byId.get(focusId)) || current;
  const chart = useMemo(() => (focus ? buildChart(focus, s.songLevel) : []), [focus, s.songLevel]);
  const counts = useMemo(
    () => (current ? Object.fromEntries(SONG_LEVELS.map((l) => [l, chartNoteCount(buildChart(current, l))])) : null),
    [current],
  );

  const addToPlaylist = (id: string) => update({ playlist: [...s.playlist, id], playIndex: s.playlist.length ? s.playIndex : 0 });

  const removeEntry = (i: number) => update(withoutEntries(s.playlist, s.playIndex, (k) => k === i));

  const moveEntry = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= s.playlist.length) return;
    const playlist = s.playlist.slice();
    [playlist[i], playlist[j]] = [playlist[j], playlist[i]];
    const playIndex = s.playIndex === i ? j : s.playIndex === j ? i : s.playIndex;
    update({ playlist, playIndex });
  };

  const onFile = async (f: File) => {
    setErr("");
    try {
      const m = await importSong(f, setStage);
      setLibrary((l) => [m, ...(l ?? [])]);
      setFocusId(m.id);
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
    setLibrary((l) => (l ?? []).map((x) => (x.id === next.id ? next : x)));
    if (currentId === next.id) update({ songRev: s.songRev + 1 });
  };

  const reanalyze = async (m: SongMeta) => {
    setErr("");
    try {
      const next = await reanalyzeSong(m, setStage);
      setLibrary((l) => (l ?? []).map((x) => (x.id === next.id ? next : x)));
      if (currentId === next.id) update({ songRev: s.songRev + 1 });
    } catch (e) {
      setErr((e as Error).message === "decode" ? t("song.decodeError") : t("song.analyzeError"));
    } finally {
      setStage(null);
    }
  };

  const remove = async (m: SongMeta) => {
    await songs.remove(m.id);
    setLibrary((l) => (l ?? []).filter((x) => x.id !== m.id));
    setConfirmDelete(null);
    if (s.playlist.includes(m.id)) update(withoutEntries(s.playlist, s.playIndex, (k) => s.playlist[k] === m.id));
  };

  return (
    <>
      <section>
        <h3>{t("song.playlist")}</h3>
        <div className="seg">
          {PLAY_MODES.map((pm) => (
            <button key={pm} className={s.playMode === pm ? "on" : ""} onClick={() => update({ playMode: pm })}>
              {t(`play.${pm}`)}
            </button>
          ))}
        </div>
        {!s.playlist.length && <p className="note">{t("song.listEmpty")}</p>}
        <div className="playlist">
          {s.playlist.map((id, i) => {
            const m = byId.get(id);
            const isCurrent = i === Math.min(s.playIndex, s.playlist.length - 1);
            return (
              <div key={`${i}-${id}`} className={`pl-row ${isCurrent ? "on" : ""}`} onClick={() => update({ playIndex: i })}>
                <span className="pl-mark">{isCurrent ? "▶" : i + 1}</span>
                <span className="pl-name">{m?.name ?? "…"}</span>
                <span className="note">{m ? `${m.bpm} BPM · ${fmtDur(m.durationSec)}` : ""}</span>
                <span className="pl-act" onClick={(e) => e.stopPropagation()}>
                  <button disabled={i === 0} onClick={() => moveEntry(i, -1)} title={t("song.moveUp")}>
                    ↑
                  </button>
                  <button disabled={i === s.playlist.length - 1} onClick={() => moveEntry(i, 1)} title={t("song.moveDown")}>
                    ↓
                  </button>
                  <button onClick={() => removeEntry(i)} title={t("song.removeFromList")}>
                    ✕
                  </button>
                </span>
              </div>
            );
          })}
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

      <section>
        <h3>{t("song.library")}</h3>
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
        {library && !library.length && <p className="note">{t("song.empty")}</p>}
        <div className="songs">
          {library?.map((m) => (
            <div key={m.id} className={`song ${m.id === focus?.id ? "on" : ""}`} onClick={() => setFocusId(m.id)}>
              <div className="song-head">
                <div className="song-main">
                  <div className="song-name">{m.name}</div>
                  <div className="note">
                    {m.bpm} BPM · {fmtDur(m.durationSec)} ·{" "}
                    {m.beatSource === "model" ? (
                      <span className={m.confidence < 0.35 ? "warn-text" : ""}>{confidence(m.confidence)}</span>
                    ) : (
                      <span className="warn-text">{t("song.needsReanalyze")}</span>
                    )}
                  </div>
                </div>
                <button
                  className="add-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    addToPlaylist(m.id);
                  }}
                >
                  {t("song.addToList")}
                </button>
              </div>
              {m.id === focus?.id && (
                <div className="pact" onClick={(e) => e.stopPropagation()}>
                  <button disabled={!!stage} onClick={() => reanalyze(m)}>
                    {t("song.reanalyze")}
                  </button>
                  <button onClick={() => edit(m, (x) => ({ ...x, ...rescaleTempo(x, 2) }))}>{t("song.double")}</button>
                  <button onClick={() => edit(m, (x) => ({ ...x, ...rescaleTempo(x, 0.5) }))}>{t("song.half")}</button>
                  {m.auto && (m.auto.downbeat !== m.downbeat || m.auto.beats.length !== m.beats.length) && (
                    <button onClick={() => edit(m, (x) => ({ ...x, ...x.auto! }))}>{t("song.restore")}</button>
                  )}
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

      {focus && chart.length > 0 && (
        <section>
          <h3>
            {t("song.overview")}{" "}
            <span className="note">
              {focus.name} · {t(`level.${s.songLevel}`)} · {t("song.notes", { n: chartNoteCount(chart) })}
            </span>
          </h3>
          <div className="sections">
            {chartSections(chart).map((sec, i) => (
              <div key={i} className="section-row">
                <span className="sec-name">{t("song.section", { n: i + 1 })}</span>
                <span className="note sec-range">
                  {t("song.sectionBars", { a: sec.firstBar + 1, b: sec.lastBar + 1 })} · {fmtDur(chart[sec.firstBar].start)}
                </span>
                <PatternPreview cells={sec.cells} />
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
