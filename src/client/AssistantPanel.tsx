import { ResearchRing } from './Brand';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, ArrowUp, BookOpen, Check, Search, ChevronRight, CircleHelp, FileText, Focus, GitBranch, LoaderCircle, Quote, RotateCcw, ShieldCheck, Square, X } from 'lucide-react';
import type { AssistantAction, AssistantBackend, AssistantFocus, AssistantReference, AssistantState, AssistantTurn } from '../shared/assistant';
import { isAcpAgent } from '../shared/acp-agents';
import type { ProjectDetail, Proposal } from '../shared/types';
import { RichText, time } from './Content';
import { readSaved, saveLocal, useDraft } from './persistence';
import { textPreview } from '../shared/presentation';
import { agentDirections } from '../shared/agent-work';
import { presentAssistantResponse, type AssistantStructurePreview as StructurePreview } from '../shared/assistant-presentation';
import { readAssistantClarifications, type AssistantClarificationQuestion } from '../shared/assistant-clarifications';
import { post } from './api';
import { RosApprovalMenu, RosModelMenu, RosSizeIcon, rosSizeLabel } from './RosModelMenu';
import type { ResearchPolicy } from '../shared/research';
import { RememberCard } from './MemoryPage';
import type { PersonalMemoryState } from '../shared/personal-memory';
import { AssistantStructurePreview, proposalStructurePreview } from './AssistantStructurePreview';
import { AssistantAnswerDialog, AssistantFollowUpQuestions, answerQuestionFingerprint, appendPreparedAnswers } from './AssistantAnswerDialog';
import { useSmoothText } from './live-reply';
import { useSkillMenu } from './SkillMenu';
import './assistant-compact.css';

/** The Vite dev server (npm run dev); the dev-only conversation reset exists only there. */
const devBuild = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);

type Props = {
  state: AssistantState | null; detail: ProjectDetail; policy: ResearchPolicy | null; focus: AssistantFocus; busy: boolean; loadError?:string;
  onSend: (message: string) => Promise<boolean>; onCancel: (turnId: string) => Promise<unknown>;
  onClearFocus: () => void; onReference: (reference: AssistantReference) => void;
  onRefresh: () => Promise<unknown>; onConnections: () => void; onPermissions: () => void; onClose: () => void; prefill: string; onPrefillUsed: () => void;
  onDecision: (actionId: string, decision: 'accept' | 'dismiss') => Promise<unknown>;
  onProposal: (proposalId: string, decision: 'accept' | 'dismiss') => Promise<unknown>;
  onInspectAction: (action: AssistantAction) => void;
  /** Ros opens as a sheet over the map (half) or docked on the right (full). */
  mode?: 'half' | 'full'; onMode?: (mode: 'half' | 'full') => void;
  /** Opens the Skills page from the / menu. */
  onSkills?: () => void;
};

export function AssistantPanel({ state, detail, policy, focus, busy, loadError, onSend, onCancel, onClearFocus, onReference: navigateReference, onRefresh, onConnections, onPermissions, onClose, prefill, onPrefillUsed, onDecision, onProposal, onInspectAction, mode = 'full', onMode, onSkills }: Props) {
  const [message, setMessage] = useDraft(`assistant-draft:${detail.project.id}`, readSaved(`project-draft:${detail.project.id}`, ''));
  const skills = useSkillMenu(message, setMessage, onSkills);
  const [previousOpen,setPreviousOpen]=useState(!state?.turns.length);
  const [answerTarget, setAnswerTarget] = useState<{ projectId: string; turnId: string; questions: AssistantClarificationQuestion[] } | null>(null);
  const [preparedNotice, setPreparedNotice] = useState('');
  type Submission={message:string;at:string;status:'pending'|'failed'|'uncertain';error?:string};
  const [submission,setSubmission]=useState<Submission|null>(()=>{const saved=readSaved<Submission|null>(`assistant-submission:${detail.project.id}`,null);return saved?.status==='pending'?{...saved,status:'uncertain',error:'The browser closed before admission was confirmed. Refresh saved activity before sending again; ros.ai will not retry automatically.'}:saved;});
  const rememberSubmission=(value:Submission|null)=>{setSubmission(value);saveLocal(`assistant-submission:${detail.project.id}`,value);};


  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('.ros-model-menu, .modal, .cm-editor:focus-within')) onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const scroller = useRef<HTMLDivElement>(null); const textarea = useRef<HTMLTextAreaElement>(null); const followConversation=useRef(true);
  const focusedNode = detail.project.canvas.nodes.find(node => node.id === focus.nodeId);
  const focusedArtifact = detail.artifacts.find(artifact => artifact.id === focus.artifactId);
  const blocks = detail.project.canvas.nodes.length;
  const turns = [...(state?.turns || [])].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)); const active = turns.find(turn => turn.id === state?.activeTurnId);
  const savedMessages = state?.messages || [];
  // The service stores the first user message just before its turn is created.
  const firstTurn=turns[0];
  const firstTurnMessageIndex=firstTurn?savedMessages.findLastIndex(item=>item.role==='user'&&item.content===firstTurn.userMessage&&item.createdAt<=firstTurn.createdAt):-1;
  const messages=firstTurnMessageIndex>=0?savedMessages.slice(0,firstTurnMessageIndex):firstTurn?savedMessages.filter(item=>item.createdAt<firstTurn.createdAt):savedMessages;
  const onReference=(reference:AssistantReference)=>{
    const saved=detail.messages.find(item=>item.id===reference.id);
    if(reference.kind!=='message'||!saved||saved.nodeId){navigateReference(reference);return;}
    const legacy=messages.some(item=>item.id===reference.id);if(legacy)setPreviousOpen(true);
    const matchingTurn=saved.role==='user'?turns.find(turn=>turn.userMessage===saved.content&&turn.createdAt>=saved.createdAt):turns.findLast(turn=>turn.createdAt<=saved.createdAt);
    setTimeout(()=>{const selector=legacy?`[data-message-id="${reference.id}"]`:matchingTurn?`[data-turn-id="${matchingTurn.id}"]`:null;if(selector)document.querySelector<HTMLElement>(selector)?.scrollIntoView({block:'center'});},0);
  };
  const running = busy || Boolean(active);
  const lastTurn = turns.at(-1);
  const blocker = state && !state.modelAvailable ? assistantBlocker(state.modelBlocker||'The selected model is unavailable.',state.backend) : null;
  const modelBlocked = Boolean(state && !state.modelAvailable);
  const pending = detail.proposals.filter(proposal => proposal.status === 'pending' && !turns.some(turn => turn.actions.some(action => action.proposalId === proposal.id)));
  const asking = answerTarget?.projectId === detail.project.id;
  // The composer grows with its text, then scrolls.
  useEffect(() => { const element = textarea.current; if (!element || asking) return; element.style.height = ''; if (element.scrollHeight > element.clientHeight) element.style.height = `${Math.min(element.scrollHeight, Math.round(window.innerHeight * 0.4))}px`; }, [message, asking, mode]);
  useEffect(() => { if (prefill) { setMessage(prefill); textarea.current?.focus(); onPrefillUsed(); } }, [prefill, onPrefillUsed]);
  useEffect(() => { const element = scroller.current; if (element) {followConversation.current=true;element.scrollTop = element.scrollHeight;} }, [turns.length, lastTurn?.reply, lastTurn?.status, messages.length, busy]);
  useEffect(()=>{const element=scroller.current;if(!element)return;const observer=new ResizeObserver(()=>{if(followConversation.current)element.scrollTop=element.scrollHeight;});observer.observe(element);return()=>observer.disconnect();},[]);
  useEffect(()=>{if(submission&&turns.some(turn=>turn.userMessage===submission.message&&turn.createdAt>=submission.at)){setSubmission(null);saveLocal(`assistant-submission:${detail.project.id}`,null);}},[state,detail.project.id,submission]);
  const changeBackend=async(backend:AssistantBackend)=>{if(running)return;try{await post(`/api/projects/${detail.project.id}/assistant/backend`,{backend});await onRefresh();}catch(cause){rememberSubmission({message:'Change assistant connection',at:new Date().toISOString(),status:'failed',error:cause instanceof Error?cause.message:String(cause)});}};
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!message.trim() || running || modelBlocked || submission?.status==='pending') return;
    setPreparedNotice('');
    const attempt:Submission={message:message.trim(),at:new Date().toISOString(),status:'pending'};rememberSubmission(attempt);
    try{if(await onSend(attempt.message)){setMessage('');rememberSubmission(null);}else rememberSubmission({...attempt,status:'failed',error:'The message was not admitted. Inspect saved activity and the connection status before sending again.'});}
    catch(cause){const error=cause instanceof Error?cause.message:String(cause);rememberSubmission({...attempt,status:/timeout|timed out|unknown|unreadable|network|fetch|abort/i.test(error)?'uncertain':'failed',error});}
    textarea.current?.focus();
  };
  // Stop, by button or Esc, leaves the cursor in the box for the next question.
  const stop = () => { if (active) void onCancel(active.id); textarea.current?.focus(); };
  const usePrompt = (value: string) => { setMessage(value); textarea.current?.focus(); };
  const openAnswers = (turnId: string, questions: AssistantClarificationQuestion[]) => {
    if (!questions.length || busy || submission?.status === 'pending') return;
    setAnswerTarget({ projectId: detail.project.id, turnId, questions });
  };
  const prepareAnswers = (answers: string): string | null => {
    if (answerTarget?.projectId !== detail.project.id) return 'The project changed. Reopen its questions before preparing answers.';
    if (busy || submission?.status === 'pending') return 'Wait for your current submission to finish. Your answers remain saved.';
    if (appendPreparedAnswers(message, answers).length > 12000) return 'These answers and your current draft exceed 12,000 characters. Shorten either draft; both remain retained.';
    setMessage(current => {
      const combined = appendPreparedAnswers(current, answers);
      return combined.length <= 12000 ? combined : current;
    });
    setPreparedNotice('Answers added to your draft. No message was sent.'); setAnswerTarget(null);
    setTimeout(() => textarea.current?.focus(), 0);
    return null;
  };
  return <aside id="research-assistant-panel" className={`assistant-panel assistant-compact ros-panel ros-${mode}`} aria-label="Ros" data-testid="assistant-panel">
    <header className="assistant-heading"><span className={`assistant-signal ${running ? 'working' : ''}`} aria-hidden="true"><ResearchRing/></span><h2>Ros</h2><span className="assistant-heading-spacer"/>{devBuild&&<button className="text-button small assistant-dev-clear" title="Development only: forget this project's conversation, questions and agent session" disabled={running} onClick={()=>void post(`/api/projects/${detail.project.id}/assistant/dev-clear`, {}).then(()=>onRefresh())}><RotateCcw size={13}/> Clear · dev</button>}{onMode&&<button className="icon-button" aria-label={mode==='half'?rosSizeLabel.full:rosSizeLabel.half} title={mode==='half'?'Side panel':'Half sheet'} onClick={()=>onMode(mode==='half'?'full':'half')}><RosSizeIcon size={mode==='half'?'full':'half'}/></button>}<button className="icon-button" aria-label="Close Ros" title="Close (Esc)" onClick={onClose}><X size={16}/></button></header>
    <div className="assistant-scroll" id="assistant-conversation" ref={scroller} data-testid="project-conversation" onScroll={event=>{const element=event.currentTarget;followConversation.current=element.scrollHeight-element.scrollTop-element.clientHeight<24;}}>
      {loadError&&<section className="assistant-submission-failure" role="alert"><strong>Saved conversation unavailable</strong><p>{loadError}</p><button className="secondary small" onClick={()=>void onRefresh()}>Refresh saved activity</button></section>}
      {!state && !loadError && <p className="assistant-loading"><LoaderCircle className="spin" size={16}/> Opening the conversation…</p>}
      {state && !turns.length && !messages.length && <div className="assistant-welcome"><div className="assistant-welcome-signal" aria-hidden="true"><ResearchRing/></div><h3>What are you exploring?</h3><p>Start with a question or a half-formed idea. Keep the conversation here while your notes and evidence take shape.</p><div className="assistant-starters"><button onClick={() => usePrompt('Help me frame the question I want to explore: ')}>Shape a research question <ArrowRight size={14}/></button>{detail.project.canvas.nodes.length > 0 && <button onClick={() => usePrompt('What do we know so far, and what is still missing?')}>Make sense of this project <ArrowRight size={14}/></button>}</div></div>}
      {messages.length > 0 && <details className="assistant-previous" open={previousOpen} onToggle={event=>setPreviousOpen(event.currentTarget.open)}><summary><HistoryLabel/> Earlier project conversation <span>{messages.length}</span></summary>{messages.map(item => <article key={item.id} data-message-id={item.id} className={`assistant-message ${item.role}`}><div className="message-meta"><span>{item.role === 'user' ? 'You' : item.role === 'system' ? 'Workspace update' : 'ros.ai'}</span><time>{time(item.createdAt)}</time></div>{item.role === 'assistant' ? <AssistantResponse content={item.content} detail={detail} onAnswer={busy||submission?.status==='pending'?undefined:questions=>openAnswers(`message:${item.id}`,questions)}/> : <RichText text={item.content}/>}</article>)}</details>}
      {turns.map(turn => <Turn key={turn.id} turn={turn} detail={detail} onReference={onReference} onDecision={onDecision} onProposal={onProposal} onInspectAction={onInspectAction} person={state?.person} onMemory={()=>void onRefresh()} onAnswer={busy||submission?.status==='pending'?undefined:questions=>openAnswers(turn.id,questions)}/>)}
      {pending.map(proposal => <ProposalReview key={proposal.id} proposal={proposal} title={proposal.summary} detail={detail} onProposal={onProposal} onOpen={() => onReference({kind:'proposal',id:proposal.id,label:proposal.summary})}/>)}
      {submission&&submission.status!=='pending'&&<section className="assistant-submission-failure" role="alert"><div className="message-meta">Your submission · {submission.status==='uncertain'?'Admission unconfirmed':'Not admitted'}</div><RichText text={submission.message}/><p>{submission.error}</p><button type="button" className="secondary small" onClick={()=>void onRefresh()}>Refresh saved activity</button><button type="button" className="text-button" onClick={onConnections}>Inspect connection</button><p className="subtle">No automatic retry. A new message is a deliberate continuation.</p></section>}
      {busy && !active && <div className="assistant-working" role="status"><LoaderCircle size={14} className="spin"/> Saving your question…</div>}
    </div>
    {blocker&&!running&&<div className="assistant-admission" role="status"><div><CircleHelp size={14}/><span>{blocker.summary}</span><button type="button" onClick={()=>{if(blocker.action==='model'||blocker.action==='steps')void changeBackend('provider');else if(blocker.action==='permissions')onPermissions();else onConnections();}}>{blocker.action==='model'?'Choose API model':blocker.action==='steps'?'Answer without tools':blocker.action==='permissions'?'Review permissions':'Open Model'}<ArrowRight size={12}/></button></div></div>}
    {preparedNotice&&<p className="assistant-prepared-notice" role="status">{preparedNotice}</p>}
    {asking&&<AssistantAnswerDialog key={`${answerTarget.turnId}:${answerQuestionFingerprint(answerTarget.questions)}`} projectId={answerTarget.projectId} turnId={answerTarget.turnId} questions={answerTarget.questions} composerText={message} onPrepare={prepareAnswers} onClose={()=>{setAnswerTarget(null);setTimeout(()=>textarea.current?.focus(),0);}}/>}
    <form className="assistant-composer ros-composer" hidden={asking} onSubmit={event => void submit(event)}>
      <label className="sr-only" htmlFor="assistant-message">Message Ros</label>
      {skills.menu}
      <textarea id="assistant-message" ref={textarea} data-testid="project-message" aria-autocomplete="list" aria-expanded={skills.open} value={message} rows={2} placeholder={active ? 'Type your next question' : turns.length ? 'Ask a follow-up, or @ an agent' : 'Ask Ros, or @ an agent'} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (skills.onKeyDown(event)) return; if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(event); } else if (event.key === 'Escape' && active) { event.preventDefault(); stop(); } }}/>
      <div className="ros-bar-footer">
        <RosModelMenu state={state} detail={detail} running={running} onRefresh={onRefresh} onConnections={onConnections} onPermissions={onPermissions} onError={error=>rememberSubmission({message:'Change what Ros runs with',at:new Date().toISOString(),status:'failed',error})}/>
        <RosApprovalMenu policy={policy} running={running} onRefresh={onRefresh} onDetails={onPermissions} onError={error=>rememberSubmission({message:'Change approval mode',at:new Date().toISOString(),status:'failed',error})}/>
        <span className="ros-footer-break" aria-hidden="true"/>
        {focusedNode || focusedArtifact
          ? <span className="ros-context focused" title={`Ros is looking at ${focusedArtifact?.title || focusedNode?.title}`}><Focus size={12}/><span>{focusedArtifact?.title || focusedNode?.title}</span>{focusedNode && <button type="button" aria-label="Show Ros the whole map" title="Whole map" onClick={onClearFocus}><X size={12}/></button>}</span>
          : <span className="ros-context" title="Select a block to point Ros at it"><Focus size={12}/><span>Whole map · {blocks} {blocks === 1 ? 'block' : 'blocks'}</span></span>}
        <span className="ros-footer-spacer"/>
        {active ? <button type="button" className="ros-send ros-stop" aria-label="Stop Ros" title="Stop (Esc)" onClick={stop}><Square size={10} fill="currentColor"/></button>
          : <button className="ros-send" data-testid="send-project-message" aria-label="Send to Ros" title={blocker?.summary||'Send to Ros'} disabled={!message.trim() || running || !state || modelBlocked}>{running ? <LoaderCircle size={14} className="spin"/> : <ArrowUp size={14}/>}</button>}
      </div>
    </form>
  </aside>;
}

function HistoryLabel() { return <BookOpen size={13}/>; }

function assistantBlocker(reason:string,backend?:AssistantBackend):{summary:string;action:'model'|'connections'|'permissions'|'steps'} {
  // An agent on this computer says itself what is missing (installed, signed in, locked down) and where to fix it.
  if(isAcpAgent(backend))return {summary:reason,action:/stopped|stop flag/i.test(reason)?'permissions':'connections'};
  if(backend==='codex'&&/restricted read|isolation boundary|isolate reads|workspace isolation/i.test(reason))return {summary:'Codex needs a CLI with workspace read isolation.',action:'model'};
  // A local model that cannot work step by step: the reason names the model and what to change.
  if(backend==='agent'&&/cannot call tools/i.test(reason))return {summary:reason,action:'steps'};
  if(backend==='agent'&&/Local models/.test(reason))return {summary:reason,action:'connections'};
  if(/stopped|stop flag/i.test(reason))return {summary:'Work in this project is paused.',action:'permissions'};
  if(backend==='claude'&&/api key/i.test(reason))return {summary:'Connect a Claude API key for Claude Code.',action:'connections'};
  if(backend==='claude'&&/claude plan/i.test(reason))return {summary:reason,action:'connections'};
  if(/allowance|authorization|authorized|spending|grant/i.test(reason))return {summary:backend==='codex'?'Codex needs a usage allowance.':backend==='claude'?'Claude Code needs a usage allowance.':'Enable usage for this model connection.',action:'connections'};
  if(/credential|api key|configured/i.test(reason))return {summary:'Connect the selected model provider.',action:'connections'};
  return {summary:backend==='codex'?'Codex cannot start. Check connection details.':backend==='claude'?'Claude Code cannot start. Check connection details.':'The model cannot start. Check connection details.',action:'connections'};
}

function ReferenceLinks({ references, onReference }: { references: AssistantReference[]; onReference: Props['onReference'] }) {
  if (!references.length) return null;
  return <div className="assistant-references">{references.map((reference, index) => <button key={`${reference.kind}:${reference.id}:${index}`} onClick={() => onReference(reference)} title={`Open ${reference.label}`}>{reference.kind === 'artifact' ? <FileText size={12}/> : reference.kind === 'proposal' ? <GitBranch size={12}/> : <BookOpen size={12}/>}<span>{textPreview(reference.label,48).text}</span><ArrowRight size={11}/></button>)}</div>;
}

function Turn({ turn, detail, onReference, onDecision, onProposal, onInspectAction, onAnswer, person, onMemory }: { turn: AssistantTurn; detail: ProjectDetail; onReference: Props['onReference']; onDecision: Props['onDecision']; onProposal: Props['onProposal']; onInspectAction: Props['onInspectAction']; onAnswer?: (questions: AssistantClarificationQuestion[]) => void; person?: PersonalMemoryState; onMemory?: () => void }) {
  const focus = detail.project.canvas.nodes.find(node => node.id === turn.focus.nodeId);
  // The person's own Claude Code or Codex, connected over MCP: there is no message from them here.
  const outside = turn.source === 'outside-agent';
  // Admission failures retain one persistent alert. The stored reply/error
  // remain intact; an identical failure should not appear as two responses.
  const reply = useSmoothText(turn.reply.trim() === turn.error?.trim() ? '' : turn.reply, turn.status === 'running');
  const blockedRecord = turn.source==='local-records' && reply.includes('[Saved-record view') && /allowance|authorization|spending ceiling|model unavailable/i.test(reply);
  const agentNode = detail.project.canvas.nodes.find(node => node.agent?.turnId === turn.id);
  // The summary below says what an agent's search plan did; its approval card stays only while it waits.
  const searchPlan = (action: AssistantAction) => Boolean(agentNode && detail.proposals.find(item => item.id === action.proposalId)?.operations.some(operation => operation.type === 'addNode' && (operation.node.blockType === 'search' || operation.node.label === 'result')));
  const savedStructure = turn.actions.some(action => {
    const proposal = detail.proposals.find(item => item.id === action.proposalId);
    return proposal && Boolean(proposalStructurePreview(proposal, detail.project.canvas.nodes));
  });
  return <section className="assistant-turn" data-turn-id={turn.id}>
    {outside ? null : <article className="assistant-message user">{focus && <span className="turn-focus" title={focus.title}><Focus size={11}/>{focus.title}</span>}<RichText text={turn.userMessage}/></article>}
    <article className="assistant-message response">{outside&&<div className="message-meta"><span>{`Your ${turn.model ?? 'own agent'}`}</span><span className="response-source">Working from outside ros.ai</span></div>}{agentNode && <AgentWorkSummary node={agentNode} turn={turn} detail={detail} onReference={onReference}/>}<AssistantResponse content={reply} question={turn.question?.trim()===turn.error?.trim()?undefined:turn.question} clarifications={turn.clarifications} structure={turn.structure} detail={detail} hideStructure={savedStructure} blockedRecord={blockedRecord} onAnswer={onAnswer}/><ReferenceLinks references={turn.references} onReference={onReference}/>
      {turn.warning&&<details className="assistant-failure-details"><summary><CircleHelp size={14}/><span>Reply saved · proposal details</span></summary><p>{turn.warning}</p><p>Unvalidated actions were not applied.</p></details>}
      {turn.status === 'running' && <div className="assistant-working" role="status"><LoaderCircle size={14} className="spin"/>{turn.events.at(-1)?.message || 'Working on your question…'}</div>}
      {turn.error && <details className="assistant-failure-details"><summary><CircleHelp size={14}/><span>Attempt failed</span><span>Details</span></summary><p>{turn.error}</p></details>}
      {['interrupted','cancelled'].includes(turn.status) && <p className="assistant-interrupted">{turn.status === 'cancelled' ? 'Stopped. Saved work remains available.' : 'Interrupted. Send a follow-up to continue from the saved work.'}</p>}
      {turn.actions.filter(action => !searchPlan(action) || (detail.proposals.find(item => item.id === action.proposalId)?.status ?? action.status) === 'pending').map(action => <ActionCard key={action.id} action={action} detail={detail} onReference={onReference} onDecision={onDecision} onProposal={onProposal} onInspectAction={onInspectAction}/>)}
      {turn.remembered?.length ? <RememberCard remembered={turn.remembered} person={person} onChanged={onMemory}/> : null}
      {turn.status !== 'running' && <div className="ros-turn-meta"><span>{outside ? 'Outside agent' : turn.source === 'local-records' ? 'Saved context' : 'Ros'} · {time(turn.createdAt)}</span>{!outside&&turn.model&&<span title={turn.destination?turn.location==='local-verified'?'On this computer':turn.location==='local-unverified'?`${turn.destination} · local processing unverified`:`Sent to ${turn.destination}`:undefined}>{turn.model}</span>}{turn.events.length > 0 && <details className="assistant-turn-events"><summary>{turn.events.length} {turn.events.length === 1 ? 'step' : 'steps'}</summary><ol>{turn.events.map((event, index) => <li key={index}><time>{time(event.at)}</time><span>{event.message}</span></li>)}</ol></details>}</div>}
    </article>
  </section>;
}

/** What an agent turn left on the canvas, so the answer below does not have to list it. */
function AgentWorkSummary({ node, turn, detail, onReference }: { node: ProjectDetail['project']['canvas']['nodes'][number]; turn: AssistantTurn; detail: ProjectDetail; onReference: Props['onReference'] }) {
  const work = agentDirections(detail.project.canvas, detail.artifacts, node.id), running = turn.status === 'running';
  const waiting = turn.actions.filter(action => action.status === 'pending' && (!action.proposalId || detail.proposals.find(item => item.id === action.proposalId)?.status === 'pending')).length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (!work.directions.length && !waiting) return null;
  return <div className="agent-work-summary">
    <ul>
      {work.directions.length > 0 && <li><Search size={13}/>{running && !work.sources ? `Searching ${plural(work.directions.length, 'direction')}…` : `Searched ${plural(work.directions.length, 'direction')} · ${plural(work.sources, 'source')}`}</li>}
      {work.directions.length > 0 && <li><BookOpen size={13}/>{work.written === work.directions.length ? `Wrote ${plural(work.written, 'result note')}` : `Wrote ${work.written} of ${plural(work.directions.length, 'result note')}`}</li>}
      {work.pages.length + work.findings > 0 && <li><Quote size={13}/>Read {plural(work.pages.length, 'page')} · saved {plural(work.findings, 'finding')}</li>}
      {waiting > 0 && <li className="waiting"><GitBranch size={13}/>{plural(waiting, 'change')} waiting for your review</li>}
    </ul>
    <button className="text-button" onClick={() => onReference({ kind: 'node', id: node.id, label: node.title })}>Show on canvas<ArrowRight size={12}/></button>
  </div>;
}

function AssistantResponse({ content, question, clarifications, structure, detail, hideStructure = false, blockedRecord = false, onAnswer }: { content: string; question?: string | null; clarifications?: AssistantClarificationQuestion[]; structure?: StructurePreview; detail: ProjectDetail; hideStructure?: boolean; blockedRecord?: boolean; onAnswer?: (questions: AssistantClarificationQuestion[]) => void }) {
  const presentation = presentAssistantResponse(content);
  const followUp = presentation.question || question;
  const questions = readAssistantClarifications({ clarifications: clarifications || presentation.clarifications, question: followUp });
  const draftStructure = structure || presentation.structure;
  const replyText = followUp && presentation.reply.includes(followUp) ? presentation.reply.replace(followUp, '').trim() : presentation.reply;
  const opaqueReply = /^(?:```(?:json)?\s*)?(?:\{|\[\s*[{"])/i.test(replyText.trim());
  const transformed = replyText !== content || Boolean(presentation.structure || presentation.question) || opaqueReply;
  return <>
    {opaqueReply ? <p className="assistant-structure-unreadable">The saved reply could not be displayed as a complete response. Its original text is available below.</p> : replyText && (blockedRecord ? <details className="assistant-saved-fallback"><summary>No model ran · saved response</summary><RichText text={replyText}/></details> : <RichText text={replyText}/>)}
    {questions.length > 0 && <AssistantFollowUpQuestions questions={questions} onAnswer={onAnswer ? () => onAnswer(questions) : undefined}/>}
    {draftStructure && !hideStructure && <AssistantStructurePreview structure={draftStructure} existingNodes={detail.project.canvas.nodes}/>}
    {transformed && <details className="assistant-original-response"><summary>Original saved reply</summary><pre>{content}</pre></details>}
  </>;
}

function ActionCard({ action, detail, onReference, onDecision, onProposal, onInspectAction }: { action: AssistantAction; detail: ProjectDetail; onReference: Props['onReference']; onDecision: Props['onDecision']; onProposal: Props['onProposal']; onInspectAction: Props['onInspectAction'] }) {
  const [busy,setBusy] = useState(false);
  const title = textPreview(action.title, 90);
  const proposal = detail.proposals.find(item => item.id === action.proposalId);
  const structure = proposal?.status === 'pending' ? proposalStructurePreview(proposal, detail.project.canvas.nodes) : null;
  const status = proposal && proposal.status !== 'pending' ? proposal.status : action.status;
  const decide = async (decision:'accept'|'dismiss') => {setBusy(true);try{await onDecision(action.id,decision);}finally{setBusy(false);}};
  const addedNote = proposal?.operations.find(operation=>operation.type==='addNode');
  const relatedNoteId = addedNote?.type==='addNode' ? addedNote.node.id : action.nodeId;
  const reuseArtifact = detail.artifacts.find(item=>item.id===action.artifactId);
  const reuseTarget = detail.project.canvas.nodes.find(item=>item.id===(action.targetNodeId||action.nodeId));
  const canOpen = Boolean(action.reportProposalId)||action.type!=='proposal'||status==='pending'||Boolean(relatedNoteId&&detail.project.canvas.nodes.some(node=>node.id===relatedNoteId));
  const open = () => action.reportProposalId ? onInspectAction(action) : action.proposalId ? status==='pending' ? onReference({kind:'proposal',id:action.proposalId,label:action.title,nodeId:action.nodeId}) : relatedNoteId && onReference({kind:'node',id:relatedNoteId,label:action.title}) : onInspectAction(action);
  if (proposal && status === 'pending' && !action.reportProposalId) return <ProposalReview proposal={proposal} title={action.title} detail={detail} onProposal={onProposal} onOpen={open}/>;
  return <div className={`assistant-action status-${status}`}><div className="assistant-action-title">{action.type === 'proposal' ? <GitBranch size={15}/> : action.type === 'reuse' ? <FileText size={15}/> : <BookOpen size={15}/>}<strong title={action.title}>{title.text}</strong><span>{status === 'pending' ? 'Review' : status}</span></div>{title.truncated&&<details className="assistant-action-description"><summary>Full request</summary><p>{action.title}</p></details>}{action.error && <p>{action.error}</p>}{structure&&<AssistantStructurePreview structure={structure} existingNodes={detail.project.canvas.nodes} validation="proposal"/>}{action.type === 'reuse' && action.status === 'pending' ? <><p>Use <strong>{reuseArtifact?.title||'the selected artifact'}</strong>{reuseArtifact&&<> · version <code>{reuseArtifact.hash.slice(0,8)}</code></>} as an input to <strong>{reuseTarget?.title||'the suggested note'}</strong>.</p>{reuseArtifact&&<ReferenceLinks references={[{kind:'artifact',id:reuseArtifact.id,label:'Inspect this version',nodeId:reuseArtifact.nodeId}]} onReference={onReference}/>}<div className="assistant-action-buttons"><button className="primary small" disabled={busy} onClick={() => void decide('accept')}><Check size={13}/> Accept reuse</button><button className="text-button" disabled={busy} onClick={() => void decide('dismiss')}>Dismiss</button></div></> : <button className="assistant-action-open" disabled={!canOpen} onClick={open}>{action.type === 'proposal' ? (status === 'pending' ? action.reportProposalId?'Review report revision':'Review canvas changes' : status==='dismissed'?'Proposal dismissed':'View related note') : action.type === 'experiment' ? 'Inspect experiment' : 'Open saved work'}<ArrowRight size={13}/></button>}</div>;
}

/** A pending canvas change, reviewed where it was proposed: what changes, then Accept or Dismiss. */
function ProposalReview({ proposal, title, detail, onProposal, onOpen }: { proposal: Proposal; title: string; detail: ProjectDetail; onProposal: Props['onProposal']; onOpen: () => void }) {
  const [busy, setBusy] = useState(false);
  const structure = proposalStructurePreview(proposal, detail.project.canvas.nodes);
  const stale = proposal.baseRevision !== detail.project.revision;
  const decide = async (decision: 'accept' | 'dismiss') => { setBusy(true); try { await onProposal(proposal.id, decision); } finally { setBusy(false); } };
  return <section className="proposal-review" aria-label="Proposed canvas change">
    <header><GitBranch size={14} aria-hidden="true"/><strong title={title}>{title.split('\n')[0]}</strong></header>
    {structure && <AssistantStructurePreview structure={structure} existingNodes={detail.project.canvas.nodes} validation="proposal" compact/>}
    {stale && <p className="proposal-review-stale">The canvas changed since. Ask Ros to update this.</p>}
    <div className="proposal-review-actions"><button className="primary small" disabled={busy || stale} onClick={() => void decide('accept')}><Check size={13}/> Accept</button><button className="text-button small" disabled={busy} onClick={() => void decide('dismiss')}>Dismiss</button><button className="text-button small proposal-review-open" onClick={onOpen}>Show on canvas <ArrowRight size={12}/></button></div>
  </section>;
}
