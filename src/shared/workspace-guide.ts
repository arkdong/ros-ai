/** Explicit guide reviews use their own context, never research chat context. */
export type WorkspaceGuideIntent = 'structure' | 'inputs-outputs' | 'conclusion';
export type WorkspaceGuideMetadataField = 'title' | 'description' | 'relationships';
export type WorkspaceGuideArtifactSelection = { artifactId: string; hash: string; excerpt?: string };
export type WorkspaceGuideReviewInput = {
  intent: WorkspaceGuideIntent;
  nodeIds: string[];
  metadataFields: WorkspaceGuideMetadataField[];
  contentNodeIds: string[];
  artifacts: WorkspaceGuideArtifactSelection[];
  message?: string;
  acknowledgedDestination: true;
  connectionId: string;
  model: string;
  connectionRevision: number;
};
export type WorkspaceGuideSettings = { connectionId: string | null; model: string | null };
export type WorkspaceGuideConnection = {
  id: string;
  label: string;
  destination: string;
  location: 'local-unverified' | 'external' | 'local-verified';
  configured: boolean;
  enabled: boolean;
  revision: number;
  models: { id: string; label: string }[];
};
export type WorkspaceGuideManifest = {
  hash: string;
  nodeIds: string[];
  metadataFields: WorkspaceGuideMetadataField[];
  contentNodeIds: string[];
  artifacts: WorkspaceGuideArtifactSelection[];
  messageIncluded: boolean;
  omissions: string[];
};
export type WorkspaceGuideInputSuggestion = {
  nodeId: string;
  artifactId: string;
  hash: string;
  excerpt?: string;
  label: string;
  status?: 'pending' | 'applied' | 'blocked';
};
export type WorkspaceGuideReview = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: string;
  updatedAt: string;
  intent: WorkspaceGuideIntent;
  reply: string;
  error?: string;
  warning?: string;
  model: string;
  connectionId: string;
  destination: string;
  location: WorkspaceGuideConnection['location'];
  manifest: WorkspaceGuideManifest;
  proposalId?: string;
  inputSuggestions?: WorkspaceGuideInputSuggestion[];
};
export type WorkspaceGuideState = {
  projectId: string;
  settings: WorkspaceGuideSettings;
  connections: WorkspaceGuideConnection[];
  ready: boolean;
  blocker: string;
  reviews: WorkspaceGuideReview[];
  activeReviewId: string | null;
};
