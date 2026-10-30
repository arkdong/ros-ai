import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { query, type SDKControlGetUsageResponse, type SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudePlanLogin, ClaudePlanStatus } from '../shared/claude-agent.js';
import type { PlanUsage, PlanWindow } from '../shared/budget-report.js';

const LOGIN_SECONDS = 600, STATUS_SECONDS = 15, STATUS_CACHE_MS = 30_000, USAGE_SECONDS = 20, USAGE_CACHE_MS = 60_000;

/** Claude Code on the person's own Claude plan. Anthropic allows a person to sign in to the
 * unmodified Claude Code program with their own subscription, including inside another product,
 * as long as the sign-in happens in Anthropic's own flow and the product never handles the
 * token. So ros.ai only starts the program Anthropic ships with the Agent SDK and asks it to
 * sign in; Claude Code keeps and renews its own login where it always does (the person's usual
 * Claude Code sign-in), and ros.ai never reads, stores or passes it on. Local app only. */
export const planAllowed = process.env.ROS_PUBLIC_DEMO !== '1';

/** The Claude Code program the Agent SDK ships for this computer, found the way the SDK finds it. */
export function claudeBinary(): string | null {
  let require: NodeJS.Require;
  try { require = createRequire(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')); } catch { return null; }
  const ext = process.platform === 'win32' ? '.exe' : '';
  const names = process.platform === 'linux' ? [`linux-${process.arch}`, `linux-${process.arch}-musl`] : [`${process.platform}-${process.arch}`];
  for (const name of names) {
    try { const path = require.resolve(`@anthropic-ai/claude-agent-sdk-${name}/claude${ext}`); if (existsSync(path)) return path; } catch { /* Try the next build. */ }
  }
  return null;
}

/** No API key, no gateway and no config folder of ros.ai's own: Claude Code can only use the
 * person's own Claude sign-in, from its usual place. */
export function planEnvironment() {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) if (process.env[key]) env[key] = process.env[key]!;
  return { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: 'ros-ai/0.1.0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
}

export class ClaudePlan {
  private status: ClaudePlanStatus = { state: 'unknown' };
  private checkedAt = 0;
  private checking: Promise<ClaudePlanStatus> | null = null;
  private login: (ClaudePlanLogin & { child?: ChildProcess }) | null = null;

  /** What is known without starting anything; kicks off a check when it is stale. */
  current(): ClaudePlanStatus {
    if (Date.now() - this.checkedAt > STATUS_CACHE_MS) void this.check();
    return this.status;
  }
  forget() { this.checkedAt = 0; this.status = { state: 'unknown' }; }

  /** Asks Claude Code whether it is signed in. No request is sent to a model. */
  check(force = false): Promise<ClaudePlanStatus> {
    if (!force && Date.now() - this.checkedAt <= STATUS_CACHE_MS) return Promise.resolve(this.status);
    if (this.checking) return this.checking;
    const binary = claudeBinary();
    if (!planAllowed || !binary) {
      this.status = { state: 'unavailable', message: planAllowed ? 'The Claude Code program that comes with ros.ai is missing on this computer. Run npm ci, then try again.' : 'A Claude subscription can only be used in the local app.' };
      this.checkedAt = Date.now();
      return Promise.resolve(this.status);
    }
    this.checking = new Promise<ClaudePlanStatus>(resolve => {
      let out = '';
      const child = spawn(binary, ['auth', 'status', '--json'], { env: planEnvironment(), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const timer = setTimeout(() => child.kill(), STATUS_SECONDS * 1000);
      child.stdout.on('data', chunk => { if (out.length < 20000) out += String(chunk); });
      const finish = () => {
        clearTimeout(timer);
        let value: { loggedIn?: boolean; authMethod?: string; email?: string | null; subscriptionType?: string | null } = {};
        try { value = JSON.parse(out); } catch { /* Treated as not signed in below. */ }
        // 'claude.ai' is a Claude account sign-in; 'oauth_token' is a token the person made with `claude setup-token`.
        const plan = value.loggedIn && (value.authMethod === 'claude.ai' || value.authMethod === 'oauth_token');
        resolve(plan ? { state: 'signed-in', email: value.email ?? null, plan: value.subscriptionType ?? null }
          : { state: 'signed-out', message: value.loggedIn ? 'Claude Code is signed in with an API key, not a Claude subscription.' : null });
      };
      child.on('error', finish);
      child.on('close', finish);
    }).then(status => { this.status = status; this.checkedAt = Date.now(); this.checking = null; return status; });
    return this.checking;
  }

  /** How much of the plan's windows is used: the numbers behind Claude Code's own /usage, asked of the program
   * itself (its token stays with it). No request is sent to a model. Asked at most once a minute. */
  usage(): Promise<PlanUsage> {
    if (this.usageRead && Date.now() - this.usageRead.at <= USAGE_CACHE_MS) return Promise.resolve(this.usageRead.value);
    this.reading ??= this.readUsage().then(value => { this.usageRead = { at: Date.now(), value }; return value; }).finally(() => { this.reading = null; });
    return this.reading;
  }
  /** What a turn on the plan reported about its limits, kept for when /usage cannot answer. */
  noteRateLimit(info: SDKRateLimitInfo) {
    if (!info.rateLimitType || typeof info.utilization !== 'number') return;
    // A share from 0 to 1 here, unlike /usage's percentages.
    this.seen.set(info.rateLimitType, { usedPercent: Math.min(100, Math.max(0, info.utilization * 100)), resetsAt: info.resetsAt ? new Date(info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1)).toISOString() : null, at: Date.now() });
  }
  private usageRead: { at: number; value: PlanUsage } | null = null;
  private reading: Promise<PlanUsage> | null = null;
  private seen = new Map<string, { usedPercent: number; resetsAt: string | null; at: number }>();
  private async readUsage(): Promise<PlanUsage> {
    const status = await this.check(), at = new Date().toISOString();
    const usage = (state: PlanUsage['state'], message: string | null, windows: PlanWindow[] = [], plan: string | null = status.state === 'signed-in' ? status.plan ?? null : null): PlanUsage => ({ id: 'claude', name: 'Claude Code', plan, state, windows, message, checkedAt: at });
    if (status.state === 'unavailable') return usage('unavailable', status.message ?? 'Your Claude subscription cannot be used here.');
    if (status.state !== 'signed-in') return usage('signed-out', status.message ?? 'Sign in with your Claude subscription on the Agents page to see its limits.');
    let answer: SDKControlGetUsageResponse | null = null;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), USAGE_SECONDS * 1000);
    try {
      const stream = query({ prompt: idle(controller.signal), options: { abortController: controller, env: planEnvironment(), settingSources: [], skills: [], tools: [], stderr: () => {} } });
      // Experimental in the Agent SDK; if it changes, the limits seen on recent turns stand in.
      answer = await stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    } catch { answer = null; } finally { clearTimeout(timer); controller.abort(); }
    const windows = answer?.rate_limits ? planWindows(answer.rate_limits) : [];
    if (windows.length) return usage('ready', null, windows, answer?.subscription_type ?? status.plan);
    const recent = [...this.seen.entries()].filter(([, value]) => Date.now() - value.at < 6 * 3600_000).map(([type, value]) => ({ label: SEEN_LABELS[type] ?? type, usedPercent: value.usedPercent, resetsAt: value.resetsAt }));
    if (recent.length) return usage('ready', 'From your last turns in ros.ai; Claude Code did not answer just now.', recent);
    return usage('unavailable', 'Claude Code did not share your plan’s limits. A sign-in made with claude setup-token cannot read them; signing in again on the Agents page can.');
  }

  loginState(): ClaudePlanLogin | null {
    if (!this.login) return null;
    const { child: _child, ...state } = this.login;
    return state;
  }

  /** Starts Claude Code's own sign-in. It opens Anthropic's page in the browser and finishes there;
   * ros.ai only waits for the program to exit and never sees the token. */
  startLogin(): ClaudePlanLogin {
    if (this.login?.state === 'waiting') return this.loginState()!;
    const binary = claudeBinary();
    if (!planAllowed || !binary) return this.fail(planAllowed ? 'The Claude Code program that comes with ros.ai is missing on this computer. Run npm ci, then try again.' : 'A Claude subscription can only be used in the local app.');
    // Its input stays open so it waits for the browser instead of giving up.
    const child = spawn(binary, ['auth', 'login', '--claudeai'], { env: planEnvironment(), stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    const login: ClaudePlanLogin & { child?: ChildProcess } = { state: 'waiting', message: 'Finish signing in on the Claude page that opened in your browser.', command: terminalCommand(binary), child };
    this.login = login;
    const timer = setTimeout(() => { if (login.state === 'waiting') { login.state = 'failed'; login.message = 'Sign-in timed out. Try again, or sign in from Terminal.'; child.kill(); } }, LOGIN_SECONDS * 1000);
    child.on('error', () => { clearTimeout(timer); if (login.state === 'waiting') { login.state = 'failed'; login.message = 'Claude Code could not start its sign-in.'; } });
    child.on('close', code => {
      clearTimeout(timer);
      delete login.child;
      this.forget();
      if (login.state !== 'waiting') return;
      void this.check(true).then(status => {
        if (status.state === 'signed-in') { login.state = 'completed'; login.message = 'Signed in with your Claude subscription.'; }
        else { login.state = 'failed'; login.message = code === 0 ? 'Claude Code finished without signing in to a Claude subscription.' : 'Sign-in did not finish. Try again, or sign in from Terminal.'; }
      });
    });
    return this.loginState()!;
  }

  cancelLogin(): ClaudePlanLogin | null {
    if (this.login?.state === 'waiting') { this.login.state = 'cancelled'; this.login.message = 'Sign-in cancelled.'; this.login.child?.kill(); }
    return this.loginState();
  }

  shutdown() { this.login?.child?.kill(); }

  private fail(message: string): ClaudePlanLogin {
    this.login = { state: 'failed', message, command: null };
    return this.loginState()!;
  }
}

function terminalCommand(binary: string) {
  return `${/[\s'"]/.test(binary) ? `"${binary}"` : binary} auth login`;
}

async function* idle(signal: AbortSignal): AsyncGenerator<never> { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }

const SEEN_LABELS: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet' };
/** The windows Claude Code's /usage shows, in its order; ones it leaves empty are skipped. */
function planWindows(limits: NonNullable<SDKControlGetUsageResponse['rate_limits']>): PlanWindow[] {
  const rows: PlanWindow[] = [];
  const add = (label: string, item: { utilization: number | null; resets_at: string | null } | null | undefined) => {
    if (item && typeof item.utilization === 'number' && Number.isFinite(item.utilization)) rows.push({ label, usedPercent: Math.min(100, Math.max(0, item.utilization)), resetsAt: item.resets_at });
  };
  add('5-hour', limits.five_hour);
  add('Weekly', limits.seven_day);
  add('Weekly Opus', limits.seven_day_opus);
  add('Weekly Sonnet', limits.seven_day_sonnet);
  for (const item of limits.model_scoped ?? []) add(`Weekly ${item.display_name}`, item);
  if (limits.extra_usage?.is_enabled) add('Extra usage this month', { utilization: limits.extra_usage.utilization, resets_at: null });
  return rows;
}
