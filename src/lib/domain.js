export const STATUS_META = Object.freeze({
  NEW: { label: 'Новое обращение', color: '#f4d35e', tone: 'yellow' },
  INSPECTION: { label: 'На проверке', color: '#f4d35e', tone: 'yellow' },
  VIOLATION: { label: 'Нарушение выявлено', color: '#f16d65', tone: 'red' },
  IN_PROGRESS: { label: 'Устраняется', color: '#f16d65', tone: 'red' },
  RESOLVED: { label: 'Закрыто', color: '#9ddd72', tone: 'green' },
  NORMAL: { label: 'Без нарушений', color: '#9ddd72', tone: 'green' },
});

export const CATEGORY_LABELS = Object.freeze({
  DUMPING: 'Стихийная свалка',
  LAND_GRAB: 'Самозахват земли',
  UNUSED_LAND: 'Неиспользуемая земля',
  ABANDONED_PLOT: 'Заброшенный участок',
  OTHER: 'Другое',
});

export const TRANSITIONS = Object.freeze({
  NEW: ['INSPECTION'],
  INSPECTION: ['VIOLATION', 'RESOLVED'],
  VIOLATION: ['IN_PROGRESS'],
  IN_PROGRESS: ['RESOLVED'],
  RESOLVED: [],
});

export const TIME_ZONE = 'Asia/Qyzylorda';

export function formatDate(value) {
  if (!value) return 'Не назначен';
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('ru-RU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: TIME_ZONE,
      }).format(date);
}

export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('ru-RU', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: TIME_ZONE,
      }).format(date);
}

export function calendarDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type) => parts.find((entry) => entry.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function isOverdue(report, now = new Date()) {
  return (
    report.status !== 'RESOLVED' && Boolean(report.deadline && report.deadline < calendarDate(now))
  );
}

export function derivePlotStatus(reports) {
  if (reports.some((report) => ['VIOLATION', 'IN_PROGRESS'].includes(report.status)))
    return 'VIOLATION';
  if (reports.some((report) => ['NEW', 'INSPECTION'].includes(report.status))) return 'INSPECTION';
  return 'NORMAL';
}
