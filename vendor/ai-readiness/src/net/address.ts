import { isIPv4, isIPv6 } from 'node:net';

/**
 * Which IP addresses a crawler may connect to (the network guard).
 *
 * The rule is an allow-list, not a block-list: an IPv4 address is allowed only when it is in
 * none of the special-purpose ranges of the IANA registry, and an IPv6 address only when it is
 * global unicast (`2000::/3`) outside the special-purpose blocks inside that range. Anything
 * this module cannot parse as a canonical IPv4 dotted quad or an IPv6 address is refused, so a
 * resolver answer in an odd form (`0177.0.0.1`, `2130706433`) fails closed.
 *
 * IPv6 forms that carry an IPv4 address (IPv4-mapped `::ffff:a.b.c.d`, IPv4-compatible
 * `::a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, Teredo `2001::/32`) are refused outright:
 * a site does not need them to be crawled, and each is a way to reach an internal IPv4 address.
 */

export type AddressRefusal =
  | 'invalid'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'shared'
  | 'reserved'
  | 'documentation'
  | 'multicast'
  | 'broadcast'
  | 'ipv4_embedded'
  | 'not_global'
  | 'cloud_metadata';

export type AddressClass =
  | { readonly allowed: true; readonly family: 4 | 6 }
  | { readonly allowed: false; readonly reason: AddressRefusal };

interface Range4 {
  readonly base: number;
  readonly bits: number;
  readonly reason: AddressRefusal;
}

// IANA IPv4 Special-Purpose Address Registry, plus multicast and the reserved class E, plus
// cloud platform addresses that sit in public space.
//
// Cloud metadata services: AWS, GCP, Azure IMDS, DigitalOcean, OpenStack use 169.254.169.254
// (link-local, below); Oracle 192.0.0.192 (192.0.0.0/24, below); Alibaba 100.100.100.200
// (shared 100.64.0.0/10, below); AWS IPv6 fd00:ec2::254 (ULA, refused in classify6). Names
// such as `metadata.google.internal` or `metadata.azure.internal` resolve to one of these and
// are refused by their address. Azure's wireserver 168.63.129.16 is public address space, so
// it is listed on its own.
const IPV4_REFUSED: readonly Range4[] = [
  { base: ip4('168.63.129.16'), bits: 32, reason: 'cloud_metadata' },
  { base: ip4('0.0.0.0'), bits: 8, reason: 'unspecified' },
  { base: ip4('10.0.0.0'), bits: 8, reason: 'private' },
  { base: ip4('100.64.0.0'), bits: 10, reason: 'shared' },
  { base: ip4('127.0.0.0'), bits: 8, reason: 'loopback' },
  { base: ip4('169.254.0.0'), bits: 16, reason: 'link_local' },
  { base: ip4('172.16.0.0'), bits: 12, reason: 'private' },
  { base: ip4('192.0.0.0'), bits: 24, reason: 'reserved' },
  { base: ip4('192.0.2.0'), bits: 24, reason: 'documentation' },
  { base: ip4('192.31.196.0'), bits: 24, reason: 'reserved' },
  { base: ip4('192.52.193.0'), bits: 24, reason: 'reserved' },
  { base: ip4('192.88.99.0'), bits: 24, reason: 'reserved' },
  { base: ip4('192.168.0.0'), bits: 16, reason: 'private' },
  { base: ip4('192.175.48.0'), bits: 24, reason: 'reserved' },
  { base: ip4('198.18.0.0'), bits: 15, reason: 'reserved' },
  { base: ip4('198.51.100.0'), bits: 24, reason: 'documentation' },
  { base: ip4('203.0.113.0'), bits: 24, reason: 'documentation' },
  { base: ip4('224.0.0.0'), bits: 4, reason: 'multicast' },
  { base: ip4('255.255.255.255'), bits: 32, reason: 'broadcast' },
  { base: ip4('240.0.0.0'), bits: 4, reason: 'reserved' },
];

function ip4(dotted: string): number {
  const parts = dotted.split('.').map(Number);
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function inRange4(value: number, range: Range4): boolean {
  if (range.bits === 0) return true;
  const mask = range.bits === 32 ? 0xffffffff : (~0 << (32 - range.bits)) >>> 0;
  return (value & mask) >>> 0 === (range.base & mask) >>> 0;
}

function classify4(address: string): AddressClass {
  const value = ip4(address);
  for (const range of IPV4_REFUSED) {
    if (inRange4(value, range)) return { allowed: false, reason: range.reason };
  }
  return { allowed: true, family: 4 };
}

/** The eight 16-bit groups of an IPv6 address (with any dotted IPv4 tail folded in). */
function groups6(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  // A dotted IPv4 tail becomes two groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isIPv4(tail)) return null;
    const v = ip4(tail);
    text = `${text.slice(0, lastColon + 1)}${(v >>> 16).toString(16)}:${(v & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((group) => parseInt(group, 16));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...rest];
  if (all.length !== 8 || all.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return all;
}

function classify6(address: string): AddressClass {
  // A zone index (`fe80::1%eth0`) only exists on link-local addresses; refuse it outright.
  if (address.includes('%')) return { allowed: false, reason: 'link_local' };
  const g = groups6(address);
  if (g === null) return { allowed: false, reason: 'invalid' };
  const [g0, g1, g2, g3, g4, g5] = g as [number, number, number, number, number, number];
  const firstSixZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (firstSixZero && g5 === 0) {
    if (g[6] === 0 && g[7] === 0) return { allowed: false, reason: 'unspecified' };
    if (g[6] === 0 && g[7] === 1) return { allowed: false, reason: 'loopback' };
    return { allowed: false, reason: 'ipv4_embedded' }; // IPv4-compatible ::a.b.c.d
  }
  if (firstSixZero && g5 === 0xffff) return { allowed: false, reason: 'ipv4_embedded' }; // mapped
  if (g0 === 0x64 && g1 === 0xff9b) return { allowed: false, reason: 'ipv4_embedded' }; // NAT64
  if ((g0 & 0xff00) === 0xff00) return { allowed: false, reason: 'multicast' };
  if ((g0 & 0xffc0) === 0xfe80) return { allowed: false, reason: 'link_local' };
  if ((g0 & 0xfe00) === 0xfc00) return { allowed: false, reason: 'private' }; // ULA, incl. fd00:ec2::254
  if ((g0 & 0xe000) !== 0x2000) return { allowed: false, reason: 'not_global' }; // outside 2000::/3
  if (g0 === 0x2002) return { allowed: false, reason: 'ipv4_embedded' }; // 6to4
  if (g0 === 0x2001 && g1 === 0) return { allowed: false, reason: 'ipv4_embedded' }; // Teredo
  if (g0 === 0x2001 && g1 === 0x0db8) return { allowed: false, reason: 'documentation' };
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return { allowed: false, reason: 'documentation' };
  if (g0 === 0x2001 && g1 < 0x0200) return { allowed: false, reason: 'reserved' }; // 2001::/23
  return { allowed: true, family: 6 };
}

/**
 * Classifies one IP address as the network guard sees it. Accepts the forms `dns.lookup`
 * returns: a canonical dotted quad, or an IPv6 address with or without brackets.
 */
export function classifyAddress(address: string): AddressClass {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  if (isIPv4(bare)) return classify4(bare);
  if (isIPv6(bare.split('%')[0] ?? '')) return classify6(bare);
  return { allowed: false, reason: 'invalid' };
}
