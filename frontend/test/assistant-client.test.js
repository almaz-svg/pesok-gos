import test from 'node:test';
import assert from 'node:assert/strict';
import { chatHistory, createAssistantClient } from '../src/lib/assistant-client.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('chat history retains complete recent turns within the server budget', () => {
  const turns = Array.from({ length: 12 }, (_, i) => ({
    question: `Вопрос ${i}`,
    answer: `Ответ ${i}`,
  }));
  turns.push({ question: 'Неотвеченный вопрос', answer: '' });
  const messages = chatHistory(turns, 'Следующий');
  assert.equal(messages.length, 13);
  assert.equal(messages[0].content, 'Вопрос 6');
  assert.deepEqual(messages.at(-1), { role: 'user', content: 'Следующий' });
  const large = chatHistory(
    Array.from({ length: 6 }, () => ({ question: 'q'.repeat(2000), answer: 'a'.repeat(6000) })),
    'q'.repeat(2000),
  );
  assert.equal(large.length, 7);
  assert.ok(large.reduce((sum, item) => sum + item.content.length, 0) <= 26000);
});

test('each send uses fresh CSRF and never adds a browser OpenAI credential', async () => {
  const calls = [];
  const client = createAssistantClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      return options.method === 'GET'
        ? json({ available: true, csrf_token: `token-${calls.length}` })
        : json({ reply: 'Ответ', truncated: false });
    },
  });
  await client.send([{ role: 'user', content: 'Карта?' }], '/map');
  await client.send([{ role: 'user', content: 'Мәртебелер?' }], '/reports', undefined, 'kk');
  assert.equal(calls[1].headers['X-CSRFToken'], 'token-1');
  assert.equal(calls[3].headers['X-CSRFToken'], 'token-3');
  assert.ok(calls.every((call) => call.credentials === 'include' && !call.headers.Authorization));
  assert.deepEqual(JSON.parse(calls[1].body), {
    messages: [{ role: 'user', content: 'Карта?' }],
    page: '/map',
    language: 'ru',
  });
  assert.equal(JSON.parse(calls[3].body).language, 'kk');
});

test('missing configuration prevents POST and provider errors stay out of the UI', async () => {
  let calls = 0;
  const unavailable = createAssistantClient({
    fetchImpl: async () => {
      calls++;
      return json({ available: false, csrf_token: 'token' });
    },
  });
  await assert.rejects(unavailable.send([], '/'), /пока недоступен/);
  assert.equal(calls, 1);
  const broken = createAssistantClient({
    fetchImpl: async () => json({ error: { message: 'secret-provider-detail' } }, 503),
  });
  await assert.rejects(
    broken.status(),
    (error) =>
      !error.message.includes('secret-provider-detail') && /недоступен/.test(error.message),
  );
});

test('cancellation and request timeout are distinguished', async () => {
  const waitForAbort = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  const client = createAssistantClient({ fetchImpl: waitForAbort, timeoutMs: 20 });
  await assert.rejects(client.status(), /Время ожидания/);
  const controller = new AbortController();
  const result = client.status(controller.signal);
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
});
