"""Direct independent empirical check; no unit-test framework or extra provider work."""
import csv,json,math
from pathlib import Path
root=Path(__file__).resolve().parent
with (root.parent/'source/fred-sp500-2018-2021.csv').open() as f:
    p=[(r['observation_date'],float(r['SP500'])) for r in csv.DictReader(f) if r['SP500'].strip()]
loss=[None]+[-(p[i][1]/p[i-1][1]-1) for i in range(1,len(p))]
def q95(xs):
    s=sorted(xs);i=(len(s)-1)*.95;lo=math.floor(i)
    return s[lo]+(i-lo)*(s[lo+1]-s[lo])
rows=[]
for i in range(253,len(p)):
    if '2019-01-01'<=p[i][0]<='2021-12-31':
        rows.append({'date':p[i][0],'q126':q95(loss[i-126:i]),'q252':q95(loss[i-252:i]),'loss':loss[i]})
summary=[]
for year in ['all','2019','2020','2021']:
    r=[x for x in rows if year=='all' or x['date'].startswith(year)]
    for w in [126,252]:
        n=sum(x['loss']>x[f'q{w}'] for x in r)
        summary.append({'period':year,'window':w,'n':len(r),'exceedances':n,'percent':100*n/len(r)})
manifest=json.loads((root/'native-extension.json').read_text())
audit=next(x for x in manifest['artifacts'] if x['kind']=='dataset')
with Path(audit['path']).open() as f:observed=list(csv.DictReader(f))
assert len(rows)==len(observed)==755
max_error=0
for expected,saved in zip(rows,observed):
    assert expected['date']==saved['date']
    for w in [126,252]:
        max_error=max(max_error,abs(expected[f'q{w}']-float(saved[f'q{w}'])))
        assert abs(expected[f'q{w}']-float(saved[f'q{w}']))<1e-12
        assert (expected['loss']>expected[f'q{w}'])==(saved[f'breach{w}'].lower()=='true')
report={'checked':'Independent stdlib quantile calculation on each exact prior window; compared both thresholds and breach flags across all 755 output rows. No model or network calls.','rows':len(rows),'maximum_threshold_difference':max_error,'summary':summary,'nativeRunId':manifest['runId']}
(root/'calculation-check.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
