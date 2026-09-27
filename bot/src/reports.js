export function normalizeTelegramUserId(value) {
  if (!['string', 'number'].includes(typeof value)
    || !/^[1-9]\d*$/.test(String(value))
    || !Number.isSafeInteger(Number(value))) {
    throw new Error('Не удалось определить пользователя Telegram. Откройте бота заново.');
  }
  return String(value);
}

export function selectUserReports(reports, telegramUserId) {
  const owner = normalizeTelegramUserId(telegramUserId);
  return reports
    .filter(report => report && String(report.telegramUserId) === owner)
    .sort((a, b) => {
      const dateOrder = (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
      return dateOrder || String(b.id).localeCompare(String(a.id), 'en', { numeric: true });
    });
}
