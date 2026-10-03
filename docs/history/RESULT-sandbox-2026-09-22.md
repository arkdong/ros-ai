# ros.ai Nebius Sandbox integration — September 22, 2026

The Nebius remote Python backend is implemented and available in **Action → Experiments → Execution runtime**. Authenticated read-only catalog access succeeds with the configured account. **No live sandbox execution is claimed:** the inspected official docs and signed-in console do not establish pricing, cost units or a free-beta guarantee, so execution admission remains blocked. The reported account credit is not used as a fabricated per-run price.

The normal app runs at **http://127.0.0.1:4310** with existing projects intact. [Setup and allowance configuration](../nebius-sandbox-setup.md) explains how to enable a separately authorized allowance once authoritative terms are available. Docker remains the default and the automatic research collaborator still uses Docker.

## Implemented

- A pinned public Python 3.12-slim image, fixed-origin REST transport, credential-free guest environment, disabled guest networking, disposable filesystem, 30-second execution timeout, 64 MiB writable layer and bounded output. No image imports, SDK/package installation, persistent file uploads, unrestricted host shell or network tool.
- Captured CSV as `rows`, parameters as `params`, standard-library Python and helpers for metrics, tables, simple SVG plots, CSV exports and conclusions. Code, input versions, logs, result artifacts, runtime and operation metadata remain inspectable. Scientific libraries remain in the separate local Docker runtime.
- Exact external-transfer approval for every remote attempt, including when a project uses automatic modes. Preview is local and inert; Allow sends the captured code/CSV/parameters. Separate sandbox allowance, shared project reservations and approval commit atomically.
- Conservative grant accounting across projects, new Actions, failures, cancellation, explicit retries and restart. Unknown prices fail closed. Provider raw cost is retained with unknown units, never relabelled USD. The configured ceiling is operator-attested admission accounting, not a Nebius billing cap.
- Submission intent saved before POST; operation identity captured from validated response headers. Ambiguous submissions are never repeated automatically. Cancellation must reach a terminal provider state. Restart reconciles known operations without resubmission; recovery audit records remain separate from immutable finished attempts.
- Runtime-specific optional model planning and version loading. Remote planning still needs its own inference authorization; it does not execute code. The new sandbox allowance does not renew the exhausted Ultra grant.

## Verification

| Check | Result |
| --- | --- |
| Authenticated catalog | HTTP 200; the public Python 3.12-slim UUID is available. No instance created. [Sanitized evidence](../../evidence/nebius-sandbox/access.json). |
| Regression tests | **111/111 pass, zero skipped.** Includes 27 offline remote transport/worker cases, six remote service/budget/recovery cases, a runtime-specific planning case and the preserved local suite. [Test output](../../evidence/nebius-sandbox/tests.txt). |
| Lint / build | Both pass. Vite's existing main-chunk size warning remains non-fatal. [Lint](../../evidence/nebius-sandbox/lint.txt), [build](../../evidence/nebius-sandbox/build.txt). |
| Actual browser | On an isolated local server: selected Nebius, created an exact local code/data preview, inspected transfer notice and observed Allow & run disabled by missing pricing. No remote operation or inference. [Screenshot](../../evidence/nebius-sandbox/remote-approval-browser.png), [record](../../evidence/nebius-sandbox/browser.json). |
| Normal app upgrade | Idle app backed up before restart; **32/32 API snapshot hashes identical across six projects**, including histories, artifacts, policies, local connections, sessions, reviews and provider accounting. Existing example/results and new runtime option verified in the real browser. [Upgrade evidence](../../evidence/nebius-sandbox/upgrade.json). |
| Spending | Zero sandbox execution requests, image imports, uploads or new inference requests. Historical ledgers and grants preserved; execution grants remain disabled. |

The remote tests inject documented REST responses and run only fixed, trusted worker fixtures locally. They do not prove a successful Nebius VM execution, provider isolation enforcement, actual cancellation termination, scientific-library availability or charges. Provider VM CPU/RAM request caps are undocumented; worker process resource limits are a separate mechanism. Disposable filesystem state does not establish deletion of provider request data/logs. [Dated API and pricing research](nebius-sandbox-api-research-2026-09-22.md).

## Remaining live step

Establish applicable free-beta terms or a conservative worst-case sandbox charge and a specific bounded allowance. Then run a small non-sensitive captured CSV through this adapter, verify actual artifacts/runtime/exit state, and test cancellation under that allowance. No invented rate or automatic spending permission has been configured to bypass this requirement.

The earlier [collaborator result](RESULT-collaborator-2026-09-21.md), [experiment build](RESULT-experiments-2026-09-21.md) and [foundation](RESULT-foundation-2026-09-21.md) remain preserved. The real Amsterdam weather example still has two completed local Docker analyses and three plots; cycling count observations and the full live model-led research loop remain unverified. This is dated pre-event work; no eligibility claim, deployment, account change, purchase, public write, goal or automation was made.
