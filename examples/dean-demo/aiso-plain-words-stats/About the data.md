**Source:** KNMI (Royal Netherlands Meteorological Institute), weather station 240 at Schiphol Airport. Hourly measurements for 2024, added up into 366 local calendar days. Licence CC BY 4.0, attribution KNMI.

**Columns in plain words**
- `local_date`: the day; `is_weekend`: 1 for Saturday and Sunday; `month` and `season`.
- `rain_mm`: precipitation that day in millimetres (rain, snow and hail).
- `temp_c`: average temperature; `wind_ms`: average wind speed in metres per second.
- `rain_trace_hours`: hours with a trace of rain (less than 0.05 mm), counted as zero in `rain_mm`.
- `observed_hours` and the `*_missing_hours` columns: how complete each day is.

**Limits:** one station and one year. Weekend and weekday groups are unequal in size (104 and 262 days). Weather at Schiphol is not the weather everywhere in Amsterdam.
