"""Independent stdlib calculation checks the saved pandas result."""
import csv,json,math
from collections import Counter
from pathlib import Path
root=Path(__file__).parent
raw=list(csv.DictReader((root/'source/fred-sp500-2018-2021.csv').open()))
rows=[(r['observation_date'],float(r['SP500'])) for r in raw if r['SP500'] not in ('','.','nan')]
assert len({r[0] for r in rows})==len(rows)
losses=[None]+[-(rows[i][1]/rows[i-1][1]-1) for i in range(1,len(rows))]
counts=Counter();breaches=Counter();checks=[]
for i in range(253,len(rows)):
    date=rows[i][0]
    if not '2019-01-01'<=date<='2021-12-31':continue
    prior=sorted(losses[i-252:i]);assert len(prior)==252 and None not in prior
    index=251*.95;lo=math.floor(index);weight=index-lo
    quantile=prior[lo]*(1-weight)+prior[lo+1]*weight
    counts[date[:4]]+=1;breaches[date[:4]]+=int(losses[i]>quantile)
    if date in ('2019-01-04','2020-03-16','2021-12-31'):
        checks.append({'day':date,'latest_input':rows[i-1][0],'oldest_input':rows[i-252][0],'threshold':quantile})
assert dict(counts)=={'2019':250,'2020':253,'2021':252}
assert dict(breaches)=={'2019':4,'2020':21,'2021':6}
high=0;worst=0
for date,price in rows:
    high=max(high,price);worst=min(worst,price/high-1)
assert round(worst*100,2)==-33.92
report={'checked':'independent sorted linear quantiles and previous-observation slicing; same counts as saved pandas run','raw_rows':len(raw),'observed_prices':len(rows),'blank_prices_excluded':len(raw)-len(rows),'eligible_counts':dict(counts),'exceedances':dict(breaches),'overall_exceedances':sum(breaches.values()),'overall_observations':sum(counts.values()),'worst_drawdown_percent':worst*100,'spot_windows':checks}
(root/'verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
