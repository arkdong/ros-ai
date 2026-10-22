import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight, Check, LoaderCircle, Plus, X } from 'lucide-react';
import type { NotionEdit, NotionPage, NotionProperty, NotionUnit } from '../shared/types';
import { api } from './api';
import { RichText } from './Content';

/** A Notion page laid out as Notion lays it out: the title, every field as a row, a line, then the text.
 * A field or a block of text edits in place and is saved straight to Notion; the page is then read again. */
export function NotionPageEditor({ page, projectId, nodeId, readOnly, onSaved, onTitle }: { page: NotionPage; projectId: string; nodeId: string; readOnly?: boolean; onSaved: (page: NotionPage) => void; onTitle?: (title: string) => void }) {
  const save = async (edit: NotionEdit) => {
    const saved = await api<NotionPage>(`/api/projects/${projectId}/nodes/${nodeId}/notion/edit`, { method: 'POST', body: JSON.stringify(edit), signal: AbortSignal.timeout(90_000) });
    onSaved(saved);
    if (edit.kind === 'title') onTitle?.(saved.title);
    return saved;
  };
  const fields = page.properties.filter(property => property.type !== 'title');
  return <div className="notion-page">
    <TitleField page={page} readOnly={readOnly} onSave={title => save({ kind: 'title', title })}/>
    {fields.length > 0 && <dl className="notion-page-fields">{fields.map(property => <PropertyRow key={property.name} property={property} readOnly={readOnly} onSave={(value, end) => save({ kind: 'property', name: property.name, value, ...(end !== undefined ? { end } : {}) })}/>)}</dl>}
    <div className="notion-page-text">
      {page.units.map((unit, index) => <UnitBlock key={`${index}:${unit.source ?? unit.markdown}`} unit={unit} readOnly={readOnly} onSave={text => save({ kind: 'text', old: unit.source!, new: text })}/>)}
      {!page.units.length && readOnly && <p className="notion-page-empty">An empty page.</p>}
      {!readOnly && <AppendBlock onSave={text => save({ kind: 'append', text })}/>}
    </div>
  </div>;
}

/** The outcome of one save, shown on its row for a moment. */
function useSaving() {
  const [state, setState] = useState<{ busy?: boolean; saved?: boolean; error?: string }>({});
  useEffect(() => { if (!state.saved) return; const timer = setTimeout(() => setState({}), 2500); return () => clearTimeout(timer); }, [state.saved]);
  const run = async (action: () => Promise<unknown>) => {
    setState({ busy: true });
    try { await action(); setState({ saved: true }); return true; }
    catch (reason) { setState({ error: reason instanceof Error ? reason.message : String(reason) }); return false; }
  };
  return { state, run, clear: () => setState({}) };
}
const Status = ({ state }: { state: ReturnType<typeof useSaving>['state'] }) => state.busy ? <span className="notion-page-status"><LoaderCircle size={12} className="spin"/></span>
  : state.saved ? <span className="notion-page-status saved"><Check size={12}/> Saved in Notion</span>
  : state.error ? <span className="notion-page-status error" title={state.error}>{state.error}</span> : null;

function TitleField({ page, readOnly, onSave }: { page: NotionPage; readOnly?: boolean; onSave: (title: string) => Promise<unknown> }) {
  const [title, setTitle] = useState(page.title); const saving = useSaving();
  useEffect(() => setTitle(page.title), [page.title]);
  const commit = async () => { if (title.trim() === page.title || readOnly) { setTitle(page.title); return; } if (!(await saving.run(() => onSave(title)))) setTitle(page.title); };
  return <div className="notion-page-title-row">
    {page.icon && <span className="notion-page-icon" aria-hidden="true">{page.icon}</span>}
    <input className="notion-page-title" aria-label="Page title" value={title} readOnly={readOnly} maxLength={2000} onChange={event => setTitle(event.target.value)} onBlur={() => void commit()} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { setTitle(page.title); event.currentTarget.blur(); } }}/>
    <Status state={saving.state}/>
  </div>;
}

const typeMark: Record<NotionProperty['type'], string> = { title: 'Aa', text: '≡', select: '◦', multi_select: '⁝', checkbox: '☑', date: '▦', number: '#', people: '◉', relation: '↗', files: '⎘', computed: 'ƒ' };

function PropertyRow({ property, readOnly, onSave }: { property: NotionProperty; readOnly?: boolean; onSave: (value: string | number | boolean | string[] | null, end?: string | null) => Promise<unknown> }) {
  const saving = useSaving();
  const editable = property.editable && !readOnly;
  const commit = (value: string | number | boolean | string[] | null, end?: string | null) => saving.run(() => onSave(value, end));
  return <div className={`notion-page-field${editable ? '' : ' fixed'}`}>
    <dt title={property.name}><i aria-hidden="true">{typeMark[property.type]}</i>{property.name}</dt>
    <dd title={editable ? undefined : 'Set in Notion'}>
      {!editable ? <Shown property={property}/>
        : property.type === 'select' ? <select className="notion-page-select" aria-label={property.name} value={property.value} onChange={event => void commit(event.target.value || null)}>
            <option value="">Empty</option>{[...new Set([...(property.options ?? []), ...(property.value ? [property.value] : [])])].map(option => <option key={option} value={option}>{option}</option>)}</select>
        : property.type === 'multi_select' ? <Chips property={property} onChange={values => void commit(values)}/>
        : property.type === 'checkbox' ? <input type="checkbox" aria-label={property.name} checked={property.value === 'Yes'} onChange={event => void commit(event.target.checked)}/>
        : property.type === 'date' ? <DateField property={property} onChange={(start, end) => void commit(start, end)}/>
        : property.type === 'number' ? <TextField value={property.value} kind="number" label={property.name} onCommit={value => commit(value === '' ? null : Number(value))}/>
        : <TextField value={property.value} label={property.name} onCommit={value => commit(value)}/>}
      <Status state={saving.state}/>
    </dd>
  </div>;
}

/** A value that is only shown: people, relations, files and what Notion computes. */
function Shown({ property }: { property: NotionProperty }) {
  if (property.links?.length) return <>{property.links.map((link, index) => <a key={index} href={link.url} target="_blank" rel="noreferrer" onClick={event => event.stopPropagation()}>{link.text}<ArrowUpRight size={10}/></a>)}</>;
  if (property.type === 'multi_select' && property.values?.length) return <>{property.values.map(value => <span key={value} className="notion-chip">{value}</span>)}</>;
  if (!property.value) return <span className="notion-page-blank">Empty</span>;
  return <span className="notion-page-value">{property.value}</span>;
}

/** Text that saves when you leave it or press Enter; Escape puts the old value back. */
function TextField({ value, kind, label, onCommit }: { value: string; kind?: 'number'; label: string; onCommit: (value: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(value); const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => { const element = ref.current; if (element) { element.style.height = '0'; element.style.height = `${element.scrollHeight}px`; } }, [draft]);
  const commit = async () => { if (draft === value) return; if (!(await onCommit(draft.trim()))) setDraft(value); };
  const keys = (event: KeyboardEvent<HTMLElement>) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { setDraft(value); event.currentTarget.blur(); } };
  if (kind === 'number') return <input className="notion-page-input" type="number" step="any" aria-label={label} value={draft} placeholder="Empty" onChange={event => setDraft(event.target.value)} onBlur={() => void commit()} onKeyDown={keys}/>;
  return <textarea ref={ref} className="notion-page-input" rows={1} aria-label={label} value={draft} placeholder="Empty" onChange={event => setDraft(event.target.value)} onBlur={() => void commit()} onKeyDown={keys}/>;
}

function Chips({ property, onChange }: { property: NotionProperty; onChange: (values: string[]) => void }) {
  const chosen = property.values ?? (property.value ? property.value.split(', ') : []);
  const rest = (property.options ?? []).filter(option => !chosen.includes(option));
  return <>
    {chosen.map(value => <span key={value} className="notion-chip">{value}<button type="button" aria-label={`Remove ${value}`} onClick={() => onChange(chosen.filter(item => item !== value))}><X size={10}/></button></span>)}
    {rest.length > 0 && <select className="notion-page-select add" aria-label={`Add to ${property.name}`} value="" onChange={event => { if (event.target.value) onChange([...chosen, event.target.value]); }}><option value="">+</option>{rest.map(option => <option key={option} value={option}>{option}</option>)}</select>}
  </>;
}

function DateField({ property, onChange }: { property: NotionProperty; onChange: (start: string | null, end: string | null) => void }) {
  const start = property.date?.start ?? '', end = property.date?.end ?? '';
  const [withEnd, setWithEnd] = useState(Boolean(end));
  useEffect(() => { if (end) setWithEnd(true); }, [end]);
  return <>
    <input className="notion-page-input date" type="date" aria-label={property.name} value={start} onChange={event => onChange(event.target.value || null, event.target.value ? end || null : null)}/>
    {withEnd ? <><span className="notion-page-blank">to</span><input className="notion-page-input date" type="date" aria-label={`${property.name} end`} value={end} onChange={event => onChange(start || null, event.target.value || null)}/></>
      : start ? <button type="button" className="text-button small notion-page-end" onClick={() => setWithEnd(true)}>+ end</button> : null}
  </>;
}

/** One block of the page's text: click to edit the words; Enter or leaving saves, Escape cancels. */
function UnitBlock({ unit, readOnly, onSave }: { unit: NotionUnit; readOnly?: boolean; onSave: (text: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(unit.text ?? ''); const saving = useSaving(); const ref = useRef<HTMLTextAreaElement>(null);
  const editable = Boolean(unit.source) && !readOnly;
  useEffect(() => { if (editing && ref.current) { ref.current.style.height = '0'; ref.current.style.height = `${ref.current.scrollHeight}px`; ref.current.focus(); } }, [editing, draft]);
  const commit = async () => { setEditing(false); if (draft.trim() === unit.text || !draft.trim()) { setDraft(unit.text ?? ''); return; } if (!(await saving.run(() => onSave(draft.trim())))) setDraft(unit.text ?? ''); };
  if (editing) return <div className="notion-unit editing"><textarea ref={ref} aria-label="Edit this text" rows={1} value={draft} onChange={event => setDraft(event.target.value)} onBlur={() => void commit()} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { setDraft(unit.text ?? ''); setEditing(false); } }}/></div>;
  return <div className={`notion-unit${editable ? ' editable' : ''}`} title={editable ? 'Click to edit; saved in Notion' : undefined} role={editable ? 'button' : undefined} tabIndex={editable ? 0 : undefined} onClick={event => { if (editable && !(event.target as HTMLElement).closest('a')) setEditing(true); }} onKeyDown={event => { if (editable && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setEditing(true); } }}>
    <RichText text={unit.markdown}/><Status state={saving.state}/>
  </div>;
}

function AppendBlock({ onSave }: { onSave: (text: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(''); const saving = useSaving();
  const commit = async () => { setEditing(false); if (!draft.trim()) { setDraft(''); return; } if (await saving.run(() => onSave(draft.trim()))) setDraft(''); };
  if (editing) return <div className="notion-unit editing"><textarea autoFocus aria-label="New paragraph" rows={2} value={draft} placeholder="Write, then press Enter" onChange={event => setDraft(event.target.value)} onBlur={() => void commit()} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { setDraft(''); setEditing(false); } }}/></div>;
  return <div className="notion-page-add"><button type="button" className="text-button small" onClick={() => setEditing(true)}><Plus size={12}/> Add a paragraph</button><Status state={saving.state}/></div>;
}
