/** A project folder holds every block as an ordinary file that other apps can open. */
export type FolderFileKind = 'note'|'report'|'code'|'notebook'|'dataset'|'figure';
export const FOLDER_DIRECTORIES: Record<FolderFileKind, string> = { note:'notes', report:'reports', code:'code', notebook:'notebooks', dataset:'data', figure:'figures' };
export type FolderFile = { nodeId:string; path:string; kind:FolderFileKind; missing?:boolean };
/** A file in the folder that is not a block yet. Only the person adds it to the canvas. */
/** A PDF is never a block itself: adding it saves its text as a note file beside it (`CV.pdf` → `CV.pdf.md`). */
export type UnplacedFile = { path:string; kind:Exclude<FolderFileKind,'report'|'figure'>|'pdf'; bytes:number };
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
