import { useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { ClickSynth, VOICES, VoiceId } from "../core/audio";
import { isValidPattern, newPatternId } from "../core/pattern";
import { allPatterns, currentPattern, MAX_SCALE, MIN_SCALE, Settings } from "../core/settings";
import { SUPPORTED_KEYS } from "../core/keys";
import { CueMode, MAX_BEATS, MAX_BPM, MIN_BPM, Pattern, SessionSummary } from "../core/types";
import { keyName, MessageKey, patternName, resolveLang, setLang, t, tendency } from "../i18n";
import {
  clearHistory,
  EV,
  isMac,
  KeyStatus,
  loadHistory,
  loadSettings,
  native,
  onSettingsChanged,
  requestSettings,
} from "../platform/bridge";
import PatternEditor, { PatternPreview } from "./PatternEditor";
import Calibration from "./Calibration";
import SongSection from "./SongSection";
import OnlineTab from "./OnlineTab";
import { AUTH_CHANGED } from "../platform/api";
import { syncHistory } from "../platform/sync";
import HistoryDetail, { fmtTime, historyPatternName } from "./HistoryDetail";
import "./settings.css";

type Tab = "rhythm" | "cue" | "keys" | "general" | "history" | "online";
const TABS: Tab[] = ["rhythm", "cue", "keys", "general", "history", "online"];

interface RunState {
  running: boolean;
  keyStatus: KeyStatus;
  hotkeyErrors: string[];
}

export default function SettingsApp() {
  const [s, setS] = useState<Settings | null>(null);
  const [tab, setTab] = useState<Tab>("rhythm");
  const [run, setRun] = useState<RunState>({ running: false, keyStatus: "stopped", hotkeyErrors: [] });
  const [history, setHistory] = useState<SessionSummary[]>([]);

  useEffect(() => {
    const un: Promise<() => void>[] = [];
    loadSettings().then(setS);
    // signed in: exchange practice history with other devices (silently skipped otherwise)
    const sync = () =>
      syncHistory()
        .then((added) => (added ? loadHistory().then(setHistory) : undefined))
        .catch(() => {});
    loadHistory().then(setHistory).then(sync);
    un.push(listen(AUTH_CHANGED, (e) => e.payload && sync()));
    un.push(onSettingsChanged(setS));
    un.push(listen<RunState>(EV.runState, (e) => setRun(e.payload)));
    un.push(listen<SessionSummary>(EV.sessionEnded, () => loadHistory().then(setHistory).then(sync)));
    emit(EV.cmd, "ping");
    return () => un.forEach((p) => p.then((f) => f()));
  }, []);

  // Language must be set before this render's t() calls.
  const lang = s ? resolveLang(s.language) : null;
  if (lang) setLang(lang);
  useEffect(() => {
    if (lang) getCurrentWindow().setTitle(t("settings.windowTitle")).catch(() => {});
  }, [lang]);

  if (!s) return <div className="loading">{t("common.loading")}</div>;

  const update = (patch: Partial<Settings>) => {
    const next = { ...s, ...patch };
    setS(next);
    requestSettings(next);
  };

  return (
    <div className="app">
      <header>
        <div className="brand">
          {t("app.name")}
          <span className="sub">
            {s.mode === "song"
              ? `${t("mode.song")} · ${t(`level.${s.songLevel}`)}`
              : `${s.beats}/4 · ${s.bpm} BPM · ${patternName(currentPattern(s))}`}
          </span>
        </div>
        <button className={run.running ? "danger" : "primary"} onClick={() => emit(EV.cmd, "toggle")}>
          {run.running ? t("header.stop") : t("header.start")}
        </button>
      </header>
      <nav>
        {TABS.map((id) => (
          <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {t(`tab.${id}` as MessageKey)}
          </button>
        ))}
      </nav>
      <main>
        {tab === "rhythm" && <RhythmTab s={s} update={update} />}
        {tab === "cue" && <CueTab s={s} update={update} />}
        {tab === "keys" && <KeysTab s={s} update={update} run={run} />}
        {tab === "general" && <GeneralTab s={s} update={update} run={run} />}
        {tab === "online" && <OnlineTab />}
        {tab === "history" && <HistoryTab history={history} onClear={() => clearHistory().then(() => setHistory([]))} />}
      </main>
    </div>
  );
}

type TabProps = { s: Settings; update: (p: Partial<Settings>) => void };

function Toggle({ checked, onChange, label, note }: { checked: boolean; onChange: (v: boolean) => void; label: string; note?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
      {note && <span className="note">{note}</span>}
    </label>
  );
}

// ---------------------------------------------------------------- rhythm
function RhythmTab({ s, update }: TabProps) {
  const [editing, setEditing] = useState<Pattern | null | "new">(null);
  const taps = useRef<number[]>([]);
  const [importErr, setImportErr] = useState(false);

  const tapTempo = () => {
    const now = performance.now();
    taps.current = [...taps.current.filter((x) => now - x < 3000), now].slice(-8);
    if (taps.current.length >= 3) {
      const iv = (taps.current[taps.current.length - 1] - taps.current[0]) / (taps.current.length - 1);
      update({ bpm: Math.round(Math.min(MAX_BPM, Math.max(MIN_BPM, 60000 / iv))) });
    }
  };

  const savePattern = (p: Pattern) => {
    const exists = s.customPatterns.some((c) => c.id === p.id);
    const customPatterns = exists ? s.customPatterns.map((c) => (c.id === p.id ? p : c)) : [...s.customPatterns, p];
    update({ customPatterns, patternId: p.id });
    setEditing(null);
  };

  const cur = currentPattern(s);

  const exportPatterns = () => {
    const blob = new Blob([JSON.stringify(s.customPatterns, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "patterns.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importPatterns = async (f: File) => {
    try {
      const data = JSON.parse(await f.text());
      const list = (Array.isArray(data) ? data : [data]).filter(isValidPattern) as Pattern[];
      if (!list.length) throw new Error();
      const fresh = list.map((p) => ({ ...p, id: newPatternId(), builtin: false }));
      update({ customPatterns: [...s.customPatterns, ...fresh] });
      setImportErr(false);
    } catch {
      setImportErr(true);
    }
  };

  const modeSwitch = (
    <section>
      <h3>{t("rhythm.mode")}</h3>
      <div className="seg">
        {(["metronome", "song"] as const).map((m) => (
          <button key={m} className={s.mode === m ? "on" : ""} onClick={() => update({ mode: m })}>
            {t(`mode.${m}`)}
          </button>
        ))}
      </div>
    </section>
  );

  if (s.mode === "song") {
    return (
      <>
        {modeSwitch}
        <SongSection s={s} update={update} />
      </>
    );
  }

  if (editing) {
    return (
      <section>
        <h3>{editing === "new" ? t("rhythm.newTitle") : t("rhythm.editTitle")}</h3>
        <PatternEditor initial={editing === "new" ? null : editing} onSave={savePattern} onCancel={() => setEditing(null)} />
      </section>
    );
  }

  return (
    <>
      {modeSwitch}
      <section>
        <h3>{t("rhythm.tempo")}</h3>
        <div className="row">
          <input type="range" min={MIN_BPM} max={MAX_BPM} value={s.bpm} onChange={(e) => update({ bpm: Number(e.target.value) })} />
          <input
            type="number"
            className="num"
            min={MIN_BPM}
            max={MAX_BPM}
            value={s.bpm}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v >= MIN_BPM && v <= MAX_BPM) update({ bpm: v });
            }}
          />
          <span>BPM</span>
          <button onClick={tapTempo}>{t("rhythm.tapTempo")}</button>
        </div>
      </section>
      <section>
        <h3>{t("rhythm.meter")}</h3>
        <div className="seg">
          {Array.from({ length: MAX_BEATS }, (_, i) => i + 1).map((n) => (
            <button key={n} className={s.beats === n ? "on" : ""} onClick={() => update({ beats: n })}>
              {n}/4
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3>{t("rhythm.pattern")}</h3>
        <div className="patterns">
          {allPatterns(s).map((p) => (
            <div key={p.id} className={`pattern ${p.id === s.patternId ? "on" : ""}`} onClick={() => update({ patternId: p.id })}>
              <div className="pname">
                {patternName(p)}
                {!p.builtin && <span className="tag">{t("rhythm.custom")}</span>}
              </div>
              <PatternPreview cells={p.cells} beats={s.beats} />
              {!p.builtin && (
                <div className="pact" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => setEditing(p)}>{t("common.edit")}</button>
                  <button
                    onClick={() =>
                      update({
                        customPatterns: s.customPatterns.filter((c) => c.id !== p.id),
                        patternId: s.patternId === p.id ? "quarter" : s.patternId,
                      })
                    }
                  >
                    {t("common.delete")}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="row">
          <button onClick={() => setEditing("new")}>{t("rhythm.new")}</button>
          <button
            onClick={() =>
              setEditing({ ...cur, id: newPatternId(), name: t("rhythm.copyName", { name: patternName(cur) }), builtin: false })
            }
          >
            {t("rhythm.duplicate")}
          </button>
          <label className="filebtn">
            {t("rhythm.import")}
            <input type="file" accept=".json,application/json" onChange={(e) => e.target.files?.[0] && importPatterns(e.target.files[0])} />
          </label>
          <button disabled={!s.customPatterns.length} onClick={exportPatterns}>
            {t("rhythm.export")}
          </button>
        </div>
        {importErr && <div className="note warn-text">{t("rhythm.importError")}</div>}
      </section>
    </>
  );
}

// ---------------------------------------------------------------- cue
let previewSynth: ClickSynth | null = null;
function previewVoice(voice: VoiceId, volume: number) {
  if (!previewSynth) previewSynth = new ClickSynth(new AudioContext({ latencyHint: "interactive" }));
  previewSynth.cut(); // stop a preview that's still playing
  previewSynth.setVoice(voice);
  previewSynth.setVolume(volume);
  previewSynth.preview();
}

function CueTab({ s, update }: TabProps) {
  const opts: [CueMode, MessageKey][] = [
    ["sound", "cue.sound"],
    ["visual", "cue.visual"],
    ["both", "cue.both"],
  ];
  return (
    <>
      <section>
        <h3>{t("cue.mode")}</h3>
        {opts.map(([v, label]) => (
          <label key={v} className="radio">
            <input type="radio" checked={s.cue === v} onChange={() => update({ cue: v })} />
            <span>{t(label)}</span>
          </label>
        ))}
      </section>
      <section>
        <h3>{t("cue.audio")}</h3>
        <div className="row">
          <span>{t("cue.voice")}</span>
          <div className="seg">
            {VOICES.map((v) => (
              <button
                key={v}
                className={s.voice === v ? "on" : ""}
                onClick={() => {
                  update({ voice: v });
                  previewVoice(v, s.volume);
                }}
              >
                {t(`voice.${v}`)}
              </button>
            ))}
          </div>
          <button onClick={() => previewVoice(s.voice, s.volume)}>▶ {t("cue.preview")}</button>
        </div>
        <div className="row">
          <span>{t("cue.volume")}</span>
          <input type="range" min={0} max={1} step={0.05} value={s.volume} onChange={(e) => update({ volume: Number(e.target.value) })} />
          <span className="note">{Math.round(s.volume * 100)}%</span>
        </div>
        <Toggle checked={s.accent} onChange={(v) => update({ accent: v })} label={t("cue.accent")} />
        <Toggle checked={s.soundPattern} onChange={(v) => update({ soundPattern: v })} label={t("cue.soundPattern")} />
        {s.soundPattern && (
          <div className="sub">
            <Toggle checked={s.muteBeatClick} onChange={(v) => update({ muteBeatClick: v })} label={t("cue.muteBeat")} />
          </div>
        )}
        <Toggle checked={s.countIn} onChange={(v) => update({ countIn: v })} label={t("cue.countIn")} />
      </section>
      <section>
        <h3>{t("cue.widget")}</h3>
        <div className="row">
          <span>{t("cue.size")}</span>
          <input
            type="range"
            min={MIN_SCALE}
            max={MAX_SCALE}
            step={0.05}
            value={s.widgetScale}
            onChange={(e) => update({ widgetScale: Number(e.target.value) })}
          />
          <span className="note">{Math.round(s.widgetScale * 100)}%</span>
          {s.widgetScale !== 1 && <button onClick={() => update({ widgetScale: 1 })}>{t("common.reset")}</button>}
        </div>
        <Toggle checked={s.iconFeedback} onChange={(v) => update({ iconFeedback: v })} label={t("cue.iconFeedback")} />
      </section>
    </>
  );
}

// ---------------------------------------------------------------- keys
function KeyCapture({ code, onChange }: { code: string; onChange: (c: string) => void }) {
  const [waiting, setWaiting] = useState(false);
  const [bad, setBad] = useState("");
  useEffect(() => {
    if (!waiting) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.code === "Escape") return setWaiting(false);
      if (!SUPPORTED_KEYS.has(e.code)) return setBad(e.code);
      setBad("");
      onChange(e.code);
      setWaiting(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [waiting, onChange]);
  return (
    <span>
      <button className={`keycap ${waiting ? "waiting" : ""}`} onClick={() => setWaiting(!waiting)}>
        {waiting ? t("keys.press") : keyName(code)}
      </button>
      {bad && <span className="note warn-text"> {t("keys.unsupported", { code: bad })}</span>}
    </span>
  );
}

function KeysTab({ s, update, run }: TabProps & { run: RunState }) {
  return (
    <>
      <section>
        <h3>{t("keys.title")}</h3>
        <label className="radio">
          <input type="radio" checked={s.keyMode === "single"} onChange={() => update({ keyMode: "single" })} />
          <span>{t("keys.single")}</span>
          <KeyCapture code={s.keys[0]} onChange={(c) => update({ keys: [c, s.keys[1]] })} />
        </label>
        <label className="radio">
          <input type="radio" checked={s.keyMode === "alternate"} onChange={() => update({ keyMode: "alternate" })} />
          <span>{t("keys.alternate")}</span>
          <KeyCapture code={s.keys[0]} onChange={(c) => update({ keys: [c, s.keys[1]] })} />
          <span>+</span>
          <KeyCapture code={s.keys[1]} onChange={(c) => update({ keys: [s.keys[0], c] })} />
        </label>
        {s.keyMode === "alternate" && (
          <Toggle
            checked={s.strictAlternate}
            onChange={(v) => update({ strictAlternate: v })}
            label={t("keys.strict")}
            note={t("keys.strictNote")}
          />
        )}
        {s.keyMode === "alternate" && s.keys[0] === s.keys[1] && <div className="note warn-text">{t("keys.same")}</div>}
        <p className="note">
          {t("keys.privacyOne")}
          {run.keyStatus !== "running" && <span className="warn-text"> {t("keys.globalOff")}</span>}
        </p>
      </section>
      <section>
        <h3>{t("calib.title")}</h3>
        <Calibration current={s.calibrationMs} onApply={(ms) => update({ calibrationMs: ms })} />
        <div className="row">
          <span>{t("calib.fine")}</span>
          <input type="range" min={-200} max={200} value={s.calibrationMs} onChange={(e) => update({ calibrationMs: Number(e.target.value) })} />
          <span className="note">{s.calibrationMs} ms</span>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- general
function GeneralTab({ s, update, run }: TabProps & { run: RunState }) {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    autostartEnabled().then(setAutostart).catch(() => setAutostart(null));
  }, []);

  const statusKey: Record<KeyStatus, MessageKey> = {
    running: "status.running",
    "no-permission": "status.noPermission",
    unsupported: "status.unsupported",
    error: "status.error",
    stopped: "status.stopped",
  };

  return (
    <>
      <section>
        <h3>{t("general.language")}</h3>
        <div className="seg">
          {(["auto", "zh", "en"] as const).map((l) => (
            <button key={l} className={s.language === l ? "on" : ""} onClick={() => update({ language: l })}>
              {t(`lang.${l}`)}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3>{t("general.globalKeys")}</h3>
        <p>{t(statusKey[run.keyStatus])}</p>
        {run.keyStatus === "no-permission" && isMac && (
          <>
            <p className="note">{t("general.permNote")}</p>
            <div className="row">
              <button
                onClick={async () => {
                  await native.requestKeyPermission();
                  setAsked(true);
                }}
              >
                {t("general.requestPerm")}
              </button>
              <button onClick={() => native.openPermissionSettings()}>{t("general.openSysSettings")}</button>
              <button className={asked ? "primary" : ""} onClick={() => native.restart()}>
                {t("general.restart")}
              </button>
            </div>
          </>
        )}
      </section>
      <section>
        <h3>{t("general.hotkeys")}</h3>
        <HotkeyInput
          label={t("general.hkToggle")}
          value={s.hotkeys.toggle}
          bad={run.hotkeyErrors.includes(s.hotkeys.toggle)}
          onChange={(v) => update({ hotkeys: { ...s.hotkeys, toggle: v } })}
        />
        <HotkeyInput
          label={t("general.hkBoss")}
          value={s.hotkeys.boss}
          bad={run.hotkeyErrors.includes(s.hotkeys.boss)}
          onChange={(v) => update({ hotkeys: { ...s.hotkeys, boss: v } })}
        />
        <p className="note">{t("general.hkNote")}</p>
      </section>
      <section>
        <h3>{t("general.widget")}</h3>
        <Toggle
          checked={s.clickThrough}
          onChange={(v) => update({ clickThrough: v })}
          label={t("general.clickThrough")}
          note={t("general.clickThroughNote")}
        />
        {autostart !== null && (
          <Toggle
            checked={autostart}
            onChange={async (v) => {
              await (v ? enableAutostart() : disableAutostart());
              setAutostart(await autostartEnabled());
            }}
            label={t("general.autostart")}
          />
        )}
      </section>
    </>
  );
}

function HotkeyInput({ label, value, bad, onChange }: { label: string; value: string; bad: boolean; onChange: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="row">
      <span className="hk-label">{label}</span>
      <input className={bad ? "bad" : ""} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onChange(v.trim())} />
      {bad && <span className="note warn-text">{t("general.hkBad")}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- history
function HistoryTab({ history, onClear }: { history: SessionSummary[]; onClear: () => void }) {
  const [open, setOpen] = useState<SessionSummary | null>(null);
  if (open) return <HistoryDetail s={open} onBack={() => setOpen(null)} />;
  if (!history.length) return <p className="note">{t("history.empty")}</p>;
  const last = history[0];
  return (
    <>
      <section className="summary clickable" onClick={() => setOpen(last)}>
        <h3>
          {t("history.last")} <span className="note">{t("history.clickDetail")}</span>
        </h3>
        <div className="big">{(last.accuracy * 100).toFixed(1)}%</div>
        <div className="row wrap">
          <span className="grade perfect">Perfect {last.perfect}</span>
          <span className="grade great">Great {last.great}</span>
          <span className="grade good">Good {last.good}</span>
          <span className="grade miss">Miss {last.miss}</span>
          {last.stray > 0 && <span className="note">{t("history.strayN", { n: last.stray })}</span>}
        </div>
        <p>
          {t("history.lastLine", {
            tendency: tendency(last.meanOffset),
            std: last.stdOffset,
            combo: last.maxCombo,
            dur: last.durationSec,
          })}
        </p>
      </section>
      <section>
        <h3>{t("history.list")}</h3>
        <table className="rows">
          <thead>
            <tr>
              <th>{t("col.time")}</th>
              <th>{t("col.pattern")}</th>
              <th>{t("col.tempo")}</th>
              <th>{t("col.accuracy")}</th>
              <th>{t("col.offset")}</th>
              <th>{t("col.combo")}</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h, i) => (
              <tr key={i} onClick={() => setOpen(h)}>
                <td>{fmtTime(h.startedAt)}</td>
                <td>
                  {historyPatternName(h)} · {h.beats}/4{h.keyMode === "alternate" ? t("history.alt") : ""}
                </td>
                <td>{h.bpm}</td>
                <td>{(h.accuracy * 100).toFixed(1)}%</td>
                <td>
                  {h.meanOffset > 0 ? "+" : ""}
                  {h.meanOffset} ±{h.stdOffset}
                </td>
                <td>{h.maxCombo}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button onClick={onClear}>{t("history.clear")}</button>
      </section>
    </>
  );
}
