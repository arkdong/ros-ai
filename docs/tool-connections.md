# Local tool connections

AI models are set up on the **Model** page of the left icon bar, outside tools on **Plugins**, and every usage allowance on **Budget**. Each tool is a collapsible row with a connection and availability summary. Expand a row to manage its account; its allowance is on the Budget page. Account setup and research permission are separate: saving a key or signing in does not add spending allowance, select inputs, start research, or execute code. Private connection routes are unavailable in the public demo.

| Connection | Setup in this build | What connection status establishes |
| --- | --- | --- |
| Nebius Token Factory | Save an existing Token Factory API key, or set `NEBIUS_API_KEY` in `.env.local`. | Key presence; **Check key** requests the authenticated model catalog without starting inference. |
| Codex | Install the official CLI, then choose browser or device-code sign-in in the panel. | Native CLI/app-server sign-in and protocol support; research availability is checked separately. |
| Claude Code | Save an existing Anthropic API key, or set `ANTHROPIC_API_KEY` in `.env.local`, then save a Claude Code allowance. | Key presence; **Check key** lists models without starting inference. Choosing Claude Code in the assistant's settings runs turns. |
| Google Drive | Configure a local Google OAuth Web application, then complete Google consent yourself. | A saved read-only grant; CSV listing and explicitly selected captures use that grant. |

## Visible usage allowances

Nebius, direct OpenAI, Tavily and Claude Code show their local ros.ai **total USD ceiling**, **retained usage**, **remaining USD**, and **request ceiling/remaining requests**. These allowances cover inference or search across all ros.ai projects in this data directory. They are application admission limits, not provider account balances, invoices, or account-wide billing caps. Account credits and reported token/search-credit usage remain separate.

To authorize application use, enter a total ceiling and maximum request count, acknowledge that the allowance permits external requests, and explicitly save it. Your first save creates a separate fresh app allowance; its **Reserved** figure covers that allowance, while historical environment usage stays preserved in **Budget & usage**. Later edits, pause, credential replacement, restart, and project switching do not reset its retained use; failed, cancelled, or uncertain dispatched requests retain conservative reservations. USD/request ceilings cannot be below retained use. **Pause usage** blocks new admissions without refunding previous use or falling back to an environment grant. Already dispatched provider requests can still finish. Historical comparison mode cannot use an app allowance; its exact environment scope remains enforced until that mode is removed from server configuration. The separate legacy combined Nebius/sandbox ceiling and remote execution's pricing/approval gates are unchanged: saving an inference allowance does not authorize a remote sandbox attempt.

Codex instead shows **turns, runtime seconds, and tool-call allowances**, with per-turn time/tool limits and an explicit authorization acknowledgement. First enable snapshots the current project's saved notes and immutable artifact IDs; later numeric edits retain that scope. New cards and artifact versions are not automatically included, and grouping or focus does not broaden it. **Pause usage** blocks new turns and requests Stop for an active turn; full reservations remain. Ceilings cannot be below retained use, including earlier Codex admissions in this project, and edits/restart never reset them. These units are not dollars or a cap on hidden provider requests or subscription billing. One admitted agent turn consumes one project model-request unit and its reserved runtime/tool allowance. A USD ceiling alone neither authorizes Codex nor resolves a missing isolation boundary.

Google Drive has no model allowance: the visible limits describe read-only CSV access and the 500,000-byte capture maximum. Connecting it does not create a model-research budget.

## Plugins

The **Plugins** page lists outside tools. Google Drive uses the OAuth setup above, and Google Docs uses the same read-only Drive grant. Zotero (API key), Slack (bot token), Notion (internal integration secret) and GitHub (fine-grained personal access token) each take a token the user creates in that service. Tokens stay in the owner-only `plugin-tokens.json` in the data folder; the browser only sees whether one is saved. **Check** makes one read-only identity request (Zotero `keys/current`, Slack `auth.test`, Notion `users/me`, GitHub `user`). Tavily web search moved here from the model list; its allowance is on Budget. Overleaf is shown as not available yet: it has no public API and its Git integration needs a paid plan. Connecting a plugin does not yet let the canvas or assistant use it.

## Assistant model selection and project setup

The assistant uses one custom model picker. Each option shows the model maker's symbol and name, grouped by the API connection that serves it: NVIDIA Nemotron and Moonshot Kimi through Nebius, OpenAI GPT through the direct OpenAI API. Maker identity and serving connection are separate. The picker retains the supported model IDs, project default and explicit block/Group inheritance. Arrow keys, Home/End, Enter and Escape are supported; **Model details** retains exact IDs, scope and key presence. It offers supported models rather than accepting arbitrary unverified IDs.

The assistant's settings button holds the API-model/Local-Codex choice, connection setup, research permissions and full admission diagnostics. The conversation shows one short current blocker; historical failures and saved-record fallback responses retain their full original text under disclosures. A known-blocked model send is disabled and the draft remains saved. No budget/model/settings edit sends or retries a message. Existing saved-record server behavior and stored conversations remain intact.

If provider usage is disabled, **Open Model** leads to its existing explicit allowance controls. Codex's isolation failure leads to **Choose API model**, because spending limits cannot fix missing read isolation.

For the audited Ultra scalar-text request shape, local reservation counts the exact serialized wire body plus conservative chat-template margins; it no longer assumes every short prompt uses the full published context. Other models and request shapes retain full-context reservation. Nebius uses the documented total `max_completion_tokens` cap (visible output plus reasoning), one choice and no parameter fallback or retry. See the [Nebius completion reference](https://docs.tokenfactory.nebius.com/api-reference/inference/create-chat-completion) and the [pinned audit and limitations](../evidence/token-reservation-2026-10-01.json). Current hosted template/cap compatibility has not been verified by a live call; rates and availability are checked from the authenticated catalog before each admission.

## Nebius

Get the key from your chosen project in Token Factory's API keys page, following the [official quickstart](https://docs.tokenfactory.nebius.com/quickstart). Save it under **Nebius Token Factory → Connect**. This implementation uses `https://api.tokenfactory.us-central1.nebius.com/v1`.

**Check key** sends only a catalog GET. A successful check does not establish access to a particular inference model, balance, invoice, or an account spending cap. Research still needs the visible cumulative provider allowance and applicable approval. See provider verification for the existing accounting limits.

## Codex

Follow the [official CLI setup](https://developers.openai.com/codex/quickstart), then open a project and **Codex → Connect**. Browser sign-in and device-code sign-in are user-controlled native app-server flows. You can instead run `codex login` or `codex login --device-auth` in your own terminal. Device-code availability depends on your account/workspace settings. See [official authentication guidance](https://learn.chatgpt.com/docs/auth).

Codex owns its credentials; ros.ai does not copy its auth cache or treat its subscription token as an API key. Signed-in, protocol-configured, authorized, and available are distinct states. Embedded research requires enforced restricted read roots, disabled host tools, and the explicitly saved bounded turn/time/tool allowance. Missing isolation keeps turns blocked even after you save an allowance. Status checks submit no inference and do not verify model entitlement; application turn limits are not a provider billing cap. The current adapter supports native ChatGPT authentication, with direct OpenAI API access kept separate. The [official app-server documentation](https://learn.chatgpt.com/docs/app-server) describes different requirements for hosted or commercial integrations; this connection is local. See the dated implementation record.

## Claude Code

Claude Code can be the project assistant. It runs through Anthropic's [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), which ships with ros.ai (`npm ci` installs it), so no separate `claude` install is needed.

1. Save an [Anthropic API key](https://platform.claude.com/settings/keys) on the **Model** page under **Claude Code**. API billing is separate from a Claude subscription.
2. Save a usage allowance (total USD and requests) on the same card. Its model and effort are under [Model and effort](#model-and-effort-for-claude-code-and-codex).
3. In the assistant, open settings and choose **Claude Code**.

Each turn reserves up to US$5.00 of the allowance (`ROS_CLAUDE_TURN_USD` changes it, up to 20) and passes that amount to Claude Code as the turn's budget. A turn that finishes is then counted at the cost Claude Code reports at Anthropic's published rates, an estimate rather than an invoice. A stopped, failed or uncertain turn keeps its full reservation.

What it can do, enforced by ros.ai rather than by instructions:

- Read, Glob and Grep inside the project folder only. A check before every tool call refuses paths outside the folder; a project without a folder gets no file tools.
- Propose canvas changes, artifact reuse, analysis code and report revisions through the same `ros_*` tools as Codex. They follow the project's permission choice, and code runs only in ros.ai's sandbox.
- No shell, file writes, web access, subagents, skills or MCP servers from your own Claude Code setup.

The session gets its own config folder inside ros.ai's data folder and only the saved API key. ros.ai stops the turn if Claude Code reports any other credential source. Claude subscription sign-in is deliberately not offered: Anthropic requires API authentication for third-party applications unless subscription-login use has prior approval. Each turn's prompt, tools, model, reported cost and events are saved with the turn. Follow-up turns in the same project resume the same Claude Code session.

## Model and effort for Claude Code and Codex

Each of the four agents ros.ai runs (Claude Code and Codex, each on a subscription or on an API key) keeps one model and one effort for all projects. Pick them on the agent's card on the **Agents** page, or from the chip beside the agent in the Ros bar; both show the same choice. The chip shows the model with the effort as five bars, and its menu names the level.

- **Claude Code** offers the models its own Agent SDK lists (Opus, Fable, Sonnet and Haiku), read once from the bundled Claude Code with no key and no network, at Low, Medium, High, Extra high or Max. ros.ai passes them as Claude Code's `model` and `effort` options. Sonnet is the default.
- **Codex** on the ChatGPT subscription offers the models the installed Codex CLI lists (`model/list`) and starts from the model and `model_reasoning_effort` in your own Codex settings until you pick one here. Each turn sends the choice with `turn/start`.
- **Codex (API key)** stays on the models ros.ai prices, GPT-5.4 and GPT-5.4 mini, at Low, Medium or High.

A new model starts on its own default effort. Higher effort thinks longer, so a turn is slower and uses more of a plan's limits or costs more on a key. A finished turn names what it ran with, for example "Claude Code · Opus 5.5 · High".

## Google Drive

In your own Google Cloud project, enable the Drive API and configure the OAuth consent screen, including your account as a test user when applicable. Create a **Web application** OAuth client. Register the exact callback URI displayed in the panel; the default is `http://127.0.0.1:4310/api/connections/google-drive/callback`. `localhost` and `127.0.0.1` are different registered URIs, and a changed `ROS_PORT` changes the callback. Follow Google's [web-server OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server).

Save the client ID and secret in the Google Drive setup form (**OAuth app settings** when already configured). Alternatively set `ROS_GOOGLE_CLIENT_ID` and `ROS_GOOGLE_CLIENT_SECRET` in ignored `.env.local` and restart. Saved app settings override these environment values. Changing the OAuth client disconnects the local grant. Select **Continue to Google** only after reviewing the permission disclosure, then complete Google's login and consent in your browser.

The requested `drive.readonly` scope permits reading and downloading **all** Drive files; it is a restricted Google scope, not per-file consent. The panel discloses this before Connect. ros.ai limits its own operations to CSV metadata listing and explicit CSV downloads, with no Google uploads, edits, sharing, deletion, or automatic sync. Google's [scope reference](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) explains the broader permission and per-file alternatives.

Browse or search CSVs and select **Import** for the current project. Captures must be non-empty UTF-8 CSVs no larger than 500,000 bytes; Google Sheets/Docs export is unavailable. Import stores a local resource with its Drive file ID, version/modification metadata, source URL, timestamp, and SHA-256 content hash. Later use as a dataset preserves that source record. Import does not automatically select research inputs. Files changing during capture are rejected. **Disconnect locally** removes the local token file, retaining imported evidence and OAuth app settings; it does not revoke access in the Google account.

## Private storage and verification limits

The data directory is the one printed at startup: your explicit `ROS_DATA_DIR`, an existing repo-local `.ros-ai/`, or else the computer's app-data folder (macOS `~/Library/Application Support/ros.ai`). API keys are in `tool-credentials.json`; Google app configuration is in `connections/google-drive-client.json`, and access/refresh tokens in `connections/google-drive.json`. These files are written with owner-only `0600` permissions and remain unencrypted local secrets. They are rejected on unsafe reads; Google storage also rejects redirected files/directories. API responses expose presence, source, and bounded status messages, never saved keys, client secrets, or tokens. Keep a custom data directory private and outside version control.

Removing a saved API key restores any startup environment value. Google token refresh runs only on the server; pending login uses S256 PKCE and a one-use state bound to an HttpOnly browser cookie. Google requests use fixed HTTPS endpoints, bounded responses/timeouts, and no redirects. The implementation was checked with disposable offline HTTP responses and UI setup inspection. No live Google OAuth/capture, Claude inference, or newly authorized provider research call is claimed by those checks.
