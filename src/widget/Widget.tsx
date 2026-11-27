import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Menu } from "@tauri-apps/api/menu";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { RhythmEngine } from "../core/engine";
import { chartCells, ChallengeSpec } from "../core/challenge";
import { expandBar } from "../core/pattern";
import { beatsPerBar, currentPattern, currentSongId, nextPlayIndex, normalizeSettings, Settings, toEngineConfig } from "../core/settings";
import { buildChart } from "../core/songChart";
import { songs } from "../platform/songs";
import { BarSlot } from "../core/types";
import { Grade, ScheduledEvent } from "../core/types";
import {
  appendHistory,
  EV,
  getState,
  isMac,
  KeyStatus,
  loadSettings,
  native,
  persistSettings,
  setState,
} from "../platform/bridge";
import { placeInitial, resizeAnchored, snapAndSave } from "../platform/widgetWindow";
import { api, AUTH_CHANGED, CHALLENGE_DONE, ChallengeOutcome, ChallengeRequest, PLAY_CHALLENGE } from "../platform/api";
import { resolveLang, setLang, t } from "../i18n";
import "./widget.css";

// Base sizes in logical px at scale 1 (must match widget.css).
const H = 44;
const ICON = 36;
const BEAT_W = 34; // wide enough for four 16th-note dots on one row
const GAP = 4;
const PAD = 4;

/** `boxes`: beat boxes to show (bar length, or the song's longest bar, or the challenge's). */
function widgetSize(s: Settings, boxes: number): [number, number] {
  const k = s.widgetScale;
  if (s.cue === "sound") return [Math.round(H * k), Math.round(H * k)];
  const n = boxes;
  return [Math.round((PAD + ICON + GAP + n * BEAT_W + (n - 1) * GAP + PAD) * k), Math.round(H * k)];
}

interface Flash { id: number; grade: Grade }

/** Set UI language and push translated labels to the native tray menu. */
function applyLanguage(s: Settings) {
  setLang(resolveLang(s.language));
  native
    .setTrayLabels({
      toggle: t("tray.toggle"),
      show: t("tray.show"),
      clickthrough: t("tray.clickThrough"),
      settings: t("tray.settings"),
      quit: t("tray.quit"),
      tooltip: t("app.name"),
    })
    .catch(() => {});
}

export default function Widget() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [running, setRunning] = useState(false);
  const [beat, setBeat] = useState<{ bar: number; beat: number; countIn: boolean } | null>(null);
  const [pulse, setPulse] = useState(0);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [combo, setCombo] = useState(0);
  const [stray, setStray] = useState<{ id: number; beat: number } | null>(null);
  const beatRef = useRef<number | null>(null);
  const [, setResultsVersion] = useState(0);
  const [keyStatus, setKeyStatus] = useState<KeyStatus>("stopped");
  const [hotkeyErrors, setHotkeyErrors] = useState<string[]>([]);
  const [hint, setHint] = useState<string>("");
  const [lastAcc, setLastAcc] = useState<number | null>(null);
  /** Boxes shown in song mode: the longest bar of the current song (bars vary). */
  const [songBeats, setSongBeats] = useState(4);
  const songBeatsRef = useRef(4);
  /** The challenge being played (daily / PK), if any. */
  const challengeRef = useRef<ChallengeRequest | null>(null);
  const [challenge, setChallenge] = useState<ChallengeSpec | null>(null);
  const boxes = (s: Settings) => (challengeRef.current ? challengeRef.current.spec.beats : s.mode === "song" ? songBeatsRef.current : beatsPerBar(s));
  const hintTimer = useRef<number | undefined>(undefined);
  /** A hint that clears itself after a while. */
  const flashHint = useCallback((text: string, ms = 10000) => {
    clearTimeout(hintTimer.current);
    setHint(text);
    hintTimer.current = window.setTimeout(() => setHint(""), ms);
  }, []);

  const settingsRef = useRef<Settings | null>(null);
  const runningRef = useRef(false);
  const keyStatusRef = useRef<KeyStatus>("stopped");
  const queue = useRef<ScheduledEvent[]>([]);
  const results = useRef(new Map<string, Grade>());
  const flashId = useRef(0);

  // ---- engine -------------------------------------------------------------
  // One engine per widget for its whole life. A ref (not useMemo) so a dev hot
  // reload can't create a second engine while the first keeps playing.
  const engineRef = useRef<RhythmEngine | null>(null);
  if (!engineRef.current)
    engineRef.current = new RhythmEngine({
        onSchedule: (e) => queue.current.push(e),
        onResult: (r, stats) => {
          results.current.set(`${r.bar}:${r.noteIndex}`, r.grade);
          setResultsVersion((v) => v + 1);
          setCombo(stats.combo);
          setFlash({ id: ++flashId.current, grade: r.grade });
        },
        // Song finished: stop like the user pressed stop (saves the session).
        // Song finished: save it, then go on to the next playlist entry.
        onEnd: () => void (challengeRef.current ? finishRef.current() : endRef.current()),
        onStray: (stats) => {
          setCombo(stats.combo);
          setFlash({ id: ++flashId.current, grade: "miss" });
          // Extra tap with no note nearby: mark the beat box it happened in.
          if (beatRef.current !== null) setStray({ id: flashId.current, beat: beatRef.current });
        },
      });
  const engine = engineRef.current;
  useEffect(
    () => () => {
      // Unmount (or hot reload): never leave audio running without a UI.
      engine.stop();
      runningRef.current = false;
    },
    [engine],
  );

  // Start/stop/restart run strictly one after another (rapid clicks or setting
  // changes during playback must not interleave).
  const opChain = useRef<Promise<unknown>>(Promise.resolve());
  const serial = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const next = opChain.current.then(fn, fn);
    opChain.current = next.catch(() => {});
    return next;
  }, []);

  const hotkeyErrorsRef = useRef<string[]>([]);
  const broadcastState = useCallback(
    (over?: Partial<{ running: boolean }>) =>
      emit(EV.runState, {
        running: over?.running ?? runningRef.current,
        keyStatus: keyStatusRef.current,
        hotkeyErrors: hotkeyErrorsRef.current,
      }),
    [],
  );

  const watchKeys = useCallback((on: boolean) => {
    const s = settingsRef.current;
    // Only ask the OS hook to forward tap keys while practicing.
    const keys = on && s ? (s.keyMode === "alternate" ? s.keys : [s.keys[0]]) : [];
    native.setWatchedKeys(keys).catch(() => {});
  }, []);

  const stopNow = useCallback(async () => {
    if (!runningRef.current) return;
    // stopped by hand during a challenge: nothing is submitted
    const cancelled = challengeRef.current;
    challengeRef.current = null;
    const summary = engine.stop();
    if (cancelled) {
      setChallenge(null);
      flashHint(t("widget.challengeCancelled"));
      emit(CHALLENGE_DONE, { kind: cancelled.kind, status: "cancelled" } satisfies ChallengeOutcome).catch(() => {});
      const s = settingsRef.current;
      if (s) resizeAnchored(...widgetSize(s, boxes(s))).catch(() => {});
    }
    runningRef.current = false;
    setRunning(false);
    setBeat(null);
    beatRef.current = null;
    setStray(null);
    queue.current = [];
    watchKeys(false);
    broadcastState({ running: false });
    if (summary) {
      setLastAcc(summary.accuracy);
      await appendHistory(summary);
      await emit(EV.sessionEnded, summary);
    }
  }, [engine, watchKeys, broadcastState]);

  const startNow = useCallback(async () => {
    const s = settingsRef.current;
    if (!s || runningRef.current) return;
    results.current.clear();
    queue.current = [];
    setCombo(0);
    let song = null;
    if (s.mode === "song") {
      // Load and decode the song each time (decoded audio is large; don't keep it idle).
      const songId = currentSongId(s);
      if (!songId) return setHint(t("widget.noSong"));
      try {
        const [meta, bytes] = await Promise.all([songs.read(songId), songs.loadAudio(songId)]);
        const bars = buildChart(meta, s.songLevel);
        if (!bars.length) return setHint(t("widget.noSong"));
        const longest = Math.max(...bars.map((b) => b.beats.length));
        if (longest !== songBeatsRef.current) {
          songBeatsRef.current = longest;
          setSongBeats(longest);
          const [w, h] = widgetSize(s, longest);
          resizeAnchored(w, h).catch(() => {});
        }
        song = { id: meta.id, name: meta.name, bpm: meta.bpm, buffer: await engine.decode(bytes), bars, volume: s.songVolume, clicks: s.songClicks };
      } catch {
        return setHint(t("widget.noSong"));
      }
    }
    const ok = await engine.start(toEngineConfig(s), song);
    if (!ok) {
      setHint(t("widget.enableSound"));
      return;
    }
    setHint("");
    runningRef.current = true;
    setRunning(true);
    watchKeys(true);
    broadcastState({ running: true });
  }, [engine, watchKeys, broadcastState]);

  /** Play a challenge chart (count-in, fixed bars) with the user's keys and sounds. */
  const startChallenge = useCallback(
    (ch: ChallengeRequest) =>
      serial(async () => {
        await stopNow();
        const s = settingsRef.current;
        if (!s) return;
        results.current.clear();
        queue.current = [];
        setCombo(0);
        // the count-in clicks quarters; the chart itself comes bar by bar
        const pattern = { id: `challenge:${ch.kind}`, name: ch.kind === "daily" ? t("online.daily") : t("online.pk"), cells: [[true]] };
        const cfg = {
          ...toEngineConfig(s),
          mode: "metronome" as const,
          songId: null,
          bpm: ch.spec.bpm,
          beats: ch.spec.beats,
          pattern,
          countIn: true,
          judge: true,
          challengeBars: ch.spec.bars,
          challengeCells: chartCells(ch.spec),
        };
        challengeRef.current = ch;
        setChallenge(ch.spec);
        resizeAnchored(...widgetSize(s, ch.spec.beats)).catch(() => {});
        if (!(await engine.start(cfg))) {
          challengeRef.current = null;
          setChallenge(null);
          setHint(t("widget.enableSound"));
          return;
        }
        flashHint(t("widget.challengeGo"), 3000);
        runningRef.current = true;
        setRunning(true);
        watchKeys(true);
        broadcastState({ running: true });
      }),
    [serial, stopNow, engine, watchKeys, broadcastState, flashHint],
  );

  /** Challenge chart finished: save locally, send the raw taps for the server to judge. */
  const finishChallenge = useCallback(
    () =>
      serial(async () => {
        const ch = challengeRef.current;
        if (!ch || !runningRef.current) return;
        const taps = engine.taps.slice();
        challengeRef.current = null; // so stopNow doesn't treat this as a cancel
        await stopNow();
        setChallenge(null);
        const s = settingsRef.current;
        if (s) resizeAnchored(...widgetSize(s, boxes(s))).catch(() => {});
        setHint(t("widget.submitting"));
        try {
          const result = ch.kind === "daily" ? (await api.submitDaily(ch.date, taps)).result : (await api.pkSubmit(ch.id, taps)).mine!;
          flashHint(t("widget.challengeScore", { p: (result.score / 100).toFixed(2) }));
          await emit(CHALLENGE_DONE, { kind: ch.kind, status: "submitted", result } satisfies ChallengeOutcome);
        } catch (e) {
          flashHint(t("widget.submitFailed"));
          await emit(CHALLENGE_DONE, { kind: ch.kind, status: "error", code: (e as Error).message } satisfies ChallengeOutcome);
        }
      }),
    [serial, stopNow, engine, flashHint],
  );

  const start = useCallback(() => serial(startNow), [serial, startNow]);
  const stop = useCallback(() => serial(stopNow), [serial, stopNow]);
  const toggle = useCallback(() => serial(() => (runningRef.current ? stopNow() : startNow())), [serial, startNow, stopNow]);
  /** End of a song: save the session, move along the playlist (per play mode), keep going. */
  const onSongEnd = useCallback(
    () =>
      serial(async () => {
        if (!runningRef.current) return;
        await stopNow();
        const s = settingsRef.current;
        if (!s || s.mode !== "song" || !s.playlist.length) return;
        await applyRef.current({ ...s, playIndex: nextPlayIndex(s) }, true);
        await startNow();
      }),
    [serial, startNow, stopNow],
  );

  // ---- settings -----------------------------------------------------------
  const applySettings = useCallback(
    async (s: Settings, persist: boolean) => {
      const prev = settingsRef.current;
      settingsRef.current = s;
      applyLanguage(s);
      setSettings(s);
      if (persist) {
        await persistSettings(s);
        await emit(EV.settingsChanged, s);
      }
      getCurrentWindow().setIgnoreCursorEvents(s.clickThrough).catch(() => {});
      const [w, h] = widgetSize(s, boxes(s));
      if (prev) resizeAnchored(w, h).catch(() => {});
      // Restart with the new config if something timing-related changed mid-practice.
      // (a challenge keeps its own fixed chart: no restart)
      if (runningRef.current && !challengeRef.current && prev && JSON.stringify(toEngineConfig(prev)) !== JSON.stringify(toEngineConfig(s))) {
        // Volume and sound type change live; anything else restarts playback.
        const live = (c: ReturnType<typeof toEngineConfig>) => JSON.stringify({ ...c, volume: 0, voice: "", songVolume: 0 });
        if (live(toEngineConfig(prev)) === live(toEngineConfig(s))) {
          engine.setVolume(s.volume);
          engine.setVoice(s.voice);
          engine.setSongVolume(s.songVolume);
        }
        else
          await serial(async () => {
            await stopNow();
            await startNow();
          });
      } else if (runningRef.current) watchKeys(true);
    },
    [engine, start, stop, watchKeys],
  );

  // ---- startup ------------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    (async () => {
      const s = await loadSettings();
      if (disposed) return;
      applyLanguage(s);
      settingsRef.current = s;
      setSettings(s);
      const [w, h] = widgetSize(s, boxes(s));
      await placeInitial(w, h).catch(() => {});
      await getCurrentWindow().setIgnoreCursorEvents(s.clickThrough).catch(() => {});
      await getCurrentWindow().show();

      let st = await native.startKeyListener();
      if (st === "no-permission" && isMac && !(await getState<boolean>("askedPermission"))) {
        await setState("askedPermission", true);
        await native.requestKeyPermission();
        st = await native.startKeyListener();
      }
      keyStatusRef.current = st;
      setKeyStatus(st);
      const dbg = (window as unknown as { bcLog?: (l: string, m: string) => void }).bcLog;
      const pos = await getCurrentWindow().outerPosition();
      const size = await getCurrentWindow().outerSize();
      dbg?.("info", `widget ready: keyStatus=${st} pos=${pos.x},${pos.y} size=${size.width}x${size.height} cue=${s.cue}`);

      unlisten.push(
        await listen<Settings>(EV.settingsUpdate, (e) => applyRef.current(normalizeSettings(e.payload), true)),
        await listen<string>(EV.globalKey, (e) => engine.hit(e.payload, performance.now())),
        await listen<ChallengeRequest>(PLAY_CHALLENGE, (e) => void challengeStartRef.current(e.payload)),
        await listen(AUTH_CHANGED, () => void pollPkRef.current()),
        await listen<string>(EV.cmd, async (e) => {
          if (e.payload === "toggle") toggleRef.current();
          else if (e.payload === "stop") stopRef.current();
          else if (e.payload === "ping") {
            keyStatusRef.current = await native.keyStatus();
            setKeyStatus(keyStatusRef.current);
            broadcastState();
          } else if (e.payload === "clickthrough" && settingsRef.current) {
            applyRef.current({ ...settingsRef.current, clickThrough: !settingsRef.current.clickThrough }, true);
          }
        }),
        await getCurrentWindow().onMoved(() => {
          clearTimeout(moveTimer.current);
          moveTimer.current = window.setTimeout(() => snapAndSave().catch(() => {}), 350);
        }),
      );
    })();
    return () => {
      disposed = true;
      unlisten.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const moveTimer = useRef<number | undefined>(undefined);

  // Global hotkeys (re-registered when they change).
  const hk = settings?.hotkeys;
  useEffect(() => {
    if (!hk) return;
    let cancelled = false;
    (async () => {
      await unregisterAll().catch(() => {});
      const errs: string[] = [];
      const reg = async (acc: string, fn: () => void) => {
        if (!acc.trim()) return;
        try {
          await register(acc, (ev) => ev.state === "Pressed" && fn());
        } catch {
          errs.push(acc);
        }
      };
      await reg(hk.toggle, () => toggleRef.current());
      await reg(hk.boss, async () => {
        const w = getCurrentWindow();
        if (await w.isVisible()) {
          await stopRef.current();
          await w.hide();
        } else await w.show();
      });
      if (!cancelled) {
        hotkeyErrorsRef.current = errs;
        setHotkeyErrors(errs);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hk?.toggle, hk?.boss]);
  const toggleRef = useRef(toggle);
  const stopRef = useRef(stop);
  const applyRef = useRef(applySettings);
  const endRef = useRef(onSongEnd);
  endRef.current = onSongEnd;
  const finishRef = useRef(finishChallenge);
  finishRef.current = finishChallenge;
  const challengeStartRef = useRef(startChallenge);
  challengeStartRef.current = startChallenge;

  // PK invites: check now and then; mention new ones that wait for this player.
  const seenPk = useRef<Set<string> | null>(null);
  const pollPk = useCallback(async () => {
    try {
      const { matches } = await api.pkList();
      const waiting = matches.filter((m) => m.status === "open" && !m.mine).map((m) => m.id);
      const fresh = seenPk.current ? waiting.filter((id) => !seenPk.current!.has(id)) : [];
      seenPk.current = new Set(waiting);
      if (fresh.length && !runningRef.current) flashHint(t("widget.pkWaiting", { n: waiting.length }), 15000);
    } catch {
      seenPk.current = null; // logged out or offline
    }
  }, [flashHint]);
  const pollPkRef = useRef(pollPk);
  pollPkRef.current = pollPk;
  useEffect(() => {
    void pollPkRef.current();
    const id = window.setInterval(() => void pollPkRef.current(), 5 * 60000);
    return () => clearInterval(id);
  }, []);
  toggleRef.current = toggle;
  stopRef.current = stop;
  applyRef.current = applySettings;
  useEffect(() => {
    broadcastState();
  }, [hotkeyErrors, broadcastState]);

  // Fallback: in-window keys when the global hook isn't available.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keyStatusRef.current === "running" || e.repeat) return;
      engine.hit(e.code, e.timeStamp > 0 ? e.timeStamp : performance.now());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine]);

  // Render loop: release scheduled events when they become audible.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const now = performance.now();
      const q = queue.current;
      let latest: ScheduledEvent | null = null;
      while (q.length && q[0].perfTime <= now) {
        const e = q.shift()!;
        if (e.slot.isBeatStart) latest = e;
      }
      if (latest) {
        setBeat({ bar: latest.bar, beat: latest.slot.beat, countIn: latest.countIn });
        beatRef.current = latest.countIn ? null : latest.slot.beat;
        setPulse((p) => p + 1);
        if (latest.slot.beat === 0) {
          for (const k of results.current.keys()) {
            if (Number(k.split(":")[0]) < latest.bar - 1) results.current.delete(k);
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- interaction ----------------------------------------------------------
  const down = useRef<{ x: number; y: number } | null>(null);
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    down.current = { x: e.screenX, y: e.screenY };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const d = down.current;
    if (d && (Math.abs(e.screenX - d.x) > 3 || Math.abs(e.screenY - d.y) > 3)) {
      down.current = null;
      getCurrentWindow().startDragging().catch(() => {});
    }
  };
  const onMouseUp = () => {
    if (down.current && hint) start();
    down.current = null;
  };

  const onContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    const s = settingsRef.current;
    const menu = await Menu.new({
      items: [
        { id: "toggle", text: runningRef.current ? t("menu.stop") : t("menu.start"), action: () => toggle() },
        { item: "Separator" },
        { id: "settings", text: t("menu.settings"), action: () => native.openSettings() },
        {
          id: "through",
          text: t("menu.clickThrough"),
          action: () => s && applySettings({ ...s, clickThrough: true }, true),
        },
        {
          id: "hide",
          text: t("menu.hide"),
          action: async () => {
            await stop();
            await getCurrentWindow().hide();
          },
        },
        { item: "Separator" },
        { id: "quit", text: t("menu.quit"), action: () => native.quit() },
      ],
    });
    await menu.popup();
  };

  // ---- render ---------------------------------------------------------------
  const pattern = settings ? currentPattern(settings) : null;
  const idleSlots = useMemo(
    () =>
      settings?.mode === "song"
        ? expandBar({ id: "", name: "", cells: [[true], [true], [true], [true]] }, 4)
        : pattern && settings
          ? expandBar(pattern, settings.beats)
          : [],
    [pattern, settings?.beats, settings?.mode],
  );
  if (!settings) return null;

  const visual = settings.cue !== "sound";
  const shownBar = beat?.bar ?? 0;
  const nBeats = challenge ? challenge.beats : settings.mode === "song" ? songBeats : beatsPerBar(settings);
  // Dots per beat for a bar; song charts differ bar to bar, so ask the engine.
  const slotsAt = (bar: number): BarSlot[] => (running && engine.slotsOf(bar)) || idleSlots;
  const beatsIn = (bar: number) => slotsAt(bar).reduce((m, x) => Math.max(m, x.beat + 1), 0);
  const layout = (bar: number) => {
    const sl = slotsAt(bar);
    const per: { on: boolean; noteIndex: number }[][] = Array.from({ length: nBeats }, () => []);
    for (const x of sl) per[x.beat]?.push({ on: x.isNote, noteIndex: x.noteIndex });
    return per;
  };
  const perBeat = layout(shownBar);
  const prevBar = layout(shownBar - 1);

  const warn = keyStatus !== "running";
  const title = [
    running ? t("widget.running") : t("widget.idle"),
    lastAcc !== null ? t("widget.lastAcc", { p: `${(lastAcc * 100).toFixed(1)}%` }) : "",
    warn ? t("widget.keysOff") : "",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div
      className={`widget ${visual ? "visual" : "compact"} ${running ? "running" : ""}`}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onDoubleClick={() => toggle()}
      onContextMenu={onContextMenu}
      title={title}
      style={{ ["--s" as string]: settings.widgetScale }}
    >
      <div className="icon">
        {settings.iconFeedback && running && <span key={pulse} className="pulse" />}
        {settings.iconFeedback && flash && <span key={`f${flash.id}`} className={`flash ${flash.grade}`} />}
        <svg viewBox="0 0 24 24" width={20 * settings.widgetScale} height={20 * settings.widgetScale} aria-hidden>
          {running ? (
            <path d="M9 3v11.3A3.5 3.5 0 1 0 11 17.5V7h6V3z" fill="currentColor" />
          ) : (
            <path d="M8 5.5v13l10-6.5z" fill="currentColor" />
          )}
        </svg>
        {running && combo >= 5 && <span className="combo">{combo}</span>}
        {warn && <span className="warn" />}
        {hint && <span className="hint">{hint}</span>}
      </div>
      {visual && (
        <div className="bar">
          {perBeat.map((cellsNow, i) => {
            let cells = cellsNow;
            const active = running && beat?.beat === i;
            // Beats not reached yet in this bar keep showing (dimmed) the previous bar's
            // results, so late-judged misses on the last notes of a bar stay visible.
            const ahead = running && beat !== null && i > beat.beat;
            const barOf = ahead ? shownBar - 1 : shownBar;
            if (ahead) cells = prevBar[i];
            // song bars can be shorter than the widest bar (e.g. a 2/4 bar): extra boxes fade
            const unused = i >= beatsIn(barOf);
            return (
              <div
                key={i}
                className={`beat ${active ? "active" : ""} ${active && beat?.countIn ? "countin" : ""} ${i === 0 ? "first" : ""} ${ahead ? "ahead" : ""} ${unused ? "unused" : ""}`}
              >
                {cells.map((c, j) => {
                  const g = c.on ? results.current.get(`${barOf}:${c.noteIndex}`) : undefined;
                  return <span key={j} className={`dot ${c.on ? "on" : "rest"} ${g ?? ""}`} />;
                })}
                {running && stray?.beat === i && <span key={stray.id} className="stray-mark" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
