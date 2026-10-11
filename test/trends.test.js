// Tendances : comptage des mots dans le temps (nécessite Postgres via DATABASE_URL, sinon ignorés).
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

const enabled = Boolean(process.env.DATABASE_URL);
const P = 'TRDtest_';
const id = (n) => `${P}${String(n).padStart(3, '0')}`;
let db;
let tr;
let HttpError;

const add = async (n, { published = '2001-05-10', texts, translated = false, duration = null } = {}) => {
  const { rows } = await db.pool.query(
    `INSERT INTO videos (youtube_id, title, channel, published_at, source, lang, translated, duration_s) VALUES ($1, $2, 'Chaîne', $3, 'manual', 'fr', $4, $5) RETURNING id`,
    [id(n), `Vidéo ${n}`, published, translated, duration],
  );
  await db.withTransaction((c) => db.replaceSegments(c, rows[0].id, texts.map((text, i) => ({ start_ms: i * 1000, text }))));
  return rows[0].id;
};
const err = async (p) => p.then(() => null, (e) => e);
const withServer = async (fn) => {
  const { createApp } = await import('../src/server.js');
  const server = createApp().listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
};

before(async () => {
  if (!enabled) return;
  db = await import('../src/db.js');
  tr = await import('../src/trends.js');
  ({ HttpError } = await import('../src/http-error.js'));
  await db.initDb();
});
beforeEach(async () => {
  if (!enabled) return;
  tr.resetTrendsState();
  await db.pool.query(`DELETE FROM videos WHERE youtube_id LIKE '${P}%'`);
});
after(async () => {
  if (!enabled) return;
  await db.pool.query(`DELETE FROM videos WHERE youtube_id LIKE '${P}%'`);
  await db.pool.end();
});

/** Les autres tests insèrent des vidéos très anciennes ou futures : selon l'écart, l'affichage passe en années. */
const keyFor = (r, date) => (r.granularity === 'year' ? date.slice(0, 4) : date.slice(0, 7));
const pointFor = (r, s, date) => s.points[r.periods.findIndex((p) => p.key === keyFor(r, date))];

test('termes : saisie nettoyée, validée et dédoublonnée', () => {
  assert.deepEqual(tr.parseTerms(' Dette  publique , ÉCONOMIE ,dette publique').map((t) => [t.label, t.norm]), [
    ['Dette publique', 'dette publique'],
    ['ÉCONOMIE', 'economie'],
  ]);
  for (const bad of ['', '   ', ',,', 'a', 'un deux trois quatre cinq six sept', 'x'.repeat(61), 'a, bb, cc, dd, ee']) {
    assert.throws(() => tr.parseTerms(bad), (e) => e instanceof HttpError && e.status === 400, JSON.stringify(bad));
  }
  assert.equal(tr.parseTerms('a(b)\\m.*').map((t) => t.norm)[0], 'a b m'); // pas de caractère spécial dans le motif
  assert.equal(tr.termPattern('dette publique'), '\\mdette publique(?:s|x)?\\M');
});

test('accents : motif Postgres couvrant les graphies accentuées', () => {
  assert.equal(tr.accentPattern('securite'), 's[eéèêë][cç][uùûü]r[iîï]t[eéèêë]');
  assert.match(tr.accentPattern('coeur'), /\(\?:oe\|œ\|o\[éèêë\]\)/);
});

test('périodes : mois consécutifs, passage d\'une année à l\'autre', () => {
  assert.deepEqual(tr.monthsBetween('2023-11', '2024-02'), ['2023-11', '2023-12', '2024-01', '2024-02']);
  assert.deepEqual(tr.monthsBetween('2024-05', '2024-05'), ['2024-05']);
});

test('tendances : mots entiers, pluriel, accents ; exclut traduites, sans date et Shorts', { skip: !enabled }, async () => {
  await add(1, { published: '2001-05-10', texts: ['Le zzqtrend est là', 'des zzqtrends encore', 'Un zzqtrendiste ne compte pas'] });
  await add(2, { published: '2001-05-20', texts: ['zzqtrend', 'zzqtrend zzqtrend'] });
  await add(3, { published: '2001-07-01', texts: ['pas de mot ici mais zzqother'] });
  await add(4, { published: '2001-09-01', translated: true, texts: ['zzqtrend zzqtrend zzqtrend zzqtrend'] });
  await add(5, { published: null, texts: ['zzqtrend'] });
  await add(6, { published: '2001-06-01', duration: 40, texts: ['zzqtrend'] });
  await add(7, { published: '2001-06-15', texts: ['Zzqtrénd'] });

  const r = await tr.getTrends('zzqtrend, zzqother');
  assert.equal(r.series.length, 2);
  const [a, b] = r.series;
  assert.deepEqual([a.term, a.mentions, a.videos, a.first, a.last], ['zzqtrend', 6, 3, '2001-05-10', '2001-06-15']);
  assert.deepEqual([b.term, b.mentions, b.videos], ['zzqother', 1, 1]);
  assert.deepEqual(a.top_videos.map((v) => [v.youtube_id, v.mentions]), [[id(2), 3], [id(1), 2], [id(7), 1]]);
  assert.equal(a.points.length, r.periods.length);
  assert.equal(a.points.reduce((n, p) => n + p.mentions, 0), 6);
  // la période de mai 2001 : 5 mentions dans 2 vidéos (en mode « année », tout 2001 : 6 dans 3)
  const may = pointFor(r, a, '2001-05-10');
  assert.deepEqual([may.mentions, may.videos], r.granularity === 'year' ? [6, 3] : [5, 2]);
  assert.equal(a.peak.mentions, r.granularity === 'year' ? 6 : 5);
  // fréquence pour 10 000 mots = mentions / mots de la période
  const period = r.periods[r.periods.findIndex((p) => p.key === keyFor(r, '2001-05-10'))];
  assert.ok(period.words > 0 && period.videos >= 2);
  assert.ok(Math.abs(may.per10k - (may.mentions / period.words) * 10000) < 1e-9);
  assert.ok(r.base.translated_excluded >= 1 && r.base.undated_excluded >= 1);
  assert.ok(r.base.videos >= 4); // 1, 2, 3 et 7
});

test('tendances : un mot absent donne une courbe à zéro, et les mois sans vidéo n\'ont pas de fréquence', { skip: !enabled }, async () => {
  await add(1, { published: '2001-01-10', texts: ['bonjour'] });
  await add(2, { published: '2001-04-10', texts: ['bonjour'] });
  const r = await tr.getTrends('zzqabsent');
  const s = r.series[0];
  assert.deepEqual([s.mentions, s.videos, s.first, s.last, s.peak], [0, 0, null, null, null]);
  if (r.granularity === 'month') {
    const gap = r.periods.findIndex((p) => p.key === '2001-02');
    assert.ok(gap >= 0);
    assert.deepEqual([r.periods[gap].videos, s.points[gap].per10k], [0, null]); // pas de vidéo ce mois-là : trou, pas zéro
    assert.equal(s.points[r.periods.findIndex((p) => p.key === '2001-01')].per10k, 0);
  }
});

test('tendances : le cache suit les modifications des vidéos', { skip: !enabled }, async () => {
  await add(1, { texts: ['zzqcache'] });
  assert.equal((await tr.getTrends('zzqcache')).series[0].mentions, 1);
  await add(2, { texts: ['zzqcache zzqcache'] }); // une vidéo de plus : le résultat en cache n'est plus servi
  assert.equal((await tr.getTrends('zzqcache')).series[0].mentions, 3);
});

test('tendances : erreurs claires et limite par visiteur', { skip: !enabled }, async () => {
  assert.equal((await err(tr.getTrends(''))).status, 400);
  assert.equal((await err(tr.getTrends('a, bb, cc, dd, ee'))).status, 400);
  let last;
  for (let i = 0; i < 121; i++) last = await err(tr.getTrends(`zzqlimite${i}`, { ip: 'ip-limite' }));
  assert.equal(last.status, 429);
  assert.ok(!(await err(tr.getTrends('zzqautre', { ip: 'autre-visiteur' })))); // un autre visiteur n'est pas bloqué
  // un résultat déjà en cache est servi même à un visiteur au quota (d'autres tests modifient des vidéos en parallèle :
  // si le cache est invalidé entre les deux appels, on recommence)
  let served = false;
  for (let attempt = 0; attempt < 5 && !served; attempt++) {
    await tr.getTrends('zzqpartage', { ip: `amorce-${attempt}` });
    served = !(await err(tr.getTrends('zzqpartage', { ip: 'ip-limite' })));
  }
  assert.ok(served);
});

test('mots les plus prononcés : sans mots-outils, singulier et pluriel regroupés', { skip: !enabled }, async () => {
  await add(1, { texts: [`${'zzqfavori '.repeat(50)} ${'zzqfavoris '.repeat(3)} ${'toujours '.repeat(90)} ${'Zzqéléphant '.repeat(60)}`] });
  const words = await tr.getTopWords({ limit: 200 });
  assert.ok(words.some((x) => x.word === 'zzqéléphant'), 'les accents sont restitués à l\'affichage');
  const w = words.find((x) => x.word === 'zzqfavori');
  assert.ok(w, 'le mot favori est présent');
  assert.equal(w.mentions, 53);
  assert.ok(!words.some((x) => x.word === 'toujours' || x.word === 'zzqfavoris'));
});

test('API : /api/trends et /api/trends/words', { skip: !enabled }, async () => {
  await add(1, { texts: ['zzqapi zzqapi'] });
  await withServer(async (base) => {
    const ok = await fetch(`${base}/api/trends?q=${encodeURIComponent('zzqapi')}`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('cache-control'), /max-age=300/);
    const body = await ok.json();
    assert.equal(body.series[0].mentions, 2);
    assert.deepEqual(Object.keys(body).sort(), ['base', 'granularity', 'periods', 'series']);
    const bad = await fetch(`${base}/api/trends?q=`);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /mot/);
    assert.equal((await fetch(`${base}/api/trends?q=a,bb,cc,dd,ee`)).status, 400);
    const words = await (await fetch(`${base}/api/trends/words`)).json();
    assert.ok(Array.isArray(words.words));
  });
});
