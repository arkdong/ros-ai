/** Files in the project folder that changed while one ROS turn ran: written by the agent, by ros.ai when a change was
 * accepted, or by anything else on the computer at the same time (turn-files.ts on the server).
 * added/removed: lines, for text files. binary: no line counts (not text, or too large to compare).
 * patch: a saved diff can be opened. */
export type TurnFileChange = { path: string; status: 'added' | 'modified' | 'deleted'; added: number; removed: number; binary?: boolean; patch?: boolean };
/** overlap: another thread of the project was working at the same time, so some changes may be its own.
 * more: changes past the ones listed. partial: the folder was too large to look at whole. */
export type TurnFiles = { changed: TurnFileChange[]; more?: number; overlap?: boolean; partial?: boolean; at: string };

export const turnFilesTotals = (files: TurnFiles) => files.changed.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
