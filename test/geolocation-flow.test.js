import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_MODE = 'mock';
process.env.OPENAI_API_KEY = '';
const { createBot } = await import('../src/bot.js');
const { mockApi, createMockApi } = await import('../src/mock-api.js');
const { messages } = await import('../src/i18n.js');

function conversation(language = 'ru', onReply = async () => {}) {
  let savedLanguage = language;
  const bot = createBot('test-token', { apiRoot: 'http://127.0.0.1:1' }, {
    preferences: {
      getLanguage: async () => savedLanguage,
      setLanguage: async (_, value) => { savedLanguage = value; },
    },
    assistant: { enabled: false },
  });
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };
  bot.catch(error => { throw error; });
  const replies = [];
  bot.context.reply = async function (text, extra) {
    replies.push({ text, extra, chatId: this.chat.id });
    await onReply(text, extra);
  };
  bot.context.answerCbQuery = async () => {};
  const from = { id: 101, is_bot: false, first_name: 'Test' };
  let id = 0;
  return {
    replies,
    async send(content, group = false) {
      const message = typeof content === 'string' ? { text: content } : content;
      if (message.text?.startsWith('/')) {
        message.entities = [{ type: 'bot_command', offset: 0, length: message.text.split(' ')[0].length }];
      }
      await bot.handleUpdate({ update_id: ++id, message: {
        message_id: id, date: 0, from,
        chat: { id: group ? -999 : 101, type: group ? 'supergroup' : 'private' }, ...message,
      } });
    },
    async click(data) {
      await bot.handleUpdate({ update_id: ++id, callback_query: {
        id: String(id), from, data, chat_instance: 'test',
        message: { message_id: 1, date: 0, chat: { id: 101, type: 'private' }, text: 'Test' },
      } });
    },
  };
}

const location = { location: { latitude: 51.12955, longitude: 71.4154, horizontal_accuracy: 25 } };
const photo = { photo: [{ file_id: 'test-photo', file_unique_id: 'test', width: 10, height: 10 }] };

test('a direct Telegram location is analyzed and persisted with the report across reopening', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zher-geo-'));
  const reportsFile = join(directory, 'reports.json');
  t.after(async () => { await rm(reportsFile, { force: true }); await rmdir(directory); });
  const store = createMockApi({ reportsFile });
  t.mock.method(mockApi, 'createReport', report => store.createReport(report));
  t.mock.method(mockApi, 'listReports', owner => store.listReports(owner));
  const chat = conversation();
  await chat.send(location);
  const analysis = chat.replies.find(reply => /OpenStreetMap/.test(reply.text));
  assert.ok(analysis, 'Direct location must produce an actual geographic result, not silence');
  assert.match(analysis.text, /Астана/);
  assert.match(analysis.text, /25/);
  const map = analysis.extra.reply_markup.inline_keyboard.flat().find(button => button.url);
  assert.match(map.url, /mlat=51.12955&mlon=71.4154/);
  assert.equal(chat.replies.at(-1).text, messages.ru.steps.photo);
  await chat.send(photo);
  await chat.send('The public passage is blocked.');
  const reports = await createMockApi({ reportsFile }).listReports(101);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].lat, 51.12955);
  assert.equal(reports[0].lon, 71.4154);
  assert.equal(reports[0].locationAnalysis.regions[0].id, 'KZ-71');
  assert.equal(reports[0].locationAnalysis.accuracyMeters, 25);
  assert.ok(reports[0].locationAnalysis.datasetTimestamp);
  const reopened = conversation();
  await reopened.click(`reports:open:${reports[0].id}`);
  const card = reopened.replies.map(reply => reply.text).join('');
  assert.match(card, /Астана/);
  assert.match(card, /OpenStreetMap/);
});

test('a first-message geolocation survives explicit Kazakh language selection', async () => {
  const chat = conversation(null);
  await chat.send(location);
  assert.match(chat.replies.at(-1).text, /Тілді таңдаңыз/);
  await chat.click('language:kk');
  assert.ok(chat.replies.some(reply => /Астана/.test(reply.text) && /OpenStreetMap/.test(reply.text)));
  assert.equal(chat.replies.at(-1).text, messages.kk.steps.photo);
});

test('invalid native coordinates cannot advance to a photo and can be corrected', async () => {
  const chat = conversation();
  await chat.send(messages.ru.report);
  for (const latitude of [NaN, Infinity, 91, '51.1']) {
    await chat.send({ location: { latitude, longitude: 71.1 } });
    assert.equal(chat.replies.at(-1).text, messages.ru.invalidLocation);
  }
  await chat.send(location);
  assert.equal(chat.replies.at(-1).text, messages.ru.steps.photo);
});

test('coordinates sent without a menu action receive the same geographic processing', async () => {
  const chat = conversation('kk');
  await chat.send('51.12955, 71.41540');
  assert.ok(chat.replies.some(reply => /Астана/.test(reply.text)));
  assert.equal(chat.replies.at(-1).text, messages.kk.steps.photo);
});

test('group location and text cannot complete or replace a private location draft', async t => {
  const saved = [];
  t.mock.method(mockApi, 'createReport', async report => { saved.push(report); return { id: 'DEMO-TEST', demoOnly: true }; });
  const chat = conversation();
  await chat.send(messages.ru.report);
  await chat.send(location);
  await chat.send(photo);
  await chat.send('Group reply that is not a report', true);
  await chat.send({ location: { latitude: 43.238949, longitude: 76.889709 } }, true);
  assert.equal(saved.length, 0);
  await chat.send('Private description');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].lat, 51.12955);
  assert.equal(saved[0].description, 'Private description');
});

test('a late report save cannot erase a newer location draft', async t => {
  let release;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  t.mock.method(mockApi, 'createReport', async () => {
    markStarted();
    return new Promise(resolve => { release = resolve; });
  });
  const chat = conversation();
  await chat.send(messages.ru.report);
  await chat.send(location);
  await chat.send(photo);
  const old = chat.send('Old description');
  await started;
  await chat.send('/cancel');
  await chat.send(messages.ru.report);
  release({ id: 'DEMO-OLD', demoOnly: true });
  await old;
  assert.ok(!chat.replies.at(-1).extra?.reply_markup, 'A late receipt must not replace the new draft keyboard');
  await chat.send(location);
  assert.equal(chat.replies.at(-1).text, messages.ru.steps.photo);
  await chat.send(photo);
  assert.equal(chat.replies.at(-1).text, messages.ru.steps.description);
});

test('venue and live location messages are snapshots, not continuous tracking', async t => {
  let saved;
  t.mock.method(mockApi, 'createReport', async report => { saved = report; return { id: 'DEMO-LIVE', demoOnly: true }; });
  const chat = conversation();
  await chat.send({ venue: { location: { latitude: 51.12955, longitude: 71.4154 }, title: 'Public site', address: 'Test' } });
  assert.equal(chat.replies.at(-1).text, messages.ru.steps.photo);
  await chat.send({ location: { ...location.location, live_period: 900 } });
  assert.ok(chat.replies.some(reply => /перемещение не отслеживается/.test(reply.text)));
  await chat.send(photo);
  await chat.send('Description');
  assert.equal(saved.locationAnalysis.live, true);
  assert.equal(saved.locationAnalysis.inputType, 'telegram');
});

test('a second description while a save is pending cannot create a duplicate report', async t => {
  let release;
  let markStarted;
  let saves = 0;
  const started = new Promise(resolve => { markStarted = resolve; });
  t.mock.method(mockApi, 'createReport', async () => {
    saves += 1;
    markStarted();
    return new Promise(resolve => { release = resolve; });
  });
  const chat = conversation();
  await chat.send(location);
  await chat.send(photo);
  const pending = chat.send('Description');
  await started;
  await chat.send('Description again');
  assert.equal(chat.replies.at(-1).text, messages.ru.reportSaving);
  assert.equal(saves, 1);
  release({ id: 'DEMO-ONE', demoOnly: true });
  await pending;
});

test('a delayed language welcome cannot restore a cancelled first-message location', async t => {
  let release;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const saves = t.mock.method(mockApi, 'createReport', async () => ({ id: 'DEMO-UNEXPECTED' }));
  const chat = conversation(null, async text => {
    if (text === messages.ru.welcome) {
      markStarted();
      await new Promise(resolve => { release = resolve; });
    }
  });
  await chat.send(location);
  const choosing = chat.click('language:ru');
  await started;
  await chat.send('/cancel');
  release();
  await choosing;
  assert.ok(!chat.replies.some(reply => /OpenStreetMap/.test(reply.text)));
  await chat.send(photo);
  await chat.send('Cancelled description');
  assert.equal(saves.mock.callCount(), 0);
});

test('a new valid point discards the old photo while invalid points leave a draft intact', async t => {
  const saved = [];
  t.mock.method(mockApi, 'createReport', async report => { saved.push(report); return { id: 'DEMO-GEO', demoOnly: true }; });
  const chat = conversation();
  await chat.send(location);
  await chat.send(photo);
  await chat.send({ location: { latitude: 91, longitude: 71 } });
  await chat.send('First description');
  assert.equal(saved[0].lat, location.location.latitude);
  await chat.send(location);
  await chat.send(photo);
  await chat.send({ location: { latitude: 43.238949, longitude: 76.889709 } });
  await chat.send('Do not reuse the old photo');
  assert.equal(saved.length, 1);
  assert.equal(chat.replies.at(-1).text, messages.ru.steps.photo);
  await chat.send({ photo: [{ ...photo.photo[0], file_id: 'new-photo' }] });
  await chat.send('Second description');
  assert.equal(saved.length, 2);
  assert.equal(saved[1].telegramFileId, 'new-photo');
  assert.equal(saved[1].locationAnalysis.regions[0].id, 'KZ-75');
});

test('cancelling before choosing a language removes the pending location', async () => {
  const chat = conversation(null);
  await chat.send(location);
  await chat.send('/cancel');
  await chat.click('language:ru');
  assert.ok(!chat.replies.some(reply => /OpenStreetMap/.test(reply.text)));
  assert.equal(chat.replies.at(-1).text, messages.ru.welcome);
});

test('a slow analysis reply does not ask for a photo already received', async () => {
  let release;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const chat = conversation('ru', async text => {
    if (/OpenStreetMap/.test(text)) {
      markStarted();
      await new Promise(resolve => { release = resolve; });
    }
  });
  const analyzing = chat.send(location);
  await started;
  await chat.send(photo);
  release();
  await analyzing;
  assert.equal(chat.replies.at(-1).text, messages.ru.steps.description);
});
