import { useEffect, useRef, useState } from 'react';
import { MiniMap, useReactFlow, useStore, type Node } from '@xyflow/react';
import './canvas-minimap.css';

const WIDTH = 168, HEIGHT = 112, IDLE_MS = 1400;
// The Ros bar is centred and up to 620 px wide; below this map width it would run into the minimap, so the minimap moves to the right (see canvas-minimap.css).
const BESIDE_BAR = 620 + 2 * (16 + WIDTH + 12);
// An open Group is drawn as its frame, so the blocks it holds show inside it instead of vanishing into one grey slab;
// blocks and closed Groups are drawn solid (canvas-minimap.css).
const shape = ({ data }: Node) => data.kind === 'group' && data.expanded ? 'frame' : 'block';

/** A small overview of the whole canvas at the bottom left. It shows while the map moves and fades out once it rests;
 *  a click jumps there and a drag pans the map. */
export function CanvasMinimap() {
  const flow = useReactFlow(), narrow = useStore(state => state.width > 0 && state.width < BESIDE_BAR);
  const [awake, setAwake] = useState(false), [held, setHeld] = useState(false), timer = useRef<number | undefined>(undefined);
  const wake = () => { setAwake(true); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setAwake(false), IDLE_MS); };
  // Any change of view wakes it: a drag, a scroll, a zoom, See all or a jump from the minimap itself. Opening the map does not.
  const [x, y, zoom] = useStore(state => state.transform), first = useRef(true);
  useEffect(() => { if (first.current) first.current = false; else wake(); }, [x, y, zoom]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return <div className={`canvas-minimap${awake || held ? ' awake' : ''}${narrow ? ' above-bar' : ''}`} aria-hidden={!(awake || held)}
    onPointerEnter={() => setHeld(true)} onPointerLeave={() => { setHeld(false); wake(); }}>
    <MiniMap position="bottom-left" pannable ariaLabel="Canvas overview" style={{ width: WIDTH, height: HEIGHT }}
      nodeClassName={shape} nodeBorderRadius={6} bgColor="#ffffff" maskColor="transparent" maskStrokeColor="#171717" maskStrokeWidth={1.5} offsetScale={8}
      onClick={(_, point) => void flow.setCenter(point.x, point.y, { zoom: flow.getZoom(), duration: 260 })}/>
  </div>;
}
