import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PythonRuntime, seatbeltProfile } from '../src/server/local-python.js';
import { LocalPythonBackend } from '../src/server/sandbox.js';

test('the Seatbelt profile denies by default, grants no network and keeps the home folder closed', () => {
  const profile = seatbeltProfile({ read: ['/Users/ada/My "Project"'], write: ['/private/tmp/ros-work'] }, '/Users/ada');
  assert.match(profile, /^\(version 1\)\n\(deny default\)/u);
  assert.doesNotMatch(profile, /network/u);
  assert.match(profile, /\(allow file-read\* \(require-all \(require-not \(subpath "\/Users\/ada"\)\) \(require-not \(subpath "\/Volumes"\)\)\)\)/u);
  assert.match(profile, /\(allow file-read\* \(subpath "\/Users\/ada\/My \\"Project\\""\)\)/u);
  assert.match(profile, /\(allow file-read\* file-write\* \(subpath "\/private\/tmp\/ros-work"\)\)/u);
});

test('without an OS sandbox the local backend reports itself unavailable and refuses to run', () => {
  const backend = new LocalPythonBackend(new PythonRuntime(join(mkdtempSync(join(tmpdir(), 'ros-py-')), 'python')), null);
  assert.equal(backend.capabilities().available, false);
  assert.equal(backend.capabilities().backend, 'docker-python');
  assert.throws(() => backend.start({ code: 'print(1)', parameters: {} }), /unavailable/u);
});

test('Python is reported as set up on the first run until it is installed', () => {
  const runtime = new PythonRuntime(join(mkdtempSync(join(tmpdir(), 'ros-py-')), 'python'));
  assert.equal(runtime.state().status, 'missing');
  const backend = new LocalPythonBackend(runtime, (command, args) => ({ command, args }));
  assert.equal(backend.capabilities().available, true);
  assert.match(backend.capabilities().runtime ?? '', /set up on the first run/u);
});

test('the Seatbelt profile allows the network proxy port and nothing else', () => {
  const profile = seatbeltProfile({ read: [], write: [], proxyPort: 51234 }, '/Users/ada');
  assert.deepEqual(profile.split('\n').filter(line => line.includes('network')), ['(allow network-outbound (remote ip "localhost:51234"))']);
});
