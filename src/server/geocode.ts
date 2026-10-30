import { StoreError } from './store.js';

/** Places looked up by name or address, for Map block pins: OpenStreetMap's Nominatim, which needs no key. Its usage
 * policy asks for at most one request a second, a User-Agent that names the app, and no search as you type, so
 * lookups wait their turn, answers are kept for the session, and the Map block searches only when asked. */

export type FoundPlace = { name: string; address: string; lat: number; lng: number; osm?: string };

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const HEADERS = { 'User-Agent': 'ros.ai (https://ros-ai.io; hello@ros-ai.io)', Accept: 'application/json', 'Accept-Language': 'en' };
const GAP = 1_100, TIMEOUT = 15_000, KEPT = 500;
/** The most places one agent call looks up; each takes a second. */
export const MAX_LOOKUPS = 25;

type Answer = { name?: string; display_name?: string; lat?: string; lon?: string; osm_type?: string; osm_id?: number };

export class Geocoder {
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;
  private kept = new Map<string, FoundPlace[]>();
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly wait = (ms: number) => new Promise(done => setTimeout(done, ms))) {}

  /** Up to `limit` places that match, best first; none when nothing does. */
  async search(query: string, limit = 5, signal?: AbortSignal): Promise<FoundPlace[]> {
    const text = query.trim().replace(/\s+/gu, ' ').slice(0, 300), key = `${limit}:${text.toLowerCase()}`;
    if (!text) return [];
    const saved = this.kept.get(key);
    if (saved) return saved;
    const turn = this.queue.then(() => this.lookup(text, limit, signal));
    this.queue = turn.catch(() => undefined);
    const found = await turn;
    this.kept.set(key, found);
    if (this.kept.size > KEPT) this.kept.delete(this.kept.keys().next().value!);
    return found;
  }
  /** The best match, or undefined. */
  async first(query: string, signal?: AbortSignal): Promise<FoundPlace | undefined> { return (await this.search(query, 1, signal))[0]; }

  private async lookup(text: string, limit: number, signal?: AbortSignal): Promise<FoundPlace[]> {
    const since = Date.now() - this.last;
    if (since < GAP) await this.wait(GAP - since);
    if (signal?.aborted) throw new StoreError('The lookup was stopped.', 409);
    this.last = Date.now();
    const url = `${ENDPOINT}?${new URLSearchParams({ q: text, format: 'jsonv2', limit: String(Math.min(10, Math.max(1, limit))) })}`;
    let response: Response;
    try { response = await this.fetcher(url, { headers: HEADERS, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT) }); }
    catch { throw new StoreError('OpenStreetMap could not be reached to look up the place. Check the internet connection.', 502); }
    if (response.status === 429) throw new StoreError('OpenStreetMap asked ros.ai to slow down. Try again in a minute.', 429);
    if (!response.ok) throw new StoreError(`OpenStreetMap answered ${response.status} to the lookup.`, 502);
    const answers = await response.json().catch(() => []) as Answer[];
    return (Array.isArray(answers) ? answers : []).flatMap(answer => {
      const lat = Number(answer.lat), lng = Number(answer.lon), address = String(answer.display_name ?? '').slice(0, 300);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
      const name = String(answer.name || address.split(',')[0] || text).slice(0, 200);
      return [{ name, address, lat, lng, ...(answer.osm_type && answer.osm_id ? { osm: `https://www.openstreetmap.org/${answer.osm_type}/${answer.osm_id}` } : {}) }];
    });
  }
}
