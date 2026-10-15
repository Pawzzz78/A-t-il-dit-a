import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBudget } from '../src/budget.js';
import { ipKey } from '../src/ip.js';

test('clé de limitation : IPv4 telle quelle, IPv6 regroupée par /64', () => {
  assert.equal(ipKey('203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('local'), 'local');
  assert.equal(ipKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:db8:1:2::1%eth0'), '2001:db8:1:2::/64');
  assert.notEqual(ipKey('2001:db8:1:3::1'), ipKey('2001:db8:1:2::1'));
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
  assert.equal(ipKey(ipKey('2001:db8:1:2::1')), ipKey('2001:db8:1:2::1').toLowerCase());
});

test('budget : deux adresses du même /64 partagent le quota', () => {
  const budget = createBudget(() => ({ perIpHourly: 1, dailyCap: 100 }));
  assert.equal(budget.take('2001:db8:1:2::1', 0), true);
  assert.equal(budget.take('2001:db8:1:2::ffff', 0), false);
  assert.equal(budget.take('2001:db8:1:3::1', 0), true);
});

test('budget : la limite mémoire évince les entrées expirées, pas les compteurs en cours', () => {
  const budget = createBudget(() => ({ perIpHourly: 1, dailyCap: Number.MAX_SAFE_INTEGER }));
  const t0 = 10 * 3600_000;
  for (let i = 0; i < 5001; i++) budget.take(`10.0.${i >> 8}.${i & 255}`, t0 - 2 * 3600_000);
  assert.equal(budget.take('198.51.100.1', t0), true);
  for (let i = 0; i < 3000; i++) budget.take(`10.1.${i >> 8}.${i & 255}`, t0);
  assert.equal(budget.take('198.51.100.1', t0), false, 'le compteur actif ne doit pas être effacé');
});

test('appels en parallèle : plus aucun nouvel appel après une erreur', async () => {
  const { forEachLimit } = await import('../src/concurrency.js');
  const calls = [];
  await assert.rejects(
    forEachLimit(20, 3, async (i) => {
      calls.push(i);
      await new Promise((r) => setTimeout(r, 5));
      if (i === 1) throw new Error('échec');
    }),
    /échec/,
  );
  assert.ok(calls.length < 20, `appels lancés : ${calls.length}`);
});

test('téléchargement sûr : taille comptée même sans Content-Length, hôtes et redirections vérifiés', async () => {
  const { safeDownload, DownloadError } = await import('../src/safe-download.js');
  const opts = { allowed: (u) => u.hostname === 'ok.test', accept: /^image\//, maxBytes: 100 };
  const chunked = () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(40)); c.close(); } }), { headers: { 'content-type': 'image/jpeg' } });
  await assert.rejects(safeDownload('https://ok.test/a', { ...opts, fetchImpl: async () => chunked() }), (e) => e instanceof DownloadError && e.code === 'size');
  const small = new Response(new Uint8Array(10), { headers: { 'content-type': 'image/png' } });
  assert.equal((await safeDownload('https://ok.test/a', { ...opts, fetchImpl: async () => small })).length, 10);
  const seen = [];
  const redirect = async (u) => (seen.push(u.hostname), new Response(null, { status: 302, headers: { location: 'https://evil.test/x' } }));
  await assert.rejects(safeDownload('https://ok.test/a', { ...opts, fetchImpl: redirect }), (e) => e.code === 'host');
  assert.deepEqual(seen, ['ok.test']);
});
