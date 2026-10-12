import type { Artifact } from '../shared/types';
import { RichText } from './Content';
import { DataTable } from './DataViewer';
import { svgImageUrl } from '../shared/reports';
import { parseCsv } from '../shared/data-view';
import { CodeView } from './code';
export { DataTable } from './DataViewer';
export { parseCsv } from '../shared/data-view';

export function ArtifactContent({artifact}: {artifact: Artifact}) {
  if (artifact.kind === 'plot') return <img className="result-plot" src={svgImageUrl(artifact)} alt={artifact.title} />;
  if (artifact.kind === 'dataset') return <DataTable rows={parseCsv(artifact.content)} />;
  try {
    const parsed: unknown = JSON.parse(artifact.content);
    if (artifact.kind === 'metric' && parsed && typeof parsed === 'object' && 'value' in parsed) return <div className="metric-value">{String(parsed.value)}</div>;
    if (Array.isArray(parsed) && parsed.length && typeof parsed[0] === 'object' && parsed[0] !== null) {
      const columns = Object.keys(parsed[0]);
      return <DataTable rows={[columns, ...parsed.map(row => columns.map(col => (row as Record<string, unknown>)[col]))]} />;
    }
  } catch { /* Text/code/log artifacts preserve their exact captured text. */ }
  if (artifact.mediaType === 'text/markdown' && ['result','source'].includes(artifact.kind)) return <RichText text={artifact.content}/>;
  if (artifact.kind === 'code') return <CodeView code={artifact.content}/>;
  return <pre>{artifact.content}</pre>;
}

