import { constants, closeSync, existsSync, fstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import { StoreError, type Store } from './store.js';
import type { AssistantService } from './assistant.js';
import type { PluginTokens } from './plugins.js';
import type { AppId, RemoteApps } from './remote-apps.js';
import type { ToolCredentials } from './tool-credentials.js';
import type { GoogleDriveConnection } from './google-drive.js';
import type { Papers } from './papers.js';
import type { BrowserService } from './browser.js';
import { PLUGINS, type PluginId, type TokenPluginId } from '../shared/plugins.js';
import type { CredentialProvider } from '../shared/tool-connections.js';
import type { SearchServiceStatus } from '../shared/search.js';
import { NOT_NOW_DAYS, suggestionConnect, type PluginReadiness, type SuggestionStatus } from '../shared/plugin-hints.js';

export const pluginIdSchema = z.enum(PLUGINS.map(plugin => plugin.id) as [PluginId, ...PluginId[]]);
const silenceSchema = z.object({ pluginId: pluginIdSchema, projectId: z.string().min(1).max(200).nullable(), until: z.iso.datetime().nullable(), at: z.iso.datetime() }).strict();
const savedSchema = z.object({ version: z.literal(1), enabled: z.boolean(), silenced: z.array(silenceSchema).max(1000) }).strict();
type Saved = z.infer<typeof savedSchema>;
const DAY = 24 * 60 * 60 * 1000;

/** Whether ros.ai suggests plugins in conversations, and the plugins the person put off or declined. One owner-only file
 * in the data folder; nothing in it leaves this computer. */
export class PluginSuggestions {
  private readonly file: string;
  private saved: Saved = { version: 1, enabled: true, silenced: [] };
  constructor(dataDir: string, private readonly clock: () => number = Date.now) {
    this.file = join(dataDir, 'suggestions.json');
    if (!existsSync(this.file)) return;
    const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 400_000 || (info.mode & 0o077) !== 0) throw new Error('Invalid private suggestions file.');
      this.saved = savedSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
    } catch { throw new Error('Could not read the plugin suggestion settings. Ensure suggestions.json is valid and readable only by its owner.'); }
    finally { closeSync(fd); }
  }
  private persist(next: Saved) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw new StoreError('Could not save the plugin suggestion settings.', 500);
    }
    this.saved = next;
  }
  /** Silences still in force: Not now ends by itself after a week. */
  private active() { const now = this.clock(); return this.saved.silenced.filter(item => item.until === null || Date.parse(item.until) > now); }
  get enabled() { return this.saved.enabled; }
  status(plugins: SuggestionStatus['plugins'], projectTitle: (projectId: string) => string | null): SuggestionStatus {
    return { enabled: this.saved.enabled, plugins, silenced: this.active().map(item => ({ ...item, projectTitle: item.projectId ? projectTitle(item.projectId) : null })) };
  }
  setEnabled(supplied: unknown) {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(supplied);
    this.persist({ ...this.saved, enabled, silenced: this.active() });
  }
  /** Not now (a project): these plugins stay out of that project's suggestions for a week. Don't suggest again (no
   * project): out of every project until Undo, which also replaces any Not now for the plugin. */
  silence(pluginIds: PluginId[], projectId: string | null) {
    const now = this.clock(), at = new Date(now).toISOString(), until = projectId ? new Date(now + NOT_NOW_DAYS * DAY).toISOString() : null;
    const kept = this.active().filter(item => !(pluginIds.includes(item.pluginId) && (projectId === null || item.projectId === projectId)));
    this.persist({ ...this.saved, silenced: [...kept, ...pluginIds.map(pluginId => ({ pluginId, projectId, until, at }))] });
  }
  unsilence(pluginId: PluginId, projectId: string | null) {
    this.persist({ ...this.saved, silenced: this.active().filter(item => !(item.pluginId === pluginId && item.projectId === projectId)) });
  }
  silenced(pluginId: PluginId, projectId: string) { return this.active().some(item => item.pluginId === pluginId && (item.projectId === null || item.projectId === projectId)); }
}

/** search: the web search services, which Tavily and Exa answer with no key too, within their free limits. */
export type ReadinessSources = { credentials: ToolCredentials; googleDrive: GoogleDriveConnection; plugins?: PluginTokens; apps?: RemoteApps; papers?: Papers; browser?: BrowserService; search?: () => SearchServiceStatus };
/** Whether agents can use each plugin now, read the way the Plugins page reads it. */
export function pluginReadiness(sources: ReadinessSources): Partial<Record<PluginId, PluginReadiness>> {
  const drive = sources.googleDrive.status(), papers = sources.papers?.status().sources ?? [], browser = sources.browser?.status();
  const readiness: Partial<Record<PluginId, PluginReadiness>> = {};
  for (const plugin of PLUGINS) {
    const id = plugin.id;
    if (!suggestionConnect(plugin)) continue;
    if (id === 'google-drive' || id === 'google-sheets' || id === 'google-docs') readiness[id] = drive.connected ? 'ready' : drive.state === 'reconnect-required' ? 'failed' : 'missing';
    else if (plugin.connect === 'public') readiness[id] = papers.find(item => item.id === id)?.agents ? 'ready' : 'off';
    else if (plugin.connect === 'browser') readiness[id] = browser?.agents && browser.engine ? 'ready' : 'off';
    else if (plugin.connect === 'key') {
      const key = sources.credentials.status(id as CredentialProvider), free = sources.search?.().services.find(item => item.id === id)?.free === true;
      readiness[id] = free ? 'ready' : !key.configured ? 'missing' : key.verified === false ? 'failed' : 'ready';
    } else {
      const app = plugin.connect === 'sign-in' || plugin.connect === 'desktop' || plugin.signIn ? sources.apps?.status(id as AppId) : undefined;
      const token = plugin.connect === 'token' ? sources.plugins?.status(id as TokenPluginId) : undefined;
      readiness[id] = app?.connected || (token?.configured && token.verified !== false) ? 'ready' : token?.configured ? 'failed' : 'missing';
    }
  }
  return readiness;
}

export function attachSuggestionRoutes(app: Express, suggestions: PluginSuggestions, options: { store: Store; readiness: () => Partial<Record<PluginId, PluginReadiness>>; assistant?: AssistantService }) {
  const title = (projectId: string) => { try { return options.store.getProject(projectId).title; } catch { return null; } };
  const status = () => suggestions.status(options.readiness(), title);
  app.get('/api/suggestions', (_req, res) => res.json(status()));
  app.put('/api/suggestions', (req, res) => { suggestions.setEnabled(req.body); res.json(status()); });
  // The person's answer to a chip or a card: later (Not now), never (Don't suggest this plugin again), done (carried on after connecting).
  app.post('/api/suggestions/decide', (req, res) => {
    const body = z.object({ decision: z.enum(['later', 'never', 'done']), projectId: z.string().min(1).max(200), turnId: z.string().min(1).max(200).optional(), pluginId: pluginIdSchema.optional() }).strict().parse(req.body);
    options.store.getProject(body.projectId);
    const card = body.turnId ? options.assistant?.suggestion(body.projectId, body.turnId) : undefined;
    if (body.turnId && !card) throw new StoreError('This reply has no plugin suggestion.', 404);
    if (body.decision === 'later') {
      const ids = card ? card.plugins.map(item => item.id) : body.pluginId ? [body.pluginId] : [];
      if (!ids.length) throw new StoreError('Say which plugin to put off.');
      suggestions.silence(ids, body.projectId);
      if (card) options.assistant!.closeSuggestion(body.projectId, body.turnId!, 'later');
    } else if (body.decision === 'never') {
      if (!body.pluginId) throw new StoreError('Say which plugin not to suggest again.');
      suggestions.silence([body.pluginId], null);
      // The card stays while it still offers another plugin.
      if (card && card.plugins.every(item => suggestions.silenced(item.id, body.projectId))) options.assistant!.closeSuggestion(body.projectId, body.turnId!, 'never');
    } else {
      if (!card) throw new StoreError('Say which reply carried on.');
      options.assistant!.closeSuggestion(body.projectId, body.turnId!, 'done');
    }
    res.json(status());
  });
  // Undo in Settings › General: a project's Not now, or Don't suggest again when no project is given.
  app.delete('/api/suggestions/silenced/:pluginId', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : null;
    suggestions.unsilence(pluginIdSchema.parse(req.params.pluginId), projectId);
    res.json(status());
  });
}
