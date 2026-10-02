# ros.ai continuous collaborator build — September 22, 2026

The local app at **http://127.0.0.1:4310** now has a persistent project assistant, an evidence-linked research outline, direct canvas editing, nested Notes, recoverable project Trash, and the approved light lime/deep-green interface. The saved example **Schiphol weather · live assistant research** demonstrates actual Ultra inference, Tavily discovery, model-generated Docker analyses and explicit result reuse. [Open the demo tour](examples/schiphol-live-research/README.md).

The Nebius Sandbox backend and exact code/data approval are implemented. **Live remote execution remains blocked:** inspected official documentation and the signed-in console did not establish applicable sandbox prices, cost-unit conversion or free-beta terms. The final demo contains an inert model-generated remote preview with Allow & run disabled. No code/CSV was submitted to Nebius Sandboxes. [Setup and remaining gate](docs/nebius-sandbox-setup.md).

## Delivered behavior

- One continuous project conversation with Conversation / Research outline views; original/evolving question, reasons, decisions, observed outputs and open questions. Node, group and artifact focus changes attention immediately; clear restores project context. Node conversations remain separate.
- Actual assistant tools for governed note changes, one basic search, experiment proposals/execution under existing grants and explicit reuse of an immutable artifact. Ask requires specific approval. Generated structure stays a proposal until accepted. No implicit scheduling or input transfer follows a relationship.
- Durable model-visible requests, raw responses, code, errors, usage and artifact versions. Large histories compact within a 60 KB request bound with visible omissions and prioritized focus/failures. Invalid JSON/contracts apply no tool actions and retain capture; restart interrupts work without replay. Search cancellation, project stop and shutdown discard late responses and retain admitted costs.
- Three project starters: blank, prepared weather demo, or conversation. The prepared demo contains labelled notes/data, not invented successful execution. Nested Notes navigation preserves deeper groups and Knowledge/Action kinds.
- Four-sided click/drag connections, optional labels and cross-parent relationships. Expanded title/description edits save/cancel directly with undo. Arrange changes positions only, deterministically and undoably, including a large nested fixture.
- Confirmed project Trash and Restore retain notes, histories, artifacts and limits. No permanent delete control was added. Larger readable controls and the supplied glow artwork replace appearance settings; no theme system.
- A shared durable **US$10 maximum for all new Nebius inference plus sandbox charges in this build**. It supplements provider, project and runtime limits and never creates a second US$10 allowance. Historical grants/uncertain reservations and the cumulative Tavily ledger remain intact.

## Actual live demonstration

The coding assistant operated the actual app in Ask mode using public data; this was a guided integration demonstration, not unattended autonomy. Six Ultra requests clarified the idea, proposed four notes, discovered sources and generated analysis, repaired a failure, then inspected outputs and proposed a follow-up. One Tavily basic search returned captured snippets. A previously retrieved real KNMI CSV was explicitly imported; the model did not autonomously obtain new weather observations.

The first Docker attempt failed with FileNotFoundError and remains saved. A later model response failed schema validation and applied no tools; it is also retained. The repaired model program completed with a monthly table, plot, CSV, metrics and conclusion. The final model inspected those outputs and proposed reuse plus follow-up code. The exact monthly CSV was accepted through the browser. Selecting it changed the input signature, so the stale preview was cancelled and refreshed from the same captured model plan before approval, without another model request. The follow-up completed in Docker.

Observed daily-mean temperature was 11.970 °C; precipitation was 1,047.0 mm under trace-as-zero; 155/366 days met the 1 mm threshold. Reusing rounded monthly data gives temperature means 11.956083 °C (equal-month) and 11.970473 °C (day-weighted). These are descriptive one-year local-day summaries: trace precipitation, daylight-saving hours and rounding limit interpretation. There are no cycling counts or causal claims.

The final model used hashes where some artifact IDs were required; invalid references were rejected. It omitted requested additional finding/gap memory entries. Actual saved results remain navigable through execution-derived outline findings. The demo tour discloses this limitation and the coding-assistant annotations; original responses and immutable results were not rewritten. [Captured live steps and outputs](evidence/continuous-collaborator/).

## Verification and preservation

| Check | Result |
| --- | --- |
| Behavioral suite | **153/153 pass, zero skipped**, including actual local Docker, assistant context/tools/contracts, search cancellation, canvas/store behavior and shared-budget/remote fixtures. [Log](evidence/continuous-collaborator/tests-final.txt). |
| Lint / production build | Both pass. Existing >500 kB Vite chunk warning remains. [Lint](evidence/continuous-collaborator/lint-final.txt), [build](evidence/continuous-collaborator/build-final.txt). |
| Actual browser | Three starters; nested tree/focus; four-side connections and optional label; inline edit/save/undo; Arrange/undo; Trash/Restore; CSV upload and real bounded computation; live conversation/reuse; outline → immutable metric → artifact focus; final Nebius preview and disabled execution. [Record](evidence/continuous-collaborator/browser-final.json). |
| Pre-existing data | **268/268 old rows across ten tables unchanged**, zero missing/changed. Six original projects plus new live demo. Private ignored backup retained. [Audit](evidence/continuous-collaborator/preservation-final.json). |
| Final restart | All persisted table hashes identical after graceful restart; no request replay or new charge. A fresh inert remote preview was created afterward for review. [Evidence](evidence/continuous-collaborator/restart-final.json). |
| Secret scan | Configured API keys/provider project ID absent from source/docs/evidence/build and checked local API responses. No values emitted. [Evidence](evidence/continuous-collaborator/secret-scan.json). |

Remote fixtures prove application behavior against simulated REST contracts. They do not prove Nebius guest isolation, actual VM execution, cancellation termination, resource caps or billing. The adapter requests network-disabled disposable execution, pins the image, bounds transfer/output/time, records submission before POST and reconciles known operation IDs without blind resubmission. Exact transfer approval and verified-price admission remain separate from provider enforcement. [Dated API research](docs/nebius-sandbox-api-research-2026-09-22.md).

## Usage and handoff

Six new Ultra calls reported **68,262 input + 13,220 output tokens**, a **US$0.107922 usage-derived estimate** at the per-request checked catalog rates. **US$9.599184 remains reserved/accounted** against the US$10 combined maximum, leaving US$0.400816. Reservations include the invalid response and are not refunded to actual usage. No remote sandbox reservation, submission, image import or charge was admitted. New paid requests are disabled in the running handoff server; saved local work remains usable.

One new Tavily basic search used one reported credit (US$0.008 conservative rate). Including two historical rows, one uncertain, cumulative accounted Tavily use is **US$0.024**, leaving **US$9.976** of its unchanged US$10 ceiling. These are application estimates/reservations, not an invoice or account-balance claim. [Final ledger audit](evidence/continuous-collaborator/final-usage.json), [authorization and pricing record](docs/continuous-provider-verification-2026-09-22.md).

To complete live Nebius execution, establish authoritative applicable sandbox free terms or a worst-case charge for all resources, configure a bounded sublimit under the remaining shared allowance, then explicitly approve one non-sensitive captured run. Do not rotate grant IDs/data directories to replenish the spent build allowance. The current remaining maximum may be insufficient; any increase needs new user direction and an explicit reconciled authorization design.

Earlier [sandbox result](RESULT-sandbox-2026-09-22.md), [collaborator result](RESULT-collaborator-2026-09-21.md), [experiments](RESULT-experiments-2026-09-21.md) and [foundation](RESULT-foundation-2026-09-21.md) remain preserved. No deployment, account change, purchase, credit redemption, public/shared write, goal, automation or event eligibility claim was made. This is dated pre-event work.
