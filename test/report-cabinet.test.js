import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

process.env.DATA_MODE = 'mock';
const { createBot } = await import('../src/bot.js');
const { createMockApi, mockApi } = await import('../src/mock-api.js');

const reportInput = { telegramUserId: '101', lat: 51.1693, lon: 71.4492, description: 'Работы на участке', telegramFileId: 'saved-photo' };

function store(t) {
  const reportsFile = join(tmpdir(), `zher-dialog-${randomUUID()}.json`);
  t.after(() => rm(reportsFile, { force: true }));
  const api = createMockApi({ reportsFile });
  t.mock.method(mockApi, 'createReport', report => api.createReport(report));
  t.mock.method(mockApi, 'listReports', owner => api.listReports(owner));
  return { api, reportsFile };
}

function conversation({ userId = 101, chatType = 'private', failCallbackAnswer = false } = {}) {
  const bot = createBot('test-token', {}, { preferences: { getLanguage: async () => 'ru' } });
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };
  bot.catch(error => { throw error; });
  const replies = [];
  const photos = [];
  const user = { id: userId, is_bot: false, first_name: 'Test' };
  const chat = { id: chatType === 'private' ? userId : -999, type: chatType };
  let updateId = 0;
  let answeredCallbacks = 0;
  bot.context.reply = async (text, extra) => { replies.push({ text, extra }); };
  bot.context.replyWithPhoto = async (photo, extra) => { photos.push({ photo, extra }); };
  bot.context.answerCbQuery = async () => {
    answeredCallbacks += 1;
    if (failCallbackAnswer) throw new Error('400: query is too old and response timeout expired');
  };
  return {
    replies, photos,
    get answeredCallbacks() { return answeredCallbacks; },
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
        message: { message_id: 1, date: 0, chat, text: 'Cabinet' },
      } });
    },
  };
}

function buttons(reply) {
  return reply?.extra?.reply_markup?.inline_keyboard?.flat() || [];
}

test('main menu exposes the cabinet and an empty cabinet offers a way to submit a report', async t => {
  store(t);
  const chat = conversation();
  await chat.send('/start');
  assert.ok(chat.replies.at(-1).extra.reply_markup.keyboard.flat().some(button =>
    (typeof button === 'string' ? button : button.text) === 'Мои обращения'));
  await chat.send('Мои обращения');
  assert.match(chat.replies.at(-1).text, /пока нет обращений/);
  assert.ok(chat.replies.at(-1).extra.reply_markup.keyboard.flat().some(button =>
    (typeof button === 'string' ? button : button.text).includes('Сообщить о проблеме')));
  await chat.send('/reports');
  assert.match(chat.replies.at(-1).text, /пока нет обращений/);
});

test('a submitted report is visible after restarting the bot with its evidence and next step', async t => {
  store(t);
  const sender = conversation();
  await sender.send('📍 Сообщить о проблеме');
  await sender.send({ location: { latitude: 51.1693, longitude: 71.4492 } });
  await sender.send({ photo: [{ file_id: 'saved-photo', file_unique_id: 'p', width: 100, height: 100 }] });
  await sender.send('Работы на участке');
  assert.match(sender.replies.at(-1).text, /DEMO-042.*сохранён/s);

  const owner = conversation();
  await owner.send('Мои обращения');
  assert.match(owner.replies.at(-1).text, /DEMO-042/);
  const open = buttons(owner.replies.at(-1)).find(button => button.text.includes('DEMO-042'));
  assert.ok(open, 'The stored report must have an open button');
  await owner.click(open.callback_data);
  const card = owner.replies.at(-1);
  assert.match(card.text, /Работы на участке/);
  assert.match(card.text, /51\.1693.*71\.4492/);
  assert.match(card.text, /Статус: Сохранено в боте/);
  assert.match(card.text, /Создано: \d{2}\.\d{2}\.\d{4}/);
  assert.match(card.text, /не отправлял/);
  assert.match(card.text, /Следующий шаг:/);
  assert.doesNotMatch(card.text, /передан на первичную проверку/);
  assert.ok(buttons(card).some(button => button.url?.includes('mlat=51.1693') && button.url?.includes('mlon=71.4492')));
  const photo = buttons(card).find(button => button.text.includes('Фото'));
  assert.ok(photo);
  await owner.click(photo.callback_data);
  assert.equal(owner.photos[0].photo, 'saved-photo');
  assert.equal(owner.answeredCallbacks, 2);

  const stranger = conversation({ userId: 202 });
  await stranger.send('Мои обращения');
  assert.match(stranger.replies.at(-1).text, /пока нет обращений/);
});

test('cabinet shows the violation passport without breaking old report cards', async t => {
  const { api, reportsFile } = store(t);
  await api.createReport({
    ...reportInput,
    description: 'Сосед перекрыл общий проход забором',
    casePassport: {
      type: 'blocked_access',
      typeLabel: 'Перекрыт проход или доступ',
      responsibleAuthority: 'Местный акимат',
      urgency: 'high',
      evidenceChecklist: ['Фото препятствия', 'Геолокация'],
      officialDraft: 'Прошу провести проверку по факту перекрытия прохода.',
      nextAction: 'Проверьте черновик и отправьте через eOtinish.',
      followUpDays: 3,
    },
  });
  const chat = conversation();
  await chat.click('reports:open:DEMO-042');
  assert.match(chat.replies.at(-1).text, /Паспорт нарушения/);
  assert.match(chat.replies.at(-1).text, /Категория: Перекрыт проход или доступ/);
  assert.match(chat.replies.at(-1).text, /Ответственный орган: Местный акимат/);
  assert.match(chat.replies.at(-1).text, /Срочность: высокая/);
  assert.match(chat.replies.at(-1).text, /Нужные доказательства/);
  assert.match(chat.replies.at(-1).text, /Черновик обращения/);

  await writeFile(reportsFile, JSON.stringify([{
    id: 'DEMO-OLD',
    telegramUserId: '101',
    lat: 51,
    lon: 71,
    description: 'Старая запись',
    telegramFileId: 'photo',
    createdAt: '2026-09-20T12:00:00Z',
    demoOnly: true,
  }]));
  await chat.click('reports:open:DEMO-OLD');
  assert.match(chat.replies.at(-1).text, /Старая запись/);
  assert.doesNotMatch(chat.replies.at(-1).text, /Паспорт нарушения/);
});

test('cabinet opens separate draft texts only for the report owner', async t => {
  const { api } = store(t);
  await api.createReport({
    ...reportInput,
    description: 'Сосед перекрыл общий проход забором',
    casePassport: {
      type: 'blocked_access',
      typeLabel: 'Перекрыт проход или доступ',
      responsibleAuthority: 'Местный акимат',
      urgency: 'high',
      evidenceChecklist: ['Фото препятствия', 'Геолокация'],
      officialDraft: 'Официальный текст для eOtinish.',
      followUpDraft: 'Повторное обращение по ранее поданному сигналу.',
      inactivityComplaintDraft: 'Жалоба на бездействие ответственного органа.',
      publicText: 'Короткий публичный текст.',
      nextAction: 'Проверьте черновик и отправьте через eOtinish.',
      followUpDays: 3,
    },
  });

  const owner = conversation();
  await owner.click('reports:open:DEMO-042');
  const cardButtons = buttons(owner.replies.at(-1));
  assert.ok(cardButtons.some(button => button.callback_data === 'reports:draft:official:DEMO-042'));
  assert.ok(cardButtons.some(button => button.callback_data === 'reports:draft:followup:DEMO-042'));
  assert.ok(cardButtons.some(button => button.callback_data === 'reports:draft:complaint:DEMO-042'));
  assert.ok(cardButtons.some(button => button.callback_data === 'reports:draft:public:DEMO-042'));

  await owner.click('reports:draft:complaint:DEMO-042');
  assert.match(owner.replies.at(-1).text, /Жалоба/);
  assert.match(owner.replies.at(-1).text, /Жалоба на бездействие ответственного органа/);
  assert.ok(buttons(owner.replies.at(-1)).some(button => button.callback_data === 'reports:open:DEMO-042'));

  const stranger = conversation({ userId: 202 });
  await stranger.click('reports:draft:official:DEMO-042');
  assert.match(stranger.replies.at(-1).text, /не найдено|недоступно/);
  assert.doesNotMatch(stranger.replies.at(-1).text, /Официальный текст/);
});

test('forged card and photo callbacks never disclose another user report', async t => {
  const { api } = store(t);
  await api.createReport(reportInput);
  const stranger = conversation({ userId: 202 });
  await stranger.click('reports:open:DEMO-042');
  assert.match(stranger.replies.at(-1)?.text || '', /не найдено|недоступно/);
  await stranger.click('reports:photo:DEMO-042');
  assert.match(stranger.replies.at(-1)?.text || '', /не найдено|недоступно/);
  assert.doesNotMatch(stranger.replies.map(reply => reply.text).join('\n'), /Работы на участке|51\.1693|saved-photo/);
  assert.equal(stranger.photos.length, 0);
  assert.equal(stranger.answeredCallbacks, 2);
});

test('cabinet refuses group access for lists, cards and photos', async t => {
  const { api } = store(t);
  await api.createReport(reportInput);
  const group = conversation({ chatType: 'supergroup' });
  await group.send('Мои обращения');
  await group.click('reports:open:DEMO-042');
  await group.click('reports:photo:DEMO-042');
  assert.equal(group.replies.length, 3);
  for (const reply of group.replies) assert.match(reply.text, /личном чате/);
  assert.doesNotMatch(group.replies.map(reply => reply.text).join('\n'), /Работы на участке|DEMO-042/);
  assert.equal(group.photos.length, 0);
});

test('pagination reaches every report and returns from a card to its page', async t => {
  const { api } = store(t);
  for (let i = 0; i < 12; i += 1) await api.createReport({ ...reportInput, description: `Report ${i}` });
  const chat = conversation();
  await chat.send('Мои обращения');
  assert.match(chat.replies.at(-1)?.text || '', /1 из 3/);
  assert.match(chat.replies.at(-1).text, /DEMO-053/);
  assert.doesNotMatch(chat.replies.at(-1).text, /DEMO-048/);
  await chat.click(buttons(chat.replies.at(-1)).find(button => button.text === 'Далее').callback_data);
  assert.match(chat.replies.at(-1).text, /2 из 3/);
  const secondPageReport = buttons(chat.replies.at(-1)).find(button => button.text.includes('DEMO-048'));
  await chat.click(secondPageReport.callback_data);
  await chat.click(buttons(chat.replies.at(-1)).find(button => button.text === 'К списку').callback_data);
  assert.match(chat.replies.at(-1).text, /2 из 3/);
  await chat.click(buttons(chat.replies.at(-1)).find(button => button.text === 'Далее').callback_data);
  assert.match(chat.replies.at(-1).text, /3 из 3/);
  assert.match(chat.replies.at(-1).text, /DEMO-042/);
  assert.ok(!buttons(chat.replies.at(-1)).some(button => button.text === 'Далее'));
  assert.ok(buttons(chat.replies.at(-1)).every(button => Buffer.byteLength(button.callback_data || '') <= 64));
});

test('old card buttons reload the current status and handle deleted reports', async t => {
  const { api, reportsFile } = store(t);
  await api.createReport(reportInput);
  const chat = conversation();
  await chat.send('Мои обращения');
  const open = buttons(chat.replies.at(-1)).find(button => button.text.includes('DEMO-042'));
  assert.ok(open, 'A report card should be available');
  const reports = JSON.parse(await readFile(reportsFile, 'utf8'));
  reports[0].status = 'under_review';
  reports[0].demoOnly = false;
  reports[0].updatedAt = '2026-09-26T12:00:00Z';
  await writeFile(reportsFile, JSON.stringify(reports));
  await chat.click(open.callback_data);
  assert.match(chat.replies.at(-1).text, /На рассмотрении/);
  assert.match(chat.replies.at(-1).text, /Обновлено: 26\.09\.2026/);
  await writeFile(reportsFile, '[]');
  await chat.click(open.callback_data);
  assert.match(chat.replies.at(-1).text, /не найдено|недоступно/);
});

test('failed cabinet loading offers retry and clears the interrupted report draft', async t => {
  store(t);
  t.mock.method(mockApi, 'listReports', async () => { throw new Error('Сервис временно недоступен.'); });
  const chat = conversation();
  await chat.send('📍 Сообщить о проблеме');
  await chat.send('Мои обращения');
  assert.match(chat.replies.at(-1).text, /временно недоступен/);
  assert.ok(buttons(chat.replies.at(-1)).some(button => button.text === 'Повторить'));
  const count = chat.replies.length;
  await chat.send({ location: { latitude: 51, longitude: 71 } });
  assert.equal(chat.replies.length, count);
});

test('an expired callback acknowledgement still opens the card with ownership checked', async t => {
  const { api } = store(t);
  await api.createReport(reportInput);
  const owner = conversation({ failCallbackAnswer: true });
  await assert.doesNotReject(() => owner.click('reports:open:DEMO-042'));
  assert.match(owner.replies.at(-1).text, /Работы на участке/);
  const stranger = conversation({ userId: 202, failCallbackAnswer: true });
  await assert.doesNotReject(() => stranger.click('reports:open:DEMO-042'));
  assert.match(stranger.replies.at(-1).text, /не найдено|недоступно/);
  assert.doesNotMatch(stranger.replies.at(-1).text, /Работы на участке/);
});
