import test from 'node:test';
import assert from 'node:assert/strict';

// Codex runs inside ros.ai on the person's ChatGPT subscription or on the OpenAI API key from the Agents page. These check
// what ros.ai hands the Codex process: read-only and kept to the project either way, and the key only on the key.
const { codexProcessArgs, childEnvironment, codexIsolation } = await import('../src/server/codex-app-server.js');
const { tokenUsd } = await import('../src/server/codex-agent.js');

const config = (args: string[]) => new Map(args.flatMap((arg, index) => args[index - 1] === '-c' ? [arg.split(/=(.*)/su).slice(0, 2) as [string, string]] : []));
const protocol = { appServer: true, dynamicTools: true, interrupt: true, restrictedReadAccess: false, permissionProfiles: false };
const api = { key: 'sk-test-codex', home: '/data/codex-api', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4' };
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test('older Codex keeps read roots, newer Codex uses the permission profile, and a Codex with neither does not run inside ros.ai', () => {
  assert.equal(codexIsolation({ ...protocol, restrictedReadAccess: true, permissionProfiles: true }), 'read-roots');
  assert.equal(codexIsolation({ ...protocol, permissionProfiles: true }), 'profile');
  assert.equal(codexIsolation(protocol), null);
  const roots = config(codexProcessArgs('/work/project'));
  assert.equal(roots.get('sandbox_mode'), '"read-only"');
  assert.equal(roots.has('default_permissions'), false);
});

test('on a ChatGPT subscription Codex is read-only, offline apart from its own search, kept to the project and signs in itself', () => {
  const plan = config(codexProcessArgs('/work/project', { isolation: 'profile' }));
  assert.equal(plan.get('sandbox_mode'), '"read-only"');
  assert.equal(plan.get('default_permissions'), '"ros_ai"');
  assert.equal(plan.get('permissions.ros_ai.filesystem'), '{":minimal"="read","/work/project"="read"}');
  assert.equal(plan.get('permissions.ros_ai.network.enabled'), 'false');
  assert.equal(plan.get('web_search'), '"live"');
  assert.equal(plan.get('model_provider'), '"ros_ai_local"');
  assert.equal(plan.get('model_providers.ros_ai_local.requires_openai_auth'), 'true');
  for (const key of ['model', 'model_providers.ros_ai_local.env_key', 'model_providers.ros_ai_local.base_url']) assert.equal(plan.has(key), false, key);
});

test('on an OpenAI API key Codex bills only that key, through its own provider and home, and the key stays off the command line', () => {
  const args = codexProcessArgs('/work/project', { isolation: 'profile', api });
  const key = config(args);
  assert.equal(key.get('model_provider'), '"ros_ai_api"');
  assert.equal(key.get('model_providers.ros_ai_api.requires_openai_auth'), 'false');
  assert.equal(key.get('model_providers.ros_ai_api.env_key'), '"OPENAI_API_KEY"');
  assert.equal(key.get('model_providers.ros_ai_api.base_url'), '"https://api.openai.com/v1"');
  assert.equal(key.get('model_providers.ros_ai_api.request_max_retries'), '0');
  assert.equal(key.get('model'), '"gpt-5.4"');
  assert.equal(key.get('sandbox_mode'), '"read-only"');
  assert.equal(key.get('default_permissions'), '"ros_ai"');
  assert.ok(!args.some(arg => arg.includes(api.key)));

  const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CODEX_HOME: process.env.CODEX_HOME };
  process.env.OPENAI_API_KEY = 'sk-server-openai';
  process.env.ANTHROPIC_API_KEY = 'sk-server-anthropic';
  process.env.CODEX_HOME = '/home/person/.codex';
  try {
    const onKey = childEnvironment(api);
    assert.equal(onKey.OPENAI_API_KEY, api.key);
    assert.equal(onKey.CODEX_HOME, api.home);
    assert.equal(onKey.ANTHROPIC_API_KEY, undefined);
    const onPlan = childEnvironment();
    assert.equal(onPlan.OPENAI_API_KEY, undefined);
    assert.equal(onPlan.ANTHROPIC_API_KEY, undefined);
    assert.equal(onPlan.CODEX_HOME, '/home/person/.codex');
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('a turn on the key is priced from the token counts Codex reports, with cached input and reasoning', () => {
  const counts = { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 10_000, totalTokens: 1_010_000 };
  near(tokenUsd('gpt-5.4', counts), 1.5 + 0.1 + 0.15);
  near(tokenUsd('gpt-5.4-mini', counts), 0.45 + 0.03 + 0.045);
  // Reasoning tokens Codex leaves out of outputTokens still count, as output.
  near(tokenUsd('gpt-5.4', { ...counts, totalTokens: 1_030_000 }), 1.5 + 0.1 + 0.45);
});
