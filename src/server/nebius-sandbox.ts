import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ExecutionBackend, RemoteExecutionState, SandboxCapabilities, SandboxHandle, SandboxInput, SandboxOutput, SandboxResult } from './sandbox.js';

const API = 'https://api.tokenfactory.nebius.com/sandboxes/v1';
export const NEBIUS_SANDBOX_IMAGE = '4fa16c8f-62a9-35a4-a4ea-07b7e8cd44ae';
const MAX_RESPONSE_BYTES = 2_500_000;
const MAX_CAPTURE_BYTES = 500_000;
const uuid = z.string().uuid();
const terminal = new Set(['SUCCESS', 'FAILED', 'CANCELLED']);
const workerPath = fileURLToPath(new URL('./sandbox/nebius_worker.py', import.meta.url));
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const streamSchema = z.object({ value: z.string().max(700_000), encoding: z.enum(['ascii', 'base64']), truncated: z.boolean().optional() }).passthrough();
const operationSchema = z.object({
  uuid, kind: z.literal('instance'), status: z.enum(['PENDING', 'ASSIGNED', 'EXECUTING', 'SUCCESS', 'FAILED', 'CANCELLED']),
  error: z.string().max(20_000).nullable().optional(), image_uuid: uuid.nullable().optional(),
  metadata: z.object({ result: z.object({
    state: z.object({ exit_code: z.number().int().nullable().optional(), signal: z.number().int().nullable().optional(), timed_out: z.boolean().optional() }).passthrough().optional(),
    stdout: streamSchema.optional(), stderr: streamSchema.optional(),
    resources: z.object({ cost: z.number().finite().nonnegative().nullable().optional() }).passthrough().optional(),
  }).passthrough().nullable().optional() }).passthrough().optional(),
}).passthrough();
type Operation = z.infer<typeof operationSchema>;
const outputSchema = z.object({
  kind: z.enum(['table', 'metric', 'plot', 'result', 'dataset']), title: z.string().trim().min(1).max(200),
  content: z.string().refine(value => Buffer.byteLength(value) <= 100_000, 'Output exceeds 100 KB.'),
  mediaType: z.enum(['application/json', 'image/svg+xml', 'text/plain', 'text/csv']),
}).strict();
const captureSchema = z.object({
  ok: z.boolean(), outputs: z.array(outputSchema).max(20), stdout: z.string(), stderr: z.string(),
  runtime: z.string().min(1).max(1000), error: z.string().max(2000).nullable(),
}).strict();
const now = () => new Date().toISOString();
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const bounded = (value: number | undefined, fallback: number, min: number, max: number) => Number.isFinite(value) ? Math.min(max, Math.max(min, value!)) : fallback;

class RemoteError extends Error {}
function decode(stream: z.infer<typeof streamSchema>): string {
  if (stream.truncated) throw new RemoteError('Nebius truncated the captured stream; a complete result is unavailable.');
  if (stream.encoding === 'ascii') {
    if (!/^[\x00-\x7f]*$/.test(stream.value)) throw new RemoteError('Malformed ASCII stream from Nebius.');
    return stream.value;
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(stream.value)) throw new RemoteError('Malformed base64 stream from Nebius.');
  const decoded = Buffer.from(stream.value, 'base64');
  if (decoded.toString('base64') !== stream.value) throw new RemoteError('Malformed base64 stream from Nebius.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(decoded); }
  catch { throw new RemoteError('Nebius returned invalid UTF-8 output.'); }
}

// Model-written Python can forge its stdout. Only inert SVG primitives may be
// promoted to a plot artifact; the guest worker is not an integrity boundary.
function validateSvg(content: string): boolean {
  if (!/^<svg\b/.test(content) || !/<\/svg>\s*$/.test(content) || /<\?|<!/.test(content)) return false;
  const names = new Set(['svg', 'g', 'rect', 'line', 'polyline', 'polygon', 'circle', 'text', 'title', 'desc', 'path']);
  const attrs = new Set(['xmlns', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'points', 'd', 'fill', 'stroke', 'stroke-width', 'font-size', 'font-family', 'text-anchor', 'dominant-baseline', 'transform', 'role', 'aria-label']);
  const stack: string[] = []; let closedRoot = false;
  for (const match of content.matchAll(/<([^>]*)>/g)) {
    const tag = match[1];
    if (/^\/[a-z]+\s*$/.test(tag)) {
      if (stack.pop() !== tag.slice(1).trim()) return false;
      if (!stack.length) closedRoot = true;
      continue;
    }
    const name = /^([a-z]+)(?=\s|\/|$)/.exec(tag)?.[1];
    if (!name || !names.has(name) || closedRoot) return false;
    if (!/\/\s*$/.test(tag)) stack.push(name);
    let remainder = tag.slice(name.length).replace(/\/\s*$/, '').trim();
    while (remainder) {
      const attribute = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')\s*/.exec(remainder);
      if (!attribute || !attrs.has(attribute[1])) return false;
      const value = attribute[2] ?? attribute[3];
      if (/[&\\]|url\s*\(|[\x00-\x1f]/i.test(value)) return false;
      if (attribute[1] === 'xmlns' && value !== 'http://www.w3.org/2000/svg') return false;
      remainder = remainder.slice(attribute[0].length);
    }
  }
  return closedRoot && !stack.length && !content.replace(/<[^>]*>/g, '').includes('<');
}
function validateOutput(output: SandboxOutput): void {
  const media = { table: 'application/json', metric: 'application/json', plot: 'image/svg+xml', result: 'text/plain', dataset: 'text/csv' };
  if (output.mediaType !== media[output.kind]) throw new RemoteError('Nebius output kind and media type disagree.');
  if (output.kind === 'plot' && !validateSvg(output.content)) throw new RemoteError('Nebius returned an unsupported or active SVG plot.');
  if (output.kind === 'metric') z.object({ value: scalar }).strict().parse(JSON.parse(output.content));
  if (output.kind === 'table') z.array(z.record(z.string().max(200), scalar).refine(row => Object.keys(row).length <= 100)).max(10_000).parse(JSON.parse(output.content));
}

/** One disposable cloud operation per attempt; authority/spend admission remains
 * the caller's responsibility. Construction never probes or starts cloud work.
 */
export class NebiusSandboxBackend implements ExecutionBackend {
  // Keys saved from Connections update process.env at runtime, so read them per use.
  private readonly options: { apiKey?: string; projectId?: string };
  private get apiKey() { return this.options.apiKey ?? process.env.NEBIUS_SANDBOX_API_KEY ?? process.env.NEBIUS_API_KEY ?? ''; }
  private get projectId() { return this.options.projectId ?? process.env.NEBIUS_SANDBOX_PROJECT_ID ?? process.env.NEBIUS_PROJECT_ID ?? process.env.NEBIUS_AI_PROJECT ?? process.env.CONTREE_PROJECT ?? ''; }
  private readonly imageId: string;
  private readonly fetcher: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly completionTimeoutMs: number;
  private readonly worker: string;
  private readonly base: SandboxCapabilities;

  constructor(options: { apiKey?: string; projectId?: string; imageId?: string; fetch?: typeof fetch; pollIntervalMs?: number; requestTimeoutMs?: number; completionTimeoutMs?: number } = {}) {
    this.options = { apiKey: options.apiKey, projectId: options.projectId };
    this.imageId = options.imageId ?? process.env.ROS_NEBIUS_SANDBOX_IMAGE_ID ?? process.env.NEBIUS_SANDBOX_IMAGE_ID ?? NEBIUS_SANDBOX_IMAGE;
    this.fetcher = options.fetch ?? fetch;
    this.pollIntervalMs = bounded(options.pollIntervalMs, 1000, 1, 10_000);
    this.requestTimeoutMs = bounded(options.requestTimeoutMs, 10_000, 10, 15_000);
    this.completionTimeoutMs = bounded(options.completionTimeoutMs, 90_000, 50, 180_000);
    this.worker = readFileSync(workerPath, 'utf8');
    this.base = {
      available: false, backend: 'nebius-sandbox', policy: 'nebius-disposable-stdlib-v1',
      runtime: 'Configured Python 3.12 standard library on Nebius; remote runtime not yet probed',
      workerHash: createHash('sha256').update(JSON.stringify({ worker: this.worker, image: this.imageId, policy: 'nebius-disposable-stdlib-v1' })).digest('hex'),
      imageId: uuid.safeParse(this.imageId).success ? this.imageId : null, libraries: {}, timeoutMs: 30_000, maxMemoryMb: null, maxOutputBytes: MAX_CAPTURE_BYTES,
      exampleCode: 'values = [float(row["value"]) for row in rows]\nmetric("Mean", sum(values) / len(values))\ntable("Values", [{"value": value} for value in values])\nplot("Values", values)',
      dataContract: 'Python standard library only. Captured CSV is rows: list of dictionaries with string values; parameters are params. Helpers: table(title, records), metric(title, scalar), plot(title, numeric_values, optional_labels), export_csv(title, records), conclusion(text). No pandas, NumPy, SciPy or matplotlib is promised.',
      enforcement: [
        'Provider request: disposable VM, network interface disabled, non-root UID/GID 65534, explicit credential-free environment, at most 30 seconds execution and 64 MiB writable layer.',
        'Worker process requests CPU, address-space, process, file-size and file-descriptor limits; these do not establish a provider-wide CPU/RAM quota.',
        'Only the captured CSV, code and parameters leave this machine via stdin; no host paths, credentials, images or upload objects are exposed to model-written code.',
        '20 outputs, 100 KB each, 500 KB result bundle; bounded response decoding. Stop requests cancellation and polls its terminal state.',
      ],
      limitations: [
        'Availability means configured only. Account access, runtime behavior and billing need separate verification and permission.',
        'Provider VM isolation and resource controls are documented claims. No configurable provider CPU/RAM cap is published; maxMemoryMb is unknown.',
        'Sandbox pricing and cost units are unverified. Raw provider cost is recorded with unknown units, never treated as USD or free.',
        'Disposable runs omit filesystem checkpoints; provider retention of input/operation logs is unspecified.',
        'A lost spawn response can leave execution uncertain; it is never automatically submitted again. Restart reconciles only known operation IDs.',
      ],
    };
  }
  private get value(): SandboxCapabilities {
    const configured = Boolean(this.apiKey && this.projectId && !/[\r\n]/.test(this.apiKey + this.projectId) && uuid.safeParse(this.imageId).success);
    return { ...this.base, available: configured,
      limitations: [...(!configured ? ['Nebius sandbox API token, project ID and valid pinned image UUID are required.'] : []), ...this.base.limitations] };
  }
  capabilities(): SandboxCapabilities { return structuredClone(this.value); }

  private async request(path: string, method = 'GET', body?: unknown, onResponse?: (response: Response) => void): Promise<{ response: Response; value?: unknown }> {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const work = async () => {
      const response = await this.fetcher(`${API}${path}`, { method, redirect: 'manual', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, Project: this.projectId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (controller.signal.aborted) { void response.body?.cancel(); throw new RemoteError('Nebius request finished after its local deadline; outcome remains uncertain.'); }
      if (response.status < 200 || response.status >= 300) throw new RemoteError(`Nebius sandbox ${method} returned HTTP ${response.status}.`);
      if (method === 'DELETE') {
        if (response.status !== 202) throw new RemoteError('Nebius did not acknowledge cancellation.');
        await response.body?.cancel(); return { response };
      }
      if (method === 'POST' && response.status !== 201) throw new RemoteError('Nebius returned an unexpected submission status.');
      if (method === 'GET' && response.status !== 200) throw new RemoteError('Nebius returned an unexpected operation status response.');
      onResponse?.(response);
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw new RemoteError('Nebius response exceeds the bounded size.');
      reader = response.body?.getReader();
      if (!reader) throw new RemoteError('Nebius returned an empty response.');
      const chunks: Uint8Array[] = []; let count = 0;
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; count += chunk.value.byteLength; if (count > MAX_RESPONSE_BYTES) throw new RemoteError('Nebius response exceeds the bounded size.'); chunks.push(chunk.value); }
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new RemoteError('Nebius returned malformed JSON.'); }
      return { response, value };
    };
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => { deadline = setTimeout(() => { controller.abort(); reject(new RemoteError('Nebius sandbox request timed out; submission or cancellation may be uncertain.')); }, this.requestTimeoutMs); })]);
    } catch (error) { if (error instanceof RemoteError) throw error; throw new RemoteError('Nebius sandbox transport failed; its remote outcome may be uncertain.'); }
    finally { clearTimeout(deadline); controller.abort(); void reader?.cancel().catch(() => {}); }
  }
  private operationId(response: Response): string {
    const location = response.headers.get('location');
    if (!location) throw new RemoteError('Nebius submission did not provide an operation Location.');
    const url = new URL(location, API + '/');
    if (url.origin !== new URL(API).origin || url.username || url.password || url.search || url.hash) throw new RemoteError('Nebius returned an unsafe operation Location.');
    const id = /^\/(?:sandboxes\/)?v1\/operations\/([^/]+)$/.exec(url.pathname)?.[1];
    if (!id || !uuid.safeParse(id).success) throw new RemoteError('Nebius returned an invalid operation Location.');
    return id;
  }
  private async status(operationId: string): Promise<{ operation: Operation; retryMs: number }> {
    const { response, value } = await this.request(`/operations/${operationId}`);
    const parsed = operationSchema.safeParse(value);
    if (!parsed.success || parsed.data.uuid !== operationId) throw new RemoteError('Nebius returned malformed or mismatched operation metadata.');
    const retry = response.headers.get('retry-after');
    return { operation: parsed.data, retryMs: retry && /^\d+$/.test(retry) ? Math.min(10_000, Math.max(this.pollIntervalMs, Number(retry) * 1000)) : this.pollIntervalMs };
  }
  private state(operation: Operation, base: RemoteExecutionState): RemoteExecutionState {
    return { ...base, status: operation.status, phase: terminal.has(operation.status) ? 'terminal' : 'running',
      ...(typeof operation.metadata?.result?.resources?.cost !== 'number' ? {} : { rawCost: operation.metadata.result.resources.cost, costUnit: 'unknown' as const }) };
  }
  private async cancelAndWait(operationId: string, initial: RemoteExecutionState, onProgress?: (state: RemoteExecutionState) => void): Promise<RemoteExecutionState> {
    let state: RemoteExecutionState = { ...initial, operationId, phase: 'cancelling', cancellationConfirmed: false };
    const report = () => { try { onProgress?.(structuredClone(state)); } catch { /* Cleanup must continue even when its storage callback fails. */ } };
    report();
    const until = Date.now() + Math.min(this.completionTimeoutMs, 15_000);
    try { await this.request(`/operations/${operationId}`, 'DELETE'); }
    catch { /* It may have already finished or accepted a lost cancellation. Poll its actual state. */ }
    while (Date.now() < until) {
      try {
        const { operation, retryMs } = await this.status(operationId);
        if (terminal.has(operation.status)) { state = { ...this.state(operation, state), cancellationConfirmed: true }; report(); return state; }
        state.status = operation.status; report();
        await new Promise(resolve => setTimeout(resolve, Math.min(retryMs, Math.max(0, until - Date.now()))));
      } catch (error) { state.error = (error as Error).message; break; }
    }
    state = { ...state, phase: 'uncertain', cancellationConfirmed: false, error: state.error ?? 'Nebius did not confirm a terminal state after cancellation.' }; report(); return state;
  }

  /** Recovery never submits work. It cancels the known operation and observes a
   * terminal state before reporting confirmed remote termination. */
  async reconcile(operationId: string, onProgress?: (state: RemoteExecutionState) => void): Promise<RemoteExecutionState> {
    if (!this.value.available) throw new Error('Nebius sandbox is not configured.');
    uuid.parse(operationId);
    return this.cancelAndWait(operationId, { operationId, phase: 'cancelling' }, onProgress);
  }

  start(input: SandboxInput): SandboxHandle {
    if (!this.value.available) throw new Error('Nebius sandbox is not configured.');
    if (typeof input.code !== 'string' || !input.code.trim() || Buffer.byteLength(input.code) > 20_000) throw new Error('Nebius code must be 1-20,000 UTF-8 bytes.');
    if (typeof input.csv !== 'string' || Buffer.byteLength(input.csv) > 500_000) throw new Error('Nebius captured CSV exceeds 500 KB.');
    const parameters = z.record(z.string().max(100), z.union([z.string().max(1000), z.number().finite(), z.boolean()])).parse(input.parameters);
    const payload = { code: input.code, csv: input.csv, parameters };
    if (bytes(payload) > 650_000) throw new Error('Nebius input exceeds 650 KB.');
    const timeout = Math.ceil(bounded(input.timeoutMs, 30_000, 1000, 30_000) / 1000);
    const startedAt = now(); let stopped: string | undefined, wake: (() => void) | undefined;
    let state: RemoteExecutionState = { phase: 'submitting' }, submitted = false;
    const emit = (next: RemoteExecutionState) => {
      state = next;
      try { input.onProgress?.(structuredClone(state)); }
      catch { throw new RemoteError('Remote progress could not be saved; execution cannot continue without durable tracking.'); }
    };
    const cleanup = async () => {
      if (state.operationId) state = await this.cancelAndWait(state.operationId, state, next => { state = next; input.onProgress?.(structuredClone(next)); });
      else if (submitted) { state = { ...state, phase: 'uncertain', cancellationConfirmed: false, error: 'Submission outcome is unknown; no operation ID was captured. No automatic retry.' }; try { input.onProgress?.(structuredClone(state)); } catch { /* Return exact uncertainty even if storage is unavailable. */ } }
    };
    const execute = async (): Promise<SandboxResult> => {
      const result: SandboxResult = { status: 'failed', outputs: [], stdout: '', stderr: '', exitCode: null, signal: null, runtime: this.value.runtime, startedAt, endedAt: startedAt, enforcement: [...this.value.enforcement] };
      try {
        emit({ phase: 'submitting' }); // Caller must persist this before the only POST.
        if (stopped) { emit({ phase: 'terminal', cancellationConfirmed: true }); throw new RemoteError(stopped); }
        submitted = true;
        const { value } = await this.request('/instances', 'POST', {
          image: this.imageId, command: '/usr/local/bin/python3', args: ['-I', '-c', this.worker], shell: false,
          cwd: '/tmp', uid: 65534, gid: 65534, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' }, preserve_env: false,
          networking: { enabled: false }, resources_limits: { max_layer_bytes: 64 * 1024 * 1024 },
          timeout, truncate_output_at: MAX_CAPTURE_BYTES, disposable: true,
          stdin: { value: Buffer.from(JSON.stringify(payload)).toString('base64'), encoding: 'base64', close: true },
        }, response => emit({ phase: 'submitted', operationId: this.operationId(response) }));
        // Capture a valid operation reference before validating other response
        // fields so malformed metadata can still trigger remote cleanup.
        const spawn = z.object({ uuid, image: uuid.optional() }).passthrough().safeParse(value);
        if (!spawn.success || (spawn.data.image && spawn.data.image !== this.imageId)) throw new RemoteError('Nebius returned malformed or mismatched submission metadata.');
        emit({ ...state, instanceId: spawn.data.uuid });
        const until = Date.now() + this.completionTimeoutMs;
        for (;;) {
          if (stopped) { await cleanup(); throw new RemoteError(stopped); }
          if (Date.now() >= until) { await cleanup(); throw new RemoteError('Nebius completion deadline exceeded; cancellation was requested.'); }
          const { operation, retryMs } = await this.status(state.operationId!);
          if (stopped) { await cleanup(); throw new RemoteError(stopped); }
          if (operation.image_uuid && operation.image_uuid !== this.imageId) throw new RemoteError('Nebius operation used a different image than the approved capture.');
          emit(this.state(operation, state));
          if (terminal.has(operation.status)) {
            const execution = operation.metadata?.result;
            if (execution?.state && execution.stdout && execution.stderr) {
              result.exitCode = execution.state.exit_code ?? null;
              // Live Nebius POSIX process metadata uses -1 when no signal ended
              // the process. Zero/null are also non-signals; positive values are
              // actual terminating signals and must still fail the execution.
              result.signal = execution.state.signal == null || execution.state.signal <= 0 ? null : String(execution.state.signal);
              const wire = decode(execution.stdout); result.stderr = decode(execution.stderr);
              if (Buffer.byteLength(wire) > MAX_CAPTURE_BYTES || Buffer.byteLength(result.stderr) > 50_000) throw new RemoteError('Nebius captured result exceeds the bounded size.');
              const capture = captureSchema.safeParse(JSON.parse(wire));
              if (!capture.success || bytes(capture.data) > MAX_CAPTURE_BYTES || Buffer.byteLength(capture.data.stdout + capture.data.stderr) > 50_000) throw new RemoteError('Nebius returned an invalid worker result bundle.');
              for (const output of capture.data.outputs) validateOutput(output);
              result.outputs = capture.data.outputs; result.stdout = capture.data.stdout; result.stderr += capture.data.stderr; result.runtime = capture.data.runtime;
              if (operation.status === 'SUCCESS' && execution.state.exit_code === 0 && result.signal === null && !execution.state.timed_out && capture.data.ok && capture.data.error === null) { result.status = 'completed'; break; }
              result.error = execution.state.timed_out ? 'Nebius execution reached its time limit.' : capture.data.error ?? `Nebius operation ${operation.status}, Python exit ${execution.state.exit_code ?? 'unknown'}.`;
            } else result.error = `Nebius operation ${operation.status} did not return captured execution results.`;
            if (operation.status === 'CANCELLED') result.status = 'cancelled';
            break;
          }
          await new Promise<void>(resolve => { const timer = setTimeout(() => { wake = undefined; resolve(); }, Math.min(retryMs, Math.max(0, until - Date.now()))); wake = () => { clearTimeout(timer); wake = undefined; resolve(); }; });
        }
      } catch (error) {
        const cancelledByProvider = state.phase === 'terminal' && state.status === 'CANCELLED';
        if (submitted && state.phase !== 'terminal' && state.phase !== 'uncertain') await cleanup();
        result.error = error instanceof RemoteError ? error.message : 'Nebius execution or result validation failed.';
        result.status = stopped || cancelledByProvider ? 'cancelled' : 'failed';
        if (!submitted) { state = { ...state, phase: 'terminal', cancellationConfirmed: true, error: result.error }; try { input.onProgress?.(structuredClone(state)); } catch { /* No remote submission occurred. */ } }
      }
      result.endedAt = now(); result.remote = structuredClone(state); return result;
    };
    const done = Promise.resolve().then(execute);
    return { done, cancel: (reason = 'User stopped this remote experiment.') => { stopped ??= reason.slice(0, 2000); wake?.(); } };
  }
}
