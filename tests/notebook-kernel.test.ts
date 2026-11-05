import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NotebookKernelProcess, type KernelMessage } from '../src/server/notebook-kernel.js';
import { ProcessTree } from '../src/server/local-python.js';

// The notebook kernel as ros.ai runs it without Docker, on this computer's Python and without the OS sandbox. The
// libraries it loads at start are stand-ins, so the test needs no pandas or matplotlib.
const python = (() => {
  const found = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : undefined;
})();
const skip = process.platform === 'win32' ? 'the kernel without Docker runs on macOS' : python ? false : 'needs python3';
const STAND_INS: Record<string, string> = {
  'matplotlib/__init__.py': 'def use(*args, **kwargs): pass\n',
  'matplotlib/pyplot.py': 'def get_fignums(): return []\ndef figure(*args, **kwargs): pass\ndef close(*args, **kwargs): pass\n',
  'matplotlib/artist.py': 'class Artist: pass\n',
  'matplotlib/figure.py': 'class Figure: pass\n',
  'numpy/__init__.py': '',
  'pandas/__init__.py': 'class DataFrame: pass\nclass Series: pass\nclass RangeIndex: pass\n',
};

async function until<T>(find: () => T | undefined, what: string, ms = 10_000): Promise<T> {
  for (const deadline = Date.now() + ms; ;) {
    const value = find();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Waited ${ms / 1000} s for ${what}.`);
    await delay(20);
  }
}
/** Gone, or ended and waiting to be collected by the system. */
const ended = (pid: number) => { const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }); return state.status !== 0 || /^Z/u.test(state.stdout.trim()); };

function notebook(t: TestContext, local?: (folder: string) => { python: string; args?: string[] }) {
  const folder = mkdtempSync(join(tmpdir(), 'ros-kernel-')), modules = join(folder, 'modules');
  for (const [path, text] of Object.entries(STAND_INS)) { mkdirSync(dirname(join(modules, path)), { recursive: true }); writeFileSync(join(modules, path), text); }
  const messages: KernelMessage[] = [];
  const chosen = local?.(folder);
  const kernel = new NotebookKernelProcess({ image: 'unused', owner: 'test', onMessage: message => messages.push(message), onExit: () => undefined,
    local: { python: chosen?.python ?? python!, home: folder,
      confine: (command, args) => ({ command, args: chosen?.args ?? [...args.slice(0, -1), `import sys; sys.path.insert(0, ${JSON.stringify(modules)})\n${args.at(-1)}`] }) } });
  t.after(async () => { await kernel.stop(); rmSync(folder, { recursive: true, force: true }); });
  const done = (id: string) => until(() => messages.find((message): message is Extract<KernelMessage, { type: 'done' }> => message.type === 'done' && message.id === id), `cell ${id} to end`);
  const printed = (id: string) => messages.filter(message => message.type === 'stream' && message.id === id).map(message => message.type === 'stream' ? message.text : '').join('');
  return { kernel, messages, done, printed };
}

test('A cell whose error has a very long line ends as an error, and printing a broken character keeps the notebook running', { skip, timeout: 60_000 }, async t => {
  const { kernel, messages, done, printed } = notebook(t);
  kernel.start();
  await until(() => messages.find(message => message.type === 'ready'), 'Python to start');

  // A pasted data line with a typo: its traceback line is longer than ros.ai takes.
  kernel.execute({ id: 'long', code: "row = 'x' * 30000\nraise ValueError(row)", count: 1 });
  const failed = await done('long');
  assert.equal(failed.status, 'error');
  assert.match(failed.error!.traceback.at(-1)!, /^ValueError: x+ \[ros\.ai: 20012 more characters left out\]$/u);

  // An unpaired surrogate, as file names and cut emoji can hold, printed and raised.
  kernel.execute({ id: 'odd', code: "print('\\ud800 in a name')", count: 2 });
  assert.equal((await done('odd')).status, 'ok');
  assert.equal(printed('odd'), '\ud800 in a name\n');
  kernel.execute({ id: 'raised', code: "raise ValueError('\\udc80')", count: 3 });
  assert.equal((await done('raised')).error?.evalue, '\udc80');
  kernel.execute({ id: 'after', code: "x = 2\nprint(x * 21)", count: 4 });
  assert.equal((await done('after')).status, 'ok');
  assert.equal(printed('after'), '42\n');
});

test('A cell that ends with a message ros.ai does not take still ends, as an error', { skip: process.platform === 'win32' && 'the kernel without Docker runs on macOS', timeout: 30_000 }, async t => {
  const reply = { type: 'done', id: 'cell-1', status: 'error', error: { ename: 'ValueError', evalue: 'bad', traceback: ['x'.repeat(30_000)] } };
  const { kernel, done } = notebook(t, () => ({ python: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(`${JSON.stringify(reply)}\n`)}); setTimeout(() => undefined, 5000);`] }));
  kernel.start();
  assert.deepEqual(await done('cell-1'), { type: 'done', id: 'cell-1', status: 'error', error: { ename: 'Error', evalue: 'The cell failed, and its error was too large for ros.ai to show.', traceback: [] } });
});

test('Stop ends a process a cell started in a session of its own, and does not wait on it', { skip, timeout: 60_000 }, async t => {
  const { kernel, messages, done, printed } = notebook(t);
  kernel.start();
  await until(() => messages.find(message => message.type === 'ready'), 'Python to start');
  kernel.execute({ id: 'away', code: "import subprocess, sys\nchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)\nprint(child.pid)", count: 1 });
  assert.equal((await done('away')).status, 'ok');
  const away = Number(printed('away').trim());
  t.after(() => { try { process.kill(away, 'SIGKILL'); } catch { /* already gone */ } });
  assert.ok(away > 0 && !ended(away));
  // The person presses Stop a moment later. The process holds Python's output open and is in no group ros.ai ends.
  await delay(1200);
  const started = Date.now();
  await Promise.race([kernel.stop(), delay(8000).then(() => { throw new Error('Stop was still waiting after 8 s.'); })]);
  assert.ok(Date.now() - started < 8000);
  await until(() => ended(away) || undefined, 'the process to end', 3000);
});

test('Processes that leave Python’s process group count against its caps, and end with it', { skip, timeout: 60_000 }, async () => {
  const script = "import subprocess, sys, time\nfor _ in range(3):\n    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)\n    print(child.pid, flush=True)\ntime.sleep(30)";
  const child = spawn(python!, ['-c', script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (text: string) => { output += text; });
  const closed = new Promise(resolve => child.once('close', resolve));
  const reasons: string[] = [];
  const tree = new ProcessTree(child, { memoryMb: 100_000, processes: 3 }, reason => reasons.push(reason));
  const away = await until(() => { const pids = output.split('\n').filter(Boolean).map(Number); return pids.length === 3 ? pids : undefined; }, 'three processes to start');
  try {
    assert.match(await until(() => reasons[0], 'the process cap'), /^started more than 3 processes$/u);
    tree.end();
    await Promise.race([closed, delay(8000).then(() => { throw new Error('Python’s output was still open after 8 s.'); })]);
    await until(() => away.every(ended) || undefined, 'every process to end', 3000);
  } finally {
    for (const pid of away) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});
