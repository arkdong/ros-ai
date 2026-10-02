import type { Artifact } from './types';
import { artifactTable } from './data-view';

export type ReportEvidence = { artifactId: string; hash: string; kind: Artifact['kind']; title: string; claimType: 'source claim' | 'measured result' | 'model claim' | 'user interpretation' | 'externally captured output' };
export const evidenceClaim = (artifact: Artifact): ReportEvidence['claimType'] => artifact.capture==='external' ? 'externally captured output' : artifact.metadata?.origin==='code-block-execution' ? 'measured result' : artifact.kind === 'source' ? 'source claim' : artifact.metadata?.contribution === 'model claim' ? 'model claim' : artifact.metadata?.contribution === 'user interpretation' ? 'user interpretation' : artifact.kind === 'result' && artifact.capture === 'generated' && artifact.metadata?.report !== true ? 'model claim' : ['table','metric','plot','dataset'].includes(artifact.kind) ? 'measured result' : 'user interpretation';
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
export function reportHtml(title: string, text: string, evidence: Artifact[], report?: Artifact): string {
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
  const captured = evidence.map(artifact => `<details id="evidence-${artifact.id}"><summary>${escapeHtml(artifact.title)} · ${evidenceClaim(artifact)}</summary><p>Artifact ${artifact.id}<br/>SHA256 ${artifact.hash}<br/>Captured ${artifact.createdAt}<br/>Producing attempt ${artifact.runId}</p>${artifact.kind === 'plot' ? `<img alt="${escapeHtml(artifact.title)}" src="${escapeHtml(svgImageUrl(artifact))}"/>` : ['dataset','table'].includes(artifact.kind) ? `${tableHtml(artifact)}<details><summary>Exact captured data · SHA256 ${artifact.hash}</summary><pre class="exact-captured-data">${escapeHtml(artifact.content)}</pre></details>` : `<pre>${escapeHtml(artifact.content)}</pre>`}<details><summary>Captured metadata</summary><pre>${escapeHtml(JSON.stringify(artifact.metadata ?? {}, null, 2))}</pre></details></details>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${escapeHtml(title)}</title><style>body{font:17px/1.6 system-ui,sans-serif;color:#26312d;max-width:960px;margin:48px auto;padding:0 24px}h1,h2,h3{line-height:1.25}img{max-width:100%;height:auto}figure{margin:32px 0}figcaption{font-size:14px;color:#58645e}table{border-collapse:collapse;font-size:14px}td,th{padding:8px 12px;border:1px solid #dce2df;text-align:left}.table-scroll{overflow:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;background:#f5f7f5;padding:16px}details{border-top:1px solid #dce2df;padding:14px 0}a{color:#256b4d}small{color:#66726c}@media print{body{margin:0}details{break-inside:avoid}figure{break-inside:avoid}}</style></head><body><h1>${escapeHtml(title)}</h1><small>ros.ai · ${report ? evidenceClaim(report) : 'user interpretation'}. Saved report ${report?.id ?? 'preview'} ${report ? `· SHA256 ${report.hash}` : ''}. Supporting captures retain their original claim type and exact version.</small><main>${body}</main><section><h2>Preserved evidence</h2>${captured || '<p>No saved evidence selected.</p>'}</section></body></html>`;
}
export function reportMarkdown(title: string, text: string, evidence: Artifact[], report?: Artifact): string {
  let result = canonicalReport(text, evidence).replace(/(!?\[[^\]]*\])\(artifact:([a-zA-Z0-9_-]+)\)/gu, (match, label: string, id: string) => {
    const artifact = evidence.find(item => item.id === id); if (!artifact) return match;
    if (label.startsWith('!') && artifact.kind === 'plot') return `${label}(${svgImageUrl(artifact)})`;
    if (label.startsWith('!') && ['table','dataset'].includes(artifact.kind)) {
      try { const data=artifactTable(artifact.content,artifact.kind==='dataset'||artifact.mediaType==='text/csv'), cell=(value:string)=>value.replaceAll('|','\\|').replaceAll('\n','<br>'); return `${[data.columns,data.columns.map(()=> '---'),...data.rows].map(row=>`| ${row.map(cell).join(' | ')} |`).join('\n')}\n\n[${label.slice(2,-1)}](#evidence-${id})`; } catch { return `[${label.slice(2,-1)}](#evidence-${id})`; }
    }
    return `${label}(#evidence-${id})`;
  });
  result = `# ${title}\n\n${result}\n\n## Preserved evidence\n\nReport ${report?.id ?? 'preview'}${report ? ` · SHA256 ${report.hash}` : ''}.\n\n`;
  for (const artifact of evidence) result += `<a id="evidence-${artifact.id}"></a>\n\n### ${artifact.title}\n\n${evidenceClaim(artifact)} · artifact ${artifact.id} · SHA256 ${artifact.hash} · attempt ${artifact.runId} · ${artifact.createdAt}\n\n${artifact.kind === 'plot' ? `![${artifact.title}](${svgImageUrl(artifact)})` : `\`\`\`\n${artifact.content.replaceAll('```', '\u0060\u0060\u200b\u0060')}\n\`\`\``}\n\n`;
  return result;
}
