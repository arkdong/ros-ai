# ros.ai business model: open core

22 October 2026 · Snapshot taken 22 October 2026 of the Claude Doc https://claude.ai/artifact/7xPGswbPJWFt7xhXySmTBR, which stays the living version; edit the doc, not this file. Written for Adam in the thread "Business model and open source" after he asked whether to keep the app open and local with a free tier and Pro, Max, Team and Enterprise subscriptions like Claude Code and Codex, instead of open source.

**Decided by Adam on 22 October 2026: open core.** The local app stays MIT. The hosted layer (sign-in, gateway, usage ledger, later the shared workspace and the organisation server) is proprietary and sells Free, Pro, Team and Enterprise, with Max later.

## The short answer

Keep the ladder, Free, Pro, Max, Team and Enterprise, and keep the local app open under MIT. Those are two separate decisions, and the comparables show it: GitLab, n8n, Supabase, PostHog, Zed and Codex CLI all sell that ladder on top of an open core. What people pay for in every one of them is what the company runs for them, a hosted model, sync, a shared workspace, an organisation server. Nobody pays for the code on the laptop.

Closing the source would cost the hackathon entry, the "open" claims in every pitch document, and the only distribution a solo founder with no users and no marketing budget can afford. It would protect nothing that earns money, because the code is not the moat; the shared context a team builds up is.

One change before the repo goes public on 26 October: take the `cloud` folder (sign-in, gateway, usage ledger) out of the MIT tree, so the paid layer is yours from day one. That is the open-core pattern, and it is the whole difference between "open source" and "a business".

## What was proposed, and what the analogy really says

The proposal: the app stays local and free for individuals, with Pro, Max, Team and Enterprise subscriptions like Claude Code and Codex, and the source stays closed. The first half is right. The second half does not follow from the examples.

| Product | Source | What the subscription buys |
| --- | --- | --- |
| Claude Code | Proprietary; the source leaked through a source map on 31 March 2026 and was never released | Tokens of a frontier model: Pro $20, Max $100 to $200 a month. The CLI itself is free |
| Codex CLI | Open source, Apache 2.0, on GitHub | The same: ChatGPT Plus, Pro, Team, Enterprise pay for the model, not for the CLI |
| Zed | Open source editor, about 87k stars, $32M Series B from Sequoia | Pro $10 and Business $30 a month for hosted AI; own keys are free |
| Cursor | Closed | Bundled inference: Plus $8 to Ultra $200, Teams from $30 a seat; loses money on individual accounts |
| Obsidian | Closed local app, free for personal use | Sync $4 to $5 a month, commercial licence $50 a year; raised Sync prices 35% in June 2026 because costs outran revenue |

In every row the money comes from something the company runs: a model, a sync service, a hosted workspace. Open or closed source changes who can read the laptop code, not who pays. ros.ai does not own a frontier model, so the analogy with Claude Code gives the ladder, and leaves open what ros.ai puts in each rung that a person cannot get by running the MIT app with their own keys.

## The options

| Option | What it means for ros.ai | Who does it | What it protects |
| --- | --- | --- | --- |
| 1. Everything MIT (the plan before this decision) | The whole repo, including `cloud`, is public under MIT | Paperclip (71k stars, no revenue) | Nothing. Anyone may run and sell a hosted ros.ai Team |
| 2. Open core (decided) | The local app is MIT. The hosted and organisation layer is proprietary, in a private repo or an `ee` folder with its own licence | GitLab, n8n, Supabase, PostHog, Cal.com, Zed, Cline | The paid layer. The app stays forkable, the business does not |
| 3. Source-available local app (FSL or BSL) | Code is public and free to use, but not for a competing product; each release turns MIT after two years (FSL) or four (BSL) | Sentry and Convex (FSL), HashiCorp and MariaDB (BSL) | A rival selling ros.ai as a service. Not open source by the OSI definition |
| 4. Closed local app plus subscriptions | A download, no public source | Obsidian, Cursor, Warp, Raycast, Claude Code | The code. Loses the hackathon, the open story and reading-the-code trust |
| 5. Everything closed and hosted | A web app with accounts | OpenScience, Figlinq | Everything, and gives up local-first |

Options 2 and 3 can be combined later: an open-core company that meets a free-rider can put its next releases under FSL, as Sentry did, without closing anything.

## How the options play against the facts

| What matters | 1. All MIT | 2. Open core | 3. Source-available (FSL) | 4. Closed app |
| --- | --- | --- | --- | --- |
| Where the money comes from | Hosted tiers, but anyone may copy them | Hosted and organisation tiers, yours alone | Same as 2, plus the app itself cannot be resold | Same ladder; the app can also be charged for |
| Getting users with no marketing and no users today | Best: stars, forks, word of mouth | Same as 1 | Weaker: contributors and universities read "not open source" | Weakest: an unknown founder asking people to install a closed app that holds every API key and launches every agent on the machine |
| The "neutral control plane" claim | Credible: anyone can check that no vendor is favoured and nothing leaves the machine | Credible for the app, which is where the checks run | Credible, with a footnote | Hard: a closed intermediary between you and all your agents is what the labs are |
| University procurement (DPIA, EU guidelines) | Easiest: the institution is the processor, the code is readable | Same for the app; the org server is bought like Overleaf Server Pro | Fine | Possible, but every review asks what the binary sends home |
| Investor story | "Free forever" with no gated layer | The n8n ($40M to $100M ARR in six months) and Supabase story | Sentry-style, needs explaining | Cursor and Warp are the comparables, and both sell inference |
| Free-rider and fork risk | A cloud could host ros.ai Team for free | A fork cannot take the paid layer | Lowest for two years per release | None for the code; the UI can be copied from screenshots anyway |
| Work before 26 October | None | Move `cloud` out of the MIT tree, one PR | Swap LICENSE, rewrite the README licence section and four pitch documents | Build a release pipeline for binaries, rewrite every document |

Free-to-paid conversion in open-source software runs at 0.5 to 3% (Monetizely), and Cursor has positive margin on enterprise and loses money on individuals. So Pro and Max are an on-ramp, and Team and Enterprise are the revenue.

## What each option means for 30 October to 2 November

| Submission | What it asks | 1. All MIT | 2. Open core | 3. Source-available | 4. Closed app |
| --- | --- | --- | --- | --- | --- |
| NVIDIA x Nebius hackathon, 30 Oct 18:00 Amsterdam | A public repo with a licence and README, a demo URL, a video of three minutes or less, Token Factory and an NVIDIA model (as recorded in the plan of 17 October) | Fits | Fits: the app repo is public, the gateway is a separate service behind the demo URL | Probably fits, but a judge may read "not open source" against an open-model hackathon | Does not fit without a public repo |
| a16z speedrun SR008, priority window to 1 Nov | Business model, traction, team | Weakest story | The n8n and Supabase story, already in the two-pager | Sentry story; one paragraph of explanation | Cursor story, but ros.ai has no model to bundle |
| YC W27, 2 Nov 8pm PT | Same, plus the one-liner and the business-model box | Same | One-liner stays; business-model box gains the Pro rung | One-liner must drop "open" or explain it | The whole "any vendor, in the open" argument rewritten |
| The pitch documents | They say "MIT" and "free and open forever" throughout | No edit | Edit the business-model section of each | Replace every "MIT" | Rewrite four documents |

The slogan "Run your agents in the open" survives every option, because "in the open" means the agents' work is visible, not that the code is.

**If the hackathon is skipped** (YC and a16z matter more to Adam). That removes the public-repo rule and nothing else. YC and a16z fund open and closed companies alike (YC: GitLab, PostHog, Supabase, OpenScience in W26; a16z: Cursor, Databricks). What they test is traction and the answer to "why this instead of the Codex app?", and the only answer ros.ai has is that it is open and runs any vendor's agents. A closed app has to ship as a signed binary, which needs the Electron wrap and the Apple Developer account placed after 30 October, so a closed ros.ai on 2 November is a demo URL and nothing a YC partner can install. If the hackathon is skipped, drop the ros-nemotron fine-tune for this round, keep the public repo on 26 October, and spend the days on the app and the application video.

## Three worries, answered

**Does open source let people copy the app?** Yes, and so does closed source; the licence only changes how legally.

| Who copies | How | What stops them |
| --- | --- | --- |
| The labs: Codex app, Claude Code Agent Teams, Antigravity | From screenshots. They would add a visible shared workspace whether the repo is MIT or private | Nothing in a licence. Only being in people's daily routine first |
| An open rival such as AIPOCH, or a community fork | Copies the idea on its own stack, or forks the repo | A fork must keep up with the release pace. Forks won at Elastic, Redis and HashiCorp only after those companies broke trust. Roo Code forking Cline is the one case in the agent space, and Cline still raised its round, because a fork copies the free part only |
| Someone hosting ros.ai for money | Runs the hosted tiers on the code | Open core: the hosted layer is not in the open repo. FSL on later releases if it ever happens |

Closed source is not secrecy either: Claude Code's full source leaked from one source map, and an Electron app unpacks in a minute. The real cost of open source is time: issues and pull requests from strangers. Policy at launch: issues welcome, pull requests not reviewed until v1.

**What would an individual pay for, if hosted Ros is a toy?** Nobody pays $20 a month for a 4B model. An individual pays for what the laptop cannot do:

1. A hosted workspace that runs while the laptop is closed: the work continues on a ros.ai runner overnight (the Codex cloud and Claude Code web pattern).
2. A phone app: the queue of decisions reachable from anywhere, through a relay only ros.ai can run.
3. Project memory across machines: encrypted sync and backup of projects and "Ros remembers".
4. Hosted connectors: Notion, Drive and Slack through ros.ai's registered OAuth apps, with scheduled syncs.
5. Models without keys: one ros.ai key to open models on Nebius and frontier models by API, at cost plus margin (the Cursor model; API resale, never subscription tokens).

One individual tier at launch, Pro, with items 1 to 4 as the promise and item 5 as the day-one reality. Max only when a dedicated always-on runner exists. Nothing on this list is built before 2 November; it is published as scope.

**What if a competitor copies the way the canvas works?** They can, under any licence. Notion's blocks, Figma's canvas and Linear's UI were all copied, and the originals won on speed, distribution and ecosystem. A copier gets the idea, not neutrality (a canvas in the Codex app is a canvas for Codex agents), not the team's compounding shared context, not the standard (vendors support an open format rather than copy it, as with MCP), and not the pace. The one piece that is genuinely hard to copy is rule enforcement at the point where every vendor's calls meet, because only a neutral party can hold that point.

## The ladder

| Rung | Price anchor | What is in it | Why it is paid |
| --- | --- | --- | --- |
| Free | $0 | The MIT app, your own keys and agents, the local Ros download, and a small monthly allowance of hosted Ros | The on-ramp. Needs no keys on day one |
| Pro | $20 a month | Day one: one ros.ai key to open models on Nebius and frontier models by API, with a monthly allowance. Promised: the hosted workspace that runs while the laptop is closed, the phone app, project memory across machines, hosted connectors | Compute, relay and storage that ros.ai runs; inference at cost plus margin |
| Max (later) | $100 a month | A dedicated always-on runner and five to ten times the allowance | Only once the runner exists |
| Team | $25 a seat a month, 40% academic discount | A shared hosted workspace, roles, shared memory and program library, backups | The shared context a team builds up |
| Enterprise | From about EUR 15,000 a year | The organisation server, self-hosted or single-tenant: SSO and SCIM, the audit log of agent actions, one policy set for every agent, a processing agreement, support | What faculties, consultancies and compliance teams must buy before they can use agents on work they stand behind |

Three rules. Pro resells API usage under ros.ai's own brand and margin, never a vendor's subscription token. The ladder is published before 2 November as scope, not as a shop; the hosted tiers are built after the hackathon. The MIT app is never crippled to push people up the ladder.

## Steps

1. Before the repo goes public on 26 October, move `cloud` out of the MIT tree (a private `ros-ai-cloud` repo is the simplest form; the GitLab and n8n form is a `cloud` folder with its own licence). PR #44 touches `cloud`, so merge or rebase it first.
2. README licence section: "The local app is MIT. The hosted service and organisation server are separate, proprietary products." The name and logo exclusion stays.
3. Business-model sections of the two-pager, the investor brief, the product report and the YC answers updated to this ladder (done 22 October).
4. FSL stays in the drawer for a free-rider that hosts ros.ai for money.

Sources: the product and market report, the investor brief, the VC two-pager, the Accel research note on rivals and open-source business models (14 October 2026), and the plan to 30 October, all in the project files; the pages cited in the living doc.
