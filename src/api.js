import { config } from './config.js';
import { mockApi } from './mock-api.js';
import { normalizeTelegramUserId, selectUserReports } from './reports.js';

async function request(path, options) {
  let response;
  try {
    response = await fetch(`${config.apiBaseUrl}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('Сервис временно недоступен. Попробуйте ещё раз чуть позже.');
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message;
    if (response.status === 404 && path.startsWith('/applications/')) {
      throw new Error('Заявление не найдено. Проверьте номер и попробуйте ещё раз.');
    }
    if (response.status === 404) {
      throw new Error('Метод Django API не найден. Проверьте адрес API и запущен ли backend.');
    }
    throw new Error(message || 'Не удалось выполнить запрос. Попробуйте ещё раз.');
  }
  return payload;
}

export function createReport(report) {
  const ownedReport = { ...report, telegramUserId: normalizeTelegramUserId(report.telegramUserId) };
  if (config.dataMode === 'mock') return mockApi.createReport(ownedReport);
  return request('/reports', { method: 'POST', body: JSON.stringify(ownedReport) });
}

export async function listReports(telegramUserId) {
  const owner = normalizeTelegramUserId(telegramUserId);
  const payload = config.dataMode === 'mock'
    ? await mockApi.listReports(owner)
    : await request(`/reports?telegramUserId=${encodeURIComponent(owner)}`);
  const reports = Array.isArray(payload) ? payload : payload?.reports;
  if (!Array.isArray(reports)) {
    throw new Error('Сервис вернул неизвестный формат списка обращений. Попробуйте позже.');
  }
  return selectUserReports(reports, owner);
}

export function getApplication(trackingNumber) {
  if (config.dataMode === 'mock') return mockApi.getApplication(trackingNumber);
  return request(`/applications/${encodeURIComponent(trackingNumber)}`);
}

export function listProcedures() {
  if (config.dataMode === 'mock') return mockApi.listProcedures();
  return request('/procedures');
}
