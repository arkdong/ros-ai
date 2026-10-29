# ros.ai

**Run your agents in the open.**

ros.ai is the open workspace that holds your whole project's context on one canvas. AI agents from any vendor work from it, and you see the whole picture, make the connections and direct them there.

Your notes, code, data, files, papers and Notion pages sit on the canvas as blocks. Claude Code, Codex, Gemini CLI, Goose, OpenCode, local models and ROS, our own agent, work from those blocks with the same tools. Their work lands back on the canvas with its sources, under the permissions you set, and every change can be undone. ros.ai runs on your own computer, and the code is MIT.

[ros-ai.io](https://ros-ai.io) · [Live demo](https://ros-ai-production.up.railway.app/app) · [Guide](docs/guide.md)

## Install

**Mac app:** download it for [Apple silicon](https://github.com/arkdong/ros-ai/releases/latest/download/ros.ai-mac-arm64.dmg) or [Intel](https://github.com/arkdong/ros-ai/releases/latest/download/ros.ai-mac-x64.dmg) and drag ros.ai to Applications. The build is not signed yet, so the first open says macOS could not verify it. Click Done, then open System Settings › Privacy & Security and choose Open Anyway. After that it opens as usual.

**Terminal**, on a Mac, Linux or Windows under WSL:

```sh
curl -fsSL https://ros-ai.io/install.sh | sh
```

On a Mac that installs the app from the latest release and opens it, with no Open Anyway step (`ROS_AI_SOURCE=1` builds from source instead). On Linux and WSL it needs git and Node.js 24: it builds ros.ai in `~/ros-ai`, adds the `ros-ai` command and opens the workspace at http://127.0.0.1:4310. From a clone, `npm ci && npm run build && npm start`; `npm link` adds the command (`ros-ai` starts, `ros-ai update` pulls the latest release and rebuilds, `ros-ai app` opens the Mac window).

Everything stays on this computer: projects, keys and the Python sandbox. Model requests go only to the providers you connect.

## First run

1. **Welcome.** A running canvas shows what a project looks like.
2. **Set up ROS.** Sign in for free hosted ROS, or continue without an account. On a Mac you can also download ROS to run on this computer.
3. **Connect your tools.** ros.ai finds Claude Code, Codex, Cursor, Gemini CLI, Pi, Hermes Agent, Ollama and LM Studio on this computer and links them in one go. Nothing is sent anywhere.

Then one card starts a project: a name, a folder, and **Start from** a blank canvas, a folder you already have or an example.

## The canvas

**Add block** offers Text, Code (Python), Notebook, Data (a CSV or a linked sheet), File (PDF or image), Paper (OpenAlex, arXiv, Zotero), Notion (a page or database, read live), Google Drive (a Sheet or Doc, read live), App (a small page an agent builds, sealed on its card), Training run and Group. Agents add their own blocks as they work: an Agent block for each task and a Web block for each search.

Every block an agent made says so. A label marks a Text block as a question, task, finding, decision or draft. Every change stays undoable.

A project is a folder of plain files: Markdown, `.py`, `.ipynb` and CSV. Obsidian, VS Code and Jupyter open them, and edits made there come back as changes you can undo.

## The ROS bar

The bar at the bottom of the canvas is where you direct the work. Ask ROS, or @ an agent. Its menu picks the agent, its model and effort, and the project's permissions. `/` applies a skill. Esc twice stops a running turn.

A project holds many threads. The threads button in the bar starts a new one or switches between them, and two can work at once, each with its own history and its own agent session. Changes they propose land on the one map.

## Agents

The **Agents** page lists every agent that can work in your projects, grouped by who pays.

- **On your subscription:** Claude Code on your Claude plan, Codex on your ChatGPT plan.
- **On your API keys:** Claude Code, Codex, the OpenAI API and Nebius Token Factory.
- **Their own setup:** Gemini CLI, Goose and OpenCode, with the sign-in or model they already have.
- **Free:** ROS, and open models from Ollama, LM Studio or any OpenAI-compatible server.
- **Your own agents:** your Claude Code, Codex, Cursor, Gemini CLI, Pi or Hermes Agent, on their own sign-in, through ros.ai's MCP server. ros.ai never sees that login.

Every agent gets the same tools, plugins and permissions. The Agents page shows the exact command that links your own agent, for example:

```sh
claude mcp add --scope user ros-ai -- node "/path/to/ros.ai data/bin/ros-ai-mcp.mjs"
```

## ROS

ROS is ros.ai's own agent: NVIDIA Nemotron 3 in ros.ai's agent loop, with the canvas as its tools. It reads the canvas, proposes blocks and Python, searches the web in several directions, reads the pages, writes findings with checked quotes, and checks the claims in any answer.

- **Hosted ROS** runs Nemotron 3 Nano and Super on Nebius Token Factory. Sign in and it works, with a free daily allowance and no key.
- **ROS on this computer** is [ros-nemotron](training/ros-nemotron/README.md), our fine-tune of Nemotron 3 Nano 4B on 1,140 real ros.ai turns. On 95 held-out tasks it passes 66, against 33 for the base model. ros.ai downloads it (about 3 GB, with about 8 GB of memory) and runs it with llama.cpp, free and offline. Weights: [arkdong/ros-nemotron-4b-GGUF](https://huggingface.co/arkdong/ros-nemotron-4b-GGUF).

ROS also remembers how you like work done, one line at a time, kept as Markdown in the data folder. Settings › Memory lists the lines and can turn it off.

## Plugins and skills

**Plugins** are the apps every agent can use: Notion (several accounts), Google Drive, Sheets and Docs, GitHub, Linear, Sentry, Figma, Slack, Zotero, OpenAlex and arXiv, web search with Tavily, Exa or Brave, and a browser that opens public websites in an empty profile, never with your cookies. Reads run straight away. A change in an outside app waits for your OK.

**Skills** are ways of working an agent follows when a task matches. Write one, paste one, link one from GitHub, or copy from your Claude Code, Codex, OpenCode or Gemini folders. Every agent reads the same library.

## Permissions

Each project has one permission setting, in the ROS bar's menu and in Settings › General.

- **Ask every time:** every code run and every canvas change waits for your OK.
- **Approve for me:** plain analysis, new blocks and moves go ahead; the rest waits for you.
- **Full access:** code runs and canvas changes land at once; everything stays undoable.

A write to an outside app always asks, because Undo cannot take it back.

## Python on this computer

Code and Notebook blocks run ros.ai's own Python 3.12, set up with uv on first use (about 150 MB, once). On a Mac it runs in the macOS sandbox, the way Claude Code and Codex run commands: it reads the project, writes its outputs, and reaches a website only after you allow it. PyPI is always allowed, so `%pip install` works. On Linux and Windows the blocks use Docker: `docker build -t ros-ai-research-python:1 src/server/sandbox`.

## Keys, data and updates

Keys pasted on the Agents and Plugins pages are saved in the data folder: `~/Library/Application Support/ros.ai` on a Mac, or `.ros-ai/` when the checkout has one. To paste them only once, put them in `~/.config/ros.ai/keys.env` (`chmod 600`), which ros.ai reads at every start: any `*_API_KEY`, `NOTION_TOKEN`, and a starting allowance as `ROS_START_ALLOWANCE_<CLAUDE|TAVILY|NEBIUS|OPENAI>_USD`.

ros.ai checks GitHub for a newer release at start and every six hours, sending nothing about you. An **Update** button appears when one is ready. Settings › General › Updates turns the check off.

## Examples

**Start from** offers two guided examples: [From idea to report](examples/demo-workflow/), a research run on AI in Dutch business, and [the banking question](examples/dutch-ai-adoption/README.md) on CBS figures. The `examples/` folder holds more projects to open as a folder.

## Development

```sh
npm run dev            # live reload
npm run lint           # TypeScript
npm run build          # production build, which CI runs on every pull request
npm run try -- 42      # start pull request #42 on localhost, your checkout untouched
npm run app            # the Mac app on this checkout; npm run app:build makes the DMG
npm test               # unit suite
```

The Mac app is an Electron shell around the same server, in [desktop/](desktop/README.md), built and released by [a GitHub workflow](.github/workflows/mac-app.yml) on every `v*` tag. [AGENTS.md](AGENTS.md) holds the rules for coding agents working on this repository.

Docs: [working in ros.ai](docs/guide.md), [architecture](docs/architecture.md), [roadmap](docs/roadmap.md), [Python sandbox](docs/python-sandbox.md), [tool connections](docs/tool-connections.md), [ros-nemotron](training/ros-nemotron/README.md). The website lives in [arkdong/ros-ai-site](https://github.com/arkdong/ros-ai-site). The live demo is built from the root Dockerfile on `main`, with saved results only.

## Licence

ros.ai's code and documentation are [MIT](LICENSE). The licence does not cover the hosted service (sign-in, the hosted ROS gateway and the usage ledger), which lives in the private repository `arkdong/ros-ai-cloud` and will sell the paid tiers; the app works without it, and `ROS_CLOUD_URL=off` hides it. It also does not cover the ros.ai name and logo (`public/brand/`, `desktop/build/icon.png`), other organisations' logos in `src/client/brand-logos/` and `src/client/ModelMakerSymbol.tsx`, shown only to identify their services, or the third-party data in `examples/`: KNMI weather observations ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)), CBS statistics (CBS's reuse terms) and NDW counter-site records (ODC PDDL).
