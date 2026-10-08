import { Bot, LoaderCircle, Search as SearchIcon, Wrench } from 'lucide-react';
import type { AssistantTurn } from '../shared/assistant';
import type { CanvasNode, ProjectDetail } from '../shared/types';
import { RichText, time } from './Content';
import { KindIcon } from './Canvas';
import './agent-view.css';

const status = { running: 'Working', completed: 'Finished', failed: 'Stopped with an error', cancelled: 'Stopped', interrupted: 'Interrupted' } as const;
const toolName = (message: string) => /requested (ros_[a-z_]+)/.exec(message)?.[1];
const toolLabel: Record<string, string> = { ros_fan_out_search: 'Planned web searches', ros_write_result: 'Wrote a result', ros_propose_canvas: 'Proposed canvas changes', ros_propose_analysis: 'Proposed analysis code', ros_propose_report: 'Proposed a report', ros_propose_reuse: 'Proposed reusing a result', ros_read_selected: 'Read the selection' };

/** One agent's turn: what it set out to do, why it made each tool call, and what it left on the canvas. */
export function AgentView({ node, turn, detail, onOpenNode }: { node: CanvasNode; turn?: AssistantTurn; detail: ProjectDetail; onOpenNode: (id: string) => void }) {
  const made = detail.project.canvas.connections.filter(edge => edge.source === node.id).flatMap(edge => { const target = detail.project.canvas.nodes.find(item => item.id === edge.target); return target ? [{ edge, target }] : []; });
  // Thoughts and tool calls make the timeline; "returned a validated result" lines repeat the call.
  const steps = (turn?.events ?? []).filter(event => event.kind === 'thought' || (event.kind === 'tool' && toolName(event.message)));
  return <div className="agent-view">
    <header>
      <span className="agent-avatar"><Bot size={18}/></span>
      <div><strong>{node.title}</strong><small>{turn ? `${status[turn.status]} · ${turn.model ?? (node.agent?.runtime === 'claude' ? 'Claude Code' : 'Codex')}` : 'This agent’s turn is no longer in the assistant history.'}</small></div>
      {turn?.status === 'running' && <LoaderCircle size={16} className="spin"/>}
    </header>
    {node.description && <p className="agent-goal">{node.description}</p>}
    {turn && <section><h4>What it did</h4>
      {steps.length ? <ol className="agent-timeline">{steps.map((event, index) => event.kind === 'thought'
        ? <li key={index} className="agent-step-thought"><span>“{event.message}”</span></li>
        : <li key={index} className="agent-step-tool"><Wrench size={13}/><span>{toolLabel[toolName(event.message)!] ?? toolName(event.message)}</span><time>{time(event.at)}</time></li>)}</ol>
        : <p className="subtle">No tool calls yet.</p>}
    </section>}
    {made.length > 0 && <section><h4>On the canvas</h4><ul className="agent-made">{made.map(({ edge, target }) => <li key={edge.id}><button onClick={() => onOpenNode(target.id)}><KindIcon kind={target.kind} blockType={target.blockType}/>{target.title}</button>{edge.label && <small>{edge.label}</small>}</li>)}</ul></section>}
    {turn?.reply && <section><h4>Answer</h4><RichText text={turn.reply}/></section>}
    {turn?.error && <p className="agent-error">{turn.error}</p>}
    {!turn && <p className="subtle"><SearchIcon size={12}/> The blocks it made stay on the canvas.</p>}
  </div>;
}
