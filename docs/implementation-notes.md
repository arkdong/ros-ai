# Implementation notes

## September 23, 2026 — canvas behavior, identity and budget visibility

`shared/canvas-reflow.ts` keeps a stable sibling-order/gap plan and settles measured card/visible-result footprints from children outward when displayed size changes. Expansion, collapse, density/page changes, saved resizing and content-driven measurement changes trigger a debounced presentation batch. Manual movement and Arrange establish a new plan; initial loading establishes measurements without rearranging saved positions. Redundant distant spacing is removed from the constraint plan so shrinking groups reclaim expansion-created space while deliberate manual gaps remain. Reflow retains negative roots, nested containment, viewport and focus, defers during pointer previews/animation, and does not fit the canvas or issue per-frame writes.

Canvas history now distinguishes content from presentation. The store compares semantic node fields and relationships while excluding x/y/width; layout-only saves retain current preferences without content revision, change rows or redo truncation. Undo/Redo skips legacy layout-only stack entries and preserves current presentation in the applicable parent scope. Legacy rows remain stored. `shared/content-timeline.ts` also indexes validated saved result/plot/table/metric/dataset versions as evidence milestones; these open artifacts without making execution undoable or deleting run, authority or spend audits.

The supplied wordmark and ring PNGs are bundled in `public/brand/`. A proportional CSS window removes the wordmark’s transparent padding from display; the original artwork is unchanged. The ring replaces the assistant signal and top-right assistant toggle and is also the favicon. Accessible labels and active states remain. Browser titles follow project selection/rename as “Project name · ros.ai” or use “ros.ai — Research workspace” with no selection.

The battery opens a mutually exclusive right-side Budget & usage panel. Its read-only project endpoint projects policy counters, attributed provider usage, sandbox admissions and shared admission summaries without exposing provider traces or authorization IDs. Combined admissions are not double counted. Last hour and Last 24h are rolling windows; Today uses browser-local midnight, including DST. Known estimates, missing costs, reported tokens/search credits and retained reservations stay distinct; raw sandbox cost is never converted from unknown units. Provider account credit remains unknown. Local refreshes change no permissions and call no paid service.

## September 23, 2026 — demo navigation and disclosure

Root cards can be moved above and left of the origin. `shared/canvas-position.ts` preserves negative root coordinates and converts child positions through the group content inset, clamping only nested notes. Explicit Arrange retains a negative root anchor. These preferences persist separately from content undo; opening a project does not rearrange it.

Expanded groups default to two result cards and offer Show 4 or All, with arrows and page dots. `shared/result-pages.ts` bounds invalid or outdated page choices and preserves the first visible result when changing density where possible. Per-node choices are local browser preferences. Compact pages retain all artifacts and support dragging into another group for explicit reuse; drops within the current group do not write a hidden position or move a highlight. All keeps existing free placement. Group footprints and explicit Arrange account for the visible page.

The Research outline uses a distinct original-question anchor, collapsible directions and indented findings. `shared/outline-hierarchy.ts` nests actual node parents and uses explicit finding ownership or verified saved reference identities for associations. Findings involving multiple directions appear once under Across directions; unassigned findings stay separate. Connections never imply ownership. Short summaries keep full text and evidence navigation accessible, and disclosure state persists locally without changing conversation or focus behavior.

Resources is a visible, collapsible, independently scrollable sidebar section. It lists linked files, project copies and captured sources/datasets with origin/version labels. Add file accepts UTF-8 CSV up to 500,000 bytes: an explicit absolute path uses a read-only local connection; a browser-selected copy is retained in project SQLite records. Preview shows current linked contents or a saved copy. Use in note captures the linked file's version at use time, captures a project copy, or selects an existing immutable artifact; it neither writes to the original nor starts research. A linked file can change between preview and capture. Existing exports and legacy connection controls remain available.

Permissions place approval mode, scope and main limits first, with additional restrictions and limits behind disclosures. Inspector Note settings holds kind and per-Action permissions. Experiment screens lead with pending approvals and saved results; exact code/data, runtime, parameters and planning remain available through disclosures. These are presentation changes; approval fingerprints, stale checks, resource admission and server enforcement are unchanged. Current verification remains separate in [RESULT](../RESULT.md).

## September 23, 2026 — outcome cards and relationship direction

Collapsed cards show their title and a softly colored, text-labeled outcome section. `shared/card-outcome.ts` selects one or two bounded sentences from saved results, with scalar-metric and table/plot fallbacks. It distinguishes saved evidence from execution, keeps later progress/failures visible, and reports explicit blockers. Purpose or progress appears before results exist. The separate generic description is omitted from collapsed outcome cards; full descriptions, inputs, execution details and immutable artifacts remain accessible through expand/details. This is deterministic presentation, with no inference call or saved-content rewrite.

`CanvasNode.width` is optional and validates as an integer from 320 to 720 px. Existing records without it display at 408 px. Pointer and keyboard resizing persist across restart as presentation-only mutations and do not change execution authority. Approval comparison excludes width along with x/y while preserving all other context/runtime/data checks. `shared/card-size.ts` estimates an initial footprint; the browser's `ResizeObserver` measures actual wrapped content and clamps card height to 224–420 px. Longer outcome text scrolls inside its section. New insertion uses variable widths and a conservative 420 px height, retaining the existing placement gap.

Relationships show arrowheads. `shared/relationships.ts` derives source-to-consumer display direction for exact recognized inverse labels, swapping endpoints and handles together so deliberate sides remain attached to their notes. Stored connections are unchanged until an explicit label edit, which saves the displayed direction with the new wording. Unknown labels keep their original direction and semantics. The outline uses relative labels such as “Provides data to → Monthly analysis” and “Data from ← KNMI observations”; arbitrary relationships show their full source → target direction.

Arrange runs only on explicit request. It ranks recognized sources above consumers, handles nested branches and measured group/artifact footprints, and collapses strongly connected components when relationships form cycles. Notes within a level retain spatial reading order; disconnected/free-form notes use ordinary reading-order placement. Saved manual positions remain untouched on project load; Arrange and the subsequent size-change reflow save presentation without content history. No relationship grants permission, imports evidence or schedules execution. [Architecture](architecture.md) documents current mechanics; [RESULT](../RESULT.md) holds verification evidence separately.

## Historical foundation decisions — September 20, 2026

**Historical foundation record.** The sections below preserve the completed foundation's original stack, card dimensions and execution boundaries. Later builds use one expandable canvas and add bounded/local and explicitly gated remote execution. Current behavior, controls and limits are in [architecture](architecture.md), [next-build decisions](next-build-decisions.md), and [RESULT](../RESULT.md). The no-code-execution statements below describe the completed foundation only.

This is pre-event application development. No event eligibility, approved-model status, or permission to submit advance work is asserted.

## Concrete stack

- Node.js 24+ and TypeScript, launched by `tsx`; Node's built-in SQLite avoids a native third-party database installation. This module is release-candidate/experimental depending on Node version; validated runtime is recorded in RESULT.md.
- Express 5 owns the loopback HTTP boundary and serves a built browser interface. The default launch builds missing frontend assets; `npm run dev` opts into Vite middleware for local development.
- React 19 and React Flow implement an unbounded viewport, explicit relationships, 24px snapping, and consistent 240×144 node cards. React Flow is presentation only and has no scheduling authority.
- Zod validates structural operations and request boundaries. SQLite stores separate records for projects, changes, conversations, proposals, runs, selections, and provider reservations. Artifact bodies are stored by hash on disk.
- `npm ci` installs the lockfile. `npm run lint` is TypeScript strict checking; `npm test` uses Node's test runner through tsx; `npm run build` checks types and creates browser assets.

Dependencies were chosen for implemented needs. No Codex or DeepSeek source was copied, vendored, or linked as a runtime dependency. The pinned comparison informed ownership of request snapshots, cancellation, policy, and lifecycle resources.

## Local boundary

The server binds only to `127.0.0.1`; host and origin checks reject remote-host and cross-origin API requests. This is a personal local application, with no accounts or remote access support. Provider credentials load only in the server from ignored `.env.local`. The API exposes configured status, never credential values. A per-data-directory process lock prevents a second server from interrupting the first server's active runs during recovery.

The runtime exposes only bounded model inference and optional Tavily search. There is no agent shell, file access, package install, generated-code execution, automatic node execution, or graph mutation tool. Direct canvas mutations and accepted proposals use the same project service; proposal generation has no mutation authority.

## Reference documentation

- [Node SQLite](https://nodejs.org/api/sqlite.html)
- [React Flow viewport](https://reactflow.dev/learn/concepts/the-viewport)
- [Vite backend integration](https://vite.dev/guide/backend-integration.html)
- Provider-specific evidence and pricing: [provider verification](provider-verification.md)

## Verification status

The bounded foundation is complete. [RESULT.md](../RESULT.md) maps all acceptance areas to actual evidence and distinguishes live calls from deterministic fake-provider tests. [WORKLOG.md](../WORKLOG.md) preserves dated progress.
