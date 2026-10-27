# ros.ai Agent Instructions

## Read first

Read `README.md`, `docs/guide.md`, `docs/product-brief.md` and `docs/architecture.md` before implementation. Current user instructions take precedence.

## Product boundaries

- Use ros.ai for the product and ros-ai for repository/filesystem names.
- Build an exploratory research workspace, not an automation pipeline. Nodes work independently; connections do not imply scheduling, blocking, or automatic input import.
- Project and node conversations are separate. Manual content edits are direct and undoable; layout and view changes persist without entering content history or discarding redo. Agent-generated additions follow the selected project/Action approval mode and shared grant, with visible relation, provenance and undo history; Ask requires specific approval.
- Preserve the user's ownership of canvas structure. Use one expandable canvas where only explicit Groups contain blocks; Knowledge and Action are block kinds, not containers. Deeper Group nesting is allowed without cycles. Additional Actions inherit the project default and never replenish limits.
- The product is the downloadable local app: CLI-launched, served on loopback, with a browser frontend. The Railway deployment is only a quick demo and must not set local defaults. Nebius and Tavily calls are external connections. Keep credentials server-side.
- Generated code runs only in isolated Python, and the collaborator works within explicit permissions and resources. Beyond the curated public demo, hosted deployment remains excluded, except ros.ai cloud (sign-in and the free hosted-model gateway, approved by Adam on 2026-10-18; since 2026-10-22 in the separate private repository `arkdong/ros-ai-cloud`, under its own licence), which keeps the provider key server-side and leaves the local app working without it. Leave clear adapter boundaries for later models, database connections and confirmed Nebius sandbox access.
- Treat architectural recommendations as implementation defaults, not claims of completed code. Avoid wholesale harness-repository merging.

## Engineering and verification

- Inspect actual state and preserve unrelated or concurrent edits.
- Keep modules and interfaces focused on real consumers. Choose and document the concrete stack; add working setup, test, lint, build, and run commands when a runtime exists.
- Iterate fast without new unit tests, unit-suite runs or broad defensive suites (direction since September 23). Use the build/type check, a compact browser smoke and direct checks of affected calculations; preserve data and authorization safeguards. `npm test` is the historical suite and is not a gate.
- Verify the actual UI in a browser. Mocks support tests but do not establish live integration success.
- Adam prefers lean, focused verification: reuse passing checks and avoid repeating broad suites, full database comparisons, or build/restart cycles unless a concrete new change, failure, or risk justifies them. Preserve data and cost safeguards while verifying the affected behavior.
- Preserve model-visible request inputs and artifact versions, not claims of hidden reasoning or deterministic model replay.
- Keep long-running work state in project-local goal/worklog/result files when activated; documentation changes alone do not activate a goal.

## Safety and cost

- Never commit credentials, private keys, account data, or private personal data.
- Get explicit approval before deployments, purchases, account changes, or public/shared writes.
- Earlier verification allowances are historical, not authorization for new calls. Paid verification requires fresh explicit budget authorization. Use configured credentials only; do not purchase or redeem credits.
- Verify pricing/credit units, record usage and uncertainty, and stop live calls when the applicable remaining budget cannot be enforced conservatively. Continue unaffected local work. Consumed one-off exceptions (such as the September 23 beta smoke) do not relax general gates or authorize retries.
- No unrestricted shell, package installation, filesystem, or network tool may be exposed by the bounded experiment runtime. Approval policy and actual enforcement must be reported separately.

## Durable context

Project status and implementation truth belong in this repository: the README, `docs/guide.md`, `docs/architecture.md` and `docs/roadmap.md`. Strategy, pitch and dated build records are kept outside the repository.
