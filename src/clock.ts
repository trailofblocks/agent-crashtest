/**
 * Time, real or simulated. Everything in crashtest that waits (tool latency, backoff, timeouts,
 * rate-limit windows) goes through a Clock, so the lab can run on simulated time: a 60-second
 * rate limit costs nothing, and every run with the same seed sees the same timings.
 */
export interface Clock {
  /** Milliseconds. Real clocks use the epoch; the simulated clock starts at 0. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Run `fn` after `ms`. Returns a function that cancels it. */
  setTimer(ms: number, fn: () => void): () => void;
}

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }
  setTimer(ms: number, fn: () => void): () => void {
    const handle = setTimeout(fn, Math.max(0, ms));
    return () => clearTimeout(handle);
  }
}

interface Timer {
  at: number;
  seq: number;
  fn: () => void;
}

/** Let every pending promise callback run. Tool calls in the lab are in-memory, so this is enough. */
async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * A discrete-event clock. Time stands still while there is work to do, and jumps to the next timer
 * when everything is waiting. Timers due at the same moment fire in the order they were set.
 */
export class SimClock implements Clock {
  private t = 0;
  private seq = 0;
  private timers: Timer[] = [];
  /** Timers fired so far, as a guard against runaway simulations. */
  events = 0;

  now(): number {
    return this.t;
  }

  setTimer(ms: number, fn: () => void): () => void {
    const timer: Timer = { at: this.t + Math.max(0, ms), seq: ++this.seq, fn };
    this.timers.push(timer);
    return () => {
      const i = this.timers.indexOf(timer);
      if (i >= 0) this.timers.splice(i, 1);
    };
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.setTimer(ms, resolve));
  }

  get pending(): number {
    return this.timers.length;
  }

  private fireNext(): boolean {
    if (this.timers.length === 0) return false;
    let best = 0;
    for (let i = 1; i < this.timers.length; i++) {
      const a = this.timers[i]!;
      const b = this.timers[best]!;
      if (a.at < b.at || (a.at === b.at && a.seq < b.seq)) best = i;
    }
    const [timer] = this.timers.splice(best, 1);
    this.t = Math.max(this.t, timer!.at);
    this.events++;
    timer!.fn();
    return true;
  }

  /**
   * Run `work` to completion on simulated time. Throws if the work is stuck waiting with no timer
   * left to fire, or after `maxEvents` timers (a simulation that never ends).
   */
  async run<T>(work: () => Promise<T>, maxEvents = 100_000): Promise<T> {
    let state: { done: false } | { done: true; ok: true; value: T } | { done: true; ok: false; error: unknown } = { done: false };
    work().then(
      (value) => (state = { done: true, ok: true, value }),
      (error) => (state = { done: true, ok: false, error }),
    );
    const start = this.events;
    for (;;) {
      await settle();
      if (state.done) break;
      if (this.events - start >= maxEvents) throw new Error(`SimClock: gave up after ${maxEvents} timer events`);
      if (!this.fireNext()) throw new Error("SimClock: the work is waiting, but no timer is set (deadlock)");
    }
    const s = state as { done: true; ok: true; value: T } | { done: true; ok: false; error: unknown };
    if (!s.ok) throw s.error;
    return s.value;
  }

  /** Fire every remaining timer, in order. Used after a run, so requests still in flight land. */
  async drain(maxEvents = 10_000): Promise<void> {
    const start = this.events;
    await settle();
    while (this.fireNext()) {
      await settle();
      if (this.events - start >= maxEvents) throw new Error(`SimClock: drain gave up after ${maxEvents} timer events`);
    }
  }
}
