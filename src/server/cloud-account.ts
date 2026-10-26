import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import type { CloudAccountStatus } from '../shared/cloud-account.js';
import type { InferenceConnections } from './inference-connections.js';
import { StoreError } from './store.js';

const SIGN_IN_TTL_MS = 10 * 60_000;
const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const accountSchema = z.object({ token: z.string().min(16).max(512), email: z.string(), connectionId: z.string() }).strict();
const modelsSchema = z.object({ data: z.array(z.object({ id: z.string(), context_length: z.number().int(), max_output_tokens: z.number().int(), pricing: z.object({ input_usd_per_million: z.number(), output_usd_per_million: z.number() }) })).min(1).max(16) });

/** Signs this computer in to ros.ai cloud in the person's browser, then registers the cloud as an ordinary model connection so Ros, the assistant and
 * the agent loop use it like any other model. The session token stays on the local server in an
 * owner-only file, like the other keys; the browser page never sees it. */
export class CloudAccount {
  private readonly file: string;
  private pending?: { state: string; verifier: string; verificationUrl: string; expiresAt: number };
  private lastError = '';
  private readonly callbackUrl: string;
  constructor(private readonly url: string | undefined, dataDir: string, private readonly connections: InferenceConnections, port: number) {
    this.file = join(dataDir, 'cloud-account.json');
    this.callbackUrl = `http://127.0.0.1:${port}/api/cloud/callback`;
  }
  private account() {
    if (!existsSync(this.file)) return undefined;
    try { return accountSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))); } catch { return undefined; }
  }
  private save(account: z.infer<typeof accountSchema> | undefined) {
    if (!account) { if (existsSync(this.file)) unlinkSync(this.file); return; }
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(account), { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, this.file);
  }
  private async call(path: string, init: RequestInit = {}) {
    const response = await fetch(`${this.url}${path}`, { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json', ...init.headers } });
    return { status: response.status, body: await response.json().catch(() => ({})) as any };
  }

  async status(): Promise<CloudAccountStatus> {
    if (!this.url) return { available: false, state: 'signed-out' };
    const account = this.account();
    if (this.pending && Date.now() < this.pending.expiresAt) return { available: true, state: 'waiting', verificationUrl: this.pending.verificationUrl };
    if (!account) return { available: true, state: 'signed-out', ...(this.lastError ? { error: this.lastError } : {}) };
    try {
      const me = await this.call('/v1/me', { headers: { Authorization: `Bearer ${account.token}` } });
      if (me.status === 401) return { available: true, state: 'expired', email: account.email };
      const allowance = me.body?.allowance;
      return { available: true, state: 'signed-in', email: account.email, connectionId: account.connectionId, ...(allowance ? { leftTodayUsd: Math.max(0, allowance.dailyUsd - allowance.usedTodayUsd), dailyUsd: allowance.dailyUsd } : {}) };
    } catch { return { available: true, state: 'signed-in', email: account.email, connectionId: account.connectionId, error: 'ros.ai cloud could not be reached just now.' }; }
  }

  /** Opens one browser page: the person signs in at ros.ai cloud (GitHub, Google or email) and the
   * page sends them straight back to /api/cloud/callback here with a one-time code, which only this
   * server can swap for a token, because only it knows the PKCE verifier (RFC 8252, like CLI sign-ins). */
  async signIn(): Promise<CloudAccountStatus> {
    if (!this.url) throw new StoreError('ros.ai cloud is not set up in this copy of ros.ai.', 404);
    const state = randomBytes(24).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const page = new URL(`${this.url}/app/sign-in`);
    for (const [key, value] of Object.entries({ redirect_uri: this.callbackUrl, state, code_challenge: challenge, code_challenge_method: 'S256' })) page.searchParams.set(key, value);
    this.pending = { state, verifier, verificationUrl: page.href, expiresAt: Date.now() + SIGN_IN_TTL_MS };
    this.lastError = '';
    return this.status();
  }
  /** The browser lands here after signing in; returns the page to show in that tab. */
  async callback(query: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    const pending = this.pending;
    if (!pending || Date.now() > pending.expiresAt || typeof query.state !== 'string' || query.state !== pending.state) return { ok: false, message: 'This sign-in has expired. Start again from ros.ai.' };
    this.pending = undefined;
    try {
      const result = await this.call('/app/token', { method: 'POST', body: JSON.stringify({ code: query.code, code_verifier: pending.verifier, redirect_uri: this.callbackUrl }) });
      if (typeof result.body.access_token !== 'string') throw new Error(result.body.error_description || 'ros.ai cloud did not finish the sign-in.');
      await this.connect(result.body.access_token);
      return { ok: true, message: 'You are signed in. You can close this tab and go back to ros.ai.' };
    } catch (error) { this.lastError = error instanceof Error ? error.message : 'Sign-in failed.'; return { ok: false, message: this.lastError }; }
  }
  /** Registers (or refreshes) the cloud as a model connection with the token as its key. */
  private async connect(token: string) {
    const auth = { Authorization: `Bearer ${token}` };
    const [me, models] = await Promise.all([this.call('/v1/me', { headers: auth }), this.call('/v1/models')]);
    const catalogue = modelsSchema.parse(models.body).data;
    // A cloud on this computer (development) is recorded without a USD debit, like any loopback server.
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(this.url!).hostname);
    const prior = this.account(), existing = prior && this.connections.statuses().find(item => item.id === prior.connectionId && !item.deleted);
    const fields = {
      name: 'ros.ai cloud', endpoint: `${this.url}/v1`, apiKey: token, enabled: true,
      models: catalogue.map(item => ({ id: item.id, label: item.id === 'ros' ? 'Ros' : item.id === 'ros-deep' ? 'Ros, thinking deeper' : item.id, contextTokens: item.context_length, inputUsdPerMillion: loopback ? 0 : item.pricing.input_usd_per_million, outputUsdPerMillion: loopback ? 0 : item.pricing.output_usd_per_million, maker: { id: 'nvidia' as const, label: 'NVIDIA Nemotron', monogram: 'N' } })),
      caps: { maxInputBytes: 64000, maxOutputTokens: Math.min(...catalogue.map(item => item.max_output_tokens)), timeoutMs: 120000, maxConcurrent: 4, maxResponseBytes: 256000 },
    };
    const connection = existing ? this.connections.update(existing.id, fields) : this.connections.create(fields);
    // ros.ai cloud enforces the real free allowance; this local ceiling only mirrors its size.
    const status = this.connections.status(connection.id);
    this.connections.saveAllowance(connection.id, { requestCeiling: Math.max(10000, status.usedRequests), usdCeiling: loopback ? status.usdCeiling : Math.max(100, status.accountedUsd), enabled: true, acknowledged: true });
    this.save({ token, email: String(me.body?.user?.email ?? ''), connectionId: connection.id });
  }

  async signOut(): Promise<CloudAccountStatus> {
    this.pending = undefined;
    const account = this.account();
    if (account) {
      await this.call('/api/auth/sign-out', { method: 'POST', headers: { Authorization: `Bearer ${account.token}` }, body: '{}' }).catch(() => undefined);
      if (this.connections.statuses().some(item => item.id === account.connectionId && !item.deleted)) this.connections.remove(account.connectionId);
      this.save(undefined);
    }
    return this.status();
  }
  shutdown() { this.pending = undefined; }
}

export function attachCloudAccountRoutes(app: Express, cloud: CloudAccount) {
  app.get('/api/cloud', async (_req, res) => { res.json(await cloud.status()); });
  app.post('/api/cloud/sign-in', async (_req, res) => { res.json(await cloud.signIn()); });
  // The browser tab the sign-in opened lands here; it closes itself when it can.
  app.get('/api/cloud/callback', async (req, res) => {
    const result = await cloud.callback(req.query);
    res.setHeader('Cache-Control', 'no-store');
    res.status(result.ok ? 200 : 400).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ros.ai</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,-apple-system,sans-serif;color:#171717;background:#fafafa}p{max-width:360px;text-align:center}</style></head><body><p>${escape(result.message)}</p>${result.ok ? '<script>setTimeout(()=>window.close(),600)</script>' : ''}</body></html>`);
  });
  app.post('/api/cloud/sign-out', async (_req, res) => { res.json(await cloud.signOut()); });
}
