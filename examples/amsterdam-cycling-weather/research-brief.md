# Model-visible research brief

Research question: At selected Amsterdam bicycle counters, how is daily precipitation associated with bicycle counts, and does that association differ between weekdays and weekends? Possible later follow-ups are season and location. These are independent, user-directed research activities; this brief does not authorize a fixed pipeline or spending.

## Evidence presently available

The selected CSV `schiphol-weather-2024.csv` is real KNMI weather data, station 240 (Schiphol Airport, 52.318 N, 4.790 E), for all 366 Europe/Amsterdam calendar days in 2024. Its columns are local_date, rain_mm, is_weekend, month, season, temp_c, wind_ms, observed_hours, expected_hours, rain_trace_hours, trace_max_additional_mm, rain_missing_hours, temp_missing_hours, wind_missing_hours, station_id. Precipitation RH=-1 means <0.05 mm. rain_mm treats that as zero and retains trace counts for sensitivity analysis. Precipitation includes snow/hail as well as rain. Daily weather is not trip-level rain exposure.

There are **no bicycle count observations** in the CSV. Never invent them, turn station metadata into counts, or report a cycling–rainfall relationship from weather alone. A real model-led weather prerequisite analysis and an identified data gap are useful results; they are not completion of the original question.

Public NDW metadata verifies three candidate permanent radar sites: Erasmusgracht (PNH08_11_9), Zuiderzeeweg (PNH08_11_8), De Ruyterkade (PNH08_11_5). Their straight-line distances from Schiphol are approximately 7.24, 13.09 and 10.13 km. Showers can differ across those distances. Metadata validity is not observation coverage. NDW's export form requires email/CAPTCHA; the authenticated count API requires OAuth. No request was submitted and no account created.

## Hypothesis and background

Working hypothesis, untested here: on comparable days at a fixed counter, greater precipitation is associated with fewer bicycle passages; the strength may differ on weekends because trip purposes differ. Weekend is an imperfect proxy for trip purpose. Temperature, wind, season, holidays, events, closures and sensor failure are possible competing explanations.

Thomas, Jaarsma and Tutert studied counts near Ede and Gouda and found different weather sensitivity for recreational and utilitarian paths. This motivates investigating day type and location; it does not establish the result in Amsterdam. Source: https://link.springer.com/article/10.1007/s11116-012-9398-5

Helbich, Böcker and Dijst studied geographic heterogeneity using Rotterdam travel diaries. This motivates caution about applying a single weather relationship everywhere. Source: https://research-portal.uu.nl/en/publications/geographic-heterogeneity-in-cycling-under-various-weather-conditi/

## Work possible now

Audit weather completeness including DST, show weekday/weekend and seasonal sample sizes, plot monthly precipitation totals and rainfall distributions, and quantify wet-day share with an explicit threshold (for example at least 1 mm/day). A subsequent Action can compare within seasons and check trace-as-zero versus trace-as-0.025 mm/hour. Explain how every result helps prepare the eventual join and which conclusions remain unsupported. Use actual execution outputs, preserve errors/repairs and attempts, and stop or request approval as the project/Action grant requires.

## Work after counts arrive

Inspect raw metadata and classification before aggregation. Verify interval boundaries/time zone, complete hour counts (23/24/25), direction totals, duplicate rows, quality exclusions, missing/negative sentinels and coverage overlap. Keep one row per site/local date. Start with plots and group sizes; then estimate an association allowing temperature, wind, season and day type to differ. Discuss sample size, residual/time dependence and uncertainty. Do not interpret a slope as causal. Re-run for a second season/location only if that data actually exists and the user/grant allows it.

Data sources: https://www.knmi.nl/kennis-en-datacentrum/achtergrond/data-ophalen-vanuit-een-script ; https://dexter.ndw.nu/api/gis/bicycle-data/complete ; https://docs.ndw.nu/producten/fietsdata/ . Weather license/attribution: KNMI, CC BY 4.0, https://english.knmidata.nl/open-data . Exact captured input and derived-output hashes are in preparation.json and source/weather-retrieval.json. This brief records preparation by the coding agent, not an application-model run.
