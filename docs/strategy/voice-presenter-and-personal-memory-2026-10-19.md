# Voice presenter and personal memory for ros.ai

19 October 2026 · Snapshot taken 19 October 2026 of the Claude Doc https://claude.ai/code/artifact/3f341eaf-c11e-43e4-8a4f-2e7c7c17e1e3, which stays the living version; edit the doc, not this file. Written for Adam in the thread "Voice and personal agent" after he asked to investigate two extension features as moats: a voice conversation that shows blocks, results, interfaces and the thinking process on the canvas while it talks, like a presenter, and a personal agent with memory of the person's preferences that can remind them and "dream" to improve. The two drawings in the doc (the presenter pipeline and the timeline to December) are described in words here.

## Summary and recommendation

Build both, after 30 October, memory first and the presenter second, as one assistant: Ros knows how you work and shows you on the map what your agents did. Nothing touches the app before the 24 October freeze; the one cheap preparation is a `cues` field in the ros-nemotron training data.

- **Ros presents.** A spoken walk-through in which each sentence carries a cue that moves the camera, points Ros's cursor, opens a result or traces a source, and the person interrupts by voice or by clicking the block they mean. The map is the stage; the record is the script; what is narrated is the model's visible plan and tool steps, never a reconstructed inner monologue. A cascade of free browser engines around any vendor's text agent, with local NVIDIA and Kokoro models as optional downloads. First use: Brief me on the waiting queue. About three weeks after token streaming, which is the prerequisite.
- **Ros remembers.** Memory built from work on the map (edits, approvals, rejections, runs), stored as Markdown the person owns, proposed with provenance under the approval mode, and served to every agent through MCP and the harness adapters. Reminders live in the waiting queue. Dreams consolidate, connect, remind and write the morning brief on the local ros-nemotron; later they distil the day's accepted and rejected proposals into the local planner. About two weeks for v1 and dreams v1.
- **Moat.** Memory creates a switching cost that accrues to ros.ai, counter-positioned against vendor memory, which cannot be portable without weakening its owner's lock-in. The presenter is a differentiator that compounds only through the stage protocol and shared walkthroughs. Dreams on a local model are a cost and privacy advantage and, over months, an asset nobody else holds. The position from the v3 direction is still not a moat; these deepen the two assets in it that compound: context every agent reads and a record people can follow.
- **Timing.** Memory v1 on 3 to 7 November, cues and Ros's cursor 10 to 14, voice out 17 to 21, voice in 24 to 28, dreams v1 on 1 to 5 December. No new paid service; the US$55 ceiling is untouched.
- **Pitch.** One clause: ros.ai remembers how you work and tells every agent, and it can walk you through what your agents did while you slept.

## Where ros.ai stands today

Both features can be assembled from primitives that already exist on `main` (read 19 October at cbaba92). The real gaps are audio, token streaming and a background scheduler; everything else is a new use of a working part.

| Primitive | What exists today | What it gives voice (V) or memory (M) |
| --- | --- | --- |
| The map with a moving camera | `Canvas.tsx:320-345` animates the viewport to a block or a region with a duration | V: the stage; camera cues need no new rendering |
| Ros bar | A floating input at the bottom of the map with a fading peek of the last reply, opening as a half sheet or full panel (`src/client/RosDock.tsx:19-43`) | V: the talk control and the live transcript live here; nothing new on the map |
| Guided demo | Seven scripted steps that add blocks, re-lay the tree and draw a highlight frame around the current block with a one-paragraph description (`src/client/DemoTour.tsx`, `src/server/demo-workflow.ts:73-74`) | V: a presenter without a voice already; the step becomes the cue |
| Agent loop with visible events | Every attempt records `thought`, `tool` and `usage` events as the model emits them (`src/server/tool-loop-agent.ts:80-111`); outside agents' calls show as turns | V: the "thinking" to narrate is the model's own visible plan and tool steps, never a reconstructed chain of thought (AGENTS.md: preserve model-visible inputs, not claims of hidden reasoning) |
| Proposals and approval modes | Agents change the map only through `ros_propose_*` tools under the project's permission choice, with provenance and undo (`src/server/agent-tools.ts:61-71`) | M: a memory entry, a reminder and a dream's suggestion are proposals like any other |
| Project memory | `ResearchMemory` per project: original question, question history, decisions, findings, hypotheses, gaps, saved as a record and fed to the model as a bounded packet (`src/server/assistant.ts:57-58, 213`) | M: the pattern for a personal layer exists; the packet just gains a second source |
| Cross-project records | `global_records` holds per-provider grants independent of any project (architecture.md, ConnectionBudgets) | M: a person-level store has a home in the database |
| Projects as plain files | Notes, code, notebooks and data are files in a folder the person chose; outside edits come back as undoable changes (README, product brief 6 October) | M: memory as Markdown files the person can open in Obsidian or edit by hand |
| MCP server for outside agents | `ros_list_projects`, `ros_read_canvas`, `ros_read_artifact` plus the propose tools, with a server instruction string every client reads (`src/server/outside-agents.ts:36-41, 108-110`) | M: the channel that serves one memory to Claude Code, Codex and any MCP client |
| Hosted Ros and the local model plan | Gateway models `ros` and `ros-deep` (`cloud/README.md`); Nemotron 3 Nano 4B as a 2.84 GB GGUF is the local target (`docs/research-local-nemotron-training-2026-09-25.md`) | M: dreams can run on the local model at no cost and without leaving the machine |

What is missing, and must be built rather than reused:

- No audio code at all: no speech recognition, synthesis or microphone handling anywhere in `src` (checked by search on 19 October).
- No streaming: the client polls every 1.5 s and model requests run with `stream:false` (roadmap item 17). A voice that narrates while it works needs token and event streaming first.
- No background work: nothing runs unless the CLI is running. Reminders and dreams need a scheduler in the server, and a rule for what happens at the next start when the app was closed.
- No personal, cross-project memory: `ResearchMemory` is per project and is about the research, not the person.

## Feature 1: Ros presents

The feature is not "talk to Ros". It is "Ros presents on the map": a spoken walk-through in which every sentence points at a block, a result or a step, and the person can interrupt by voice or by clicking the thing they mean. No voice agent has this, because none of them has a shared spatial stage. The canvas is the stage, and the record on it is the script.

### What the others do

| Product | What voice does | What it shows while talking | What is missing for this idea |
| --- | --- | --- | --- |
| [Claude Code voice dictation](https://code.claude.com/docs/en/voice-dictation) | Speech into the prompt, hold or tap a key; audio goes to Anthropic's servers; needs a claude.ai sign-in | Only the transcript in the prompt; no spoken reply | Input only; nothing is shown or pointed at |
| Codex app | Dictation into the prompt (as Adam describes; not checked today) | Nothing beyond the thread | Same |
| ChatGPT voice inside chat (November 2025, from search summaries) | A live conversation in the chat window with a transcript | Cards it generates itself: maps, images, weather | The visuals are its own answers, not the person's work; nothing to point at or interrupt into |
| Gemini Live and Copilot Vision (from memory, not checked today) | Talk while the assistant watches the screen | Nothing of its own; it describes what you show it | It looks, it does not drive; no record of what it referred to |
| NotebookLM audio and video overviews (from memory) | A narrated overview generated from sources | Generated slides | Passive playback; not interactive, not the person's canvas |
| NVIDIA voice agent blueprint (from search summaries) | Parakeet ASR, Nemotron, Magpie TTS; about 0.8 s end to end on H100s | Nothing; a reference pipeline | Shows the cascade is state of the art and NVIDIA-native; no workspace |

The pattern: everyone has speech in, a few have speech out, one shows cards. Nobody lets the agent point at the person's own work while it talks, and nobody lets the person point back.

### The design in ros.ai's terms

**A stage protocol.** Ros's reply carries small cues inline, one per sentence that refers to something: *look at* a block (the camera moves, `focusReadable` exists), *frame* a group or a set of blocks (`showBlocks` exists), *open* an exact artifact version (the viewer exists), *point* at a block (Ros's cursor moves there and the guided demo's highlight frame appears), *trace* a path from a source to a finding to a paragraph (the "click a sentence" idea from the v3 direction), *propose* (the proposal is drawn dashed on the map and waits, as today). The server validates every cue against the map the way it validates proposals: an id that does not exist is dropped, never invented. Because cues are text, any model can emit them, including the local 4B planner, and any outside agent can use them through MCP.

**Ros's cursor.** A second cursor on the map, labelled Ros, as collaborators' cursors in Figma or Google Docs. It is the presenter's pointer and the cheapest legible sign that "agents work in the open". It also works without any audio.

**Three uses, three triggers.**

1. *Brief me.* After agents worked (overnight, or during a meeting), Ros walks through the "N waiting" queue from the Ros bar: each decision with the blocks behind it, the source each finding rests on, the contradiction between two lanes, the spend. This is the v3 morning view, spoken. First use to build.
2. *Present this map.* For a colleague, a supervisor or a dean: Ros tells the story of the project from the record, question to directions to findings to the report, moving the camera as it goes. Later, a recorded walkthrough that others can play inside ros.ai.
3. *Work with me.* While Ros runs tools it narrates what it is doing and the map shows it live: the Search block filling, code output arriving. The person interrupts ("stop, why that source?") or clicks a block and says "what about this one?"; the clicked block's id travels with the utterance.

**Thinking shown honestly.** What Ros narrates is the plan and the tool steps the model actually emitted (`thought`, `tool`, `approval`, `usage` events in `src/shared/agent-runtime.ts:16`), never a reconstructed inner monologue. The Ros bar's peek becomes the live transcript; the Activity list stays the record.

**Interaction rules.** Barge-in stops speech at once, on voice or on a click. "This one" resolves to the selected block. Voice commands ("run it", "group these", "undo") reuse existing actions under the same approval rules; voice grants no new authority. Microphone off by default; a transcript always exists so nothing is lost; every cue has a keyboard and click equivalent. One Talk button in the Ros bar; mode and engine choices sit behind More, as Adam's UI rule asks.

### Architecture

A cascade (speech in, text turn, speech out) rather than a speech-to-speech model. The reason is the thesis: ros.ai runs harnesses, not models, so the turn in the middle must stay any vendor's text agent, and the cues must come out of ordinary text. A cascade adds about a second of latency, which is fine for a presenter and wrong only for a phone call.

*Drawing in the doc, "Every spoken sentence carries a cue that moves the map":* the person speaks or clicks a block → transcript plus the block meant → agent turn, any vendor's model → reply with cues, checked by ros.ai → split at each cue, one segment each → speak the segment (browser or Kokoro) and move the map (camera, cursor, open) in step; an interruption (stop, go back, this one) loops back to the person.

The person's words and the block they clicked go to any vendor's agent; the reply's cues are checked against the map, split into segments, and each segment is spoken and shown at the same moment, until the person interrupts.

| Stage | Default (free, no install) | "Keep it on my machine" option | Not recommended |
| --- | --- | --- | --- |
| Speech in | The browser's Web Speech API: zero cost, zero install; Chrome sends audio to Google, Safari to Apple, so the app says so | NVIDIA Nemotron streaming ASR (0.6B, English, cache-aware Parakeet RNNT; a 40-language 3.5 version per NeMo docs, from search summaries), downloaded and run by ros.ai like the local model | Claude Code's or Codex's dictation: tied to their sign-in, not reusable |
| The turn | The existing loops: `tool-loop-agent.ts` for Nemotron and local models, `claude-agent.ts`, Codex, outside agents over MCP | Same | A realtime speech model as the agent: one vendor, cues harder to validate, cost per minute |
| Speech out | The browser's `speechSynthesis`: instant, system voices (good on a Mac) | Kokoro-82M through kokoro-js in the browser (Apache 2.0, about 300 MB download, WebGPU; from search summaries), or NVIDIA Magpie TTS where a GPU exists | Cloud voices (ElevenLabs, OpenAI): audio leaves the machine, per-character cost, another key |
| Sync | The server splits the reply at cue boundaries into segments; the client speaks one segment at a time and fires its cue when the segment starts; an interruption cancels the rest and keeps the transcript | Same | Timing by word timestamps: more precise, engine-specific, fragile |

Prerequisite: streaming. Model requests run with `stream:false` and the client polls every 1.5 s (`src/server/inference-connections.ts:161`, roadmap item 17). A presenter that narrates while it works needs tokens and events streamed; this is two or three days and benefits everything else.

Credentials stay server-side as now. The default engines send nothing to a paid service; the app names where audio goes for the browser engines; nothing is recorded unless the person records a walkthrough.

### Risks

- Researchers at desks rarely talk to tools, and open offices make it worse. Lead with listening (Brief me, Present this map) rather than speaking; dictation is the smaller half.
- A model that points at the wrong block is worse than text. Validate ids, fall back to plain text when a cue fails, and teach the local planner the cue vocabulary in its training data rather than hoping.
- Browser recognition quality on mixed Dutch and English is uneven; the local NVIDIA model is the fix, later.
- Scope: this is about three weeks after streaming, not something to squeeze in before the freeze.

### Build path

| Step | What | Size |
| --- | --- | --- |
| 1 | Stream model tokens and agent events to the client (roadmap 17) | 2 to 3 days |
| 2 | Cues without voice: Ros's replies carry cues, the map follows as the person reads or steps through, Ros's cursor appears; reuse the guided demo's highlight | 3 to 4 days |
| 3 | Speech out with the browser's synthesis, segment sync, and Brief me on the waiting queue | 3 to 4 days |
| 4 | Speech in with the browser's recognition, barge-in, and click-to-point | 3 to 4 days |
| 5 | Optional downloads (Kokoro, Nemotron ASR), Present this map, recorded walkthroughs | later |

Step 2 alone is a visible differentiator and demo-able: a reply that walks the map as you read it.

## Feature 2: Ros remembers

Memory is table stakes in 2026: every assistant has one, and each one is a lock-in for its vendor. The ros.ai version differs in three ways. It is built from what the person does on the map (edits, approvals, rejections, runs), not from chat. It is owned as files and served to every agent, not held by one vendor. And it improves itself overnight on a local model, at no cost and without leaving the machine.

### What the others do

| Product | What it remembers | Where it lives | Reaches other agents? | Background work |
| --- | --- | --- | --- | --- |
| ChatGPT memory and Pulse (from search summaries; openai.com is unreachable from this container) | Saved memories plus chat history | OpenAI's servers | Only by copying a generated summary out | Pulse researches overnight and delivers morning cards; Pro only at launch |
| [Claude memory](https://claude.com/blog/memory) (announced 11 September 2025, Pro and Max from 23 October 2025) | "Your team's processes, client needs, project details, and priorities", kept as one editable summary | Anthropic's servers; one memory per project, incognito chats excluded | Import from other providers by pasting a summary (March 2026, from search summaries) | None stated |
| Codex memories (from search summaries) | Background summaries of idle chats, secrets redacted | `~/.codex/memories/` on one machine; opt-in, off by default, preview | No: "memories don't reach other tools or machines" | Summaries written while idle |
| Claude Code (from memory of the product, not checked today) | Instructions in CLAUDE.md; an auto-memory folder of Markdown files with an index that the agent writes itself | The project's folder under `~/.claude` | No | None |
| [gbrain](https://github.com/garrytan/gbrain) (Garry Tan, MIT, April 2026) | Explicit facts with sources, corrections and withdrawals; "durable preferences and facts can be shared across agents; transient task and harness configuration state stay local" | A Markdown repo indexed into PGLite or Postgres with pgvector | Yes: MCP over stdio or HTTP, CLI, "every major MCP client" | "The 24/7 dream cycle": cron-driven enrichment that "fixes its own citations and consolidates memory overnight"; the author reports 66 cron jobs |
| Mem0 OpenMemory MCP (from search summaries) | Whatever clients add | A local Docker container; needs an OpenAI key | Yes: Cursor, Claude Desktop, Windsurf, Cline share one store | None |
| Letta sleep-time agents (from search summaries; letta.com is unreachable) | Memory blocks of a primary agent | Letta's server | Within Letta | A second agent edits the primary's memory in the background; experimental; adds model calls |

The market is converging on three things: Markdown the person can read, MCP as the sharing channel, and a background consolidation step (dream, sleep-time, Pulse). gbrain is the closest to Adam's idea and is a memory product by the YC CEO, which matters for the application: ros.ai should not pitch "a memory layer". Its memory is a by-product of working on the map, and it can read a gbrain or OpenMemory store through MCP rather than compete with it.

### What Ros remembers, and from what

| Kind | Examples | The signal it comes from |
| --- | --- | --- |
| Taste and style | Sentence length, tone, Dutch or English, citation habits, chart palettes, which block widths and layouts the person keeps | The difference between what an agent proposed and what the person accepted or edited; rejected proposals; presentation preferences already saved outside content history |
| Working habits | Approval modes chosen, which agent for which kind of task, budgets, hours of work | The record: proposals, runs, usage rows |
| People and collaboration | "Marc wants the summary first", "the dean reviews on Fridays", "Adam reviews PRs with one paste-able command" | What the person says, External blocks (Slack, Notion), hand-off packets. Stored as *how I work with X*, never as a profile of X |
| Commitments | "Send the draft to the dean on Monday", "re-run the gap analysis when CBS publishes 2025 data" | Conversations and notes; each carries a time or an event trigger |
| Project facts | Question, decisions, findings, hypotheses, gaps | Already `ResearchMemory`; stays per project |

Three layers, so a memory is never in the wrong place:

| Layer | Lives in | Read by | Written by | Example |
| --- | --- | --- | --- | --- |
| Personal | Markdown files in the app data folder, one file per subject, plus an index under 2 KB | Ros in every project; every outside agent through MCP | Ros's proposals, the person directly | "Prefers charts in two colours, one of them grey" |
| Project | The project folder, next to the blocks (the v3 shared memory) | Every agent on that map | Agents' proposals, any member | "CBS figures only; the 2019 survey is out" |
| Organisation | The hosted service, which is the paid layer | Members by role | Admins and agents under policy | "Reports cite sources in the house style" |

### How it works

**Observe, propose, approve, serve.** At the end of a turn Ros proposes memory entries with provenance ("from your edit to the report on 18 October, which cut every sentence over 25 words"). The reply schema already carries up to eight memory entries for project memory (`src/server/assistant.ts:36`); the personal layer adds a flag and a store. The project's approval mode decides whether an entry is kept at once or asked about, as with any proposal, and every entry has undo. A Memory view in Settings is a plain list: on or off, edit, forget. Serving is a bounded packet in every Ros turn, the same way `ResearchMemory` is injected today, and to outside agents through a `ros_read_memory` tool plus one line in the MCP server's instructions, and through the harness adapters (the Agent SDK prompt for Claude Code, a generated section of AGENTS.md in the project folder for Codex). The line for users: your preferences follow you into Claude Code and Codex when they work on your map.

**Reminders.** A memory with a trigger: a date, or an event on the map (a dataset version changed, a run failed, a block idle for a week). They surface as items in the Ros bar's "N waiting" queue and in the morning brief, never as operating-system notifications, because nothing runs when the CLI is closed; what was due while the app was closed shows at the next start.

**Dreams.** A scheduled pass that reads the day's record and the current memory, and only proposes. Four steps now and one later:

1. Consolidate: merge duplicates, settle contradictions, raise the confidence of a preference seen three times, retire what has not applied for months.
2. Connect: find what the day's work touched elsewhere, such as a finding that contradicts a claim in another project, or a dataset another project could use.
3. Remind: extract commitments from the day's conversations and notes.
4. Brief: write the morning note (what happened, what waits, what Ros learned), which the presenter can speak.
5. Later, improve: distil the day's accepted and rejected proposals into examples for the local planner, and eventually a nightly LoRA adapter for ros-nemotron, versioned and revertible. This is dreaming in the machine-learning sense (replay and consolidation), and it is research: it needs an evaluation set and a drift check before it touches the default model.

Dreams run on the local ros-nemotron when it is installed, otherwise on hosted Ros within the free allowance, never on a paid key without an explicit budget. They run when the CLI is idle (say twenty minutes without input) or at a set hour, with a Dream now button for demos. Everything a dream produces is a proposal on the map or in the Memory view, with provenance; a dream never changes a block silently.

**Privacy and ownership.** Files in the person's folder, exportable, deletable with history. Memories about other people are the person's own notes and stay in the personal layer unless the person moves them to a project. Memory text is evidence, never instructions, the house rule that already applies to artifacts, and outside agents receive it labelled as the person's preferences. No telemetry, consistent with the analytics recommendation of 18 October.

### Risks

- Wrong or uncomfortable memories ("you prefer purple" when you do not). Provenance on every entry, approval before it applies, a visible confidence, and forget in one click.
- Packet bloat: a memory that grows past 2 KB costs every turn. Dreams exist to compress it.
- A 4B model dreaming badly: proposals only, a small evaluation set, and a fallback to `ros-deep`.
- Memory becomes a product of its own (gbrain, OpenMemory, operating-system memory from Apple or Microsoft). Keep ros.ai's memory a property of the workspace, and read others' stores through MCP instead of competing on retrieval.

### Build path

| Step | What | Size |
| --- | --- | --- |
| 1 | Personal packet v1: Ros proposes entries, a store in files plus the index, the Memory view, injection into every Ros turn | 3 to 4 days |
| 2 | Serve it to outside agents: MCP tool and instruction line, Agent SDK prompt, AGENTS.md section | 1 to 2 days |
| 3 | Reminders with date and event triggers in the waiting queue | 2 to 3 days |
| 4 | Dreams v1 (consolidate, remind, brief) with a scheduler, on the local or hosted model | 3 to 4 days |
| 5 | Dreams v2: connections across projects, examples and adapters for the local planner | later, research |

## How the two fit together

Together they are one thing: Ros knows how you work and shows you, on the map, what the agents did. Built apart they are two features; built in this order they are one assistant.

- Dreams write the morning brief and Brief me speaks it on the map. The first spoken thing in ros.ai is the dream's output, so both features share one surface: the waiting queue in the Ros bar.
- Memory makes the presentation personal: the language, the pace, which detail comes first, and what Marc needs when the map is presented to him. Voice feeds memory back: what the person interrupted on and asked for ("the source first, always") is a preference worth proposing.
- One stage protocol and one memory packet serve every agent. A Claude Code or Codex session on the map can read the person's preferences and present its own work through MCP. That is the pitch line "shared context across many agents from any vendor" made tangible.
- The order follows from this: memory first (it compounds from the first day and needs no audio), cues and Ros's cursor second (the presenter without a voice), voice third.

## Moats, honestly

Memory is the moat-shaped one; the presenter is the differentiator that makes the moat visible. Neither is a moat on day one, and the v3 direction's statement stands: ros.ai has a position (local, open, any vendor, enforcing), not yet a moat. These two deepen the two assets in that position that compound with use: context that every agent reads, and a record that people can follow.

| Feature | Advantage it creates | Who can copy it, and how fast | What makes it compound |
| --- | --- | --- | --- |
| Ros presents (cues, cursor, voice) | Differentiation and demo power: the only agent that points at the person's own work while it talks, and that the person can point back at | A vendor with a canvas could add it in a release; ChatGPT already shows cards while talking | Only through the stage protocol being used by outside agents, and through walkthroughs shared between people; weak network effects |
| Ros remembers (memory served to every agent) | A switching cost that accrues to ros.ai rather than to a model vendor. Counter-positioning: OpenAI or Anthropic cannot make memory portable without weakening their own lock-in; ros.ai can, because it sells no model | gbrain and OpenMemory are neutral memory stores today; Apple and Microsoft will add personal context to the operating system; none of them has the signal from work on a map (edits, approvals, rejections, runs) | Every accepted proposal adds an entry; every agent the person connects reads it; leaving ros.ai means losing the memory every agent uses |
| Dreams on a local model | Cost and privacy: nightly improvement without a bill or an upload, and a story users and judges like (the local checkpoint doing daily work) | Cloud vendors run background passes already (Pulse) at their cost and on their servers; a local-first rival such as AIPOCH could add it | The local model learns the person's work over months; versioned adapters are an asset nobody else holds |

Two honest caveats. The presenter is worth more to the YC and hackathon story than to a researcher's first week, so it should not be sold as the reason to install. And a memory feature that only stores chat preferences is generic; what is specific to ros.ai is the source of the entries (work in the open) and their destination (every agent), so those two properties must ship with v1, not later.

## Timing against 24 and 30 October

Nothing in this doc should ship before 30 October. The one pre-freeze action worth taking costs under half a day: reserve the cue vocabulary in the ros-nemotron training data, so the planner learns to point at blocks before the interface exists.

- Why nothing before: Adam's rule freezes the app on 24 October with no tool, block or prompt changes after; the foundation PRs (parallel agents, the three blocks, simple by default) are still ahead of that date; voice needs streaming, which is not in the plan; and the judge's emphasis was training on NVIDIA and Nebius with a local checkpoint, not features.
- The exception: when Nemotron 3 Ultra writes the training examples on 24 and 25 October, the planner's output gains one optional field, `cues` (look at, frame, open, point), filled only where a plan refers to blocks. Half a day of prompt and checker work, no regeneration later, and the fine-tune demo can show the planner naming the blocks it means. If M1 slips, drop it; teaching research method comes first.
- Memory needs nothing reserved: it is injected on the prompt side.
- After 30 October, five weeks for one developer with agents, in the order the timeline below shows, before the first UvA users' feedback changes it. If YC interviews fall in November, cues and memory v1 are the two things worth showing by then.
- Cost: no new paid service. The browser engines are free, dreams run on the local model, the optional downloads come later. The US$55 ceiling is untouched.

*Timeline drawn in the doc, "Both features start after the 30 October submission":*

| When | What |
| --- | --- |
| 19 October | Today |
| 24 October | App frozen |
| 24 to 25 October | Training data |
| 25 to 26 October | Train ros-nemotron |
| 26 to 27 October | Model in the app |
| 28 October | Record the video |
| 30 October | Hackathon deadline |
| 2 November | YC deadline |
| 3 to 7 November | Memory v1 and MCP serving |
| 10 to 14 November | Streaming, cues and Ros's cursor |
| 17 to 21 November | Voice out and Brief me |
| 24 to 28 November | Voice in and interruption |
| 1 to 5 December | Dreams v1 |

Everything up to 30 October is the agreed hackathon schedule; the five weeks after it are the proposed order, memory first.

## What it means for the pitch

One clause, not a feature list, in the YC answers, the a16z form and the product and market report: *ros.ai remembers how you work and tells every agent, and it can walk you through what your agents did while you slept.* The investor claim stays "the control plane for agents of any vendor": memory is the context the plane holds, the presenter is the view of it.

- Hackathon video (28 October): neither feature appears. A closing "next" line is fine only if it stays honest about what exists; the local checkpoint doing nightly work is a future claim.
- Names: "Ros remembers" and "Ros presents". Avoid "personal agent" (a crowded category: Pulse, Meta, Apple) and "voice assistant" (a phone-call expectation the cascade will not meet).

## Decisions for Adam

- [ ] Order after 30 October: memory first, then cues and Ros's cursor, then voice. Recommended: yes.
- [ ] Reserve a `cues` field in the ros-nemotron training data before the freeze. Recommended: yes if it costs under half a day; no if M1 is late.
- [ ] Speech engines: the browser's recognition and synthesis by default, Nemotron ASR and Kokoro as optional downloads later. Recommended: yes.
- [ ] Ros's cursor on the map as the presenter's pointer, with or without audio. Recommended: yes.
- [ ] Memory as Markdown files in the app data folder, personal apart from project, entries proposed under the project's approval mode. Recommended: yes.
- [ ] Dreams propose only, run on the local model by default, hosted Ros as the fallback within the free allowance. Recommended: yes.
- [ ] First spoken use: Brief me (recommended) or Present this map.

## Sources

Opened and quoted: [Claude Code voice dictation](https://code.claude.com/docs/en/voice-dictation), [gbrain README](https://github.com/garrytan/gbrain), [Claude memory announcement](https://claude.com/blog/memory), the ros-ai repository at cbaba92 (files cited inline), the v3 product direction (`research/product-direction-2026-10-16-v3.md` in the project files), the rival analysis notes (`research/rival-analysis-2026-10-06.md`), the [plan to 30 October](https://claude.ai/code/artifact/1a4bf51c-347f-458a-8572-349842425c83) and the [app foundation canvas](https://claude.ai/artifact/RGVcnyEazFEtpL4g4i79BN).

Search summaries only, because the pages could not be opened from the container the investigation ran in (treat figures as approximate): [ChatGPT voice inside chat](https://gulfnews.com/technology/openai-integrates-chatgpt-voice-into-main-chat-interface-1.500360920), [ChatGPT Pulse](https://openai.com/index/introducing-chatgpt-pulse/), [Codex memories](https://codexhandbook.com/en/guide/customization/memories-and-persistent-context/), [Nemotron ASR streaming collection](https://catalog.ngc.nvidia.com/orgs/nvidia/collections/nemotron-asr-streaming) and [NeMo featured models](https://docs.nvidia.com/nemo/speech/latest/asr/featured_models.html), [NVIDIA open speech models and the voice agent pipeline](https://perspectives.nvidia.com/nemotron-speech/task/faq/open-speech-models-proven-in-production/), [Letta sleep-time compute](https://letta.com/blog/sleep-time-compute), [Mem0 OpenMemory MCP](https://mem0.ai/blog/introducing-openmemory-mcp), [kokoro-js](https://www.npmjs.com/package/kokoro-js), [Claude memory import](https://alternativeto.net/news/2026/3/claude-s-memory-feature-lets-you-import-your-preferences-and-context-from-other-ai-providers).

From memory of the products, not checked today: Gemini Live, Copilot Vision, NotebookLM overviews, Claude Code's auto-memory folder.
