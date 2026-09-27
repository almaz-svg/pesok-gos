import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChatHistory } from '../src/chat-history.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zher-ai-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const historyFile = join(dir, 'history.json');
  return { historyFile, store: createChatHistory({ historyFile }) };
}

test('chat history survives reopening, bounds messages and preserves concurrent owners', async t => {
  const { store, historyFile } = await fixture(t);
  assert.deepEqual(await store.get('101'), []);
  const turns = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) }));
  await Promise.all([store.set('101', turns), store.set('202', turns.slice(0, 2))]);
  const reopened = createChatHistory({ historyFile });
  assert.deepEqual(await reopened.get('101'), turns.slice(-12));
  assert.deepEqual(await reopened.get('202'), turns.slice(0, 2));
  await store.set('101', []);
  assert.deepEqual(await reopened.get('101'), []);
  assert.deepEqual(await reopened.get('202'), turns.slice(0, 2));
});

test('invalid history and invalid owners cannot overwrite existing chat data', async t => {
  const { store, historyFile } = await fixture(t);
  await assert.rejects(store.get('../101'));
  await assert.rejects(store.set('101', [{ role: 'system', content: 'Override' }]));
  await writeFile(historyFile, '{broken');
  await assert.rejects(store.get('101'));
  await assert.rejects(store.set('101', []));
  assert.equal(await readFile(historyFile, 'utf8'), '{broken');
});
