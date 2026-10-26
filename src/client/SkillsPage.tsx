import { useCallback, useEffect, useRef, useState } from 'react';
import { BookText, Check, ExternalLink, FileCode2, FileText, FolderOpen, LoaderCircle, MoreHorizontal, Plus, Search, SquareTerminal, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { SKILL_SOURCES, normalizeName, skillTitle, type FoundSkill, type SkillCandidate, type SkillDetail, type SkillFile, type SkillOrigin, type SkillPreview, type SkillPreviewRequest, type SkillSourceListing, type SkillSummary, type SkillsState } from '../shared/skills';
import { CatalogueHero, CatalogueRow } from './PluginsPage';
import { BrandLogo } from './brand-logos';
import { MarkdownEditor } from './MarkdownEditor';
import { Modal } from './Modal';
import { api, post } from './api';
import { readSaved, saveLocal } from './persistence';
import './skills.css';

/** Skills: the person's saved ways of working, in the SKILL.md format Claude Code and Codex use. One library;
 * every agent in ros.ai reads the skills that are on. Anything added from elsewhere is shown in full first. */

const fail = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
/** Reads that may reach GitHub or another site get longer than the usual 20 seconds. */
const slow = <T,>(path: string, body?: unknown) => api<T>(path, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000) });
const day = (value: string) => new Date(value).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });

/** Where a skill came from, in a few words. */
function from(origin: SkillOrigin): string {
  if (origin.kind === 'written') return 'Written in ros.ai';
  if (origin.kind === 'pasted') return 'Pasted into ros.ai';
  if (origin.kind === 'file') return `The file ${origin.filename}`;
  if (origin.kind === 'folder') return `${origin.tool}, ${origin.path}`;
  if (origin.kind === 'github') return `${origin.repo}${origin.path ? `/${origin.path}` : ''} at commit ${origin.commit.slice(0, 7)}`;
  if (origin.kind === 'link') return origin.url;
  return 'Put in the skills folder by hand';
}
/** The files of a skill in one line: all of them when there are few. */
function fileLine(files: SkillFile[], bytes: number) {
  const others = files.filter(file => file.path !== 'SKILL.md');
  const names = others.length <= 5 ? ['SKILL.md', ...others.map(file => file.path)].join(', ') : `SKILL.md and ${others.length} more files`;
  return `${names} (${size(bytes)})`;
}
/** The mark of the tool whose folder a skill was found in. */
function ToolMark({ tool }: { tool: string }) {
  if (tool === 'claude-code') return <BrandLogo id="claude" size={22}/>;
  if (tool === 'codex' || tool === 'agents') return <BrandLogo id="codex" size={22}/>;
  return tool === 'project' ? <FolderOpen size={18}/> : <SquareTerminal size={18} strokeWidth={1.75}/>;
}

type AddTab = 'write' | 'paste' | 'link' | 'file';
/** How the Add dialog opens: on a tab, or straight on the review of one skill (a row's +). */
type AddStart = { tab?: AddTab; request?: SkillPreviewRequest };

export function SkillsPage({ publicDemo, selected, onSelect, onSkills }: { publicDemo: boolean; selected: string | null; onSelect: (name: string | null) => void; onSkills: (skills: SkillSummary[]) => void }) {
  const [state, setState] = useState<SkillsState | null>(null), [found, setFound] = useState<FoundSkill[]>([]), [error, setError] = useState('');
  const [adding, setAdding] = useState<AddStart | null>(null), [notice, setNotice] = useState('');
  const refresh = useCallback(async () => {
    if (publicDemo) return;
    const [library, local] = await Promise.allSettled([api<SkillsState>('/api/skills'), api<{ found: FoundSkill[] }>('/api/skills/found')]);
    if (library.status === 'fulfilled') { setState(library.value); onSkills(library.value.skills); setError(''); } else setError(fail(library.reason));
    if (local.status === 'fulfilled') setFound(local.value.found);
  }, [publicDemo, onSkills]);
  useEffect(() => { void refresh(); }, [refresh]);
  if (publicDemo) return <p className="rail-page-note">This demo keeps no skills. Launch the local workspace to add yours.</p>;
  const skills = state?.skills ?? [];
  const added = (names: string[]) => {
    setAdding(null);
    setNotice(names.length === 1 ? `${skillTitle(names[0]!)} is in your skills. Agents can use it from your next request.` : `${names.length} skills are in your skills. Agents can use them from your next request.`);
    void refresh();
  };
  const dialog = adding && <AddSkillDialog start={adding} onClose={() => setAdding(null)} onAdded={added}/>;
  if (selected) return <>
    <SkillView key={selected} name={selected} onBack={() => onSelect(null)} onChanged={() => void refresh()} onRemoved={() => { onSelect(null); setNotice(`${skillTitle(selected)} was removed.`); void refresh(); }} onCheck={request => setAdding({ request })}/>
    {dialog}
  </>;
  return <div className="plugins-page skills-page">
    <header className="plugins-head"><div><h1>Skills</h1><p>Ways of working that your agents follow when a task matches. Every agent in ros.ai uses the same ones.</p></div><button type="button" className="primary small" onClick={() => setAdding({ tab: 'write' })}><Plus size={14}/> Add skill</button></header>
    {notice && <p className="connection-notice" role="status"><Check size={14}/>{notice}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <section className="plugin-group"><h2>Your skills</h2>
      {!state ? <p className="skills-empty"><LoaderCircle size={13} className="spin"/> Reading your skills…</p>
        : skills.length ? <div className="plugin-grid">{skills.map(skill => <CatalogueRow key={skill.name} mark={<BookText size={20}/>} name={skill.title} summary={skill.description} state={{ label: skill.enabled ? 'On' : 'Off', connected: skill.enabled, shown: true }} action={<MoreHorizontal size={16}/>} onClick={() => onSelect(skill.name)}/>)}</div>
        : <p className="skills-empty">No skills yet. Write one, or add one from your other tools or the lists below.</p>}
    </section>
    {found.length > 0 && <section className="plugin-group"><h2>On this computer</h2>
      <p className="skills-intro">Skills in the folders of Claude Code, Codex and your other agents. Add one to use it here too.</p>
      <div className="plugin-grid">{found.map(item => <CatalogueRow key={item.key} mark={<ToolMark tool={item.tool}/>} name={item.title} summary={`${item.toolLabel} · ${item.description}`} state={item.added === 'same' ? { label: 'Added', connected: true } : item.added === 'different' ? { label: 'Differs', connected: false, shown: true } : undefined} action={item.added === 'same' ? <Check size={16}/> : <Plus size={16}/>} onClick={() => setAdding({ request: { kind: 'found', key: item.key } })}/>)}</div>
    </section>}
    <SkillBrowse added={new Set(skills.map(skill => skill.name))} onPick={request => setAdding({ request })}/>
    <p className="plugins-footnote">Skills from elsewhere are shown in full before they are added. Agents can read a skill's scripts; ros.ai never runs them on your computer.</p>
    {dialog}
  </div>;
}

/** Curated public repositories of skills, read at their latest commit, with a search. */
function SkillBrowse({ added, onPick }: { added: Set<string>; onPick: (request: SkillPreviewRequest) => void }) {
  const [sourceId, setSourceId] = useState(() => { const saved = readSaved<string>('skills-source', SKILL_SOURCES[0]!.id); return SKILL_SOURCES.some(item => item.id === saved) ? saved : SKILL_SOURCES[0]!.id; });
  const [listings, setListings] = useState<Record<string, SkillSourceListing>>({}), [loading, setLoading] = useState(''), [error, setError] = useState(''), [query, setQuery] = useState(''), [all, setAll] = useState(false);
  const load = useCallback(async (id: string, again = false) => {
    setLoading(id); setError('');
    try { const listing = await slow<SkillSourceListing>(`/api/skills/sources/${id}${again ? '?refresh=1' : ''}`); setListings(current => ({ ...current, [id]: listing })); }
    catch (cause) { setError(fail(cause)); }
    finally { setLoading(current => current === id ? '' : current); }
  }, []);
  useEffect(() => { saveLocal('skills-source', sourceId); }, [sourceId]);
  const listing = listings[sourceId], source = SKILL_SOURCES.find(item => item.id === sourceId)!;
  useEffect(() => { if (!listing && loading !== sourceId && !error) void load(sourceId); }, [listing, loading, sourceId, error, load]);
  const words = query.trim().toLowerCase();
  const entries = (listing?.entries ?? []).filter(entry => !words || `${entry.name} ${entry.description}`.toLowerCase().includes(words));
  const shown = all || words ? entries : entries.slice(0, 12);
  return <section className="plugin-group skill-browse"><h2>Browse</h2>
    <div className="skill-browse-bar">
      <div className="skill-sources" role="tablist" aria-label="Where to browse">{SKILL_SOURCES.map(item => <button key={item.id} type="button" role="tab" aria-selected={item.id === sourceId} className={item.id === sourceId ? 'active' : ''} onClick={() => { setSourceId(item.id); setAll(false); setError(''); }}>{item.label}</button>)}</div>
      <label className="skill-search"><Search size={14}/><input type="search" placeholder="Search skills" aria-label="Search skills" value={query} onChange={event => setQuery(event.target.value)}/></label>
    </div>
    <p className="skills-intro">{source.about} <a href={`https://github.com/${source.repo}`} target="_blank" rel="noreferrer">{source.repo}<ExternalLink size={11}/></a></p>
    {error && <p className="inline-error" role="alert">{error} <button type="button" className="text-button" onClick={() => void load(sourceId, true)}>Try again</button></p>}
    {!listing ? loading === sourceId && <p className="skills-empty"><LoaderCircle size={13} className="spin"/> Reading {source.repo} on GitHub…</p> : <>
      <div className="plugin-grid">{shown.map(entry => <CatalogueRow key={`${entry.name}:${JSON.stringify(entry.request)}`} mark={<BookText size={20}/>} name={entry.title} summary={entry.description} state={added.has(entry.name) ? { label: 'Added', connected: true } : undefined} action={added.has(entry.name) ? <Check size={16}/> : <Plus size={16}/>} onClick={() => onPick(entry.request)}/>)}</div>
      {!entries.length && <p className="skills-empty">{words ? `No skill here matches “${query.trim()}”.` : 'This source lists no skills.'}</p>}
      <p className="skill-browse-foot">{shown.length < entries.length && <button type="button" className="text-button" onClick={() => setAll(true)}>Show all {entries.length}</button>}<button type="button" className="text-button" disabled={loading === sourceId} onClick={() => void load(sourceId, true)}>{loading === sourceId ? 'Checking…' : 'Check for new skills'}</button></p>
    </>}
  </section>;
}

const tabs: { id: AddTab; label: string }[] = [{ id: 'write', label: 'Write' }, { id: 'paste', label: 'Paste' }, { id: 'link', label: 'Link' }, { id: 'file', label: 'File' }];
const hasFrontmatter = (text: string) => /^﻿?---[ \t]*\r?\n/u.test(text);

/** Add a skill: write it here, or read it from pasted text, a link or a file, and see all of it before it is kept. */
function AddSkillDialog({ start, onClose, onAdded }: { start: AddStart; onClose: () => void; onAdded: (names: string[]) => void }) {
  const [tab, setTab] = useState<AddTab>(start.tab ?? 'link');
  const [name, setName] = useState(''), [description, setDescription] = useState(''), [body, setBody] = useState(''), [text, setText] = useState(''), [link, setLink] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [preview, setPreview] = useState<SkillPreview | null>(null), [chosen, setChosen] = useState<string[]>([]);
  // The list of skills found at a link, kept while one of them is reviewed, so Back returns to it.
  const [list, setList] = useState<SkillPreview | null>(null);
  const look = async (request: SkillPreviewRequest) => {
    setBusy(true); setError('');
    try {
      const result = await slow<SkillPreview>('/api/skills/preview', request);
      setPreview(result); setChosen(result.candidates.filter(item => item.existing !== 'same').map(item => item.name));
    } catch (cause) { setError(fail(cause)); }
    finally { setBusy(false); }
  };
  const started = useRef(false);
  useEffect(() => { if (start.request && !started.current) { started.current = true; void look(start.request); } }, [start.request]);
  const write = async () => {
    setBusy(true); setError('');
    try { const skill = await post<SkillDetail>('/api/skills', { name, description, body }); onAdded([skill.name]); }
    catch (cause) { setError(fail(cause)); setBusy(false); }
  };
  const candidates = preview?.candidates ?? [], choices = preview?.choices ?? [];
  const replacing = candidates.some(item => chosen.includes(item.name) && item.existing === 'different');
  const install = async () => {
    if (!preview?.draftId) return;
    setBusy(true); setError('');
    try { const result = await post<SkillsState & { added: string[] }>('/api/skills/install', { draftId: preview.draftId, names: chosen, replace: replacing }); onAdded(result.added); }
    catch (cause) { setError(fail(cause)); setBusy(false); }
  };
  const readFile = (file: File) => {
    if (file.size > 12 * 1024 * 1024) { setError('This file is larger than 12 MB.'); return; }
    const reader = new FileReader();
    reader.onload = () => void look({ kind: 'file', filename: file.name, data: String(reader.result).replace(/^data:[^,]*,/u, '') });
    reader.onerror = () => setError('This file could not be read.');
    reader.readAsDataURL(file);
  };
  const reviewing = candidates.length > 0, choosing = !reviewing && choices.length > 0, direct = Boolean(start.request);
  const back = () => { setError(''); if (reviewing && list) { setPreview(list); setList(null); } else setPreview(null); };
  const pasted = text.trim() && !hasFrontmatter(text.trim());
  const ready = tab === 'write' ? name.trim() && description.trim() && body.trim() : tab === 'paste' ? text.trim() && (!pasted || (name.trim() && description.trim())) : tab === 'link' ? link.trim() : false;
  const submit = () => { if (!ready || busy) return; if (tab === 'write') void write(); else if (tab === 'paste') void look({ kind: 'text', text, ...(pasted ? { name, description } : {}) }); else void look({ kind: 'link', url: link.trim() }); };
  const nameFields = <>
    <label className="field-label" htmlFor="skill-name">Name</label>
    <input id="skill-name" value={name} maxLength={64} placeholder="Literature review" onChange={event => setName(event.target.value)} autoFocus/>
    {name.trim() && <p className="skill-call">You call it with <code>/{normalizeName(name)}</code></p>}
    <label className="field-label" htmlFor="skill-when">When agents use it</label>
    <textarea id="skill-when" rows={2} maxLength={1024} value={description} placeholder="Find and summarise papers on a question, with citations. Use when I ask what the research says." onChange={event => setDescription(event.target.value)}/>
  </>;
  const all = candidates.every(item => item.existing === 'same');
  return <Modal title={reviewing ? candidates.length === 1 ? `Add ${candidates[0]!.title}?` : `Add ${candidates.length} skills?` : choosing ? 'Choose a skill' : 'Add a skill'} className="skill-modal" onClose={onClose}>
    {!reviewing && !choosing && (direct ? busy && <p className="skills-empty"><LoaderCircle size={13} className="spin"/> Reading the skill…</p> : <form id="skill-add" onSubmit={event => { event.preventDefault(); submit(); }}>
      <div className="skill-tabs" role="tablist" aria-label="How to add it">{tabs.map(item => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => { setTab(item.id); setError(''); }}>{item.label}</button>)}</div>
      {tab === 'write' && <>{nameFields}<label className="field-label" htmlFor="skill-body">Instructions</label><textarea id="skill-body" rows={9} value={body} placeholder={'Steps, rules and examples, in Markdown.\n\n1. Restate the question in one line.\n2. …'} onChange={event => setBody(event.target.value)}/></>}
      {tab === 'paste' && <><label className="field-label" htmlFor="skill-text">A SKILL.md, or any instructions</label><textarea id="skill-text" className="skill-code" rows={10} value={text} placeholder={'---\nname: literature-review\ndescription: Find and summarise papers on a question…\n---\n\n# Steps'} onChange={event => setText(event.target.value)} autoFocus/>{pasted && nameFields}</>}
      {tab === 'link' && <><label className="field-label" htmlFor="skill-link">Link</label><input id="skill-link" value={link} placeholder="GitHub link, owner/repo, or a site address" onChange={event => setLink(event.target.value)} autoFocus/></>}
      {tab === 'file' && <label className="skill-drop" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) readFile(file); }}>
        <input type="file" accept=".md,.markdown,.zip,.skill" onChange={event => { const file = event.target.files?.[0]; if (file) readFile(file); event.target.value = ''; }}/>
        {busy ? <LoaderCircle size={18} className="spin"/> : <Upload size={18}/>}<span>Choose or drop a SKILL.md, .zip or .skill file</span>
      </label>}
    </form>)}
    {choosing && <>
      <p className="modal-description">{preview?.note} Choose one to see it in full.</p>
      <div className="skill-choices">{choices.map(choice => <button key={JSON.stringify(choice.request)} type="button" className="plugin-row" disabled={busy} onClick={() => { setList(preview); void look(choice.request); }}><span className="plugin-row-mark"><BookText size={20}/></span><span className="plugin-row-text"><strong>{choice.title}</strong><small>{choice.description}</small></span><span className="plugin-row-action"><Plus size={16}/></span></button>)}</div>
    </>}
    {reviewing && candidates.map(candidate => <CandidateReview key={candidate.name} candidate={candidate} many={candidates.length > 1} chosen={chosen.includes(candidate.name)} onChoose={on => setChosen(current => on ? [...current, candidate.name] : current.filter(item => item !== candidate.name))}/>)}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="modal-actions">
      {(reviewing || choosing) && (!direct || list) ? <button type="button" className="secondary" disabled={busy} onClick={back}>Back</button> : <button type="button" className="secondary" onClick={onClose}>Cancel</button>}
      {reviewing ? all ? <button type="button" className="primary" onClick={onClose}>Done</button> : <button type="button" className="primary" disabled={busy || !chosen.length} onClick={() => void install()}>{busy ? <LoaderCircle size={14} className="spin"/> : <Check size={14}/>} {replacing ? 'Replace' : chosen.length > 1 ? `Add ${chosen.length} skills` : 'Add skill'}</button>
        : !choosing && !direct && tab !== 'file' && <button type="submit" form="skill-add" className="primary" disabled={busy || !ready}>{busy ? <LoaderCircle size={14} className="spin"/> : tab === 'write' ? <Plus size={14}/> : <Search size={14}/>} {tab === 'write' ? 'Add skill' : tab === 'paste' ? 'Review' : 'Look up'}</button>}
    </div>
  </Modal>;
}

/** One skill as read from elsewhere: what it says it does, where it is from, its files, anything to know, and its SKILL.md in full. */
function CandidateReview({ candidate, many, chosen, onChoose }: { candidate: SkillCandidate; many: boolean; chosen: boolean; onChoose: (on: boolean) => void }) {
  return <article className="skill-review">
    <header>
      {many && <input type="checkbox" checked={chosen} disabled={candidate.existing === 'same'} onChange={event => onChoose(event.target.checked)} aria-label={`Add ${candidate.title}`}/>}
      <span className="plugin-row-mark"><BookText size={18}/></span>
      <div><strong>{candidate.title}</strong><code>/{candidate.name}</code></div>
    </header>
    <p>{candidate.description}</p>
    <dl>
      <dt>From</dt><dd>{from(candidate.origin)}</dd>
      {candidate.license && <><dt>Licence</dt><dd>{candidate.license}</dd></>}
      <dt>Files</dt><dd>{fileLine(candidate.files, candidate.bytes)}</dd>
    </dl>
    {candidate.existing && <p className="skill-note">{candidate.existing === 'same' ? 'You have this skill already, with the same files.' : 'You have a different version of this skill. Adding this one replaces it.'}</p>}
    {candidate.warnings.map(warning => <p key={warning} className="skill-warning"><TriangleAlert size={13}/>{warning}</p>)}
    <details open={!many}><summary>SKILL.md</summary><pre className="skill-source-text">{candidate.skillMd}</pre></details>
  </article>;
}

/** One skill's page: on or off, when agents use it, its instructions (edited in place and saved as you type), its files and where it came from. */
function SkillView({ name, onBack, onChanged, onRemoved, onCheck }: { name: string; onBack: () => void; onChanged: () => void; onRemoved: () => void; onCheck: (request: SkillPreviewRequest) => void }) {
  const [skill, setSkill] = useState<SkillDetail | null>(null), [error, setError] = useState(''), [menu, setMenu] = useState(false), [removing, setRemoving] = useState(false), [file, setFile] = useState<{ path: string; text?: string; bytes: number } | null>(null);
  const [description, setDescription] = useState(''), [body, setBody] = useState('');
  const sent = useRef({ description: '', body: '' }), latest = useRef({ description, body }); latest.current = { description, body };
  useEffect(() => {
    let live = true;
    api<SkillDetail>(`/api/skills/skill/${name}`).then(value => { if (!live) return; setSkill(value); setDescription(value.description); setBody(value.body); sent.current = { description: value.description, body: value.body }; }, cause => { if (live) setError(fail(cause)); });
    return () => { live = false; };
  }, [name]);
  const change = async (patch: { enabled?: boolean; description?: string; body?: string }) => {
    try { const value = await api<SkillDetail>(`/api/skills/skill/${name}`, { method: 'PUT', body: JSON.stringify(patch) }); setSkill(value); setError(''); onChanged(); }
    catch (cause) { setError(fail(cause)); }
  };
  // Text saves itself shortly after typing stops and when you leave it, as a block's text does.
  const save = useRef(() => {}); save.current = () => {
    const { description: when, body: text } = latest.current, patch: { description?: string; body?: string } = {};
    if (when.trim() && when !== sent.current.description) patch.description = when;
    if (text !== sent.current.body) patch.body = text;
    if (!Object.keys(patch).length) return;
    sent.current = { description: patch.description ?? sent.current.description, body: patch.body ?? sent.current.body };
    void change(patch);
  };
  useEffect(() => { if (!skill) return; const timer = setTimeout(() => save.current(), 700); return () => clearTimeout(timer); }, [body, skill]);
  useEffect(() => () => save.current(), []);
  const open = async (path: string) => { try { setFile(await api(`/api/skills/skill/${name}/file?path=${encodeURIComponent(path)}`)); } catch (cause) { setError(fail(cause)); } };
  const finder = async () => { setMenu(false); try { await post('/api/skills/open', { name }); } catch (cause) { setError(fail(cause)); } };
  const remove = async () => { try { await api(`/api/skills/skill/${name}`, { method: 'DELETE' }); setRemoving(false); onRemoved(); } catch (cause) { setRemoving(false); setError(fail(cause)); } };
  if (!skill) return <div className="plugins-page plugin-detail">{error ? <><p className="inline-error" role="alert">{error}</p><button type="button" className="text-button" onClick={onBack}>Back to skills</button></> : <p className="skills-empty"><LoaderCircle size={13} className="spin"/> Opening the skill…</p>}</div>;
  const others = skill.fileList.filter(item => item.path !== 'SKILL.md');
  const origin = skill.origin;
  return <div className="plugins-page plugin-detail skill-page">
    <CatalogueHero crumb="Skills" onBack={onBack} mark={<BookText size={30}/>} name={skill.title}
      summary={<textarea className="skill-description" aria-label="When agents use this skill" rows={2} maxLength={1024} value={description} onChange={event => setDescription(event.target.value)} onBlur={() => save.current()} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}/>}
      action={<div className="skill-hero-actions">
        <button type="button" role="switch" aria-checked={skill.enabled} className="skill-toggle" onClick={() => void change({ enabled: !skill.enabled })}><span className={`ros-switch ${skill.enabled ? 'on' : ''}`} aria-hidden="true"/>{skill.enabled ? 'On' : 'Off'}</button>
        <span className="skill-more"><button type="button" className="icon-button" aria-label="More" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={16}/></button>
          {menu && <div className="project-menu skill-menu-more"><button type="button" onClick={() => void finder()}><FolderOpen size={14}/> Show in Finder</button><button type="button" className="danger" onClick={() => { setMenu(false); setRemoving(true); }}><Trash2 size={14}/> Remove skill…</button></div>}</span>
      </div>}/>
    <p className="skill-call">{skill.automatic ? <>Agents use it when a task matches, or when you start a request with <code>/{skill.name}</code>.</> : <>Agents use it only when you start a request with <code>/{skill.name}</code>.</>}</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <h2 className="plugin-section">Instructions</h2>
    <div className="skill-instructions"><MarkdownEditor value={body} onChange={setBody} onBlur={() => save.current()} ariaLabel="Skill instructions" placeholder="Write the steps agents follow…"/></div>
    {others.length > 0 && <><h2 className="plugin-section">Files</h2>
      <ul className="skill-files">{others.map(item => <li key={item.path}><button type="button" onClick={() => void open(item.path)}>{item.kind === 'script' ? <FileCode2 size={14}/> : <FileText size={14}/>}<span>{item.path}</span><small>{item.kind === 'script' ? 'Agents can read it; ros.ai does not run it · ' : ''}{size(item.bytes)}</small></button></li>)}</ul>
    </>}
    <h2 className="plugin-section">Source</h2>
    <p className="skill-source">{from(origin)}, added {day(skill.addedAt)}.{skill.license ? ` Licence: ${skill.license}.` : ''}{origin.kind === 'github' && <> <button type="button" className="text-button" onClick={() => onCheck({ kind: 'github', repo: origin.repo, path: origin.path })}>Check for a newer version</button></>}</p>
    {skill.warnings.map(warning => <p key={warning} className="skill-warning"><TriangleAlert size={13}/>{warning}</p>)}
    {file && <Modal title={file.path} className="skill-modal" onClose={() => setFile(null)}>{file.text === undefined ? <p className="modal-description">This file is not text ({size(file.bytes)}), so it cannot be shown here.</p> : <pre className="skill-source-text tall">{file.text}</pre>}</Modal>}
    {removing && <Modal title="Remove this skill?" onClose={() => setRemoving(false)}><p className="modal-description"><strong>{skill.title}</strong> and its files leave ros.ai's skill folder. Copies in other tools stay where they are.</p><div className="modal-actions"><button type="button" className="secondary" onClick={() => setRemoving(false)}>Keep skill</button><button type="button" className="primary danger-primary" onClick={() => void remove()}><Trash2 size={15}/> Remove skill</button></div></Modal>}
  </div>;
}
