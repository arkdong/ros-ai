import { BookOpen, Bot, FileText, GitBranch, LoaderCircle, Search as SearchIcon, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AssistantTurn } from '../shared/assistant';
import type { AgentStep } from '../shared/agent-runtime';
import type { CanvasNode, ProjectDetail } from '../shared/types';
import { agentDirections, type AgentDirection } from '../shared/agent-work';
import { RichText, time } from './Content';
import './agent-view.css';

const status = { running: 'Working', completed: 'Finished', failed: 'Stopped with an error', cancelled: 'Stopped', interrupted: 'Interrupted' } as const;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
type Step = { at: string; tool: string; outcome: AgentStep['outcome']; target?: string; size?: number; thought?: string; error?: string };

/** Pairs each tool call with the sentence the agent wrote before it and with what came of it. */
export function agentSteps(turn: AssistantTurn): Step[] {
  const steps: Step[] = [], byCall = new Map<number, Step>();
  let thought: string | undefined;
  for (const event of turn.events) {
    if (event.kind === 'thought') { thought = event.message; continue; }
    if (event.kind !== 'tool') continue;
    if (event.step) {
      const known = byCall.get(event.step.call);
      if (known) { known.outcome = event.step.outcome; if (event.step.outcome === 'failed') known.error = event.message; continue; }
      const step: Step = { at: event.at, tool: event.step.tool, outcome: event.step.outcome, target: event.step.target, size: event.step.size, thought };
      byCall.set(event.step.call, step); steps.push(step); thought = undefined;
    } else {
      // Turns saved before steps were recorded only name the tool.
      const tool = /requested (ros_[a-z_]+)/u.exec(event.message)?.[1];
      if (tool) { steps.push({ at: event.at, tool, outcome: turn.status === 'running' ? 'requested' : 'done', thought }); thought = undefined; }
      else if (!/returned a validated result/u.test(event.message) && steps.length) Object.assign(steps.at(-1)!, { outcome: 'failed', error: event.message });
    }
  }
  return steps;
}

function stepLabel(step: Step, title: (id?: string) => string | undefined): string {
  const searches = step.size ? plural(step.size, 'direction') : 'the planned directions';
  if (step.tool === 'ros_fan_out_search') return step.outcome === 'requested' ? `Planning searches in ${searches}` : step.outcome === 'waiting' ? `Planned searches in ${searches} · waiting for your approval` : step.outcome === 'declined' ? 'Search plan declined' : step.outcome === 'failed' ? 'Search plan failed' : `Searched ${searches}`;
  if (step.tool === 'ros_write_result') return step.outcome === 'failed' ? 'Could not write a result note' : step.outcome === 'requested' ? 'Writing a result note' : 'Wrote a result note';
  if (step.tool === 'ros_propose_canvas') return step.outcome === 'waiting' ? 'Proposed canvas changes · waiting for your review' : step.outcome === 'declined' ? 'Canvas changes declined' : step.outcome === 'failed' ? 'Canvas changes failed' : step.outcome === 'requested' ? 'Proposing canvas changes' : 'Changed the canvas';
  const labels: Record<string, string> = { ros_read_selected: 'Read the selected blocks', ros_propose_analysis: 'Proposed analysis code', ros_propose_report: 'Proposed a report', ros_propose_reuse: 'Proposed reusing a result' };
  return labels[step.tool] ?? title(step.target) ?? step.tool;
}
const stepIcon = (tool: string): ReactNode => tool === 'ros_fan_out_search' ? <SearchIcon size={13}/> : tool === 'ros_write_result' ? <BookOpen size={13}/> : tool === 'ros_propose_canvas' ? <GitBranch size={13}/> : tool === 'ros_read_selected' || tool === 'ros_propose_report' ? <FileText size={13}/> : <Wrench size={13}/>;

/** One agent's turn: what it set out to do, each step with the agent's reason and what came of it, and its answer. */
export function AgentView({ node, turn, detail, onOpenNode, onReveal }: { node: CanvasNode; turn?: AssistantTurn; detail: ProjectDetail; onOpenNode: (id: string) => void; onReveal: (id: string) => void }) {
  const canvas = detail.project.canvas, title = (id?: string) => canvas.nodes.find(item => item.id === id)?.title;
  const work = agentDirections(canvas, detail.artifacts, node.id);
  const runtime = turn?.model ?? (node.agent?.runtime === 'claude' ? 'Claude Code' : 'Codex');
  const running = turn?.status === 'running';
  // Each finished search plan lists the directions it added, in the order the canvas holds them.
  let next = 0, shownTime = '';
  const steps = (turn ? agentSteps(turn) : []).map(step => {
    const directions = step.tool === 'ros_fan_out_search' && step.outcome === 'done' ? work.directions.slice(next, step.size ? next + step.size : undefined) : [];
    next += directions.length;
    const stamp = time(step.at), at = stamp === shownTime ? undefined : stamp;
    shownTime = stamp;
    return { step, directions, at };
  });
  const unlisted = work.directions.slice(next);
  const directionList = (list: AgentDirection[]) => <ul className="agent-directions">{list.map(({ search, sources, written }) => <li key={search.id}>
    <button onClick={() => onOpenNode(search.id)}><SearchIcon size={13}/><span>{search.title}</span></button>
    <small>{plural(sources, 'source')}{!written && !running ? ' · no note written' : ''}</small>
  </li>)}</ul>;
  return <div className="agent-view">
    <header>
      <span className="agent-avatar"><Bot size={18}/></span>
      <div><strong>{runtime}</strong><small>{turn ? `${status[turn.status]} · ${time(turn.updatedAt)}` : 'This turn is no longer in the assistant history.'}{work.directions.length ? ` · ${plural(work.directions.length, 'direction')} · ${plural(work.sources, 'source')}` : ''}</small></div>
      {running && <LoaderCircle size={16} className="spin"/>}
      <button className="secondary small" onClick={() => onReveal(node.id)}>Show on canvas</button>
    </header>
    {node.description && <div className="agent-goal"><RichText text={node.description}/></div>}
    {steps.length > 0 && <section><div className="agent-section-title">Steps</div>
      <ol className="agent-steps">{steps.map(({ step, directions, at }, index) => <li key={index} className={`agent-step ${step.outcome}`}>
        <span className="agent-step-icon">{step.outcome === 'requested' && running ? <LoaderCircle size={13} className="spin"/> : stepIcon(step.tool)}</span>
        <div>
          <div className="agent-step-label"><span>{stepLabel(step, title)}</span>{step.tool === 'ros_write_result' && title(step.target) && <button className="agent-step-target" onClick={() => onOpenNode(step.target!)}>{title(step.target)}</button>}{at && <time>{at}</time>}</div>
          {step.thought && <p className="agent-step-thought">{step.thought}</p>}
          {directions.length > 0 && directionList(directions)}
          {step.error && <p className="agent-step-error">{step.error}</p>}
        </div>
      </li>)}</ol>
    </section>}
    {unlisted.length > 0 && <section><div className="agent-section-title">Directions</div>{directionList(unlisted)}</section>}
    {turn?.reply && !running && <section><div className="agent-section-title">Answer</div><RichText text={turn.reply}/></section>}
    {turn?.error && <p className="agent-error">{turn.error}</p>}
  </div>;
}
