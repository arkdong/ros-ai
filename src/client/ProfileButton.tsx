import { useCallback, useEffect, useRef, useState } from 'react';
import { ChartColumn, LoaderCircle, LogOut, Settings2, UserRound } from 'lucide-react';
import type { CloudAccountStatus } from '../shared/cloud-account';
import { api, post } from './api';
import './profile-button.css';

/** Tells every view of the ros.ai account to look again, e.g. after the Agents page signs in. */
export const cloudAccountChanged = () => window.dispatchEvent(new Event('ros-cloud-changed'));

/** The account row at the bottom of the sidebar: Sign in when signed out, your email and a small
 * menu when signed in. It reuses the device sign-in on the local server; the browser page at
 * ros.ai cloud is where people sign in or create their account. */
export function ProfileButton({ onUsage, onSettings, onChanged }: { onUsage: () => void; onSettings: () => void; onChanged: () => Promise<unknown> }) {
  const [status, setStatus] = useState<CloudAccountStatus>(), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null), changed = useRef(onChanged);
  changed.current = onChanged;
  const refresh = useCallback(() => api<CloudAccountStatus>('/api/cloud').then(setStatus, () => undefined), []);
  useEffect(() => {
    void refresh();
    window.addEventListener('ros-cloud-changed', refresh); window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('ros-cloud-changed', refresh); window.removeEventListener('focus', refresh); };
  }, [refresh]);
  const waiting = status?.state === 'waiting';
  // While the browser approval is open, check every few seconds; the local server does the polling.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(async () => {
      const next = await api<CloudAccountStatus>('/api/cloud').catch(() => undefined);
      if (next && next.state !== 'waiting') { setStatus(next); cloudAccountChanged(); await changed.current().catch(() => undefined); }
    }, 3000);
    return () => clearInterval(timer);
  }, [waiting]);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);

  const signIn = async () => {
    // Open the tab inside the click so the browser allows it, then point it at the sign-in page.
    const tab = window.open('', '_blank');
    setBusy(true); setError('');
    try {
      const next = await post<CloudAccountStatus>('/api/cloud/sign-in'); setStatus(next);
      if (tab && next.verificationUrl) { tab.opener = null; tab.location.href = next.verificationUrl; } else tab?.close();
    } catch (cause) { tab?.close(); setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  const signOut = async () => {
    setBusy(true); setError('');
    try { setStatus(await post<CloudAccountStatus>('/api/cloud/sign-out')); setOpen(false); cloudAccountChanged(); await changed.current(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  const go = (to: () => void) => { setOpen(false); to(); };

  if (!status?.available) return <div className="local-label"><span className="local-square"/> Saved on this computer</div>;
  const signedIn = status.state === 'signed-in', email = status.email || 'Your account';
  const problem = error || status.error;
  return <div className="profile" ref={box}>
    <button className={`profile-row ${open ? 'open' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void refresh(); }}>
      {signedIn ? <span className="profile-avatar signed-in" aria-hidden="true">{email.charAt(0).toUpperCase()}</span> : <span className="profile-avatar" aria-hidden="true"><UserRound size={14}/></span>}
      <span className="profile-name">{signedIn ? email : status.state === 'expired' ? 'Sign in again' : 'Sign in'}</span>
    </button>
    {open && <div className="profile-menu" role="dialog" aria-label={signedIn ? 'Your account' : 'Sign in to ros.ai'}>
      {signedIn ? <>
        <div className="profile-menu-head"><strong>{email}</strong>{status.leftTodayUsd !== undefined && <span>Hosted Ros · US${status.leftTodayUsd.toFixed(2)} left today</span>}</div>
        {problem && <p className="inline-error" role="alert">{problem}</p>}
        <button className="profile-item" onClick={() => go(onUsage)}><ChartColumn size={15}/> Usage</button>
        <button className="profile-item" onClick={() => go(onSettings)}><Settings2 size={15}/> Settings</button>
        <div className="profile-divider"/>
        <button className="profile-item" disabled={busy} onClick={() => void signOut()}>{busy ? <LoaderCircle size={15} className="spin"/> : <LogOut size={15}/>} Sign out</button>
      </> : waiting ? <div className="profile-sign-in">
        <strong>Approve in your browser</strong>
        <p>Check that the page shows this code.</p>
        <div className="profile-code">{status.userCode}</div>
        <div className="profile-links"><a href={status.verificationUrl} target="_blank" rel="noreferrer">Open the page again</a><button className="text-button" disabled={busy} onClick={() => void signIn()}>Start again</button></div>
      </div> : <div className="profile-sign-in">
        <strong>Sign in to ros.ai</strong>
        <p>Use Ros hosted by ros.ai, free while ros.ai is new. Your projects stay on this computer.</p>
        {problem && <p className="inline-error" role="alert">{problem}</p>}
        <button className="primary profile-primary" disabled={busy} onClick={() => void signIn()}>{busy && <LoaderCircle size={13} className="spin"/>}Sign in or create account</button>
        <small>Opens ros.ai in your browser</small>
      </div>}
    </div>}
  </div>;
}
