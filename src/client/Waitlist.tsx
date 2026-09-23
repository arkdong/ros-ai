import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Check, Maximize2 } from 'lucide-react';
import { api, post } from './api';
import { Wordmark } from './Brand';
import './waitlist.css';

export function Waitlist({ pitch = false }: { pitch?: boolean }) {
  const [count, setCount] = useState<number | null>(null);
  const [countError, setCountError] = useState(false);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = pitch ? 'Waitlist count · ros.ai' : 'Join the waitlist · ros.ai';
    let current = true;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await api<{ count: number }>('/api/waitlist');
        if (current) { setCount(result.count); setCountError(false); }
      } catch { if (current) setCountError(true); }
      finally { loading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { current = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [pitch]);

  const join = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || joined) return;
    setBusy(true); setError('');
    try {
      const result = await post<{ count: number; joined: true }>('/api/waitlist', { email: email.trim() });
      setCount(result.count); setCountError(false); setJoined(true); setEmail('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not join. Please try again.'); }
    finally { setBusy(false); }
  };

  const counter = <div className="waitlist-counter" aria-label="Waitlist signup count">
    <span className="waitlist-counter-value" aria-live="polite" aria-atomic="true">{count === null ? '—' : count.toLocaleString()}</span>
    <span className="waitlist-counter-label">Waitlist {count === 1 ? 'signup' : 'signups'}</span>
    <span className={`waitlist-counter-status ${countError ? 'offline' : ''}`}>
      <span aria-hidden="true"/>{countError ? (count === null ? 'Count unavailable · reconnecting' : 'Last known count · reconnecting') : count === null ? 'Loading live count…' : 'Unique email signups · updates every 5 seconds'}
    </span>
  </div>;

  return <div className={`waitlist-page ${pitch ? 'waitlist-pitch' : ''}`}>
    <header className="waitlist-header">
      <a href="/" aria-label="ros.ai home"><Wordmark/></a>
      <nav aria-label="Waitlist navigation">
        <a href={pitch ? '/waitlist' : '/waitlist/pitch'}>{pitch ? 'Join the waitlist' : <><Maximize2 size={15}/> Pitch view</>}</a>
        <a href="/app">Explore the demo <ArrowRight size={15}/></a>
      </nav>
    </header>
    {pitch ? <main className="waitlist-pitch-main">
      <p className="waitlist-eyebrow">ros.ai · Early access</p>
      <h1>A workspace for curious minds.</h1>
      {counter}
      <a className="waitlist-pitch-url" href="/waitlist">{window.location.host}/waitlist <ArrowRight size={24}/></a>
    </main> : <main className="waitlist-main">
      <section className="waitlist-introduction">
        <p className="waitlist-eyebrow">ros.ai · Early access</p>
        <h1>Make room for your next question.</h1>
        <p className="waitlist-description">Keep your questions, evidence and experiments together. Join the waitlist to hear when ros.ai is ready for you.</p>
        {counter}
      </section>
      <section className="waitlist-form-card" aria-labelledby="waitlist-form-heading">
        {joined ? <div className="waitlist-success" role="status">
          <span className="waitlist-success-icon"><Check size={25}/></span>
          <h2 id="waitlist-form-heading">You’re on the list.</h2>
          <p>Thanks for your interest in ros.ai. We’ll use your email to contact you about early access.</p>
          <a className="waitlist-primary" href="/app">Explore the demo <ArrowRight size={17}/></a>
        </div> : <>
          <span className="waitlist-form-kicker">Build research that stays with you.</span>
          <h2 id="waitlist-form-heading">Join the waitlist</h2>
          <form onSubmit={event => void join(event)}>
            <label htmlFor="waitlist-email">Email address</label>
            <input id="waitlist-email" name="email" type="email" autoComplete="email" inputMode="email" maxLength={254} value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" required disabled={busy} aria-describedby="waitlist-privacy"/>
            <p id="waitlist-privacy">By joining, you agree to be contacted about ros.ai early access. Your email stays private; only the signup count is public.</p>
            {error && <p className="waitlist-error" role="alert">{error}</p>}
            <button className="waitlist-primary" type="submit" disabled={busy}>{busy ? 'Joining…' : 'Join the waitlist'}{!busy && <ArrowRight size={17}/>}</button>
          </form>
        </>}
      </section>
    </main>}
    <footer className="waitlist-footer">Questions. Evidence. Experiments. <span>One place to keep exploring.</span></footer>
  </div>;
}
