import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** The exit code of RECYCLE for a folder the Recycle Bin would not keep. */
const NOT_RECYCLABLE = 3;
/** Moves $env:ROS_TRASH_PATH to the Recycle Bin. Windows deletes a folder outright, without asking, when the Recycle
 * Bin cannot keep it: on a network or removable drive, where the Recycle Bin is turned off, or when the folder is
 * larger than the Recycle Bin holds. Those are refused first, with exit code 3, and the folder stays. */
const RECYCLE = [
  '$p = $env:ROS_TRASH_PATH; $root = [IO.Path]::GetPathRoot($p)',
  String.raw`if (-not $root -or $root.StartsWith('\\') -or (New-Object IO.DriveInfo $root).DriveType -ne 'Fixed') { exit 3 }`,
  String.raw`$volume = $null; try { $drive = $root.Substring(0, 2); $volume = [regex]::Match((Get-CimInstance Win32_Volume | Where-Object { $_.DriveLetter -eq $drive } | Select-Object -First 1).DeviceID, '\{[^}]+\}').Value } catch { }`,
  String.raw`if ($volume) { $bin = Get-ItemProperty -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\' + $volume) -ErrorAction SilentlyContinue; if ($bin.NukeOnDelete -eq 1) { exit 3 }; if ($bin.MaxCapacity) { $size = (Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum; if ($size -gt [int64]$bin.MaxCapacity * 1MB) { exit 3 } } }`,
  "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
].join('; ');

/** Moves a folder to the computer's Trash (the Recycle Bin on Windows), where it can still be put back. Nothing is deleted outright. */
export async function moveToTrash(path: string): Promise<void> {
  if (process.platform === 'darwin') {
    // macOS 15 has a trash command that keeps Finder's Put Back; older versions get a plain move into ~/.Trash.
    if (existsSync('/usr/bin/trash') && await run('/usr/bin/trash', [path]) === 0 && !existsSync(path)) return;
    moveInto(join(homedir(), '.Trash'), path);
    return;
  }
  if (process.platform === 'win32') {
    const code = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', RECYCLE], { ROS_TRASH_PATH: path });
    if (code === 0 && !existsSync(path)) return;
    throw new Error(code === NOT_RECYCLABLE ? 'the Recycle Bin cannot keep it: it is on a network or removable drive, the Recycle Bin is off there, or it is too large, and Windows would delete it outright' : 'Windows did not move the folder to the Recycle Bin');
  }
  if (await run('gio', ['trash', path]) === 0 && !existsSync(path)) return;
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

/** The exit code, or null when the program did not start or was stopped. */
function run(command: string, args: string[], env: Record<string, string> = {}): Promise<number | null> {
  return new Promise(done => {
    const child = spawn(command, args, { stdio: 'ignore', env: { ...process.env, ...env } });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.once('error', () => { clearTimeout(timer); done(null); });
    child.once('close', code => { clearTimeout(timer); done(code); });
  });
}
