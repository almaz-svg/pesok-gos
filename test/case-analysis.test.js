import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeViolationCase } from '../src/case-analysis.js';

test('case analysis recognizes real Russian user text and returns readable drafts', () => {
  const analysis = analyzeViolationCase({
    description: 'Сосед поставил забор и перекрыл общий проход во двор',
    lat: 51.1693,
    lon: 71.4492,
    hasPhoto: true,
  });

  assert.equal(analysis.type, 'blocked_access');
  assert.match(analysis.typeLabel, /проход/i);
  assert.match(analysis.responsibleAuthority, /акимат|земельн|архитект/i);
  assert.match(analysis.officialDraft, /Прошу провести проверку/i);
  assert.match(analysis.officialDraft, /Сосед поставил забор/i);
  assert.match(analysis.nextAction, /Проверьте черновик/i);
});

test('case analysis turns a blocked passage complaint into an actionable passport', () => {
  const analysis = analyzeViolationCase({
    description: 'Сосед поставил забор и перекрыл общий проход во двор',
    lat: 51.1693,
    lon: 71.4492,
    hasPhoto: true,
  });

  assert.equal(analysis.type, 'blocked_access');
  assert.match(analysis.typeLabel, /проход/i);
  assert.match(analysis.responsibleAuthority, /акимат|земельн|архитект/i);
  assert.equal(analysis.urgency, 'high');
  assert.ok(analysis.evidenceChecklist.some(item => /фото/i.test(item)));
  assert.ok(analysis.evidenceChecklist.some(item => /геолокац|координат/i.test(item)));
  assert.match(analysis.officialDraft, /Прошу провести проверку/i);
  assert.match(analysis.officialDraft, /51\.1693, 71\.4492/);
  assert.match(analysis.officialDraft, /забор и перекрыл общий проход/i);
  assert.match(analysis.nextAction, /eOtinish/i);
});

test('case analysis detects illegal construction and asks for construction-specific proof', () => {
  const analysis = analyzeViolationCase({
    description: 'На участке начали стройку, копают котлован без паспорта объекта',
    lat: 43.2389,
    lon: 76.8897,
    hasPhoto: true,
  });

  assert.equal(analysis.type, 'illegal_construction');
  assert.match(analysis.responsibleAuthority, /архитектур|строительн/i);
  assert.ok(analysis.evidenceChecklist.some(item => /паспорт/i.test(item)));
  assert.ok(analysis.evidenceChecklist.some(item => /техник|работ/i.test(item)));
  assert.match(analysis.socialText, /стройк/i);
});

test('case analysis keeps uncertain complaints honest instead of inventing legal certainty', () => {
  const analysis = analyzeViolationCase({
    description: 'Что-то странное происходит на пустыре возле дома',
    lat: 51,
    lon: 71,
    hasPhoto: false,
  });

  assert.equal(analysis.type, 'other_land_issue');
  assert.equal(analysis.urgency, 'normal');
  assert.match(analysis.typeLabel, /требует уточнения/i);
  assert.ok(analysis.evidenceChecklist.some(item => /фото/i.test(item)));
  assert.doesNotMatch(analysis.officialDraft, /нарушен закон|незаконно установлено/i);
  assert.match(analysis.officialDraft, /прошу провести проверку/i);
});
