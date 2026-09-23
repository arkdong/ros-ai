"""Trusted standard-library capture worker for an isolated remote Python VM.

Run as ``python -I -c <this source>`` with a bounded JSON request on stdin.
The supplied program has ordinary Python semantics. These capture helpers and
per-process rlimits are not a Python security boundary or provider VM quotas.
Never run model-produced programs through this worker on the application host.
"""

import contextlib
import csv
import html
import io
import json
import math
import platform
import sys
import traceback
from collections.abc import Sequence


MAX_INPUT = 700_000
MAX_CODE = 20_000
MAX_ROWS = 10_000
MAX_COLUMNS = 100
MAX_OUTPUTS = 20
MAX_CONTENT = 100_000
MAX_CAPTURE = 50_000
MAX_BUNDLE = 500_000
# Leave room for an error even after a program fills its capture allowance.
ERROR_RESERVE = 16_000
MAX_PLOT_POINTS = 1_000


def bounded_text(value, limit):
    """Return a valid UTF-8 prefix, with a bound measured in bytes."""
    return str(value).encode("utf-8", errors="replace")[:limit].decode(
        "utf-8", errors="ignore"
    )


def encoded_json(value):
    # ASCII serialization makes the final wire byte count unambiguous, including
    # escaped control characters and user strings containing lone surrogates.
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":"))


class Capture:
    def __init__(self):
        self.outputs = []
        self.stdout = ""
        self.stderr = ""
        self.text_bytes = 0
        self.runtime = f"Python {platform.python_version()} · standard library capture worker"

    def result(self, error=None):
        return {
            "ok": error is None,
            "outputs": self.outputs,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "runtime": self.runtime,
            "error": error,
        }

    def within_budget(self):
        return len(encoded_json(self.result())) <= MAX_BUNDLE - ERROR_RESERVE

    def write(self, stream, value):
        if not isinstance(value, str):
            raise TypeError("Text output must be a string.")
        remaining = MAX_CAPTURE - self.text_bytes
        size = len(value.encode("utf-8", errors="replace"))
        prefix = bounded_text(value, remaining)
        previous = getattr(self, stream)
        setattr(self, stream, previous + prefix)
        if not self.within_budget():
            setattr(self, stream, previous)
            raise ValueError("Captured result exceeds the 500 KB serialized limit.")
        self.text_bytes += len(prefix.encode("utf-8"))
        if size > remaining:
            raise ValueError("Combined stdout and stderr exceeds 50 KB.")
        return len(value)

    def add(self, kind, title, content, media_type):
        if len(self.outputs) >= MAX_OUTPUTS:
            raise ValueError("At most 20 captured outputs per attempt.")
        validate_title(title)
        if len(content.encode("utf-8")) > MAX_CONTENT:
            raise ValueError("One captured output exceeds 100 KB; summarize fewer rows.")
        output = {"kind": kind, "title": title, "content": content, "mediaType": media_type}
        self.outputs.append(output)
        if not self.within_budget():
            self.outputs.pop()
            raise ValueError("Captured result exceeds the 500 KB serialized limit.")

    def table(self, title, data):
        validate_records(data)
        self.add("table", title, json.dumps(data, ensure_ascii=False, allow_nan=False), "application/json")

    def metric(self, title, value):
        validate_scalar(value)
        self.add("metric", title, json.dumps({"value": value}, ensure_ascii=False, allow_nan=False), "application/json")

    def conclusion(self, text):
        self.add("result", "Experiment conclusion", str(text), "text/plain")

    def export_csv(self, title, data):
        columns = validate_records(data)
        stream = io.StringIO(newline="")
        writer = csv.DictWriter(stream, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        # Stop growing the CSV as soon as its character count already exceeds
        # the byte limit; add() also checks multibyte UTF-8 content.
        for row in data:
            writer.writerow(row)
            if stream.tell() > MAX_CONTENT:
                raise ValueError("One captured output exceeds 100 KB; summarize fewer rows.")
        self.add("dataset", title, stream.getvalue(), "text/csv")

    def plot(self, title, values, labels=None):
        validate_title(title)
        if isinstance(values, (str, bytes)) or not isinstance(values, Sequence) or not 1 <= len(values) <= MAX_PLOT_POINTS:
            raise ValueError("Plot needs a sequence of 1-1,000 numeric values.")
        numbers = []
        for value in values:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise TypeError("Plot values must be finite numbers.")
            number = float(value)
            if not math.isfinite(number):
                raise ValueError("Plot values must be finite numbers.")
            numbers.append(number)
        if labels is None:
            labels = [str(index + 1) for index in range(len(numbers))]
        if isinstance(labels, (str, bytes)) or not isinstance(labels, Sequence) or len(labels) != len(numbers):
            raise ValueError("Plot labels must match the number of values.")
        if any(not isinstance(label, str) or len(label) > 200 for label in labels):
            raise ValueError("Plot labels must be strings of at most 200 characters.")

        low, high = min(numbers), max(numbers)
        # Scale before subtracting so opposite large finite values cannot
        # overflow their range and create invalid coordinates.
        scale = max(abs(low), abs(high), 1.0)
        scaled_low, scaled_high = low / scale, high / scale
        spread = scaled_high - scaled_low
        points = []
        for index, number in enumerate(numbers):
            x = 64 + (index * 608 / (len(numbers) - 1) if len(numbers) > 1 else 304)
            y = 174 if spread == 0 else 292 - (number / scale - scaled_low) / spread * 236
            points.append((x, y))
        def escaped(text):
            # html.escape covers markup; replace characters forbidden by XML
            # so titles/labels cannot create malformed SVG text nodes.
            valid = "".join(
                char if char in "\t\n\r" or 0x20 <= ord(char) <= 0xD7FF
                or 0xE000 <= ord(char) <= 0xFFFD or 0x10000 <= ord(char) <= 0x10FFFF
                else "\ufffd" for char in str(text)
            )
            return html.escape(valid, quote=True)
        svg = [
            '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="360" viewBox="0 0 720 360">',
            '<rect x="0" y="0" width="720" height="360" fill="white"/>',
            f'<text x="64" y="28" font-family="sans-serif" font-size="18" fill="#172a3a">{escaped(title)}</text>',
            '<line x1="64" y1="56" x2="64" y2="292" stroke="#64748b"/>',
            '<line x1="64" y1="292" x2="672" y2="292" stroke="#64748b"/>',
            f'<text x="8" y="62" font-family="sans-serif" font-size="11" fill="#475569">{escaped(format(high, ".4g"))}</text>',
            f'<text x="8" y="292" font-family="sans-serif" font-size="11" fill="#475569">{escaped(format(low, ".4g"))}</text>',
        ]
        coordinates = " ".join(f"{x:.2f},{y:.2f}" for x, y in points)
        svg.append(f'<polyline points="{coordinates}" fill="none" stroke="#167d9a" stroke-width="2"/>')
        if len(points) == 1:
            x, y = points[0]
            svg.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="3" fill="#167d9a"/>')
        tick_count = min(6, len(points))
        indices = sorted({round(index * (len(points) - 1) / max(1, tick_count - 1)) for index in range(tick_count)})
        for index in indices:
            x, _ = points[index]
            label = labels[index]
            if len(label) > 32:
                label = label[:29] + "..."
            svg.append(f'<text x="{x:.2f}" y="320" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#475569">{escaped(label)}</text>')
        svg.append("</svg>")
        self.add("plot", title, "".join(svg), "image/svg+xml")


class CapturedText(io.TextIOBase):
    def __init__(self, capture, stream):
        self.capture = capture
        self.stream = stream

    def writable(self):
        return True

    def write(self, value):
        return self.capture.write(self.stream, value)


def validate_title(title):
    if not isinstance(title, str) or not title.strip() or len(title) > 200:
        raise ValueError("Output title must have 1-200 characters.")


def validate_scalar(value):
    if value is not None and not isinstance(value, (str, int, float, bool)):
        raise TypeError("Output values must be strings, finite numbers, booleans, or null.")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Output numbers must be finite.")


def validate_records(data):
    if not isinstance(data, list) or len(data) > MAX_ROWS:
        raise ValueError("Table and CSV outputs need a list of at most 10,000 dictionaries.")
    columns = {}
    for row in data:
        if not isinstance(row, dict):
            raise TypeError("Each table or CSV row must be a dictionary.")
        for key, value in row.items():
            if not isinstance(key, str):
                raise TypeError("Table and CSV column names must be strings.")
            columns[key] = None
            if len(columns) > MAX_COLUMNS:
                raise ValueError("Table or CSV output exceeds 100 columns.")
            validate_scalar(value)
    return list(columns)


def apply_process_limits():
    if sys.platform != "linux":
        return
    import resource

    limits = {
        "RLIMIT_CPU": 25,
        "RLIMIT_AS": 512 * 1024 * 1024,
        "RLIMIT_FSIZE": 16 * 1024 * 1024,
        "RLIMIT_NOFILE": 64,
        "RLIMIT_CORE": 0,
        "RLIMIT_NPROC": 32,
    }
    for name, requested in limits.items():
        limit = getattr(resource, name, None)
        if limit is not None:
            _, hard = resource.getrlimit(limit)
            bound = requested if hard == resource.RLIM_INFINITY else min(requested, hard)
            resource.setrlimit(limit, (bound, bound))


def read_input():
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ValueError("Worker input exceeds 700 KB.")

    def invalid_constant(value):
        raise ValueError(f"Non-finite JSON number is not allowed: {value}")

    request = json.loads(raw.decode("utf-8"), parse_constant=invalid_constant)
    if not isinstance(request, dict) or set(request) != {"code", "csv", "parameters"}:
        raise ValueError("Worker input must contain code, csv, and parameters.")
    code, csv_text, parameters = request["code"], request["csv"], request["parameters"]
    if not isinstance(code, str) or not code.strip() or len(code.encode("utf-8")) > MAX_CODE:
        raise ValueError("Program code must be 1-20,000 UTF-8 bytes.")
    if not isinstance(csv_text, str):
        raise TypeError("CSV input must be a string.")
    if not isinstance(parameters, dict):
        raise TypeError("Parameters must be an object.")
    for key, value in parameters.items():
        if len(key) > 100 or not isinstance(value, (str, int, float, bool)):
            raise ValueError("Parameters need short names and scalar string, number, or boolean values.")
        if isinstance(value, str) and len(value) > 1000:
            raise ValueError("Parameter strings may contain at most 1,000 characters.")
        validate_scalar(value)

    reader = csv.reader(io.StringIO(csv_text.removeprefix("\ufeff"), newline=""), strict=True)
    columns = next(reader, [])
    if len(columns) > MAX_COLUMNS:
        raise ValueError("Dataset exceeds 100 columns.")
    if any(not column.strip() for column in columns) or len(set(columns)) != len(columns):
        raise ValueError("CSV column names must be nonempty and unique.")
    rows = []
    for values in reader:
        if not values:
            continue
        if len(values) != len(columns):
            raise ValueError("Each CSV row must match the number of column names.")
        if len(rows) >= MAX_ROWS:
            raise ValueError("Dataset exceeds 10,000 rows.")
        rows.append(dict(zip(columns, values)))
    return code, rows, columns, parameters


def main():
    capture = Capture()
    error = None
    try:
        apply_process_limits()
        code, rows, columns, parameters = read_input()
        scope = {
            "__name__": "__research__",
            "rows": rows,
            "columns": columns,
            "params": parameters,
            "table": capture.table,
            "metric": capture.metric,
            "conclusion": capture.conclusion,
            "export_csv": capture.export_csv,
            "plot": capture.plot,
        }
        with contextlib.redirect_stdout(CapturedText(capture, "stdout")), contextlib.redirect_stderr(CapturedText(capture, "stderr")):
            exec(compile(code, "<research-program>", "exec"), scope, scope)
    except BaseException as failure:
        try:
            error = bounded_text(f"{type(failure).__name__}: {failure}", 2000)
        except BaseException:
            error = "Program failed; exception text was unavailable."
        try:
            detail = "".join(traceback.format_exception(type(failure), failure, failure.__traceback__))
            capture.write("stderr", bounded_text(detail[-15_000:], 15_000))
        except BaseException:
            pass
    wire = encoded_json(capture.result(error))
    # Capture additions reserve sufficient space for the bounded error field.
    # The application must still validate the entire untrusted remote response.
    if len(wire) > MAX_BUNDLE:
        raise RuntimeError("Worker result violated its serialized capture bound.")
    sys.stdout.write(wire)
    sys.stdout.flush()
    return 0 if error is None else 1


if __name__ == "__main__":
    sys.exit(main())
