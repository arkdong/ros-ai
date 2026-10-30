import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { FILE_BYTES } from '../shared/files.js';
import { readLimited } from './papers.js';
import { privateAddress } from './private-address.js';

/** Pictures and PDFs from the web, downloaded into the project folder so a File block can show them. An agent gives a
 * File block a web address instead of a folder path: the address of an image or PDF, or of a page whose main picture
 * it wants (the picture the page names for link previews). Only the public internet is reached, every redirect is
 * checked, and nothing larger than a File block shows is read. */

/** The most web files one canvas change downloads. */
export const MAX_WEB_FILES = 12;
const TIMEOUT = 30_000, PAGE_BYTES = 3_000_000, HOPS = 5;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 ros.ai',
  Accept: 'image/webp,image/png,image/jpeg,image/gif,application/pdf;q=0.9,text/html;q=0.8,*/*;q=0.5',
};

/** A web address a File block can be given in place of a folder path. */
export const isWebAddress = (path: string) => /^https?:\/\//iu.test(path.trim());

type Kind = { extension: '.pdf' | '.png' | '.jpg' | '.webp' | '.gif'; label: string };
export function sniff(bytes: Buffer): Kind | undefined {
  if (bytes.subarray(0, 1024).indexOf('%PDF-') >= 0) return { extension: '.pdf', label: 'PDF' };
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { extension: '.png', label: 'PNG image' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { extension: '.jpg', label: 'JPEG image' };
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return { extension: '.webp', label: 'WebP image' };
  if (/^GIF8[79]a/u.test(bytes.subarray(0, 6).toString('latin1'))) return { extension: '.gif', label: 'GIF image' };
  return undefined;
}
/** What a file that is not a PDF or a shown image is, for the agent's message. */
function otherKind(bytes: Buffer, type: string | null): string {
  const start = bytes.subarray(0, 512).toString('latin1');
  if (/^....ftypavi[fs]/su.test(start) || type === 'image/avif') return 'an AVIF image, which a File block cannot show';
  if (/<svg[\s>]/iu.test(start) || type === 'image/svg+xml') return 'an SVG drawing, which a File block cannot show';
  return `${type ? `a ${type.split(';')[0]} file` : 'a file'}, not a PDF or a PNG, JPEG, WebP or GIF image`;
}

const DECODE: Record<string, string> = { amp: '&', quot: '"', apos: '\'', lt: '<', gt: '>', '#39': '\'', '#x27': '\'', '#x2F': '/', '#47': '/' };
const decode = (text: string) => text.replace(/&(amp|quot|apos|lt|gt|#39|#x27|#x2F|#47);/giu, (all, name: string) => DECODE[name] ?? DECODE[name.toLowerCase()] ?? all);
/** The picture a web page names for link previews (Open Graph, Twitter cards, image_src), as an absolute address. */
export function pagePicture(html: string, base: URL): string | undefined {
  const tags = html.slice(0, PAGE_BYTES).match(/<(?:meta|link)\b[^>]*>/giu) ?? [];
  const attr = (tag: string, name: string) => { const found = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'iu')); return found ? decode(found[1] ?? found[2] ?? found[3] ?? '').trim() : undefined; };
  const wanted = ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'];
  const named = new Map<string, string>();
  for (const tag of tags) {
    if (/^<link/iu.test(tag)) { if (attr(tag, 'rel')?.toLowerCase() === 'image_src' && attr(tag, 'href')) named.set('image_src', attr(tag, 'href')!); continue; }
    const key = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase(), content = attr(tag, 'content');
    if (content && wanted.includes(key) && !named.has(key)) named.set(key, content);
  }
  for (const key of [...wanted, 'image_src']) {
    const value = named.get(key);
    if (!value) continue;
    try { const url = new URL(value, base); if (url.protocol === 'https:' || url.protocol === 'http:') return url.href; } catch { /* the next one */ }
  }
  return undefined;
}

/** A web file ready to save: its bytes, kind, the address it came from and the page that named it, if any. */
export type WebFile = { bytes: Buffer; extension: Kind['extension']; label: string; image: string; page?: string; name: string };
type Options = { fetcher?: typeof fetch; lookup?: (host: string) => Promise<{ address: string }[]> };

export class WebFileFetcher {
  private readonly fetcher: typeof fetch;
  private readonly lookup: (host: string) => Promise<{ address: string }[]>;
  constructor(options: Options = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.lookup = options.lookup ?? (host => dnsLookup(host, { all: true }));
  }
  /** Downloads an image or PDF; for a web page, the picture it names for link previews. Throws with a short reason. */
  async file(address: string, signal?: AbortSignal): Promise<WebFile> {
    let got = await this.get(address.trim(), signal), page: string | undefined;
    const html = /html/iu.test(got.type ?? '') || /^\s*(<!doctype html|<html|<head)/iu.test(got.bytes.subarray(0, 512).toString('latin1'));
    if (!sniff(got.bytes) && html) {
      const picture = pagePicture(got.bytes.toString('utf8'), got.url);
      if (!picture) throw new Error('it is a web page that names no main picture; give the address of the image itself');
      page = got.url.href;
      got = await this.get(picture, signal);
    }
    const kind = sniff(got.bytes);
    if (!kind) throw new Error(`it is ${otherKind(got.bytes, got.type)}`);
    let name = 'file';
    try { name = decodeURIComponent(got.url.pathname.split('/').filter(Boolean).at(-1) ?? 'file').slice(0, 160); } catch { /* keep file */ }
    return { bytes: got.bytes, extension: kind.extension, label: kind.label, image: got.url.href, ...(page ? { page } : {}), name };
  }
  /** One address, following redirects by hand so every hop is checked. A page is read up to PAGE_BYTES, a file up to
   * the most a File block shows. */
  private async get(href: string, signal?: AbortSignal): Promise<{ bytes: Buffer; type: string | null; url: URL }> {
    let current = href;
    for (let hop = 0; hop <= HOPS; hop++) {
      let url: URL;
      try { url = new URL(current); } catch { throw new Error('it is not a web address'); }
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) throw new Error('only public http and https addresses can be downloaded');
      const host = url.hostname.replace(/^\[|\]$/gu, '');
      const addresses = isIP(host) ? [host] : (await this.lookup(host).catch(() => [])).map(item => item.address);
      if (!addresses.length) throw new Error(`${host} could not be found`);
      if (addresses.some(privateAddress)) throw new Error('it is not on the public internet');
      const response = await this.fetcher(url.href, { redirect: 'manual', headers: HEADERS, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (!location) throw new Error('a redirect without an address');
        current = new URL(location, url).href;
        continue;
      }
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(response.status === 403 || response.status === 401 ? `the site refused the download (HTTP ${response.status})` : `HTTP ${response.status}`); }
      const type = response.headers.get('content-type'), page = /html/iu.test(type ?? '');
      try { return { bytes: await readLimited(response, page ? PAGE_BYTES : FILE_BYTES), type, url }; }
      catch (error) { throw error instanceof Error && /larger/u.test(error.message) ? new Error(page ? 'the page is too large to read' : `it is larger than ${FILE_BYTES / 1_000_000} MB, the most a File block shows`) : error; }
    }
    throw new Error('too many redirects');
  }
}
