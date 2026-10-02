import type { ModelMaker } from './model-settings.js';

export type InferenceDestination = 'local-unverified' | 'remote';
export type RegisteredInferenceModel = {
  id: string;
  label: string;
  contextTokens: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  maker?: ModelMaker;
};
export type InferenceCaps = {
  maxInputBytes: number;
  maxOutputTokens: number;
  timeoutMs: number;
  maxConcurrent: number;
  maxResponseBytes?: number;
};
/** Write-only configuration: endpoint and key never appear in readable status. */
export type InferenceConnectionInput = {
  name: string;
  endpoint: string;
  apiKey?: string | null;
  models: RegisteredInferenceModel[];
  caps: InferenceCaps;
  enabled: boolean;
};
export type InferenceAllowanceInput = { requestCeiling: number; usdCeiling: number; enabled: true; acknowledged: true };
export type InferenceConnectionStatus = {
  id: string;
  name: string;
  enabled: boolean;
  deleted: boolean;
  ready: boolean;
  reason: string;
  revision: number;
  endpointOrigin: string;
  keyConfigured: boolean;
  destination: InferenceDestination;
  models: RegisteredInferenceModel[];
  caps: InferenceCaps;
  allowanceEnabled: boolean;
  requestCeiling: number;
  usdCeiling: number;
  usedRequests: number;
  accountedUsd: number;
  remainingRequests: number;
  remainingUsd: number;
  pricingBasis: string;
  updatedAt: string;
};
export type InferenceConnectionsResponse = { connections: InferenceConnectionStatus[] };
