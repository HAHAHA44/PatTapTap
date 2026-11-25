import {
  getCurrentWindow,
  LogicalSize,
  Monitor,
  monitorFromPoint,
  PhysicalPosition,
  primaryMonitor,
} from "@tauri-apps/api/window";
import { getState, setState } from "./bridge";

const MARGIN = 16; // logical px from screen edge for the default spot
const SNAP = 18; // logical px: snap to work-area edges when this close

const win = () => getCurrentWindow();

interface Rect { x: number; y: number; w: number; h: number }

function workArea(m: Monitor): Rect {
  const wa = m.workArea ?? { position: m.position, size: m.size };
  return { x: wa.position.x, y: wa.position.y, w: wa.size.width, h: wa.size.height };
}

async function monitorFor(x: number, y: number): Promise<Monitor | null> {
  return (await monitorFromPoint(x, y)) ?? (await primaryMonitor());
}

/** Restore the saved position, or default to the bottom-right corner. */
export async function placeInitial(w: number, h: number) {
  const wnd = win();
  await wnd.setSize(new LogicalSize(w, h));
  const saved = await getState<{ x: number; y: number }>("widgetPos");
  if (saved && (await monitorFromPoint(saved.x + 2, saved.y + 2))) {
    await wnd.setPosition(new PhysicalPosition(saved.x, saved.y));
    return;
  }
  const m = await primaryMonitor();
  if (!m) return;
  const a = workArea(m);
  const s = m.scaleFactor;
  await wnd.setPosition(
    new PhysicalPosition(
      Math.round(a.x + a.w - (w + MARGIN) * s),
      Math.round(a.y + a.h - (h + MARGIN) * s),
    ),
  );
}

/**
 * Resize while keeping the corner nearest to the screen corner fixed, so a widget
 * parked bottom-right grows to the left/up instead of off-screen.
 */
export async function resizeAnchored(w: number, h: number) {
  const wnd = win();
  const pos = await wnd.outerPosition();
  const size = await wnd.outerSize();
  const m = await monitorFor(pos.x + size.width / 2, pos.y + size.height / 2);
  const s = m?.scaleFactor ?? (await wnd.scaleFactor());
  const nw = Math.round(w * s);
  const nh = Math.round(h * s);
  if (nw === size.width && nh === size.height) return;
  let x = pos.x;
  let y = pos.y;
  if (m) {
    const a = workArea(m);
    if (pos.x + size.width / 2 > a.x + a.w / 2) x = pos.x + size.width - nw;
    if (pos.y + size.height / 2 > a.y + a.h / 2) y = pos.y + size.height - nh;
    x = Math.min(Math.max(x, a.x), a.x + a.w - nw);
    y = Math.min(Math.max(y, a.y), a.y + a.h - nh);
  }
  await wnd.setSize(new LogicalSize(w, h));
  if (x !== pos.x || y !== pos.y) await wnd.setPosition(new PhysicalPosition(x, y));
  await setState("widgetPos", { x, y });
}

/** After a drag ends: snap to nearby work-area edges and remember the spot. */
export async function snapAndSave() {
  const wnd = win();
  const pos = await wnd.outerPosition();
  const size = await wnd.outerSize();
  const m = await monitorFor(pos.x + size.width / 2, pos.y + size.height / 2);
  let { x, y } = pos;
  if (m) {
    const a = workArea(m);
    const snap = SNAP * m.scaleFactor;
    if (Math.abs(x - a.x) < snap) x = a.x;
    if (Math.abs(a.x + a.w - (x + size.width)) < snap) x = a.x + a.w - size.width;
    if (Math.abs(y - a.y) < snap) y = a.y;
    if (Math.abs(a.y + a.h - (y + size.height)) < snap) y = a.y + a.h - size.height;
    if (x !== pos.x || y !== pos.y) await wnd.setPosition(new PhysicalPosition(x, y));
  }
  await setState("widgetPos", { x, y });
}
