import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewCode } from '../src/server/review-code.js';

test('trusted AST review recognizes dataframe, numerical, statistics and matplotlib operations', () => {
  const samples = [
    'metric("Mean", df["value"].mean())\ntable("Summary", df.describe().reset_index())\nfig, ax = plt.subplots()\nax.plot(df["value"])\nplot("Values", fig)',
    `import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from scipy.stats import linregress as regression
df["date"] = pd.to_datetime(df["date"])
df["weekend"] = df["date"].dt.dayofweek >= 5
summary = df.groupby("weekend").agg(count=("bicycles", "size"), mean=("bicycles", "mean")).reset_index()
table("Grouped counts", summary)
fit = regression(df["rain"], df["bicycles"])
metric("Slope", fit.slope)
fig, ax = plt.subplots(figsize=(7, 4))
for weekend, group in df.groupby("weekend"):
    ax.scatter(group["rain"], group["bicycles"], label=str(weekend))
ax.set(xlabel="Rain (mm)", ylabel="Bicycle counts", title="Association, not causation")
ax.legend()
plot("Rain and cycling", fig)
export_csv("Grouped data", summary)
conclusion("Examine the measured association and confounding factors.")`,
    `import numpy as numerical
from math import sqrt as root
average = numerical.mean
def summarize(values):
    return average(values) / root(len(values))
metric("Summary", summarize(df["value"]))`,
    `from scipy import stats
from collections import Counter
from datetime import datetime
import json
counts = Counter(["a", "a", "b"])
table("Counts", [{"key": k, "value": v} for k, v in counts.items()])
metric("Tail", stats.norm.cdf(1.0))
conclusion(json.dumps({"year": datetime(2026, 1, 1).year}))`,
    `rng = np.random.default_rng(42)
sample = rng.normal(size=100)
metric("Average", np.mean(sample))
_, ax = plt.subplots()
ax.hist(sample)
plot("Samples")`,
  ];
  for (const code of samples) assert.equal(reviewCode(code).allowed, true, `${reviewCode(code).reason}\n${code}`);
});

test('same-line imports, import aliases, module subpaths and indirect I/O all escalate', () => {
  const samples = [
    'metric("start", 1); import os\nmetric("pid", os.getpid())',
    'import subprocess as math\nmath.run(["echo", "no"])',
    'from os import system as numerical_mean\nnumerical_mean("echo no")',
    'import pandas.io.common as data_tools\ndata_tools.os.system("echo no")',
    'import numpy.ctypeslib as numbers\nnumbers.load_library("foo", "/tmp")',
    'from pandas import read_table as grouped\ngrouped("/etc/passwd")',
    'reader = pd.read_table\nreader("/etc/passwd")',
    'numbers = np\nread = numbers.fromfile\nread("/etc/passwd")',
    'np.lib.format.open_memmap("file")',
    'pd.io.common.os.system("echo no")',
    'getattr(pd, "read_csv")("/etc/passwd")',
    'df.__class__.__mro__',
    'f = eval\nf("1+1")',
    'vars(pd)',
    'import numpy as np\nnp.fromfile("/etc/passwd")',
    'from json import load\nload(params["file"])',
    'df.to_pickle("file.pkl")',
    'df.to_sql("table", params["connection"])',
    'fig, ax = plt.subplots()\nfig.savefig("figure.svg")',
    'df.query("x > 0")',
    'df.eval("x + y")',
    'df.agg("to_pickle", "data.pkl")',
    'df.apply("to_csv", args=("data.csv",))',
    'df.groupby("group").agg({"value": "unfamiliar"})',
    'df.agg(params["operation"])',
    'np.mean(df["value"], **params)',
    'print("hello", file=params["out"])',
    'from numpy import *\nmean(df["value"])',
  ];
  for (const code of samples) assert.equal(reviewCode(code).allowed, false, code);
});

test('unfamiliar calls and dynamic/replaced authority escalate instead of being assumed safe', () => {
  for (const code of [
    'unknown_analysis(df)',
    'df.unfamiliar_method()',
    'pd.unfamiliar_method(df)',
    'function = params["callable"]\nfunction(df)',
    'pd.mean = np.mean',
    'metric = np.mean',
    'import numpy as metric',
    'def metric(x):\n    return x',
    'class Research:\n    pass',
    'f = lambda x: x.unknown()\nf(df)',
    'def research(callback):\n    return callback(df)',
  ]) assert.equal(reviewCode(code).allowed, false, code);
});

test('parsing never executes supplied code and missing/malformed/oversized parsing fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-code-review-'));
  const target = join(dir, 'must-not-be-created');
  try {
    const attempt = reviewCode(`open(${JSON.stringify(target)}, "w").write("no")`);
    assert.equal(attempt.allowed, false);
    assert.equal(existsSync(target), false);
    assert.equal(reviewCode('metric("ok", 1)', { python: join(dir, 'missing-python') }).allowed, false);
    assert.match(reviewCode('metric("ok", 1)', { python: join(dir, 'missing-python') }).reason, /unavailable/);
    assert.equal(reviewCode('if invalid syntax').allowed, false);
    assert.equal(reviewCode('').allowed, false);
    assert.equal(reviewCode('x = ' + '1'.repeat(20_001)).allowed, false);
    const allowed = reviewCode('metric("x", 1)');
    assert.equal(allowed.allowed, true);
    assert.match(allowed.reason, /not proof/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
