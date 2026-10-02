# ros.ai collaborator build — September 21, 2026

The local collaborator build is implemented: one expandable research canvas, Knowledge and Action workspaces, scoped research sessions, three approval modes, isolated Python with research libraries, and local CSV/output connections. **The complete live model-led journey remains unverified.** The Amsterdam example has verified real weather, but its bicycle-count observations are still missing.

This is dated pre-event work, without an eligibility or submission claim. No goal or automation was activated. Earlier reports and evidence remain preserved in [the foundation result](RESULT-foundation-2026-09-21.md) and [the September 21 experiment-build result](RESULT-experiments-2026-09-21.md).

## Implemented behavior

- **One research canvas.** Legacy Topic/Activity records display as Knowledge/Action without rewriting their histories. Click selects; double-click or the expand control opens a bounded group. Multiple groups and deeper nesting remain visible together, with parent labels, smooth fitting, Broader view and Collapse all. Editing, conversation, experiments, research progress and permissions open in contextual dialogs. Drafts/navigation persist locally; highlights and exact artifact selections persist in the service. Dragging an artifact into another group explicitly reuses its saved version without starting work.
- **A resumable research loop.** One preferred model can propose Python, inspect actual outputs/errors, revise, conclude and suggest directions within a bounded session. A follow-up retains prior findings and shared counters. Model-visible inputs, code, datasets, outputs, errors and attempts remain inspectable. Related Actions record their relation to the research question; creation and starting follow the selected mode. These are flexible, independent research activities, not a scheduled graph pipeline.
- **Real permission policies.** Ask reviews each experiment and additional Action; starting a newly accepted Action is a separate decision. Approve for me uses an independent conservative rule reviewer, with escalation for unfamiliar or out-of-scope effects. Full access allows work only within the explicit grant. New Actions inherit the project default and can override their mode. Experiment count, external requests, created Actions, reserved runtime and spending are cumulative across nodes, retries and follow-ups. Mode changes do not reset them. Project stop and explicit resume apply across work.
- **Local sources and exports.** A chosen CSV is read-only by default and imported as an immutable capture. Generated artifacts export as new files in a chosen output folder. Original-source replacement requires separate connection write permission, an expected hash and an audit backup. Full access cannot override read-only connections. Database/cloud connectors are extension points, not implemented drivers.
- **A richer execution boundary.** Ordinary Python, pandas, NumPy, Matplotlib and SciPy execute in a dedicated Docker container. Each attempt captures its input/code/parameters, runtime identity, stdout/stderr, outputs and failure. The earlier closed numerical interpreter remains explicitly selectable for compatibility. Missing Docker fails closed; there is no unrestricted host-Python fallback.

The native forced-tool planning request that failed historically is no longer a dependency of the research loop. New planning uses an application-validated JSON text contract. Fixture responses prove orchestration and schema handling; they do **not** prove that the live Ultra endpoint now completes the journey.

## Verification and evidence

| Area | Observed result |
| --- | --- |
| Behavioral tests | **77/77 pass, zero skipped.** Coverage includes approval modes/inheritance/overrides, actual automatic review and escalation, shared admission, stop/recovery, scoped model fixtures, repair/follow-up, deeper nesting, sources, exports and permissions. Model fixtures are not live provider evidence. |
| TypeScript / build | `npm run lint` and `npm run build` pass for the integrated build. Vite reports a non-fatal main-chunk size warning. |
| Actual browser | One ReactFlow instance; three groups open together; a fourth-level Action created through the UI; parent context, collapse, popup drafts, pinning, drag reuse and reload persistence observed. A new Action inherited Ask; a per-Action Approve for me override saved. [Browser report](docs/browser-next-build-verification.md), [recorded facts](evidence/next-build/canvas-verification.json), [rendered DOM](evidence/next-build/canvas-dom.txt). |
| Actual UI execution | A UI-created Ask preview ran in the real Docker backend after Allow & run and completed with four rows and mean 25 in its summary. A separate real bounded-interpreter fixture also completed. These use synthetic fixture data and coding-agent/local starter code, not model-generated experiments. |
| CSV and export UI | A read-only CSV was imported through the connection dialog; a generated metric exported through the UI to the selected temporary folder as `{"value":25}`. Original source write permission remained off. |
| Visual / responsive | [Expanded canvas](evidence/next-build/canvas-expanded-groups.png) and [390 × 844 contextual editor](evidence/next-build/canvas-mobile-editor.png) inspected. Navigation closes and dialog contents scroll; the viewport override was restored. |
| Actual sandbox checks | Local tests exercise computation, host/input write denial, external network denial, scrubbed environment, cgroup/seccomp/privilege settings, failure capture, revisions, deadlines, child termination, immediate cancellation and output/file limits. [Runtime contract](docs/python-sandbox.md). |
| Saved-user-data upgrade | Normal port 4310 app upgraded after an ignored backup. All five prior project-detail hashes match when the new empty highlights field is omitted, and the provider usage hash is unchanged. [Upgrade evidence](evidence/collaborator/upgrade.json), [backup record](evidence/collaborator/backup.json). Browser fixtures remained isolated on port 4318. |
| Final restart | All 31 API snapshot hashes across six projects, their policies/connections/sessions/reviews and provider usage match exactly after restarting the final build. Paid calls remain disabled. The saved example and expanded canvas survived browser reload. [Restart record](evidence/collaborator/final-restart.json). |

**Browser permission-check limitation:** automatic approval review rejected saving Full access in the disposable fixture, treating the persistent approval-policy change as lacking exact authorization for its blast radius. The change was not saved and was not retried through another route; the fixture remains in Ask. Independent backend fixtures exercise Full access, but a successful Full access browser save is not claimed.

## Amsterdam cycling and weather demonstration

The [example](examples/amsterdam-cycling-weather/README.md) includes **366 real local-calendar days for 2024**, prepared from **8,784 KNMI Schiphol hourly observations**. Captured raw data, request/hash records, an offline preparation script, derived CSV and quality evidence are retained. Preparation validates all dates, no missing retained intervals, the 23-hour March day and 25-hour October day. Trace precipitation is disclosed rather than silently converted into exact zero measurements. KNMI attribution and CC BY 4.0 terms accompany the derived data.

Candidate Amsterdam bicycle counters were verified in NDW metadata. Their actual count observations were not acquired: the checked public export requires email/CAPTCHA, while the documented count API requires OAuth. No export was submitted and no synthetic counts were substituted. Schiphol is a weather proxy several kilometres from the candidate sites; future counts must be checked for matching intervals, local time, location, classification, completeness and terms before joining.

The available alternative is explicitly **Schiphol weather readiness for an Amsterdam cycling study**: inspect weekday/weekend precipitation distributions and then compare within seasons. It cannot answer whether rainfall changes cycling. Background studies motivate the question but are not Amsterdam findings. [Source, alignment and access review](docs/amsterdam-data.md).

**In-app weather demonstration completed:** **Amsterdam cycling & weather — evidence first**, project `2e354e21-2c06-464d-8882-a31eb9ac2b5f`, contains the verified captured weather dataset and two completed Docker Python analyses. Overview run `1d826f27-d965-45aa-b885-c54094e3da87` and seasonal follow-up `c99b4535-cdb5-4349-85f8-3a23dee4e605` produced **16 outputs, including three plots**, with **23 artifacts** in total. The outputs were exported to the chosen local folder; the source remains read-only. The coding assistant authored this program: it is actual real-data computation, not a live app-model-generated analysis. No new provider calls occurred; existing project and provider-ledger preservation checks passed. [Exact run, dataset and export evidence](evidence/collaborator/weather-project.json), [actual example browser checks](evidence/collaborator/weather-browser.json). The earlier [Coffee cooling example](examples/coffee-cooling/README.md) remains a synthetic-data demonstration with preserved local computation history.

## Provider spending and live gap

No new paid application-provider calls were authorized for this collaborator implementation. The historical September 21 allowance—**up to $5 for two Ultra requests**—is consumed:

1. The native code/tool-planning request returned HTTP 400. No resulting model code executed; the actual charge for that rejected request is unknown.
2. Text interpretation of real local outputs from build-authored code on synthetic data succeeded. Reported usage was 1,115 input and 428 output tokens, with a published-rate estimate of **$0.002399**.

The historical ledger retains **$4.218304 in conservative reservations**. Neither reservations nor the successful request's estimate are an invoice or account balance. Its authorization ID and accounting remain preserved. [Failed planning record](evidence/next-ultra-live.json), [successful interpretation record](evidence/next-ultra-interpretation.json), [provider findings](docs/next-provider-verification.md).

A fresh concrete authorization is required to verify the replacement live planning → model-written experiment → execution → inspection/revision → user-directed follow-up path. Raising project limits does not create that authorization. The coding-agent model setting also does not authorize app-provider spend. No new Tavily inference, purchase, deployment or public write is part of the current verification.

A concrete question is pending for up to $15 / six Ultra requests / three 30-second local experiments using only the public weather data, retaining Ask and read-only originals. The normal app keeps paid work disabled while awaiting an answer. [Prepared verification scope and admission calculation](docs/collaborator-provider-verification.md).

## Run and limits

```sh
npm ci
docker build -t ros-ai-research-python:1 src/server/sandbox
npm run build
npm start
```

Use Node.js 24+, an installed Python for legacy/reviewer support, and a running Docker engine. Open **http://127.0.0.1:4310**. Keep `.env.local` and `.ros-ai/` intact; restart after backend changes. [README](README.md) contains the user flow and [architecture](docs/architecture.md) describes ownership and recovery.

Approval policy and actual isolation are separate. Docker disables external networking, uses read-only root/copied inputs, excludes original files/home/credentials/socket mounts, runs as non-root with dropped capabilities and seccomp, and enforces memory/CPU/process/output limits plus a 30-second wall deadline. Python can read installed container files and create bounded child processes. This is container isolation, not a dedicated VM per run or protection against all kernel/runtime vulnerabilities. Stop removes the unique container; an independent watchdog attempts deadline cleanup after server death. Reliable cleanup depends on a responsive Docker engine.

Browser closure leaves the server working. Service/laptop shutdown interrupts work; durable sessions require explicit continuation, and unknown paid outcomes are never blindly replayed. Captured provenance does not reveal hidden reasoning, prove citation entailment or guarantee deterministic replay.

Nebius documents a Sandboxes beta, but this account's access, pricing and execution are unverified; its adapter remains unavailable. Multi-model comparisons, database drivers, full Codex/DeepSeek runtimes, hosting, accounts, cloud sync and remote continuation remain future work. Canonical status belongs in this repository; the compact vault packet routes here, and event preparation stays in the existing Inbox checklist.
