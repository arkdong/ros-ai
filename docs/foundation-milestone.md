# Foundation milestone

This dated checklist describes the foundation, not the later September 21 workspace/experiment build. Its original result is preserved in [RESULT-foundation-2026-09-21.md](../RESULT-foundation-2026-09-21.md). Current implementation and verification are in [RESULT.md](../RESULT.md).

Defined September 20 and completed September 21, 2026. This is the canonical bounded build checklist; [RESULT.md](../RESULT.md) maps actual evidence and limitations. Event preparation remains in the vault Inbox.

## Outcome

A local CLI-launched browser application for independent research nodes, with an aligned canvas, two conversation scopes, accepted structural proposals, real Nebius/Tavily research, and persistent inspectable history. It must support different investigations without changing application code.

## Acceptance checklist

- [x] Document and verify installation, ignored credential configuration, and one-command local startup.
- [x] Build the project/chat sidebar, expandable dotted grid, snapping node cards, pan/zoom, and resizable node inspector.
- [x] Support direct node/connection edits and undo/redo without destroying historical run references.
- [x] Persist separate project conversations and research conversations inside nodes.
- [x] Generate real Nebius-backed structural proposals; preview/dismiss leaves committed state unchanged, acceptance is atomic, and stale edits are detected.
- [x] Execute model-only research and Tavily-assisted research in independent nodes without graph scheduling.
- [x] Show progress, selected inputs, artifacts, evidence, failure, cancellation, and retry history.
- [x] Allow concurrent node work under a modest cap; stopping one does not cancel another.
- [x] Share only explicitly selected artifact versions/excerpts with another node, preserving origin.
- [x] Preserve projects, layout, connections, chats, runs, and artifacts after restart; uncertain interrupted calls are not automatically repeated.
- [x] Inspect previous canvas states and run inputs/results without overwriting the current project.
- [x] Record model-visible requests, available provider/model metadata, tools, outputs, usage, and cost basis; identify unsupported evidence/metadata honestly.
- [x] Keep model adapters distinct from full agent-runtime adapters; demonstrate replaceability through contract tests without presenting mock integrations as live.
- [x] Verify the real UI in a browser, including a narrower viewport, and save representative screenshots.
- [x] Exercise two materially different investigations without a prescribed Literature → Findings template.
- [x] Report actual live integration checks, costs/estimates, unresolved failures, and launch instructions.

## Verification approach

Use focused behavioral tests for changes/undo, proposal acceptance/conflicts, input versioning, conversation isolation, restart, cancellation, retries, and budgets. Use local test providers for repeatable failure scenarios, but real provider smoke tests are necessary before claiming integration success.

Nineteen behavioral tests pass. Actual Chromium desktop/narrow checks, clean restart equality, fresh no-credential setup and bounded real Nebius/Tavily calls pass. Failure/cancellation/timeout contracts use labelled local test providers; live integration claims use actual provider evidence.

## One-time verification budgets

The user intends to fund US$20 in Nebius Token Factory and US$10 in Tavily for the initial build. Treat these as separate ceilings, not targets, transferable balances, recurring grants, or proof that funding is already available. Both credentials are now configured locally; see [provider setup](local-provider-setup.md) for the limited live verification completed.

Verify provider pricing/credit units and usage evidence before live calls. Reserve conservatively for requests in flight and stop before a ceiling can be exceeded. If reliable budget admission cannot be established, stop live verification and report the missing evidence. Never purchase credits, change plans, or redeem Codex reset credits.

## Deferred

- Agent-generated code execution and its sandbox.
- Full live Codex/DeepSeek runtime integration; retain the adapter seam.
- NVIDIA-specific capabilities pending a concrete use case/provider choice.
- Hosted deployment, accounts, cloud synchronization, Firebase/Supabase.
- Full historical branch/merge workflows, distributed scheduling, and a plugin marketplace.

## Handoff and goal status

The September 20 overnight brief activated this build through an explicit user goal request. [GOAL.md](../GOAL.md), [WORKLOG.md](../WORKLOG.md) and [RESULT.md](../RESULT.md) preserve scope, progress and completion evidence. The goal is achieved; deferred work is not presented as implemented.

Keep project-local implementation progress and a final result report. Keep event eligibility, event-day model comparisons, and submission preparation in the existing Inbox note rather than duplicating them here.
