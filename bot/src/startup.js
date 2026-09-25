export const commands = [
  { command: 'start', description: 'Открыть главное меню' },
  { command: 'reports', description: 'Мои обращения' },
  { command: 'language', description: 'Язык / Тіл' },
  { command: 'cancel', description: 'Отменить текущее действие' },
];

const profile = {
  name: 'Жер Мониторинг',
  description:
    'Бот цифрового мониторинга земель. Отправьте геолокацию, фото и описание проблемы; проверьте заявление или откройте земельные процедуры.',
  shortDescription: 'Сигналы о земельных проблемах, проверка заявлений и инструкции.',
};

export function readStartupOptions(env = process.env) {
  const timeout = Number(env.TELEGRAM_STARTUP_TIMEOUT_MS);
  const telegramSetupProfile = env.TELEGRAM_SETUP_PROFILE?.trim().toLowerCase() !== 'false';

  return {
    telegramStartupTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 15000,
    telegramSetupProfile,
  };
}

export async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not respond within ${timeoutMs} ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function launchTelegramBot(bot, options, onLaunch) {
  bot.botInfo = await withTimeout(
    bot.telegram.getMe(),
    options.telegramStartupTimeoutMs,
    'Telegram getMe',
  );
  // launch() stays pending for the entire polling lifetime, not just startup.
  return bot.launch({}, onLaunch);
}

export async function configureTelegramProfile(bot, options) {
  if (!options.telegramSetupProfile) return;

  const timeoutMs = options.telegramStartupTimeoutMs;
  await withTimeout(bot.telegram.setMyName(profile.name), timeoutMs, 'Telegram setMyName');
  await withTimeout(
    bot.telegram.setMyDescription(profile.description),
    timeoutMs,
    'Telegram setMyDescription',
  );
  await withTimeout(
    bot.telegram.setMyShortDescription(profile.shortDescription),
    timeoutMs,
    'Telegram setMyShortDescription',
  );
  await withTimeout(bot.telegram.setMyCommands(commands), timeoutMs, 'Telegram setMyCommands');
}

export function formatStartupError(error) {
  const message = error?.message || String(error);
  if (/EACCES|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|did not respond/i.test(message)) {
    return [
      `Не удалось подключиться к Telegram API: ${message}`,
      'Проверьте доступ к https://api.telegram.org, VPN/прокси, firewall и разрешение для node.exe.',
    ].join('\n');
  }
  return `Не удалось запустить Telegram-бота: ${message}`;
}
