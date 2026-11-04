import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { pipeline, Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { privateAddress } from './private-address.js';

export type AddressLookup = (host: string, callback: (error: Error | null, addresses: LookupAddress[]) => void) => void;
const systemLookup: AddressLookup = (host, callback) => dnsLookup(host, { all: true }, (error, addresses) => callback(error, addresses ?? []));
const DECODERS: Record<string, () => NodeJS.ReadWriteStream> = { gzip: createGunzip, 'x-gzip': createGunzip, deflate: createInflate, br: createBrotliDecompress };

/** fetch for the public internet only. A check that looks a name up and then lets fetch look it up again can be fooled
 * by a name that answers with a public address first and a private one a moment later (DNS rebinding). Here the
 * address is checked as the connection is made, from the very lookup the connection uses, so what was checked is what
 * is reached. Redirects come back as they are, for the caller to check each hop; the request carries no body. */
export function publicFetch(options: { lookup?: AddressLookup; isPublic?: (address: string) => boolean } = {}): typeof fetch {
  const lookup = options.lookup ?? systemLookup, isPublic = options.isPublic ?? (address => !privateAddress(address));
  const notPublic = (host: string) => Object.assign(new Error(`${host} is not on the public internet`), { code: 'ENOTPUBLIC' });
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('Only http and https addresses can be fetched.');
    const host = url.hostname.replace(/^\[|\]$/gu, '');
    // An address written as numbers is connected to without a lookup.
    if (isIP(host) && !isPublic(host)) throw notPublic(host);
    const checked = (hostname: string, settings: { all?: boolean }, callback: (...args: unknown[]) => void) => lookup(hostname, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses.length || addresses.some(item => !isPublic(item.address))) return callback(notPublic(hostname));
      if (settings.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
    const headers = Object.fromEntries(new Headers(init.headers));
    headers['accept-encoding'] ??= 'gzip, deflate, br';
    return new Promise<Response>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: init.method ?? 'GET', headers, agent: false, lookup: checked as never, ...(init.signal ? { signal: init.signal } : {}),
      }, (response: IncomingMessage) => {
        try {
          const status = response.statusCode ?? 502, encoding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase();
          const answer = new Headers();
          for (const [name, value] of Object.entries(response.headers)) for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) answer.append(name, item);
          if (status === 204 || status === 304 || init.method === 'HEAD') { response.resume(); return resolve(new Response(null, { status, headers: answer })); }
          const decoder = DECODERS[encoding]?.();
          const body = decoder ? pipeline(response, decoder, () => undefined) as unknown as Readable : response;
          resolve(new Response(Readable.toWeb(body) as unknown as ReadableStream, { status, headers: answer }));
        } catch (error) { response.destroy(); reject(error); }
      });
      request.on('error', reject);
      request.end();
    });
  }) as typeof fetch;
}
