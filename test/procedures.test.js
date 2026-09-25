import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_MODE = 'mock';
const { createBot } = await import('../src/bot.js');
const { mockApi } = await import('../src/mock-api.js');
const { config } = await import('../src/config.js');

let nextUserId = 100;

function conversation() {
  const bot = createBot('test-token', {}, { preferences: { getLanguage: async () => 'ru' } });
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };
  const replies = [];
  const user = { id: nextUserId++, is_bot: false, first_name: 'Test' };
  const chat = { id: user.id, type: 'private' };
  let updateId = 0;
  let answeredCallbacks = 0;
  bot.context.reply = async (text, extra) => {
    replies.push({ text, extra });
    return { message_id: replies.length };
  };
  bot.context.answerCbQuery = async () => { answeredCallbacks += 1; };
  return {
    replies,
    get answeredCallbacks() { return answeredCallbacks; },
    async send(content) {
      const message = typeof content === 'string' ? { text: content } : content;
      await bot.handleUpdate({ update_id: ++updateId, message: {
        message_id: updateId, date: 0, chat, from: user, ...message,
      } });
    },
    async click(data) {
      await bot.handleUpdate({ update_id: ++updateId, callback_query: {
        id: String(updateId), from: user, chat_instance: 'test', data,
        message: { message_id: 1, date: 0, chat, text: 'Procedure' },
      } });
    },
  };
}

test('procedures open one menu, with official topics and a separate demo entry', async () => {
  const chat = conversation();
  await chat.send('📋 Земельные процедуры');
  assert.equal(chat.replies.length, 1);
  const menu = chat.replies[0];
  assert.doesNotMatch(menu.text, /Демонстрационный материал|Срок: Не указан/);
  const buttons = menu.extra.reply_markup.keyboard.flat().map(button => typeof button === 'string' ? button : button.text);
  assert.deepEqual(buttons, ['Сведения об участке', 'Целевое назначение', 'Обращение в госорган', 'Демо-сигнал', 'Главное меню']);

  for (const label of buttons.slice(0, 3)) {
    await chat.send(label);
    const reply = chat.replies.at(-1);
    assert.match(reply.text, /Порядок действий:/);
    assert.match(reply.text, /Источник: https:\/\//);
    assert.doesNotMatch(reply.text, /Демонстрационные данные|ещё не подключены/);
    assert.ok(reply.text.length < 4096);
    assert.ok(reply.extra.reply_markup.inline_keyboard.flat().some(button => button.url?.startsWith('https://')));
    assert.ok(reply.extra.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'procedures:list'));
  }
  await chat.click('procedures:list');
  assert.equal(chat.answeredCallbacks, 1);
  assert.equal(chat.replies.at(-1).extra.reply_markup.keyboard.length, 5);
});

test('procedure selection recovers from unknown input and returns to main menu', async () => {
  const chat = conversation();
  await chat.send('📋 Земельные процедуры');
  await chat.send('unknown');
  assert.match(chat.replies.at(-1).text, /Выберите/);
  await chat.send('Главное меню');
  assert.equal(chat.replies.at(-1).extra.reply_markup.keyboard.length, 4);
  const replyCount = chat.replies.length;
  await chat.send('Сведения об участке');
  assert.equal(chat.replies.length, replyCount);
});

test('demo report is explicitly local and never claims submission to an authority', async t => {
  t.mock.method(mockApi, 'createReport', async () => ({ id: 'DEMO-TEST', demoOnly: true }));
  const chat = conversation();
  await chat.send('📋 Земельные процедуры');
  await chat.send('Демо-сигнал');
  assert.match(chat.replies.at(-1).text, /Демо/);
  assert.match(chat.replies.at(-1).text, /не.*отправ/);
  await chat.send({ location: { latitude: 51.1693, longitude: 71.4492 } });
  await chat.send({ photo: [{ file_id: 'test-photo', file_unique_id: 'test', width: 1, height: 1 }] });
  await chat.send('Тестовое описание');
  const receipt = chat.replies.at(-1);
  assert.match(receipt.text, /DEMO-TEST/);
  assert.match(receipt.text, /не отправ/);
  assert.doesNotMatch(receipt.text, /передан на первичную проверку/);
  assert.equal(receipt.extra.reply_markup.keyboard.length, 4);
});

test('API procedures still work without optional menu labels and do not offer demo submission', async t => {
  const previousMode = config.dataMode;
  config.dataMode = 'api';
  t.after(() => { config.dataMode = previousMode; });
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ procedures: [{ title: 'API procedure', steps: ['API step'] }] }),
  }));
  const chat = conversation();
  await chat.send('📋 Земельные процедуры');
  assert.deepEqual(chat.replies.at(-1).extra.reply_markup.keyboard, [['API procedure'], ['Главное меню']]);
  await chat.send('API procedure');
  assert.match(chat.replies.at(-1).text, /API step/);
  await chat.send('Демо-сигнал');
  assert.match(chat.replies.at(-1).text, /Выберите/);
});

test('failed procedure reload clears the old selection and offers the main menu', async t => {
  const chat = conversation();
  await chat.send('📋 Земельные процедуры');
  t.mock.method(mockApi, 'listProcedures', async () => { throw new Error('Service unavailable'); });
  await chat.click('procedures:list');
  assert.equal(chat.replies.at(-1).text, 'Service unavailable');
  assert.equal(chat.replies.at(-1).extra.reply_markup.keyboard.length, 4);
  const count = chat.replies.length;
  await chat.send('Сведения об участке');
  assert.equal(chat.replies.length, count);
});
