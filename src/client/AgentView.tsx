import { BookOpen, BookOpenText, BookText, Bot, ExternalLink, FileText, FolderClosed, GitBranch, LayoutGrid, LoaderCircle, Quote, Search as SearchIcon, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AssistantTurn } from '../shared/assistant';
import type { AgentStep } from '../shared/agent-runtime';
import type { Artifact, CanvasNode, ProjectDetail } from '../shared/types';
import { agentDirections, type AgentDirection } from '../shared/agent-work';
import { skillTitle } from '../shared/skills';
import { RichText, time } from './Content';
import './agent-view.css';

const status = { running: 'Working', completed: 'Finished', failed: 'Stopped with an error', cancelled: 'Stopped', interrupted: 'Interrupted' } as const;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./u, ''); } catch { return url; } };
type Step = { at: string; tool: string; outcome: AgentStep['outcome']; target?: string; size?: number; items?: string[]; proposalId?: string; skipped?: number; thought?: string; error?: string };

/** Pairs each tool call with the sentence the agent wrote before it and with what came of it. */
export function agentSteps(turn: AssistantTurn): Step[] {
  const steps: Step[] = [], byCall = new Map<number, Step>();
  let thought: string | undefined;
  for (const event of turn.events) {
    if (event.kind === 'thought') { thought = event.message; continue; }
    if (event.kind !== 'tool') continue;
    if (event.step) {
      const known = byCall.get(event.step.call);
      if (known) {
        // A result says how many things the call covered, what it made and the proposal it left.
        const { outcome, size, items, proposalId, skipped } = event.step;
        Object.assign(known, { outcome }, size === undefined ? {} : { size }, items ? { items } : {}, proposalId ? { proposalId } : {}, skipped ? { skipped } : {});
        if (outcome === 'failed') known.error = event.message;
        continue;
      }
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
  const count = (word: string) => step.size === undefined ? `${word}s` : plural(step.size, word);
  const searches = step.size ? plural(step.size, 'direction') : 'the planned directions';
  if (step.tool === 'ros_fan_out_search') return step.outcome === 'requested' ? `Planning searches in ${searches}` : step.outcome === 'waiting' ? `Planned searches in ${searches} · waiting for your approval` : step.outcome === 'declined' ? 'Search plan declined' : step.outcome === 'failed' ? 'Search plan failed' : `Searched ${searches}`;
  if (step.tool === 'ros_write_result') return step.outcome === 'failed' ? 'Could not write a result note' : step.outcome === 'requested' ? 'Writing a result note' : 'Wrote a result note';
  if (step.tool === 'ros_read_pages') return step.outcome === 'failed' ? 'Could not read the pages' : step.outcome === 'requested' ? `Reading ${count('page')} in full` : `Read ${count('page')} in full`;
  if (step.tool === 'ros_write_findings') return step.outcome === 'failed' ? 'Could not save the findings' : step.outcome === 'requested' ? `Saving ${count('finding')}` : step.size === 0 ? 'Saved no findings' : `Saved ${count('finding')}`;
  if (step.tool === 'ros_propose_groups') return step.outcome === 'requested' ? 'Grouping the findings by theme' : step.outcome === 'waiting' ? `Proposed ${step.size ? plural(step.size, 'theme') : 'a grouping'} · waiting for your review` : step.outcome === 'declined' ? 'Grouping declined' : step.outcome === 'failed' ? 'Grouping failed' : step.size ? `Grouped the findings into ${plural(step.size, 'theme')}` : 'Set weak results aside';
  if (step.tool === 'ros_use_skill') {
    // The target is the skill's name, or "name/path" when the agent read one of the skill's files.
    const [name, ...path] = (step.target ?? '').split('/'), skill = name ? `the ${skillTitle(name)} skill` : '', file = path.join('/');
    if (!skill) return step.outcome === 'failed' ? 'Could not list your skills' : step.outcome === 'requested' ? 'Listing your skills' : 'Listed your skills';
    if (file) return step.outcome === 'failed' ? `Could not read ${file} from ${skill}` : step.outcome === 'requested' ? `Reading ${file} from ${skill}` : `Read ${file} from ${skill}`;
    return step.outcome === 'failed' ? `Could not read ${skill}` : step.outcome === 'requested' ? `Reading ${skill}` : `Follows ${skill}`;
  }
  if (step.tool === 'ros_propose_canvas') return step.outcome === 'waiting' ? 'Proposed canvas changes · waiting for your review' : step.outcome === 'declined' ? 'Canvas changes declined' : step.outcome === 'failed' ? 'Canvas changes failed' : step.outcome === 'requested' ? 'Proposing canvas changes' : 'Changed the canvas';
  const labels: Record<string, string> = { ros_read_selected: 'Read the selected blocks', ros_propose_analysis: 'Proposed analysis code', ros_propose_report: 'Proposed a report', ros_propose_reuse: 'Proposed reusing a result' };
  return labels[step.tool] ?? title(step.target) ?? step.tool;
}
const icons: Record<string, ReactNode> = { ros_fan_out_search: <SearchIcon size={13}/>, ros_write_result: <BookOpen size={13}/>, ros_read_pages: <BookOpenText size={13}/>, ros_write_findings: <Quote size={13}/>, ros_propose_groups: <LayoutGrid size={13}/>, ros_propose_canvas: <GitBranch size={13}/>, ros_read_selected: <FileText size={13}/>, ros_propose_report: <FileText size={13}/>, ros_use_skill: <BookText size={13}/> };

type Props = { node: CanvasNode; turn?: AssistantTurn; detail: ProjectDetail; onOpenNode: (id: string) => void; onReveal: (id: string) => void; onOpenArtifact: (artifact: Artifact) => void; onReview: (proposalId: string) => void };
/** One agent's turn: what it set out to do, each step with the agent's reason and what came of it, and its answer. */
export function AgentView({ node, turn, detail, onOpenNode, onReveal, onOpenArtifact, onReview }: Props) {
  const canvas = detail.project.canvas, title = (id?: string) => canvas.nodes.find(item => item.id === id)?.title;
  const work = agentDirections(canvas, detail.artifacts, node.id);
  const runtime = turn?.model ?? (node.agent?.runtime === 'claude' ? 'Claude Code' : node.agent?.runtime === 'model' ? 'Agent' : 'Codex');
  const running = turn?.status === 'running';
  // A proposal the agent left behind is decided after its turn ends, so its step shows the decision.
  // A search plan approved too late searched nothing, so its step keeps what the agent saw.
  const decided = (step: Step): Step => {
    const proposal = step.tool === 'ros_fan_out_search' ? undefined : detail.proposals.find(item => item.id === step.proposalId);
    return proposal ? { ...step, outcome: proposal.status === 'accepted' ? 'done' : proposal.status === 'dismissed' ? 'declined' : 'waiting' } : step;
  };
  // Each finished search plan lists the directions it added, in the order the canvas holds them.
  let next = 0, shownTime = '';
  const steps = (turn ? agentSteps(turn) : []).map(decided).map(step => {
    const directions = step.tool === 'ros_fan_out_search' && step.outcome === 'done' ? work.directions.slice(next, step.size ? next + step.size : undefined) : [];
    next += directions.length;
    const stamp = time(step.at), at = stamp === shownTime ? undefined : stamp;
    shownTime = stamp;
    return { step, directions, at };
  });
  const unlisted = work.directions.slice(next);
  // A demo's agent block holds a run recorded while the demo was prepared, not a turn of this assistant.
  const recorded = detail.artifacts.some(item => item.metadata?.tutorialOrigin === 'recorded' && (item.nodeId === node.id || work.directions.some(({ result, legacySearch }) => result.id === item.nodeId || legacySearch?.id === item.nodeId)));
  const directionList = (list: AgentDirection[]) => <ul className="agent-items">{list.map(({ result, legacySearch, sources, written, findings }) => <li key={result.id}>
    <button onClick={() => onOpenNode(result.id)}><SearchIcon size={13}/><span>{legacySearch?.title ?? result.title}</span></button>
    <small>{plural(sources, 'source')}{findings.length ? ` · ${plural(findings.length, 'finding')}` : ''}{!written && !running ? ' · no note written' : ''}</small>
  </li>)}</ul>;
  // Pages read in full: their saved text, with the original page beside it.
  const pageList = (pages: Artifact[]) => pages.length > 0 && <ul className="agent-items">{pages.map(page => <li key={page.id}>
    <button onClick={() => onOpenArtifact(page)} title="Read the saved text"><FileText size={13}/><span>{page.title}</span></button>
    {page.url && <a href={page.url} target="_blank" rel="noreferrer" title="Open the original page">{host(page.url)}<ExternalLink size={11}/></a>}
  </li>)}</ul>;
  // What a step made: the pages it read, the findings it saved, or the groups it proposed.
  const made = (step: Step) => {
    if (step.tool === 'ros_read_pages') return pageList((step.items ?? []).flatMap(id => detail.artifacts.filter(item => item.id === id)));
    if (step.tool === 'ros_write_findings') {
      const findings = (step.items ?? []).flatMap(id => canvas.nodes.filter(item => item.id === id));
      return findings.length > 0 && <ul className="agent-items">{findings.map(finding => <li key={finding.id}><button onClick={() => onOpenNode(finding.id)}><Quote size={13}/><span>{finding.title}</span></button></li>)}</ul>;
    }
    const proposal = step.tool === 'ros_propose_groups' ? detail.proposals.find(item => item.id === step.proposalId) : undefined;
    if (!proposal) return null;
    const groups = proposal.operations.flatMap(operation => operation.type === 'addNode' && operation.node.kind === 'group' ? [operation.node] : []);
    const members = (id: string) => proposal.operations.filter(operation => operation.type === 'updateNode' && operation.patch.parentId === id).length;
    return groups.length > 0 && <ul className="agent-items">{groups.map(group => {
      const label = <><FolderClosed size={13}/><span>{group.title}</span></>;
      return <li key={group.id}>{proposal.status === 'accepted' && title(group.id) ? <button onClick={() => onReveal(group.id)}>{label}</button> : <span className="agent-item-text">{label}</span>}<small>{plural(members(group.id), 'block')}</small></li>;
    })}</ul>;
  };
  return <div className="agent-view">
    <header>
      <span className="agent-avatar"><Bot size={18}/></span>
      <div><strong>{runtime}</strong><small>{turn ? `${status[turn.status]} · ${time(turn.updatedAt)}` : recorded ? 'A recorded run' : 'This turn is no longer in the assistant history.'}{work.directions.length ? ` · ${plural(work.directions.length, 'direction')} · ${plural(work.sources, 'source')}` : ''}{work.findings ? ` · ${plural(work.findings, 'finding')}` : ''}</small></div>
      {running && <LoaderCircle size={16} className="spin"/>}
      <button className="secondary small" onClick={() => onReveal(node.id)}>Show on canvas</button>
    </header>
    {node.description && <div className="agent-goal"><RichText text={node.description}/></div>}
    {steps.length > 0 && <section><div className="agent-section-title">Steps</div>
      <ol className="agent-steps">{steps.map(({ step, directions, at }, index) => <li key={index} className={`agent-step ${step.outcome}`}>
        <span className="agent-step-icon">{step.outcome === 'requested' && running ? <LoaderCircle size={13} className="spin"/> : icons[step.tool] ?? <Wrench size={13}/>}</span>
        <div>
          <div className="agent-step-label"><span>{stepLabel(step, title)}</span>{step.tool === 'ros_write_result' && title(step.target) && <button className="agent-step-target" onClick={() => onOpenNode(step.target!)}>{title(step.target)}</button>}{at && <time>{at}</time>}</div>
          {step.thought && <p className="agent-step-thought">{step.thought}</p>}
          {directions.length > 0 && directionList(directions)}
          {made(step)}
          {step.skipped ? <p className="agent-step-note">{plural(step.skipped, 'quote')} did not match {step.skipped === 1 ? 'its' : 'their'} page word for word and {step.skipped === 1 ? 'was' : 'were'} not saved.</p> : null}
          {step.outcome === 'waiting' && step.proposalId && step.tool !== 'ros_fan_out_search' && <button className="secondary small agent-step-review" onClick={() => onReview(step.proposalId!)}>Review</button>}
          {step.error && <p className="agent-step-error">{step.error}</p>}
        </div>
      </li>)}</ol>
    </section>}
    {unlisted.length > 0 && <section><div className="agent-section-title">Directions</div>{directionList(unlisted)}</section>}
    {!steps.some(({ step }) => step.tool === 'ros_read_pages') && work.pages.length > 0 && <section><div className="agent-section-title">Pages read in full</div>{pageList(work.pages)}</section>}
    {turn?.reply && !running && <section><div className="agent-section-title">Answer</div><RichText text={turn.reply}/></section>}
    {turn?.error && <p className="agent-error">{turn.error}</p>}
  </div>;
}
