import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectFolderRoot } from './project-folders.js';
import type { Store } from './store.js';

/** The last answer from an outside source (a Notion database, for example), kept in the project folder
 * under .ros-ai/cache so a restart still has it. It is a cache, not content: it never enters canvas
 * history, and deleting the folder only means the next read goes to the source again. Projects without
 * a folder keep nothing on disk. */
export class ProjectCache {
  constructor(private readonly store: Store) {}

  private file(projectId: string, namespace: string, key: string) {
    const root = projectFolderRoot(this.store, projectId);
    if (!root) return null;
    const dir = join(root, '.ros-ai', 'cache', namespace.replace(/[^a-z0-9-]/giu, '-'));
    return { dir, path: join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`) };
  }

  read<T>(projectId: string, namespace: string, key: string): T | null {
    const target = this.file(projectId, namespace, key);
    if (!target) return null;
    try {
      const saved = JSON.parse(readFileSync(target.path, 'utf8')) as { key: string; value: T };
      return saved.key === key ? saved.value : null;
    } catch { return null; }
  }

  write<T>(projectId: string, namespace: string, key: string, value: T) {
    const target = this.file(projectId, namespace, key);
    if (!target) return;
    try {
      mkdirSync(target.dir, { recursive: true, mode: 0o700 });
      // Written beside the file and renamed, so a crash never leaves half a cache entry.
      const temporary = join(target.dir, `.${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify({ key, savedAt: new Date().toISOString(), value }), { mode: 0o600 });
      renameSync(temporary, target.path);
    } catch { /* a cache that cannot be written is only a slower next start */ }
  }
}
