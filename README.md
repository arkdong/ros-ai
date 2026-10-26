# ros.ai

**Run your agents in the open.**

ros.ai is an open workspace where AI agents from any vendor and your own tools work on the same project. They collaborate through one shared context, a canvas of blocks, where you can inspect, evaluate and direct their work instead of each agent keeping its own. It runs on your computer: projects, keys and the Python sandbox stay there, and model requests go only to the providers you connect.

A project is a canvas of Text, Code, Notebook, Data, File, External and Agent blocks, plus Groups. Ros, the built-in assistant, and any agent you connect (Claude Code, Codex, Cursor, Gemini CLI, a local model) propose changes that you review under the project's approval mode. Everything an agent adds carries its provenance and can be undone.

## Install

**Mac app.** Download `ros.ai-<version>-arm64.dmg` (Apple silicon) or `ros.ai-<version>-x64.dmg` (Intel) from the [latest release](https://github.com/arkdong/ros-ai/releases/latest), drag ros.ai to Applications and open it. Nothing else is needed. An unsigned build asks once: *System Settings → Privacy & Security → Open Anyway*.

**From source** (macOS, Linux, Windows under WSL) with Node.js 24 or newer:

```sh
git clone https://github.com/arkdong/ros-ai.git && cd ros-ai
npm ci && npm run build
npm start        # the workspace at http://127.0.0.1:4310
npm run app      # or the same in its own window (Mac)
```

The service binds to loopback only. ros.ai keeps its own records in the computer's app-data folder (macOS `~/Library/Application Support/ros.ai`), or in `.ros-ai/` when the checkout already has one; `ROS_DATA_DIR` chooses another place, and the folder in use is printed at startup. Each project also lives in a folder you choose, as ordinary Markdown, `.py`, `.ipynb` and CSV files that Obsidian, VS Code or Jupyter open; edits saved there come back as changes you can undo.

## First run

1. **Connect your tools.** ros.ai looks at this computer (the Applications folder, your PATH, the agents' own settings, model servers on `127.0.0.1`; nothing is sent anywhere, no credential file is opened) and shows what it found: Claude Code, Codex, Cursor, Gemini CLI, a running Ollama or LM Studio, and the free hosted Ros. **Connect** links them in one go. You can come back to this on the **Agents** page.
2. **Pick a model for Ros.** Sign in for the free hosted Ros (Nemotron on Nebius, no key), paste your own key on the **Model** page, download Ros to run on this computer (Agents › Ros, about 3 GB), or point ros.ai at a local server.
3. **Start a project.** New project opens a blank canvas; the book icon opens the bundled examples.

**Code and Notebook blocks** need nothing else on macOS: the first run sets up ros.ai's own Python 3.12 with uv (about 150 MB, once, in the data folder) and runs code in the macOS sandbox, the way Codex and Claude Code run commands. The only network is a proxy on this computer that asks before each new website (Allow once, Always for this project, Deny; PyPI is always allowed, so `%pip install` works in notebooks); Settings → General → Python network can switch to Full network. On Linux and Windows they use Docker: `docker build -t ros-ai-research-python:1 src/server/sandbox`.

## Keys in one file

Keys can be pasted on the Model and Plugins pages and are saved privately in the data folder. To avoid typing them into every fresh data folder, put them once in `~/.config/ros.ai/keys.env`, readable only by you:

```sh
mkdir -p ~/.config/ros.ai && touch ~/.config/ros.ai/keys.env && chmod 600 ~/.config/ros.ai/keys.env
open -e ~/.config/ros.ai/keys.env   # ANTHROPIC_API_KEY=…  TAVILY_API_KEY=…  ROS_START_ALLOWANCE_CLAUDE_USD=5
```

ros.ai reads it at each start (`ROS_KEYS_FILE` names another file, `ROS_KEYS_FILE=off` skips it). It takes `*_API_KEY` names (`ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, `NEBIUS_API_KEY`, `OPENAI_API_KEY`), `NOTION_TOKEN`, and optional starting allowances `ROS_START_ALLOWANCE_<CLAUDE|TAVILY|NEBIUS|OPENAI>_USD` (with `_REQUESTS`, default 200). A starting allowance is saved only in a data folder that has never had one for that service; restarts never top it up. Paid calls stay capped by each connection's own allowance on the **Budget** page.

## Your own agents

ros.ai is also an MCP server, so you can keep working in your own Claude Code, Codex, Cursor or Gemini CLI, signed in with your own plan or key; ros.ai never sees that login. The first-run screen links them, or paste the command yourself (the **Agents** page shows the exact path):

```sh
claude mcp add --scope user ros-ai -- node "/path/to/ros.ai data/bin/ros-ai-mcp.mjs"
codex mcp add ros-ai -- node "/path/to/ros.ai data/bin/ros-ai-mcp.mjs"
```

Inside the Mac app the command names a `ros-ai-node` launcher instead of `node`, so no separate Node is needed. The agent can read the canvas, artifacts and your saved preferences and propose blocks, report revisions, analysis code and reuse. Proposals follow the project's approval mode, run code only in ros.ai's sandbox, and appear in the assistant panel under the agent's name. Started inside a project's folder, the agent works in that project.

**Apps every agent can use.** On the Plugins page, Notion, Linear and Sentry connect by signing in to their hosted MCP servers the way Claude and Claude Code do. GitHub uses its hosted MCP server with the token you save there, Figma uses the MCP server of Figma's desktop app, and Slack uses the bot token of your own Slack app. Every agent you run in ros.ai gets the same app tools at once. Tools that only read run straight away; anything that could change something in the app appears as a note on the canvas and runs only after you accept it.

**Ros remembers.** Ros notices how you like work done and proposes one line at a time, kept as Markdown files in the data folder (`memory/`). Settings › Memory lists the lines and can turn it off; every agent receives the kept lines as your preferences, never as instructions.

## Three approval modes

- **Ask every time:** review each experiment and additional block.
- **Approve for me:** a conservative rule reviewer runs plain data-analysis code (pandas, NumPy, SciPy, Matplotlib and the standard maths modules) straight away; anything else escalates to you.
- **Full access:** code runs straight away in the sandbox and the assistant can add blocks without asking; every change stays undoable.

[Working in ros.ai](docs/guide.md) covers the canvas, blocks, labels, Groups, history, resources, the Python boundary and spending in detail.

## Examples

A fresh install includes attributed examples you can open from the book icon: [AI adoption in Dutch businesses](examples/dutch-ai-adoption/README.md) (CBS evidence, two real local calculations, an editable article), [Amsterdam-area rainfall patterns for cycling planning](examples/demo-amsterdam/README.md) and [Amsterdam cycling and weather](examples/amsterdam-cycling-weather/README.md) (real KNMI observations), [Schiphol weather](examples/schiphol-live-research/README.md) and [Coffee cooling](examples/coffee-cooling/README.md). The [market risk](examples/demo-market-risk/README.md) demo needs its own captured data, which is not redistributed.

## Development

```sh
npm run dev            # frontend live reload and local server
npm run lint           # TypeScript
npm run build          # production frontend
npm run try -- 4       # start pull request #4 (or a branch) on localhost without switching branches
npm run app            # the Mac app on this checkout; npm run app:build makes the DMG
npm test               # historical unit suite; day-to-day verification uses lint, build and a browser check
```

`npm run try` checks a pull request out into `../ros-ai-try/pr-4` with its own packages and an empty data folder, starts it on the next free port from 4311 and opens the browser; `git worktree remove --force ../ros-ai-try/pr-4` deletes the copy. The Mac app lives in [desktop/](desktop/README.md): an Electron shell around the same server, built by [a GitHub workflow](.github/workflows/mac-app.yml) that signs when the Apple secrets exist.

Docs: [working in ros.ai](docs/guide.md), [architecture](docs/architecture.md), [product brief](docs/product-brief.md), [roadmap](docs/roadmap.md), [Python sandbox](docs/python-sandbox.md), [tool connections](docs/tool-connections.md), [inference setup](docs/inference-setup.md), [Code and Notebook setup](docs/stage-one-setup.md), [datasets, figures and reports](docs/datasets-figures-reports.md), [Amsterdam data provenance](docs/amsterdam-data.md), [Nebius sandbox](docs/nebius-sandbox-setup.md), [Railway demo](docs/railway-deployment.md). [CONTEXT.md](CONTEXT.md) records shared language and [AGENTS.md](AGENTS.md) the rules for coding agents working on this repository.

The public site at [ros-ai.io](https://ros-ai.io) lives in `arkdong/ros-ai-site`. The hosted demo is built from the root Dockerfile on `main`; it uses per-browser visitor stores and saved results only, with no new inference, execution or host-file access.

## Hosted Ros

The app works on its own with your keys and agents. Signing in to ros.ai cloud adds free hosted Ros (NVIDIA Nemotron on Nebius) with a usage allowance, and later the paid tiers (a hosted workspace that keeps running, memory across machines, hosted connectors). That service lives in the separate private repository `arkdong/ros-ai-cloud`; `ROS_CLOUD_URL=off` hides it.

## Licence

ros.ai's code and documentation are released under the [MIT licence](LICENSE): the local app is open source and runs on its own. The licence does not cover:

- the hosted service (sign-in, the hosted Ros gateway and the usage ledger), which lives in the separate private repository `arkdong/ros-ai-cloud` and is not open source; ros.ai runs that service and sells the paid tiers on it. The app works without it;
- the ros.ai name and logo (`public/brand/`, `desktop/build/icon.png`);
- other organisations' logos and marks in `src/client/brand-logos/` (sources in its `SOURCES.md`) and drawn in `src/client/ModelMakerSymbol.tsx`; they belong to their owners and are shown only to identify their services;
- third-party data in `examples/`: KNMI weather observations and the datasets derived from them ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), Royal Netherlands Meteorological Institute), CBS statistics in `examples/dutch-ai-adoption/` (CBS's own reuse terms), and NDW counter-site records (ODC PDDL).
