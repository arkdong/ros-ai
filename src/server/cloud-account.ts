import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import type { CloudAccountStatus } from '../shared/cloud-account.js';
import type { InferenceConnections } from './inference-connections.js';
import { StoreError } from './store.js';

const CLIENT_ID = 'ros-ai-app';
const accountSchema = z.object({ token: z.string().min(16).max(512), email: z.string(), connectionId: z.string() }).strict();
const modelsSchema = z.object({ data: z.array(z.object({ id: z.string(), context_length: z.number().int(), max_output_tokens: z.number().int(), pricing: z.object({ input_usd_per_million: z.number(), output_usd_per_million: z.number() }) })).min(1).max(16) });

/** Signs this computer in to ros.ai cloud with a device code the person approves in their
 * browser, then registers the cloud as an ordinary model connection so Ros, the assistant and
 * the agent loop use it like any other model. The session token stays on the local server in an
 * owner-only file, like the other keys; the browser page never sees it. */
export class CloudAccount {
  private readonly file: string;
  private pending?: { userCode: string; verificationUrl: string; expiresAt: number; stop: AbortController };
  private lastError = '';
  constructor(private readonly url: string | undefined, dataDir: string, private readonly connections: InferenceConnections) {
    this.file = join(dataDir, 'cloud-account.json');
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
    if (this.pending && Date.now() < this.pending.expiresAt) return { available: true, state: 'waiting', userCode: this.pending.userCode, verificationUrl: this.pending.verificationUrl };
    if (!account) return { available: true, state: 'signed-out', ...(this.lastError ? { error: this.lastError } : {}) };
    try {
      const me = await this.call('/v1/me', { headers: { Authorization: `Bearer ${account.token}` } });
      if (me.status === 401) return { available: true, state: 'expired', email: account.email };
      const allowance = me.body?.allowance;
      return { available: true, state: 'signed-in', email: account.email, connectionId: account.connectionId, ...(allowance ? { leftTodayUsd: Math.max(0, allowance.dailyUsd - allowance.usedTodayUsd), dailyUsd: allowance.dailyUsd } : {}) };
    } catch { return { available: true, state: 'signed-in', email: account.email, connectionId: account.connectionId, error: 'ros.ai cloud could not be reached just now.' }; }
  }

  /** Asks for a device code and waits in the background for the person to approve it. */
  async signIn(): Promise<CloudAccountStatus> {
    if (!this.url) throw new StoreError('ros.ai cloud is not set up in this copy of ros.ai.', 404);
    this.pending?.stop.abort();
    const code = await this.call('/api/auth/device/code', { method: 'POST', body: JSON.stringify({ client_id: CLIENT_ID }) });
    if (code.status !== 200 || typeof code.body.device_code !== 'string') throw new StoreError('ros.ai cloud did not start a sign-in. Try again in a moment.', 502);
    const stop = new AbortController(), expiresAt = Date.now() + Number(code.body.expires_in ?? 600) * 1000;
    this.pending = { userCode: code.body.user_code, verificationUrl: code.body.verification_uri_complete, expiresAt, stop };
    this.lastError = '';
    void this.poll(code.body.device_code, Math.max(5, Number(code.body.interval ?? 5)), expiresAt, stop.signal);
    return this.status();
  }
  private async poll(deviceCode: string, interval: number, expiresAt: number, signal: AbortSignal) {
    while (!signal.aborted && Date.now() < expiresAt) {
      await new Promise(resolve => setTimeout(resolve, interval * 1000));
      if (signal.aborted) return;
      try {
        const result = await this.call('/api/auth/device/token', { method: 'POST', body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode, client_id: CLIENT_ID }) });
        if (result.body.error === 'authorization_pending') continue;
        if (result.body.error === 'slow_down') { interval += 5; continue; }
        if (typeof result.body.access_token !== 'string') { this.lastError = result.body.error === 'access_denied' ? 'Sign-in was refused in the browser.' : 'The sign-in code expired. Start again.'; break; }
        await this.connect(result.body.access_token);
        break;
      } catch (error) { this.lastError = error instanceof Error ? error.message : 'Sign-in failed.'; break; }
    }
    if (this.pending?.stop.signal === signal) this.pending = undefined;
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
    this.pending?.stop.abort(); this.pending = undefined;
    const account = this.account();
    if (account) {
      await this.call('/api/auth/sign-out', { method: 'POST', headers: { Authorization: `Bearer ${account.token}` }, body: '{}' }).catch(() => undefined);
      if (this.connections.statuses().some(item => item.id === account.connectionId && !item.deleted)) this.connections.remove(account.connectionId);
      this.save(undefined);
    }
    return this.status();
  }
  shutdown() { this.pending?.stop.abort(); }
}

export function attachCloudAccountRoutes(app: Express, cloud: CloudAccount) {
  app.get('/api/cloud', async (_req, res) => { res.json(await cloud.status()); });
  app.post('/api/cloud/sign-in', async (_req, res) => { res.json(await cloud.signIn()); });
  app.post('/api/cloud/sign-out', async (_req, res) => { res.json(await cloud.signOut()); });
}
