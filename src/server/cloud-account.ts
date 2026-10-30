import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { connect } from 'node:tls';
import type { Express } from 'express';
import { z } from 'zod';
import type { CloudAccountStatus } from '../shared/cloud-account.js';
import type { FeedbackNote } from '../shared/feedback.js';
import type { InferenceConnections } from './inference-connections.js';
import { StoreError } from './store.js';
import { followScript } from './sign-in-window.js';

const SIGN_IN_TTL_MS = 10 * 60_000;
const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
/** The sign-in tab's last page, in the look of the ros.ai cloud sign-in pages. */
const signInTab = (title: string, message: string, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ros.ai</title><link rel="icon" type="image/png" href="/brand/ros-ai-ring.png">
<style>body{margin:0;min-height:100vh;display:flex;background:#fff;color:#0b0d10;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}main{width:100%;max-width:408px;margin:auto;padding:48px 16px}img{display:block;width:40px;height:40px;margin-bottom:28px}h1{margin:0 0 12px;font-size:26px;line-height:1.25;letter-spacing:-.4px}p{margin:0;color:#4a5059}</style></head>
<body><main><img src="/brand/ros-ai-ring.png" alt="ros.ai"><h1>${escape(title)}</h1><p>${escape(message)}</p></main>${script}</body></html>`;
/** Network errors where the request never left this computer, so trying again cannot repeat it. */
const NOT_CONNECTED = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
/** Errors where the connection opened but this computer refused the certificate that came back. */
const CERTIFICATE = /CERT|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|SELF_SIGNED/u;
/** Who issued the certificate a server sends, to name what is in the way when it is refused: read without trusting it,
 * and the connection closes before anything is sent over it. */
function certificateIssuer(address: string): Promise<string | undefined> {
  const { hostname, port } = new URL(address);
  return new Promise(done => {
    const socket = connect({ host: hostname, port: Number(port) || 443, servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: false, timeout: 5000 }, () => {
      const { O, CN } = socket.getPeerCertificate().issuer ?? {};
      socket.destroy();
      done([O, CN].filter(Boolean).join(' ') || undefined);
    });
    socket.once('error', () => done(undefined));
    socket.once('timeout', () => { socket.destroy(); done(undefined); });
  });
}
const accountSchema = z.object({ token: z.string().min(16).max(512), email: z.string(), connectionId: z.string() }).strict();
const modelsSchema = z.object({ data: z.array(z.object({ id: z.string(), context_length: z.number().int(), max_output_tokens: z.number().int(), pricing: z.object({ input_usd_per_million: z.number(), output_usd_per_million: z.number() }) })).min(1).max(16) });

/** Signs this computer in to ros.ai cloud in the person's browser, then registers the cloud as an ordinary model connection so ROS, the assistant and
 * the agent loop use it like any other model. The session token stays on the local server in an
 * owner-only file, like the other keys; the browser page never sees it. */
export class CloudAccount {
  private readonly file: string;
  /** keep: the tab stays open after the sign-in, because Connect your tools opens its next sign-in there. */
  private pending?: { state: string; verifier: string; verificationUrl: string; expiresAt: number; keep?: boolean };
  private lastError = '';
  private readonly callbackUrl: string;
  constructor(private readonly url: string | undefined, dataDir: string, private readonly connections: InferenceConnections, port: number) {
    this.file = join(dataDir, 'cloud-account.json');
    this.callbackUrl = `http://127.0.0.1:${port}/api/cloud/callback`;
  }
  /** The inference connection hosted ROS runs on while the person is signed in, without asking ros.ai cloud. */
  connectionId(): string | undefined { return this.account()?.connectionId; }
  private account() {
    if (!existsSync(this.file)) return undefined;
    try { return accountSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))); } catch { return undefined; }
  }
  private save(account: z.infer<typeof accountSchema> | undefined) {
    if (!account) { if (existsSync(this.file)) unlinkSync(this.file); return; }
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(account), { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, this.file);
  }
  /** One request to ros.ai cloud. A connection that never opened (no DNS answer, refused, timed out) is tried twice more,
   * since nothing reached the cloud and the one-time sign-in code is still unused; what still fails says which address
   * could not be reached and why, instead of Node's bare "fetch failed". */
  private async call(path: string, init: RequestInit = {}) {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(`${this.url}${path}`, { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json', ...init.headers } });
        return { status: response.status, body: await response.json().catch(() => ({})) as any };
      } catch (error) {
        const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
        if (cause?.code && NOT_CONNECTED.has(cause.code) && attempt < 3) { await new Promise(resolve => setTimeout(resolve, attempt * 1000)); continue; }
        if (!(error instanceof TypeError) || error.message !== 'fetch failed') throw error;
        console.error(`ros.ai cloud: ${path} failed: ${cause?.code ?? ''} ${cause?.message ?? ''}`.trim());
        const host = new URL(this.url!).hostname;
        if (cause?.code && CERTIFICATE.test(cause.code)) {
          // Usually a firewall or antivirus that inspects HTTPS and signs with its own authority (a FortiGate, say).
          const issuer = await certificateIssuer(this.url!);
          throw new Error(`This computer does not trust the certificate that came back from ${host} (${cause.code}${issuer ? `, issued by ${issuer}` : ''}). A firewall or antivirus on this network is probably inspecting secure connections. Use another network, ask its admin to exempt ${host}, or install its certificate on this computer.`);
        }
        throw new Error(`ros.ai could not reach ros.ai cloud at ${host} (${cause?.code ?? cause?.message ?? 'no answer'}). Check the internet connection and try again.`);
      }
    }
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
  async signIn(keep = false): Promise<CloudAccountStatus> {
    if (!this.url) throw new StoreError('ros.ai cloud is not set up in this copy of ros.ai.', 404);
    const state = randomBytes(24).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const page = new URL(`${this.url}/app/sign-in`);
    for (const [key, value] of Object.entries({ redirect_uri: this.callbackUrl, state, code_challenge: challenge, code_challenge_method: 'S256' })) page.searchParams.set(key, value);
    this.pending = { state, verifier, verificationUrl: page.href, expiresAt: Date.now() + SIGN_IN_TTL_MS, ...(keep ? { keep } : {}) };
    this.lastError = '';
    return this.status();
  }
  /** The browser lands here after signing in; returns the page to show in that tab. */
  async callback(query: Record<string, unknown>): Promise<{ ok: boolean; message: string; keep?: boolean }> {
    const pending = this.pending;
    if (!pending || Date.now() > pending.expiresAt || typeof query.state !== 'string' || query.state !== pending.state) return { ok: false, message: 'This sign-in has expired. Start again from ros.ai.' };
    this.pending = undefined;
    try {
      const result = await this.call('/app/token', { method: 'POST', body: JSON.stringify({ code: query.code, code_verifier: pending.verifier, redirect_uri: this.callbackUrl }) });
      if (typeof result.body.access_token !== 'string') throw new Error(result.body.error_description || 'ros.ai cloud did not finish the sign-in.');
      await this.connect(result.body.access_token);
      return pending.keep ? { ok: true, message: 'ros.ai goes on by itself.', keep: true } : { ok: true, message: 'You can close this tab and go back to ros.ai.' };
    } catch (error) { this.lastError = error instanceof Error ? error.message : 'Sign-in failed.'; return { ok: false, message: this.lastError, ...(pending.keep ? { keep: true } : {}) }; }
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
      models: catalogue.map(item => ({ id: item.id, label: item.id === 'ros' ? 'ROS' : item.id === 'ros-deep' ? 'ROS, thinking deeper' : item.id, contextTokens: item.context_length, inputUsdPerMillion: loopback ? 0 : item.pricing.input_usd_per_million, outputUsdPerMillion: loopback ? 0 : item.pricing.output_usd_per_million, maker: { id: 'nvidia' as const, label: 'NVIDIA Nemotron', monogram: 'N' } })),
      caps: { maxInputBytes: 64000, maxOutputTokens: Math.min(...catalogue.map(item => item.max_output_tokens)), timeoutMs: 120000, maxConcurrent: 4, maxResponseBytes: 256000 },
    };
    const connection = existing ? this.connections.update(existing.id, fields) : this.connections.create(fields);
    // ros.ai cloud enforces the real free allowance; this local ceiling only mirrors its size.
    const status = this.connections.status(connection.id);
    this.connections.saveAllowance(connection.id, { requestCeiling: Math.max(10000, status.usedRequests), usdCeiling: loopback ? status.usdCeiling : Math.max(100, status.accountedUsd), enabled: true, acknowledged: true });
    this.save({ token, email: String(me.body?.user?.email ?? ''), connectionId: connection.id });
  }

  /** Whether this copy of ros.ai has a ros.ai cloud at all (ROS_CLOUD_URL is not off). */
  get available() { return Boolean(this.url); }
  /** Signed in on this computer, read from the saved account without asking ros.ai cloud. */
  get signedIn() { return Boolean(this.url && this.account()); }
  /** The signed-in email, read from this computer without asking ros.ai cloud. */
  signedInEmail() { return this.url ? this.account()?.email || undefined : undefined; }
  /** Passes one feedback note on to ros.ai cloud, as the signed-in person when there is one, so a
   * reply can go to their account email; the saved email goes along in case the session has ended.
   * Answers with the address the reply will go to, if any. */
  async sendFeedback(note: FeedbackNote): Promise<{ email?: string }> {
    if (!this.url) throw new StoreError('ros.ai cloud is off in this copy of ros.ai.', 404);
    const account = this.account();
    const body = account?.email && !note.email ? { ...note, email: account.email } : note;
    const result = await this.call('/v1/feedback', { method: 'POST', headers: account ? { Authorization: `Bearer ${account.token}` } : {}, body: JSON.stringify(body) })
      .catch(() => { throw new StoreError('ros.ai cloud could not be reached.', 502); });
    if (result.status === 404) throw new StoreError('ros.ai cloud does not take notes yet.', 502);
    if (result.status >= 300) throw new StoreError(typeof result.body?.error?.message === 'string' ? result.body.error.message : `ros.ai cloud did not take the note (${result.status}).`, result.status === 429 ? 429 : 502);
    return typeof result.body?.email === 'string' ? { email: result.body.email } : {};
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
  // The sign-in button opens this in a new tab, which then goes on to ros.ai cloud. Opening a
  // local address straight from the click keeps browsers from blocking or blanking the tab.
  // ?keep=1: Connect your tools' window, which stays open for its next sign-in.
  app.get('/api/cloud/start', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { const status = await cloud.signIn(req.query.keep === '1'); res.redirect(302, status.verificationUrl!); }
    catch (error) { res.status(502).type('html').send(signInTab('Sign-in could not start', error instanceof Error ? error.message : 'Try again in a moment.')); }
  });
  // The browser tab the sign-in opened lands here; it closes itself when it can, unless Connect your tools keeps it, and
  // then it goes where Connect your tools tells it next.
  app.get('/api/cloud/callback', async (req, res) => {
    const result = await cloud.callback(req.query);
    res.setHeader('Cache-Control', 'no-store');
    res.status(result.ok ? 200 : 400).type('html').send(result.ok ? signInTab("You're signed in", result.message, result.keep ? followScript : '<script>setTimeout(()=>window.close(),600)</script>') : signInTab('Sign-in did not finish', result.message, result.keep ? followScript : ''));
  });
  app.post('/api/cloud/sign-out', async (_req, res) => { res.json(await cloud.signOut()); });
}
