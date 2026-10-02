import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine, Check, X } from 'lucide-react';
import type { AssistantClarificationQuestion } from '../shared/assistant-clarifications';
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
  const id = useId(), panel = useRef<HTMLDivElement>(null), close = useRef(onClose);
  close.current = onClose;
  const signature = JSON.stringify(questions);
  const storageKey = `assistant-answers:${projectId}:${turnId}:${answerQuestionFingerprint(questions)}`;
  const [answers, setAnswers] = useState(() => savedAnswers(storageKey, signature, questions));
  const [error, setError] = useState('');
  const count = answers.filter(answer => answer.leaveOut || answer.selected.length || answer.custom.trim()).length;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.querySelector<HTMLElement>('input:not(:disabled),textarea:not(:disabled),button:not(:disabled)')?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return; }
      if (event.key !== 'Tab') return;
      const elements = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]') ?? [])].filter(element => element.getClientRects().length);
      const first = elements[0], last = elements.at(-1);
      if (!first || !last) { event.preventDefault(); panel.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyDown, true);
    return () => {
      document.removeEventListener('keydown', keyDown, true);
      document.body.style.overflow = previousOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const change = (index: number, patch: Partial<AnswerDraft>) => {
    const next = answers.map((answer, position) => position === index ? { ...answer, ...patch } : answer);
    setAnswers(next); setError(''); saveLocal(storageKey, { signature, answers: next });
  };
  const prepare = (event: FormEvent) => {
    event.preventDefault();
    if (!count) return;
    const prepared = questions.flatMap((question, index) => {
      const answer = answers[index];
      if (answer.leaveOut) return [`${index + 1}. ${question.question}\nAnswer: Not important — leave this out of the research.`];
      const values = answer.selected.map(option => question.options[option]);
      if (answer.custom.trim()) values.push(answer.custom.trim());
      return values.length ? [`${index + 1}. ${question.question}\nAnswer: ${values.join('; ')}`] : [];
    });
    const text = `Answers to your follow-up questions:\n\n${prepared.join('\n\n')}`;
    if (appendPreparedAnswers(composerText, text).length > 12000) {
      setError('These answers and your current draft exceed the 12,000 character message limit. Shorten an answer or close this dialog to edit your draft. Both drafts are retained.'); return;
    }
    const problem = onPrepare(text);
    if (problem) setError(problem);
  };
  return createPortal(<div className="assistant-answer-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} className="assistant-answer-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-help`} tabIndex={-1}>
      <header><div><h2 id={`${id}-title`}>Answer follow-up questions</h2><p id={`${id}-help`}>Choose up to two options for each question, add your own answer, or leave it out.</p></div><button className="icon-button" type="button" aria-label="Close answers" onClick={onClose}><X size={17}/></button></header>
      <form onSubmit={prepare}>
        <div className="assistant-answer-questions">{questions.map((question, index) => {
          const answer = answers[index];
          return <fieldset key={question.id} className="assistant-answer-question"><legend><span>{index + 1}</span><span><InlineText text={question.question}/></span></legend>
            {question.options.length > 0 && <><div className="assistant-answer-options">{question.options.map((option, optionIndex) => {
              const selected = answer.selected.includes(optionIndex);
              return <label key={optionIndex} className={selected ? 'selected' : ''}><input type="checkbox" checked={selected} disabled={answer.leaveOut || (!selected && answer.selected.length >= 2)} onChange={event => { if (event.target.checked && answer.selected.length >= 2) return; change(index, { selected: event.target.checked ? [...answer.selected, optionIndex] : answer.selected.filter(value => value !== optionIndex) }); }}/><span><InlineText text={option}/></span>{selected && <Check size={13} aria-hidden="true"/>}</label>;
            })}</div><small className="assistant-answer-selection-help">{answer.selected.length === 2 && !answer.leaveOut ? 'Two selected. Uncheck one to choose another.' : 'Select up to two.'}</small></>}
            <label className="assistant-answer-custom" htmlFor={`${id}-custom-${index}`}>Your own answer · up to 2,000 characters<textarea id={`${id}-custom-${index}`} rows={2} maxLength={2000} disabled={answer.leaveOut} value={answer.custom} placeholder="Add a detail, a preference, or a different answer…" onChange={event => change(index, { custom: event.target.value })}/></label>
            <label className="assistant-answer-leave-out"><input type="checkbox" checked={answer.leaveOut} onChange={event => change(index, { leaveOut: event.target.checked })}/><span>Not important · leave out</span></label>
          </fieldset>;
        })}</div>
        {error && <p className="assistant-answer-error" role="alert">{error}</p>}
        <footer><div><strong>{count} of {questions.length} answered</strong><p>Added to your existing draft. You decide when to send.</p></div><button type="submit" className="primary small" disabled={!count}><ArrowDownToLine size={14}/> Add answers to draft</button></footer>
      </form>
    </div>
  </div>, document.body);
}

export function AssistantFollowUpQuestions({ questions, onAnswer }: { questions: AssistantClarificationQuestion[]; onAnswer?: () => void }) {
  if (!questions.length) return null;
  const compact = questions.length > 1 || questions[0].question.length > 240;
  const wording = <ol>{questions.map(question => <li key={question.id}><RichText text={question.question}/></li>)}</ol>;
  return <div className="assistant-follow-up assistant-question-list"><span>{compact ? `${questions.length} question${questions.length === 1 ? '' : 's'} to clarify` : 'Follow-up question'}</span>{compact ? <details><summary>Read questions</summary>{wording}</details> : wording}{onAnswer && <button type="button" className="secondary small" onClick={onAnswer}>Answer {questions.length === 1 ? 'question' : 'questions'}<ArrowDownToLine size={13}/></button>}</div>;
}
