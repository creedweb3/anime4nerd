// Manga mode: hosts the background must not fetch on a page's behalf (see fetchImage in background.ts).
// Hostnames are checked as new URL() normalises them. A public name that resolves to a private
// address passes the name check; addressBlocked() catches it from the address that answered.

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.corp', '.intranet'];

const bare = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');

function parseV4(h: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m ? m.slice(1).map(Number) : null;
}

/** The eight 16-bit groups of an IPv6 address, or null if it does not parse. */
function parseV6(h: string): number[] | null {
  let s = h;
  const tail4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s); // "::ffff:1.2.3.4"
  if (tail4) {
    const [a, b, c, d] = tail4.slice(1).map(Number);
    s = `${s.slice(0, tail4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  const groups = rest === null ? head : [...head, ...Array<string>(Math.max(0, 8 - head.length - rest.length)).fill('0'), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function privateV4([a, b, c]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 // this network, private, loopback, multicast and reserved
    || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    || (a === 169 && b === 254) // link-local
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0) // IETF protocol assignments
    || (a === 198 && (b === 18 || b === 19)); // benchmarking
}

const embeddedV4 = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

function privateV6(g: number[]): boolean {
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) {
    // ::, ::1, IPv4-compatible and IPv4-mapped addresses
    return (g[5] === 0 && g[6] === 0 && g[7] <= 1) || privateV4(embeddedV4(g[6], g[7]));
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] !== 0 || privateV4(embeddedV4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return privateV4(embeddedV4(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo tunnels
  return (g[0] & 0xfe00) === 0xfc00 // unique local
    || ((g[0] & 0xff00) === 0xfe00 && g[0] >= 0xfe80) // link-local, site-local
    || (g[0] & 0xff00) === 0xff00; // multicast
}

/** Loopback, private, link-local and local-only names: a page must not get these read for it. */
export function isPrivateHost(host: string): boolean {
  const h = bare(host);
  if (!h) return true;
  if (h.includes(':')) { const g = parseV6(h); return !g || privateV6(g); }
  const v4 = parseV4(h);
  if (v4) return privateV4(v4);
  return h === 'localhost' || !h.includes('.') || LOCAL_SUFFIXES.some((s) => h.endsWith(s));
}

/** Cloud metadata services and link-local addresses: never fetched, even for a reader on a local address. */
export function isMetadataHost(host: string): boolean {
  const h = bare(host);
  if (h === 'metadata.google.internal') return true;
  const g = h.includes(':') ? parseV6(h) : null;
  if (g) {
    if (g[0] === 0xfd00 && g[1] === 0xec2) return true; // AWS IPv6 metadata
    if (!(g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)) return false;
  }
  const v4 = g ? embeddedV4(g[6], g[7]) : parseV4(h);
  return !!v4 && v4[0] === 169 && v4[1] === 254;
}

/**
 * Whether a response must be refused because of the address it came from (as webRequest reports it).
 * Catches a public name that resolves to a private address. A private address is accepted when the
 * asking frame's own document came from that same address: then everything goes through a local
 * proxy, and the address says nothing. No address seen: refused.
 */
export function addressBlocked(ip: string | null, pagePrivate: boolean, pageIp: string | undefined): boolean {
  if (!ip || isMetadataHost(ip)) return true;
  return !pagePrivate && isPrivateHost(ip) && ip !== pageIp;
}
