# Amsterdam-area rainfall patterns for cycling planning

Completed native ros.ai demonstration, 23 September 2026. Open **Amsterdam-area rainfall patterns for cycling planning**, then **What did the weather actually show?** for two saved plots. The original cycling question and the decision to narrow it are preserved in the question and challenge notes, and in project conversation memory.

The real Docker run finds **1,047.0 mm** across **366 complete local days**, with **155/366 wet days (42.35%)** under the ≥1 mm definition. No day is missing; median precipitation is 0.35 mm/day. The monthly plot labels each numerator/denominator. The second plot shows daily rainfall over time.

This is the explicitly activated weather-only fallback. No compatible cycling counts were obtained. [NDW's current API documentation](https://docs.ndw.nu/data-uitwisseling/interface-beschrijvingen/fiets-api/) still specifies OAuth access, checked 23 September. Candidate counter locations alone are not observations. The previously inspected public export required email/CAPTCHA; no export was submitted. These results cannot establish cycling behavior, demand, a causal effect, trip exposure or future weather.

The immutable CSV is an unchanged copy of the [existing verified KNMI preparation](../amsterdam-cycling-weather/README.md). That directory retains the full original hourly response, request timestamp and preparation checks. Royal Netherlands Meteorological Institute (KNMI), station 240 Schiphol, [hourly observations](https://www.daggegevens.knmi.nl/klimatologie/uurgegevens), [CC BY 4.0 attribution terms](https://english.knmidata.nl/open-data). Schiphol is an Amsterdam-area geographic proxy. Local days use Europe/Amsterdam and include the 23/25-hour DST days. Data was retrieved 21 September 2026.

Hourly trace encoding RH=-1 denotes less than 0.05 mm. Baseline totals count traces as zero while retaining 843 trace hours. An illustrative 0.025 mm/trace-hour scenario gives 158 wet days instead of 155; this is sensitivity analysis, not observed trace quantities. “Below 1 mm” includes trace/light rainfall.

The six independent notes link question, source, method, analysis, challenge and conclusion. Exact dataset versions are explicitly selected. Relationships do not run work. The editable conclusion comes from the completed calculation. Code was authored by the coding assistant; no app-model inference or paid search was used. [Native IDs and output manifest](native-project.json), [code](analysis.py), [independent arithmetic verification](verification.json) and immutable exported figures/tables in `outputs/` make the result inspectable. All four supporting-demo figures were rendered and visually inspected together; labels and captions fit.

Recheck the saved calculations without services:

```sh
python3 examples/demo-amsterdam/verify-calculations.py
```

On a fresh local ros.ai installation, `node scripts/create-supporting-demos.mjs --create` imports the captured files and executes both supporting programs with exact Ask approvals. It refuses to overwrite existing projects or retry an incomplete report. Current saved executions are already complete; do not rerun merely to view them.

A 30-second tour: show the explicitly narrowed question, both plots, the 155/366 statistic, then the challenge note explaining why cycling remains unmeasured.
