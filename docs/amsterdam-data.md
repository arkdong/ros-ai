# Amsterdam cycling/weather data review

Verified September 21, 2026. The deliverable is a **real-weather prerequisite**, with a documented bicycle-observation gap. No synthetic observations are represented as real, no cycling result is inferred, and no paid provider call or external export request was made for this review.

## What was obtained

The [example directory](../examples/amsterdam-cycling-weather/README.md) contains 366 daily rows derived from 8,784 KNMI Schiphol hourly observations covering local calendar year 2024. The raw response, retrieval request/time/hash, derived CSV hash, offline preparation program and quality report are retained. All retained intervals and requested precipitation/temperature/wind values are present. The CSV has no bicycle-count column.

Hourly data came from KNMI's documented POST interface with station `240`, variables `T:FH:RH`, start `2023123101`, end `2025010124`. The response contains 8,856 rows including padding beyond the desired year; only intervals belonging to 2024 local days are retained. KNMI announces retirement of this script interface at the end of 2026; its replacement data platform requires a free API key. No key/account was created. Captured inputs remain usable offline. [KNMI interface documentation](https://www.knmi.nl/kennis-en-datacentrum/achtergrond/data-ophalen-vanuit-een-script)

## Counts: locations verified, observations unverified

[NDW's public GIS response](https://dexter.ndw.nu/api/gis/bicycle-data/complete) provided these actual records. Coordinates are WGS84 longitude/latitude. Distances are great-circle calculations from the KNMI station coordinates, rounded to two decimals.

| Site | NDW identifier / internal ID | Longitude, latitude | Distance to Schiphol |
| --- | --- | --- | --- |
| Erasmusgracht | PNH08_11_9 / 8599 | 4.8396611, 52.3756332 | 7.24 km |
| Zuiderzeeweg | PNH08_11_8 / 8209 | 4.9625788, 52.3703575 | 13.09 km |
| De Ruyterkade | PNH08_11_5 / 8214 | 4.8959308, 52.3820763 | 10.13 km |

These records identify permanent radar counters supplied by Multisensors for Provincie Noord-Holland, with `licenseCategory: pddl`. Their `validFrom` is June 21, 2022 and `validUntil` is null. Those are station configuration validity fields, **not evidence of continuous observations**, accurate classification or available dates. Do not use validity to fill counts or assert 2024 coverage.

The [public export form](https://dexter.ndw.nu/opendata/bicycle) was inspected in an actual browser. It includes an email input, CAPTCHA, a limit of ten locations/366 days and a processing notice of up to 24 hours. Read-only verification is in [the access record](../examples/amsterdam-cycling-weather/source/ndw-export-access.json). We did not supply email, solve CAPTCHA, submit the form or send a message. [The count API](https://docs.ndw.nu/data-uitwisseling/interface-beschrijvingen/fiets-api/) documents OAuth/service-account access. A suitable export provided by the user is the narrowest next dependency.

City Amsterdam's catalog/API index and official reports were checked for directly downloadable dated counts. The retrieved material did not establish a usable daily/hourly Amsterdam observation series. This is an access/verification gap, not a claim that Amsterdam has no bicycle-count data. NDW says its collection contains both continuous and periodic sites, with varying source intervals and classifications. [NDW product documentation](https://docs.ndw.nu/producten/fietsdata/)

## Alignment and quality contract

KNMI hour `05` denotes 04:00–05:00 UTC and hour `24` ends at the next midnight. Preparation converts each interval's start to `Europe/Amsterdam` and groups by its local date. Consequently March 31 has 23 hours and October 27 has 25; both are explicitly validated. Using KNMI's UTC daily date directly against local counter dates would shift one/two midnight hours. Missing observations are never treated as dry weather. [KNMI's daily time convention](https://www.knmi.nl/kennis-en-datacentrum/achtergrond/daggegevens-van-het-weer)

RH is precipitation amount in 0.1 mm, with -1 meaning a trace below 0.05 mm. The derived `rain_mm` uses zero for trace contributions while retaining all 843 trace-hour flags and their per-day counts. A sensitivity analysis can assign 0.025 mm to each trace. This addresses censoring only, not instrument uncertainty. Temperature is the mean of hourly point observations and wind the mean of hourly mean speeds; both are converted from tenths. No long-term climate trend inference is supported.

Schiphol is an airport weather proxy, 7–13 km from these three sites. Geographic proximity does not prove the same shower occurred at a counter. Counts must describe bicycle passages rather than unique riders or whole-city demand. Once counts exist, verify classification and direction semantics; reject negative error values and incomplete days, document exclusions, check duplicates, and retain each location separately. The original NDW export and its completeness/quality data must accompany any prepared join. [NDW bicycle data specification](https://docs.ndw.nu/producten/fietsdata/2023.05.01%20dataformaat%20fietstellingen%20v3.3.pdf)

## Research use and limits

The original hypothesis is a lower passage count on wetter days with potentially different weekday/weekend associations. This remains untested. First inspect weather support and sample sizes, then join counts only where both sources cover the same actual intervals. One year is useful for an exploratory demonstration; holidays, closures, events, daylight, temperature, wind and season may confound the relation. Weekend does not identify an individual's trip purpose. Neither raw correlation nor an adjusted observational regression establishes causation.

[Thomas, Jaarsma and Tutert (2013)](https://link.springer.com/article/10.1007/s11116-012-9398-5) analyzed cycle paths near Ede and Gouda and reported differing weather sensitivity by path use. [Helbich, Böcker and Dijst](https://research-portal.uu.nl/en/publications/geographic-heterogeneity-in-cycling-under-various-weather-conditi/) examined geographic heterogeneity in Rotterdam. These studies motivate checking day type, season and location; they are background, not Amsterdam results.

A clearly labeled alternative available now is **Schiphol weather readiness for an Amsterdam cycling study**: audit data, show rain distributions by day type, and follow up within seasons. It uses real data and can exercise a model-written analysis/repair/interpretation loop, while the missing-count Action remains visible. Completing that prerequisite must not be described as completing the original cycling-weather journey.

## Terms and reproducibility

Weather is provided by **Royal Netherlands Meteorological Institute (KNMI)** under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), as stated in [KNMI's open-data policy](https://english.knmidata.nl/open-data). Attribution and transformation disclosure accompany the CSV. NDW candidate station records declare PDDL; this is distinct from NDW's general website CC0 notice. Before using an actual count export, inspect its own metadata and terms. No endorsement by either source is implied.

Run `python3 examples/amsterdam-cycling-weather/prepare.py --check` to verify the saved result against the captured inputs. This is preparation/validation by the coding agent, not evidence of a live application-model run. Application-model planning, execution, interpretation and follow-up must be proven by their own captured requests and outputs after an applicable spend authorization.
