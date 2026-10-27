import { constants, existsSync, fstatSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import { StoreError } from './store.js';
import { NEBIUS_BASE } from './providers.js';
import type { CredentialProvider, CredentialStatus } from '../shared/tool-connections.js';

const names = { nebius: 'NEBIUS_API_KEY', claude: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', tavily: 'TAVILY_API_KEY', exa: 'EXA_API_KEY', brave: 'BRAVE_API_KEY' } as const;
const providerSchema = z.enum(['nebius', 'claude', 'openai', 'tavily', 'exa', 'brave']);
const keySchema = z.string().trim().min(12).max(4096).refine(value => !/\s|[\x00-\x1f\x7f]/.test(value), 'Enter a single API key without spaces.');
const savedSchema = z.object({ version: z.literal(1), keys: z.object({ nebius: keySchema.optional(), claude: keySchema.optional(), openai: keySchema.optional(), tavily: keySchema.optional(), exa: keySchema.optional(), brave: keySchema.optional() }).strict() }).strict();

/** Local server credentials are deliberately separate from model spending grants.
 * The only browser-readable values are presence, source and a bounded check result.
 */
export class ToolCredentials {
  private readonly file: string;
  private readonly environment = new Map<CredentialProvider, string | undefined>();
  private keys: Partial<Record<CredentialProvider, string>> = {};
  private checks = new Map<CredentialProvider, Pick<CredentialStatus, 'checkedAt' | 'verified' | 'checkMessage'>>();
  constructor(dataDir: string) {
    this.file = join(dataDir, 'tool-credentials.json');
    for (const provider of Object.keys(names) as CredentialProvider[]) this.environment.set(provider, process.env[names[provider]]);
    if (existsSync(this.file)) {
      const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.size > 20000 || (info.mode & 0o077) !== 0) throw new Error('Invalid private credential file.');
        this.keys = savedSchema.parse(JSON.parse(readFileSync(fd, 'utf8'))).keys;
      } catch { throw new Error('Could not read private tool credentials. Ensure the file is valid and readable only by its owner.'); }
      finally { closeSync(fd); }
    }
    for (const provider of Object.keys(names) as CredentialProvider[]) this.apply(provider);
  }
  private apply(provider: CredentialProvider) {
    const key = this.keys[provider] ?? this.environment.get(provider);
    if (key) process.env[names[provider]] = key;
    else delete process.env[names[provider]];
  }
  private persist(keys: Partial<Record<CredentialProvider, string>>) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, keys }), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw new StoreError('Could not save the private server credential.', 500);
    }
    this.keys = keys;
  }
  status(provider: CredentialProvider): CredentialStatus {
    const source = this.keys[provider] ? 'saved' : this.environment.get(provider) ? 'environment' : 'none';
    return { provider, configured: source !== 'none', source, canDisconnect: source === 'saved', ...(this.checks.get(provider) ?? { checkedAt: null, verified: null, checkMessage: null }) };
  }
  statuses() { return (Object.keys(names) as CredentialProvider[]).map(provider => this.status(provider)); }
  save(provider: CredentialProvider, supplied: unknown) {
    const { apiKey } = z.object({ apiKey: keySchema }).strict().parse(supplied);
    this.persist({ ...this.keys, [provider]: apiKey });
    this.apply(provider); this.checks.delete(provider);
    return this.status(provider);
  }
  disconnect(provider: CredentialProvider) {
    if (!this.keys[provider]) throw new StoreError('This key comes from server environment configuration. Remove it there and restart to disconnect.');
    const keys = { ...this.keys }; delete keys[provider];
    this.persist(keys); this.apply(provider); this.checks.delete(provider);
    return this.status(provider);
  }
  async checkNebius() {
    const key = process.env.NEBIUS_API_KEY;
    if (!key) throw new StoreError('Connect a Nebius API key first.');
    let verified = false, checkMessage = 'Could not reach Nebius. The saved key has not been verified.';
    try {
      const response = await fetch(`${NEBIUS_BASE}/models`, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      // A catalog request authenticates the key without inference or spending.
      // Do not return a provider body, which can echo account/credential details.
      verified = response.ok;
      checkMessage = response.ok ? 'Nebius accepted the key for its model catalog. No model turn was started.' : response.status === 401 || response.status === 403 ? 'Nebius rejected this key. Check the key and Token Factory access.' : `Nebius catalog returned HTTP ${response.status}. No model turn was started.`;
      await response.body?.cancel();
    } catch { /* Keep a bounded, credential-free diagnostic. */ }
    // A simultaneous replacement must not inherit the previous key's check.
    if (process.env.NEBIUS_API_KEY !== key) throw new StoreError('The key changed during this check. Check the current key again.');
    this.checks.set('nebius', { checkedAt: new Date().toISOString(), verified, checkMessage });
    return this.status('nebius');
  }
  async checkClaude() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new StoreError('Connect an Anthropic API key first.');
    let verified = false, checkMessage = 'Could not reach Anthropic. The saved key has not been verified.';
    try {
      // Listing models authenticates the key without a model turn or charge.
      const response = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      verified = response.ok;
      checkMessage = response.ok ? 'Anthropic accepted the key. No model turn was started.' : response.status === 401 || response.status === 403 ? 'Anthropic rejected this key. Check the key in the Claude Console.' : `Anthropic returned HTTP ${response.status}. No model turn was started.`;
      await response.body?.cancel();
    } catch { /* Keep a bounded, credential-free diagnostic. */ }
    if (process.env.ANTHROPIC_API_KEY !== key) throw new StoreError('The key changed during this check. Check the current key again.');
    this.checks.set('claude', { checkedAt: new Date().toISOString(), verified, checkMessage });
    return this.status('claude');
  }
}

export function attachToolCredentialRoutes(app: Express, credentials: ToolCredentials) {
  app.get('/api/connections/credentials', (_req, res) => res.json({ credentials: credentials.statuses() }));
  app.put('/api/connections/credentials/:provider', (req, res) => {
    if (!req.is('application/json')) throw new StoreError('Send a JSON credential request.', 415);
    res.json(credentials.save(providerSchema.parse(req.params.provider), req.body));
  });
  app.delete('/api/connections/credentials/:provider', (req, res) => res.json(credentials.disconnect(providerSchema.parse(req.params.provider))));
  app.post('/api/connections/nebius/check', async (_req, res) => res.json(await credentials.checkNebius()));
  app.post('/api/connections/claude/check', async (_req, res) => res.json(await credentials.checkClaude()));
}
