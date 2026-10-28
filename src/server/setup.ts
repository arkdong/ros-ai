import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import type { OutsideAgents } from './outside-agents.js';
import type { InferenceConnections } from './inference-connections.js';
import type { ToolCredentials } from './tool-credentials.js';
import type { PluginTokens } from './plugins.js';
import type { CloudAccount } from './cloud-account.js';
import type { LocalRos } from './local-ros.js';
import { PLUGINS } from '../shared/plugins.js';
import { detectAgents, detectApps, detectDocker, detectModels, mac, ollamaDefaultContext, pretty, win, type Found } from './setup-detect.js';
import { SetupLinks, linkCommand } from './setup-links.js';
import type { AgentId, DetectedAgent, DetectedApp, DetectedKey, DetectedModel, LinkResult, ModelLinkResult, SetupLinkResponse, SetupResetPlan, SetupResetResponse, SetupStatus } from '../shared/setup.js';

/** First launch: what ros.ai found on this computer, the links it made for the person, and whether
 * the screen has been seen. Everything here is read from this computer and stays on it. */

const AGENTS = ['claude-code', 'codex', 'cursor', 'gemini-cli', 'pi', 'hermes'] as const;
const MODELS = ['ollama', 'lm-studio'] as const;
/** The context Ollama gives a model below 24 GB of graphics memory, and LM Studio's usual load: assumed while unknown. */
const LOCAL_DEFAULT_CONTEXT = 4096;
const agentLabels: Record<AgentId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', 'gemini-cli': 'Gemini CLI', pi: 'Pi', hermes: 'Hermes Agent' };
const keyLabels: Record<string, string> = { nebius: 'Nebius Token Factory key', claude: 'Claude API key', openai: 'OpenAI key', tavily: 'Tavily key', exa: 'Exa key', brave: 'Brave Search key' };
const lookedAt = ['the Applications folder', 'your PATH', 'the settings of Claude Code, Codex, Cursor, Gemini CLI, Pi and Hermes Agent (names only)', 'model servers on 127.0.0.1'];
type Scan = { at: string; agents: Found[]; models: Omit<DetectedModel, 'connectionId'>[]; apps: DetectedApp[]; docker: { found: boolean; running: boolean } };
/** localRos: the ROS download on this computer, which Reset onboarding can remove. */
type Deps = { dataDir: string; outside: OutsideAgents; inference: InferenceConnections; credentials: ToolCredentials; plugins: PluginTokens; cloud: CloudAccount; localRos?: Pick<LocalRos, 'status' | 'remove'> };

export class Setup {
  private readonly file: string;
  private readonly links: SetupLinks;
  private cache: { at: number; scan: Scan } | null = null;
  private scanning: Promise<Scan> | null = null;
  constructor(private readonly deps: Deps) {
    this.file = join(deps.dataDir, 'setup.json');
    this.links = new SetupLinks(deps.dataDir);
  }
  private seenAt(): string | null {
    try { const value = JSON.parse(readFileSync(this.file, 'utf8')) as { seenAt?: unknown }; return typeof value.seenAt === 'string' ? value.seenAt : null; } catch { return null; }
  }
  seen(value: boolean) {
    mkdirSync(this.deps.dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify({ seenAt: value ? new Date().toISOString() : null }), { mode: 0o600 });
  }
  private scan(rescan: boolean): Promise<Scan> {
    if (!rescan && this.cache && Date.now() - this.cache.at < 30_000) return Promise.resolve(this.cache.scan);
    if (!this.scanning) this.scanning = this.runScan().then(scan => { this.cache = { at: Date.now(), scan }; return scan; }).finally(() => { this.scanning = null; });
    return this.scanning;
  }
  private async runScan(): Promise<Scan> {
    const at = new Date().toISOString();
    if (process.env.ROS_NO_DETECT === '1') return { at, agents: [], models: [], apps: [], docker: { found: false, running: false } };
    const agents = detectAgents();
    const connected = new Set<string>(this.deps.plugins.statuses().filter(item => item.configured).map(item => item.id));
    const [models, apps, docker] = await Promise.all([detectModels(), detectApps(agents, connected), detectDocker()]);
    return { at, agents, models, apps, docker };
  }
  async status(rescan = false): Promise<SetupStatus> {
    const [scan, cloud] = await Promise.all([this.scan(rescan), this.deps.cloud.status()]);
    const seenAt = this.seenAt(), bridge = this.deps.outside.bridge;
    const agents: DetectedAgent[] = scan.agents.map(found => {
      const link = this.links.record(found.id), seen = this.deps.outside.seen(found.sessionLabel);
      const { binary, ...rest } = found;
      return { ...rest, linkable: found.method === 'file' || Boolean(binary), link, seenAt: seen?.lastAt ?? null, seenIn: seen?.projectTitle ?? null, command: linkCommand(found.id, bridge), target: pretty(found.target) };
    });
    const connections = this.deps.inference.statuses().filter(item => !item.deleted);
    const models = scan.models.map(model => ({ ...model, connectionId: connections.find(item => item.endpointOrigin === new URL(model.endpoint).origin)?.id ?? null }));
    const keys: DetectedKey[] = this.deps.credentials.statuses().filter(item => item.configured && item.source !== 'none').map(item => ({ provider: item.provider, label: keyLabels[item.provider] ?? item.provider, source: item.source === 'saved' ? 'saved' : 'environment' }));
    return {
      seenAt, scannedAt: scan.at, platform: process.platform, computer: mac ? 'this Mac' : win ? 'this PC' : 'this computer', lookedAt, bridge,
      agents, models, keys, apps: scan.apps, docker: scan.docker, cloud: { available: cloud.available, signedIn: cloud.state === 'signed-in' },
      show: !seenAt && (agents.some(agent => agent.found) || models.some(model => model.running)),
    };
  }
  async link(request: unknown): Promise<SetupLinkResponse> {
    const input = z.object({ agents: z.array(z.enum(AGENTS)).max(8).default([]), models: z.array(z.enum(MODELS)).max(4).default([]) }).strict().parse(request ?? {});
    // A fresh scan, so an agent installed a moment ago counts and an entry written since is seen.
    const scan = await this.scan(true);
    const agents: LinkResult[] = [], models: ModelLinkResult[] = [];
    for (const id of new Set(input.agents)) agents.push(await this.links.link(scan.agents.find(agent => agent.id === id)!, this.deps.outside.bridge));
    for (const id of new Set(input.models)) models.push(await this.registerModel(scan.models.find(model => model.id === id)!));
    this.cache = null;
    return { agents, models };
  }
  async unlink(id: string): Promise<LinkResult> {
    const agent = z.enum(AGENTS).parse(id), scan = await this.scan(true);
    const result = await this.links.unlink(scan.agents.find(item => item.id === agent)!);
    this.cache = null;
    return result;
  }
  /** ROS on this computer is downloaded, downloading, or left a download that stopped. */
  private downloaded() { return Boolean(this.deps.localRos && this.deps.localRos.status().state !== 'not-downloaded'); }
  /** What Reset onboarding can undo on this computer, for its options: the links this ros.ai recorded (only those, so a
   * test copy never removes the links another ros.ai made), saved plugin tokens, the hosted ROS sign-in and the download. */
  resetPlan(): SetupResetPlan {
    return {
      links: this.links.records().map(record => agentLabels[record.agent] ?? record.agent),
      tokens: this.deps.plugins.saved().map(id => PLUGINS.find(plugin => plugin.id === id)?.name ?? id),
      cloud: this.deps.cloud.signedIn,
      localRos: this.downloaded(),
    };
  }
  /** Reset onboarding, for testing the first run again: it shows again from the welcome page, plus whatever else the
   * person chose to undo. What could not be undone comes back in words; the reset goes on past it. */
  async reset(request: unknown): Promise<SetupResetResponse> {
    const input = z.object({ links: z.boolean().default(false), tokens: z.boolean().default(false), cloud: z.boolean().default(false), localRos: z.boolean().default(false) }).strict().parse(request ?? {});
    const done: string[] = [], failed: string[] = [];
    const attempt = async (success: string, work: () => unknown) => { try { await work(); done.push(success); } catch (error) { failed.push(error instanceof Error ? error.message : String(error)); } };
    if (input.links && this.links.records().length) {
      const scan = await this.scan(true);
      for (const record of this.links.records()) {
        const found = scan.agents.find(item => item.id === record.agent);
        if (!found) { failed.push(`${agentLabels[record.agent]} was not found on this computer, so its link stays recorded.`); continue; }
        const result = await this.links.unlink(found);
        if (result.ok) done.push(result.message); else failed.push(result.command ? `${result.message} ${result.command}` : result.message);
      }
    }
    if (input.tokens) for (const id of this.deps.plugins.saved()) await attempt(`Forgot the ${PLUGINS.find(plugin => plugin.id === id)?.name ?? id} token.`, () => this.deps.plugins.disconnect(id));
    if (input.cloud && this.deps.cloud.signedIn) await attempt('Signed out of hosted ROS.', () => this.deps.cloud.signOut());
    if (input.localRos && this.downloaded()) await attempt('Removed the ROS download.', () => this.deps.localRos!.remove());
    this.seen(false);
    this.cache = null;
    return { done, failed };
  }
  /** A running Ollama or LM Studio becomes an inference connection with no USD rate, like any loopback server.
   * Each model keeps the context its server gives it and whether it can call tools; embedding models stay out. */
  private async registerModel(model: Omit<DetectedModel, 'connectionId'>): Promise<ModelLinkResult> {
    if (!model.running) return { id: model.id, ok: false, message: `${model.label} is not running. Start it, then link it from Agents.` };
    const chat = model.details.filter(item => !item.embedding && item.id.length <= 160 && /^[a-zA-Z0-9][a-zA-Z0-9_./:@+-]*$/.test(item.id));
    // Models that call tools come first: ros.ai's agent can work with them.
    const chosen = [...chat.filter(item => item.tools === true), ...chat.filter(item => item.tools !== true)].slice(0, 16);
    if (!chosen.length) return { id: model.id, ok: false, message: `${model.label} is running but has no models to chat with yet. Download one, then link it from Agents.` };
    const contexts = new Map(chosen.map(item => [item.id, item.context]));
    const unknown = chosen.filter(item => item.context === null);
    if (model.id === 'ollama' && unknown.length) {
      // One load, as using a model would: the smallest such model that calls tools shows Ollama's default context.
      const probe = [...unknown].sort((a, b) => Number(b.tools === true) - Number(a.tools === true) || (a.bytes ?? Infinity) - (b.bytes ?? Infinity))[0]!;
      const usual = await ollamaDefaultContext(probe.id);
      if (usual) for (const item of chosen) if (item.context === null) contexts.set(item.id, item.maxContext ? Math.min(usual, item.maxContext) : usual);
    }
    const models = chosen.map(item => {
      const context = contexts.get(item.id) ?? Math.min(LOCAL_DEFAULT_CONTEXT, item.maxContext ?? LOCAL_DEFAULT_CONTEXT);
      return { id: item.id, label: item.id, contextTokens: Math.max(256, Math.min(8_000_000, context)), inputUsdPerMillion: 0, outputUsdPerMillion: 0, ...(item.tools === null ? {} : { tools: item.tools }) };
    });
    const origin = new URL(model.endpoint).origin, existing = this.deps.inference.statuses().find(item => !item.deleted && item.endpointOrigin === origin);
    // Local answers are slow: five minutes and 8,000 output tokens a request, shortened to the room a model's context leaves.
    const caps = { maxInputBytes: 64000, maxOutputTokens: Math.max(existing?.caps.maxOutputTokens ?? 0, 8000), timeoutMs: Math.max(existing?.caps.timeoutMs ?? 0, 300000), maxConcurrent: existing?.caps.maxConcurrent ?? 1, maxResponseBytes: Math.max(existing?.caps.maxResponseBytes ?? 0, 256000) };
    try {
      const connection = existing
        ? this.deps.inference.update(existing.id, { models, caps, enabled: true })
        : this.deps.inference.create({ name: model.label, endpoint: model.endpoint, enabled: true, models, caps });
      if (!this.deps.inference.status(connection.id).allowanceEnabled) this.deps.inference.saveAllowance(connection.id, { requestCeiling: 10000, usdCeiling: 0, enabled: true, acknowledged: true });
      return { id: model.id, ok: true, message: `${models.length} model${models.length === 1 ? '' : 's'} connected. Nothing is spent until you use them.`, connectionId: connection.id };
    } catch (error) { return { id: model.id, ok: false, message: error instanceof Error ? error.message : `${model.label} could not be registered.` }; }
  }
}

export function attachSetupRoutes(app: Express, setup: Setup) {
  app.get('/api/setup', async (req, res) => { res.json(await setup.status(req.query.rescan === '1')); });
  app.post('/api/setup/links', async (req, res) => { res.json(await setup.link(req.body)); });
  app.delete('/api/setup/links/:agent', async (req, res) => { res.json(await setup.unlink(String(req.params.agent))); });
  app.post('/api/setup/seen', (_req, res) => { setup.seen(true); res.json({ ok: true }); });
  app.delete('/api/setup/seen', (_req, res) => { setup.seen(false); res.json({ ok: true }); });
  // Settings › General › Reset onboarding: what it can undo, and the reset itself.
  app.get('/api/setup/reset', (_req, res) => { res.json(setup.resetPlan()); });
  app.post('/api/setup/reset', async (req, res) => { res.json(await setup.reset(req.body)); });
}
