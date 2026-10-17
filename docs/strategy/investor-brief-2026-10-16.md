# ros.ai investor brief

16 October 2026 · Snapshot taken 17 October 2026 of the Claude Doc https://claude.ai/code/artifact/70a94500-0bb1-4c94-927a-edc5b4ecb04f, which stays the living version; edit the doc, not this file. Short form of the [product and market report](product-and-market-report-2026-10-16.md). The two drawings live in the doc and are described in text here.

ros.ai is an open-source workspace on your own computer where you direct AI agents from any vendor. They do research, analysis and coding in the open, on one map you can see.

| At a glance | |
| --- | --- |
| In one line | Run your agents in the open. |
| Stage | Working product under the MIT licence, one founder, no users yet; 23 pull requests merged in three weeks |
| Business model | Free local app; paid team tier and organisation server for the shared map, one rule set, sign-on and audit |
| First market | Researchers and analysts, Europe first; then teams that run agents on client work |
| The ask | Pre-seed round to prove demand in 90 days; amount and terms to be discussed |

## The problem

Agents now do real work, and they do it in the dark. Each vendor's agents run in their own window with a hidden task list, nothing shared across vendors, and no record of which source a claim rests on. The person's job has moved from doing the work to directing and checking it, and no tool is built for that job across vendors.

- **Trust.** 64% of researchers name hallucination as their top AI concern ([Wiley, 2025](https://newsroom.wiley.com/press-releases/press-release-details/2025/AI-Adoption-Jumps-to-84-Among-Researchers-as-Expectations-Undergo-Significant-Reality-Check/default.aspx)). Fabricated references in PubMed Central papers rose about 14-fold between 2023 and early 2026 ([Lancet study](https://the-decoder.com/ai-hallucinated-citations-are-creeping-into-papers-that-shape-clinical-guidelines-researchers-warn/)).
- **Control.** 63% of developers rarely or never let agents run unattended ([Stack Overflow, May 2026](https://stackoverflow.blog/2026/05/27/agents-on-a-leash-agentic-ai-remains-mostly-monitored-at-work)). Guardrails are hidden vendor filters, and none spans vendors.
- **Cost.** Multi-agent runs use about 15 times the tokens of a chat ([Anthropic, 2025](https://www.anthropic.com/engineering/multi-agent-research-system)), and spend per agent is invisible.
- **Record.** Only 36% of researchers recorded how they used AI, and 74% see no clarity on what to disclose ([OUP, 2026](https://www.timeshighereducation.com/node/744922)). What was done, from which sources, decided by whom, exists nowhere a reviewer can read.

Researchers and analysts feel this first: they already run agents on work that lasts days, and their organisations must stand behind the result.

## The product

ros.ai is one map that agents work from and people direct. The map is the task board agents take work from, the shared memory every agent reads, the rules that bound them, and the record people read afterwards.

*Figure 1 (drawing in the doc): One map, any vendor's agents, one set of checks on every call. The person and the organisation on the left, the map with its four jobs in the centre, agents of any vendor on the right, and the checks every call passes between them.*

The person sets the work and decides. Agents claim tasks and write to the map, and every call passes the same checks, whatever the vendor. Today one agent works the map at a time; the next build runs several.

**What works today.** One command starts the workspace in your browser, on your own machine. A Claude Code agent searches the web, reads pages, writes findings whose quotes must match the page word for word, groups them and drafts a report. Every step lands on the map to accept or undo. Code runs in a Docker sandbox, spend is capped per model connection, and projects are plain files you own. Your own Claude Code or Codex can work on the same map through an MCP server.

**What comes next.** Several agents at once in their own lanes, with one queue of the decisions that need you. The test we build toward: at 6pm you set a question, three rules and a budget. At 9am the queue shows four decisions waiting, every finding traced to its source, and the spend per lane.

## Why now

Four things changed in the past year.

1. **The standards settled.** MCP moved to the Linux Foundation in December 2025 with more than 10,000 public servers ([Anthropic](https://anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation)). Any agent can plug in.
2. **Every lab shipped a command centre for its own agents.** The Codex app, Claude Code Agent Teams and Google Antigravity all run several agents at once, each single-vendor, each with its state hidden.
3. **Cost became the limit.** About 20% of organisations say token and operating costs constrain their AI use ([McKinsey, 2026](https://www.mckinsey.com/capabilities/quantumblack/our-insights/the-state-of-ai)).
4. **The rules arrived.** The EU's May 2026 guidelines ask researchers to keep prompts and outputs, and institutions to run AI tools they govern themselves ([European Commission](https://research-and-innovation.ec.europa.eu/document/download/2b6cf7e5-36ac-41cb-aab5-0d32050143dc_en)).

## The market

Research is the way in; the market is agent spend. Analysts put AI agents at about $7.6B in 2025, growing 46–50% a year, and AI code assistants at about $8.1B ([Grand View](https://www.grandviewresearch.com/industry-analysis/ai-agents-market-report); [MarketsandMarkets](https://www.marketsandmarkets.com/Market-Reports/ai-code-assistants-market-53503659.html)). Their forecasts differ by up to 3.5x, so they are anchors, not facts.

Our own bottom-up estimate for the first market, researchers:

| Layer | Basis | Size a year |
| --- | --- | --- |
| TAM | 10.6M researchers worldwide ([UNESCO](https://www.unesco.org/reports/science/2021/sites/default/files/medias/files/2022/01/Facts%20and%20figures%20from%20the%20UNESCO%20Science%20Report%202021.pdf)'s 8.85M in 2018, extrapolated) at $240 a seat | about $2.5B |
| SAM | EU, UK and US research: 1.89M EU researchers plus an assumed 2.0M in the US and UK | about $0.94B |
| SOM, three years | 1–3% of agent-using seats in the SAM | $2.3–6.8M |

Research is the design-partner market, not the revenue plan. Revenue comes from teams that run agents on client work, where the agent and code-assistant categories are about ten times the size of research-tool budgets. Developers who run several agents and knowledge workers inside agent tools are a further pool, counted as upside because no sourced count exists for them.

**Europe first.** EU R&D spending was EUR 403bn in 2024 ([Eurostat](https://ec.europa.eu/eurostat/web/products-eurostat-news/w/ddn-20251204-2)). Dutch universities stalled for a year on cloud AI over privacy reviews ([Privacy Company](https://www.privacycompany.eu/blog/update-dpia-on-microsoft-365-copilot-for-education)). A faculty deal fits under the EUR 216,000 EU tender threshold ([Cuatrecasas](https://www.cuatrecasas.com/en/global/public-law/art/new-eu-public-contract-thresholds-2026-2027)), so a pilot can be signed without a public tender.

## Business model

The app is free and open forever; organisations pay for the shared server. This is the pattern n8n, Supabase and GitLab grew on: a free self-hosted core and a paid organisation layer.

| Tier | What you get | Price | Who buys |
| --- | --- | --- | --- |
| Local app (MIT) | The whole product on your own machine, with your own model keys | Free | Individuals, labs, students |
| Team | A shared map for a group, roles, shared templates, backups | $20–30 per seat per month; 40% academic discount | Research groups, analyst and consulting teams |
| Organisation server | Single sign-on, an audit log of agent actions, one rule set for every agent, privacy paperwork, support; self-hosted or single-tenant | From about EUR 15,000 a year | Faculties, institutes, legal, compliance and due-diligence teams |

A lab of 25 at $25 a seat is $7,500 a year. A faculty of 100 is $30,000 a year, small enough to sign without a public tender.

**Three rules keep the model healthy.**

1. No resold AI usage. Customers pay their model provider directly, so our margin does not depend on token prices.
2. The core stays MIT. We charge for sign-on, audit and hosting, not by closing the licence.
3. Agents connect only through the vendors' approved routes, such as an API key.

**The comparable.** n8n, an open canvas with paid hosting, went from about $40M to about $100M in annual revenue between October 2025 and April 2026. Roughly 55% came from cloud and 30% from self-hosted licences ([Sacra](https://sacra.com/c/n8n/)). Only 0.5–3% of open-source users typically pay ([Monetizely](https://www.getmonetizely.com/articles/whats-the-optimal-conversion-rate-from-free-to-paid-in-open-source-saas)), so the plan counts department deals of $10,000–50,000 a year, not individual subscriptions.

**Go-to-market.** Free installs through student and researcher workshops first, then paid department pilots. Then teams outside academia that already run agents on client work: consultancies, due-diligence, policy, legal and compliance teams. That third group can buy the organisation server from the first version that runs two agents at once.

## Competition

No product today runs any vendor's agents on a map the person can see and steer. The labs have the users but keep the work hidden and single-vendor. The open tools are neutral but have no map. Pipeline builders draw fixed flows that run many times, not one piece of open-ended work.

*Figure 2 (positioning map in the doc): Nobody runs any vendor's agents on a map the person sees. One vendor's agents to any vendor's agents across; hidden state to shared state on a map upwards. The labs sit bottom-left, the open tools bottom-right, n8n and Dify top-right as fixed pipelines, ros.ai today a little above them and the ros.ai direction in the corner.*

Placements are our reading of public sources, not measurements. The biggest threat is the labs' own command centres: they already run agents in parallel, and a visible map could be one release away. Among open tools, AIPOCH adding a canvas is the move to watch.

**What we understand that they don't.**

- **Neutrality is structural.** A lab cannot enforce a rule on a rival's agent. ros.ai can, because every vendor's calls pass through its own server. That is where the calls meet.
- **The shared state must be visible.** Every serious multi-agent system converges on parallel agents, one shared state and a human gate. The labs keep that state in a hidden folder. On a map the person sees, it becomes the task board, the memory, the rules and the record at once.
- **Better models make this more valuable.** As agents run longer alone, the person's work moves from doing to directing and deciding. Labs sell engines; ros.ai is the cockpit, and every new model arrives as one more lane.

**The honest statement.** There is no moat today. There is a position and a window. The position: local, open, neutral, map-shaped, enforcing; each rival has at most three of those five. The window: before a lab opens its command centre to rivals' agents and draws the task list as a map. Our answer is to be in the daily routine of people who run several agents on long work before that happens, starting with researchers. What compounds with use: a team's map of decisions, rules and sources, its library of research programs, and the organisation's rule set and audit log. A rival starts at zero with every team.

## Where we are, and the next 90 days

A working product, one founder, no users yet. We say so plainly because the next 90 days are about proving demand.

**Built.** The local app, MIT licensed: 23 pull requests merged between 23 September and 12 October 2026 by one founder working with AI agents. Demonstrated to the dean of the University of Amsterdam's Faculty of Economics and Business in the week of 12 October 2026; a faculty pilot is proposed, not yet committed.

**Missing.** The repository is private today, with no installer, no CI and no users beyond the founder. Claude Code was last verified against a stand-in service on 7 October; Codex is wired in but has not been run yet.

**Founder.** Adam Dong, sole founder. He builds ros.ai the way its users will work: one person directing several agents. [Adam: one line on your background and your position at UvA.]

**The 90-day plan.**

| Goal | Target |
| --- | --- |
| Ship a one-command install | Public repository, CI and releases |
| Prove usage | 50 weekly-active installs, 25 of them researchers |
| Prove the core habit | Five users who set agent work in the evening and decide from the queue in the morning |
| Prove love | 40% "very disappointed" on the Sean Ellis survey at day 90 |
| Prove buyers | Three signed pilots: one University of Amsterdam faculty, one non-academic team, one lab abroad; two letters of intent |
| Ship the next build | Two agents at once, with lanes and the queue |

**The ask.** A pre-seed round to fund this 90-day proof: the one-command install with CI and releases, the two-agent build, three pilots, and a first hire for packaging and platforms. Amount and terms to be discussed.
