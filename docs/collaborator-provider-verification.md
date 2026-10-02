# Collaborator provider verification — September 21, 2026

No paid provider calls were made for this build. The prior two-request Ultra grant is exhausted; its failed native-tool plan and successful text interpretation remain in [the dated provider record](next-provider-verification.md). They do not verify the new research coordinator.

An authenticated, read-only catalog check at 21:40 UTC confirmed `nvidia/Nemotron-3-Ultra-550b-a55b`, 1,048,576 context tokens, $1 per million input tokens and $3 per million output tokens. Tools/reasoning are advertised; structured output and a concrete model version are not. These are catalog rates, not an invoice/account balance. [Captured catalog](../evidence/collaborator/catalog.json).

The replacement transport sends a JSON schema contract in the model-visible prompt without native tools or `response_format`. It parses a JSON object and validates the consumer schema before any action. Offline adapter tests verify the exact wire fields and rejection of malformed/scalar/array responses and unsolicited tool calls. Research fixtures exercise planning, actual Docker execution, real traceback repair, inspection and user-directed follow-up. Fixtures establish local behavior only.

## Concrete pending live check

Fresh user authorization was requested after completing the local example. The proposed ceiling is **$15, at most six Ultra requests, and at most three local 30-second Docker experiments**. No Tavily, additional Action creation, source writes, remote execution, purchase or deployment is included. Keep Ask mode and inspect each exact proposed program before approving its local run. Do not configure a paid grant until the user authorizes this request.

Use the saved weather project and exact public CSV version recorded in [weather-project.json](../evidence/collaborator/weather-project.json). First request a small weather audit/weekday-weekend analysis, inspect the model-written program, execute it within the local boundary, then ask the model to inspect actual outputs or errors. A subsequent user-directed season/trace-sensitivity question should preserve that session and earlier artifacts. Three experiments allow one bounded repair; six requests allow planning/inspection for two analyses plus repair. If a cap is reached or a request fails, preserve its evidence and stop rather than issue an unapproved retry.

For each 3,000-output-token request the conservative admission formula is `2 × (1,048,576 × 0.000001 + 3,000 × 0.000003) = $2.115152`; six reservations total $12.690912, below the proposed $15 ceiling. Recheck the catalog before configuring the grant and fail closed if these bounds change. Keep the same grant ID and normal data-directory ledger for all attempts, retain unknown reservations and disable paid work after verification.

Only the selected public data preview, scoped question/context, generated program and captured results needed for inspection leave the machine through Nebius. No original host paths, secrets or unrelated project chats should be sent. Capture request inputs, validated response, local outputs/errors, provider usage/latency and cost basis. Success requires actual end-to-end evidence, not merely a successful API response.

The existing saved demonstration remains usable without this paid check: two coding-assistant-authored analyses actually ran on real weather data, producing three plots and a preserved follow-up. It cannot answer the cycling association while cycling counts are absent.
