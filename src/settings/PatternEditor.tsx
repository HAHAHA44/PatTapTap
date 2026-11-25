import { useState } from "react";
import { MessageKey, t } from "../i18n";
import { newPatternId, toggleCell, withBeatCount, withSubdivision } from "../core/pattern";
import { MAX_BEATS, Pattern, SUBDIVISIONS } from "../core/types";


export function PatternPreview({ cells, beats }: { cells: boolean[][]; beats?: number }) {
  const n = beats ?? cells.length;
  return (
    <span className="pp">
      {Array.from({ length: n }, (_, i) => {
        const c = cells[i % cells.length];
        return (
          <span key={i} className="pp-beat">
            {c.map((on, j) => (
              <i key={j} className={on ? "on" : ""} />
            ))}
          </span>
        );
      })}
    </span>
  );
}

export default function PatternEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: Pattern | null;
  onSave: (p: Pattern) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? t("editor.defaultName"));
  const [cells, setCells] = useState<boolean[][]>(initial?.cells ?? [[true], [true], [true], [true]]);

  return (
    <div className="editor">
      <div className="row">
        <label>{t("editor.name")}</label>
        <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="row">
        <label>{t("editor.length")}</label>
        <div className="seg">
          {Array.from({ length: MAX_BEATS }, (_, i) => i + 1).map((n) => (
            <button key={n} className={cells.length === n ? "on" : ""} onClick={() => setCells(withBeatCount(cells, n))}>
              {n}
            </button>
          ))}
        </div>
        <span className="note">{t("editor.lengthNote")}</span>
      </div>

      <div className="grid">
        {cells.map((c, b) => (
          <div key={b} className="grid-beat">
            <div className="grid-head">{t("editor.beatN", { n: b + 1 })}</div>
            <select value={c.length} onChange={(e) => setCells(withSubdivision(cells, b, Number(e.target.value)))}>
              {SUBDIVISIONS.map((s) => (
                <option key={s} value={s}>
                  {t(`sub.${s}` as MessageKey)}
                </option>
              ))}
            </select>
            <div className="cells">
              {c.map((on, j) => (
                <button
                  key={j}
                  className={`cell ${on ? "on" : ""}`}
                  onClick={() => setCells(toggleCell(cells, b, j))}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="actions">
        <button onClick={onCancel}>{t("common.cancel")}</button>
        <button
          className="primary"
          disabled={!name.trim() || !cells.some((c) => c.some(Boolean))}
          onClick={() => onSave({ id: initial?.id ?? newPatternId(), name: name.trim(), cells })}
        >
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}
