import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { confinedEnv, killGroup, PYTHON_PACKAGES, watchGroup, type Confine, type PythonRuntime } from './local-python.js';

import type { RemoteExecutionState } from '../shared/experiments.js';
export type { RemoteExecutionState } from '../shared/experiments.js';
export type SandboxInput = { code: string; csv?: string; parameters: Record<string, string | number | boolean>; timeoutMs?: number; onProgress?:(state:RemoteExecutionState)=>void };
export type SandboxOutput = { kind: 'table' | 'metric' | 'plot' | 'result' | 'dataset'; title: string; content: string; mediaType: string; metadata?: Record<string, unknown> };
export type SandboxCapabilities = {
  available: boolean; backend: 'docker-python' | 'nebius-sandbox'; policy: string; runtime: string | null;
  workerHash: string; imageId: string | null; libraries: Record<string, string>; enforcement: string[];
  limitations: string[]; timeoutMs: number; maxMemoryMb: number|null; maxOutputBytes: number;
  exampleCode?:string; dataContract?:string;
};
export type SandboxResult = {
  status: 'completed' | 'failed' | 'cancelled'; outputs: SandboxOutput[]; stdout: string; stderr: string;
  exitCode: number | null; signal: string | null; error?: string; runtime: string | null;
  startedAt: string; endedAt: string; enforcement: string[]; remote?:RemoteExecutionState;
};
export type SandboxHandle = { done: Promise<SandboxResult>; cancel: (reason?: string) => void; containerName?: string };
/** Execution transport only. Approval, node scope, shared budgets and attempt storage belong to the caller. */
export interface ExecutionBackend {
  capabilities(): SandboxCapabilities;
  start(input: SandboxInput): SandboxHandle;
}

export const SANDBOX_IMAGE = 'ros-ai-research-python:1';
const supportPath = fileURLToPath(new URL('./sandbox/', import.meta.url));
const sha = (body: string) => createHash('sha256').update(body).digest('hex');
const maxOutputBytes = 2_000_000;
const outputSchema = z.object({
  kind: z.enum(['table', 'metric', 'plot', 'result', 'dataset']), title: z.string().min(1).max(200),
  content: z.string().max(500_000), mediaType: z.enum(['application/json', 'image/svg+xml', 'text/plain', 'text/csv']),
}).strict();
const resultSchema = z.object({ ok: z.boolean(), outputs: z.array(outputSchema).max(20), stdout: z.string().max(100_000), stderr: z.string().max(100_000), runtime: z.string().max(1000), error: z.string().max(2000).nullable() }).strict();
const baseRestrictions = [
  '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
  '--memory=512m', '--memory-swap=512m', '--cpus=1', '--pids-limit=32', '--user=65534:65534',
  '--ulimit=core=0:0', '--ulimit=nofile=128:128', '--ipc=none', '--init',
  '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777',
  '--tmpfs=/work:rw,noexec,nosuid,nodev,size=64m,mode=1777', '--workdir=/work',
  // Docker client config can inject proxy credentials without explicit -e flags.
  '--env=HTTP_PROXY=', '--env=HTTPS_PROXY=', '--env=ALL_PROXY=', '--env=NO_PROXY=',
  '--env=http_proxy=', '--env=https_proxy=', '--env=all_proxy=', '--env=no_proxy=',
];

/** Actual Linux container isolation, with no host data mounts except one copied, read-only input directory.
 * Requires a trusted local Docker engine. Image selection is operator configuration, never model input.
 */
export class DockerPythonBackend implements ExecutionBackend {
  private readonly docker: string;
  private readonly value: SandboxCapabilities;

  constructor(options: { docker?: string; image?: string; timeoutMs?: number } = {}) {
    this.docker = options.docker ?? 'docker';
    const image = options.image ?? SANDBOX_IMAGE;
    const workerHash = sha(readFileSync(join(supportPath, 'sandbox_worker.py'), 'utf8'));
    const dockerfileHash = sha(readFileSync(join(supportPath, 'Dockerfile'), 'utf8'));
    const timeoutMs = Math.max(100, Math.min(30_000, options.timeoutMs ?? 30_000));
    const inspect = spawnSync(this.docker, ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8', timeout: 5000, maxBuffer: 20_000 });
    const imageId = inspect.status === 0 && /^sha256:[a-f0-9]{64}$/.test(inspect.stdout.trim()) ? inspect.stdout.trim() : null;
    let runtime: string | null = null, libraries: Record<string, string> = {}, failure = 'Docker image is unavailable. Build src/server/sandbox/Dockerfile locally and start Docker.';
    if (imageId) {
      const command = 'import hashlib,json,platform,importlib.metadata as m; print(json.dumps({"python":platform.python_version(),"worker":hashlib.sha256(open("/opt/ros/sandbox_worker.py","rb").read()).hexdigest(),"libraries":{k:m.version(k) for k in ["numpy","pandas","matplotlib","scipy"]}}))';
      const probe = spawnSync(this.docker, ['run', '--rm', ...baseRestrictions, '--entrypoint=python', imageId, '-I', '-c', command], { encoding: 'utf8', timeout: 10_000, maxBuffer: 20_000 });
      try {
        if (probe.status !== 0) throw new Error(probe.stderr || probe.error?.message || 'Container could not start.');
        const result = z.object({ python: z.string(), worker: z.string(), libraries: z.record(z.string(), z.string()) }).parse(JSON.parse(probe.stdout));
        if (result.worker !== workerHash) throw new Error('Sandbox image contains an older capture worker. Rebuild the image before running changed code.');
        runtime = `Python ${result.python} in Docker/Linux`;
        libraries = result.libraries;
      } catch (error) { failure = error instanceof Error ? error.message.slice(0, 500) : 'Runtime probe failed.'; }
    }
    this.value = {
      available: runtime !== null, backend: 'docker-python', policy: 'docker-python-v1', runtime,
      workerHash: sha(JSON.stringify({ workerHash, dockerfileHash, imageId, restrictions: baseRestrictions })), imageId, libraries,
      timeoutMs, maxMemoryMb: 512, maxOutputBytes,
      enforcement: [
        'Linux container: network none; read-only root; non-root UID; all capabilities dropped; no-new-privileges and Docker default seccomp.',
        'Only copied, immutable per-run code/parameters and an optional explicit CSV mounted read-only. No original files, host folders, credentials, or Docker socket are mounted.',
        '512 MB memory with no additional swap, 1 CPU quota, 32 processes, CPU 25 s, wall time at most 30 s; stop kills the whole container including child processes.',
        'Private /work and /tmp each limited to 64 MB. Per-file 16 MB, stdout 2 MB, stderr 100 KB, 20 captured outputs of at most 500 KB each.',
      ],
      limitations: [
        ...(runtime === null ? [failure] : []),
        'Requires a running trusted local Docker engine and the built image; unavailable backends fail closed without an unrestricted subprocess fallback.',
        'Container isolation shares the Docker VM Linux kernel. This is not a VM per experiment or a proof against kernel/runtime vulnerabilities.',
        'Python may create processes and access installed container files inside the same limits; no host shell, package installation service, network tool or source-write permission is exposed.',
        'Wall-clock cancellation requires a responsive Docker engine; kernel/container vulnerabilities are outside this boundary.',
        'Server crashes do not migrate work. A separate deadline watchdog attempts container cleanup; if the entire host stops, no remote continuation is available.',
      ],
    };
  }

  capabilities(): SandboxCapabilities { return structuredClone(this.value); }

  start(input: SandboxInput): SandboxHandle {
    if (!this.value.available || !this.value.imageId) throw new Error('Isolated Python is unavailable. ' + this.value.limitations[0]);
    if (typeof input.code !== 'string' || !input.code.trim() || Buffer.byteLength(input.code) > 100_000) throw new Error('Sandbox code must be 1-100 KB.');
    if (input.csv !== undefined && (typeof input.csv !== 'string' || !input.csv.trim() || Buffer.byteLength(input.csv) > 2_000_000)) throw new Error('An explicitly supplied sandbox CSV must be nonempty and at most 2 MB.');
    const parameters = z.record(z.string().max(100), z.union([z.string().max(1000), z.number().finite(), z.boolean()])).parse(input.parameters);
    const timeoutMs = Math.min(this.value.timeoutMs, Math.max(100, input.timeoutMs ?? this.value.timeoutMs));
    const startedAt = new Date().toISOString(), name = `ros-ai-${randomUUID()}`;
    const temporary = mkdtempSync(join(tmpdir(), 'ros-ai-sandbox-'));
    const inputs = join(temporary, 'input');
    mkdirSync(inputs, { mode: 0o755 });
    const files = [['program.py', input.code], ['parameters.json', JSON.stringify(parameters)]];
    if (input.csv !== undefined) files.push(['dataset.csv', input.csv]);
    for (const [filename, content] of files) writeFileSync(join(inputs, filename), content, { mode: 0o444 });
    chmodSync(inputs, 0o555);
    let stopped: string | undefined, timedOut = false, overflow = false, cleanupUnconfirmed = false;
    let killClientTimer: ReturnType<typeof setTimeout> | undefined;
    let wire = '', dockerStderr = '', wireBytes = 0, errorMessage: string | undefined;
    let cancelContainer: Promise<void> | undefined;
    const removeContainer = () => {
      if ((stopped || timedOut || overflow) && !killClientTimer) killClientTimer = setTimeout(() => {
        cleanupUnconfirmed = true;
        child.kill('SIGKILL');
      }, 6000);
      cancelContainer ??= new Promise<void>(resolve => {
        const kill = spawn(this.docker, ['rm', '--force', name], { stdio: 'ignore' });
        const killerTimeout = setTimeout(() => kill.kill('SIGKILL'), 5000);
        kill.on('error', () => { clearTimeout(killerTimeout); resolve(); });
        kill.on('close', () => { clearTimeout(killerTimeout); resolve(); });
      }).finally(() => { cancelContainer = undefined; });
      return cancelContainer;
    };
    const child = spawn(this.docker, ['run', '--rm', '--name', name, ...baseRestrictions,
      '--mount', `type=bind,src=${inputs},dst=/input,readonly`,
      '--env=MPLCONFIGDIR=/tmp/matplotlib', '--env=HOME=/work', this.value.imageId], { stdio: ['ignore', 'pipe', 'pipe'] });
    // Independent trusted host watchdog survives application process death. Its only action is
    // force-removing this unique container after the same bounded wall deadline.
    const watchdog = spawn(process.execPath, ['--input-type=module', '-e',
      'import{spawn}from"node:child_process";setTimeout(()=>{const p=spawn(process.argv[1],["rm","--force",process.argv[2]],{stdio:"ignore"});setTimeout(()=>p.kill("SIGKILL"),5000).unref()},Number(process.argv[3]));', this.docker, name, String(timeoutMs + 1500)], { detached: true, stdio: 'ignore' });
    watchdog.unref();
    watchdog.on('error', () => { /* Parent wall deadline remains active; CPU limit is also applied in the worker. */ });
    const timer = setTimeout(() => { timedOut = true; errorMessage = `Isolated experiment exceeded its ${timeoutMs} ms wall time.`; void removeContainer(); }, timeoutMs);
    // Cancellation can arrive while Docker is still creating the named container.
    // Repeat until the attached client closes, so a pre-creation rm cannot miss it.
    const stopTimer = setInterval(() => { if (stopped || timedOut || overflow) void removeContainer(); }, 200);
    child.stdout.on('data', (chunk: Buffer) => {
      wireBytes += chunk.length;
      if (wireBytes <= maxOutputBytes) wire += chunk.toString('utf8');
      else { overflow = true; errorMessage = 'Isolated experiment exceeded its 2 MB output limit.'; void removeContainer(); }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      dockerStderr += chunk.toString('utf8');
      if (Buffer.byteLength(dockerStderr) > 100_000) { dockerStderr = dockerStderr.slice(0, 100_000); overflow = true; errorMessage = 'Isolated experiment exceeded its stderr limit.'; void removeContainer(); }
    });
    const done = new Promise<SandboxResult>(resolve => {
      child.on('error', error => { errorMessage = `Docker could not start: ${error.message}`; });
      child.on('close', async (exitCode, signal) => {
        clearTimeout(timer);
        clearTimeout(killClientTimer);
        clearInterval(stopTimer);
        await removeContainer();
        watchdog.kill('SIGTERM');
        const result: SandboxResult = { status: stopped ? 'cancelled' : 'failed', outputs: [], stdout: '', stderr: dockerStderr, exitCode, signal, runtime: this.value.runtime, startedAt, endedAt: new Date().toISOString(), enforcement: [...this.value.enforcement] };
        if (cleanupUnconfirmed) result.stderr += '\nDocker did not confirm stop within 6 seconds. The client was killed; container cleanup is uncertain and the separate watchdog will retry.';
        try {
          let decoded: z.infer<typeof resultSchema> | undefined;
          try { decoded = resultSchema.parse(JSON.parse(wire)); }
          catch { /* An interrupted worker may never emit its final bounded capture. */ }
          if (decoded) {
            result.outputs = decoded.outputs;
            result.stdout = decoded.stdout;
            result.stderr += decoded.stderr;
            result.runtime = decoded.runtime;
          }
          if (stopped || timedOut || overflow) throw new Error(stopped ?? errorMessage);
          if (!decoded) throw new Error(errorMessage ?? `Container exited ${exitCode ?? signal ?? 'unknown'} without a valid bounded capture. ${dockerStderr.slice(-2000)}`);
          if (!decoded.ok || exitCode !== 0) throw new Error(decoded.error ?? errorMessage ?? `Container exited ${exitCode}.`);
          result.status = 'completed';
        } catch (error) { result.error = error instanceof Error ? error.message.slice(0, 2000) : 'Isolated experiment failed.'; }
        finally {
          try { chmodSync(inputs, 0o755); rmSync(temporary, { recursive: true, force: true }); }
          catch { result.stderr += '\nTemporary input cleanup failed; directory contains only captured experiment inputs.'; }
          resolve(result);
        }
      });
    });
    return { done, containerName: name, cancel: (reason = 'User stopped this isolated experiment.') => { stopped ??= reason; void removeContainer(); } };
  }
}

const codeLimits = { memoryMb: 512, processes: 32 };

/** Code blocks without Docker: ros.ai's own Python, confined by the operating system's sandbox the way Codex and
 * Claude Code confine commands. Python is set up on the first run; the wall-clock limit starts once Python starts.
 * The backend id stays `docker-python`, the name saved runs and agent tools already use for local Python.
 */
export class LocalPythonBackend implements ExecutionBackend {
  private readonly worker = readFileSync(join(supportPath, 'sandbox_worker.py'), 'utf8');
  private readonly timeoutMs: number;

  constructor(private readonly runtime: PythonRuntime, private readonly confine: Confine | null, options: { timeoutMs?: number } = {}) {
    this.timeoutMs = Math.max(100, Math.min(30_000, options.timeoutMs ?? 30_000));
  }

  capabilities(): SandboxCapabilities {
    const state = this.runtime.state(), available = this.confine !== null;
    const libraries = Object.fromEntries(PYTHON_PACKAGES.map(item => item.split('==') as [string, string]));
    return {
      available, backend: 'docker-python', policy: 'local-python-seatbelt-v1',
      runtime: !available ? null : state.status === 'ready' ? `Python ${state.version} in the macOS sandbox` : 'Python 3.12 in the macOS sandbox (set up on the first run)',
      workerHash: sha(JSON.stringify({ worker: sha(this.worker), spec: this.runtime.specHash, limits: codeLimits })), imageId: `local-python:${this.runtime.specHash.slice(0, 16)}`,
      libraries, timeoutMs: this.timeoutMs, maxMemoryMb: codeLimits.memoryMb, maxOutputBytes,
      enforcement: [
        'macOS sandbox (Seatbelt): no network; the home folder and other drives cannot be read; writes only in a private temporary folder.',
        'Only copied, read-only per-run code, parameters and an optional CSV. No original files, project folders, keys or tokens; the environment is emptied.',
        `${codeLimits.memoryMb} MB memory and ${codeLimits.processes} processes (checked twice a second), CPU 25 s, wall time at most ${this.timeoutMs / 1000} s; stop ends every process it started.`,
        'Per-file 16 MB, stdout 2 MB, stderr 100 KB, 20 captured outputs of at most 500 KB each.',
      ],
      limitations: [
        ...(!available ? ['Sandboxed Python runs on macOS for now. On this computer, use Docker.'] : state.status === 'failed' ? [state.message] : []),
        'Runs as the person on their own computer, sharing its kernel, like Codex and Claude Code. Not a virtual machine.',
        'System folders outside the home folder can be read.',
      ],
    };
  }

  start(input: SandboxInput): SandboxHandle {
    if (!this.confine) throw new Error('Isolated Python is unavailable. ' + this.capabilities().limitations[0]);
    if (typeof input.code !== 'string' || !input.code.trim() || Buffer.byteLength(input.code) > 100_000) throw new Error('Sandbox code must be 1-100 KB.');
    if (input.csv !== undefined && (typeof input.csv !== 'string' || !input.csv.trim() || Buffer.byteLength(input.csv) > 2_000_000)) throw new Error('An explicitly supplied sandbox CSV must be nonempty and at most 2 MB.');
    const parameters = z.record(z.string().max(100), z.union([z.string().max(1000), z.number().finite(), z.boolean()])).parse(input.parameters);
    const timeoutMs = Math.min(this.timeoutMs, Math.max(100, input.timeoutMs ?? this.timeoutMs));
    const confine = this.confine, startedAt = new Date().toISOString(), capabilities = this.capabilities();
    const temporary = mkdtempSync(join(tmpdir(), 'ros-ai-sandbox-'));
    const inputs = join(temporary, 'input'), work = join(temporary, 'work'), tmp = join(temporary, 'tmp');
    for (const folder of [inputs, work, tmp]) mkdirSync(folder, { mode: 0o700 });
    const files = [['program.py', input.code], ['parameters.json', JSON.stringify(parameters)]];
    if (input.csv !== undefined) files.push(['dataset.csv', input.csv]);
    for (const [filename, content] of files) writeFileSync(join(inputs, filename), content, { mode: 0o444 });
    chmodSync(inputs, 0o555);
    let stopped: string | undefined, child: ReturnType<typeof spawn> | undefined;
    const done = (async (): Promise<SandboxResult> => {
      const result: SandboxResult = { status: 'failed', outputs: [], stdout: '', stderr: '', exitCode: null, signal: null, runtime: capabilities.runtime, startedAt, endedAt: '', enforcement: [...capabilities.enforcement] };
      const close = () => {
        result.endedAt = new Date().toISOString();
        try { chmodSync(inputs, 0o755); rmSync(temporary, { recursive: true, force: true }); }
        catch { result.stderr += '\nTemporary input cleanup failed; the folder holds only this run\'s copied inputs.'; }
        return result;
      };
      let python: string;
      try { python = await this.runtime.ensure(); }
      catch (error) { result.error = error instanceof Error ? error.message : String(error); return close(); }
      if (stopped) { result.status = 'cancelled'; result.error = stopped; return close(); }
      const wrapped = confine(python, ['-I', '-c', this.worker], { read: [this.runtime.home, temporary], write: [work, tmp] });
      return new Promise<SandboxResult>(resolve => {
        let wire = '', stderr = '', wireBytes = 0, errorMessage: string | undefined, ended = false;
        const proc = spawn(wrapped.command, wrapped.args, { cwd: work, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: confinedEnv(work, tmp, { ROS_SANDBOX_INPUT: inputs }) });
        child = proc;
        const end = (message: string) => { errorMessage ??= message; killGroup(proc.pid); };
        const unwatch = proc.pid ? watchGroup(proc.pid, codeLimits, reason => end(`Isolated experiment ${reason}.`)) : () => undefined;
        const timer = setTimeout(() => end(`Isolated experiment exceeded its ${timeoutMs} ms wall time.`), timeoutMs);
        proc.stdout!.on('data', (chunk: Buffer) => {
          wireBytes += chunk.length;
          if (wireBytes <= maxOutputBytes) wire += chunk.toString('utf8');
          else end('Isolated experiment exceeded its 2 MB output limit.');
        });
        proc.stderr!.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
          if (Buffer.byteLength(stderr) > 100_000) { stderr = stderr.slice(0, 100_000); end('Isolated experiment exceeded its stderr limit.'); }
        });
        const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
          if (ended) return;
          ended = true;
          clearTimeout(timer); unwatch();
          killGroup(proc.pid);
          result.exitCode = exitCode; result.signal = signal; result.stderr = stderr;
          try {
            let decoded: z.infer<typeof resultSchema> | undefined;
            try { decoded = resultSchema.parse(JSON.parse(wire)); }
            catch { /* An interrupted worker may never emit its final bounded capture. */ }
            if (decoded) { result.outputs = decoded.outputs; result.stdout = decoded.stdout; result.stderr += decoded.stderr; result.runtime = decoded.runtime; }
            if (stopped) { result.status = 'cancelled'; throw new Error(stopped); }
            if (errorMessage) throw new Error(errorMessage);
            if (!decoded) throw new Error(`Python exited ${exitCode ?? signal ?? 'unknown'} without a valid bounded capture. ${stderr.slice(-2000)}`);
            if (!decoded.ok || exitCode !== 0) throw new Error(decoded.error ?? `Python exited ${exitCode}.`);
            result.status = 'completed';
          } catch (error) { result.error = error instanceof Error ? error.message.slice(0, 2000) : 'Isolated experiment failed.'; }
          resolve(close());
        };
        proc.on('error', error => { errorMessage ??= `Python could not start: ${error.message}`; finish(null, null); });
        proc.on('close', finish);
      });
    })();
    return { done, cancel: (reason = 'User stopped this isolated experiment.') => { stopped ??= reason; killGroup(child?.pid); } };
  }
}

/** Adapter seam only. The public API is documented; this account's beta access and execution are unverified. */
export class UnavailableNebiusSandboxBackend implements ExecutionBackend {
  capabilities(): SandboxCapabilities {
    return { available: false, backend: 'nebius-sandbox', policy: 'unavailable', runtime: null, workerHash: '', imageId: null, libraries: {}, enforcement: [], limitations: ['Nebius publishes a sandbox API, but this account\'s beta access and remote execution are unverified; no cloud execution is implemented.'], timeoutMs: 0, maxMemoryMb: 0, maxOutputBytes: 0 };
  }
  start(_input: SandboxInput): SandboxHandle { throw new Error('Nebius sandbox account access and execution are unverified. Choose an available local backend.'); }
}
