# Continuous collaborator provider authorization — September 22, 2026

This build has fresh user authorization for **at most US$10 of new Nebius charges in total, combining inference and sandbox execution**. It is not US$10 per service, project, Action, retry or restart. The reported US$35 account balance does not establish prices or enlarge this ceiling. The user also continued the existing cumulative Tavily allowance unchanged. No purchase, redemption, account change, deployment or public/shared write is authorized by these limits.

## Durable admission

`CombinedNebiusBudget` adds a separate `combined-nebius-grant` record with the fixed build scope `continuous-collaborator-2026-09-22`. Configure `ROS_NEBIUS_COMBINED_AUTHORIZATION_ID` and `ROS_NEBIUS_COMBINED_AUTHORIZED_USD` only for this fresh authorization; the implementation refuses values above US$10. Use one stable identifier and the normal data directory for every new inference and remote attempt. Changing identifiers or ceiling values after the first admission cannot create another allowance. Historical usage and exhausted grants remain untouched.

Both services receive the same budget instance. Inference reserves against its immutable provider usage-row ID; sandbox execution reserves against its attempt ID. The shared reservation, existing provider/runtime allowance and project admission commit within the same SQLite transaction before dispatch. Known pre-dispatch admission failure rolls them all back. Once admitted, failed, cancelled, timed-out and uncertain attempts retain their entire reservation. Explicit retries receive new reservations. Reported inference cost above its reservation raises the accounted amount; smaller reported usage never refunds it. Charges round upward to integer nanodollars and ceilings downward, without a floating-point overspend tolerance.

The shared ceiling is an additional gate. It does not invent remote pricing, waive exact transfer approval, increase project resources, replenish a provider request cap or resume interrupted work. The ledger is conservative application accounting, not an invoice, account balance or provider-side billing cap. It cannot account for unrelated programs using the same credentials; moving or resetting the data directory would invalidate its cumulative protection and requires reconciliation.

## Historical records checked without modification

Read-only SQLite inspection confirmed:

| Ledger | Retained accounting | Current interpretation |
| --- | --- | --- |
| `evidence/next-ultra-data/` | Two Ultra requests at US$2.109152 each, US$4.218304 total; first uncertain, second settled with US$0.002399 estimated usage | The old two-request authorization is exhausted and remains separate. |
| `.ros-ai/` Tavily rows | One uncertain setup search and one completed basic search, US$0.008 each; US$0.016 total | The unchanged cumulative US$10 ceiling has **US$9.984 remaining**, equivalent to at most 1,248 more basic searches at the published conservative rate. This is an admission bound, not a target or verified account balance. |

At the start of this work, `.env.local` contained configured credential keys but no active provider, shared Nebius or sandbox authorization fields. No secret values were printed. The normal application and historical databases were not modified by this investigation. Future verification must record actual new calls separately below or in linked evidence.

## Price and scope recheck

The official [Tavily credit documentation](https://docs.tavily.com/documentation/api-credits), checked September 22, still defines basic search as one credit and PAYG pricing as US$0.008 per credit. The application permits one basic search per admitted run, disables automatic parameter upgrades, generated answers and full-content retrieval, and requests usage. The continued allowance must count **all** historical Tavily rows, including the uncertain setup call, instead of filtering only on the fresh Nebius authorization ID. The advertised monthly free tier is not assumed to be available to this account. Neither extraction, crawling nor the separately priced Research API is established by this bounded basic-search allowance.

The official [Nebius Sandbox overview](https://docs.tokenfactory.nebius.com/sandboxes/overview), [documentation index](https://docs.tokenfactory.nebius.com/llms.txt) and [billing guide](https://docs.tokenfactory.nebius.com/other-capabilities/billing-new) were rechecked. They establish Beta status and general billing, but the inspected material supplies no applicable sandbox rate, cost-unit conversion or free-beta commitment. The [public price URL](https://nebius.com/token-factory/prices) redirects to the authenticated console; this investigation did not duplicate the earlier signed-in console or large image-catalog inspection. The previous [API investigation](nebius-sandbox-api-research-2026-09-22.md) records unknown units for `resources.cost`. Missing prices or an account balance cannot be substituted for a worst-case charge.

**Remote execution remains blocked until an authoritative charge bound or applicable free terms are established.** No sandbox spawn, image import, file upload or paid inference/search request was made by this budget/pricing subtask. Local development and offline contract testing continued.

## Focused verification

`node --import tsx --test tests/combined-budget.test.ts tests/remote-experiments.test.ts` passes 14 tests covering the US$10 hard cap, shared inference/remote accounting across projects, retained failure/settlement reservations, higher reported usage, restart, identifier/ceiling rotation refusal, idempotent exact admission, changed-attempt rejection, atomic rollback, unknown-price rejection and remote approval/recovery regressions. These are offline fixtures; hypothetical sandbox prices in tests are explicitly labelled and are not real provider rates.

The root integration and any actual application/provider/browser verification belong in the final build result; this focused check alone does not establish live collaboration or sandbox execution.

## Actual root integration verification and handoff

The final guided demonstration used the normal local app and public KNMI capture. It made **six new Ultra requests** and **one basic Tavily search**, all through the application's admission paths. The authenticated model catalog was checked for each inference request: `nvidia/Nemotron-3-Ultra-550b-a55b`, context 1,048,576 tokens, input US$1/million and output US$3/million. Reported totals were 68,262 input and 13,220 output tokens: **US$0.107922 estimated usage**. A schema-invalid response remains charged/reserved; there was no automatic model retry.

The first three calls retain their original conservative 2× full-context-plus-output bound of US$2.133152 each. For subsequent continuous-assistant calls only, admission uses the entire catalog input context plus the explicitly capped 6,000 output tokens, **US$1.066576** each. Input at most the full context and output at most the request limit remain conservatively bounded; other callers retain their legacy multiplier. Previously admitted rows were never reduced, reinterpreted, deleted or refunded. The combined ledger therefore retains **US$9.599184**, leaving **US$0.400816** of the exact US$10 build ceiling. This remaining amount cannot admit another request with the same upper bound.

The new Tavily result reported one credit and adds US$0.008. Together with the historical uncertain setup and completed search, cumulative retained Tavily use is **US$0.024**, leaving **US$9.976** under its unchanged US$10 ceiling. Free account credits were not assumed.

Two actual model-generated Docker analyses completed after one preserved FileNotFoundError. A rejected-schema response applied no tool actions; the final interpretation used some hashes instead of valid artifact IDs, so those references were rejected. The original raw responses, usage and actual execution outputs remain saved. This is guided integration evidence, not a claim of unattended reliability or deterministic replay.

**Zero Nebius Sandbox attempts were admitted or submitted.** The real API rejected exact approval of a remote preview with HTTP 409 before usage changed; the final browser shows the saved remote code/data and disabled Allow & run. An inert preview was created after restart, then refreshed once more after Arrange changed the captured note position (three retained previews total). No sandbox image import, remote upload, operation identity or execution charge is recorded. Current pricing and provider-enforcement limitations remain as above.

All 268 pre-existing rows in the ten original tables match the private backup byte-for-byte; current usage and grant records were audited read-only. The final clean restart preserved all table hashes. Paid requests are disabled in the running handoff server; grant/environment examples remain blank or zero and existing credentials were not changed. [Final usage](../../evidence/continuous-collaborator/final-usage.json), [preservation](../../evidence/continuous-collaborator/preservation-final.json), [actual demo](../../examples/schiphol-live-research/README.md), [complete result](../../RESULT.md).
