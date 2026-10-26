import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, deflateRawSync } from 'node:zlib';
import { Store } from '../src/server/store.js';
import { ExecutionService } from '../src/server/execution.js';
import { ExperimentService } from '../src/server/experiments.js';
import { AssistantService } from '../src/server/assistant.js';
import { SandboxBudget } from '../src/server/sandbox-budget.js';
import { AgentWorkspaceTools } from '../src/server/agent-tools.js';
import { SkillLibrary, calledSkills } from '../src/server/skills.js';
import { groupSkills, parseSkillMd, readZip, updateSkillMd, writeSkillMd, yamlString } from '../src/server/skill-format.js';
import { agentStep, type AgentExecuteRequest, type AgentRuntime } from '../src/shared/agent-runtime.js';
import type { ModelAdapter, ModelRequest } from '../src/server/providers.js';
import type { ExecutionBackend } from '../src/server/sandbox.js';
import { normalizeName, type SkillPreview } from '../src/shared/skills.js';

// Frontmatter as the public skill repositories write it (anthropics/skills, K-Dense-AI/scientific-agent-skills).
const SKILL_CREATOR = `---
name: skill-creator
description: Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy.
---

# Skill Creator

A skill for creating new skills and iteratively improving them.
`;
const SCIENTIFIC_WRITING = `---
name: scientific-writing
description: Drafts, revises, and audits scientific manuscripts or reports with explicit evidence provenance. Use for manuscript sections, references, declarations, tables, figures, or submission preparation when scientific accuracy and traceability matter.
license: MIT
compatibility: Requires Python 3.11+ only for optional dependency-free local CLIs; core guidance is platform-neutral.
metadata:
  version: "2.3"
  last-reviewed: "2026-10-01"
  skill-author: K-Dense Inc.
---

# Scientific writing

Write in full paragraphs.
`;
const skillMd = (name: string, description: string, body = `Instructions for ${name}.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

/** A .zip written by hand, so the archive checks can be tested without a ZIP library. */
type ZipEntry = { path: string; data: string | Buffer; deflate?: boolean; link?: boolean; flags?: number; crc?: number };
function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data), packed = entry.deflate ? deflateRawSync(data) : data, name = Buffer.from(entry.path), crc = entry.crc ?? crc32(data), flags = entry.flags ?? 0x800, method = entry.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.link ? 0o120777 : 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed); centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function library(options: ConstructorParameters<typeof SkillLibrary>[2] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ros-skills-')), home = join(dir, 'home'), store = new Store(join(dir, 'data'));
  mkdirSync(home, { recursive: true });
  const skills = new SkillLibrary(store, join(dir, 'data'), { home, ...options });
  return { dir, home, store, skills, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const write = (path: string, text: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };

test('SKILL.md files from the public repositories read with their fields, and broken ones are refused with a reason', () => {
  const creator = parseSkillMd(SKILL_CREATOR, 'skill-creator');
  assert(!('error' in creator));
  assert.equal(creator.name, 'skill-creator');
  assert.match(creator.description, /^Create new skills.*triggering accuracy\.$/u);
  assert.equal(creator.body.split('\n')[0], '# Skill Creator');
  assert.deepEqual(creator.warnings, []);
  assert.equal(creator.automatic, true);
  assert.equal(creator.menu, true);

  const writing = parseSkillMd(SCIENTIFIC_WRITING, 'scientific-writing');
  assert(!('error' in writing));
  assert.equal(writing.license, 'MIT');
  assert.match(writing.compatibility!, /^Requires Python 3\.11\+/u);
  assert.deepEqual(writing.metadata, { version: '2.3', 'last-reviewed': '2026-10-01', 'skill-author': 'K-Dense Inc.' });

  // Folded and block descriptions, quoted text, lists, and Claude Code's own switches.
  const folded = parseSkillMd(`---\nname: Weekly Review\ndescription: >\n  Summarises the week's notes\n  into one page: wins, open questions.\nallowed-tools: [Read, "Grep"]\ndisable-model-invocation: true\nuser-invocable: false\nhooks:\n  PreToolUse: []\n---\nRun !\`git log --since=7.days\` first.\n`, 'weekly');
  assert(!('error' in folded));
  assert.equal(folded.name, 'weekly-review');
  assert.equal(folded.description, 'Summarises the week\'s notes into one page: wins, open questions.');
  assert.equal(folded.allowedTools, 'Read Grep');
  assert.equal(folded.automatic, false);
  assert.equal(folded.menu, false);
  assert(folded.warnings.some(line => /does not follow the standard/u.test(line)));
  assert(folded.warnings.some(line => /hooks/u.test(line)));
  assert(folded.warnings.some(line => /shell lines/u.test(line)));
  const block = parseSkillMd('---\nname: "quoted-name"\ndescription: |\n  Line one.\n  Line two: with a colon.\n---\n', 'other-folder');
  assert(!('error' in block));
  assert.equal(block.description, 'Line one. Line two: with a colon.');
  assert(block.warnings.some(line => /differs from its folder/u.test(line)));
  const nameless = parseSkillMd('---\ndescription: Uses the folder name.\n---\nBody', 'from-folder');
  assert(!('error' in nameless));
  assert.equal(nameless.name, 'from-folder');

  assert.match((parseSkillMd('# Just markdown\n') as { error: string }).error, /starts with a block between two --- lines/u);
  assert.match((parseSkillMd('---\nname: empty\n---\nBody') as { error: string }).error, /no description/u);
});

test('Names become folder-safe, and written frontmatter reads back the same in any YAML reader', () => {
  assert.equal(normalizeName('Literature Review!'), 'literature-review');
  assert.equal(normalizeName('Ünïcode  Notes'), 'unicode-notes');
  assert.equal(normalizeName('---'), 'skill');
  const long = normalizeName(`${'a'.repeat(63)} b`);
  assert(long.length <= 64 && !long.endsWith('-'));

  for (const text of ['Plain words, with a comma', 'Has a colon: here', 'Starts with # nothing', 'yes', '2026-10-26', '3.14', '"Quoted" start', 'Ends with colon:', 'It\'s fine']) {
    const parsed = parseSkillMd(writeSkillMd({ name: 'round-trip', description: text }, 'Body'), 'round-trip');
    assert(!('error' in parsed), text);
    assert.equal(parsed.description, text);
  }
  assert.equal(yamlString('Plain words'), 'Plain words');
  assert.equal(yamlString('3D printing'), '"3D printing"');
  assert.equal(yamlString('true'), '"true"');

  // Changing the description or the instructions leaves every other field as its author wrote it.
  const changed = updateSkillMd(SCIENTIFIC_WRITING, { description: 'Short: new description.', body: '# New body' });
  assert.match(changed, /^---\nname: scientific-writing\ndescription: "Short: new description\."\nlicense: MIT\ncompatibility: Requires/u);
  assert.match(changed, /metadata:\n {2}version: "2\.3"\n/u);
  assert.match(changed, /---\n\n# New body\n$/u);
  const folded = updateSkillMd('---\nname: x\ndescription: >\n  one\n  two\nlicense: MIT\n---\nBody\n', { description: 'Replaced' });
  assert.equal(folded, '---\nname: x\ndescription: Replaced\nlicense: MIT\n---\n\nBody\n');
});

test('Skill archives are read only when every entry is safe', () => {
  const files = readZip(zip([{ path: 'demo/SKILL.md', data: skillMd('demo', 'A demo skill.') }, { path: 'demo/scripts/run.py', data: 'print("hi")\n'.repeat(50), deflate: true }, { path: '__MACOSX/demo/._SKILL.md', data: 'junk' }]));
  assert.deepEqual(files.map(file => file.path), ['demo/SKILL.md', 'demo/scripts/run.py']);
  assert.equal(files[1]!.data.toString(), 'print("hi")\n'.repeat(50));

  assert.throws(() => readZip(zip([{ path: '../evil/SKILL.md', data: 'x' }])), /outside itself/u);
  assert.throws(() => readZip(zip([{ path: '/etc/SKILL.md', data: 'x' }])), /outside itself/u);
  assert.throws(() => readZip(zip([{ path: 'demo/link', data: '/etc/passwd', link: true }])), /link/u);
  assert.throws(() => readZip(zip([{ path: 'demo/SKILL.md', data: 'x', flags: 0x801 }])), /Encrypted/u);
  assert.throws(() => readZip(zip([{ path: 'demo/SKILL.md', data: 'x', crc: 1 }])), /damaged/u);
  assert.throws(() => readZip(Buffer.from('not a zip at all, just some text that is long enough')), /not a ZIP/u);
  assert.throws(() => readZip(zip([{ path: 'big.bin', data: Buffer.alloc(2 * 1024 * 1024 + 1) }])), /larger than 2 MB/u);

  // Every folder with a SKILL.md is one skill; a SKILL.md inside another skill belongs to it.
  const groups = groupSkills([
    { path: 'pack/one/SKILL.md', data: Buffer.from('1') }, { path: 'pack/one/references/a.md', data: Buffer.from('a') }, { path: 'pack/one/examples/inner/SKILL.md', data: Buffer.from('i') },
    { path: 'pack/two/SKILL.md', data: Buffer.from('2') }, { path: 'README.md', data: Buffer.from('r') },
  ]);
  assert.deepEqual(groups.map(group => [group.root, group.files.map(file => file.path)]), [['pack/one', ['SKILL.md', 'references/a.md', 'examples/inner/SKILL.md']], ['pack/two', ['SKILL.md']]]);
});

test('The library writes, edits, switches off and removes skills, and adds pasted text or archives only after a review', async () => {
  const f = library();
  try {
    assert.deepEqual(f.skills.state().skills, []);
    const made = f.skills.create({ name: 'Weekly Review', description: 'Use on Fridays: sum up the week.', body: '# Weekly review\n\n1. Read the week\'s notes.' });
    assert.equal(made.name, 'weekly-review');
    assert.equal(made.title, 'Weekly review');
    assert.deepEqual(made.origin, { kind: 'written' });
    assert.equal(made.enabled, true);
    assert.equal(readFileSync(join(f.skills.folder, 'weekly-review', 'SKILL.md'), 'utf8'), '---\nname: weekly-review\ndescription: "Use on Fridays: sum up the week."\n---\n\n# Weekly review\n\n1. Read the week\'s notes.\n');
    assert.throws(() => f.skills.create({ name: 'weekly review', description: 'Again.', body: 'x' }), /already exists/u);

    const edited = f.skills.update('weekly-review', { description: 'Use at the end of each week.', body: 'New steps.', enabled: false });
    assert.equal(edited.description, 'Use at the end of each week.');
    assert.equal(edited.body, 'New steps.');
    assert.equal(edited.enabled, false);
    assert.equal(f.skills.any(), false);
    assert.equal(f.skills.update('weekly-review', { enabled: true }).enabled, true);
    assert.throws(() => f.skills.get('missing-skill'), /no skill called/u);

    // Pasted text without frontmatter needs a name and a description; with them it becomes a SKILL.md.
    await assert.rejects(f.skills.preview({ kind: 'text', text: 'Just some steps.' }), /no name and description/u);
    const pasted = await f.skills.preview({ kind: 'text', text: 'Just some steps.', name: 'Quick Steps', description: 'Use for quick tasks.' });
    assert.equal(pasted.candidates.length, 1);
    assert.equal(pasted.candidates[0]!.name, 'quick-steps');
    assert.equal(pasted.candidates[0]!.existing, null);
    assert.equal(f.skills.state().skills.length, 1, 'a preview adds nothing');
    assert.deepEqual(f.skills.install({ draftId: pasted.draftId }).added, ['quick-steps']);
    assert.throws(() => f.skills.install({ draftId: pasted.draftId }), /expired/u);

    // An archive with two skills: each is shown, the person picks one.
    const archive = zip([
      { path: 'skills/alpha/SKILL.md', data: skillMd('alpha', 'Alpha skill.') }, { path: 'skills/alpha/scripts/tool.py', data: 'print(1)' }, { path: 'skills/alpha/.env', data: 'SECRET=1' },
      { path: 'skills/beta/SKILL.md', data: skillMd('beta', 'Beta skill.', 'Beta body.'), deflate: true },
    ]);
    const both = await f.skills.preview({ kind: 'file', filename: 'pack.zip', data: archive.toString('base64') });
    assert.deepEqual(both.candidates.map(item => item.name), ['alpha', 'beta']);
    const alpha = both.candidates[0]!;
    assert.deepEqual(alpha.files.map(file => [file.path, file.kind]), [['SKILL.md', 'skill'], ['scripts/tool.py', 'script']], 'hidden files are left out');
    assert.equal(alpha.scripts, 1);
    assert(alpha.warnings.some(line => /cannot run it/u.test(line)));
    assert.deepEqual(alpha.origin, { kind: 'file', filename: 'pack.zip' });
    assert.deepEqual(f.skills.install({ draftId: both.draftId, names: ['alpha'] }).added, ['alpha']);
    assert(existsSync(join(f.skills.folder, 'alpha', 'scripts', 'tool.py')));
    assert(!existsSync(join(f.skills.folder, 'alpha', '.env')));
    assert(!existsSync(join(f.skills.folder, 'beta')));

    // The same skill again is recognised; a different one of the same name waits for Replace.
    const same = await f.skills.preview({ kind: 'file', filename: 'pack.zip', data: archive.toString('base64') });
    assert.equal(same.candidates[0]!.existing, 'same');
    const other = await f.skills.preview({ kind: 'file', filename: 'SKILL.md', data: Buffer.from(skillMd('alpha', 'A different alpha.')).toString('base64') });
    assert.equal(other.candidates[0]!.existing, 'different');
    assert.throws(() => f.skills.install({ draftId: other.draftId }), /Replace it/u);
    f.skills.install({ draftId: other.draftId, replace: true });
    assert.equal(f.skills.get('alpha').description, 'A different alpha.');
    assert(!existsSync(join(f.skills.folder, 'alpha', 'scripts')), 'a replaced skill keeps none of the old files');
    assert.equal(f.skills.get('alpha').enabled, true);

    await assert.rejects(f.skills.preview({ kind: 'file', filename: 'notes.txt', data: Buffer.from('x').toString('base64') }), /SKILL\.md, a \.zip or a \.skill/u);
    await assert.rejects(f.skills.preview({ kind: 'file', filename: 'empty.zip', data: zip([{ path: 'README.md', data: 'no skill' }]).toString('base64') }), /no SKILL\.md/u);

    assert.deepEqual(f.skills.remove('alpha').skills.map(skill => skill.name), ['quick-steps', 'weekly-review']);
  } finally { f.close(); }
});

test('Skills in Claude Code, Codex and other tools\' folders are found once each and copied in after a review', async () => {
  const f = library();
  try {
    write(join(f.home, '.claude', 'skills', 'review', 'SKILL.md'), skillMd('review', 'Review a draft.'));
    write(join(f.home, '.claude', 'skills', 'review', 'references', 'checklist.md'), '- Check the sources.');
    write(join(f.home, '.claude', 'skills', 'synced', 'from-web', 'SKILL.md'), skillMd('from-web', 'A skill synced from claude.ai.'));
    write(join(f.home, '.agents', 'skills', 'plan', 'SKILL.md'), skillMd('plan', 'Plan a project.'));
    write(join(f.home, '.agents', 'skills', 'broken', 'SKILL.md'), '# No frontmatter');
    mkdirSync(join(f.home, '.codex', 'skills'), { recursive: true });
    symlinkSync(join(f.home, '.claude', 'skills', 'review'), join(f.home, '.codex', 'skills', 'review'));

    const found = f.skills.scan();
    assert.deepEqual(found.map(item => [item.toolLabel, item.name]), [['Claude Code', 'review'], ['Claude Code', 'from-web'], ['Codex and other agents', 'plan']]);
    const review = found[0]!;
    const preview = await f.skills.preview({ kind: 'found', key: review.key });
    assert.deepEqual(preview.candidates[0]!.files.map(file => file.path), ['SKILL.md', 'references/checklist.md']);
    assert.deepEqual(preview.candidates[0]!.origin, { kind: 'folder', tool: 'Claude Code', path: `~${sep}${join('.claude', 'skills', 'review')}` });
    f.skills.install({ draftId: preview.draftId });
    assert.equal(f.skills.scan().find(item => item.name === 'review')!.added, 'same');
    // A hand edit in the other tool shows as a different version.
    write(join(f.home, '.claude', 'skills', 'review', 'SKILL.md'), skillMd('review', 'Review a draft, more strictly.'));
    assert.equal(f.skills.scan().find(item => item.name === 'review')!.added, 'different');
    await assert.rejects(f.skills.preview({ kind: 'found', key: '0123456789abcdef' }), /no longer in its folder/u);
  } finally { f.close(); }
});

test('Agents get the list of skills that are on, the full text of a skill called with /name, and its files on request', () => {
  const f = library();
  try {
    f.skills.create({ name: 'literature-review', description: 'Use for a literature review: <search>, then summarise.', body: `# Literature review\n\n${'Step. '.repeat(3000)}` });
    f.skills.create({ name: 'tidy-notes', description: 'Tidy messy notes.', body: 'Merge duplicates.' });
    f.skills.create({ name: 'off-skill', description: 'Switched off.', body: 'Never shown.' });
    f.skills.update('off-skill', { enabled: false });
    write(join(f.skills.folder, 'manual-only', 'SKILL.md'), '---\nname: manual-only\ndescription: Only when called.\ndisable-model-invocation: true\n---\nManual body.\n');
    write(join(f.skills.folder, 'tidy-notes', 'references', 'style.md'), `Style guide.\n${'x'.repeat(13_000)}`);
    write(join(f.skills.folder, 'tidy-notes', 'assets', 'logo.png'), '\0PNG binary');

    assert.deepEqual(calledSkills('/tidy-notes /literature-review find papers on X'), ['tidy-notes', 'literature-review']);
    assert.deepEqual(calledSkills('Please /tidy-notes later'), []);
    assert.deepEqual(calledSkills('/Users/adam/data.csv is my file'), []);

    const prompt = f.skills.prompt('Find papers on bees')!;
    assert.match(prompt, /<available_skills>\n<skill name="literature-review">Use for a literature review: &lt;search&gt;, then summarise\.<\/skill>\n<skill name="tidy-notes">Tidy messy notes\.<\/skill>\n<\/available_skills>/u);
    assert.doesNotMatch(prompt, /off-skill|manual-only|skill_content/u);
    assert.match(f.skills.prompt('x', { catalogue: 130, called: 1000 })!, /<skill name="literature-review">.*<\/skill>\n<\/available_skills>\n1 more skill is not listed here; ros_use_skill with no name lists them all\./u);
    assert.match(f.skills.prompt('x', { catalogue: 20, called: 1000 })!, /scripts cannot run here\.\n2 skills are not listed here; ros_use_skill with no name lists them\.$/u);

    f.skills.create({ name: 'wordy', description: `Use when ${'very '.repeat(150)}long.`, body: 'Wordy body.' });
    const short = f.skills.prompt('x', { catalogue: 600, called: 1000 })!;
    assert.match(short, /<skill name="wordy">Use when very very .*…<\/skill>/u);
    assert.equal((short.match(/<skill name=/gu) ?? []).length, 3, 'shortened, every skill still fits');
    f.skills.remove('wordy');
    // A skill called with /name comes in full, even one agents may not pick themselves; a long one is cut with a way to read on.
    const called = f.skills.prompt('/manual-only /literature-review go')!;
    assert.match(called, /The researcher called these skills with \/name/u);
    assert.match(called, /<skill_content name="manual-only">\nManual body\.\n<\/skill_content>/u);
    assert.match(called, /call ros_use_skill with name "literature-review" and offset 15000/u);
    assert.equal(f.skills.prompt('/off-skill go'), f.skills.prompt('go'));
    // Without the tool (chat models), the text says it was cut and names no tool.
    const plain = f.skills.called('/literature-review', 5000, false)!;
    assert.match(plain, /too long to show here/u);
    assert.doesNotMatch(plain, /ros_use_skill/u);

    const listed = f.skills.use({}) as { skills: { name: string; onlyWhenCalled?: boolean }[]; count: number };
    assert.deepEqual(listed.skills.map(item => [item.name, item.onlyWhenCalled ?? false]), [['literature-review', false], ['manual-only', true], ['tidy-notes', false]]);
    const seen = new Set<string>();
    const read = f.skills.use({ name: '/tidy-notes' }, seen) as { content: string; more: boolean };
    assert.match(read.content, /^<skill_content name="tidy-notes">\nMerge duplicates\.\n\nFiles in this skill \(read one with ros_use_skill and file; scripts cannot run here\):\n- assets\/logo\.png\n- references\/style\.md\n<\/skill_content>$/u);
    assert.deepEqual(f.skills.use({ name: 'tidy-notes' }, seen), { name: 'tidy-notes', note: 'This skill was already read in this turn; follow the instructions above.' });
    const page = f.skills.use({ name: 'tidy-notes', file: 'references/style.md' }) as { content: string; more: boolean; totalCharacters: number };
    assert.equal(page.content.length, 12_000);
    assert.equal(page.more, true);
    assert.equal((f.skills.use({ name: 'tidy-notes', file: 'references/style.md', offset: 12_000 }) as { more: boolean }).more, false);
    assert.match((f.skills.use({ name: 'tidy-notes', file: 'assets/logo.png' }) as { note: string }).note, /not text/u);
    assert.throws(() => f.skills.use({ name: 'tidy-notes', file: '../literature-review/SKILL.md' }), /no file called/u);
    assert.throws(() => f.skills.use({ name: 'off-skill' }), /no skill called off-skill that is on/u);
    const next = f.skills.use({ name: 'literature-review', offset: 12_000 }) as { content: string; more: boolean };
    assert.equal(next.more, false);
    assert.doesNotMatch(next.content, /Files in this skill/u);
  } finally { f.close(); }
});

test('The agent tool is offered only while a skill is on, reads through the library, and names the skill on the timeline', async () => {
  const f = library();
  const project = f.store.createProject('Skills');
  const experiments = { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService;
  const toolkit = () => new AgentWorkspaceTools(f.store, {} as ExecutionService, experiments, { projectId: project.id, nodeIds: [], artifactIds: [] }, 'turn-1', 'model', 'Test model');
  try {
    AgentWorkspaceTools.skills = f.skills;
    assert(!toolkit().definitions.some(item => item.name === 'ros_use_skill'));
    f.skills.create({ name: 'tidy-notes', description: 'Tidy messy notes.', body: 'Merge duplicates.' });
    const tools = toolkit();
    const definition = tools.definitions.find(item => item.name === 'ros_use_skill');
    assert(definition);
    assert.deepEqual(Object.keys((definition.inputSchema as { properties: object }).properties), ['name', 'file', 'offset']);
    const first = await tools.call('ros_use_skill', { name: 'tidy-notes' }) as { content: string };
    assert.match(first.content, /Merge duplicates/u);
    assert.match((await tools.call('ros_use_skill', { name: 'tidy-notes' }) as { note: string }).note, /already read/u);
    // No name lists the skills that are on.
    assert.equal((await tools.call('ros_use_skill', {}) as { count: number }).count, 1);

    assert.equal(agentStep(1, 'ros_use_skill', { name: '/tidy-notes' }).target, 'tidy-notes');
    assert.equal(agentStep(2, 'ros_use_skill', { name: 'tidy-notes', file: 'references/a.md' }).target, 'tidy-notes/references/a.md');
    assert.equal(agentStep(3, 'ros_use_skill', {}).target, undefined);
  } finally { AgentWorkspaceTools.skills = undefined; f.close(); }
});

test('Every assistant turn carries the skills: agents get the list and /name calls, chat models only /name calls', async () => {
  const f = library();
  const requests: ModelRequest[] = [], agentRequests: AgentExecuteRequest[] = [];
  const model: ModelAdapter = {
    provider: 'nebius', model: 'offline-skills-fixture', configured: true,
    async prepare() { return { id: this.model, contextTokens: 100000, inputUsdPerToken: 0.0000001, outputUsdPerToken: 0.0000003, capabilities: { structuredOutput: false, toolCalling: false, cancellation: 'abort-request', modelVersion: false }, metadata: { offlineFixture: true } }; },
    async complete(request) { requests.push(structuredClone(request)); return { content: JSON.stringify({ reply: 'Done.', question: null, references: [], memory: [], tools: [] }), model: 'offline-skills-fixture', modelVersion: null, usage: { inputTokens: 10, outputTokens: 10 }, metadata: { offlineFixture: true } }; },
  };
  const runtime: ExecutionBackend = { capabilities: () => ({ available: false, backend: 'docker-python', policy: 'offline', runtime: null, workerHash: 'offline', imageId: null, libraries: {}, enforcement: [], limitations: [], timeoutMs: 1, maxMemoryMb: 1, maxOutputBytes: 1 }), start() { throw new Error('No execution in this fixture.'); } };
  const agent: AgentRuntime = { status: async () => { throw new Error('unused'); }, async execute(request) { agentRequests.push(request); return { reply: 'Agent done.', sessionId: 's', actions: [], requestId: 'r' }; }, async shutdown() {} };
  const execution = new ExecutionService(f.store, { model, limits: { nebius: 5, tavily: 10 }, includeSetupUsage: false });
  const experiments = new ExperimentService(f.store, { sandbox: runtime, sandboxBudget: new SandboxBudget(f.store, {}) });
  const assistant = new AssistantService(f.store, execution, experiments, agent, undefined, undefined, undefined, f.skills);
  const project = f.store.createProject('Skills in turns');
  experiments.authority.configure(project.id, { mode: 'ask' });
  const finished = async () => { for (let i = 0; i < 400; i++) { if (assistant.state(project.id).turns.every(turn => turn.status !== 'running')) return assistant.state(project.id).turns.at(-1)!; await delay(5); } throw new Error('The turn did not finish.'); };
  try {
    f.skills.create({ name: 'tidy-notes', description: 'Tidy messy notes.', body: 'Merge duplicates, then sort by date.' });
    assistant.setBackend(project.id, { backend: 'codex' });
    assistant.start(project.id, { message: 'Clean up my notes' });
    assert.equal((await finished()).status, 'completed');
    assert.match(agentRequests[0]!.preferences!, /<available_skills>\n<skill name="tidy-notes">Tidy messy notes\.<\/skill>/u);
    assert.doesNotMatch(agentRequests[0]!.preferences!, /skill_content/u);
    assistant.start(project.id, { message: '/tidy-notes these ones' });
    await finished();
    assert.match(agentRequests[1]!.preferences!, /<skill_content name="tidy-notes">\nMerge duplicates, then sort by date\./u);

    assistant.setBackend(project.id, { backend: 'provider' });
    assistant.start(project.id, { message: 'No skill here' });
    await finished();
    assert.doesNotMatch(String(requests.at(-1)!.messages[0]!.content), /skill_content|available_skills/u);
    assistant.start(project.id, { message: '/tidy-notes please' });
    await finished();
    const system = String(requests.at(-1)!.messages[0]!.content);
    assert.match(system, /<skill_content name="tidy-notes">\nMerge duplicates, then sort by date\.\n<\/skill_content>/u);
    assert.doesNotMatch(system, /available_skills/u);
  } finally { await assistant.shutdown(); await execution.shutdown(); await experiments.shutdown(); f.close(); }
});

/** A stand-in for GitHub's API and raw file host, recording what each request sent. */
function github(repos: Record<string, Record<string, string>>) {
  const commit = 'c0ffee'.padEnd(40, '0'), calls: { url: string; authorization: string | null }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    const api = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(commits\/[^?]+|git\/trees\/[0-9a-f]+\?recursive=1)$/u.exec(url);
    if (api) {
      const files = repos[api[1]!];
      if (!files) return new Response('{"message":"Not Found"}', { status: 404 });
      return api[2]!.startsWith('commits/') ? Response.json({ sha: commit }) : Response.json({ tree: Object.entries(files).map(([path, text]) => ({ path, type: 'blob', size: Buffer.byteLength(text) })) });
    }
    const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([0-9a-f]{40})\/(.+)$/u.exec(url);
    if (raw && raw[2] === commit) { const text = repos[raw[1]!]?.[decodeURIComponent(raw[3]!)]; return text === undefined ? new Response('missing', { status: 404 }) : new Response(text); }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls, commit };
}

test('GitHub links read a skill folder, or list the skills in a repository, at one commit; the token goes only to GitHub\'s API', async () => {
  const hub = github({ 'acme/skills': {
    'README.md': '# Skills',
    'skills/demo/SKILL.md': skillMd('demo', 'A demo skill.'), 'skills/demo/scripts/run.py': 'print(1)', 'skills/demo/references/notes.md': 'Notes',
    'skills/other/SKILL.md': skillMd('other', 'Another skill.'),
  } });
  const f = library({ fetch: hub.fetcher, githubToken: () => 'token-for-github' });
  try {
    const one = await f.skills.preview({ kind: 'link', url: 'https://github.com/acme/skills/tree/main/skills/demo' });
    assert.equal(one.candidates.length, 1);
    const demo = one.candidates[0]!;
    assert.equal(demo.name, 'demo');
    assert.deepEqual(demo.files.map(file => file.path), ['SKILL.md', 'references/notes.md', 'scripts/run.py']);
    assert.deepEqual(demo.origin, { kind: 'github', repo: 'acme/skills', ref: 'main', commit: hub.commit, path: 'skills/demo' });
    for (const call of hub.calls) assert.equal(call.authorization, call.url.startsWith('https://api.github.com/') ? 'Bearer token-for-github' : null, call.url);

    // A whole repository lists its skills to choose from; each choice reads at the same commit.
    const many = await f.skills.preview({ kind: 'link', url: 'acme/skills' }) as SkillPreview;
    assert.equal(many.draftId, null);
    assert.deepEqual(many.choices.map(choice => choice.name), ['demo', 'other']);
    assert.match(many.note!, /2 skills in acme\/skills/u);
    assert.deepEqual(many.choices[1]!.request, { kind: 'github', repo: 'acme/skills', ref: hub.commit, path: 'skills/other' });
    const chosen = await f.skills.preview(many.choices[1]!.request);
    assert.equal(chosen.candidates[0]!.description, 'Another skill.');
    // A blob link to a SKILL.md reads its folder.
    assert.equal((await f.skills.preview({ kind: 'link', url: 'https://github.com/acme/skills/blob/main/skills/other/SKILL.md' })).candidates[0]!.name, 'other');
    await assert.rejects(f.skills.preview({ kind: 'link', url: 'https://github.com/acme/missing' }), /GitHub has no public repository/u);
    await assert.rejects(f.skills.preview({ kind: 'github', repo: 'acme/skills', path: 'docs' }), /no skills/u);

    const listing = await f.skills.source('anthropic').catch((error: Error) => error);
    assert(listing instanceof Error && /GitHub has no public repository/u.test(listing.message), 'sources read their repository through the same path');
  } finally { f.close(); }
});

test('Links are read only over https from public hosts, a redirect elsewhere drops the token, and published digests are checked', async () => {
  const alpha = skillMd('alpha', 'Alpha from a site.'), digest = `sha256:${createHash('sha256').update(alpha).digest('hex')}`;
  const calls: { url: string; authorization: string | null }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    if (url === 'https://skills.example.com/.well-known/agent-skills/index.json') return Response.json({ $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json', skills: [
      { name: 'alpha', type: 'skill-md', description: 'Alpha from a site.', url: '/.well-known/agent-skills/alpha/SKILL.md', digest },
      { name: 'beta', type: 'skill-md', description: 'Beta.', url: '/.well-known/agent-skills/beta/SKILL.md', digest: `sha256:${'0'.repeat(64)}` },
    ] });
    if (url === 'https://skills.example.com/.well-known/agent-skills/alpha/SKILL.md') return new Response(alpha);
    if (url === 'https://skills.example.com/.well-known/agent-skills/beta/SKILL.md') return new Response(skillMd('beta', 'Beta.'));
    if (url === 'https://api.github.com/repos/acme/moved/commits/HEAD') return new Response(null, { status: 301, headers: { location: 'https://elsewhere.example/moved' } });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const f = library({ fetch: fetcher, githubToken: () => 'token-for-github' });
  try {
    const site = await f.skills.preview({ kind: 'link', url: 'skills.example.com' });
    assert.deepEqual(site.choices.map(choice => choice.name), ['alpha', 'beta']);
    const good = await f.skills.preview(site.choices[0]!.request);
    assert.equal(good.candidates[0]!.description, 'Alpha from a site.');
    await assert.rejects(f.skills.preview(site.choices[1]!.request), /does not match the digest/u);

    for (const url of ['http://skills.example.com/SKILL.md', 'https://127.0.0.1/SKILL.md', 'https://localhost:4310/SKILL.md', 'https://192.168.1.10/pack.zip', 'https://[::1]/SKILL.md', 'https://printer.local/SKILL.md'])
      await assert.rejects(f.skills.preview({ kind: 'link', url }), /only from https links|private network/u, url);
    await assert.rejects(f.skills.preview({ kind: 'link', url: 'https://nothing.example.com/page' }), /No skill was found there/u);

    await assert.rejects(f.skills.preview({ kind: 'github', repo: 'acme/moved' }));
    assert.equal(calls.find(call => call.url === 'https://api.github.com/repos/acme/moved/commits/HEAD')!.authorization, 'Bearer token-for-github');
    assert.equal(calls.find(call => call.url === 'https://elsewhere.example/moved')!.authorization, null);
  } finally { f.close(); }
});
