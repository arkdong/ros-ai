import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** Moves a folder to the computer's Trash (the Recycle Bin on Windows), where it can still be put back. Nothing is deleted outright. */
export async function moveToTrash(path: string): Promise<void> {
  if (process.platform === 'darwin') {
    // macOS 15 has a trash command that keeps Finder's Put Back; older versions get a plain move into ~/.Trash.
    if (existsSync('/usr/bin/trash') && await run('/usr/bin/trash', [path]) && !existsSync(path)) return;
    moveInto(join(homedir(), '.Trash'), path);
    return;
  }
  if (process.platform === 'win32') {
    const script = "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:ROS_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')";
    if (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { ROS_TRASH_PATH: path }) && !existsSync(path)) return;
    throw new Error('Windows did not move the folder to the Recycle Bin');
  }
  if (await run('gio', ['trash', path]) && !existsSync(path)) return;
  // The freedesktop.org Trash that Linux file managers share.
  const trash = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'Trash');
  mkdirSync(join(trash, 'info'), { recursive: true });
  const name = moveInto(join(trash, 'files'), path);
  writeFileSync(join(trash, 'info', `${name}.trashinfo`), `[Trash Info]\nPath=${encodeURI(path)}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`);
}

/** Renames the folder into the Trash under a name not taken yet, and returns that name. */
function moveInto(trash: string, path: string): string {
  mkdirSync(trash, { recursive: true });
  const base = basename(path);
  let name = base;
  for (let index = 2; existsSync(join(trash, name)); index++) name = `${base} ${index}`;
  renameSync(path, join(trash, name));
  return name;
}

function run(command: string, args: string[], env: Record<string, string> = {}): Promise<boolean> {
  return new Promise(done => {
    const child = spawn(command, args, { stdio: 'ignore', env: { ...process.env, ...env } });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.once('error', () => { clearTimeout(timer); done(false); });
    child.once('close', code => { clearTimeout(timer); done(code === 0); });
  });
}
