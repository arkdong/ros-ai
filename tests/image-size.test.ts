import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageSize } from '../src/server/image-size.js';

/** A TIFF header holding one EXIF Orientation tag, as cameras write it, in little- or big-endian order. */
function exif(orientation: number, little = true): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write(little ? 'II' : 'MM', 0, 'ascii');
  const u16 = (value: number, at: number) => little ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at);
  const u32 = (value: number, at: number) => little ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at);
  u16(0x2a, 2); u32(8, 4); u16(1, 8); u16(0x0112, 10); u16(3, 12); u32(1, 14); u16(orientation, 18); u32(0, 22);
  return tiff;
}
const segment = (marker: number, body: Buffer) => { const head = Buffer.alloc(4); head[0] = 0xff; head[1] = marker; head.writeUInt16BE(body.length + 2, 2); return Buffer.concat([head, body]); };
/** A JPEG's start: SOI, a JFIF segment, an EXIF segment when an orientation is given, and the frame header with the size. */
function jpeg(width: number, height: number, orientation?: number): Buffer {
  const frame = Buffer.alloc(15); frame[0] = 8; frame.writeUInt16BE(height, 1); frame.writeUInt16BE(width, 3); frame[5] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    ...(orientation ? [segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exif(orientation, false)]))] : []), segment(0xc0, frame), Buffer.from([0xff, 0xda, 0, 2])]);
}
const png = (width: number, height: number) => { const bytes = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(bytes); bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return bytes; };
const gif = (width: number, height: number) => { const bytes = Buffer.alloc(13); bytes.write('GIF89a', 0, 'ascii'); bytes.writeUInt16LE(width, 6); bytes.writeUInt16LE(height, 8); return bytes; };
const riff = (chunks: Buffer[]) => { const body = Buffer.concat(chunks), head = Buffer.alloc(12); head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'ascii'); return Buffer.concat([head, body]); };
const chunk = (name: string, body: Buffer) => { const head = Buffer.alloc(8); head.write(name, 0, 'ascii'); head.writeUInt32LE(body.length, 4); return Buffer.concat([head, body, ...(body.length & 1 ? [Buffer.alloc(1)] : [])]); };
const webpLossless = (width: number, height: number) => { const body = Buffer.alloc(5); body[0] = 0x2f; body.writeUInt32LE((width - 1) | (height - 1) << 14, 1); return riff([chunk('VP8L', body)]); };
const webpLossy = (width: number, height: number) => { const body = Buffer.alloc(10); body[3] = 0x9d; body[4] = 0x01; body[5] = 0x2a; body.writeUInt16LE(width, 6); body.writeUInt16LE(height, 8); return riff([chunk('VP8 ', body)]); };
const webpExtended = (width: number, height: number, orientation?: number) => {
  const body = Buffer.alloc(10); body[0] = orientation ? 0x08 : 0; body.writeUIntLE(width - 1, 4, 3); body.writeUIntLE(height - 1, 7, 3);
  return riff([chunk('VP8X', body), chunk('VP8 ', Buffer.alloc(11)), ...(orientation ? [chunk('EXIF', exif(orientation))] : [])]);
};

test('imageSize reads the pixel size of PNG, GIF, JPEG and WebP files from their first bytes', () => {
  assert.deepEqual(imageSize(png(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(imageSize(gif(320, 200)), { width: 320, height: 200 });
  assert.deepEqual(imageSize(jpeg(1200, 900)), { width: 1200, height: 900 });
  assert.deepEqual(imageSize(webpLossless(300, 200)), { width: 300, height: 200 });
  assert.deepEqual(imageSize(webpLossy(900, 1200)), { width: 900, height: 1200 });
  assert.deepEqual(imageSize(webpExtended(1600, 1000)), { width: 1600, height: 1000 });
});

test('imageSize gives the upright size of a photo whose EXIF orientation turns it on its side', () => {
  assert.deepEqual(imageSize(jpeg(1200, 900, 6)), { width: 900, height: 1200 });
  assert.deepEqual(imageSize(jpeg(1200, 900, 8)), { width: 900, height: 1200 });
  assert.deepEqual(imageSize(jpeg(1200, 900, 3)), { width: 1200, height: 900 }, 'turned upside down keeps its size');
  assert.deepEqual(imageSize(webpExtended(1600, 1000, 6)), { width: 1000, height: 1600 });
});

test('imageSize is undefined for files that are not pictures or are cut short', () => {
  assert.equal(imageSize(Buffer.from('%PDF-1.4 not a picture at all, just text')), undefined);
  assert.equal(imageSize(png(640, 480).subarray(0, 20)), undefined);
  assert.equal(imageSize(jpeg(1200, 900).subarray(0, 12)), undefined);
  assert.equal(imageSize(Buffer.alloc(0)), undefined);
  assert.equal(imageSize(png(0, 480)), undefined, 'a zero width is no size');
});
