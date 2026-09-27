import { config, ensureTelegramConfig } from './config.js';
import { createBot } from './bot.js';
import { Markup } from 'telegraf';
import { createLandService } from './land/service.js';
import { createMonitor } from './land/monitor.js';
import { eventText, landCopy } from './land/messages.js';
import {
  configureTelegramProfile,
  formatStartupError,
  launchTelegramBot,
  readStartupOptions,
} from './startup.js';

async function start() {
  const { botToken, telegramApiRoot } = ensureTelegramConfig(config);
  const startupOptions = readStartupOptions();
  const landService = createLandService();
  const bot = createBot(botToken, { apiRoot: telegramApiRoot }, { landService });
  const monitor = createMonitor({
    store: landService.store,
    analyze: record => landService.analyzeMonitor(record),
    notify: (record, event) => bot.telegram.sendMessage(record.owner, eventText(record, event),
      Markup.inlineKeyboard([[Markup.button.callback(landCopy(record.language).open, `land:open:${record.id}`)]])),
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      monitor.stop();
      try {
        bot.stop(signal);
      } catch (error) {
        if (error.message !== 'Bot is not running!') throw error;
        process.exit(0);
      }
    });
  }

  await launchTelegramBot(bot, startupOptions, () => {
    void monitor.start().catch(() => {});
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
