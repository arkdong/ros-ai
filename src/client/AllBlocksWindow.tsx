import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Play, Search, X } from 'lucide-react';
import { Modal } from './Modal';
import { PaperSearch } from './PaperSearch';
import { KindPreview, PREVIEW_FRAMES, usePreviewLoop } from './KindPreview';
import { KIND_GROUPS, blockKind, searchKinds, type BlockKind, type KindId } from './block-kinds';
import { TEXT_LABELS, sentence } from '../shared/vocabulary';
import type { MetricInput, MetricSource, NotionView, TrainingView } from '../shared/types';
import { ChipChoice } from './ChipChoice';
import { BrandLogo } from './brand-logos';
import { Cloud } from 'lucide-react';
import type { PaperSummary } from '../shared/papers';
import './chip-menu.css';
import './all-blocks.css';

/** Where a Metrics block can read, and what each needs first. */
const METRIC_SOURCES: { id: MetricSource; label: string; detail: string; needs: string }[] = [
  { id: 'cloud', label: 'ros.ai cloud', detail: 'Accounts, sign-ups, downloads, feedback', needs: 'Reads with your ros.ai cloud sign-in (Agents › ROS). The server must list your email in ROS_CLOUD_STATS_EMAILS.' },
  { id: 'github', label: 'GitHub', detail: 'Stars, release downloads, visitors', needs: 'Visitors and cloners need GitHub connected on the Plugins page, with push access to the repository.' },
  { id: 'umami', label: 'Umami', detail: 'Website visitors, clicks and downloads', needs: 'Needs Umami connected on the Plugins page with an API key. Leave the website empty when the key reaches only one.' },
  { id: 'railway', label: 'Railway', detail: 'Whether each service is up', needs: 'Needs Railway connected on the Plugins page with an account token. Leave the project empty when the token reaches only one.' },
];
export type AddOptions = { title: string; scope: string | null; label?: string; file?: File; notion?: NotionView; googleLink?: string; training?: TrainingView; metric?: MetricInput };
type Props = { initial?: KindId; scope: string | null; groups: { id: string; title: string }[]; folder: boolean; local: boolean; onClose: () => void; onCreate: (kind: BlockKind, options: AddOptions) => Promise<void>; onPaper: (scope: string | null, paperId: string) => Promise<void> };

/** All blocks: every kind in three groups, a search over them, and the chosen kind shown as it looks on the map with
 *  what it does and what it needs. A kind that needs a file, a link or a paper asks for it here. Enter adds. */
export function AllBlocksWindow({ initial, scope, groups, folder, local, onClose, onCreate, onPaper }: Props) {
  const [query, setQuery] = useState(''), [selected, setSelected] = useState<KindId>(initial ?? 'text'), [busy, setBusy] = useState(false), [menu, setMenu] = useState<'label' | 'where' | null>(null);
  const [title, setTitle] = useState(''), [label, setLabel] = useState(''), [where, setWhere] = useState<string | null>(scope);
  const [file, setFile] = useState<File | null>(null), [paper, setPaper] = useState<PaperSummary | null>(null);
  const [notionUrl, setNotionUrl] = useState(''), [notionFilter, setNotionFilter] = useState(''), [googleUrl, setGoogleUrl] = useState(''), [trainingFolder, setTrainingFolder] = useState('~/code/ros-nemotron-run'), [trainingHost, setTrainingHost] = useState(''), [metricSource, setMetricSource] = useState<MetricSource>('cloud'), [metricRepo, setMetricRepo] = useState('arkdong/ros-ai'), [metricId, setMetricId] = useState('');
  const [resting, setResting] = useState(false), rest = useRef<number | null>(null), foot = useRef<HTMLDivElement>(null);
  const kinds = searchKinds(query, local), kind = blockKind(selected), frames = PREVIEW_FRAMES[selected], frame = usePreviewLoop(selected, resting);
  const text = kind.id === 'text', papers = kind.id === 'paper';
  const ready = papers ? Boolean(paper) : kind.id === 'file' ? Boolean(file) : kind.id === 'notion' ? Boolean(notionUrl.trim()) : kind.id === 'google' ? Boolean(googleUrl.trim()) : kind.id === 'training' ? Boolean(trainingFolder.trim()) : kind.id === 'metric' ? metricSource !== 'github' || Boolean(metricRepo.trim()) : true;
  useEffect(() => { if (kinds.length && !kinds.some(item => item.id === selected)) setSelected(kinds[0].id); }, [query]);
  useEffect(() => {
    if (!menu) return;
    const away = (event: PointerEvent) => { if (!foot.current?.contains(event.target as Node)) setMenu(null); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [menu]);
  const pick = (id: KindId) => { setSelected(id); setPaper(null); setFile(null); setMenu(null); };
  const move = (step: number) => { const index = kinds.findIndex(item => item.id === selected); const next = kinds[Math.min(Math.max(index + step, 0), kinds.length - 1)]; if (next) pick(next.id); };
  const add = async () => {
    if (busy || !ready) return;
    setBusy(true);
    try {
      if (papers) await onPaper(where, paper!.id);
      else await onCreate(kind, { title: title.trim(), scope: where, label: text && label ? label : undefined, file: kind.id === 'notebook' || kind.id === 'file' ? file ?? undefined : undefined, notion: kind.id === 'notion' ? { url: notionUrl.trim(), ...(notionFilter.trim() ? { filter: notionFilter.trim() } : {}) } : undefined, googleLink: kind.id === 'google' ? googleUrl.trim() : undefined, training: kind.id === 'training' ? { folder: trainingFolder.trim(), ...(trainingHost.trim() ? { host: trainingHost.trim() } : {}) } : undefined, metric: kind.id === 'metric' ? { source: metricSource, ...(metricSource === 'github' ? { repo: metricRepo.trim() } : metricSource === 'umami' ? { website: metricId.trim() } : metricSource === 'railway' ? { project: metricId.trim() } : {}) } : undefined });
    } finally { setBusy(false); }
  };
  const adding = papers && paper?.pdf && folder ? 'Saving the PDF…' : kind.id === 'notion' ? 'Reading Notion…' : kind.id === 'google' ? 'Reading Google…' : kind.id === 'training' ? 'Reading the run…' : kind.id === 'metric' ? 'Reading the numbers…' : kind.id === 'file' ? 'Saving…' : 'Adding…';
  const whereTitle = where ? groups.find(group => group.id === where)?.title ?? 'nearest free spot' : 'nearest free spot';
  return <Modal title="All blocks" className="all-blocks-modal" bare onClose={onClose}>
    <form className="ab-form" onSubmit={event => { event.preventDefault(); void add(); }} onKeyDown={event => { if (event.key === 'Escape' && menu) { event.preventDefault(); event.stopPropagation(); setMenu(null); } }}>
      <label className="ab-search"><Search size={16}/><input value={query} placeholder="Search blocks" aria-label="Search blocks" data-autofocus maxLength={80} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); move(1); } else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); } }}/><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={16}/></button></label>
      <div className="ab-body">
        <div className="ab-list" role="listbox" aria-label="Kinds of block">
          {KIND_GROUPS.map(group => { const items = kinds.filter(item => item.group === group); return items.length ? <div key={group} className="ab-group"><p>{group}</p>{items.map(item => <button key={item.id} type="button" role="option" aria-selected={item.id === selected} className="ab-row" onClick={() => pick(item.id)}>{item.icon(14)}<span>{item.name}</span><span className="ab-cap">{item.caption}</span></button>)}</div> : null; })}
          {!kinds.length && <p className="ab-none">No block matches. ROS adds blocks too: ask in the bar.</p>}
          {!query.trim() && <div className="ab-row ab-dim" aria-disabled="true"><span className="ab-plug"/><span>Plugins add their kinds here</span></div>}
        </div>
        <div className="ab-detail">
          <div className="ab-swatch" onPointerEnter={() => { if (rest.current) clearTimeout(rest.current); rest.current = window.setTimeout(() => setResting(true), 600); }} onPointerLeave={() => { if (rest.current) clearTimeout(rest.current); setResting(false); }}>
            <KindPreview kind={selected} frame={frame}/>
            {frames && <span className="ros-chip ab-loop"><Play size={11}/>{frame === null ? 'Loop · 3 s' : `${frame + 1} · ${frames[frame]}`}</span>}
          </div>
          <div className="ab-title"><b>{kind.name}</b><span>{kind.caption}</span></div>
          <p className="ab-line">{kind.line}</p>
          <div className="ab-chips"><span className="ros-chip dark">{kind.needs === 'Nothing' && <span className="chip-dot"/>}{kind.needs}</span>{kind.facts.map(fact => <span key={fact} className="ros-chip">{fact}</span>)}</div>
          <div className="ab-fields">
            {papers ? <PaperSearch chosen={paper} onChoose={setPaper} disabled={busy}/> : <label className="ab-field"><span>Name <small>optional</small></span><input id="ab-title" value={title} maxLength={200} placeholder={file && (kind.id === 'notebook' || kind.id === 'file') ? file.name.replace(/\.[^.]+$/u, '') : text && label ? label[0].toUpperCase() + label.slice(1) : kind.name} disabled={busy} onChange={event => setTitle(event.target.value)}/></label>}
            {kind.id === 'notebook' && <label className="ab-field"><span>Start from a Jupyter notebook <small>optional .ipynb</small></span><input id="ab-notebook-file" type="file" accept=".ipynb,application/x-ipynb+json" disabled={busy} onChange={event => setFile(event.target.files?.[0] ?? null)}/></label>}
            {kind.id === 'file' && <label className="ab-field"><span>File</span><input id="ab-file" type="file" required accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,application/pdf,image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={event => setFile(event.target.files?.[0] ?? null)}/></label>}
            {kind.id === 'notion' && <><label className="ab-field"><span>Notion page or database link</span><input id="ab-notion-url" type="url" required value={notionUrl} maxLength={500} placeholder="https://www.notion.so/…" disabled={busy} onChange={event => setNotionUrl(event.target.value)}/></label><label className="ab-field"><span>For a database, only rows where <small>optional</small></span><input id="ab-notion-filter" value={notionFilter} maxLength={1000} placeholder={'"Teams" LIKE \'%Research%\''} disabled={busy} onChange={event => setNotionFilter(event.target.value)}/></label></>}
            {kind.id === 'google' && <label className="ab-field"><span>Google Sheet or Doc link</span><input id="ab-google-url" type="url" required value={googleUrl} maxLength={1000} placeholder="https://docs.google.com/…" disabled={busy} onChange={event => setGoogleUrl(event.target.value)}/></label>}
            {kind.id === 'training' && <><label className="ab-field"><span>Run folder on this computer</span><input id="ab-training-folder" required value={trainingFolder} maxLength={1000} placeholder="~/code/ros-nemotron-run" disabled={busy} onChange={event => setTrainingFolder(event.target.value)}/></label><label className="ab-field"><span>GPU machine <small>optional ssh host</small></span><input id="ab-training-host" value={trainingHost} maxLength={200} placeholder="nebius-h100" disabled={busy} onChange={event => setTrainingHost(event.target.value)}/></label></>}
            {kind.id === 'metric' && <>
              <div className="ab-field"><span>Read from</span><ChipChoice label="Read from" value={metricSource} disabled={busy} options={METRIC_SOURCES.map(item => ({ id: item.id, label: item.label, detail: item.detail, icon: item.id === 'cloud' ? <Cloud size={13}/> : <BrandLogo id={item.id} size={13}/> }))} onChange={value => { setMetricSource(value); setMetricId(''); }}/></div>
              {metricSource === 'github' && <label className="ab-field"><span>GitHub repository</span><input id="ab-metric-repo" required value={metricRepo} maxLength={300} placeholder="owner/name or its link" disabled={busy} onChange={event => setMetricRepo(event.target.value)}/></label>}
              {metricSource === 'umami' && <label className="ab-field"><span>Umami website <small>its domain, ID or link</small></span><input id="ab-metric-id" value={metricId} maxLength={300} placeholder="ros-ai.io" disabled={busy} onChange={event => setMetricId(event.target.value)}/></label>}
              {metricSource === 'railway' && <label className="ab-field"><span>Railway project <small>its name, ID or link</small></span><input id="ab-metric-id" value={metricId} maxLength={300} placeholder="Project name" disabled={busy} onChange={event => setMetricId(event.target.value)}/></label>}
              <p className="ab-note">{METRIC_SOURCES.find(item => item.id === metricSource)!.needs}</p>
            </>}
            {papers && <p className="ab-note">{folder ? 'Its open PDF, when there is one, is saved into files/ as a File block agents read. Otherwise a Text block holds the reference.' : 'This project has no folder, so the paper becomes a Text block with its reference. Choose a folder to keep PDFs.'}</p>}
            {kind.id === 'file' && !folder && <p className="ab-note">This project has no folder yet. Choose one in the header to keep files with it.</p>}
          </div>
        </div>
      </div>
      <div className="ab-foot" ref={foot}>
        {text && <span className="chip-slot">
          <button type="button" className={`chip-button${label ? ' set' : ''}`} aria-haspopup="menu" aria-expanded={menu === 'label'} onClick={() => setMenu(menu === 'label' ? null : 'label')}>{label ? sentence(label) : '+ label'}{label && <ChevronDown size={12}/>}</button>
          {menu === 'label' && <div className="chip-menu" role="menu" aria-label="Label">{['', ...TEXT_LABELS].map(word => <button key={word || 'none'} type="button" role="menuitemradio" aria-checked={label === word} onClick={() => { setLabel(word); setMenu(null); }}><span className="chip-check">{label === word && <Check size={13}/>}</span>{word ? sentence(word) : 'No label'}</button>)}</div>}
        </span>}
        <span className="chip-slot">
          <button type="button" className="chip-button" aria-haspopup="menu" aria-expanded={menu === 'where'} onClick={() => setMenu(menu === 'where' ? null : 'where')}>Where · {whereTitle}<ChevronDown size={12}/></button>
          {menu === 'where' && <div className="chip-menu" role="menu" aria-label="Where the block goes">{[{ id: null as string | null, title: 'Nearest free spot' }, ...groups.map(group => ({ id: group.id as string | null, title: `Inside ${group.title}` }))].map(option => <button key={option.id ?? 'free'} type="button" role="menuitemradio" aria-checked={where === option.id} onClick={() => { setWhere(option.id); setMenu(null); }}><span className="chip-check">{where === option.id && <Check size={13}/>}</span><span className="chip-menu-label">{option.title}</span></button>)}</div>}
        </span>
        <span className="sp"/>
        <span className="ab-enter">Enter</span>
        <button type="submit" className="ab-add" disabled={busy || !ready}>{busy ? adding : papers ? 'Add paper' : text && label ? `Add ${label}` : `Add ${kind.name}`}</button>
      </div>
    </form>
  </Modal>;
}
