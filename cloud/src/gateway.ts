import { Router, json, type Request, type Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { caller } from './auth.js';
import { config, type CloudModel } from './config.js';
import { AllowanceError, allowance, reserve, settle } from './ledger.js';

// Same limits as the app: 64 KB of request body, one answer, no streaming, a bounded wait.
const MAX_BODY = '64kb', TIMEOUT_MS = 120_000, PER_ORG_IN_FLIGHT = 4;
// Byte-level tokenizers never produce more tokens than UTF-8 bytes; the fixed part covers the
// chat template, as in the app's own reservation (src/server/providers.ts).
const TEMPLATE_TOKENS = 16_384;
const FORWARDED = ['messages', 'tools', 'tool_choice', 'response_format', 'stop'] as const;

const inFlight = new Map<string, number>();
const fail = (res: Response, status: number, message: string, type = 'invalid_request_error') => res.status(status).json({ error: { message, type } });
const model = (name: unknown) => config.models.find(item => item.name === name);
const usd = (item: CloudModel, input: number, output: number) => (input * item.inputUsdPerMillion + output * item.outputUsdPerMillion) / 1_000_000;

async function who(req: Request, res: Response) {
  const person = await caller(fromNodeHeaders(req.headers));
  if (!person) fail(res, 401, 'Sign in to ros.ai cloud again.', 'authentication_error');
  return person;
}

/** The ros.ai cloud API: OpenAI-compatible, so the app's existing model connection and the
 * agent loop use it unchanged. The provider key lives only here. */
export const gateway = Router();

gateway.get('/v1/models', (_req, res) => {
  res.json({ object: 'list', data: config.models.map(item => ({ id: item.name, object: 'model', owned_by: 'ros.ai', context_length: item.contextTokens, max_output_tokens: item.maxOutputTokens, pricing: { input_usd_per_million: item.inputUsdPerMillion, output_usd_per_million: item.outputUsdPerMillion } })) });
});

gateway.get('/v1/me', async (req, res) => {
  const person = await who(req, res);
  if (!person) return;
  res.json({ user: { id: person.userId, email: person.email, name: person.name }, organization: { id: person.orgId }, allowance: await allowance(person.orgId) });
});

gateway.post('/v1/chat/completions', json({ limit: MAX_BODY }), async (req, res) => {
  const person = await who(req, res);
  if (!person) return;
  const body = req.body as Record<string, unknown>;
  const item = model(body?.model);
  if (!item) return fail(res, 400, `Unknown model. Use one of: ${config.models.map(entry => entry.name).join(', ')}.`);
  if (!Array.isArray(body.messages) || !body.messages.length) return fail(res, 400, 'messages must be a non-empty list.');
  if (body.stream) return fail(res, 400, 'Streaming is not offered yet.');
  if (body.n !== undefined && body.n !== 1) return fail(res, 400, 'Only one answer per request (n = 1).');
  if (!config.upstreamKey) return fail(res, 503, 'ros.ai cloud has no model provider configured yet.', 'server_error');
  const requested = Number(body.max_completion_tokens ?? body.max_tokens ?? item.maxOutputTokens);
  if (!Number.isInteger(requested) || requested < 1) return fail(res, 400, 'max_tokens must be a positive whole number.');
  const maxOutput = Math.min(requested, item.maxOutputTokens);
  const wire: Record<string, unknown> = { model: item.upstream, n: 1, temperature: item.temperature, max_completion_tokens: maxOutput };
  for (const key of FORWARDED) if (body[key] !== undefined) wire[key] = body[key];
  const text = JSON.stringify(wire), inputBound = Buffer.byteLength(text, 'utf8') + TEMPLATE_TOKENS;
  if (inputBound > item.contextTokens) return fail(res, 400, 'The request is longer than this model accepts.');

  const busy = inFlight.get(person.orgId) ?? 0;
  if (busy >= PER_ORG_IN_FLIGHT) return fail(res, 429, `At most ${PER_ORG_IN_FLIGHT} requests at once per workspace.`, 'rate_limit_error');
  let usageId: string;
  try { usageId = await reserve({ orgId: person.orgId, userId: person.userId, sessionId: person.sessionId, model: item.name, upstreamModel: item.upstream, reservedUsd: usd(item, inputBound, maxOutput) }); }
  catch (error) { if (error instanceof AllowanceError) return fail(res, 402, error.message, 'insufficient_quota'); throw error; }

  inFlight.set(person.orgId, busy + 1);
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });
  try {
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${config.upstreamUrl}/chat/completions`, { method: 'POST', redirect: 'error', signal: abort.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.upstreamKey}` }, body: text });
    } catch {
      // The provider may have started work before the connection broke, so the reservation stands.
      await settle(usageId, 'unknown');
      return fail(res, 502, abort.signal.aborted ? 'The model took too long and the request was stopped.' : 'The model provider could not be reached.', 'server_error');
    }
    const answer = await upstream.json().catch(() => undefined) as any;
    if (!upstream.ok || !answer) {
      // A refused request (4xx) is not billed; anything else keeps the reservation to stay safe.
      await settle(usageId, upstream.status >= 400 && upstream.status < 500 ? 'refused' : 'unknown');
      return fail(res, upstream.status >= 500 || !answer ? 502 : 400, `The model provider refused the request (${upstream.status}).`, 'upstream_error');
    }
    const input = Number(answer.usage?.prompt_tokens), output = Number(answer.usage?.completion_tokens);
    if (Number.isFinite(input) && Number.isFinite(output)) await settle(usageId, { costUsd: usd(item, input, output), inputTokens: input, outputTokens: output, upstreamRequestId: typeof answer.id === 'string' ? answer.id.slice(0, 200) : undefined });
    else await settle(usageId, 'unknown');
    res.setHeader('X-Ros-Cloud-Usage', usageId);
    res.json({ ...answer, model: item.name, ros_cloud: { upstream_model: item.upstream, usage_id: usageId } });
  } finally { clearTimeout(timer); inFlight.set(person.orgId, (inFlight.get(person.orgId) ?? 1) - 1); }
});

/** One free catalogue read at start, so a wrong provider model id shows up in the log at once. */
export async function checkCatalogue() {
  if (!config.upstreamKey) { console.warn('ros.ai cloud: NEBIUS_API_KEY is not set, so chat requests are refused.'); return; }
  try {
    const response = await fetch(`${config.upstreamUrl}/models`, { headers: { Authorization: `Bearer ${config.upstreamKey}` }, signal: AbortSignal.timeout(15_000) });
    const ids = new Set(((await response.json()) as any)?.data?.map((entry: any) => entry.id) ?? []);
    for (const item of config.models) console.log(`ros.ai cloud: ${item.name} -> ${item.upstream} ${ids.has(item.upstream) ? 'is in the provider catalogue' : 'was NOT found in the provider catalogue'}`);
  } catch { console.warn('ros.ai cloud: could not read the provider catalogue.'); }
}
