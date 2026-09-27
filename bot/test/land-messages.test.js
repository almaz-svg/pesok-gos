import test from 'node:test';
import assert from 'node:assert/strict';
import { caseText, eventText } from '../src/land/messages.js';

test('a verified boundary is not described as absent when imagery is insufficient', () => {
  const record = { id: '123456abcdef', area: { lat: 51, lon: 71, width: 25, height: 25 },
    evidence: [], localStatus: 'open', watch: { enabled: false },
    analysis: { status: 'insufficient_data', validFraction: 0.5, before: { id: 'before' }, after: { id: 'after' },
      boundary: { status: 'verified', outsideHectares: null } }, boundary: { verifiedBy: '77', source: 'Document' } };
  assert.doesNotMatch(caseText(record, 'ru'), /Нет подтверждённого контура/);
  assert.doesNotMatch(caseText(record, 'kk'), /Расталған жұмыс контуры жоқ/);
});

test('an old pending event keeps its own acquisition date after a newer manual analysis', () => {
  const text = eventText({ id: 'case', language: 'ru', analysis: { after: { datetime: '2030-01-01' } } },
    { analysisAfterId: 'old', analysisAfterDate: '2026-09-10', additionalHectares: 0.16 });
  assert.match(text, /2026-09-10/);
  assert.doesNotMatch(text, /2030/);
});
