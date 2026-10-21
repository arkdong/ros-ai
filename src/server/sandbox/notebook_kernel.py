"""ros.ai notebook kernel: one long-running Python process per open notebook.

It runs inside the ros.ai sandbox (the macOS sandbox, or Docker): no network,
the project folder read-only except the notebook's own outputs folder, and
memory, CPU and process caps. The host sends JSON lines on stdin and reads JSON lines from a private copy
of stdout. Cells see neither: their printed text and figures come back as
messages, and stray writes to file descriptor 1 land on stderr.
"""
import ast
import base64
import builtins
import errno
import importlib.abc
import importlib.metadata
import importlib.util
import io
import json
import linecache
import os
import platform
import queue
import resource
import shlex
import signal
import subprocess
import sys
import threading
import time
import traceback
import types

CHANNEL_OUT = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
CHANNEL_IN = os.fdopen(os.dup(0), "rb")
os.dup2(2, 1)
_null = os.open(os.devnull, os.O_RDONLY)
os.dup2(_null, 0)
os.close(_null)

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.artist import Artist
from matplotlib.figure import Figure
import numpy as np
import pandas as pd

MAX_TEXT = 1_000_000      # printed characters per cell
MAX_DISPLAYS = 50         # rich outputs per cell
MAX_RICH = 20_000_000     # characters of rich output per cell
MAX_IMAGE = 5_000_000     # base64 characters per image
MAX_HTML = 2_000_000
MAX_PLAIN = 100_000
MAX_CSV = 1_000_000
SETUP_MAGICS = ("%matplotlib", "%config", "%load_ext", "%reload_ext", "%autoreload")
OUTPUTS = os.environ.get("ROS_NOTEBOOK_OUTPUTS", "")
# The project's own packages folder, where %pip install puts packages (sandboxed Python only).
PACKAGES = os.environ.get("ROS_NOTEBOOK_PACKAGES", "")

KERNEL_GLOBALS = globals()
_send_lock = threading.Lock()
state = {"executing": False, "cell": None}


def send(message):
    try:
        line = json.dumps(message, ensure_ascii=False, allow_nan=False, default=str)
    except ValueError:
        line = json.dumps({"type": "stream", "id": message.get("id"), "name": "stderr", "text": "[ros.ai: an output could not be sent.]\n"})
    with _send_lock:
        CHANNEL_OUT.write(line + "\n")
        CHANNEL_OUT.flush()


class Streams:
    """Printed text for the running cell, sent in small batches and in order."""

    def __init__(self):
        self.lock = threading.RLock()
        self.cell = None
        self.parts = []
        self.pending = 0
        self.sent = 0
        self.since = 0.0
        self.capped = False

    def start(self, cell):
        with self.lock:
            self.cell, self.parts, self.pending, self.sent, self.capped = cell, [], 0, 0, False
            self.since = 0.0

    def write(self, name, text):
        with self.lock:
            if self.cell is None or self.capped or not text:
                return
            room = MAX_TEXT - self.sent - self.pending
            if len(text) > room:
                text = text[:max(0, room)] + "\n[ros.ai: this cell printed more than 1 MB of text; the rest was left out.]\n"
                self.capped = True
            if self.parts and self.parts[-1][0] == name:
                self.parts[-1][1].append(text)
            else:
                self.parts.append((name, [text]))
            self.pending += len(text)
            if self.pending >= 8192 or ("\n" in text and time.monotonic() - self.since >= 0.05) or self.capped:
                self.flush()

    def flush(self):
        with self.lock:
            if self.cell is None:
                return
            for name, texts in self.parts:
                send({"type": "stream", "id": self.cell, "name": name, "text": "".join(texts)})
            self.sent += self.pending
            self.parts, self.pending, self.since = [], 0, time.monotonic()

    def finish(self):
        with self.lock:
            self.flush()
            self.cell = None


streams = Streams()


class Output(io.TextIOBase):
    def __init__(self, name):
        self.name = name

    @property
    def encoding(self):
        return "utf-8"

    def writable(self):
        return True

    def isatty(self):
        return False

    def write(self, text):
        if not isinstance(text, str):
            raise TypeError(f"write() argument must be str, not {type(text).__name__}")
        streams.write(self.name, text)
        return len(text)

    def flush(self):
        streams.flush()


def flusher():
    while True:
        time.sleep(0.1)
        with streams.lock:
            if streams.parts and time.monotonic() - streams.since >= 0.05:
                streams.flush()


class Cell:
    def __init__(self, ident, count):
        self.id, self.count, self.displays, self.rich, self.noticed = ident, count, 0, 0, False


def emit(data, metadata, result=False):
    cell = state["cell"]
    if cell is None or not data:
        return
    size = sum(len(value) if isinstance(value, str) else len(json.dumps(value)) for value in data.values())
    if cell.displays >= MAX_DISPLAYS or cell.rich + size > MAX_RICH:
        if not cell.noticed:
            cell.noticed = True
            streams.write("stderr", "[ros.ai: this cell made more output than a notebook shows; later outputs were left out.]\n")
        return
    cell.displays += 1
    cell.rich += size
    streams.flush()
    send({"type": "display", "id": cell.id, "data": data, "metadata": metadata, "result": result})


def figure_png(figure):
    buffer = io.BytesIO()
    figure.savefig(buffer, format="png", dpi=150, bbox_inches="tight")
    raw = buffer.getvalue()
    width, height = int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
    return base64.b64encode(raw).decode("ascii"), {"width": round(width / 1.5), "height": round(height / 1.5)}


def plain(value):
    try:
        text = repr(value)
    except Exception as failure:
        text = f"<{type(value).__name__} object; its repr failed: {failure}>"
    return text if len(text) <= MAX_PLAIN else text[:MAX_PLAIN] + "\n…"


def frame_csv(frame):
    """The whole table as CSV, so a shown table can be saved as a ros.ai dataset."""
    if len(frame) > 10_000 or len(frame.columns) > 200:
        return None
    try:
        table = frame.copy()
        table.columns = [" / ".join(map(str, column)) if isinstance(column, tuple) else str(column) for column in table.columns]
        if not isinstance(table.index, pd.RangeIndex):
            try:
                table = table.reset_index()
            except ValueError:
                pass
        text = table.to_csv(index=False)
    except Exception:
        return None
    return text if len(text) <= MAX_CSV else None


REPRS = (("_repr_html_", "text/html"), ("_repr_markdown_", "text/markdown"), ("_repr_svg_", "image/svg+xml"),
         ("_repr_png_", "image/png"), ("_repr_jpeg_", "image/jpeg"), ("_repr_latex_", "text/latex"), ("_repr_json_", "application/json"))


def bundle(value):
    """A Jupyter-style MIME bundle for one value."""
    if isinstance(value, Figure):
        try:
            encoded, size = figure_png(value)
        finally:
            plt.close(value)
        if len(encoded) > MAX_IMAGE:
            return {"text/plain": f"<Figure too large to show: {len(encoded) // 1_000_000} MB as PNG>"}, {}
        return {"image/png": encoded, "text/plain": plain(value)}, {"image/png": size}
    data, metadata = {}, {}
    if isinstance(value, pd.DataFrame):
        try:
            html = value._repr_html_()
        except Exception:
            html = None
        if isinstance(html, str) and len(html) <= MAX_HTML:
            data["text/html"] = html
        csv = frame_csv(value)
        if csv is not None:
            data["text/csv"] = csv
    elif isinstance(value, pd.Series):
        csv = frame_csv(value.to_frame())
        if csv is not None:
            data["text/csv"] = csv
    elif not isinstance(value, type):
        for method, mime in REPRS:
            try:
                function = getattr(value, method, None)
                result = function() if callable(function) else None
            except Exception:
                continue
            if isinstance(result, tuple) and len(result) == 2:
                result = result[0]
            if result is None:
                continue
            if mime in ("image/png", "image/jpeg"):
                if isinstance(result, bytes):
                    result = base64.b64encode(result).decode("ascii")
                if not isinstance(result, str) or len(result) > MAX_IMAGE:
                    continue
            elif mime == "application/json":
                try:
                    json.dumps(result, allow_nan=False)
                except (TypeError, ValueError):
                    continue
            elif not isinstance(result, str) or len(result) > MAX_HTML:
                continue
            data[mime] = result
    data["text/plain"] = plain(value)
    return data, metadata


def display(*objects, **_options):
    """Show values below the cell, as Jupyter's display() does."""
    for value in objects:
        if value is not None:
            data, metadata = bundle(value)
            emit(data, metadata)


def flush_figures():
    for number in list(plt.get_fignums()):
        figure = plt.figure(number)
        if not figure.axes:
            plt.close(figure)
            continue
        data, metadata = bundle(figure)
        emit(data, metadata)


def quiet(value):
    """Values Jupyter users expect to see as a figure, not as text."""
    if isinstance(value, Artist) and not isinstance(value, Figure):
        return True
    return isinstance(value, (list, tuple)) and len(value) > 0 and all(isinstance(item, Artist) for item in value)


plt.show = lambda *_args, **_kwargs: flush_figures()
Figure.show = lambda self, *_args, **_kwargs: display(self)


class _Text:
    def __init__(self, data=None, url=None, filename=None, **_options):
        if filename is not None:
            with open(filename, encoding="utf-8") as handle:
                data = handle.read()
        self.data = "" if data is None else str(data)


class Markdown(_Text):
    def _repr_markdown_(self):
        return self.data


class HTML(_Text):
    def _repr_html_(self):
        return self.data


class SVG(_Text):
    def _repr_svg_(self):
        return self.data


class Image:
    def __init__(self, data=None, url=None, filename=None, format=None, **_options):
        if filename is None and isinstance(data, str) and os.path.isfile(data):
            filename, data = data, None
        if filename is not None:
            with open(filename, "rb") as handle:
                data = handle.read()
        self.data = data if isinstance(data, bytes) else b""
        self.format = (format or ("jpeg" if self.data[:3] == b"\xff\xd8\xff" else "png")).lower().replace("jpg", "jpeg")

    def _repr_png_(self):
        return self.data if self.format == "png" else None

    def _repr_jpeg_(self):
        return self.data if self.format == "jpeg" else None


def clear_output(wait=False):
    cell = state["cell"]
    if cell is not None:
        streams.flush()
        send({"type": "clear", "id": cell.id})


class IPythonDisplay(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """`from IPython.display import display` works without IPython. It loads only when a cell imports it,
    because libraries such as matplotlib behave differently once IPython is loaded."""

    def find_spec(self, name, path=None, target=None):
        if name in ("IPython", "IPython.display"):
            return importlib.util.spec_from_loader(name, self, is_package=name == "IPython")
        return None

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        if module.__name__ == "IPython":
            module.get_ipython = lambda: None
            return
        module.__dict__.update({"display": display, "Markdown": Markdown, "HTML": HTML, "SVG": SVG, "Image": Image, "clear_output": clear_output})


sys.meta_path.append(IPythonDisplay())


def prepare(source, filename):
    """Setup magics such as %matplotlib inline become no-ops; other magics and shell lines get a clear error."""
    try:
        ast.parse(source, filename=filename)
        return source
    except SyntaxError:
        pass
    lines = source.split("\n")
    for index, line in enumerate(lines):
        text = line.strip()
        if not text.startswith(("%", "!")) or text.startswith("!="):
            continue
        if text.startswith(SETUP_MAGICS):
            lines[index] = line[:len(line) - len(line.lstrip())] + "pass"
            continue
        if PACKAGES and text.split()[0] in ("%pip", "!pip", "%pip3", "!pip3"):
            try:
                words = shlex.split(text)[1:]
            except ValueError:
                words = None
            if words is not None:
                lines[index] = line[:len(line) - len(line.lstrip())] + f"__ros_pip__({words!r})"
                continue
        kind = "a shell command" if text.startswith("!") else "an IPython magic"
        message = f"line {index + 1} is {kind} ({text.split()[0]}). ros.ai notebooks run plain Python, without IPython magics or a shell."
        if any(word in text for word in ("pip", "conda", "install")):
            message += (" Install packages with %pip install <name>." if PACKAGES else
                        " Packages can't be installed here: the sandbox has no network. It comes with pandas, NumPy, SciPy and matplotlib.")
        error = SyntaxError(message)
        error.filename, error.lineno, error.offset, error.text = filename, index + 1, 1, line
        raise error
    return "\n".join(lines)


def silenced(code, node):
    """A trailing semicolon hides the last value, as in Jupyter."""
    line = code.split("\n")[node.end_lineno - 1].encode("utf-8")[node.end_col_offset:].decode("utf-8", "ignore")
    return line.lstrip().startswith(";")


def failure_output(failure, filename):
    """The traceback from the cell onwards, without this kernel's own frames."""
    traceback_object = failure.__traceback__
    while traceback_object is not None and traceback_object.tb_frame.f_code.co_filename != filename:
        traceback_object = traceback_object.tb_next
    line, walk, last_user = None, traceback_object, None
    while walk is not None:
        if walk.tb_frame.f_code.co_filename == filename:
            line = walk.tb_lineno
        if walk.tb_frame.f_globals is not KERNEL_GLOBALS:
            last_user = walk
        walk = walk.tb_next
    if last_user is not None:
        last_user.tb_next = None  # for example the interrupt handler
    if isinstance(failure, SyntaxError) and failure.filename == filename:
        line = failure.lineno
    lines = "".join(traceback.format_exception(type(failure), failure, traceback_object)).rstrip("\n").split("\n")
    if isinstance(failure, OSError) and failure.errno in (errno.EROFS, errno.EPERM, errno.EACCES):
        lines.append(f"ros.ai: notebooks can read the project folder but not change it. Save files in {OUTPUTS or 'the outputs folder'} instead." if OUTPUTS
                     else "ros.ai: notebooks can only write to /tmp in this project, because it has no project folder.")
    return {"ename": type(failure).__name__, "evalue": str(failure)[:4000], "traceback": lines[-400:], "line": line}


user_main = types.ModuleType("__main__")
namespace = user_main.__dict__
def pip(words):
    """%pip install: packages go to this project's own folder, downloaded through the ros.ai network proxy."""
    if not words or words[0] not in ("install", "uninstall", "list", "show", "freeze"):
        raise ValueError("ros.ai supports %pip install, uninstall, list, show and freeze.")
    command = [sys.executable, "-m", "pip", *words]
    if words[0] == "install":
        command += ["--target", PACKAGES, "--upgrade", "--no-input", "--progress-bar", "off"]
    elif words[0] in ("list", "freeze"):
        command += ["--path", PACKAGES]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, text=True)
    for output in process.stdout:
        sys.stdout.write(output)
    if process.wait() != 0:
        raise RuntimeError(f"pip {words[0]} failed (exit code {process.returncode}). A site it needs may have been denied.")
    importlib.invalidate_caches()
    if words[0] == "install":
        print("Installed. Restart Python if a package was already imported.")


namespace.update({"__builtins__": builtins, "display": display, "__ros_pip__": pip})
sys.modules["__main__"] = user_main


def run(message):
    ident, count = str(message.get("id", "")), int(message.get("count") or 0)
    source = str(message.get("code", ""))
    filename = f"In [{count}]"
    state["cell"] = Cell(ident, count)
    streams.start(ident)
    status, error = "ok", None
    try:
        code = prepare(source, filename)
        linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)
        tree = ast.parse(code, filename=filename, mode="exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr) and not silenced(code, tree.body[-1]):
            last = ast.Expression(tree.body.pop().value)
        program = compile(tree, filename, "exec")
        result = compile(last, filename, "eval") if last is not None else None
        value = None
        state["executing"] = True
        try:
            exec(program, namespace)
            if result is not None:
                value = eval(result, namespace)
        finally:
            state["executing"] = False
        if value is not None and not quiet(value):
            namespace["_"] = value
            data, metadata = bundle(value)
            emit(data, metadata, result=True)
    except KeyboardInterrupt as failure:
        status, error = "interrupted", failure_output(failure, filename)
    except BaseException as failure:
        status, error = "error", failure_output(failure, filename)
    finally:
        state["executing"] = False
    try:
        flush_figures()
    except BaseException as failure:
        streams.write("stderr", f"[ros.ai: a figure could not be drawn: {failure}]\n")
    streams.finish()
    state["cell"] = None
    send({"type": "done", "id": ident, "status": status, **({"error": error} if error else {})})


def interrupt(_signum, _frame):
    if state["executing"]:
        raise KeyboardInterrupt


def no_input(*_args, **_kwargs):
    raise RuntimeError("input() isn't available in ros.ai notebooks. Set the value in the cell instead.")


def versions():
    found = {}
    for name in ("numpy", "pandas", "matplotlib", "scipy"):
        try:
            found[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            pass
    return found


def main():
    inbox = queue.Queue()

    def reader():
        try:
            for raw in CHANNEL_IN:
                try:
                    message = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(message, dict):
                    inbox.put(message)
        finally:
            inbox.put(None)

    resource.setrlimit(resource.RLIMIT_FSIZE, (512 * 1024 * 1024, 512 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    sys.dont_write_bytecode = True
    sys.path.append(os.getcwd())
    if PACKAGES:
        sys.path.append(PACKAGES)
    sys.stdout, sys.stderr, sys.stdin = Output("stdout"), Output("stderr"), io.StringIO("")
    builtins.input = no_input
    signal.signal(signal.SIGINT, interrupt)
    threading.Thread(target=reader, name="ros-ai-reader", daemon=True).start()
    threading.Thread(target=flusher, name="ros-ai-flusher", daemon=True).start()
    send({"type": "ready", "python": platform.python_version(), "libraries": versions(), "cwd": os.getcwd()})
    while True:
        message = inbox.get()
        if message is None:
            break
        if message.get("type") == "execute":
            run(message)
    os._exit(0)


main()
