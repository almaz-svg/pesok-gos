import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Telegraf } from 'telegraf';
import {
  configureTelegramProfile,
  launchTelegramBot,
  readStartupOptions,
  withTimeout,
} from '../src/startup.js';

test('connected bot keeps polling beyond the startup timeout and stops normally', async () => {
  const bot = new Telegraf('test-token');
  let markPollingStarted;
  const pollingStarted = new Promise(resolve => { markPollingStarted = resolve; });
  const me = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };
  bot.telegram.callApi = async (method, payload, options) => {
    if (method === 'getMe') return me;
    if (method === 'deleteWebhook') return true;
    assert.equal(method, 'getUpdates');
    if (!options?.signal) return [];
    markPollingStarted();
    return new Promise(resolve => options.signal.addEventListener('abort', () => resolve([]), { once: true }));
  };

  let connected = false;
  let settled = false;
  let launchError;
  const running = launchTelegramBot(bot, { telegramStartupTimeoutMs: 10 }, () => {
    connected = true;
  }).then(() => { settled = true; }, error => { settled = true; launchError = error; });

  try {
    await withTimeout(pollingStarted, 1000, 'Test polling');
    await delay(40);
    assert.equal(settled, false, launchError?.message);
    assert.equal(connected, true);
    assert.equal(bot.botInfo.username, 'test_bot');
  } finally {
    bot.stop('test');
    await running;
  }
  assert.equal(launchError, undefined);
});

test('startup rejects if authentication does not respond and never starts polling', async () => {
  let launched = false;
  const bot = {
    telegram: { getMe: () => new Promise(() => {}) },
    launch: () => { launched = true; return new Promise(() => {}); },
  };
  await assert.rejects(
    launchTelegramBot(bot, { telegramStartupTimeoutMs: 10 }),
    /Telegram getMe did not respond within 10 ms/,
  );
  assert.equal(launched, false);
});

test('polling failures propagate to the process error handler', async () => {
  const failure = new Error('409: another polling process is running');
  const bot = {
    telegram: { getMe: async () => ({ username: 'test_bot' }) },
    launch: async () => { throw failure; },
  };
  await assert.rejects(launchTelegramBot(bot, { telegramStartupTimeoutMs: 10 }), failure);
});

test('startup options default to a short Telegram startup timeout', () => {
  const options = readStartupOptions({});

  assert.equal(options.telegramStartupTimeoutMs, 15000);
  assert.equal(options.telegramSetupProfile, true);
});

test('startup options can disable nonessential Telegram profile setup', () => {
  const options = readStartupOptions({
    TELEGRAM_SETUP_PROFILE: 'false',
    TELEGRAM_STARTUP_TIMEOUT_MS: '2500',
  });

  assert.equal(options.telegramStartupTimeoutMs, 2500);
  assert.equal(options.telegramSetupProfile, false);
});

test('withTimeout rejects when Telegram does not answer quickly', async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 10, 'Telegram launch'),
    /Telegram launch did not respond within 10 ms/,
  );
});

test('profile setup can be skipped without calling Telegram profile methods', async () => {
  const calls = [];
  const bot = {
    telegram: {
      setMyName: async () => calls.push('setMyName'),
      setMyDescription: async () => calls.push('setMyDescription'),
      setMyShortDescription: async () => calls.push('setMyShortDescription'),
      setMyCommands: async () => calls.push('setMyCommands'),
    },
  };

  await configureTelegramProfile(bot, {
    telegramSetupProfile: false,
    telegramStartupTimeoutMs: 10,
  });

  assert.deepEqual(calls, []);
});

test('Telegram command menu includes the personal report cabinet', async () => {
  let publishedCommands = [];
  await configureTelegramProfile({
    telegram: {
      setMyName: async () => {},
      setMyDescription: async () => {},
      setMyShortDescription: async () => {},
      setMyCommands: async commands => { publishedCommands = commands; },
    },
  }, { telegramSetupProfile: true, telegramStartupTimeoutMs: 1000 });
  assert.ok(publishedCommands.some(command => command.command === 'reports'));
});
