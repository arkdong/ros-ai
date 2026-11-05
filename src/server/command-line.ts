import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findBinary } from './setup-detect.js';

/** How to start a program with its arguments, for spawn and execFile. */
export type Runnable = { command: string; args: string[]; windowsVerbatimArguments?: boolean };

/** How to start a command line such as an agent. On Windows npm installs one (Gemini CLI, OpenCode, Codex) as a .cmd
 * file, and Node refuses to start a .cmd without cmd.exe, which reads every argument a second time. An npm .cmd only
 * runs a Node script, so ros.ai runs that script with Node itself and the arguments arrive exactly as given; any other
 * .cmd or .bat goes through cmd.exe with its arguments escaped for it. On macOS and Linux, and for an .exe, the program
 * starts as it is. */
export function runnable(binary: string, args: string[], platform: NodeJS.Platform = process.platform): Runnable {
  if (platform !== 'win32') return { command: binary, args };
  const file = findBinary(binary) ?? binary;
  if (!/\.(cmd|bat)$/iu.test(file)) return { command: file, args };
  const script = npmScript(file);
  if (script) return { command: script.node, args: [script.path, ...args] };
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[file.replace(CMD_META, '^$1'), ...args.map(cmdArgument)].join(' ')}"`], windowsVerbatimArguments: true };
}

/** The Node script an npm .cmd file starts, with the Node it starts it with: node.exe beside it, else node on the path.
 * Null for any other .cmd or .bat. Both npm's current and its older .cmd are read:
 *   "%_prog%"  "%dp0%\node_modules\@google\gemini-cli\dist\index.js" %*   (with SET "_prog=node")
 *   node  "%~dp0\node_modules\npm\bin\npm-cli.js" %* */
export function npmScript(file: string): { node: string; path: string } | null {
  let text: string;
  try { if (statSync(file).size > 64_000) return null; text = readFileSync(file, 'utf8'); } catch { return null; }
  const target = /"%(?:~dp0|dp0%)\\([^"\r\n]+)"\s+%\*/iu.exec(text)?.[1];
  const node = /SET "_prog=node"/iu.test(text) || /^\s*node\s+"%~dp0\\/imu.test(text);
  if (!target || !node) return null;
  const folder = dirname(file), path = join(folder, ...target.split(/[\\/]+/u));
  if (!existsSync(path)) return null;
  const local = join(folder, 'node.exe');
  return { node: existsSync(local) ? local : 'node', path };
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/gu;
/** One argument for cmd.exe /d /s /c "…": quoted the way programs read their command line, then each character
 * cmd.exe would act on escaped with ^. */
export function cmdArgument(value: string): string {
  const quoted = `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\*)$/u, '$1$1')}"`;
  return quoted.replace(CMD_META, '^$1');
}
