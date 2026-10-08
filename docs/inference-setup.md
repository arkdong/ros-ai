# Personal inference connections and Workspace guide

Delivered local implementation · October 2, 2026. This setup extends the [October 1 design](inference-design-2026-10-01.md); its optional ros.ai Nemotron package remains future work. Built-in Nebius and OpenAI selections keep their existing identities and settings. The new registry adds user-configured compatible HTTP endpoints to the private local workspace.

## Add your model connection

Open **Model** in the left icon bar, find **Local models and other servers**, and choose **Add a local model or server**. **Ollama** and **LM Studio** fill in their usual local addresses. Enable the connection's requests on the **Budget** page.

1. Enter a connection name and **API base URL**. A server you already manage might use `http://127.0.0.1:8080/v1`. ros.ai sends text requests to `/chat/completions` beneath the supplied base; an endpoint already ending in `/chat/completions` is also accepted. Remote endpoints require HTTPS. HTTP is accepted only for `localhost`, `127.0.0.1` or `::1`. Endpoint queries, fragments and embedded credentials are rejected.
2. Enter the exact model ID your server accepts, a readable display name, its maker and declared context capacity. Up to 16 models can share one connection. Maker symbols describe the model author; they do not establish where it runs. The adapter uses scalar text messages and a non-streaming chat-completion response, with optional JSON instructions validated by ros.ai. Other protocols, arbitrary tools and automatic model fallback are unsupported.
3. If needed, supply an API key. The adapter sends it as a Bearer credential. Full endpoints and keys are kept in the data directory's owner-readable `inference-connections.json`, separate from the masked database registry. Readable status exposes the endpoint origin and key presence, never the saved key or endpoint path. When editing, leave the key empty to retain it, or explicitly remove it. Keep this private file intact when backing up the workspace.
4. Set **Request limits** and acknowledge the destination/configuration, then choose **Save configuration**. Saving performs no endpoint probe, model download or inference. A saved configuration has a separate usage allowance before it can send requests. Changes take effect without restarting the app.

The current frontend defaults are 64,000 input bytes, 2,048 output tokens, a 90-second deadline and one concurrent request. Bounds apply to the complete serialized request, including injected response instructions.

| Setting | Accepted bound |
| --- | --- |
| Declared model context | 256–8,000,000 tokens |
| Complete input | 256–64,000 UTF-8 bytes |
| Requested output | 1–32,768 tokens; below every configured model's context capacity |
| Deadline | 1–300 seconds; application deadlines can be shorter |
| Concurrent requests | 1–4 per connection |
| Transport response | 128,000 bytes by default; configurable through the API up to 512,000 bytes |

Context capacity, tokenization and the endpoint's handling of `max_tokens` are declarations, not verified model behavior. ros.ai enforces its byte, deadline, response and concurrency limits. A byte/context guard can reject a request before admission; select less context rather than assuming a different tokenizer or silently changing models.

For a remote endpoint, provide explicit conservative input and output **USD per million tokens** for every model. Both rates are required, and at least one must be positive. These are operator-supplied upper rates, not an account balance, invoice or verified price. A billed remote service must not be represented by a zero-cost loopback declaration. Unrepresented billing terms cannot be assumed free.

## Enable bounded usage separately

Open the saved connection's **Usage allowance**. Set a **Total request ceiling**, and for remote inference a positive **Total USD ceiling**. Acknowledge the specific endpoint and choose **Save and enable usage**. This authorizes bounded requests across your local ros.ai projects; it starts no model call.

Ceilings are cumulative totals, not extra credit on every save. Previous admissions and conservative reservations remain accounted after failure, Stop, pause, edits, key replacement, removal and restart. Removing configuration deletes its private endpoint/key while preserving its identity and accounting. Restoring a previously configured endpoint uses that retained identity. Raising a ceiling keeps prior use; lowering it below retained usage is rejected. Use **Pause usage** to stop new dispatch.

For registered remote inference, ros.ai reserves twice the full declared context multiplied by the sum of the input and output per-token upper rates. It reserves full output context because hidden or billable reasoning limits are unverified. Accounting retains at least that reservation, or a higher reported-cost estimate. Failed or uncertain requests are not refunded automatically. **Budget & usage** records captured requests, reported usage, bounded visible responses and uncertainty; it does not represent provider credit.

Loopback requests debit no provider USD in ros.ai, but still consume the connection request ceiling and the project's shared model-request limit. If a previously remote connection becomes loopback, historical USD accounting remains retained. **Local endpoint · processing unverified** means the server is user-managed: a loopback URL does not prove offline operation, restricted tools or private processing.

The project's stopped state applies to both research and guide requests. Projects have no spending ceiling of their own; the connection allowance caps paid calls, and additional Actions, retries and model changes never replenish it. Connection terms are rechecked after preparation and at atomic admission, so an edit or pause prevents dispatch under old terms. A busy connection blocks new admission before consuming another allowance.

Built-in Nebius, OpenAI and Tavily retain their separate setup and accounting rules; see [tool connections](tool-connections.md). Registering a personal endpoint does not enlarge a historical comparison or sandbox grant.

## Choose Research model and Workspace guide independently

The assistant's **API model** connection uses the main model picker. Choose a built-in model or a model from an enabled registered connection. Project defaults and block overrides retain ownership inheritance through Groups; **Use inherited model** clears only that block's override. Changing a model starts no research and grants no spending permission. An unavailable saved selection stays unavailable until you deliberately choose a replacement.

The separate **Local Codex** assistant connection uses its existing native runtime and isolation gates. It does not use the API model picker to configure Codex's own model or processing destination.

Choose **Review workspace** for the Workspace guide, then open **Guide connection** settings. Select a registered connection and model explicitly. This choice is separate from the Research model; selecting one does not silently invoke or configure the other. There is no automatic cloud fallback or second-model review on every research message.

## Review only the selected context

**Structure** starts with selected block kinds, containment and topology under temporary aliases. Private titles, descriptions, relationship wording, real workspace IDs/hashes, chats, memory, artifacts, code and raw errors are excluded unless corresponding content is explicitly included. Alias mappings stay local.

The review form can include selected title/description/relationship fields, up to 20 selected block texts, and up to 20 exact saved evidence versions or excerpts. Block descriptions and evidence content are limited to 6,000 characters each; the captured manifest records omissions and selected artifact hashes. A typed review request is deliberate content inclusion. Metadata can be private too. The assembled packet is limited to 42,000 bytes before the model instructions and connection byte cap are applied.

**Inputs and outputs** can propose a saved version as a block input. **Conclusion** requires selected evidence and either selected block text or a deliberately typed question; structure alone cannot substantiate a conclusion. Before starting, inspect the context summary and acknowledge the displayed model/destination. Changed connection/model terms require fresh acknowledgment. The server captures an immutable snapshot before inference and checks the acknowledged connection revision again before dispatch.

Replies show the returned model identifier when available and the configured destination, with unverified loopback processing labelled explicitly. The review retains its context manifest and links to any available usage receipt. Invalid action format keeps the bounded reply and diagnostics while applying no guessed actions. Model mismatch and unsolicited tools retain captured receipts; transport failures retain reservations and uncertainty. **Stop** cancels the request; it does not prove the endpoint performed no work or incurred no charge. Restart interrupts unfinished reviews, and another review requires a deliberate request.

Canvas suggestions use the existing validated proposal, approval and history path. **Ask every time** requires specific approval. A changed workspace prevents stale proposals while retaining the reply. **Use as input** is separate explicit acceptance of an exact saved artifact/version and optional excerpt; it selects evidence without starting downstream research or importing future source changes. Relationships organize meaning and never schedule execution.

## Delivery boundary

This iteration provides the server-owned registry, compatible text HTTP adapter, registered model picker integration and explicitly scoped guide reviews. It does not ship or install an optional Nemotron weights/runtime bundle, establish verified local processing, train or fine-tune a checkpoint, or add further CLI protocols. Those parts of the October 1 design remain future work.

Existing Codex authentication, bounded grants and restricted read-isolation requirements remain enforced; a new HTTP connection cannot bypass them or expose arbitrary shell execution. See [Codex integration limits](codex-local-agent-2026-09-30.md). No hosted deployment, model purchase or new external verification allowance follows from this setup documentation.
