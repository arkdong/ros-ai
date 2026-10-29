import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { Project } from '../shared/types';
import type { ProjectFolderStatus } from '../shared/project-folders';
import { api } from './api';
import { Modal } from './Modal';

const shortPath = (path: string) => path.replace(/^(\/Users|\/home)\/[^/]+(?=\/)/u, '~');

/** Removing a project asks whether its folder goes too. Keeping the files is the default; taking them moves the folder to the computer's Trash. */
export function RemoveProjectDialog({ project, busy, folders, onCancel, onRemove }: { project: Project; busy: boolean; folders: boolean; onCancel: () => void; onRemove: (files: boolean) => void }) {
  const [path, setPath] = useState<string | null>(null), [files, setFiles] = useState(false);
  useEffect(() => {
    if (!folders) return;
    let current = true;
    api<ProjectFolderStatus>(`/api/projects/${project.id}/folder`).then(status => { if (current && status.attached && status.path) setPath(status.path); }).catch(() => undefined);
    return () => { current = false; };
  }, [project.id, folders]);
  return <Modal title="Remove this project?" onClose={onCancel}>
    <p className="modal-description"><strong>{project.title}</strong> will leave your project list.{path ? '' : ' Nothing on your computer is touched.'}</p>
    {path && <div className="remove-project-files">
      <label className="settings-option"><input type="checkbox" checked={files} onChange={event => setFiles(event.target.checked)}/><span><span>Also move its folder and files to the Trash</span><small title={path}>{shortPath(path)}</small></span></label>
      <p>{files ? 'Every file in this folder goes to the Trash, including files ros.ai did not make. You can put it back from the Trash until you empty it.' : 'The folder stays where it is. Open it again later to bring the project back.'}</p>
    </div>}
    <div className="modal-actions"><button className="secondary" onClick={onCancel}>Keep project</button><button className="primary danger-primary" disabled={busy} onClick={() => onRemove(files)}><Trash2 size={15}/> {files ? 'Remove project and files' : 'Remove project'}</button></div>
  </Modal>;
}
