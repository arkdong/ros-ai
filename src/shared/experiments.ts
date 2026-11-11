import type { CodeDocument, Run } from './types.js';

export type ExperimentParameters = Record<string, string | number | boolean>;
export type ExperimentApproval = { fingerprint: string; status: 'pending' | 'allowed' | 'denied' | 'cancelled'; requestedAt: string; decidedAt?: string; decisionReason?: string };
export type ExperimentPreview = { run: Run; approval: ExperimentApproval; code: string; csv: string; parameters: ExperimentParameters; planner: string; manualCode?:boolean; inputMode?:'none'|'single-csv'; codeSource?:CodeDocument };
type ExecutionCapabilities = {available:boolean;backend:string;policy:string;runtime:string|null;workerHash:string;imageId?:string|null;enforcement:string[];limitations:string[];timeoutMs:number;libraries:Record<string,string>;exampleCode?:string;dataContract?:string};
export type ExperimentCapabilities = {
  available: boolean; permissionMode: 'ask'; executionTarget: string; runtime: string | null; workerHash: string;
  approveForMe: { available: boolean; reason: string }; fullAccess: boolean;
  sandbox?: ExecutionCapabilities;
  enforcement: string[]; limitations: string[]; maxConcurrency: number; timeoutMs: number;
  sampleCsv: string; exampleCode: string;
};
export type AutoResearch = { id: string; scope: string; outcome: string; runIds: string[]; createdAt: string; maxConcurrency: number; status: 'running' | 'completed' | 'stopped' };
