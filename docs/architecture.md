# ros.ai architecture

A map of the code as it is, for someone about to change it. It names where things live and the few rules that hold everywhere. The files themselves carry the detail in their comments, and `git log` carries the history.

## The shape

ros.ai is one Node process on the person's own computer. `npm start` (or the `ros-ai` command, or the Mac and Windows app) runs `src/server/index.ts`, which serves a React page and a JSON API on `127.0.0.1:4310`. There is no other backend. Requests leave the computer only for the model, search and app connections the person set up.

```
src/shared/   types and pure rules used by both sides (canvas, layout, links, permissions wording)
src/server/   the Express server: storage, project folders, agents, Python, plugins
src/client/   the React page: canvas, ROS bar and panel, Agents, Plugins, Skills, Settings
scripts/      the MCP bridge for outside agents, `npm run try`, and two small builds
desktop/      the Electron shell that starts the same server in its own window
training/     ros-nemotron: how the model for ROS on this computer is trained and scored
tests/        the unit suite (`npm test`, Node's test runner through tsx); CI runs it
```

Stack: TypeScript everywhere, Express 5 run through tsx, React 19 with @xyflow/react for the canvas, Vite for the page, Node's built-in SQLite, CodeMirror for editors, Playwright for the agents' browser. Node 24 or newer.

## Storage

- **The data folder** (`ROS_DATA_DIR`; see the README for where it is on each system) holds `ros-ai.sqlite` and `artifacts/`. `store.ts` owns both. Everything a project is lives there: the canvas, its revisions, conversations, runs, proposals and usage. Saved outputs are files named by the hash of their content, and are never changed after they are written.
- **Every change to a canvas is a mutation** (`Store.mutate`): a list of small operations applied in one transaction, which produces a new revision. Undo and Redo walk those revisions. Moves, resizes and other layout changes are saved without becoming history steps.
- **A project's folder** (`project-folders.ts`) mirrors the blocks as ordinary files: Markdown, `.py`, `.ipynb`, CSV, and a `.canvas` file other apps can draw. Edits saved by other apps are read back as undoable changes. The folder's own bookkeeping is in its `.ros-ai/` subfolder.
- **Keys and sign-ins** are saved in owner-only files in the data folder (`tool-credentials.ts`, `plugins.ts`, `inference-connections.ts`, `local-keys.ts`). The API never returns a key, and the page never holds one.

## The canvas

- `shared/types.ts` defines a block (`CanvasNode`), a link and a canvas. `shared/vocabulary.ts` and `client/block-kinds.tsx` name the kinds.
- Only a Group contains blocks (`shared/groups.ts`). A link is one word between two blocks and never runs anything (`shared/links.ts`).
- Layout rules are pure functions in `shared/`: `layout.ts` (Arrange and group frames), `canvas-reflow.ts` (making room), `card-size.ts` (widths, heights and the Small/Medium/Full sizes).
- `client/Canvas.tsx` draws the map; `client/App.tsx` holds the page's state and saves edits. Each kind of block has its own view: `NotebookView`, `DataViewer`, `FileView`, `NotionView`, `GoogleView`, `PostView`, `MetricView`, `DashboardView`, `MapView`, `AppView`, `TrainingView`, `WebBlock`, `AgentView`.
- Copy and paste between projects is `shared/canvas-clipboard.ts` and `server/block-paste.ts`. Sharing a canvas as one HTML file is `shared/share.ts` and `server/share-copy.ts`.

## ROS and agents

- `assistant.ts` runs a conversation: threads, turns, the queue of waiting messages, Stop, and what a turn proposed. Each engine is one service behind the same interface:
  - `tool-loop-agent.ts`: ROS, a model in ros.ai's own tool loop (hosted ROS, ROS on this computer, or any API model through `providers.ts` and `inference-connections.ts`).
  - `claude-agent.ts`, `codex-agent.ts` (with `codex-app-server.ts`), `acp-agent.ts` (Gemini CLI, Goose, OpenCode): the person's own agents, started by ros.ai.
- `agent-tools.ts` is the one set of tools every engine gets: read the canvas, propose blocks and changes, run Python, search, read pages, use plugins. `agent-prompt.ts` and `canvas-grammar.ts` are the instructions that go with them.
- `outside-agents.ts` serves the same tools as an MCP server at `/mcp`, for an agent the person runs themselves. `scripts/ros-ai-mcp.mjs` is the bridge those agents start; `setup-detect.ts`, `setup-links.ts` and `setup.ts` find the agents on this computer and link them.
- `ros-layer.ts` is ROS arranging the map after any agent's turn: grouping and linking what was left loose.
- `local-ros.ts` downloads and runs ROS on this computer with llama.cpp. `cloud-account.ts` is the sign-in to ros.ai cloud, which lives in a separate private repository.
- **Nothing an agent proposes lands by itself.** A proposal is checked by the server and then follows the project's permission mode (`authority.ts`, `review-code.ts`). A write to an outside app always asks.

## Python

- `execution.ts` and `experiments.ts` decide whether a run may start and record it. `sandbox.ts` and `notebook-kernel.ts` run it.
- On a Mac, Python is ros.ai's own interpreter, fetched with uv, inside the macOS sandbox (`local-python.ts`), with network only through an asking proxy (`network-gate.ts`). Elsewhere it runs in Docker (`src/server/sandbox/`). See [Python sandbox](python-sandbox.md).
- `notebooks.ts` is the Notebook block; `sql.ts` is SQL over a project's Data blocks with DuckDB.

## Plugins, skills and live blocks

- `plugins.ts` and `remote-apps.ts` connect outside apps, most of them through the app's own MCP server; `slack.ts`, `notion.ts`, `google-drive.ts` and `google-workspace.ts` use the app's API. `browser.ts` is the agents' browser, in an empty profile.
- Blocks that read live keep the last answer in the project folder (`project-cache.ts`): `notion-view.ts`, `google-workspace.ts`, `metric-view.ts`, `posts.ts`, `papers.ts`, `training-view.ts`.
- `app-frames.ts` serves App blocks from a second local port, so a page an agent wrote cannot reach ros.ai's own API.
- `skills.ts` is the skill library, in the Agent Skills format; `personal-memory.ts` is what ROS remembers about the person.

## Usage and spending

Paid calls are recorded, not capped: `paid-usage.ts` writes each request to Usage before it is sent and settles it at the cost the provider reports. `budget-report.ts` and `provider-balances.ts` feed Settings › Usage and Balances. `spending-budget.ts` is the optional monthly budget, the one cap: a request it has no room for is refused before it is sent.

## The apps and releases

`desktop/` wraps the server in Electron ([desktop/README.md](../desktop/README.md)). `.github/workflows/ci.yml` runs the type check, the build and the tests on every pull request; `mac-app.yml` builds, signs and publishes the Mac and Windows apps on every `v*` tag. `updates.ts` is how a running copy learns about a newer release.

## Rules that hold everywhere

- The server listens on loopback only and refuses requests with a foreign Host or Origin (`app.ts`).
- Credentials stay on the server side. Nothing with a `VITE_` prefix holds a secret.
- Generated code runs only in the Python sandbox or in a sealed App frame.
- Fetches to addresses an agent supplies go through `public-fetch.ts`, which refuses private addresses.
- A saved output is never rewritten; a new result is a new version.
