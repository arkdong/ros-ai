import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { Authority } from '../src/server/authority.js';
import { ExecutionService } from '../src/server/execution.js';
import { InferenceConnections } from '../src/server/inference-connections.js';
import { ToolLoopAgentService } from '../src/server/tool-loop-agent.js';
import { Setup } from '../src/server/setup.js';
import { detectModels } from '../src/server/setup-detect.js';
import type { ExperimentService } from '../src/server/experiments.js';

// Offline doubles of Ollama's and LM Studio's own APIs on loopback ports. No model runs anywhere.
type Chat = { model: string; max_tokens: number; tools?: { function: { name: string } }[]; messages: { role: string; content: string }[] };
const body = (req: IncomingMessage) => new Promise<Record<string, unknown>>(resolve => { let text = ''; req.on('data', chunk => { text += chunk; }); req.on('end', () => resolve(text ? JSON.parse(text) as Record<string, unknown> : {})); });
const send = (res: ServerResponse, value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
async function listen(handle: (req: IncomingMessage, res: ServerResponse, input: Record<string, unknown>) => void) {
  const server = createServer(async (req, res) => handle(req, res, req.method === 'POST' ? await body(req) : {}));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise(resolve => server.close(resolve)) };
}
/** Chat completions as a tool-calling model answers them: one ros_read_canvas call, then a reply. */
function chat(chats: Chat[], input: Record<string, unknown>, res: ServerResponse) {
  const request = input as unknown as Chat; chats.push(request);
  const called = request.messages.some(message => message.role === 'tool');
  const message = request.tools && !called ? { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ros_read_canvas', arguments: '{}' } }] } : { role: 'assistant', content: 'The map has two blocks.' };
  send(res, { id: 'fixture', model: request.model, choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
}
function fakeOllama(defaultContext: number) {
  const shows: Record<string, unknown> = {
    'qwen3:8b': { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 }, parameters: 'top_k                          20' },
    'llama3.1:8b': { capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': 131072 }, parameters: 'num_ctx                        65536\nstop                           "<|eot_id|>"' },
    'gemma3:1b': { capabilities: ['completion'], model_info: { 'gemma3.context_length': 32768 }, parameters: '' },
    'nomic-embed-text': { capabilities: ['embedding'], model_info: { 'nomic-bert.context_length': 2048 } },
  };
  const sizes: Record<string, number> = { 'qwen3:8b': 5_200_000_000, 'llama3.1:8b': 4_900_000_000, 'gemma3:1b': 815_000_000, 'nomic-embed-text': 274_000_000 };
  const loaded = new Map<string, number>(), loads: string[] = [], chats: Chat[] = [];
  return listen((req, res, input) => {
    if (req.url === '/api/tags') return send(res, { models: Object.keys(shows).map(name => ({ name, model: name, size: sizes[name] })) });
    if (req.url === '/api/show') return send(res, shows[String(input.model)]);
    if (req.url === '/api/ps') return send(res, { models: [...loaded].map(([name, context]) => ({ name, model: name, context_length: context })) });
    if (req.url === '/api/generate') {
      const name = String(input.model), trained = (Object.values((shows[name] as { model_info: Record<string, number> }).model_info).find(value => typeof value === 'number')) as number;
      loads.push(name); loaded.set(name, Math.min(defaultContext, trained));
      return send(res, { model: name, response: '', done: true, done_reason: 'load' });
    }
    if (req.url === '/v1/chat/completions') return chat(chats, input, res);
    res.writeHead(404).end();
  }).then(server => ({ ...server, loads, chats }));
}
function fakeLmStudio() {
  return listen((req, res) => {
    if (req.url === '/api/v0/models') return send(res, { object: 'list', data: [
      { id: 'qwen2.5-7b-instruct', object: 'model', type: 'llm', state: 'loaded', max_context_length: 32768, loaded_context_length: 32768, capabilities: ['tool_use'] },
      { id: 'phi-4', object: 'model', type: 'llm', state: 'not-loaded', max_context_length: 16384 },
      { id: 'text-embedding-nomic-embed-text-v1.5', object: 'model', type: 'embeddings', state: 'not-loaded', max_context_length: 2048 },
    ] });
    if (req.url === '/v1/models') return send(res, { data: [{ id: 'qwen2.5-7b-instruct' }, { id: 'phi-4' }] });
    res.writeHead(404).end();
  });
}
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'ros-local-models-')), store = new Store(dir), inference = new InferenceConnections(store, dir);
  const project = store.createProject('Local models');
  store.mutate(project.id, ['a', 'b'].map((id, index) => ({ type: 'addNode' as const, node: { id, title: `Block ${id}`, description: 'Fixture', x: index * 320, y: 0 } })), 'Fixture');
  new Authority(store).configure(project.id, { mode: 'ask' });
  return { dir, store, inference, project, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const caps = { maxInputBytes: 64000, maxOutputTokens: 8000, timeoutMs: 30000, maxConcurrent: 1, maxResponseBytes: 256000 };
function connect(inference: InferenceConnections, port: number, models: { id: string; contextTokens: number; tools?: boolean }[]) {
  const connection = inference.create({ name: 'Ollama', endpoint: `http://127.0.0.1:${port}/v1`, enabled: true, caps, models: models.map(model => ({ ...model, label: model.id, inputUsdPerMillion: 0, outputUsdPerMillion: 0 })) });
  inference.saveAllowance(connection.id, { requestCeiling: 100, usdCeiling: 0, enabled: true, acknowledged: true });
  return connection.id;
}

test('Scanning reads each local model\'s context and tool support; connecting loads one Ollama model to learn its default context', async () => {
  const ollama = await fakeOllama(8192), lmStudio = await fakeLmStudio(), f = workspace();
  const saved = { ollama: process.env.OLLAMA_HOST, lmStudio: process.env.ROS_LMSTUDIO_URL };
  process.env.OLLAMA_HOST = `127.0.0.1:${ollama.port}`; process.env.ROS_LMSTUDIO_URL = `http://localhost:${lmStudio.port}`;
  try {
    const [found, studio] = await detectModels();
    const ollamaModel = (id: string) => found.details.find(item => item.id === id);
    assert.equal(found.endpoint, `http://127.0.0.1:${ollama.port}/v1`);
    assert.deepEqual(ollamaModel('qwen3:8b'), { id: 'qwen3:8b', context: null, maxContext: 40960, tools: true, embedding: false, bytes: 5_200_000_000 });
    assert.equal(ollamaModel('llama3.1:8b')!.context, 65536, 'a context set on the model itself');
    assert.equal(ollamaModel('gemma3:1b')!.tools, false);
    assert.equal(ollamaModel('nomic-embed-text')!.embedding, true);
    assert.deepEqual(ollama.loads, [], 'scanning never loads a model');
    assert.deepEqual(studio.details.map(item => [item.id, item.context, item.tools, item.embedding]), [['qwen2.5-7b-instruct', 32768, true, false], ['phi-4', null, null, false], ['text-embedding-nomic-embed-text-v1.5', null, null, true]]);

    const setup = new Setup({ dataDir: f.dir, inference: f.inference, outside: { bridge: 'bridge', seen: () => null }, credentials: { statuses: () => [] }, plugins: { statuses: () => [] }, cloud: { status: async () => ({ available: false, state: 'signed-out' }) } } as unknown as ConstructorParameters<typeof Setup>[0]);
    const linked = await setup.link({ models: ['ollama', 'lm-studio'] });
    assert(linked.models.every(item => item.ok), JSON.stringify(linked.models));
    assert.deepEqual(ollama.loads, ['qwen3:8b'], 'one load: the smallest model without its own context that calls tools');
    const registered = (name: string) => f.inference.statuses().find(item => item.name === name)!;
    // Models that call tools come first; embedding models are left out; unknown LM Studio contexts are 4,096.
    assert.deepEqual(registered('Ollama').models.map(model => [model.id, model.contextTokens, model.tools]), [['qwen3:8b', 8192, true], ['llama3.1:8b', 65536, true], ['gemma3:1b', 8192, false]]);
    assert.deepEqual(registered('LM Studio').models.map(model => [model.id, model.contextTokens, model.tools]), [['qwen2.5-7b-instruct', 32768, true], ['phi-4', 4096, undefined]]);
    assert.equal(registered('Ollama').caps.timeoutMs, 300000);
    assert.equal(registered('Ollama').ready, true);
    // A second connect is a refresh: the same connection, and Ollama's default is now read from the loaded model.
    await setup.link({ models: ['ollama'] });
    assert.deepEqual(ollama.loads, ['qwen3:8b']);
    assert.equal(f.inference.statuses().filter(item => item.name === 'Ollama').length, 1);
  } finally {
    if (saved.ollama === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = saved.ollama;
    if (saved.lmStudio === undefined) delete process.env.ROS_LMSTUDIO_URL; else process.env.ROS_LMSTUDIO_URL = saved.lmStudio;
    await ollama.close(); await lmStudio.close(); f.close();
  }
});

test('A local request fits its model\'s context: the answer gets the room left, and too little room says what to change', async () => {
  const ollama = await fakeOllama(8192), f = workspace();
  const id = connect(f.inference, ollama.port, [{ id: 'big', contextTokens: 32768 }, { id: 'mid', contextTokens: 16384 }, { id: 'small', contextTokens: 8192 }]);
  const execution = new ExecutionService(f.store, { inference: f.inference, includeSetupUsage: false });
  // About 30 KB of request: some 10,300 tokens at three bytes a token.
  const request = { messages: [{ role: 'system' as const, content: 'x'.repeat(30_000) }, { role: 'user' as const, content: 'Hello' }], maxOutputTokens: 8000 };
  try {
    await execution.assistantComplete(f.project.id, request, new AbortController().signal, { provider: id, model: 'big' });
    assert.equal(ollama.chats.at(-1)!.max_tokens, 8000);
    await execution.assistantComplete(f.project.id, request, new AbortController().signal, { provider: id, model: 'mid' });
    const shortened = ollama.chats.at(-1)!.max_tokens;
    assert(shortened < 8000 && shortened > 5000, `max_tokens ${shortened}`);
    await assert.rejects(execution.assistantComplete(f.project.id, request, new AbortController().signal, { provider: id, model: 'small' }), /8,192-token context on Ollama\. Raise the model's context length/u);
    assert.equal(ollama.chats.length, 2, 'a request that cannot fit is never sent');
  } finally { await execution.shutdown(); await ollama.close(); f.close(); }
});

test('ROS\'s agent works step by step on a local model that calls tools, and says why it cannot on one without tools or room', async () => {
  const ollama = await fakeOllama(8192), f = workspace();
  const id = connect(f.inference, ollama.port, [{ id: 'agent', contextTokens: 32768, tools: true }, { id: 'chat-only', contextTokens: 32768, tools: false }, { id: 'tiny', contextTokens: 8192, tools: true }]);
  const execution = new ExecutionService(f.store, { inference: f.inference, includeSetupUsage: false });
  const experiments = { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService;
  const loop = new ToolLoopAgentService(f.store, execution, experiments);
  try {
    assert.match(loop.readiness(f.project.id, { provider: id, model: 'chat-only' }).reason!, /chat-only cannot call tools in Ollama/u);
    assert.match(loop.readiness(f.project.id, { provider: id, model: 'tiny' }).reason!, /8,192-token context in Ollama; working step by step needs at least 16k/u);
    execution.models.update(f.project.id, { selection: { provider: id, model: 'agent' } });
    assert.deepEqual(loop.readiness(f.project.id, { provider: id, model: 'agent' }), { available: true, reason: null });
    const result = await loop.execute({ projectId: f.project.id, nodeIds: [], artifactIds: [], turnId: 'turn-1', message: 'What is on the map?', signal: new AbortController().signal, onEvent: () => {}, selection: { provider: id, model: 'agent' } });
    assert.equal(result.reply, 'The map has two blocks.');
    assert.equal(ollama.chats.length, 2);
    assert(ollama.chats[0]!.tools!.some(tool => tool.function.name === 'ros_read_canvas'));
    assert.match(JSON.stringify(ollama.chats[1]!.messages.at(-1)), /Block a/u, 'the canvas read went back to the model');
  } finally { await loop.shutdown(); await execution.shutdown(); await ollama.close(); f.close(); }
});
