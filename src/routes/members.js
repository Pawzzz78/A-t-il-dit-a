/** Connexion des adhérents Nouvelle Énergie (SSO OpenID Connect) : /api/auth/login, /callback, /logout, /me. */
import { Router } from 'express';
import { originHost } from '../auth.js';
import { OidcError, authorizationUrl, exchangeCode, logoutUrl, membersOnly, oidcConfig, oidcConfigured, randomToken, verifyIdToken } from '../members/oidc.js';
import { endFlow, endMemberSession, memberOf, readFlow, startFlow, startMemberSession } from '../members/session.js';

export const membersRouter = Router();
membersRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/** Adresse publique du site : PUBLIC_URL, sinon celle de la requête (développement). */
const baseUrl = (req) => oidcConfig().publicUrl || `${req.protocol}://${req.get('host')}`;
const redirectUri = (req) => `${baseUrl(req)}/api/auth/callback`;

/** Page demandée avant la connexion : un chemin du site seulement (jamais une adresse externe). */
const safeNext = (value) => (typeof value === 'string' && /^\/(?![/\\])/.test(value) && value.length < 500 ? value : '/');

/** Codes d'erreur du SSO (error_description) que la page sait expliquer ; le reste est un échec neutre. */
const KNOWN_ERRORS = new Set(['membership_not_found', 'membership_unavailable', 'code_throttled', 'code_send_failed', 'sso_unavailable']);
const failure = (res, code, next = '/') => {
  const target = new URL(safeNext(next), 'http://x');
  target.searchParams.set('connexion', KNOWN_ERRORS.has(code) ? code : 'echec');
  res.redirect(302, `${target.pathname}${target.search}${target.hash}`);
};

membersRouter.get('/me', (req, res) => {
  const member = memberOf(req);
  res.json({ enabled: membersOnly(), configured: oidcConfigured(), member: member ? { given_name: member.given_name } : null });
});

membersRouter.get('/login', async (req, res) => {
  if (!membersOnly() || !oidcConfigured()) return res.status(503).json({ error: "La connexion adhérents n'est pas disponible." });
  try {
    const flow = { state: randomToken(), nonce: randomToken(), verifier: randomToken(48), next: safeNext(req.query.next) };
    const url = await authorizationUrl({ redirectUri: redirectUri(req), ...flow });
    startFlow(req, res, flow);
    res.redirect(302, url);
  } catch (e) {
    console.error(`Connexion adhérents : ${e.message}`);
    failure(res, 'sso_unavailable', req.query.next);
  }
});

membersRouter.get('/callback', async (req, res) => {
  if (!membersOnly() || !oidcConfigured()) return res.status(503).json({ error: "La connexion adhérents n'est pas disponible." });
  const flow = readFlow(req);
  endFlow(req, res);
  const q = req.query;
  if (!flow || typeof q.state !== 'string' || q.state !== flow.state) return failure(res, 'echec');
  if (q.error) return failure(res, String(q.error_description ?? ''), flow.next); // ex. access_denied + membership_not_found
  if (typeof q.code !== 'string' || !q.code) return failure(res, 'echec', flow.next);
  try {
    const tokens = await exchangeCode({ code: q.code, redirectUri: redirectUri(req), verifier: flow.verifier });
    const claims = await verifyIdToken(tokens.id_token, { nonce: flow.nonce });
    startMemberSession(req, res, { sub: claims.sub, givenName: claims.given_name, sid: claims.sid, idToken: tokens.id_token });
    res.redirect(302, safeNext(flow.next));
  } catch (e) {
    console.error(`Connexion adhérents : ${e instanceof OidcError ? e.message : e.stack}`);
    failure(res, 'echec', flow.next);
  }
});

membersRouter.post('/logout', async (req, res) => {
  const origin = req.get('origin');
  if (origin && originHost(origin) !== req.get('host')) return res.status(403).json({ error: 'Origine refusée.' });
  const member = memberOf(req);
  endMemberSession(req, res);
  let redirect = '/';
  if (member && oidcConfigured()) {
    // sans fin de session SSO, la personne serait reconnectée sans rien saisir à sa prochaine visite
    redirect = (await logoutUrl({ idToken: member.id_token, postLogoutRedirectUri: `${baseUrl(req)}/` }).catch(() => null)) ?? '/';
  }
  res.json({ redirect });
});
