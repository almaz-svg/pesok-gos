import fixture from '../data/demo.json' with { type: 'json' };
import { CATEGORY_LABELS, TRANSITIONS, derivePlotStatus, isOverdue } from './domain.js';

const environment = import.meta.env ?? {};
export const dataMode = environment.VITE_DATA_MODE || 'demo';
export const API_BASE_URL = environment.VITE_API_BASE_URL || '/api';
export const DEMO_STORAGE_KEY = 'pesok-gos:demo:v1';

export class ApiError extends Error {
  constructor(
    message,
    { status = 0, code = 'network_error', fields = {}, requestId = '', retryAfter = null } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, { status, code, fields, requestId, retryAfter });
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const has = (value, key) => Object.hasOwn(value, key);
const newId = () => globalThis.crypto.randomUUID();
const snapshot = (report) => ({
  status: report.status,
  deadline: report.deadline,
  plot_id: report.plot?.id ?? null,
});
const assertActive = (signal) => {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Запрос отменён', 'AbortError');
};
const validation = (fields, message = 'Проверьте поля запроса') =>
  new ApiError(message, { status: 400, code: 'validation_error', fields });

function validDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(new Date(`${value}T00:00:00Z`).getTime()) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

function validateMapResponse(data) {
  const position = (value) =>
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 90;
  const ring = (value) =>
    Array.isArray(value) &&
    value.length >= 4 &&
    value.every(position) &&
    value[0][0] === value.at(-1)[0] &&
    value[0][1] === value.at(-1)[1];
  const polygon = (value) => Array.isArray(value) && value.length > 0 && value.every(ring);
  const feature = (item, layer) => {
    if (
      !item ||
      item.type !== 'Feature' ||
      typeof item.id !== 'string' ||
      !item.id ||
      !item.properties
    )
      return false;
    const { geometry, properties } = item;
    if (layer === 'reports') {
      return (
        geometry?.type === 'Point' &&
        position(geometry.coordinates) &&
        has(TRANSITIONS, properties.status) &&
        has(CATEGORY_LABELS, properties.category) &&
        typeof properties.tracking_number === 'string' &&
        (properties.plot_id === null || typeof properties.plot_id === 'string') &&
        (properties.deadline === null || validDate(properties.deadline)) &&
        typeof properties.is_overdue === 'boolean'
      );
    }
    return (
      (geometry?.type === 'Polygon'
        ? polygon(geometry.coordinates)
        : geometry?.type === 'MultiPolygon' &&
          Array.isArray(geometry.coordinates) &&
          geometry.coordinates.length > 0 &&
          geometry.coordinates.every(polygon)) &&
      ['NORMAL', 'INSPECTION', 'VIOLATION'].includes(properties.status) &&
      typeof properties.cadastral_number === 'string' &&
      Number.isFinite(properties.area_ha) &&
      properties.area_ha >= 0
    );
  };
  if (
    !data ||
    !['reports', 'plots'].every(
      (layer) =>
        data[layer]?.type === 'FeatureCollection' &&
        Array.isArray(data[layer].features) &&
        data[layer].features.every((item) => feature(item, layer)),
    )
  ) {
    throw new ApiError('Сервер вернул некорректные данные карты. Повторите загрузку.', {
      status: 200,
      code: 'invalid_response',
    });
  }
  return data;
}

/** Isolated stores make the demo lifecycle testable without browser or backend. */
export function createDemoStore({
  storage = null,
  now = () => new Date(),
  initialData = fixture,
} = {}) {
  let memory = clone(initialData);
  let user = { id: '50000000-0000-4000-8000-000000000001', username: 'Демо-инспектор' };

  function read() {
    try {
      const saved = storage?.getItem(DEMO_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.schema === 1 && Array.isArray(parsed.reports) && Array.isArray(parsed.plots))
          memory = parsed;
      }
    } catch {
      /* Private browsing or a damaged demo cache: retain this tab's data. */
    }
    return clone(memory);
  }

  function save(state) {
    memory = clone(state);
    try {
      storage?.setItem(DEMO_STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* The demo still works in memory. */
    }
  }

  function reportsOf(state) {
    return state.reports.map((report) => ({ ...report, is_overdue: isOverdue(report, now()) }));
  }

  function plotsOf(state) {
    return state.plots.map((plot) => {
      const related = state.reports.filter((report) => report.plot?.id === plot.id);
      return {
        ...plot,
        status: derivePlotStatus(related),
        active_reports_count: related.filter((report) => report.status !== 'RESOLVED').length,
      };
    });
  }

  return {
    async getReports({ signal } = {}) {
      assertActive(signal);
      return reportsOf(read())
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
        .map(({ history: _history, ...report }) => report);
    },
    async getPlots({ signal } = {}) {
      assertActive(signal);
      return plotsOf(read()).sort(
        (a, b) => a.cadastral_number.localeCompare(b.cadastral_number) || a.id.localeCompare(b.id),
      );
    },
    async getReport(id, { signal } = {}) {
      assertActive(signal);
      const report = reportsOf(read()).find((entry) => entry.id === id);
      if (!report) throw new ApiError('Обращение не найдено', { status: 404, code: 'not_found' });
      return report;
    },
    async getMap({ signal } = {}) {
      assertActive(signal);
      const state = read();
      return {
        plots: {
          type: 'FeatureCollection',
          features: plotsOf(state)
            .filter((plot) => plot.geometry)
            .map((plot) => ({
              type: 'Feature',
              id: plot.id,
              geometry: plot.geometry,
              properties: {
                cadastral_number: plot.cadastral_number,
                status: plot.status,
                area_ha: plot.area_ha,
              },
            })),
        },
        reports: {
          type: 'FeatureCollection',
          features: reportsOf(state).map((report) => ({
            type: 'Feature',
            id: report.id,
            geometry: {
              type: 'Point',
              coordinates: [report.location.longitude, report.location.latitude],
            },
            properties: {
              tracking_number: report.tracking_number,
              status: report.status,
              category: report.category,
              plot_id: report.plot?.id ?? null,
              deadline: report.deadline,
              is_overdue: report.is_overdue,
            },
          })),
        },
      };
    },
    async getStatistics({ signal } = {}) {
      assertActive(signal);
      const state = read();
      const reports = reportsOf(state);
      return {
        total_plots: state.plots.length,
        active_violations: reports.filter((report) =>
          ['VIOLATION', 'IN_PROGRESS'].includes(report.status),
        ).length,
        under_inspection: reports.filter((report) => ['NEW', 'INSPECTION'].includes(report.status))
          .length,
        resolved: reports.filter((report) => report.status === 'RESOLVED').length,
        overdue: reports.filter((report) => report.is_overdue).length,
      };
    },
    async patchReport(id, payload) {
      const state = read();
      const report = state.reports.find((entry) => entry.id === id);
      if (!report) throw new ApiError('Обращение не найдено', { status: 404, code: 'not_found' });
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw validation({ body: ['Ожидается объект изменений'] });
      const fields = {};
      for (const key of Object.keys(payload)) {
        if (!['version', 'status', 'deadline', 'plot_id', 'comment'].includes(key))
          fields[key] = ['Неизвестное поле'];
      }
      if (!Number.isInteger(payload.version) || payload.version < 1)
        fields.version = ['Укажите версию из карточки'];
      if (has(payload, 'status') && !has(TRANSITIONS, payload.status))
        fields.status = ['Неизвестный статус'];
      if (has(payload, 'deadline') && payload.deadline !== null && !validDate(payload.deadline))
        fields.deadline = ['Ожидается дата YYYY-MM-DD'];
      if (
        has(payload, 'plot_id') &&
        payload.plot_id !== null &&
        !state.plots.some((plot) => plot.id === payload.plot_id)
      )
        fields.plot_id = ['Участок не найден'];
      if (
        has(payload, 'comment') &&
        (typeof payload.comment !== 'string' ||
          !payload.comment.trim() ||
          payload.comment.trim().length > 2000)
      )
        fields.comment = ['Введите комментарий от 1 до 2000 символов'];
      if (Object.keys(fields).length) throw validation(fields);
      if (payload.version !== report.version)
        throw new ApiError('Обращение уже изменено. Обновите карточку перед сохранением.', {
          status: 409,
          code: 'version_conflict',
        });

      const status = payload.status ?? report.status;
      const deadline = has(payload, 'deadline') ? payload.deadline : report.deadline;
      const comment = payload.comment?.trim() ?? null;
      if (status !== report.status && !TRANSITIONS[report.status].includes(status)) {
        throw new ApiError('Этот переход статуса недоступен', {
          status: 409,
          code: 'invalid_transition',
          fields: { status: ['Выберите следующий разрешённый статус'] },
        });
      }
      if (status === 'IN_PROGRESS' && !deadline)
        throw validation({ deadline: ['Назначьте контрольный срок устранения'] });
      if (status === 'RESOLVED' && report.status !== 'RESOLVED' && !comment)
        throw validation({ comment: ['Укажите причину закрытия'] });
      const plotId = has(payload, 'plot_id') ? payload.plot_id : (report.plot?.id ?? null);
      if (
        status === report.status &&
        deadline === report.deadline &&
        plotId === (report.plot?.id ?? null) &&
        !comment
      ) {
        throw new ApiError('Нет изменений для сохранения', { status: 400, code: 'no_changes' });
      }
      const before = snapshot(report);
      const plot = state.plots.find((entry) => entry.id === plotId);
      Object.assign(report, {
        status,
        deadline,
        plot: plot ? { id: plot.id, cadastral_number: plot.cadastral_number } : null,
        updated_at: now().toISOString(),
        version: report.version + 1,
      });
      report.is_overdue = isOverdue(report, now());
      report.history.push({
        id: newId(),
        event: 'UPDATED',
        before,
        after: snapshot(report),
        comment,
        actor: { type: 'INSPECTOR', label: user?.username || 'Демо-инспектор' },
        created_at: report.updated_at,
      });
      save(state);
      return clone(report);
    },
    async getSession() {
      if (!user)
        throw new ApiError('Войдите в систему', { status: 401, code: 'authentication_required' });
      return clone(user);
    },
    async login(username, password) {
      if (!username?.trim() || !password)
        throw new ApiError('Заполните логин и пароль', {
          status: 401,
          code: 'invalid_credentials',
        });
      user = { id: '50000000-0000-4000-8000-000000000001', username: username.trim() };
      return { user: clone(user), csrf_token: 'demo-session' };
    },
    async logout() {
      user = null;
    },
    async addDemoReport() {
      const state = read();
      const sequence = state.next_report++;
      const id = newId();
      const createdAt = now().toISOString();
      const report = {
        id,
        tracking_number: `DEMO-${now().getFullYear()}-${String(sequence).padStart(6, '0')}`,
        category: 'OTHER',
        description:
          'Новый учебный сигнал из демонстрации Telegram-бота. Проверьте сведения, выберите участок и назначьте первичный осмотр. Все данные вымышлены.',
        location: {
          latitude: 43.299 + (sequence % 5) * 0.0018,
          longitude: 68.27 + (sequence % 4) * 0.0021,
        },
        plot: null,
        status: 'NEW',
        deadline: null,
        is_overdue: false,
        photos: [],
        version: 1,
        created_at: createdAt,
        updated_at: createdAt,
        history: [],
      };
      report.history.push({
        id: newId(),
        event: 'CREATED',
        before: null,
        after: snapshot(report),
        comment: 'Добавлен учебный сигнал',
        actor: { type: 'BOT', label: 'Демонстрация Telegram-бота' },
        created_at: createdAt,
      });
      state.reports.push(report);
      save(state);
      return clone(report);
    },
    async resetDemoData() {
      save(clone(initialData));
    },
  };
}

export function createApiClient({
  baseUrl = API_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  origin = globalThis.location?.origin || 'http://localhost',
} = {}) {
  const root = new URL(baseUrl.replace(/\/+$/, '') + '/', origin);
  let csrfToken = null;

  function endpoint(path, relativeTo = root) {
    const url = new URL(path, relativeTo);
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
      throw new ApiError('API вернул адрес за пределами настроенного сервера', {
        code: 'invalid_response',
      });
    }
    return url;
  }

  async function request(path, { method = 'GET', body, signal } = {}) {
    assertActive(signal);
    const url = path instanceof URL ? endpoint(path.href) : endpoint(path);
    if (method !== 'GET' && !csrfToken) {
      const response = await request('auth/csrf', { signal });
      if (!response?.csrf_token)
        throw new ApiError('Сервер не вернул CSRF-токен', { code: 'invalid_response' });
      csrfToken = response.csrf_token;
    }
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl(url.href, {
        method,
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(method !== 'GET' ? { 'X-CSRFToken': csrfToken } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      let data = null;
      if (response.status !== 204) {
        try {
          data = await response.json();
        } catch {
          if (response.ok)
            throw new ApiError('Сервер вернул ответ в неожиданном формате', {
              status: response.status,
              code: 'invalid_response',
            });
        }
      }
      if (!response.ok) {
        const error = data?.error ?? {};
        if (error.code === 'csrf_failed') csrfToken = null;
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfter =
          retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : null;
        throw new ApiError(error.message || `Ошибка сервера (${response.status})`, {
          status: response.status,
          code: error.code || (response.status === 401 ? 'authentication_required' : 'http_error'),
          fields: error.fields || {},
          requestId: error.request_id || '',
          retryAfter,
        });
      }
      return data;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Запрос отменён', 'AbortError');
      if (timedOut)
        throw new ApiError('Сервер не ответил вовремя. Повторите загрузку.', { code: 'timeout' });
      if (error instanceof ApiError) throw error;
      throw new ApiError('Не удалось связаться с сервером. Проверьте подключение.', {
        code: 'network_error',
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function allPages(path, options) {
    const results = [];
    const visited = new Set();
    let url = endpoint(path);
    while (url) {
      if (visited.has(url.href) || visited.size >= 10000)
        throw new ApiError('Ошибка пагинации ответа API', { code: 'invalid_response' });
      visited.add(url.href);
      const page = await request(url, options);
      if (
        !page ||
        !Array.isArray(page.results) ||
        !(page.next === null || typeof page.next === 'string')
      ) {
        throw new ApiError('Сервер вернул некорректный список', { code: 'invalid_response' });
      }
      results.push(...page.results);
      url = page.next ? endpoint(page.next, url) : null;
    }
    return results;
  }

  return {
    async getMap({ signal, bbox } = {}) {
      const url = endpoint('map');
      if (bbox !== undefined) {
        if (
          !Array.isArray(bbox) ||
          bbox.length !== 4 ||
          !bbox.every(Number.isFinite) ||
          !(-180 <= bbox[0] && bbox[0] < bbox[2] && bbox[2] <= 180) ||
          !(-90 <= bbox[1] && bbox[1] < bbox[3] && bbox[3] <= 90)
        ) {
          throw validation({ bbox: ['Ожидаются границы west, south, east, north в WGS84'] });
        }
        url.searchParams.set('bbox', bbox.join(','));
      }
      return validateMapResponse(await request(url, { signal }));
    },
    getReports: (options) => allPages('reports?page_size=100', options),
    getPlots: (options) => allPages('plots?page_size=100', options),
    getReport: (id, options) => request(`reports/${encodeURIComponent(id)}`, options),
    patchReport: (id, payload) =>
      request(`reports/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }),
    getStatistics: (options) => request('statistics', options),
    getSession: (options) => request('auth/me', options),
    async login(username, password) {
      const response = await request('auth/login', {
        method: 'POST',
        body: { username, password },
      });
      csrfToken = response.csrf_token;
      return response;
    },
    async logout() {
      await request('auth/logout', { method: 'POST', body: {} });
      csrfToken = null;
    },
    photoUrl(url) {
      try {
        const photo = new URL(url, root.origin);
        return photo.origin === root.origin && ['http:', 'https:'].includes(photo.protocol)
          ? photo.href
          : '';
      } catch {
        return '';
      }
    },
  };
}

let browserStorage = null;
try {
  browserStorage = globalThis.localStorage ?? null;
} catch {
  /* Storage may be unavailable. */
}
const client =
  dataMode === 'demo' ? createDemoStore({ storage: browserStorage }) : createApiClient();

function call(method, ...args) {
  if (!['demo', 'api'].includes(dataMode))
    return Promise.reject(
      new ApiError('Укажите VITE_DATA_MODE=demo или api', { code: 'configuration_error' }),
    );
  return client[method](...args);
}

export const getMap = (options) => call('getMap', options);
export const getReports = (options) => call('getReports', options);
export const getPlots = (options) => call('getPlots', options);
export const getReport = (id, options) => call('getReport', id, options);
export const patchReport = (id, payload) => call('patchReport', id, payload);
export const getStatistics = (options) => call('getStatistics', options);
export const getSession = (options) => call('getSession', options);
export const login = (username, password) => call('login', username, password);
export const logout = () => call('logout');
export const photoUrl = (url) =>
  dataMode === 'demo' ? (url === '/demo-photo.svg' ? url : '') : client.photoUrl(url);
export const addDemoReport = () =>
  dataMode === 'demo'
    ? client.addDemoReport()
    : Promise.reject(
        new ApiError('Учебные сигналы доступны только в деморежиме', { code: 'demo_only' }),
      );
export const resetDemoData = () =>
  dataMode === 'demo'
    ? client.resetDemoData()
    : Promise.reject(new ApiError('Сброс доступен только в деморежиме', { code: 'demo_only' }));
