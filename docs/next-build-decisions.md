# Research workspaces and local experiments — September 21, 2026

The next-build user prompt supersedes the foundation's code-execution deferral and narrow-inspector recommendation. The foundation result is preserved in [the dated result](../RESULT-foundation-2026-09-21.md); its live evidence is historical, not evidence for this revision. No autonomous goal or scheduled automation was activated.

## Scope and compatibility

`CanvasNode.kind` is optional and independently describes Topic, Activity, or Unspecified. `parentId` is optional and identifies a top-level node's workspace. Missing kind/scope fields retain their original bytes and mean Unspecified/project scope in the interface. The service does not infer whether an old node is a Topic or an Activity.

The project has one level of workspaces. Both kinds are valid at either scope. Children may be selected, edited, discussed and executed within their parent's workspace; they do not introduce a third nested canvas. A transaction validates this depth and its references before any structural write. Removing a parent removes its children and their relationships in one undoable transaction, preserving their identities, chats, runs, selections and artifacts. Undo restores the entire structure.

Relationships remain optional and stay within their canvas. Cross-canvas reuse uses an explicitly selected artifact version or exact excerpt. Neither connections nor structural acceptance starts a run or imports material. Proposals and direct changes retain one project revision/undo history, including changes inside workspaces.

The representation adds optional JSON fields and artifact kinds without rebuilding or rewriting historical tables. No migration of user rows is required. Existing SQLite/artifact storage and conservative provider reservations remain intact. A disposable legacy fixture verifies byte-identical project/history rows after reopening with the new schema. For any manual backup, stop the application and copy the complete data directory, including artifact bodies; do not reset accounting.

## Interaction choices

The project canvas stays left and an opened node's workspace occupies the right half. Expand/restore and narrow-screen switching are presentation state. Local browser state preserves selection, drafts and viewports separately from structural history. Artifacts are work products, not semantic Topic/Activity nodes. Data, code, logs, tables, metrics and plot cards are inspectable independently of the canvas's research structure.

The adjustable green token is a reversible visual default. Black text, white surfaces, clear borders and visible dots supply contrast without requiring color to communicate kind or state.

## Authority and external services

Local experiment permissions are separate from provider spending. The initial product mode is Ask for approval. Requests capture their precise code, dataset, parameters and runtime capabilities. Approval never grants arbitrary host access. Automated approval is unavailable unless a real policy reviewer is installed; reviewer absence is not permission.

The local worker uses the installed Python runtime and a bounded analysis language. It is not an unrestricted Python environment, an OS sandbox, or a security claim based on a worktree/virtual environment. See the current architecture and result for the verified implementation and limits.

NVIDIA Nemotron 3 Ultra is the preferred remote model. The historical Qwen configuration is not a fallback for that request. Fresh rate/access verification and new explicit paid authorization gate live checks; no historical allowance is recycled. Public documentation and authenticated catalog reads do not establish successful inference/tool behavior. Optional cloud jobs/endpoints remain research only, without provisioning or a remote control plane.
