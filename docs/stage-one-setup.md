# Stage One: Code and Notebook setup

October 2, 2026. These workflows let you write your own code, connect an existing notebook, and deliberately reuse saved outputs. Blocks remain independent: a connection or input selection never starts another block. Current integrated verification is recorded in [RESULT.md](../RESULT.md).

## Start ros.ai and its Python runtime

Use Node.js 24 or newer and an installed, running Docker engine. From the repository root:

```sh
npm ci
docker build -t ros-ai-research-python:1 src/server/sandbox
npm run build
npm start
```

Open the local URL printed by the server, normally `http://127.0.0.1:4310`. Keep the data folder printed at startup and `.env.local` private; they contain local records and configuration. Manual Code runs and Notebook captures need no model API key.

The Docker build downloads the pinned Python image and packages. Rebuild after capture-worker changes; ros.ai checks the image against the current worker and fails closed if it does not match. The app does not install packages, build the image, or substitute unrestricted host Python when Docker is unavailable. The server also uses Python 3 for permission analysis; this is separate from the Docker execution runtime.

The image provides Python 3.12.11, pandas, NumPy, matplotlib and SciPy. Each run has no external network, read-only image/input mounts, no user folders or credentials, and bounded CPU, memory, processes and wall time. See [the Python execution boundary](python-sandbox.md) for the exact controls and their limits.

## Write and run a Code block

1. Use **Add block → Code → Add & write code**. A name is optional; ros.ai supplies a unique type name such as **Code** or **Code 2**. The block appears on the canvas and its editor opens with the cursor in the program. Later, choose **Open content** (or double-click the block) to reopen it. The editor highlights Python, suggests ros.ai helpers, library members, CSV column names (`df["`) and parameter keys (`params["`) as you type, and underlines lines Python cannot parse. **Save** (`Ctrl/⌘+S`) records an undoable content edit.
2. For Python, check that the badge reads **Docker Python ready**. Other language labels, including C and Haskell, can be saved but currently have no execution adapter.
3. Choose **No dataset**, or explicitly choose one captured CSV from this project. The selected CSV is supplied in full as `df`; it is not a preview or an automatic import from connected blocks. JSON tables and other evidence formats do not become runtime CSV inputs.
4. Choose **Save & run** or **Run** (`Ctrl/⌘+Enter`). In Ask mode, inspect the captured source, input and parameters, then choose **Allow & run**. A source change invalidates approval for the earlier captured attempt. **Stop** requests cancellation of the current container. When an attempt fails, the line that raised the error is underlined while the editor still holds that attempt's code.

With **No dataset**, no `df` is created and no sample file is supplied. `params`, `pd`, `np`, `plt` and `scipy` are available. This example creates its own small data explicitly:

```python
values = pd.DataFrame({"x": [1, 2, 3], "square": [1, 4, 9]})
print("No CSV selected.")
metric("Row count", len(values))
table("Squares", values)
export_csv("Squares CSV", values)
fig, ax = plt.subplots()
ax.plot(values["x"], values["square"])
plot("Squares", fig)
```

Use `table`, `metric`, `plot`, `export_csv` and `conclusion` to retain intended outputs. Files left inside the temporary container are not automatically imported. When a CSV is selected, `table("Summary", df.describe().reset_index())` uses that exact version. The Code path accepts at most one CSV of 500,000 bytes and 100,000 bytes of program text; runtime output and project resource limits also apply.

**Attempts & outputs** retains each attempt's status, captured source/input/parameters, output artifacts, logs and errors. Ordinary Python failures retain preceding helper outputs. Approval policy and cumulative execution allowances still apply to manual runs; creating another Code block does not replenish them. The app does not infer that a saved program or successful run is scientifically correct.

## Connect an existing Jupyter notebook

The Notebook block uses a Jupyter/JupyterLab server that you already manage. ros.ai does not install Jupyter, start a server/kernel, or run imported cells. If you need a server, `python3 -m pip install jupyterlab` and `jupyter lab` start one on `http://127.0.0.1:8888/` and print its token. The full connect, native run and save, refresh and capture loop was verified against a live JupyterLab server on October 3 ([RESULT.md](../RESULT.md)).

1. Open your existing local Jupyter server and identify its base address and notebook path. Use a relative `.ipynb` path such as `research/analysis.ipynb`.
2. Use **Add block → Notebook → Add Notebook**, then open the new canvas block. A name is optional. Enter the **Jupyter address**, **Notebook path**, and interface choice. If the server requires an API token, enter it only in the password field in ros.ai; do not put it in a URL, notebook, report or chat.
3. Choose **Connect**, then **Check**. The API connection checks the named notebook through Jupyter's Contents API. Only loopback hosts (`localhost`, `127.0.0.1`, `::1`) with ports 1024–65535 are accepted. Embedded credentials, URL query/fragment tokens and parent-directory traversal are rejected.
4. Use **Open notebook** to open the native Jupyter interface in a separate tab. Its URL contains no API token. Native browser authentication is separate: sign in directly in Jupyter if requested. A successful ros.ai API check does not sign that browser tab in.
5. Work, run and save in Jupyter. Return to ros.ai and choose **Read saved cells** or **Refresh saved cells**. Unsaved editor/kernel state is not captured.

ros.ai stores the API credential in private server records. Public connection state, canvas references, native URLs, artifacts and run configuration omit it. Notebook responses containing that credential are rejected before saving or display, including decoded JSON and joined source/output arrays. Reconnecting with edited settings requires reentering the token. Jupyter documents its [API authentication](https://jupyter-server.readthedocs.io/en/latest/operators/security.html) and [Contents API](https://jupyter-server.readthedocs.io/en/latest/developers/rest-api.html).

The connection sends bounded, authenticated reads for the named notebook. It sends no cell updates, execution requests or kernel/session creation commands. Execution you initiate in native Jupyter uses that server's own filesystem/network permissions; ros.ai's Docker boundary and execution allowances do not govern its kernel.

## Capture selected saved outputs

Select a saved source version, inspect a cell, select its output checkboxes, and choose **Capture selected output(s)**. Each operation captures one cell and at most eight explicitly selected outputs. Repeating the click creates another external-capture receipt; it does not recompute the cell. **Inspect producing snapshot** opens the exact saved notebook source associated with an output, including older versions.

Supported previews include text/logs, explicit CSV, JSON, bounded PNG and conservatively sanitized SVG. Other formats remain labelled unsupported and can be captured/downloaded as inert JSON. HTML, scripts and notebook attachments are not executed. The limits are nbformat 4, 500,000 UTF-8 bytes per notebook, 200 cells, 100,000 source characters per cell, 32 saved outputs per cell and 300,000 bytes per output. Reads have an eight-second timeout and a 750,000-byte response cap.

Each capture records the exact source artifact/hash, snapshot identity, notebook path, cell index, unique cell ID when available, cell-source hash, output index and saved execution count. Missing or duplicated cell IDs use an exact-snapshot index locator. Counts do not prove execution order, dependencies, code/output correspondence or reproducibility. The records are labelled external notebook captures with execution unobserved, rather than ros.ai-generated results. See [nbformat's cell IDs](https://nbformat.readthedocs.io/en/latest/format_description.html#cell-ids).

If live Jupyter is unavailable, expand **Import a saved .ipynb snapshot**, choose a saved file and select **Import snapshot**. This supports the same explicit output capture and provenance. It preserves the supplied file text, while live reads preserve the notebook JSON delivered by the Contents API; neither implies byte-for-byte original on-disk formatting for a live API read. Import is a fallback for saved evidence, not proof of live Notebook integration.

## Reuse an exact output or write a report

Use **Inspect & provenance** to review the retained output and its producing attempt/snapshot. **Use as input** lets you select an exact artifact version for a destination block in this project. It saves the selection without running the recipient. For Code, a CSV becomes its one explicitly chosen runtime dataset; other selected outputs remain evidence. Review any recipient draft before changing its input. You can select the same saved CSV in two Code blocks and run each independently.

**Use in report** prepares the exact saved evidence for a report. An ordinary **Report** block supports Markdown, selected tables/figures and evidence links; **Save report version** creates an immutable report artifact. Download **Markdown + evidence** or **Self-contained HTML**. See [datasets, figures and reports](datasets-figures-reports.md) for the report workflow.

Earlier source/output versions stay inspectable when code, data or notebook source changes. Staleness notices do not switch an input, recompute a block or replace report evidence. Manual source and selection changes are undoable; execution/capture evidence remains retained.

Where offered, **Interpret selected output** is a separate model request with an explicit destination and context preview. It requires that connection's authorization and resource allowance, uses the deliberately selected evidence, and labels the reply as interpretation. Capturing or reusing an output does not automatically forward the notebook, its other cells, research chats or results to a model.
