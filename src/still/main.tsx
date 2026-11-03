import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RichText } from '../client/Content';
import { readShareBundle, type ShareBundle, type ShareNode } from '../shared/share';
import { FaceView, StillCanvas } from './StillCanvas';

/** A canvas file opened in a browser: the shared canvas, read only. Its data sits in the page itself. */
function StillPage({ bundle }: { bundle: ShareBundle }) {
  // Files become blob addresses once, so a 20 MB PDF is not copied into every image tag.
  const urls = useMemo(() => {
    const made: Record<string, string> = {};
    for (const [key, file] of Object.entries(bundle.files)) {
      const data = bundle.data[key]; if (!data) continue;
      const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
      made[key] = URL.createObjectURL(new Blob([bytes], { type: file.mediaType }));
    }
    return made;
  }, [bundle]);
  const [opened, setOpened] = useState<ShareNode | null>(null), [talk, setTalk] = useState(false), [fitKey, setFitKey] = useState(0);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpened(null); setTalk(false); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, []);
  const blocks = bundle.nodes.filter(node => node.face.type !== 'group').length;
  const when = new Date(bundle.sharedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const members = opened?.face.type === 'group' ? bundle.nodes.filter(node => node.parentId === opened.id) : [];
  const pdf = opened?.face.type === 'pdf' ? urls[opened.face.file] : undefined;
  return <div className="still-page">
    <header className="still-header">
      <div><h1>{bundle.title}</h1><p>{blocks} block{blocks === 1 ? '' : 's'} · shared {when}</p></div>
      <div className="still-actions">
        {bundle.conversation?.length ? <button type="button" className={talk ? 'on' : ''} onClick={() => { setTalk(!talk); setOpened(null); }}>Conversation</button> : null}
        <button type="button" onClick={() => setFitKey(key => key + 1)}>Fit</button>
      </div>
    </header>
    <StillCanvas copy={bundle} fileUrl={key => urls[key]} onOpen={node => { setOpened(node); setTalk(false); }} fitKey={fitKey} className="still-main"/>
    <a className="still-made" href="https://ros-ai.io" target="_blank" rel="noreferrer">Made with ros.ai</a>
    {opened && <aside className="still-panel" aria-label={opened.title}>
      <div className="still-panel-head"><span className="still-kind">{opened.kindName}{opened.label ? ` · ${opened.label}` : ''}</span><button type="button" aria-label="Close" onClick={() => setOpened(null)}>×</button></div>
      <h2>{opened.title || 'Untitled'}</h2>
      {opened.snapshot && <p className="still-panel-note">{opened.snapshot.from} · a copy of how it looked{opened.snapshot.at ? ` on ${new Date(opened.snapshot.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}` : ''}</p>}
      {opened.agent && <p className="still-panel-note">{opened.agent.runtime}{opened.agent.model ? ` · ${opened.agent.model}` : ''}</p>}
      <div className="still-panel-body">
        <FaceView face={opened.face} copy={bundle} fileUrl={key => urls[key]}/>
        {pdf && <p><a className="still-button" href={pdf} target="_blank" rel="noreferrer">Open the PDF</a></p>}
        {members.length > 0 && <ul className="still-panel-members">{members.map(member => <li key={member.id}><button type="button" onClick={() => setOpened(member)}><span className="still-kind">{member.kindName}</span>{member.title || 'Untitled'}</button></li>)}</ul>}
      </div>
    </aside>}
    {talk && bundle.conversation && <aside className="still-panel" aria-label="Conversation">
      <div className="still-panel-head"><span className="still-kind">Conversation with ROS</span><button type="button" aria-label="Close" onClick={() => setTalk(false)}>×</button></div>
      <div className="still-panel-body still-talk">{bundle.conversation.map((message, index) => <div key={index} className={`still-message ${message.role}`}><RichText text={message.text}/></div>)}</div>
    </aside>}
  </div>;
}

const element = document.getElementById('ros-canvas');
let bundle: ShareBundle | null = null;
try { bundle = readShareBundle(JSON.parse(element?.textContent ?? 'null')); } catch { bundle = null; }
const root = createRoot(document.getElementById('root')!);
root.render(<StrictMode>{bundle ? <StillPage bundle={bundle}/> : <p className="still-broken">This canvas file could not be read.</p>}</StrictMode>);
