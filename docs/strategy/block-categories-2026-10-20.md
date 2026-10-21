# ros.ai block categories

20 October 2026 · Snapshot taken 20 October 2026 of the Claude Doc https://claude.ai/code/artifact/bd6050a0-d430-4a31-9f48-5b4ca5530f6a, which stays the living version; edit the doc, not this file. Adam's decisions the same day: option B, the label set as proposed, the Search block folds into the Agent block now (before the 24 October training snapshot), and this snapshot is filed.

## Summary

Drop the Knowledge / Action split and give ros.ai seven block kinds named for how you work with them, plus Group: Text, Code, Notebook, Data, File, External, Agent. Meaning (question, plan, result, finding, decision, report) becomes a label on a Text block, provenance becomes a line on every block, and the Agent is the only doer, so Search blocks fold into it.

- Run-role categories (n8n, ComfyUI, Langflow) only pay off when links execute. ros.ai's never do, and the canvases that are records (Obsidian, Heptabase, Notion, Miro) categorise by what the thing is.
- Today's split already fails its own test: Code, Notebook, Dataset and Report are created as Knowledge, and the agents never hear the words Knowledge or Action.
- Nothing in the layer ros-nemotron is trained on changes before 30 October. Aliases at the tool boundary translate the new names for as long as that model is served.

## What the app had on 20 October

Every block carried two kinds, and Knowledge / Action was only the upper one. The lower one, the block type, is what the card, the opened view, the file on disk and the agents' tools actually follow.

| Layer | Values | Where it shows |
| --- | --- | --- |
| `kind` | topic (shown as Knowledge), activity (shown as Action), group | The first choice in the Add block dialog ("What you study" / "What you do"), the Inspector's Kind select, the card's kind icon |
| `blockType` | note, action, dataset, figure, code, notebook, report, agent, search, finding | The card face and label, the opened view, the file (.md, .py, .ipynb, .csv; outputs/ for figures and tables), the `kind` and `blockType` fields of `ros_read_canvas` |

| Block type | Kind | What it is | Who makes it |
| --- | --- | --- | --- |
| Note | Knowledge | Markdown text; also the Result note of each search direction | You, or an agent |
| Action | Action | The older node: a note with a model run and selected inputs | You |
| Dataset | Knowledge | A CSV or table with a viewer | Import, or a code run |
| Figure | Knowledge | A plot or image from a run | A code run |
| Code | Knowledge | A Python script run in the sandbox, attempts kept | You, or an agent |
| Notebook | Knowledge | An .ipynb with its own kernel | You, or an imported file |
| Report | Knowledge | Markdown with immutable revisions tied to evidence | `ros_propose_report` |
| Agent | Action | One Claude Code, Codex or model turn: goal, status, timeline of steps | `ros_fan_out_search` |
| Search | Action | One search direction: queries, hits, cost, Search again | `ros_fan_out_search` |
| Finding | Knowledge | One claim with a word-for-word quote and its source | `ros_write_findings` |

Three things to notice: Code, Notebook, Dataset and Report were all created as Knowledge, so the split failed its own definition ("Knowledge holds what is studied; Action holds what is done"). The agents never heard the words Knowledge or Action: the shared instructions frozen for ros-nemotron describe the project as "a canvas of blocks (notes, code, notebooks, datasets, figures, reports)". And links were already labels only: AGENTS.md rules that connections never schedule, block or import inputs, so rerun and run-from-start can be dropped without losing anything.

## Why Knowledge / Action chafed

The split answers a question the product no longer asks: which blocks run.

1. **Knowledge constrains what you can put in.** Knowledge was defined as content with provenance and given fixed roles (question, result, finding, source, dataset, figure, report). In practice everything you write is a Note, and the roles that survived became block types with their own rules: a Finding must carry a quote ros.ai can verify, a Report must cite exact evidence versions, a Result note can only be filled by the search that made it. Those rules are good tool behaviour and bad categories. A plan, a to-do list, a hypothesis, a decision, a meeting note or a pasted email are all just text.
2. **Action contradicts Agent.** Action was "one tool call and what it produced" (Search, Read, Write). Since 8 October the Agent block records exactly those calls as steps in its timeline, so the Search block repeated the agent's step on the canvas (7 directions gave 7 Search cards plus 7 Result cards), and the older Action node was a third way of doing something, beside Code.
3. **Rerun and run-from-start no longer matter.** The Action family carried pipeline thinking: inputs, run log, cost, Search again, retries. No tool runs a chain of blocks, and AGENTS.md forbids links from scheduling anything. What was valuable in Action is the record (what ran, what it cost, what it made), and the Agent block plus a provenance line on each block keep that record without a category.

What the split got right, and survives: provenance on every block, the agent's visible loop, quote-checked findings, immutable report revisions, and Groups as the only containers. All five are behaviours of tools and metadata, not categories of block.

## What comparable products do

Products whose graph executes categorise nodes by their role in the run. Products whose canvas is a record categorise by what the thing is, and let AI act on content instead of being a node kind. ros.ai belongs to the second group, with one addition the others lack: an agent that works on the canvas as a visible participant.

| Product | A node is | Categories | Graph runs? | Lesson for ros.ai |
| --- | --- | --- | --- | --- |
| n8n | A step in an automation | By role in the run: a trigger first, then "what happens next" (action in an app, data transformation, flow, core, AI, human in the loop) | Yes, every link executes | Run-role categories only pay off when links execute. ros.ai's never will |
| ComfyUI | A function with typed sockets (MODEL, CLIP, LATENT, IMAGE) | By pipeline stage: loaders, conditioning, sampling, latent, image, mask, utils | Yes | Typed ports make a compiler, not a workspace |
| Langflow | A component with inputs, outputs and parameters | By component type: inputs and outputs, prompts, models, agents, tools, data, processing, logic, vector stores, embeddings, memory; vendor bundles | Yes | Making models, tools and agents separate kinds multiplies kinds. In ros.ai the model and the tools live inside the Agent block |
| tldraw computer | A card holding one media type (text, image, speech, website) or an Instruction card that does the AI work | By media type, plus one doer | Yes, Run propagates | Closest to "content kinds plus one doer", but still a run-graph |
| Flora | A Text, Image or Video block; the model is a setting inside it | By media type | Yes, chains | Three kinds suffice when the model is a setting, not a node |
| Obsidian Canvas, JSON Canvas | text, file, link or group | By what the thing is | No, a record | The file system already types files, so a canvas needs four kinds. ros.ai already writes a .canvas file |
| Heptabase | A card (note, journal, highlight) or a file card (PDF, image, audio, video) on a whiteboard with sections | By what the thing is; tags act as databases with properties | No | Properties and tags carry meaning, not more kinds |
| Notion | One block model; the type is chosen with "/" after you start writing | By content, chosen after the content exists | No | Pick the type after the content exists, never before |
| Miro | Sticky notes, text, shapes, docs, tables, frames; Intelligent Canvas AI acts on selected content; Sidekicks read the board | By what the thing is; AI is a participant | No | Frames are groups; the AI is a participant, not a node kind |
| Google Antigravity | Agents produce Artifacts (task lists, plans, screenshots, browser recordings) that you comment on | Agents in a manager; outputs are ordinary reviewable things | Not a graph | The agent is the only doer; its outputs are plain blocks you review |

Placed on two axes (kinds named by role in a run versus by what the thing is; the graph runs versus the canvas is a record), the run-graphs fill the top half, the record-keeping workspaces the bottom right, and ros.ai of 20 October sat alone in the bottom left: a record with run-role kinds. The proposal moves it to the bottom right.

## Options compared

- **A. Five kinds: JSON Canvas plus Agent.** Text, File, External, Agent, Group. Code, notebooks, data and images are all Files, typed by extension. The fewest words and a one-to-one map to the .canvas file, but File is the wrong word for the thing people write and run most.
- **B. Seven kinds named for how you work with them.** Text (write), Code and Notebook (run), Data (tabulate), File (keep), External (reach), Agent (who works), plus Group (where). Meaning becomes a label, provenance a line, the Agent the only doer. Keeps the approved Text / External / Visualization design, with Visualization as a Code block whose face is its chart. **Chosen by Adam on 20 October.**
- **C. One block.** A single block whose body holds parts, like a Notion page; agents are a presence on the map rather than blocks. The most minimal menu and the biggest rebuild. The direction Text blocks grow in later, not the next step.
- **D. By who made it.** Yours, from agents, from outside. Origin changes nothing about how you work with a block; it belongs in the provenance line and in a filter.

| | A. Five kinds | B. Seven kinds | C. One block | D. By origin |
| --- | --- | --- | --- | --- |
| Kinds to learn | 5 | 7 | 1, plus parts | 3 |
| One doer | Yes | Yes | Agents are not on the map | No, mixed |
| Add block | Flat list, but Code and Notebook still needed | One flat list; drop or paste decides | One button | Three lists |
| Fits the approved Text / External / Visualization design | Partly | Yes | No | No |
| Migration | dataset, figure, code, notebook become file | note, action, result, finding, report become text with labels; dataset becomes data; figure becomes file; notion becomes external; search folds into agent | Everything | Relabel only |
| Frozen tools keep working | With aliases | With aliases | Hard, the targets change | Yes |
| .canvas interop | One to one | One to one | Text only | Not affected |

## Recommendation: seven kinds, labels and a provenance line

A block is categorised by how you work with it, never by its role in a run. Meaning is a label. Provenance is a line. The Agent is the only doer.

| Kind | Holds | Card face | On disk | Replaces |
| --- | --- | --- | --- | --- |
| Text | Markdown of any length, with an optional label | First lines, label pill above the title | notes/*.md | Note, the old Action, Result, Finding, Report |
| Code | A Python script run in the sandbox, attempts kept; a chart script shows its figure as the face (the approved Visualization block) | Source, or the newest figure | code/*.py, outputs/ | Code, Figure made by a run |
| Notebook | An .ipynb with its own kernel | First cells | notebooks/*.ipynb | Notebook |
| Data | A table (CSV, Parquet, JSON rows) with the table viewer; the input of Code | Column heads and rows | data/* | Dataset |
| File | Anything else kept in the project: PDF, image, slides, audio | Preview by media type | files/* | Imported Figure |
| External | Something that lives elsewhere, reached through a plugin: a web page (address plus captured text), a Notion page or database (the live table), a Google Doc, a GitHub pull request, an Overleaf project. Writes go through the plugin and wait for Accept | The richest view the plugin gives: live rows, captured text, last-synced document | external/*.md with the address and view settings | Source, the Notion block, the Connector idea |
| Agent | Someone working: a Ros, Claude Code, Codex or API-model turn with goal, status, steps (searches, pages read, app calls, runs) and cost | Goal, status, latest step | agents/*.md timeline | Agent, Search |
| Group | A frame holding blocks and groups | Title, count, highlights | A folder | Group |

- **Labels.** One optional label per Text block, from a suggested set (question, plan, task, result, finding, decision, draft, report) or your own word. A label can carry a rule enforced by the tool that writes it: a finding needs a quote ros.ai verified, a report keeps immutable revisions tied to evidence, a result is filled once by the search that made it. Labels show as the pill above the title, filter the sidebar and go into the file's front matter.
- **Provenance line.** Every block gets a quiet footer: who made it (you, or an Agent and its step), when, and from what (the search queries and source count, the page address, the run and its cost). Clicking it opens that step in the Agent view. This is where the Search block's queries, hit count and cost go.
- **Agent, the only doer.** The fan-out draws the Agent and one Result Text per direction, with no Search cards, so 7 directions give 8 cards instead of 15. Steps that produce nothing stay in the timeline. Sub-agents are Agent blocks linked to their lead. Running a Code block yourself is not an agent: running code is you.
- **Add block.** One flat list: Text (the default), Code, Notebook, Data, File, External, Agent, Group. External and Agent open one more step (which app, which agent). Pasting an address makes an External block; dropping a .csv makes Data, a .py Code, an .ipynb Notebook, a PDF or image File; typing makes Text. The Knowledge / Action choice and the Inspector's Kind select go.
- **Links between blocks.** Unchanged: a free label, a direction, an optional caption from the agent, and the agent's own links stay quiet.
- **Naming.** External rather than Link, because ros.ai already calls the edges links, and rather than App, because a web page is not an app. Text rather than Note and Data rather than Dataset, to match what they hold.
- **On disk and in code.** The folders stay (notes/, code/, notebooks/, data/, outputs/), figures/ widens to files/, and external/ and agents/ are new. The registry the foundation design asked for becomes src/blocks/<kind>/ with eight folders, External holding one provider folder per plugin. The .canvas file maps one to one: Text to text, Code, Notebook, Data, File and Agent to file, External to link, Group to group.
- **What this does not change.** Groups as the only container, quote-checked findings, immutable report revisions, approval modes, the per-block chats, and the rule that a link never schedules anything.

## Training-snapshot compatibility

Nothing in the layer ros-nemotron is trained on has to change for this redesign. The 24 October snapshot freezes the tool names and argument schemas in agent-tools.ts, the `kind` and `blockType` enums inside ros_propose_canvas's addNode, the shared instructions in agent-prompt.ts, the fields ros_read_canvas returns, and the wording of the tool descriptions.

| Frozen surface | What the redesign changes | Why it keeps working |
| --- | --- | --- |
| Tool names and arguments | Nothing | Nothing to do |
| addNode `kind` | The field means nothing once the split goes | Accepted and ignored on input; on output ros_read_canvas keeps answering group, activity (Agent blocks) and topic as the training data shows |
| addNode `blockType` | New stored kinds text, data, file, external (after 30 October) | Permanent aliases at the boundary: note and action become Text, dataset becomes Data, figure becomes File, report becomes Text labelled report; on output the old words come back |
| Shared instructions text | Nothing | It already speaks of notes, code, notebooks, datasets, figures and reports |
| What the fan-out creates | Search blocks fold into the Agent and the Result's provenance line (done 20 October, before the snapshot) | The research tools address directions by number and Result notes by ID, never Search blocks |
| Tool description wording | The two "Search block" sentences corrected on 20 October | Before the snapshot, so the training data records the new behaviour |
| Files Claude Code reads in the project folder | files/, external/ and agents/ are new later | The frozen text names .md, .py, .ipynb and .csv, which stay true |

Timing: UI-only changes are safe at any time; no change to agent-tools.ts, agent-prompt.ts or what the tools create between 24 and 30 October; the storage rename after 30 October behind the alias layer, which stays as long as ros-nemotron is served with the frozen vocabulary.

## Build order

1. Search folds into Agent: the fan-out creates the Agent block and one Result note per direction, the searches run on the Result note, and the direction's reason is the caption of the agent's link (before the 24 October snapshot).
2. The vocabulary on screen: the Add block list, label pills, no Knowledge / Action, no Kind select.
3. Text with labels absorbing Note, Action, Result, Finding and Report.
4. External generalising the Notion block, web page first.
5. The provenance line on every block.
6. After 30 October: the storage rename, the files/, external/ and agents/ folders, the src/blocks/<kind>/ registry and the .canvas mapping.

## The More section · October 21, 2026

Before the vocabulary PR went up, Adam asked whether the block view's More section (Move to, Label, Approval, Decisions) still fits the direction. Decision: remove it. What still matters moves out of it.

- **Move to.** A block joins an expanded Group when dropped on it and leaves when dragged out; the Group under the pointer is outlined while dragging. Ungroup is a dock action for a selected Group. Ros keeps proposing groups.
- **Label.** The pill beside the kind on the card opens the label menu: the eight words, your own word, or none. Add block keeps its Label field.
- **Approval.** The per-block override is gone from the app; the project permission mode in the Ros bar is the only setting. Code runs and notebooks still honour overrides saved earlier, and the agent loop never read them.
- **Decisions.** A decision is a Text block labelled decision, linked to the blocks it rests on and visible to every agent. Saved decision logs convert once into such blocks, keeping text, reason, basis versions and withdrawals in the block text. The report's process record lists decision blocks with who wrote them.
- **Remove node and Inputs.** Delete is in the dock; inputs stay with the Code block that runs them.
