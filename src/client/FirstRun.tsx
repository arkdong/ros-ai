import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, LoaderCircle, Table2, Text } from 'lucide-react';
import type { AppId, SetupStatus } from '../shared/setup';
import type { CloudAccountStatus } from '../shared/cloud-account';
import type { LocalRosStatus } from '../shared/local-ros';
import { BrandLogo } from './brand-logos';
import { Wordmark } from './Brand';
import { RosMark } from './RosDock';
import { cloudAccountChanged } from './ProfileButton';
import { gb, macApp, SetupScreen, useLocalRos, type SetupSummary } from './Setup';
import { api, post } from './api';
import './first-run.css';

/** The first run from the very start, in a window of its own with no sidebar: what ros.ai is, then an account or not, with
 * Ros downloaded to this computer in the background if the person wants it, then the tools found here. The app opens
 * after, on the question box. */

type Step = 'welcome' | 'account' | 'tools';
type Props = { status: SetupStatus; onDone: (summary?: SetupSummary) => void; onPlugins: (id: AppId) => void; onRescan: () => Promise<unknown>; onRefresh: () => Promise<unknown>; onChanged: () => Promise<unknown> };
const fail = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** A small picture of a canvas: a question, data and a Notion page, with agents from two vendors working from them. */
function WelcomeMap() {
  const block = (left: string, top: number, kind: ReactNode, title: string, detail?: string) => <span className="first-run-block" style={{ left, top }}>
    <span className="first-run-kind">{kind}</span><strong>{title}</strong>{detail && <span className="first-run-sub">{detail}</span>}
  </span>;
  return <div className="first-run-map" role="img" aria-label="A canvas holding a question, interview data and a Notion page, which Claude Code and Codex work from">
    <svg className="first-run-lines" viewBox="0 0 622 292" preserveAspectRatio="none" aria-hidden="true"><path d="M224 55C311 55 311 87 398 87"/><path d="M224 146C311 146 311 87 398 87"/><path d="M224 146C311 146 311 205 398 205"/><path d="M224 237C311 237 311 205 398 205"/></svg>
    {block('4.5%', 20, <><Text size={12}/>Text</>, 'Why do trial users leave in week two?')}
    {block('4.5%', 111, <><Table2 size={12}/>Data</>, 'interviews.csv', '42 rows · 6 columns')}
    {block('4.5%', 202, <><BrandLogo id="notion" size={12}/>Notion page</>, 'Onboarding notes', 'Read live from Notion')}
    {block('64%', 52, <><BrandLogo id="claude" size={12}/>Agent</>, 'Claude Code', 'Reading 3 blocks')}
    {block('64%', 170, <><BrandLogo id="codex" size={12}/>Agent</>, 'Codex', '2 changes wait for you')}
  </div>;
}

export function FirstRun({ status, onDone, onPlugins, onRescan, onRefresh, onChanged }: Props) {
  const [step, setStep] = useState<Step>('welcome');
  const [cloud, setCloud] = useState<CloudAccountStatus>(), [choice, setChoice] = useState<'account' | 'without'>(status.cloud.available ? 'account' : 'without');
  const [opened, setOpened] = useState(false), [error, setError] = useState(''), [localError, setLocalError] = useState('');
  const local = useLocalRos(true, onChanged);
  const signedInHere = useRef(false), started = useRef(false), sawWaiting = useRef(false);
  useEffect(() => { void api<CloudAccountStatus>('/api/cloud').then(setCloud, () => undefined); }, []);

  const computer = status.computer, hosted = status.cloud.available, offline = local.status?.supported ?? false;
  const signedIn = cloud ? cloud.state === 'signed-in' : status.cloud.signedIn;
  // The account page is there when it has something to offer; the tools page when something was found.
  const steps: Step[] = ['welcome', ...(hosted || offline ? ['account' as const] : []), ...(status.offer ? ['tools' as const] : [])];
  const at = steps.indexOf(step);

  // While the sign-in page is open in the browser, look every two seconds: the local server finishes the sign-in itself.
  useEffect(() => {
    if (!opened) return;
    const timer = setInterval(async () => {
      const next = await api<CloudAccountStatus>('/api/cloud').catch(() => undefined);
      if (!next) return;
      setCloud(next);
      if (next.state === 'waiting') sawWaiting.current = true;
      else if (next.state === 'signed-in') {
        setOpened(false); signedInHere.current = true; cloudAccountChanged();
        void onChanged().catch(() => undefined); void onRefresh().catch(() => undefined);
      } else if (sawWaiting.current) { setOpened(false); setError(next.error || 'The sign-in did not finish. Try again.'); }
    }, 2000);
    return () => clearInterval(timer);
  }, [opened, onChanged, onRefresh]);

  /** Opens ros.ai cloud's sign-in page from the click itself, so the browser lets the tab open. */
  const signIn = () => {
    setError(''); sawWaiting.current = false;
    if (!macApp()) { window.open('/api/cloud/start', '_blank', 'noopener'); setOpened(true); return; }
    // The Mac app hands web pages to the system browser.
    void post<CloudAccountStatus>('/api/cloud/sign-in').then(next => {
      setCloud(next); sawWaiting.current = true; setOpened(true);
      if (next.verificationUrl) window.open(next.verificationUrl, '_blank', 'noopener');
    }, cause => setError(fail(cause)));
  };
  const openAgain = () => { if (cloud?.verificationUrl) window.open(cloud.verificationUrl, '_blank', 'noopener'); else signIn(); };
  const download = async (on: boolean) => {
    setLocalError('');
    try {
      if (on) started.current = true;
      local.set(await post<LocalRosStatus>(on ? '/api/local-ros/download' : '/api/local-ros/cancel'));
    } catch (cause) { setLocalError(fail(cause)); }
  };

  /** Done, from the last page or Not now: what the first run did goes on the question box. */
  const finish = (tools?: SetupSummary) => {
    const connected = [...(signedInHere.current ? [{ key: 'ros', label: 'Ros, hosted by ros.ai', icon: <RosMark/> }] : []), ...(tools?.connected ?? []).filter(item => item.key !== 'ros')];
    const waiting = tools?.waiting ?? [], state = local.status?.state;
    const localRos = state && state !== 'not-downloaded' && (started.current || state === 'downloading' || state === 'starting') ? `Ros on ${computer}` : undefined;
    onDone(connected.length || waiting.length || localRos ? { connected, waiting, ...(localRos ? { localRos } : {}) } : undefined);
  };
  const next = () => { const following = steps[at + 1]; if (following) setStep(following); else finish(); };
  const back = () => { const before = steps[at - 1]; if (before) setStep(before); };

  const dots = steps.length > 1 && <div className="first-run-steps" role="img" aria-label={`Step ${at + 1} of ${steps.length}`}>{steps.map((item, index) => <i key={item} className={index === at ? 'on' : ''}/>)}</div>;
  const primary = (label: ReactNode, action?: () => void) => <button type="button" className="primary first-run-primary" disabled={!action} onClick={action}>{label}</button>;
  const footer = (actions: ReactNode) => <footer className="first-run-foot"><RosMark working={opened}/><span className="setup-space"/>{actions}</footer>;

  let page: ReactNode;
  if (step === 'welcome') page = <>
    <h1 className="first-run-title">Welcome to ros.ai</h1>
    <p className="first-run-lead">AI agents from any vendor work from your whole project’s context on one canvas you see and direct.</p>
    <section className="first-run-card" aria-label="Welcome to ros.ai">
      <WelcomeMap/>
      {footer(primary(<>Get started<ArrowRight size={14}/></>, next))}
    </section>
    {dots}
  </>;
  else if (step === 'account') {
    const now = local.status, working = now?.state === 'downloading' || now?.state === 'starting';
    const percent = now?.totalBytes ? Math.min(100, Math.round(((now.doneBytes ?? 0) / now.totalBytes) * 100)) : 0;
    const detail = !now ? '' : now.state === 'downloading' ? `Downloading in the background · ${now.totalBytes ? `${gb(now.doneBytes)} of ${gb(now.totalBytes)}` : 'finding the files'}`
      : now.state === 'starting' ? 'Downloaded · getting Ros ready'
      : now.state === 'ready' ? `Works offline · nothing leaves ${computer}`
      : now.state === 'failed' ? now.error || 'The download stopped'
      : 'Free and works offline · about 3 GB, downloads in the background';
    const downloadRow = now?.supported && <div className="setup-row">
      <span className="setup-tile" aria-hidden="true"><RosMark/></span>
      <span className="setup-text"><span className="setup-name">{now.state === 'ready' ? `Ros on ${computer}` : `Download Ros to ${computer}`}</span><span className="setup-detail">{localError || detail}</span></span>
      {now.state === 'downloading' && <span className="setup-bar" role="progressbar" aria-label="Ros download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }}/></span>}
      {now.state === 'ready' ? <span className="setup-state ok"><i/>Ready</span>
        : now.state === 'starting' ? <span className="setup-state"><LoaderCircle size={12} className="spin"/>Starting</span>
        : now.state === 'failed' ? <button type="button" className="setup-small-button" onClick={() => void download(true)}>Try again</button>
        : <button type="button" role="switch" aria-checked={working} aria-label={`Download Ros to ${computer}`} className={`setup-switch ${working ? 'on' : ''}`} onClick={() => void download(!working)}/>}
    </div>;
    const option = (id: 'account' | 'without', title: string, points: ReactNode[]) => <label className={`first-run-choice ${choice === id ? 'on' : ''}`}>
      <span className="first-run-choice-head"><input type="radio" name="first-run-account" checked={choice === id} onChange={() => setChoice(id)}/>{title}</span>
      <span className="first-run-points">{points.map((point, index) => <span key={index}>{point}</span>)}</span>
    </label>;
    const waiting = opened && choice === 'account';
    const [title, lead] = signedIn ? ['You’re signed in', `Your projects stay on ${computer}. Ros sends only what you ask it to read.`]
      : hosted ? ['Sign in or create an account', `Your projects stay on ${computer} either way.`]
      : [`Run Ros on ${computer}`, 'Free, and it works offline. Ros can also run on your own keys.'];
    page = <>
      <h1 className="first-run-title">{title}</h1>
      <p className="first-run-lead">{lead}</p>
      <section className="first-run-card" aria-label={title}>
        {signedIn ? <div className="setup-row">
          <span className="first-run-avatar" aria-hidden="true">{(cloud?.email || 'R').charAt(0).toUpperCase()}</span>
          <span className="setup-text"><span className="setup-name">{cloud?.email || 'Signed in to ros.ai'}</span><span className="setup-detail">Ros, hosted by ros.ai · free while ros.ai is new</span></span>
          <span className="setup-state ok"><i/>Ready</span>
        </div> : hosted && <div className="first-run-choices" role="radiogroup" aria-label="How to use ros.ai">
          {option('account', 'Use a ros.ai account', waiting
            ? [<span className="first-run-wait"><LoaderCircle size={13} className="spin"/>Finish in your browser</span>, 'A ros.ai page opened there. Sign in or create your account, and this page moves on by itself.']
            : ['Ros, hosted by ros.ai, free while ros.ai is new', 'Sign in with GitHub or an email code', 'Ros sends only what you ask it to read'])}
          {option('without', 'Continue without one', [offline ? 'Ros runs on your own keys or the download below' : 'Ros runs on your own keys', 'Your own agents work the same', 'Sign in any time from the sidebar'])}
        </div>}
        {error && <p className="setup-error first-run-error" role="alert">{error}</p>}
        {downloadRow && (signedIn || hosted) && <div className="first-run-divider"/>}
        {downloadRow}
        {footer(<>
          {!signedIn && at > 0 && <button type="button" className="setup-text-button first-run-back" onClick={back}>Back</button>}
          {waiting && <button type="button" className="setup-text-button first-run-back" onClick={openAgain}>Open it again</button>}
          {signedIn || choice === 'without' || !hosted ? primary(<>Continue<ArrowRight size={14}/></>, next)
            : waiting ? primary('Waiting for your browser')
            : primary(<>{cloud?.state === 'expired' ? 'Sign in again' : 'Sign in or create account'}<ArrowUpRight size={14}/></>, signIn)}
        </>)}
      </section>
      {dots}
    </>;
  } else page = <SetupScreen status={status} framed hostedRos={!steps.includes('account')} localRos={local.status} after={dots}
    onDone={finish} onPlugins={onPlugins} onRescan={onRescan} onRefresh={onRefresh} onChanged={onChanged}/>;

  return <div className="first-run">
    <Wordmark className="first-run-brand"/>
    <main className="first-run-page" key={step}>{page}</main>
  </div>;
}
