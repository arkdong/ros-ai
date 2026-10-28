import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ArrowUp, ArrowUpRight, Check, ChevronDown, Group, Hand, LoaderCircle, MousePointer2, Plus, ScanSearch, Table2, Text } from 'lucide-react';
import type { SetupStatus } from '../shared/setup';
import type { CloudAccountStatus } from '../shared/cloud-account';
import type { LocalRosStatus } from '../shared/local-ros';
import { BrandLogo } from './brand-logos';
import { Wordmark } from './Brand';
import { RosMark } from './RosDock';
import { cloudAccountChanged } from './ProfileButton';
import { gb, SetupScreen, useLocalRos } from './Setup';
import { api, post } from './api';
import './first-run.css';

/** The first run, in a window of its own with no rail or sidebar: what ros.ai is, with the map drawn small; then an
 * account or not, with Ros downloaded to this computer in the background if the person wants it; then the tools found
 * here (SetupScreen). Each page is the start screen's column: the ring, a 28 px heading, one line, one card. */

type Step = 'welcome' | 'account' | 'tools';
type Props = { status: SetupStatus; onDone: () => void; onAgents: () => void; onChanged: () => Promise<unknown> };
const fail = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const macApp = () => document.documentElement.classList.contains('mac-app');

/** The map, small and the way the product draws it: a group of three blocks, two agents from different vendors reading
 * them, a proposal from Ros, and the Ros bar. The blocks rise in one after another; the agents' dots breathe. */
function WelcomeMap() {
  // Drawn at 530 × 330 and scaled down whole when the column is narrower, so nothing in it reflows.
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const look = () => setScale(Math.min(1, element.clientWidth / 530));
    look();
    const watcher = new ResizeObserver(look); watcher.observe(element);
    return () => watcher.disconnect();
  }, []);
  const block = (className: string, left: number, top: number, order: number, kind: ReactNode, title: string, foot: ReactNode, body?: ReactNode) =>
    <div className={`fr-block${className ? ` ${className}` : ''}`} style={{ left, top, animationDelay: `${order * 80}ms` }}><span className="fr-kind">{kind}</span><b>{title}</b>{body}<span className="fr-foot">{foot}</span></div>;
  return <div className="fr-map-frame" ref={frame} style={{ height: Math.round(330 * scale) }}><div className="fr-map" style={{ transform: `scale(${scale})` }} role="img" aria-label="A map with a question, interview data and a Notion page in one group; Claude Code and Codex working from them; a proposal from Ros; and the Ros bar.">
    <svg className="fr-edges" width="532" height="330" viewBox="0 0 532 330" aria-hidden="true">
      <path d="M258 67C287 67 287 63 316 63"/><path d="M258 145C287 145 287 63 316 63"/><path d="M258 225C287 225 287 63 316 63"/>
      <path d="M258 145C287 145 287 141 316 141"/>
      <path d="M414 176V186" strokeDasharray="3 3"/>
    </svg>
    {[[255, 64], [255, 142], [255, 222], [313, 60], [313, 138]].map(([left, top]) => <span className="fr-handle" key={`${left}-${top}`} style={{ left, top }}/>)}
    <div className="fr-dock" aria-hidden="true"><i className="on"><MousePointer2 size={12}/></i><i><Hand size={12}/></i><s/><i><Plus size={12}/></i><i><Group size={12}/></i></div>
    <div className="fr-group" style={{ left: 50, top: 18, width: 240, height: 248 }}><span className="fr-group-label"><Group size={10}/>Interviews · 3 blocks</span></div>
    {block('', 62, 34, 1, <><Text size={11}/>Text · Question</>, 'Why do trial users leave?', 'You · today')}
    {block('sel', 62, 108, 2, <><Table2 size={11}/>Data</>, 'interviews.csv', '42 rows · 6 columns', <span className="fr-table"><span>user</span><span>plan</span><span>left_at</span></span>)}
    {block('', 62, 191, 3, <><BrandLogo id="notion" size={11}/>Notion page</>, 'Onboarding notes', 'Read live from Notion · 4 min ago')}
    {block('', 316, 30, 4, <><BrandLogo id="claude" size={11}/>Agent · Claude Code<i className="fr-dot"/></>, 'Reading 3 blocks', 'Running · 2 min')}
    {block('', 316, 106, 5, <><BrandLogo id="codex" size={11}/>Agent · Codex<i className="fr-dot"/></>, '2 changes wait for you', <>A chart and a note<span className="fr-chip lt">Review</span></>)}
    {block('dash', 316, 186, 6, <><RosMark/>Ros · proposed</>, 'Week-two churn: three causes', <>From the 42 interviews<span className="fr-chip">Accept</span></>)}
    <div className="fr-bar"><span className="fr-bar-q">Ask Ros, or tell an agent what to do</span><span className="fr-bar-foot"><RosMark/><span className="fr-bar-chip ctx"><ScanSearch size={10}/>3 blocks</span><span className="fr-bar-chip">Nemotron<ChevronDown size={10}/></span><span className="fr-bar-send"><ArrowUp size={11}/></span></span></div>
  </div></div>;
}

export function FirstRun({ status, onDone, onAgents, onChanged }: Props) {
  const [step, setStep] = useState<Step>('welcome');
  const [cloud, setCloud] = useState<CloudAccountStatus>(), [choice, setChoice] = useState<'account' | 'without'>('account');
  const [opened, setOpened] = useState(false), [error, setError] = useState(''), [download, setDownload] = useState(true), [localError, setLocalError] = useState('');
  const local = useLocalRos();
  const sawWaiting = useRef(false), started = useRef(false);
  useEffect(() => { void api<CloudAccountStatus>('/api/cloud').then(setCloud, () => undefined); }, []);

  const computer = status.computer, hosted = status.cloud.available, offline = local.status?.supported ?? false;
  const signedIn = cloud ? cloud.state === 'signed-in' : status.cloud.signedIn;
  // The account page is there when it has something to offer; the tools page when an agent or a model server was found.
  const steps: Step[] = ['welcome', ...(hosted || offline ? ['account' as const] : []), ...(status.agents.some(agent => agent.found) || status.models.some(model => model.running) ? ['tools' as const] : [])];
  const at = steps.indexOf(step);

  /** Yes on the download row starts it when the page is left, so a change of mind costs nothing. */
  const startDownload = () => {
    const now = local.status;
    if (!download || !now?.supported || (now.state !== 'not-downloaded' && now.state !== 'failed') || started.current) return;
    started.current = true; setLocalError('');
    post<LocalRosStatus>('/api/local-ros/download').then(local.set, cause => { started.current = false; setLocalError(fail(cause)); });
  };
  const next = () => { if (step === 'account') startDownload(); const following = steps[at + 1]; if (following) setStep(following); else onDone(); };
  const back = () => { const before = steps[at - 1]; if (before) setStep(before); };
  const advance = useRef(next), changed = useRef(onChanged);
  advance.current = next; changed.current = onChanged;

  // While the sign-in page is open in the browser, look every two seconds: the local server finishes the sign-in itself,
  // and this page moves on by itself.
  useEffect(() => {
    if (!opened) return;
    const timer = setInterval(async () => {
      const found = await api<CloudAccountStatus>('/api/cloud').catch(() => undefined);
      if (!found) return;
      setCloud(found);
      if (found.state === 'waiting') sawWaiting.current = true;
      else if (found.state === 'signed-in') { setOpened(false); cloudAccountChanged(); void changed.current().catch(() => undefined); advance.current(); }
      else if (sawWaiting.current) { setOpened(false); setError(found.error || 'The sign-in did not finish. Try again.'); }
    }, 2000);
    return () => clearInterval(timer);
  }, [opened]);

  /** Opens ros.ai cloud's sign-in page from the click itself, so the browser lets the tab open. */
  const signIn = () => {
    setError(''); sawWaiting.current = false;
    if (!macApp()) { window.open('/api/cloud/start', '_blank', 'noopener'); setOpened(true); return; }
    // The Mac app hands web pages to the system browser.
    void post<CloudAccountStatus>('/api/cloud/sign-in').then(found => {
      setCloud(found); sawWaiting.current = true; setOpened(true);
      if (found.verificationUrl) window.open(found.verificationUrl, '_blank', 'noopener');
    }, cause => setError(fail(cause)));
  };
  const openAgain = () => { if (cloud?.verificationUrl) window.open(cloud.verificationUrl, '_blank', 'noopener'); else signIn(); };
  const retry = () => { started.current = false; setDownload(true); startDownload(); };

  const stepLine = steps.length > 1 && <p className="fr-step">Step {at + 1} of {steps.length}</p>;
  const primary = (label: ReactNode, action?: () => void) => <button type="button" className="primary setup-primary" disabled={!action} onClick={action}>{label}</button>;
  let page: ReactNode;
  if (step === 'welcome') page = <div className="setup-column">
    <span className="setup-ring"><RosMark/></span>
    <h1>Welcome to ros.ai</h1>
    <p className="fr-lead">AI agents from any vendor work from your whole project’s context on one canvas you see and direct.</p>
    <section className="setup-card" aria-label="Welcome to ros.ai">
      <WelcomeMap/>
      <footer className="setup-foot"><RosMark/><span className="setup-sp"/>{primary(<>Get started<ArrowRight size={14}/></>, next)}</footer>
    </section>
    {stepLine}
  </div>;
  else if (step === 'account') {
    const now = local.status, waiting = opened && choice === 'account' && !signedIn;
    const percent = now?.totalBytes ? Math.min(100, Math.round(((now.doneBytes ?? 0) / now.totalBytes) * 100)) : 0;
    const [name, detail] = !now || now.state === 'not-downloaded' || now.state === 'failed'
      ? [`Download Ros to ${computer}`, localError || (now?.state === 'failed' ? now.error || 'The download stopped.' : 'Free and works offline. 3 GB, downloaded in the background.')]
      : [`Ros on ${computer}`, now.state === 'downloading' ? 'Downloading in the background' : now.state === 'starting' ? 'Downloaded · getting Ros ready' : `Works offline. Nothing leaves ${computer}.`];
    const control = !now || now.state === 'not-downloaded' ? <span className="fr-seg" role="radiogroup" aria-label={`Download Ros to ${computer}`}>
        <button type="button" role="radio" aria-checked={download} className={download ? 'on' : ''} onClick={() => setDownload(true)}>Yes</button>
        <button type="button" role="radio" aria-checked={!download} className={download ? '' : 'on'} onClick={() => setDownload(false)}>Later</button>
      </span>
      : now.state === 'failed' ? <button type="button" className="chip-button" onClick={retry}>Try again</button>
      : now.state === 'downloading' ? <span className="setup-cap">{now.totalBytes ? `${gb(now.doneBytes)} of ${gb(now.totalBytes)}` : 'Finding the files'}<span className="setup-bar" role="progressbar" aria-label="Ros download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }}/></span></span>
      : now.state === 'starting' ? <span className="setup-state"><LoaderCircle size={12} className="spin"/>Starting</span>
      : <span className="setup-state ok"><i/>Ready</span>;
    const [title, lead] = hosted ? ['Sign in or create an account', `Free while ros.ai is new. Your projects stay on ${computer} either way.`] : [`Run Ros on ${computer}`, 'Free, and it works offline. Ros can also run on your own keys.'];
    page = <div className="setup-column">
      <span className="setup-ring"><RosMark/></span>
      <h1>{title}</h1>
      <p className="setup-lead">{lead}</p>
      <section className="setup-card fr-account" aria-label={title}>
        {hosted && <div className="fr-choices" role="radiogroup" aria-label="How to use ros.ai">
          <button type="button" role="radio" aria-checked={choice === 'account'} className={`fr-acc${choice === 'account' ? ' on' : ''}`} disabled={signedIn} onClick={() => setChoice('account')}>
            <span className="fr-acc-head"><RosMark/><b>Use a ros.ai account</b>{signedIn ? <span className="setup-state ok"><i/>Signed in</span> : <><span className="fr-rec">Recommended</span><span className="setup-ck" aria-hidden="true">{choice === 'account' && <Check size={12} strokeWidth={2.5}/>}</span></>}</span>
            {signedIn ? <span className="fr-acc-pts one">{cloud?.email ? `Signed in as ${cloud.email}. ` : ''}Ros, hosted by ros.ai, now appears as a model.</span>
              : waiting ? <span className="fr-acc-pts one"><LoaderCircle size={13} className="spin"/>A ros.ai page opened in your browser. Sign in or create your account there; this page moves on by itself.</span>
              : <span className="fr-acc-pts"><span>Ros, hosted by ros.ai, free while ros.ai is new</span><span>Sign in with GitHub or an email code</span><span>Only what you give Ros leaves {computer}</span></span>}
          </button>
          {!signedIn && <button type="button" role="radio" aria-checked={choice === 'without'} className={`fr-acc alt${choice === 'without' ? ' on' : ''}`} onClick={() => setChoice('without')}>
            <span className="setup-text"><span className="setup-name">Continue without an account</span><span className="setup-why">Ros runs on your own keys{offline ? ' or on the download below' : ''}. Your own agents work the same.</span></span>
            <span className="setup-ck" aria-hidden="true">{choice === 'without' && <Check size={12} strokeWidth={2.5}/>}</span>
          </button>}
        </div>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        {offline && <div className={`fr-dl${hosted ? '' : ' first'}`}>
          <span className="fr-dl-tile" aria-hidden="true"><RosMark working={now?.state === 'downloading'}/></span>
          <span className="setup-text"><span className="setup-name">{name}</span><span className="setup-why">{detail}</span></span>
          {control}
        </div>}
        <footer className="setup-foot">
          <RosMark working={waiting}/>
          <span className="setup-sp"/>
          <button type="button" className="chip-button" onClick={back}>Back</button>
          {waiting && <button type="button" className="chip-button" onClick={openAgain}>Open it again</button>}
          {signedIn || choice === 'without' || !hosted ? primary(<>Continue<ArrowRight size={14}/></>, next)
            : waiting ? primary('Waiting for your browser')
            : primary(<>{cloud?.state === 'expired' ? 'Sign in again' : 'Sign in or create account'}<ArrowUpRight size={14}/></>, signIn)}
        </footer>
      </section>
      {stepLine}
    </div>;
  } else page = <SetupScreen status={signedIn === status.cloud.signedIn ? status : { ...status, cloud: { ...status.cloud, signedIn } }} hostedOn={choice === 'account'} localRos={local.status} after={stepLine}
    onDone={onDone} onAgents={onAgents} onChanged={onChanged}/>;

  return <div className="first-run">
    <Wordmark className="fr-brand"/>
    <main className="fr-page" key={step}>{page}</main>
  </div>;
}
