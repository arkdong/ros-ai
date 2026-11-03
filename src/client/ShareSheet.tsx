import { useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import { Modal } from './Modal';
import { post } from './api';
import { StillCanvas, type StillGhost } from '../still/StillCanvas';
import { DEFAULT_SHARE_CHOICES, FIND_NAMES, shareFileName, type ShareBox, type ShareChoices, type ShareFind, type SharePreview } from '../shared/share';
import type { Canvas } from '../shared/types';
import './share-sheet.css';

const size = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Share: one sheet that shows exactly what will leave this computer. The preview on the left is what the other
 * person sees; a click on a block there leaves it out. Private things are off until switched on, and personal
 * things found inside blocks are hidden until shown again. The one action saves a canvas file. */
export function ShareSheet({ projectId, title, canvas, layout, open, onClose }: { projectId: string; title: string; canvas: Canvas; layout: Record<string, ShareBox>; open: string[]; onClose: () => void }) {
  const [choices, setChoices] = useState<ShareChoices>({ ...DEFAULT_SHARE_CHOICES, layout, open });
  const [preview, setPreview] = useState<SharePreview | null>(null), [error, setError] = useState(''), [saving, setSaving] = useState(false), [saved, setSaved] = useState('');
  const asked = useRef(0);
  useEffect(() => {
    const ask = ++asked.current;
    const timer = setTimeout(() => { post<SharePreview>(`/api/projects/${projectId}/share/preview`, choices).then(value => { if (ask === asked.current) { setPreview(value); setError(''); } }).catch(cause => { if (ask === asked.current) setError(message(cause)); }); }, preview ? 120 : 0);
    return () => clearTimeout(timer);
  }, [projectId, choices]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = (patch: Partial<ShareChoices>) => { setSaved(''); setChoices(current => ({ ...current, ...patch })); };
  const leave = (id: string) => change({ leaveOut: choices.leaveOut.includes(id) ? choices.leaveOut.filter(item => item !== id) : [...choices.leaveOut, id] });
  const reveal = (find: ShareFind) => change({ reveal: find.revealed ? choices.reveal.filter(id => id !== find.id) : [...choices.reveal, find.id] });
  // Left-out blocks stay faintly on the preview where they were, so a click brings them back.
  const ghosts = useMemo<StillGhost[]>(() => choices.leaveOut.flatMap(id => { const node = canvas.nodes.find(item => item.id === id), box = layout[id]; return node && box ? [{ id, title: node.title, box }] : []; }), [choices.leaveOut, canvas, layout]);
  const save = async () => {
    setSaving(true); setError('');
    try {
      const response = await fetch(`/api/projects/${projectId}/share/file`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(choices), signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? `Saving failed (${response.status}).`);
      const name = shareFileName(preview?.copy.title ?? title), url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
      setSaved(name);
    } catch (cause) { setError(message(cause)); } finally { setSaving(false); }
  };
  const counts = preview?.counts, finds = preview?.finds ?? [];
  const grouped = (['key', 'email', 'phone', 'path', 'address'] as const).flatMap(kind => { const items = finds.filter(find => find.kind === kind); return items.length ? [{ kind, items }] : []; });
  return <Modal title={`Share ${title}`} onClose={onClose} className="share-sheet" bare>
    <div className="share-head"><h2>Share “{title}”</h2><button className="icon-button" aria-label="Close" onClick={onClose}><X size={18}/></button></div>
    <div className="share-body">
      <div className="share-preview" aria-label="What the other person sees">
        {preview ? <StillCanvas copy={preview.copy} fileUrl={key => `/api/projects/${projectId}/nodes/${encodeURIComponent(key)}/file`} onOpen={node => leave(node.id)} ghosts={ghosts} onGhost={leave} fitKey={projectId} padding={28} className="share-still"/>
          : <div className="share-loading">{error ? error : <LoaderCircle size={20} className="spin"/>}</div>}
        <span className="share-preview-hint">Click a block to leave it out</span>
      </div>
      <div className="share-side">
        <h3>Include</h3>
        <div className="share-row"><span>Blocks</span><span className="share-count">{counts ? `${counts.blocks} of ${counts.total}` : '…'}{choices.leaveOut.length > 0 && <button type="button" className="text-button" onClick={() => change({ leaveOut: [] })}>Include all</button>}</span></div>
        <Choice label="Pictures and files" detail={counts ? `${counts.files} · ${size(preview!.bytes)}` : ''} on={choices.files} onChange={files => change({ files })}/>
        {(counts?.live ?? 0) > 0 || !choices.live ? <Choice label="Live blocks as they look now" detail="Notion, Google, Metrics" on={choices.live} onChange={live => change({ live })}/> : null}
        {(counts?.messages ?? 0) > 0 && <Choice label="Conversation with ROS" detail={`${counts!.messages} message${counts!.messages === 1 ? '' : 's'}`} on={choices.conversation} onChange={conversation => change({ conversation })}/>}
        {(counts?.agents ?? 0) > 0 && <Choice label="Agent and model names" on={choices.agentDetails} onChange={agentDetails => change({ agentDetails })}/>}
        <h3>Hidden for you</h3>
        {!preview ? null : !grouped.length ? <p className="share-quiet">Nothing personal found in the blocks you share.</p>
          : <ul className="share-finds">{grouped.map(({ kind, items }) => <li key={kind}>
            <div className="share-find-kind"><span className="share-dot"/>{items.length} {FIND_NAMES[kind][items.length === 1 ? 0 : 1]}</div>
            {items.slice(0, 8).map(find => <div key={find.id} className="share-find" title={`In ${find.blocks.join(', ')}`}>
              <code>{find.shown}</code>
              {kind === 'key' ? <span className="share-count">Always hidden</span> : <button type="button" className="text-button" onClick={() => reveal(find)}>{find.revealed ? 'Hide' : 'Show'}</button>}
            </div>)}
            {items.length > 8 && <p className="share-quiet">{items.length - 8} more</p>}
          </li>)}</ul>}
      </div>
    </div>
    <div className="share-foot">
      <span className="share-foot-note" role="status">{error && preview ? error : saved ? `Saved ${saved}. It opens in any browser.` : 'One .html file. It opens in any browser, offline.'}</span>
      <button type="button" className="primary" disabled={!preview || saving || !counts?.blocks} onClick={() => void save()}>{saving ? <LoaderCircle size={15} className="spin"/> : null}Save canvas file</button>
    </div>
  </Modal>;
}

function Choice({ label, detail, on, onChange }: { label: string; detail?: string; on: boolean; onChange: (on: boolean) => void }) {
  return <label className="share-row">
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}><span/></button>
    <span>{label}</span>{detail && <span className="share-count">{detail}</span>}
  </label>;
}
