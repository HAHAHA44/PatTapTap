/**
 * A steady interval driven from a Web Worker, which browsers throttle far less
 * than main-thread timers when the window is unfocused. Falls back to setInterval.
 */
export class Ticker {
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private intervalMs: number, private onTick: () => void) {}

  start() {
    this.stop();
    try {
      const src = `let t=null;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}`;
      const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      this.worker = new Worker(url);
      URL.revokeObjectURL(url);
      this.worker.onmessage = () => this.onTick();
      this.worker.postMessage(this.intervalMs);
    } catch {
      this.worker = null;
      this.timer = setInterval(this.onTick, this.intervalMs);
    }
  }

  stop() {
    if (this.worker) {
      this.worker.postMessage(0);
      this.worker.terminate();
      this.worker = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
