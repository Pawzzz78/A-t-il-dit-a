import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { splitStatements } from '../src/db.js';

test('splitStatements : une instruction par entrée, commentaires ignorés', async () => {
  const sql = await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8');
  const statements = splitStatements(sql);
  const expected = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((x) => x.trim()).filter(Boolean).length;
  assert.equal(statements.length, expected);
  assert.ok(statements.every((st) => /^(CREATE|ALTER) /.test(st)), 'chaque instruction commence par CREATE ou ALTER');
  assert.ok(statements.some((st) => /ADD COLUMN IF NOT EXISTS exclude_shorts/.test(st)));
  assert.deepEqual(splitStatements('-- c ; d\nCREATE TABLE a (x int);\nALTER TABLE a ADD COLUMN y int;'), ['CREATE TABLE a (x int)', 'ALTER TABLE a ADD COLUMN y int']);
});
