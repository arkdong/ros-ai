# ros.ai

**Run your agents in the open.**

ros.ai is the open workspace that holds your whole project's context on one canvas. AI agents from any vendor work from it, and you see the whole picture, make the connections and direct them there.

Your notes, code, data, files, papers and Notion pages sit on the canvas as blocks. Claude Code, Codex, Gemini CLI, Goose, OpenCode, local models and ROS, our own agent, work from those blocks with the same tools. Their work lands back on the canvas with its sources, under the permissions you set, and every change can be undone. ros.ai runs on your own computer, and the code is MIT.

[ros-ai.io](https://ros-ai.io) · [Live demo](https://ros-ai-production.up.railway.app/app) · [Guide](docs/guide.md)

## Install

**Mac app.** Download the DMG for Apple silicon or Intel from the [latest release](https://github.com/arkdong/ros-ai/releases/latest), drag ros.ai to Applications and open it. An unsigned build asks once: *System Settings → Privacy & Security → Open Anyway*.

**Terminal**, on a Mac, Linux or Windows under WSL, with git and Node.js 24 or newer:

```sh
curl -fsSL https://ros-ai.io/install.sh | sh
```

That puts ros.ai in `~/ros-ai`, builds it and opens it at http://127.0.0.1:4310. Next time, `cd ~/ros-ai && npm start`. From a clone of this repository, `npm ci && npm run build && npm start`.

ros.ai listens on loopback only. Projects, keys and the Python sandbox stay on this computer. Model requests go only to the providers you connect.

## First run

1. **Welcome.** A running canvas shows what a project looks like.
2. **Set up ROS.** Sign in for free hosted ROS, with no key to paste, or continue without an account. On a Mac you can also download ROS to run on this computer.
3. **Connect your tools.** ros.ai looks at this computer for Claude Code, Codex, Cursor, Gemini CLI, Pi, Hermes Agent, Ollama and LM Studio, and links them in one go. Nothing is sent anywhere.

Then one card starts a project: a name, a folder, and **Start from** a blank canvas, a folder you already have or an example. Settings › General › First run shows the welcome again.

## The canvas

**Add block** offers Text, Code (Python), Notebook, Data (a CSV or a linked sheet), File (PDF or image), Paper (OpenAlex, arXiv, Zotero), Notion (a page or database, read live), Google Drive (a Sheet or Doc, read live), App (a small page an agent builds, sealed on its card), Training run and Group. Agents add their own blocks as they work: an Agent block for each task and a Web block for each search.

Every block an agent made says so. A label marks a Text block as a question, task, finding, decision or draft. A Group closes to one card. Every change stays undoable.

A project is a folder of plain files: Markdown, `.py`, `.ipynb` and CSV. Obsidian, VS Code and Jupyter open them, and edits made there come back as changes you can undo.

## The ROS bar

The bar at the bottom of the canvas is where you direct the work. Ask ROS, or @ an agent. Its menu picks the agent, its model and effort, and the project's permissions. `/` applies a skill. Esc twice stops a running turn.

## Agents

The **Agents** page lists every agent that can work in your projects, grouped by who pays.

- **On your subscription:** Claude Code on your Claude plan, Codex on your ChatGPT plan.
- **On your API keys:** Claude Code, Codex, the OpenAI API and Nebius Token Factory.
- **Their own setup:** Gemini CLI, Goose and OpenCode, with the sign-in or model they already have.
- **Free:** ROS, and open models from Ollama, LM Studio or any OpenAI-compatible server.
- **Your own agents:** your Claude Code, Codex, Cursor, Gemini CLI, Pi or Hermes Agent, on their own sign-in. They work on the canvas through ros.ai's MCP server, and ros.ai never sees that login.

Every agent gets the same tools, the same plugins and the same permissions. The first run links your own agents, and the Agents page shows the exact command to paste yourself:

```sh
claude mcp add --scope user ros-ai -- node "/path/to/ros.ai data/bin/ros-ai-mcp.mjs"
codex mcp add ros-ai -- node "/path/to/ros.ai data/bin/ros-ai-mcp.mjs"
hermes mcp add ros-ai --command node --args "/path/to/ros.ai data/bin/ros-ai-mcp.mjs" --client=hermes
```

Cursor, Gemini CLI and Pi take one `ros-ai` entry in their settings file. Started inside a project's folder, the agent works in that project.

## ROS

ROS is ros.ai's own agent: NVIDIA Nemotron 3 in ros.ai's agent loop, with the canvas as its tools. It reads the canvas, proposes blocks and Python, searches the web in several directions, reads the pages, writes findings with checked quotes, and checks the claims in any answer.

- **Hosted ROS** runs Nemotron 3 Nano and Super on Nebius Token Factory. Sign in and it works, with a free daily allowance and no key.
- **ROS on this computer** is [ros-nemotron](training/ros-nemotron/README.md), our fine-tune of Nemotron 3 Nano 4B on 1,140 real ros.ai turns. On 95 held-out tasks it passes 66, against 33 for the base model. ros.ai downloads it (about 3 GB, with about 8 GB of memory) and runs it with llama.cpp, free and offline. Weights: [arkdong/ros-nemotron-4b-GGUF](https://huggingface.co/arkdong/ros-nemotron-4b-GGUF).

**ROS remembers.** It notices how you like work done and proposes one line at a time, kept as Markdown in the data folder. Settings › Memory lists the lines and can turn it off. Every agent gets the kept lines as your preferences, never as instructions.

## Plugins and skills

**Plugins** are the apps every agent can use: Notion (several accounts), Google Drive, Sheets and Docs, GitHub, Linear, Sentry, Figma, Slack, Zotero, OpenAlex and arXiv, web search with Tavily, Exa or Brave, and a browser that opens public websites in an empty profile, never with your cookies. Reads run straight away. A change in an outside app waits for your OK.

**Skills** are ways of working an agent follows when a task matches. Write one, paste one, link one from GitHub, drop a `SKILL.md` or `.zip`, or copy from your Claude Code, Codex, OpenCode or Gemini folders. Every agent reads the same library.

## Permissions

Each project has one permission setting, in the ROS bar's menu and in Settings › General.

- **Ask every time:** every code run and every canvas change waits for your OK.
- **Approve for me:** plain analysis, new blocks and moves go ahead; the rest waits for you.
- **Full access:** code runs and canvas changes land at once; everything stays undoable.

A write to an outside app always asks, because Undo cannot take it back.

## Python on this computer

Code and Notebook blocks run ros.ai's own Python 3.12, set up with uv on first use (about 150 MB, once). On a Mac it runs in the macOS sandbox, the way Claude Code and Codex run commands: it reads the project, writes its outputs, and reaches a website only after you allow it, once or always for this project. PyPI is always allowed, so `%pip install` works. On Linux and Windows the blocks use Docker: `docker build -t ros-ai-research-python:1 src/server/sandbox`.

## Keys, data and updates

Keys pasted on the Agents and Plugins pages are saved in the data folder. To paste them only once, put them in `~/.config/ros.ai/keys.env`, readable only by you (`chmod 600`): any `*_API_KEY`, `NOTION_TOKEN`, and a starting allowance per service as `ROS_START_ALLOWANCE_<CLAUDE|TAVILY|NEBIUS|OPENAI>_USD`. ros.ai reads it at every start, and `ROS_KEYS_FILE=off` skips it.

The data folder is `~/Library/Application Support/ros.ai` on a Mac, or `.ros-ai/` when the checkout has one. `ROS_DATA_DIR` picks another, and Settings › General shows the one in use.

ros.ai asks GitHub for a newer release at start and every six hours, sending nothing about you. When one is ready, an **Update** button appears: the Mac app restarts into the checked download, and a source checkout on `main` pulls, rebuilds and restarts. Settings › General › Updates turns the check off, and `ROS_UPDATE_URL=off` stops it entirely.

## Hosted ros.ai

The app works on its own with your keys and agents. A ros.ai account adds free hosted ROS with a daily allowance. Paid tiers come later: a workspace that keeps running when your laptop is closed, memory across machines, hosted connectors. That service lives in the private repository `arkdong/ros-ai-cloud`, and `ROS_CLOUD_URL=off` hides it.

## Examples

**Start from** offers two guided examples: [From idea to report](examples/demo-workflow/), a research run on AI in Dutch business, and [the banking question](examples/dutch-ai-adoption/README.md) on CBS figures, with two real calculations and an editable article. The `examples/` folder holds more projects to open: [Amsterdam rainfall and cycling](examples/demo-amsterdam/README.md) and [Amsterdam cycling and weather](examples/amsterdam-cycling-weather/README.md) on KNMI observations, [Schiphol weather](examples/schiphol-live-research/README.md) and [Coffee cooling](examples/coffee-cooling/README.md). [Market risk](examples/demo-market-risk/README.md) needs its own data, which is not redistributed.

## Development

```sh
npm run dev            # live reload
npm run lint           # TypeScript
npm run build          # production build, which CI runs on every pull request
npm run try -- 42      # start pull request #42 on localhost, your checkout untouched
npm run app            # the Mac app on this checkout; npm run app:build makes the DMG
npm test               # unit suite
```

`npm run try` puts the pull request in `../ros-ai-try/pr-42` with its own packages and data folder and starts it on the next free port from 4311. The Mac app is an Electron shell around the same server, in [desktop/](desktop/README.md), built by [a GitHub workflow](.github/workflows/mac-app.yml) on every `v*` tag. [AGENTS.md](AGENTS.md) holds the rules for coding agents working on this repository, and [CONTEXT.md](CONTEXT.md) the shared language.

Docs: [working in ros.ai](docs/guide.md), [architecture](docs/architecture.md), [product brief](docs/product-brief.md), [roadmap](docs/roadmap.md), [Python sandbox](docs/python-sandbox.md), [tool connections](docs/tool-connections.md), [inference setup](docs/inference-setup.md), [ros-nemotron](training/ros-nemotron/README.md). The website [ros-ai.io](https://ros-ai.io) lives in [arkdong/ros-ai-site](https://github.com/arkdong/ros-ai-site). The live demo is built from the root Dockerfile on `main`, with saved results only: no new inference, no execution and no access to the host.

## Licence

ros.ai's code and documentation are [MIT](LICENSE): the local app is open source and runs on its own. The licence does not cover:

- the hosted service (sign-in, the hosted ROS gateway and the usage ledger) in the private repository `arkdong/ros-ai-cloud`, which ros.ai runs and sells the paid tiers on. The app works without it;
- the ros.ai name and logo (`public/brand/`, `desktop/build/icon.png`);
- other organisations' logos and marks in `src/client/brand-logos/` (sources in its `SOURCES.md`) and `src/client/ModelMakerSymbol.tsx`, shown only to identify their services;
- third-party data in `examples/`: KNMI weather observations and the datasets derived from them ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), Royal Netherlands Meteorological Institute), CBS statistics in `examples/dutch-ai-adoption/` (CBS's reuse terms) and NDW counter-site records (ODC PDDL).
