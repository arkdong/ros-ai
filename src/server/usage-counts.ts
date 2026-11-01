import type { Express } from 'express';
import { z } from 'zod';
import { USAGE_KEYS, type UsageCounts as DayCounts, type UsageCountsStatus } from '../shared/usage-counts.js';
import type { CloudAccount } from './cloud-account.js';
import type { Store } from './store.js';

const DAY = 86_400_000;
const EVERY = 6 * 60 * 60_000;
type Saved = { on?: boolean; sentThrough?: string; sentAt?: string };
const utcDay = (at: Date) => at.toISOString().slice(0, 10);
const anything = (counts: DayCounts) => USAGE_KEYS.some(key => (counts[key] ?? 0) > 0);

/** Sends the day-by-day usage counts the store keeps (Store.countUsage: projects made, sources added, messages to agents,
 * Python runs, reports) to ros.ai cloud as the signed-in person, a few times a day, so its launch numbers can show who
 * is active, the activation funnel and retention. Numbers only: no names, titles, content, files or addresses. On by
 * default, with a switch in Settings › General; signed out, or with the switch off, nothing leaves this computer.
 * Each send repeats the days since the last one, the last of which may have been only part done, and ros.ai cloud keeps
 * a day's latest totals, so sending twice changes nothing. */
export class UsageCounts {
  private timer?: NodeJS.Timeout;
  private sending?: Promise<void>;
  constructor(private readonly store: Store, private readonly cloud: CloudAccount | undefined, private readonly version?: string) {}
  private saved(): Saved { return this.store.globalRecord<Saved>('usage-settings', 'settings') ?? {}; }
  private save(change: Saved) { this.store.saveGlobalRecord('usage-settings', 'settings', { ...this.saved(), ...change }); }
  get on() { return this.saved().on !== false; }
  status(now = new Date()): UsageCountsStatus {
    const today = this.store.usageDays().find(item => item.day === utcDay(now))?.counts ?? {}, { sentAt } = this.saved();
    return { on: this.on, available: Boolean(this.cloud?.available), signedIn: Boolean(this.cloud?.signedIn), ...(sentAt ? { sentAt } : {}), today };
  }
  setOn(on: boolean): UsageCountsStatus {
    this.save({ on });
    if (on) void this.send().catch(() => undefined);
    return this.status();
  }
  /** The days to send now: those since the last send (that day again, since it may have gone part done), at most 30 back. */
  pending(now = new Date()) {
    const today = utcDay(now), oldest = utcDay(new Date(now.getTime() - 30 * DAY)), since = this.saved().sentThrough;
    const from = since && since > oldest ? since : oldest;
    return this.store.usageDays().filter(item => item.day >= from && item.day <= today && anything(item.counts)).slice(-31)
      .map(item => ({ day: item.day, counts: Object.fromEntries(USAGE_KEYS.flatMap(key => item.counts[key] ? [[key, Math.min(100_000, Math.floor(item.counts[key]!))]] : [])) }));
  }
  /** One send, if the switch is on and someone is signed in; a send already under way is joined, not repeated. */
  send(now = new Date()): Promise<void> {
    if (!this.on || !this.cloud?.signedIn) return Promise.resolve();
    this.sending ??= (async () => {
      const days = this.pending(now);
      if (days.length && !await this.cloud!.sendUsage({ days, ...(this.version ? { version: this.version } : {}) })) return;
      this.save({ sentThrough: utcDay(now), ...(days.length ? { sentAt: now.toISOString() } : {}) });
    })().finally(() => { this.sending = undefined; });
    return this.sending;
  }
  /** A first send a minute after start, then every six hours. A failed send waits for the next. */
  start() {
    const run = () => { void this.send().catch(error => console.warn('usage counts:', error instanceof Error ? error.message : error)); };
    setTimeout(run, 60_000).unref();
    this.timer = setInterval(run, EVERY); this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}

export function attachUsageCountRoutes(app: Express, counts: UsageCounts) {
  app.get('/api/usage-counts', (_req, res) => { res.json(counts.status()); });
  app.put('/api/usage-counts', (req, res) => { res.json(counts.setOn(z.object({ on: z.boolean() }).strict().parse(req.body).on)); });
}
