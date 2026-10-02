import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, ChevronDown, FileSpreadsheet, FileText, Library, PanelRightClose, FolderOutput, Link2, LoaderCircle, Plus, Upload, X } from 'lucide-react';
import { api, post } from './api';
import { groupResources } from '../shared/resource-groups';
import type { Artifact, ProjectDetail } from '../shared/types';
import type { ProjectResource, ResourcePreview } from '../shared/research';
import './Resources.css';
import { artifactTable, emptyTransform, type DataTransform } from '../shared/data-view';
import { DataViewer } from './DataViewer';
import { DerivedDataset } from './DerivedDataset';

const MAX_BYTES = 500000;
const storageLabel = (resource: ProjectResource) => resource.storage === 'linked' ? 'Linked file' : resource.storage === 'copied' ? 'Project copy' : resource.kind === 'source' ? 'Captured source' : 'Captured dataset';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function ResourceDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return createPortal(<dialog ref={dialog} className="resource-dialog" aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="resource-dialog-inner"><header><h2>{title}</h2><button className="icon-button" aria-label="Close resource dialog" onClick={onClose}><X size={18}/></button></header>{children}</div></dialog>, document.body);
}

export function Resources({ detail, onChanged, onOpenArtifact, onExports, onClose }: { detail: ProjectDetail; onChanged: () => Promise<unknown>; onOpenArtifact: (artifact: Artifact, nodeId: string) => void; onExports: () => void; onClose: () => void }) {
  const projectId = detail.project.id, base = `/api/projects/${projectId}/resources`;
  const [resources, setResources] = useState<ProjectResource[]>([]), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false), [mode, setMode] = useState<'copy' | 'link'>('copy'), [name, setName] = useState(''), [path, setPath] = useState('');
  const [upload, setUpload] = useState<{ fileName: string; content: string; bytes: number } | null>(null), [reading, setReading] = useState(false), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<ProjectResource | null>(null), [preview, setPreview] = useState<ResourcePreview | null>(null), [previewBusy, setPreviewBusy] = useState(false);
  const [nodeId, setNodeId] = useState(detail.project.canvas.nodes[0]?.id ?? '');
  const [derived, setDerived] = useState<DataTransform|null>(null);
  const readSequence = useRef(0), listSequence = useRef(0), previewSequence = useRef(0);
  const load = useCallback(async () => { const sequence = ++listSequence.current; const values = await api<ProjectResource[]>(base); if (sequence === listSequence.current) setResources(values); }, [base]);
  useEffect(() => { void load().catch(cause => setError(message(cause))); }, [load, detail]);
  useEffect(() => { if (!detail.project.canvas.nodes.some(node => node.id === nodeId)) setNodeId(detail.project.canvas.nodes[0]?.id ?? ''); }, [detail.project.canvas.nodes, nodeId]);
  const showPreview = async (resource: ProjectResource) => {
    const sequence = ++previewSequence.current; setSelected(resource); setPreview(null); setDerived(null); setPreviewBusy(true); setError(''); setNotice('');
    try { const value = await api<ResourcePreview>(`${base}/${resource.id}`); if (sequence === previewSequence.current) setPreview(value); }
    catch (cause) { if (sequence === previewSequence.current) setError(message(cause)); }
    finally { if (sequence === previewSequence.current) setPreviewBusy(false); }
  };
  const chooseFile = async (file: File | undefined) => {
    const sequence = ++readSequence.current; setUpload(null); setError(''); if (!file) return;
    if (!/\.csv$/iu.test(file.name) || file.size === 0 || file.size > MAX_BYTES) { setError('Choose a non-empty UTF-8 CSV, no larger than 500 KB (500,000 bytes).'); return; }
    setReading(true);
    try {
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
      if (content.includes('\0')) throw new Error('CSV contains binary data. Choose a UTF-8 text file.');
      if (sequence === readSequence.current) { setUpload({ fileName: file.name, content, bytes: file.size }); setName(file.name); }
    } catch { if (sequence === readSequence.current) setError('Could not read this file as UTF-8 CSV text.'); }
    finally { if (sequence === readSequence.current) setReading(false); }
  };
  const add = async () => {
    setBusy(true); setError('');
    try {
      const resource = await post<ProjectResource>(base, mode === 'link' ? { mode, name: name.trim(), path: path.trim() } : { mode, name: name.trim(), fileName: upload!.fileName, content: upload!.content });
      await load(); await onChanged(); setAdding(false); setName(''); setPath(''); setUpload(null); setNotice(`${resource.name} added to this project.`);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };
  const useInNote = async () => {
    if (!selected || !nodeId) return;
    setBusy(true); setError('');
    try { await post(`${base}/${selected.id}/use`, { nodeId }); await load(); await onChanged(); setNotice('Exact resource version selected in this note.'); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };
  const shown = preview?.resource ?? selected;
  let table: ReturnType<typeof artifactTable> | null = null;
  try { if(preview && shown?.kind==='csv') table=artifactTable(preview.content); } catch { /* Exact raw capture remains accessible for malformed CSV. */ }
  const addDatasetBlock = async () => {
    if(!selected || !preview || !shown)return;
    setBusy(true);setError('');
    try {const saved=await post<{artifact:Artifact;nodeId:string}>(`/api/projects/${projectId}/datasets/derive`,{resourceId:selected.id,expectedHash:preview.hash,title:shown.name,transformation:emptyTransform});await load();await onChanged();setSelected(null);setPreview(null);onOpenArtifact(saved.artifact,saved.nodeId);}
    catch(cause){setError(message(cause));}finally{setBusy(false);}
  };
  const ownerTitle = (resource: ProjectResource) => resource.nodeId ? detail.project.canvas.nodes.find(node => node.id === resource.nodeId)?.title ?? 'Removed note' : undefined;
  const renderResource = (resource: ProjectResource) => <button key={resource.id} className="resource-row" data-resource-id={resource.id} aria-label={`Preview ${resource.name} · ${storageLabel(resource)}${ownerTitle(resource) ? ` · ${ownerTitle(resource)}` : ''}`} onClick={() => void showPreview(resource)}>
    {resource.storage === 'linked' ? <Link2 size={18}/> : resource.kind === 'source' ? <FileText size={18}/> : <FileSpreadsheet size={18}/>}<span><strong>{resource.name}</strong><small>{storageLabel(resource)} · {new Date(resource.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</small><small className="resource-owner">{ownerTitle(resource) ? `From ${ownerTitle(resource)}` : 'Project file'}</small>{(resource.url || resource.path || resource.locator) && <small className="resource-origin">{resource.url || resource.path || resource.locator}</small>}{resource.hash && <small className="resource-version">Saved version {resource.hash.slice(0, 10)}</small>}</span><ArrowUpRight size={14}/>
  </button>;
  return <aside id="research-resources-panel" className="assistant-panel resources-panel" aria-label="Project resources" data-tour-target="resources-panel"><header className="assistant-heading"><Library size={23}/><div><h2>Resources</h2><p>Sources, files & exact saved versions</p></div><button className="icon-button" aria-label="Close resources panel" onClick={onClose}><PanelRightClose size={17}/></button></header>
    <div className="resources-actions"><button className="secondary" onClick={() => { setAdding(true); setError(''); setNotice(''); }}><Plus size={15}/> Add file</button><button className="text-button" onClick={onExports}><FolderOutput size={15}/> Exports</button><span>{resources.length} item{resources.length === 1 ? '' : 's'}</span></div>
    <div className="resources-list">{groupResources(resources).map(group => group.versions.length === 1 ? renderResource(group.versions[0]) : <details className="resource-group" key={group.id}><summary><span><strong>{group.versions.find(resource => resource.storage !== 'captured' || resource.originKey === `artifact:${resource.id}`)?.name || group.versions[0].name}</strong><small>{group.versions.length} linked records · expand exact captures</small></span><ChevronDown size={15}/></summary>{group.versions.map(renderResource)}</details>)}{!resources.length && <p className="resources-empty">Add a CSV or capture research evidence. Resources stay with this project.</p>}</div>
    <p className="resources-format-note">File import supports UTF-8 CSV up to 500 KB. Writing references in other formats can be saved as attributed source notes.</p>
    {!adding && !selected && error && <p className="resource-error" role="alert">{error}</p>}{!adding && !selected && notice && <p className="resource-notice" role="status">{notice}</p>}
    {adding && <ResourceDialog title="Add a project file" onClose={() => { if (!busy) setAdding(false); }}><p className="resource-intro">CSV files up to 500 KB (500,000 bytes). Choose how this project keeps the file.</p><div className="resource-modes" role="radiogroup" aria-label="File storage"><label className={mode === 'copy' ? 'selected' : ''}><input type="radio" name="resource-mode" checked={mode === 'copy'} disabled={busy} onChange={() => setMode('copy')}/><Upload size={17}/><span><strong>Copy into project</strong><small>Upload a saved copy. Later source changes do not affect it.</small></span></label><label className={mode === 'link' ? 'selected' : ''}><input type="radio" name="resource-mode" checked={mode === 'link'} disabled={busy} onChange={() => setMode('link')}/><Link2 size={17}/><span><strong>Link a local file</strong><small>Keep its location; capture an exact version when used.</small></span></label></div>
      {mode === 'copy' ? <label className="field-label">CSV file<input type="file" accept=".csv,text/csv" aria-label="CSV file to copy" disabled={busy || reading} onChange={event => void chooseFile(event.target.files?.[0])}/>{upload && <small>{upload.fileName} · {upload.bytes.toLocaleString()} bytes</small>}</label> : <label className="field-label">Absolute local path<input aria-label="Resource local path" placeholder="/Users/you/data/observations.csv" value={path} disabled={busy} onChange={event => setPath(event.target.value)}/><small>The local ros.ai server reads this selected file. The source stays read-only.</small></label>}
      <label className="field-label">Name<input aria-label="Resource name" value={name} maxLength={160} disabled={busy} onChange={event => setName(event.target.value)} placeholder="Observations"/></label>{error && <p className="resource-error" role="alert">{error}</p>}<div className="resource-dialog-actions"><button className="secondary" disabled={busy} onClick={() => setAdding(false)}>Cancel</button><button className="primary" disabled={busy || reading || !name.trim() || (mode === 'copy' ? !upload : !path.trim())} onClick={() => void add()}>{busy || reading ? <LoaderCircle size={15} className="spin"/> : <Plus size={15}/>} Add file</button></div></ResourceDialog>}
    {selected && shown && <ResourceDialog title={shown.name} onClose={() => { if (!busy) { ++previewSequence.current; setSelected(null); setPreview(null); } }}><div className="resource-detail-meta"><span>{storageLabel(shown)}</span>{shown.bytes !== undefined && <span>{shown.bytes.toLocaleString()} bytes</span>}{shown.hash && <code title={shown.hash}>SHA256 {shown.hash.slice(0, 12)}</code>}</div>{shown.path && <p className="resource-path">{shown.path}</p>}{shown.url && <p className="resource-path">{shown.url}</p>}{shown.locator && <p className="resource-path">{shown.locator}</p>}{shown.storage === 'linked' && <p className="resource-intro">This preview reads the linked file now. Use in note captures its current version and keeps the original unchanged.</p>}{shown.storage === 'copied' && <p className="resource-intro">This immutable copy is saved in this project. Use it in a note to make it available for research.</p>}{shown.storage === 'captured' && <p className="resource-intro">An immutable captured version. Selecting it in another note does not start research.</p>}
      {shown.storage === 'captured' && <p className="resource-capture-context">From <strong>{ownerTitle(shown)}</strong><br/>Captured {new Date(shown.createdAt).toLocaleString()} · Version {shown.artifactId?.slice(0, 8)}</p>}
      {previewBusy ? <p className="resource-loading"><LoaderCircle size={16} className="spin"/> Loading preview…</p> : preview && (table ? derived ? <DerivedDataset data={table} projectId={projectId} resourceId={selected.id} sourceHash={preview.hash} initial={derived} onSaved={async(saved,nodeId)=>{await load();await onChanged();setSelected(null);setPreview(null);setDerived(null);onOpenArtifact(saved,nodeId);}} onCancel={()=>setDerived(null)}/> : <DataViewer key={`${selected.id}:${preview.hash}`} viewKey={`resource:${selected.id}:${preview.hash}`} data={table} name={shown.name} onSaveDerived={setDerived}/> : <pre className="resource-content-preview" tabIndex={0}>{preview.content}</pre>)}
      {error && <p className="resource-error" role="alert">{error}</p>}{notice && <p className="resource-notice" role="status">{notice}</p>}
      {table&&!derived&&<button className="primary" disabled={busy||previewBusy||!preview} onClick={()=>void addDatasetBlock()}><Plus size={14}/> Add dataset block to canvas</button>}<div className="resource-use"><label className="field-label">Use in note<select aria-label="Resource destination note" value={nodeId} disabled={busy} onChange={event => setNodeId(event.target.value)}><option value="">Choose a note…</option>{detail.project.canvas.nodes.filter(node=>node.kind!=='group').map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</select></label><button className="primary" disabled={busy || previewBusy || !preview || !nodeId} onClick={() => void useInNote()}>{busy ? <LoaderCircle size={14} className="spin"/> : <ArrowUpRight size={14}/>} Use in note</button></div>{!detail.project.canvas.nodes.length && <p className="resource-intro">Add a dataset block, or add a note to use this resource for research.</p>}
      {shown.artifactId && <button className="text-button" onClick={() => { const artifact = detail.artifacts.find(item => item.id === shown.artifactId); if (artifact) { setSelected(null); setPreview(null); onOpenArtifact(artifact, artifact.nodeId); } }}>Open full artifact & provenance <ArrowUpRight size={14}/></button>}</ResourceDialog>}
  </aside>;
}
