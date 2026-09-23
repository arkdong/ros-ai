"""Trusted capture helpers. Security boundary is Docker/Linux, not Python exec.

The program has ordinary Python semantics inside its restricted container. Never
mount user folders, credentials, the Docker socket, or the original data source.
"""
import contextlib
import io
import json
import math
import os
import platform
import resource
import sys
import traceback
from datetime import date, datetime

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import scipy

MAX_OUTPUTS = 20
MAX_CONTENT = 500_000
MAX_CAPTURE = 100_000
outputs = []


class CapturedText(io.TextIOBase):
    def __init__(self):
        self.parts = []
        self.length = 0

    def write(self, value):
        if self.length + len(value) > MAX_CAPTURE:
            raise RuntimeError("Program text output exceeds 100 KB.")
        self.parts.append(value)
        self.length += len(value)
        return len(value)

    def getvalue(self):
        return "".join(self.parts)


def json_default(value):
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, (datetime, date, pd.Timestamp)):
        return value.isoformat()
    if isinstance(value, np.ndarray):
        return value.tolist()
    raise TypeError(f"Unsupported output value: {type(value).__name__}")


def add(kind, title, content, media_type):
    if len(outputs) >= MAX_OUTPUTS:
        raise ValueError("At most 20 captured outputs per attempt.")
    if not isinstance(title, str) or not title.strip() or len(title) > 200:
        raise ValueError("Output title must have 1-200 characters.")
    if len(content.encode("utf-8")) > MAX_CONTENT:
        raise ValueError("One output exceeds 500 KB; summarize or plot fewer rows.")
    outputs.append({"kind": kind, "title": title, "content": content, "mediaType": media_type})


def table(title, data):
    if isinstance(data, pd.Series):
        data = data.reset_index()
    if isinstance(data, pd.DataFrame):
        if len(data) > 10_000 or len(data.columns) > 100:
            raise ValueError("Table exceeds 10,000 rows or 100 columns.")
        # pandas converts missing/non-finite values to JSON null.
        content = data.to_json(orient="records", date_format="iso", indent=2)
    else:
        content = json.dumps(data, default=json_default, allow_nan=False, indent=2)
    add("table", title, content, "application/json")


def metric(title, value):
    add("metric", title, json.dumps({"value": value}, default=json_default, allow_nan=False), "application/json")


def plot(title, figure=None):
    figure = plt.gcf() if figure is None else figure
    stream = io.StringIO()
    figure.savefig(stream, format="svg", bbox_inches="tight", metadata={"Date": None})
    add("plot", title, stream.getvalue(), "image/svg+xml")
    plt.close(figure)


def export_csv(title, frame):
    if not isinstance(frame, pd.DataFrame):
        frame = pd.DataFrame(frame)
    add("dataset", title, frame.to_csv(index=False), "text/csv")


def conclusion(text):
    add("result", "Experiment conclusion", str(text), "text/plain")


def main():
    # These limits supplement container memory/CPU/PID and parent wall-clock caps.
    resource.setrlimit(resource.RLIMIT_CPU, (25, 25))
    resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024, 16 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    runtime = f"Python {platform.python_version()} · pandas {pd.__version__} · NumPy {np.__version__} · matplotlib {matplotlib.__version__} · SciPy {scipy.__version__}"
    captured_out, captured_err = CapturedText(), CapturedText()
    error = None
    try:
        frame = pd.read_csv("/input/dataset.csv")
        if len(frame) > 100_000 or len(frame.columns) > 100:
            raise ValueError("Dataset exceeds 100,000 rows or 100 columns.")
        with open("/input/parameters.json", encoding="utf-8") as handle:
            parameters = json.load(handle)
        with open("/input/program.py", encoding="utf-8") as handle:
            code = handle.read()
        scope = {"__name__": "__research__", "df": frame, "params": parameters,
                 "pd": pd, "np": np, "plt": plt, "scipy": scipy,
                 "table": table, "metric": metric, "plot": plot,
                 "export_csv": export_csv, "conclusion": conclusion}
        with contextlib.redirect_stdout(captured_out), contextlib.redirect_stderr(captured_err):
            exec(compile(code, "/input/program.py", "exec"), scope, scope)
    except BaseException as failure:
        error = f"{type(failure).__name__}: {failure}"[:2000]
        detail = "".join(traceback.format_exception(type(failure), failure, failure.__traceback__))[-15_000:]
        try:
            captured_err.write(detail)
        except RuntimeError:
            pass
    result = {"ok": error is None, "outputs": outputs, "stdout": captured_out.getvalue(),
              "stderr": captured_err.getvalue(), "runtime": runtime, "error": error}
    sys.stdout.write(json.dumps(result, default=json_default, allow_nan=False))
    sys.stdout.flush()
    return 0 if error is None else 1


if __name__ == "__main__":
    sys.exit(main())
