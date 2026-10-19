import { isIPv4, isIPv6 } from 'node:net';

/** [network, prefix length] of the IPv4 ranges a webhook can never reach. */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const v4Number = (address: string): number =>
  address.split('.').reduce((total, part) => total * 256 + Number(part), 0);

function blockedV4(address: string): boolean {
  const value = v4Number(address);
  return BLOCKED_V4.some(([network, bits]) => {
    const size = 2 ** (32 - bits);
    const start = v4Number(network);
    return value >= start && value < start + size;
  });
}

/** The eight 16-bit groups of an IPv6 address (zone ids and embedded dotted quads included). */
function groupsOf(address: string): number[] | null {
  let text = address.split('%')[0] as string;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const quad = dotted[1] as string;
    if (!isIPv4(quad)) return null;
    const value = v4Number(quad);
    text = `${text.slice(0, -quad.length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? (halves[0] as string).split(':') : [];
  const tail = halves.length === 2 && halves[1] ? (halves[1] as string).split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const groups = all.map((group) => parseInt(group, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

const quad = (high: number, low: number): string =>
  `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

/**
 * Whether the address is anything but a public unicast one: loopback, private, link-local, CGNAT,
 * multicast, documentation, metadata and the IPv6 forms that carry an IPv4 address (mapped,
 * compatible, NAT64, 6to4), which are judged by the IPv4 they carry. Unparseable text is blocked.
 */
export function isBlockedAddress(address: string): boolean {
  if (isIPv4(address)) return blockedV4(address);
  if (!isIPv6(address)) return true;
  const g = groupsOf(address);
  if (g === null) return true;
  const [a, b, c, d, e, f, h, i] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible), which includes :: and ::1.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0))
    return f === 0 && h === 0 && i <= 1 ? true : blockedV4(quad(h, i));
  // 64:ff9b::/96 (NAT64) and 2002::/16 (6to4) embed an IPv4 address.
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0)
    return blockedV4(quad(h, i));
  if (a === 0x2002) return blockedV4(quad(b, c));
  // Only global unicast 2000::/3 is allowed, minus Teredo and documentation space.
  if ((a & 0xe000) !== 0x2000) return true;
  if (a === 0x2001 && (b === 0 || b === 0xdb8 || (b & 0xfff0) === 0x10)) return true;
  return false;
}
