import type { CanvasNode } from './types.js';

export type ModelProvider = 'nebius' | 'openai';
export type ModelSelection = { provider: ModelProvider; model: string };
export type ProjectModelSettings = { default: ModelSelection; overrides: Record<string, ModelSelection> };
export type EffectiveModel = { selection: ModelSelection; inheritedFrom: string | null };
export type ModelSettingsResponse = ProjectModelSettings & {
  project: ModelSelection;
  effective: Record<string, EffectiveModel>;
  providers: { id: ModelProvider; label: string; configured: boolean; models: { id: string; label: string }[] }[];
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
