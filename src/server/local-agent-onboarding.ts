import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { StoreError } from './store.js';
import { CodexAppServer } from './codex-app-server.js';
import type { CodexLoginStatus } from '../shared/local-agent-setup.js';

type Login = { projectId: string; public: CodexLoginStatus; rpc: CodexAppServer; nativeLoginId?: string; cancelRequested?: boolean; cwd: string; deadline: ReturnType<typeof setTimeout> };
const waiting = (login: Login) => login.public.state === 'waiting';

/** User-triggered native login only. Codex owns the browser callback and its
 * credential store; ros.ai retains only transient URL/code and coarse outcome.
 * No key/token login, logout, inference or automatic retry is exposed.
 */
export class LocalAgentOnboarding {
  private readonly logins = new Map<string, Login>();
  private starting = false;
  private closed = false;
  constructor(private readonly onCompleted: () => void) {}
  hasPending() { return this.starting || [...this.logins.values()].some(waiting); }
  private settle(login: Login, state: CodexLoginStatus['state'], message: string) {
    if (!waiting(login)) return;
    login.public = { ...login.public, state, message, authUrl: undefined, userCode: undefined };
    clearTimeout(login.deadline); login.rpc.close(); rmSync(login.cwd, { recursive: true, force: true });
    if (state === 'completed') this.onCompleted();
  }
  private flow(projectId: string, id: string) {
    const login = this.logins.get(z.string().uuid().parse(id));
    if (!login || login.projectId !== projectId) throw new StoreError('This sign-in flow is unavailable. Recheck native account status before starting another sign-in; it will not be retried automatically.', 404);
    return login;
  }
  async start(projectId: string, supplied: unknown, disabledMcp: string[]): Promise<CodexLoginStatus> {
    const { method } = z.object({ method: z.enum(['browser', 'device']).default('browser') }).strict().parse(supplied);
    if (this.closed) throw new StoreError('Local sign-in service is stopping.', 503);
    if (this.starting || [...this.logins.values()].some(waiting)) throw new StoreError('A native Codex sign-in is already waiting. Finish or cancel that flow before starting another.', 409);
    // Login affects one local Codex account, shared by all ros.ai projects.
    for (const [id, login] of this.logins) if (!waiting(login) && Date.parse(login.public.expiresAt) < Date.now()) this.logins.delete(id);
    const cwd = mkdtempSync(join(tmpdir(), 'ros-ai-codex-login-'));
    this.starting = true;
    let login: Login | null = null;
    try {
      const rpc = new CodexAppServer(cwd, { disabledMcp }), id = randomUUID();
      const publicStatus: CodexLoginStatus = { id, agent: 'codex', method, state: 'waiting', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), message: 'Complete sign-in on the official OpenAI page. This changes only native Codex authentication; it sends no inference request and grants no research permission.' };
      login = { projectId, public: publicStatus, rpc, cwd, deadline: setTimeout(() => {}, 0) };
      const current = login;
      clearTimeout(current.deadline);
      current.deadline = setTimeout(() => {
        current.cancelRequested = true;
        if (current.nativeLoginId) void rpc.request('account/login/cancel', { loginId: current.nativeLoginId }, 2000).catch(() => {}).finally(() => this.settle(current, 'expired', 'This sign-in flow expired. Recheck the native account before deliberately starting a new flow. No retry or inference was sent.'));
        else this.settle(current, 'expired', 'Sign-in expired before its native identity was confirmed. Recheck native account status; no automatic retry occurred.');
      }, 10 * 60_000);
      this.logins.set(id, current);
      const earlyCompletions: { loginId: string; success: boolean }[] = [];
      const complete = (success: boolean) => this.settle(current, success ? 'completed' : 'failed', success ? 'Native Codex sign-in completed. Refresh connection status; research availability still requires the separate grant and isolation checks.' : 'Native Codex did not complete sign-in. Recheck account status or use the official CLI login; no automatic retry occurred.');
      rpc.onFailure = () => { if (!current.cancelRequested) this.settle(current, 'failed', 'Native Codex sign-in disconnected. Its outcome is unconfirmed; recheck account status before starting again. No automatic retry occurred.'); };
      rpc.onNotification = (name, params) => {
        if (name !== 'account/login/completed' || current.cancelRequested || typeof params.loginId !== 'string' || typeof params.success !== 'boolean') return;
        // Bind a completion to the returned native ID before accepting it. A
        // notification can precede the login/start response on the same stream.
        if (!current.nativeLoginId) {
          if (earlyCompletions.length < 4) earlyCompletions.push({ loginId: params.loginId, success: params.success });
          return;
        }
        if (params.loginId === current.nativeLoginId) complete(params.success);
      };
      await rpc.initialize();
      if (this.closed || current.cancelRequested || !waiting(current)) return current.public;
      const result = await rpc.request<{ type?: string; loginId?: string; authUrl?: string; verificationUrl?: string; userCode?: string }>('account/login/start', { type: method === 'browser' ? 'chatgpt' : 'chatgptDeviceCode' });
      z.literal(method === 'browser' ? 'chatgpt' : 'chatgptDeviceCode').parse(result.type);
      const nativeLoginId = z.string().min(1).max(200).parse(result.loginId);
      current.nativeLoginId = nativeLoginId;
      if (this.closed || current.cancelRequested || !waiting(current)) return current.public;
      const url = new URL(z.string().max(16000).parse(method === 'browser' ? result.authUrl : result.verificationUrl));
      if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.username || url.password) throw new StoreError('Codex returned an unexpected sign-in destination. Use the official CLI login and recheck status.', 503);
      const userCode = method === 'device' ? z.string().regex(/^[A-Za-z0-9-]{1,40}$/u).parse(result.userCode) : undefined;
      if (waiting(current)) current.public = { ...current.public, authUrl: url.href, userCode };
      const earlyCompletion = earlyCompletions.find(value => value.loginId === nativeLoginId);
      if (earlyCompletion) complete(earlyCompletion.success);
      return current.public;
    } catch {
      if (login && !waiting(login)) return login.public;
      if (login) {
        if (login.nativeLoginId) await login.rpc.request('account/login/cancel', { loginId: login.nativeLoginId }, 2000).catch(() => {});
        this.settle(login, 'failed', 'Native sign-in could not start safely. Run codex login in your terminal and recheck connection status; no automatic retry or inference was sent.');
      } else rmSync(cwd, { recursive: true, force: true });
      throw new StoreError('Native Codex sign-in could not start. Run codex login in your own terminal, then recheck this connection. No automatic retry or inference was sent.', 503);
    } finally { this.starting = false; }
  }
  status(projectId: string, id: string): CodexLoginStatus { return this.flow(projectId, id).public; }
  current(projectId: string): CodexLoginStatus | null {
    return [...this.logins.values()].find(login => login.projectId === projectId && waiting(login))?.public ?? null;
  }
  async cancel(projectId: string, id: string): Promise<CodexLoginStatus> {
    const login = this.flow(projectId, id);
    if (!waiting(login)) return login.public;
    login.cancelRequested = true;
    if (login.nativeLoginId) await login.rpc.request('account/login/cancel', { loginId: login.nativeLoginId }, 3000).catch(() => {});
    this.settle(login, 'cancelled', 'Stopped this sign-in flow. Existing native account credentials were not removed. Recheck account status before another sign-in; no retry or inference was sent.');
    return login.public;
  }
  async shutdown() {
    this.closed = true;
    await Promise.allSettled([...this.logins.values()].filter(waiting).map(login => this.cancel(login.projectId, login.public.id)));
  }
}
