# ros.ai — measured three-model comparison and pitch statistics

## Latest demo frontend pass · September 23

The focused frontend polish is complete and verified locally: compact generated stage placement/reflow, a labeled assistant with first-demo opening and persisted dismissal, matching sidebar controls, concise demo titles, and tutorial guidance/saved-outcome/evidence hierarchy. Waitlist pages now redirect to the demo and enrollment is retired without touching stored signup files. Type/build, all four chapters in the actual browser, phone layout, direct geometry checks, Docker image build and startup/routes passed. No unit tests or provider calls were run.

Curated commit `e7ae9c6` was pushed to GitHub `main` after direct user approval in the owning task. Railway deployment `5ece9bc1-67e5-4659-87b1-beed92b3c14a` is Active. A live browser smoke confirmed root/waitlist routing to `/app`, the revised demo workspace and links on all 13 slides. The preceding Railway image-build failure did not recur; its underlying cause remains unproven. See [the focused result](RESULT-demo-frontend-2026-09-23.md).


Status: September 23, 2026. Local implementation and targeted browser checks are complete. Following a new direct request, the prepared release is now published privately at https://github.com/arkdong/ros-ai for the user to import into Railway. The directly authorized three-model comparison is recorded with actual outcomes below; public live execution remains unfinished. The preceding provider/connection report is preserved in [RESULT-model-selection-2026-09-23.md](RESULT-model-selection-2026-09-23.md).

## Fresh rerun — September 23, $90 cap

A new direct instruction authorized a fast rerun without unit tests or checks. Six fresh model calls completed (two each) with an 8,000-token response cap including reasoning. All three original Python programs ran unchanged and produced all four correct values; all three drafts completed. GPT-5.4: 17.667s API total, $0.0291025 estimated token cost, 8/8 rubric. Nemotron: 8.873s, $0.014743, 7/8 (mislabels two size bins). Kimi: 28.053s, $0.0283696, 8/8. Nonblind assistant rubric; n=1/configuration, concurrent calls and differing reasoning settings. Nemotron cost49.3% less and took49.8% less API time than GPT in this rerun.

Total estimate $0.0722151; retained reservations $8.6144512 within $90. Fresh fixed grant benchmark-20260923-v2 preserves all prior ledgers and results. Paid admission is disabled again. No unit tests, build, browser verification or broad checks were run. Details: examples/model-comparison-2026-09-23-rerun/report.md and assessment.json. Updated statistics slide9 and evidence published via GitHub commit0276180; automatic Railway rollout not checked per the fast-rerun instruction.

## Actual model comparison and pitch slide — September 23

Adam directly approved the existing three-model comparison within a US$40 total cap. Six actual requests completed, two per configuration, with no paid retries or new search/remote sandbox calls. All three original code proposals executed unchanged in local isolated Docker and passed all four reference calculations. GPT-5.4 returned a complete draft; Nemotron's draft reached the 1,400-token cap, including reasoning, and stopped mid-sentence; Kimi's interpretation returned no text. These are one-run configuration observations, not general model rankings. [Full statistics](../../examples/model-comparison-2026-09-23/report.md) and [reproducible data](../../examples/model-comparison-2026-09-23/summary.json).

Total model API time (two calls, excluding review/Python): GPT-5.4 15.154s, Nemotron 6.900s, Kimi 77.243s including the failed response wait. Known token estimates total US$0.04710595, with Kimi's final charge unknown; conservative reservations retain approximately US$8.0336512 under US$40. The old combined Nebius grant is unchanged. A separate fixed-scope comparison ledger binds exact project/model pairs, permits at most two calls each and never replenishes across restart. Normal server port4310 now disables all new paid admission.

GPT's proposal response settled successfully but its native run failed when recording the returned model snapshot. The finished failed run remains immutable; a recovery receipt links the exact captured response/artifact/usage to the unedited local calculation, with no repeated inference. Store now permits one-time null-to-version capture only on an active running attempt. Build/type and the actual post-fix GPT interpretation pass; no unit suite added or run.

Inserted measured-statistics slide9 immediately before Responsible design (now10), total13 slides, preserving concurrent canvas-overview edits in source, public mirror and standalone HTML. Actual browser verified layout and exact adjacent navigation. The linked evidence page explains the response cap, reasoning differences, n=1, costs and failures. Published only deck/evidence/manifest to existing private GitHub main at `f3e0951f3405f95aca986abb632c162d71d67aec`; the prior source/application release remains intact.

Railway deployment `c2e08dca-fe25-4240-882b-dcd1a12fc40f` is active and successful. The public browser confirms the measured statistics at [slide 9](https://ros-ai-production.up.railway.app/deck/#slide=9), with all three rows and the cost/uncertainty notes visible.

## Waitlist and pitch count — September 23

Implemented `/waitlist` for email signup and `/waitlist/pitch` for a large live count, with entry links in the app header and demo chooser. Count refreshes every five seconds while visible; unavailable data is never rendered as a fabricated zero. The metric is unique normalized email submissions, not verified people. Duplicate addresses succeed without increasing the count. Email addresses stay server-side; no public list or outbound email service was added.

The separate shared `ROS_DATA_DIR/waitlist.sqlite` survives server restarts and sits outside visitor workspace limits. Railway needs its persistent `/data` volume and one replica to retain the list across redeployments. Each installation has its own list.

Type/production build passed. Actual desktop signup, success state, pitch count refresh and 390px phone layout passed. Focused HTTP checks verified normalized duplicate handling, invalid-email rejection and cross-origin protection. Two test submissions survived a restart in an isolated disposable database; no test signups entered the real local list, which reads zero. Verification: `evidence/waitlist-2026-09-23/verification.json`. No unit tests, paid calls or deployment were performed.

Published 106 curated files (105 manifest entries plus the manifest) to private `arkdong/ros-ai`, `main`, commit `216d821978d18b46270887ffe27c7efcbb7f71a7`. Push and authenticated GitHub page confirmed. The waitlist is available locally on port 4310 and ready for the user's Railway release. This does not establish a public deployment.

## Delivered and verified

First visitors can skip Demo mode or choose banking or market research. Starting a tutorial creates a separate project and progressively adds Explore → Gather → Analyze and challenge → Draft. The default path imports genuine saved evidence, calculations and writing; it performs no inference, search or code execution. Imported outputs retain original run IDs, hashes, timestamps and producing-runtime metadata. Prepared editorial writing is labelled separately. Existing projects and historical evidence remain intact.

Knowledge opens with its description, selected evidence, current outputs and child findings. Group cards derive summaries from saved descendant evidence when they have no output of their own. Expanded ancestors show highlighted descendant plots with their actual origin. Research outline finding counts include descendants. This repairs the empty-looking stage/Knowledge views without silently importing evidence or changing ownership.

Each node has a compact accessible effective-model indicator. Project defaults, nearest-ancestor overrides and task overrides still apply. Saved output labels retain the producing model/runtime independently of the current selection. The Nebius catalog now includes `moonshotai/Kimi-K2.7-Code` alongside Nemotron 3 Ultra. Existing top-level aggregated relationships remain unchanged.

Both local tutorials completed all four stages in the actual browser. Banking opened its two saved plots and editable article; market opened its three saved plots and cited paper. A 720px browser inspection found clipped scenario choices and an existing tutorial overlay covering the chooser; both were fixed and rechecked. Final type/production build passes. The existing approximately 641 KB JavaScript bundle advisory remains. No unit tests were added or run, following the user's focused-verification preference.

The banking tutorial also completed one genuine optional rerun through the app's exact code/input review and Ask approval, using isolated local Docker Python. Project `8ae23c8d-16ab-4620-8e6f-4458aec13ddc`, run `28f7707a-e7a1-4c17-bd02-abd73716e225`, backend `docker-python`, status `completed`. It produced 11 new analytical outputs (five metrics, two tables, two plots and two conclusions), plus captured code/data/log artifacts. The expected 41.4-point adoption gap, 20.3-point denominator gap and two negative bins were asserted during execution. The fresh adoption plot was visually inspected. No model or remote sandbox was called for this rerun; older saved outputs remain separately labelled.

## Public mode and deployment boundary

`ROS_PUBLIC_DEMO=1` selects a separate visitor service, skips `.env.local` and does not construct model/execution services or open the private `.ros-ai` workspace. Opaque HttpOnly, SameSite Strict cookies identify separate visitor SQLite stores. The initial HTML response establishes the cookie before parallel API requests. Production cookies use Secure; local HTTP preview is the explicit exception. Requests enforce the configured host/origin and JSON writes. A route allowlist excludes paid calls, arbitrary execution, host filesystem connectors and provider/account usage.

Public banking completed all four stages in the browser at the disposable local preview on port 4311. Its article and figures render; optional execution controls are disabled. Targeted two-visitor HTTP checks passed: visitor A can read its project, visitor B gets 404 for that ID and sees an empty project list. Market creation, paid messages, experiment previews, host connections and usage requests return 403. These checks are local evidence, not proof of a deployed public service.

The public image includes only source/build assets and the four curated banking dependencies. It excludes keys, private workspaces, personal writing guidance, output folders and market data/figures. The market tutorial remains local because its S&P/FRED redistribution permission is unresolved. Public visitors can inspect/edit/reuse saved research, but cannot run new AI or Python. Local ros.ai retains those separately authorized capabilities.

A sanitized release snapshot is prepared at `/private/tmp/ros-ai-public-release-20260923`, with a SHA-256 manifest. [Railway deployment instructions](../railway-deployment.md) describe its Dockerfile, origin, healthcheck and persistent volume. The curated image `ros-ai-public-demo:20260923` built successfully from this snapshot with the official Node 24 base and npm dependencies. The built image also passed an actual Node 24 container smoke: health endpoint, all four banking stages, 11 saved outputs, two plots and the finished draft. The disposable container was then removed; no secrets or host data were mounted. The subsequent direct GitHub request created private repository `arkdong/ros-ai` and published the release on `main` at `1903a674e8de35cfec9563077efaba8a4577bacc`. No Railway service or public website URL has been created. This is the recorded public tutorial slice, not completion of the requested publicly executable application.

## Historical authorization blocks resolved for comparison

The earlier delegated comparison approval was rejected before execution. Adam's subsequent direct instruction in this task authorized the existing US$40 total comparison; the six recorded requests above resolve that blocker without reusing older consumed grants. Historical preparation and rejection details remain in `examples/model-comparison-2026-09-23/report-before-live.md` and `approval-status.json`. Public execution remains a separate unfinished integration.

## Public execution still requires implementation

The local rerun proves actual execution locally; it does not establish Railway execution. The current Railway image has no Docker engine/Python runtime, and public mode deliberately never constructs `ExperimentService`. Adding a credential alone will not enable a runnable public experiment.

The smallest supported remote direction reuses `NebiusSandboxBackend` behind a narrow visitor-scoped preview/decision/cancel API, with a single shared sandbox/combined budget ledger across all visitors, bounded concurrent work, durable operation recovery and no paid retries. Visitor records must stay open while an attempt is active. Its standard-library input/helpers differ from the current pandas/matplotlib tutorial code, so the public rerun must supply an equivalent reviewed standard-library program or a separately verified richer image. Credentials remain server-side and only captured data/code/parameters reach the guest. This integration has not been implemented or verified in public mode.

Fresh remote execution also remains gated by confirmed price/credit units or explicit beta terms and a fresh bounded sandbox authorization. The consumed one-use beta exception and the model-only $40 comparison cap provide neither. A Railway Sandbox adapter is another possible implementation, not a deployment setting already supported here.

Public runner assessment: a shared budget cannot simply be constructed per visitor or pointed at another visitor's Store. Admission needs a central operator ledger/job registry bound to visitor/project/run identities; central reservations must survive uncertain outcomes and partial persistence. Startup must reconcile all active remote jobs, including visitors who never reopen the site. A banking-only fixed, reviewable stdlib calculation is the smallest recommended first public execution slice.

Handoff server: port 4310 is running with zero inference/search dollar allowances and sandbox authorization disabled; grant IDs and all ledgers remain preserved. The authorized comparison is finished; further paid calls require a new bounded scope. The separate saved-only public preview remains on port 4311.

## Initial GitHub publication — historical, September 23

Published the sanitized release to [arkdong/ros-ai](https://github.com/arkdong/ros-ai), private, branch `main`, commit `1903a674e8de35cfec9563077efaba8a4577bacc`. Used the existing signed-in GitHub account and existing SSH identity; no new credentials or third-party permissions were created. The separate release checkout is `/private/tmp/ros-ai-github-20260923`; the original local workspace remains intact. The initial 102 files include the Dockerfile, source, banking dependencies, SHA-256 manifest, ignore rules and step-by-step Railway import instructions. Remote push and authenticated browser contents were verified. This initial GitHub-only instruction did not authorize model calls; the later direct comparison authorization, measured results and current live deck are recorded above.

## Interpreting model performance and quality — September 23

Re-read all fresh drafts against the common source packet and six-row CSV, with a second assistant review. All three satisfy required calculations, word range, scope and noncausal caveats. Nemotron has one concrete false ordinal description (20–49/50–99 called the two smallest bins); its population-coverage wording also needs care. GPT is the cleanest conservative draft in this review; Kimi adds a sound inference but no demonstrated quality advantage. Coarse 8/8–7/8–8/8 scores are not accuracy percentages.

The practical measured tradeoff is Nemotron saving8.794 APIseconds and1.43595 UScents vsGPT, with factual prose review still necessary. Kimi costs almost the same asGPT but takes10.386seconds longer. Review time, reliability, adaptation and a no-model workflow were not measured. This precise six-row task does not prove robustness or autonomous discovery. Detailed interpretation: examples/model-comparison-2026-09-23-rerun/interpretation.md.

Reframed the existing comparison slide around those conclusions and concrete output differences; preserved underlying results and other slides. Local browser layout inspected; no unit tests or model calls. GitHub commit0c471d2 publishes slide/evidence clarification. Concurrent audience slide remains in local source (comparison10/14); remote release comparison remains9/13 until that separate edit is published.

## Impact-first model slide — September 23

User requested results and impact instead of numbers. Replaced the comparison table with qualitative outcome cards: Nemotron offers less waiting but needs a factual correction/scope clarification; GPT is the clearest cautious draft; Kimi is sound with no clear quality gain for its longer wait. Takeaway: Nemotron is promising for exploratory drafts; trace claims to evidence and review before sharing. Scores, cost and latency remain in the linked evidence page. Scoped CSS and section updated in source, public and offline HTML; browser layout inspected. Published commit1652272. No tests or new paid calls.

Impact slide deployment 9cc011f6-bd6d-4eab-89fa-9c9ef7ea525f succeeded. Refreshed the user’s public deck tab and confirmed qualitative outcome cards on slide9/13; detailed measurements remain in the evidence link.
