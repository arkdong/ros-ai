import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Download, ImageOff, LoaderCircle, Minus, Pause, Play, Plus, VideoOff } from 'lucide-react';
import type { Artifact } from '../shared/types';
import { fileSize, isPdfType, isVideoType, videoLength, type ImageSize } from '../shared/files';
import './file-view.css';

type PdfModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfDocument = import('pdfjs-dist/legacy/build/pdf.mjs').PDFDocumentProxy;
type RenderTask = import('pdfjs-dist/legacy/build/pdf.mjs').RenderTask;
type TextLayer = import('pdfjs-dist/legacy/build/pdf.mjs').TextLayer;
type PdfWorker = import('pdfjs-dist/legacy/build/pdf.mjs').PDFWorker;
/** The file a block shows: its address (which changes with the file's version), type and size, a picture's or video's
 * pixel size and a video's length. */
export type ShownFile = { src: string; mediaType: string; bytes?: number; image?: ImageSize; seconds?: number };
const ZOOMS = [50, 75, 100, 125, 150, 200, 300];
/** PDFs kept open while no card or sheet shows them, so opening one again is quick. Each holds its whole file. */
const IDLE_DOCUMENTS = 4;
/** A drawn page is capped at this many pixels (about 48 MB), so a page zoomed far in is drawn a little softer instead
 * of taking hundreds of megabytes. */
const MAX_PAGE_PIXELS = 12_000_000;
/** The steps a picture zooms through, as a share of its own pixel size; Fit sits between the two that bracket it. */
const PICTURE_ZOOMS = [25, 50, 75, 100, 150, 200, 300, 400];

let pdfjsLoad: Promise<PdfModule> | null = null;
/** pdf.js is loaded the first time a PDF is on screen; its worker renders pages off the main thread. The legacy build
 * carries the polyfills that browsers from before 2026 need. */
function loadPdfjs(): Promise<PdfModule> {
  return pdfjsLoad ??= Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')]).then(([pdfjs, worker]) => { pdfjs.GlobalWorkerOptions.workerSrc = worker.default; return pdfjs; });
}
/** Every PDF is read in one pdf.js worker; a worker per PDF kept a copy of each file for as long as the page was open. */
let pdfWorker: PdfWorker | null = null;
type OpenPdf = { doc: Promise<PdfDocument>; users: number };
/** The open documents, least recently used first. */
const documents = new Map<string, OpenPdf>();
/** One open document per address, shared by every card and sheet that shows it. The address carries the file's version,
 * so a replaced file is read again. */
function openPdf(src: string): OpenPdf {
  const known = documents.get(src);
  if (known) { documents.delete(src); documents.set(src, known); return known; }
  const open: OpenPdf = { doc: loadPdfjs().then(pdfjs => {
    if (!pdfWorker || pdfWorker.destroyed) pdfWorker = new pdfjs.PDFWorker();
    return pdfjs.getDocument({ url: src, disableRange: true, disableStream: true, worker: pdfWorker }).promise;
  }), users: 0 };
  documents.set(src, open);
  open.doc.catch(() => { if (documents.get(src) === open) documents.delete(src); });
  return open;
}
/** Past IDLE_DOCUMENTS, the documents nothing shows are closed, longest unused first, which frees their files in the
 * worker. A document something shows is never closed. */
function closeIdlePdfs() {
  const idle = [...documents].filter(([, open]) => open.users === 0);
  for (const [src, open] of idle.slice(0, Math.max(0, idle.length - IDLE_DOCUMENTS))) {
    documents.delete(src);
    void open.doc.then(doc => doc.loadingTask.destroy()).catch(() => undefined);
  }
}
function usePdf(src: string): { doc: PdfDocument | null; error: string } {
  const [state, setState] = useState<{ src: string; doc: PdfDocument | null; error: string }>({ src, doc: null, error: '' });
  useEffect(() => {
    let live = true;
    const open = openPdf(src);
    open.users++;
    open.doc.then(doc => { if (live) setState({ src, doc, error: '' }); }, (reason: unknown) => { if (live) setState({ src, doc: null, error: reason instanceof Error ? reason.message : 'The PDF could not be read.' }); });
    return () => { live = false; open.users--; closeIdlePdfs(); };
  }, [src]);
  return state.src === src ? state : { doc: null, error: '' };
}
/** The inner width of an element, followed as it resizes. */
function useWidth(box: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const update = () => setWidth(Math.floor(element.clientWidth));
    const observer = new ResizeObserver(update); observer.observe(element); update();
    return () => observer.disconnect();
  }, [box]);
  return width;
}

/** A width that has stopped changing for a moment; the first one is taken at once. */
function useSettled(value: number, wait = 160): number {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (settled === 0 && value > 0) { setSettled(value); return; }
    const timer = setTimeout(() => setSettled(value), wait);
    return () => clearTimeout(timer);
  }, [value, wait]); // eslint-disable-line react-hooks/exhaustive-deps
  return settled === 0 ? value : settled;
}

/** One page drawn at a CSS width, sharp on high-density screens up to MAX_PAGE_PIXELS. The page is drawn off screen and
 * then shown in one step, so a redraw never blanks the page. A fluid page fills its box and scales while a new width is
 * drawn. With `text`, pdf.js lays the page's words over it as invisible text, so they can be selected and copied. */
function PdfPage({ doc, number, width, fluid = false, text = false, onRendered }: { doc: PdfDocument; number: number; width: number; fluid?: boolean; text?: boolean; onRendered?: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), words = useRef<HTMLDivElement>(null);
  const rendered = useRef(onRendered); rendered.current = onRendered;
  useEffect(() => {
    let live = true, task: RenderTask | undefined;
    void doc.getPage(number).then(page => {
      if (!live || !canvas.current) return;
      const base = page.getViewport({ scale: 1 }), ratio = window.devicePixelRatio || 1;
      const scale = width / base.width;
      if (!(scale > 0)) return;
      const sharp = Math.min(scale * ratio, Math.sqrt(MAX_PAGE_PIXELS / (base.width * base.height)));
      const viewport = page.getViewport({ scale: sharp }), drawn = document.createElement('canvas');
      drawn.width = Math.floor(viewport.width); drawn.height = Math.floor(viewport.height);
      task = page.render({ canvas: drawn, viewport });
      return task.promise.then(() => {
        const element = canvas.current;
        if (live && element) {
          element.width = drawn.width; element.height = drawn.height;
          element.getContext('2d')?.drawImage(drawn, 0, 0);
          if (fluid) { element.style.width = '100%'; element.style.height = 'auto'; }
          else { element.style.width = `${Math.floor(width)}px`; element.style.height = `${Math.floor(base.height * scale)}px`; }
          rendered.current?.();
        }
        // The browser frees a canvas's pixels sooner once it has none.
        drawn.width = 0; drawn.height = 0;
      });
    }).catch((error: unknown) => { if (live && !(error instanceof Error && error.name === 'RenderingCancelledException')) console.error(`Page ${number} could not be drawn`, error); });
    return () => { live = false; task?.cancel(); };
  }, [doc, number, width, fluid]);
  // A page that leaves the view gives back its pixels and what pdf.js kept to draw it.
  useEffect(() => {
    const element = canvas.current;
    return () => {
      if (element) { element.width = 0; element.height = 0; }
      void doc.getPage(number).then(page => page.cleanup()).catch(() => undefined);
    };
  }, [doc, number]);
  useEffect(() => {
    const element = words.current;
    if (!text || !element) return;
    let live = true, layer: TextLayer | undefined;
    void Promise.all([loadPdfjs(), doc.getPage(number)]).then(([pdfjs, page]) => {
      if (!live) return;
      const scale = width / page.getViewport({ scale: 1 }).width;
      if (!(scale > 0)) return;
      element.replaceChildren();
      element.style.setProperty('--total-scale-factor', String(scale));
      layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: element, viewport: page.getViewport({ scale }) });
      return layer.render();
    }).catch((error: unknown) => { if (live && !(error instanceof Error && error.name === 'AbortException')) console.error(`The text of page ${number} could not be laid out`, error); });
    return () => { live = false; layer?.cancel(); };
  }, [doc, number, width, text]);
  const page = <canvas ref={canvas} className="pdf-page" role="img" aria-label={`Page ${number}`}/>;
  return text ? <>{page}<div ref={words} className="pdf-text"/></> : page;
}

/** What a File block shows on its card: a PDF's pages in one scroll with one quiet line about the file, or the picture
 * itself, whole, filling the card. The card's width sets the pages'; resizing redraws them. */
export function FilePreview({ file, title, missing = false, onSize }: { file: ShownFile; title: string; missing?: boolean; onSize?: (size: ImageSize) => void }) {
  if (isVideoType(file.mediaType)) return <VideoPreview file={file} title={title} missing={missing} onSize={onSize}/>;
  if (!isPdfType(file.mediaType)) return <PicturePreview file={file} title={title} missing={missing} onSize={onSize}/>;
  return <PdfPreview file={file}/>;
}
/** The address a video is shown from: its first frame stands as its poster until it plays. */
const posterFrame = (src: string) => `${src}#t=0.001`;
/** The one video playing on the map, so starting another pauses it and opening it carries on where the card was. */
let playingCard: { src: string; video: HTMLVideoElement } | null = null;
/** A video on its card: its first frame, whole, in the video's shape, with its length; the button in the middle plays
 * it in place (the card still drags from anywhere else) and a thin line shows how far it has played. Only the header
 * is read until it plays; the browser then asks the server for the parts it needs. */
function VideoPreview({ file, title, missing, onSize }: { file: ShownFile; title: string; missing: boolean; onSize?: (size: ImageSize) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState<string | null>(null), [playing, setPlaying] = useState(false), [played, setPlayed] = useState(0);
  const [length, setLength] = useState<number | undefined>(file.seconds);
  useEffect(() => () => { if (playingCard?.video === video.current) playingCard = null; }, []);
  if (missing || failed === file.src) return <div className="picture-missing"><VideoOff size={18} strokeWidth={1.5}/><span>{title || 'Untitled'}</span><small>{missing ? 'File missing from the project folder' : 'This video does not play here. Open it to use another app.'}</small></div>;
  const toggle = () => {
    const element = video.current;
    if (!element) return;
    if (!element.paused) { element.pause(); return; }
    if (playingCard && playingCard.video !== element) playingCard.video.pause();
    playingCard = { src: file.src, video: element };
    void element.play().catch(() => undefined);
  };
  const shown = length ?? file.seconds;
  return <div className={`video-card${playing ? ' playing' : ''}`}>
    <video ref={video} className="picture-preview video-preview" src={posterFrame(file.src)} preload="metadata" playsInline draggable={false} aria-label={title}
      style={file.image ? { aspectRatio: `${file.image.width} / ${file.image.height}`, width: `min(100%, ${file.image.width}px)` } : undefined}
      onLoadedMetadata={event => { const element = event.currentTarget; if (element.videoWidth && element.videoHeight) onSize?.({ width: element.videoWidth, height: element.videoHeight }); if (Number.isFinite(element.duration)) setLength(element.duration); }}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
      onEnded={event => { event.currentTarget.currentTime = 0; setPlayed(0); }}
      onTimeUpdate={event => { const element = event.currentTarget; if (element.duration > 0) setPlayed(element.currentTime / element.duration); }}
      onError={() => setFailed(file.src)}/>
    <button type="button" className="video-play nodrag" aria-label={playing ? `Pause ${title}` : `Play ${title}`} onClick={event => { event.stopPropagation(); toggle(); }} onDoubleClick={event => event.stopPropagation()}>{playing ? <Pause size={18} fill="currentColor" strokeWidth={0}/> : <Play size={18} fill="currentColor" strokeWidth={0}/>}</button>
    {shown !== undefined && !playing && played === 0 && <span className="video-length">{videoLength(shown)}</span>}
    {(playing || played > 0) && <span className="video-progress" aria-hidden="true"><span style={{ width: `${played * 100}%` }}/></span>}
  </div>;
}
/** A picture on its card: as wide as the card and as tall as its own shape asks, so the whole picture shows. Its
 * pixel size, known from the folder, gives the card that shape before the picture loads; `onSize` tells the canvas
 * the size once the picture has loaded, for a file the folder could not read. */
function PicturePreview({ file, title, missing, onSize }: { file: ShownFile; title: string; missing: boolean; onSize?: (size: ImageSize) => void }) {
  const [failed, setFailed] = useState<string | null>(null);
  const broken = missing || failed === file.src;
  if (broken) return <div className="picture-missing"><ImageOff size={18} strokeWidth={1.5}/><span>{title || 'Untitled'}</span><small>{missing ? 'File missing from the project folder' : 'The picture could not be shown'}</small></div>;
  // A picture smaller than the card sits at its own size in the middle, rather than being stretched.
  return <img className="picture-preview" src={file.src} alt={title} draggable={false} style={file.image ? { aspectRatio: `auto ${file.image.width} / ${file.image.height}`, width: `min(100%, ${file.image.width}px)` } : undefined}
    onLoad={event => onSize?.({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setFailed(file.src)}/>;
}
/** The card's PDF: every page under the one before, scrolled like a Notion page card once the block is picked (see
 * canvasWheel in Canvas.tsx). Page 1 is drawn at once, the rest as they come near the view, and pages far from it are not. */
function PdfPreview({ file }: { file: ShownFile }) {
  // While the card is resized the drawn pages scale with it; they are drawn again once the width settles.
  const box = useRef<HTMLDivElement>(null), width = useSettled(useWidth(box)), { doc, error } = usePdf(file.src), sizes = usePageSizes(doc);
  const shown = useNearPages(box, sizes.length, 1);
  return <>
    <div ref={box} className="block-figure-preview file-page-preview">{error ? <span className="file-preview-note">{error}</span> : doc && width > 0 && sizes.length ? sizes.map((size, index) => <div key={index} className="pdf-page-box" style={{ aspectRatio: `${size.width} / ${size.height}` }}>{shown.has(index + 1) && <PdfPage doc={doc} number={index + 1} width={width} fluid/>}</div>) : <LoaderCircle size={14} className="spin"/>}</div>
    <FileLine parts={['PDF', doc ? `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}` : '', file.bytes ? fileSize(file.bytes) : '']}/>
  </>;
}
/** Every page's size at scale 1, so each page's box has its height before it is drawn and the scroll length is right. */
function usePageSizes(doc: PdfDocument | null): { width: number; height: number }[] {
  const [sizes, setSizes] = useState<{ doc: PdfDocument; all: { width: number; height: number }[] } | null>(null);
  useEffect(() => {
    if (!doc) return;
    let live = true;
    void Promise.all(Array.from({ length: doc.numPages }, (_, index) => doc.getPage(index + 1).then(page => { const view = page.getViewport({ scale: 1 }); return { width: view.width, height: view.height }; })))
      .then(all => { if (live) setSizes({ doc, all }); }).catch(() => undefined);
    return () => { live = false; };
  }, [doc]);
  return sizes && sizes.doc === doc ? sizes.all : [];
}
/** The pages (counted from 1) within a view's height above a scroll box's view or two below it. Only these are drawn: a
 * page that moves further away is let go and drawn again when it comes back, so a long PDF holds a few pages, not every
 * page scrolled past. `onUpdate` hears the box after each check, for the page counter. */
function useNearPages(box: RefObject<HTMLElement | null>, total: number, layout: unknown, onUpdate?: (element: HTMLElement, pages: HTMLElement[]) => void): Set<number> {
  const [shown, setShown] = useState<Set<number>>(() => new Set([1, 2]));
  const heard = useRef(onUpdate); heard.current = onUpdate;
  useEffect(() => {
    const element = box.current;
    if (!element || !total) return;
    const update = () => {
      const pages = Array.from(element.querySelectorAll<HTMLElement>('.pdf-page-box'));
      const top = element.scrollTop, near = new Set<number>();
      pages.forEach((page, index) => { if (page.offsetTop < top + element.clientHeight * 2 && page.offsetTop + page.offsetHeight > top - element.clientHeight) near.add(index + 1); });
      // A box with no height yet says nothing about which pages are near, so the first pages stay until it has one.
      if (element.clientHeight) setShown(previous => near.size === previous.size && [...near].every(page => previous.has(page)) ? previous : near);
      heard.current?.(element, pages);
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    return () => element.removeEventListener('scroll', update);
  }, [box, total, layout]);
  return shown;
}
function FileLine({ parts }: { parts: string[] }) { return <div className="file-line">{parts.filter(Boolean).map(part => <small key={part}>{part}</small>)}</div>; }

/** The opened File block: every page of a PDF in one scroll with zoom (Text shows the text ros.ai read), or the
 * picture, whole, as large as the view allows. */
export function FileViewer({ file, title, text }: { file: ShownFile; title: string; text?: Artifact }) {
  if (isVideoType(file.mediaType)) return <VideoViewer file={file} title={title}/>;
  if (!isPdfType(file.mediaType)) return <PictureViewer file={file} title={title}/>;
  return <PdfViewer file={file} title={title} text={text}/>;
}
/** The opened video: as large as the view allows in its own shape, its first frame until it plays, with the player's
 * own controls. A video playing on its card carries on here from the same moment. */
function VideoViewer({ file, title }: { file: ShownFile; title: string }) {
  const video = useRef<HTMLVideoElement>(null), [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const element = video.current, card = playingCard;
    if (!element || !card || card.src !== file.src || card.video.paused) return;
    const at = card.video.currentTime;
    card.video.pause();
    const start = () => { element.currentTime = at; void element.play().catch(() => undefined); };
    if (element.readyState >= 1) start(); else element.addEventListener('loadedmetadata', start, { once: true });
    return () => element.removeEventListener('loadedmetadata', start);
  }, [file.src]);
  return <div className="file-viewer picture video fit">
    <div className="picture-stage">
      {failed === file.src ? <p className="file-preview-note video-failed"><VideoOff size={16} strokeWidth={1.5}/> This video’s format does not play in ros.ai. Open in plays it in another app.</p>
        : <video ref={video} src={posterFrame(file.src)} controls playsInline preload="metadata" aria-label={title} onError={() => setFailed(file.src)}/>}
    </div>
  </div>;
}
/** The opened picture: fitted whole to the view and never larger than its own pixels; the zoom at the corner, or a
 * click on the picture, shows it at its own size and scrolls, and Fit brings the whole picture back. */
function PictureViewer({ file, title }: { file: ShownFile; title: string }) {
  const scroll = useRef<HTMLDivElement>(null), box = useBox(scroll);
  const [loaded, setLoaded] = useState<{ src: string; size: ImageSize } | null>(null);
  const natural = loaded?.src === file.src ? loaded.size : file.image;
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  // The share of the picture's own size that fits it whole in the stage, never above its own size.
  const fit = natural && box.width > 0 && box.height > 0 ? Math.min(1, box.width / natural.width, box.height / natural.height) * 100 : 100;
  const current = zoom === 'fit' ? fit : zoom;
  const zoomIn = () => setZoom(PICTURE_ZOOMS.find(step => step > current + 0.5) ?? PICTURE_ZOOMS[PICTURE_ZOOMS.length - 1]);
  const zoomOut = () => { const below = PICTURE_ZOOMS.filter(step => step < current - 0.5); setZoom(below.length ? below[below.length - 1] : PICTURE_ZOOMS[0]); };
  // A zoomed picture starts from its middle.
  useLayoutEffect(() => { const element = scroll.current; if (!element || zoom === 'fit') return; element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2; element.scrollTop = (element.scrollHeight - element.clientHeight) / 2; }, [zoom]);
  const canGrow = natural ? fit < 99.5 : false;
  return <div className={`file-viewer picture${zoom === 'fit' ? ' fit' : ' zoomed'}`}>
    <div className="picture-stage">
      <div ref={scroll} className="picture-scroll"><img src={file.src} alt={title} draggable={false} style={zoom === 'fit' ? (natural ? { maxWidth: natural.width, maxHeight: natural.height } : undefined) : { width: natural ? Math.round(natural.width * zoom / 100) : undefined }}
        onLoad={event => setLoaded({ src: file.src, size: { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight } })}
        onClick={() => { if (zoom !== 'fit') setZoom('fit'); else if (canGrow) setZoom(100); }} title={zoom === 'fit' ? (canGrow ? 'Show at its own size' : undefined) : 'Fit the whole picture'}/></div>
      <span className="picture-zoom" role="group" aria-label="Zoom">
        <button type="button" className="icon-button" aria-label="Zoom out" disabled={current <= PICTURE_ZOOMS[0] + 0.5} onClick={zoomOut}><Minus size={13}/></button>
        <button type="button" className="picture-zoom-level" aria-label={zoom === 'fit' ? 'Fitted to the view' : 'Fit the whole picture'} disabled={zoom === 'fit'} onClick={() => setZoom('fit')}>{zoom === 'fit' ? 'Fit' : `${zoom}%`}</button>
        <button type="button" className="icon-button" aria-label="Zoom in" disabled={current >= PICTURE_ZOOMS[PICTURE_ZOOMS.length - 1] - 0.5} onClick={zoomIn}><Plus size={13}/></button>
      </span>
    </div>
  </div>;
}
/** The inner size of an element, followed as it resizes. */
function useBox(box: RefObject<HTMLElement | null>): ImageSize {
  const [size, setSize] = useState<ImageSize>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const update = () => setSize(current => { const next = { width: Math.floor(element.clientWidth), height: Math.floor(element.clientHeight) }; return next.width === current.width && next.height === current.height ? current : next; });
    const observer = new ResizeObserver(update); observer.observe(element); update();
    return () => observer.disconnect();
  }, [box]);
  return size;
}
/** The opened PDF: every page in one scroll, with zoom; Text shows the text ros.ai read. */
function PdfViewer({ file, title, text }: { file: ShownFile; title: string; text?: Artifact }) {
  const [zoom, setZoom] = useState(100), [mode, setMode] = useState<'pages' | 'text'>('pages'), [place, setPlace] = useState({ page: 1, total: 0 });
  const pdf = isPdfType(file.mediaType);
  const step = (direction: 1 | -1) => setZoom(current => { const index = ZOOMS.indexOf(current); return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (index < 0 ? ZOOMS.indexOf(100) : index) + direction))]; });
  const name = title.replace(/[\\/:]+/gu, '-');
  return <div className="file-viewer">
    <div className="file-toolbar">
      {pdf && mode === 'pages' && place.total > 0 && <span className="file-page-counter">Page {place.page} of {place.total}</span>}
      <span className="file-toolbar-space"/>
      {mode === 'pages' && <span className="file-zoom"><button type="button" className="icon-button" aria-label="Zoom out" disabled={zoom <= ZOOMS[0]} onClick={() => step(-1)}><Minus size={14}/></button><span>{zoom}%</span><button type="button" className="icon-button" aria-label="Zoom in" disabled={zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => step(1)}><Plus size={14}/></button></span>}
      {pdf && text && <span className="file-modes" role="group" aria-label="Show"><button type="button" className={mode === 'pages' ? 'active' : ''} aria-pressed={mode === 'pages'} onClick={() => setMode('pages')}>Pages</button><button type="button" className={mode === 'text' ? 'active' : ''} aria-pressed={mode === 'text'} onClick={() => setMode('text')}>Text</button></span>}
      <a className="secondary small file-download" href={file.src} download={name} title="Save a copy"><Download size={13}/> Download</a>
    </div>
    {mode === 'text' && text ? <pre className="file-text" tabIndex={0}>{text.content}</pre>
      : <PdfPages src={file.src} zoom={zoom} onPlace={(page, total) => setPlace(current => current.page === page && current.total === total ? current : { page, total })}/>}
  </div>;
}
/** Every page in one scroll. Pages near the view are drawn; `onPlace` reports the page under the middle of the view. */
function PdfPages({ src, zoom, onPlace }: { src: string; zoom: number; onPlace: (page: number, total: number) => void }) {
  const box = useRef<HTMLDivElement>(null), width = useWidth(box), { doc, error } = usePdf(src);
  const place = useRef(onPlace); place.current = onPlace;
  const sizes = usePageSizes(doc);
  const pageWidth = Math.max(120, Math.floor((width - 32) * zoom / 100));
  const shown = useNearPages(box, sizes.length, pageWidth, (element, pages) => {
    const middle = element.scrollTop + element.clientHeight / 2;
    let current = 1;
    pages.forEach((page, index) => { if (page.offsetTop <= middle) current = index + 1; });
    if (doc) place.current(current, doc.numPages);
  });
  return <div ref={box} className="file-viewport pdf-pages">
    {error ? <p className="file-preview-note">{error}</p> : !doc || !sizes.length ? <p className="file-preview-note"><LoaderCircle size={14} className="spin"/> Opening…</p>
      : sizes.map((size, index) => <div key={index} className="pdf-page-box" style={{ width: pageWidth, height: Math.floor(pageWidth * size.height / size.width) }}>{shown.has(index + 1) && <PdfPage doc={doc} number={index + 1} width={pageWidth} text/>}</div>)}
  </div>;
}
