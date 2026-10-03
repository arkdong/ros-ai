// Compare configured credential values with tracked files, the browser build and an isolated server's API responses.
// Reports names and paths only, never values. Usage: node scripts/verify-secrets.mjs [report.json]
import { parse } from 'dotenv';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const credentials = existsSync('.env.local')
  ? Object.entries(parse(readFileSync('.env.local'))).filter(([name, value]) => /(API_KEY|PROJECT_ID)$/.test(name) && value.length > 8)
  : [];
const walk = root => readdirSync(root).flatMap(name => { const path = join(root, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
const paths = ['src', 'docs', 'evidence', 'scripts', 'examples', 'public', 'dist/client'].filter(existsSync).flatMap(walk)
  .concat(['README.md', 'RESULT.md', 'WORKLOG.md', '.env.example'].filter(existsSync));
const matches = [];
for (const path of paths) { const content = readFileSync(path); for (const [name, value] of credentials) if (content.includes(Buffer.from(value))) matches.push({ path, credentialName: name }); }

const base = process.env.ROS_VERIFY_URL || 'http://127.0.0.1:4317';
if (new URL(base).port === '4310') throw new Error('Inspect an isolated server, not saved user projects on port 4310.');
for (const route of ['/api/connections', '/api/projects', '/api/usage', '/api/experiments/capabilities']) {
  const text = await fetch(base + route).then(response => response.text()).catch(() => '');
  for (const [name, value] of credentials) if (text.includes(value)) matches.push({ route, credentialName: name });
}

const report = { checkedAt: new Date().toISOString(), status: matches.length ? 'failed' : 'passed', credentialCount: credentials.length, filesChecked: paths.length, apiBase: base, matches };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
if (matches.length) throw new Error('Credential value found outside server config; inspect report paths without printing values.');
console.log(`Secret scan passed across ${paths.length} files; no credential values emitted.`);
