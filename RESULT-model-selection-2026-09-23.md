# ros.ai — simplified connections and selectable reasoning providers

Completed September 23, 2026. This is the current implementation report; the preceding four-stage demo and live market extension are preserved in [RESULT-four-stage-2026-09-23.md](RESULT-four-stage-2026-09-23.md).

## Delivered behavior

The canvas draws exactly one connection for each unordered pair of top-level notes/groups with underlying cross-group relationships. Expansion does not add child wires, diamond boundary ports or boundary labels. The count opens a read-only contribution list with the original endpoints and labels, plus actions to inspect either note. Consistent directions have one arrowhead; contributions in opposite directions have both. Relationships within one group remain available through note details. Stored relationships, selected inputs and evidence are not rewritten by aggregation. Arrange no longer reserves the superseded boundary gutters.

Reasoning selection supports **Nebius Token Factory** and **OpenAI**, with a project default, stage overrides and task overrides. A task uses its nearest ancestor setting unless overridden; **Use inherited setting** removes an override. The default is Nebius `nvidia/Nemotron-3-Ultra-550b-a55b`. OpenAI offers `gpt-5.4-mini` and `gpt-5.4`. Controls appear in note details, focused assistant and research setup. Local language models are not offered. Local Docker, bounded Python and Nebius Sandbox remain separate execution choices.

Model settings persist in project-local records independently of canvas content. Node research, experiment planning, research-loop steps and assistant turns capture their selected provider/model before dispatch. OpenAI uses the official `openai` JavaScript SDK directly, with application-validated JSON contracts, no automatic retries and no Agents SDK. The supplied key is in ignored server-only `.env.local` with mode 0600; no key is included in client code or this report.

## Verification and limits

- Final `npm run build` passes, including TypeScript. The existing bundle-size advisory remains (about 624 KB JavaScript before gzip).
- The real browser confirms three aggregate banking links when collapsed and the same three after expansion; the three-contribution dialog preserves source/target names and original labels, including mixed directions.
- The real browser confirms stage OpenAI selection, child inheritance, a task-specific Nebius override, persistence after reload and reset to inherited selection. Both temporary overrides were removed; Nebius remains the project default. The note settings and separate execution controls were visually inspected.
- The OpenAI SDK made one successful read-only authenticated model-catalog request. Both advertised OpenAI model IDs are available to this credential. **No OpenAI inference request was made**, so generated output, provider error/cancellation behavior and actual token billing remain live-unverified.
- No unit tests were added or run, and no broad defensive suite or database audit was run, following the explicit fast-iteration request.
- The local service was gracefully restarted and is running at `http://127.0.0.1:4310` with paid admission disabled.

OpenAI has a separate explicit server-side authorization (`ROS_OPENAI_AUTHORIZATION_ID`, `ROS_OPENAI_AUTHORIZED_USD`, `ROS_OPENAI_MAX_REQUESTS`), defaulting to zero. Existing Nebius/Tavily grants are not transferred or reset. Published standard OpenAI rates checked September 23 are $0.75/$4.50 per million input/output tokens for GPT-5.4 mini and $2.50/$15 for GPT-5.4. The adapter selects the default service tier, disables reasoning and uses a conservative 272K context ceiling to stay below the full-model long-context pricing boundary. Conservative reservations and uncertain outcomes remain retained, distinct from provider billing/balances. Sources: [official pricing](https://developers.openai.com/api/docs/pricing), [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4), [official SDK quickstart](https://developers.openai.com/api/docs/quickstart).

No paid inference/search/sandbox session, purchase, account change, credit redemption, deployment or public write occurred in this update. Prior consumed scopes and remote-sandbox pricing limitations remain in the dated reports. No goal or automation was activated.
