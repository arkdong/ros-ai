"""Summarize saved experiment receipts; no inference or test execution."""
from pathlib import Path
from datetime import datetime, timezone
import json
ROOT=Path('examples/model-comparison-2026-09-23-rerun')
def read(p): return json.loads((ROOT/p).read_text())
expected={'Adoption gap, largest minus smallest (pp)':41.4,'Largest-group turnover minus enterprise share (pp)':20.3,'Groups where turnover share is below enterprise share':2,'Aggregate size groups':6}
models=[]
for key in ['openai','nemotron','kimi']:
 r=read(f'{key}/receipt.json'); d=read(f'{key}/project-evidence.json'); usage=read(f'{key}/usage.json')
 run=next(x for x in d['runs'] if x['id']==r['execute']['runId'])
 metrics=[{'title':a['title'],'expected':expected.get(a['title']),'actual':json.loads(a['content'])['value']} for a in d['artifacts'] if a['runId']==run['id'] and a['kind']=='metric']
 calls=[]
 for stage in ['plan','interpret']:
  u=next((x for x in usage if x.get('runId')==r.get(stage,{}).get('runId')),None)
  if u is None: continue
  trace=u.get('reportedUsage') or {}; resp=trace.get('response') or {}; meta=resp.get('metadata') or {}; tokens=resp.get('usage') or {}
  calls.append({'stage':stage,'status':u['status'],'estimatedUsd':u['estimatedUsd'],'reservedUsd':u['reservedUsd'],'apiMs':meta.get('latencyMs',(trace.get('failure') or {}).get('latencyMs')),'inputTokens':tokens.get('inputTokens'),'outputTokens':tokens.get('outputTokens'),'reasoningTokens':(meta.get('providerUsage',{}).get('completion_tokens_details') or {}).get('reasoning_tokens'),'finishReason':meta.get('finishReason'),'error':(trace.get('failure') or {}).get('message')})
 models.append({'key':key,'label':r['configuration']['label'],'model':r['configuration']['model'],'projectId':r['projectId'],'calls':calls,'codeUnedited':run['configuration']['code']==read(f'{key}/plan.json')['code'],'numericalMetrics':metrics,'numericalCorrect':sum(abs(m['actual']-m['expected'])<1e-8 for m in metrics if m['expected'] is not None),'draftStatus':r.get('interpret',{}).get('status'),'apiMs':sum(c['apiMs'] or 0 for c in calls),'estimatedUsdKnown':sum(c['estimatedUsd'] or 0 for c in calls),'costComplete':len(calls)==2 and all(c['estimatedUsd'] is not None for c in calls),'reservedUsd':sum(c['reservedUsd'] for c in calls),'inputTokensKnown':sum(c['inputTokens'] or 0 for c in calls),'outputTokensKnown':sum(c['outputTokens'] or 0 for c in calls)})
s={'generatedAt':datetime.now(timezone.utc).isoformat(),'date':'2026-09-23','authorizationId':'benchmark-20260923-v2','capUsd':90,'maxOutputTokens':8000,'models':models,'totals':{'requests':sum(len(m['calls']) for m in models),'estimatedUsdKnown':sum(m['estimatedUsdKnown'] for m in models),'costComplete':all(m['costComplete'] for m in models),'reservedUsd':sum(m['reservedUsd'] for m in models)},'limitations':['One fresh workflow per configuration; not a general ranking.','Response cap increased from prior 1400-token trial to 8000; prior evidence preserved separately.','GPT reasoning none, Nebius provider defaults; API time includes both calls but excludes Python and review.','Concurrent API requests; no sequential-isolation timing guarantee.','Known costs are token-price estimates, not invoices. No unit tests or broad checks were run.']}
(ROOT/'summary.json').write_text(json.dumps(s,indent=2)+'\n')
print(json.dumps(s,indent=2))
