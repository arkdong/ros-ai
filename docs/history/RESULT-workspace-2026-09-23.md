# ros.ai workspace refinement — September 23, 2026

The updated local app is running at **http://127.0.0.1:4310** with a monochrome reading surface, larger type, concise source-text previews, geometry-aware connections and stable spatial arrangement. The saved research projects and ledgers are unchanged. **No paid calls occurred in this iteration.**

The preceding continuous-assistant build and actual Ultra/Tavily/Docker demonstration remain documented in [the preserved September 22 result](RESULT-continuous-2026-09-22.md) and [Schiphol demo tour](../../examples/schiphol-live-research/README.md). This update does not add provider capabilities or complete live Nebius Sandbox verification.

## Changes

- Charcoal primary text, neutral gray supporting text, white cards/panels and a near-white canvas. Primary buttons are charcoal; green marks selected borders and the supplied assistant glow. Cards use 18 px titles, 15 px descriptions and 13 px supporting labels at normal zoom. Expanded headers, child insets and card footprints were enlarged together.
- Cards, Notes and the research outline display deterministic excerpts of the original text. Full titles/descriptions remain in saved records, note details, expanded editing and outline disclosures. No model summary or rewrite was used. Server outline previews are smaller; full project detail remains available. Model-visible research context limits are unchanged.
- Arrange follows existing sibling y/x reading order, aligns shared columns and rows, includes expanded children and result footprints, retains the root corner/viewport and is undoable. Repeating it makes no further mutation. New-note placement now uses the actual shared card dimensions and gap. Connections never impose a research sequence.
- Automatic connections choose appropriate sides and short rounded orthogonal routes around unrelated cards/groups/artifacts. Routes follow live dragging and the 420 ms Arrange interpolation; a small side preference prevents flicker near ties. Deliberately saved handles retain their sides. Labels render above lines and expose complete text through hover/edit. Fit, Broader view, Collapse and focused expansion account for overlaid controls.
- Exact experiment approval no longer includes node x/y in the current-context comparison. The original captured node snapshot stays immutable. Relevant context, selected artifact versions/excerpts, code/CSV/parameters, worker/image, pricing/authorization and current policy/resources still require validation. Moving a card therefore preserves an otherwise unchanged approval without broadening its authority.

## Verification

| Check | Result |
| --- | --- |
| Behavioral suite | **173/173 passed; zero skipped.** Includes real local Docker, existing persistence/authority/provider fixtures, seven approval-context regressions, layout and routing cases. [Log](../../evidence/workspace-ux-2026-09-23/tests-final.txt). |
| Lint / production build | Both pass. The existing Vite bundle-size advisory remains. [Lint](../../evidence/workspace-ux-2026-09-23/lint-final.txt), [build](../../evidence/workspace-ux-2026-09-23/build-final.txt). |
| Actual browser | Disposable nine-note nested fixture: previews/full text, collapsed/expanded Arrange, exact Undo, repeat stability, result containment, vertical/horizontal/obstacle/manual routes, dragging and desktop/narrow views. Twelve consecutive samples during Arrange retained all five edges and nine distinct interpolated paths. [Record](../../evidence/workspace-ux-2026-09-23/browser-final.json). |
| Saved data after restart/reload | **All 424 rows in 11 tables and all 71 artifact files unchanged.** Seven projects, 22 terminal runs, conversations, inputs, history and paid ledgers match the private backup. No new/missing/changed rows. [Audit](../../evidence/workspace-ux-2026-09-23/preservation-final.json). |
| Fixture preservation | Browser operations changed position/history and focus only. Original research text, connections, runs, artifacts, inputs and conversation remained identical. [Final fixture](../../evidence/workspace-ux-2026-09-23/ui-final.json), [Undo](../../evidence/workspace-ux-2026-09-23/ui-undo.json). |
| Secret scan | Configured keys/provider project ID absent from scanned source, docs, evidence, build and read-only local API responses. No values emitted. [Record](../../evidence/workspace-ux-2026-09-23/secret-scan.json). |

The layout regressions were reproduced before the fix: UUID-driven reading order and inconsistent columns for mixed expanded sizes. [Before](../../evidence/workspace-ux-2026-09-23/layout-before.txt), [after](../../evidence/workspace-ux-2026-09-23/layout-after.txt). Browser inspection additionally found and corrected labels behind lines, Fit hiding card controls, edges disappearing during interpolation and delayed group bounds after artifact dragging. Development hot reload produced React Flow warnings; no runtime browser errors were observed.

## Preserved limits

Routing is a bounded local heuristic, not a global crossing-minimization solver. Impossible overlapping geometry or incompatible fixed handles can still produce an obstructed route, flagged in its rendered route data. Historical stored handle values are conservatively treated as deliberate because their original intent cannot be recovered. Long labels and source previews can clip; full text remains accessible. Reduced-motion skips Arrange interpolation. Very large expanded groups still require pan/zoom.

Paid requests remain disabled in the handoff server. The September 22 combined Nebius grant still retains **US$9.599184 of US$10**, leaving **US$0.400816**, with the prior usage-derived estimate **US$0.107922**. Tavily remains **US$0.024** cumulatively retained. No grant was reset and no new sandbox admission/submission exists. These are application records, not account-balance or invoice claims.

The remote Sandbox adapter and exact transfer approval remain implemented, but **live execution is still unverified because applicable pricing/cost units or free-beta terms have not been established**. [Setup and gate](../nebius-sandbox-setup.md). Existing local Docker research remains usable. No deployment, purchase, account change, public write, new goal or automation occurred. Concurrent mockups under outputs were preserved.

Source docs and the compact vault packet are updated. Earlier foundation, experiment, collaborator and sandbox reports remain dated historical evidence; this is pre-event implementation work, not an eligibility claim.
