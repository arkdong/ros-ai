import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppWindow, ArrowRight, ArrowUpRight, Check, FileText, Group, Laptop, ListChecks, LoaderCircle, Table2, Text } from 'lucide-react';
import type { AgentId, DetectedApp, SetupStatus } from '../shared/setup';
import type { CloudAccountStatus } from '../shared/cloud-account';
import type { LocalRosStatus } from '../shared/local-ros';
import { BrandLogo, hasBrandLogo } from './brand-logos';
import { Wordmark } from './Brand';
import { RosMark } from './RosDock';
import { cloudAccountChanged } from './ProfileButton';
import { AgentIcon, gb, SetupScreen, useLocalRos } from './Setup';
import { api, post } from './api';
import './first-run.css';

/** The first run, in a window of its own with no rail or sidebar, drawn as a canvas with a small project running on
 * it. The page is a node in the middle: what ros.ai is; then an account or not and ROS downloaded to this computer
 * or not; then the tools found here (SetupScreen). Around it, the way a project looks on the map: a group with a
 * trip's brief, its hotels and its flights, an agent reading them step by step, a proposal from ROS to accept or keep
 * out, and what was found on this computer. The agent is the person's own when one was found, ROS's node says where
 * ROS runs for the choices made so far, and the found node fills in as links are made. */

type Step = 'welcome' | 'account' | 'tools';
type Props = { status: SetupStatus; onDone: () => void; onAgents: () => void; onPlugins: () => void; onChanged: () => Promise<unknown> };
/** One node around the page, drawn like a block on the map: a kind line with a state at its right, a title, a body
 * and a provenance line. stamp changes when the content changes, so the change fades in. */
type Node = { id: string; kind: ReactNode; state?: ReactNode; title?: ReactNode; body?: ReactNode; foot?: ReactNode; stamp: string; className?: string };
type Wire = { d: string; from: [number, number]; to: [number, number]; dash?: boolean; pulse: boolean };
const AGENTS: AgentId[] = ['claude-code', 'codex', 'cursor', 'gemini-cli', 'pi', 'hermes'];
/** The example's agent, step by step: what it is doing, then what it did. The last step is where it stops. */
const WORK = [
  { doing: 'Reading the brief', done: 'Read the brief' },
  { doing: 'Comparing 14 hotels', done: 'Compared 14 hotels' },
  { doing: 'Checking the flight times', done: 'Checked the flights' },
  { doing: 'Found a better stay', done: 'Proposed one change' },
];
/** The nodes whose wires carry a dot while the example runs. */
const EXAMPLE = new Set(['brief', 'hotels', 'flights', 'agent']);
const fail = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const macApp = () => document.documentElement.classList.contains('mac-app');
const curve = (from: [number, number], to: [number, number]) => { const bend = (to[0] - from[0]) / 2; return `M${from[0]} ${from[1]}C${from[0] + bend} ${from[1]} ${to[0] - bend} ${to[1]} ${to[0]} ${to[1]}`; };
/** How an app was found, in a word or two for the found node. */
const appNote = (app: DetectedApp) => app.connected ? 'connected' : app.usedBy.length ? `used by ${app.usedBy[0]}` : app.signals.includes('running') ? 'running' : app.signals.includes('synced folder') ? 'synced' : app.signals.includes('signed in on the command line') ? 'signed in' : 'installed';

export function FirstRun({ status, onDone, onAgents, onPlugins, onChanged }: Props) {
  const [step, setStep] = useState<Step>('welcome');
  const [cloud, setCloud] = useState<CloudAccountStatus>(), [choice, setChoice] = useState<'account' | 'without'>('account');
  const [opened, setOpened] = useState(false), [error, setError] = useState(''), [download, setDownload] = useState(true), [localError, setLocalError] = useState('');
  const local = useLocalRos();
  const sawWaiting = useRef(false), started = useRef(false);
  useEffect(() => { void api<CloudAccountStatus>('/api/cloud').then(setCloud, () => undefined); }, []);
  // The example: the agent moves on every 1.8 s and its clock runs until it is done; then ROS's proposal appears and
  // waits for Accept or Keep mine.
  const [phase, setPhase] = useState(0), [decision, setDecision] = useState<'accepted' | 'kept' | null>(null), [seconds, setSeconds] = useState(0);
  const working = phase < WORK.length - 1;
  useEffect(() => { if (!working) return; const timer = setTimeout(() => setPhase(value => value + 1), phase === 0 ? 1600 : 1800); return () => clearTimeout(timer); }, [phase, working]);
  useEffect(() => { if (!working) return; const timer = setInterval(() => setSeconds(value => value + 1), 1000); return () => clearInterval(timer); }, [working]);

  const computer = status.computer, hosted = status.cloud.available, offline = local.status?.supported ?? false;
  const signedIn = cloud ? cloud.state === 'signed-in' : status.cloud.signedIn;
  // The tools page gets the sign-in made here; one object per change, so its rows keep the person's ticks.
  const screenStatus = useMemo(() => signedIn === status.cloud.signedIn ? status : { ...status, cloud: { ...status.cloud, signedIn } }, [status, signedIn]);
  // The account page is there when it has something to offer; the tools page when an agent, a model server or an app was found.
  const steps: Step[] = ['welcome', ...(hosted || offline ? ['account' as const] : []), ...(status.agents.some(agent => agent.found) || status.models.some(model => model.running) || status.apps.length ? ['tools' as const] : [])];
  const at = steps.indexOf(step);

  /** Download ROS starts it when the page is left, so a change of mind costs nothing. */
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

  // Wires from each node to the page's near edge, measured from the layout like the map's edges, and measured again
  // whenever the window, the page or a node changes size. Context runs into the page from the left and out to the
  // agent on the right, so the dots run that way; the proposal hangs from the agent on a dashed wire.
  const stage = useRef<HTMLDivElement>(null), center = useRef<HTMLDivElement>(null);
  const [wires, setWires] = useState<Wire[]>([]);
  useLayoutEffect(() => {
    const root = stage.current, page = center.current;
    if (!root || !page) return;
    const measure = () => {
      const base = root.getBoundingClientRect(), card = (page.querySelector('.setup-column') ?? page).getBoundingClientRect();
      const found: Wire[] = [], boxes = new Map<string, DOMRect>();
      for (const node of root.querySelectorAll<HTMLElement>('.fr-sat')) {
        if (!node.offsetParent) continue;
        const rect = node.getBoundingClientRect(), left = node.closest('.fr-side')?.classList.contains('left') ?? false, id = node.dataset.id ?? '';
        boxes.set(id, rect);
        const edge: [number, number] = [Math.round((left ? rect.right : rect.left) - base.left), Math.round(rect.top + rect.height / 2 - base.top)];
        const hub: [number, number] = [Math.round((left ? card.left : card.right) - base.left), Math.round(card.top + card.height / 2 - base.top)];
        const [from, to] = left ? [edge, hub] : [hub, edge];
        found.push({ from, to, d: curve(from, to), pulse: working && EXAMPLE.has(id) });
      }
      const agent = boxes.get('agent'), proposal = boxes.get('proposal');
      if (agent && proposal) {
        const from: [number, number] = [Math.round(agent.left + 36 - base.left), Math.round(agent.bottom - base.top)];
        const to: [number, number] = [Math.round(proposal.left + 36 - base.left), Math.round(proposal.top - base.top)];
        found.push({ from, to, d: `M${from[0]} ${from[1]}C${from[0]} ${from[1] + 12} ${to[0]} ${to[1] - 12} ${to[0]} ${to[1]}`, dash: true, pulse: !decision });
      }
      setWires(found);
    };
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(root); watcher.observe(page);
    for (const side of root.querySelectorAll('.fr-side')) watcher.observe(side);
    return () => watcher.disconnect();
  }, [step, working, decision]);

  const stepLine = steps.length > 1 && <p className="fr-step">Step {at + 1} of {steps.length}</p>;
  const primary = (label: ReactNode, action?: () => void) => <button type="button" className="primary setup-primary" disabled={!action} onClick={action}>{label}</button>;
  let page: ReactNode;
  if (step === 'welcome') page = <div className="setup-column fr-welcome">
    <span className="setup-ring"><RosMark/></span>
    <h1>Welcome to ros.ai</h1>
    <p className="fr-lead">ros.ai is the open workspace that holds your whole project’s context on one canvas. AI agents from any vendor work from it, and you see the whole picture, make the connections and direct them there.</p>
    <footer className="setup-foot">{primary(<>Continue<ArrowRight size={15}/></>, next)}</footer>
    {stepLine}
  </div>;
  else if (step === 'account') {
    const current = local.status, waiting = opened && choice === 'account' && !signedIn, both = hosted && offline;
    const percent = current?.totalBytes ? Math.min(100, Math.round(((current.doneBytes ?? 0) / current.totalBytes) * 100)) : 0;
    const [title, lead] = both ? ['Set up ROS', `Two choices, both free. Your projects stay on ${computer} either way.`]
      : hosted ? ['Sign in or create an account', `Free while ros.ai is new. Your projects stay on ${computer} either way.`]
      : [`Run ROS on ${computer}`, 'Free, and it works offline. ROS can also run on your own keys.'];
    const tick = (on: boolean) => <span className="setup-ck" aria-hidden="true">{on && <Check size={12} strokeWidth={2.5}/>}</span>;
    // ROS on this computer: two tiles while nothing is downloaded, one status row once the download runs.
    const ros = !offline ? null : !current || current.state === 'not-downloaded'
      ? <div className="fr-tiles" role="radiogroup" aria-label={`Download ROS to ${computer}`}>
        <button type="button" role="radio" aria-checked={download} className={`fr-acc tile${download ? ' on' : ''}`} onClick={() => setDownload(true)}>
          <span className="fr-acc-head"><RosMark/><b>Download ROS</b>{tick(download)}</span>
          <span className="fr-acc-why">3 GB in the background while you set up. Free, and it works offline on {computer}.</span>
        </button>
        <button type="button" role="radio" aria-checked={!download} className={`fr-acc tile${download ? '' : ' on'}`} onClick={() => setDownload(false)}>
          <span className="fr-acc-head"><b>Later</b>{tick(!download)}</span>
          <span className="fr-acc-why">Any time from Agents › ROS. {hosted ? 'Hosted ROS and your own keys work meanwhile.' : 'ROS runs on your own keys meanwhile.'}</span>
        </button>
      </div>
      : <div className="fr-dl">
        <span className="fr-dl-tile" aria-hidden="true"><RosMark working={current.state === 'downloading'}/></span>
        <span className="setup-text">
          <span className="setup-name">{current.state === 'failed' ? `Download ROS to ${computer}` : `ROS on ${computer}`}</span>
          <span className="setup-why">{current.state === 'failed' ? localError || current.error || 'The download stopped.' : current.state === 'downloading' ? 'Downloading in the background' : current.state === 'starting' ? 'Downloaded · getting ROS ready' : `Works offline. Nothing leaves ${computer}.`}</span>
        </span>
        {current.state === 'failed' ? <button type="button" className="chip-button" onClick={retry}>Try again</button>
          : current.state === 'downloading' ? <span className="setup-cap">{current.totalBytes ? `${gb(current.doneBytes)} of ${gb(current.totalBytes)}` : 'Finding the files'}<span className="setup-bar" role="progressbar" aria-label="ROS download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }}/></span></span>
          : current.state === 'starting' ? <span className="setup-state"><LoaderCircle size={12} className="spin"/>Starting</span>
          : <span className="setup-state ok"><i/>Ready</span>}
      </div>;
    page = <div className="setup-column">
      <span className="setup-ring"><RosMark/></span>
      <h1>{title}</h1>
      <p className="setup-lead">{lead}</p>
      <section className="setup-card fr-account" aria-label={title}>
        {both && <p className="fr-cap">Choice 1 of 2 · Your account</p>}
        {hosted && <div className="fr-choices" role="radiogroup" aria-label="How to use ros.ai">
          <button type="button" role="radio" aria-checked={choice === 'account'} className={`fr-acc main${choice === 'account' ? ' on' : ''}`} disabled={signedIn} onClick={() => setChoice('account')}>
            <span className="fr-acc-head"><RosMark/><b>Use a ros.ai account</b>{signedIn ? <span className="setup-state ok"><i/>Signed in</span> : <><span className="fr-rec">Recommended</span>{tick(choice === 'account')}</>}</span>
            {signedIn ? <span className="fr-acc-pts one">{cloud?.email ? `Signed in as ${cloud.email}. ` : ''}ROS, hosted by ros.ai, now appears as a model.</span>
              : waiting ? <span className="fr-acc-pts one"><LoaderCircle size={13} className="spin"/>A ros.ai page opened in your browser. Sign in or create your account there; this page moves on by itself.</span>
              : <ul className="fr-acc-pts"><li><Check size={13} strokeWidth={2.5}/>ROS, hosted by ros.ai, free while ros.ai is new</li><li><Check size={13} strokeWidth={2.5}/>Sign in with GitHub or an email code</li><li><Check size={13} strokeWidth={2.5}/>Only what you give ROS leaves {computer}</li></ul>}
          </button>
          {!signedIn && <button type="button" role="radio" aria-checked={choice === 'without'} className={`fr-acc alt${choice === 'without' ? ' on' : ''}`} onClick={() => setChoice('without')}>
            <span className="setup-text"><span className="setup-name">Continue without an account</span><span className="setup-why">ROS runs on your own keys{offline ? ` or on ${computer}` : ''}. Your own agents work the same.</span></span>
            {tick(choice === 'without')}
          </button>}
        </div>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        {both && <p className="fr-cap second">Choice 2 of 2 · ROS on {computer}</p>}
        {ros}
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
  } else page = <SetupScreen status={screenStatus} hostedOn={choice === 'account'} localRos={local.status} after={stepLine}
    onDone={onDone} onAgents={onAgents} onPlugins={onPlugins} onChanged={onChanged}/>;

  // The nodes. Left: the steps, then the example's group. Right: its agent, ROS's proposal once the agent is done,
  // and what was found on this computer.
  const found = status.agents.filter(agent => agent.found), running = status.models.filter(model => model.running);
  const example = found.find(agent => agent.id === 'claude-code') ?? found.find(agent => agent.id !== 'cursor');
  const agentId: AgentId = example?.id ?? 'claude-code', agentLabel = example?.label ?? 'Claude Code';
  const stepLabel: Record<Step, string> = { welcome: 'Welcome', account: hosted ? 'Set up ROS' : `ROS on ${computer}`, tools: 'Your tools' };
  const all = [
    ...found.map(agent => ({ key: agent.id, icon: <AgentIcon id={agent.id} size={14}/>, label: agent.label, note: agent.link ? 'linked' : agent.signedIn ? 'signed in' : agent.signals.includes('used recently') ? 'used recently' : 'found' })),
    ...running.map(model => ({ key: model.id, icon: <BrandLogo id={model.id} size={14}/>, label: model.label, note: model.models.length ? `${model.models.length} model${model.models.length === 1 ? '' : 's'}` : 'running' })),
    ...status.apps.map(app => ({ key: app.id, icon: hasBrandLogo(app.id) ? <BrandLogo id={app.id} size={14}/> : <AppWindow size={14} strokeWidth={1.75}/>, label: app.label, note: appNote(app) })),
  ];
  const lines = all.slice(0, 6), more = all.length - lines.length;
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const dl = local.status;
  // Where ROS runs for the choices made so far, under its proposal: the download while it runs, else the account choice.
  const where = signedIn ? `Hosted by ros.ai${cloud?.email ? ` · ${cloud.email}` : ''}`
    : hosted && step !== 'welcome' && choice === 'without' ? `On your keys${offline ? ` or on ${computer}` : ''}`
    : hosted ? 'Hosted by ros.ai · free while ros.ai is new'
    : `On your keys${offline ? ` or on ${computer}` : ''}`;
  const rosFoot = dl?.state === 'downloading' ? <span className="fr-live"><LoaderCircle size={11} className="spin"/><span className="fr-cut">Downloading to {computer}{dl.totalBytes ? ` · ${((dl.doneBytes ?? 0) / 1e9).toFixed(1)} of ${gb(dl.totalBytes)}` : ''}</span></span>
    : dl?.state === 'starting' ? <span className="fr-live"><LoaderCircle size={11} className="spin"/><span className="fr-cut">Getting ready on {computer}</span></span>
    : dl?.state === 'ready' ? <span className="fr-live ok"><i/><span className="fr-cut">On {computer} · ready, works offline</span></span>
    : dl?.state === 'failed' ? <span className="fr-live fail"><i/><span className="fr-cut">The download to {computer} stopped</span></span>
    : step === 'account' && download && offline ? <span className="fr-cut">Downloads to {computer} when you continue</span>
    : <span className="fr-cut">{where}</span>;
  const stepsNode: Node = { id: 'steps', stamp: `steps-${at}`, kind: <><ListChecks size={12}/>{steps.length} steps</>, state: `Step ${at + 1} of ${steps.length}`,
    body: <ol className="fr-steps">{steps.map((item, index) => <li key={item} className={index < at ? 'done' : index === at ? 'now' : ''}><i>{index < at && <Check size={9} strokeWidth={3}/>}</i>{stepLabel[item]}</li>)}</ol> };
  const brief: Node = { id: 'brief', stamp: `brief-${decision}`, kind: <><Text size={12}/>Text</>, title: 'Team trip to Lisbon', foot: <span className="fr-cut">You · this morning</span>,
    body: <><p>Six of us, 12 to 14 November. Under €4,000 all in, close to the venue in Alfama.</p>{decision === 'accepted' && <p className="fr-added">Stay: Lis Blue, €96 a night, eight minutes from the venue.</p>}</> };
  const hotels: Node = { id: 'hotels', stamp: 'hotels', kind: <><Table2 size={12}/>Data</>, title: '14 hotels near the venue', foot: <><BrandLogo id="google-sheets" size={12}/><span className="fr-cut">Google Sheets · 14 rows · 5 columns</span></>,
    body: <span className="fr-table"><span className="h">hotel</span><span className="h n">€ a night</span><span className="h n">walk</span><span>Lis Blue</span><span className="n">96</span><span className="n">8 min</span><span>Alfama Yard</span><span className="n">132</span><span className="n">3 min</span><span>Tejo View</span><span className="n">118</span><span className="n">15 min</span></span> };
  const flights: Node = { id: 'flights', stamp: 'flights', kind: <><FileText size={12}/>File</>, title: 'flights.pdf', foot: <span className="fr-cut">PDF · 2 pages · from your Downloads</span>,
    body: <span className="fr-doc"><b>Amsterdam to Lisbon</b><span>12 Nov · 07:40 to 10:05 · six seats</span><span>Back 14 Nov · €1,380 for everyone</span></span> };
  const agent: Node = { id: 'agent', stamp: 'agent', kind: <><AgentIcon id={agentId} size={12}/>Agent · {agentLabel}</>, state: working ? <><i className="fr-dot"/>Running · {clock}</> : `Done in ${seconds} s`,
    title: <span className="fr-swap" key={phase}>{WORK[phase].doing}</span>,
    body: <ol className={`fr-steps${working ? ' live' : ''}`}>{WORK.map((item, index) => { const done = index < phase || !working; return <li key={item.done} className={done ? 'done' : index === phase ? 'now' : ''}><i>{done && <Check size={9} strokeWidth={3}/>}</i>{done ? item.done : item.doing}</li>; })}</ol>,
    foot: <><span className="fr-logos">{AGENTS.map(id => <span key={id} className={found.some(agent => agent.id === id) ? 'on' : ''}><AgentIcon id={id} size={13}/></span>)}</span><span className="fr-cut">Any vendor</span></> };
  const proposal: Node | null = working ? null : { id: 'proposal', stamp: `proposal-${decision}`, className: `proposal${decision ? ` decided ${decision}` : ''}`, kind: <><RosMark working={dl?.state === 'downloading'}/>ROS · proposal</>, foot: rosFoot,
    state: decision === 'accepted' ? <span className="fr-live ok"><i/>Accepted</span> : decision === 'kept' ? 'Kept out' : 'For you', title: 'Stay at Lis Blue',
    body: decision === 'accepted' ? <p>Added to the brief. Everything an agent makes lands this way: only after you accept it.</p>
      : decision === 'kept' ? <p>Nothing changed. Your brief stays as it was.</p>
      : <><p>€96 a night and eight minutes to the venue: €620 under budget. Add it to the brief?</p><span className="fr-chips"><button type="button" className="fr-chip" onClick={() => setDecision('accepted')}>Accept</button><button type="button" className="fr-chip lt" onClick={() => setDecision('kept')}>Keep mine</button></span></> };
  const mac: Node = { id: 'computer', stamp: `computer-${all.map(line => line.key + line.note).join()}`, kind: <><Laptop size={12}/>On {computer}</>, state: all.length ? `${all.length} found` : undefined,
    body: lines.length ? <><ul className="fr-found">{lines.map(line => <li key={line.key}>{line.icon}<span>{line.label}</span><small>{line.note}</small></li>)}</ul>{more > 0 && <p className="fr-more">and {more} more</p>}</> : 'No agents, model servers or apps found yet. ROS works on its own.',
    foot: <span className="fr-cut">{status.lookedAt.length} place{status.lookedAt.length === 1 ? '' : 's'} looked at · names and dates only</span> };
  const node = (item: Node, order: number) => <section key={item.id} data-id={item.id} className={`fr-sat${item.className ? ` ${item.className}` : ''}`} style={{ animationDelay: `${120 + order * 70}ms` }}>
    <div className="fr-sat-in" key={item.stamp}>
      <span className="fr-sat-kind">{item.kind}{item.state && <span className="fr-sat-state">{item.state}</span>}</span>
      {item.title && <b className="fr-sat-title">{item.title}</b>}
      {item.body && <div className="fr-sat-body">{item.body}</div>}
      {item.foot && <div className="fr-sat-foot">{item.foot}</div>}
    </div>
  </section>;

  return <div className="first-run">
    <Wordmark className="fr-brand"/>
    <div className="fr-stage" ref={stage}>
      <svg className="fr-wires" aria-hidden="true">{wires.map((wire, index) => <g key={index}>
        <path d={wire.d} className={wire.dash ? 'dash' : undefined}/><circle cx={wire.from[0]} cy={wire.from[1]} r="3.5"/><circle cx={wire.to[0]} cy={wire.to[1]} r="3.5"/>
        {wire.pulse && <circle className="fr-pulse" r="3"><animateMotion dur="2.6s" repeatCount="indefinite" begin={`${(index % 4) * 0.45}s`} path={wire.d}/></circle>}
      </g>)}</svg>
      <aside className="fr-side left">
        {steps.length > 1 && node(stepsNode, 0)}
        <div className="fr-group" role="group" aria-label="An example project on the canvas: a team trip to Lisbon">
          <span className="fr-group-label"><Group size={11}/>Example · Lisbon trip</span>
          {node(brief, 1)}{node(hotels, 2)}{node(flights, 3)}
        </div>
      </aside>
      <div className="fr-center" ref={center}><main className="fr-page" key={step}>{page}</main></div>
      <aside className="fr-side right">{node(agent, 1)}{proposal && node(proposal, 0)}{node(mac, 3)}</aside>
    </div>
  </div>;
}
