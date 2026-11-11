// Time for the rig logic. The app uses the real clock; the bench uses a virtual one so the 30 scenarios
// run in well under a second and always the same way. Times are seconds.

export type Cancel = () => void;

export interface Clock {
  /** Seconds since some fixed point. Only differences matter. */
  now(): number;
  /** Runs fn after `seconds` (0 = as soon as the current work is done). */
  after(seconds: number, fn: () => void): Cancel;
  /** Wall-clock milliseconds, for log time stamps and the rig's clock sync. */
  wallMs(): number;
}

export const DISTANT_PAST = -Infinity;

export class RealClock implements Clock {
  now(): number { return performance.now() / 1000; }
  after(seconds: number, fn: () => void): Cancel {
    const id = setTimeout(fn, Math.max(0, seconds * 1000));
    return () => clearTimeout(id);
  }
  wallMs(): number { return Date.now(); }
}

/** A clock that only moves when told to, running due work in time order (ties in the order scheduled). */
export class VirtualClock implements Clock {
  private t = 0;
  private seq = 0;
  private jobs: { at: number; seq: number; fn: () => void; dead: boolean }[] = [];
  constructor(private readonly startWallMs = Date.UTC(2026, 10, 11, 12, 0, 0)) {}

  now(): number { return this.t; }
  wallMs(): number { return this.startWallMs + this.t * 1000; }

  after(seconds: number, fn: () => void): Cancel {
    const job = { at: this.t + Math.max(0, seconds), seq: this.seq++, fn, dead: false };
    this.jobs.push(job);
    return () => { job.dead = true; };
  }

  /** Runs everything due up to `until` (seconds), or until stop() returns true. */
  runUntil(until: number, stop: () => boolean = () => false): void {
    while (!stop()) {
      let best = -1;
      for (let i = 0; i < this.jobs.length; i++) {
        const j = this.jobs[i];
        if (j.dead) continue;
        if (best < 0 || j.at < this.jobs[best].at || (j.at === this.jobs[best].at && j.seq < this.jobs[best].seq)) best = i;
      }
      if (best < 0 || this.jobs[best].at > until) break;
      const job = this.jobs.splice(best, 1)[0];
      this.t = Math.max(this.t, job.at);
      job.fn();
      if (this.jobs.length > 5000) this.jobs = this.jobs.filter(j => !j.dead);
    }
    if (!stop()) this.t = Math.max(this.t, until);
  }
}
