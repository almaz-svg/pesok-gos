import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { analyzeViolationCase } from '../src/case-analysis.js';

// Import the real bot without loading local credentials or enabling external AI.
process.env.DATA_MODE = 'api';
process.env.API_BASE_URL = 'http://report-card.test/api';
process.env.OPENAI_API_KEY = '';
const dotenvConfig = mock.method(dotenv, 'config', () => ({ parsed: {} }));
const { createBot } = await import('../src/bot.js');
dotenvConfig.mock.restore();

const locales = {
  ru: {
    description: 'Сосед перекрыл проход забором. ',
    passport: 'Паспорт нарушения',
    coordinates: 'Координаты:',
    nextStep: 'Следующий шаг:',
    drafts: {
      official: 'Черновик официального обращения',
      followup: 'Повторное обращение',
      complaint: 'Жалоба на бездействие',
      public: 'Публичный текст',
    },
  },
  kk: {
    description: 'Көрші ортақ жолды қоршаумен жауып тастады. ',
    passport: 'Бұзушылық паспорты',
    coordinates: 'Координаттары:',
    nextStep: 'Келесі қадам:',
    drafts: {
      official: 'Ресми өтініш жобасы',
      followup: 'Қайта өтініш',
      complaint: 'Әрекетсіздік туралы шағым',
      public: 'Жария мәтін',
    },
  },
};
const draftFields = {
  official: 'officialDraft',
  followup: 'followUpDraft',
  complaint: 'inactivityComplaintDraft',
  public: 'publicText',
};

function reportFor(language) {
  const description = locales[language].description.padEnd(1998, 'я') + '\u{1F4CD}';
  return {
    id: 'REP-LENGTH',
    telegramUserId: '101',
    status: 'signal_received',
    demoOnly: true,
    createdAt: '2026-09-20T12:00:00Z',
    updatedAt: '2026-09-25T12:00:00Z',
    description,
    lat: 51.1693,
    lon: 71.4492,
    telegramFileId: 'synthetic-photo',
    casePassport: analyzeViolationCase({ description, lat: 51.1693, lon: 71.4492, hasPhoto: true }),
  };
}

function conversation(t, language, record) {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://report-card.test/api/reports?telegramUserId=101');
    assert.equal(options.method || 'GET', 'GET');
    return Response.json({ reports: [record] });
  });
  const bot = createBot('synthetic-token', {}, {
    preferences: { getLanguage: async () => language },
    assistant: { enabled: false, cancel() {} },
  });
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };
  bot.catch(error => { throw error; });
  t.mock.method(Object.getPrototypeOf(bot.telegram), 'callApi', async method => {
    throw new Error(`Unexpected Telegram call: ${method}`);
  });
  const replies = [];
  const photos = [];
  const user = { id: 101, is_bot: false, first_name: 'Test' };
  const chat = { id: 101, type: 'private' };
  let updateId = 0;
  let answeredCallbacks = 0;
  bot.context.reply = async (text, extra) => {
    replies.push({ text, extra });
    if (text.length > 4096) throw new Error('400: Bad Request: message is too long');
  };
  bot.context.replyWithPhoto = async (photo, extra) => { photos.push({ photo, extra }); };
  bot.context.answerCbQuery = async () => { answeredCallbacks += 1; };
  return {
    photos,
    get answeredCallbacks() { return answeredCallbacks; },
    async click(data) {
      const start = replies.length;
      await bot.handleUpdate({ update_id: ++updateId, callback_query: {
        id: String(updateId), from: user, chat_instance: 'synthetic', data,
        message: { message_id: 1, date: 0, chat, text: 'Cabinet' },
      } });
      return replies.slice(start);
    },
  };
}

function buttons(reply) {
  return reply?.extra?.reply_markup?.inline_keyboard?.flat() || [];
}

function callback(reply, data) {
  const button = buttons(reply).find(item => item.callback_data === data);
  assert.ok(button, `Missing action: ${data}`);
  assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  return button.callback_data;
}

function deliveredText(replies) {
  assert.ok(replies.length > 0);
  for (const [index, reply] of replies.entries()) {
    assert.ok(reply.text.length > 0 && reply.text.length <= 3500,
      `Reply ${index + 1} has ${reply.text.length} UTF-16 code units; expected 1..3500`);
    assert.equal(reply.text.isWellFormed(), true, 'A chunk must not break a surrogate pair');
    if (index < replies.length - 1) assert.equal(reply.extra?.reply_markup, undefined);
  }
  assert.ok(buttons(replies.at(-1)).length > 0, 'The last chunk must carry the actions');
  return replies.map(reply => reply.text).join('');
}

for (const [language, copy] of Object.entries(locales)) {
  test(`${language}: generated passport with a 2000-unit description fits and retains all actions`, async t => {
    const record = reportFor(language);
    assert.equal(record.description.length, 2000);
    const chat = conversation(t, language, record);
    const replies = await chat.click('reports:open:REP-LENGTH');
    const text = deliveredText(replies);
    assert.ok(replies.length > 1);
    assert.ok(text.includes(record.description));
    assert.ok(text.includes(copy.passport));
    assert.ok(text.includes(`${copy.coordinates} 51.1693, 71.4492`));
    assert.ok(text.includes(copy.nextStep));
    for (const value of [record.casePassport.typeLabel, record.casePassport.responsibleAuthority,
      ...record.casePassport.evidenceChecklist, record.casePassport.officialDraft]) {
      assert.ok(text.includes(value), 'The card must retain the generated passport text');
    }
    for (const reply of replies) assert.equal(reply.extra.link_preview_options.is_disabled, true);
    const card = replies.at(-1);
    assert.equal(buttons(card).find(button => button.url)?.url,
      'https://www.openstreetmap.org/?mlat=51.1693&mlon=71.4492#map=17/51.1693/71.4492');
    assert.ok(buttons(card).some(button => button.url === 'https://eotinish.kz/ru'));

    await chat.click(callback(card, 'reports:photo:REP-LENGTH'));
    assert.equal(chat.photos[0].photo, 'synthetic-photo');
    for (const [kind, field] of Object.entries(draftFields)) {
      const draft = await chat.click(callback(card, `reports:draft:${kind}:REP-LENGTH`));
      assert.equal(deliveredText(draft), `${copy.drafts[kind]}\n\n${record.casePassport[field]}`);
      callback(draft.at(-1), 'reports:open:REP-LENGTH');
    }
    assert.equal(deliveredText(await chat.click(callback(card, 'reports:open:REP-LENGTH'))), text);
    const list = await chat.click(callback(card, 'reports:page:0'));
    callback(list.at(-1), 'reports:open:REP-LENGTH');
    const menu = await chat.click(callback(card, 'reports:menu'));
    assert.ok(menu.at(-1).extra.reply_markup.keyboard.length > 0);
    assert.equal(chat.answeredCallbacks, 9);
  });

  test(`${language}: card chunks retain long emoji drafts without broken surrogate pairs`, async t => {
    const record = reportFor(language);
    const chat = conversation(t, language, record);
    for (const prefix of ['', 'x']) {
      record.casePassport.officialDraft = `${prefix}${'\u{1F4CD}'.repeat(4000)} END`;
      const replies = await chat.click('reports:open:REP-LENGTH');
      const text = deliveredText(replies);
      assert.ok(replies.length >= 3);
      assert.ok(text.includes(record.casePassport.officialDraft));
      assert.ok(text.includes(record.description));
      assert.ok(text.includes(copy.nextStep));
      callback(replies.at(-1), 'reports:draft:official:REP-LENGTH');
    }
  });

  test(`${language}: every draft callback preserves full text at UTF-16 chunk boundaries`, async t => {
    const record = reportFor(language);
    const chat = conversation(t, language, record);
    for (const [kind, field] of Object.entries(draftFields)) {
      const heading = `${copy.drafts[kind]}\n\n`;
      for (const length of [3499, 3500, 3501, 7001]) {
        record.casePassport[field] = 'x'.repeat(length - heading.length - 2) + '\u{1F4CD}';
        const replies = await chat.click(`reports:draft:${kind}:REP-LENGTH`);
        assert.equal(deliveredText(replies), heading + record.casePassport[field]);
        assert.equal(replies.length, Math.ceil(length / 3500));
        callback(replies.at(-1), 'reports:open:REP-LENGTH');
        callback(replies.at(-1), 'reports:page:0');
        callback(replies.at(-1), 'reports:menu');
      }
    }
  });
}

test('a short legacy report still uses one message with its actions', async t => {
  const record = { ...reportFor('ru'), description: 'Short description', casePassport: undefined };
  const chat = conversation(t, 'ru', record);
  const replies = await chat.click('reports:open:REP-LENGTH');
  assert.equal(replies.length, 1);
  assert.ok(deliveredText(replies).includes('Short description'));
  callback(replies[0], 'reports:photo:REP-LENGTH');
  callback(replies[0], 'reports:page:0');
});
