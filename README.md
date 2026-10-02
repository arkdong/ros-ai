# ros.ai

A persistent local research workspace for following questions, collecting knowledge, proposing hypotheses, running experiments and inspecting evidence over time. Research activities are independent; there is no fixed pipeline.

## Development repository · October 2, 2026

`/Users/adamdong/code/ros-ai` is the main development checkout for the private [arkdong/ros-ai repository](https://github.com/arkdong/ros-ai), using branch `main` and remote `origin`. The full application source, setup, engineering documentation, scripts and existing tests now continue the earlier demo-release history. The old temporary release checkout is no longer the development source.

After reviewing changes, use `git add <paths>`, `git commit`, and `git push`. Credentials, `.ros-ai/` databases, recovery backups, local `evidence/`, generated `outputs/`, historical model-comparison bundles and restricted market captures stay ignored on disk. Some dated reports link to these local-only records. A fresh clone includes the banking and weather examples; the market demo requires the separately retained local data/results, which are not distributed here. The original October 2 local root commit remains in a local backup branch and `.ros-ai-backups/git-connect-2026-10-02/original-local.bundle`; do not push backup branches with `--all` or `--mirror`.

The root Dockerfile still packages only the isolated banking demo. Railway currently watches `main`, so pushing application changes can also deploy that demo; deployment requires explicit approval under `AGENTS.md`.

**Stage One delivery, October 2:** dedicated **Code** and **Notebook** blocks support manual work, immutable outputs, exact same-project input selection and report evidence. Code executes Python through the existing isolated Docker runtime, with no dataset or one deliberately selected full CSV. Notebook connects to a user-managed local Jupyter server, opens its native interface separately and captures selected saved cell outputs; bounded `.ipynb` import is also available. Code and imported-output paths are verified. **Live Jupyter integration remains blocked because no local session is available; Stage One is not fully verified.** [Setup and short workflow](docs/stage-one-setup.md), [delivery and evidence](RESULT.md). Stages two onward remain undefined.

The [inference design](docs/inference-design-2026-10-01.md) separates the user's chosen **Research model** from the **Workspace guide**. Compatible personal API/local HTTP connections and explicitly selected guide context are implemented; a managed optional Nemotron runtime/checkpoint and conditional fine-tuning remain later stages. [Setup](docs/inference-setup.md) records processing and verification limits. [CONTEXT.md](CONTEXT.md) records shared language.

## Local workspace iteration · September 30–October 1, 2026

Groups are now explicit organizational frames containing mixed research blocks. Select blocks to group them; expand a Group to see its contents, or collapse it to a title, item count and up to three chosen exact-version highlights. Research blocks open their content and saved results. The focused block registry supports notes, Actions, datasets, figures, code and reports. Legacy containers retain their identities, overview research, evidence and effective models; moving or grouping blocks preserves those model settings and shared authority.

Datasets and tables now have pagination, search, column filtering, sorting, column visibility and type/empty-cell summaries, with full CSV download. A before/after preview can save a cleaned or derived copy while retaining the source version. Figures offer zoom, SVG download, caption/presentation revisions and navigation to producing attempts and captured inputs. Ordinary projects can create editable reports with inline figures/tables and exact evidence links, then export Markdown or self-contained HTML. Saving creates a derived version; viewing never recomputes research.

Assistant submissions now expose pending admission, persistent failures, progress and Stop. Unavailable inference states the exact blocker; saved-record responses remain labelled. The original reported silence was **not reproduced**, so no root cause is claimed. A separate local Codex app-server adapter and validated selected-context tools are implemented. Actual read-only authentication/protocol/configuration checks passed, with **no inference turn**. Embedded Codex work is blocked by the absent fresh bounded grant and installed CLI's missing restricted read-root support. See [integration limits](docs/codex-local-agent-2026-09-30.md) and [current results](RESULT.md).

The top-right **Connections** button opens a right-side panel with collapsible tool rows and visible connection/usage summaries. Nebius, direct OpenAI and Tavily expose total USD/request allowances shared across ros.ai projects; the current project's separate USD ceiling is visible and saved deliberately (new projects start at $0). Codex exposes scoped turn/time/tool allowances, with isolation still required; Claude API setup retains its unavailable embedded-runtime label. Google Drive supports read-only CSV browsing and explicit project copies up to 500,000 bytes, with no model budget. Saved keys remain in private server files, and allowance edits, pause and restart preserve retained usage. Relationship badges show the actual wording on their drawn line, with exact endpoints in inspection. See [connection setup and allowance limits](docs/tool-connections.md).

The following earlier build records remain historical context. This iteration is local; it authorizes no deployment, public write or paid/subscription-consuming inference.

The September 23 build adds optional Demo mode for first visitors, with banking and market scenarios in four progressive stages. Each creates a separate workspace using genuine saved results; an optional exact-approved local Python rerun produces a separate fresh attempt. Knowledge views and stage highlights expose their saved findings, and each node shows its effective model. A separate isolated public-demo mode and curated Railway release are prepared. The curated release is published in the private [arkdong/ros-ai repository](https://github.com/arkdong/ros-ai) for Railway import. The latest $90-cap rerun records six fresh requests: all generated programs produce all four required values and all drafts complete; the earlier $40-cap trial remains preserved. Its measured statistics appear before Responsible design in the HTML pitch. Public execution remains additional work. See [current results](RESULT.md).

The preceding September 23 workspace refinement adds automatic spacing when displayed frames change size, content-only canvas history, the supplied ros.ai wordmark and green ring, project-aware browser tabs, and a read-only budget panel. It retains saved-outcome cards, adjustable widths, source-to-consumer arrows and the existing reading surface. Full saved research remains available. Presentation changes do not invalidate unchanged experiment approval. See [current verification](RESULT.md).

The September 22 continuous-assistant build adds a persistent project conversation and research outline alongside the canvas. It keeps the original question, evolving intent, decisions and evidence together while attention moves between notes and artifacts. Notes remain independently editable, with direct connections, inline editing, explicit arrangement and recoverable project deletion.

The earlier September 22 sandbox extension added an explicitly approved Nebius Sandbox runtime alongside local execution. Authenticated catalog access and one explicitly authorized remote smoke are verified; normal product execution retains its pricing and authorization gates. The continuous assistant can propose exact remote code for review, but a proposal does not bypass that gate. See [sandbox setup](docs/nebius-sandbox-setup.md).

The September 21 collaborator build adds one expandable canvas, Knowledge and Action nodes, a scoped model research loop, three approval modes, isolated Python with research libraries, and local CSV/output connections. [RESULT.md](RESULT.md) distinguishes actual verification from unfinished live checks. Earlier [foundation](RESULT-foundation-2026-09-21.md) and [experiment-build](RESULT-experiments-2026-09-21.md) records remain preserved.

## Start locally

Use Node.js 24+, Python 3 for permission analysis/legacy experiments, and a running local Docker engine for research Python:

```sh
npm ci
docker build -t ros-ai-research-python:1 src/server/sandbox
npm run build
npm start
```

Open **http://127.0.0.1:4310**. The service binds to loopback. Keep `.env.local` and `.ros-ai/` intact. Build after frontend changes and restart the service after backend changes. Docker/image absence disables isolated experiments; it never falls back to unrestricted host Python.

```sh
npm run dev       # frontend live reload and local server
npm run lint      # TypeScript
npm test          # historical suite; current iteration uses focused checks, not this suite
npm run build     # production frontend
```

## October 2 — answer questions individually

The **Assistant** presents several clarifiers as a compact **Answer questions** button. Its dialog offers up to two explicit suggestions per question, a custom answer, and **Not important · leave out**. Draft answers stay on this browser by project and question set. **Add answers to draft** preserves the existing message; sending remains deliberate. Historical saved questionnaires gain this view without rerunning a model. Card previews use visible indented branches and distinct Knowledge/Action symbols, colors and shapes; recovered outlines remain drafts.

Canvas Add, Undo/Redo, History and tutorial controls now sit on the white dotted canvas. Reports remain available through **Add block → Report**; an empty canvas offers **Add your first block**. Connections, project permissions, budget and resources stay in the project header. [Current verification](RESULT.md).

## Begin with a question

October 2 generated-card follow-up: assistant additions now use parent-local, card-sized placement, and redundant Group membership wires stay in details. Knowledge labels match the preview. Review found model-authored methodology errors in Test's ASML/Lam notes; corrected ROIC-minus-WACC content is saved as a pending proposal, with original cards retained until acceptance. [Diagnosis and verification](RESULT.md).

**New project** offers three starting points:

- **Start blank:** an empty canvas with the assistant closed. Create Code or Notebook directly from **Add block**; deliberately open Assistant when useful.
- **Explore a demo:** choose banking or market research. Four user-controlled steps load the question, captured evidence, real saved calculations and editable draft into a new workspace. Starting or advancing the tutorial does not call a model, search the web or execute code. The older KNMI starter remains readable in existing projects.
- **Start a conversation:** submit a question to the project assistant. With authorized model access, it can clarify the idea and propose a small set of related notes for review under the project’s approval mode.

The right panel stays with the project. **Conversation** holds the continuing exchange. **Research outline** anchors the original question above collapsible research directions, with findings indented beneath a direction only when saved ownership or evidence references support that association. Actual nested notes form nested directions; shared findings appear under **Across directions**, and findings without a linked direction remain under **Other findings**. Decisions, hypotheses, gaps and question history remain available in their own disclosures. Short summaries help scanning; full text and references open the notes, artifacts, proposals or saved attempts. Earlier project messages remain accessible without being repeated as new turns.

Selecting a note, group or artifact changes the assistant’s visible focus. Clear focus to return to the whole project. Focus changes attention, not the conversation or permissions. Existing node conversations remain separate and are available through **Discuss** or a node’s **Conversation** tab. Without authorized model access, the assistant labels its responses as saved-context summaries rather than presenting them as model research.

## Explore the canvas

Knowledge means what you study; Action means what you do. Each research block shows one primary preview suited to its saved content: figure, table, metric, code or short text. Before a result exists it shows its purpose. Current pending, active, failed, interrupted or stopped work remains distinct from earlier successful results. **Open content** leads to the description, selected inputs, attempts and all saved outputs; hiding secondary evidence on the board never deletes it.

Cards start at 408 px wide. Drag the bottom-right width control, or focus it and use the arrow keys, to choose a width from 320 to 720 px. Width survives restart as a presentation preference. Select several blocks with the canvas Group control, then choose **Group selected**. Only Groups have expansion controls; their light rectangular frames can contain mixed blocks and deliberate nested Groups. Group details hold an optional overview, up to three chosen saved highlights, move/ungroup controls and retained legacy research content. A highlight opens its exact artifact version and source provenance. Opening a research block opens content rather than expanding a hidden container.

Root notes can move freely left of and above the canvas origin; the viewport does not limit their saved positions. Only nested notes stay within their parent’s content boundary. Use **Broader view** to return to context, **Collapse all** to fold groups, and **Arrange** to place recognized sources above consumers. Arrangement reserves the actual card, expanded-group and result footprints and keeps branches readable; cyclic relationships do not require an impossible ordering. Disconnected notes and free-form relationships retain visual reading order. Arrange keeps a negative root corner when present and retains the viewport. Opening a project does not rearrange saved positions. The sidebar’s expandable **Notes** tree follows parent ownership and spatial order.

After Group expansion/collapse, resizing or content-driven frame changes, surrounding notes automatically make room using measured sizes and visible previews. Shrinking groups release the space introduced by expansion while preserving deliberate manual gaps and the existing relationship order. Nested groups settle inside their parents. Reflow saves changed positions in a settled batch and keeps pan, zoom and focus steady; another Arrange click is unnecessary.

All saved results remain available through block details and the artifact viewer. Explicit artifact pins and Group highlights are chosen separately from the primary board preview. Dataset pagination is a viewer preference; it does not truncate captured data or alter research history.

Drag a handle from any side of a note to another note, or click a handle and then choose the destination. The canvas combines all relationships between each pair of top-level notes/groups into one line labelled with its relationship count, including when groups expand. Opposite directions share the same line with arrows at both ends. Select the line to inspect its contributing source notes, target notes and labels. Individual child links and links within the same group remain in note details, with no extra canvas wires or boundary markers. Original relationships, selected evidence and ownership stay intact. The Research outline keeps the individual relationship wording and direction; connections never schedule work or import evidence.

The workspace uses charcoal text, white cards and panels, a near-white canvas and larger type. Outcome sections use restrained soft colors with readable status labels. Full original titles and descriptions remain available on open/expand. The supplied wordmark appears at home; the vivid green ring identifies the assistant and its top-right toggle, and serves as the favicon. Assets are bundled locally with their aspect ratios preserved. The browser title follows the selected project as **Project name · ros.ai**, or **ros.ai — Research workspace** with no project. Aggregated connection endpoints follow the top-level card or expanded group as it moves. Connections shows provider configuration and accounting; model choices are visible in the assistant and note details.

Pin an artifact as a highlight. Reuse it through the artifact menu or drag it into another group; this selects that exact immutable version and does not run the destination. Connections express relationships, never scheduling or automatic input import. Manual structure edits are undoable. Old Topic/Activity content displays as Knowledge/Action without rewriting its historical records.

**Canvas history** shows content edits and saved-evidence milestones. Undo/Redo applies to note creation, content edits, deletion and relationships, preserving current presentation where the parent scope matches. Movement, Arrange, resizing, automatic reflow, expansion and result paging stay out of this timeline and do not discard content redo. Older layout-only entries are hidden from the content view but remain stored. Saved evidence opens its immutable artifact versions; Undo never deletes execution evidence, approvals or spending records.

## Select data and run research

1. Add Knowledge/Action nodes for your question. Open **Resources** from the library icon beside the top-toolbar battery, choose **Add file** to copy a CSV into the project or link an explicitly selected absolute local path. Files must be UTF-8 CSV, no larger than 500,000 bytes. A project copy stays independent of later source changes; a linked file stays read-only.
2. Preview a resource, choose its destination and select **Use in note**. Linked files are read again at use time to capture their current version; copied files and already captured evidence retain their saved version. Selection does not start research. Resource labels distinguish linked files, project copies and captured sources/datasets, including the originating note. **Exports** and the earlier **Local files & exports** controls remain available.
3. Open project permissions, choose an approval mode, describe the scope and set the main experiment/spending limits. Additional node/data scope and request/runtime/Action limits are available in collapsible sections. New Actions inherit the project default; an Action can override its mode while sharing the same limits.
4. Continue in the project conversation, or open an Action’s research dialog for a dataset-specific session. With provider authorization, the assistant can search for sources, propose notes, write exact Python against captured data, inspect actual outputs/errors and propose revisions. Project turns retain their model-visible requests and tool actions; execution attempts retain their saved code, inputs and outputs. Manual local experiments and labelled saved-context summaries remain available without paid inference.
5. Review pending requests as required. Experiment views put approvals and saved results first; expand the exact-request and advanced sections for code, data, runtime and parameters. Note kind and per-Action permissions live under **Note settings**. Continue with a follow-up question; prior work remains saved and budgets do not reset.
6. Select an output folder in Local files and export chosen artifacts. Outputs use new filenames. Source modification requires separate connection write permission and an expected source hash; Full access cannot override a read-only source.

## Three approval modes

- **Ask every time:** review each experiment and additional Action. Creating a related Action and starting it are separate decisions in this mode.
- **Approve for me:** an independent, conservative rule reviewer checks granted nodes/data, Python operations, action relation and resource limits. Unfamiliar or out-of-scope work escalates to a person. This is an automatic policy reviewer, not a second reasoning model or a scientific-validity guarantee.
- **Full access:** no individual approval inside the explicit scope and resources. Shared limits, stop controls, isolated runtime and connection permissions still apply.

Project counters reserve experiments, external requests, created Actions, maximum runtime and spending. Failures, retries, follow-ups and new nodes retain consumed reservations. Changing modes never replenishes them. **Stop all** stops project research, active experiments and provider requests; resume is explicit. Browser closure leaves the server working. Service/laptop shutdown interrupts work; reopening never blindly repeats a paid request.

Use a project’s **… → Delete project** action to move it to local **Trash**, then **Restore** to recover it. Notes, conversations, artifacts and history remain stored. Active research and pending experiments must be stopped first; Trash is not a way to discard running work or reset its accounting.

## Actual Python boundary

Python executes inside Docker with pandas, NumPy, matplotlib and SciPy. The dedicated Code block receives `params`, `pd`, `np`, `plt`, `scipy` and output helpers; `df` exists only when a full CSV is deliberately selected. Legacy dataset experiments retain their captured `df` contract:

```python
metric("Mean", df["value"].mean())
table("Summary", df.describe().reset_index())
fig, ax = plt.subplots()
ax.plot(df["value"])
plot("Observations", fig)
export_csv("Data used", df)
```

The container has no external network, no original source/user folder mounts, read-only root/input files, non-root identity, dropped capabilities, seccomp, 512 MB memory, one CPU, process/output limits and a 30-second wall deadline. Python can access installed container files and create processes within those limits; this is not a VM per run or proof against kernel vulnerabilities. See [the precise runtime boundary](docs/python-sandbox.md). The earlier closed numerical interpreter remains an explicitly selectable compatibility backend.

## Models and spending

The library, battery and assistant ring open mutually exclusive **Resources**, **Budget & usage** and **Research assistant** panels in the same right-side space. Resources shows source/owner/date, preview, file import and exports. Explicitly related captures expand into exact versions; matching names or URLs alone never merge data.

The battery opens **Budget & usage**. It shows the project’s configured ceiling, retained reservations and remaining allowance, plus recorded provider requests for **Last hour**, **Today** or **Last 24h**. Today follows the viewer’s local midnight, including daylight-saving changes. Known cost estimates, reported tokens/search credits and unknown costs stay distinct. Nebius credit may be shown as a dated user report, with its original observation time unknown and no API verification. Tavily key/account credits and limits can refresh server-side through a one-minute cache when `ROS_TAVILY_USAGE_SYNC=1` is explicitly enabled; current live verification remains blocked by approval review. Credits are not converted to dollars. App provider allowances remain separate admission limits. See [account usage](docs/provider-account-usage.md).

Choose **Nebius Token Factory** or **OpenAI** in the assistant, note details or research dialog. The project default is Nebius with Nemotron 3 Ultra (`nvidia/Nemotron-3-Ultra-550b-a55b`, or the existing `ROS_NEBIUS_MODEL` configuration). A task inherits its nearest containing stage/group setting, then the project default. Changing a provider or model creates an override for that note; **Use inherited setting** removes it. Nebius also offers Kimi K2.7 Code. OpenAI offers GPT-5.4 mini and GPT-5.4 through direct calls with the official OpenAI SDK. No Agents SDK workflow or locally hosted model backend is used. Model selection is separate from the Python execution runtime.

Project collaboration and research planning retain application-validated JSON contracts, captured model selections and observable request/response evidence. OpenAI credential and model catalog access have been verified; no paid OpenAI inference was performed for this change. Model claims, source excerpts and actual execution outputs remain distinguishable. See [current results](RESULT.md) for verification details.

Save the OpenAI key under **Connections → Other API connections → OpenAI API**, or configure `OPENAI_API_KEY` in ignored server-side `.env.local` and restart. Set the visible USD and request allowance in that connection and explicitly enable usage. Its default allowance is $0. A configured credential or model selection alone does not grant spending permission. The alternative operator environment fields remain `ROS_OPENAI_AUTHORIZATION_ID`, `ROS_OPENAI_AUTHORIZED_USD` and `ROS_OPENAI_MAX_REQUESTS`.

Credentials stay server-side. **Connections** now lets the user explicitly enable a fresh inference/search allowance with a total USD ceiling and request ceiling, then save the separate current-project spending ceiling. The first app allowance is separate from preserved historical environment usage; subsequent edits, pauses, credentials and restarts never reset its retained counters. Once saved, an app allowance takes precedence even while paused. Operator configuration through `ROS_PAID_AUTHORIZATION_ID`, `ROS_NEBIUS_AUTHORIZED_USD`, `ROS_TAVILY_AUTHORIZED_USD` and `ROS_PAID_MAX_REQUESTS` remains an alternative before an app allowance exists. Historical allowances are not new permission, and changing a project limit alone does not authorize paid calls. Reservations remain after settlement, failure and restart; they are not an account balance or invoice. Never rotate an authorization ID/data directory to reset a grant.

The historical September 22 continuous-assistant build recorded a **US$10 combined ceiling for Nebius inference and sandbox attempts**, configured through `ROS_NEBIUS_COMBINED_AUTHORIZATION_ID` and `ROS_NEBIUS_COMBINED_AUTHORIZED_USD`. It is cumulative across projects, retries and uncertain outcomes, and preserves older grants. Tavily's separate historical cumulative ceiling retains earlier usage. Neither record authorizes new calls in this iteration. The combined grant does not establish sandbox pricing or permit a remote attempt without exact approval and its separate pricing admission. Current usage belongs in [RESULT.md](RESULT.md).

## Demonstrations and boundaries

- [AI adoption in Dutch businesses · the banking question](examples/dutch-ai-adoption/README.md): CBS evidence, two real local executions, a denominator/coverage challenge and an editable article. The book icon starts a four-stage saved-results tour. Live model refinement is unavailable under current limits; the manual fallback is labelled.
- [Amsterdam-area rainfall patterns for cycling planning](examples/demo-amsterdam/README.md): actual KNMI weather analysis and two plots. Explicit weather-only fallback; cycling counts remain unavailable.
- [When market conditions change · a historical risk baseline](examples/demo-market-risk/README.md): actual historical prices, preceding-window thresholds, exceedances and drawdown. Local research; public redistribution rights are not cleared.

- [Schiphol weather · live assistant research](examples/schiphol-live-research/README.md): preserved guided live Ultra/Tavily/Docker demonstration with exact output reuse; [September 22 verification](RESULT-continuous-2026-09-22.md) records its limitations and accounting.
- [Amsterdam cycling and weather](examples/amsterdam-cycling-weather/README.md): saved as **Amsterdam cycling & weather — evidence first**, with 366 real KNMI days, two completed local Python analyses, three plots, selected evidence reuse and a seasonal follow-up. Open **Audit the real weather data**, then **Compare seasons & trace assumptions**. Code was prepared by the coding assistant; no new app-model inference was used. Bicycle counts are missing, so no cycling association is claimed.
- [Coffee cooling](examples/coffee-cooling/README.md): earlier synthetic-data example with real local computations and preserved history.

Data lives in ignored `.ros-ai/` (SQLite and content-addressed artifacts). Stop the app before backing up the whole directory. Legacy projects, chats, histories, artifacts, selections and accounting remain intact. Captured requests explain observable provenance, not hidden reasoning or deterministic replay.

Notebook/Excel/database engines, other embedded agent runtimes, accounts, cloud sync and remote continuation remain future work. The local Codex adapter is implemented, but an actual authorized end-to-end turn remains unverified and blocked as described above. Nebius Sandboxes has a REST execution adapter, pinned Python 3.12 stdlib image, separate budget admission, cancellation and restart reconciliation. One narrowly authorized historical remote smoke is verified; beta pricing/units remain unknown for normal admission. Remote attempts always require exact approval. No deployment, purchase, public write or eligibility claim is part of this iteration.

- [Product brief](docs/product-brief.md)
- [Architecture](docs/architecture.md)
- [Data provenance](docs/amsterdam-data.md)
- [Current verification](RESULT.md)

Canonical source: `/Users/adamdong/code/ros-ai`. Compact vault packet: `/Users/adamdong/vault/13 Agent Memory/Projects/ros-ai/README.md`. Event preparation remains in the existing Inbox checklist.

## Optional public demonstration

The curated public mode is separate from your local workspace and provider credentials. See [Railway setup](docs/railway-deployment.md). It uses per-browser visitor stores, the banking tutorial and saved results only; new inference, execution and host-file access are disabled. The market dataset and figures are omitted pending redistribution permission. A prepared Docker image or local preview is not a deployed website; current deployment status belongs in [RESULT.md](RESULT.md).

## Demo entry and tutorial

The public homepage opens `/app`. The former `/waitlist` and `/waitlist/pitch` URLs redirect there; signup and count APIs are retired. Existing `waitlist.sqlite` files remain untouched on the persistent volume.

Demo projects use concise display names. The research assistant opens on the first demo visit, remembers subsequent panel choices in this browser, and has a labeled header button. Tutorial sections distinguish guidance, saved outcomes and captured evidence; opening or advancing them does not run new research. Generated stage notes use compact content-relative placement, and new notes no longer freeze space introduced by earlier expansion. Existing manual layouts remain intact; use Arrange for a deliberate new arrangement.

## Personal inference and Workspace guide · October 2, 2026

The local workspace now registers user-configured compatible HTTP model servers with private endpoint/key storage, explicit request/resource caps and a separate cumulative usage allowance. Enabled registered models appear alongside the existing built-in models, preserving project defaults and block inheritance. Remote calls require conservative declared pricing plus the project's separate budget; loopback calls consume request limits without a provider USD debit. Edits, pause, removal and restart retain previous usage. See [inference setup](docs/inference-setup.md).

**Review workspace** selects its own guide connection and captures only the chosen structure, metadata and exact evidence versions. Research chat is not forwarded automatically. Reviews disclose their destination, preserve available response/usage receipts and produce validated proposals or separately accepted input selections without scheduling downstream work. User-managed loopback processing remains unverified. Optional Nemotron weights/runtime packaging, fine-tuning and additional CLI protocols are not delivered; the existing Codex isolation gates remain. Earlier dated build/design records above retain their historical meaning.
