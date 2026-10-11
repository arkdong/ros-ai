#!/usr/bin/env node
/**
 * Sets up the starting canvas for a dean demo case in your running ros.ai.
 *
 *   npm run dean-demo -- abn-amro-drafting
 *   npm run dean-demo -- abn-amro-drafting --port 4311 --into ~/Documents/ros.ai
 *
 * Each case is a folder in examples/dean-demo with its notes and data plus canvas.json, which places them.
 * The files are copied into a new project folder (by default ~/Documents/ros.ai/<title>), which is then
 * opened as a project in the ros.ai running on 127.0.0.1. Nothing runs and nothing is spent: the demo's
 * searches and drafts happen live, from the prompts in docs/dean-demo-runbook.md.
 */
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cases = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'dean-demo');
const available = readdirSync(cases, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
const usage = `Usage: npm run dean-demo -- <${available.join(' | ')}> [--port 4310] [--into ~/Documents/ros.ai]`;
const fail = message => { console.error(message); process.exit(1); };

let name, port = 4310, into = join(homedir(), 'Documents', 'ros.ai');
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--port') port = Number(args[++index]);
  else if (args[index] === '--into') into = args[++index]?.replace(/^~(?=$|\/)/u, homedir());
  else if (!name && !args[index].startsWith('-')) name = args[index];
  else fail(`Unknown option ${args[index]}.\n${usage}`);
}
if (!name || !available.includes(name)) fail(usage);
if (!Number.isInteger(port) || !into) fail(usage);

const source = join(cases, name), canvas = JSON.parse(readFileSync(join(source, 'canvas.json'), 'utf8'));
// The same subfolders ros.ai uses for each kind of block.
const subfolder = file => ({ '.md': 'notes', '.csv': 'data', '.py': 'code', '.ipynb': 'notebooks' })[extname(file).toLowerCase()] ?? 'notes';
let folder = join(into, canvas.title.replace(/[\\/:*?"<>|#^[\]]/gu, '-'));
for (let n = 2; existsSync(folder); n++) folder = join(into, `${canvas.title.replace(/[\\/:*?"<>|#^[\]]/gu, '-')} (${n})`);

// Fresh block ids, so the same case can be set up more than once.
const ids = new Map(canvas.blocks.map(block => [block.id, randomUUID()]));
const blocks = canvas.blocks.map(block => {
  const file = `${subfolder(block.file)}/${block.file}`;
  mkdirSync(join(folder, dirname(file)), { recursive: true });
  copyFileSync(join(source, block.file), join(folder, file));
  return { id: ids.get(block.id), title: block.title, kind: 'topic', ...(block.blockType ? { blockType: block.blockType } : {}), parentId: null, x: block.x, y: block.y, ...(block.width ? { width: block.width } : {}), file };
});
const connections = (canvas.connections ?? []).map(edge => ({ id: randomUUID(), source: ids.get(edge.source), target: ids.get(edge.target), label: edge.label }));
mkdirSync(join(folder, '.ros-ai'), { recursive: true });
writeFileSync(join(folder, '.ros-ai', 'project.json'), JSON.stringify({ app: 'ros.ai', format: 1, projectId: randomUUID(), title: canvas.title, blocks, connections }, null, 2) + '\n');
console.log(`Copied the "${canvas.title}" starting canvas into ${folder}`);

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/folders/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: folder }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) fail(`ros.ai could not open it: ${body.error ?? response.status}`);
  console.log(`Opened it in ros.ai at http://127.0.0.1:${port}. Reload the page and pick "${body.title}" from the project list.`);
} catch {
  console.log(`ros.ai is not running on port ${port}. Start it with npm start, then use New project > Open a folder and choose that folder.`);
}
