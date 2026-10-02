# Local Codex agent integration · September 30, 2026

ros.ai now has a full-agent seam separate from the OpenAI/Nebius model API adapters and isolated Python execution. `CodexAgentService` uses the official newline JSON-RPC app-server transport. It implements initialize, account/config inspection, selected-context dynamic tools, scope-bound thread start/resume, streamed replies/progress, tool and usage captures, denial of host/external approval requests, interruption and terminal outcomes. No inference request was authorized or sent while building this integration. Streaming, cancellation and live model/tool behavior therefore remain unverified against an actual inference turn.

## Observed connection and current blockers

Read-only checks on this machine found Codex CLI **0.141.0**, signed in with ChatGPT. The app-server initialize, `account/read` with `refreshToken:false` and `config/read` succeeded. Generated schemas include dynamic tools and interruption. The installed schema does **not** include restricted read-root access. A read-only sandbox alone permits broader host reads, so this adapter fails closed before inference when that capability is absent. Current official documentation describes restricted read roots; documentation availability is not proof that the installed binary enforces them.

The process-only overrides were checked through app-server configuration: shell/exec, snapshots, apps, plugins, browser/computer use, hooks, subagents, image generation, workspace dependencies and memories are disabled. Inherited MCP servers were detected and a second read-only connection verified they were all disabled. The execution path checks current effective settings again before thread creation. ros.ai neither changes the user's persistent Codex configuration nor copies its credentials. The server child receives an allowlisted environment excluding ros.ai provider keys.

There is also no fresh bounded Codex inference grant configured. Installed, signed in, protocol configured, authorized and available are distinct connection states. Account detection does not verify model access or a successful agent turn. Claude Code **2.1.173** was installed and signed out; no embedded Claude adapter is claimed.

## Selected context and validated effects

`AgentWorkspaceTools` captures only explicitly selected block IDs and exact selected artifact IDs/hashes. Connections and grouping never expand the capture. Artifact pages can be read through `ros_read_selected`; reads retain hash, producing attempt and captured time. The initial preview is bounded and the complete saved content remains accessible through pages.

The other tools propose canvas/group/block edits, explicit artifact reuse, bounded analysis and report revisions. All mutations use existing store validation and project approval/resource policy. Destructive group removal requires every affected descendant to be selected. Artifact pointers and group highlights must reference captured versions; highlights retain the actual source block/hash. There is no arbitrary SQL, path, host shell, network or package API.

`ros_propose_report` saves a pending full draft and exact source/evidence manifest. Specific acceptance checks revision and hashes and calls the report editor to create a derived immutable artifact. Its provenance identifies a model claim and the accepted agent proposal. A pending report is not presented as a committed result. The report surface preserves the source version and exact evidence links. This tool seam can support another agent transport, including a later local MCP surface; a standalone MCP server is not implemented in this iteration.

Captured requests, visible output, dynamic-tool arguments/results, reported usage and artifact versions are retained in `agent-attempt` records. Hidden reasoning and deterministic replay are not claimed. The client does not automatically repeat an RPC or resume an uncertain submission; interrupted/failed/uncertain records and full reservations survive restart.

## Grant admission

Connection checks need no inference grant. Turns require `ROS_CODEX_GRANT_JSON` supplied after fresh explicit user authorization. It contains fixed `id`, `authorizedAt`, `expiresAt`, `scope`, `projectIds`, `nodeIds`, `artifactIds`, `maxTurns`, `maxRuntimeSeconds`, `maxToolCalls`, `perTurnSeconds` and `perTurnToolCalls`. The grant is a single persistent ledger across its projects. Changing terms under a used ID, changing focus/grouping, starting another Action, failure or restarting cannot replenish it.

Each admitted turn reserves its entire wall-time and tool-call allowance and one shared project model-call unit before submission. That project unit identifies an **agent turn**, not an asserted count of internal model API requests. Application turn/time/tool ceilings are not a token or USD billing cap. This path accepts ChatGPT-plan authentication; API-key agent execution stays blocked until a separately enforced priced admission exists. The direct model API providers retain their own budget gates. Native Codex authentication is used through an in-process-only custom Responses provider with `requires_openai_auth:true`; request/stream retries are set to zero without reading or repurposing OAuth tokens.

No grant was installed, reset or enabled during this build. Even a grant does not bypass a missing enforcement capability. An updated CLI with restricted read-root enforcement, or a separately verified isolation boundary, is needed before this machine's embedded turn can be admitted. Updating the CLI/account was outside this iteration.

## Local verification

TypeScript checked successfully. Direct disposable-store checks established that a selected frame cannot remove an unselected child; report proposals create no artifact before explicit acceptance; accepted drafts retain exact evidence and model-claim provenance; a single grant cannot replenish by switching projects; changed terms under the same used ID are rejected; full wall-time reservations accumulate. These checks sent **zero model requests** and are not live agent integration evidence.

The local browser connection panel uses `GET /api/projects/:id/agents` and a deliberate refresh through `POST /api/projects/:id/agents/check`, both returning `{connections:[status]}`. Existing local startup commands remain `npm run build` and `npm start`. The app still binds to loopback.

## Official guidance consulted

- [Codex app-server](https://learn.chatgpt.com/docs/app-server): custom-client conversations, streaming, approvals, cancellation, experimental dynamic tools, generated protocol schemas, native account inspection and restricted read access. The official page distinguishes local/open-source authentication from commercial or hosted services.
- [Codex authentication](https://learn.chatgpt.com/docs/auth) and [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk): authentication remains Codex-owned; app-server suits a rich local client.
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference): tool feature configuration, custom provider authentication and retry controls. Installed support was inspected instead of assumed from current documentation.
- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) and [programmatic CLI](https://code.claude.com/docs/en/headless): embedded third-party subscription login requires Anthropic's prior approval; API authentication and a user's external CLI workflow are separate paths.
