import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { openToOthers } from '../src/server/private-file.js';
import { ToolCredentials } from '../src/server/tool-credentials.js';
import { PluginSuggestions } from '../src/server/plugin-suggestions.js';
import { codexSessionPrefix, inCodexSessionScope } from '../src/server/codex-agent.js';
import { cmdArgument, npmScript, runnable } from '../src/server/command-line.js';

/** Runs body as if ros.ai were on another system, for code that asks process.platform when it runs. */
function onPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
  const saved = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...saved, value: platform });
  try { return body(); } finally { Object.defineProperty(process, 'platform', saved); }
}

test('saved keys open on Windows, where every file reads as open to everyone, and stay owner-only elsewhere (C5)', () => {
  assert.equal(openToOthers(0o666, 'win32'), false);
  assert.equal(openToOthers(0o444, 'win32'), false);
  assert.equal(openToOthers(0o644, 'linux'), true);
  assert.equal(openToOthers(0o600, 'darwin'), false);
  const dir = mkdtempSync(join(tmpdir(), 'ros-windows-keys-'));
  try {
    writeFileSync(join(dir, 'tool-credentials.json'), JSON.stringify({ version: 1, keys: { tavily: 'tvly-0123456789abcdef' } }));
    writeFileSync(join(dir, 'suggestions.json'), JSON.stringify({ version: 1, enabled: true, silenced: [] }));
    // How Node on Windows reports these files.
    chmodSync(join(dir, 'tool-credentials.json'), 0o666); chmodSync(join(dir, 'suggestions.json'), 0o666);
    onPlatform('win32', () => {
      assert.doesNotThrow(() => new ToolCredentials(dir));
      assert.doesNotThrow(() => new PluginSuggestions(dir));
    });
    assert.throws(() => new ToolCredentials(dir), /readable only by its owner/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex session folders count as its own with Windows paths, and nothing else does (M36)', () => {
  const temp = 'C:\\Users\\Ada\\AppData\\Local\\Temp', folder = `${temp}\\ros-ai-agent-session-a1B2c3`;
  assert.equal(inCodexSessionScope(folder, temp, win32), true);
  // The check before this fix, which refused every Codex turn on Windows.
  assert.equal(win32.resolve(folder).startsWith(`${win32.resolve(temp)}/ros-ai-agent-session-`), false);
  assert.equal(inCodexSessionScope('C:\\Users\\Ada\\Documents\\ros-ai-agent-session-a1B2c3', temp, win32), false);
  assert.equal(inCodexSessionScope(`${folder}\\..\\..\\Roaming`, temp, win32), false);
  assert.equal(inCodexSessionScope(join(tmpdir(), 'ros-ai-agent-session-x9'), tmpdir()), true);
  assert.equal(codexSessionPrefix(temp, win32), `${temp}\\ros-ai-agent-session-`);
});

test('an npm-installed agent on Windows runs its Node script directly, and any other .cmd goes through cmd.exe escaped (M37)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-windows-cmd-'));
  try {
    const script = join(dir, 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js');
    mkdirSync(join(dir, 'node_modules', '@google', 'gemini-cli', 'dist'), { recursive: true }); writeFileSync(script, '');
    // npm's current .cmd file for a package bin.
    writeFileSync(join(dir, 'gemini.cmd'), ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@google\\gemini-cli\\dist\\index.js" %*', ''].join('\r\n'));
    assert.deepEqual(runnable(join(dir, 'gemini.cmd'), ['--acp', '--model', 'a b"c'], 'win32'), { command: 'node', args: [script, '--acp', '--model', 'a b"c'] });
    // With node.exe beside it, as the .cmd itself would.
    writeFileSync(join(dir, 'node.exe'), '');
    assert.equal(npmScript(join(dir, 'gemini.cmd'))?.node, join(dir, 'node.exe'));
    // npm's older .cmd file.
    writeFileSync(join(dir, 'old.cmd'), ['@IF EXIST "%~dp0\\node.exe" (', '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@google\\gemini-cli\\dist\\index.js" %*', ') ELSE (',
      '  @SETLOCAL', '  @SET PATHEXT=%PATHEXT:;.JS;=;%', '  node  "%~dp0\\node_modules\\@google\\gemini-cli\\dist\\index.js" %*', ')'].join('\r\n'));
    assert.equal(npmScript(join(dir, 'old.cmd'))?.path, script);
    // Anything else: cmd.exe, with each argument quoted and its special characters escaped.
    writeFileSync(join(dir, 'tool.bat'), '@echo off\r\nexit /b 0\r\n');
    const other = runnable(join(dir, 'tool.bat'), ['a "b" & c'], 'win32');
    assert.equal(other.windowsVerbatimArguments, true);
    assert.deepEqual(other.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.ok(other.args[3].endsWith(' ^"a^ \\^"b\\^"^ ^&^ c^""'), other.args[3]);
    assert.equal(cmdArgument('C:\\dir\\'), '^"C:\\dir\\\\^"');
    // A .cmd whose script is missing, or that runs something other than Node, is not taken for npm's.
    writeFileSync(join(dir, 'sh.cmd'), 'SET "_prog=/bin/sh"\r\n"%_prog%"  "%dp0%\\node_modules\\x\\run" %*\r\n');
    assert.equal(npmScript(join(dir, 'sh.cmd')), null);
    writeFileSync(join(dir, 'gone.cmd'), 'SET "_prog=node"\r\n"%_prog%"  "%dp0%\\node_modules\\gone\\cli.js" %*\r\n');
    assert.equal(npmScript(join(dir, 'gone.cmd')), null);
    // On macOS and Linux nothing changes.
    assert.deepEqual(runnable(join(dir, 'gemini.cmd'), ['--version'], 'darwin'), { command: join(dir, 'gemini.cmd'), args: ['--version'] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
