# When market conditions change · a historical risk baseline

Completed native ros.ai demonstration, 23 September 2026. Open **When market conditions change · a historical risk baseline**, then **Measure subsequent threshold breaches** for the two saved plots and actual Docker execution. This is one reproducible historical baseline on real prices; it makes no investment recommendation or claim about proprietary Earthian AI technology.

| Eligible period | Days | Exceedances | Rate | Nominal 5% count | Daily return SD |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2019 | 250 | 4 | 1.60% | 12.50 | 0.77% |
| 2020 | 253 | 21 | 8.30% | 12.65 | 2.17% |
| 2021 | 252 | 6 | 2.38% | 12.60 | 0.83% |
| Overall | 755 | 31 | 4.11% | 37.75 | 1.41% |

2020 was preselected in the brief, before computing comparisons. Its observed variability is greater in this sample. The overall rate alone conceals the difference between periods. The threshold incorporates large losses after they arrive and retains them until they leave its rolling window. Worst price drawdown over the declared 2018–2021 input period is **−33.92%**. None of these descriptive checks establishes future calibration, significance or an effective trading rule.

## September 23 research-to-paper extension

The **same native project** now uses four expandable stages: Explore the question → Gather evidence → Analyze and challenge → Draft. Its earlier baseline, two figures and execution records remain intact. The new [editable paper](research-v2/paper.md) appears in **Research paper · editable working draft**, with exact selected figures shown in its reading surface.

The extension performed **two Tavily basic searches, two Nemotron 3 Ultra inference requests and one local Docker experiment**. Search roles and rejected/restricted evidence are recorded in [the evidence assessment](research-v2/evidence-assessment.md). The actual model proposal contained a substantive warm-up error: it filtered to evaluation dates before rolling thresholds. Review corrected that before execution; the exact proposal, [review](research-v2/model-review.md), corrected code and native run remain inspectable. Inference proposes/interprets; Docker computes the numbers.

On identical 755 evaluation sessions, the existing 252-session baseline reproduces **31 breaches (4.11%)**; the declared 126-session sensitivity yields **38 (5.03%)**. Yearly short-window counts are 9/250, 17/253 and 12/252. In 2020 Q1, the baseline records 16/62 breaches and the sensitivity 14/62. An aggregate near or below 5% does not establish reliability or select a better model. Two new labelled plots show 2020 threshold paths and yearly rates/denominators; the original drawdown remains available.

The [plan](research-v2/pre-analysis-plan.md) was saved before the new calculation but after the old baseline was known. This is disclosed retrospective sensitivity, with no independent validation or significance test. The [direct empirical check](research-v2/calculation-check.json) independently reproduced both thresholds and all breach flags across the 755 saved rows. Both new SVGs were rendered and visually inspected; no unit tests or broad defensive suite was added.

[Native extension manifest](research-v2/native-extension.json) records run/artifact IDs. One local receipt-linking step failed after the first inference was already settled; [read-only reconciliation](research-v2/plan-reconciliation.json) recovered that same response without a repeated call. The original failure and an explicitly corrected editorial note remain preserved. Fresh inference reservations total **$2.109152 of the authorized $3**, with **$0.012099 estimated token cost**; the exactly-two-call grant is consumed. Two Tavily credits add **$0.016** to the existing cumulative ceiling (**$0.040 retained overall**). These are app accounting, not provider balances. No additional sandbox was used.

A concise walkthrough: explore the refined question; open the evidence assessment; compare the two actual plots; inspect the model warm-up correction and actual interpretation; read/edit the cited paper. Present this as saved results from newly performed September 23 research, not work performed merely by opening the tour. Data and derived figures remain local; redistribution rights are still not cleared.

## Source and rights

S&P Dow Jones Indices LLC, **S&P 500 [SP500]**, retrieved from [FRED](https://fred.stlouisfed.org/series/SP500) on 23 September 2026. The exact [CSV request](https://fred.stlouisfed.org/graph/fredgraph.csv?id=SP500&cosd=2018-01-01&coed=2021-12-31) and hash are retained in [source metadata](source/retrieval.json). The unmodified response contains 1,044 weekday rows, 1,008 observed prices and 36 blanks. Blanks are omitted, never forward-filled. No duplicate dates occur. We do not independently certify each absent observation against an exchange holiday calendar.

Observations are daily close **index points**, not dollar prices. The underlying US equity index is USD based. This is a **price index excluding dividends**, not total return and not split-adjusted ETF shares. We apply no further corporate-action adjustment. [S&P's index mathematics methodology](https://www.spglobal.com/spdji/en/documents/methodologies/methodology-index-math.pdf) describes divisor maintenance for non-market changes; the analysis uses the published continuous index level.

**Local research only:** FRED's series notes mark S&P data copyrighted and require prior permission for reproduction. No public redistribution permission was obtained for this snapshot or its figures. Access to a downloadable CSV is not an open license. Keep raw data/derived figures local until their proposed sharing is cleared. This build neither publishes nor claims permission.

## Fixed method and checks

Use prices from 2018–2021. Compute simple returns `r[t] = P[t]/P[t-1] − 1`, loss `L[t] = −r[t]`, and the linear empirical 95th percentile of the **252 strictly preceding** losses. Exceedance means today's loss is strictly greater than its threshold. Full warm-up windows only; evaluation runs from **4 January 2019 through 31 December 2021**. Using 2018 as initial history leaves the first two 2019 sessions in warm-up. Returns span adjacent observed sessions.

The code applies `loss.shift(1).rolling(252, min_periods=252).quantile(.95, interpolation='linear')`. Three saved checks recompute exact windows and show that perturbing today's loss leaves its threshold unchanged. A separate standard-library script independently sorts prior windows and linearly interpolates quantiles; its yearly counts and drawdown agree. [Verification results](verification.json) include exact dates at both edges of each checked window.

The return plot overlays the corresponding **negative** loss threshold and highlights breaches. The drawdown plot uses `price / running_max(price) − 1`, with the running maximum beginning at the first retained January 2018 observation. The nominal 5% count is a reference, not a promised rate or a formal calibration test. Dependence, a single index/window, omitted dividends, costs and portfolio weights limit generalization.

## Inspect and reproduce

[Native IDs/output manifest](native-project.json), [exact code](analysis.py), [daily calculation audit](outputs/daily-calculation-audit.csv), two SVG figures and compact tables in `outputs/` are saved. The native app preserves input snapshot, exact Ask approval, completed Docker run, artifacts, explicit reuse and an editable conclusion across the original related independent notes, now nested in the four-stage structure. For the original baseline, code was prepared by the coding assistant with no paid model/search call. The later extension above records its actual fresh inference/search work separately. All four supporting-demo figures were rendered and visually inspected; labels and captions fit.

```sh
python3 examples/demo-market-risk/verify-calculations.py
```

`node scripts/create-supporting-demos.mjs --create` creates both demos only on a fresh installation; existing projects/reports are preserved. No automatic retry is attempted after a failure. A 30-second local tour: question, return/threshold plot, 2020's 21/253 versus the overall 31/755, drawdown plot, then the qualified conclusion. Present the saved evaluation as prepared work.
