# ros.ai demo UX polish — September 23, 2026

The approved refinement is available at **http://127.0.0.1:4310**. The canvas supports left/up movement, expanded results default to two blocks with paging, the outline groups actual findings under their directions, and the sidebar includes Resources. Permissions and experiment details put essentials first. Branding assets were not changed by this work. No paid calls occurred.

The preceding outcome-card report is preserved in [RESULT-card-flow-2026-09-23.md](RESULT-card-flow-2026-09-23.md). Existing live research evidence remains in [the Schiphol tour](../../examples/schiphol-live-research/README.md).

## Delivered behavior

- Root notes can persist negative coordinates and remain reachable through pan/zoom. Child notes remain contained in their group. Root manual positions are authoritative, and Arrange respects negative anchors. Moves remain undoable. Expanding a manually placed group may overlap neighbors; explicit Arrange reflows them.
- Each expanded node offers **Show 2 / 4 / All**, defaulting to 2, with previous/next buttons, page dots and a visible range. Preferences persist per project/node in this browser, clamp when result counts shrink, and preserve all artifacts. Compact pages use packed positions; internal result drags do not write hidden coordinates. Drag-to-reuse remains available; All retains manual artifact placement.
- The research outline anchors the original question, separates its evolution, and presents collapsible research directions with actual associated findings. References use saved node/artifact/run ownership; ambiguous findings remain separate. Existing evidence references and full text remain accessible. Disclosure preferences persist locally.
- The collapsible, scrollable **Resources** section lists linked files, uploaded project copies and captured datasets/sources with provenance. Add supports a selected absolute local CSV path or a browser-uploaded immutable copy. Preview is read-only. **Use in note** explicitly captures the current linked/copy bytes or selects an existing exact artifact version. Originals remain unchanged. Exports and existing connections remain accessible.
- Permissions show approval mode, scope and main limits first; notes/datasets and additional limits use disclosures. Note settings are secondary. Experiment details prioritize pending approvals and saved results, with preparation, runtime, code and model planning reachable below. Server approval and budget enforcement are unchanged.

Resources add supports **UTF-8 CSV up to 500,000 bytes**, with a 6,000-character preview. Full resource content is retained. Browser uploads do not imply access to their original filesystem path. Linking does not grant experiment code filesystem authority; runtime boundaries remain unchanged.

## Verification

| Check | Result |
| --- | --- |
| Behavioral suite | **211/211 passed, zero skipped**. Includes actual local Docker and isolated provider fixtures, negative movement/history/restart, pagination/clamping, outline ownership, CSV resource copying/linking/capture, invalid encoding and existing approval/budget behavior. [Log](../../evidence/demo-polish-2026-09-23/tests-final.txt). |
| Lint / build | Pass, including the final React key fix. Existing Vite bundle-size advisory remains. [Lint](../../evidence/demo-polish-2026-09-23/lint-final.txt), [build](../../evidence/demo-polish-2026-09-23/build-final.txt). |
| Browser | Disposable Schiphol copy: both panels open, negative drag/reload/pan; 2/4/All/next/dots/last page and independent defaults; outline reference navigation/collapse persistence; actual CSV upload, linked preview, explicit capture, changed-source versus unchanged-copy behavior; exports and advanced controls; production resource restart. [Observations](../../evidence/demo-polish-2026-09-23/browser-final.json). |
| Compact drag | Every database table unchanged after dragging a result within its compact page. [Record](../../evidence/demo-polish-2026-09-23/compact-drag.json). |
| Fixture preservation | Existing node content, relationships, artifacts, runs, conversations, inputs, proposals and ledgers preserved. Only intentional positions/history/focus and new synthetic local CSV resources/imports differ. [Audit](../../evidence/demo-polish-2026-09-23/fixture-preservation.json). |
| Normal workspace | **All 440 rows across 11 tables and 71 artifact files** match both the initial and immediate restart backups, with no new rows or paid admissions. Normal browser reload has no new console errors. [Initial comparison](../../evidence/demo-polish-2026-09-23/preservation-final.json), [restart](../../evidence/demo-polish-2026-09-23/preservation-restart.json). |
| Secrets | Final scan covers source, docs, evidence, built assets and inspected local API responses without printing credential values. [Record](../../evidence/demo-polish-2026-09-23/secret-scan.json). |

The browser pass found and fixed duplicate sibling React keys in the new Resources integration. Full behavioral tests passed before that identity-only fix; final lint/build and production browser checks include it. Canonical docs describe the delivered behavior. Current research remains unchanged.

## Existing execution limit

The Nebius Sandbox adapter is implemented, but **live remote execution remains unverified because applicable pricing/cost units or documented free-beta terms are unresolved**. This UX work did not submit remote code or reset any grant. The normal server disables new paid calls and preserves prior ledgers. See [sandbox setup](../nebius-sandbox-setup.md).

No deployment, account change, public write, goal or automation occurred. This is dated pre-event implementation work, not an eligibility claim.
