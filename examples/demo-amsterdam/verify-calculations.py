"""Independent stdlib spot-check of the saved weather calculation."""
import csv, json
from decimal import Decimal
from pathlib import Path
root=Path(__file__).parent
rows=list(csv.DictReader((root/'schiphol-weather-2024.csv').open()))
assert len(rows)==366 and len({r['local_date'] for r in rows})==366
rain=[Decimal(r['rain_mm']) for r in rows]
assert sum(rain)==Decimal('1047.0')
assert sum(x>=1 for x in rain)==155
assert sum(Decimal(r['rain_mm'])+Decimal('.025')*int(r['rain_trace_hours'])>=1 for r in rows)==158
assert sum(int(r['observed_hours']) for r in rows)==8784
assert all(r['rain_missing_hours']=='0' for r in rows)
report={'checked':'independent decimal sums, wet-day counts and interval coverage','observed_days':366,'precipitation_mm':1047.0,'wet_days':155,'wet_day_percent':155/366*100,'trace_midpoint_wet_days':158,'missing_precipitation_hours':0}
(root/'verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
