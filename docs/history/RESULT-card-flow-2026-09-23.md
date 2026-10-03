# ros.ai card outcomes and research flow — September 23, 2026

The local app at **http://127.0.0.1:4310** now has outcome-focused collapsed cards, saved width resizing, content-adaptive height and source-to-consumer relationship arrows. **Arrange** places recognized evidence sources above their consumers. Existing saved positions remain until the user chooses Arrange. No paid provider calls occurred.

The previous workspace report is preserved in [RESULT-workspace-2026-09-23.md](RESULT-workspace-2026-09-23.md). The actual Ultra/Tavily/Docker research demonstration remains in [the Schiphol tour](../../examples/schiphol-live-research/README.md); this update does not change its research or establish live Nebius Sandbox success.

## Delivered behavior

- Collapsed cards show a title and a softly colored, text-labeled outcome. One or two sentences come from saved conclusions, scalar metrics or captured evidence. Pending/running, failed, interrupted, stopped and blocked attempts remain explicit; earlier success cannot hide a newer unsuccessful attempt. Before evidence exists, a short purpose appears. Full original descriptions and artifacts remain accessible through details and expansion. This is deterministic evidence selection, not new model interpretation.
- Default width is 408 px. The bottom-right grip supports dragging, Left/Right keys and Home/End; integer widths of 320–720 px persist in SQLite, history and undo/redo. Height follows actual wrapped content within 224–420 px. A bounded scroll area handles exceptionally long outcome text. Expanded groups reserve their own children and results. Saving temporarily disables the grip to prevent overlapping same-card revisions.
- Known inverse relationships such as “uses data from” display from source to consumer as “provides data to,” including arrowheads and correctly swapped manual handle roles. Existing relationship records are not migrated. Explicit label edits use the displayed direction atomically; undo restores the original representation. Unrecognized free-form relationships retain their direction and meaning. Outline references say which neighbor provides or consumes evidence.
- Arrange uses dependency levels, measured card sizes and expanded result footprints. The Schiphol branch is KNMI → monthly analysis and sandbox preview; monthly analysis → robustness. Cycles share a level safely; nested endpoints project into their containing groups. Unconnected/free-form notes retain spatial reading order. Arrange changes positions only, remains undoable, preserves the viewport and is stable on repeat. Relationships do not schedule execution or import data.
- Presentation-only width joins x/y in the approval comparison exclusions. Exact saved approval snapshots remain immutable; code, datasets, selected inputs, meaningful node context, runtime, pricing, authority and resources retain their validation. New-note placement reserves variable widths and a conservative height.

## Verification

| Check | Result |
| --- | --- |
| Behavioral suite | **195/195 passed, zero skipped**, including actual local Docker and isolated provider fixtures. Covers outcome selection/status honesty, width validation/history/restart, approval preservation, branching/cyclic/nested layout, relationship direction/handles and outline context. [Log](../../evidence/card-flow-2026-09-23/tests-final.txt). |
| Final prompt guidance check | 9/9 execution tests after updating placement guidance. [Log](../../evidence/card-flow-2026-09-23/execution-final.txt). |
| Lint / build | Pass. Existing Vite bundle-size advisory remains. [Lint](../../evidence/card-flow-2026-09-23/lint-final.txt), [build](../../evidence/card-flow-2026-09-23/build-final.txt). |
| Actual browser | Disposable Schiphol copy: grounded outcomes, pointer/keyboard sizing, reload persistence, undo, adaptive height, source-first branches, repeat Arrange, full expanded evidence, label edit/undo and arrow markers. No browser errors; existing development attribution warning. [Observations](../../evidence/card-flow-2026-09-23/browser-final.json). |
| Fixture research | Note content, original connections after undo, artifacts, selected inputs, messages, runs, proposals and usage unchanged. Width/positions, history and focus were intentionally exercised. [Audit](../../evidence/card-flow-2026-09-23/fixture-preservation.json). |
| Normal workspace restart | **All 432 rows across 11 tables and all 71 artifact files** match the immediate pre-restart backup; no new rows or paid admissions. [Audit](../../evidence/card-flow-2026-09-23/preservation-restart.json). |
| Secret scan | Configured credentials absent from scanned source, docs, evidence, build and inspected local API responses; no values printed. [Record](../../evidence/card-flow-2026-09-23/secret-scan.json). |

The first preflight backup and pre-restart audit differ in one existing `assistant-focus.nodeId` field, changed concurrently while this task used its separate fixture. All other 431 rows and all artifacts are identical; research, graph, history, conversations, accounting and authority are intact. The newer focus was preserved by the immediate restart backup. [Preflight](../../evidence/card-flow-2026-09-23/preservation-preflight.json), [comparison](../../evidence/card-flow-2026-09-23/preservation-before-restart.json). No normal demo Arrange or resize was performed during verification.

## Remaining limits

Outcome excerpts can omit later qualifications; full saved evidence remains the source for interpretation. Small viewports and large expanded groups require pan/zoom. Free-form relationship wording is not parsed as a dependency. Routing remains a bounded local heuristic and may be obstructed by impossible overlap or fixed-handle geometry.

The remote Nebius Sandbox adapter is implemented, but **live remote execution remains unverified because applicable pricing/cost units or free-beta terms are unresolved**. The card states that blocker. This work did not submit remote code, reset a grant or spend account credit. The normal handoff server disables new paid requests; prior paid ledgers are unchanged. See [sandbox setup](../nebius-sandbox-setup.md) and the preserved September 22 provider record for historical accounting.

Canonical source documentation and the compact vault packet are updated. No deployment, purchase, account change, public write, goal or automation occurred; concurrent mockups under outputs remain untouched. This is dated pre-event implementation work, not an eligibility claim.
