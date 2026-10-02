import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireDataLock } from '../src/server/lock.js';

test('data-directory lock rejects competing opens and can be acquired after release', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ros-ai-lock-'));
  let release: (() => void) | undefined;
  try {
    release = acquireDataLock(directory);
    assert.throws(() => acquireDataLock(directory), /already open in ros.ai/);
    // A separate investigation directory can run in another process.
    const releaseOther = acquireDataLock(join(directory, 'other'));
    releaseOther();
    release();
    release(); // Shutdown cleanup is intentionally idempotent.
    release = acquireDataLock(directory);
    assert.throws(() => acquireDataLock(directory), /already open in ros.ai/);
  } finally {
    release?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an abrupt process death releases the data lock without deleting any lock file', { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ros-ai-lock-crash-'));
  const lockModule = new URL('../src/server/lock.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { acquireDataLock } from ${JSON.stringify(lockModule)};
    acquireDataLock(process.env.ROS_TEST_LOCK_DIRECTORY);
    process.stdout.write('locked\\n');
    setInterval(() => {}, 1000);
  `], { env: { ...process.env, ROS_TEST_LOCK_DIRECTORY: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  let release: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Lock fixture did not start')), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Lock fixture exited before acquiring lock (${code})`)); });
      child.stdout.on('data', chunk => {
        output += String(chunk);
        if (output.includes('locked\n')) { clearTimeout(timer); resolve(); }
      });
    });
    assert.throws(() => acquireDataLock(directory), /already open in ros.ai/);
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
    release = acquireDataLock(directory);
    assert.throws(() => acquireDataLock(directory), /already open in ros.ai/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
    release?.();
    rmSync(directory, { recursive: true, force: true });
  }
});
