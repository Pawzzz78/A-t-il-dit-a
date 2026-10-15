// Connexion des adhérents NE : le SSO (OpenID Connect, Authorization Code + PKCE) est simulé par un petit serveur local
// qui vérifie le secret du client et le PKCE comme le ferait Keycloak, et signe de vrais jetons RS256.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import express from 'express';
import { oidcConfigured, resetOidcCache } from '../src/members/oidc.js';
import { requireMember } from '../src/members/session.js';
import { membersRouter } from '../src/routes/members.js';

const CLIENT = { id: 'studio', secret: 'secret-de-test' };
const SUB = '5f0c2a9e-0000-4000-8000-000000007b41';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('base64url');

let mock; // faux SSO
let site; // notre application
let siteUrl;
const saved = { ...process.env };

function startMock() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const state = { codes: new Map(), claims: {}, header: {}, good: privateKey, signWith: privateKey, other: other.privateKey, tokenCalls: [], jwksCalls: 0, status: 200 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const base = `http://127.0.0.1:${server.address().port}/realms/ne`;
    if (url.pathname === '/realms/ne/.well-known/openid-configuration') {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/protocol/openid-connect/auth`,
        token_endpoint: `${base}/protocol/openid-connect/token`,
        jwks_uri: `${base}/protocol/openid-connect/certs`,
        end_session_endpoint: `${base}/protocol/openid-connect/logout`,
      });
    }
    if (url.pathname.endsWith('/certs')) {
      state.jwksCalls++;
      return json(200, { keys: [jwk] });
    }
    if (url.pathname.endsWith('/token') && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const form = new URLSearchParams(raw);
      state.tokenCalls.push({ form, auth: req.headers.authorization });
      const expected = `Basic ${Buffer.from(`${CLIENT.id}:${CLIENT.secret}`).toString('base64')}`;
      const grant = state.codes.get(form.get('code'));
      if (state.status !== 200) return json(state.status, { error: 'server_error' });
      if (req.headers.authorization !== expected) return json(401, { error: 'invalid_client' });
      if (!grant || sha256(form.get('code_verifier') ?? '') !== grant.challenge || form.get('redirect_uri') !== grant.redirectUri) return json(400, { error: 'invalid_grant' });
      state.codes.delete(form.get('code')); // un code ne sert qu'une fois
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: base, aud: CLIENT.id, azp: CLIENT.id, sub: SUB, sid: 'sid-1', email: 'camille@exemple.fr', email_verified: true, given_name: 'Camille', departement: '06', auth_time: now, iat: now, exp: now + 300, nonce: grant.nonce, ...state.claims };
      const header = { alg: 'RS256', kid: 'k1', typ: 'JWT', ...state.header };
      const body = `${b64(header)}.${b64(claims)}`;
      const sig = header.alg === 'RS256' ? crypto.sign('RSA-SHA256', Buffer.from(body), state.signWith).toString('base64url') : 'x';
      return json(200, { access_token: 'at', token_type: 'Bearer', id_token: `${body}.${sig}` });
    }
    json(404, {});
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      state.base = `http://127.0.0.1:${server.address().port}/realms/ne`;
      state.close = () => server.close();
      state.issueCode = (query, redirectUri) => {
        const code = crypto.randomBytes(8).toString('hex');
        state.codes.set(code, { challenge: query.get('code_challenge'), nonce: query.get('nonce'), redirectUri });
        return code;
      };
      resolve(state);
    }),
  );
}

before(async () => {
  mock = await startMock();
  const app = express();
  app.use('/api/auth', membersRouter);
  app.get('/api/outil', requireMember, (req, res) => res.json({ sub: req.member?.sub ?? null }));
  app.post('/api/outil', requireMember, (_req, res) => res.json({ ok: true }));
  site = http.createServer(app);
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
});
after(() => {
  mock.close();
  site.close();
});

beforeEach(() => {
  Object.assign(process.env, { MEMBERS_ONLY: 'on', OIDC_ISSUER: mock.base, OIDC_CLIENT_ID: CLIENT.id, OIDC_CLIENT_SECRET: CLIENT.secret, SESSION_SECRET: 'une-phrase-secrete-assez-longue', PUBLIC_URL: 'https://lisnardfacts.fr' });
  delete process.env.OIDC_SCOPE;
  delete process.env.MEMBERS_SESSION_DAYS;
  mock.claims = {};
  mock.header = {};
  mock.signWith = mock.good;
  mock.tokenCalls.length = 0;
  mock.status = 200;
  resetOidcCache();
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const cookiesOf = (res) => Object.fromEntries(res.headers.getSetCookie().map((c) => c.split(';')[0].split('=')).map(([k, ...v]) => [k, v.join('=')]));
const jar = (c) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ');
const get = (path, cookie) => fetch(`${siteUrl}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

/** Démarre une connexion : renvoie les paramètres envoyés au SSO et le cookie d'état. */
async function begin(next) {
  const res = await get(`/api/auth/login${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  return { res, query: location.searchParams, location, flow: jar(cookiesOf(res)) };
}

/** Parcours complet jusqu'à la session : renvoie la réponse du callback et le cookie de session. */
async function signIn({ next, tweak } = {}) {
  const { query, flow } = await begin(next);
  const code = mock.issueCode(query, query.get('redirect_uri'));
  tweak?.();
  const res = await get(`/api/auth/callback?code=${code}&state=${query.get('state')}`, flow);
  return { res, session: cookiesOf(res).mbr, query };
}

test('connexion : redirection vers le SSO avec PKCE S256, state, nonce et scopes minimaux', async () => {
  const { res, query, location } = await begin('/?v=abc');
  assert.equal(location.origin + location.pathname, `${mock.base}/protocol/openid-connect/auth`);
  assert.equal(query.get('response_type'), 'code');
  assert.equal(query.get('client_id'), CLIENT.id);
  assert.equal(query.get('redirect_uri'), 'https://lisnardfacts.fr/api/auth/callback');
  assert.equal(query.get('scope'), 'openid adherent'); // ni e-mail ni rien d'inutile
  assert.equal(query.get('code_challenge_method'), 'S256');
  assert.ok(query.get('code_challenge')?.length >= 43 && query.get('state')?.length >= 32 && query.get('nonce')?.length >= 32);
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('mbr_flow='));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\/api\/auth/);
  assert.match(setCookie, /Max-Age=600/);
  assert.doesNotMatch(setCookie, /verifier/); // le vérificateur est dans une valeur signée, pas en clair
});

test('parcours complet : session adhérent, accès à l\'outil, prénom pour l\'affichage', async () => {
  assert.equal((await get('/api/outil')).status, 401); // sans connexion : fermé
  const denied = await (await get('/api/outil')).json();
  assert.equal(denied.login, '/api/auth/login');

  const { res, session, query } = await signIn({ next: '/?v=abc' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/?v=abc');
  assert.ok(session);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('mbr='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=604800/); // 7 jours
  // le serveur du SSO a bien reçu : le secret en Basic, le code, le vérificateur PKCE qui correspond au défi, l'adresse de retour
  const call = mock.tokenCalls.at(-1);
  assert.equal(call.form.get('grant_type'), 'authorization_code');
  assert.equal(call.form.get('redirect_uri'), query.get('redirect_uri'));
  assert.equal(sha256(call.form.get('code_verifier')), query.get('code_challenge'));
  // le cookie d'état est effacé
  assert.ok(res.headers.getSetCookie().some((c) => c.startsWith('mbr_flow=;') && /Max-Age=0/.test(c)));

  const ok = await (await get('/api/outil', `mbr=${session}`)).json();
  assert.equal(ok.sub, SUB);
  const me = await (await get('/api/auth/me', `mbr=${session}`)).json();
  assert.deepEqual(me, { enabled: true, configured: true, member: { given_name: 'Camille' } });
  // aucune autre donnée de profil n'est exposée par notre API
  assert.equal(JSON.stringify(me).includes('06'), false);
  assert.equal(JSON.stringify(me).includes('exemple.fr'), false);
});

test('un code d\'autorisation ne sert qu\'une fois, et le state doit correspondre', async () => {
  const { query, flow } = await begin();
  const code = mock.issueCode(query, query.get('redirect_uri'));
  const bad = await get(`/api/auth/callback?code=${code}&state=autre`, flow);
  assert.equal(bad.headers.get('location'), '/?connexion=echec');
  assert.equal(cookiesOf(bad).mbr, undefined);
  // sans cookie d'état (autre navigateur, parcours périmé) : refusé aussi
  const { query: q2 } = await begin();
  const c2 = mock.issueCode(q2, q2.get('redirect_uri'));
  const noFlow = await get(`/api/auth/callback?code=${c2}&state=${q2.get('state')}`);
  assert.equal(noFlow.headers.get('location'), '/?connexion=echec');
  assert.equal(mock.tokenCalls.length, 0); // rien n'est envoyé au SSO dans ces cas
});

test('erreurs renvoyées par le SSO : explication précise pour chaque code connu, échec neutre sinon', async () => {
  for (const code of ['membership_not_found', 'membership_unavailable', 'code_throttled', 'code_send_failed']) {
    const { query, flow } = await begin();
    const res = await get(`/api/auth/callback?error=access_denied&error_description=${code}&state=${query.get('state')}`, flow);
    assert.equal(res.headers.get('location'), `/?connexion=${code}`);
    assert.equal(cookiesOf(res).mbr, undefined);
  }
  const { query, flow } = await begin();
  const res = await get(`/api/auth/callback?error=server_error&error_description=${encodeURIComponent('<script>')}&state=${query.get('state')}`, flow);
  assert.equal(res.headers.get('location'), '/?connexion=echec'); // jamais d'écho d'un texte inconnu
});

test('jeton d\'identité invalide : refusé (nonce, audience, émetteur, expiration, signature, algorithme)', async () => {
  const now = Math.floor(Date.now() / 1000);
  const cases = {
    'nonce différent': () => (mock.claims = { nonce: 'rejoué' }),
    autre_application: () => (mock.claims = { aud: 'une-autre-app', azp: 'une-autre-app' }),
    mauvais_emetteur: () => (mock.claims = { iss: 'https://pirate.example/realms/ne' }),
    expire: () => (mock.claims = { exp: now - 3600 }),
    sans_sub: () => (mock.claims = { sub: undefined }),
    mauvaise_signature: () => (mock.signWith = mock.other),
    algorithme_none: () => (mock.header = { alg: 'none' }),
    algorithme_hs256: () => (mock.header = { alg: 'HS256' }),
  };
  const good = mock.good;
  for (const [name, tweak] of Object.entries(cases)) {
    Object.assign(mock, { signWith: good, claims: {}, header: {} });
    const { res, session } = await signIn({ tweak });
    assert.equal(res.headers.get('location'), '/?connexion=echec', name);
    assert.equal(session, undefined, name);
  }
  Object.assign(mock, { signWith: good, claims: {}, header: {} });
});

test('le SSO en panne ou qui refuse l\'échange : échec neutre, pas de session', async () => {
  const { res, session } = await signIn({ tweak: () => (mock.status = 500) });
  assert.equal(res.headers.get('location'), '/?connexion=echec');
  assert.equal(session, undefined);
});

test('page demandée : seulement un chemin du site (pas d\'adresse externe)', async () => {
  for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)']) {
    const { res } = await signIn({ next });
    assert.equal(res.headers.get('location'), '/', next);
  }
});

test('cookie de session falsifié, périmé ou d\'une autre clé : refusé', async () => {
  const { session } = await signIn();
  const [body, mac] = session.split('.');
  assert.equal((await get('/api/outil', `mbr=${session}`)).status, 200);
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), sub: 'quelquun-d-autre' })).toString('base64url');
  assert.equal((await get('/api/outil', `mbr=${forged}.${mac}`)).status, 401);
  assert.equal((await get('/api/outil', `mbr=${body}.`)).status, 401);
  process.env.SESSION_SECRET = 'une-autre-phrase-secrete-longue';
  assert.equal((await get('/api/outil', `mbr=${session}`)).status, 401);
  // périmé : session de durée négligeable
  process.env.SESSION_SECRET = 'une-phrase-secrete-assez-longue';
  const expired = Buffer.from(JSON.stringify({ sub: SUB, exp: Date.now() - 1000 })).toString('base64url');
  const mac2 = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(expired).digest('base64url');
  assert.equal((await get('/api/outil', `mbr=${expired}.${mac2}`)).status, 401);
});

test('les requêtes qui modifient des données exigent la même origine', async () => {
  const { session } = await signIn();
  const post = (origin) => fetch(`${siteUrl}/api/outil`, { method: 'POST', headers: { cookie: `mbr=${session}`, ...(origin ? { origin } : {}) } });
  assert.equal((await post()).status, 200);
  assert.equal((await post(siteUrl)).status, 200);
  assert.equal((await post('https://pirate.example')).status, 403);
  assert.equal((await post('null')).status, 403); // « Origin: null » (page isolée) : refusé, sans erreur 500
});

test('déconnexion : cookie effacé et fin de session côté SSO', async () => {
  const { session } = await signIn();
  const res = await fetch(`${siteUrl}/api/auth/logout`, { method: 'POST', headers: { cookie: `mbr=${session}` } });
  const { redirect } = await res.json();
  const url = new URL(redirect);
  assert.equal(url.origin + url.pathname, `${mock.base}/protocol/openid-connect/logout`);
  assert.equal(url.searchParams.get('post_logout_redirect_uri'), 'https://lisnardfacts.fr/');
  assert.ok(url.searchParams.get('id_token_hint')?.split('.').length === 3);
  assert.ok(res.headers.getSetCookie().some((c) => c.startsWith('mbr=;') && /Max-Age=0/.test(c)));
  assert.equal((await fetch(`${siteUrl}/api/auth/logout`, { method: 'POST', headers: { origin: 'https://pirate.example' } })).status, 403);
  assert.equal((await fetch(`${siteUrl}/api/auth/logout`, { method: 'POST', headers: { origin: 'null' } })).status, 403);
  const anonymous = await fetch(`${siteUrl}/api/auth/logout`, { method: 'POST' });
  assert.deepEqual(await anonymous.json(), { redirect: '/' });
});

test('réglages : accès libre par défaut, fermé sans configuration, durée de session', async () => {
  process.env.MEMBERS_ONLY = 'off';
  assert.equal((await get('/api/outil')).status, 200);
  assert.deepEqual(await (await get('/api/auth/me')).json(), { enabled: false, configured: true, member: null });
  assert.equal((await get('/api/auth/login')).status, 503); // pas de connexion quand l'accès est libre

  process.env.MEMBERS_ONLY = 'on';
  delete process.env.OIDC_CLIENT_SECRET;
  assert.equal(oidcConfigured(), false);
  const closed = await get('/api/outil'); // activé mais pas configuré : on ferme (jamais d'accès ouvert par oubli)
  assert.equal(closed.status, 503);
  assert.equal((await get('/api/auth/login')).status, 503);

  process.env.OIDC_CLIENT_SECRET = CLIENT.secret;
  process.env.MEMBERS_SESSION_DAYS = '30';
  const { res } = await signIn();
  assert.match(res.headers.getSetCookie().find((c) => c.startsWith('mbr=')), /Max-Age=2592000/);
});

test('clés du SSO : lues une fois et mises en cache ; SSO injoignable : échec neutre', async () => {
  const before = mock.jwksCalls;
  await signIn();
  await signIn();
  assert.equal(mock.jwksCalls - before <= 1, true);
  process.env.OIDC_ISSUER = 'http://127.0.0.1:9/realms/ne'; // rien n'écoute ici
  resetOidcCache();
  const res = await get('/api/auth/login');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/?connexion=sso_unavailable');
});
