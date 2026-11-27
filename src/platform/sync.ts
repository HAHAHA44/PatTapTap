// Practice history sync: upload sessions this device hasn't sent yet, then merge in
// sessions recorded on other devices. A session is identified by its start time.

import type { SessionSummary } from "../core/types";
import { api } from "./api";
import { getState, loadHistory, replaceHistory, setState } from "./bridge";

const SENT_KEY = "syncedSessions";
const BATCH = 20;

let running: Promise<number> | null = null;

/** Returns how many sessions were added from other devices. Throws if offline / logged out. */
export function syncHistory(): Promise<number> {
  running ??= (async () => {
    const local = await loadHistory();
    const sent = new Set((await getState<number[]>(SENT_KEY)) ?? []);
    const todo = local.filter((s) => !sent.has(s.startedAt));
    for (let i = 0; i < todo.length; i += BATCH) {
      const chunk = todo.slice(i, i + BATCH);
      await api.pushSessions(chunk);
      chunk.forEach((s) => sent.add(s.startedAt));
      await setState(SENT_KEY, [...sent].slice(-1000));
    }
    const { sessions: remote } = await api.pullSessions();
    // re-read: a practice may have ended meanwhile
    const now = await loadHistory();
    const have = new Set(now.map((s) => s.startedAt));
    const added = remote.filter((s) => !have.has(s.startedAt));
    if (added.length) {
      const merged: SessionSummary[] = [...now, ...added].sort((a, b) => b.startedAt - a.startedAt);
      await replaceHistory(merged);
      added.forEach((s) => sent.add(s.startedAt));
      await setState(SENT_KEY, [...sent].slice(-1000));
    }
    return added.length;
  })().finally(() => (running = null));
  return running;
}
