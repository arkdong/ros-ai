import type { CanvasNode } from './types.js';
import type { InferenceDestination } from './inference.js';

/** Built-in IDs remain stable; registered connections use a durable custom-UUID. */
export type ModelProvider = string;
export type ModelSelection = { provider: ModelProvider; model: string };
export type ModelMaker = { id: 'nvidia' | 'moonshot' | 'openai' | 'unknown'; label: string; monogram: string };
/** Presentation only: model makers and inference connections are different. */
/** Nemotron models ros.ai offers on Nebius Token Factory with a person's own key, best first. Ids were read from
 * the authenticated catalogue on 2026-10-19 (research/model-comparison-2026-10-19.md: Super 7.5/10, Nano 6/10, Ultra 0/10). */
export const NEBIUS_MODELS: readonly { id: string; label: string }[] = [
  { id: 'nvidia/nemotron-3-super-120b-a12b', label: 'Nemotron 3 Super' },
  { id: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', label: 'Nemotron 3 Nano 30B' },
  { id: 'nvidia/Nemotron-3-Ultra-550b-a55b', label: 'Nemotron 3 Ultra' },
  { id: 'moonshotai/Kimi-K2.7-Code', label: 'Kimi K2.7 Code' },
];
export const DEFAULT_NEBIUS_MODEL = NEBIUS_MODELS[0].id;
export const ULTRA_MODEL = NEBIUS_MODELS[2].id;
/** A catalogue id read as a name: nvidia/nemotron-3-super-120b-a12b becomes Nemotron 3 Super; an unknown id keeps its short form. */
export function nebiusModelLabel(id: string): string {
  const known = NEBIUS_MODELS.find(model => model.id === id);
  if (known) return known.label;
  const short = id.split('/').pop() ?? id, nemotron = /^(?:nvidia-)?nemotron-3-(nano|super|ultra)/i.exec(short);
  return nemotron ? `Nemotron 3 ${nemotron[1][0].toUpperCase()}${nemotron[1].slice(1).toLowerCase()}` : short;
}

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
