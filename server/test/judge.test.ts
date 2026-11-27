import assert from "node:assert/strict";
import test from "node:test";
import { challengeDate, chartDurationMs, dailySpec, judgeTaps, noteTimes, specFromSeed } from "../../src/core/challenge";

test("same seed, same chart; charts vary by day", () => {
  assert.deepEqual(dailySpec("2026-11-27"), dailySpec("2026-11-27"));
  const specs = new Set(Array.from({ length: 30 }, (_, i) => JSON.stringify(dailySpec(`2026-12-${String(i + 1).padStart(2, "0")}`))));
  assert.ok(specs.size > 10);
  const s = specFromSeed("x");
  assert.ok(s.bpm >= 70 && s.bpm <= 140 && (s.beats === 3 || s.beats === 4) && s.bars === 16);
});

test("daily date follows the configured offset", () => {
  const t = Date.UTC(2026, 10, 27, 17, 0); // 17:00 UTC = 01:00 next day at UTC+8
  assert.equal(challengeDate(t, 480), "2026-11-28");
  assert.equal(challengeDate(t, 0), "2026-11-27");
});

test("note times: quarter notes at 120 BPM", () => {
  const n = noteTimes({ patternId: "quarter", bpm: 120, beats: 4, bars: 2 });
  assert.deepEqual(n, [0, 500, 1000, 1500, 2000, 2500, 3000, 3500]);
  assert.equal(chartDurationMs({ patternId: "quarter", bpm: 120, beats: 4, bars: 2 }), 4000);
});

test("grades, strays and misses", () => {
  const notes = [0, 500, 1000, 1500];
  const r = judgeTaps(notes, [10, 545, 1080, 1250]); // perfect, great, good, stray; 1500 missed
  assert.deepEqual([r.perfect, r.great, r.good, r.miss, r.stray], [1, 1, 1, 1, 1]);
  assert.equal(r.maxCombo, 3);
  assert.equal(r.score, Math.round(((1 + 0.7 + 0.4) / 5) * 10000));
});

test("perfect run scores 10000; stopping early does not help", () => {
  const notes = noteTimes({ patternId: "eighth", bpm: 100, beats: 4, bars: 16 });
  assert.equal(judgeTaps(notes, notes).score, 10000);
  assert.equal(judgeTaps(notes, notes.slice(0, 8)).score, Math.round((8 / notes.length) * 10000));
});

test("a tap takes the nearest open note; one tap per note", () => {
  const r = judgeTaps([0, 120], [70, 75]); // first tap -> 120 (50ms) is nearer than 0 (70ms)
  assert.equal(r.great + r.good, 2);
  assert.equal(r.miss, 0);
  const spam = judgeTaps([0], [0, 1, 2, 3]);
  assert.deepEqual([spam.perfect, spam.stray], [1, 3]);
});
