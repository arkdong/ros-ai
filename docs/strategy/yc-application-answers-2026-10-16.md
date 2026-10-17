# ros.ai YC application answers

16 October 2026 · Snapshot taken 17 October 2026 of the Claude Doc https://claude.ai/code/artifact/31b9521c-f141-4e1f-8787-0d153f1e3d51, which stays the living version; edit the doc, not this file. Second pass, written at full depth from the [product and market report](product-and-market-report-2026-10-16.md) and its direction: ros.ai is where people direct AI agents and agents do the work in the open. Internal notes: the **[Adam: …]** placeholders are founder and fundraising facts still to fill.

Every answer is ready to paste into the Winter 2027 form, in the order the form asks. Text in **[Adam: …]** is a fact only Adam can supply: his background, the video, location, legal entity, equity, YC history and batch. The state of the company is stated as the project records it: one founder, MIT licence, no users, no revenue, no installer or CI, and agent features verified mostly against stand-in services. YC partners read fast and reward plain, specific sentences backed by evidence, so each answer leads with its point and keeps only the numbers that matter. Every figure is sourced in the report.

## Founders

**Who writes code, or does other technical work on your product? Was any of it done by a non-founder? Please explain.**

I do, and I am the only founder. I wrote ros.ai with AI coding agents doing most of the typing under my direction: I set the product, the architecture and the rules, review every change in the browser, and merge it. The repository has 87 commits since 23 September 2026, 39 under my name and 48 by Claude Code sessions I directed, merged through 23 pull requests. The codebase is about 17,000 lines of TypeScript and React plus a Python sandbox image. No non-founder has written code or done other technical work on it, and I have no contractors or agency.

**Are you looking for a cofounder?**

**[Adam: confirm yes or no.]** Suggested answer: Yes, for the right person. I am looking for a technical cofounder who has shipped and maintained open-source developer tools: installers, CI, releases, cross-platform support and a community around them. That is the weakest part of ros.ai today and the part the next ninety days depend on. They would need to run agents on their own work every day, because that is who the product is for. I would rather build alone for longer than take the wrong person.

**Founder profile.** **[Adam: complete the YC profile. It is required to submit: education, work history, your role at the University of Amsterdam Faculty of Economics and Business and AISO Research, and the most impressive thing you have built.]**

## Founder Video

**Please record a one minute video introducing the founder(s).** **[Adam: record it; the file must stay under 100 MB.]** YC wants a plain video, not a produced one: who you are, what you are making, why you. A sixty-second plan, to say in your own words:

- 0 to 10 seconds. "I'm Adam Dong, founder of ros.ai. I do research at the University of Amsterdam **[Adam: adjust]**, and I run AI agents on my own research and code every day."
- 10 to 25 seconds. "Agents now do real work, but they do it in the dark: each vendor in its own window, a hidden task list, no record of which source a claim rests on. My job has become directing and deciding, and no tool is built for that across vendors."
- 25 to 45 seconds, on screen: the canvas with an agent's searches, findings with their quotes, the grouped themes and the report draft. "ros.ai is an open-source workspace on your own computer where agents from any vendor work on one map. You set the goal, the rules and the budget. They leave every step, source and decision on the map. You decide."
- 45 to 60 seconds. "I built this in four weeks with the agents it is made for, and it is MIT licensed. The first pilot I am setting up is at my own faculty **[Adam: only if true at recording time]**. I'm applying to YC to make ros.ai the place people run their agents from."

## Company

**Company name.** ros.ai

**Describe what your company does in 50 characters or less.**

Run your AI agents in the open, on one map

That is 42 characters. If a plainer line reads better to a screener, use "Open-source workspace for directing AI agents" (45) or "Direct AI agents from any vendor on one map" (43).

**Company URL, if any.** **[Adam: the ros.ai domain if it is live; otherwise leave this empty. The demo link goes in the product field below.]**

**If you have a demo, attach it below.** **[Adam: record up to three minutes.]** A script against the product as it runs today, no slides:

1. 0:00. One command in a terminal; the canvas opens on 127.0.0.1. Show the project folder: plain Markdown, Python and notebook files the person owns.
2. 0:20. Type a question with two rules and a budget: "What did Dutch firms report about AI adoption in 2024? CBS figures only. Stop at two dollars." Choose Claude Code as the agent.
3. 0:40. The agent proposes a fan-out of searches; approve it. Search blocks appear, pages are read, and Finding blocks arrive whose quotes were checked against the page. Open one Finding and show the quote and its source.
4. 1:30. Decide and group: the agent proposes themes; accept them. Show the Set aside group holding what was not used.
5. 1:50. Open a Code block, run a small calculation on a CSV in the Docker sandbox, and show the attempt history and the figure.
6. 2:15. The report draft, every claim linked to a Finding and a page. Show the Budget page with this turn's spend, and the Model page where your own Claude Code or Codex can be attached over MCP.
7. 2:45. Zoom out: the whole piece of work on one map.

A recording of a real Claude Code turn is also the first documented live run of the agent, which the project still lacks. It needs an Anthropic API key with a small allowance on the Model page; a turn reserves up to one dollar. **[Adam: approve that spend before recording.]**

**Please provide a link to the product, if any.** https://ros-ai-production.up.railway.app/app. This is a public copy of the local app with recorded content, kept so people can see the product without installing it. The product itself runs on the person's own machine from the repository at github.com/arkdong/ros-ai. **[Adam: the repository is private today. Make it public before submitting if you can, because reviewers of an open-source company will look for the code. The roadmap lists what to clean out of the history first: absolute home paths in eight files, a logo's embedded metadata, and CBS reuse terms.]**

**If login credentials are required for the link above, enter them here.** None.

**What is your company going to make? Please describe your product and what it does or will do.**

ros.ai is an open-source workspace that runs on your own computer, where you direct AI agents from any vendor and they do research, analysis and coding in the open, on one map you own.

The problem: agents now do much of the work, and they do it in the dark. Claude Code, Codex and the rest each run in their own window with a hidden task list. Nothing is shared between vendors. No record says which source or decision a claim rests on. The guardrails are filters you never see. Your job has moved from doing the work to directing it, bounding it and deciding, and no tool is built for that job across vendors.

How ros.ai works: one command serves a canvas in your browser. You write the goal, the rules and the budget on it. Agents take tasks from the map and work in their own lanes and sandboxes: Claude Code through the Agent SDK, Codex through its own app, your own agent sessions over MCP, and later Gemini CLI, OpenCode and local models. Every step lands on the map as a block with its source: a search, a page read, a finding whose quote must match the page, a calculation with its code and every attempt, a draft with each claim linked to evidence. Every tool call passes through ros.ai's own server, so one set of rules holds for every vendor: Python only in a Docker sandbox with no network, a spend cap per connection, quotes that must match the page, outward writes that ask first. When more than one agent runs, you see a queue of the decisions waiting for you, with the path behind each one. The map is the agents' task board, their shared memory, the policy that bounds them, and the record people read afterwards.

Picture it. At six in the evening you write a question, three rules and a budget. Three lanes work overnight: one on the literature, one on the data in a notebook, one on a chart. At nine the queue says four decisions are waiting. Behind it, the map shows what was done, which page each finding rests on, one contradiction between two lanes, and the spend. You decide, and the report updates.

Today it does this with one agent at a time: a Claude Code agent searches, reads, writes findings with verified quotes, groups them and drafts a report on the local canvas, with sandboxed code, spend caps and an MCP server for your own Claude Code or Codex. Next, in order: two or more agents at once with lanes and the decision queue; Task nodes with a budget and an acceptance check; experiments that keep what improves and show what was reverted; connectors to Zotero, Google Docs and GitHub in both directions.

The local app is free and MIT licensed. Organisations pay for a server that holds their shared map, one policy set for every agent, sign-on and the audit record.

**Where do you live now, and where would the company be based after YC?** **[Adam: in the form's format, for example "Amsterdam, Netherlands / Amsterdam, Netherlands" or "Amsterdam, Netherlands / San Francisco, USA".]**

**Explain your decision regarding location.**

**[Adam: your own reasons first, in a sentence or two.]** The case for Amsterdam as the base: the first users and the first buyers are European researchers and their institutions. The EU's May 2026 guidelines ask researchers to keep their prompts and outputs and ask institutions to run AI tools they govern themselves. Dutch universities stalled for a year on cloud AI over a privacy assessment. The Netherlands ranks third in the EU on public research spending per head, and a faculty deal fits under the EU tender threshold, so pilots can be signed directly. The University of Amsterdam is the proving ground I can reach in person every week, and Amsterdam has the open-source precedent investors already know: Polars raised its Series A from Accel here. The three months of the batch in the Bay Area are where the agent vendors and most open-source developer-tool companies are, which matters for the harnesses ros.ai has to support and for the first hires.

## Progress

**How far along are you?**

A working product, one founder, and no users yet.

What runs today. One command serves ros.ai in a browser on your own machine, and projects are plain Markdown, Python and notebook files in a folder you pick. A Claude Code agent, run through Anthropic's Agent SDK on your own API key, works through ten tools that can only read the project and propose: it fans out web searches, reads the pages, writes findings whose quotes must match the page word for word, groups them by theme and drafts a report, and every step lands as a block you accept or undo. Codex is connected the same way through its own app and sign-in but has not run a live turn yet. Python runs only in a Docker sandbox with no network. Spend is reserved per turn and capped per connection. An MCP server lets your own Claude Code or Codex session work on the same canvas. Credentials for Google Drive, Zotero, Notion, GitHub, Slack and Tavily are held server-side, ready for connectors.

Velocity. The repository started on 23 September 2026: 87 commits and 23 merged pull requests by 12 October, about 17,000 lines of TypeScript, built by one founder directing coding agents. I demonstrated it to the dean of the UvA Faculty of Economics and Business in the week of 12 October. **[Adam: what came of it, in one sentence.]**

What is missing, plainly. No users beyond me, and no telemetry to count any. No installer: it runs from a clone with Node 24 and Docker. No CI. The agent features were verified against stand-in services rather than long paid runs. One agent turn runs at a time, so the multi-agent map is a design on working code, not shipped software.

The next ninety days: a one-command install, CI and a public repository; two agents at once with lanes and the decision queue; 50 weekly-active installs, 25 of them researchers; three signed pilots, one UvA faculty, one non-academic team that runs several agents, one lab outside the Netherlands; and five people who set the evening's agent work in ros.ai and decide from its queue in the morning.

**How long have each of you been working on this? How much of that has been full-time? Please explain.**

I have worked on the idea since August 2026: a strategy note on AI-augmented research on 5 August, a first build plan on 31 August, and the vision that fixed the product on 7 September. The current codebase started on 23 September 2026, so about four weeks of building, with 23 pull requests merged in the ten days to 12 October. **[Adam: how much of this was full-time, and what you did alongside it, for example your role at UvA.]**

**What tech stack are you using, or planning to use, to build this product? Include AI models and AI coding tools you use.**

TypeScript end to end. The client is React 19 with React Flow for the canvas and CodeMirror 6 for code, built with Vite. The server is Express 5 on Node 24, run with tsx and bound to loopback, with records in SQLite through Node's built-in driver and zod at the API boundary. Generated Python runs in a Docker image, Python 3.12 with numpy, pandas, matplotlib and scipy, with no network and as a non-root user.

Agents and models: the Claude Agent SDK, which bundles Claude Code, on the user's own Anthropic API key; Codex through its app-server protocol with its own sign-in; an MCP server that exposes ros.ai's tools to any outside agent; OpenAI-compatible connections for other and local models, which the September prototype used to run Nemotron 3 Ultra through Nebius Token Factory; Tavily for web search. Planned: an ACP adapter so Gemini CLI and OpenCode run as lanes, an Ollama preset for local models, schema migrations, CI and an npm installer.

To build it I use Claude Code as the main coding agent, run from Claude projects, with Codex as the second; Playwright drives the browser checks. **[Adam: name the models you build with, for example Claude Opus and Sonnet.]**

**Are people using your product?** No.

**Do you have revenue?** No.

**If you are applying with the same idea as a previous batch, did anything change? If you applied with a different idea, why did you pivot and what did you learn from the last idea?**

**[Adam: leave empty if you have never applied.]** If you applied before with ros.ai: Same company, sharper idea. In September ros.ai was a single-agent research canvas with good provenance. Building it with several coding agents at once showed me that the real job is directing many agents across vendors and keeping the thread between them, so the product became the map the agents work from, with the research canvas as its first case. What I learned: a record of the work on its own is a feature any vendor can copy from a transcript; the thing people open in the morning is the product.

**If you have already participated or committed to participate in an incubator, "accelerator" or "pre-accelerator" program, please tell us about it.** **[Adam: none, unless there is one to list. A hackathon is not an accelerator and does not belong here.]**

## Idea

**Why did you pick this idea to work on? Do you have domain expertise in this area? How do you know people need what you're making?**

**[Adam: open with your own moment in one or two sentences, for example the first time you ran several agents on one piece of research and lost track of what each had read and decided.]**

I picked it because it is the problem I have every day. I do research at the University of Amsterdam's Faculty of Economics and Business **[Adam: adjust, and add AISO Research and your research and analysis background in two sentences]**, and I work the way the product assumes its users work: one person directing several AI agents on research and code. ros.ai itself was built that way, 48 of its 87 commits by agents I directed. The pain is daily and specific: each agent in its own window, context lost at every hand-off, no record of which source a result rests on, and no way to apply one rule to all of them.

How I know others have it. Surveys say the same thing from three sides. Trust: 64% of researchers name hallucination as their top concern about AI and only 22% call AI tools trustworthy (Wiley 2025, Elsevier 2025); fabricated references in PubMed Central papers rose about fourteen-fold between 2023 and early 2026. Record: only 36% of researchers recorded how they used AI, and 74% see no clarity on what to disclose (Oxford University Press 2026). Control and cost: 63% of developers rarely or never let agents run unattended and 69% run a single agent (Stack Overflow, May 2026); multi-agent runs use about 15 times the tokens of a chat (Anthropic), and a fifth of organisations say token costs already limit their use (McKinsey 2026). The rules arrived in May 2026: the EU's living guidelines ask researchers to keep prompts and outputs and ask institutions to run tools they govern. Demand shows up bottom-up anyway: Dutch universities stalled for a year on cloud AI over a privacy assessment while Radboud staff bought their own ChatGPT licences, Princeton built an AI sandbox because faculty asked for one, and more than 90% of UvA medical informatics students use ChatGPT with privacy of their input as their top concern.

What I do not yet know is whether people will open ros.ai first thing in the morning rather than an agent's own app. Nobody uses it yet, and the ninety-day targets under Progress exist to answer exactly that, starting with researchers at my own faculty. **[Adam: what the dean said in the week of 12 October, if it helps.]**

**Who are your competitors? What do you understand about your business that they don't?**

The sharpest competitors are the labs' own command centres: Claude Code Agent Teams, the Codex app inside ChatGPT, Google's Antigravity Agent Manager and VS Code Agent Sessions. They already run several agents at once and they have the users. Next are the open science agents, AIPOCH Open-Science, OpenScience and Jupyter AI 3.x: open and neutral, but chat- or notebook-shaped, with no map. Pipeline builders such as n8n, Dify and Langflow draw a fixed flow to run many times. Agent-operations tools such as Paperclip govern fleets from an org chart. Observability tools such as Langfuse and LangSmith show traces after the fact to the engineer who built the agent. Autonomous research systems, Kosmos, Google's Co-Scientist and Karpathy's autoresearch, prove the shape and sell the result, not the cockpit.

What I understand that they don't, or cannot act on:

1. Every serious multi-agent system has converged on one shape: parallel agents, one shared structured state, a human gate. Anthropic's research system, Kosmos's world model, autoresearch's program file and Agent Teams' task list are the same thing. All of them keep that state hidden, text-only and single-vendor. The product is to make it visible, shared across vendors, local and owned by the person. Once it is on a map, it is the task board, the shared memory, the policy surface and the record at once.
2. Neutrality is structural, not a feature. A lab cannot enforce a rule on a rival's agent, and will not ship a surface that makes a rival's agent a first-class citizen. ros.ai can, because every vendor's tool calls pass through its own server: one sandbox, one budget, one quote check and one approval rule for a Claude lane, a Codex lane and a local model alike.
3. The product that does the work owns the user. A record is bought after the pain; the place where the work starts is bought first. So ros.ai is where agents run from, not where they report to, and "what do you open at nine in the morning" is the test for every feature.
4. Better models make this more valuable, not less. Longer autonomous runs and more parallel agents mean more tasks set, more rules written and more decisions per person per day. Labs sell engines. ros.ai is the cockpit, and every new model or harness arrives as one more lane over MCP or ACP.
5. The buyer that must show its work is in Europe now, and wants local, open tools with its own audit record. No lab is building for a Dutch faculty's privacy assessment.

Honestly, there is no moat today. There is a position, local, open, neutral, map-shaped and enforcing, and a window before a lab opens its command centre to rivals' agents or AIPOCH adds a canvas. The plan is to be in the daily loop of people who run several agents on long work before that happens, starting with researchers.

**How do or will you make money? How much could you make?**

Open core, the pattern of n8n, Supabase and PostHog. The local app is free and MIT licensed forever. Organisations pay for the server that holds their shared map, one policy set for every agent, single sign-on, audit exports and a shared library of research programs.

| Tier | What it includes | Price | Who buys |
| --- | --- | --- | --- |
| Local app (MIT) | The whole product on your own machine, on your own model keys | Free forever | Individuals, labs, students |
| Team, hosted or single-tenant | A shared map for a group, roles, a shared program library, backups, policy defaults | $20 to 30 per seat per month, the band of Notion Business, Claude Team and Cursor Teams; 40% academic discount | Research groups, consultancy and analyst teams |
| Organisation server, self-hosted or single-tenant | SAML or SURFconext sign-on, SCIM, an audit log of agent actions, one policy set enforced on every lane, a privacy-assessment pack, support | From about EUR 15,000 a year | Faculties, institutes, legal, compliance and due-diligence teams |

A lab of 25 at $25 a seat is $7,500 a year. A faculty of 100 is $30,000, under the EUR 216,000 EU tender threshold, so a pilot can be contracted directly. Three rules keep the model healthy: we never resell model inference, so spend stays on the customer's own key and our margin does not depend on token prices; the core stays MIT and we charge for sign-on, audit and hosting rather than closing the licence; agents connect only through the vendors' sanctioned routes.

How much. The research wedge alone, bottom-up: 10.6 million researchers worldwide at $240 a seat a year is about $2.5 billion a year. EU, UK and US research is about $0.94 billion of that, the agent-active quarter of it about $0.23 billion, and 1 to 3% of those seats within three years is $2.3 to 6.8 million a year, mostly as department deals of $10,000 to 50,000. Institutions already pay for governed AI at this scale: the University of Colorado pays about $2 million a year for ChatGPT Edu and USC $3.1 million. The larger prize is agent spend beyond research. The AI agents and AI code assistants categories were each about $8 billion in 2025 and are growing 22 to 50% a year, and any team that runs Claude Code and Codex on work it must stand behind, consultancies, due-diligence, policy and legal teams, is a buyer for the organisation server from the first version that runs two agents at once. The comparable is n8n, an open canvas with paid hosting: about $40 million in annual revenue at its Series C in October 2025 and about $100 million by April 2026.

**If you had any other ideas you considered applying with, please list them.**

- The open, local review layer for agentic research: the narrow version of ros.ai, sold to universities on the EU guidelines, where every AI-assisted claim carries the page it came from and the institution keeps the audit record. It is one job of the map and the first thing a faculty would pay for.
- Autoresearch for empirical social science: a written program, a loop of search, read, analyse and draft, and a ratchet that keeps only what improves a stated metric, with a reviewer agent that has evidence tools only. Karpathy's autoresearch drew 21,000 stars in days for one metric on one GPU; nobody has built it for questions answered with data and literature.
- Git for knowledge work: agent turns as branches the person merges, with a decision ledger. I set it aside because the record is a feature of the bigger product, but it stands on its own for teams that must show their work.
- A governed AI sandbox for universities: the vetted environment Princeton built for itself, as a product for research IT, with local models, a privacy-assessment pack and per-site network approval. Institutions already pay two to three million dollars a year for less.
- **[Adam: anything unrelated you would also want YC to see.]**

## Equity

| Question | Answer |
| --- | --- |
| Have you formed ANY legal entity yet? | **[Adam: yes or no; if yes, the country and type, for example a Dutch BV.]** |
| Planned equity ownership breakdown | **[Adam.]** If no entity exists: Adam Dong, founder and CEO, 100%, with an option pool of 10 to 15% planned for the first hires, the first of them packaging, CI and platforms. |
| Have you taken any investment yet? | **[Adam: yes or no.]** |
| Are you currently fundraising? | **[Adam: yes or no.]** If yes, the report frames it as a pre-seed round to fund the ninety-day proof and a first hire. |

## Curious

**What convinced you to apply to Y Combinator? Did someone encourage you to apply? Have you been to any YC events?** **[Adam: your own answer. Name the person if someone encouraged you, and any YC event you attended.]**

**How did you hear about Y Combinator?** **[Adam.]**

## Batch Preference

**What batch do you want to apply for?** **[Adam: Winter 2027, or a batch after it.]**

## Before you submit

- [ ] Complete the founder profile; the form refuses to submit without it.
- [ ] Record the one-minute founder video and the three-minute demo.
- [ ] Fill every placeholder: search the form text for "[Adam".
- [ ] Decide on making the repository public, and clean the history first if so.
- [ ] Keep the one-liner at 50 characters or fewer after any edit.
- [ ] If the demo is recorded against a real Claude Code turn, keep the dated record of that run in the project.
