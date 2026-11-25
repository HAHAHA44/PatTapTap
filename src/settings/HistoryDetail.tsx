import { useMemo } from "react";
import { analyze, GroupStats, notePositions } from "../core/analysis";
import { SessionSummary } from "../core/types";
import { formatPosition, getLang, patternName, t, tendency } from "../i18n";
import OffsetChart from "./OffsetChart";

export const fmtTime = (ts: number) => {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const signed = (x: number) => `${x > 0 ? "+" : ""}${x}`;

/** Pattern name of a stored session, translated when it was a built-in. */
export function historyPatternName(s: SessionSummary): string {
  return s.patternId ? patternName({ id: s.patternId, name: s.patternName, builtin: s.patternBuiltin }) : s.patternName;
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {note && <div className="tile-note">{note}</div>}
    </div>
  );
}

function GroupCells({ g, noMiss }: { g: GroupStats; noMiss?: boolean }) {
  return (
    <>
      <td>{g.count}</td>
      <td>{g.hits ? signed(g.mean) : "–"}</td>
      <td>{g.hits ? `±${g.std}` : "–"}</td>
      <td>{noMiss ? "–" : g.count ? pct(g.misses / g.count) : "–"}</td>
    </>
  );
}

export default function HistoryDetail({ s, onBack }: { s: SessionSummary; onBack: () => void }) {
  const d = s.detail;
  const a = useMemo(() => (d ? analyze(d) : null), [d]);
  const lang = getLang();
  const labels = useMemo(() => (d ? notePositions(d.cells).map(formatPosition) : []), [d, lang]);

  const head = (
    <div className="detail-head">
      <button onClick={onBack}>{t("common.back")}</button>
      <div>
        <b>{fmtTime(s.startedAt)}</b>
        <span className="note">
          {" "}
          {historyPatternName(s)} · {s.beats}/4 · {s.bpm} BPM · {s.keyMode === "alternate" ? t("detail.alternate") : t("detail.single")} ·{" "}
          {s.durationSec}s
        </span>
      </div>
    </div>
  );

  if (!d || !a) {
    return (
      <section>
        {head}
        <p className="note">{t("detail.noData")}</p>
      </section>
    );
  }

  const drift = a.driftPerMin;
  const driftText = Math.abs(drift) < 3 ? t("drift.steady") : drift > 0 ? t("drift.slower") : t("drift.faster");
  const worst = [...a.positions].filter((p) => p.hits).sort((x, y) => Math.abs(y.mean) - Math.abs(x.mean))[0];
  const showWorst = worst && Math.abs(worst.mean) >= 10;
  const judged = s.perfect + s.great + s.good + s.miss;
  const statHead = (first: string) => (
    <thead>
      <tr>
        <th>{first}</th>
        <th>{t("col.count")}</th>
        <th>{t("col.meanOffset")}</th>
        <th>{t("col.stability")}</th>
        <th>{t("col.missRate")}</th>
      </tr>
    </thead>
  );

  return (
    <>
      <section>
        {head}
        <div className="tiles">
          <Tile label={t("tile.accuracy")} value={pct(s.accuracy)} note={t("tile.maxCombo", { n: s.maxCombo })} />
          <Tile
            label={t("tile.mean")}
            value={`${signed(s.meanOffset)} ms`}
            note={`${tendency(s.meanOffset)} · ${t("tile.median", { v: signed(a.median) })}`}
          />
          <Tile label={t("tile.std")} value={`±${s.stdOffset} ms`} />
          <Tile label={t("tile.drift")} value={`${signed(drift)} ${t("tile.driftUnit")}`} note={driftText} />
        </div>
      </section>

      <section>
        <h3>{t("detail.chartTitle")}</h3>
        <OffsetChart strict={d.strictAlternate} trace={d.trace} movingAvg={a.movingAvg} windows={d.windows} labels={labels} />
        {d.truncated && <p className="note">{t("detail.truncated")}</p>}
      </section>

      <section>
        <h3>{t("detail.judgeTitle")}</h3>
        <table className="kv">
          <tbody>
            <tr>
              <td>{t("detail.dist")}</td>
              <td>
                <span className="grade perfect">Perfect {s.perfect}</span> · <span className="grade great">Great {s.great}</span> ·{" "}
                <span className="grade good">Good {s.good}</span> · <span className="grade miss">Miss {s.miss}</span>
                {judged > 0 && <span className="note">{t("detail.perfectRate", { p: pct(s.perfect / judged) })}</span>}
              </td>
            </tr>
            <tr>
              <td>{t("detail.stray")}</td>
              <td>{t("common.times", { n: s.stray })}</td>
            </tr>
            <tr>
              <td>{t("detail.timing")}</td>
              <td>
                {pct(a.onTimePct)} / {pct(a.earlyPct)} / {pct(a.latePct)}
              </td>
            </tr>
            <tr>
              <td>{t("detail.extremes")}</td>
              <td>
                {signed(Math.round(a.earliest))} ms / {signed(Math.round(a.latest))} ms
              </td>
            </tr>
            <tr>
              <td>{t("detail.halves")}</td>
              <td>
                {t("detail.halvesValue", {
                  m1: signed(a.firstHalf.mean),
                  m2: signed(a.secondHalf.mean),
                  s1: a.firstHalf.std,
                  s2: a.secondHalf.std,
                  x1: a.firstHalf.misses,
                  x2: a.secondHalf.misses,
                })}
              </td>
            </tr>
            {a.wrongHand > 0 && (
              <tr>
                <td>{t("detail.wrongKey")}</td>
                <td>{t("common.times", { n: a.wrongHand })}</td>
              </tr>
            )}
            <tr>
              <td>{t("detail.windows")}</td>
              <td>
                {t("detail.windowsValue", {
                  p: d.windows.perfect,
                  g: d.windows.great,
                  gd: d.windows.good,
                  c: d.calibrationMs,
                })}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h3>{t("detail.positions")}</h3>
        {showWorst && (
          <p className="note">{t("detail.worst", { label: formatPosition(worst.pos), tendency: tendency(worst.mean) })}</p>
        )}
        <table>
          {statHead(t("col.position"))}
          <tbody>
            {a.positions.map((p) => (
              <tr key={p.noteIndex} className={showWorst && p.noteIndex === worst.noteIndex ? "hl" : ""}>
                <td>{formatPosition(p.pos)}</td>
                <GroupCells g={p} />
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {a.hands && (
        <section>
          <h3>{t("detail.keys")}</h3>
          {!d.strictAlternate && <p className="note">{t("detail.keysNote")}</p>}
          <table>
            {statHead(t("col.key"))}
            <tbody>
              {a.hands.map((g, i) => (
                <tr key={i}>
                  <td>{i === 0 ? t("key.1") : t("key.2")}</td>
                  <GroupCells g={g} noMiss={!d.strictAlternate} />
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
