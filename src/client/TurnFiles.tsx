import { useState } from 'react';
import { ChevronRight, FileText, FolderOpen } from 'lucide-react';
import { turnFilesTotals, type TurnFileChange, type TurnFiles } from '../shared/turn-files';
import { api, post } from './api';
import './turn-files.css';

/** Rows shown before "N more". */
const ROWS = 6;
const word: Record<TurnFileChange['status'], string> = { added: 'New', modified: '', deleted: 'Deleted' };

/** The files a turn changed in the project folder, under its answer: each with its line counts, its diff on a click,
 * and Show in folder. */
export function TurnFilesCard({ projectId, turnId, files }: { projectId: string; turnId: string; files: TurnFiles }) {
  const [opened, setOpened] = useState<string | null>(null);
  const [patches, setPatches] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState('');
  const [all, setAll] = useState(false);
  if (!files.changed.length) return null;
  const totals = turnFilesTotals(files), count = files.changed.length + (files.more ?? 0);
  const shown = all || files.changed.length <= ROWS ? files.changed : files.changed.slice(0, ROWS - 1);
  const toggle = async (file: TurnFileChange) => {
    setProblem('');
    if (opened === file.path) { setOpened(null); return; }
    setOpened(file.path);
    if (!file.patch || patches[file.path] !== undefined) return;
    try { const { patch } = await api<{ patch: string }>(`/api/projects/${projectId}/assistant/turns/${turnId}/files/diff?path=${encodeURIComponent(file.path)}`); setPatches(current => ({ ...current, [file.path]: patch })); }
    catch (cause) { setProblem(cause instanceof Error ? cause.message : 'Could not open the diff.'); }
  };
  const reveal = async (path: string) => { setProblem(''); try { await post(`/api/projects/${projectId}/assistant/turns/${turnId}/files/reveal`, { path }); } catch (cause) { setProblem(cause instanceof Error ? cause.message : 'Could not show the file.'); } };
  return <section className="turn-files" aria-label="Files changed">
    <header><FileText size={14} aria-hidden="true"/><strong>{count} {count === 1 ? 'file' : 'files'} changed</strong>{(totals.added > 0 || totals.removed > 0) && <span className="turn-files-lines"><span className="added">+{totals.added}</span> <span className="removed">−{totals.removed}</span></span>}</header>
    <ul>{shown.map(file => {
      const open = opened === file.path, name = file.path.split('/').pop() ?? file.path, folder = file.path.slice(0, file.path.length - name.length);
      return <li key={file.path} className={open ? 'open' : undefined}>
        <div className="turn-files-row">
          <button type="button" className="turn-files-toggle" aria-expanded={open} title={file.path} onClick={() => void toggle(file)}><ChevronRight size={12} aria-hidden="true"/><span className="turn-files-name">{folder && <span className="turn-files-folder">{folder}</span>}{name}</span></button>
          {word[file.status] && <span className="turn-files-status">{word[file.status]}</span>}
          {file.binary ? <span className="turn-files-status">Not text</span> : <span className="turn-files-lines"><span className="added">+{file.added}</span> <span className="removed">−{file.removed}</span></span>}
          <button type="button" className="icon-button turn-files-reveal" aria-label={`Show ${name} in its folder`} title={file.status === 'deleted' ? 'Open its folder' : 'Show in folder'} onClick={() => void reveal(file.path)}><FolderOpen size={13}/></button>
        </div>
        {open && (file.patch ? patches[file.path] === undefined ? !problem && <p className="turn-files-note">Opening the diff…</p> : <Patch text={patches[file.path]}/> : <p className="turn-files-note">{file.binary ? 'This file is not text, or too large to compare.' : 'No diff was kept for this file.'}</p>)}
      </li>;
    })}</ul>
    {shown.length < files.changed.length && <button type="button" className="text-button small" onClick={() => setAll(true)}>{files.changed.length - shown.length} more</button>}
    {files.more ? <p className="turn-files-note">{files.more} more not listed.</p> : null}
    {files.overlap && <p className="turn-files-note">Another thread was working at the same time, so some of these may be its changes.</p>}
    {files.partial && <p className="turn-files-note">The project folder is large, so only part of it was compared.</p>}
    {problem && <p className="turn-files-note" role="alert">{problem}</p>}
  </section>;
}

function Patch({ text }: { text: string }) {
  const rows = text.split('\n').filter(line => !line.startsWith('--- ') && !line.startsWith('+++ '));
  return <pre className="turn-files-patch">{rows.map((line, index) => <span key={index} className={line.startsWith('@@') ? 'hunk' : line[0] === '+' ? 'added' : line[0] === '-' ? 'removed' : undefined}>{line || ' '}{'\n'}</span>)}</pre>;
}
