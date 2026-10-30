import type { Express } from 'express';
import type { MetricPoint, MetricRead, MetricValue, MetricView } from '../shared/types.js';
import type { ProjectCache } from './project-cache.js';
import { metricViewSchema, Store, StoreError } from './store.js';
import { RAILWAY_API, UMAMI_API } from './plugins.js';

/** A source is read again only after this long, however often the card asks. */
const FRESH_MS = 10 * 60_000;
/** One point an hour is enough for a trend; a later read in the same hour replaces that hour's point. */
const POINT_MS = 60 * 60_000;
/** About three months of hourly points. */
const MAX_POINTS = 2_200;
const GITHUB = 'https://api.github.com';

type Read = Omit<MetricRead, 'history'>;
type Saved = { read: Read; history: MetricPoint[] };
type Options = { githubToken?: () => string | undefined; umamiKey?: () => string | undefined; railwayToken?: () => string | undefined; cloud?: { url: string; stats: () => Promise<Record<string, unknown>> }; fetch?: typeof fetch };
type Answer<T> = { ok: true; data: T } | { ok: false; status: number };

/** "arkdong/ros-ai", a github.com link to it, or a git remote, as owner/name. */
export function githubRepo(text: string) {
  const trimmed = text.trim().replace(/\.git$/u, '').replace(/\/+$/u, '');
  const match = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})(?:\/.*)?$/u.exec(trimmed);
  if (!match) throw new StoreError('Give a GitHub repository as owner/name, for example arkdong/ros-ai, or its link.', 400);
  return `${match[1]}/${match[2]}`;
}
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
/** An id pasted alone or inside a link: Umami's /websites/<id>/…, Railway's /project/<id>/…. */
function idIn(text: string, what: string) {
  const match = UUID.exec(text.trim());
  if (!match) throw new StoreError(`Give the ${what}, or a link that holds it.`, 400);
  return match[0].toLowerCase();
}
/** The view a person typed into the Add block window, checked. */
export function metricViewFrom(body: { source?: unknown; repo?: unknown; website?: unknown; project?: unknown }): MetricView {
  switch (body.source) {
    case 'cloud': return { source: 'cloud' };
    case 'umami': return metricViewSchema.parse({ source: 'umami', website: idIn(String(body.website ?? ''), 'Umami website ID (Websites › Edit › Website ID)') }) as MetricView;
    case 'railway': return metricViewSchema.parse({ source: 'railway', project: idIn(String(body.project ?? ''), 'Railway project ID (Project › Settings › Project ID)') }) as MetricView;
    default: return metricViewSchema.parse({ source: 'github', repo: githubRepo(String(body.repo ?? '')) }) as MetricView;
  }
}
const viewKey = (view: MetricView) => view.source === 'github' ? `github:${view.repo.toLowerCase()}` : view.source === 'umami' ? `umami:${view.website}` : view.source === 'railway' ? `railway:${view.project}` : 'cloud';
const DAY = 24 * 60 * 60_000;
const ago = (at: string) => { const minutes = Math.round((Date.now() - Date.parse(at)) / 60_000); return minutes < 60 ? `${Math.max(1, minutes)} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`; };

/** Metric blocks: launch numbers read live from a service, with a trend kept in the project folder's cache.
 * ros.ai only reads, with the sign-in or key the person already gave it; nothing about the person is sent anywhere. */
export class MetricViews {
  private readonly reads = new Map<string, { at: number; saved: Saved }>();
  constructor(private readonly cache?: ProjectCache, private readonly options: Options = {}) {}

  async read(view: MetricView, refresh = false, projectId?: string): Promise<MetricRead> {
    const key = `${projectId ?? ''}:${viewKey(view)}`;
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
      return { ...held.saved.read, history: held.saved.history, notice: `${error instanceof Error ? error.message : 'The service did not answer.'} Showing the earlier read.` };
    }
  }

  private fresh(view: MetricView): Promise<Read> {
    switch (view.source) {
      case 'github': return this.github(view.repo);
      case 'cloud': return this.cloud();
      case 'umami': return this.umami(view.website);
      case 'railway': return this.railway(view.project);
    }
  }

  private async request<T>(url: string, init: RequestInit): Promise<Answer<T> & { headers?: Headers }> {
    const response = await (this.options.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(20_000) });
    return response.ok ? { ok: true, data: await response.json() as T, headers: response.headers } : { ok: false, status: response.status, headers: response.headers };
  }

  private async ask<T>(path: string): Promise<Answer<T>> {
    const token = this.options.githubToken?.();
    const answer = await this.request<T>(`${GITHUB}${path}`, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ros.ai', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (!answer.ok && (answer.status === 429 || (answer.status === 403 && answer.headers?.get('x-ratelimit-remaining') === '0'))) throw new StoreError(token ? 'GitHub has rate-limited this sign-in for now; try again in a few minutes.' : 'GitHub allows 60 lookups an hour without an account, and they are used up. Connect GitHub on the Plugins page to raise the limit.', 429);
    return answer;
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

  /** ros.ai cloud's own counts, read with the app's ros.ai cloud sign-in (see ros-ai-cloud src/stats.ts). */
  private async cloud(): Promise<Read> {
    if (!this.options.cloud) throw new StoreError('ros.ai cloud is off in this copy of ros.ai.', 404);
    const stats = await this.options.cloud.stats(), number = (key: string) => typeof stats[key] === 'number' ? stats[key] as number : null;
    const value = (key: string, label: string): MetricValue => { const found = number(key); return { key, label, value: found, ...(found === null ? { note: 'ros.ai cloud did not give this number.' } : {}) }; };
    const values = [
      value('users', 'Accounts'), value('signups_today', 'Sign-ups today'), value('downloads', 'Downloads'), value('active_week', 'Hosted ROS users, 7 days'),
      value('signups_week', 'Sign-ups, 7 days'), value('downloads_week', 'Downloads, 7 days'), value('requests_week', 'Hosted ROS requests, 7 days'),
      value('cost_week', 'Hosted ROS cost, 7 days (US$)'), value('feedback', 'Feedback notes'), value('feedback_week', 'Feedback notes, 7 days'),
    ];
    return { source: 'cloud', title: 'ros.ai cloud', link: this.options.cloud.url, values, fetchedAt: new Date().toISOString() };
  }

  private async umamiAsk<T>(path: string): Promise<Answer<T>> {
    const key = this.options.umamiKey?.();
    if (!key) throw new StoreError('Connect Umami on the Plugins page (Launch numbers) with an API key first.', 409);
    const answer = await this.request<T>(`${UMAMI_API}${path}`, { headers: { 'x-umami-api-key': key, Accept: 'application/json' } });
    if (!answer.ok && (answer.status === 401 || answer.status === 403)) throw new StoreError('Umami did not accept the API key, or it cannot see this website.', 403);
    return answer;
  }

  /** An Umami Cloud website: visitors today and over 7 days, page views, visits, who is on it now, and the clicks the site tracks. */
  private async umami(website: string): Promise<Read> {
    const about = await this.umamiAsk<{ name?: string; domain?: string }>(`/websites/${website}`);
    if (!about.ok) throw new StoreError(about.status === 404 ? 'Umami has no website with that ID for this key.' : `Umami answered ${about.status}.`, about.status === 404 ? 404 : 502);
    const now = Date.now(), today = new Date(now); today.setHours(0, 0, 0, 0);
    const range = (from: number) => `startAt=${from}&endAt=${now}`;
    // Umami 2 answers { visitors: { value, prev } }; later versions answer plain numbers.
    type Stats = Record<string, number | { value?: number } | unknown>;
    const count = (stats: Answer<Stats>, key: string) => { if (!stats.ok) return null; const found = stats.data[key]; return typeof found === 'number' ? found : typeof (found as { value?: unknown })?.value === 'number' ? (found as { value: number }).value : null; };
    const [day, week, active, events] = await Promise.all([
      this.umamiAsk<Stats>(`/websites/${website}/stats?${range(today.getTime())}`),
      this.umamiAsk<Stats>(`/websites/${website}/stats?${range(now - 7 * DAY)}`),
      this.umamiAsk<Record<string, unknown> | { x?: number }[]>(`/websites/${website}/active`),
      this.umamiAsk<{ x: string; y: number }[]>(`/websites/${website}/metrics?${range(now - 7 * DAY)}&type=event`),
    ]);
    const online = !active.ok ? null : Array.isArray(active.data) ? Number(active.data[0]?.x ?? 0) : typeof active.data.visitors === 'number' ? active.data.visitors : typeof active.data.x === 'number' ? active.data.x : null;
    const missing = 'Umami did not give this number.';
    const value = (key: string, label: string, found: number | null): MetricValue => ({ key, label, value: found, ...(found === null ? { note: missing } : {}) });
    const named: Record<string, string> = { get_click: '“Get ros.ai” clicks', download_click: 'Download clicks', github_click: 'GitHub clicks', try_demo_click: 'Demo clicks' };
    const clicks = events.ok ? [...events.data].sort((a, b) => b.y - a.y).slice(0, 6).map(item => value(`event:${item.x}`.slice(0, 80), `${named[item.x] ?? item.x}, 7 days`, item.y)) : [];
    const values = [
      value('visitors_today', 'Visitors today', count(day, 'visitors')), value('visitors_week', 'Visitors, 7 days', count(week, 'visitors')),
      ...clicks.slice(0, 1), value('online', 'On the site now', online),
      value('pageviews_week', 'Page views, 7 days', count(week, 'pageviews')), value('visits_week', 'Visits, 7 days', count(week, 'visits')), ...clicks.slice(1),
    ];
    return { source: 'umami', title: about.data.domain || about.data.name || 'Umami website', link: `https://cloud.umami.is/websites/${website}`, values, fetchedAt: new Date().toISOString() };
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const token = this.options.railwayToken?.();
    if (!token) throw new StoreError('Connect Railway on the Plugins page (Launch numbers) with an account token first.', 409);
    const answer = await this.request<{ data?: T; errors?: { message?: string }[] }>(RAILWAY_API, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables }) });
    if (!answer.ok) throw new StoreError(answer.status === 401 || answer.status === 403 ? 'Railway did not accept the token.' : `Railway answered ${answer.status}.`, answer.status === 401 || answer.status === 403 ? 403 : 502);
    if (!answer.data.data) throw new StoreError(`Railway: ${answer.data.errors?.[0]?.message?.slice(0, 200) ?? 'no answer'}`, 502);
    return answer.data.data;
  }

  /** A Railway project: each service's last deploy and how many are up. Only reads; it never deploys. */
  private async railway(project: string): Promise<Read> {
    const found = await this.graphql<{ project: { name: string; services: { edges: { node: { id: string; name: string } }[] } } | null }>('query($id: String!) { project(id: $id) { name services { edges { node { id name } } } } }', { id: project });
    if (!found.project) throw new StoreError('Railway has no project with that ID for this token.', 404);
    const services = found.project.services.edges.map(edge => edge.node).filter(service => UUID.test(service.id)).slice(0, 20);
    type Last = { edges: { node: { status: string; createdAt: string } }[] };
    // One request: the latest deployment of every service, each under its own alias.
    const latest = services.length ? await this.graphql<Record<string, Last>>(`query($p: String!) { ${services.map((service, index) => `s${index}: deployments(first: 1, input: { projectId: $p, serviceId: "${service.id}" }) { edges { node { status createdAt } } }`).join(' ')} }`, { p: project }) : {};
    const words: Record<string, string> = { SUCCESS: 'Online', FAILED: 'Failed', CRASHED: 'Crashed', BUILDING: 'Building', DEPLOYING: 'Deploying', INITIALIZING: 'Starting', QUEUED: 'Queued', WAITING: 'Waiting', SLEEPING: 'Sleeping', REMOVED: 'Removed', SKIPPED: 'Skipped', NEEDS_APPROVAL: 'Needs approval' };
    const rows: MetricValue[] = services.map((service, index) => {
      const deploy = latest[`s${index}`]?.edges[0]?.node;
      return { key: `service:${service.id}`, label: service.name.slice(0, 80), value: null, text: deploy ? `${words[deploy.status] ?? deploy.status} · deployed ${ago(deploy.createdAt)}` : 'Never deployed', ...(deploy ? { tone: deploy.status === 'SUCCESS' ? 'good' as const : deploy.status === 'FAILED' || deploy.status === 'CRASHED' ? 'bad' as const : undefined } : {}) };
    });
    const up = rows.filter(row => row.tone === 'good').length;
    return { source: 'railway', title: found.project.name, link: `https://railway.com/project/${project}`, values: [{ key: 'up', label: `Services online (of ${rows.length})`, value: up }, ...rows], fetchedAt: new Date().toISOString() };
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
  return { source: read.source, title: read.title, link: read.link, readAt: read.fetchedAt, values: read.values.map(item => item.text ? { label: item.label, state: item.text } : item.value === null ? { label: item.label, value: null, note: item.note } : { label: item.label, value: item.value, ...(change(item.key, item.value, day) !== undefined ? { changeOverDay: change(item.key, item.value, day) } : {}), ...(change(item.key, item.value, week) !== undefined ? { changeOverWeek: change(item.key, item.value, week) } : {}) }) };
}

export function attachMetricRoutes(app: Express, store: Store, views: MetricViews) {
  app.get('/api/projects/:id/nodes/:nodeId/metric', async (req, res) => {
    const node = store.getProject(String(req.params.id)).canvas.nodes.find(item => item.id === String(req.params.nodeId));
    if (!node?.metric) throw new StoreError('This block shows no metrics.', 404);
    res.json(await views.read(node.metric, req.query.refresh === '1', String(req.params.id)));
  });
  // Reads the source once before a person adds the block, so a wrong repository, ID or key is caught first.
  app.post('/api/metric/preview', async (req, res) => {
    const view = metricViewFrom(req.body as Record<string, unknown>), read = await views.read(view, true);
    res.json({ view: view.source === 'github' ? { ...view, repo: read.title } : view, read });
  });
}
