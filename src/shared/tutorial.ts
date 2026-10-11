import type { ExperimentPreview } from './experiments.js';

export type TutorialScenarioId = 'banking' | 'market';
export type TutorialExecution = { available:boolean; backend:'docker-python'; reason:string };
export type TutorialScenario = { id:TutorialScenarioId; title:string; summary:string; question:string; publicDataReady:boolean; publicDataStatus:string; available?:boolean; unavailableReason?:string };
export type TutorialCatalog = {
  scenarios:TutorialScenario[];
  workspace?:{ available:boolean; title:string; summary:string; unavailableReason?:string };
  execution:TutorialExecution;
  hosting:{ mode:'local'|'public-demo'; publicReady:boolean; reason:string };
};
export type TutorialStage = {
  index:number; title:string; nodeId:string|null; summary:string;
  status:'pending'|'ready'|'awaiting-approval'|'running'|'completed'|'failed';
};
export type TutorialSession = {
  projectId:string; scenario:TutorialScenarioId; title:string; step:number;
  stages:TutorialStage[]; runId:string|null; preview:ExperimentPreview|null;
  outputArtifactIds:string[]; freshOutputArtifactIds:string[];
  draftNodeId:string|null; draftArtifactId:string|null;
  execution:TutorialExecution; notice:string; createdAt:string;
};
