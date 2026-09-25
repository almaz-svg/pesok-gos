import { Markup } from 'telegraf';
import { listReports } from './api.js';

const PAGE_SIZE = 5;
const statusLabels = {
  signal_received: 'Сигнал сохранён',
  under_review: 'На рассмотрении',
  inspection_scheduled: 'Назначена проверка',
  approved: 'Одобрено',
  rejected: 'Отклонено',
};
const nextSteps = {
  signal_received: 'Проверьте статус позже: сигнал сохранён в сервисе.',
  under_review: 'Проверяйте обновления и сохраняйте дополнительные материалы по проблеме.',
  inspection_scheduled: 'Сохраните новые фото участка, если ситуация изменится.',
  approved: 'Ознакомьтесь с решением и проверьте, устранена ли проблема.',
  rejected: 'Ознакомьтесь с причиной отказа в ответе и уточните недостающие сведения.',
};

function dateLabel(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty' }).format(date)
    : 'не указана';
}

function statusLabel(report) {
  return report.demoOnly ? 'Сохранено в боте' : statusLabels[report.status] || 'Статус уточняется';
}

function shortText(value, limit) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > limit ? `${text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : text;
}

function mapUrl(report) {
  if (!Number.isFinite(report.lat) || Math.abs(report.lat) > 90
    || !Number.isFinite(report.lon) || Math.abs(report.lon) > 180) return null;
  return `https://www.openstreetmap.org/?mlat=${report.lat}&mlon=${report.lon}#map=17/${report.lat}/${report.lon}`;
}

function reportText(report) {
  const nextStep = report.demoOnly
    ? 'Для официального обращения перейдите в eOtinish. Сохраните фото и координаты.'
    : shortText(report.nextStep, 500) || nextSteps[report.status] || 'Обновите карточку позже, чтобы проверить статус.';
  const lines = [
    `Обращение ${report.id}`,
    `Статус: ${statusLabel(report)}`,
    `Создано: ${dateLabel(report.createdAt)}`,
  ];
  if (report.updatedAt) lines.push(`Обновлено: ${dateLabel(report.updatedAt)}`);
  if (report.demoOnly) lines.push('', 'Демо-сигнал. В госорганы не отправлялся.');
  lines.push('', 'Описание:', shortText(report.description, 2000) || 'Не указано.');
  lines.push('', mapUrl(report) ? `Координаты: ${report.lat}, ${report.lon}` : 'Координаты не указаны.');
  if (report.explanation) lines.push('', shortText(report.explanation, 400));
  lines.push('', `Следующий шаг: ${nextStep}`);
  return lines.join('\n');
}

const menuButton = () => [Markup.button.callback('Главное меню', 'reports:menu')];

export function registerReportCabinet(bot, { menu, clearState }) {
  async function run(ctx, action) {
    if (ctx.callbackQuery) {
      try {
        await ctx.answerCbQuery();
      } catch {
        // Telegram may expire the acknowledgement; still handle the action below.
      }
    }
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Мои обращения доступны только в личном чате с ботом.');
      return;
    }
    clearState(ctx);
    try {
      await action();
    } catch (error) {
      await ctx.reply(error.message, Markup.inlineKeyboard([
        [Markup.button.callback('Повторить', 'reports:page:0')],
        menuButton(),
      ]));
    }
  }

  async function loadReports(ctx) {
    const reports = await listReports(ctx.from.id);
    if (reports.some(report => typeof report.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(report.id))) {
      throw new Error('Сервис вернул некорректный номер обращения. Попробуйте позже.');
    }
    return reports;
  }

  async function showList(ctx, requestedPage = 0) {
    const reports = await loadReports(ctx);
    if (!reports.length) {
      await ctx.reply('У вас пока нет обращений. Чтобы зафиксировать проблему, выберите «Сообщить о проблеме».', menu);
      return;
    }
    const pageCount = Math.ceil(reports.length / PAGE_SIZE);
    const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
    const items = reports.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const text = [
      `Мои обращения: ${reports.length}`,
      `Страница ${page + 1} из ${pageCount}`,
      ...items.map(report => `\n${report.id} | ${dateLabel(report.createdAt)}\n${statusLabel(report)}\n${shortText(report.description, 100)}`),
    ].join('\n');
    const rows = items.map(report => [Markup.button.callback(`Открыть ${report.id}`, `reports:open:${report.id}`)]);
    const navigation = [];
    if (page > 0) navigation.push(Markup.button.callback('Назад', `reports:page:${page - 1}`));
    if (page < pageCount - 1) navigation.push(Markup.button.callback('Далее', `reports:page:${page + 1}`));
    if (navigation.length) rows.push(navigation);
    rows.push([Markup.button.callback('Обновить', `reports:page:${page}`)], menuButton());
    await ctx.reply(text, Markup.inlineKeyboard(rows));
  }

  async function showReport(ctx, id, photoOnly) {
    const reports = await loadReports(ctx);
    const index = reports.findIndex(report => report.id === id);
    if (index === -1) {
      await ctx.reply('Обращение не найдено или недоступно.', Markup.inlineKeyboard([
        [Markup.button.callback('К списку', 'reports:page:0')], menuButton(),
      ]));
      return;
    }
    const report = reports[index];
    if (photoOnly) {
      if (!report.telegramFileId) {
        await ctx.reply('У этого обращения нет сохранённого фото.');
        return;
      }
      await ctx.replyWithPhoto(report.telegramFileId, { caption: `Фото обращения ${report.id}` });
      return;
    }
    const rows = [];
    if (report.telegramFileId) rows.push([Markup.button.callback('Фото', `reports:photo:${report.id}`)]);
    const url = mapUrl(report);
    if (url) rows.push([Markup.button.url('Открыть на карте', url)]);
    if (report.demoOnly) rows.push([Markup.button.url('Открыть eOtinish', 'https://eotinish.kz/ru')]);
    rows.push(
      [Markup.button.callback('Обновить статус', `reports:open:${report.id}`)],
      [Markup.button.callback('К списку', `reports:page:${Math.floor(index / PAGE_SIZE)}`)],
      menuButton(),
    );
    await ctx.reply(reportText(report), {
      ...Markup.inlineKeyboard(rows),
      link_preview_options: { is_disabled: true },
    });
  }

  bot.hears('Мои обращения', ctx => run(ctx, () => showList(ctx)));
  bot.command('reports', ctx => run(ctx, () => showList(ctx)));
  bot.action(/^reports:page:(\d+)$/, ctx => run(ctx, () => showList(ctx, Number(ctx.match[1]))));
  bot.action(/^reports:(open|photo):(.+)$/, ctx => run(ctx, () => showReport(ctx, ctx.match[2], ctx.match[1] === 'photo')));
  bot.action('reports:menu', ctx => run(ctx, () => ctx.reply('Выберите действие:', menu)));
}
