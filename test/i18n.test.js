import test from 'node:test';
import assert from 'node:assert/strict';
import { messages } from '../src/i18n/messages.js';
import { getLanguage, getLocale, setLanguage, subscribe, translateFor } from '../src/i18n/core.js';
import { formatDate } from '../src/lib/domain.js';

test('translations preserve every interpolation and provide both target languages', () => {
  const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [source, languages] of Object.entries(messages)) {
    for (const code of ['kk', 'en']) {
      assert.ok(languages[code]?.trim(), source + ': ' + code);
      assert.deepEqual(placeholders(languages[code]), placeholders(source), source + ': ' + code);
    }
  }
  assert.equal(translateFor('kk', 'Обзор'), 'Шолу');
  assert.equal(translateFor('en', 'Открыть {value0}', { value0: 'DEMO-123' }), 'Open DEMO-123');
  assert.equal(translateFor('en', 'Пользовательский текст {x}'), 'Пользовательский текст {x}');
});

test('language switches notify subscribers, format dates and reject unsupported values', () => {
  let changes = 0;
  const unsubscribe = subscribe(() => changes++);
  try {
    setLanguage('en');
    assert.equal(getLocale(), 'en-GB');
    assert.match(formatDate('2026-09-27'), /Sept?\b/);
    setLanguage('kk');
    assert.equal(formatDate(null), 'Тағайындалмаған');
    setLanguage('invalid');
    assert.equal(getLanguage(), 'kk');
    assert.equal(changes, 2);
    unsubscribe();
    setLanguage('ru');
    assert.equal(changes, 2);
  } finally {
    unsubscribe();
    setLanguage('ru');
  }
});
