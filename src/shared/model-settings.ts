import type { CanvasNode } from './types.js';
import type { InferenceDestination } from './inference.js';

/** Built-in IDs remain stable; registered connections use a durable custom-UUID. */
export type ModelProvider = string;
export type ModelSelection = { provider: ModelProvider; model: string };
export type ModelMaker = { id: 'nvidia' | 'moonshot' | 'openai' | 'unknown'; label: string; monogram: string };
/** Presentation only: model makers and inference connections are different. */
export function modelMaker(model: string, provider?: ModelProvider): ModelMaker {
  // Local servers name models without the maker's prefix: nemotron-3-nano:4b, gpt-oss:20b, kimi-k2.
  if(model.toLowerCase().startsWith('nvidia/')||/(^|\/)nemotron/i.test(model))return {id:'nvidia',label:'NVIDIA',monogram:'NV'};
  if(model.toLowerCase().startsWith('moonshotai/')||/(^|\/)kimi-/i.test(model))return {id:'moonshot',label:'Moonshot',monogram:'M'};
  if(provider==='openai'||/(^|\/)gpt-oss/i.test(model))return {id:'openai',label:'OpenAI',monogram:'AI'};
  return {id:'unknown',label:'Configured model',monogram:'M'};
}
export type ProjectModelSettings = { default: ModelSelection; overrides: Record<string, ModelSelection> };
export type EffectiveModel = { selection: ModelSelection; inheritedFrom: string | null };
export type ModelSettingsResponse = ProjectModelSettings & {
  project: ModelSelection;
  effective: Record<string, EffectiveModel>;
  providers: { id: ModelProvider; label: string; configured: boolean; connectionId?: string; destination?: InferenceDestination; endpointOrigin?: string; models: { id: string; label: string; maker?: ModelMaker }[] }[];
};

/** Parent ownership supplies settings; evidence connections never do. */
export function resolveModelSetting(settings: ProjectModelSettings, nodes: readonly CanvasNode[], nodeId?: string | null): EffectiveModel {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const visited = new Set<string>();
  let id = nodeId;
  while (id && !visited.has(id)) {
    visited.add(id);
    if (settings.overrides[id]) return { selection: settings.overrides[id], inheritedFrom: id };
    id = byId.get(id)?.parentId;
  }
  return { selection: settings.default, inheritedFrom: null };
}
