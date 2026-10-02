import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/server/store.js';
import { Authority } from '../src/server/authority.js';
import { Highlights } from '../src/server/connections.js';
import type { Artifact, CanvasNode, Run } from '../src/shared/types.js';
import type { ResearchMemory } from '../src/shared/assistant.js';

// Explicit, user-authorized local demonstration. Prepared imports are labelled
// as such; the two calculations run through the normal app approval/runtime API.
// Existing projects and ledgers are never modified or reset.
if (!process.argv.includes('--create')) throw Error('Pass --create to create and execute the authorized local flagship demo.');
const root = fileURLToPath(new URL('../examples/dutch-ai-adoption/', import.meta.url));
const read = (name: string) => readFileSync(root + name, 'utf8');
const base = process.env.ROS_EXAMPLE_URL || 'http://127.0.0.1:4310';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw Error('Local API required.');
const api = async (path: string, body?: unknown) => {
  const response = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || String(response.status));
  return value;
};
const at = () => new Date().toISOString();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const title = 'AI adoption in Dutch businesses · the banking question';
const question = 'How is AI adoption changing Dutch businesses, and what could that mean for banks such as ABN AMRO?';
const sourceUrl = 'https://www.cbs.nl/en-gb/longread/aanvullende-statistische-diensten/2025/ai-monitor-2024/2-use-of-ai-technology-by-dutch-companies';
const manifestFile = root + 'project-manifest.json';
const store = new Store(fileURLToPath(new URL('../.ros-ai/', import.meta.url)), { recoverInterrupted: false });
let manifest: Record<string, any> = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {};
const save = () => writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
if (!manifest.projectId && store.listProjects().some(p => p.title === title)) throw Error('A matching project exists without a manifest. Inspect it; do not create a duplicate.');
if (manifest.status === 'completed') { console.log(JSON.stringify(manifest, null, 2)); store.close(); process.exit(0); }
const brief = read('editorial-brief.md');
const writing = read('writing-reference.md');
const exploration = read('source-exploration.md');
const metadata = JSON.parse(read('preparation.json'));
const nodes: CanvasNode[] = [
  { id: 'dutch-ai-brief', title: '01 · The banking question', description: brief, kind: 'topic', x: 0, y: 0, parentId: null },
  { id: 'dutch-ai-writing-reference', title: 'Writing voice · AURORA reference', description: writing, kind: 'topic', x: 0, y: 0, parentId: 'dutch-ai-brief' },
  { id: 'dutch-ai-sources', title: '02 · Evidence and banking context', description: exploration, kind: 'topic', x: 520, y: 0, parentId: null },
  { id: 'dutch-ai-direction', title: '03 · Choose a comparable question', description: 'Focus on company size in the CBS 2024 survey, then challenge what changes when the denominator is turnover rather than enterprises. Six compatible size bins are available. Keep the 2023 retailer and 2026 cyber-risk surveys as attributed context; do not combine them into a time trend. This narrower question cannot measure productivity, causality or all microbusinesses.', kind: 'topic', x: 1040, y: 0, parentId: null },
  { id: 'dutch-ai-data', title: '04 · CBS data, scope and denominators', description: 'Real published aggregate data, 2024 provisional: six company-size bins from CBS tables 2.1.3 and 2.2.1. Dutch enterprises with 10+ persons employed; NACE C–N and Q. Percentage of firms using at least one of seven AI technologies versus turnover share belonging to AI users. Published CI endpoints retained. No microbusiness observations, imputation or invented sample counts. Inspect the immutable CSV, original table-text capture, extraction code and metadata.', kind: 'topic', x: 0, y: 400, parentId: null },
  { id: 'dutch-ai-analysis', title: '05 · Measure the adoption gap', description: 'Run the exact captured CSV in isolated local Python. Compare six size groups and preserve the code, numeric checks and adoption plot. Prepared code by the coding assistant, actual saved Docker execution, no application-model inference. Initial interpretation to challenge: do smaller Dutch businesses generally lag in AI value creation?', kind: 'activity', x: 520, y: 400, parentId: null },
  { id: 'dutch-ai-challenge', title: '06 · Challenge what the numbers mean', description: 'Test the initial value-creation interpretation using the same exact data and selected overview result. Compare firm-share and turnover-share denominators and audit the excluded under-ten population. A difference in turnover ownership is not revenue caused by AI. Preserve the original interpretation and carry the correction into the article.', kind: 'activity', x: 1040, y: 400, parentId: null },
  { id: 'dutch-ai-synthesis', title: '07 · What might this mean for a bank?', description: 'Observed: AI use differs by size in the covered 10+ population. Attributed context: ABN AMRO Insights discusses implementation and digital-risk preparedness in separate surveys. Hypotheses: a bank could ask about a specific process, full implementation cost, error review, vendor dependence and a measurable pilot. Open questions: do outcomes improve, are savings usable, and what happens below ten persons employed? None is answered by an adoption indicator. No lending recommendation, bank endorsement, internal data or causal benefit is claimed.', kind: 'topic', x: 520, y: 800, parentId: null },
  { id: 'dutch-ai-article', title: '08 · Draft grounded in the challenge', description: 'The editable article will be saved here after the actual calculations and challenge complete. Prepared editorial work is distinct from a live application-model refinement.', kind: 'topic', x: 1040, y: 800, parentId: null },
];
function capture(nodeId: string, description: string, specs: Array<Omit<Artifact, 'id' | 'hash' | 'createdAt' | 'projectId' | 'nodeId' | 'runId'>>) {
  return store.atomic(() => {
    const project = store.getProject(manifest.projectId);
    const inputs = store.detail(project.id).inputs.filter(i => i.nodeId === nodeId).map(i => ({ ...i, artifact: store.getArtifact(i.artifactId) }));
    const run: Run = { id: randomUUID(), projectId: project.id, nodeId, request: description, useSearch: false, status: 'running', createdAt: at(), startedAt: at(), projectRevision: project.revision, node: project.canvas.nodes.find(n => n.id === nodeId)!, inputs, messages: [], provider: 'local', model: 'coding-assistant-prepared-import-v1', modelVersion: null, configuration: { kind: 'prepared-evidence-import', preparedBy: 'coding assistant', autonomousResearch: false, noProviderRequest: true }, tools: [], events: [{ at: at(), type: 'import', message: 'Captured prepared evidence/editorial material; this import is not model inference or code execution.' }], artifactIds: [] };
    store.createRun(run);
    const artifacts = specs.map(spec => store.addArtifact({ ...spec, projectId: project.id, nodeId, runId: run.id }));
    store.updateRun(run.id, { status: 'completed', endedAt: at(), artifactIds: artifacts.map(a => a.id) });
    return artifacts;
  });
}
if (!manifest.projectId) {
  const project = store.createProject(title);
  manifest = { projectId: project.id, title, question, createdAt: at(), status: 'preparing', nodeIds: Object.fromEntries(nodes.map(n => [n.id.replace('dutch-ai-', ''), n.id])), newPaidProviderCalls: 0, execution: 'Prepared by coding assistant; actual local Docker analysis, not app-model work.' };
  save();
  const relations = [
    ['brief', 'sources', 'motivates question'], ['sources', 'direction', 'informs scope'], ['direction', 'data', 'defines evidence needed'],
    ['data', 'analysis', 'provides data to'], ['analysis', 'challenge', 'tests interpretation'], ['challenge', 'synthesis', 'qualifies interpretation'],
    ['synthesis', 'article', 'supports draft'], ['writing-reference', 'article', 'guides writing style'],
  ];
  store.mutate(project.id, [...nodes.map(node => ({ type: 'addNode' as const, node })), ...relations.map(([source, target, label]) => ({ type: 'addConnection' as const, connection: { id: randomUUID(), source: 'dutch-ai-' + source, target: 'dutch-ai-' + target, label } }))], 'Create authorized flagship research checkpoints; coding-assistant preparation');
  const guidePath = '/Users/adamdong/code/AURORA/data/writing_guide.md';
  const guide = capture('dutch-ai-writing-reference', 'Capture attributed writing-reference summary; original AURORA files unchanged', [{ kind: 'source', title: 'ABN AMRO writing guide · attributed local summary', content: writing, mediaType: 'text/markdown', capture: 'generated', locator: guidePath, metadata: { demoRole: 'writing-reference', role: 'editorial reference, not factual evidence', originalPath: guidePath, originalSha256: hash(readFileSync(guidePath, 'utf8')), version: 'January 2026 v1.1', preparedBy: 'coding assistant' } }])[0];
  const sources = capture('dutch-ai-sources', 'Save verified source exploration and source roles', [{ kind: 'source', title: 'CBS evidence and ABN AMRO context · source map', content: exploration, mediaType: 'text/markdown', capture: 'generated', url: sourceUrl, metadata: { demoRole: 'evidence-source', retrievedAt: at(), role: 'primary statistics and separately attributed banking context', preparedBy: 'coding assistant' } }]);
  const dataset = capture('dutch-ai-data', 'Import real CBS published aggregate tables and extraction provenance', [
    { kind: 'dataset', title: 'CBS AI adoption and turnover by company size · 2024', content: read('cbs-ai-size-2024.csv'), mediaType: 'text/csv', capture: 'full-content', url: sourceUrl, metadata: { ...metadata, demoRole: 'dataset' } },
    { kind: 'source', title: 'CBS original table-text capture · 2.1.3 and 2.2.1', content: read('source/cbs-published-tables.txt'), mediaType: 'text/plain', capture: 'full-content', url: sourceUrl, metadata: { retrievedAt: at(), sourceRole: 'published aggregate table extraction', sourceSha256: metadata.source_sha256 } },
    { kind: 'source', title: 'Dataset methods and coverage · CBS 2024', content: JSON.stringify(metadata, null, 2), mediaType: 'application/json', capture: 'generated', url: sourceUrl },
    { kind: 'code', title: 'Reproduce CSV extraction from captured tables', content: read('prepare.py'), mediaType: 'text/x-python', capture: 'generated', metadata: { preparedBy: 'coding assistant', execution: 'Executed with host Python for trusted data extraction; not model-generated code execution.' } },
  ]);
  capture('dutch-ai-analysis', 'Preserve the initial interpretation before the challenge', [{ kind: 'source', title: 'Initial interpretation to test · not a finding', content: 'Initial interpretation: smaller Dutch businesses may be falling behind in AI value creation. This is an intentionally unverified hypothesis, not a computed result. The challenge will audit the scope and revenue denominator before the article makes any claim.', mediaType: 'text/markdown', capture: 'generated', metadata: { status: 'hypothesis-to-challenge', preparedBy: 'coding assistant' } }]);
  manifest.datasetArtifactId = dataset[0].id; manifest.writingReferenceId = guide.id; manifest.evidenceSourceId = sources[0].id;
  for (const target of ['dutch-ai-data', 'dutch-ai-analysis', 'dutch-ai-challenge']) store.addInput(project.id, target, dataset[0].id);
  store.addInput(project.id, 'dutch-ai-article', guide.id); store.addInput(project.id, 'dutch-ai-article', sources[0].id);
  const time = at();
  const memory: ResearchMemory = { originalQuestion: question, questionHistory: [{ id: randomUUID(), text: question, at: time }, { id: randomUUID(), text: 'How does reported AI use differ by company size in CBS 2024, and how does changing the denominator challenge the interpretation?', at: time }], decisions: [{ id: randomUUID(), kind: 'decision', text: 'Use six same-year published CBS size groups. Banking surveys and AURORA style references have separate roles. Coding-assistant preparation and local execution; no app-model call.', references: [{ kind: 'node', id: 'dutch-ai-direction', label: 'Comparable scope' }], at: time, status: 'recorded' }], findings: [], hypotheses: [], gaps: [] };
  store.saveRecord('research-memory', project.id, project.id, memory);
  store.addMessage(project.id, null, 'system', 'Original question: ' + question + '\n\nThis requested demo was prepared by the coding assistant from public CBS and ABN AMRO sources. Calculations run through the local Docker backend. No live application-model research or remote execution is claimed. Exact data, selected outputs and editorial revisions remain saved.');
  new Authority(store).configure(project.id, { mode: 'ask', scope: 'Authorized flagship demonstration: two local descriptive analyses of the exact CBS aggregate CSV; no external calls.', nodeIds: ['dutch-ai-analysis', 'dutch-ai-challenge'], datasetIds: [dataset[0].id], allowActionCreation: false, limits: { experiments: 4, modelCalls: 0, createdActions: 0, runtimeSeconds: 120, spendUsd: 0 } });
  save();
}
assert.equal(store.getArtifact(manifest.datasetArtifactId).hash, metadata.csv_sha256);
// Bring a partially prepared local demonstration forward without creating a duplicate.
const priorMemory = store.record<ResearchMemory>('research-memory', manifest.projectId)!;
for (const entry of [...priorMemory.decisions, ...priorMemory.findings, ...priorMemory.gaps]) {
  entry.status = entry.kind === 'finding' ? 'observed' : entry.kind === 'gap' ? 'unverified' : 'recorded';
  for (const reference of entry.references) {
    const old = reference as typeof reference & { type?: typeof reference.kind };
    if (!old.kind && old.type) old.kind = old.type;
    delete old.type;
  }
}
store.saveRecord('research-memory', manifest.projectId, manifest.projectId, priorMemory);
const finish = async (id: string) => {
  for (let i = 0; i < 160; i++) {
    const result = await api('/api/experiments/' + id);
    if (!['queued', 'running'].includes(result.run.status)) { assert.equal(result.run.status, 'completed', result.run.error); return result.run; }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw Error('Local attempt not completed after 48 seconds. Inspect the preserved run; no automatic retry.');
};
const run = async (field: string, nodeId: string, phase: string) => {
  if (manifest[field]) return finish(manifest[field]);
  const preview = await api('/api/projects/' + manifest.projectId + '/experiments/preview', { nodeId, request: 'User-authorized demonstration: execute this exact local ' + phase + ' on captured CBS aggregate data. No network, model call, new data or causal inference.', datasetArtifactId: manifest.datasetArtifactId, backend: 'docker-python', code: read('analysis.py'), parameters: { phase } });
  manifest[field] = preview.run.id; save();
  assert.equal(preview.approval.status, 'pending');
  await api('/api/experiments/' + preview.run.id + '/decision', { fingerprint: preview.approval.fingerprint, decision: 'allow' });
  return finish(preview.run.id);
};
try {
  await run('analysisRunId', 'dutch-ai-analysis', 'overview');
  const overview = store.listArtifacts(manifest.projectId).filter(a => a.runId === manifest.analysisRunId);
  const firstResult = overview.find(a => a.kind === 'result')!;
  assert(firstResult); store.addInput(manifest.projectId, 'dutch-ai-challenge', firstResult.id);
  await run('challengeRunId', 'dutch-ai-challenge', 'challenge');
  const all = store.listArtifacts(manifest.projectId);
  const outputs = all.filter(a => [manifest.analysisRunId, manifest.challengeRunId].includes(a.runId));
  const plot = outputs.find(a => a.kind === 'plot' && a.runId === manifest.analysisRunId)!;
  const challengePlot = outputs.find(a => a.kind === 'plot' && a.runId === manifest.challengeRunId)!;
  const challenge = outputs.find(a => a.kind === 'result' && a.runId === manifest.challengeRunId)!;
  assert(plot && challengePlot && challenge); assert.equal(outputs.filter(a => a.kind === 'plot').length, 2);
  for (const artifact of [plot, challengePlot, firstResult, challenge]) {
    store.addInput(manifest.projectId, 'dutch-ai-article', artifact.id);
    store.addInput(manifest.projectId, 'dutch-ai-synthesis', artifact.id);
  }
  if (!manifest.articleArtifactId) {
    const article = read('article.md');
    store.mutate(manifest.projectId, [{ type: 'updateNode', id: 'dutch-ai-article', patch: { description: article } }], 'Save editable article after the real denominator challenge; coding-assistant prepared draft');
    const articleArtifacts = capture('dutch-ai-article', 'Save grounded prepared draft and claim checks using exact selected results', [
      { kind: 'result', title: 'Editable article · AI adoption and the banking question', content: article, mediaType: 'text/markdown', capture: 'generated', metadata: { demoRole: 'article', preparedBy: 'coding assistant', editableNodeId: 'dutch-ai-article', execution: 'Prepared editorial draft, not app-model inference', selectedPlotIds: [plot.id, challengePlot.id], challengeArtifactId: challenge.id } },
      { kind: 'source', title: 'Claim-to-evidence checks and live-demo boundary', content: read('claim-checks.md'), mediaType: 'text/markdown', capture: 'generated', metadata: { demoRole: 'claim-checks', preparedBy: 'coding assistant' } },
    ]);
    const checked = capture('dutch-ai-challenge', 'Record the editorial change required by the executed challenge', [{ kind: 'source', title: 'Challenge applied · original and revised interpretation', content: 'Original interpretation: smaller Dutch businesses may be falling behind in AI value creation.\n\nExecuted check: the 500+ group has 59.2% AI-using enterprises and 79.5% of turnover belonging to users, a 20.3-point difference between denominators; two intermediate bins have a slightly lower turnover share than firm share. Under-ten enterprises are outside the observed population.\n\nRevised article: the covered 10+ population shows a size gradient in use; turnover ownership is not AI-generated revenue, and adoption does not establish productivity or causality. The relevant main-text paragraphs and plot captions now say so. This editorial application is prepared by the coding assistant, not a second model review.', mediaType: 'text/markdown', capture: 'generated', metadata: { demoRole: 'challenge', resultArtifactId: challenge.id, runId: manifest.challengeRunId, originalResultId: firstResult.id } }])[0];
    manifest.articleArtifactId = articleArtifacts[0].id; manifest.challengeAppliedId = checked.id;
    store.addInput(manifest.projectId, 'dutch-ai-article', checked.id);
    const highlighter = new Highlights(store);
    highlighter.save(manifest.projectId, { nodeId: 'dutch-ai-analysis', artifactId: plot.id, x: 0, y: 0 });
    highlighter.save(manifest.projectId, { nodeId: 'dutch-ai-challenge', artifactId: challengePlot.id, x: 0, y: 0 });
    const memory = store.record<ResearchMemory>('research-memory', manifest.projectId)!;
    memory.findings.push({ id: randomUUID(), kind: 'finding', text: 'Actual saved calculation: 41.4 percentage-point adoption gap between the largest and smallest observed size groups. Scope is 10+ enterprises in C–N,Q, 2024 provisional.', references: [{ kind: 'artifact', id: plot.id, label: 'Adoption plot' }, { kind: 'run', id: manifest.analysisRunId, label: 'Actual local calculation' }], at: at(), status: 'recorded' });
    memory.decisions.push({ id: randomUUID(), kind: 'decision', text: 'Challenge changed the article: distinguish enterprise and turnover denominators, exclude claims about under-ten firms and AI-caused productivity or sales.', references: [{ kind: 'artifact', id: checked.id, label: 'Applied challenge' }, { kind: 'node', id: 'dutch-ai-article', label: 'Editable article' }], at: at(), status: 'recorded' });
    memory.gaps.push({ id: randomUUID(), kind: 'gap', text: 'No microbusiness or causal business-outcome data. Live application-model paragraph refinement has not run; use the saved tour or clearly labelled manual edit until inference is admitted.', references: [{ kind: 'node', id: 'dutch-ai-article', label: 'Prepared draft' }], at: at(), status: 'recorded' });
    store.saveRecord('research-memory', manifest.projectId, manifest.projectId, memory);
  }
  mkdirSync(root + 'outputs', { recursive: true });
  for (const [name, artifact] of [['adoption-by-size.svg', plot], ['denominator-challenge.svg', challengePlot], ['overview-result.md', firstResult], ['challenge-result.md', challenge]] as const) writeFileSync(root + 'outputs/' + name, artifact.content);
  for (const artifact of outputs.filter(a => ['metric', 'table'].includes(a.kind))) writeFileSync(root + 'outputs/' + artifact.id + '.json', artifact.content);
  manifest = { ...manifest, status: 'completed', error: undefined, completedAt: at(), analysisPlotId: plot.id, challengePlotId: challengePlot.id, analysisResultId: firstResult.id, challengeResultId: challenge.id, actualLocalRuns: 2, plots: 2, articleWordsApprox: read('article.md').split(/\s+/).length, liveModelRefinement: 'not-run; modelCalls ceiling 0, saved-tour/manual fallback only', providerCalls: 0 };
  store.saveRecord('demo-manifest', 'dutch-ai-adoption', manifest.projectId, manifest); save();
  console.log(JSON.stringify(manifest, null, 2));
} catch (error) { manifest.error = error instanceof Error ? error.message : String(error); save(); throw error; }
finally { store.close(); }
