import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUp, Check, Pencil, X } from 'lucide-react';
import { ASSISTANT_CLARIFICATION_LIMITS, type AssistantClarificationQuestion } from '../shared/assistant-clarifications';
import { InlineText, RichText } from './Content';
import { readSaved, saveLocal } from './persistence';
import './assistant-answer-dialog.css';

type AnswerDraft = { selected: number[]; custom: string; leaveOut: boolean };
type Props = {
  projectId: string;
  turnId: string;
  questions: AssistantClarificationQuestion[];
  composerText: string;
  onPrepare: (answers: string) => string | null;
  onClose: () => void;
};
const emptyAnswer = (): AnswerDraft => ({ selected: [], custom: '', leaveOut: false });
export function appendPreparedAnswers(current: string, prepared: string): string {
  return current + (current ? current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n' : '') + prepared;
}

/** Local draft identity only; exact content is checked again before reuse. */
export function answerQuestionFingerprint(questions: readonly AssistantClarificationQuestion[]): string {
  const text = JSON.stringify(questions);
  let first = 2166136261, second = 2246822507;
  for (let index = 0; index < text.length; index++) {
    first = Math.imul(first ^ text.charCodeAt(index), 16777619);
    second = Math.imul(second ^ text.charCodeAt(index), 3266489909);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function savedAnswers(key: string, signature: string, questions: readonly AssistantClarificationQuestion[]): AnswerDraft[] {
  const saved = readSaved<unknown>(key, null);
  if (!saved || typeof saved !== 'object' || !('signature' in saved) || saved.signature !== signature || !('answers' in saved) || !Array.isArray(saved.answers)) return questions.map(emptyAnswer);
  const answers = saved.answers;
  return questions.map((question, index) => {
    const answer: unknown = answers[index];
    if (!answer || typeof answer !== 'object') return emptyAnswer();
    const selected = 'selected' in answer && Array.isArray(answer.selected) ? [...new Set(answer.selected.filter((value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < question.options.length))].slice(0, 2) : [];
    return { selected, custom: 'custom' in answer && typeof answer.custom === 'string' ? answer.custom.slice(0, 2000) : '', leaveOut: 'leaveOut' in answer && answer.leaveOut === true };
  });
}

export function AssistantAnswerDialog({ projectId, turnId, questions, composerText, onPrepare, onClose }: Props) {
  const id = useId(), panel = useRef<HTMLDivElement>(null);
  const signature = JSON.stringify(questions);
  const storageKey = `assistant-answers:${projectId}:${turnId}:${answerQuestionFingerprint(questions)}`;
  const [answers, setAnswers] = useState(() => savedAnswers(storageKey, signature, questions));
  const [step, setStep] = useState(0);
  const [error, setError] = useState('');
  const count = answers.filter(answered).length;
  const question = questions[step], answer = answers[step], last = step === questions.length - 1;
  const multiple = questions.length > 1;
  // Keep the keyboard in the card as questions change; a question without choices starts in its answer field.
  useEffect(() => { (question.options.length ? panel.current : panel.current?.querySelector('textarea'))?.focus(); }, [step]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = (index: number, patch: Partial<AnswerDraft>) => {
    const next = answers.map((item, position) => position === index ? { ...item, ...patch } : item);
    setAnswers(next); setError(''); saveLocal(storageKey, { signature, answers: next });
  };
  const toggle = (option: number) => {
    const selected = answer.selected.includes(option) ? answer.selected.filter(value => value !== option) : answer.selected.length >= ASSISTANT_CLARIFICATION_LIMITS.selectedOptions ? answer.selected : [...answer.selected, option];
    change(step, { selected, leaveOut: false });
  };
  const go = (next: number) => { setStep(Math.max(0, Math.min(questions.length - 1, next))); setError(''); };
  const prepare = () => {
    if (!count) return;
    const prepared = questions.flatMap((item, index) => {
      const draft = answers[index];
      if (draft.leaveOut) return [`${index + 1}. ${item.question}\nAnswer: Not important — leave this out of the research.`];
      const values = draft.selected.map(option => item.options[option]);
      if (draft.custom.trim()) values.push(draft.custom.trim());
      return values.length ? [`${index + 1}. ${item.question}\nAnswer: ${values.join('; ')}`] : [];
    });
    const text = `Answers to your follow-up questions:\n\n${prepared.join('\n\n')}`;
    if (appendPreparedAnswers(composerText, text).length > 12000) { setError('These answers and your draft exceed the 12,000 character limit. Shorten an answer first.'); return; }
    const problem = onPrepare(text);
    if (problem) setError(problem);
  };
  const advance = () => last ? prepare() : go(step + 1);
  const skip = () => { change(step, { leaveOut: true, selected: [], custom: '' }); if (!last) go(step + 1); };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.target instanceof HTMLTextAreaElement) return;
    const digit = Number(event.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= question.options.length) { event.preventDefault(); toggle(digit - 1); }
    else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); advance(); }
    else if (event.key === 'ArrowLeft' && multiple) { event.preventDefault(); go(step - 1); }
    else if (event.key === 'ArrowRight' && multiple) { event.preventDefault(); go(step + 1); }
  };
  return <div ref={panel} className="ros-question" role="group" aria-labelledby={`${id}-question`} tabIndex={-1} onKeyDown={keyDown}>
    <header>
      {multiple ? <nav className="ros-question-steps" aria-label="Questions">{questions.map((item, index) => <button key={item.id} type="button" className={`${index === step ? 'current' : ''} ${answered(answers[index]) ? 'answered' : ''}`} aria-current={index === step ? 'step' : undefined} aria-label={`Question ${index + 1}${answered(answers[index]) ? ', answered' : ''}`} onClick={() => go(index)}>{answered(answers[index]) && index !== step ? <Check size={11}/> : index + 1}</button>)}</nav> : <span className="ros-question-kicker">ROS asks</span>}
      <button className="icon-button" type="button" aria-label="Close questions" title="Close (Esc)" onClick={onClose}><X size={15}/></button>
    </header>
    <div className="ros-question-body">
      <p id={`${id}-question`} className="ros-question-text"><InlineText text={question.question}/></p>
      <div className="ros-question-options" role="group" aria-label="Choices">
        {question.options.map((option, index) => {
          const selected = answer.selected.includes(index);
          return <button key={index} type="button" className={selected ? 'selected' : ''} aria-pressed={selected} onClick={() => toggle(index)}><kbd>{index + 1}</kbd><span><InlineText text={option}/></span>{selected && <Check size={14} aria-hidden="true"/>}</button>;
        })}
        <label className={`ros-question-other ${answer.custom.trim() ? 'selected' : ''}`}><Pencil size={13} aria-hidden="true"/><textarea key={question.id} rows={1} maxLength={2000} value={answer.custom} placeholder={question.options.length ? 'Something else…' : 'Type your answer…'} aria-label="Your own answer" onChange={event => { change(step, { custom: event.target.value, leaveOut: false }); grow(event.target); }} ref={grow} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); advance(); } }}/></label>
      </div>
      {question.options.length > 1 && <small className="ros-question-hint">Pick up to two{question.options.length < 10 ? ', or press 1–' + question.options.length : ''}</small>}
      {answer.leaveOut && <small className="ros-question-hint">Skipped. ROS will leave this out.</small>}
    </div>
    {error && <p className="ros-question-error" role="alert">{error}</p>}
    <footer>
      <button type="button" className="text-button" onClick={skip}>Skip</button>
      <span className="ros-question-spacer"/>
      {step > 0 && <button type="button" className="secondary small" onClick={() => go(step - 1)}>Back</button>}
      {last ? <button type="button" className="primary small" disabled={!count} title="Adds your answers to the message. You decide when to send." onClick={prepare}>Add to message <ArrowUp size={13}/></button> : <button type="button" className="primary small" onClick={() => go(step + 1)}>Next <ArrowRight size={13}/></button>}
    </footer>
  </div>;
}

const answered = (answer: AnswerDraft) => answer.leaveOut || answer.selected.length > 0 || Boolean(answer.custom.trim());
/** The answer field grows with its text, up to a few lines. */
const grow = (element: HTMLTextAreaElement | null) => { if (!element) return; element.style.height = 'auto'; element.style.height = `${Math.min(element.scrollHeight, 160)}px`; };

export function AssistantFollowUpQuestions({ questions, onAnswer }: { questions: AssistantClarificationQuestion[]; onAnswer?: () => void }) {
  if (!questions.length) return null;
  const compact = questions.length > 1 || questions[0].question.length > 240;
  const wording = <ol>{questions.map(question => <li key={question.id}><RichText text={question.question}/></li>)}</ol>;
  return <div className="assistant-follow-up assistant-question-list"><span>{compact ? `${questions.length} question${questions.length === 1 ? '' : 's'} to clarify` : 'Follow-up question'}</span>{compact ? <details><summary>Read questions</summary>{wording}</details> : wording}{onAnswer && <button type="button" className="secondary small" onClick={onAnswer}>Answer {questions.length === 1 ? 'question' : 'questions'}<ArrowDownToLine size={13}/></button>}</div>;
}
