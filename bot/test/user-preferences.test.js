import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUserPreferences, userPreferences } from '../src/user-preferences.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zher-preferences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preferencesFile = join(directory, 'data', 'user-preferences.json');
  return { directory, preferencesFile, store: createUserPreferences({ preferencesFile }) };
}

test('missing preferences are absent without creating a file', async t => {
  const { directory, store } = await fixture(t);
  assert.equal(await store.getLanguage(101), undefined);
  assert.deepEqual(await readdir(directory), []);
  assert.equal(typeof userPreferences.getLanguage, 'function');
  assert.equal(typeof userPreferences.setLanguage, 'function');
});

test('two users retain independent languages on disk and after reopening', async t => {
  const { directory, preferencesFile, store } = await fixture(t);
  await store.setLanguage(101, 'ru');
  assert.deepEqual(JSON.parse(await readFile(preferencesFile, 'utf8')), {
    101: { language: 'ru' },
  });
  await store.setLanguage('202', 'kk');
  assert.equal(await store.getLanguage('101'), 'ru');
  assert.equal(await store.getLanguage(202), 'kk');
  assert.deepEqual(JSON.parse(await readFile(preferencesFile, 'utf8')), {
    101: { language: 'ru' },
    202: { language: 'kk' },
  });

  const reopened = createUserPreferences({ preferencesFile });
  assert.equal(await reopened.getLanguage(101), 'ru');
  assert.equal(await reopened.getLanguage('202'), 'kk');
  assert.equal(await reopened.getLanguage(303), undefined);
  await reopened.setLanguage('101', 'kk');
  assert.equal(await store.getLanguage(101), 'kk');
  assert.equal(await store.getLanguage(202), 'kk');
  assert.deepEqual(await readdir(join(directory, 'data')), ['user-preferences.json']);
});

test('updates preserve other fields and accept the largest safe user ID', async t => {
  const { directory } = await fixture(t);
  const preferencesFile = join(directory, 'existing.json');
  await writeFile(preferencesFile, JSON.stringify({
    101: { language: 'ru', notifications: false, settings: { example: 1 } },
    202: { language: 'kk' },
  }));
  const store = createUserPreferences({ preferencesFile });
  await store.setLanguage('101', 'kk');
  await store.setLanguage(Number.MAX_SAFE_INTEGER, 'ru');
  assert.deepEqual(JSON.parse(await readFile(preferencesFile, 'utf8')), {
    101: { language: 'kk', notifications: false, settings: { example: 1 } },
    202: { language: 'kk' },
    9007199254740991: { language: 'ru' },
  });
  assert.equal(await store.getLanguage('9007199254740991'), 'ru');
});

test('concurrent writes preserve every user and reads wait for queued updates', async t => {
  const { preferencesFile, store } = await fixture(t);
  const writes = [
    store.setLanguage(101, 'ru'),
    store.setLanguage(202, 'kk'),
    store.setLanguage(303, 'ru'),
    store.setLanguage('101', 'kk'),
    store.setLanguage(404, 'kk'),
    store.setLanguage('202', 'ru'),
  ];
  const read = store.getLanguage(101);
  const results = await Promise.all([...writes, read]);
  assert.equal(results.at(-1), 'kk');
  assert.deepEqual(JSON.parse(await readFile(preferencesFile, 'utf8')), {
    101: { language: 'kk' },
    202: { language: 'ru' },
    303: { language: 'ru' },
    404: { language: 'kk' },
  });
});

test('invalid owners reject for reads and writes without changing saved preferences', async t => {
  const { preferencesFile, store } = await fixture(t);
  await store.setLanguage(101, 'ru');
  const original = await readFile(preferencesFile, 'utf8');
  for (const owner of [
    undefined, null, '', 'undefined', 0, -1, 1.5, NaN, Infinity,
    Number.MAX_SAFE_INTEGER + 1, '9007199254740992', '01', ' 101', '101 ',
    '+101', '1e2', true, {}, [], 101n, '__proto__', 'constructor',
  ]) {
    await assert.rejects(() => store.getLanguage(owner));
    await assert.rejects(() => store.setLanguage(owner, 'kk'));
  }
  assert.equal(await readFile(preferencesFile, 'utf8'), original);
  assert.equal(await store.getLanguage(101), 'ru');
});

test('languages must be exactly ru or kk before any file is created or changed', async t => {
  const { directory, preferencesFile, store } = await fixture(t);
  const invalid = [undefined, null, '', 'en', 'RU', 'KK', ' ru', 'kk ', 1, {}, ['ru']];
  for (const language of invalid) {
    await assert.rejects(() => store.setLanguage(101, language), /language/i);
  }
  assert.deepEqual(await readdir(directory), []);
  await store.setLanguage(101, 'ru');
  const original = await readFile(preferencesFile, 'utf8');
  for (const language of invalid) {
    await assert.rejects(() => store.setLanguage(101, language), /language/i);
  }
  assert.equal(await readFile(preferencesFile, 'utf8'), original);
  await store.setLanguage(202, 'kk');
  assert.equal(await store.getLanguage(101), 'ru');
  assert.equal(await store.getLanguage(202), 'kk');
});

test('corrupt existing files reject reads and writes without overwriting data', async t => {
  const { directory } = await fixture(t);
  const preferencesFile = join(directory, 'corrupt.json');
  const store = createUserPreferences({ preferencesFile });
  for (const content of [
    '', '{broken', 'null', '[]', '"ru"', '42',
    '{"101":null}', '{"101":[]}', '{"101":"ru"}', '{"101":{}}',
    '{"101":{"language":"en"}}', '{"101":{"language":"RU"}}',
    '{"0":{"language":"ru"}}', '{"9007199254740992":{"language":"kk"}}',
    '{"__proto__":{"language":"ru"}}',
  ]) {
    await writeFile(preferencesFile, content);
    await assert.rejects(() => store.getLanguage(101), `Should reject ${content}`);
    await assert.rejects(() => store.setLanguage(202, 'kk'), `Should preserve ${content}`);
    assert.equal(await readFile(preferencesFile, 'utf8'), content);
  }
  assert.deepEqual(await readdir(directory), ['corrupt.json']);

  await writeFile(preferencesFile, '{"101":{"language":"ru"}}');
  await store.setLanguage(202, 'kk');
  assert.equal(await store.getLanguage(101), 'ru');
  assert.equal(await store.getLanguage(202), 'kk');
});

test('filesystem errors reject the save and do not poison later writes', async t => {
  const { directory, preferencesFile, store } = await fixture(t);
  const blockedParent = join(directory, 'data');
  await writeFile(blockedParent, 'blocked');
  await assert.rejects(() => store.setLanguage(101, 'ru'));
  assert.equal(await readFile(blockedParent, 'utf8'), 'blocked');
  await rm(blockedParent);

  await mkdir(preferencesFile, { recursive: true });
  await assert.rejects(() => store.getLanguage(101));
  await assert.rejects(() => store.setLanguage(101, 'ru'));
  assert.deepEqual(await readdir(preferencesFile), []);
  await rm(preferencesFile, { recursive: true });

  await store.setLanguage(202, 'kk');
  assert.deepEqual(JSON.parse(await readFile(preferencesFile, 'utf8')), {
    202: { language: 'kk' },
  });
  assert.equal(await store.getLanguage(101), undefined);
});
