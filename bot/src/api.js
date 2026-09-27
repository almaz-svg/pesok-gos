import { config } from './config.js';
import { mockApi } from './mock-api.js';
import { normalizeTelegramUserId, selectUserReports } from './reports.js';
import { formatLocationAnalysis } from './location.js';

const unavailable = 'Сервис временно недоступен. Попробуйте ещё раз чуть позже.';
const badList = 'Сервис вернул неизвестный формат списка обращений. Попробуйте позже.';

async function request(path, options = {}) {
  if (!config.botApiKey) throw new Error('Не настроена связь бота с сайтом. Обратитесь к администратору.');
  let response;
  try {
    response = await fetch(`${config.apiBaseUrl}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers, Authorization: `Bearer ${config.botApiKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch { throw new Error(unavailable); }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 404 && path.startsWith('/tracking/')) throw new Error('Заявление не найдено. Проверьте номер и попробуйте ещё раз.');
    if (response.status === 404) throw new Error('Метод Django API не найден. Проверьте адрес API и запущен ли backend.');
    if (response.status >= 500) throw new Error(unavailable);
    throw Object.assign(new Error(payload?.error?.message || 'Не удалось выполнить запрос. Попробуйте ещё раз.'), { status: response.status });
  }
  return payload;
}

export async function createReport(report) {
  const owner = normalizeTelegramUserId(report.telegramUserId);
  if (config.dataMode === 'mock') return mockApi.createReport({ ...report, telegramUserId: owner });
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(report.idempotencyKey || '')) throw new Error('Не задан ключ отправки обращения. Начните новое обращение.');
  const result = {
    language: report.language === 'kk' ? 'kk' : 'ru',
    ...(report.locationAnalysis ? { location_summary: formatLocationAnalysis(report.locationAnalysis, report.language).replaceAll('\\n', '\n') } : {}),
    ...(report.casePassport ? { case_passport: report.casePassport } : {}),
    ...(report.landCaseId ? { land_case_id: report.landCaseId } : {}),
  };
  const created = await request('/reports', {
    method: 'POST', headers: { 'Idempotency-Key': report.idempotencyKey },
    body: JSON.stringify({
      telegram_user_id: owner, location: { latitude: report.lat, longitude: report.lon },
      photos: [{ telegram_file_id: report.telegramFileId }], description: report.description,
      category: ({ waste_dump: 'DUMPING', land_grab: 'LAND_GRAB' })[report.casePassport?.type] || 'OTHER',
      bot_result: result,
    }),
  });
  if (!created.id || !created.tracking_number) throw new Error('Сервис сохранил ответ без номера сигнала. Попробуйте проверить его позже.');
  return { id: created.tracking_number, backendId: created.id, status: created.status, createdAt: created.created_at };
}

function cabinetReport(report) {
  return {
    id: report.tracking_number, backendId: report.id, telegramUserId: report.telegram_user_id,
    description: report.description, lat: report.location?.latitude, lon: report.location?.longitude,
    telegramFileId: report.photos?.[0]?.telegram_file_id, status: report.status,
    createdAt: report.created_at, updatedAt: report.updated_at,
    casePassport: report.bot_result?.case_passport, locationSummary: report.bot_result?.location_summary,
    nextStep: report.bot_result?.case_passport?.nextAction,
    landCaseId: report.bot_result?.land_case_id,
  };
}

export async function listReports(telegramUserId) {
  const owner = normalizeTelegramUserId(telegramUserId);
  if (config.dataMode === 'mock') return mockApi.listReports(owner);
  let path = `/bot/reports?telegram_user_id=${encodeURIComponent(owner)}`;
  const records = [], visited = new Set();
  while (path) {
    if (visited.has(path) || visited.size >= 1000) throw new Error(badList);
    visited.add(path);
    const payload = await request(path);
    if (!Array.isArray(payload?.results)) throw new Error(badList);
    records.push(...payload.results.filter(r => r && String(r.telegram_user_id) === owner).map(cabinetReport));
    path = null;
    if (payload.next) {
      const base = new URL(`${config.apiBaseUrl}/bot/reports`);
      let next;
      try { next = new URL(payload.next, base); } catch { throw new Error(badList); }
      if (next.origin !== base.origin || next.pathname !== base.pathname || next.username || next.password
        || next.searchParams.get('telegram_user_id') !== owner || !/^[1-9]\d*$/.test(next.searchParams.get('page') || '')) throw new Error(badList);
      path = `/bot/reports?telegram_user_id=${owner}&page=${next.searchParams.get('page')}`;
    }
  }
  return selectUserReports(records, owner);
}

export async function getApplication(trackingNumber, telegramUserId) {
  if (config.dataMode === 'mock') return mockApi.getApplication(trackingNumber);
  const owner = normalizeTelegramUserId(telegramUserId);
  const item = await request(`/tracking/${encodeURIComponent(trackingNumber)}?telegram_user_id=${owner}`);
  return { trackingNumber: item.tracking_number, stage: item.status, explanation: item.status_label, updatedAt: item.updated_at };
}

export async function listProcedures() {
  if (config.dataMode === 'mock') return mockApi.listProcedures();
  const records = await request('/instructions');
  if (!Array.isArray(records)) throw new Error(unavailable);
  return records.map(item => ({ id: item.id, title: item.title, steps: [item.body], referenceOnly: true }));
}
