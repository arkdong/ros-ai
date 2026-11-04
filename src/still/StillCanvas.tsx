import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { MarkdownPreview, RichText } from '../client/Content';
import { chipPoint, facingSides, linkCurve, sideAnchor, type LinkBox } from '../shared/links';
import type { ShareBox, ShareCopy, ShareFace, ShareNode } from '../shared/share';
import './still.css';

/** A block left out in the Share sheet, still drawn faintly there so a click brings it back. */
export type StillGhost = { id: string; title: string; box: ShareBox };
type Props = {
  copy: ShareCopy;
  /** Where a carried file can be read: a data URL in a canvas file, the project's file route in ros.ai. */
  fileUrl: (key: string) => string | undefined;
  onOpen?: (node: ShareNode) => void;
  ghosts?: StillGhost[];
  onGhost?: (id: string) => void;
  /** Blocks the sheet marks (left out by a click on the preview). */
  className?: string;
  /** Changes when the copy should be fitted to the frame again. */
  fitKey?: string | number;
  padding?: number;
};

const ZOOM = { min: .05, max: 2.5 };
const size = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const day = (value?: string) => { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };

/** A read-only canvas: the blocks of a shared copy where they sat, with their links. It pans and zooms, and a click
 * opens a block. No editing, no agents and no network: everything it shows is in the copy. */
export function StillCanvas({ copy, fileUrl, onOpen, ghosts = [], onGhost, className = '', fitKey, padding = 48 }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const viewRef = useRef(view); viewRef.current = view;
  const placed = useMemo(() => copy.nodes.filter(node => node.box), [copy]);
  const byId = useMemo(() => new Map(copy.nodes.map(node => [node.id, node])), [copy]);
  const bounds = useMemo(() => {
    const boxes = [...placed.map(node => node.box!), ...ghosts.map(ghost => ghost.box)];
    if (!boxes.length) return { x: 0, y: 0, width: 400, height: 300 };
    const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
    return { x, y, width: Math.max(...boxes.map(box => box.x + box.width)) - x, height: Math.max(...boxes.map(box => box.y + box.height)) - y };
  }, [placed, ghosts]);

  const fit = useCallback(() => {
    const element = frame.current; if (!element) return;
    const { width, height } = element.getBoundingClientRect(); if (!width || !height) return;
    const zoom = Math.min(1, Math.max(ZOOM.min, Math.min((width - padding * 2) / bounds.width, (height - padding * 2) / bounds.height)));
    setView({ zoom, x: (width - bounds.width * zoom) / 2 - bounds.x * zoom, y: (height - bounds.height * zoom) / 2 - bounds.y * zoom });
  }, [bounds, padding]);
  useLayoutEffect(() => { fit(); }, [fitKey, copy.title]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const element = frame.current; if (!element) return;
    let first = true;
    const observer = new ResizeObserver(() => { if (first) { first = false; return; } fit(); });
    observer.observe(element); return () => observer.disconnect();
  }, [fit]);

  const zoomAt = useCallback((factor: number, at: { x: number; y: number }) => {
    const current = viewRef.current, zoom = Math.min(ZOOM.max, Math.max(ZOOM.min, current.zoom * factor)), scale = zoom / current.zoom;
    setView({ zoom, x: at.x - (at.x - current.x) * scale, y: at.y - (at.y - current.y) * scale });
  }, []);
  useEffect(() => {
    const element = frame.current; if (!element) return;
    // A trackpad scroll pans; a pinch (which browsers send as a wheel with Ctrl) or Ctrl+wheel zooms.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect(), at = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-event.deltaY * .01), at);
      else setView(current => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [zoomAt]);

  // Dragging pans; two fingers pinch. A press that barely moves is a click on whatever is under it.
  const pointers = useRef(new Map<number, { x: number; y: number }>()), moved = useRef(0), pinch = useRef(0);
  const down = (event: ReactPointerEvent) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); moved.current = 0;
    if (pointers.current.size === 2) { const [a, b] = [...pointers.current.values()]; pinch.current = Math.hypot(a.x - b.x, a.y - b.y); }
  };
  const move = (event: ReactPointerEvent) => {
    const last = pointers.current.get(event.pointerId); if (!last) return;
    if (pointers.current.size === 1) {
      const dx = event.clientX - last.x, dy = event.clientY - last.y;
      moved.current += Math.abs(dx) + Math.abs(dy);
      if (moved.current > 4) { frame.current?.setPointerCapture(event.pointerId); setView(current => ({ ...current, x: current.x + dx, y: current.y + dy })); }
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()], distance = Math.hypot(a.x - b.x, a.y - b.y), rect = frame.current!.getBoundingClientRect();
      if (pinch.current) zoomAt(distance / pinch.current, { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top });
      pinch.current = distance; moved.current = 99;
    }
  };
  const up = (event: ReactPointerEvent) => { pointers.current.delete(event.pointerId); if (pointers.current.size < 2) pinch.current = 0; };
  const click = (act: () => void) => () => { if (moved.current <= 4) act(); };

  // A link to a block hidden inside a closed Group ends at that Group.
  const shownBox = (id: string): ShareBox | undefined => { for (let node = byId.get(id); node; node = node.parentId ? byId.get(node.parentId) : undefined) if (node.box) return node.box; return undefined; };
  const cards = placed.filter(node => !(node.face.type === 'group' && node.open));
  const frames = placed.filter(node => node.face.type === 'group' && node.open);
  const obstacles: LinkBox[] = cards.map(node => node.box!);
  const links = copy.links.flatMap(link => {
    const a = shownBox(link.source), b = shownBox(link.target);
    if (!a || !b || a === b) return [];
    const sides = facingSides(a, b), curve = linkCurve(sideAnchor(a, sides.source), sides.source, sideAnchor(b, sides.target), sides.target);
    return [{ id: link.id, path: curve.path, label: link.label, at: link.label ? chipPoint(curve.point, obstacles) : null }];
  });

  return <div ref={frame} className={`still-frame ${className}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
    <div className="still-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
      {frames.map(node => <section key={node.id} className="still-group-frame" style={box(node.box!)} onClick={click(() => onOpen?.(node))}>
        <header><span className="still-kind">Group</span><h3>{node.title || 'Untitled'}</h3>{node.face.type === 'group' && node.face.note && <p>{node.face.note.slice(0, 200)}</p>}</header>
      </section>)}
      <svg className="still-links" aria-hidden="true" style={{ left: bounds.x - 400, top: bounds.y - 400, width: bounds.width + 800, height: bounds.height + 800 }} viewBox={`${bounds.x - 400} ${bounds.y - 400} ${bounds.width + 800} ${bounds.height + 800}`}>
        <defs><marker id="still-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="#a8a8a8" strokeWidth="1.5"/></marker></defs>
        {links.map(link => <path key={link.id} d={link.path} markerEnd="url(#still-arrow)"/>)}
      </svg>
      {links.map(link => link.at && <span key={link.id} className="still-link-label" style={{ left: link.at.x, top: link.at.y }}>{link.label}</span>)}
      {ghosts.map(ghost => <button key={ghost.id} type="button" className="still-ghost" style={box(ghost.box)} title="Left out. Click to include it again." onClick={click(() => onGhost?.(ghost.id))}><span>{ghost.title || 'Untitled'}</span><small>Left out</small></button>)}
      {cards.map(node => <StillCard key={node.id} node={node} copy={copy} fileUrl={fileUrl} onClick={click(() => onOpen?.(node))}/>)}
    </div>
  </div>;
}

const box = (value: ShareBox) => ({ left: value.x, top: value.y, width: value.width, height: value.height });

function StillCard({ node, copy, fileUrl, onClick }: { node: ShareNode; copy: ShareCopy; fileUrl: Props['fileUrl']; onClick: () => void }) {
  const face = node.face;
  if (face.type === 'picture') {
    const src = face.src ?? (face.file ? fileUrl(face.file) : undefined);
    return <article className={`still-card still-picture${face.src ? ' framed' : ''}`} style={box(node.box!)} onClick={onClick}>
      {src ? <img src={src} alt={node.title} draggable={false}/> : <span className="still-left">Picture</span>}
      {!face.src && <span className="still-picture-title">{node.title}</span>}
    </article>;
  }
  const members = face.type === 'group' ? copy.nodes.filter(item => item.parentId === node.id) : [];
  return <article className={`still-card${face.type === 'group' ? ' still-group' : ''}`} style={box(node.box!)} onClick={onClick}>
    <div className="still-top"><span className="still-kind">{node.kindName}{face.type === 'group' ? ` · ${members.length} item${members.length === 1 ? '' : 's'}` : ''}</span>{node.label && <span className="still-label">{node.label}</span>}</div>
    <h3 className="still-title">{node.title || 'Untitled'}</h3>
    <div className="still-body">{face.type === 'group'
      ? <>{face.note && <p className="still-note">{face.note.slice(0, 160)}</p>}<ul className="still-members">{members.slice(0, 6).map(member => <li key={member.id}>{member.title || 'Untitled'}</li>)}{members.length > 6 && <li className="more">{members.length - 6} more</li>}</ul></>
      : <FaceView face={face} copy={copy} fileUrl={fileUrl} compact/>}</div>
    {(node.snapshot || node.agent) && <footer className="still-foot">{node.snapshot ? `${node.snapshot.from} · as it looked${node.snapshot.at ? ` on ${day(node.snapshot.at)}` : ''}` : `${node.agent!.runtime}${node.agent!.model ? ` · ${node.agent!.model}` : ''}`}</footer>}
  </article>;
}

/** What a block shows, on its card (compact) or opened. */
export function FaceView({ face, copy, fileUrl, compact = false }: { face: ShareFace; copy: ShareCopy; fileUrl: Props['fileUrl']; compact?: boolean }): ReactNode {
  switch (face.type) {
    case 'text': return compact ? <MarkdownPreview text={face.markdown} limit={600}/> : <RichText text={face.markdown}/>;
    case 'code': return <pre className="still-code"><code>{compact ? face.source.split('\n').slice(0, 14).join('\n') : face.source}</code></pre>;
    case 'table': {
      const rows = compact ? face.rows.slice(0, 6) : face.rows, columns = compact ? face.columns.slice(0, 5) : face.columns;
      return <div className="still-table-wrap"><table className="still-table"><thead><tr>{columns.map((column, index) => <th key={index}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.slice(0, columns.length).map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table>
        <small>{face.total.toLocaleString('en-US')} rows · {face.columns.length} columns{!compact && face.total > face.rows.length ? ` · first ${face.rows.length.toLocaleString('en-US')} shared` : ''}</small></div>;
    }
    case 'picture': { const src = face.src ?? (face.file ? fileUrl(face.file) : undefined); return src ? <img className="still-opened-picture" src={src} alt=""/> : <p className="still-left">Picture</p>; }
    case 'pdf': { const file = copy.files[face.file]; return <div className="still-pdf"><span className="still-pdf-mark">PDF</span><div><strong>{file?.name ?? 'Document'}</strong>{file && <small>{size(file.size)}</small>}</div></div>; }
    case 'numbers': return <dl className="still-numbers">{face.values.slice(0, compact ? 6 : undefined).map((value, index) => <div key={index}><dt>{value.label}</dt><dd>{value.value}</dd>{!compact && value.note && <small>{value.note}</small>}</div>)}</dl>;
    case 'pins': return <ul className="still-pins">{face.pins.slice(0, compact ? 6 : undefined).map((pin, index) => <li key={index}><strong>{pin.name}</strong>{!compact && <small> · {pin.lat.toFixed(4)}, {pin.lng.toFixed(4)}{pin.note ? ` · ${pin.note}` : ''}</small>}</li>)}</ul>;
    case 'app': return <p className="still-left">An interactive App. It runs when this canvas is opened in ros.ai.</p>;
    case 'post': return <div className="still-post"><small>{face.author}{face.community ? ` · ${face.community}` : ''}</small>{face.title && <strong>{face.title}</strong>}<p>{compact ? face.text.slice(0, 280) : face.text}</p>{!compact && <a href={face.url} target="_blank" rel="noreferrer">{face.url}</a>}</div>;
    case 'group': return face.note ? <RichText text={face.note}/> : null;
    case 'left': return <p className="still-left">{face.note}</p>;
    case 'empty': return null;
  }
}
