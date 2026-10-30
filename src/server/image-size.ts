import type { ImageSize } from '../shared/files.js';

/** How much of an image file is read to learn its size: the headers of PNG, GIF and WebP files come first; a JPEG's
 * size follows its EXIF and colour profile segments, which this much covers for all but unusual files. */
export const IMAGE_HEAD_BYTES = 256 * 1024;

/** The pixel size of a PNG, JPEG, GIF or WebP from its first bytes, as a browser shows it: a JPEG or WebP whose EXIF
 * data turns it on its side is given its upright size. Undefined when the bytes are not one of these or are cut short. */
export function imageSize(bytes: Uint8Array): ImageSize | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) return upright(view.getUint32(16), view.getUint32(20));
  if (bytes.length >= 10 && ascii(bytes, 0, 3) === 'GIF') return upright(view.getUint16(6, true), view.getUint16(8, true));
  if (bytes.length >= 4 && view.getUint16(0) === 0xffd8) return jpeg(bytes, view);
  if (bytes.length >= 20 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return webp(bytes, view);
  return undefined;
}
const ascii = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
const upright = (width: number, height: number, orientation = 1): ImageSize | undefined =>
  width > 0 && height > 0 ? orientation >= 5 ? { width: height, height: width } : { width, height } : undefined;

/** A JPEG: its segments in turn until the frame header (SOF) gives the size; an APP1 Exif segment before it may give the orientation. */
function jpeg(bytes: Uint8Array, view: DataView): ImageSize | undefined {
  let at = 2, orientation = 1;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1];
    if (marker === 0xff) { at++; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = view.getUint16(at + 2);
    if (length < 2) return undefined;
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (frame) return at + 9 <= bytes.length ? upright(view.getUint16(at + 7), view.getUint16(at + 5), orientation) : undefined;
    if (marker === 0xe1 && at + 10 <= bytes.length && ascii(bytes, at + 4, 6) === 'Exif\0\0') orientation = exifOrientation(bytes, at + 10, Math.min(bytes.length, at + 2 + length)) ?? orientation;
    at += 2 + length;
  }
  return undefined;
}
/** The Orientation tag (0x0112) of a TIFF header, as EXIF carries it; undefined when the tag is absent or the bytes are cut short. */
function exifOrientation(bytes: Uint8Array, start: number, end: number): number | undefined {
  if (start + 8 > end) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), order = ascii(bytes, start, 2);
  if (order !== 'II' && order !== 'MM') return undefined;
  const little = order === 'II';
  if (view.getUint16(start + 2, little) !== 0x2a) return undefined;
  const directory = start + view.getUint32(start + 4, little);
  if (directory + 2 > end) return undefined;
  const entries = view.getUint16(directory, little);
  for (let index = 0; index < entries; index++) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > end) return undefined;
    if (view.getUint16(entry, little) !== 0x0112) continue;
    const value = view.getUint16(entry + 8, little);
    return value >= 1 && value <= 8 ? value : undefined;
  }
  return undefined;
}
/** A WebP: a lossy, lossless or extended header gives the size; an extended file's EXIF chunk may give the orientation. */
function webp(bytes: Uint8Array, view: DataView): ImageSize | undefined {
  const chunk = ascii(bytes, 12, 4), length = view.getUint32(16, true), payload = 20;
  if (chunk === 'VP8 ') return payload + 10 <= bytes.length && bytes[payload + 3] === 0x9d && bytes[payload + 4] === 0x01 && bytes[payload + 5] === 0x2a ? upright(view.getUint16(payload + 6, true) & 0x3fff, view.getUint16(payload + 8, true) & 0x3fff) : undefined;
  if (chunk === 'VP8L') { if (payload + 5 > bytes.length || bytes[payload] !== 0x2f) return undefined; const bits = view.getUint32(payload + 1, true); return upright((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1); }
  if (chunk !== 'VP8X' || payload + 10 > bytes.length) return undefined;
  const width = 1 + (bytes[payload + 4] | bytes[payload + 5] << 8 | bytes[payload + 6] << 16), height = 1 + (bytes[payload + 7] | bytes[payload + 8] << 8 | bytes[payload + 9] << 16);
  let orientation = 1;
  if (bytes[payload] & 0x08) {
    // The EXIF chunk comes after the image data; each chunk is padded to an even length.
    for (let at = payload + length + (length & 1); at + 8 <= bytes.length;) {
      const name = ascii(bytes, at, 4), size = view.getUint32(at + 4, true);
      if (name === 'EXIF') { const start = at + 8, end = Math.min(bytes.length, start + size); orientation = exifOrientation(bytes, ascii(bytes, start, 6) === 'Exif\0\0' ? start + 6 : start, end) ?? 1; break; }
      at += 8 + size + (size & 1);
    }
  }
  return upright(width, height, orientation);
}
