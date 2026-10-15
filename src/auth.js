import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'adm';
const TTL_MS = 12 * 60 * 60 * 1000;

export const authConfigured = () =>
  Boolean(process.env.ADMIN_PASSWORD) && (process.env.SESSION_SECRET ?? '').length >= 16;

const sign = (payload) => createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function checkPassword(candidate) {
  // On compare des hash pour ne pas dépendre de la longueur du mot de passe.
  const h = (s) => createHmac('sha256', 'pw').update(String(s)).digest();
  return timingSafeEqual(h(candidate), h(process.env.ADMIN_PASSWORD));
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  );
}

export function startSession(req, res) {
  const exp = String(Date.now() + TTL_MS);
  const value = `${exp}.${sign(exp)}`;
  res.append(
    'Set-Cookie',
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL_MS / 1000}${
      req.secure ? '; Secure' : ''
    }`,
  );
}

export function endSession(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

export function isAuthenticated(req) {
  if (!authConfigured()) return false;
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return false;
  const [exp, mac] = raw.split('.');
  return Boolean(exp && mac && safeEqual(mac, sign(exp)) && Number(exp) > Date.now());
}

/** Middleware : session valide + origine identique pour les requêtes qui modifient des données. */
export function requireAdmin(req, res, next) {
  if (!authConfigured()) {
    return res.status(503).json({ error: "L'admin n'est pas configurée (ADMIN_PASSWORD / SESSION_SECRET)." });
  }
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non authentifié.' });
  if (!['GET', 'HEAD'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin && new URL(origin).host !== req.get('host')) {
      return res.status(403).json({ error: 'Origine refusée.' });
    }
  }
  next();
}

/** Limiteur de tentatives de connexion : 5 échecs / 15 min / IP. */
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
const MAX = 5;

export function loginAllowed(ip) {
  const rec = attempts.get(ip);
  return !rec || rec.until < Date.now() || rec.count < MAX;
}
export function recordLogin(ip, ok) {
  if (ok) return attempts.delete(ip);
  const rec = attempts.get(ip);
  if (!rec || rec.until < Date.now()) attempts.set(ip, { count: 1, until: Date.now() + WINDOW });
  else rec.count++;
}
