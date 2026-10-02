# Amsterdam cycling and weather — real-data prerequisite

**Status, September 21, 2026:** real Schiphol weather is ready to analyze. Amsterdam bicycle counter locations are verified, but their count observations have **not** been acquired. This example does not yet establish a relationship between rainfall and cycling. There are no synthetic cycling counts in this directory.

Select [schiphol-weather-2024.csv](schiphol-weather-2024.csv) as a read-only local source. It contains 366 local calendar days in 2024, derived from 8,784 actual hourly observations supplied by **KNMI**, station 240, Schiphol Airport. The CSV is about 23 KB and needs no network connection after import. Preserve this README with exports to retain provenance and limitations.

## A useful first Action

Use the [model brief](research-brief.md) for the complete research context, then request:

> Audit this real weather prerequisite dataset before we can study cycling. Check daily/hourly completeness, traces, weekday/weekend sample sizes and season coverage. Plot monthly precipitation totals and daily precipitation distributions by weekday/weekend; include a table of group sizes, wet-day shares using at least 1 mm/day, mean and median precipitation. Explain what the missing bicycle observations prevent us from concluding. Write and execute the analysis within the current grant, inspect its actual outputs, and suggest a follow-up.

After inspecting the result, a user-directed follow-up is:

> Compare those weather distributions within each season. Show whether an overall weekday/weekend difference is consistent across seasons, and compare trace-as-zero with trace-as-0.025 mm/hour. Preserve the first attempt and explain why this is still a weather prerequisite, not evidence that rain changes cycling.

The coding agent prepared the CSV. A model has **not** generated or run either suggested analysis as part of data preparation. Whether the application subsequently completes those steps must be reported from actual run evidence.

## Prepared demonstration: overview, then a seasonal follow-up

[analysis.py](analysis.py) is a ready-to-run program for ros.ai's Docker Python backend. The coding assistant prepared this program; it does not require an application-model or search request. Both parameter settings were executed successfully against the captured real CSV in the actual Docker backend on September 21, 2026. The three resulting SVG figures were rendered and visually inspected. A separate calculation using Python's standard library and decimal arithmetic confirmed annual/group totals, medians, wet-day counts, seasonal comparisons and trace-threshold changes.

1. Open the weather overview Action and inspect its captured input and approved code. Use parameters `{"phase":"overview"}`. The run produces coverage checks, monthly and weekday/weekend summaries, trace sensitivity, two figures and a conclusion. Its completeness checks stop the program if the expected year, station, local dates or weather coverage differs.
2. Open the seasonal follow-up Action. Explicitly select the same immutable dataset and the overview conclusion as context; a canvas relationship by itself does not import them. Use the same program with `{"phase":"seasonal"}`. It recomputes seasonal groups from the captured CSV and produces separate tables, a figure with four seasonal panels, and a new conclusion. The runner reads the CSV; selecting the earlier conclusion preserves the context without making it an extra numerical input.
3. Compare saved attempts and highlight useful plots or conclusions. The overview remains inspectable when the follow-up changes the interpretation. Reusing a highlight selects an exact version and does not start another Action.
4. Inspect the missing-counts Knowledge node or the source review before extending the analysis to cycling. A later count export requires its own quality and time-alignment checks.

The real computations give **1,047.0 mm** of precipitation in 2024 under the trace-as-zero convention. Weekdays average **3.04 mm/day** (262 days), versus **2.40** on weekends (104 days); both medians are **0.35 mm**. The seasonal follow-up reveals that the mean difference reverses in spring: weekend minus weekday precipitation is **−0.19, +0.30, −0.70 and −1.90 mm/day** in winter, spring, summer and autumn. These describe this one observed year, not an established weekend effect.

Replacing zero with an illustrative 0.025 mm per trace hour adds **21.075 mm** to the annual total and moves **three days** into the at-least-1-mm category. The actual omitted trace contribution is below **42.15 mm**. These are sensitivity assumptions, not measured trace values or confidence intervals. **Neither run estimates cycling demand or a causal effect.** The demonstration shows captured inputs, real local computation, charts, evidence reuse, independent follow-up and preserved history; application-model research is a separate capability and needs its own authorization and evidence.

## Fields and measurement meaning

| Field | Meaning |
| --- | --- |
| `local_date` | Calendar date in `Europe/Amsterdam` |
| `rain_mm` | Sum of hourly KNMI RH / 10; trace hours contribute zero under the disclosed convention |
| `is_weekend` | 1 for Saturday/Sunday; 0 otherwise; holidays are not separately classified |
| `month`, `season` | Calendar month and meteorological season; winter combines Jan–Feb and Dec within this single year |
| `temp_c` | Mean of end-of-hour temperature observations belonging to the day's hourly intervals, °C |
| `wind_ms` | Mean of the hourly mean wind speeds, m/s |
| `observed_hours`, `expected_hours` | Coverage: 23, 24 or 25 hours according to daylight saving time |
| `rain_trace_hours` | Number of RH=-1 observations, each denoting precipitation below 0.05 mm |
| `trace_max_additional_mm` | Upper bound on precipitation omitted by the trace-as-zero convention, exclusive when trace count is positive; does not bound all measurement uncertainty |
| `rain_missing_hours`, `temp_missing_hours`, `wind_missing_hours` | Missing observed values; all zero in this captured year |
| `station_id` | 240, Schiphol Airport |

Precipitation includes forms other than rain. A daily total is not a measurement of a cyclist's exposure during a particular trip. The temperature field is not KNMI's separately published daily TG series. These semantics come from the retained source header and [KNMI documentation](https://www.knmi.nl/kennis-en-datacentrum/achtergrond/data-ophalen-vanuit-een-script).

## Getting to the original cycling question

The [NDW public export form](https://dexter.ndw.nu/opendata/bicycle) offers historical bicycle data, but the checked form requires an email address and CAPTCHA and says processing can take up to 24 hours. No export was submitted. The [count API documentation](https://docs.ndw.nu/data-uitwisseling/interface-beschrijvingen/fiets-api/) requires OAuth. A public station record proves location/configuration, not the existence or completeness of observations in 2024.

A suitable next input is an NDW export for **Erasmusgracht** (`PNH08_11_9`, internal ID `8599`) and optionally **Zuiderzeeweg** (`PNH08_11_8`, ID `8209`), ideally hourly throughout 2024, with location metadata, bicycle classification, measurement completeness and quality flags. Include both directions exactly once. Both are candidate permanent radar stations, not yet validated count series. If only shorter windows are available, retain their actual dates and narrow the question.

On receipt, preserve the original export, verify its license, time zone and whether timestamp denotes interval start/end, then sum complete hours into the same local days. Missing or negative count sentinels must remain missing rather than become zero. Exclude incomplete days transparently; never extrapolate a few recorded hours into a daily count without a separate justified method. Join one site/date to one weather date. Keep sites separate so an extra sensor or missing sensor cannot masquerade as a change in demand. Then ask the model to plot counts against rainfall, compare weekday/weekend patterns with sample sizes and uncertainty, and investigate season or location as a follow-up. Report association rather than causation.

## Reproduce and inspect

```sh
python3 scripts/prepare-amsterdam-weather.py
python3 scripts/prepare-amsterdam-weather.py --check
```

Both commands run offline using the captured source; the first rebuilds the CSV and preparation report, and the second checks them without writes. Preparation verifies the source hash, unique hours, all 366 dates, zero missing intervals and the 23-hour March 31 / 25-hour October 27 days. The response also contained hours outside 2024; the script filters by local interval start, not by the request's date string.

- [Preparation and quality evidence](preparation.json)
- [Raw KNMI response](source/knmi-schiphol-hourly-2024.txt) and [request/time/hash](source/weather-retrieval.json)
- [Three candidate NDW station records](source/ndw-amsterdam-candidate-sites.geojson), [retrieval/hash](source/sites-retrieval.json), and [export access check](source/ndw-export-access.json)
- [Detailed source and alignment review](../../docs/amsterdam-data.md)

KNMI data: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), attribution **Royal Netherlands Meteorological Institute (KNMI)**; this derived CSV converts units and groups hourly observations into local days. [KNMI's open-data policy](https://english.knmidata.nl/open-data) specifies that license. NDW candidate metadata declares `pddl`; its records are retained with source attribution. No count-data license or coverage claim is made for an export that has not been received.
