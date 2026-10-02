"""Extract factual numeric tables from the preserved CBS web-tool capture.

No observations are synthesised. The capture is published aggregate data,
not enterprise microdata or a directly downloaded publisher CSV.
"""
import csv
import hashlib
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parent
source = root / 'source/cbs-published-tables.txt'
text = re.sub(r'L\d+: ?', '', source.read_text())
adoption = re.findall(r'(10-19|20-49|50-99|100-249|250-499|500 or more)\s+employees\s*\|\s*([\d.]+)\s*\|\s*([\d.]+) - ([\d.]+)', text)
turnover = re.findall(r'(10-19|20-49|50-99|100-249|250-499|500 employees and more)\s*(?:employees)?\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*(?:\n|$)', text)
assert len(adoption) == 6 and len(turnover) == 6
rows = []
for i, (size, value, low, high) in enumerate(adoption):
    revenue_size, revenue, non_revenue = turnover[i]
    assert size == revenue_size or (size == '500 or more' and revenue_size == '500 employees and more')
    assert abs(float(revenue) + float(non_revenue) - 100) < 1e-9
    rows.append(dict(size_order=i+1, size_group=size.replace(' or more', '+'), year=2024,
                     ai_enterprise_percent=value, published_ci_low=low, published_ci_high=high,
                     adopter_turnover_percent=revenue, nonadopter_turnover_percent=non_revenue,
                     minimum_persons=10, sectors='NACE C-N and Q', provisional=1))
destination = root / 'cbs-ai-size-2024.csv'
with destination.open('w', newline='') as stream:
    writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
metadata = dict(
    publisher='Statistics Netherlands (CBS)', publication='Dutch AI monitor 2024, chapter 2',
    publication_date='2025-06-18', retrieved_date='2026-09-23',
    url='https://www.cbs.nl/en-gb/longread/aanvullende-statistische-diensten/2025/ai-monitor-2024/2-use-of-ai-technology-by-dutch-companies',
    table_ids=['2.1.3', '2.2.1'], period='2024', geography='Netherlands',
    population='Enterprises with 10 or more persons employed in NACE sections C through N and Q; English source labels size groups employees.',
    measure='Use of at least one of seven AI technologies; enterprise percentage and share of turnover belonging to AI-using enterprises are distinct denominators.',
    excluded='Enterprises with fewer than 10 persons employed and sectors outside C-N,Q. No productivity, loan or causal-impact observations.',
    missingness='All six published size bins have numeric values in both captured tables. No missing values converted to zero; no enterprise-level sample counts provided in the chart.',
    transformations='Programmatic extraction of six bins from preserved web text; joined by size label; 500 or more normalised to 500+. No smoothing or imputation. Published CI endpoints retained unchanged.',
    retrieval_method='Public web browsing tool rendered table text. Direct HTTPS requests returned 500; this is a derived CSV, not a raw publisher CSV.',
    source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
    csv_sha256=hashlib.sha256(destination.read_bytes()).hexdigest(), rows=len(rows),
    authorship='Prepared by coding assistant. No ros.ai model or Tavily request.')
(root / 'preparation.json').write_text(json.dumps(metadata, indent=2) + '\n')
print(json.dumps({'rows': len(rows), 'csv_sha256': metadata['csv_sha256']}))
