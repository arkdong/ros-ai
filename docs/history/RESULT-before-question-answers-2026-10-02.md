# ros.ai — readable replies and indented structure drafts

Implemented October 2, 2026 in response to the reported ASML serialized-output problem. [Previous inference delivery](RESULT-before-presentation-2026-10-02.md) preserves the connection/guide implementation and remaining managed-Nemotron stages.

## Confirmed cause

The exact saved response is 3,673 characters and contains one extra closing brace. Strict JSON parsing fails with extra data at character 3,672. The previous fallback correctly rejected actions but displayed the whole response object as chat text. This is a presentation defect, not a problem with the user's question. A separate invalid structure puts children beneath an ordinary Knowledge block; only explicit Groups may contain blocks.

The original reply, usage receipt, warning and zero-action turn remain unchanged. No model request was repeated. The draft is not repaired into an accepted action plan and no research content or formula was silently rewritten.

## Delivered behavior

- Replies and follow-up questions render separately. A bounded, display-only projection can read a complete response object inside malformed wrapping, a fence or serialized string. Completed reply/question strings can survive a fragment, but a partial proposal never becomes an outline or executable action. The strict whole-object/fence action parser is unchanged.
- Proposed cards have an indented outline with Knowledge, Action or Group icons and labels. Titles remain visible; descriptions, rationale and exact identifiers are secondary disclosures. Relationships expand separately from containment and do not imply scheduling or input import. Duplicate parent warnings appear once rather than on every child.
- Recovered model structures are marked **Draft · not applied**, with no Apply/Accept/Run controls. App-validated pending proposals derive their outline from saved operations and retain the existing Review canvas changes path. The original saved response remains available in a collapsed disclosure. Historical records gain the readable view without migration or rewriting.
- Future strict notes proposals can include an explicit Group and its children in one batch. Fresh proposal refs resolve to server-assigned IDs before parent/relationship construction; duplicate refs, non-Group parents and cycles fail without canvas changes. Explicit parent changes on existing blocks are honored. Other tools still require accepted existing blocks. Store's whole-proposal validation, approval and shared limits remain.
- Instructions favor one focused question when a material definition is missing and a small useful initial structure after sufficient clarification. They no longer ask for a default multi-card starter map alongside a questionnaire. This is prompt guidance, not a guarantee of future model compliance.

## Verification and run state

Final **npm run build passed** (TypeScript/Vite, existing approximately 774 KB bundle advisory). No unit tests were added or run.

Twenty direct offline response checks passed, including the exact saved extra-brace failure, readable reply/question recovery, five complete display-only notes, no partial structures, duplicate/cycle/unknown-field rejection, bounded output, and unchanged strict action acceptance. Seven direct affected checks against AssistantService, ExecutionService and disposable Store passed for same-batch Groups, forward refs, pending Ask approval, explicit acceptance/moves and rejection of invalid parents/cycles. No transport or usage records occurred in those checks. [Structure receipt](../../evidence/assistant-presentation-2026-10-02/structure-checks.json).

Actual production Chrome verified the original reported turn: readable text/question, five cards, 12 px child indentation, one parent warning, closed Details/relationships/identifier disclosures and zero draft action buttons. Descriptions and four relationships expanded correctly. The serialized envelope is absent from visible chat; original text remains under disclosure. Console errors were empty. A compact before/after comparison confirmed the original turn and zero-block canvas are unchanged. [Browser receipt](../../evidence/assistant-presentation-2026-10-02/browser-smoke.json), [indented draft](../../evidence/assistant-presentation-2026-10-02/indented-draft.png).

The actual local server was restarted once after confirming no active assistant turns or runs in all three projects. It remains on loopback port 4310. No paid inference, provider/subscription turn, grant/credential/account change, installation, model download/training, deployment, public write, push/commit, goal or automation occurred. The malformed draft remains unvalidated; the user must clarify/refine it before a valid proposal can be applied.
