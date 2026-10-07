import type { Artifact, RunStatus } from './types';
import { artifactTable } from './data-view';

export type ClaimType = 'source claim' | 'measured result' | 'model claim' | 'user interpretation' | 'externally captured output' | 'input data' | 'imported result' | 'program code' | 'execution log';
export type ReportEvidence = { artifactId: string; hash: string; kind: Artifact['kind']; title: string; claimType: ClaimType };
/** Only outputs computed in this project are measured results. Imported files, run
 * inputs, programs, logs and copied example outputs keep their own labels. */
export function evidenceClaim(artifact: Artifact): ClaimType {
  const metadata = artifact.metadata ?? {};
  if (artifact.capture === 'external') return 'externally captured output';
  if (artifact.kind === 'code') return 'program code';
  if (artifact.kind === 'log') return 'execution log';
  if (artifact.kind === 'source') return 'source claim';
  if (artifact.kind === 'dataset' && metadata.executionRole !== 'output') return 'input data';
  if (metadata.contribution === 'model claim') return 'model claim';
  if (metadata.contribution === 'user interpretation') return 'user interpretation';
  if (metadata.tutorialOrigin !== undefined && ['table','metric','plot'].includes(artifact.kind)) return 'imported result';
  if (metadata.origin === 'code-block-execution' || metadata.origin === 'notebook-cell-output') return 'measured result';
  if (artifact.kind === 'result' && artifact.capture === 'generated' && metadata.report !== true) return 'model claim';
  return ['table','metric','plot','dataset'].includes(artifact.kind) ? 'measured result' : 'user interpretation';
}

export type RecordVersion = { id: string; title: string; kind: Artifact['kind']; hash: string };
export type ReportAttempt = { runId: string; block: string; number: number; status: RunStatus; startedAt: string | null; endedAt: string | null; backend: string; program: RecordVersion | null; input: RecordVersion | null; parameters: Record<string, unknown>; runtime: string | null; image: string | null; approval: string | null; failure: string | null; codeOrigin: string | null; codeNow: 'same' | 'changed' | null; outputs: (RecordVersion & { cited: boolean })[] };
export type ReportDecision = { id: string; block: string; text: string; reason: string; at: string; withdrawnAt: string | null; basedOn: (RecordVersion | { id: string; hash: string; missing: true })[] };
export type AiUseCall = { id: string; at: string; kind: 'model' | 'search' | 'agent'; service: string; model: string | null; purpose: string; location: 'external' | 'local-unverified'; outcome: string; block: string | null; contextBytes: number | null; request?: { role: string; content: string }[] };
/** Generated at export time from the saved record. Never contains credentials or local paths. */
export type ReportRecord = {
  generatedAt: string; attempts: ReportAttempt[]; notRun: number; producedBy: Record<string, string>; savedLabels: Record<string, ClaimType>; decisions: ReportDecision[];
  aiUse: { calls: AiUseCall[]; unattributed: number; plannedCode: string[]; modelEvidence: number; statement: string | null; requestsIncluded: boolean };
};
export const recordTime = (value: string | null) => value ? `${value.slice(0, 10)} ${value.slice(11, 16)} UTC` : 'not recorded';
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const kilobytes = (bytes: number | null) => bytes === null ? 'not recorded' : bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`;
const attemptStatus: Record<RunStatus, string> = { completed: 'completed', failed: 'failed', cancelled: 'stopped', interrupted: 'interrupted', queued: 'not finished', running: 'not finished' };
const where = (call: AiUseCall) => call.kind === 'agent' ? 'Codex, under its own sign-in' : call.location === 'local-unverified' ? `${call.service} · local endpoint, unverified` : `${call.service} · external service`;
const parameterText = (parameters: Record<string, unknown>) => Object.keys(parameters).length ? Object.entries(parameters).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ') : 'none';
const labelText = (artifact: Artifact, record?: ReportRecord) => { const current = evidenceClaim(artifact), saved = record?.savedLabels[artifact.id]; return saved && saved !== current ? `${current} (labelled “${saved}” when the report was saved)` : current; };
const modelCalls = (record: ReportRecord) => record.aiUse.calls.filter(call => call.kind !== 'search');
const modelSummary = (record: ReportRecord) => { const calls = modelCalls(record), agents = calls.filter(call => call.kind === 'agent').length, direct = calls.length - agents; return calls.length ? `ros.ai sent ${direct ? plural(direct, 'model request') : 'no direct model requests'}${agents ? ` and started ${plural(agents, 'Codex agent turn')}` : ''} for this project.` : 'ros.ai sent no model requests for this project.'; };
const evidenceSummary = (record: ReportRecord) => record.aiUse.modelEvidence ? `${plural(record.aiUse.modelEvidence, 'cited evidence item is', 'cited evidence items are')} model output, labelled “model claim”.` : 'No cited evidence is labelled as model output.';
const statementLine = (record: ReportRecord) => `Researcher’s statement on AI used outside ros.ai: ${record.aiUse.statement ? `“${record.aiUse.statement}”` : 'not stated.'}`;
/** Evidence derived from an analysis output links to the attempt that produced its source. */
const attemptLink = (artifact: Artifact, record: ReportRecord | undefined, html: boolean) => {
  const source = record?.producedBy[artifact.id];
  if (!source) return artifact.runId;
  const link = (label: string) => html ? `<a href="#attempt-${source}">${label}</a>` : `[${label}](#attempt-${source})`;
  return source === artifact.runId ? link(artifact.runId) : `${artifact.runId} · derived from ${link(`attempt ${source}`)}`;
};
const scope = 'This record covers only requests ros.ai itself sent and saved. It cannot see AI tools used outside ros.ai.';
const requestNote = (record: ReportRecord) => !record.aiUse.calls.length ? '' : record.aiUse.requestsIncluded ? ' Full request text follows, with local file paths shortened to file names.' : ' Full request text is not included in this export.';

function recordHtml(record: ReportRecord, evidence: Artifact[]): string {
  const cited = new Set(evidence.map(artifact => artifact.id));
  const version = (value: RecordVersion) => `${cited.has(value.id) ? `<a href="#evidence-${value.id}">${escapeHtml(value.title)}</a>` : escapeHtml(value.title)} · SHA256 <code>${value.hash}</code>`;
  const attempts = record.attempts.map(attempt => `<article class="attempt" id="attempt-${attempt.runId}"><h4>${escapeHtml(attempt.block)} · attempt ${attempt.number} · ${attemptStatus[attempt.status]}</h4><dl><dt>Ran</dt><dd>${recordTime(attempt.startedAt)} · ${escapeHtml(attempt.backend)}</dd><dt>Program</dt><dd>${attempt.program ? version(attempt.program) : 'not saved'}</dd><dt>Input</dt><dd>${attempt.input ? version(attempt.input) : 'no input file'}</dd><dt>Parameters</dt><dd>${escapeHtml(parameterText(attempt.parameters))}</dd><dt>Runtime</dt><dd>${escapeHtml(attempt.runtime ?? 'not recorded')}${attempt.image ? ` · image <code>${escapeHtml(attempt.image)}</code>` : ''}</dd><dt>Approval</dt><dd>${escapeHtml(attempt.approval ?? 'not recorded')}</dd>${attempt.failure ? `<dt>Failure</dt><dd>${escapeHtml(attempt.failure)}</dd>` : ''}${attempt.codeOrigin ? `<dt>Code origin</dt><dd>${escapeHtml(attempt.codeOrigin)}</dd>` : ''}${attempt.codeNow ? `<dt>Code block now</dt><dd>${attempt.codeNow === 'same' ? 'Same program, parameters and input as this attempt' : 'Changed since this attempt'}</dd>` : ''}<dt>Outputs</dt><dd>${attempt.outputs.length ? `<ul>${attempt.outputs.map(output => `<li>${version(output)} · ${output.kind}${output.cited ? ' · <strong>cited in this report</strong>' : ''}</li>`).join('')}</ul>` : 'none'}</dd></dl></article>`).join('');
  const decisions = record.decisions.map(decision => `<article class="decision${decision.withdrawnAt ? ' withdrawn' : ''}"><p><strong>${decision.withdrawnAt ? `<s>${escapeHtml(decision.text)}</s>` : escapeHtml(decision.text)}</strong></p><p>Reason: ${decision.withdrawnAt ? `<s>${escapeHtml(decision.reason)}</s>` : escapeHtml(decision.reason)}</p>${decision.basedOn.length ? `<p>Based on: ${decision.basedOn.map(basis => 'missing' in basis ? `unavailable version <code>${basis.hash}</code>` : version(basis)).join('; ')}</p>` : ''}<p><small>Recorded by the researcher in ${escapeHtml(decision.block)} · ${recordTime(decision.at)}${decision.withdrawnAt ? ` · withdrawn ${recordTime(decision.withdrawnAt)}` : ''}</small></p></article>`).join('');
  const calls = modelCalls(record), searches = record.aiUse.calls.filter(call => call.kind === 'search');
  const callRows = (values: AiUseCall[], search: boolean) => `<div class="table-scroll"><table><thead><tr><th>When</th><th>${search ? 'Service' : 'Model'}</th>${search ? '' : '<th>Where processed</th>'}<th>Purpose</th><th>Block</th><th>${search ? 'Query size' : 'Context sent'}</th><th>Outcome</th></tr></thead><tbody>${values.map(call => `<tr><td>${recordTime(call.at)}</td><td>${escapeHtml(search ? call.service : call.model ?? call.service)}</td>${search ? '' : `<td>${escapeHtml(where(call))}</td>`}<td>${escapeHtml(call.purpose)}</td><td>${escapeHtml(call.block ?? 'Project')}</td><td>${kilobytes(call.contextBytes)}</td><td>${escapeHtml(call.outcome)}</td></tr>`).join('')}</tbody></table></div>`;
  const requests = record.aiUse.calls.filter(call => call.request?.length).map(call => `<details><summary>Full request · ${recordTime(call.at)} · ${escapeHtml(call.purpose)}</summary>${call.request!.map(message => `<p><small>${escapeHtml(message.role)}</small></p><pre>${escapeHtml(message.content)}</pre>`).join('')}</details>`).join('');
  const ai = `<p>${modelSummary(record)}</p>${calls.length ? callRows(calls, false) : ''}${searches.length ? `<p>ros.ai sent ${plural(searches.length, 'web search', 'web searches')} for this project.</p>${callRows(searches, true)}` : ''}${record.aiUse.unattributed ? `<p>${plural(record.aiUse.unattributed, 'older request')} in this workspace ${record.aiUse.unattributed === 1 ? 'has' : 'have'} no project record and ${record.aiUse.unattributed === 1 ? 'is' : 'are'} not counted here.</p>` : ''}<p>${evidenceSummary(record)}</p>${record.aiUse.plannedCode.length ? `<p>Code that ros.ai ran from a model plan:</p><ul>${record.aiUse.plannedCode.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p>No code that ros.ai ran came from a model plan.</p>'}<p>${escapeHtml(statementLine(record))}</p><p><small>${scope}${requestNote(record)}</small></p>${requests}`;
  return `<section id="process-record"><h2>How this report was produced</h2><p><small>Generated ${recordTime(record.generatedAt)} from this project’s saved record. The report text and evidence are the saved versions; this record shows the project at export time.</small></p><h3>Analyses tried</h3>${attempts || '<p>No analysis attempts produced the cited evidence.</p>'}${record.notRun ? `<p>${plural(record.notRun, 'other preview was', 'other previews were')} never run (stopped, denied or still awaiting approval).</p>` : ''}<h3>Decisions</h3>${decisions || '<p>No decisions recorded in this project.</p>'}<h3>AI use</h3>${ai}</section>`;
}
function recordMarkdown(record: ReportRecord, evidence: Artifact[]): string {
  const cited = new Set(evidence.map(artifact => artifact.id)), text = (value: string) => value.replaceAll('\n', ' ');
  const version = (value: RecordVersion) => `${cited.has(value.id) ? `[${text(value.title).replaceAll(']', '')}](#evidence-${value.id})` : text(value.title)} · SHA256 \`${value.hash}\``;
  let result = `## How this report was produced\n\nGenerated ${recordTime(record.generatedAt)} from this project’s saved record. The report text and evidence are the saved versions; this record shows the project at export time.\n\n### Analyses tried\n\n`;
  for (const attempt of record.attempts) result += `<a id="attempt-${attempt.runId}"></a>\n\n#### ${text(attempt.block)} · attempt ${attempt.number} · ${attemptStatus[attempt.status]}\n\n- Ran: ${recordTime(attempt.startedAt)} · ${attempt.backend}\n- Program: ${attempt.program ? version(attempt.program) : 'not saved'}\n- Input: ${attempt.input ? version(attempt.input) : 'no input file'}\n- Parameters: ${text(parameterText(attempt.parameters))}\n- Runtime: ${attempt.runtime ?? 'not recorded'}${attempt.image ? ` · image \`${attempt.image}\`` : ''}\n- Approval: ${text(attempt.approval ?? 'not recorded')}\n${attempt.failure ? `- Failure: ${text(attempt.failure)}\n` : ''}${attempt.codeOrigin ? `- Code origin: ${attempt.codeOrigin}\n` : ''}${attempt.codeNow ? `- Code block now: ${attempt.codeNow === 'same' ? 'same program, parameters and input as this attempt' : 'changed since this attempt'}\n` : ''}- Outputs: ${attempt.outputs.length ? attempt.outputs.map(output => `${version(output)} · ${output.kind}${output.cited ? ' · **cited in this report**' : ''}`).join('; ') : 'none'}\n\n`;
  if (!record.attempts.length) result += 'No analysis attempts produced the cited evidence.\n\n';
  if (record.notRun) result += `${plural(record.notRun, 'other preview was', 'other previews were')} never run (stopped, denied or still awaiting approval).\n\n`;
  result += '### Decisions\n\n';
  for (const decision of record.decisions) { const strike = (value: string) => decision.withdrawnAt ? `~~${text(value)}~~` : text(value); result += `- **${strike(decision.text)}**\n  - Reason: ${strike(decision.reason)}\n${decision.basedOn.length ? `  - Based on: ${decision.basedOn.map(basis => 'missing' in basis ? `unavailable version \`${basis.hash}\`` : version(basis)).join('; ')}\n` : ''}  - Recorded by the researcher in ${text(decision.block)} · ${recordTime(decision.at)}${decision.withdrawnAt ? ` · withdrawn ${recordTime(decision.withdrawnAt)}` : ''}\n`; }
  if (!record.decisions.length) result += 'No decisions recorded in this project.\n';
  const searches = record.aiUse.calls.filter(call => call.kind === 'search');
  result += `\n### AI use\n\n${modelSummary(record)}\n`;
  if (modelCalls(record).length) result += `\n${modelCalls(record).map(call => `- ${recordTime(call.at)} · ${call.model ?? call.service} · ${where(call)} · ${call.purpose} · ${call.block ?? 'Project'} · context sent ${kilobytes(call.contextBytes)} · ${call.outcome}`).join('\n')}\n`;
  if (searches.length) result += `\nros.ai sent ${plural(searches.length, 'web search', 'web searches')} for this project.\n\n${searches.map(call => `- ${recordTime(call.at)} · ${call.service} · ${call.purpose} · ${call.block ?? 'Project'} · ${call.outcome}`).join('\n')}\n`;
  if (record.aiUse.unattributed) result += `\n${plural(record.aiUse.unattributed, 'older request')} in this workspace ${record.aiUse.unattributed === 1 ? 'has' : 'have'} no project record and ${record.aiUse.unattributed === 1 ? 'is' : 'are'} not counted here.\n`;
  result += `\n${evidenceSummary(record)}\n\n${record.aiUse.plannedCode.length ? `Code that ros.ai ran from a model plan:\n\n${record.aiUse.plannedCode.map(item => `- ${item}`).join('\n')}` : 'No code that ros.ai ran came from a model plan.'}\n\n${text(statementLine(record))}\n\n${scope}${requestNote(record)}\n\n`;
  for (const call of record.aiUse.calls.filter(item => item.request?.length)) result += `#### Full request · ${recordTime(call.at)} · ${call.purpose}\n\n${call.request!.map(message => `${message.role}:\n\n\`\`\`\n${message.content.replaceAll('```', '``​`')}\n\`\`\``).join('\n\n')}\n\n`;
  return result;
}
const legacyFigures: Record<string, string> = { 'outputs/adoption-by-size.svg': 'AI adoption by company size · CBS 2024', 'outputs/denominator-challenge.svg': 'Challenge the denominator · adoption versus turnover' };
/** The two archived article paths map only to its explicitly selected captures.
 * General reports use stable artifact IDs; no filename/title guessing. */
export function resolveReportArtifact(reference: string, artifacts: Artifact[]): Artifact | undefined {
  if (reference.startsWith('artifact:')) return artifacts.find(artifact => artifact.id === reference.slice(9));
  const title = legacyFigures[reference];
  const candidates = title ? artifacts.filter(artifact => artifact.kind === 'plot' && artifact.title === title) : [];
  return candidates.length === 1 ? candidates[0] : undefined;
}
export function reportReferences(text: string): string[] { return [...new Set([...text.matchAll(/\[[^\]]*\]\((artifact:[a-zA-Z0-9_-]+)\)/gu)].map(match => match[1].slice(9)))]; }
export function canonicalReport(text: string, selected: Artifact[]): string {
  return text.replace(/(!?\[[^\]]*\])\(([^)]+)\)/gu, (match, label: string, reference: string) => {
    const artifact = resolveReportArtifact(reference, selected); return artifact ? `${label}(artifact:${artifact.id})` : match;
  });
}
export const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
// Historical name retained for all figure consumers; PNG captures are base64, SVG is text.
export const svgImageUrl = (artifact: Artifact) => artifact.mediaType==='image/png' ? `data:image/png;base64,${artifact.content}` : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(artifact.content)}`;
function tableHtml(artifact: Artifact): string {
  try { const data = artifactTable(artifact.content, artifact.kind === 'dataset' || artifact.mediaType === 'text/csv'); return `<div class="table-scroll"><table><thead><tr>${data.columns.map(column => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${data.rows.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`; } catch { return `<pre>${escapeHtml(artifact.content)}</pre>`; }
}
export function reportHtml(title: string, text: string, evidence: Artifact[], report?: Artifact, record?: ReportRecord): string {
  const inline = (value: string): string => {
    let output = '', at = 0;
    const pattern = /(!?\[([^\]]*)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`)/gu;
    for (const match of value.matchAll(pattern)) {
      output += escapeHtml(value.slice(at, match.index));
      if (match[2] !== undefined) {
        const artifact = resolveReportArtifact(match[3], evidence);
        if (artifact && match[0].startsWith('!')) output += artifact.kind === 'plot' ? `<figure><a href="#evidence-${artifact.id}"><img alt="${escapeHtml(match[2])}" src="${escapeHtml(svgImageUrl(artifact))}" style="max-width:${Number(artifact.metadata?.presentationWidth) || 100}%"/></a><figcaption>${escapeHtml(match[2] || String(artifact.metadata?.caption ?? artifact.title))} · <a href="#evidence-${artifact.id}">exact evidence</a></figcaption></figure>` : `<figure>${tableHtml(artifact)}<figcaption>${escapeHtml(match[2] || artifact.title)} · <a href="#evidence-${artifact.id}">exact evidence</a></figcaption></figure>`;
        else if (artifact) output += `<a href="#evidence-${artifact.id}">${escapeHtml(match[2])}</a>`;
        else if (/^https?:\/\//iu.test(match[3]) && !match[0].startsWith('!')) output += `<a href="${escapeHtml(match[3])}">${escapeHtml(match[2])}</a>`;
        else output += escapeHtml(match[0]);
      } else if (match[4]) output += `<strong>${escapeHtml(match[4])}</strong>`;
      else output += `<code>${escapeHtml(match[5])}</code>`;
      at = match.index! + match[0].length;
    }
    return output + escapeHtml(value.slice(at));
  };
  const body = text.split(/\n\s*\n/u).map(paragraph => {
    if (/^#{1,4} /u.test(paragraph)) { const level = paragraph.match(/^#+/u)![0].length; return `<h${level}>${inline(paragraph.replace(/^#+ /u, ''))}</h${level}>`; }
    if (paragraph.split('\n').every(line => /^[-*] /u.test(line))) return `<ul>${paragraph.split('\n').map(line => `<li>${inline(line.slice(2))}</li>`).join('')}</ul>`;
    const lines = paragraph.split('\n');
    if (lines.length > 1 && /^\s*\|?\s*:?-{3,}/u.test(lines[1])) { const cells=(line:string)=>line.trim().replace(/^\|/u,'').replace(/\|$/u,'').split('|').map(cell=>cell.trim()); return `<div class="table-scroll"><table><thead><tr>${cells(lines[0]).map(cell=>`<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${lines.slice(2).map(line=>`<tr>${cells(line).map(cell=>`<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`; }
    return /^(?:!\[)/u.test(paragraph) ? inline(paragraph) : `<p>${inline(paragraph).replaceAll('\n','<br/>')}</p>`;
  }).join('\n');
  const captured = evidence.map(artifact => `<details id="evidence-${artifact.id}"><summary>${escapeHtml(artifact.title)} · ${escapeHtml(labelText(artifact, record))}</summary><p>Artifact ${artifact.id}<br/>SHA256 ${artifact.hash}<br/>Captured ${artifact.createdAt}<br/>Producing attempt ${attemptLink(artifact, record, true)}</p>${artifact.kind === 'plot' ? `<img alt="${escapeHtml(artifact.title)}" src="${escapeHtml(svgImageUrl(artifact))}"/>` : ['dataset','table'].includes(artifact.kind) ? `${tableHtml(artifact)}<details><summary>Exact captured data · SHA256 ${artifact.hash}</summary><pre class="exact-captured-data">${escapeHtml(artifact.content)}</pre></details>` : `<pre>${escapeHtml(artifact.content)}</pre>`}<details><summary>Captured metadata</summary><pre>${escapeHtml(JSON.stringify(artifact.metadata ?? {}, null, 2))}</pre></details></details>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${escapeHtml(title)}</title><style>body{font:17px/1.6 system-ui,sans-serif;color:#26312d;max-width:960px;margin:48px auto;padding:0 24px;overflow-wrap:break-word}h1,h2,h3{line-height:1.25}img{max-width:100%;height:auto}figure{margin:32px 0}figcaption{font-size:14px;color:#58645e}table{border-collapse:collapse;font-size:14px}td,th{padding:8px 12px;border:1px solid #dce2df;text-align:left}.table-scroll{overflow:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;background:#f5f7f5;padding:16px}details{border-top:1px solid #dce2df;padding:14px 0}a{color:#256b4d}small{color:#66726c}code{overflow-wrap:anywhere;font-size:13px}dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 16px;margin:8px 0 0}dt{color:#58645e}dd{margin:0;min-width:0}.attempt,.decision{border-top:1px solid #dce2df;padding:12px 0}.decision.withdrawn{color:#66726c}@media (max-width:600px){dl{grid-template-columns:minmax(0,1fr)}dd{margin-bottom:6px}}@media print{body{margin:0}details{break-inside:avoid}figure{break-inside:avoid}.attempt,.decision{break-inside:avoid}}</style></head><body><h1>${escapeHtml(title)}</h1><small>ros.ai · ${report ? evidenceClaim(report) : 'user interpretation'}. Saved report ${report?.id ?? 'preview'} ${report ? `· SHA256 ${report.hash}` : ''}. Supporting captures retain their original claim type and exact version.</small><main>${body}</main>${record ? recordHtml(record, evidence) : ''}<section><h2>Preserved evidence</h2>${captured || '<p>No saved evidence selected.</p>'}</section></body></html>`;
}
export function reportMarkdown(title: string, text: string, evidence: Artifact[], report?: Artifact, record?: ReportRecord): string {
  let result = canonicalReport(text, evidence).replace(/(!?\[[^\]]*\])\(artifact:([a-zA-Z0-9_-]+)\)/gu, (match, label: string, id: string) => {
    const artifact = evidence.find(item => item.id === id); if (!artifact) return match;
    if (label.startsWith('!') && artifact.kind === 'plot') return `${label}(${svgImageUrl(artifact)})`;
    if (label.startsWith('!') && ['table','dataset'].includes(artifact.kind)) {
      try { const data=artifactTable(artifact.content,artifact.kind==='dataset'||artifact.mediaType==='text/csv'), cell=(value:string)=>value.replaceAll('|','\\|').replaceAll('\n','<br>'); return `${[data.columns,data.columns.map(()=> '---'),...data.rows].map(row=>`| ${row.map(cell).join(' | ')} |`).join('\n')}\n\n[${label.slice(2,-1)}](#evidence-${id})`; } catch { return `[${label.slice(2,-1)}](#evidence-${id})`; }
    }
    return `${label}(#evidence-${id})`;
  });
  result = `# ${title}\n\n${result}\n\n${record ? recordMarkdown(record, evidence) : ''}## Preserved evidence\n\nReport ${report?.id ?? 'preview'}${report ? ` · SHA256 ${report.hash}` : ''}.\n\n`;
  for (const artifact of evidence) result += `<a id="evidence-${artifact.id}"></a>\n\n### ${artifact.title}\n\n${labelText(artifact, record)} · artifact ${artifact.id} · SHA256 ${artifact.hash} · attempt ${attemptLink(artifact, record, false)} · ${artifact.createdAt}\n\n${artifact.kind === 'plot' ? `![${artifact.title}](${svgImageUrl(artifact)})` : `\`\`\`\n${artifact.content.replaceAll('```', '\u0060\u0060\u200b\u0060')}\n\`\`\``}\n\n`;
  return result;
}
