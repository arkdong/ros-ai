/** How long Claude Code or Codex thinks before it answers. Both take these five levels; each model takes some of them.
 * Codex's own 'ultra' hands work to sub-agents, which ros.ai turns off, so it is not one of them. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];
export const isEffortLevel = (value: unknown): value is EffortLevel => EFFORT_LEVELS.includes(value as EffortLevel);
/** Each level in the person's words, the same for both agents. */
export const EFFORT_NAMES: Record<EffortLevel, { label: string; detail: string }> = {
  low: { label: 'Low', detail: 'Quick answers with light thinking' },
  medium: { label: 'Medium', detail: 'Balanced speed and depth' },
  high: { label: 'High', detail: 'Thinks longer on complex questions' },
  xhigh: { label: 'Extra high', detail: 'Deeper thinking for hard problems' },
  max: { label: 'Max', detail: 'Thinks as long as it needs; slowest' },
};
/** A model Claude Code or Codex can run on, named the way the agent names it, with the effort levels it takes and the one it starts on.
 * A model that takes no effort level has none and a null default. */
export type AgentModel = { id: string; label: string; detail: string; efforts: EffortLevel[]; defaultEffort: EffortLevel | null };
/** The model and effort one of the four agents ros.ai runs (IN_APP_AGENTS) works with in every project, and the models it offers.
 * models is empty while the agent's own list is unknown, as before Codex is installed; model and effort are then null. */
export type AgentModelChoice = { model: string | null; effort: EffortLevel | null; models: AgentModel[] };
/** "Opus 5.5 · High": what the chip beside the agent says, and what a finished turn names. */
export function modelEffortLabel(choice: AgentModelChoice): string | null {
  const model = choice.models.find(item => item.id === choice.model);
  if (!model) return choice.model;
  return choice.effort ? `${model.label} · ${EFFORT_NAMES[choice.effort].label}` : model.label;
}
/** The level a model runs a wanted level at: the highest it takes at or below it, as Claude Code itself does, or its own default. */
export function effortFor(model: AgentModel, wanted: EffortLevel | null | undefined): EffortLevel | null {
  if (!model.efforts.length) return null;
  if (!wanted) return model.defaultEffort;
  const at = EFFORT_LEVELS.indexOf(wanted);
  return [...model.efforts].reverse().find(level => EFFORT_LEVELS.indexOf(level) <= at) ?? model.defaultEffort;
}
