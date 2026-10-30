import type { Express } from 'express';
import type { MetricPoint, MetricRead, MetricValue, MetricView } from '../shared/types.js';
import type { ProjectCache } from './project-cache.js';
import { metricViewSchema, Store, StoreError } from './store.js';

/** A source is read again only after this long, however often the card asks. */
const FRESH_MS = 10 * 60_000;
/** One point an hour is enough for a trend; a later read in the same hour replaces that hour's point. */
const POINT_MS = 60 * 60_000;
/** About three months of hourly points. */
const MAX_POINTS = 2_200;
const GITHUB = 'https://api.github.com';

type Read = Omit<MetricRead, 'history'>;
type Saved = { read: Read; history: MetricPoint[] };
type Options = { githubToken?: () => string | undefined; fetch?: typeof fetch };

/** "arkdong/ros-ai", a github.com link to it, or a git remote, as owner/name. */
export function githubRepo(text: string) {
  const trimmed = text.trim().replace(/\.git$/u, '').replace(/\/+$/u, '');
  const match = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})(?:\/.*)?$/u.exec(trimmed);
  if (!match) throw new StoreError('Give a GitHub repository as owner/name, for example arkdong/ros-ai, or its link.', 400);
  return `${match[1]}/${match[2]}`;
}

/** Metric blocks: launch numbers read live from a service, with a trend kept in the project folder's cache.
 * ros.ai only reads, with the sign-in the person already gave it; nothing about the person is sent anywhere. */
export class MetricViews {
  private readonly reads = new Map<string, { at: number; saved: Saved }>();
  constructor(private readonly cache?: ProjectCache, private readonly options: Options = {}) {}

  async read(view: MetricView, refresh = false, projectId?: string): Promise<MetricRead> {
    const key = `${projectId ?? ''}:${view.source}:${view.repo.toLowerCase()}`;
    let held = this.reads.get(key);
    if (!held && projectId) {
      const saved = this.cache?.read<Saved>(projectId, 'metric', key);
      if (saved) this.reads.set(key, held = { at: Date.parse(saved.read.fetchedAt) || 0, saved });
    }
    if (held && !refresh && Date.now() - held.at < FRESH_MS) return { ...held.saved.read, history: held.saved.history };
    try {
      const read = await this.fresh(view), saved = { read, history: addPoint(held?.saved.history ?? [], read) };
      this.reads.set(key, { at: Date.now(), saved });
      if (projectId) this.cache?.write(projectId, 'metric', key, saved);
      return { ...read, history: saved.history };
    } catch (error) {
      if (!held) throw error;
      return { ...held.saved.read, history: held.saved.history, notice: `${error instanceof Error ? error.message : 'The service did not answer'} Showing the earlier read.` };
    }
  }

  private fresh(view: MetricView): Promise<Read> {
    return this.github(view.repo);
  }

  private async ask<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
    const token = this.options.githubToken?.();
    const response = await (this.options.fetch ?? fetch)(`${GITHUB}${path}`, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ros.ai', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(20_000) });
    if (response.ok) return { ok: true, data: await response.json() as T };
    if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) throw new StoreError(token ? 'GitHub has rate-limited this sign-in for now; try again in a few minutes.' : 'GitHub allows 60 lookups an hour without an account, and they are used up. Connect GitHub on the Plugins page to raise the limit.', 429);
    return { ok: false, status: response.status };
  }

  private async github(repo: string): Promise<Read> {
    const about = await this.ask<{ full_name: string; html_url: string; stargazers_count: number; forks_count: number; subscribers_count: number }>(`/repos/${repo}`);
    if (!about.ok) throw new StoreError(about.status === 404 ? `GitHub has no repository ${repo} that this computer can see. A private one needs GitHub connected on the Plugins page.` : `GitHub answered ${about.status} for ${repo}.`, about.status === 404 ? 404 : 502);
    const { full_name: name, html_url: link } = about.data;
    // Release downloads are the sum over every asset of every release; three pages cover 300 releases.
    let downloads: number | null = 0;
    for (let page = 1; page <= 3; page++) {
      const releases = await this.ask<{ assets: { download_count: number }[] }[]>(`/repos/${name}/releases?per_page=100&page=${page}`);
      if (!releases.ok) { downloads = null; break; }
      downloads += releases.data.reduce((sum, release) => sum + release.assets.reduce((total, asset) => total + asset.download_count, 0), 0);
      if (releases.data.length < 100) break;
    }
    // Traffic is the last 14 days and needs a sign-in with push access to the repository.
    const [views, clones] = await Promise.all([this.ask<{ count: number; uniques: number }>(`/repos/${name}/traffic/views`), this.ask<{ count: number; uniques: number }>(`/repos/${name}/traffic/clones`)]);
    const traffic = 'Needs GitHub connected on the Plugins page, with push access to this repository.';
    const values: MetricValue[] = [
      { key: 'stars', label: 'Stars', value: about.data.stargazers_count },
      { key: 'downloads', label: 'Release downloads', value: downloads, ...(downloads === null ? { note: 'GitHub did not list the releases.' } : {}) },
      { key: 'visitors', label: 'Visitors, 14 days', value: views.ok ? views.data.uniques : null, ...(views.ok ? {} : { note: traffic }) },
      { key: 'views', label: 'Page views, 14 days', value: views.ok ? views.data.count : null, ...(views.ok ? {} : { note: traffic }) },
      { key: 'cloners', label: 'Cloners, 14 days', value: clones.ok ? clones.data.uniques : null, ...(clones.ok ? {} : { note: traffic }) },
      { key: 'forks', label: 'Forks', value: about.data.forks_count },
      { key: 'watchers', label: 'Watchers', value: about.data.subscribers_count },
    ];
    return { source: 'github', title: name, link, values, fetchedAt: new Date().toISOString() };
  }
}

function addPoint(history: MetricPoint[], read: Read): MetricPoint[] {
  const values = Object.fromEntries(read.values.flatMap(item => item.value === null ? [] : [[item.key, item.value]]));
  const last = history.at(-1), point = { at: read.fetchedAt, values };
  const kept = last && Date.parse(read.fetchedAt) - Date.parse(last.at) < POINT_MS ? history.slice(0, -1) : history;
  return [...kept, point].slice(-MAX_POINTS);
}

/** What an agent reads for a Metric block: each number, and how it moved over the last day and week. */
export function metricSummary(read: MetricRead) {
  const before = (ms: number) => [...read.history].reverse().find(point => Date.parse(read.fetchedAt) - Date.parse(point.at) >= ms);
  const day = before(20 * 60 * 60_000), week = before(6.5 * 24 * 60 * 60_000);
  const change = (key: string, value: number, point?: MetricPoint) => point && point.values[key] !== undefined ? value - point.values[key] : undefined;
  return { source: read.source, title: read.title, link: read.link, readAt: read.fetchedAt, values: read.values.map(item => item.value === null ? { label: item.label, value: null, note: item.note } : { label: item.label, value: item.value, ...(change(item.key, item.value, day) !== undefined ? { changeOverDay: change(item.key, item.value, day) } : {}), ...(change(item.key, item.value, week) !== undefined ? { changeOverWeek: change(item.key, item.value, week) } : {}) }) };
}

export function attachMetricRoutes(app: Express, store: Store, views: MetricViews) {
  app.get('/api/projects/:id/nodes/:nodeId/metric', async (req, res) => {
    const node = store.getProject(String(req.params.id)).canvas.nodes.find(item => item.id === String(req.params.nodeId));
    if (!node?.metric) throw new StoreError('This block shows no metrics.', 404);
    res.json(await views.read(node.metric, req.query.refresh === '1', String(req.params.id)));
  });
  // Reads the source once before a person adds the block, so a wrong repository is caught first.
  app.post('/api/metric/preview', async (req, res) => {
    const body = req.body as { source?: unknown; repo?: unknown };
    const view = metricViewSchema.parse({ source: body.source, repo: githubRepo(String(body.repo ?? '')) });
    const read = await views.read(view, true);
    res.json({ view: { ...view, repo: read.title }, read });
  });
}
