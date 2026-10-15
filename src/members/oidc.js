/**
 * Client OpenID Connect pour le SSO de Nouvelle Énergie (Keycloak) : Authorization Code + PKCE, sans bibliothèque.
 *
 * Doc : https://adherent.unenouvelleenergie.fr/initiatives/connexion (espace adhérents, accès connecté).
 * Règles d'usage des données (à respecter) : on garde `sub`, jamais le profil ; le prénom ne sert qu'à l'affichage et reste dans
 * le cookie de session du navigateur ; pas de listes ; l'adhésion est déjà vérifiée par le SSO à chaque connexion.
 *
 * Variables d'environnement :
 *   MEMBERS_ONLY          « on » pour réserver le studio aux adhérents (désactivé par défaut)
 *   OIDC_CLIENT_ID        identifiant du client, remis par l'équipe numérique de NE
 *   OIDC_CLIENT_SECRET    secret du client (client confidentiel : le site a un serveur) — jamais dans le dépôt
 *   PUBLIC_URL            adresse publique du site, ex. https://lisnardfacts.fr (sert à former les adresses de retour)
 *   OIDC_ISSUER           (facultatif) https://auth.unenouvelleenergie.fr/realms/nouvelle-energie
 *   OIDC_SCOPE            (facultatif) « openid adherent » : on ne demande ni l'adresse e-mail ni rien d'inutile
 */
import crypto from 'node:crypto';

export const DEFAULT_ISSUER = 'https://auth.unenouvelleenergie.fr/realms/nouvelle-energie';
const TIMEOUT_MS = 10_000;
const CLOCK_SKEW_S = 60;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

export class OidcError extends Error {
  constructor(message, code = 'oidc_error') {
    super(message);
    this.code = code;
  }
}

export const membersOnly = () => /^(on|true|1|oui)$/i.test(process.env.MEMBERS_ONLY ?? '');

export function oidcConfig() {
  return {
    issuer: (process.env.OIDC_ISSUER || DEFAULT_ISSUER).replace(/\/+$/, ''),
    clientId: process.env.OIDC_CLIENT_ID || '',
    clientSecret: process.env.OIDC_CLIENT_SECRET || '',
    scope: process.env.OIDC_SCOPE || 'openid adherent',
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  };
}

/** La connexion est utilisable : client configuré et secret de session assez long. */
export const oidcConfigured = () => {
  const c = oidcConfig();
  return Boolean(c.clientId && c.clientSecret) && (process.env.SESSION_SECRET ?? '').length >= 16;
};

const fetchJson = async (url, init = {}) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const data = await res.json().catch(() => ({}));
  return { res, data };
};

// --- discovery et clés publiques -----------------------------------------------------------------------------------------------------

let discoveryCache = null;
let jwksCache = null;

export function resetOidcCache() {
  discoveryCache = null;
  jwksCache = null;
}

export async function discovery() {
  const { issuer } = oidcConfig();
  if (discoveryCache?.issuer === issuer && discoveryCache.until > Date.now()) return discoveryCache.doc;
  const { res, data } = await fetchJson(`${issuer}/.well-known/openid-configuration`).catch(() => ({ res: null, data: {} }));
  if (!res?.ok || !data.authorization_endpoint || !data.token_endpoint || !data.jwks_uri) throw new OidcError('Le SSO est injoignable.', 'sso_unavailable');
  if (data.issuer && data.issuer.replace(/\/+$/, '') !== issuer) throw new OidcError("L'émetteur annoncé par le SSO ne correspond pas à celui attendu.", 'bad_issuer');
  discoveryCache = { issuer, doc: data, until: Date.now() + DISCOVERY_TTL_MS };
  return data;
}

async function signingKey(kid, alg) {
  const find = () => jwksCache?.keys.find((k) => (!kid || k.kid === kid) && k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === alg));
  if (!jwksCache || jwksCache.until < Date.now() || !find()) {
    // clé inconnue : on relit la liste une fois (rotation des clés), sans permettre de marteler le SSO
    if (!jwksCache || jwksCache.fetchedAt < Date.now() - 30_000) {
      const { jwks_uri } = await discovery();
      const { res, data } = await fetchJson(jwks_uri).catch(() => ({ res: null, data: {} }));
      if (!res?.ok || !Array.isArray(data.keys)) throw new OidcError('Les clés du SSO sont injoignables.', 'sso_unavailable');
      jwksCache = { keys: data.keys, fetchedAt: Date.now(), until: Date.now() + DISCOVERY_TTL_MS };
    }
  }
  const jwk = find();
  if (!jwk) throw new OidcError('Clé de signature inconnue.', 'bad_token');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

// --- jeton d'identité --------------------------------------------------------------------------------------------------------------------

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/** Vérifie la signature (RS256), l'émetteur, l'audience, l'expiration et le nonce ; renvoie les claims. */
export async function verifyIdToken(token, { nonce }) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) throw new OidcError("Jeton d'identité illisible.", 'bad_token');
  let header;
  let claims;
  try {
    header = b64json(parts[0]);
    claims = b64json(parts[1]);
  } catch {
    throw new OidcError("Jeton d'identité illisible.", 'bad_token');
  }
  if (header.alg !== 'RS256') throw new OidcError('Algorithme de signature refusé.', 'bad_token');
  const key = await signingKey(header.kid, header.alg);
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new OidcError('Signature du jeton invalide.', 'bad_token');

  const { issuer, clientId } = oidcConfig();
  const now = Math.floor(Date.now() / 1000);
  const aud = [].concat(claims.aud ?? []);
  if (claims.iss !== issuer) throw new OidcError('Émetteur du jeton inattendu.', 'bad_token');
  if (!aud.includes(clientId) || (aud.length > 1 && claims.azp !== clientId)) throw new OidcError('Jeton destiné à une autre application.', 'bad_token');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now) throw new OidcError('Jeton expiré.', 'bad_token');
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > now) throw new OidcError('Jeton daté du futur.', 'bad_token');
  if (!nonce || claims.nonce !== nonce) throw new OidcError('Nonce invalide.', 'bad_token');
  if (!claims.sub) throw new OidcError('Jeton sans identifiant.', 'bad_token');
  return claims;
}

// --- parcours ------------------------------------------------------------------------------------------------------------------------------

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const pkceChallenge = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

/** Adresse du SSO où envoyer la personne (Authorization Code + PKCE S256). */
export async function authorizationUrl({ redirectUri, state, nonce, verifier }) {
  const { authorization_endpoint } = await discovery();
  const { clientId, scope } = oidcConfig();
  const url = new URL(authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    nonce,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

/** Échange le code d'autorisation contre les jetons (client confidentiel : secret en en-tête Basic). */
export async function exchangeCode({ code, redirectUri, verifier }) {
  const { token_endpoint } = await discovery();
  const { clientId, clientSecret } = oidcConfig();
  const { res, data } = await fetchJson(token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, client_id: clientId }),
  }).catch(() => ({ res: null, data: {} }));
  if (!res) throw new OidcError('Le SSO est injoignable.', 'sso_unavailable');
  if (!res.ok || !data.id_token) throw new OidcError(`Échange du code refusé${data.error ? ` (${data.error})` : ''}.`, 'token_refused');
  return data;
}

/** Adresse de déconnexion du SSO (met fin à la session SSO, sinon la personne serait reconnectée sans rien saisir). */
export async function logoutUrl({ idToken, postLogoutRedirectUri }) {
  const { end_session_endpoint } = await discovery();
  if (!end_session_endpoint) return null;
  const url = new URL(end_session_endpoint);
  if (idToken) url.searchParams.set('id_token_hint', idToken);
  url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
  url.searchParams.set('client_id', oidcConfig().clientId);
  return url.toString();
}
