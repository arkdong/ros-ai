# Provider implementation and verification

> Historical foundation evidence. The September 21 next build selects Nemotron 3 Ultra and requires fresh paid authorization; see [current provider verification](next-provider-verification.md). The Qwen configuration, live checks and one-time allowances below describe the earlier foundation and do not authorize further calls.

Implementation evidence dated September 21, 2026. Live build verification results are reported separately in `RESULT.md`; deterministic contract tests do not prove live service success.

## Official interfaces and observed catalog

Nebius inference uses `POST https://api.tokenfactory.nebius.com/v1/chat/completions`. Before **each** inference request, the server authenticates to `GET /v1/models?verbose=true`, verifies the configured model is present, reads its token prices and context ceiling, and checks structured-output capability for project conversation. Credentials are never included in recorded messages, usage traces, or browser responses. Errors contain curated HTTP status information rather than upstream bodies that might echo private authorization details.

The authenticated catalog returned `Qwen/Qwen3-30B-A3B-Instruct-2507`, a 262,144-token context, `structured_outputs`, `json_mode`, and `tools` on September 21. Catalog pricing was $0.10 per million input tokens and $0.30 per million output tokens. [Sanitized observed catalog](evidence/nebius-catalog-2026-09-21.json) records the actual response metadata. The service does not infer tool or JSON support merely from an OpenAI-compatible endpoint. Tool calling is declared by the catalog but is not used: user-enabled search is centrally bounded before one model synthesis call. A model ID does not pin hosted weights, and the provider does not expose a dependable model version in this adapter.

Primary sources checked:

- [Nebius model catalog endpoint](https://docs.tokenfactory.nebius.com/api-reference/models/list-models) documents the authenticated model listing and verbose option.
- [Nebius quickstart](https://docs.tokenfactory.nebius.com/quickstart) identifies the Token Factory API and chat interface.
- [Nebius published pricing](https://nebius.com/token-factory/prices) independently lists the selected model's $0.10/$0.30 per-million input/output prices.
- [Nebius structured-output documentation](https://docs.tokenfactory.nebius.com/ai-models-inference/json) is listed in the official documentation index; actual capability admission uses the authenticated catalog rather than assuming all models implement it.
- [Tavily Search reference](https://docs.tavily.com/documentation/api-reference/endpoint/search) specifies `POST https://api.tavily.com/search`, optional usage reporting, and returned snippets.
- [Tavily credits and pricing](https://docs.tavily.com/documentation/api-credits) defines basic search as one credit and the pay-as-you-go price as $0.008 per credit. Subscription effective prices can be lower; this build does not assume any free allowance.

## Cost admission and its limits

The pasted build prompt contains an earlier Nebius $5 ceiling and a later $20 ceiling. This implementation uses **the lower $5 ceiling** conservatively. Tavily retains its separate **$10 ceiling**, also below the earlier 1,500-credit ceiling at the published $0.008 upper rate. Limits are one-time cumulative allowances in the local data directory, never daily/monthly resets. They are ceilings, not targets.

Before a Nebius call the ledger reserves **twice the cost of the entire model context at the observed input rate plus the capped output at the observed output rate**. For the observed model and 1,400 output cap, this is `$0.0532688` per call. A request is restricted to 64 KB of serialized model input, and a conservative byte bound plus template margin must fit the model's declared context. Using the full context for reservation avoids presenting character-based token guesses as an exact tokenizer. This large reservation is retained even after a successful response; reported token usage yields a separate, much smaller cost estimate. Reservations for failed, cancelled, timed-out or interrupted requests remain counted. No automatic inference/search retries exist.

Each search run admits at most one **basic** Tavily search, explicitly disables automatic parameters, generated answers and full-content retrieval, requests at most three results, and asks for usage. It reserves one credit ($0.008). The prior September 20 setup search receives its own durable uncertain one-credit reservation. This reflects documented request pricing; the original setup command did not return a measured cost. Model-only runs do not call Tavily.

Usage rows retain provider, purpose, linked run, reservation, catalog or credit pricing basis, reported usage, and separate estimated cost. Project model requests and responses are also recorded in the ledger, including exact model-visible messages and proposal schema. Admission counts the greater of reservation and estimated usage, so a smaller successful estimate never silently releases the conservative reserve.

Account balances, invoices, other applications' usage and account-side hard limits have not been read or modified. These controls bound requests from this local data directory using provider pricing and advertised request limits; they are not a promise of an exact invoice or an account-wide limit. Reusing credentials in another program or resetting/changing `ROS_DATA_DIR` requires explicit reconciliation of prior build usage. No account purchases, upgrades, credits or resets are performed.

## Execution and provenance

A user starts an independent node run. Two jobs may run concurrently by default, with a configured maximum of four. Duplicate starts in the same active node reuse that run. Cancellation affects only its request; late output is discarded, and cancellation is not a claim that provider computation or billing stopped. Requests time out after 90 seconds. Shutdown marks unfinished runs interrupted, aborts requests, retains reservations, and never resumes automatically. Explicit retry creates a linked new run with current node/input configuration and preserves the earlier attempt.

A run captures its node and project revision, selected artifact IDs and immutable hashes/excerpts, the last sixteen messages from **that node only**, exact assembled model messages, request settings, catalog capabilities/pricing, search schema and observed tool records, output artifacts, usage, errors and timings. Conversations remain separate; visual relationships do not import source content or start work. Project conversation includes committed canvas state and the latest pending preview for refinement; only accepted proposals can change structure.

Search excerpts preserve the exact text sent to the model, source URL, and character-range locator. Up to 6,000 characters per result are captured; longer snippets are explicitly marked truncated. They are labelled **search snippets**, not full documents. The original selected excerpt is retained for `[I1]` input references. Result sentence spans contain citation references such as `[S1]` or `[I1]`; evidence records link cited spans to the captured artifact/excerpt and explicitly flag absent or unknown references as unsupported. A reference existing does not establish truth or entailment. Uncited model-only output is not presented as source-grounded.

The model adapter and external agent-runtime contract are separate. `DeferredAgentRuntime` declares unavailable Codex/DeepSeek execution, cancellation and traces honestly and returns a deferred error; no external runtime integration, synthetic prompt reconstruction, shell, arbitrary filesystem, package installation or generated-code execution is exposed to research agents. This code uses lifecycle-scoped cancellation, captured request context and centralized tool/cost policy as architectural lessons. No harness source was copied or vendored.

## Configuration and checks

`NEBIUS_API_KEY` and `TAVILY_API_KEY` are server-side environment variables or ignored `.env.local` settings. `NEBIUS_MODEL` defaults to the catalog-verified model above. `NEBIUS_BUDGET_USD` and `TAVILY_BUDGET_USD` may lower, but cannot raise, the build caps. `ROS_MAX_CONCURRENT` defaults to two; the service restricts it to an integer from one through four. Missing keys leave canvas/history available and give actionable run/chat errors.

`npx tsx --test tests/execution.test.ts` covers context isolation, graph non-execution, selected version capture, proposal preview/dismiss/accept, durable request/schema traces, exact search snippets, unsupported citations, duplicate clicks, concurrency admission, isolated cancellation and discarded late completion, explicit failure retry, persistence without automatic replay, separate durable budgets, unknown pricing rejection, timeouts, and distinct model/external-runtime contracts. All providers in this test file are clearly local fixtures; paid live smoke verification is performed separately through the actual application API.


## Real integration smoke result

The application API smoke test completed at **2026-09-21 00:03 Europe/Amsterdam** (2026-09-20 22:03 UTC). [The captured smoke report](../evidence/live-smoke.json) records a live project proposal, non-mutating preview, accepted two-node canvas change, one Tavily-assisted node, a selected-result model-only follow-up, and a separate model-only writing investigation. These were actual configured services, not test fixtures.

| Provider | Build calls | Provider-reported usage | Cost estimate from reported usage | Retained conservative accounting |
| --- | ---: | --- | ---: | ---: |
| Nebius | 4 | 2,442 input + 857 output tokens | $0.0005013 | $0.2130752 |
| Tavily | 1 new + 1 prior setup | New search: 1 credit; setup: unavailable | New: $0.008; setup estimated $0.008 | $0.016 including setup |

All four Nebius completions reported `finish_reason=stop`, the expected model ID, and no dependable model version/system fingerprint. Tavily returned three exact captured search snippets with locators and reported one credit. These are usage-derived estimates rather than measured invoices or account balance readings.

The outputs also demonstrate why provenance is inspected rather than assumed: the selected-result follow-up repeated source labels belonging to the earlier run, and the model-only response invented an `[I1]` despite no selected input. The application retained those actual outputs and marked references absent from the current run as unsupported. It did not fabricate artifacts to satisfy them. The search-backed original result's three references map to captured excerpts; their existence is not an automated entailment judgment. The writing plan also contained ambiguous session-frequency wording, so generated research text still needs human review.

After this smoke test, local improvements separated evidence into sentence spans, distinguished prior-run citations, and explicitly enumerated the current allowed references in the model prompt. Nine deterministic execution tests pass for these controls; **the revised prompt was not billed for another live call**. Earlier immutable runs retain the evidence records produced by the version that executed them. No original outputs or usage records were rewritten to make this verification appear better.
