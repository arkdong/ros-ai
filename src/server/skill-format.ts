import { createHash } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';
import { SKILL_LIMITS, SKILL_NAME, normalizeName, type SkillFile, type SkillFileKind } from '../shared/skills.js';

/** Reading and writing SKILL.md files and skill archives, with no YAML or ZIP library: the frontmatter
 * of a skill is a handful of flat fields, and an archive is checked entry by entry before anything is
 * kept. Validation is lenient, as the Agent Skills guide asks: a skill written for another tool loads
 * with warnings, and only a missing description or a missing frontmatter block refuses it. */

export type ParsedSkill = {
  name: string; description: string; license?: string; compatibility?: string; metadata: Record<string, string>;
  allowedTools?: string; automatic: boolean; menu: boolean; body: string; warnings: string[];
};
type Value = string | boolean | string[] | Record<string, string>;

const indentOf = (line: string) => line.length - line.trimStart().length;
function dedent(lines: string[]) {
  const depth = Math.min(...lines.filter(line => line.trim()).map(indentOf));
  return lines.map(line => line.slice(Math.min(depth, indentOf(line))));
}
/** A quoted scalar: '…' doubles its quotes; "…" takes JSON-like escapes. */
function quoted(text: string): string {
  const quote = text[0]!;
  let out = '';
  for (let at = 1; at < text.length; at++) {
    const char = text[at]!;
    if (quote === '\'' && char === '\'') { if (text[at + 1] === '\'') { out += '\''; at++; continue; } return out; }
    if (quote === '"' && char === '"') return out;
    if (quote === '"' && char === '\\') {
      const next = text[++at] ?? '';
      if (next === 'u' && /^[0-9a-fA-F]{4}$/u.test(text.slice(at + 1, at + 5))) { out += String.fromCharCode(parseInt(text.slice(at + 1, at + 5), 16)); at += 4; continue; }
      out += ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0' } as Record<string, string>)[next] ?? next;
      continue;
    }
    out += char;
  }
  return out;
}
const unquote = (text: string) => { const value = text.trim(); return value.startsWith('"') || value.startsWith('\'') ? quoted(value) : value.replace(/\s+#.*$/u, ''); };
/** Splits "a, 'b, c', d" at the commas outside quotes. */
function items(text: string): string[] {
  const out: string[] = [];
  let current = '', quote = '';
  for (const char of text) {
    if (quote) { current += char; if (char === quote) quote = ''; continue; }
    if (char === '"' || char === '\'') { quote = char; current += char; continue; }
    if (char === ',') { out.push(current); current = ''; continue; }
    current += char;
  }
  out.push(current);
  return out.map(unquote).filter(Boolean);
}

function scalar(rest: string, block: string[]): Value {
  const lines = block.length ? dedent(block) : [];
  if (/^[|>][+-]?\d*$/u.test(rest)) {
    if (rest.startsWith('|')) return lines.join('\n').trimEnd();
    // Folded: lines join with spaces; a blank line is a paragraph break.
    return lines.reduce((text, line) => !line.trim() ? `${text}\n` : text && !text.endsWith('\n') ? `${text} ${line.trim()}` : `${text}${line.trim()}`, '').trimEnd();
  }
  const joined = [rest, ...lines.map(line => line.trim())].filter(Boolean).join(' ');
  if (rest.startsWith('"') || rest.startsWith('\'')) return quoted(joined);
  if (rest.startsWith('[')) return items(joined.replace(/^\[|\][^\]]*$/gu, ''));
  if (rest.startsWith('{')) return Object.fromEntries(items(joined.replace(/^\{|\}[^}]*$/gu, '')).map(pair => { const at = pair.indexOf(':'); return at < 0 ? [pair, ''] : [pair.slice(0, at).trim(), unquote(pair.slice(at + 1))]; }));
  if (!rest && lines.some(line => line.trim())) {
    const first = lines.find(line => line.trim())!;
    if (/^-(\s|$)/u.test(first)) return lines.filter(line => /^-(\s|$)/u.test(line)).map(line => unquote(line.replace(/^-\s*/u, '')));
    if (/^[A-Za-z0-9_.-]+\s*:/u.test(first)) {
      // A one-level map, as metadata is; deeper lines join onto the key above them.
      const map: Record<string, string> = {};
      let key = '';
      for (const line of lines) {
        const pair = indentOf(line) === 0 ? /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/u.exec(line) : null;
        if (pair) { key = pair[1]!; map[key] = unquote(pair[2] ?? ''); }
        else if (key && line.trim()) map[key] = [map[key], line.trim().replace(/^-\s*/u, '')].filter(Boolean).join(map[key] ? ', ' : '');
      }
      return map;
    }
  }
  const plain = joined.replace(/\s+#.*$/u, '').trim();
  return plain === 'true' ? true : plain === 'false' ? false : plain === 'null' || plain === '~' ? '' : plain;
}

/** The flat YAML that skill frontmatter uses: top-level keys with plain, quoted, block or folded values,
 * lists and one-level maps. Anything stranger is kept as text rather than refused. */
export function parseYaml(yaml: string): { values: Record<string, Value>; problems: string[] } {
  const lines = yaml.split('\n'), values: Record<string, Value> = {}, problems: string[] = [];
  for (let at = 0; at < lines.length;) {
    const line = lines[at]!;
    if (!line.trim() || line.trimStart().startsWith('#')) { at++; continue; }
    const field = indentOf(line) === 0 ? /^([A-Za-z0-9_.-]+)\s*:(?:\s+(.*)|\s*)$/u.exec(line) : null;
    at++;
    if (!field) { problems.push(`Line ${at} is not a "key: value" field.`); continue; }
    const block: string[] = [];
    while (at < lines.length && (!lines[at]!.trim() || indentOf(lines[at]!) > 0)) block.push(lines[at++]!);
    while (block.length && !block.at(-1)!.trim()) block.pop();
    if (field[1]! in values) problems.push(`${field[1]} appears twice; the last one counts.`);
    values[field[1]!] = scalar((field[2] ?? '').trim(), block);
  }
  return { values, problems };
}

const FRONTMATTER = /^---[ \t]*\n([\s\S]*?)\n?---[ \t]*(?:\n|$)/u;
export function splitFrontmatter(text: string): { yaml: string | null; body: string } {
  const source = text.replace(/^﻿/u, '').replace(/\r\n?/gu, '\n');
  const match = FRONTMATTER.exec(source);
  return match ? { yaml: match[1]!, body: source.slice(match[0].length) } : { yaml: null, body: source };
}


const text = (value: Value | undefined) => typeof value === 'string' ? value.trim() : typeof value === 'boolean' ? String(value) : Array.isArray(value) ? value.join(' ') : '';
/** Reads a SKILL.md. folder is the name of the folder it sits in, which the standard says the name matches. */
export function parseSkillMd(source: string, folder?: string): ParsedSkill | { error: string } {
  const { yaml, body } = splitFrontmatter(source);
  if (yaml === null) return { error: 'A SKILL.md starts with a block between two --- lines that gives at least a name and a description.' };
  const { values, problems } = parseYaml(yaml), warnings = [...problems];
  const description = text(values.description).replace(/\s+/gu, ' ');
  if (!description) return { error: 'This SKILL.md has no description. Agents choose a skill by its description, so it is required.' };
  let name = text(values.name);
  if (!name) { name = folder ?? ''; warnings.push('It has no name, so it takes the name of its folder.'); }
  if (!name) return { error: 'This SKILL.md has no name.' };
  if (!SKILL_NAME.test(name) || name.length > SKILL_LIMITS.name) warnings.push(`Its name "${name.slice(0, 80)}" does not follow the standard (lowercase letters, digits and single hyphens, at most 64), so ros.ai uses "${normalizeName(name)}".`);
  else if (folder && folder !== name) warnings.push(`Its name differs from its folder (${folder}).`);
  if (description.length > SKILL_LIMITS.description) warnings.push('Its description is longer than the 1,024 characters the standard allows.');
  const compatibility = text(values.compatibility);
  if (compatibility.length > SKILL_LIMITS.compatibility) warnings.push('Its compatibility note is longer than 500 characters.');
  const metadata = values.metadata && typeof values.metadata === 'object' && !Array.isArray(values.metadata) ? values.metadata : {};
  const allowed = Array.isArray(values['allowed-tools']) ? values['allowed-tools'].join(' ') : text(values['allowed-tools']);
  if (values.hooks !== undefined) warnings.push('It declares Claude Code hooks; ros.ai ignores them.');
  if (/(^|\s)!`[^`]+`/u.test(body)) warnings.push('It has Claude Code shell lines (!`…`); ros.ai shows them as text and never runs them.');
  return {
    name: normalizeName(name), description, ...(text(values.license) ? { license: text(values.license) } : {}), ...(compatibility ? { compatibility } : {}),
    metadata, ...(allowed ? { allowedTools: allowed } : {}), automatic: values['disable-model-invocation'] !== true, menu: values['user-invocable'] !== false,
    body: body.replace(/^\n+/u, '').trimEnd(), warnings,
  };
}

/** A YAML scalar for one line of text: plain when every YAML reader reads it back as the same text, otherwise
 * quoted (a colon, a comment sign, a leading digit that could read as a number or date, or a YAML word). */
export function yamlString(value: string): string {
  const line = value.replace(/\s+/gu, ' ').trim();
  return /^[A-Za-z(][^:#]*$/u.test(line) && !/[:\s]$/u.test(line) && !/^(true|false|null|yes|no|on|off|y|n|~)$/iu.test(line) ? line : JSON.stringify(line);
}
export function writeSkillMd(fields: { name: string; description: string }, body: string): string {
  return `---\nname: ${fields.name}\ndescription: ${yamlString(fields.description)}\n---\n\n${body.trim()}\n`;
}
/** Changes the description and or the instructions of a SKILL.md and leaves every other field as written. */
export function updateSkillMd(source: string, change: { description?: string; body?: string }): string {
  const { yaml, body } = splitFrontmatter(source);
  let lines = (yaml ?? '').split('\n');
  if (change.description !== undefined) {
    const start = lines.findIndex(line => /^description\s*:/u.test(line));
    const replacement = `description: ${yamlString(change.description)}`;
    if (start < 0) { const name = lines.findIndex(line => /^name\s*:/u.test(line)); lines.splice(name < 0 ? lines.length : name + 1, 0, replacement); }
    else { let end = start + 1; while (end < lines.length && (!lines[end]!.trim() || indentOf(lines[end]!) > 0)) end++; lines = [...lines.slice(0, start), replacement, ...lines.slice(end)]; }
  }
  return `---\n${lines.join('\n').replace(/\n+$/u, '')}\n---\n\n${(change.body ?? body).trim()}\n`;
}

const SCRIPT = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd|r)$/iu;
export function fileKind(path: string): SkillFileKind {
  if (path === 'SKILL.md') return 'skill';
  if (path.startsWith('scripts/') || SCRIPT.test(path)) return 'script';
  if (path.startsWith('references/') || /\.(md|txt|rst)$/iu.test(path)) return 'reference';
  if (path.startsWith('assets/') || path.startsWith('templates/')) return 'asset';
  return 'other';
}
const utf8 = new TextDecoder('utf-8', { fatal: true });
export function isText(data: Buffer): boolean {
  if (data.subarray(0, 8192).includes(0)) return false;
  try { utf8.decode(data); return true; } catch { return false; }
}
export function describeFiles(files: { path: string; data: Buffer }[]): SkillFile[] {
  return files.map(file => ({ path: file.path, bytes: file.data.length, kind: fileKind(file.path), text: isText(file.data) })).sort((a, b) => Number(b.path === 'SKILL.md') - Number(a.path === 'SKILL.md') || a.path.localeCompare(b.path));
}
/** One digest for a whole skill folder: the same files with the same bytes give the same digest. */
export function skillDigest(files: { path: string; data: Buffer }[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) hash.update(`${file.path}\0${createHash('sha256').update(file.data).digest('hex')}\n`);
  return hash.digest('hex');
}

/** A relative path inside a skill: no absolute paths, no "..", no hidden system files. */
export function safeRelative(path: string): string | null {
  const clean = path.replace(/\\/gu, '/').replace(/^\.\/+/u, '');
  if (!clean || clean.startsWith('/') || /^[A-Za-z]:/u.test(clean) || clean.includes('\0')) return null;
  const parts = clean.split('/');
  if (parts.some(part => part === '..' || part === '')) return null;
  return parts.join('/');
}
export const ignoredFile = (path: string) => /(^|\/)(__MACOSX|\.git|node_modules|\.DS_Store|Thumbs\.db)(\/|$)/u.test(path);

/** Checks the counted limits of one skill's files. */
export function checkLimits(files: { path: string; data: Buffer }[]) {
  if (files.length > SKILL_LIMITS.files) throw new Error(`A skill may hold at most ${SKILL_LIMITS.files} files.`);
  if (files.some(file => file.data.length > SKILL_LIMITS.fileBytes)) throw new Error('A file in this skill is larger than 2 MB.');
  if (files.reduce((sum, file) => sum + file.data.length, 0) > SKILL_LIMITS.bytes) throw new Error('This skill is larger than 10 MB.');
}

/** The entries of a .zip (or a .skill, which is a zip), checked before anything is unpacked: no
 * encryption, no ZIP64, no links, no paths outside the archive, and sizes within the skill limits. */
export function readZip(archive: Buffer): { path: string; data: Buffer }[] {
  if (archive.length > SKILL_LIMITS.archive) throw new Error('This archive is larger than 12 MB.');
  let end = -1;
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 22 - 65_535); at--) if (archive.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  if (end < 0) throw new Error('This file is not a ZIP archive.');
  const count = archive.readUInt16LE(end + 10), size = archive.readUInt32LE(end + 12), offset = archive.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error('ZIP64 archives are not supported.');
  if (offset + size > archive.length) throw new Error('This ZIP archive is damaged.');
  const out: { path: string; data: Buffer }[] = [];
  let total = 0;
  for (let at = offset, index = 0; index < count; index++) {
    if (archive.readUInt32LE(at) !== 0x02014b50) throw new Error('This ZIP archive is damaged.');
    const flags = archive.readUInt16LE(at + 8), method = archive.readUInt16LE(at + 10), crc = archive.readUInt32LE(at + 16);
    const packed = archive.readUInt32LE(at + 20), unpacked = archive.readUInt32LE(at + 24), nameLength = archive.readUInt16LE(at + 28);
    const extra = archive.readUInt16LE(at + 30), comment = archive.readUInt16LE(at + 32), attributes = archive.readUInt32LE(at + 38), local = archive.readUInt32LE(at + 42);
    const raw = archive.subarray(at + 46, at + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1');
    at += 46 + nameLength + extra + comment;
    if (raw.endsWith('/') || ignoredFile(raw)) continue;
    if (flags & 1) throw new Error('Encrypted archives are not supported.');
    if (((attributes >>> 16) & 0o170000) === 0o120000) throw new Error(`The archive holds a link (${raw.slice(0, 120)}), which ros.ai does not unpack.`);
    const path = safeRelative(raw);
    if (!path) throw new Error(`The archive holds a path outside itself (${raw.slice(0, 120)}).`);
    if (unpacked > SKILL_LIMITS.fileBytes) throw new Error(`${path} is larger than 2 MB.`);
    if ((total += unpacked) > SKILL_LIMITS.bytes) throw new Error('This archive unpacks to more than 10 MB.');
    if (out.length >= SKILL_LIMITS.files * 4) throw new Error('This archive holds too many files.');
    if (archive.readUInt32LE(local) !== 0x04034b50) throw new Error('This ZIP archive is damaged.');
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28), body = archive.subarray(start, start + packed);
    if (body.length !== packed) throw new Error('This ZIP archive is damaged.');
    const data = method === 0 ? Buffer.from(body) : method === 8 ? inflateRawSync(body, { maxOutputLength: unpacked + 1 }) : null;
    if (!data) throw new Error(`${path} is packed in a way ros.ai cannot read (method ${method}).`);
    if (data.length !== unpacked || crc32(data) !== crc) throw new Error(`${path} in the archive is damaged.`);
    out.push({ path, data });
  }
  return out;
}

/** Splits loose files into skills: every folder holding a SKILL.md is one skill, with the files below it.
 * A SKILL.md inside another skill's folder belongs to that skill. */
export function groupSkills(files: { path: string; data: Buffer }[]): { root: string; files: { path: string; data: Buffer }[] }[] {
  const roots = files.filter(file => file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md')).map(file => file.path.slice(0, -'SKILL.md'.length).replace(/\/$/u, ''))
    .sort((a, b) => a.split('/').length - b.split('/').length);
  const kept: string[] = [];
  for (const root of roots) if (!kept.some(outer => outer === '' || root.startsWith(`${outer}/`))) kept.push(root);
  return kept.map(root => ({ root, files: files.filter(file => root === '' || file.path.startsWith(`${root}/`)).map(file => ({ path: root ? file.path.slice(root.length + 1) : file.path, data: file.data })) }));
}
