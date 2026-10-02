#!/usr/bin/env python3
"""Rebuild the real-weather prerequisite CSV from the captured KNMI response.

Offline and deterministic; does not call a model, NDW, or any network service.
Use --check to verify the checked-in output without changing it.
"""
import argparse
import csv
import hashlib
import io
import json
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "amsterdam-cycling-weather"
LOCAL = ZoneInfo("Europe/Amsterdam")
UTC = timezone.utc
START, END = date(2024, 1, 1), date(2025, 1, 1)
FIELDS = ["local_date", "rain_mm", "is_weekend", "month", "season", "temp_c",
          "wind_ms", "observed_hours", "expected_hours", "rain_trace_hours",
          "trace_max_additional_mm", "rain_missing_hours", "temp_missing_hours",
          "wind_missing_hours", "station_id"]


def sha256(content):
    return hashlib.sha256(content).hexdigest()


def prepare():
    raw = (EXAMPLE / "source/knmi-schiphol-hourly-2024.txt").read_bytes()
    source = json.loads((EXAMPLE / "source/weather-retrieval.json").read_text())
    if sha256(raw) != source["sha256"]:
        raise ValueError("Captured KNMI input does not match its retrieval hash")
    grouped, seen = defaultdict(list), set()
    source_rows = 0
    for record in csv.reader(line for line in raw.decode().splitlines()
                             if line.strip() and not line.startswith("#")):
        if len(record) != 6:
            raise ValueError("Unexpected KNMI schema; expected STN,YYYYMMDD,HH,T,FH,RH")
        stn, day, hour, temp, wind, rain = [part.strip() for part in record]
        if stn != "240" or not 1 <= int(hour) <= 24:
            raise ValueError("Unexpected station or hour")
        # KNMI HH=5 is 04:00–05:00 UTC; HH=24 ends at next midnight.
        interval_end = datetime.strptime(day, "%Y%m%d").replace(tzinfo=UTC) + timedelta(hours=int(hour))
        interval_start = interval_end - timedelta(hours=1)
        if interval_start in seen:
            raise ValueError("Duplicate hourly observation")
        seen.add(interval_start)
        source_rows += 1
        local_day = interval_start.astimezone(LOCAL).date()
        if START <= local_day < END:
            values = [None if value == "" else int(value) for value in (temp, wind, rain)]
            if values[2] is not None and values[2] < -1:
                raise ValueError("Unexpected precipitation sentinel")
            grouped[local_day].append((interval_start, *values))

    rows, day = [], START
    while day < END:
        hours = sorted(grouped.get(day, []))
        midnight = datetime.combine(day, time(), LOCAL).astimezone(UTC)
        tomorrow = datetime.combine(day + timedelta(days=1), time(), LOCAL).astimezone(UTC)
        expected = int((tomorrow - midnight).total_seconds() / 3600)
        expected_starts = [midnight + timedelta(hours=i) for i in range(expected)]
        if [item[0] for item in hours] != expected_starts:
            raise ValueError(f"Incomplete/misaligned hourly coverage on {day}")
        temps, winds, rains = ([item[index] for item in hours] for index in (1, 2, 3))
        missing = [sum(value is None for value in values) for values in (rains, temps, winds)]
        traces = rains.count(-1)
        # Trace RH=-1 is <0.05 mm. Preserve count, use zero only as the declared lower-bound convention.
        rain_mm = "" if missing[0] else f"{sum(max(0, value) for value in rains) / 10:.1f}"
        mean_temp = "" if missing[1] else f"{sum(temps) / len(temps) / 10:.3f}"
        mean_wind = "" if missing[2] else f"{sum(winds) / len(winds) / 10:.3f}"
        season = {12: "winter", 1: "winter", 2: "winter", 3: "spring", 4: "spring", 5: "spring",
                  6: "summer", 7: "summer", 8: "summer", 9: "autumn", 10: "autumn", 11: "autumn"}[day.month]
        rows.append([day.isoformat(), rain_mm, int(day.weekday() >= 5), day.month, season,
                     mean_temp, mean_wind, len(hours), expected, traces, f"{traces * .05:.2f}", *missing, 240])
        day += timedelta(days=1)

    assert len(rows) == 366
    assert sum(row[8] for row in rows) == 8784
    assert {row[0]: row[8] for row in rows}["2024-03-31"] == 23
    assert {row[0]: row[8] for row in rows}["2024-10-27"] == 25
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(FIELDS)
    writer.writerows(rows)
    output = buffer.getvalue().encode()
    report = {
        "status": "real weather prerequisite only; bicycle counts not acquired",
        "sourceSha256": sha256(raw), "preparedCsvSha256": sha256(output),
        "sourceRows": source_rows, "retainedHourlyRows": 8784, "dailyRows": len(rows),
        "startLocalDate": START.isoformat(), "endLocalDateInclusive": "2024-12-31",
        "timezone": "Europe/Amsterdam", "duplicateHours": 0, "missingIntervals": 0,
        "missingValues": {name: sum(row[index] for row in rows)
                          for name, index in (("rain", 11), ("temperature", 12), ("wind", 13))},
        "dstDayHours": {row[0]: row[8] for row in rows if row[8] != 24},
        "traceHours": sum(row[9] for row in rows),
        "traceConvention": "rain_mm assigns RH=-1 a zero contribution; actual trace is <0.05 mm per trace hour. trace_max_additional_mm bounds only omitted trace (exclusive when trace count is positive), not total measurement uncertainty.",
        "bicycleCountRows": 0,
        "modelAnalysisPerformed": False,
    }
    return output, (json.dumps(report, indent=2) + "\n").encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    csv_bytes, report_bytes = prepare()
    for name, content in (("schiphol-weather-2024.csv", csv_bytes), ("preparation.json", report_bytes)):
        target = EXAMPLE / name
        if args.check:
            if not target.exists() or target.read_bytes() != content:
                raise SystemExit(f"Mismatch: {target}")
        else:
            target.write_bytes(content)
    print("Verified 366 local calendar days, 8,784 aligned hourly observations, DST boundaries and source/output hashes.")
    print("Bicycle counts remain missing. This CSV cannot answer the cycling–rainfall association question.")


if __name__ == "__main__":
    main()
