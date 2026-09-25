import test from 'node:test';
import assert from 'node:assert/strict';
import { Markup, Telegraf } from 'telegraf';
import * as procedures from '../src/procedures.js';

process.env.DATA_MODE = 'api';
process.env.API_BASE_URL = 'http://localized-cabinet.test/api';
const { registerReportCabinet } = await import('../src/report-cabinet.js');

function report(overrides = {}) {
  return {
    id: 'REP-1', telegramUserId: '101', status: 'signal_received',
    createdAt: '2026-09-20T21:00:00Z', updatedAt: '2026-09-25T12:00:00Z',
    description: 'Работы на участке', lat: 51.1693, lon: 71.4492,
    telegramFileId: 'saved-photo', ...overrides,
  };
}

function backend(t, records) {
  return t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /^http:\/\/localized-cabinet\.test\/api\/reports\?telegramUserId=(101|202)$/);
    assert.equal(options.method || 'GET', 'GET');
    return Response.json({ reports: typeof records === 'function' ? records() : records });
  });
}

function conversation({ language = 'kk', userId = 101, chatType = 'private', failCallbackAnswer = false, menu } = {}) {
  const bot = new Telegraf('test-token', { telegram: { apiRoot: 'http://127.0.0.1:1' } });
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };
  bot.catch(error => { throw error; });
  let currentLanguage = language;
  bot.use((ctx, next) => {
    ctx.state.language = currentLanguage;
    return next();
  });
  const replies = [];
  const photos = [];
  let cleared = 0;
  let answered = 0;
  bot.context.reply = async (text, extra) => { replies.push({ text, extra }); };
  bot.context.replyWithPhoto = async (photo, extra) => { photos.push({ photo, extra }); };
  bot.context.answerCbQuery = async () => {
    answered += 1;
    if (failCallbackAnswer) throw new Error('Callback expired');
  };
  registerReportCabinet(bot, {
    menu: menu || (ctx => Markup.keyboard([[ctx.state.language === 'kk' ? 'Мәселе туралы хабарлау' : 'Сообщить о проблеме']]).resize()),
    clearState: () => { cleared += 1; },
  });
  const user = { id: userId, is_bot: false, first_name: 'Test' };
  const chat = { id: chatType === 'private' ? userId : -999, type: chatType };
  let updateId = 0;
  return {
    replies, photos,
    get cleared() { return cleared; },
    get answered() { return answered; },
    setLanguage(value) { currentLanguage = value; },
    async send(text = '/reports') {
      await bot.handleUpdate({ update_id: ++updateId, message: {
        message_id: updateId, date: 0, chat, from: user, text,
        ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}),
      } });
    },
    async click(data) {
      await bot.handleUpdate({ update_id: ++updateId, callback_query: {
        id: String(updateId), from: user, chat_instance: 'test', data,
        message: { message_id: 1, date: 0, chat, text: 'Cabinet' },
      } });
    },
  };
}

function buttons(reply) {
  return reply?.extra?.reply_markup?.inline_keyboard?.flat() || [];
}

function button(reply, data) {
  const found = buttons(reply).find(item => item.callback_data === data);
  assert.ok(found, `Missing usable button: ${data}`);
  return found;
}

test('Kazakh cabinet accepts both keyboard labels and resolves the empty menu for the current language', async t => {
  backend(t, []);
  const chat = conversation();
  for (const label of ['Менің өтініштерім', 'Мои обращения', '/reports']) {
    const count = chat.replies.length;
    await chat.send(label);
    assert.equal(chat.replies.length, count + 1);
    const reply = chat.replies.at(-1);
    assert.match(reply.text, /Әзірге өтініштеріңіз жоқ/);
    assert.match(reply.text, /Мәселе туралы хабарлау/);
    assert.deepEqual(reply.extra.reply_markup.keyboard, [['Мәселе туралы хабарлау']]);
  }
  await chat.click('reports:menu');
  assert.equal(chat.replies.at(-1).text, 'Әрекетті таңдаңыз:');
  assert.deepEqual(chat.replies.at(-1).extra.reply_markup.keyboard, [['Мәселе туралы хабарлау']]);
  chat.setLanguage('ru');
  await chat.click('reports:menu');
  assert.equal(chat.replies.at(-1).text, 'Выберите действие:');
  assert.deepEqual(chat.replies.at(-1).extra.reply_markup.keyboard, [['Сообщить о проблеме']]);
  await chat.send('Менің өтініштерім');
  assert.match(chat.replies.at(-1).text, /У вас пока нет обращений/);
  assert.deepEqual(chat.replies.at(-1).extra.reply_markup.keyboard, [['Сообщить о проблеме']]);
  assert.equal(chat.cleared, 6);
});

test('a static Markup menu remains supported and missing language falls back to Russian', async t => {
  backend(t, []);
  const menu = Markup.keyboard([['Static menu']]).resize();
  const chat = conversation({ language: null, menu });
  await chat.send();
  assert.match(chat.replies.at(-1).text, /У вас пока нет обращений/);
  assert.equal(chat.replies.at(-1).extra, menu);
  await chat.click('reports:menu');
  assert.equal(chat.replies.at(-1).text, 'Выберите действие:');
  assert.equal(chat.replies.at(-1).extra, menu);
});

test('Kazakh pagination retains callback data, page clamping and return from a card', async t => {
  let records = Array.from({ length: 12 }, (_, i) => report({ id: `REP-${i + 1}` }));
  backend(t, () => records);
  const chat = conversation();
  await chat.send();
  const first = chat.replies.at(-1);
  assert.match(first.text, /Менің өтініштерім: 12/);
  assert.match(first.text, /1 \/ 3/);
  assert.match(first.text, /Сигнал сақталды/);
  assert.match(first.text, /21\.09\.2026/);
  assert.equal(button(first, 'reports:open:REP-12').text, 'Ашу REP-12');
  assert.equal(button(first, 'reports:page:1').text, 'Келесі');
  assert.equal(button(first, 'reports:page:0').text, 'Жаңарту');
  assert.equal(button(first, 'reports:menu').text, 'Басты мәзір');
  assert.equal(buttons(first).filter(item => item.callback_data.startsWith('reports:open:')).length, 5);
  await chat.click('reports:page:1');
  const second = chat.replies.at(-1);
  assert.match(second.text, /2 \/ 3/);
  assert.equal(button(second, 'reports:page:0').text, 'Артқа');
  await chat.click('reports:open:REP-7');
  assert.equal(button(chat.replies.at(-1), 'reports:page:1').text, 'Тізімге оралу');
  records = records.slice(0, 6);
  await chat.click('reports:page:2');
  assert.match(chat.replies.at(-1).text, /2 \/ 2/);
  assert.deepEqual(buttons(chat.replies.at(-1)).filter(item => item.callback_data.startsWith('reports:open:')).map(item => item.callback_data), ['reports:open:REP-1']);
});

test('Kazakh cards localize labels and photo buttons while preserving backend content and map coordinates', async t => {
  backend(t, [report({ explanation: 'Ответ ведомства без перевода', nextStep: 'Приложите документ из архива' })]);
  const chat = conversation();
  await chat.click('reports:open:REP-1');
  const card = chat.replies.at(-1);
  for (const text of ['Өтініш REP-1', 'Мәртебесі: Сигнал сақталды', 'Құрылған күні: 21.09.2026',
    'Жаңартылған күні: 25.09.2026', 'Сипаттамасы:\nРаботы на участке', 'Координаттары: 51.1693, 71.4492',
    'Ответ ведомства без перевода', 'Келесі қадам: Приложите документ из архива']) {
    assert.ok(card.text.includes(text), `Missing localized card content: ${text}`);
  }
  assert.equal(button(card, 'reports:open:REP-1').text, 'Мәртебені жаңарту');
  assert.equal(button(card, 'reports:photo:REP-1').text, 'Фото');
  assert.equal(button(card, 'reports:page:0').text, 'Тізімге оралу');
  assert.equal(buttons(card).find(item => item.url?.includes('openstreetmap.org')).text, 'Картадан ашу');
  assert.equal(buttons(card).find(item => item.url?.includes('openstreetmap.org')).url,
    'https://www.openstreetmap.org/?mlat=51.1693&mlon=71.4492#map=17/51.1693/71.4492');
  assert.equal(card.extra.link_preview_options.is_disabled, true);
  await chat.click('reports:photo:REP-1');
  assert.deepEqual(chat.photos, [{ photo: 'saved-photo', extra: { caption: 'REP-1 өтінішінің фотосы' } }]);
});

test('Kazakh cards translate every known status and fallback next step without claiming unknown status approval', async t => {
  let record;
  backend(t, () => [record]);
  const chat = conversation();
  for (const [status, label, nextStep] of [
    ['signal_received', 'Сигнал сақталды', 'Мәртебесін кейінірек тексеріңіз: сигнал сервисте сақталды.'],
    ['under_review', 'Қаралуда', 'Жаңартуларды тексеріп, мәселе бойынша қосымша материалдарды сақтаңыз.'],
    ['inspection_scheduled', 'Тексеру тағайындалды', 'Жағдай өзгерсе, учаскенің жаңа фотоларын сақтаңыз.'],
    ['approved', 'Мақұлданды', 'Шешіммен танысып, мәселенің шешілгенін тексеріңіз.'],
    ['rejected', 'Қабылданбады', 'Жауаптағы бас тарту себебімен танысып, жетіспейтін мәліметтерді нақтылаңыз.'],
    ['awaiting_import', 'Мәртебесі нақтылануда', 'Мәртебесін тексеру үшін карточканы кейінірек жаңартыңыз.'],
  ]) {
    record = report({ status });
    await chat.send();
    assert.ok(chat.replies.at(-1).text.includes(label));
    await chat.click('reports:open:REP-1');
    assert.ok(chat.replies.at(-1).text.includes(`Мәртебесі: ${label}`));
    assert.ok(chat.replies.at(-1).text.includes(`Келесі қадам: ${nextStep}`));
    assert.doesNotMatch(chat.replies.at(-1).text, /awaiting_import/);
  }
});

test('Kazakh demo cards retain the local-only warning and official link', async t => {
  backend(t, [report({ demoOnly: true, nextStep: 'Submitted to government' })]);
  const chat = conversation();
  await chat.click('reports:open:REP-1');
  const card = chat.replies.at(-1);
  assert.match(card.text, /Мәртебесі: Ботта сақталды/);
  assert.match(card.text, /Демо-хабарлама\. Мемлекеттік органдарға жіберілген жоқ\./);
  assert.match(card.text, /Келесі қадам: Ресми өтініш беру үшін eOtinish сервисіне өтіңіз\. Фото мен координаттарды сақтаңыз\./);
  assert.doesNotMatch(card.text, /Submitted to government/);
  assert.equal(buttons(card).find(item => item.url === 'https://eotinish.kz/ru').text, 'eOtinish ашу');
});

test('Kazakh missing values, invalid coordinates and absent photos have localized fallbacks', async t => {
  backend(t, [report({ description: '', createdAt: 'invalid', updatedAt: 'invalid', lat: 91, telegramFileId: undefined })]);
  const chat = conversation();
  await chat.click('reports:open:REP-1');
  const card = chat.replies.at(-1);
  assert.match(card.text, /Құрылған күні: көрсетілмеген/);
  assert.match(card.text, /Жаңартылған күні: көрсетілмеген/);
  assert.match(card.text, /Сипаттамасы:\nКөрсетілмеген\./);
  assert.match(card.text, /Координаттар көрсетілмеген\./);
  assert.ok(!buttons(card).some(item => item.url || item.callback_data.startsWith('reports:photo:')));
  await chat.click('reports:photo:REP-1');
  assert.equal(chat.replies.at(-1).text, 'Бұл өтініштің сақталған фотосы жоқ.');
  assert.equal(chat.photos.length, 0);
});

test('Kazakh cards retain UTF-16 length caps for backend content', async t => {
  backend(t, [report({
    description: `DESCRIPTION ${'\u{1F4CD}'.repeat(2500)}`,
    explanation: `EXPLANATION ${'\u{1F4CD}'.repeat(2500)}`,
    nextStep: `NEXT STEP ${'\u{1F4CD}'.repeat(2500)}`,
  })]);
  const chat = conversation();
  await chat.send();
  assert.ok(chat.replies.at(-1).text.length < 4096);
  assert.equal(chat.replies.at(-1).text.isWellFormed(), true);
  await chat.click('reports:open:REP-1');
  const card = chat.replies.at(-1);
  assert.match(card.text, /Келесі қадам: NEXT STEP/);
  for (const field of ['DESCRIPTION', 'EXPLANATION', 'NEXT STEP']) assert.ok(card.text.includes(field));
  assert.ok(card.text.length <= 4096);
  assert.equal(card.text.isWellFormed(), true);
});

test('Kazakh cabinet rejects other owners even when backend returns their reports and callback acknowledgement fails', async t => {
  const requests = backend(t, [report()]);
  const stranger = conversation({ userId: 202, failCallbackAnswer: true });
  await stranger.send();
  assert.match(stranger.replies.at(-1).text, /Әзірге өтініштеріңіз жоқ/);
  for (const action of ['open', 'photo']) {
    await stranger.click(`reports:${action}:REP-1`);
    assert.equal(stranger.replies.at(-1).text, 'Өтініш табылмады немесе қолжетімсіз.');
    assert.equal(button(stranger.replies.at(-1), 'reports:page:0').text, 'Тізімге оралу');
    assert.equal(button(stranger.replies.at(-1), 'reports:menu').text, 'Басты мәзір');
  }
  assert.doesNotMatch(stranger.replies.map(reply => reply.text).join('\n'), /Работы на участке|51\.1693|REP-1|saved-photo/);
  assert.equal(stranger.photos.length, 0);
  assert.equal(stranger.answered, 2);
  assert.ok(requests.mock.calls.every(call => call.arguments[0].endsWith('telegramUserId=202')));
  const owner = conversation({ failCallbackAnswer: true });
  await owner.click('reports:open:REP-1');
  assert.match(owner.replies.at(-1).text, /Өтініш REP-1/);
  await owner.click('reports:photo:REP-1');
  assert.equal(owner.photos[0].photo, 'saved-photo');
});

test('Kazakh cabinet blocks all group entry points before loading or exposing reports', async t => {
  const requests = backend(t, [report()]);
  const chat = conversation({ chatType: 'supergroup', failCallbackAnswer: true });
  await chat.send('Менің өтініштерім');
  await chat.send('Мои обращения');
  await chat.send();
  for (const data of ['reports:page:0', 'reports:open:REP-1', 'reports:photo:REP-1', 'reports:menu']) await chat.click(data);
  assert.equal(chat.replies.length, 7);
  for (const reply of chat.replies) assert.equal(reply.text, 'Менің өтініштерім бөлімі ботпен жеке чатта ғана қолжетімді.');
  assert.equal(requests.mock.callCount(), 0);
  assert.equal(chat.photos.length, 0);
  assert.equal(chat.cleared, 0);
});

test('Kazakh load failures offer localized retry and menu buttons and recover', async t => {
  let unavailable = true;
  t.mock.method(globalThis, 'fetch', async () => {
    if (unavailable) throw new Error('offline');
    return Response.json({ reports: [report()] });
  });
  const chat = conversation();
  await chat.send();
  const failure = chat.replies.at(-1);
  assert.match(failure.text, /Қызмет уақытша қолжетімсіз/);
  assert.doesNotMatch(failure.text, /Сервис временно|offline/);
  assert.equal(button(failure, 'reports:page:0').text, 'Қайталау');
  assert.equal(button(failure, 'reports:menu').text, 'Басты мәзір');
  unavailable = false;
  await chat.click('reports:page:0');
  assert.match(chat.replies.at(-1).text, /Менің өтініштерім: 1/);
  assert.equal(chat.cleared, 2);
});

test('Kazakh invalid report IDs never generate unsafe callbacks', async t => {
  let id;
  backend(t, () => [report({ id })]);
  const chat = conversation();
  for (id of ['REP:broken', 'R'.repeat(41)]) {
    await chat.send();
    const failure = chat.replies.at(-1);
    assert.match(failure.text, /кейінірек|қайталап/i);
    assert.doesNotMatch(failure.text, /некорректный номер/);
    assert.deepEqual(buttons(failure).map(item => item.callback_data), ['reports:page:0', 'reports:menu']);
    for (const item of buttons(failure)) assert.ok(Buffer.byteLength(item.callback_data, 'utf8') <= 64);
  }
});

test('reference procedures expose complete Kazakh text while preserving Russian defaults and official sources', () => {
  assert.equal(typeof procedures.localizeProcedure, 'function');
  const expected = [
    ['Жер учаскесі туралы мәліметтер', 'Учаске туралы мәліметтер', 'https://map.gov4c.kz/egkn/', 'https://www.gov.kz/services/4009?lang=ru'],
    ['Жер учаскесінің нысаналы мақсатын өзгерту', 'Нысаналы мақсат', 'https://www.gov.kz/services/3610?lang=ru', 'https://www.gov.kz/services/3610?lang=ru'],
    ['Жер учаскесіндегі мәселе туралы хабарлау', 'Мемлекеттік органға өтініш', 'https://eotinish.kz/ru', 'https://eotinish.kz/ru/guide?id=fa3c2d1a-925e-4892-af5c-37b09abcc7ee'],
  ];
  procedures.referenceProcedures.forEach((original, i) => {
    const snapshot = structuredClone(original);
    assert.equal(procedures.localizeProcedure(original), original);
    assert.equal(procedures.localizeProcedure(original, 'ru'), original);
    const localized = procedures.localizeProcedure(original, 'kk');
    assert.equal(localized.title, expected[i][0]);
    assert.equal(localized.menuLabel, expected[i][1]);
    assert.equal(localized.officialUrl, expected[i][2]);
    assert.equal(localized.sourceUrl, expected[i][3]);
    assert.equal(localized.sourceCheckedAt, '2026-09-25');
    assert.equal(localized.referenceOnly, true);
    assert.equal(localized.id, original.id);
    assert.equal(localized.steps.length, original.steps.length);
    for (const [index, step] of localized.steps.entries()) {
      assert.notEqual(step, original.steps[index]);
      assert.match(step, /[әғқңөұүһі]/i);
    }
    for (const field of ['note', 'officialButton', ...(original.durationText ? ['durationText'] : [])]) {
      assert.notEqual(localized[field], original[field]);
      assert.ok(localized[field].length > 0);
    }
    assert.deepEqual(original, snapshot);
  });
});

test('backend procedure translations override only textual fields, never identity, flags or URLs', () => {
  assert.equal(typeof procedures.localizeProcedure, 'function');
  const original = {
    id: 'backend-procedure', title: 'Backend title', menuLabel: 'Backend menu', steps: ['Backend step'],
    note: 'Backend note', officialButton: 'Backend button', durationText: 'Backend duration', documents: ['Backend document'],
    officialUrl: 'https://official.example/service', sourceUrl: 'https://official.example/source', sourceCheckedAt: '2026-09-25',
    referenceOnly: true, demoOnly: true, source: 'official', durationDays: 8,
    translations: { kk: {
      title: 'Қазақша атау', menuLabel: 'Қазақша мәзір', steps: ['Бірінші қадам'], note: 'Ескерту',
      officialButton: 'Қызметті ашу', durationText: '8 жұмыс күні', documents: ['Қажетті құжат'],
      id: 'changed', officialUrl: 'https://untrusted.example', sourceUrl: 'https://untrusted.example', sourceCheckedAt: 'tomorrow',
      referenceOnly: false, demoOnly: false, source: 'changed', durationDays: 0,
    } },
  };
  const snapshot = structuredClone(original);
  const localized = procedures.localizeProcedure(original, 'kk');
  for (const field of ['title', 'menuLabel', 'steps', 'note', 'officialButton', 'durationText', 'documents']) {
    assert.deepEqual(localized[field], original.translations.kk[field]);
  }
  for (const field of ['id', 'officialUrl', 'sourceUrl', 'sourceCheckedAt', 'referenceOnly', 'demoOnly', 'source', 'durationDays']) {
    assert.deepEqual(localized[field], original[field]);
  }
  assert.deepEqual(original, snapshot);
});

test('procedure localization preserves untranslated content and rejects malformed text overrides', () => {
  assert.equal(typeof procedures.localizeProcedure, 'function');
  const plain = { title: 'Backend title', steps: ['Original step'], documents: ['Original document'], note: 'Original note' };
  assert.equal(procedures.localizeProcedure(plain, 'kk'), plain);
  assert.equal(procedures.localizeProcedure(plain, 'en'), plain);
  const partial = { ...plain, translations: { kk: { title: 'Қазақша атау', steps: [null], documents: 'invalid', note: null } } };
  const localized = procedures.localizeProcedure(partial, 'kk');
  assert.equal(localized.title, 'Қазақша атау');
  assert.deepEqual(localized.steps, ['Original step']);
  assert.deepEqual(localized.documents, ['Original document']);
  assert.equal(localized.note, 'Original note');
});
