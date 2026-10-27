/** Skills: the person's saved ways of working, in the Agent Skills format (agentskills.io) that Claude Code,
 * Codex, OpenCode, Gemini CLI and most other agents share: a folder holding a SKILL.md (a name, one line on
 * when to use it, and instructions) plus optional scripts, references and assets. ros.ai keeps one library
 * and gives it to every agent the same way: the names and descriptions in each turn, the full text when an
 * agent asks for it, or at once when the person calls one with /name. */

/** The standard's name rule: lowercase letters, digits and single hyphens, at most 64 characters. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const SKILL_LIMITS = { name: 64, description: 1024, compatibility: 500, files: 200, bytes: 10 * 1024 * 1024, fileBytes: 2 * 1024 * 1024, skillMd: 256 * 1024, archive: 12 * 1024 * 1024, text: 60_000 };

/** Where a skill came from, kept so its page can say so and an update can be checked. */
export type SkillOrigin =
  | { kind: 'written' }
  | { kind: 'pasted' }
  | { kind: 'file'; filename: string }
  | { kind: 'folder'; tool: string; path: string }
  | { kind: 'github'; repo: string; ref: string; commit: string; path: string }
  | { kind: 'link'; url: string }
  | { kind: 'found' };

export type SkillFileKind = 'skill' | 'script' | 'reference' | 'asset' | 'other';
export type SkillFile = { path: string; bytes: number; kind: SkillFileKind; text: boolean };

export type SkillSummary = {
  name: string; title: string; description: string; enabled: boolean;
  /** false when the skill opts out of being picked by agents (disable-model-invocation): only /name uses it. */
  automatic: boolean;
  /** false when the skill hides itself from the / menu (user-invocable: false). */
  menu: boolean;
  origin: SkillOrigin; license?: string; files: number; scripts: number; bytes: number;
  addedAt: string; updatedAt: string; warnings: string[];
};
export type SkillDetail = SkillSummary & { body: string; compatibility?: string; fileList: SkillFile[]; folder: string };

/** A skill read from somewhere, shown in full before it is added. */
export type SkillCandidate = {
  name: string; title: string; description: string; license?: string; compatibility?: string;
  files: SkillFile[]; bytes: number; scripts: number; skillMd: string; warnings: string[];
  /** Whether the library already holds a skill of this name, and whether it is the same. */
  existing: 'same' | 'different' | null; origin: SkillOrigin;
};

/** Ways to read a skill before adding it. */
export type SkillPreviewRequest =
  | { kind: 'text'; text: string; name?: string; description?: string }
  | { kind: 'link'; url: string; digest?: string }
  | { kind: 'github'; repo: string; ref?: string; path?: string }
  | { kind: 'file'; filename: string; data: string }
  | { kind: 'found'; key: string };

/** One of several skills found at a link or in a source; preview its request to review it. */
export type SkillChoice = { name: string; title: string; description: string; request: SkillPreviewRequest };
export type SkillPreview = { draftId: string | null; candidates: SkillCandidate[]; choices: SkillChoice[]; note?: string };

/** A skill in another tool's folder on this computer, or in a project's folder. */
export type FoundSkill = { key: string; tool: string; toolLabel: string; folder: string; name: string; title: string; description: string; added: 'same' | 'different' | null };

export type SkillSource = { id: string; label: string; repo: string; about: string };
export type SkillSourceListing = { source: SkillSource; commit: string; checkedAt: string; entries: SkillChoice[] };

export type SkillsState = { skills: SkillSummary[]; folder: string };

/** Curated places to browse; each is a public GitHub repository read at its latest commit. */
export const SKILL_SOURCES: SkillSource[] = [
  { id: 'anthropic', label: 'Anthropic', repo: 'anthropics/skills', about: 'Anthropic\'s example skills: documents, design, writing and making skills. Each has its own licence.' },
  { id: 'openai', label: 'OpenAI', repo: 'openai/plugins', about: 'Skills inside the plugins OpenAI publishes for Codex.' },
  { id: 'k-dense', label: 'Scientific', repo: 'K-Dense-AI/scientific-agent-skills', about: 'K-Dense\'s research skills: databases, statistics, bioinformatics and scientific writing. MIT licence.' },
];

/** A name that can be a folder and a /command: the standard's characters, at most 64 of them. */
export function normalizeName(raw: string): string {
  return raw.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, SKILL_LIMITS.name).replace(/-+$/u, '') || 'skill';
}

const ACRONYMS = new Set(['ai', 'api', 'csv', 'css', 'docx', 'gh', 'html', 'json', 'llm', 'mcp', 'pdf', 'pptx', 'pr', 'sql', 'ui', 'url', 'ux', 'xlsx', 'xml', 'yaml', 'ios', 'seo', 'rna', 'dna', 'nmr']);
/** "literature-review" reads as "Literature review"; known abbreviations stay in capitals. */
export function skillTitle(name: string): string {
  const words = name.split('-').filter(Boolean).map(word => ACRONYMS.has(word) ? word.toUpperCase() : word);
  const text = words.join(' ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : name;
}
