import type { ManualProviderCredit, ProviderAccounts, TavilyAccountUsage, TavilyUsageScope } from '../shared/budget-report.js';
import type { Store } from './store.js';

const endpoint = 'https://api.tavily.com/usage';
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const operations = (value: Record<string, unknown>): TavilyUsageScope['operations'] => ({ search: number(value.search_usage), extract: number(value.extract_usage), crawl: number(value.crawl_usage), map: number(value.map_usage), research: number(value.research_usage) });

/** Explicit allowlist: provider responses may contain account identifiers and keys. */
export function parseTavilyUsage(value: unknown): Pick<TavilyAccountUsage, 'key' | 'account'> {
  const root = object(value), key = object(root.key), account = object(root.account);
  if (!Object.keys(key).length || !Object.keys(account).length || number(key.usage) === null || number(account.plan_usage) === null) throw new Error('Tavily returned an unsupported usage response.');
  return {
    key: { usage: number(key.usage), limit: number(key.limit), operations: operations(key) },
    account: { plan: typeof account.current_plan === 'string' ? account.current_plan.slice(0, 100) : null, planUsage: number(account.plan_usage), planLimit: number(account.plan_limit), paygoUsage: number(account.paygo_usage), paygoLimit: number(account.paygo_limit), operations: operations(account) },
  };
}

/** Account-wide provider quantities, never project attribution or a USD balance.
 * Only a successful authenticated refresh advances fetchedAt. Failures retain the
 * last good snapshot; concurrent reads coalesce and retry at most once per minute.
 */
export class ProviderUsage {
  private readonly configuredKey?: string;
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;
  private readonly enabled: boolean;
  private snapshot: TavilyAccountUsage = { status: 'unconfigured', fetchedAt: null, attemptedAt: null, error: null, key: null, account: null };
  private pending?: Promise<void>;
  private lastAttempt = -Infinity;
  constructor(private readonly store?: Pick<Store, 'record'>, options: { key?: string; fetch?: typeof fetch; now?: () => number; enabled?: boolean } = {}) {
    this.configuredKey = options.key;
    this.fetcher = options.fetch ?? fetch;
    this.clock = options.now ?? Date.now;
    // Reading the key's own usage is free and read-only, so it is on unless turned off.
    this.enabled = options.enabled ?? process.env.ROS_TAVILY_USAGE_SYNC !== '0';
  }
  // A key saved in the app after start-up is picked up on the next read.
  private get key() { return this.configuredKey ?? process.env.TAVILY_API_KEY?.trim() ?? ''; }
  private async refresh(): Promise<void> {
    this.lastAttempt = this.clock();
    this.snapshot.attemptedAt = new Date(this.lastAttempt).toISOString();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await this.fetcher(endpoint, { method: 'GET', headers: { Authorization: `Bearer ${this.key}` }, redirect: 'error', signal: controller.signal });
      if (!response.ok) { void response.body?.cancel(); throw new Error(`Tavily usage returned HTTP ${response.status}.`); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Tavily returned an empty usage response.');
      const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 32_000) throw new Error('Tavily usage response exceeds 32 KB.'); chunks.push(chunk.value); } }
      finally { await reader.cancel().catch(() => {}); }
      const parsed = parseTavilyUsage(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      this.snapshot = { ...parsed, status: 'fresh', fetchedAt: new Date(this.clock()).toISOString(), attemptedAt: this.snapshot.attemptedAt, error: null };
    } catch (error) {
      // Never propagate an upstream response body, credential or transport URL.
      const message = error instanceof Error && /^(Tavily (usage returned HTTP \d+\.|returned an (empty|unsupported) usage response\.|usage response exceeds 32 KB\.))$/.test(error.message) ? error.message : 'Tavily usage refresh failed. Check the server connection or credentials.';
      this.snapshot = { ...this.snapshot, status: this.snapshot.fetchedAt ? 'stale' : 'error', error: message };
    } finally { clearTimeout(timer); }
  }
  async read(): Promise<ProviderAccounts> {
    if (!this.key) this.snapshot = { status: 'unconfigured', fetchedAt: null, attemptedAt: null, error: null, key: null, account: null };
    else if (!this.enabled) this.snapshot.status = 'disabled';
    if (this.key && this.enabled) {
      if (!this.pending && this.clock() - this.lastAttempt >= 60_000) this.pending = this.refresh().finally(() => { this.pending = undefined; });
      if (this.pending) await this.pending;
    }
    const saved = this.store?.record<ManualProviderCredit>('provider-account-report', 'nebius');
    const nebius = saved?.source === 'user-reported' && number(saved.amountUsd) !== null && /^\d{4}-\d{2}-\d{2}$/.test(saved.reportedOn)
      ? { amountUsd: saved.amountUsd, approximate: saved.approximate === true, source: 'user-reported' as const, reportedOn: saved.reportedOn, observedAt: typeof saved.observedAt === 'string' && Number.isFinite(Date.parse(saved.observedAt)) ? saved.observedAt : null } : null;
    return { tavily: structuredClone(this.snapshot), nebius };
  }
}
