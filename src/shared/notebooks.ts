import type { ApprovalMode } from './research.js';

/** A Notebook block's cells and outputs, in nbformat 4 terms. Cells run in ros.ai's Docker sandbox:
 * one Python process per open notebook, so variables carry from cell to cell. */
export const NOTEBOOK_LIMITS = { fileBytes:20_000_000, cells:1000, cellSourceCharacters:100_000, runningKernels:4, idleStopMinutes:30 } as const;

export type NotebookOutput =
  | { output_type:'stream'; name:'stdout'|'stderr'; text:string }
  | { output_type:'display_data'; data:Record<string,unknown>; metadata:Record<string,unknown> }
  | { output_type:'execute_result'; data:Record<string,unknown>; metadata:Record<string,unknown>; execution_count:number|null }
  | { output_type:'error'; ename:string; evalue:string; traceback:string[] };
export type NotebookCell = { id:string; cell_type:'code'|'markdown'|'raw'; source:string; metadata:Record<string,unknown>;
  outputs?:NotebookOutput[]; execution_count?:number|null; attachments?:Record<string,unknown> };
/** `revision` changes when cells are edited, added or replaced, not when outputs arrive. */
export type NotebookContent = { nodeId:string; projectId:string; revision:number; updatedAt:string; nbformatMinor:number;
  metadata:Record<string,unknown>; cells:NotebookCell[] };
/** What the browser sends when saving: cells without outputs. Outputs stay with the cell id on the server. */
export type NotebookCellEdit = Pick<NotebookCell,'id'|'cell_type'|'source'> & { metadata?:Record<string,unknown> };

export type NotebookKernel = { status:'off'|'starting'|'idle'|'busy'; session:string|null; executionCount:number;
  message?:string; python?:string; libraries?:Record<string,string>; cwd?:string };
export type NotebookQueued = { cellId:string; state:'queued'|'running' };
export type NotebookState = {
  notebook:NotebookContent; kernel:NotebookKernel; queue:NotebookQueued[]; mode:ApprovalMode;
  /** The .ipynb file and the folder cells may write to, relative to the project folder. */
  file:string|null; outputs:string|null;
  runtime:{ available:boolean; reason?:string };
  /** A version replaced by an import or an edit in another app, which Undo brings back. */
  previous?:{ reason:string; at:string };
  /** Outputs saved as results, as `cellId/index` → artifact id, while the output is unchanged. */
  saved:Record<string,string>;
};
export type NotebookApproval = { cellId:string; fingerprint:string; reason:string };
export type NotebookRunResult = { revision:number; queued:string[]; approval?:NotebookApproval };
export type NotebookEvent =
  | { type:'kernel'; kernel:NotebookKernel }
  | { type:'cell'; cellId:string; state:'queued'|'running'|'done'|'cancelled'; executionCount?:number|null; status?:'ok'|'error'|'interrupted' }
  | { type:'output'; cellId:string; output:NotebookOutput }
  | { type:'stream'; cellId:string; name:'stdout'|'stderr'; text:string }
  | { type:'clear'; cellId:string }
  /** `client` names the window that saved, which already has this version. */
  | { type:'notebook'; revision:number; reason:string; client?:string };
/** Shown on the canvas card. `figure` is the hash of the newest figure, served by the notebook's figure route. */
export type NotebookSummary = { nodeId:string; cells:number; codeCells:number;
  lastRun?:{ at:string; status:'ok'|'error'|'interrupted'; executionCount:number|null }; figure?:string; value?:string;
  /** The first cell with content, shown on the card when there is no figure or number. */
  excerpt?:{ kind:'code'|'text'; text:string };
  /** A cell is running or waiting. Added when the project is read; never saved. */
  running?:boolean };

/** The line of a cell that raised an error, read from its traceback (ros.ai's or Jupyter's wording). */
export function errorLine(output:NotebookOutput, executionCount:number|null|undefined):number|null {
  if (output.output_type !== 'error' || executionCount === null || executionCount === undefined) return null;
  let line:number|null = null;
  for (const match of output.traceback.join('\n').replace(/\u001b\[[0-9;]*m/gu, '').matchAll(/(?:File "In \[(\d+)\]", line (\d+)|Cell In\s?\[(\d+)\], line (\d+))/gu))
    if (Number(match[1] ?? match[3]) === executionCount) line = Number(match[2] ?? match[4]);
  return line;
}
