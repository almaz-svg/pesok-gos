import { Markup, Telegraf } from 'telegraf';
import { createReport, getApplication, listProcedures } from './api.js';
import { config } from './config.js';
import { registerReportCabinet } from './report-cabinet.js';

const MENU = Markup.keyboard([
  ['📍 Сообщить о проблеме', 'Мои обращения'],
  ['🔎 Проверить заявление', '📋 Земельные процедуры'],
]).resize();

const CANCEL = Markup.keyboard([['Отмена']]).resize();
const SHARE_LOCATION = Markup.keyboard([
  [Markup.button.locationRequest('📍 Отправить геолокацию')],
  ['Отмена'],
]).resize();

const steps = {
  location: 'Отправьте геолокацию кнопкой ниже или прикрепите её через скрепку.',
  photo: 'Пришлите фотографию участка. Для отправки сигнала фото обязательно.',
  description: 'Кратко опишите, что произошло. Например: «На участке ведут земляные работы».',
};

function formatDate(value) {
  if (!value) return 'не указана';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ru-RU').format(date);
}

function statusLabel(stage) {
  return {
    under_review: 'На рассмотрении',
    inspection_scheduled: 'Назначена проверка',
    approved: 'Одобрено',
    rejected: 'Отклонено',
  }[stage] || stage || 'Статус не указан';
}

function procedureText(procedure) {
  const lines = [`📋 ${procedure.title || 'Процедура'}`];
  if (procedure.demoOnly) lines.push('🧪 Демонстрационные данные');
  else if (procedure.referenceOnly) lines.push('Справочная инструкция');
  if (procedure.steps?.length) lines.push('', 'Порядок действий:', ...procedure.steps.map((step, i) => `${i + 1}. ${step}`));
  if (procedure.documents?.length) lines.push('', 'Документы:', ...procedure.documents.map(item => `• ${item}`));
  if (procedure.durationText) lines.push('', `Срок: ${procedure.durationText}`);
  if (procedure.note) lines.push('', procedure.note);
  const sourceUrl = procedure.sourceUrl || procedure.officialUrl;
  if (sourceUrl) lines.push('', `Источник: ${sourceUrl}`);
  if (procedure.sourceCheckedAt) lines.push(`Проверено: ${formatDate(procedure.sourceCheckedAt)}`);
  return lines.join('\n');
}

function procedureMenu(procedures) {
  const rows = procedures.map(procedure => [procedure.menuLabel || procedure.title]);
  if (config.dataMode === 'mock') rows.push(['Демо-сигнал']);
  rows.push(['Главное меню']);
  return Markup.keyboard(rows).resize();
}

export function createBot(token, telegramOptions = {}) {
  const bot = new Telegraf(token, { telegram: telegramOptions });
  const states = new Map();

  async function showProcedures(ctx) {
    states.delete(ctx.from.id);
    try {
      const payload = await listProcedures();
      const procedures = Array.isArray(payload) ? payload : payload.procedures;
      if (!procedures?.length) {
        await ctx.reply('Список процедур пока пуст.', MENU);
        return;
      }
      states.set(ctx.from.id, { step: 'procedure', procedures });
      await ctx.reply('Земельные процедуры\n\nВыберите тему:', procedureMenu(procedures));
    } catch (error) {
      await ctx.reply(error.message, MENU);
    }
  }

  function beginReport(ctx) {
    states.set(ctx.from.id, { step: 'location' });
    const notice = config.dataMode === 'mock'
      ? 'Демо-сигнал. Данные сохраняются только в этом боте и не отправляются в госорганы.\n\n'
      : '';
    return ctx.reply(`${notice}${steps.location}`, SHARE_LOCATION);
  }

  bot.start(async ctx => {
    states.delete(ctx.from.id);
    await ctx.reply(
      'Здравствуйте! Это бот цифрового мониторинга земель.\n\nВыберите действие:',
      MENU,
    );
  });

  bot.command('cancel', async ctx => {
    states.delete(ctx.from.id);
    await ctx.reply('Действие отменено. Выберите, что сделать дальше.', MENU);
  });

  bot.hears('Отмена', async ctx => {
    states.delete(ctx.from.id);
    await ctx.reply('Действие отменено. Выберите, что сделать дальше.', MENU);
  });

  bot.hears('Главное меню', ctx => {
    states.delete(ctx.from.id);
    return ctx.reply('Выберите действие:', MENU);
  });

  bot.hears('📍 Сообщить о проблеме', beginReport);
  if (config.dataMode === 'mock') bot.hears('Демо-сигнал', beginReport);

  bot.hears('🔎 Проверить заявление', async ctx => {
    states.set(ctx.from.id, { step: 'application' });
    await ctx.reply('Введите номер заявления, например KZ-2026-042.', CANCEL);
  });

  bot.hears('📋 Земельные процедуры', showProcedures);

  bot.action('procedures:list', async ctx => {
    await ctx.answerCbQuery();
    await showProcedures(ctx);
  });

  registerReportCabinet(bot, { menu: MENU, clearState: ctx => states.delete(ctx.from.id) });

  bot.on('location', async ctx => {
    const draft = states.get(ctx.from.id);
    if (!draft) return;
    if (draft.step !== 'location') {
      await ctx.reply(steps[draft.step] || 'Сначала выберите действие в меню.');
      return;
    }
    draft.lat = ctx.message.location.latitude;
    draft.lon = ctx.message.location.longitude;
    draft.step = 'photo';
    await ctx.reply(steps.photo, CANCEL);
  });

  bot.on('photo', async ctx => {
    const draft = states.get(ctx.from.id);
    if (!draft) return;
    if (draft.step !== 'photo') {
      await ctx.reply(steps[draft.step] || 'Сначала выберите действие в меню.');
      return;
    }
    draft.telegramFileId = ctx.message.photo.at(-1).file_id;
    draft.step = 'description';
    await ctx.reply(steps.description, CANCEL);
  });

  bot.on('text', async ctx => {
    const draft = states.get(ctx.from.id);
    if (!draft) return;

    if (draft.step === 'procedure') {
      const procedure = draft.procedures.find(item => (item.menuLabel || item.title) === ctx.message.text);
      if (!procedure) {
        await ctx.reply('Выберите тему из списка:', procedureMenu(draft.procedures));
        return;
      }
      const buttons = [];
      if (procedure.officialUrl) {
        buttons.push([Markup.button.url(procedure.officialButton || 'Открыть официальный сайт', procedure.officialUrl)]);
      }
      buttons.push([Markup.button.callback('Назад к процедурам', 'procedures:list')]);
      await ctx.reply(procedureText(procedure), {
        ...Markup.inlineKeyboard(buttons),
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    if (draft.step === 'location' || draft.step === 'photo') {
      await ctx.reply(steps[draft.step]);
      return;
    }

    if (draft.step === 'description') {
      const description = ctx.message.text.trim();
      if (!description || description.length > 2000) {
        await ctx.reply('Описание должно содержать от 1 до 2000 символов. Попробуйте ещё раз.');
        return;
      }
      try {
        const report = await createReport({
          telegramUserId: ctx.from.id,
          lat: draft.lat,
          lon: draft.lon,
          description,
          telegramFileId: draft.telegramFileId,
        });
        if (!report?.id) throw new Error('Сервис сохранил ответ без номера сигнала. Попробуйте проверить его позже.');
        states.delete(ctx.from.id);
        await ctx.reply(
          report.demoOnly
            ? `Демо-сигнал ${report.id} сохранён.\nВ госорганы не отправлялся.\n\nОфициальное обращение: https://eotinish.kz/ru`
            : `✅ Сигнал ${report.id} принят.\nСтатус: передан на первичную проверку.`,
          MENU,
        );
      } catch (error) {
        await ctx.reply(`${error.message}\n\nВаши данные сохранены в черновике. Отправьте описание ещё раз, чтобы повторить.`);
      }
      return;
    }

    if (draft.step === 'application') {
      const trackingNumber = ctx.message.text.trim();
      if (!/^[A-Za-z0-9-]{4,40}$/.test(trackingNumber)) {
        await ctx.reply('Номер должен содержать от 4 до 40 латинских букв, цифр или дефисов. Попробуйте ещё раз.');
        return;
      }
      try {
        const application = await getApplication(trackingNumber);
        states.delete(ctx.from.id);
        await ctx.reply(
          `${application.demoOnly ? '🧪 Демонстрационные данные\n' : ''}Заявление ${application.trackingNumber}\nСтатус: ${statusLabel(application.stage)}\n${application.explanation || ''}\nОбновлено: ${formatDate(application.updatedAt)}`,
          MENU,
        );
      } catch (error) {
        await ctx.reply(`${error.message}\n\nВведите номер ещё раз или нажмите «Отмена».`);
      }
    }
  });

  bot.catch((error, ctx) => {
    console.error(`Telegram update ${ctx.update.update_id} failed:`, error);
  });

  return bot;
}
