/** The bar a sample must clear to be trained on, and the same score for evaluating a model: the
 * turn finished, its tool calls passed ros.ai's checks, the family's tools were used in order,
 * and the answer follows the system prompt (short, no headings or tables, titles not IDs, and
 * nothing pending described as done). Each failed rule is named, so the report says why. */
import { FAMILIES } from './families.js';
import type { Trajectory } from './env.js';

export type Verdict = { pass: boolean; reasons: string[]; recovered: number };
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;
const words = (text: string) => text.split(/\s+/u).filter(Boolean).length;

export function check(trajectory: Trajectory): Verdict {
  const reasons: string[] = [], spec = FAMILIES[trajectory.family], reply = trajectory.reply.trim();
  if (trajectory.status !== 'completed') return { pass: false, reasons: [`turn failed: ${trajectory.error?.slice(0, 160)}`], recovered: 0 };
  const used = trajectory.calls.filter(call => !call.failed).map(call => call.name);
  const failed = trajectory.calls.filter(call => call.failed);
  // A failed call the model then fixed is kept (it teaches recovery) unless failures pile up; the failed
  // turn itself is masked from training in export.ts.
  if (failed.length > 2) reasons.push(`${failed.length} tool calls failed`);
  const recovered = failed.filter(call => used.includes(call.name)).length;
  if (failed.length - recovered > 0 && trajectory.family !== 'cannot-do') reasons.push(`unrecovered failure: ${failed.find(call => !used.includes(call.name))?.message.slice(0, 120)}`);
  for (const name of spec.requires ?? []) if (!used.includes(name)) reasons.push(`never called ${name}`);
  for (const name of spec.forbids ?? []) if (used.includes(name)) reasons.push(`called ${name}, which this family should not`);
  for (const [index, name] of (spec.first ?? []).entries()) if (used[index] !== name) reasons.push(`call ${index + 1} was ${used[index] ?? 'nothing'}, expected ${name}`);
  if (trajectory.family === 'research') {
    const order = ['ros_fan_out_search', 'ros_write_result', 'ros_read_pages', 'ros_write_findings', 'ros_propose_groups'];
    const firsts = order.map(name => used.indexOf(name));
    if (firsts.some((position, index) => index && position !== -1 && firsts[index - 1] !== -1 && position < firsts[index - 1])) reasons.push('research steps out of order');
    if (trajectory.findings < 3) reasons.push(`only ${trajectory.findings} findings saved`);
  }
  // Questions are answered from what was read, not from memory. Selected blocks arrive with their text
  // in the first message, so a read is required only when nothing was selected.
  const nothingSelected = trajectory.messages.some(message => message.role === 'user' && message.content.startsWith('Nothing is selected.'));
  if (['read-answer', 'report', 'add-notes'].includes(trajectory.family) && nothingSelected && !used.some(name => name.startsWith('ros_read'))) reasons.push('answered without reading');
  if (!reply) reasons.push('empty answer');
  if (words(reply) > 160) reasons.push(`answer is ${words(reply)} words`);
  if (/^#{1,6} /mu.test(reply)) reasons.push('answer has a heading');
  if (/^\s*\|.*\|\s*$/mu.test(reply)) reasons.push('answer has a table');
  if (UUID.test(reply) || trajectory.ids.some(id => id.length > 12 && reply.includes(id))) reasons.push('answer shows a raw ID');
  if (/<tool_call>|<function=/u.test(reply)) reasons.push('tool call written into the answer');
  const pending = trajectory.proposals.some(proposal => proposal.status === 'pending');
  if (pending && !/approv|review|accept|wait|pending|goedkeur|nog niet/iu.test(reply)) reasons.push('pending proposal not described as waiting');
  if (pending && /\b(I have|I've) (added|saved|created|run|updated|grouped|renamed)\b/iu.test(reply) && !/approv|review|wait|pending/iu.test(reply)) reasons.push('claims a pending change is done');
  // The prompt asks for one short sentence before each tool call; most turns should have it.
  const toolTurns = trajectory.messages.filter(message => message.role === 'assistant' && 'toolCalls' in message && message.toolCalls.length);
  if (toolTurns.length >= 2 && toolTurns.filter(message => message.content.trim()).length / toolTurns.length < .5) reasons.push('tool calls without a reason sentence');
  return { pass: !reasons.length, reasons, recovered };
}
