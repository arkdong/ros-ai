import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, LoaderCircle, UserRound, X } from 'lucide-react';
import { FEEDBACK_KINDS, FEEDBACK_MAX_CHARS, publicIssueUrl, type FeedbackSetup } from '../shared/feedback';
import { api, post } from './api';
import { BrandLogo } from './brand-logos';
import { readSaved, saveLocal, useDraft } from './persistence';
import './feedback.css';

/** "Chrome 141": the browser's name and major version, never the whole user agent. */
function browserName() {
  const known: [string, RegExp][] = [['Electron', /Electron\/(\d+)/u], ['Edge', /Edg\/(\d+)/u], ['Firefox', /Firefox\/(\d+)/u], ['Chrome', /Chrome\/(\d+)/u], ['Safari', /Version\/(\d+(?:\.\d+)?).*Safari/u]];
  for (const [name, pattern] of known) { const match = pattern.exec(navigator.userAgent); if (match) return `${name} ${match[1]}`; }
  return 'another browser';
}

// Lucide's question mark from circle-help, half as large again so it reads without its circle.
const QuestionMark = () => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7.65 7.5a4.5 4.5 0 0 1 8.7 1.5c0 3-4.5 4.5-4.5 4.5"/><path d="M12 19.5h.01"/></svg>;

/** The question-mark circle in the bottom-right corner of every page, and its card for a problem, an
 * idea or a question. Opening it asks only the local server; nothing leaves this computer until the
 * person presses Send or Post publicly on GitHub. The public demo offers GitHub only. */
export function FeedbackButton({ publicDemo }: { publicDemo: boolean }) {
  const [open, setOpen] = useState(false), [setup, setSetup] = useState<FeedbackSetup>();
  const [kindId, setKind] = useDraft('feedback-kind', 'problem'), [message, setMessage] = useDraft('feedback-message'), [email, setEmail] = useDraft('feedback-email');
  const [withDetails, setWithDetails] = useState(() => readSaved('feedback-details', true));
  const [sending, setSending] = useState(false), [error, setError] = useState(''), [sent, setSent] = useState<{ email?: string }>();
  const box = useRef<HTMLDivElement>(null), circle = useRef<HTMLButtonElement>(null), text = useRef<HTMLTextAreaElement>(null);
  const kind = FEEDBACK_KINDS.find(item => item.id === kindId) ?? FEEDBACK_KINDS[0], ready = Boolean(setup);

  const close = () => { setOpen(false); setSent(undefined); setError(''); };
  useEffect(() => {
    if (!open) return;
    // Asked on every open, so signing in or out shows straight away.
    if (publicDemo) setSetup({ cloud: false, details: 'ros.ai public demo' });
    else api<FeedbackSetup>('/api/feedback').then(setSetup, () => setSetup({ cloud: false, details: 'ros.ai' }));
    // Captured, because the map stops presses from bubbling up to the page.
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) close(); };
    // Handled here first, so the app's own Escape (which closes open views) leaves them alone.
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); circle.current?.focus(); } };
    document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key); };
  }, [open, publicDemo]);
  useEffect(() => { if (open && ready && !sent) text.current?.focus(); }, [open, ready, sent]);

  const details = setup ? `${setup.details} · ${browserName()}` : '';
  const publicUrl = publicIssueUrl({ kind: kind.id, message, ...(withDetails && details ? { details } : {}) });
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!setup?.cloud) { window.open(publicUrl, '_blank', 'noopener,noreferrer'); return; }
    if (!message.trim() || sending) return;
    setSending(true); setError('');
    try {
      setSent(await post<{ email?: string }>('/api/feedback', { kind: kind.id, message: message.trim(), ...(!setup.email && email.trim() ? { email: email.trim() } : {}), ...(withDetails ? { details } : {}) }));
      setMessage('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSending(false); }
  };

  return <div className={`feedback ${open ? 'open' : ''}`} ref={box}>
    <button ref={circle} type="button" className="feedback-circle" aria-label="Send feedback" title="Send feedback" aria-haspopup="dialog" aria-expanded={open} onClick={() => open ? close() : setOpen(true)}><QuestionMark/></button>
    {open && setup && <div className="feedback-card-space"><section className="feedback-card" role="dialog" aria-label="Send feedback">
      <header><strong>Send feedback</strong><button type="button" className="feedback-close" aria-label="Close" onClick={close}><X size={16}/></button></header>
      {sent ? <>
        <div className="feedback-sent" role="status"><span className="feedback-sent-mark"><Check size={15}/></span><div><strong>Thanks, it’s with the ros.ai team.</strong>{sent.email && <small>We’ll reply to {sent.email}.</small>}</div></div>
        <footer><button type="button" className="text-button" onClick={() => setSent(undefined)}>Send another</button><button type="button" className="secondary small" autoFocus onClick={close}>Done</button></footer>
      </> : <form onSubmit={event => void send(event)}>
        <div className="feedback-kinds" role="radiogroup" aria-label="Kind of note">{FEEDBACK_KINDS.map(item => <label key={item.id} className={item.id === kind.id ? 'on' : ''}><input type="radio" name="feedback-kind" value={item.id} checked={item.id === kind.id} onChange={() => setKind(item.id)}/>{item.label}</label>)}</div>
        <textarea ref={text} className="feedback-text" aria-label="Your note" placeholder={kind.hint} value={message} maxLength={FEEDBACK_MAX_CHARS} onChange={event => setMessage(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}/>
        {setup.cloud && (setup.email ? <p className="feedback-reply"><UserRound size={14}/>Replies go to {setup.email}</p>
          : <input type="email" className="feedback-email" aria-label="Email for a reply" placeholder="Email, if you’d like a reply" autoComplete="email" maxLength={254} value={email} onChange={event => setEmail(event.target.value)}/>)}
        <label className="feedback-details"><input type="checkbox" checked={withDetails} onChange={event => { setWithDetails(event.target.checked); saveLocal('feedback-details', event.target.checked); }}/><span>Include app details<small>{details}</small></span></label>
        {error && <p className="feedback-error" role="alert"><span className="feedback-error-dot"/>{error} Your note is kept here, so you can try again or post it on GitHub.</p>}
        <footer>{setup.cloud ? <>
          <a className="feedback-public" href={publicUrl} target="_blank" rel="noopener noreferrer"><BrandLogo id="github" size={14}/>Post publicly on GitHub</a>
          <button type="submit" className="primary small" disabled={!message.trim() || sending}>{sending && <LoaderCircle size={13} className="spin"/>}{error ? 'Try again' : 'Send'}</button>
        </> : <a className="primary small feedback-github" href={publicUrl} target="_blank" rel="noopener noreferrer"><BrandLogo id="github" size={14}/>Post on GitHub</a>}</footer>
      </form>}
    </section></div>}
  </div>;
}
