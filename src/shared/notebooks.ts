/** Notebook captures are saved external evidence, never ros.ai kernel execution. */
export const NOTEBOOK_LIMITS = { snapshotBytes:500_000, responseBytes:750_000, cells:200, cellSourceCharacters:100_000,
  outputsPerCell:32, outputBytes:300_000, selectedOutputs:8, previewCharacters:16_000, timeoutMs:8_000 } as const;
export type NotebookSessionStatus = { id:string; name:string; endpoint:string; interface:'lab'|'notebook'; tokenConfigured:boolean;
  available:boolean|null; checkedAt:string|null; reason:string; runtimeOwner:'user-managed-jupyter'; isolation:'external-unverified' };
export type NotebookOutputPreview = { index:number; kind:'text'|'csv'|'json'|'figure'|'unsupported'; title:string; mediaType:string;
  content?:string; capturable:boolean; reason?:string; truncated?:boolean };
export type NotebookCellPreview = { index:number; id:string|null; locator:string; cellType:'code'|'markdown'|'raw';
  source:string; sourceHash:string; executionCount:number|null; outputs:NotebookOutputPreview[] };
export type NotebookSnapshotSummary = { id:string; projectId:string; nodeId:string; hash:string; sourceArtifactId:string; runId:string;
  capturedAt:string; path:string; origin:'jupyter'|'uploaded-ipynb'|'project-file'; sessionId?:string; cells:number; kernelName?:string; language?:string;
  warnings:string[] };
export type NotebookSnapshot = Omit<NotebookSnapshotSummary,'cells'> & { cells:NotebookCellPreview[] };
export type NotebookCaptureSummary = { runId:string; snapshotId:string; snapshotHash:string; cellIndex:number; cellId:string|null;
  cellLocator:string; outputIndices:number[]; artifactIds:string[]; capturedAt:string };
export type NotebookState = { session:NotebookSessionStatus|null; snapshot:NotebookSnapshot|null; snapshots:NotebookSnapshotSummary[];
  captures:NotebookCaptureSummary[]; limits:typeof NOTEBOOK_LIMITS; reason:string };
export type NotebookOpen = { url:string; nativeAuthentication:true; reason:string };
