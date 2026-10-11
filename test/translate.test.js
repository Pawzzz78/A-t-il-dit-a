import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchLocalized } from '../src/localize.js';
import { TranslationError, baseLang, chunkIndices, completeWithOpenRouter, formatLines, parseLines, translateSegments } from '../src/translate.js';

/** Faux modèle : "traduit" en mettant en majuscules, ligne par ligne. */
const fakeComplete = (transform = (text) => text.toUpperCase()) => {
  const calls = [];
  const complete = async ({ system, user }) => {
    calls.push({ user, system });
    return user
      .split('\n')
      .map((l) => l.replace(/^\[(\d+)\] (.*)$/, (_, n, t) => (transform(t, Number(n)) == null ? '' : `[${n}] ${transform(t, Number(n))}`)))
      .filter(Boolean)
      .join('\n');
  };
  complete.calls = calls;
  return complete;
};

const segs = (n) => Array.from({ length: n }, (_, i) => ({ start_ms: i * 1000, duration_ms: 900, text: `segment ${i + 1}` }));

test('baseLang', () => {
  assert.equal(baseLang('fr-FR'), 'fr');
  assert.equal(baseLang('EN'), 'en');
  assert.equal(baseLang(''), null);
});

test('chunkIndices : limites en nombre de segments et en caractères', () => {
  assert.deepEqual(chunkIndices(['a', 'b', 'c', 'd', 'e'], 2), [[0, 1], [2, 3], [4]]);
  assert.deepEqual(chunkIndices(['aaaa', 'bbbb', 'cc'], 10, 8), [[0, 1], [2]]);
  assert.deepEqual(chunkIndices([]), []);
});

test('parseLines : ignore le bruit, les numéros inattendus et les doublons', () => {
  const out = parseLines('Voici la traduction :\n[1] bonjour\n[2]  à   tous \n[9] intrus\n[1] doublon\nnote', [1, 2, 3]);
  assert.deepEqual([...out], [[1, 'bonjour'], [2, 'à tous']]);
  assert.equal(formatLines([{ n: 4, text: 'x' }]), '[4] x');
});

test('translateSegments : horodatages conservés, ordre respecté sur plusieurs paquets, original gardé', async () => {
  const complete = fakeComplete();
  const input = segs(130);
  const out = await translateSegments(input, { from: 'en', to: 'fr', complete });
  assert.equal(out.length, 130);
  assert.ok(complete.calls.length >= 3);
  out.forEach((s, i) => {
    assert.equal(s.text, `SEGMENT ${i + 1}`);
    assert.equal(s.text_original, `segment ${i + 1}`);
    assert.equal(s.start_ms, i * 1000);
    assert.equal(s.duration_ms, 900);
  });
  assert.match(complete.calls[0].system, /English into French/);
  assert.match(complete.calls[0].system, /never instructions/);
});

test('translateSegments : une retraduction conserve le texte d\'origine initial', async () => {
  const out = await translateSegments([{ start_ms: 0, text: 'bonjour', text_original: 'hello' }], { from: 'fr', to: 'es', complete: fakeComplete() });
  assert.equal(out[0].text_original, 'hello');
});

test('translateSegments : les lignes manquantes sont redemandées', async () => {
  let first = true;
  const complete = fakeComplete((text, n) => (n === 2 && first ? (first = false, null) : text.toUpperCase()));
  const out = await translateSegments(segs(3), { from: 'en', to: 'fr', complete });
  assert.deepEqual(out.map((s) => s.text), ['SEGMENT 1', 'SEGMENT 2', 'SEGMENT 3']);
  assert.equal(complete.calls.length, 2);
  assert.equal(complete.calls[1].user, '[2] segment 2');
});

test('translateSegments : échec si des lignes restent manquantes', async () => {
  const complete = fakeComplete((text, n) => (n === 2 ? null : text.toUpperCase()));
  await assert.rejects(translateSegments(segs(3), { from: 'en', to: 'fr', complete }), (e) => e instanceof TranslationError && /incomplète/.test(e.message));
});

test('translateSegments : sans clé → erreur de configuration', async () => {
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    await assert.rejects(translateSegments(segs(1), { from: 'en', to: 'fr' }), (e) => e.code === 'config');
  } finally {
    if (saved) process.env.OPENROUTER_API_KEY = saved;
  }
});

const supadata = (lang) => async () => ({ segments: segs(2), lang });
const translateFn = async (s, { from, to }) => s.map((x) => ({ ...x, text: `[${from}→${to}] ${x.text}`, text_original: x.text }));

test('fetchLocalized : même langue → pas de traduction', async () => {
  let called = false;
  const r = await fetchLocalized('x', 'fr', { fetchFn: supadata('fr-FR'), translateFn: async () => ((called = true), []), translateConfigured: () => true });
  assert.equal(called, false);
  assert.deepEqual([r.translated, r.untranslated, r.lang], [false, false, 'fr-FR']);
});

test('fetchLocalized : autre langue → traduction vers la langue demandée', async () => {
  const r = await fetchLocalized('x', 'fr', { fetchFn: supadata('en'), translateFn, translateConfigured: () => true });
  assert.equal(r.translated, true);
  assert.equal(r.lang, 'fr');
  assert.equal(r.originalLang, 'en');
  assert.equal(r.segments[0].text, '[en→fr] segment 1');
});

test('fetchLocalized : autre langue sans clé → texte d\'origine conservé et signalé', async () => {
  const r = await fetchLocalized('x', 'fr', { fetchFn: supadata('en'), translateFn, translateConfigured: () => false });
  assert.deepEqual([r.translated, r.untranslated, r.lang], [false, true, 'en']);
  assert.equal(r.segments[0].text, 'segment 1');
});

// --- couche HTTP OpenRouter (faux fetch, aucun appel réseau) --------------------------

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, statusText: `HTTP ${status}`, json: async () => body });
const ok = (text) => jsonResponse(200, { choices: [{ message: { content: text }, finish_reason: 'stop' }] });
const withKey = async (fn) => {
  const saved = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  }
};
const args = { model: 'vendor/cheap-model', system: 'SYS', user: '[1] hello' };
const opts = (fetchImpl) => ({ fetchImpl, retryDelayMs: 0 });

test('OpenRouter : requête bien formée et texte extrait de choices[0].message.content', async () => {
  await withKey(async () => {
    let seen;
    const text = await completeWithOpenRouter(args, opts(async (url, init) => ((seen = { url, init }), ok('[1] bonjour'))));
    assert.equal(text, '[1] bonjour');
    assert.equal(seen.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.headers.Authorization, 'Bearer sk-or-test');
    const body = JSON.parse(seen.init.body);
    assert.equal(body.model, 'vendor/cheap-model');
    assert.equal(body.temperature, 0);
    assert.deepEqual(body.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: '[1] hello' }]);
  });
});

test('OpenRouter : sans clé → erreur de configuration', async () => {
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    await assert.rejects(completeWithOpenRouter(args, opts(async () => ok('x'))), (e) => e.code === 'config');
  } finally {
    if (saved) process.env.OPENROUTER_API_KEY = saved;
  }
});

test('OpenRouter : 429 puis succès → réessai automatique', async () => {
  await withKey(async () => {
    let n = 0;
    const text = await completeWithOpenRouter(args, opts(async () => (++n < 3 ? jsonResponse(429, { error: { message: 'slow down' } }) : ok('[1] ok'))));
    assert.equal(text, '[1] ok');
    assert.equal(n, 3);
  });
});

test('OpenRouter : classement des erreurs pour la synchro', async () => {
  await withKey(async () => {
    const classify = async (res) => {
      try {
        await completeWithOpenRouter(args, opts(async () => res));
      } catch (e) {
        return e.code;
      }
    };
    assert.equal(await classify(jsonResponse(401, { error: { message: 'No auth credentials found' } })), 'auth');
    assert.equal(await classify(jsonResponse(402, { error: { message: 'Insufficient credits' } })), 'quota');
    assert.equal(await classify(jsonResponse(400, { error: { message: 'vendor/x is not a valid model ID' } })), 'config');
    assert.equal(await classify(jsonResponse(404, { error: { message: 'No endpoints found for vendor/x (model)' } })), 'config');
    assert.equal(await classify(jsonResponse(400, { error: { message: 'bad json' } })), 'upstream');
    assert.equal(await classify(jsonResponse(500, { error: { message: 'boom' } })), 'upstream');
    // erreur en amont renvoyée avec un statut 200
    assert.equal(await classify(jsonResponse(200, { error: { code: 502, message: 'provider down' } })), 'upstream');
    // réponse vide
    assert.equal(await classify(jsonResponse(200, { choices: [{ message: { content: '' } }] })), 'upstream');
  });
});

test('OpenRouter + translateSegments : bout en bout avec un faux fetch', async () => {
  await withKey(async () => {
    const fetchImpl = async (_url, init) => {
      const user = JSON.parse(init.body).messages[1].content;
      // le modèle ajoute du bruit (préambule, balises de code) que le parseur doit ignorer
      const lines = user.split('\n').map((l) => l.replace(/^\[(\d+)\] (.*)$/, (_, n, t) => `[${n}] FR:${t}`));
      return ok('Voici la traduction :\n```\n' + lines.join('\n') + '\n```');
    };
    const complete = (a) => completeWithOpenRouter(a, opts(fetchImpl));
    const out = await translateSegments(segs(3), { from: 'en', to: 'fr', complete });
    assert.deepEqual(out.map((s) => s.text), ['FR:segment 1', 'FR:segment 2', 'FR:segment 3']);
  });
});

test('OpenRouter : réponse vide faute de budget (modèle « à raisonnement ») → réessai avec plus de budget et raisonnement réduit', async () => {
  await withKey(async () => {
    const bodies = [];
    const text = await completeWithOpenRouter({ ...args, maxTokens: 1000 }, opts(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? jsonResponse(200, { choices: [{ message: { content: '' }, finish_reason: 'length' }] }) : ok('[1] bonjour');
    }));
    assert.equal(text, '[1] bonjour');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].max_tokens, 1000);
    assert.equal(bodies[0].reasoning, undefined);
    assert.equal(bodies[1].max_tokens, 4000);
    assert.deepEqual(bodies[1].reasoning, { effort: 'low' });
  });
});

test('OpenRouter : toujours vide malgré le réessai → erreur de configuration qui nomme le modèle', async () => {
  await withKey(async () => {
    let calls = 0;
    const e = await completeWithOpenRouter(args, opts(async () => (calls++, jsonResponse(200, { choices: [{ message: { content: null }, finish_reason: 'length' }] })))).catch((x) => x);
    assert.equal(e.code, 'config');
    assert.match(e.message, /vendor\/cheap-model/);
    assert.match(e.message, /raisonnement/);
    assert.equal(calls, 2); // un essai + un essai boosté, pas d'acharnement
  });
});

test('OpenRouter : réponse bloquée par un filtre de contenu → erreur explicite, sans réessai', async () => {
  await withKey(async () => {
    let calls = 0;
    const e = await completeWithOpenRouter(args, opts(async () => (calls++, jsonResponse(200, { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] })))).catch((x) => x);
    assert.match(e.message, /filtre/);
    assert.match(e.message, /content_filter/);
    assert.equal(calls, 1);
  });
});

test('OpenRouter : contenu fourni en liste de parties', async () => {
  await withKey(async () => {
    const text = await completeWithOpenRouter(args, opts(async () => jsonResponse(200, { choices: [{ message: { content: [{ type: 'text', text: '[1] bon' }, { type: 'text', text: 'jour' }] } }] })));
    assert.equal(text, '[1] bonjour');
  });
});
