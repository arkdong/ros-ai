# ros.ai foundation result

Completed September 21, 2026, Europe/Amsterdam. Work began September 20 from a documentation-only repository. This is dated pre-event development, not a claim of hackathon eligibility or an approved submission.

## Outcome and launch

The reusable local foundation is implemented and verified. The application is running at **http://127.0.0.1:4310**. From this repository:

```sh
npm ci
npm start
```

Node 24+ is required; verification used Node 25.8.0. A fresh start builds missing frontend assets and serves frontend/backend together on loopback. Existing server-side `.env.local` contains the configured keys; do not overwrite it. No credentials are needed for local canvas/history features. See [README](../../README.md) for development, configuration and backup instructions.

Three saved investigations demonstrate the foundation: **City heat and shade** contains live source-grounded research and an explicitly reused result; **A focused writing experiment** contains separate model-only work; **Field notes — canvas verification** records manual edits and real conversational proposal acceptance. New investigations begin empty and have no fixed workflow template.

## What works

- Expandable dotted canvas with aligned node cards, pan/zoom, snapping, creation/editing/movement/removal, semantic connections, undo/redo and a resizable node inspector.
- Separate persisted project/node conversations. Project chat generates schema-validated previews; acceptance is an atomic undoable canvas transaction, while dismissal and stale rejection preserve current work.
- Independent node research using a real Nebius model, with optional one-call Tavily basic search. No relationship automatically imports inputs, starts work or imposes ordering.
- Explicit artifact/excerpt selection with original run/hash references, captured versions, newer-result hints and historical inputs that remain unchanged.
- Per-node cancellation, duplicate-start protection, bounded concurrency, preserved failures/retries and restart interruption without automatic billable replay.
- Prior canvas inspection and prior-run requests, settings, activity, results, captured source snippets, evidence mappings and attributable usage.
- Server-only secrets; host/origin checks; conservative persistent per-provider admission; no shell, generated-code, unrestricted file, account or deployment tool in the research runtime.
- Separate model and full agent-runtime interfaces. Codex/DeepSeek runtime implementations honestly report deferred capabilities.

## Verification and evidence

| Acceptance area | Actual verification |
| --- | --- |
| Fresh setup and one-command start | Separate temporary installation with `npm ci`, no copied dependencies or credentials; `npm start` built missing assets and served loopback frontend/API. [Evidence](../../evidence/fresh-setup.json) |
| Different investigations and real integrations | Real Nebius structured proposal, model-only writing exercise, Tavily snippets + Nebius synthesis, and explicitly selected result follow-up. [Live smoke](../../evidence/live-smoke.json) |
| Canvas and history UI | Chromium editing, descriptions, relationships, undo/redo, grid movement, pan/zoom, resizing, deletion recovery, history and run-input inspection; zero page errors. [Browser checks](../../evidence/browser-smoke.json) |
| Proposal UI and stale conflicts | Two real Nebius requests through the browser: neutral preview, intervening manual edit, stale acceptance disabled, dismissal, fresh acceptance, undo/redo and no run launched. [Evidence](../../evidence/browser-live.json) |
| Evidence selection and narrow layouts | Browser exact-excerpt attachment/removal, citation opening/scrolling, 900px canvas reframing, 600px sidebar and overflow checks. [Evidence](../../evidence/browser-responsive.json) |
| Persistence across process restart | Identical full API-state SHA-256 before/after restart: 3 projects, 6 nodes, 1 relationship, 12 messages, 3 proposals, 3 runs, 6 artifacts, 1 selection, 29 history states, 8 ledger records; no duplicate calls. [Evidence](../../evidence/restart.json) |
| Behavioral and contract coverage | **19/19 tests pass** across persistence, API, execution, provider contracts, evidence spans and process-lock crash recovery. Cancellation/concurrency/failure/timeout scenarios use explicitly fake providers, not claimed live integrations. [Tests](../../tests/) |
| Build and secret handling | Strict TypeScript check and production build pass. Configured key values absent from browser bundle, application source, docs, evidence and inspected API responses; key values never printed. [Secret scan](../../evidence/secret-scan.json) |

Screenshots inspected after fixes:

- [Desktop captured evidence](../../evidence/desktop-research.png)
- [Run history](../../evidence/desktop-run-history.png)
- [Real proposal preview](../../evidence/proposal-preview.png)
- [900px workspace](../../evidence/narrow-workspace.png)
- [600px workspace](../../evidence/mobile-workspace.png)

Verification scripts are in `scripts/`. Live scripts require explicit `--allow-billable` and refuse to repeat completed evidence automatically; they are excluded from `npm test`. Browser scripts exercise the saved verification investigations and may change their canvas histories. Local test fixtures use temporary directories and no real providers.

## Provider usage and uncertainty

Final build ledger snapshot: [usage summary](../../evidence/usage-summary.json). Pricing and catalog evidence: [provider verification](provider-verification.md).

| Provider | Live application verification | Published-rate cost estimate | Retained conservative accounting | Effective ceiling |
| --- | --- | --- | --- | --- |
| Nebius | 6 calls; 3,280 input and 1,246 output tokens reported | **$0.0007018** | **$0.3196128** | **$5** (stricter than the final brief's $20) |
| Tavily | 1 basic search; 1 credit reported | **$0.008**, plus **$0.008** allowance for the prior setup search | **$0.016** including setup | **$10** |

Amounts are estimates using verified published prices, not invoice measurements. The earlier setup search did not report usage, so its one-credit allowance remains uncertain. Account balances, invoices and usage by other clients were not verified. Reservations remain counted after successful requests and across restart; no budgets reset at midnight. No purchases, upgrades, credit redemptions, deployments, publishing or remote pushes occurred.

## Limits and follow-on boundaries

No external blocker remains for this bounded foundation. Source quality and model answers still require review: the live follow-up reused old source labels and the model-only writing response invented an input citation. These are preserved and visibly marked unsupported; they were not rewritten into apparently grounded answers. The prompt now explicitly lists allowed references, and tests protect evidence mapping, but citation correctness and entailment are not guaranteed.

Search captures up to three bounded snippets, not full pages. Research uses one optional search plus one capped model synthesis; context is limited to the last sixteen scoped conversation messages and a 64 KB serialized request. Large or longer investigations may need smaller selected excerpts or separate nodes. Execution progress is shown by durable stages rather than token streaming. At 600px, the inspector overlays part of the canvas; desktop and 900px layouts keep it alongside the canvas.

SQLite/local artifacts are the sole storage backend. `node:sqlite` stability varies by Node release; Node 25.8.0 was actually tested. Licensing/distribution decisions, generated-code sandboxing, hosted deployment/accounts/cloud sync, full external harness integrations, and historical branching/merging remain outside this milestone. Recorded model identifiers do not pin hosted weights or guarantee deterministic replay.

The project-local source/docs are authoritative. The compact vault packet was updated without duplicating detailed logs or event checklists.
