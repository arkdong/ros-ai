/** A project folder holds every block as an ordinary file that other apps can open. */
import type { ImageSize } from './files.js';
/** `file` is a PDF or image the person put in the folder: ros.ai shows it and never writes it. `app` is an App block's
 * page, an .html file; the blocks it reads live in the project manifest, so copying the file never copies them. */
export type FolderFileKind = 'note'|'report'|'code'|'notebook'|'dataset'|'figure'|'file'|'app';
export const FOLDER_DIRECTORIES: Record<FolderFileKind, string> = { note:'notes', report:'reports', code:'code', notebook:'notebooks', dataset:'data', figure:'figures', file:'files', app:'apps' };
/** `bytes` and `version` (a prefix of the content hash) are given for the PDFs and images File blocks show. */
/** `image` is the pixel size of a File block's picture, read from the file so its card has the picture's shape before the picture loads. */
export type FolderFile = { nodeId:string; path:string; kind:FolderFileKind; missing?:boolean; bytes?:number; version?:string; image?:ImageSize };
/** A file in the folder that is not a block yet. Only the person adds it to the canvas. */
/** A PDF or image becomes a File block that shows it; a PDF's text is read into the block's saved version. */
export type UnplacedFile = { path:string; kind:Exclude<FolderFileKind,'report'|'figure'|'file'>|'pdf'|'image'; bytes:number };
export type FolderProblem = { path:string; message:string };
export type ProjectFolderStatus = {
  attached:boolean; path?:string; available?:boolean; reason?:string;
  /** The project revision, so the browser knows to reload after an outside edit. */
  revision:number; files:FolderFile[]; unplaced:UnplacedFile[]; problems:FolderProblem[]; checkedAt?:string;
};
export type FolderSuggestion = { path:string; exists:boolean; picker:boolean };
export type FolderChoice = { path:string } | { cancelled:true };

/** An installed app that "Open in" offers. */
export type OpenApp = { id: string; label: string; kind: 'editor' | 'terminal' };
