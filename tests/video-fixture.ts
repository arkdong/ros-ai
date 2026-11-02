/** A small MP4 written by hand: a 'ftyp', a 'mdat' of zeros and a 'moov' with one video track, so tests need no encoder. */
export function movie({ width, height, seconds, rotate = false, version1 = false, moovFirst = false, mdat = 4096 }: { width: number; height: number; seconds: number; rotate?: boolean; version1?: boolean; moovFirst?: boolean; mdat?: number }): Buffer {
  const box = (type: string, ...parts: Buffer[]) => { const body = Buffer.concat(parts), head = Buffer.alloc(8); head.writeUInt32BE(body.length + 8); head.write(type, 4, 'latin1'); return Buffer.concat([head, body]); };
  const u32 = (value: number) => { const out = Buffer.alloc(4); out.writeUInt32BE(value >>> 0); return out; };
  const i32 = (value: number) => { const out = Buffer.alloc(4); out.writeInt32BE(value); return out; };
  const u64 = (value: number) => { const out = Buffer.alloc(8); out.writeBigUInt64BE(BigInt(value)); return out; };
  const scale = 1000;
  const mvhd = version1 ? box('mvhd', Buffer.from([1, 0, 0, 0]), u64(0), u64(0), u32(scale), u64(Math.round(seconds * scale)), Buffer.alloc(80)) : box('mvhd', Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(scale), u32(Math.round(seconds * scale)), Buffer.alloc(80));
  const one = 0x10000, matrix = Buffer.concat((rotate ? [0, one, 0, -one, 0, 0, 0, 0, 0x40000000] : [one, 0, 0, 0, one, 0, 0, 0, 0x40000000]).map(i32));
  const tkhd = version1 ? box('tkhd', Buffer.from([1, 0, 0, 3]), u64(0), u64(0), u32(1), u32(0), u64(0), Buffer.alloc(16), matrix, u32(width * one), u32(height * one))
    : box('tkhd', Buffer.from([0, 0, 0, 3]), u32(0), u32(0), u32(1), u32(0), u32(0), Buffer.alloc(16), matrix, u32(width * one), u32(height * one));
  const sound = box('trak', box('tkhd', Buffer.alloc(84)), box('mdia', box('hdlr', Buffer.alloc(8), Buffer.from('soun'), Buffer.alloc(12))));
  const picture = box('trak', tkhd, box('mdia', box('hdlr', Buffer.alloc(8), Buffer.from('vide'), Buffer.alloc(12))));
  const moov = box('moov', mvhd, sound, picture), ftyp = box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomiso2mp41')), data = box('mdat', Buffer.alloc(mdat));
  return Buffer.concat(moovFirst ? [ftyp, moov, data] : [ftyp, data, moov]);
}
