# Stage One: Code and Notebook setup

October 2, 2026; notebooks updated October 7. These workflows let you write your own code, run notebooks, and deliberately reuse saved outputs. Blocks remain independent: a connection or input selection never starts another block. Current integrated verification is recorded in [RESULT.md](../RESULT.md).

## Start ros.ai and its Python runtime

Use Node.js 24 or newer and an installed, running Docker engine. From the repository root:

```sh
npm ci
docker build -t ros-ai-research-python:1 src/server/sandbox
npm run build
npm start
```

Open the local URL printed by the server, normally `http://127.0.0.1:4310`. Keep the data folder printed at startup and `.env.local` private; they contain local records and configuration. Code and Notebook runs need no model API key.

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

## Write and run a notebook

1. Use **Add block → Notebook → Add & open notebook**. To start from an existing notebook, choose its `.ipynb` file in the same dialog. The notebook opens over the canvas with the cursor in its first cell. **Canvas** goes back; double-click the block, or choose **Open notebook** on its card, to return.
2. Type Python and press **Shift+Enter** to run the cell and move on, or **Ctrl/⌘+Enter** to run it in place. The first run starts the notebook's Python, which keeps variables from cell to cell until **Restart**. **Stop** interrupts the running cell. **Run all** runs every code cell from the top and stops at the first error.
3. **+ Text** adds a Markdown cell; press **Esc** to see it rendered and double-click it to edit. After **Esc**, **A** or **B** adds a cell above or below, **M** or **Y** makes the cell text or code, **D D** deletes it and **Z** brings it back.
4. Each cell passes the project's permission choice before it runs. Ask every time shows a check card on the cell, Approve for me asks only about code the automatic reviewer does not clear, and Full access runs every cell inside the sandbox.

The notebook's Python uses the same Docker image and packages as Code blocks. Nothing is preloaded, so import what you use (`import pandas as pd`). It has no network. With a project folder it can read the folder, for example `pd.read_csv('../data/survey.csv')` from `notebooks/`, and save files only in `outputs/<notebook>/`; without one it can write only to `/tmp`. Up to four notebooks keep Python running at once, and a notebook left unused for 30 minutes stops its Python and says so; run the cells again to continue. A notebook file can be up to 20 MB, with 1,000 cells of up to 100,000 characters each.

The notebook is saved as `notebooks/<name>.ipynb` in the project folder, so Jupyter, JupyterLab or VS Code can open it. A save from one of those apps reloads the open notebook with **Undo**; if ros.ai still holds unsaved typing, it asks which version to keep. **Import .ipynb** on the toolbar replaces the notebook with a file, and **Undo** brings the previous version back.

Outputs show tables, text, errors, PNG and SVG figures, Markdown and CSV. Other HTML, scripts and pictures from the web are not loaded; they stay in the file. **Save as result** under an output keeps it as a project result for **Use as input** or **Use in report**. An output that ros.ai's sandbox produced counts as a measured result; one that came with an imported file or an outside edit is labelled as such.

## Reuse an exact output or write a report

Use **Inspect & provenance** to review the retained output and its producing attempt/snapshot. **Use as input** lets you select an exact artifact version for a destination block in this project. It saves the selection without running the recipient. For Code, a CSV becomes its one explicitly chosen runtime dataset; other selected outputs remain evidence. Review any recipient draft before changing its input. You can select the same saved CSV in two Code blocks and run each independently.

**Use in report** prepares the exact saved evidence for a report. An ordinary **Report** block supports Markdown, selected tables/figures and evidence links; **Save report version** creates an immutable report artifact. Download **Markdown + evidence** or **Self-contained HTML**. See [datasets, figures and reports](datasets-figures-reports.md) for the report workflow.

Earlier source/output versions stay inspectable when code, data or notebook source changes. Staleness notices do not switch an input, recompute a block or replace report evidence. Manual source and selection changes are undoable; execution/capture evidence remains retained.

Where offered, **Interpret selected output** is a separate model request with an explicit destination and context preview. It requires that connection's authorization and resource allowance, uses the deliberately selected evidence, and labels the reply as interpretation. Capturing or reusing an output does not automatically forward the notebook, its other cells, research chats or results to a model.
