import { ResearchRing } from './Brand';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, ArrowUp, BookOpen, Check, ChevronDown, ChevronRight, CircleHelp, FileText, Focus, GitBranch, ListTree, LoaderCircle, MessageSquare, PanelRightClose, Plug, Settings2, ShieldCheck, Square, Terminal, X } from 'lucide-react';
import type { AssistantAction, AssistantFocus, AssistantReference, AssistantState, AssistantTurn, OutlineEntry } from '../shared/assistant';
import type { ProjectDetail } from '../shared/types';
import { RichText, time } from './Content';
import { readSaved, saveLocal } from './persistence';
import { textPreview } from '../shared/presentation';
import { buildOutlineHierarchy, type OutlineBranch } from '../shared/outline-hierarchy';
import { presentAssistantResponse, type AssistantStructurePreview as StructurePreview } from '../shared/assistant-presentation';
import { readAssistantClarifications, type AssistantClarificationQuestion } from '../shared/assistant-clarifications';
import { post } from './api';
import { ModelSettings } from './ModelSettings';
import { AssistantBudgetSetup } from './AssistantBudgetSetup';
import { WorkspaceGuide } from './WorkspaceGuide';
import { AssistantStructurePreview, proposalStructurePreview } from './AssistantStructurePreview';
import { AssistantAnswerDialog, AssistantFollowUpQuestions, answerQuestionFingerprint, appendPreparedAnswers } from './AssistantAnswerDialog';
import './outline-hierarchy.css';
import './assistant-compact.css';

type Props = {
  state: AssistantState | null; detail: ProjectDetail; focus: AssistantFocus; busy: boolean; loadError?:string;
  onSend: (message: string) => Promise<boolean>; onCancel: (turnId: string) => Promise<unknown>;
  onClearFocus: () => void; onReference: (reference: AssistantReference) => void;
  onRefresh: () => Promise<unknown>; onConnections: () => void; onPermissions: () => void; onClose: () => void; prefill: string; onPrefillUsed: () => void;
  onDecision: (actionId: string, decision: 'accept' | 'dismiss') => Promise<unknown>;
  onInspectAction: (action: AssistantAction) => void;
};

export function AssistantPanel({ state, detail, focus, busy, loadError, onSend, onCancel, onClearFocus, onReference: navigateReference, onRefresh, onConnections, onPermissions, onClose, prefill, onPrefillUsed, onDecision, onInspectAction }: Props) {
  const [tab, setTab] = useState<'conversation' | 'outline'>(() => readSaved(`assistant-tab:${detail.project.id}`, 'conversation'));
  const [message, setMessage] = useState(() => readSaved(`assistant-draft:${detail.project.id}`, readSaved(`project-draft:${detail.project.id}`, '')));
  const [previousOpen,setPreviousOpen]=useState(!state?.turns.length);
  const [settingsOpen,setSettingsOpen]=useState(false),[budgetOpen,setBudgetOpen]=useState(false),[backendBusy,setBackendBusy]=useState(false),[guideOpen,setGuideOpen]=useState(false);
  const [answerTarget, setAnswerTarget] = useState<{ projectId: string; turnId: string; questions: AssistantClarificationQuestion[] } | null>(null);
  const [preparedNotice, setPreparedNotice] = useState('');
  const settingsRef=useRef<HTMLDivElement>(null),settingsButton=useRef<HTMLButtonElement>(null);
  type Submission={message:string;at:string;status:'pending'|'failed'|'uncertain';error?:string};
  const [submission,setSubmission]=useState<Submission|null>(()=>{const saved=readSaved<Submission|null>(`assistant-submission:${detail.project.id}`,null);return saved?.status==='pending'?{...saved,status:'uncertain',error:'The browser closed before admission was confirmed. Refresh saved activity before sending again; ros.ai will not retry automatically.'}:saved;});
  const rememberSubmission=(value:Submission|null)=>{setSubmission(value);saveLocal(`assistant-submission:${detail.project.id}`,value);};


  const scroller = useRef<HTMLDivElement>(null); const textarea = useRef<HTMLTextAreaElement>(null); const followConversation=useRef(true);
  const focusedNode = detail.project.canvas.nodes.find(node => node.id === focus.nodeId);
  const focusedGroup = detail.project.canvas.nodes.some(node => node.parentId === focus.nodeId && focus.nodeId);
  const focusedArtifact = detail.artifacts.find(artifact => artifact.id === focus.artifactId);
  const turns = [...(state?.turns || [])].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)); const active = turns.find(turn => turn.id === state?.activeTurnId);
  const savedMessages = state?.messages || [];
  // The service stores the first user message just before its turn is created.
  const firstTurn=turns[0];
  const firstTurnMessageIndex=firstTurn?savedMessages.findLastIndex(item=>item.role==='user'&&item.content===firstTurn.userMessage&&item.createdAt<=firstTurn.createdAt):-1;
  const messages=firstTurnMessageIndex>=0?savedMessages.slice(0,firstTurnMessageIndex):firstTurn?savedMessages.filter(item=>item.createdAt<firstTurn.createdAt):savedMessages;
  const onReference=(reference:AssistantReference)=>{
    const saved=detail.messages.find(item=>item.id===reference.id);
    if(reference.kind!=='message'||!saved||saved.nodeId){navigateReference(reference);return;}
    setTab('conversation');
    const legacy=messages.some(item=>item.id===reference.id);if(legacy)setPreviousOpen(true);
    const matchingTurn=saved.role==='user'?turns.find(turn=>turn.userMessage===saved.content&&turn.createdAt>=saved.createdAt):turns.findLast(turn=>turn.createdAt<=saved.createdAt);
    setTimeout(()=>{const selector=legacy?`[data-message-id="${reference.id}"]`:matchingTurn?`[data-turn-id="${matchingTurn.id}"]`:null;if(selector)document.querySelector<HTMLElement>(selector)?.scrollIntoView({block:'center'});},0);
  };
  const running = busy || Boolean(active);
  const lastTurn = turns.at(-1);
  const blocker = state && !state.modelAvailable ? assistantBlocker(state.modelBlocker||'The selected model is unavailable.',state.backend) : null;
  const modelBlocked = Boolean(state && !state.modelAvailable);
  const pending = detail.proposals.filter(proposal => proposal.status === 'pending' && !turns.some(turn => turn.actions.some(action => action.proposalId === proposal.id)));
  useEffect(() => { saveLocal(`assistant-tab:${detail.project.id}`, tab); }, [tab, detail.project.id]);
  useEffect(() => { saveLocal(`assistant-draft:${detail.project.id}`, message); }, [message, detail.project.id]);
  useEffect(() => { if (prefill) { setTab('conversation'); setMessage(prefill); textarea.current?.focus(); onPrefillUsed(); } }, [prefill, onPrefillUsed]);
  useEffect(() => { const element = scroller.current; if (element) {followConversation.current=true;element.scrollTop = element.scrollHeight;} }, [turns.length, lastTurn?.reply, lastTurn?.status, messages.length, busy, tab, budgetOpen]);
  useEffect(()=>{const element=scroller.current;if(!element)return;const observer=new ResizeObserver(()=>{if(followConversation.current)element.scrollTop=element.scrollHeight;});observer.observe(element);return()=>observer.disconnect();},[tab]);
  useEffect(()=>{if(submission&&turns.some(turn=>turn.userMessage===submission.message&&turn.createdAt>=submission.at)){setSubmission(null);saveLocal(`assistant-submission:${detail.project.id}`,null);}},[state,detail.project.id,submission]);
  useEffect(()=>{if(!settingsOpen)return;const dismiss=(event:PointerEvent)=>{if(!settingsRef.current?.contains(event.target as Node)&&!settingsButton.current?.contains(event.target as Node))setSettingsOpen(false);};const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){setSettingsOpen(false);settingsButton.current?.focus();}};document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',key);return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',key);};},[settingsOpen]);
  const changeBackend=async(backend:'provider'|'codex')=>{if(running||backendBusy)return;setBackendBusy(true);try{await post(`/api/projects/${detail.project.id}/assistant/backend`,{backend});await onRefresh();setSettingsOpen(false);setBudgetOpen(false);}catch(cause){rememberSubmission({message:'Change assistant connection',at:new Date().toISOString(),status:'failed',error:cause instanceof Error?cause.message:String(cause)});}finally{setBackendBusy(false);}};
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!message.trim() || running || modelBlocked || backendBusy || submission?.status==='pending') return;
    setPreparedNotice('');
    const attempt:Submission={message:message.trim(),at:new Date().toISOString(),status:'pending'};rememberSubmission(attempt);
    try{if(await onSend(attempt.message)){setMessage('');rememberSubmission(null);}else rememberSubmission({...attempt,status:'failed',error:'The message was not admitted. Inspect saved activity and the connection status before sending again.'});}
    catch(cause){const error=cause instanceof Error?cause.message:String(cause);rememberSubmission({...attempt,status:/timeout|timed out|unknown|unreadable|network|fetch|abort/i.test(error)?'uncertain':'failed',error});}
  };
  const usePrompt = (value: string) => { setMessage(value); setTab('conversation'); textarea.current?.focus(); };
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
    setTab('conversation'); setPreparedNotice('Answers added to your draft. No message was sent.'); setAnswerTarget(null);
    setTimeout(() => textarea.current?.focus(), 0);
    return null;
  };
  return <aside id="research-assistant-panel" className="assistant-panel assistant-compact" aria-label="Assistant" data-testid="assistant-panel">
    <header className="assistant-heading"><span className={`assistant-signal ${running ? 'working' : ''}`} aria-hidden="true"><ResearchRing/></span><div><h2>Assistant</h2>{running&&<p>Working on your question</p>}</div><button ref={settingsButton} className="icon-button" aria-label="Assistant settings" aria-expanded={settingsOpen} aria-controls="assistant-settings" onClick={()=>setSettingsOpen(!settingsOpen)}><Settings2 size={17}/></button><button className="icon-button" aria-label="Close assistant panel" onClick={onClose}><PanelRightClose size={17}/></button></header>
    {settingsOpen&&<div ref={settingsRef} id="assistant-settings" className="assistant-settings-popover" role="dialog" aria-label="Assistant settings"><h3>Assistant connection</h3><div role="group" aria-label="Assistant connection"><button type="button" aria-pressed={state?.backend!=='codex'} disabled={running||backendBusy} onClick={()=>void changeBackend('provider')}><MessageSquare size={16}/><span><strong>API model</strong><small>Use the model selected below</small></span>{state?.backend!=='codex'&&<Check size={14}/>}</button><button type="button" aria-pressed={state?.backend==='codex'} disabled={running||backendBusy} onClick={()=>void changeBackend('codex')}><Terminal size={16}/><span><strong>Local Codex</strong><small>Use this computer’s Codex sign-in</small></span>{state?.backend==='codex'&&<Check size={14}/>}</button></div><div className="assistant-settings-links"><button type="button" onClick={onConnections}><Plug size={14}/> Connections & usage</button><button type="button" onClick={()=>{setSettingsOpen(false);onPermissions();}}><ShieldCheck size={14}/> Research permissions</button></div>{state?.modelBlocker&&<details><summary>Connection details</summary><p>{state.modelBlocker}</p></details>}</div>}
    <div className="assistant-tabs" role="tablist" aria-label="Assistant view" onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();const next=tab==='conversation'?'outline':'conversation';setTab(next);document.getElementById(`${next}-tab`)?.focus();}}}><button id="conversation-tab" role="tab" aria-selected={tab === 'conversation'} aria-controls="assistant-conversation" className={tab === 'conversation' ? 'active' : ''} onClick={() => setTab('conversation')}><MessageSquare size={15}/> Conversation</button><button id="outline-tab" role="tab" aria-selected={tab === 'outline'} aria-controls="assistant-outline" className={tab === 'outline' ? 'active' : ''} onClick={() => setTab('outline')}><ListTree size={15}/> Research outline</button></div>
    <div className={`assistant-focus ${focusedNode ? 'has-focus' : ''}`} data-testid="assistant-focus"><Focus size={13}/><div><span>{focusedArtifact ? 'Artifact' : focusedNode ? focusedGroup ? 'Group' : 'Note' : 'Project'}</span><strong title={focusedArtifact?.title || focusedNode?.title || detail.project.title}>{focusedArtifact?.title || focusedNode?.title || detail.project.title}</strong></div>{focusedNode && <button className="icon-button" aria-label="Clear assistant focus" title="Return to project context" onClick={onClearFocus}><X size={13}/></button>}</div>
    {tab === 'conversation' && <div className="assistant-model-row">{state?.backend==='codex'?<button type="button" className="assistant-runtime-trigger" disabled={running||backendBusy} onClick={()=>setSettingsOpen(!settingsOpen)}><Terminal size={20}/><span><strong>Codex connection</strong><small>Native CLI · processing destination depends on Codex</small></span><ChevronDown size={14}/></button>:<ModelSettings detail={detail} nodeId={focusedNode?.id} compact readOnly={running||backendBusy}/>}<button type="button" className="review-workspace-trigger" onClick={()=>setGuideOpen(true)}><ListTree size={13}/> Review workspace</button></div>}
    {guideOpen&&<WorkspaceGuide key={detail.project.id} detail={detail} onClose={()=>setGuideOpen(false)} onConnections={()=>{setGuideOpen(false);onConnections();}} onChanged={onRefresh} onReference={reference=>{setGuideOpen(false);onReference(reference);}}/>}
    {answerTarget?.projectId===detail.project.id&&<AssistantAnswerDialog key={`${answerTarget.turnId}:${answerQuestionFingerprint(answerTarget.questions)}`} projectId={answerTarget.projectId} turnId={answerTarget.turnId} questions={answerTarget.questions} composerText={message} onPrepare={prepareAnswers} onClose={()=>setAnswerTarget(null)}/>}
    {tab === 'conversation' ? <><div className="assistant-scroll" id="assistant-conversation" role="tabpanel" aria-labelledby="conversation-tab" ref={scroller} data-testid="project-conversation" onScroll={event=>{const element=event.currentTarget;followConversation.current=element.scrollHeight-element.scrollTop-element.clientHeight<24;}}>
      {loadError&&<section className="assistant-submission-failure" role="alert"><strong>Saved conversation unavailable</strong><p>{loadError}</p><button className="secondary small" onClick={()=>void onRefresh()}>Refresh saved activity</button></section>}
      {!state && !loadError && <p className="assistant-loading"><LoaderCircle className="spin" size={16}/> Opening the conversation…</p>}
      {state && !turns.length && !messages.length && <div className="assistant-welcome"><div className="assistant-welcome-signal" aria-hidden="true"><ResearchRing/></div><h3>What are you exploring?</h3><p>Start with a question or a half-formed idea. Keep the conversation here while your notes and evidence take shape.</p><div className="assistant-starters"><button onClick={() => usePrompt('Help me frame the question I want to explore: ')}>Shape a research question <ArrowRight size={14}/></button>{detail.project.canvas.nodes.length > 0 && <button onClick={() => usePrompt('What do we know so far, and what is still missing?')}>Make sense of this project <ArrowRight size={14}/></button>}</div></div>}
      {messages.length > 0 && <details className="assistant-previous" open={previousOpen} onToggle={event=>setPreviousOpen(event.currentTarget.open)}><summary><HistoryLabel/> Earlier project conversation <span>{messages.length}</span></summary>{messages.map(item => <article key={item.id} data-message-id={item.id} className={`assistant-message ${item.role}`}><div className="message-meta"><span>{item.role === 'user' ? 'You' : item.role === 'system' ? 'Workspace update' : 'ros.ai'}</span><time>{time(item.createdAt)}</time></div>{item.role === 'assistant' ? <AssistantResponse content={item.content} detail={detail} onAnswer={busy||submission?.status==='pending'?undefined:questions=>openAnswers(`message:${item.id}`,questions)}/> : <RichText text={item.content}/>}</article>)}</details>}
      {turns.map(turn => <Turn key={turn.id} turn={turn} detail={detail} onReference={onReference} onDecision={onDecision} onInspectAction={onInspectAction} onAnswer={busy||submission?.status==='pending'?undefined:questions=>openAnswers(turn.id,questions)}/>)}
      {pending.map(proposal => {const structure=proposalStructurePreview(proposal,detail.project.canvas.nodes);return <div className="assistant-pending-outline" key={proposal.id}>{structure&&<AssistantStructurePreview structure={structure} existingNodes={detail.project.canvas.nodes} validation="proposal"/>}<button className="assistant-pending-proposal" onClick={() => onReference({kind:'proposal',id:proposal.id,label:proposal.summary})}><GitBranch size={16}/><span><strong>Review canvas changes</strong>{!structure&&<small>{proposal.summary}</small>}</span><ChevronRight size={15}/></button></div>;})}
      {submission&&submission.status!=='pending'&&<section className="assistant-submission-failure" role="alert"><div className="message-meta">Your submission · {submission.status==='uncertain'?'Admission unconfirmed':'Not admitted'}</div><RichText text={submission.message}/><p>{submission.error}</p><button type="button" className="secondary small" onClick={()=>void onRefresh()}>Refresh saved activity</button><button type="button" className="text-button" onClick={onConnections}>Inspect connection</button><p className="subtle">No automatic retry. A new message is a deliberate continuation.</p></section>}
      {busy && !active && <div className="assistant-working" role="status"><LoaderCircle size={14} className="spin"/> Saving your question…</div>}
    </div>
    {blocker&&!running&&<div className="assistant-admission" role="status"><div><CircleHelp size={14}/><span>{blocker.summary}</span><button type="button" onClick={()=>{if(blocker.action==='budget'){setBudgetOpen(!budgetOpen);setSettingsOpen(false);}else if(blocker.action==='model')void changeBackend('provider');else if(blocker.action==='permissions')onPermissions();else onConnections();}} disabled={backendBusy}>{blocker.action==='budget'?'Set project budget':blocker.action==='model'?'Choose API model':blocker.action==='permissions'?'Review permissions':'Open connections'}<ArrowRight size={12}/></button></div></div>}
    {budgetOpen&&<AssistantBudgetSetup projectId={detail.project.id} nodeId={focusedNode?.id} onChanged={onRefresh} onConnections={onConnections} onClose={()=>setBudgetOpen(false)}/>}
    {preparedNotice&&<p className="assistant-prepared-notice" role="status">{preparedNotice}</p>}
    <form className="assistant-composer" onSubmit={event => void submit(event)}><label className="sr-only" htmlFor="assistant-message">Message research assistant</label><textarea id="assistant-message" ref={textarea} data-testid="project-message" value={message} rows={3} placeholder={focusedNode ? `Ask about ${focusedNode.title}…` : 'Ask, explore, or change direction…'} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(event); } }}/><div className="assistant-composer-actions"><button type="button" className="assistant-permissions" onClick={onPermissions}><ShieldCheck size={13}/><span>Permissions</span></button>{active ? <button type="button" className="assistant-stop" aria-label="Stop assistant" onClick={() => void onCancel(active.id)}><Square size={13}/> Stop</button> : <button className="send-button" data-testid="send-project-message" aria-label="Send project message" title={blocker?.summary||'Send project message'} disabled={!message.trim() || running || !state || modelBlocked || backendBusy}><ArrowUp size={18}/></button>}</div></form><div className="assistant-provider-status"><span className={`status-dot ${state?.modelAvailable ? 'available' : ''}`}/>{!state ? 'Opening saved conversation…' : state.modelAvailable ? state.backend==='codex'?'Codex admission enabled':'Model requests enabled' : 'Model unavailable · draft stays saved'}</div></> : <ResearchOutline state={state} detail={detail} onReference={onReference}/>}
  </aside>;
}

function HistoryLabel() { return <BookOpen size={13}/>; }

function assistantBlocker(reason:string,backend?:'provider'|'codex'):{summary:string;action:'budget'|'model'|'connections'|'permissions'} {
  if(backend==='codex'&&/restricted read|isolation boundary|isolate reads|workspace isolation/i.test(reason))return {summary:'Codex needs a CLI with workspace read isolation.',action:'model'};
  if(/project spending ceiling|project.*spend.*allowance/i.test(reason))return {summary:'This project has no remaining model budget.',action:'budget'};
  if(/stopped|stop flag/i.test(reason))return {summary:'Research is stopped for this project.',action:'permissions'};
  if(/project model-request limit/i.test(reason))return {summary:'This project has used its model-request limit.',action:'permissions'};
  if(/allowance|authorization|authorized|spending|grant/i.test(reason))return {summary:backend==='codex'?'Codex needs a usage allowance.':'Enable usage for this model connection.',action:'connections'};
  if(/credential|api key|configured/i.test(reason))return {summary:'Connect the selected model provider.',action:'connections'};
  return {summary:backend==='codex'?'Codex cannot start. Check connection details.':'The model cannot start. Check connection details.',action:'connections'};
}

function ReferenceLinks({ references, onReference }: { references: AssistantReference[]; onReference: Props['onReference'] }) {
  if (!references.length) return null;
  return <div className="assistant-references">{references.map((reference, index) => <button key={`${reference.kind}:${reference.id}:${index}`} onClick={() => onReference(reference)} title={`Open ${reference.label}`}>{reference.kind === 'artifact' ? <FileText size={12}/> : reference.kind === 'proposal' ? <GitBranch size={12}/> : <BookOpen size={12}/>}<span>{textPreview(reference.label,48).text}</span><ArrowRight size={11}/></button>)}</div>;
}

function Turn({ turn, detail, onReference, onDecision, onInspectAction, onAnswer }: { turn: AssistantTurn; detail: ProjectDetail; onReference: Props['onReference']; onDecision: Props['onDecision']; onInspectAction: Props['onInspectAction']; onAnswer?: (questions: AssistantClarificationQuestion[]) => void }) {
  const focus = detail.project.canvas.nodes.find(node => node.id === turn.focus.nodeId);
  // Admission failures retain one persistent alert. The stored reply/error
  // remain intact; an identical failure should not appear as two responses.
  const reply = turn.reply.trim() === turn.error?.trim() ? '' : turn.reply;
  const blockedRecord = turn.source==='local-records' && reply.includes('[Saved-record view') && /allowance|authorization|spending ceiling|model unavailable/i.test(reply);
  const savedStructure = turn.actions.some(action => {
    const proposal = detail.proposals.find(item => item.id === action.proposalId);
    return proposal && Boolean(proposalStructurePreview(proposal, detail.project.canvas.nodes));
  });
  return <section className="assistant-turn" data-turn-id={turn.id}>
    <article className="assistant-message user"><div className="message-meta"><span>You</span><time>{time(turn.createdAt)}</time>{focus && <span className="turn-focus" title={focus.title}>{focus.title}</span>}</div><RichText text={turn.userMessage}/></article>
    <article className="assistant-message response"><div className="message-meta"><span className="assistant-message-mark" aria-hidden="true"/><span>ros.ai</span><span className="response-source">{turn.source === 'local-records' ? 'Saved context' : turn.source==='codex-agent'?'Codex connection':'Research model'}</span></div>{turn.model&&<p className="assistant-actual-model">{turn.model}{turn.destination&&<> · {turn.location==='local-verified'?'On this computer':turn.location==='local-unverified'?`${turn.destination} · local processing unverified`:`Sent to ${turn.destination}`}</>}</p>}<AssistantResponse content={reply} question={turn.question?.trim()===turn.error?.trim()?undefined:turn.question} clarifications={turn.clarifications} structure={turn.structure} detail={detail} hideStructure={savedStructure} blockedRecord={blockedRecord} onAnswer={onAnswer}/><ReferenceLinks references={turn.references} onReference={onReference}/>
      {turn.warning&&<details className="assistant-failure-details"><summary><CircleHelp size={14}/><span>Reply saved · proposal details</span></summary><p>{turn.warning}</p><p>Unvalidated actions were not applied.</p></details>}
      {turn.status === 'running' && <div className="assistant-working" role="status"><LoaderCircle size={14} className="spin"/>{turn.events.at(-1)?.message || 'Working on your question…'}</div>}
      {turn.error && <details className="assistant-failure-details"><summary><CircleHelp size={14}/><span>Attempt failed</span><span>Details</span></summary><p>{turn.error}</p></details>}
      {['interrupted','cancelled'].includes(turn.status) && <p className="assistant-interrupted">{turn.status === 'cancelled' ? 'Stopped. Saved work remains available.' : 'Interrupted. Send a follow-up to continue from the saved work.'}</p>}
      {turn.actions.map(action => <ActionCard key={action.id} action={action} detail={detail} onReference={onReference} onDecision={onDecision} onInspectAction={onInspectAction}/>)}
      {turn.events.length > 0 && <details className="assistant-turn-events"><summary>Activity · {turn.events.length}</summary><ol>{turn.events.map((event, index) => <li key={index}><time>{time(event.at)}</time><span>{event.message}</span></li>)}</ol></details>}
    </article>
  </section>;
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

function ActionCard({ action, detail, onReference, onDecision, onInspectAction }: { action: AssistantAction; detail: ProjectDetail; onReference: Props['onReference']; onDecision: Props['onDecision']; onInspectAction: Props['onInspectAction'] }) {
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
  return <div className={`assistant-action status-${status}`}><div className="assistant-action-title">{action.type === 'proposal' ? <GitBranch size={15}/> : action.type === 'reuse' ? <FileText size={15}/> : <BookOpen size={15}/>}<strong title={action.title}>{title.text}</strong><span>{status === 'pending' ? 'Review' : status}</span></div>{title.truncated&&<details className="assistant-action-description"><summary>Full request</summary><p>{action.title}</p></details>}{action.error && <p>{action.error}</p>}{structure&&<AssistantStructurePreview structure={structure} existingNodes={detail.project.canvas.nodes} validation="proposal"/>}{action.type === 'reuse' && action.status === 'pending' ? <><p>Use <strong>{reuseArtifact?.title||'the selected artifact'}</strong>{reuseArtifact&&<> · version <code>{reuseArtifact.hash.slice(0,8)}</code></>} as an input to <strong>{reuseTarget?.title||'the suggested note'}</strong>.</p>{reuseArtifact&&<ReferenceLinks references={[{kind:'artifact',id:reuseArtifact.id,label:'Inspect this version',nodeId:reuseArtifact.nodeId}]} onReference={onReference}/>}<div className="assistant-action-buttons"><button className="primary small" disabled={busy} onClick={() => void decide('accept')}><Check size={13}/> Accept reuse</button><button className="text-button" disabled={busy} onClick={() => void decide('dismiss')}>Dismiss</button></div></> : <button className="assistant-action-open" disabled={!canOpen} onClick={open}>{action.type === 'proposal' ? (status === 'pending' ? action.reportProposalId?'Review report revision':'Review canvas changes' : status==='dismissed'?'Proposal dismissed':'View related note') : action.type === 'experiment' ? 'Inspect experiment' : 'Open saved work'}<ArrowRight size={13}/></button>}</div>;
}

function ResearchOutline({ state, detail, onReference }: { state: AssistantState | null; detail: ProjectDetail; onReference: Props['onReference'] }) {
  const kinds: {kind:OutlineEntry['kind'];label:string}[] = [{kind:'decision',label:'Decisions'},{kind:'hypothesis',label:'Hypotheses'},{kind:'gap',label:'Open questions & gaps'}];
  const entries = state?.outline || [];
  const hierarchy = buildOutlineHierarchy(entries, detail);
  const memory = state?.memory;
  const originalQuestion = memory?.originalQuestion;
  const longQuestion = Boolean(originalQuestion && originalQuestion.length > 220);
  const questionPreview = longQuestion ? textPreview(originalQuestion!,180).text : originalQuestion;
  return <div className="assistant-outline outline-hierarchy" id="assistant-outline" role="tabpanel" aria-labelledby="outline-tab">
    <div className="outline-question"><span className="eyebrow"><CircleHelp size={14}/>Original question</span>{originalQuestion ? <><p className={longQuestion ? 'outline-question-preview' : undefined}>{questionPreview}</p>{longQuestion && <details className="outline-original-disclosure"><summary>Show full original question</summary><p>{originalQuestion}</p></details>}</> : <p className="outline-placeholder">{state ? 'Start a conversation to give this research a question.' : 'Opening the research outline…'}</p>}</div>
    {memory && memory.questionHistory.length > 1 && <details className="question-history"><summary>How the question has evolved <span>{memory.questionHistory.length}</span></summary>{memory.questionHistory.map(question => <p key={question.id}><time>{time(question.at)}</time>{question.text}</p>)}</details>}
    {hierarchy.directions.length > 0 && <OutlineSection id="directions" label="Research directions" count={hierarchy.directionCount} projectId={detail.project.id} defaultOpen><div className="outline-direction-list">{hierarchy.directions.map(branch => <OutlineDirection key={branch.entry.id} branch={branch} detail={detail} onReference={onReference}/>)}</div></OutlineSection>}
    {hierarchy.sharedFindings.length > 0 && <OutlineSection id="shared-findings" label="Across directions" count={hierarchy.sharedFindings.length} projectId={detail.project.id} defaultOpen><p className="outline-section-caption">Findings with evidence from more than one direction.</p>{hierarchy.sharedFindings.map(entry => <OutlineItem key={entry.id} entry={entry} detail={detail} onReference={onReference}/>)}</OutlineSection>}
    {hierarchy.unassignedFindings.length > 0 && <OutlineSection id="other-findings" label="Other findings" count={hierarchy.unassignedFindings.length} projectId={detail.project.id} defaultOpen><p className="outline-section-caption">Saved findings without a linked research direction.</p>{hierarchy.unassignedFindings.map(entry => <OutlineItem key={entry.id} entry={entry} detail={detail} onReference={onReference}/>)}</OutlineSection>}
    {kinds.map(({kind,label}) => {const items = entries.filter(entry => entry.kind === kind);if(!items.length)return null;return <OutlineSection id={kind} label={label} count={items.length} projectId={detail.project.id} key={kind}>{items.map(entry => <OutlineItem key={entry.id} entry={entry} detail={detail} onReference={onReference}/>)}</OutlineSection>;})}
    {state && !entries.some(entry => entry.kind !== 'question') && <div className="outline-empty"><ListTree size={25}/><h3>The shape of your research</h3><p>Questions, directions, decisions and findings collect here as you work. References take you back to the notes and evidence.</p></div>}
    <p className="outline-footer">Your original question stays visible as the investigation changes.</p>
  </div>;
}

function OutlineSection({ id, label, count, projectId, defaultOpen = false, children }: { id: string; label: string; count: number; projectId: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(() => readSaved(`outline-section:${projectId}:${id}`, defaultOpen));
  return <details className={`outline-hierarchy-section outline-group-${id}`} open={open} onToggle={event => { setOpen(event.currentTarget.open); saveLocal(`outline-section:${projectId}:${id}`, event.currentTarget.open); }}>
    <summary className="outline-section-toggle"><ChevronRight size={15} className="outline-disclosure-icon"/><h3>{label}</h3><span className="outline-item-count">{count}</span></summary>
    <div className="outline-section-content">{children}</div>
  </details>;
}

function OutlineDirection({ branch, detail, onReference }: { branch: OutlineBranch; detail: ProjectDetail; onReference: Props['onReference'] }) {
  const entry = branch.entry;
  const note = detail.project.canvas.nodes.find(node => node.id === entry.nodeId);
  const title = note?.title || entry.title, summary = note?.description ?? entry.summary;
  const nestedFindings = (item: OutlineBranch): OutlineEntry[] => [...item.findings, ...item.children.flatMap(nestedFindings)];
  const findings = [...new Map(nestedFindings(branch).map(finding => [finding.id, finding])).values()];
  const findingSummary = findings.map(finding => finding.summary || finding.title).filter(Boolean).join(' · ');
  const [open, setOpen] = useState(() => readSaved(`outline-direction:${detail.project.id}:${entry.id}`, branch.findings.length > 0 || branch.children.length > 0));
  return <details className="outline-direction-branch" data-outline-node={entry.nodeId} open={open} onToggle={event => { setOpen(event.currentTarget.open); saveLocal(`outline-direction:${detail.project.id}:${entry.id}`, event.currentTarget.open); }}>
    <summary className="outline-direction-toggle"><ChevronRight size={14} className="outline-disclosure-icon"/><div><strong title={title}>{textPreview(title, 100).text}</strong><p className="outline-collapsed-summary">{textPreview(findingSummary || summary, 160).text || 'Open this direction to inspect its saved context.'}</p><span className="outline-branch-meta">{findings.length ? `${findings.length} saved finding${findings.length === 1 ? '' : 's'}${findings.length > branch.findings.length ? ' across this stage' : ''}` : 'No linked findings yet'}{branch.children.length ? ` · ${branch.children.length} nested direction${branch.children.length === 1 ? '' : 's'}` : ''}</span></div></summary>
    <div className="outline-direction-content">
      <OutlineItem entry={entry} detail={detail} onReference={onReference} directionContext/>
      {branch.findings.length > 0 && <section className="outline-linked-findings" aria-label={`Findings for ${title}`}><h4><FileText size={13}/>Findings<span>{branch.findings.length}</span></h4>{branch.findings.map(finding => <OutlineItem key={finding.id} entry={finding} detail={detail} onReference={onReference}/>)}</section>}
      {branch.children.length > 0 && <div className="outline-nested-directions"><h4>Nested directions</h4>{branch.children.map(child => <OutlineDirection key={child.entry.id} branch={child} detail={detail} onReference={onReference}/>)}</div>}
    </div>
  </details>;
}

function OutlineItem({entry,detail,onReference,directionContext=false}:{entry:OutlineEntry;detail:ProjectDetail;onReference:Props['onReference'];directionContext?:boolean}) {
  const note=entry.kind==='direction'?detail.project.canvas.nodes.find(node=>node.id===entry.nodeId):undefined;
  const title=note?.title||entry.title,summary=note?.description??entry.summary;
  const titlePreview=textPreview(title,64),summaryPreview=textPreview(summary,entry.kind==='direction'?110:170);
  const genericTitle=['Saved finding','Hypothesis','Open question','Decision'].includes(title);
  const hasSummary=summaryPreview.text&&summaryPreview.text!==textPreview(title,Number.MAX_SAFE_INTEGER).text;
  const needsDisclosure=titlePreview.truncated||Boolean(hasSummary&&summaryPreview.truncated);
  const refs=entry.references.filter(reference=>reference.kind!=='node'||reference.id!==entry.nodeId);
  return <article className={`outline-entry ${directionContext ? 'outline-direction-context' : ''}`}>
    {directionContext ? entry.nodeId && <button className="outline-open-direction" title={`Open ${title}`} onClick={()=>onReference({kind:'node',id:entry.nodeId!,label:title,nodeId:entry.nodeId})}>Open note<ArrowRight size={12}/></button> : !genericTitle&&(entry.nodeId?<button className="outline-title" title={title} onClick={()=>onReference({kind:'node',id:entry.nodeId!,label:title,nodeId:entry.nodeId})}><span>{titlePreview.text}</span><ArrowRight size={14}/></button>:<strong className="outline-title" title={title}>{titlePreview.text}</strong>)}
    {hasSummary&&<p className={genericTitle?'outline-main-summary':undefined}>{summaryPreview.text}</p>}
    {needsDisclosure&&<details className="outline-entry-details"><summary>Read full text</summary>{titlePreview.truncated&&<strong>{title}</strong>}{hasSummary&&<p>{summary}</p>}</details>}
    {entry.status&&<span className="outline-status">{entry.status}</span>}
    <ReferenceLinks references={refs.slice(0,2)} onReference={onReference}/>
    {refs.length>2&&<details className="outline-entry-details outline-more-references"><summary>{refs.length-2} more references</summary><ReferenceLinks references={refs.slice(2)} onReference={onReference}/></details>}
  </article>;
}
