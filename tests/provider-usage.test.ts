import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTavilyUsage, ProviderUsage } from '../src/server/provider-usage.js';

const response = { key: { usage: 3, limit: null, search_usage: 3, extract_usage: 0, key: 'never-expose' }, account: { current_plan: 'Fixture', plan_usage: 9, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0, search_usage: 9, account_id: 'never-expose' } };
test('Tavily keeps key/account scopes, unknown limits, credit quantities and zero distinct', () => {
  const result = parseTavilyUsage(response);
  assert.equal(result.key?.usage, 3); assert.equal(result.key?.limit, null);
  assert.equal(result.account?.planUsage, 9); assert.equal(result.account?.paygoLimit, 0);
  assert.equal(result.key?.operations.extract, 0); assert.equal(result.key?.operations.research, null);
  assert(!JSON.stringify(result).includes('never-expose'));
  assert.throws(() => parseTavilyUsage({ detail: 'secret' }), /unsupported/);
});
test('usage reads coalesce and cache; refresh failures preserve last successful time and quantities', async () => {
  let now = Date.parse('2026-09-23T10:00:00Z'), calls = 0, failed = false;
  const service = new ProviderUsage(undefined, { key: 'server-only', enabled: true, now: () => now, fetch: async (url, options) => {
    calls++; assert.equal(url, 'https://api.tavily.com/usage');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer server-only');
    return new Response(JSON.stringify(failed ? { secret: 'server-only' } : response), { status: failed ? 401 : 200 });
  } });
  const first = await Promise.all([service.read(), service.read()]);
  assert.equal(calls, 1); assert.equal(first[0].tavily.status, 'fresh');
  now += 30_000; await service.read(); assert.equal(calls, 1);
  now += 31_000; failed = true;
  const stale = await service.read(); assert.equal(calls, 2);
  assert.equal(stale.tavily.status, 'stale'); assert.equal(stale.tavily.key?.usage, 3);
  assert.equal(stale.tavily.fetchedAt, first[0].tavily.fetchedAt);
  assert.equal(stale.tavily.attemptedAt, new Date(now).toISOString());
  assert.equal(stale.tavily.error, 'Tavily usage returned HTTP 401.');
  assert(!JSON.stringify(stale).includes('server-only'));
});
test('missing credentials do not fetch; a manual Nebius report has no invented sync timestamp', async () => {
  const service = new ProviderUsage({ record: () => ({ amountUsd: 42, approximate: true, source: 'user-reported', reportedOn: '2026-09-23', observedAt: null, secret: 'never-expose' }) as never }, { key: '', fetch: async () => { throw new Error('Must not fetch'); } });
  const result = await service.read();
  assert.equal(result.tavily.status, 'unconfigured'); assert.equal(result.tavily.fetchedAt, null);
  assert.deepEqual(result.nebius, { amountUsd: 42, approximate: true, source: 'user-reported', reportedOn: '2026-09-23', observedAt: null });
});
test('a configured credential alone does not enable account usage queries', async () => {
  const service = new ProviderUsage(undefined, { key: 'configured', enabled: false, fetch: async () => { throw new Error('Must not fetch'); } });
  assert.equal((await service.read()).tavily.status, 'disabled');
});
