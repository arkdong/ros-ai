import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Download, LoaderCircle, Minus, Plus } from 'lucide-react';
import type { Artifact } from '../shared/types';
import { fileSize, isPdfType } from '../shared/files';
import './file-view.css';

type PdfModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfDocument = import('pdfjs-dist/legacy/build/pdf.mjs').PDFDocumentProxy;
type RenderTask = import('pdfjs-dist/legacy/build/pdf.mjs').RenderTask;
/** The file a block shows: its address (which changes with the file's version), type and size. */
export type ShownFile = { src: string; mediaType: string; bytes?: number };
const PREVIEW_HEIGHT = 172, OPEN_DOCUMENTS = 12, ZOOMS = [50, 75, 100, 125, 150, 200, 300];
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

/** One page drawn at a CSS size, sharp on high-density screens. `fit` bounds the page's box; `width` sets it. */
function PdfPage({ doc, number, width, fit, onRendered }: { doc: PdfDocument; number: number; width?: number; fit?: { width: number; height: number }; onRendered?: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const rendered = useRef(onRendered); rendered.current = onRendered;
  useEffect(() => {
    let live = true, task: RenderTask | undefined;
    void doc.getPage(number).then(page => {
      const element = canvas.current;
      if (!live || !element) return;
      const base = page.getViewport({ scale: 1 }), ratio = window.devicePixelRatio || 1;
      const scale = fit ? Math.min(fit.width / base.width, fit.height / base.height) : (width ?? base.width) / base.width;
      if (!(scale > 0)) return;
      const viewport = page.getViewport({ scale: scale * ratio });
      element.width = Math.floor(viewport.width); element.height = Math.floor(viewport.height);
      element.style.width = `${Math.floor(viewport.width / ratio)}px`; element.style.height = `${Math.floor(viewport.height / ratio)}px`;
      task = page.render({ canvas: element, viewport });
      return task.promise.then(() => { if (live) rendered.current?.(); });
    }).catch((error: unknown) => { if (live) console.error(`Page ${number} could not be drawn`, error); });
    return () => { live = false; task?.cancel(); };
  }, [doc, number, width, fit?.width, fit?.height]);
  return <canvas ref={canvas} className="pdf-page" role="img" aria-label={`Page ${number}`}/>;
}

/** What a File block shows on its card: the first page of a PDF, or the image, with one quiet line about the file. */
export function FilePreview({ file, title }: { file: ShownFile; title: string }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  if (!isPdfType(file.mediaType)) return <>
    <img className="block-figure-preview" src={file.src} alt={title} onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}/>
    <FileLine parts={[typeName(file.mediaType), size ? `${size.width} × ${size.height}` : '', file.bytes ? fileSize(file.bytes) : '']}/>
  </>;
  return <PdfPreview file={file}/>;
}
function PdfPreview({ file }: { file: ShownFile }) {
  const box = useRef<HTMLDivElement>(null), width = useWidth(box), { doc, error } = usePdf(file.src);
  return <>
    <div ref={box} className="block-figure-preview file-page-preview">{error ? <span className="file-preview-note">{error}</span> : doc && width > 0 ? <PdfPage doc={doc} number={1} fit={{ width, height: PREVIEW_HEIGHT }}/> : <LoaderCircle size={14} className="spin"/>}</div>
    <FileLine parts={['PDF', doc ? `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}` : '', file.bytes ? fileSize(file.bytes) : '']}/>
  </>;
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
  const [sizes, setSizes] = useState<{ width: number; height: number }[]>([]);
  const [shown, setShown] = useState<Set<number>>(() => new Set([1, 2]));
  const pageWidth = Math.max(120, Math.floor((width - 32) * zoom / 100));
  // The pages' proportions set every page's box before it is drawn, so the scroll length is right from the start.
  useEffect(() => {
    if (!doc) return;
    let live = true;
    void Promise.all(Array.from({ length: doc.numPages }, (_, index) => doc.getPage(index + 1).then(page => { const view = page.getViewport({ scale: 1 }); return { width: view.width, height: view.height }; })))
      .then(all => { if (live) setSizes(all); }).catch(() => undefined);
    return () => { live = false; };
  }, [doc]);
  useEffect(() => {
    const element = box.current;
    if (!element || !doc || !sizes.length) return;
    const update = () => {
      const pages = Array.from(element.querySelectorAll<HTMLElement>('.pdf-page-box'));
      const top = element.scrollTop, middle = top + element.clientHeight / 2, near = new Set<number>();
      let current = 1;
      pages.forEach((page, index) => {
        if (page.offsetTop < top + element.clientHeight * 2 && page.offsetTop + page.offsetHeight > top - element.clientHeight) near.add(index + 1);
        if (page.offsetTop <= middle) current = index + 1;
      });
      setShown(previous => { const next = new Set([...previous, ...near]); return next.size === previous.size ? previous : next; });
      place.current(current, doc.numPages);
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    return () => element.removeEventListener('scroll', update);
  }, [doc, sizes, pageWidth]);
  return <div ref={box} className="file-viewport pdf-pages">
    {error ? <p className="file-preview-note">{error}</p> : !doc || !sizes.length ? <p className="file-preview-note"><LoaderCircle size={14} className="spin"/> Opening…</p>
      : sizes.map((size, index) => <div key={index} className="pdf-page-box" style={{ width: pageWidth, height: Math.floor(pageWidth * size.height / size.width) }}>{shown.has(index + 1) && <PdfPage doc={doc} number={index + 1} width={pageWidth}/>}</div>)}
  </div>;
}
