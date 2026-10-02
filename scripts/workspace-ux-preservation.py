#!/usr/bin/env python3
"""Read-only database/artifact audit. Writes sanitized evidence, never app state.

python3 scripts/workspace-ux-preservation.py --phase preflight
python3 scripts/workspace-ux-preservation.py --phase final
"""
import argparse
import hashlib
import json
import sqlite3
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAID_NAMESPACES = {
    'combined-nebius-admission', 'combined-nebius-grant',
    'sandbox-admission', 'sandbox-grant',
}
ACTIVE = {'queued', 'running'}


def json_text(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(json_text(value).encode('utf-8')).hexdigest()


def encoded(value):
    return {'sqliteBlobHex': value.hex()} if isinstance(value, bytes) else value


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def snapshot(path, immutable=False):
    wal = Path(str(path) + '-wal')
    if immutable and wal.exists() and wal.stat().st_size:
        raise RuntimeError('Backup has a nonempty WAL; immutable backup reading would omit it.')
    # Only the closed, complete backup is immutable. The normal database must
    # include its live WAL through a regular read-only transaction.
    connection = sqlite3.connect(path.as_uri() + '?mode=ro' + ('&immutable=1' if immutable else ''), uri=True)
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('BEGIN')
        tables = {}
        names = [r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        for name in names:
            info = list(connection.execute('PRAGMA table_info(' + identifier(name) + ')'))
            columns = [row[1] for row in info]
            primary = [row[1] for row in sorted(info, key=lambda row: row[5]) if row[5]]
            if not primary:
                raise RuntimeError('Audit requires a primary key for table ' + name)
            rows = [dict(zip(columns, map(encoded, row))) for row in connection.execute('SELECT * FROM ' + identifier(name))]
            tables[name] = {'columns': columns, 'primary': primary, 'rows': rows}
        return tables
    finally:
        connection.close()


def key(row, primary):
    return json_text([row[column] for column in primary])


def compare(before, current, primary, columns):
    old = {key(row, primary): row for row in before}
    new = {key(row, primary): row for row in current}
    missing, changed, matching = [], [], []
    for row_key in sorted(old):
        old_row = {column: old[row_key][column] for column in columns}
        row_id = {column: old[row_key][column] for column in primary}
        if row_key not in new:
            missing.append(row_id)
            continue
        new_row = {column: new[row_key].get(column) for column in columns}
        matching.append(new_row)
        if old_row != new_row:
            changed_columns = [column for column in columns if old_row[column] != new_row[column]]
            detail = {'key': row_id, 'columns': changed_columns, 'beforeSha256': digest(old_row), 'currentSha256': digest(new_row)}
            if 'data' in changed_columns:
                try:
                    left, right = json.loads(old_row['data']), json.loads(new_row['data'])
                    detail['changedJsonFields'] = sorted(field for field in left.keys() | right.keys() if left.get(field) != right.get(field))
                    if 'status' in detail['changedJsonFields']:
                        detail['statusTransition'] = {'before': left.get('status'), 'current': right.get('status')}
                except (ValueError, TypeError, AttributeError):
                    pass
            changed.append(detail)
    original = [{column: old[k][column] for column in columns} for k in sorted(old)]
    return {
        'oldRows': len(old), 'currentRows': len(new), 'newRows': len(new.keys() - old.keys()),
        'identicalOldRows': len(old) - len(missing) - len(changed),
        'missingOldRows': len(missing), 'changedOldRows': len(changed),
        'allOldRowsPreserved': not missing and not changed,
        'beforeSha256': digest(original), 'currentMatchedSha256': digest(matching),
        'missing': missing, 'changed': changed,
    }


def records(tables, namespace=None):
    rows = tables.get('workspace_records', {}).get('rows', [])
    return [row for row in rows if namespace is None or row['namespace'] == namespace]


def active_work(tables):
    values = []
    for row in tables.get('runs', {}).get('rows', []):
        run = json.loads(row['data'])
        if run.get('status') in ACTIVE:
            values.append({'id': row['id'], 'kind': run.get('configuration', {}).get('kind', 'provider-run'), 'status': run['status']})
    for row in records(tables):
        value = json.loads(row['data'])
        if value.get('status') in ACTIVE:
            values.append({'id': row['id'], 'kind': row['namespace'], 'status': value['status']})
    return sorted(values, key=lambda value: (value['kind'], value['id']))


def sum_usd(rows, field):
    return float(sum((Decimal(str(row.get(field) or 0)) for row in rows), Decimal(0)))


def paid_summary(tables):
    usage = [json.loads(row['data']) for row in tables['usage']['rows']]
    providers = []
    for provider in sorted({row['provider'] for row in usage}):
        selected = [row for row in usage if row['provider'] == provider]
        providers.append({'provider': provider, 'rows': len(selected), 'statuses': dict(Counter(row['status'] for row in selected)), 'retainedReservedUsd': sum_usd(selected, 'reservedUsd'), 'estimatedUsd': sum_usd(selected, 'estimatedUsd')})
    grants = []
    for row in records(tables, 'combined-nebius-grant'):
        grant = json.loads(row['data'])
        admissions = grant['admissions']
        selected = [row for row in usage if row['id'] in {item['attemptId'] for item in admissions if item['kind'] == 'inference'}]
        reserved = sum_usd(admissions, 'reservedUsd')
        accounted = float(sum((max(Decimal(str(item['reservedUsd'])), Decimal(str(next((row.get('estimatedUsd') or 0 for row in selected if row['id'] == item['attemptId']), 0)))) for item in admissions), Decimal(0)))
        grants.append({'authorizationId': grant['authorizationId'], 'ceilingUsd': grant['maxUsd'], 'admissionCount': len(admissions), 'admissionKinds': dict(Counter(item['kind'] for item in admissions)), 'inferenceUsageRows': len(selected), 'estimatedInferenceUsd': sum_usd(selected, 'estimatedUsd'), 'retainedReservedUsd': reserved, 'accountedUsd': accounted, 'remainingUsd': float(Decimal(str(grant['maxUsd'])) - Decimal(str(accounted)))})
    return {'providers': providers, 'combinedNebius': grants, 'sandboxAdmissions': len(records(tables, 'sandbox-admission'))}


def artifact_files(before_directory, current_directory):
    def hashes(directory):
        return {str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest() for path in directory.rglob('*') if path.is_file()}
    before, current = hashes(before_directory), hashes(current_directory)
    missing = sorted(before.keys() - current.keys())
    changed = [{'path': path, 'beforeSha256': before[path], 'currentSha256': current[path]} for path in sorted(before.keys() & current.keys()) if before[path] != current[path]]
    return {'oldFiles': len(before), 'currentFiles': len(current), 'newFiles': len(current.keys() - before.keys()), 'identicalOldFiles': len(before) - len(missing) - len(changed), 'allOldFilesPreserved': not missing and not changed, 'beforeManifestSha256': digest(before), 'currentMatchedManifestSha256': digest({name: current[name] for name in before if name in current}), 'missing': missing, 'changed': changed}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=['preflight', 'final'], default='preflight')
    parser.add_argument('--backup', type=Path, default=ROOT / '.ros-ai-backups/20260923-workspace-ux')
    parser.add_argument('--current', type=Path, default=ROOT / '.ros-ai')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    before_directory, current_directory = args.backup.resolve(), args.current.resolve()
    before_path, current_path = before_directory / 'ros-ai.sqlite', current_directory / 'ros-ai.sqlite'
    before, current = snapshot(before_path, immutable=True), snapshot(current_path)
    tables = []
    for name, value in before.items():
        result = compare(value['rows'], current.get(name, {}).get('rows', []), value['primary'], value['columns'])
        tables.append({'table': name, 'primaryKeyColumns': value['primary'], 'comparedColumns': value['columns'], **result})
    old_usage, new_usage = before['usage'], current['usage']
    usage_comparison = compare(old_usage['rows'], new_usage['rows'], old_usage['primary'], old_usage['columns'])
    old_paid = [row for row in records(before) if row['namespace'] in PAID_NAMESPACES]
    new_paid = [row for row in records(current) if row['namespace'] in PAID_NAMESPACES]
    grant_comparison = compare(old_paid, new_paid, ['namespace', 'id'], ['namespace', 'id', 'project_id', 'data'])
    finished_before = [row for row in before['runs']['rows'] if json.loads(row['data']).get('status') not in ACTIVE]
    finished_ids = {row['id'] for row in finished_before}
    terminal_comparison = compare(finished_before, [row for row in current['runs']['rows'] if row['id'] in finished_ids], before['runs']['primary'], before['runs']['columns'])
    result = {
        'checkedAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
        'phase': args.phase, 'beforeDatabase': str(before_path.relative_to(ROOT)), 'currentDatabase': str(current_path.relative_to(ROOT)),
        'readOnly': True,
        'method': 'SQLite URI mode=ro, query_only, explicit read transactions. Closed backup has no nonempty WAL and is read immutable; live database includes its WAL. Every original column value is compared directly, including unnormalized JSON text; digests encode typed row values. Physical SQLite pages are not compared. Only sanitized IDs, field names, hashes, statuses and cost totals are emitted.',
        'allOldRowsPreserved': all(table['allOldRowsPreserved'] for table in tables),
        **{field: sum(table[field] for table in tables) for field in ['oldRows', 'currentRows', 'newRows', 'identicalOldRows', 'missingOldRows', 'changedOldRows']},
        'tables': tables,
        'newTables': [{'table': name, 'rowCount': len(current[name]['rows'])} for name in current.keys() - before.keys()],
        'activeWork': {'before': active_work(before), 'current': active_work(current)},
        'terminalRuns': terminal_comparison,
        'artifactFiles': artifact_files(before_directory / 'artifacts', current_directory / 'artifacts'),
        'paidLedgers': {
            'unchanged': usage_comparison['allOldRowsPreserved'] and not usage_comparison['newRows'] and grant_comparison['allOldRowsPreserved'] and not grant_comparison['newRows'],
            'providerUsage': usage_comparison, 'grantAndAdmissionRecords': grant_comparison,
            'before': paid_summary(before), 'current': paid_summary(current),
        },
    }
    output = (args.output or ROOT / ('evidence/workspace-ux-2026-09-23/preservation-' + args.phase + '.json')).resolve()
    if output == before_path or output == current_path or before_directory in output.parents or current_directory in output.parents:
        raise RuntimeError('Evidence output cannot be inside either audited data directory.')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({key: result[key] for key in ['checkedAt', 'phase', 'allOldRowsPreserved', 'oldRows', 'identicalOldRows', 'missingOldRows', 'changedOldRows', 'newRows', 'activeWork']} | {'artifactFilesPreserved': result['artifactFiles']['allOldFilesPreserved'], 'paidLedgersUnchanged': result['paidLedgers']['unchanged'], 'output': str(output)}))


if __name__ == '__main__':
    main()
