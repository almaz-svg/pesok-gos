import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { createAiAssistant, getAiConfig } from '../src/ai-assistant.js';

function memory() {
  const rows = new Map();
  return {
    async get(id) { return structuredClone(rows.get(id) || []); },
    async set(id, messages) { rows.set(id, structuredClone(messages)); },
  };
}

test('AI settings are optional and never require a key for normal bot startup', async () => {
  assert.deepEqual(getAiConfig({}), { apiKey: '', model: 'gpt-4.1-mini' });
  assert.deepEqual(getAiConfig({ OPENAI_API_KEY: ' key ', OPENAI_MODEL: ' model ' }), { apiKey: 'key', model: 'model' });
  const assistant = createAiAssistant({ settings: getAiConfig({}) });
  assert.equal(assistant.enabled, false);
  await assert.rejects(assistant.ask('101', 'Hello', 'ru'), { code: 'AI_DISABLED' });
});

test('official SDK sends conversation and only owned report context to Responses API', async () => {
  const requests = [];
  const history = memory();
  const client = new OpenAI({
    apiKey: 'test-key', maxRetries: 0,
    fetch: async (url, options) => {
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ id: 'resp_test', object: 'response', status: 'completed', output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Когда появился забор?', annotations: [] }] },
      ] }), { headers: { 'content-type': 'application/json' } });
    },
  });
  const assistant = createAiAssistant({
    settings: { apiKey: 'test-key', model: 'gpt-4.1-mini' }, client, history,
    loadReports: async () => [
      { id: 'DEMO-1', telegramUserId: '101', description: 'Fence', status: 'signal_received', demoOnly: true, lat: 51, lon: 71 },
      { id: 'PRIVATE', telegramUserId: '202', description: 'Foreign secret' },
    ],
  });
  assert.equal(await assistant.ask('101', 'Перекрыли проход', 'ru'), 'Когда появился забор?');
  await assistant.ask('101', 'Вчера', 'kk');
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].model, 'gpt-4.1-mini');
  assert.match(JSON.stringify(requests[0].input), /DEMO-1/);
  assert.doesNotMatch(JSON.stringify(requests), /Foreign secret|PRIVATE|test-key/);
  assert.match(requests[1].instructions, /Kazakh/);
  assert.ok(requests[1].input.some(item => item.role === 'assistant' && item.content === 'Когда появился забор?'));
  assert.ok(requests[1].input.some(item => item.role === 'user' && item.content === 'Перекрыли проход'));
  assert.equal((await history.get('101')).length, 4);
  await assistant.ask('202', 'Другая проблема', 'ru');
  assert.doesNotMatch(JSON.stringify(requests[2].input), /Перекрыли проход|Вчера|Когда появился/);
  await assistant.reset('101');
  assert.deepEqual(await history.get('101'), []);
  assert.equal((await history.get('202')).length, 2);
});

test('provider failures and empty replies do not overwrite history or expose provider errors', async () => {
  for (const outcome of [new Error('secret-key-in-error'), { status: 'completed', output_text: '' }, { status: 'incomplete', output_text: 'Partial' }]) {
    const history = memory();
    const previous = [{ role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Answer' }];
    await history.set('101', previous);
    const assistant = createAiAssistant({
      settings: { apiKey: 'test', model: 'test' }, history, loadReports: async () => [],
      client: { responses: { create: async () => { if (outcome instanceof Error) throw outcome; return outcome; } } },
    });
    await assert.rejects(assistant.ask('101', 'Next', 'ru'), error => {
      assert.equal(error.code, 'AI_UNAVAILABLE');
      assert.doesNotMatch(error.message, /secret-key/);
      return true;
    });
    assert.deepEqual(await history.get('101'), previous);
  }
});

test('parallel requests for one owner are rejected and reset discards an in-flight answer', async () => {
  let finish;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const history = memory();
  const assistant = createAiAssistant({
    settings: { apiKey: 'test', model: 'test' }, history, loadReports: async () => [],
    client: { responses: { create: async () => { started(); return new Promise(resolve => { finish = resolve; }); } } },
  });
  const running = assistant.ask('101', 'First', 'ru');
  const rejected = assert.rejects(running, { code: 'AI_CANCELLED' });
  await ready;
  await assert.rejects(assistant.ask('101', 'Second', 'ru'), { code: 'AI_BUSY' });
  await assistant.reset('101');
  finish({ status: 'completed', output_text: 'Obsolete answer' });
  await rejected;
  assert.deepEqual(await history.get('101'), []);
});

test('missing backend is marked unavailable and input limits fail before provider calls', async () => {
  let request;
  const assistant = createAiAssistant({
    settings: { apiKey: 'test', model: 'test' }, history: memory(),
    loadReports: async () => { throw new Error('Backend down'); },
    client: { responses: { create: async body => { request = body; return { status: 'completed', output_text: 'Please clarify' }; } } },
  });
  await assert.rejects(assistant.ask('101', 'x'.repeat(2001), 'ru'), { code: 'AI_INPUT' });
  assert.equal(request, undefined);
  await assistant.ask('101', 'Help', 'ru');
  assert.match(JSON.stringify(request.input), /unavailable/);
});
