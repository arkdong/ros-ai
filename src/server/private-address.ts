import { isIP } from 'node:net';

/** An address on this computer or its network, or one that is not routed on the internet at all: links that come from
 * other people (a paper's PDF, a web page an agent's browser opens) are fetched only from the public internet.
 * IPv6 forms that carry an IPv4 address (mapped, compatible, NAT64, 6to4) are judged by that IPv4 address. */
export function privateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return privateIPv4(address.split('.').map(Number));
  if (version !== 6) return true;
  const groups = ipv6Groups(address);
  if (!groups) return true;
  const zeros = (count: number) => groups.slice(0, count).every(group => group === 0);
  const embedded = (high: number, low: number) => privateIPv4([high >> 8, high & 255, low >> 8, low & 255]);
  if (zeros(6)) return embedded(groups[6], groups[7]);
  if (zeros(5) && groups[5] === 0xffff) return embedded(groups[6], groups[7]);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(group => group === 0)) return embedded(groups[6], groups[7]);
  if (groups[0] === 0x2002) return embedded(groups[1], groups[2]);
  const first = groups[0];
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00
    || (first === 0x2001 && groups[1] === 0x0db8) || (first === 0x0100 && groups.slice(1, 4).every(group => group === 0));
}

function privateIPv4([a, b, c]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113);
}

/** The eight 16-bit groups of an IPv6 address, with :: expanded and a trailing dotted IPv4 part read as two groups. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().replace(/%.*$/u, '');
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parts = (half: string) => half ? half.split(':').map(group => /^[0-9a-f]{1,4}$/u.test(group) ? parseInt(group, 16) : NaN) : [];
  const left = parts(halves[0]), right = halves.length === 2 ? parts(halves[1]) : [];
  const groups = halves.length === 2 ? [...left, ...Array<number>(Math.max(0, 8 - left.length - right.length)).fill(0), ...right] : left;
  return groups.length === 8 && groups.every(group => Number.isInteger(group)) ? groups : null;
}
