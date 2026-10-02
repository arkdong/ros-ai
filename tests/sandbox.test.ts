import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DockerPythonBackend, UnavailableNebiusSandboxBackend, type SandboxResult } from '../src/server/sandbox.js';

// These are real local container checks, never fixtures for model/provider success.
const backend = new DockerPythonBackend();
const docker = { skip: !backend.capabilities().available };
const run = (code: string, timeoutMs?: number) => backend.start({ csv: 'x,y,day\n1,3,weekday\n2,5,weekday\n3,7,weekend\n4,9,weekend\n', parameters: { scale: 2 }, code, timeoutMs });
const value = (result: SandboxResult, title: string) => JSON.parse(result.outputs.find(output => output.title === title)!.content).value;

test('isolated execution fails closed when Docker/image is missing; unverified Nebius is unavailable', () => {
  const unavailable = new DockerPythonBackend({ docker: '/ros-test-no-such-docker' });
  assert.equal(unavailable.capabilities().available, false);
  assert.throws(() => unavailable.start({ csv: 'x\n1', code: 'print(1)', parameters: {} }), /unavailable/);
  const nebius = new UnavailableNebiusSandboxBackend();
  assert.equal(nebius.capabilities().available, false);
  assert.throws(() => nebius.start({ csv: '', code: '', parameters: {} }), /unverified/);
  if (process.env.ROS_REQUIRE_DOCKER_TESTS === '1') assert.equal(backend.capabilities().available, true, backend.capabilities().limitations.join('\n'));
});

test('actual Python research libraries compute captured CSV, SVG, table, export and conclusion', docker, async () => {
  const result = await run(`from scipy.stats import linregress
fit = linregress(df.x, df.y)
metric("Slope", fit.slope)
metric("Scaled mean", df.y.mean() * params["scale"])
table("Grouped means", df.groupby("day", as_index=False).y.mean())
fig, ax = plt.subplots()
ax.scatter(df.x, df.y)
ax.set(xlabel="x", ylabel="y")
plot("Measured values", fig)
export_csv("Grouped output", df.groupby("day", as_index=False).y.mean())
print("Analyzed", len(df), "rows")
conclusion("The fixture has an exact slope of 2; this is a local computation, not a live model claim.")`).done;
  assert.equal(result.status, 'completed', result.error);
  assert.equal(value(result, 'Slope'), 2);
  assert.equal(value(result, 'Scaled mean'), 12);
  assert.match(result.outputs.find(output => output.kind === 'plot')!.content, /<svg/);
  assert.match(result.outputs.find(output => output.kind === 'dataset')!.content, /weekday,4.0/);
  assert.match(result.stdout, /Analyzed 4 rows/);
  assert.match(result.runtime!, /Python 3.12.11/);
  assert.deepEqual(backend.capabilities().libraries, { numpy: '2.2.6', pandas: '2.2.3', matplotlib: '3.10.3', scipy: '1.15.3' });
});

test('actual Linux isolation blocks original files, input writes, network and host credentials', docker, async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'ros-isolation-canary-'));
  const secret = join(fixture, 'private.txt'), escaped = join(fixture, 'escaped.txt');
  writeFileSync(secret, 'private-host-canary');
  const previous = process.env.ROS_SANDBOX_CANARY_SECRET;
  process.env.ROS_SANDBOX_CANARY_SECRET = 'not-for-experiment';
  try {
    const result = await run(`import os, socket, subprocess
def denied(label, call):
    try:
        call()
        metric(label, False)
    except (OSError, PermissionError):
        metric(label, True)
denied("host read denied", lambda: open(${JSON.stringify(secret)}).read())
denied("host write denied", lambda: open(${JSON.stringify(escaped)}, "w").write("escaped"))
denied("input write denied", lambda: open("/input/dataset.csv", "w").write("changed"))
denied("root write denied", lambda: open("/etc/ros-test", "w").write("changed"))
denied("network denied", lambda: socket.create_connection(("1.1.1.1", 443), 1))
metric("credential absent", os.environ.get("ROS_SANDBOX_CANARY_SECRET") is None)
metric("proxy cleared", not os.environ.get("HTTP_PROXY"))
metric("nonroot", os.getuid() != 0)
metric("memory bytes", int(open("/sys/fs/cgroup/memory.max").read()))
metric("swap bytes", int(open("/sys/fs/cgroup/memory.swap.max").read()))
metric("pids", int(open("/sys/fs/cgroup/pids.max").read()))
metric("cpu quota", open("/sys/fs/cgroup/cpu.max").read().strip())
status = dict(line.split(":", 1) for line in open("/proc/self/status") if ":" in line)
metric("seccomp filter", status["Seccomp"].strip())
metric("no new privileges", status["NoNewPrivs"].strip())
metric("capabilities dropped", int(status["CapEff"].strip(), 16))
denied("root escalation denied", lambda: os.setuid(0))
shell = subprocess.run(["/bin/sh", "-c", "echo changed > /input/dataset.csv"], capture_output=True)
metric("shell cannot change input", shell.returncode != 0)`).done;
    assert.equal(result.status, 'completed', result.error);
    for (const title of ['host read denied', 'host write denied', 'input write denied', 'root write denied', 'network denied', 'credential absent', 'proxy cleared', 'nonroot', 'shell cannot change input', 'root escalation denied']) assert.equal(value(result, title), true, title);
    assert.equal(value(result, 'memory bytes'), 512 * 1024 * 1024);
    assert.equal(value(result, 'swap bytes'), 0);
    assert.equal(value(result, 'pids'), 32);
    assert.equal(value(result, 'cpu quota'), '100000 100000');
    assert.equal(value(result, 'seccomp filter'), '2');
    assert.equal(value(result, 'no new privileges'), '1');
    assert.equal(value(result, 'capabilities dropped'), 0);
    assert.equal(readFileSync(secret, 'utf8'), 'private-host-canary');
    assert.equal(existsSync(escaped), false);
  } finally {
    if (previous === undefined) delete process.env.ROS_SANDBOX_CANARY_SECRET; else process.env.ROS_SANDBOX_CANARY_SECRET = previous;
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('failed attempts preserve prior outputs and traceback; a revision executes independently', docker, async () => {
  const first = await run('metric("Before error", 42)\nprint("Reached dataframe lookup")\ntable("Bad", df["missing"])').done;
  assert.equal(first.status, 'failed');
  assert.match(first.error!, /KeyError.*missing/);
  assert.equal(value(first, 'Before error'), 42);
  assert.match(first.stdout, /Reached dataframe lookup/);
  assert.match(first.stderr, /Traceback/);
  const second = await run('metric("Revised mean", df.y.mean())').done;
  assert.equal(second.status, 'completed', second.error);
  assert.equal(value(second, 'Revised mean'), 6);
  assert.equal(value(first, 'Before error'), 42);
});

test('wall deadline and explicit stop remove the whole container including its subprocesses', docker, async () => {
  const timedAttempt = run('import time\ntime.sleep(60)', 1000);
  const timeout = await timedAttempt.done;
  assert.equal(timeout.status, 'failed');
  assert.match(timeout.error!, /wall time/);
  const attempt = run('import subprocess,time\nsubprocess.Popen(["python", "-c", "import time; time.sleep(60)"])\ntime.sleep(60)');
  await delay(1200);
  const stoppedAt = Date.now();
  attempt.cancel('Fixture requested stop.');
  const stopped = await attempt.done;
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.error, 'Fixture requested stop.');
  assert.ok(Date.now() - stoppedAt < 6000, 'Cancellation should terminate all container processes promptly.');
  for (const handle of [timedAttempt, attempt]) {
    const inspect = spawnSync('docker', ['inspect', handle.containerName!], { encoding: 'utf8' });
    assert.notEqual(inspect.status, 0, 'This fixture container and all its children should be removed.');
    assert.match(inspect.stderr, /no such (object|container)/i);
  }
});

test('cancel during container creation cannot miss the new container, and output is bounded', docker, async () => {
  const attempt = run('import time\ntime.sleep(60)');
  attempt.cancel();
  assert.equal((await attempt.done).status, 'cancelled');
  const noisy = await run('print("x" * 150000)').done;
  assert.equal(noisy.status, 'failed');
  assert.match(noisy.error!, /100 KB/);
  const fileBomb = await run('with open("/work/large", "wb") as f:\n    for _ in range(64):\n        f.write(b"x" * 1048576)').done;
  assert.equal(fileBomb.status, 'failed');
  assert.match(fileBomb.error!, /File too large/);
});
