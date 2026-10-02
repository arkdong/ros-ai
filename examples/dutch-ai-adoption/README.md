# AI adoption in Dutch businesses · the banking question

Completed native ros.ai demonstration on 23 September 2026. Open **AI adoption in Dutch businesses · the banking question** in the local project list.

Original question: **How is AI adoption changing Dutch businesses, and what could that mean for banks such as ABN AMRO?**

The project now follows four expandable stages, with its original detailed work nested inside: **Explore the question → Gather evidence → Analyze and challenge → Draft**. Exploration retains the broad banking question and outputs the focused company-size question; evidence assesses sources and denominators; analysis retains both actual runs and the qualification; Draft holds the editable article and attributed AURORA guidance. It includes actual public CBS aggregate observations, two real local Docker executions, two plots, saved code and exact selected artifact versions. Preparation and editorial drafting were performed by the coding assistant; no ros.ai model call, Tavily call, remote execution or bank endorsement is claimed.

## Evidence and finding

CBS *Dutch AI monitor 2024*, chapter 2, tables **2.1.3** and **2.2.1**, published in English on 18 June 2025. The six 2024 provisional size groups cover enterprises with at least ten persons employed in NACE C–N and Q. All six groups have published numeric estimates; the rows are aggregate groups, not a sample of six firms. Published confidence-interval endpoints are reproduced without inventing new intervals or sample sizes.

The actual calculation finds a **41.4 percentage-point gap** in adoption between the 500+ and 10–19 groups (59.2% minus 17.8%). The challenge compares firm and turnover denominators: in the 500+ group, adopters account for **79.5% of turnover**, which is **20.3 points** above their firm share. This is not revenue caused by AI. Two intermediate bins have turnover shares slightly below firm shares, so within-size revenue overrepresentation is not universal. Under-ten businesses are absent, not zero adopters. The corrected article names those limitations in its main text.

- [Official CBS source](https://www.cbs.nl/en-gb/longread/aanvullende-statistische-diensten/2025/ai-monitor-2024/2-use-of-ai-technology-by-dutch-companies)
- `source/cbs-published-tables.txt`: exact numeric table text captured by web browsing, with provenance. Direct HTTPS retrieval returned HTTP 500. This is **not** a downloaded original publisher CSV or microdata.
- `prepare.py`: deterministic extraction and size-label join; `preparation.json`: population, exclusions, transformations and SHA-256 hashes.
- `cbs-ai-size-2024.csv`: derived six-row CSV used by the actual runs.
- `source-exploration.md`: separately attributed ABN AMRO 2023 and 2026 context; percentages are not merged into the CBS data.
- `writing-reference.md`: attributed summary of the actual local AURORA writing guide. Original files remain untouched. This native note fallback does not claim PDF/Word import support.

## Saved outputs and editing

- `outputs/adoption-by-size.svg`: first actual execution's figure.
- `outputs/denominator-challenge.svg`: actual challenge figure.
- `outputs/overview-result.md`, `outputs/challenge-result.md`: exact saved computed conclusions.
- `outputs/*.json`: exact captured metric/table outputs.
- `article.md`: approximately 880-word draft. The same content is editable in native note **Editable article · grounded in the challenge**; the saved artifact preserves the prepared version.
- `claim-checks.md`: claim-to-evidence checks.
- `project-manifest.json`: actual native project, node, run and artifact IDs.

Project ID: `67e23d18-f399-46ed-9698-147e7d9d5f2c`. Overview run: `669eeee7-ee61-49ca-81ad-c5317bb1d747`. Challenge run: `49dea26e-eb9d-4bc0-99a1-a8706074db11`.

The article explicitly selects both actual plots, both result versions, the applied challenge and writing/source references. Relationships do not imply data import or execution. Opening the demo does not run anything or spend money.

## Reproduce

From the repository root:

```sh
python3 examples/dutch-ai-adoption/prepare.py
node --import tsx scripts/create-dutch-ai-demo.ts --create
```

The first command recreates the CSV from the saved public table-text capture and checks the six bins. The second creates the authorized local demonstration through Store and the loopback experiment API, approves the two exact scoped programs in Ask mode and records real outputs. It is idempotent after completion, returning the existing manifest; it never repeats a completed run or resets budgets. Start the local app and Docker runtime first. It opens Store with recovery disabled so preparation cannot interrupt another project's active runs. It writes only this newly created demonstration project.

Focused verification: the extraction retained every numeric cell of the two six-row source tables; the two completed runtime attempts passed the calculation assertions; both actual SVGs were rendered and visually inspected with readable axes, labels, captions and legends. The creator script passes a strict TypeScript check. CBS chapter 2's methodological note explicitly describes 95% intervals, population weighting and the `svyciprop` logit method; this demo reproduces the published endpoints, not their estimation. The implementation task performs the final integrated browser smoke with Resources and the guided tour.

For a fresh calculation within the app, select the exact CSV and use `analysis.py` in Docker Python with `phase=overview` or `phase=challenge`. The challenge also selects the exact overview result. The project's Ask policy retains a zero external-spend/model-call ceiling and a four-experiment local ceiling; the two original runs consume two attempts. The saved code asserts size labels, population, bounds, nonmissing data, turnover complements, the 41.4-point gap, the 20.3-point denominator difference and the two negative within-bin differences.

## Four-stage tour and live boundary

The book icon opens a four-step tour. Each step focuses its expanded stage and states its output. Open the focused question; inspect the CBS evidence; inspect the actual calculated plot and interpretation check; then read or edit the cited draft. AURORA guidance is available within Draft. These are **prepared saved results**. The stage buttons navigate at readable zoom; Overview is an explicit whole-canvas view.

No live application-model paragraph refinement has run. Current demo project policy allows zero model calls. The tutorial should use its saved-results mode, or label any direct user/coding-assistant edit as a manual fallback. A newly authorised inference action must preserve its actual outcome rather than substitute this prepared draft. This is the only live-tour gap; the source → data → calculation → challenge → draft workflow is completed and saved.
