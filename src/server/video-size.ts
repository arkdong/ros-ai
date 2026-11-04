import type { ImageSize } from '../shared/files.js';

/** A video's picture size as a player shows it (turned upright when the file asks for a rotation) and its length. */
export type VideoInfo = ImageSize & { seconds?: number };
/** Reads `length` bytes at `position`; fewer come back at the end of the file. */
export type ReadAt = (position: number, length: number) => Uint8Array;

/** The movie header ('moov') of a long recording can hold several megabytes of tables; one larger than this is not read. */
const MOOV_BYTES = 32 * 1024 * 1024;
const ascii = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));

/** The size and length of an MP4 or MOV, read from its 'moov' box. Only box headers are read on the way, so a large
 * 'mdat' (the video itself) before or after it is skipped, never read. Undefined when no video track is found. */
export function videoInfo(read: ReadAt, fileSize: number): VideoInfo | undefined {
  let at = 0;
  for (let boxes = 0; at + 8 <= fileSize && boxes < 1000; boxes++) {
    const head = read(at, 16);
    if (head.length < 8) return undefined;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength), type = ascii(head, 4, 4);
    let size = view.getUint32(0), header = 8;
    if (size === 1) { if (head.length < 16) return undefined; size = Number(view.getBigUint64(8)); header = 16; }
    else if (size === 0) size = fileSize - at;
    if (size < header) return undefined;
    if (type === 'moov') {
      if (size > MOOV_BYTES) return undefined;
      const moov = read(at + header, size - header);
      return moov.length === size - header ? fromMoov(moov) : undefined;
    }
    at += size;
  }
  return undefined;
}

/** The boxes directly inside `bytes`, as [type, body]. */
function* boxes(bytes: Uint8Array): Generator<[string, Uint8Array]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at + 8 <= bytes.length) {
    let size = view.getUint32(at), header = 8;
    if (size === 1) { if (at + 16 > bytes.length) return; size = Number(view.getBigUint64(at + 8)); header = 16; }
    else if (size === 0) size = bytes.length - at;
    if (size < header || at + size > bytes.length) return;
    yield [ascii(bytes, at + 4, 4), bytes.subarray(at + header, at + size)];
    at += size;
  }
}
const child = (bytes: Uint8Array, type: string) => { for (const [name, body] of boxes(bytes)) if (name === type) return body; return undefined; };
const dataView = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function fromMoov(moov: Uint8Array): VideoInfo | undefined {
  let seconds: number | undefined;
  const mvhd = child(moov, 'mvhd');
  if (mvhd && mvhd.length >= 32) {
    const view = dataView(mvhd), v1 = mvhd[0] === 1;
    const scale = view.getUint32(v1 ? 20 : 12), length = v1 ? Number(view.getBigUint64(24)) : view.getUint32(16);
    if (scale > 0 && length > 0 && length !== 0xffffffff) seconds = length / scale;
  }
  for (const [name, trak] of boxes(moov)) {
    if (name !== 'trak') continue;
    const hdlr = child(child(trak, 'mdia') ?? new Uint8Array(), 'hdlr');
    if (!hdlr || hdlr.length < 12 || ascii(hdlr, 8, 4) !== 'vide') continue;
    const tkhd = child(trak, 'tkhd');
    if (!tkhd) continue;
    const v1 = tkhd[0] === 1, matrix = v1 ? 52 : 40, sizeAt = matrix + 36;
    if (tkhd.length < sizeAt + 8) continue;
    const view = dataView(tkhd);
    // Width and height are 16.16 fixed point; the matrix's first two values say whether the picture is turned on its side.
    const width = Math.round(view.getUint32(sizeAt) / 65536), height = Math.round(view.getUint32(sizeAt + 4) / 65536);
    const a = view.getInt32(matrix), b = view.getInt32(matrix + 4), sideways = a === 0 && b !== 0;
    if (!(width > 0 && height > 0)) continue;
    return { ...(sideways ? { width: height, height: width } : { width, height }), ...(seconds !== undefined ? { seconds: Math.round(seconds * 100) / 100 } : {}) };
  }
  return undefined;
}
