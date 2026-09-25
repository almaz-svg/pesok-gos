import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_MODE = 'mock';
const { createBot } = await import('../src/bot.js');
const { mockApi } = await import('../src/mock-api.js');

function preferences(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    async getLanguage(id) { return values.get(String(id)); },
    async setLanguage(id, language) { values.set(String(id), language); },
  };
}

function conversation(store, { userId = 101, chatType = 'private', failCallbackAnswer = false, onCallbackAnswer } = {}) {
  const bot = createBot('test-token', {}, { preferences: store });
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };
  bot.catch(error => { throw error; });
  const replies = [];
  const user = { id: userId, is_bot: false, first_name: 'Test', language_code: 'kk' };
  const chat = { id: chatType === 'private' ? userId : -999, type: chatType };
  let updateId = 0;
  bot.context.reply = async (text, extra) => { replies.push({ text, extra }); };
  bot.context.answerCbQuery = async function () {
    if (onCallbackAnswer) await onCallbackAnswer(this.callbackQuery.data);
    if (failCallbackAnswer) throw new Error('Query expired');
  };
  return {
    replies,
    async send(content) {
      const message = typeof content === 'string' ? { text: content } : content;
      if (message.text?.startsWith('/')) {
        message.entities = [{ type: 'bot_command', offset: 0, length: message.text.split(' ')[0].length }];
      }
      await bot.handleUpdate({ update_id: ++updateId, message: {
        message_id: updateId, date: 0, chat, from: user, ...message,
      } });
    },
    async click(data) {
      await bot.handleUpdate({ update_id: ++updateId, callback_query: {
        id: String(updateId), from: user, chat_instance: 'test', data,
        message: { message_id: 1, date: 0, chat, text: 'Language' },
      } });
    },
  };
}

function labels(reply) {
  return (reply?.extra?.reply_markup?.keyboard || []).flat().map(button => typeof button === 'string' ? button : button.text);
}

function assertLanguagePicker(reply) {
  assert.match(reply?.text || '', /Выберите язык/);
  assert.match(reply.text, /Тілді таңдаңыз/);
  assert.doesNotMatch(reply.text, /function|execute\(|async|=>/, 'The language prompt must not expose middleware code');
  const options = reply.extra.reply_markup.inline_keyboard.flat();
  assert.deepEqual(options.map(button => button.text).sort(), ['Русский', 'Қазақша'].sort());
  assert.deepEqual(options.map(button => button.callback_data).sort(), ['language:kk', 'language:ru']);
}

test('the first start or ordinary message asks for a language before displaying the menu', async () => {
  for (const text of ['/start', 'Здравствуйте']) {
    const store = preferences();
    const chat = conversation(store);
    await chat.send(text);
    assert.equal(chat.replies.length, 1);
    assertLanguagePicker(chat.replies[0]);
    assert.equal(await store.getLanguage(101), undefined, 'Telegram client language must not silently choose for the user');
  }
});

test('Russian selection opens the menu and another bot instance remembers the same user choice', async () => {
  const store = preferences();
  const chat = conversation(store);
  await chat.send('/start');
  await chat.click('language:ru');
  assert.equal(await store.getLanguage(101), 'ru');
  assert.ok(labels(chat.replies.at(-1)).includes('Мои обращения'));
  assert.ok(labels(chat.replies.at(-1)).includes('Язык / Тіл'));
  const reopened = conversation(store);
  await reopened.send('/start');
  assert.match(reopened.replies.at(-1).text, /Здравствуйте/);
  assert.ok(labels(reopened.replies.at(-1)).includes('Мои обращения'));
  const stranger = conversation(store, { userId: 202 });
  await stranger.send('/start');
  assertLanguagePicker(stranger.replies.at(-1));
});

test('Kazakh selection localizes the report flow without translating the submitted description', async t => {
  let savedReport;
  t.mock.method(mockApi, 'createReport', async report => {
    savedReport = report;
    return { id: 'DEMO-TEST', demoOnly: true };
  });
  const chat = conversation(preferences());
  await chat.click('language:kk');
  assert.ok(labels(chat.replies.at(-1)).includes('Менің өтініштерім'));
  assert.match(chat.replies.at(-1).text, /Сәлеметсіз бе/);
  await chat.send('📍 Мәселе туралы хабарлау');
  assert.match(chat.replies.at(-1).text, /геолокация/i);
  assert.match(chat.replies.at(-1).text, /жіберілмейді/);
  await chat.send({ location: { latitude: 51, longitude: 71 } });
  assert.match(chat.replies.at(-1).text, /фото/);
  assert.ok(labels(chat.replies.at(-1)).includes('Бас тарту'));
  await chat.send({ photo: [{ file_id: 'photo', file_unique_id: 'p', width: 1, height: 1 }] });
  assert.match(chat.replies.at(-1).text, /сипатта/);
  await chat.send('Описание на выбранном пользователем языке');
  assert.equal(savedReport.description, 'Описание на выбранном пользователем языке');
  assert.equal(savedReport.telegramUserId, '101');
  assert.match(chat.replies.at(-1).text, /DEMO-TEST.*сақталды/s);
  assert.match(chat.replies.at(-1).text, /жіберілмеді/);
  assert.ok(labels(chat.replies.at(-1)).includes('Менің өтініштерім'));
});

test('language can be changed from a command or menu and the old report draft is cleared', async t => {
  const requests = t.mock.method(mockApi, 'createReport', async () => ({ id: 'DEMO-TEST', demoOnly: true }));
  const store = preferences({ 101: 'kk' });
  const chat = conversation(store);
  await chat.send('📍 Мәселе туралы хабарлау');
  await chat.send('/language');
  assertLanguagePicker(chat.replies.at(-1));
  await chat.click('language:ru');
  assert.ok(labels(chat.replies.at(-1)).includes('Мои обращения'));
  await chat.send({ location: { latitude: 51, longitude: 71 } });
  await chat.send({ photo: [{ file_id: 'photo', file_unique_id: 'p', width: 1, height: 1 }] });
  await chat.send('Old description');
  assert.equal(requests.mock.callCount(), 0);
  await chat.send('Язык / Тіл');
  assertLanguagePicker(chat.replies.at(-1));
});

test('reports and old callbacks cannot bypass the first language selection', async t => {
  const load = t.mock.method(mockApi, 'listReports', async () => []);
  const chat = conversation(preferences());
  await chat.send('/reports');
  assertLanguagePicker(chat.replies.at(-1));
  await chat.click('reports:open:DEMO-042');
  assertLanguagePicker(chat.replies.at(-1));
  assert.equal(load.mock.callCount(), 0);
});

test('invalid choices and group callbacks cannot overwrite a saved language', async () => {
  const store = preferences({ 101: 'ru' });
  const chat = conversation(store);
  await chat.click('language:en');
  assertLanguagePicker(chat.replies.at(-1));
  assert.equal(await store.getLanguage(101), 'ru');
  const group = conversation(store, { chatType: 'supergroup' });
  await group.click('language:kk');
  assert.match(group.replies.at(-1).text, /личном чате|жеке чат/);
  assert.equal(await store.getLanguage(101), 'ru');
});

test('failed language saving retains the old language and keeps the selector available', async () => {
  const store = preferences({ 101: 'ru' });
  store.setLanguage = async () => { throw new Error('disk full'); };
  const chat = conversation(store);
  await chat.click('language:kk');
  assert.match(chat.replies.at(-1).text, /Не удалось сохранить язык/);
  assert.equal(labels(chat.replies.at(-1)).length, 0);
  assertLanguagePicker(chat.replies.at(-1));
  assert.equal(await store.getLanguage(101), 'ru');
});

test('expired callback acknowledgements do not block choosing a language', async () => {
  const store = preferences();
  const chat = conversation(store, { failCallbackAnswer: true });
  await chat.click('language:kk');
  assert.equal(await store.getLanguage(101), 'kk');
  assert.ok(labels(chat.replies.at(-1)).includes('Менің өтініштерім'));
});

test('Kazakh application and procedure screens use localized instructions', async () => {
  const chat = conversation(preferences({ 101: 'kk' }));
  await chat.send('🔎 Өтінішті тексеру');
  assert.match(chat.replies.at(-1)?.text || '', /Өтініш нөмірін/);
  await chat.send('bad');
  assert.match(chat.replies.at(-1).text, /4.*40/);
  assert.doesNotMatch(chat.replies.at(-1).text, /Номер должен/);
  await chat.send('KZ-2026-042');
  assert.match(chat.replies.at(-1).text, /Қаралуда/);
  assert.doesNotMatch(chat.replies.at(-1).text, /Учебная запись|Демонстрационные данные/);
  await chat.send('📋 Жер рәсімдері');
  assert.match(chat.replies.at(-1).text, /таңдаңыз/);
  const topic = labels(chat.replies.at(-1))[0];
  await chat.send(topic);
  assert.match(chat.replies.at(-1).text, /Қадамдар:/);
  assert.match(chat.replies.at(-1).text, /Дереккөз: https:/);
  assert.doesNotMatch(chat.replies.at(-1).text, /Откройте|Порядок действий|Источник:/);
});

test('unreadable preferences block business actions with a bilingual retry message', async t => {
  const load = t.mock.method(mockApi, 'listReports', async () => []);
  const store = preferences();
  store.getLanguage = async () => { throw new Error('Invalid JSON'); };
  const chat = conversation(store);
  await chat.send('/reports');
  assert.match(chat.replies.at(-1).text, /Не удалось загрузить настройки языка/);
  assert.match(chat.replies.at(-1).text, /Тіл баптауларын/);
  assert.equal(load.mock.callCount(), 0);
});

test('Kazakh application errors preserve the selected language for retry and cancellation', async () => {
  const chat = conversation(preferences({ 101: 'kk' }));
  await chat.send('🔎 Өтінішті тексеру');
  await chat.send('KZ-UNKNOWN');
  assert.match(chat.replies.at(-1).text, /Өтініш табылмады/);
  assert.doesNotMatch(chat.replies.at(-1).text, /Заявление|Введите|Отмена/);
  await chat.send('Бас тарту');
  assert.ok(labels(chat.replies.at(-1)).includes('Менің өтініштерім'));
  const count = chat.replies.length;
  await chat.send('KZ-2026-042');
  assert.equal(chat.replies.length, count);
});

test('an unconfigured group user is directed to private language selection before business actions', async t => {
  const lookup = t.mock.method(mockApi, 'getApplication', async () => ({ trackingNumber: 'KZ-TEST' }));
  const chat = conversation(preferences(), { chatType: 'supergroup' });
  await chat.send('/start');
  assert.match(chat.replies.at(-1).text, /личном чате/);
  assert.equal(labels(chat.replies.at(-1)).length, 0);
  await chat.send('🔎 Проверить заявление');
  assert.match(chat.replies.at(-1).text, /личном чате/);
  const count = chat.replies.length;
  await chat.send('KZ-TEST');
  await chat.send('Ordinary group conversation');
  await chat.send('/start@another_bot');
  assert.equal(chat.replies.length, count);
  assert.equal(lookup.mock.callCount(), 0);
});

for (const delayedStage of ['acknowledgement', 'preference read']) {
  test(`the newest language choice wins when an older ${delayedStage} is delayed`, async () => {
    let releaseOlder;
    const blocked = new Promise(resolve => { releaseOlder = resolve; });
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const store = preferences();
    let firstRead = true;
    const read = store.getLanguage;
    if (delayedStage === 'preference read') {
      store.getLanguage = async id => {
        if (firstRead) {
          firstRead = false;
          markStarted();
          await blocked;
        }
        return read(id);
      };
    }
    const chat = conversation(store, {
      onCallbackAnswer: async data => {
        if (delayedStage === 'acknowledgement' && data === 'language:ru') {
          markStarted();
          await blocked;
        }
      },
    });
    const older = chat.click('language:ru');
    await started;
    try {
      await chat.click('language:kk');
    } finally {
      releaseOlder();
    }
    await older;
    assert.equal(await store.getLanguage(101), 'kk');
    assert.ok(labels(chat.replies.at(-1)).includes('Менің өтініштерім'));
    assert.equal(chat.replies.length, 1, 'Superseded language selections must not send an obsolete menu');
  });
}
