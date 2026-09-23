import { z } from 'zod';
import { resolveModelSetting, type ModelSelection, type ModelSettingsResponse, type ProjectModelSettings } from '../shared/model-settings.js';
import { StoreError, type Store } from './store.js';
import { DEFAULT_MODEL } from './providers.js';
import { OPENAI_MODELS } from './openai-provider.js';

const selectionSchema = z.object({ provider: z.enum(['nebius', 'openai']), model: z.string().trim().min(1).max(160) }).strict();
export class ModelSettings {
  constructor(private readonly store: Store, private readonly nebiusModel = process.env.ROS_NEBIUS_MODEL ?? DEFAULT_MODEL) {}
  settings(projectId: string): ProjectModelSettings {
    this.store.getProject(projectId);
    return this.store.record<ProjectModelSettings>('model-settings', projectId) ?? { default: { provider: 'nebius', model: this.nebiusModel }, overrides: {} };
  }
  resolve(projectId: string, nodeId?: string | null) {
    return resolveModelSetting(this.settings(projectId), this.store.getProject(projectId).canvas.nodes, nodeId);
  }
  read(projectId: string): ModelSettingsResponse {
    const settings = this.settings(projectId), nodes = this.store.getProject(projectId).canvas.nodes;
    return { ...settings, project: settings.default, effective: Object.fromEntries(nodes.map(node => [node.id, resolveModelSetting(settings, nodes, node.id)])),
      providers: [
        { id: 'nebius', label: 'Nebius Token Factory', configured: Boolean(process.env.NEBIUS_API_KEY), models: [{ id: this.nebiusModel, label: this.nebiusModel === DEFAULT_MODEL ? 'Nemotron 3 Ultra' : this.nebiusModel }, { id: 'moonshotai/Kimi-K2.7-Code', label: 'Kimi K2.7 Code' }] },
        { id: 'openai', label: 'OpenAI', configured: Boolean(process.env.OPENAI_API_KEY), models: OPENAI_MODELS.map(({ id, label }) => ({ id, label })) },
      ] };
  }
  update(projectId: string, supplied: unknown) {
    const { nodeId, selection } = z.object({ nodeId: z.string().min(1).max(120).nullable().optional(), selection: selectionSchema.nullable() }).strict().parse(supplied);
    const settings = this.settings(projectId);
    if (nodeId && !this.store.getProject(projectId).canvas.nodes.some(node => node.id === nodeId)) throw new StoreError('Choose a note in this project.');
    if (selection) this.validate(selection);
    if (nodeId) {
      if (selection) settings.overrides[nodeId] = selection;
      else delete settings.overrides[nodeId];
    } else {
      if (!selection) throw new StoreError('Choose a project default model.');
      settings.default = selection;
    }
    this.store.saveRecord('model-settings', projectId, projectId, settings);
    return this.read(projectId);
  }
  private validate(selection: ModelSelection) {
    const supported = selection.provider === 'nebius' ? [this.nebiusModel, 'moonshotai/Kimi-K2.7-Code'].includes(selection.model) : OPENAI_MODELS.some(model => model.id === selection.model);
    if (!supported) throw new StoreError('Choose one of the available models.');
  }
}
