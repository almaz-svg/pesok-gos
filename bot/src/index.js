import { config, ensureTelegramConfig } from './config.js';
import { createBot } from './bot.js';
import {
  configureTelegramProfile,
  formatStartupError,
  launchTelegramBot,
  readStartupOptions,
} from './startup.js';

async function start() {
  const { botToken, telegramApiRoot } = ensureTelegramConfig(config);
  const startupOptions = readStartupOptions();
  const bot = createBot(botToken, { apiRoot: telegramApiRoot });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      try {
        bot.stop(signal);
      } catch (error) {
        if (error.message !== 'Bot is not running!') throw error;
        process.exit(0);
      }
    });
  }

  await launchTelegramBot(bot, startupOptions, () => {
    console.log(`Жер Мониторинг запущен. Откройте бота в Telegram: @${bot.botInfo.username}`);
    configureTelegramProfile(bot, startupOptions).catch(error => {
      console.warn(`Не удалось обновить профиль бота: ${error.message}`);
    });
  });
}

start().catch(error => {
  console.error(formatStartupError(error));
  process.exit(1);
});
