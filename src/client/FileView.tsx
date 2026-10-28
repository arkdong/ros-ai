import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Download, LoaderCircle, Minus, Plus } from 'lucide-react';
import type { Artifact } from '../shared/types';
import { fileSize, isPdfType } from '../shared/files';
import './file-view.css';

type PdfModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfDocument = import('pdfjs-dist/legacy/build/pdf.mjs').PDFDocumentProxy;
type RenderTask = import('pdfjs-dist/legacy/build/pdf.mjs').RenderTask;
type TextLayer = import('pdfjs-dist/legacy/build/pdf.mjs').TextLayer;
/** The file a block shows: its address (which changes with the file's version), type and size. */
export type ShownFile = { src: string; mediaType: string; bytes?: number };
const OPEN_DOCUMENTS = 12, ZOOMS = [50, 75, 100, 125, 150, 200, 300];
const typeName = (mediaType: string) => isPdfType(mediaType) ? 'PDF' : mediaType === 'image/png' ? 'PNG' : 'JPEG';

let pdfjsLoad: Promise<PdfModule> | null = null;
/** pdf.js is loaded the first time a PDF is on screen; its worker renders pages off the main thread. The legacy build
 * carries the polyfills that browsers from before 2026 need. */
function loadPdfjs(): Promise<PdfModule> {
  return pdfjsLoad ??= Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')]).then(([pdfjs, worker]) => { pdfjs.GlobalWorkerOptions.workerSrc = worker.default; return pdfjs; });
}
const documents = new Map<string, Promise<PdfDocument>>();
/** One open document per address. The address carries the file's version, so a replaced file is read again. */
function openPdf(src: string): Promise<PdfDocument> {
  const open = documents.get(src);
  if (open) return open;
  const document = loadPdfjs().then(pdfjs => pdfjs.getDocument({ url: src, disableRange: true, disableStream: true }).promise);
  documents.set(src, document);
  document.catch(() => documents.delete(src));
  if (documents.size > OPEN_DOCUMENTS) { const [oldest] = documents; documents.delete(oldest[0]); void oldest[1].then(value => value.cleanup()).catch(() => undefined); }
  return document;
}
function usePdf(src: string): { doc: PdfDocument | null; error: string } {
  const [state, setState] = useState<{ src: string; doc: PdfDocument | null; error: string }>({ src, doc: null, error: '' });
  useEffect(() => {
    let live = true;
    openPdf(src).then(doc => { if (live) setState({ src, doc, error: '' }); }, (reason: unknown) => { if (live) setState({ src, doc: null, error: reason instanceof Error ? reason.message : 'The PDF could not be read.' }); });
    return () => { live = false; };
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

/** One page drawn at a CSS width, sharp on high-density screens. The page is drawn off screen and then shown in one
 * step, so a redraw never blanks the page. A fluid page fills its box and scales while a new width is drawn. With
 * `text`, pdf.js lays the page's words over it as invisible text, so they can be selected and copied. */
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
      const viewport = page.getViewport({ scale: scale * ratio }), drawn = document.createElement('canvas');
      drawn.width = Math.floor(viewport.width); drawn.height = Math.floor(viewport.height);
      task = page.render({ canvas: drawn, viewport });
      return task.promise.then(() => {
        const element = canvas.current;
        if (!live || !element) return;
        element.width = drawn.width; element.height = drawn.height;
        element.getContext('2d')?.drawImage(drawn, 0, 0);
        if (fluid) { element.style.width = '100%'; element.style.height = 'auto'; }
        else { element.style.width = `${Math.floor(viewport.width / ratio)}px`; element.style.height = `${Math.floor(viewport.height / ratio)}px`; }
        rendered.current?.();
      });
    }).catch((error: unknown) => { if (live && !(error instanceof Error && error.name === 'RenderingCancelledException')) console.error(`Page ${number} could not be drawn`, error); });
    return () => { live = false; task?.cancel(); };
  }, [doc, number, width, fluid]);
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

/** What a File block shows on its card: a PDF's pages in one scroll, or the image, as wide as the card and cut at the
 * card's preview height, with one quiet line about the file. The card's width sets the pages'; resizing redraws them. */
export function FilePreview({ file, title }: { file: ShownFile; title: string }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  if (!isPdfType(file.mediaType)) return <>
    <img className="block-figure-preview file-image-preview" src={file.src} alt={title} onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}/>
    <FileLine parts={[typeName(file.mediaType), size ? `${size.width} × ${size.height}` : '', file.bytes ? fileSize(file.bytes) : '']}/>
  </>;
  return <PdfPreview file={file}/>;
}
/** The card's PDF: every page under the one before, scrolled with the wheel like a Notion page card (nowheel keeps the
 * wheel off the canvas). Page 1 is drawn at once and the rest as they come near the view. */
function PdfPreview({ file }: { file: ShownFile }) {
  // While the card is resized the drawn pages scale with it; they are drawn again once the width settles.
  const box = useRef<HTMLDivElement>(null), width = useSettled(useWidth(box)), { doc, error } = usePdf(file.src), sizes = usePageSizes(doc);
  const shown = useNearPages(box, sizes.length, 1);
  return <>
    <div ref={box} className="block-figure-preview file-page-preview nowheel">{error ? <span className="file-preview-note">{error}</span> : doc && width > 0 && sizes.length ? sizes.map((size, index) => <div key={index} className="pdf-page-box" style={{ aspectRatio: `${size.width} / ${size.height}` }}>{shown.has(index + 1) && <PdfPage doc={doc} number={index + 1} width={width} fluid/>}</div>) : <LoaderCircle size={14} className="spin"/>}</div>
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
/** The pages (counted from 1) that have come within a view's height or two of a scroll box; once near, a page stays drawn.
 * `onUpdate` hears the box after each check, for the page counter. */
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
      setShown(previous => { const next = new Set([...previous, ...near]); return next.size === previous.size ? previous : next; });
      heard.current?.(element, pages);
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    return () => element.removeEventListener('scroll', update);
  }, [box, total, layout]);
  return shown;
}
function FileLine({ parts }: { parts: string[] }) { return <div className="file-line">{parts.filter(Boolean).map(part => <small key={part}>{part}</small>)}</div>; }

/** The opened File block: every page of a PDF in one scroll, or the image, with zoom; Text shows the text ros.ai read. */
export function FileViewer({ file, title, text }: { file: ShownFile; title: string; text?: Artifact }) {
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
      : pdf ? <PdfPages src={file.src} zoom={zoom} onPlace={(page, total) => setPlace(current => current.page === page && current.total === total ? current : { page, total })}/>
      : <div className="file-viewport"><img src={file.src} alt={title} style={{ width: `${zoom}%`, maxWidth: 'none' }}/></div>}
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
