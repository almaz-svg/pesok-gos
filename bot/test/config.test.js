import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTelegramConfig, getTelegramConfig } from '../src/config.js';

test('Telegram config trims token and normalizes API URL', () => {
  const config = getTelegramConfig({
    BOT_TOKEN: ' token-from-botfather ',
    API_BASE_URL: 'http://localhost:8000/api///',
  });

  assert.equal(config.botToken, 'token-from-botfather');
  assert.equal(config.apiBaseUrl, 'http://localhost:8000/api');
  assert.equal(config.telegramApiRoot, 'https://api.telegram.org');
  assert.equal(config.dataMode, 'mock');
});

test('Telegram config falls back to the default API URL when env value is blank', () => {
  const config = getTelegramConfig({
    BOT_TOKEN: 'telegram-token',
    API_BASE_URL: '   ',
  });

  assert.equal(config.apiBaseUrl, 'http://127.0.0.1:8000/api');
});

test('Telegram config normalizes custom Telegram API root', () => {
  const config = getTelegramConfig({
    BOT_TOKEN: 'telegram-token',
    TELEGRAM_API_ROOT: ' http://127.0.0.1:8081/// ',
  });

  assert.equal(config.telegramApiRoot, 'http://127.0.0.1:8081');
});

test('Telegram startup rejects a missing bot token', () => {
  assert.throws(() => ensureTelegramConfig(getTelegramConfig({})), /BOT_TOKEN is required/);
});

test('Telegram startup rejects an unknown data mode', () => {
  const config = getTelegramConfig({ BOT_TOKEN: 'telegram-token', DATA_MODE: 'external' });
  assert.throws(() => ensureTelegramConfig(config), /DATA_MODE must be either mock or api/);
});
