import 'dotenv/config';

export function getTelegramConfig(env = process.env) {
  const botToken = env.BOT_TOKEN?.trim() || '';
  const apiBaseUrl = (env.API_BASE_URL?.trim() || 'http://127.0.0.1:8000/api').replace(/\/+$/, '');
  const telegramApiRoot = (env.TELEGRAM_API_ROOT?.trim() || 'https://api.telegram.org').replace(/\/+$/, '');
  const dataMode = (env.DATA_MODE || 'mock').trim().toLowerCase();

  const botApiKey = env.BOT_API_KEY?.trim() || '';
  return { botToken, apiBaseUrl, telegramApiRoot, dataMode, botApiKey };
}

export const config = getTelegramConfig();

export function ensureTelegramConfig(currentConfig = config) {
  if (!currentConfig.botToken) {
    throw new Error('BOT_TOKEN is required. Add your Telegram bot token to the local .env file.');
  }
  if (!['mock', 'api'].includes(currentConfig.dataMode)) {
    throw new Error('DATA_MODE must be either mock or api.');
  }
  if (currentConfig.dataMode === 'api' && !currentConfig.botApiKey) {
    throw new Error('BOT_API_KEY is required in api mode. Use the same server key as Django.');
  }

  return currentConfig;
}
