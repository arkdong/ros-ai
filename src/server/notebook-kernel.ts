import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { SANDBOX_IMAGE } from './sandbox.js';

const KERNEL = readFileSync(fileURLToPath(new URL('./sandbox/notebook_kernel.py', import.meta.url)), 'utf8');
const MAX_LINE = 32_000_000;
/** The same container boundary as Code blocks, sized for interactive work: no network, read-only system and project
 * files, no added privileges. Only the notebook's outputs folder, /tmp and /work can be written. */
export const KERNEL_RESTRICTIONS = [
  '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
  '--memory=2g', '--memory-swap=2g', '--cpus=2', '--pids-limit=128',
  '--ulimit=core=0:0', '--ulimit=nofile=256:256', '--ipc=none', '--init',
  '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777', '--tmpfs=/work:rw,noexec,nosuid,nodev,size=256m,mode=1777',
  // Docker client config can inject proxy settings without explicit -e flags.
  '--env=HTTP_PROXY=', '--env=HTTPS_PROXY=', '--env=ALL_PROXY=', '--env=NO_PROXY=',
  '--env=http_proxy=', '--env=https_proxy=', '--env=all_proxy=', '--env=no_proxy=',
  '--env=MPLCONFIGDIR=/tmp/matplotlib', '--env=HOME=/work',
];

const id = z.string().max(100);
const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), python: z.string().max(40), libraries: z.record(z.string().max(40), z.string().max(40)), cwd: z.string().max(4000) }),
  z.object({ type: z.literal('stream'), id, name: z.enum(['stdout', 'stderr']), text: z.string().max(2_000_000) }),
  z.object({ type: z.literal('display'), id, data: z.record(z.string().max(200), z.unknown()), metadata: z.record(z.string().max(200), z.unknown()), result: z.boolean() }),
  z.object({ type: z.literal('clear'), id }),
  z.object({ type: z.literal('done'), id, status: z.enum(['ok', 'error', 'interrupted']),
    error: z.object({ ename: z.string().max(200), evalue: z.string().max(5000), traceback: z.array(z.string().max(20_000)).max(500) }).optional() }),
]);
/** Sent by Python inside the container, so read as untrusted: a cell can write to the channel itself. */
export type KernelMessage = z.infer<typeof messageSchema>;
export type KernelExit = { code: number | null; signal: string | null; detail: string; stopped: boolean };
/** The project folder, mounted read-only at /project, and the one folder in it that cells may write to. */
export type KernelFolder = { root: string; notebookDir: string; outputs: string; outputsPath: string };

// Docker reads --mount values as CSV, so a path with a comma or quote is quoted.
const field = (value: string) => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const bind = (source: string, target: string, readonly: boolean) => ['type=bind', field(`src=${source}`), field(`dst=${target}`), ...(readonly ? ['readonly'] : [])].join(',');
/** Files the kernel writes belong to the person running ros.ai. A server running as root still runs Python as nobody. */
export function kernelUser(): string {
  const uid = process.getuid?.(), gid = process.getgid?.();
  return uid === undefined || gid === undefined || uid === 0 ? '65534:65534' : `${uid}:${gid}`;
}

/** The image Code blocks use. Checked when a notebook starts Python, so starting Docker later works without a restart. */
export function kernelImage(docker = 'docker'): Promise<{ id: string } | { reason: string }> {
  return new Promise(resolve => execFile(docker, ['image', 'inspect', '--format', '{{.Id}}', SANDBOX_IMAGE], { timeout: 10_000, maxBuffer: 20_000 }, (error, stdout, stderr) => {
    const id = String(stdout).trim();
    if (!error && /^sha256:[a-f0-9]{64}$/u.test(id)) return resolve({ id });
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return resolve({ reason: 'Notebook cells run in Docker, and Docker is not installed on this computer. Install Docker Desktop and start it.' });
    if (/cannot connect|daemon|connection refused|pipe/iu.test(String(stderr))) return resolve({ reason: 'Docker is not running. Start Docker Desktop, then run the cell again.' });
    resolve({ reason: `The ros.ai Python image is missing. Build it once with: docker build -t ${SANDBOX_IMAGE} src/server/sandbox` });
  }));
}

/** Removes notebook containers a previous ros.ai left behind, for example after a crash. */
export function removeLeftoverKernels(owner: string, docker = 'docker'): void {
  execFile(docker, ['ps', '-aq', '--filter', `label=ros-ai.notebook-owner=${owner}`], { timeout: 10_000, maxBuffer: 100_000 }, (error, stdout) => {
    const ids = error ? [] : String(stdout).split(/\s+/u).filter(value => /^[a-f0-9]{12,64}$/u.test(value));
    if (ids.length) execFile(docker, ['rm', '--force', ...ids], { timeout: 30_000 }, () => undefined);
  });
}

/** One long-running Python process in its own container, speaking JSON lines. */
export class NotebookKernelProcess {
  readonly id = randomUUID();
  readonly name = `ros-ai-notebook-${this.id}`;
  private child?: ChildProcessWithoutNullStreams;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private stderr = '';
  private stopping = false;
  private exited = false;
  private ignoring = false;
  private overflow?: string;

  constructor(private readonly options: { image: string; owner: string; folder?: KernelFolder; docker?: string;
    onMessage: (message: KernelMessage) => void; onExit: (exit: KernelExit) => void }) {}

  start(): void {
    const folder = this.options.folder, workdir = folder ? posix.join('/project', folder.notebookDir) : '/work';
    const outputs = folder ? posix.join('/project', folder.outputs) : undefined;
    const args = ['run', '--rm', '-i', '--name', this.name, '--label', `ros-ai.notebook-owner=${this.options.owner}`, ...KERNEL_RESTRICTIONS, `--user=${kernelUser()}`,
      ...(folder && outputs ? ['--mount', bind(folder.root, '/project', true), '--mount', bind(folder.outputsPath, outputs, false), `--env=ROS_NOTEBOOK_OUTPUTS=${posix.relative(workdir, outputs) || '.'}`] : []),
      `--workdir=${workdir}`, '--entrypoint=python', this.options.image, '-I', '-u', '-c', KERNEL];
    const child = spawn(this.options.docker ?? 'docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
    child.stderr.setEncoding('utf8').on('data', (text: string) => { this.stderr = (this.stderr + text).slice(-4000); });
    child.stdin.on('error', () => { /* the exit handler reports a stopped process */ });
    child.on('error', error => this.finish(null, null, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Docker is not installed on this computer.' : error.message));
    child.on('close', (code, signal) => this.finish(code, signal));
  }

  execute(message: { id: string; code: string; count: number }): boolean {
    if (!this.child || this.exited || this.stopping) return false;
    this.child.stdin.write(`${JSON.stringify({ type: 'execute', ...message })}\n`);
    return true;
  }
  /** Ctrl+C for the running cell: Docker's init process passes SIGINT on to Python. */
  interrupt(): void {
    if (this.exited) return;
    execFile(this.options.docker ?? 'docker', ['kill', '--signal=INT', this.name], { timeout: 10_000 }, () => undefined);
  }
  /** Closing stdin ends an idle kernel at once; removing the container also ends a busy one. */
  stop(reason?: string): Promise<void> {
    if (this.exited) return Promise.resolve();
    if (reason && !this.overflow) this.overflow = reason;
    this.stopping = true;
    this.child?.stdin.end();
    const docker = this.options.docker ?? 'docker', remove = () => execFile(docker, ['rm', '--force', this.name], { timeout: 10_000 }, () => undefined);
    remove();
    return new Promise(resolve => {
      // The container may still be starting when the first removal runs.
      const retry = setInterval(remove, 1000), timer = setTimeout(() => { clearInterval(retry); this.child?.kill('SIGKILL'); resolve(); }, 10_000);
      const done = () => { clearInterval(retry); clearTimeout(timer); resolve(); };
      if (this.exited) done(); else this.child?.once('close', done);
    });
  }

  private read(chunk: Buffer): void {
    if (this.ignoring) return;
    let start = 0;
    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, index);
      const line = this.pendingBytes ? Buffer.concat([...this.pending, piece]).toString('utf8') : piece.toString('utf8');
      this.pending = []; this.pendingBytes = 0; start = index + 1;
      this.parse(line);
    }
    if (start >= chunk.length) return;
    this.pending.push(chunk.subarray(start));
    this.pendingBytes += chunk.length - start;
    if (this.pendingBytes > MAX_LINE) {
      this.pending = []; this.pendingBytes = 0; this.ignoring = true;
      void this.stop('A cell sent an output larger than ros.ai accepts, so Python was stopped.');
    }
  }
  private parse(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return; }
    const message = messageSchema.safeParse(value);
    if (message.success) this.options.onMessage(message.data);
  }
  private finish(code: number | null, signal: NodeJS.Signals | null, failure?: string): void {
    if (this.exited) return;
    this.exited = true;
    const detail = this.overflow ?? failure ?? this.stderr.replace(/\s+/gu, ' ').trim().slice(-600);
    this.options.onExit({ code, signal, detail, stopped: this.stopping && !this.overflow });
  }
}
