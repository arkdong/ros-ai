/** Kept trajectories as chat samples in the shape Hugging Face chat templates take (messages with
 * tool_calls, plus the tool list), which train/train_lora.py tokenises with Nemotron's own template.
 * An assistant turn whose tool call ros.ai refused is kept as context but marked train: false, so
 * the model learns the fix and never the mistake. Splits go by project, so validation projects are unseen. */
import { createHash } from 'node:crypto';
import type { ChatMessage } from '../../src/server/providers.js';
import type { Trajectory } from './env.js';

type Sample = { id: string; family: string; fixtureId: string; tools: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[]; messages: Record<string, unknown>[] };

const parse = (text: string) => { try { return JSON.parse(text || '{}') as unknown; } catch { return text; } };

export function toSample(trajectory: Trajectory): Sample {
  const failedCalls = new Set(trajectory.messages.filter((message): message is Extract<ChatMessage, { role: 'tool' }> => message.role === 'tool' && message.content.startsWith('Error:')).map(message => message.toolCallId));
  const messages = trajectory.messages.map(message => {
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    if (message.role === 'assistant' && 'toolCalls' in message && message.toolCalls.length) return {
      role: 'assistant', content: message.content, train: !message.toolCalls.some(call => failedCalls.has(call.id)),
      tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: parse(call.arguments) } })),
    };
    return message.role === 'assistant' ? { role: 'assistant', content: message.content, train: true } : { role: message.role, content: message.content };
  });
  return { id: trajectory.taskId, family: trajectory.family, fixtureId: trajectory.fixtureId, tools: trajectory.tools.map(tool => ({ type: 'function', function: tool })), messages };
}

/** About one project in twenty goes to validation, chosen by its id so reruns agree. */
export const isValidation = (fixtureId: string) => parseInt(createHash('sha256').update(fixtureId).digest('hex').slice(0, 4), 16) % 20 === 0;
