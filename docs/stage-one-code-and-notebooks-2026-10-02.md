# ros.ai Stage one Code and Notebook plan

October 2, 2026. **Status: Code and Notebook capture/connection implementation delivered; live Jupyter verification blocked by missing local infrastructure. Stage One is not marked complete. The original objectives below remain a dated plan; current delivery is recorded at the end and in RESULT.md.** This is the canonical record of Adam's renewed direction; current implementation and verification remain in [RESULT.md](../RESULT.md).

## Purpose and priority

Adam finds the current workspace too complicated, with too much effort and distraction around the assistant. He wants a simple local research workspace usable without AI: edit code or notebooks, produce tangible results, deliberately reuse those results in other analyses, and write reports from exact evidence. The assistant is optional rather than the entrance to ordinary work.

Stage one includes **two separate node types: Code block and Notebook block**. This expands the earlier single-cell-only recommendation. Stages two onward will be discussed next and are not defined or scheduled here. The earlier [inference design](inference-design-2026-10-01.md) remains background direction and dated history, not a commitment to its sequence as the new product plan.

## Pre-implementation baseline and target

This table records the source-confirmed baseline before this implementation. It is historical; the delivery section below supersedes it.

| Current implementation | Stage one target or remaining gap |
| --- | --- |
| The creation menu has Code, but opens the generic Inspector; a blank project opens Assistant. [App](../src/client/App.tsx) | Ordinary code/data/result work has a direct surface and needs no assistant or model credentials. |
| Editable Python is inside nested Experiment disclosures. [Experiment](../src/client/Experiment.tsx) | A dedicated Code block exposes editing, running, output monitoring and saved attempts together. |
| [Local Docker Python](python-sandbox.md) provides pandas, NumPy, SciPy and Matplotlib with isolation/resource limits and captured attempts. | Reuse this runtime as the proposed first slice; never substitute unrestricted host execution. Runtime availability remains explicit. |
| [ExperimentService](../src/server/experiments.ts) takes one supplied CSV or exact source dataset. | Explicit output handoff is an objective; broader multi-input combination needs a defined supported contract. |
| Same-project exact artifact reuse, derived datasets, figures, [reports](datasets-figures-reports.md), content undo/history and observable request traces exist. | Reuse these foundations for Code and Notebook outputs with clear origin and staleness. |
| No full notebook/kernel engine, broad language execution, general connector interface, managed local guide or open-source license/distribution is delivered. | Local notebook access belongs in Stage one; the remaining capabilities retain their actual status and open scope. |

## Accepted Stage one objectives

| Block | Responsibility decided by Adam | Proposed default or open choice |
| --- | --- | --- |
| Code block | Edit and run a single program/cell; monitor its output and select useful results. Preserve a language-extensible objective including C, Haskell and other languages. | Python through the existing isolated runtime is the proposed first implementation slice. Which other languages ship immediately is undecided. “System runtime” does not authorize unrestricted host-shell execution. |
| Notebook block | Open and use an external local Jupyter notebook or JupyterLab session; select which result from which cell matters. | Embedding a local interface or opening/spawning a small local web interface are candidate experiences. Embedding versus launch/connect, and JupyterLab versus Notebook/JupyterLite, remain unresolved. |

Both blocks need a common user-facing way to capture/select outputs such as text, tables, metrics, figures and files. An optional LLM may inspect expressly selected notebook context and propose an extraction. AI observation is never a prerequisite for editing, execution, capture or reuse.

## Outputs provenance and handoff

Capture the selected result with its origin block, exact code/input/parameter versions, actual run or source version, runtime attribution and capture time. A notebook result also identifies its source notebook version and originating cell or cells. Imported saved notebook output is labelled externally captured; it does not prove ros.ai ran it, establish cell execution order, or prove the external kernel shares ros.ai's Docker isolation. Missing execution/dependency evidence stays visible.

When code, input data or a notebook source changes, retain the immutable result and mark its relationship to the current source as stale or unverifiable. Never silently recompute, replace a recipient's selected version, or present old output as produced by current code. An LLM extraction/summary is separately labelled interpretation with its selected sources, rather than relabelled execution evidence.

**Use as input** or **Send selected result** is the first implementation's explicit handoff objective: choose an exact result/version and destination, and save what was handed off and where. A handoff may supply an input or message to another block and eventually an explicitly chosen agent. Agent handoff belongs in this output/interface objective; actual agent operation remains limited by implemented adapters, grants and isolation. Recipient execution is a separate decision. No background sending, arbitrary agent execution or automated pipeline is promised.

Canvas connections remain meaningful relationships. They never start downstream work, import all notebook content or grant authority. Manual content edits stay direct and undoable; layout stays outside content history. Agent-generated additions retain relation, provenance, undo and shared grants; Ask requires specific approval. Runtime, paid-call, connection and external-transfer permissions remain separate. New blocks and retries never replenish limits.

## Proposed implementation order within Stage one

- **S1a proposed:** direct Python Code editing/running with visible output monitoring, deliberate result capture and reuse, using the existing isolated runtime. Programs without data must not acquire hidden sample inputs.
- **S1b proposed:** local Notebook opening/connection and per-cell selected output capture/reuse, with honest external-runtime and source-version attribution.

This is proposed sequencing, not Adam's final architecture or a completed delivery. Notebook remains part of Stage one. No later stages are invented here.

## Acceptance scenarios for future implementation

1. **Work without AI:** with no assistant/model credentials, create a project, manually edit code/data, run supported Python, inspect and capture a useful output, and open/use a supported local notebook. Missing runtime/setup produces a clear blocker, not an AI requirement or unsafe fallback.
2. **Choose notebook evidence:** select a particular cell's table or figure without importing the whole notebook. Capture its notebook/cell/source version and known run identity, label unavailable evidence, and reopen the provenance later.
3. **Reuse across branches and combine where supported:** deliberately hand version A to two analysis blocks. A later source version does not replace either selection or run them. A supported combination records every selected origin; unsupported multi-input combinations explain their limit.
4. **Write from evidence:** insert an exact Code/Notebook result in a report, save/reopen it with its source links, and disclose a newer or stale source without rewriting the cited version.
5. **Optional AI extraction:** deliberately select notebook context and destination for an authorized model to suggest an extraction. Preserve its observable request/tools and distinguish the summary from raw output; the suggestion does not broaden grants or execute recipient work.
6. **Report language availability honestly:** Python is available only with its enforced runtime. C, Haskell and other languages appear according to delivered support; no unsupported editor choice implies successful execution.

These were planned acceptance scenarios in the preceding documentation-only task. Actual checks and remaining blockers are recorded below.

## Original open decisions (delivery choices below supersede these)

- Notebook host/interface: embed, launch or connect; JupyterLab, Notebook or JupyterLite; session ownership, lifecycle and resource/isolation boundaries.
- Notebook/cell identity and source-version capture when an external session cannot provide trustworthy execution/dependency evidence.
- Code languages/runtimes delivered immediately beyond Python, and the adapter boundary for later languages.
- Common output types and handoff packaging, supported combinations, recipient/message UX and initially supported agent destinations. Current reuse is same-project; cross-project handoff is not established.
- Open-source license/distribution, general connector contracts and a packaged locally contained guide. Stages two onward remain undefined.

## Background direction and reference products

Adam's long-term direction is open source, local ownership and inspectable observable prompts, tool calls, history and provenance, with user-chosen model/agent/data/document connections. Codex, Claude Code, Google Drive and Overleaf are examples of desired connection choices, not promises of delivered support. Traceability covers observable requests and artifact versions, not hidden reasoning or deterministic replay.

An optional Workspace guide could use a locally contained model such as Nemotron to suggest structure, branches and merges. Its default is structure and allowed metadata; private research content requires deliberate inclusion. Subscription sign-in or a locally running CLI does not establish on-device inference. Packaged runtime and privacy proof remain future work.

The reference product is **Figlinq**. The earlier browser walkthrough showed a Python notebook, editable data grid/CSV export, plot/editor and visible assistant tool activity. Its [official features](https://figlinq.com/features/) and [assistant documentation](https://figlinq.com/docs/ai-assistant/) describe a research canvas, browser JupyterLite, selected-file/editor context and inspectable code/tools/revisions. The visible financial notebook embedded its values; source retrieval and its exact claimed model version were not verified. These observations and official claims are distinct.

Wonderful's official [AI OS](https://www.wonderful.ai/ai-os) and [agents](https://www.wonderful.ai/agents) pages describe an enterprise system with integrations, shared permissions/context, agents, skills and versioning. Both products are inspiration; this record adds no competitor verification or scope commitment.

## Dated decision log

| Date | Status and decision |
| --- | --- |
| 2026-10-02 | **Adam decided:** prioritize a simpler local workspace usable without AI, centered on tangible code/notebook results and explicit reuse. |
| 2026-10-02 | **Adam decided:** Stage one contains distinct Code and Notebook blocks; local notebook access expands the earlier single-cell-only recommendation. |
| 2026-10-02 | **Adam decided:** useful per-cell outputs can be deliberately selected; optional AI extraction and agent handoff preserve selection, provenance and existing authority. |
| 2026-10-02 | **Proposed defaults:** reuse isolated Python first; S1a Code then S1b Notebook. Runtime/language and notebook interface choices stay open. |
| 2026-10-02 | **Planning boundary:** stages two onward are not defined. This request changes documentation only and does not activate/change GOAL.md, start a runtime, authorize research/provider spending or publish/deploy anything. |

## Implementation choices — October 2, 2026

- **Notebook interface:** connect to an existing user-managed loopback Jupyter/JupyterLab server and open its native interface in a separate browser tab. Credentials stay in private server records and Authorization headers; native Jupyter sign-in is separate. ros.ai never installs or starts a host kernel. A bounded `.ipynb` import also supports selected saved-output capture, clearly labelled external evidence.
- **Code:** one saved editable program with an independent language field. Python runs only through the existing Docker/Linux backend with its limits and exact approval/shared grant. Other language source can be retained, but no unimplemented runtime is presented as executable. No dataset means no dataset or sample injection.
- **Inputs and outputs:** Python accepts no data or one explicitly chosen full CSV artifact as `df`; parameters are `params`. Unrelated selected evidence is never silently merged or executed. Existing text/log, metric, JSON table, CSV and safe figure artifacts retain immutable producing snapshots. Unsupported notebook output stays labelled, not relabelled as a table/figure.
- **Destinations:** explicit same-project exact-version selected inputs and existing report evidence. Input selection does not run the destination. Optional assistant interpretation is prepared only from expressly selected output context; agent delivery remains subject to implemented adapters and permissions.
- **Runtime inspection:** Docker Desktop is installed but was stopped; its launch is routine local verification setup. Neither system nor bundled Python contains Jupyter. Actual Notebook live access remains unverified until an existing user-managed session is available; imported fixtures do not establish integration success.

## Delivered implementation and verification — October 2, 2026

Code and Notebook creation first selects the new block on the canvas; opening its content deliberately opens the dedicated editor. The October 2 creation follow-up makes names optional and uses one selected type for all seven block choices, including a blank Report that saves into its existing node. Blank projects keep Assistant closed; node **Discuss** still opens the separate node conversation. Saved code/language/parameters/exact CSV choice and Notebook references use additive existing canvas storage and ordinary content undo. Unsaved Code drafts remain browser-local and survive reopening.

Code uses isolated Docker Python only, without hidden sample data. Exact Ask review, shared cumulative limits and stop/cancellation remain enforced. Each attempt retains program/settings/input/runtime versions, bounded logs, successful outputs before failure and immutable earlier results. C/Haskell/other source can be stored, but execution is unavailable.

Notebook uses the existing user-managed loopback Jupyter Contents API, read-only bounded source capture and token-free native JupyterLab/Notebook links. It never launches a kernel or claims external execution inherits Docker isolation. Per-cell CSV/text/JSON/PNG/safe SVG outputs can be captured; unsupported MIME remains inert JSON. Exact snapshot/cell hashes or snapshot-index locators are retained. Execution ordering, current kernel state and dependencies remain unverified.

Both paths offer explicit same-project exact-version **Use as input**, report evidence and provenance. Python accepts zero or one full CSV; other outputs become selected evidence, not automatic Python variables. Selection records a receipt and starts no recipient work. Source edits mark older results stale where evidence allows, leaving selected/report versions untouched. Optional interpretation prepares only explicitly chosen textual output, selected structural destination and existing guide consent; no whole notebook or neighboring cells are included implicitly.

**Verified:** required TypeScript/Vite build; three real Docker attempts (42 without `df`; retained metric7/stdout/error on deliberate failure; exact CSV sum14); branching to two recipients without execution; staleness and pinned versions; exact report references/export; actual browser creation/editor/Ask/output/history, Notebook selected-cell capture/reuse, selected-only guide preview, and missing-Jupyter state. Direct offline service checks cover bounded imports/safe formats, privacy and optional interpretation; they are not live provider or notebook proof. No unit suite or paid calls. Evidence: [Stage One receipts](../evidence/stage-one-2026-10-02/).

**Remaining blocker:** neither available Python runtime has Jupyter and no running local session has been supplied. Native connection/open/refresh code is delivered, but no actual live Jupyter session or execution has been verified. Imported synthetic snapshots prove capture/reuse only. [Setup](stage-one-setup.md) explains the required user-managed session and shortest manual workflow. Stages two onward, managed notebook launch, additional compilers, multi-CSV execution and arbitrary agent delivery remain outside this implementation.
