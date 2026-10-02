# Provider and cloud verification — September 21, 2026

This is new-build evidence. The foundation's Qwen/Tavily records and original usage ledger remain historical and unchanged. This build verifies a real local numerical runner and one live Ultra text interpretation. **A live Ultra-generated-code experiment is not verified:** its native tool-planning request failed with HTTP 400. No model was silently replaced.

## Selected model and authenticated catalog

A read-only authenticated `GET https://api.tokenfactory.us-central1.nebius.com/v1/models?verbose=true` succeeded at **2026-09-21 19:44:53 UTC**, returning 17 models. It exposed the exact preferred model:

| Field | Observed value |
| --- | --- |
| Model ID | `nvidia/Nemotron-3-Ultra-550b-a55b` |
| Region/API | `https://api.tokenfactory.us-central1.nebius.com/v1` |
| Context | 1,048,576 tokens |
| Prompt rate | $0.000001/token = $1 per million |
| Completion rate | $0.000003/token = $3 per million |
| Other listed request/image/video/minute charges | Zero |
| Catalog features | `tools`, `reasoning` |
| Quantization | `fp4` |
| Structured output / pinned model version | Not advertised / unavailable |

The same information was checked immediately before each submitted request and retained in its ledger trace. The [Nebius-owned Ultra guide](https://github.com/nebius/token-factory-cookbook/blob/main/models/nemotron/nemotron3-ultra-550b-a55b.md) independently supplies this ID, region, and rates. Its list page and individual guide disagree about context; runtime admission uses the authenticated catalog value. NVIDIA's [model research page](https://research.nvidia.com/labs/nemotron/Nemotron-3-Ultra/) confirms the 550B-total/55B-active family and configurable reasoning, but does not establish a hosting provider's exact API compatibility.

`ROS_NEBIUS_MODEL` selects the exact default above. The old `NEBIUS_MODEL` value is deliberately ignored so an existing Qwen setting cannot silently replace the user's preferred model. A deliberate new override remains visible as the selected model and must appear in the regional catalog. There is no fallback model.

## Authorized live checks and their limits

The user explicitly authorized **at most two Ultra submissions, capped at $5 Nebius, with no Tavily**. The authorization was used only by the isolated verification scripts and was not enabled in the normal app's `.env.local`. The fresh ledger lives in ignored `evidence/next-ultra-data/`; do not delete or rotate it to reset admission. Sanitized fixture/project/usage records are in the following reports:

| Attempt | Actual outcome | Usage and cost evidence |
| --- | --- | --- |
| [First: native experiment tool proposal](../evidence/next-ultra-live.json) | Provider HTTP 400. No generated plan, no generated code executed, no retry. | No reported token usage; cost unknown. $2.109152 reservation retained as uncertain. |
| [Second: interpret actual local results](../evidence/next-ultra-interpretation.json) | Completed with exact Ultra model ID and `finish_reason=stop`. | 1,115 input and 428 completion tokens; **$0.002399** published-rate estimate; 1,657 ms HTTP-completion latency. $2.109152 reservation retained. |

**Two of two requests are consumed; no more requests are authorized.** Total conservative accounting is **$4.218304**. The known $0.002399 estimate is for the successful request only, not the combined invoice; the first request's billing is unknown. No account balance or invoice was read. There were no search calls, purchases, deployments, account changes, or retries.

Each request reserved `2 × (1,048,576 × $0.000001 + 2,000 × $0.000003)`. Reservations remain counted after settlement, failure and restart. Reported completion tokens determine the successful estimate; no hidden-reasoning trace is claimed or reconstructed.

The first call used the documented native function contract plus `reasoning_effort: low`. Generic [Nebius chat API documentation](https://docs.tokenfactory.nebius.com/api-reference/inference/create-chat-completion) lists this option, but the exact Ultra guide does not establish its supported values. Its original error body was discarded by the foundation's error handling, so the **cause of HTTP 400 is unknown**. The current adapter omits this unverified model-specific option. The second call also omitted tools, so its success cannot isolate the first failure's cause. Subsequent errors retain bounded diagnostics with exact outgoing credentials and token-like values redacted. No inference was spent solely to diagnose the first failure.

The second experiment used reviewed, build-authored numerical code against the synthetic CSV `x,y = (1,3),(2,5),(3,7),(4,9)`. Actual Python execution produced slope **2**, intercept **1**, R² **1**, a descriptive table, logs and an SVG plot. Exact outputs were explicitly selected as the interpretation node's inputs. The model correctly stated the metrics and warned against causal/predictive conclusions. Its final general limitation cited the descriptive table, which does not establish that general claim: captured citation existence is not entailment. No provider output or historical evidence was rewritten to improve the result.

The manual verification scripts refuse to repeat existing evidence/state, require `--allow-billable`, and use the original durable request counter. Their existence does not grant future permission. The first script pauses for an exact-code review before local execution; the follow-up separately records that its code was locally authored.

## Working integration contract

The [Nebius function guide](https://docs.tokenfactory.nebius.com/ai-models-inference/function-calling) defines model outputs as proposed function calls for application-side validation. Ultra's catalog declares tool calling, so the adapter offers a single named response function when structured output is unavailable. It validates exactly one expected call, valid JSON arguments, response size and exact returned model identity; unknown/multiple/unsolicited calls fail. This is a **tested offline adapter contract**, not a claim that the failed live tool request succeeded.

Project chat asks for missing intent/outcome once, reuses supplied context, and favors one or two independent nodes. New Topic/Activity kinds are independent of root/child scope. Structural replies still go through preview and atomic acceptance. Larger unsolicited maps are rejected. Without usable credentials or fresh paid authorization, a visibly labelled fixed-rule local helper can ask a focused question and propose one stand-alone Topic/Activity; it never claims inference.

`startExperimentPlan(projectId,nodeId,{request,datasetArtifactId})` creates a normal durable, cancellable run. It captures the exact dataset artifact/hash, selected inputs and node conversation, requests `{explanation, code, parameters}`, and stores the returned tool proposal. `configuration.experimentPlan` can populate the local editor. The local runner receives `planRunId`, preserves its origin and changes, validates bounded syntax, and requires a new exact-action approval. Model output never directly executes code or changes the canvas. Results can be explicitly selected for a separate interpretation request.

Normal application paid work is off until a fresh grant is configured server-side through `ROS_PAID_AUTHORIZATION_ID`, provider-specific `ROS_NEBIUS_AUTHORIZED_USD` / `ROS_TAVILY_AUTHORIZED_USD`, and `ROS_PAID_MAX_REQUESTS`. Limits and request count persist under the same authorization ID; the historical budget variables confer no permission. Reservations, execution approvals and OS containment remain separate mechanisms. The retained historical ledger is not overwritten or silently replenished. Do not change data directories or authorization IDs to bypass spent allowances.

Five new provider tests cover native function routing/rejection, no historical model fallback, fail-closed paid admission, useful local chat, durable scoped budget/count admission, exact dataset/context capture without execution, and redacted diagnostics. The nine existing execution tests still pass. These use labelled local fake providers. Real-runner and browser evidence is reported separately in the next-build result.

## Prepared comparison, not a benchmark claim

[Equivalent-input fixtures](../evidence/next-model-comparison-fixtures.json) define a small descriptive analysis and a synthetic linear-fit task with checkable answers, fixed requests, limits and a scoring rubric. The catalog also exposed Super (262,144 context; $0.30/$0.90 per million input/output) and Nano (262,144; $0.06/$0.24), both with tools/reasoning. These are future comparison candidates, not selected substitutes.

A fair authorized comparison should reuse exact captured input bytes and settings, count invalid/failed responses, validate resulting code through the same local policy, check numerical values and citation quality, and record measured latency, provider usage and rate-based cost. Report request-format differences and repeated samples before generalizing latency. The one successful Ultra interpretation is a smoke check, not evidence of superiority, cost savings or reliability. No Nano/Super comparison inference occurred.

## Optional Nebius Serverless feasibility — documentation only

[Current Serverless documentation](https://docs.nebius.com/serverless/overview) distinguishes finite Jobs from persistent HTTP Endpoints. Job container disks disappear after completion; endpoint container disks disappear when stopped/deleted. Durable results therefore need separately persisted storage. These are optional later execution adapters, not dependencies of the local loop.

The [Jobs quickstart](https://docs.nebius.com/serverless/quickstart/jobs) requires a cloud project, authenticated API/CLI, available Compute quota, compatible image/platform/preset, subnet and timeout. It returns a resource ID for status polling. The [Endpoints quickstart](https://docs.nebius.com/serverless/quickstart/endpoints) additionally documents editor permission, VPC allocation quota and a separate endpoint authentication token. Endpoint access must be tested with/without that token. Token Factory inference credentials do not establish cloud project authorization; no cloud access was verified here.

[Pricing and quotas](https://docs.nebius.com/serverless/pricing-quotas) follow regional Compute/disk charges; mounted object storage/shared filesystems bill separately even when workloads stop. Specific regional rates, available hardware, account discounts, quotas and access remain unverified. A future adapter must price its exact resources, duration, storage and network allowance and reserve before submission, with hard job timeouts, bounded concurrency and explicit endpoint lifetime/cleanup. The earlier Token Factory budget is not cloud-runtime authorization.

ros.ai would additionally need: immutable dataset/code/result objects; a durable submission record written before dispatch; remote resource IDs and status reconciliation; separately scoped server-side secrets; and authentication/integrity checks on any future callback. These are design requirements inferred for reliable integration, not deployed features. The reviewed [lifecycle documentation](https://docs.nebius.com/serverless/lifecycle) supports status-based recovery; no provider callback or idempotent-create guarantee was verified. Never resubmit an uncertain job blindly.

A laptop-independent workflow needs durable remote orchestration/storage and a reachable authenticated callback receiver, or later polling after reconnect. A closed local server cannot receive callbacks. The current SQLite/local-worker app continues after browser closure only while its server and laptop remain running; server/laptop shutdown interrupts local work. No cloud resources, endpoints, secrets, storage buckets, callback services or self-hosted models were provisioned. The [Nebius-maintained cookbook](https://github.com/nebius/serverless-ai-cookbook) is useful example material, but identifies itself as a community resource rather than authoritative product documentation. Data Lab curation and inference batches are not an arbitrary local-code runtime.
