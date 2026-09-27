import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authPath,
  loginDestination,
  loginErrorMessage,
  validateLogin,
} from '../src/lib/login-form.js';
import { createApiClient } from '../src/lib/data-client.js';

test('sign-in only returns to supported internal workspaces', () => {
  for (const next of ['/map', '/reports', '/reports?view=analytics']) {
    assert.equal(loginDestination(next), next);
    assert.ok(authPath('/login', next).startsWith('/login'));
  }
  for (const next of [
    undefined,
    '//example.com',
    'https://example.com',
    '/\\example.com',
    '/login',
    '/register',
    'javascript:alert(1)',
    '/reports?next=//example.com',
  ])
    assert.equal(loginDestination(next), '/map');
  assert.equal(authPath('/register', '/reports'), '/register?next=%2Freports');
});

test('sign-in accepts existing passwords without imposing registration rules', () => {
  assert.deepEqual(validateLogin({ username: ' inspector ', password: ' a ' }), {});
  assert.ok(validateLogin({ username: ' ', password: '' }).username);
  assert.ok(validateLogin({ username: 'inspector', password: '' }).password);
  assert.ok(validateLogin({ username: 'x'.repeat(151), password: 'x' }).username);
  assert.equal(
    loginErrorMessage({ code: 'invalid_credentials', message: 'private diagnostics' }),
    'Неверный логин или пароль',
  );
  assert.equal(
    loginErrorMessage({ status: 429 }),
    'Слишком много попыток входа. Подождите и попробуйте снова.',
  );
});

test('leaving sign-in aborts its pending HTTP request', async () => {
  const controller = new AbortController();
  const client = createApiClient({
    fetchImpl: async (url, options) => {
      if (url.endsWith('auth/csrf'))
        return new Response(JSON.stringify({ csrf_token: 'test-token' }));
      assert.deepEqual(JSON.parse(options.body), { username: 'inspector', password: ' pass ' });
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Cancelled', 'AbortError')),
          { once: true },
        );
        queueMicrotask(() => controller.abort());
      });
    },
  });
  await assert.rejects(client.login('inspector', ' pass ', { signal: controller.signal }), {
    name: 'AbortError',
  });
});
