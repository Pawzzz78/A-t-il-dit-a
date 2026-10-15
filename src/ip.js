/**
 * Clé de limitation par visiteur : une adresse IPv4 telle quelle, une adresse IPv6 réduite à son préfixe /64
 * (un abonné dispose d'un /64 entier : sans ce regroupement, changer d'adresse contournerait toutes les limites).
 */
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

/** Garde une table de limitation bornée : retire d'abord les entrées expirées, puis les plus anciennes. */
export function trimMap(map, max, expired) {
  if (map.size <= max) return;
  for (const [key, value] of map) if (expired(value)) map.delete(key);
  for (const key of map.keys()) {
    if (map.size <= max) break;
    map.delete(key);
  }
}
