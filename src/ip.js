// Rate-limit key: IPv4 as is, IPv6 cut to its /64 (one subscriber owns a whole /64)
import { isIPv4, isIPv6 } from 'node:net';

export function ipKey(ip) {
  let s = String(ip ?? '').trim().toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s.startsWith('::ffff:') && isIPv4(s.slice(7))) return s.slice(7);
  if (!isIPv6(s)) return s;
  // An embedded IPv4 tail counts as two 16-bit groups
  const groups = (part) => (part ? part.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : []);
  const [head, tail] = s.split('::');
  const left = groups(head);
  const right = groups(tail);
  const full = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return `${full.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

// Bounded limiter table: drop expired entries, then the oldest, down to 90 % so the scan is not repeated on every call
export function trimMap(map, max, expired) {
  if (map.size <= max) return;
  for (const [key, value] of map) if (expired(value)) map.delete(key);
  const target = Math.floor(max * 0.9);
  for (const key of map.keys()) {
    if (map.size <= target) break;
    map.delete(key);
  }
}
