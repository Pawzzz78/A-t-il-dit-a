/**
 * Session adhérent : un cookie signé (HMAC avec SESSION_SECRET) dans le navigateur, rien en base.
 * Contenu : `sub` (identifiant stable), prénom (affichage seulement), `sid`, et le jeton d'identité (pour la déconnexion SSO).
 * Aucun profil n'est enregistré côté serveur (règle d'usage des données du SSO).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseCookies } from '../auth.js';
import { membersOnly, oidcConfigured } from './oidc.js';

export const SESSION_COOKIE = 'mbr';
export const FLOW_COOKIE = 'mbr_flow';
const FLOW_TTL_S = 10 * 60;

export const sessionDays = () => {
  const n = Number(process.env.MEMBERS_SESSION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 90) : 7;
};

const sign = (payload) => createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

const seal = (obj) => {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${body}.${sign(body)}`;
};
const unseal = (raw) => {
  const [body, mac] = String(raw ?? '').split('.');
  if (!body || !mac || !safeEqual(mac, sign(body))) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return obj && Number(obj.exp) > Date.now() ? obj : null;
  } catch {
    return null;
  }
};

const cookie = (req, name, value, { path, maxAge }) =>
  `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;

export function startMemberSession(req, res, { sub, givenName, sid, idToken }) {
  const maxAge = sessionDays() * 24 * 3600;
  const value = seal({ sub, gn: givenName ?? null, sid: sid ?? null, idt: idToken, exp: Date.now() + maxAge * 1000 });
  res.append('Set-Cookie', cookie(req, SESSION_COOKIE, value, { path: '/', maxAge }));
}

export function endMemberSession(req, res) {
  res.append('Set-Cookie', cookie(req, SESSION_COOKIE, '', { path: '/', maxAge: 0 }));
}

/** Membre connecté d'après le cookie : { sub, given_name, sid, id_token } ou null. */
export function memberOf(req) {
  if (!oidcConfigured()) return null;
  const s = unseal(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  return s?.sub ? { sub: s.sub, given_name: s.gn ?? null, sid: s.sid ?? null, id_token: s.idt ?? null } : null;
}

/** État du parcours de connexion en cours (state, nonce, vérificateur PKCE, page demandée), valable 10 minutes. */
export function startFlow(req, res, flow) {
  res.append('Set-Cookie', cookie(req, FLOW_COOKIE, seal({ ...flow, exp: Date.now() + FLOW_TTL_S * 1000 }), { path: '/api/auth', maxAge: FLOW_TTL_S }));
}
export const readFlow = (req) => unseal(parseCookies(req.headers.cookie)[FLOW_COOKIE]);
export const endFlow = (req, res) => res.append('Set-Cookie', cookie(req, FLOW_COOKIE, '', { path: '/api/auth', maxAge: 0 }));

/** Middleware : l'API du studio n'est ouverte qu'aux adhérents quand MEMBERS_ONLY est activé. */
export function requireMember(req, res, next) {
  if (!membersOnly()) return next();
  if (!oidcConfigured()) return res.status(503).json({ error: "La connexion adhérents n'est pas configurée." });
  const member = memberOf(req);
  if (!member) return res.status(401).json({ error: 'Réservé aux adhérents de Nouvelle Énergie.', login: '/api/auth/login' });
  if (!['GET', 'HEAD'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin && new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Origine refusée.' });
  }
  req.member = member;
  next();
}
