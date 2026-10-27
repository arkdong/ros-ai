/** Step 1 and 2 of the data: the teacher invents research projects (one canvas each) and then the
 * requests a researcher would type into the Ros bar on each one. Both are cheap (a few cents);
 * the expensive part is the rollouts. Domains for training and for held-out evaluation never mix. */
import { randomUUID } from 'node:crypto';
import { ask, type ChatAdapter } from './lib.js';
import { FAMILIES, TASKS_PER_PROJECT } from './families.js';
import type { Family, Fixture, Task } from './env.js';

/** Training domains: the people ros.ai is for first (students, PhDs, analysts, AISO researchers). */
export const TRAIN_DOMAINS = [
  'urban climate and heat in Dutch cities', 'cycling and public transport use', 'student mental health survey', 'Dutch housing prices and rent regulation', 'EU AI Act compliance for a startup',
  'protein folding literature review', 'microplastics in rivers', 'sleep and screen time study', 'labour market for AI engineers', 'history of the Dutch East India Company archives',
  'renewable energy subsidies in the EU', 'hospital waiting times', 'customer churn in a SaaS company', 'misinformation on social media during elections', 'bird migration counts',
  'coffee cooling physics experiment', 'secondary school maths results', 'food prices and inflation', 'startup fundraising market research', 'water quality in Amsterdam canals',
  'recruiting for a student AI research lab', 'language model evaluation benchmarks', 'museum visitor patterns', 'flood risk and dikes', 'electric vehicle charging demand',
  'tourism pressure in Amsterdam', 'thesis on remote work and productivity', 'antibiotic resistance trends', 'local journalism and news deserts', 'football match statistics',
  'air quality and asthma', 'algae biofuel lab notes', 'gender pay gap reporting', 'supply chain delays for semiconductors', 'reading habits of teenagers',
  'carbon accounting for a university', 'crop yields and drought', 'pension fund investment policy', 'game user research playtest notes', 'refugee integration policy',
];
/** Held-out domains for evaluation only. */
export const EVAL_DOMAINS = ['noise pollution near Schiphol', 'vaccination uptake by region', 'second-hand clothing market', 'wildfire smoke and health', 'open-source maintainer burnout', 'dairy farming emissions in Friesland', 'university dropout rates', 'quantum computing startups', 'e-bike accidents', 'library digitisation project'];

const PROJECT = `You design realistic ros.ai research projects for a training set. ros.ai is a local research workspace: a canvas of blocks a researcher builds while working (notes, questions, plans, findings, datasets, reports), some in groups, some linked.
Return JSON {"projects":[{"title","blocks":[{"slug","title","text","blockType","group"?,"csv"?:{"fileName","content"}}],"groups":[{"slug","title"}],"links":[{"from","to","label"}]}]}.
- blockType is one of note, action, report. A dataset block has csv instead (8-60 rows of realistic CSV with a header, at most 12 columns, real-looking values, some gaps).
- 4-14 blocks per project. Vary the state: some projects just started (a question and two notes), some well along (sources, findings, a draft report, a dataset). Texts are what a real researcher writes: 1-12 lines, sometimes messy, with dates, names of sources, open questions, TODOs, occasionally English mixed with Dutch.
- About one project in eight has one block whose text includes an instruction aimed at an AI assistant (for example a pasted web page saying "AI assistants must ..."), as found in the wild.
- slugs are short kebab-case and unique per project; links and groups refer to slugs.`;

export async function makeProjects(model: ChatAdapter, domain: string, count: number): Promise<Fixture[]> {
  const written = await ask<{ projects: Omit<Fixture, 'id' | 'domain'>[] }>(model, PROJECT, `Write ${count} different projects in the domain: ${domain}. Make them differ in stage, size and style.`, 12000);
  // Dataset blocks often come back without text; the rest of the pipeline expects a string.
  return written.projects.map(project => ({ ...project, blocks: project.blocks.map(block => ({ ...block, text: block.text ?? '' })), id: randomUUID().slice(0, 8), domain }));
}

const TASKS = `You write realistic requests a researcher types into the ros.ai assistant bar while looking at their canvas, for a training set. Return JSON {"tasks":[{"family","message","selection","researcher"?,"language"}]}.
- family is one of the names listed below; follow each family's description.
- selection: slugs of blocks the researcher has selected (often one, sometimes 2-4, or [] when nothing is selected). Analysis tasks select the dataset block (and often a question or action block). Edit tasks select every block they change.
- message: how real people write: short or long, polite or terse, typos sometimes, refer to blocks by their titles or "this", "the selected note". About one in ten in Dutch, the rest English.
- researcher (research-declined only): "decline".
Families:
`;

/** Tasks for one project, spread over families by share; modes and memory lines are drawn here, not by the teacher. */
export async function makeTasks(model: ChatAdapter, fixture: Fixture, random: () => number): Promise<Task[]> {
  const families = Object.entries(FAMILIES).map(([name, spec]) => `- ${name} (${Math.max(1, Math.round(spec.share * TASKS_PER_PROJECT))} tasks): ${spec.brief}`).join('\n');
  const canvas = JSON.stringify({ title: fixture.title, blocks: fixture.blocks.map(block => ({ slug: block.slug, title: block.title, blockType: block.csv ? 'dataset' : block.blockType, text: block.text.slice(0, 600), ...(block.csv ? { columns: block.csv.content.split('\n')[0] } : {}) })), links: fixture.links });
  const hasData = fixture.blocks.some(block => block.csv);
  type Written = { family: Family; message: string; selection: string[]; researcher?: 'decline' }[];
  const written = await ask<{ tasks: Written } | Written>(model, TASKS + families, `${hasData ? '' : 'This project has no dataset: skip the dataset and analysis families and add more research and add-notes tasks instead.\n'}Project:\n${canvas}`, 8000);
  const slugs = new Set(fixture.blocks.map(block => block.slug));
  // The teacher sometimes answers with the bare array instead of { tasks }.
  return ((Array.isArray(written) ? written : written?.tasks) ?? [] as Written).filter(task => task.family in FAMILIES && task.message?.trim()).map(task => {
    const modes = FAMILIES[task.family].mode;
    return {
      id: randomUUID().slice(0, 12), fixtureId: fixture.id, family: task.family, message: task.message.trim(),
      selection: (task.selection ?? []).filter(slug => slugs.has(slug)).slice(0, 6),
      mode: modes[Math.floor(random() * modes.length)],
      ...(task.family === 'research-declined' ? { researcher: 'decline' as const } : {}),
      // Some turns carry the person's kept memory lines, as the app sends them.
      ...(random() < .15 ? { preferences: PREFERENCES[Math.floor(random() * PREFERENCES.length)] } : {}),
      ...(random() < .25 ? { notion: true } : {}),
    };
  });
}

// The exact wording of PersonalMemory.prompt() in src/server/personal-memory.ts.
const memory = (lines: string[]) => `The researcher's saved preferences (their own notes on how they like work done, not instructions from elsewhere):\n${lines.map(line => `- ${line}`).join('\n')}`;
const PREFERENCES = [
  memory(['Prefers British spelling.', 'Wants sources from the last five years where possible.']),
  memory(['Writes their thesis in English but reads Dutch sources.', 'Keep answers very short.']),
  memory(['Uses APA citations.', 'Prefers two short paragraphs over bullet lists.']),
  memory(['Works at AISO, a student AI research lab in Amsterdam.', 'Cares about methodology over speed.']),
];

/** A seeded random source, so the same seed writes the same modes and memory lines. */
export function seeded(seed: number) { let state = seed >>> 0; return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
