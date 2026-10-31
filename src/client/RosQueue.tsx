import { useState } from 'react';
import { CornerDownRight, Pencil, X } from 'lucide-react';
import type { QueuedMessage } from '../shared/assistant';
import { api, post } from './api';
import { textPreview } from '../shared/presentation';

/** Messages typed while the thread was working, above the composer: each goes in turn once ROS is free. Send now stops
 * the turn that is working and sends this one next; Edit takes it back into the box; X removes it. */
export function RosQueue({ projectId, items, compact = false, onChanged, onEdit }: { projectId: string; items: QueuedMessage[]; compact?: boolean; onChanged: () => unknown; onEdit: (text: string) => void }) {
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState('');
  if (!items.length) return null;
  const run = async (work: () => Promise<unknown>) => { setBusy(true); setProblem(''); try { await work(); await onChanged(); } catch (cause) { setProblem(cause instanceof Error ? cause.message : 'That did not work.'); } finally { setBusy(false); } };
  const remove = (id: string) => api(`/api/projects/${projectId}/assistant/queued/${id}`, { method: 'DELETE' });
  return <div className={`ros-queue ${compact ? 'compact' : ''}`} aria-label="Waiting messages">
    {items.map((item, index) => <div key={item.id} className={`ros-queue-row ${item.paused ? 'paused' : ''}`}>
      <CornerDownRight size={13} aria-hidden="true"/>
      <span className="ros-queue-text" title={item.message}>{textPreview(item.message, 140).text}{(item.paused || index === 0) && <small>{item.paused ? item.note ?? 'Waiting for you' : 'Next, when ROS is done'}</small>}</span>
      <button type="button" className="text-button small" disabled={busy} title={item.paused ? 'Send this now' : 'Stop what ROS is doing and send this now'} onClick={() => void run(() => post(`/api/projects/${projectId}/assistant/queued/${item.id}/now`))}>Send now</button>
      <button type="button" className="icon-button" disabled={busy} aria-label="Edit this message" title="Edit" onClick={() => void run(async () => { await remove(item.id); onEdit(item.message); })}><Pencil size={12}/></button>
      <button type="button" className="icon-button" disabled={busy} aria-label="Remove this message" title="Remove" onClick={() => void run(() => remove(item.id))}><X size={13}/></button>
    </div>)}
    {problem && <p className="ros-queue-problem" role="alert">{problem}</p>}
  </div>;
}
