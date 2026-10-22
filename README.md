# ros.ai

A persistent local research workspace for following questions, collecting knowledge, proposing hypotheses, running experiments and inspecting evidence over time. Research activities are independent; there is no fixed pipeline.

The CLI serves a browser canvas on loopback. Blocks are Text, Code, Notebook, Data, File, External and Agent, plus Group; a Text block can carry a label that says what it means (question, plan, task, result, finding, decision, draft, report, or your own word). The assistant proposes changes for review under the project's approval mode, and Python runs in an isolated Docker sandbox.

**The product is this local app.** You download it and run it on your own machine, much like DeepSeek's open-source harness or Codex CLI. Your projects, keys and the Python sandbox stay on your machine. Model and search requests go only to the providers you connect, and a model server on your own machine keeps inference local too. The [hosted demo](https://ros-ai-production.up.railway.app/app) is only a quick way to show ros.ai without installing it. What the local release still needs is in [the roadmap](docs/roadmap.md).

## Status

- **Stage One (Code and Notebook blocks)** was completed on October 3; the Stage One foundation work (canvas dock, permissions, project folders, notebooks) continues on a branch. See [RESULT.md](RESULT.md) for what is verified and [the setup guide](docs/stage-one-setup.md) for the workflow. Later stages are not yet defined.
- **Inference:** the user's own **Research model** and the separate **Workspace guide** are described in [the inference design](docs/inference-design-2026-10-01.md) and [setup](docs/inference-setup.md). Managed Nemotron packaging and fine-tuning are deferred.
- **Project folders:** each project lives in a folder you choose. Notes, code, notebooks and data are ordinary files (Markdown, `.py`, `.ipynb`, CSV) that Obsidian, VS Code or Jupyter open, and edits saved there come back as changes you can undo. See [RESULT.md](RESULT.md).
- **Code editor:** Code blocks open straight into an editor with Python highlighting, completion for ros.ai helpers, CSV columns and parameters, and error underlines. `Ctrl/⌘+Enter` runs and `Ctrl/⌘+S` saves.
- **Notebooks:** a Notebook block opens a notebook over the canvas and runs its cells one by one, as Jupyter does, in a Python that stays running in the sandbox. It is saved as `.ipynb` in the project folder, and a `.ipynb` file can be imported.
- **Ros remembers:** Ros notices how you like work done (taste and style, working habits, people, commitments) and proposes one line at a time, kept under the project's permission choice as Markdown files in the app data folder (`memory/`). Settings › Memory lists the lines, and every agent (Ros, the agent loop, Claude Code or Codex over MCP) receives the kept lines as your preferences, never as instructions. The switch there turns it off.
- **Website:** the public site at https://ros-ai.io lives in its own repository, `arkdong/ros-ai-site`. The public demo's `/` redirects there; the app stays at `/app`.
- **Public demo:** Railway builds the root Dockerfile from `main`, so pushing to `main` can deploy. Use branches and pull requests; deployment needs explicit approval under [AGENTS.md](AGENTS.md).
- Dated build notes live in [docs/history](docs/history/). [CONTEXT.md](CONTEXT.md) records shared language.

## Start locally

Use Node.js 24+ and Python 3 for permission analysis/legacy experiments:

```sh
npm ci
npm run build
npm start
```

On macOS, Code and Notebook blocks need nothing else: the first run sets up ros.ai's own Python 3.12 with uv (about 150 MB, once, in the data folder) and runs it in the macOS sandbox, the way Codex and Claude Code run commands. Its only network is a proxy on this computer that asks before each new website (Allow once, Always for this project, Deny; PyPI is always allowed, so `%pip install` works in notebooks); Settings → General → Python network can switch to Full network. On Linux and Windows they still use Docker for now: `docker build -t ros-ai-research-python:1 src/server/sandbox`.

Open **http://127.0.0.1:4310**. The service binds to loopback. ros.ai keeps its own records in the computer's app-data folder (macOS `~/Library/Application Support/ros.ai`), or in `.ros-ai/` when the checkout already has one; `ROS_DATA_DIR` chooses another place, and the folder in use is printed at startup. Keep it and `.env.local` intact. Build after frontend changes and restart the service after backend changes. Docker/image absence disables isolated experiments; it never falls back to unrestricted host Python.

**Keys in one file.** To avoid typing keys into every fresh data folder (eval runs, `npm run try` copies), put them once in `~/.config/ros.ai/keys.env`, readable only by you (`chmod 600`). ros.ai reads it at each start; `ROS_KEYS_FILE` names another file and `ROS_KEYS_FILE=off` skips it. It takes only `*_API_KEY` names (`ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, `NEBIUS_API_KEY`, `OPENAI_API_KEY`), `NOTION_TOKEN`, and optional starting allowances `ROS_START_ALLOWANCE_<CLAUDE|TAVILY|NEBIUS|OPENAI>_USD` (with `_REQUESTS`, default 200). A starting allowance is saved only in a data folder that has never had one for that service, so every fresh data folder gets its own; restarts never top it up.

```sh
mkdir -p ~/.config/ros.ai && touch ~/.config/ros.ai/keys.env && chmod 600 ~/.config/ros.ai/keys.env
open -e ~/.config/ros.ai/keys.env   # ANTHROPIC_API_KEY=…  TAVILY_API_KEY=…  ROS_START_ALLOWANCE_CLAUDE_USD=5
```

**Apps with their own hosted connection (Notion).** On the Apps page, Connect signs in to the app's hosted MCP server the way Claude and Claude Code do: ros.ai registers itself, you approve in the browser, and nothing is created or pasted. ros.ai's assistants then get the app's own tools through `ros_app_tools` and `ros_app_call`. Tools that only read run straight away; anything that could change something in the app appears as a note on the canvas and runs only after you accept it, whatever the permission mode, and Undo in ros.ai does not take it back there. The sign-in is saved privately in the data folder (`app-connections.json`); the catalogue is in `src/server/remote-apps.ts`. A Notion integration secret (`NOTION_TOKEN`, or *Use a token instead*) still works for the older `ros_notion_*` tools.

```sh
npm run dev       # frontend live reload and local server
npm run lint      # TypeScript
npm test          # historical unit suite; day-to-day verification uses lint, build and a browser smoke check
npm run build     # production frontend
npm run try -- 4  # start pull request #4 (or a branch) on localhost without switching branches
```

`npm run try` checks the pull request out into `../ros-ai-try/pr-4` with its own packages and an empty data folder, starts it on the next free port from 4311 and opens the browser. Your checkout, projects and keys stay as they are, and the copy gets no AI keys or spending allowances. Running it again picks up new pushes; `git worktree remove --force ../ros-ai-try/pr-4` deletes the copy.

Credentials, `.ros-ai/` databases, local `evidence/`, generated `outputs/`, historical model-comparison bundles and the restricted market captures stay ignored on disk. A fresh clone includes the banking and weather examples; the market demo appears only where its local data exists.

## Begin with a question


**New project** offers three starting points:

- **Start blank:** an empty canvas with the assistant closed. Create Code or Notebook directly from **Add block**; deliberately open Assistant when useful.
- **Explore a demo:** choose banking or market research. Four user-controlled steps load the question, captured evidence, real saved calculations and editable draft into a new workspace. Starting or advancing the tutorial does not call a model, search the web or execute code. The older KNMI starter remains readable in existing projects.
- **Start a conversation:** submit a question to the project assistant. With authorized model access, it can clarify the idea and propose a small set of related notes for review under the project’s approval mode.

The right panel stays with the project. **Conversation** holds the continuing exchange. **Research outline** anchors the original question above collapsible research directions, with findings indented beneath a direction only when saved ownership or evidence references support that association. Actual nested notes form nested directions; shared findings appear under **Across directions**, and findings without a linked direction remain under **Other findings**. Decisions, hypotheses, gaps and question history remain available in their own disclosures. Short summaries help scanning; full text and references open the notes, artifacts, proposals or saved attempts. Earlier project messages remain accessible without being repeated as new turns.

Selecting a note, group or artifact changes the assistant’s visible focus. Clear focus to return to the whole project. Focus changes attention, not the conversation or permissions. Existing node conversations remain separate and are available through **Discuss** or a node’s **Conversation** tab. Without authorized model access, the assistant labels its responses as saved-context summaries rather than presenting them as model research.

## Explore the canvas

A block is named for how you work with it: Text, Code, Notebook, Data, File, External (a Notion database, for now) or Agent. A Text block's label, the small pill beside its kind, says what it means to the project. Each research block shows one primary preview suited to its saved content: figure, table, metric, code or short text. A Code block shows its source, scrollable inside the card. Pending, active, failed, interrupted or stopped work gets a status line; idle blocks show only their content. The open arrow at the top right (or a double-click) leads to the description, selected inputs, attempts and all saved outputs; hiding secondary evidence on the board never deletes it.

Cards start at 408 px wide. Drag the bottom-right width control, or focus it and use the arrow keys, to choose a width from 320 to 720 px. Width survives restart as a presentation preference. Select several blocks with the canvas Group control, then choose **Group selected**. Only Groups have expansion controls; their light rectangular frames can contain mixed blocks and deliberate nested Groups. Group details hold an optional overview, up to three chosen saved highlights, move/ungroup controls and retained legacy research content. A highlight opens its exact artifact version and source provenance. Opening a research block opens content rather than expanding a hidden container.

Root notes can move freely left of and above the canvas origin; the viewport does not limit their saved positions. Only nested notes stay within their parent’s content boundary. The tool dock on the canvas’s left edge explains each tool on hover: **Group** picks blocks to put in a group, **Up a level** returns to the surrounding group, **Tidy** places recognized sources above consumers, **See all** zooms out to every block and **Collapse** folds open groups. Tidy reserves the actual card, expanded-group and result footprints and keeps branches readable; cyclic relationships do not require an impossible ordering. Disconnected notes and free-form relationships retain visual reading order. Tidy keeps a negative root corner when present and retains the viewport. Opening a project does not rearrange saved positions. The sidebar’s expandable **Notes** tree follows parent ownership and spatial order.

After Group expansion/collapse, resizing or content-driven frame changes, surrounding notes automatically make room using measured sizes and visible previews. Shrinking groups release the space introduced by expansion while preserving deliberate manual gaps and the existing relationship order. Nested groups settle inside their parents. Reflow saves changed positions in a settled batch and keeps pan, zoom and focus steady; another Arrange click is unnecessary.

All saved results remain available through block details and the artifact viewer. Explicit artifact pins and Group highlights are chosen separately from the primary board preview. Dataset pagination is a viewer preference; it does not truncate captured data or alter research history.

Drag a handle from any side of a note to another note, or click a handle and then choose the destination. The canvas combines all relationships between each pair of top-level notes/groups into one line labelled with its relationship count, including when groups expand. Opposite directions share the same line with arrows at both ends. Select the line to inspect its contributing source notes, target notes and labels. Individual child links and links within the same group remain in note details, with no extra canvas wires or boundary markers. Original relationships, selected evidence and ownership stay intact. The Research outline keeps the individual relationship wording and direction; connections never schedule work or import evidence.

The workspace uses charcoal text, white cards and panels, a near-white canvas and larger type. Outcome sections use restrained soft colors with readable status labels. Full original titles and descriptions remain available on open/expand. The supplied wordmark appears at home; the vivid green ring identifies the assistant and its top-right toggle, and serves as the favicon. Assets are bundled locally with their aspect ratios preserved. The browser title follows the selected project as **Project name · ros.ai**, or **ros.ai — Research workspace** with no project. Aggregated connection endpoints follow the top-level card or expanded group as it moves. Connections shows provider configuration and accounting; model choices are visible in the assistant and note details.

Pin an artifact as a highlight. Reuse it through the artifact menu or drag it into another group; this selects that exact immutable version and does not run the destination. Connections express relationships, never scheduling or automatic input import. Manual structure edits are undoable. Old Topic/Activity and Knowledge/Action content displays as Text (an Action as a Text block labelled task) without rewriting its historical records.

**Canvas history** shows content edits and saved-evidence milestones. Undo/Redo applies to note creation, content edits, deletion and relationships, preserving current presentation where the parent scope matches. Movement, Arrange, resizing, automatic reflow, expansion and result paging stay out of this timeline and do not discard content redo. Older layout-only entries are hidden from the content view but remain stored. Saved evidence opens its immutable artifact versions; Undo never deletes execution evidence, approvals or spending records.

## Select data and run research

1. Add Text blocks for your question (label them question, plan or task as you like). Open **Resources** from the library icon beside the top-toolbar battery, choose **Add file** to copy a CSV into the project or link an explicitly selected absolute local path. Files must be UTF-8 CSV, no larger than 500,000 bytes. A project copy stays independent of later source changes; a linked file stays read-only.
2. Preview a resource, choose its destination and select **Use in note**. Linked files are read again at use time to capture their current version; copied files and already captured evidence retain their saved version. Selection does not start research. Resource labels distinguish linked files, project copies and captured sources/datasets, including the originating note. **Exports** and the earlier **Local files & exports** controls remain available.
3. Open **Permissions** and choose an approval mode; the choice saves at once. New blocks inherit the project default, and a block can override its mode.
4. Continue in the project conversation, or open a block’s research dialog for a dataset-specific session. With provider authorization, the assistant can search for sources, propose notes, write exact Python against captured data, inspect actual outputs/errors and propose revisions. Project turns retain their model-visible requests and tool actions; execution attempts retain their saved code, inputs and outputs. Manual local experiments and labelled saved-context summaries remain available without paid inference.
5. Review pending requests as required. Experiment views put approvals and saved results first; expand the exact-request and advanced sections for code, data, runtime and parameters. A Text block’s label changes from the pill beside its kind on the card; a block joins a Group when you drop it on the open Group and leaves when you drag it out. Continue with a follow-up question; prior work remains saved and budgets do not reset.
6. Select an output folder in Local files and export chosen artifacts. Outputs use new filenames. Source modification requires separate connection write permission and an expected source hash; Full access cannot override a read-only source.

## Three approval modes

- **Ask every time:** review each experiment and additional block. Creating a related block and starting its work are separate decisions in this mode.
- **Approve for me:** an independent, conservative rule reviewer runs plain data-analysis code (pandas, NumPy, SciPy, Matplotlib and the standard maths modules) straight away. Other imports, file or system access and anything unfamiliar escalate to a person, and so do blocks the assistant adds. This is an automatic policy reviewer, not a second reasoning model or a scientific-validity guarantee.
- **Full access:** code runs straight away in the isolated sandbox and the assistant can add blocks without asking; every change stays undoable. Stop controls, the isolated runtime and connection permissions still apply.

The project keeps running tallies of code runs, model requests, created Actions, runtime and spending. They are a record, not a limit: paid calls stay capped by each connection’s own allowance, which failures, retries, follow-ups and mode changes never replenish. **Stop all** stops project research, active experiments and provider requests; resume is explicit. Browser closure leaves the server working. Service/laptop shutdown interrupts work; reopening never blindly repeats a paid request.

Use a project’s **… → Delete project** action to move it to local **Trash**, then **Restore** to recover it. Notes, conversations, artifacts and history remain stored. Active research and pending experiments must be stopped first; Trash is not a way to discard running work or reset its accounting.

## Actual Python boundary

Python executes with pandas, NumPy, matplotlib and SciPy inside the macOS sandbox (Seatbelt: network only through ros.ai's asking proxy, the home folder unreadable except the project, writes only to the notebook's outputs folder and a private temporary folder, memory and process caps) or, on other systems, inside Docker. The dedicated Code block receives `params`, `pd`, `np`, `plt`, `scipy` and output helpers; `df` exists only when a full CSV is deliberately selected. Legacy dataset experiments retain their captured `df` contract:

```python
metric("Mean", df["value"].mean())
table("Summary", df.describe().reset_index())
fig, ax = plt.subplots()
ax.plot(df["value"])
plot("Observations", fig)
export_csv("Data used", df)
```

The container has no external network, no original source/user folder mounts, read-only root/input files, non-root identity, dropped capabilities, seccomp, 512 MB memory, one CPU, process/output limits and a 30-second wall deadline. Python can access installed container files and create processes within those limits; this is not a VM per run or proof against kernel vulnerabilities. See [the precise runtime boundary](docs/python-sandbox.md). The earlier closed numerical interpreter remains an explicitly selectable compatibility backend.

## Use your own Claude Code, Codex or Cursor

ros.ai is also an MCP server, so you can keep researching in your own Claude Code, Codex, Cursor or Gemini CLI, signed in with your own plan or key. ros.ai never sees or handles that login.

At first launch ros.ai looks at this computer (the Applications folder, your PATH, the names in those agents' settings and the model servers on `127.0.0.1`; nothing is sent anywhere, and no credential file is opened) and shows one **Connect your tools** screen with what it found: your agents, a running Ollama or LM Studio, and the free hosted Ros. **Connect** links them in one go: for Claude Code and Codex it runs their own `mcp add`, for Cursor and Gemini CLI it adds one `ros-ai` entry to their settings file (with a one-time backup). Every link is one entry you can undo from the **Agents** page, which also shows when each agent was last seen in a project. Set `ROS_NO_DETECT=1` to skip the scan.

You can also paste the command yourself (the **Agents** page shows the exact path):

```bash
claude mcp add --scope user ros-ai -- node "/path/to/ros.ai data/bin/ros-ai-mcp.mjs"
codex mcp add ros-ai -- node "/path/to/ros.ai data/bin/ros-ai-mcp.mjs"
```

The agent can then read the canvas, artifacts and your saved preferences (`ros_read_memory`) and propose blocks, report revisions, analysis code and reuse. Proposals follow the project's Permissions choice, run code only in ros.ai's sandbox, and appear in the assistant panel under the agent's name. Started inside a project's folder, the agent works in that project; otherwise it names one. ros.ai copies the bridge (`scripts/ros-ai-mcp.mjs`) into its data folder at every start and links point at that copy, so moving or updating the code keeps them working. The bridge talks to `127.0.0.1` with a token ros.ai writes to its data folder (`mcp.json`) at every start; it looks for that file next to itself, in a checkout's `.ros-ai` and in the usual app-data folder, and `ROS_DATA_DIR` overrides all three.

## Models and spending

The library, battery and assistant ring open mutually exclusive **Resources**, **Budget & usage** and **Research assistant** panels in the same right-side space. Resources shows source/owner/date, preview, file import and exports. Explicitly related captures expand into exact versions; matching names or URLs alone never merge data.

The battery opens **Budget & usage**. It shows what the project has spent so far, plus recorded provider requests for **Last hour**, **Today** or **Last 24h**. Today follows the viewer’s local midnight, including daylight-saving changes. Known cost estimates, reported tokens/search credits and unknown costs stay distinct. Nebius credit may be shown as a dated user report, with its original observation time unknown and no API verification. Tavily key/account credits and limits can refresh server-side through a one-minute cache when `ROS_TAVILY_USAGE_SYNC=1` is explicitly enabled; current live verification remains blocked by approval review. Credits are not converted to dollars. App provider allowances remain separate admission limits. See [account usage](docs/provider-account-usage.md).

Choose **Nebius Token Factory** or **OpenAI** in the assistant, note details or research dialog. The project default is Nebius with Nemotron 3 Ultra (`nvidia/Nemotron-3-Ultra-550b-a55b`, or the existing `ROS_NEBIUS_MODEL` configuration). A task inherits its nearest containing stage/group setting, then the project default. Changing a provider or model creates an override for that note; **Use inherited setting** removes it. Nebius also offers Kimi K2.7 Code. OpenAI offers GPT-5.4 mini and GPT-5.4 through direct calls with the official OpenAI SDK. No Agents SDK workflow or locally hosted model backend is used. Model selection is separate from the Python execution runtime.

Project collaboration and research planning retain application-validated JSON contracts, captured model selections and observable request/response evidence. OpenAI credential and model catalog access have been verified; no paid OpenAI inference was performed for this change. Model claims, source excerpts and actual execution outputs remain distinguishable. See [current results](RESULT.md) for verification details.

Save the OpenAI key on the **Model** page under **OpenAI API**, or configure `OPENAI_API_KEY` in ignored server-side `.env.local` and restart. Set the visible USD and request allowance on the **Budget** page and explicitly enable usage. Its default allowance is $0. A configured credential or model selection alone does not grant spending permission. The alternative operator environment fields remain `ROS_OPENAI_AUTHORIZATION_ID`, `ROS_OPENAI_AUTHORIZED_USD` and `ROS_OPENAI_MAX_REQUESTS`.

Credentials stay server-side. The **Budget** page lets the user explicitly enable a fresh inference/search allowance with a total USD ceiling and request ceiling. The first app allowance is separate from preserved historical environment usage; subsequent edits, pauses, credentials and restarts never reset its retained counters. Once saved, an app allowance takes precedence even while paused. Operator configuration through `ROS_PAID_AUTHORIZATION_ID`, `ROS_NEBIUS_AUTHORIZED_USD`, `ROS_TAVILY_AUTHORIZED_USD` and `ROS_PAID_MAX_REQUESTS` remains an alternative before an app allowance exists. Historical allowances are not new permission. Reservations remain after settlement, failure and restart; they are not an account balance or invoice. Never rotate an authorization ID/data directory to reset a grant.

The historical September 22 continuous-assistant build recorded a **US$10 combined ceiling for Nebius inference and sandbox attempts**, configured through `ROS_NEBIUS_COMBINED_AUTHORIZATION_ID` and `ROS_NEBIUS_COMBINED_AUTHORIZED_USD`. It is cumulative across projects, retries and uncertain outcomes, and preserves older grants. Tavily's separate historical cumulative ceiling retains earlier usage. Neither record authorizes new calls in this iteration. The combined grant does not establish sandbox pricing or permit a remote attempt without exact approval and its separate pricing admission. Current usage belongs in [RESULT.md](RESULT.md).

## Demonstrations and boundaries

- [AI adoption in Dutch businesses · the banking question](examples/dutch-ai-adoption/README.md): CBS evidence, two real local executions, a denominator/coverage challenge and an editable article. The book icon starts a four-stage saved-results tour. Live model refinement is unavailable under current limits; the manual fallback is labelled.
- [Amsterdam-area rainfall patterns for cycling planning](examples/demo-amsterdam/README.md): actual KNMI weather analysis and two plots. Explicit weather-only fallback; cycling counts remain unavailable.
- [When market conditions change · a historical risk baseline](examples/demo-market-risk/README.md): actual historical prices, preceding-window thresholds, exceedances and drawdown. Local research; public redistribution rights are not cleared.

- [Schiphol weather · live assistant research](examples/schiphol-live-research/README.md): preserved guided live Ultra/Tavily/Docker demonstration with exact output reuse; [September 22 verification](docs/history/RESULT-continuous-2026-09-22.md) records its limitations and accounting.
- [Amsterdam cycling and weather](examples/amsterdam-cycling-weather/README.md): saved as **Amsterdam cycling & weather — evidence first**, with 366 real KNMI days, two completed local Python analyses, three plots, selected evidence reuse and a seasonal follow-up. Open **Audit the real weather data**, then **Compare seasons & trace assumptions**. Code was prepared by the coding assistant; no new app-model inference was used. Bicycle counts are missing, so no cycling association is claimed.
- [Coffee cooling](examples/coffee-cooling/README.md): earlier synthetic-data example with real local computations and preserved history.

ros.ai's own records (SQLite and content-addressed artifacts) live in the data folder printed at startup. Stop the app before backing up the whole folder. A project's folder holds copies of its blocks as plain files; history, runs and saved versions stay in the data folder. Legacy projects, chats, histories, artifacts, selections and accounting remain intact. Captured requests explain observable provenance, not hidden reasoning or deterministic replay.

Notebook/Excel/database engines, other embedded agent runtimes, accounts, cloud sync and remote continuation remain future work. The local Codex adapter is implemented, but an actual authorized end-to-end turn remains unverified and blocked as described above. Nebius Sandboxes has a REST execution adapter, pinned Python 3.12 stdlib image, separate budget admission, cancellation and restart reconciliation. One narrowly authorized historical remote smoke is verified; beta pricing/units remain unknown for normal admission. Remote attempts always require exact approval. No deployment, purchase, public write or eligibility claim is part of this iteration.

- [Product brief](docs/product-brief.md)
- [Architecture](docs/architecture.md)
- [Data provenance](docs/amsterdam-data.md)
- [Current verification](RESULT.md)
- Strategy notes of 16 October 2026 (internal): [product and market report](docs/strategy/product-and-market-report-2026-10-16.md), [investor brief](docs/strategy/investor-brief-2026-10-16.md), [YC application answers](docs/strategy/yc-application-answers-2026-10-16.md)
- Onboarding design of 19 October 2026 (internal): [find and connect your tools](docs/strategy/onboarding-connections-2026-10-19.md), a design doc and screen mockup; its first slice (the scan, the first-launch screen, silent links for Claude Code, Codex and Cursor, the rows on Agents) is built
- Strategy note of 19 October 2026 (internal): [voice presenter and personal memory](docs/strategy/voice-presenter-and-personal-memory-2026-10-19.md), an investigation of two extension features and their moat value

## Optional public demonstration

The curated public mode is separate from your local workspace and provider credentials. See [Railway setup](docs/railway-deployment.md). It uses per-browser visitor stores, the banking tutorial and saved results only; new inference, execution and host-file access are disabled. The market dataset and figures are omitted pending redistribution permission. A prepared Docker image or local preview is not a deployed website; current deployment status belongs in [RESULT.md](RESULT.md).

## Licence

ros.ai's code and documentation are released under the [MIT licence](LICENSE): the local app is open source and runs on its own. The licence does not cover:

- the hosted service (sign-in, the hosted Ros gateway and the usage ledger), which lives in the separate private repository `arkdong/ros-ai-cloud` and is not open source; ros.ai runs that service and sells the paid tiers on it. The app works without it;
- the ros.ai name and logo (`public/brand/`);
- other organisations' logos and marks, in `public/deck/assets/` and in `src/client/brand-logos/` (sources in its `SOURCES.md`) and drawn in `src/client/ModelMakerSymbol.tsx`; they belong to their owners and are shown only to identify their services;
- third-party data in `examples/`: KNMI weather observations and the datasets derived from them ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), Royal Netherlands Meteorological Institute), CBS statistics in `examples/dutch-ai-adoption/` (CBS's own reuse terms), and NDW counter-site records (ODC PDDL).
