import { z } from 'zod';
import { nodeBlockType } from '../shared/blocks.js';
import { noteImageType } from '../shared/files.js';
import type { CanvasNode, Mutation, Project } from '../shared/types.js';
import type { NotebookService } from './notebooks.js';
import type { ProjectFolders } from './project-folders.js';
import { StoreError, type Store } from './store.js';

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u);
const bodySchema = z.object({
  operations: z.array(z.unknown()).min(1).max(500),
  label: z.string().min(1).max(240),
  expectedRevision: z.number().int().nonnegative().optional(),
  /** The project the blocks were copied from. */
  from: identifier,
  /** Each pasted block's original, by the pasted block's id. */
  sources: z.record(identifier, identifier),
  /** The saved version each original showed, by the pasted block's id. */
  artifacts: z.record(identifier, identifier).default({}),
}).strict();

/** Folder images a Text block's Markdown embeds: `![alt](photos/a.png)` and `![[a.png|300]]`. Web images need no copy. */
export function embeddedImages(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/!\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|!\[\[([^\]|\n]+?)(?:\|\s*\d{1,4}\s*)?\]\]/gu)) {
    const src = (match[1] ?? match[2] ?? '').trim();
    if (src && !/^[a-z][a-z0-9+.-]*:/iu.test(src) && noteImageType(src)) found.push(src);
  }
  return found;
}

export type PasteResult = { project: Project; missing: string[] };

/**
 * Pastes copied blocks. Within one project the copies share what the originals point at. From another project, each
 * block takes what it shows along: a File block's PDF or image, a Post's photos and subtitles and a Text block's
 * embedded images are copied into this project's folder, a saved version (a table, figure or report) is copied into
 * this project, and a Notebook gets its cells. Something that cannot be copied is named in `missing`.
 */
export function pasteBlocks(deps: { store: Store; folders?: ProjectFolders; notebooks?: NotebookService }, projectId: string, input: unknown): PasteResult {
  const { store, folders, notebooks } = deps, body = bodySchema.parse(input), from = body.from, same = from === projectId;
  const operations = structuredClone(body.operations) as Mutation[], missing: string[] = [];
  let sourceAlive = true;
  try { store.getProject(from); } catch { sourceAlive = false; }
  const folderHere = Boolean(folders?.hasFolder(projectId)), folderThere = sourceAlive && Boolean(folders?.hasFolder(from));
  const copies: { nodeId: string; artifactId: string }[] = [], notebookCopies: { from: string; to: string }[] = [];
  for (const operation of operations) {
    if (operation.type !== 'addNode') continue;
    const node = operation.node as CanvasNode, original = body.sources[node.id];
    if (!original) continue;
    if (nodeBlockType(node) === 'notebook' && node.kind !== 'group') notebookCopies.push({ from: original, to: node.id });
    if (same) continue;
    const artifactId = body.artifacts[node.id];
    if (artifactId) try { if (store.getArtifact(artifactId).projectId === from) copies.push({ nodeId: node.id, artifactId }); } catch { missing.push(node.title); }
    if (node.file?.path) {
      if (!folders || !folderHere) throw new StoreError(`Choose a folder for this project first, so ${node.title} has a place for its file.`, 409);
      try { if (!folderThere) throw new Error('no folder'); node.file = { path: folders.copyFileFrom(from, node.file.path, projectId) }; }
      catch { missing.push(node.title); }
    }
    if (node.post) {
      const post = node.post, paths = [...post.photos.flatMap(photo => photo.path ? [photo.path] : []), ...(post.subtitles?.path ? [post.subtitles.path] : [])];
      const moved = folders && folderHere && folderThere && paths.length ? folders.copyPostFrom(from, paths, projectId, post.title || node.title) : new Map<string, string>();
      // A photo that did not come along is shown from its page again.
      post.photos = post.photos.map(({ path, ...photo }) => path && moved.has(path) ? { ...photo, path: moved.get(path)! } : photo);
      if (post.subtitles?.path) { const { path, ...subtitles } = post.subtitles; post.subtitles = moved.has(path) ? { ...subtitles, path: moved.get(path)! } : subtitles; }
    }
    if (!node.file && node.kind !== 'group' && node.description && folders && folderHere && folderThere) {
      const images = embeddedImages(node.description);
      if (images.length) folders.copyNoteImagesFrom(from, original, images, projectId);
    }
  }
  const project = store.pasteBlocks(projectId, operations, body.label, body.expectedRevision, copies);
  for (const notebook of notebookCopies) {
    if (!notebooks || !sourceAlive) { missing.push('a notebook'); continue; }
    try { notebooks.copyFrom(from, notebook.from, projectId, notebook.to); }
    catch { missing.push(project.canvas.nodes.find(node => node.id === notebook.to)?.title ?? 'a notebook'); }
  }
  return { project, missing: [...new Set(missing)] };
}
