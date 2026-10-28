import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, Bot, CalendarDays, Check, Code, FileText, FolderOpen, Group, Laptop, ListChecks, LoaderCircle, Lock, Table2, Text } from 'lucide-react';
import type { AgentId, SetupStatus } from '../shared/setup';
import type { CloudAccountStatus } from '../shared/cloud-account';
import type { LocalRosStatus } from '../shared/local-ros';
import { BrandLogo } from './brand-logos';
import { Wordmark } from './Brand';
import { RosMark } from './RosDock';
import { cloudAccountChanged } from './ProfileButton';
import { AgentIcon, gb, SetupScreen, useLocalRos } from './Setup';
import { api, post } from './api';
import './first-run.css';

/** The first run, in a window of its own with no rail or sidebar, drawn as a canvas. The page is a node in the middle:
 * what ros.ai is; then an account or not, with Ros downloaded to this computer in the background if the person wants
 * it; then the tools found here (SetupScreen). Smaller nodes around it carry what was found on this computer and what
 * ros.ai is, wired to the page the way blocks are wired on the map, and some of them change as the pages go by. */

type Step = 'welcome' | 'account' | 'tools';
type Props = { status: SetupStatus; onDone: () => void; onAgents: () => void; onChanged: () => Promise<unknown> };
/** One small node: a kind line, a body, a footer line; `stamp` changes when the content does, so the change fades in. */
type Satellite = { id: string; kind: ReactNode; body: ReactNode; foot?: ReactNode; stamp: string };
type Wire = { d: string; from: [number, number]; to: [number, number] };
const AGENTS: AgentId[] = ['claude-code', 'codex', 'cursor', 'gemini-cli', 'pi', 'hermes'];
const fail = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const macApp = () => document.documentElement.classList.contains('mac-app');
/** "A", "A and B", "A, B and C". */
const list = (names: string[]) => names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

export function FirstRun({ status, onDone, onAgents, onChanged }: Props) {
  const [step, setStep] = useState<Step>('welcome');
  const [cloud, setCloud] = useState<CloudAccountStatus>(), [choice, setChoice] = useState<'account' | 'without'>('account');
  const [opened, setOpened] = useState(false), [error, setError] = useState(''), [download, setDownload] = useState(true), [localError, setLocalError] = useState('');
  const local = useLocalRos();
  const sawWaiting = useRef(false), started = useRef(false);
  useEffect(() => { void api<CloudAccountStatus>('/api/cloud').then(setCloud, () => undefined); }, []);
  // The clock in the corner node keeps time.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(timer); }, []);

  const computer = status.computer, hosted = status.cloud.available, offline = local.status?.supported ?? false;
  const signedIn = cloud ? cloud.state === 'signed-in' : status.cloud.signedIn;
  // The account page is there when it has something to offer; the tools page when an agent or a model server was found.
  const steps: Step[] = ['welcome', ...(hosted || offline ? ['account' as const] : []), ...(status.agents.some(agent => agent.found) || status.models.some(model => model.running) ? ['tools' as const] : [])];
  const at = steps.indexOf(step);

  /** Yes on the download row starts it when the page is left, so a change of mind costs nothing. */
  const startDownload = () => {
    const current = local.status;
    if (!download || !current?.supported || (current.state !== 'not-downloaded' && current.state !== 'failed') || started.current) return;
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

  // Wires from each small node to the page's near edge, measured from the layout like the map's edges, and measured
  // again whenever the window, the page or a node changes size.
  const stage = useRef<HTMLDivElement>(null), center = useRef<HTMLDivElement>(null);
  const [wires, setWires] = useState<Wire[]>([]);
  useLayoutEffect(() => {
    const root = stage.current, page = center.current;
    if (!root || !page) return;
    const measure = () => {
      const base = root.getBoundingClientRect(), card = (page.querySelector('.setup-column') ?? page).getBoundingClientRect();
      const found: Wire[] = [];
      for (const node of root.querySelectorAll<HTMLElement>('.fr-sat')) {
        if (!node.offsetParent) continue;
        const rect = node.getBoundingClientRect(), left = node.closest('.fr-side')?.classList.contains('left') ?? false;
        const from: [number, number] = [Math.round((left ? rect.right : rect.left) - base.left), Math.round(rect.top + rect.height / 2 - base.top)];
        const to: [number, number] = [Math.round((left ? card.left : card.right) - base.left), Math.round(card.top + card.height / 2 - base.top)];
        const bend = (to[0] - from[0]) / 2;
        found.push({ from, to, d: `M${from[0]} ${from[1]}C${from[0] + bend} ${from[1]} ${to[0] - bend} ${to[1]} ${to[0]} ${to[1]}` });
      }
      setWires(found);
    };
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(root); watcher.observe(page);
    for (const side of root.querySelectorAll('.fr-side')) watcher.observe(side);
    return () => watcher.disconnect();
  }, [step]);

  const stepLine = steps.length > 1 && <p className="fr-step">Step {at + 1} of {steps.length}</p>;
  const primary = (label: ReactNode, action?: () => void) => <button type="button" className="primary setup-primary" disabled={!action} onClick={action}>{label}</button>;
  let page: ReactNode;
  if (step === 'welcome') page = <div className="setup-column">
    <span className="setup-ring"><RosMark/></span>
    <h1>Welcome to ros.ai</h1>
    <p className="fr-lead">ros.ai is the open workspace that holds your whole project’s context on one canvas. AI agents from any vendor work from it, and you see the whole picture, make the connections and direct them there.</p>
    <footer className="setup-foot"><RosMark/><span className="setup-sp"/>{primary(<>Continue<ArrowRight size={14}/></>, next)}</footer>
    {stepLine}
  </div>;
  else if (step === 'account') {
    const current = local.status, waiting = opened && choice === 'account' && !signedIn;
    const percent = current?.totalBytes ? Math.min(100, Math.round(((current.doneBytes ?? 0) / current.totalBytes) * 100)) : 0;
    const [name, detail] = !current || current.state === 'not-downloaded' || current.state === 'failed'
      ? [`Download Ros to ${computer}`, localError || (current?.state === 'failed' ? current.error || 'The download stopped.' : 'Free and works offline. 3 GB, downloaded in the background.')]
      : [`Ros on ${computer}`, current.state === 'downloading' ? 'Downloading in the background' : current.state === 'starting' ? 'Downloaded · getting Ros ready' : `Works offline. Nothing leaves ${computer}.`];
    const control = !current || current.state === 'not-downloaded' ? <span className="fr-seg" role="radiogroup" aria-label={`Download Ros to ${computer}`}>
        <button type="button" role="radio" aria-checked={download} className={download ? 'on' : ''} onClick={() => setDownload(true)}>Yes</button>
        <button type="button" role="radio" aria-checked={!download} className={download ? '' : 'on'} onClick={() => setDownload(false)}>Later</button>
      </span>
      : current.state === 'failed' ? <button type="button" className="chip-button" onClick={retry}>Try again</button>
      : current.state === 'downloading' ? <span className="setup-cap">{current.totalBytes ? `${gb(current.doneBytes)} of ${gb(current.totalBytes)}` : 'Finding the files'}<span className="setup-bar" role="progressbar" aria-label="Ros download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }}/></span></span>
      : current.state === 'starting' ? <span className="setup-state"><LoaderCircle size={12} className="spin"/>Starting</span>
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
          <span className="fr-dl-tile" aria-hidden="true"><RosMark working={current?.state === 'downloading'}/></span>
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

  // The small nodes. Left: the steps, what was found on this computer, one thing about ros.ai that changes with the
  // page. Right: the agents ros.ai works with, Ros and where it runs, and today.
  const found = status.agents.filter(agent => agent.found), running = status.models.filter(model => model.running);
  const stepLabel: Record<Step, string> = { welcome: 'Welcome', account: hosted ? 'Account' : `Ros on ${computer}`, tools: 'Your tools' };
  const lines = [
    ...found.map(agent => ({ key: agent.id, icon: <AgentIcon id={agent.id} size={14}/>, label: agent.label, note: agent.link ? 'linked' : agent.signedIn ? 'signed in' : agent.signals.includes('used recently') ? 'used recently' : 'found' })),
    ...running.map(model => ({ key: model.id, icon: <BrandLogo id={model.id} size={14}/>, label: model.label, note: model.models.length ? `${model.models.length} model${model.models.length === 1 ? '' : 's'}` : 'running' })),
  ].slice(0, 4);
  const facts: Record<Step, Satellite> = {
    welcome: { id: 'fact', stamp: 'fact-welcome', kind: <><Group size={12}/>One canvas</>, body: 'Text, code, data, files and agents sit on one map. Every block keeps its own chat and shows where it came from.', foot: <span className="fr-kinds"><Text size={12}/><Code size={12}/><Table2 size={12}/><FileText size={12}/><Bot size={12}/><Group size={12}/></span> },
    account: { id: 'fact', stamp: 'fact-account', kind: <><FolderOpen size={12}/>Your projects</>, body: `Each project is a folder on ${computer}. Open it in any app, move it, back it up: it is yours.`, foot: 'ros.ai never uploads them' },
    tools: { id: 'fact', stamp: 'fact-tools', kind: <><Lock size={12}/>What leaves {computer}</>, body: `Only what you give Ros or an agent. The links to your agents are written here, on ${computer}.`, foot: 'Undo any of them in Agents' },
  };
  const dl = local.status;
  const rosBody = signedIn ? `Signed in${cloud?.email ? ` as ${cloud.email}` : ''}. Ros, hosted by ros.ai, appears as a model.`
    : hosted && step !== 'welcome' && choice === 'without' ? `Without an account, Ros runs on your own keys${offline ? ` or on ${computer}` : ''}. Your agents work the same.`
    : hosted ? 'Hosted by ros.ai, free while ros.ai is new. Sign in, and Ros appears as a model.'
    : `Ros runs on your own keys${offline ? `, or on ${computer} after a free 3 GB download` : ''}.`;
  const rosFoot = !dl?.supported ? 'Runs on NVIDIA Nemotron 3'
    : dl.state === 'downloading' ? <span className="fr-live"><LoaderCircle size={11} className="spin"/>Downloading to {computer}{dl.totalBytes ? ` · ${gb(dl.doneBytes)} of ${gb(dl.totalBytes)}` : ''}</span>
    : dl.state === 'starting' ? <span className="fr-live"><LoaderCircle size={11} className="spin"/>Getting Ros ready on {computer}</span>
    : dl.state === 'ready' ? <span className="fr-live ok"><i/>Ros on {computer} is ready. Works offline.</span>
    : dl.state === 'failed' ? <span className="fr-live fail"><i/>The download to {computer} stopped</span>
    : step === 'account' && download ? `Downloads to ${computer} when you continue · 3 GB`
    : 'Runs on NVIDIA Nemotron 3';
  const left: Satellite[] = [
    ...(steps.length > 1 ? [{ id: 'steps', stamp: `steps-${at}`, kind: <><ListChecks size={12}/>{steps.length} steps</>, foot: `Step ${at + 1} of ${steps.length}`,
      body: <ol className="fr-steps">{steps.map((item, index) => <li key={item} className={index < at ? 'done' : index === at ? 'now' : ''}><i>{index < at && <Check size={9} strokeWidth={3}/>}</i>{stepLabel[item]}</li>)}</ol> }] : []),
    { id: 'computer', stamp: `computer-${lines.map(line => line.key).join()}`, kind: <><Laptop size={12}/>On {computer}</>, foot: `Looked at ${status.lookedAt.length} place${status.lookedAt.length === 1 ? '' : 's'} · names and dates only`,
      body: lines.length ? <ul className="fr-found">{lines.map(line => <li key={line.key}>{line.icon}<span>{line.label}</span><small>{line.note}</small></li>)}</ul> : 'No agents or model servers found yet. Ros works on its own.' },
    facts[step],
  ];
  const right: Satellite[] = [
    { id: 'agents', stamp: `agents-${found.length}`, kind: <><Bot size={12}/>Agents from any vendor</>, foot: 'Each in its own block, from the same canvas',
      body: <><span className="fr-logos">{AGENTS.map(id => <span key={id} className={found.some(agent => agent.id === id) ? 'on' : ''}><AgentIcon id={id} size={14}/></span>)}</span>{found.length ? `${list(found.map(agent => agent.label))} ${found.length === 1 ? 'is' : 'are'} on ${computer}.` : `None on ${computer} yet. Ros works on its own; any of these can join later.`}</> },
    { id: 'ros', stamp: `ros-${signedIn}-${step === 'welcome' ? '' : choice}-${dl?.state ?? ''}-${step === 'account' && download}`, kind: <><RosMark working={dl?.state === 'downloading'}/>Ros</>, body: rosBody, foot: rosFoot },
    { id: 'today', stamp: 'today', kind: <><CalendarDays size={12}/>Day 1 with ros.ai</>, foot: 'ros.ai is open source · MIT',
      body: <><b className="fr-date">{now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</b><span className="fr-time">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} on {computer}</span></> },
  ];
  const satellite = (item: Satellite, order: number) => <section key={item.id} className="fr-sat" style={{ animationDelay: `${140 + order * 70}ms` }}>
    <div className="fr-sat-in" key={item.stamp}>
      <span className="fr-sat-kind">{item.kind}</span>
      <div className="fr-sat-body">{item.body}</div>
      {item.foot && <div className="fr-sat-foot">{item.foot}</div>}
    </div>
  </section>;

  return <div className="first-run">
    <Wordmark className="fr-brand"/>
    <div className="fr-stage" ref={stage}>
      <svg className="fr-wires" aria-hidden="true">{wires.map((wire, index) => <g key={index}><path d={wire.d}/><circle cx={wire.from[0]} cy={wire.from[1]} r="3.5"/><circle cx={wire.to[0]} cy={wire.to[1]} r="3.5"/></g>)}</svg>
      <aside className="fr-side left">{left.map((item, index) => satellite(item, index * 2))}</aside>
      <div className="fr-center" ref={center}><main className="fr-page" key={step}>{page}</main></div>
      <aside className="fr-side right">{right.map((item, index) => satellite(item, index * 2 + 1))}</aside>
    </div>
  </div>;
}
