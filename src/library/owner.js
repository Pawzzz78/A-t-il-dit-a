// Library owner without an account: HMAC of the SSO subject, or of a random token kept in the signed `own` cookie
import crypto from 'node:crypto';
import { originHost, parseCookies } from '../auth.js';
import { membersOnly, oidcConfigured } from '../members/oidc.js';
import { memberOf } from '../members/session.js';

export const OWNER_COOKIE = 'own';
const COOKIE_DAYS = 400;

const secret = () => process.env.OWNER_KEY_SECRET || process.env.SESSION_SECRET || '';
const hmac = (value) => crypto.createHmac('sha256', secret()).update(value).digest('hex');
const placeholder = (v) => /^change-me/i.test(v);

export const libraryEnabled = () => !/^(off|false|0|non)$/i.test(process.env.LIBRARY_ENABLED ?? 'on');
export const libraryConfigured = () => libraryEnabled() && secret().length >= 16 && !placeholder(secret());

const keyOf = (seed) => hmac(`owner|${seed}`).slice(0, 32);

function readToken(req) {
  const [token, mac] = String(parseCookies(req.headers.cookie)[OWNER_COOKIE] ?? '').split('.');
  if (!token || !/^[0-9a-f]{32}$/.test(mac ?? '') || !/^[A-Za-z0-9_-]{22,64}$/.test(token)) return null;
  const expected = hmac(`cookie|${token}`).slice(0, 32);
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected)) ? token : null;
}

export function ownerOf(req) {
  if (!libraryConfigured()) return null;
  const member = oidcConfigured() ? memberOf(req) : null;
  if (member) return { key: keyOf(`m:${member.sub}`), member: true };
  if (membersOnly()) return null;
  const token = readToken(req);
  return token ? { key: keyOf(`a:${token}`), member: false } : null;
}

// Anonymous owners get their cookie on their first write only
export function ensureOwner(req, res) {
  const found = ownerOf(req);
  if (found || !libraryConfigured() || membersOnly()) return found;
  const token = crypto.randomBytes(18).toString('base64url');
  const value = `${token}.${hmac(`cookie|${token}`).slice(0, 32)}`;
  res.append('Set-Cookie', `${OWNER_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}${req.secure ? '; Secure' : ''}`);
  return { key: keyOf(`a:${token}`), member: false };
}

export const clearOwner = (req, res) =>
  res.append('Set-Cookie', `${OWNER_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${req.secure ? '; Secure' : ''}`);

export function requireOwner(req, res, next) {
  if (!libraryConfigured()) return res.status(503).json({ error: "La bibliothèque n'est pas disponible." });
  if (!['GET', 'HEAD'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin && originHost(origin) !== req.get('host')) return res.status(403).json({ error: 'Origine refusée.' });
  }
  if (membersOnly() && !oidcConfigured()) return res.status(503).json({ error: "La connexion adhérents n'est pas configurée." });
  const owner = ensureOwner(req, res);
  if (!owner) return res.status(401).json({ error: 'Réservé aux adhérents de Nouvelle Énergie.', login: '/api/auth/login' });
  req.owner = owner;
  next();
}

export function optionalOwner(req, _res, next) {
  req.owner = ownerOf(req);
  next();
}
