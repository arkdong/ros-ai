import type { CodexRateLimit, CodexRateLimits, ProviderBalance } from '../shared/budget-report.js';
import type { CloudAccount } from './cloud-account.js';
import type { ProviderUsage } from './provider-usage.js';

const money = (usd: number) => `US$${usd.toFixed(2)}`;
const credits = (value: number) => `${new Intl.NumberFormat('en-US').format(value)} credits`;
const key = (name: string) => Boolean(process.env[name]?.trim());
const window = (limit: CodexRateLimit) => limit.windowMinutes === null ? 'plan' : limit.windowMinutes >= 1440 * 6 ? 'weekly' : limit.windowMinutes >= 60 ? `${Math.round(limit.windowMinutes / 60)}-hour` : `${limit.windowMinutes}-minute`;
const resets = (limit: CodexRateLimit) => limit.resetsAt ? `, resets ${new Date(limit.resetsAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : '';

/** What each connected model, agent or tool says is left. Providers without a balance API say so. */
export async function providerBalances(sources: { usage: ProviderUsage; cloud?: CloudAccount; codex?: () => { checkedAt: string; limits: CodexRateLimits } | null }): Promise<ProviderBalance[]> {
  const rows: ProviderBalance[] = [];
  const cloud = await sources.cloud?.status().catch(() => null);
  if (cloud?.state === 'signed-in') rows.push({ id: 'ros-cloud', name: 'Ros (hosted)', left: typeof cloud.leftTodayUsd === 'number' ? `${money(cloud.leftTodayUsd)} left today` : null, detail: typeof cloud.dailyUsd === 'number' ? `Free allowance of ${money(cloud.dailyUsd)} a day.` : cloud.error ?? 'ros.ai cloud did not report an allowance.', link: null, checkedAt: new Date().toISOString() });
  const codex = sources.codex?.();
  if (codex) {
    const limits = [codex.limits.primary, codex.limits.secondary].filter((item): item is CodexRateLimit => Boolean(item));
    rows.push({ id: 'codex', name: 'Codex', left: limits.length ? `${Math.round(100 - limits[0].usedPercent)}% of ${window(limits[0])} limit left` : null, detail: limits.length ? limits.map(item => `${Math.round(100 - item.usedPercent)}% of the ${window(item)} limit left${resets(item)}`).join('. ') + '. From your ChatGPT plan.' : 'Codex did not report plan limits.', link: null, checkedAt: codex.checkedAt });
  }
  if (key('TAVILY_API_KEY')) {
    const tavily = (await sources.usage.read()).tavily, account = tavily.account;
    const plan = account && account.planLimit !== null && account.planUsage !== null ? Math.max(0, account.planLimit - account.planUsage) : null;
    const paygo = account && account.paygoLimit !== null && account.paygoUsage !== null ? Math.max(0, account.paygoLimit - account.paygoUsage) : null;
    rows.push({ id: 'tavily', name: 'Tavily', left: plan !== null ? `${credits(plan)} left` : null,
      detail: tavily.status === 'disabled' ? 'Balance checks are turned off on this computer.' : tavily.error ?? (account ? `${account.plan ? `${account.plan} plan: ` : ''}${credits(account.planUsage ?? 0)} of ${account.planLimit === null ? 'an unlimited plan' : credits(account.planLimit)} used${paygo ? `, plus ${credits(paygo)} pay as you go` : ''}.` : 'Checking with Tavily…'),
      link: 'https://app.tavily.com/', checkedAt: tavily.fetchedAt });
  }
  // These providers have no balance API for an ordinary key; their own consoles show it.
  if (key('NEBIUS_API_KEY')) rows.push({ id: 'nebius', name: 'Nebius Token Factory', left: null, detail: 'Nebius does not share your credit with apps. Your Token Factory console shows it.', link: 'https://tokenfactory.nebius.com/', checkedAt: null });
  if (key('OPENAI_API_KEY')) rows.push({ id: 'openai', name: 'OpenAI', left: null, detail: 'OpenAI does not share your balance with an API key. Your billing page shows it.', link: 'https://platform.openai.com/settings/organization/billing/overview', checkedAt: null });
  if (key('ANTHROPIC_API_KEY')) rows.push({ id: 'claude', name: 'Claude Code', left: null, detail: 'Anthropic does not share your credit with an API key. The Claude Console shows it.', link: 'https://console.anthropic.com/settings/billing', checkedAt: null });
  return rows;
}
