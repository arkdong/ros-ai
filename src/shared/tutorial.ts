import type { ExperimentPreview } from './experiments.js';

export type TutorialScenarioId = 'workflow' | 'date-night' | 'banking' | 'market';
/** The demos a step-by-step guide builds (WorkflowDemo), rather than the older lessons. */
export const guidedScenario = (id: TutorialScenarioId) => id === 'workflow' || id === 'date-night';
export type TutorialExecution = { available:boolean; backend:'docker-python'; reason:string };
/** A demo as the start screen lists it: `projectTitle` is the name its project gets, `steps` how many steps build it. */
export type TutorialScenario = { id:TutorialScenarioId; title:string; projectTitle:string; steps:number; summary:string; question:string; publicDataReady:boolean; publicDataStatus:string; available?:boolean; unavailableReason?:string };
export type TutorialCatalog = {
  scenarios:TutorialScenario[];
  execution:TutorialExecution;
  hosting:{ mode:'local'|'public-demo'; publicReady:boolean; reason:string };
};
export type TutorialStage = {
  index:number; title:string; nodeId:string|null; summary:string;
  status:'pending'|'ready'|'awaiting-approval'|'running'|'completed'|'failed';
  /** The guided workflow's steps also name a short label, what a live run does, the button that adds the next step,
   * the blocks to show together and the blocks worth opening. */
  label?:string; live?:string; next?:string; frame?:string[]; open?:{ label:string; nodeId:string }[];
};
export type TutorialSession = {
  projectId:string; scenario:TutorialScenarioId; title:string; step:number;
  stages:TutorialStage[]; runId:string|null; preview:ExperimentPreview|null;
  outputArtifactIds:string[]; freshOutputArtifactIds:string[];
  draftNodeId:string|null; draftArtifactId:string|null;
  execution:TutorialExecution; notice:string; createdAt:string;
};
