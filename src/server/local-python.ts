import { execFile, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Python for Code and Notebook blocks without Docker, the way Codex and Claude Code run commands: the computer's own
 * Python process, confined by the operating system's sandbox (Seatbelt on macOS). ros.ai fetches its own Python with uv
 * the first time a block runs, into its data folder, so a person installs nothing. */

export const PYTHON_PACKAGES = ['numpy==2.2.6', 'pandas==2.2.3', 'matplotlib==3.10.3', 'scipy==1.15.3'];
/** certifi gives Python the certificates HTTPS needs, and pip (seeded into the environment) installs packages. */
const INSTALL = [...PYTHON_PACKAGES, 'certifi==2026.7.22'];
const PYTHON_SERIES = '3.12';
const UV_VERSION = '0.11.32';
/** Checksums of the uv release archives ros.ai downloads when uv is not installed. */
const UV_ARCHIVES: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin:ed336d0ba49db8ef89b2b41fffa372ce63bd032f22a56f001c265891aec32829',
  'darwin-x64': 'x86_64-apple-darwin:77f5ca26c0de20e992a3677a174fe1121ee25c36f9b1434a863f75bf077a05eb',
};
const SPEC = createHash('sha256').update(JSON.stringify({ python: PYTHON_SERIES, packages: INSTALL, seed: true })).digest('hex');

export type PythonState = { status: 'ready'; python: string; version: string } | { status: 'missing' | 'installing' | 'failed'; message: string };
/** What the setup notice shows while Python is set up. */
export type PythonSetupEvent = { status: 'installing'; step: string } | { status: 'ready'; version: string } | { status: 'failed'; message: string };
type Ready = { spec: string; version: string };

const run = (command: string, args: string[], env: NodeJS.ProcessEnv, timeout = 600_000) => new Promise<string>((resolve, reject) =>
  execFile(command, args, { env, timeout, maxBuffer: 20_000_000 }, (error, stdout, stderr) => error
    ? reject(new Error(`${String(stderr || error.message).trim().split('\n').slice(-4).join(' ').slice(0, 600)}`)) : resolve(String(stdout))));

/** ros.ai's own Python 3.12 with pandas, NumPy, matplotlib and SciPy. One copy per computer (in the app-data folder,
 * outside any project or code folder), shared by every ros.ai data folder on it. */
export class PythonRuntime {
  private installing?: Promise<string>;
  private failure?: string;
  private step = '';
  private readonly listeners = new Set<(event: PythonSetupEvent) => void>();

  subscribe(listener: (event: PythonSetupEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** The setup in progress, for a notice opened after it started. */
  setup(): PythonSetupEvent | null { return this.installing ? { status: 'installing', step: this.step } : null; }
  private emit(event: PythonSetupEvent): void { for (const listener of this.listeners) try { listener(event); } catch { /* a closed stream */ } }
  private progress(step: string): void { this.step = step; this.emit({ status: 'installing', step }); }

  constructor(readonly home: string, private readonly options: { uv?: string; fetch?: typeof fetch } = {}) {}

  get python(): string { return join(this.home, 'env', 'bin', 'python'); }
  get specHash(): string { return SPEC; }
  /** The project's own packages, installed from a notebook with %pip install. */
  packages(projectId: string): string { return join(this.home, 'projects', createHash('sha256').update(projectId).digest('hex').slice(0, 24)); }
  /** Certificates for HTTPS through the network proxy. */
  get certFile(): string { return join(this.home, 'env', 'lib', `python${PYTHON_SERIES}`, 'site-packages', 'certifi', 'cacert.pem'); }

  state(): PythonState {
    const ready = this.ready();
    if (ready) return { status: 'ready', python: this.python, version: ready.version };
    if (this.installing) return { status: 'installing', message: 'Setting up Python for the first run (about a minute, once).' };
    if (this.failure) return { status: 'failed', message: this.failure };
    return { status: 'missing', message: 'Python sets itself up the first time a cell runs (about 150 MB, once).' };
  }

  /** The Python to run, installing it first when needed. Several callers share one install. */
  ensure(): Promise<string> {
    if (this.ready()) return Promise.resolve(this.python);
    this.installing ??= this.installOnce().then(python => { this.failure = undefined; this.emit({ status: 'ready', version: this.ready()?.version ?? PYTHON_SERIES }); return python; },
      (error: unknown) => { this.failure = `Python could not be set up: ${error instanceof Error ? error.message : String(error)}`; this.emit({ status: 'failed', message: this.failure }); throw new Error(this.failure); })
      .finally(() => { this.installing = undefined; });
    return this.installing;
  }

  private ready(): Ready | null {
    try {
      const ready = JSON.parse(readFileSync(join(this.home, 'ready.json'), 'utf8')) as Ready;
      return ready.spec === SPEC && existsSync(this.python) ? ready : null;
    } catch { return null; }
  }

  /** Another ros.ai on this computer may be setting up the same copy; it holds `installing.lock` until it is done. */
  private async installOnce(): Promise<string> {
    mkdirSync(this.home, { recursive: true });
    const lock = join(this.home, 'installing.lock');
    for (const started = Date.now(); ;) {
      try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; }
      catch {
        let owner = 0;
        try { owner = Number(readFileSync(lock, 'utf8')); } catch { continue; }
        let alive = false;
        try { process.kill(owner, 0); alive = owner !== process.pid; } catch { /* gone */ }
        if (!alive) { rmSync(lock, { force: true }); continue; }
        this.progress('Another ros.ai window is setting up Python');
        if (this.ready()) return this.python;
        if (Date.now() - started > 15 * 60_000) throw new Error('another ros.ai has been setting up Python for 15 minutes.');
        await sleep(1000);
      }
    }
    try { return this.ready() ? this.python : await this.install(); }
    finally { rmSync(lock, { force: true }); }
  }

  private async install(): Promise<string> {
    this.progress('Getting uv, the installer');
    const uv = await this.uv();
    // uv keeps everything inside ros.ai's folder and ignores the person's own uv settings.
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? homedir(), UV_NO_CONFIG: '1',
      UV_PYTHON_INSTALL_DIR: join(this.home, 'pythons'), UV_CACHE_DIR: join(this.home, 'cache'), UV_PYTHON_PREFERENCE: 'only-managed', UV_LINK_MODE: 'copy',
      ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}),
      ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}) };
    const venv = join(this.home, 'env');
    rmSync(join(this.home, 'ready.json'), { force: true });
    rmSync(venv, { recursive: true, force: true });
    this.progress('Downloading Python 3.12');
    await run(uv, ['venv', '--quiet', '--seed', '--no-project', '--python', PYTHON_SERIES, venv], env);
    this.progress('Installing pandas, NumPy, matplotlib and SciPy');
    await run(uv, ['pip', 'install', '--quiet', '--python', this.python, ...INSTALL], env);
    const version = (await run(this.python, ['-I', '-c', 'import platform; print(platform.python_version())'], { PATH: '/usr/bin:/bin' }, 60_000)).trim();
    // The downloaded wheels are not needed once installed; this keeps the folder near 400 MB.
    rmSync(join(this.home, 'cache'), { recursive: true, force: true });
    writeFileSync(join(this.home, 'ready.json'), JSON.stringify({ spec: SPEC, version } satisfies Ready));
    return this.python;
  }

  /** uv from the person's PATH, or a pinned, checksummed copy in ros.ai's folder. */
  private async uv(): Promise<string> {
    if (this.options.uv) return this.options.uv;
    for (const folder of (process.env.PATH ?? '').split(delimiter)) if (folder && existsSync(join(folder, 'uv'))) return join(folder, 'uv');
    const own = join(this.home, 'bin', 'uv');
    if (existsSync(own)) return own;
    const archive = UV_ARCHIVES[`${process.platform}-${process.arch}`];
    if (!archive) throw new Error(`ros.ai cannot download uv for ${process.platform} ${process.arch}. Install uv, then run the cell again.`);
    const [target, checksum] = archive.split(':');
    const response = await (this.options.fetch ?? fetch)(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${target}.tar.gz`);
    if (!response.ok) throw new Error(`downloading uv failed (HTTP ${response.status}). Check the internet connection.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== checksum) throw new Error('the downloaded uv did not match its checksum.');
    const unpack = join(this.home, 'bin-download');
    rmSync(unpack, { recursive: true, force: true });
    mkdirSync(unpack, { recursive: true });
    writeFileSync(join(unpack, 'uv.tar.gz'), bytes);
    await run('tar', ['-xzf', join(unpack, 'uv.tar.gz'), '-C', unpack], { PATH: '/usr/bin:/bin' }, 60_000);
    mkdirSync(join(this.home, 'bin'), { recursive: true });
    renameSync(join(unpack, `uv-${target}`, 'uv'), own);
    chmodSync(own, 0o755);
    rmSync(unpack, { recursive: true, force: true });
    return own;
  }
}

/** Folders a confined Python may read beyond the system's own files, and the only folders it may write. */
export type Confinement = { read: string[]; write: string[]; proxyPort?: number };
/** Wraps a command so the operating system enforces a confinement, or null where ros.ai has no sandbox for this system. */
export type Confine = (command: string, args: string[], paths: Confinement) => { command: string; args: string[] };

const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
const quote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/** A Seatbelt profile in the spirit of Codex's: everything denied, then process basics, system files, the named folders.
 * The only network it grants is the ros.ai network proxy on this computer (see network-gate.ts), so every other
 * socket fails and each site passes the proxy's own check. The person's home folder and other drives
 * stay unreadable except the folders named in `read`. */
export function seatbeltProfile(paths: Confinement, home = homedir()): string {
  const read = paths.read.map(real), write = paths.write.map(real);
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow user-preference-read)',
    '(allow sysctl-read)',
    '(allow ipc-posix-sem)',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    '(allow file-read-metadata)',
    `(allow file-read* (require-all (require-not (subpath ${quote(real(home))})) (require-not (subpath "/Volumes"))))`,
    ...read.map(path => `(allow file-read* (subpath ${quote(path)}))`),
    '(allow file-read* file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/urandom") (literal "/dev/random"))',
    ...write.map(path => `(allow file-read* file-write* (subpath ${quote(path)}))`),
    ...(paths.proxyPort ? [`(allow network-outbound (remote ip "localhost:${Math.trunc(paths.proxyPort)}"))`] : []),
  ].join('\n');
}

/** The sandbox for this computer: Seatbelt on macOS. Other systems get theirs later. */
export function systemConfine(): Confine | null {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return null;
  return (command, args, paths) => ({ command: '/usr/bin/sandbox-exec', args: ['-p', seatbeltProfile(paths), command, ...args] });
}

/** Environment for confined Python: nothing from ros.ai's own environment, so no keys or tokens reach a cell. */
export function confinedEnv(home: string, tmp: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp, MPLCONFIGDIR: join(tmp, 'matplotlib'), MPLBACKEND: 'Agg', LANG: 'en_US.UTF-8',
    PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1',
    OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1', ...extra };
}

/** Sends Python's web traffic (pip, urllib, requests) through the ros.ai network proxy. */
export function proxyEnv(port: number, certFile: string): Record<string, string> {
  const proxy = `http://127.0.0.1:${port}`;
  return { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: '', no_proxy: '', SSL_CERT_FILE: certFile,
    REQUESTS_CA_BUNDLE: certFile, PIP_DISABLE_PIP_VERSION_CHECK: '1' };
}

type ProcessRow = { pid: number; ppid: number; pgid: number; rss: number };
const processRows = () => new Promise<ProcessRow[] | undefined>(resolve => execFile('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'rss='], { timeout: 2000, maxBuffer: 5_000_000 }, (error, stdout) => {
  if (error) return resolve(undefined);
  resolve(String(stdout).split('\n').map(line => line.trim().split(/\s+/u).map(Number)).filter(values => values.length === 4 && values.every(Number.isInteger))
    .map(([pid, ppid, pgid, rss]) => ({ pid: pid!, ppid: ppid!, pgid: pgid!, rss: rss! })));
}));
const signalled = (target: number, signal: NodeJS.Signals) => { try { process.kill(target, signal); } catch { /* already gone */ } };

/** A confined Python and every process it starts, also one that leaves its process group for a session of its own
 * (start_new_session): found by parent or group twice a second and remembered, so one whose parent ended is still
 * found. They are held to the memory and process caps together and ended together. When Python itself ends, the rest
 * are ended, and its output is closed after a short grace even if a process ros.ai never saw still holds it open, so
 * a run, Stop and Restart always finish. */
export class ProcessTree {
  private readonly root: number;
  private readonly timer: NodeJS.Timeout;
  private known = new Set<number>();
  private groups: Set<number>;
  private busy = false;
  private ended = false;

  constructor(child: ChildProcess, limits: { memoryMb: number; processes: number }, onLimit: (reason: string) => void, graceMs = 1000) {
    if (!child.pid) throw new Error('Python did not start.');
    // Started detached, so Python leads a session and process group of its own.
    this.root = child.pid;
    this.groups = new Set([this.root]);
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      void processRows().then(rows => {
        this.busy = false;
        if (!rows || this.ended) return;
        const members = this.find(rows), rss = members.reduce((sum, row) => sum + row.rss, 0);
        if (rss > limits.memoryMb * 1024) onLimit(`used more than ${limits.memoryMb >= 1024 ? `${limits.memoryMb / 1024} GB` : `${limits.memoryMb} MB`} of memory`);
        else if (members.length > limits.processes) onLimit(`started more than ${limits.processes} processes`);
      });
    }, 500);
    this.timer.unref();
    child.once('exit', () => {
      this.end();
      // What Python wrote before it ended fits in the pipes' buffers, and is read in the input pass the immediate waits for.
      const closing = setTimeout(() => setImmediate(() => { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); }), graceMs);
      child.once('close', () => clearTimeout(closing));
    });
  }

  /** Ends every process of the run: paused first, so none starts another while the rest are found, then all killed.
   * Safe to call again; each call ends what has been found by then. */
  end(): void {
    this.ended = true;
    clearInterval(this.timer);
    this.signal('SIGSTOP');
    void processRows().then(rows => { if (rows) this.find(rows); this.signal('SIGKILL'); });
  }

  /** The run's processes in a listing: Python, those remembered from earlier listings, those whose parent is one of
   * them, and those in their process groups. A process can only join a group of its own session, and every session
   * here was started by the run, so no other program's process is taken. */
  private find(rows: ProcessRow[]): ProcessRow[] {
    const found = new Map<number, ProcessRow>(), groups = new Set(this.groups);
    for (let grew = true; grew;) {
      grew = false;
      for (const row of rows) {
        if (found.has(row.pid) || !(row.pid === this.root || this.known.has(row.pid) || found.has(row.ppid) || groups.has(row.pgid))) continue;
        found.set(row.pid, row);
        groups.add(row.pgid);
        grew = true;
      }
    }
    // Only what is running now is kept, so a number the system gives a new process later is never taken for the run's.
    this.known = new Set([...found.keys()].filter(pid => pid !== this.root));
    this.groups = new Set([this.root, ...[...found.values()].map(row => row.pgid)]);
    return [...found.values()];
  }

  private signal(signal: NodeJS.Signals): void {
    for (const group of this.groups) signalled(-group, signal);
    for (const pid of [this.root, ...this.known]) signalled(pid, signal);
  }
}

