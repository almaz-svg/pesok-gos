import { Markup, Telegraf } from 'telegraf';
import { createReport, getApplication, listProcedures } from './api.js';
import { analyzeViolationCase } from './case-analysis.js';
import { config } from './config.js';
import { registerReportCabinet } from './report-cabinet.js';
import { copyFor, formatDate, languageOf, localizeError, messages } from './i18n.js';
import { localizeProcedure } from './procedures.js';
import { userPreferences } from './user-preferences.js';

const LANGUAGE_PROMPT = 'Тілді таңдаңыз / Выберите язык:';
const LANGUAGE_MENU = Markup.inlineKeyboard([
  [Markup.button.callback('Қазақша', 'language:kk'), Markup.button.callback('Русский', 'language:ru')],
]);

function menu(ctx) {
  const copy = copyFor(ctx);
  return Markup.keyboard([
    [copy.report, copy.myReports],
    [copy.application, copy.procedures],
    ['Язык / Тіл'],
  ]).resize();
}

function cancelMenu(ctx) {
  return Markup.keyboard([[copyFor(ctx).cancel]]).resize();
}

function labels(key) {
  return Object.values(messages).map(copy => copy[key]);
}

const actionLabels = new Set([
  'Язык / Тіл',
  ...['report', 'myReports', 'application', 'procedures', 'demoReport', 'mainMenu', 'cancel'].flatMap(labels),
]);

async function answerCallback(ctx) {
  if (!ctx.callbackQuery) return;
  try {
    await ctx.answerCbQuery();
  } catch {
    // Delayed Telegram acknowledgements can expire while the action is still valid.
  }
}

function procedureText(procedure, ctx) {
  const copy = copyFor(ctx);
  const lines = [`📋 ${procedure.title || copy.procedure}`];
  if (procedure.demoOnly) lines.push(copy.demoData);
  else if (procedure.referenceOnly) lines.push(copy.reference);
  if (procedure.steps?.length) lines.push('', copy.stepsLabel, ...procedure.steps.map((step, i) => `${i + 1}. ${step}`));
  if (procedure.documents?.length) lines.push('', copy.documents, ...procedure.documents.map(item => `• ${item}`));
  if (procedure.durationText) lines.push('', `${copy.duration} ${procedure.durationText}`);
  if (procedure.note) lines.push('', procedure.note);
  const sourceUrl = procedure.sourceUrl || procedure.officialUrl;
  if (sourceUrl) lines.push('', `${copy.source} ${sourceUrl}`);
  if (procedure.sourceCheckedAt) lines.push(`${copy.checked} ${formatDate(procedure.sourceCheckedAt, languageOf(ctx))}`);
  return lines.join('\n');
}

function procedureMenu(procedures, ctx) {
  const rows = procedures.map(procedure => [procedure.menuLabel || procedure.title]);
  if (config.dataMode === 'mock') rows.push([copyFor(ctx).demoReport]);
  rows.push([copyFor(ctx).mainMenu]);
  return Markup.keyboard(rows).resize();
}

export function createBot(token, telegramOptions = {}, { preferences = userPreferences } = {}) {
  const bot = new Telegraf(token, { telegram: telegramOptions });
  const states = new Map();
  const languageSelections = new Map();

  async function showLanguagePicker(ctx, error = '') {
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Выберите язык в личном чате с ботом.\nТілді ботпен жеке чатта таңдаңыз.');
      return;
    }
    await ctx.reply(`${error ? `${error}\n\n` : ''}${LANGUAGE_PROMPT}`, LANGUAGE_MENU);
  }

  bot.use(async (ctx, next) => {
    if (!ctx.from || (!ctx.message && !ctx.callbackQuery)) return next();
    if (ctx.chat?.type === 'private' && /^language:(ru|kk)$/.test(ctx.callbackQuery?.data || '')) {
      // Record arrival order before any asynchronous read or acknowledgement.
      ctx.state.languageSelection = Symbol('language-selection');
      languageSelections.set(ctx.from.id, ctx.state.languageSelection);
    }
    try {
      ctx.state.language = await preferences.getLanguage(ctx.from.id);
    } catch {
      await answerCallback(ctx);
      await ctx.reply('Не удалось загрузить настройки языка. Попробуйте позже.\nТіл баптауларын жүктеу мүмкін болмады. Кейінірек қайталап көріңіз.');
      return;
    }
    if (ctx.chat?.type !== 'private' && !ctx.state.language) {
      const text = ctx.message?.text || '';
      const command = /^\/(?:start|reports|language|cancel)(?:@(\w+))?(?:\s|$)/.exec(text);
      const ownCommand = command && (!command[1] || command[1].toLowerCase() === ctx.botInfo.username.toLowerCase());
      if (ctx.callbackQuery || ownCommand || actionLabels.has(text)) {
        await answerCallback(ctx);
        await showLanguagePicker(ctx);
      }
      return;
    }
    const choosingLanguage = ctx.callbackQuery?.data?.startsWith('language:');
    if (ctx.chat?.type === 'private' && !ctx.state.language && !choosingLanguage) {
      await answerCallback(ctx);
      await showLanguagePicker(ctx);
      return;
    }
    return next();
  });

  bot.command('language', ctx => showLanguagePicker(ctx));
  bot.hears('Язык / Тіл', ctx => showLanguagePicker(ctx));
  bot.action(/^language:(.*)$/, async ctx => {
    await answerCallback(ctx);
    const language = ctx.match[1];
    if (ctx.chat?.type !== 'private' || !['ru', 'kk'].includes(language)) {
      await showLanguagePicker(ctx);
      return;
    }
    if (languageSelections.get(ctx.from.id) !== ctx.state.languageSelection) return;
    try {
      await preferences.setLanguage(ctx.from.id, language);
    } catch {
      await showLanguagePicker(ctx, 'Не удалось сохранить язык. Попробуйте ещё раз.\nТілді сақтау мүмкін болмады. Қайталап көріңіз.');
      return;
    }
    if (languageSelections.get(ctx.from.id) !== ctx.state.languageSelection) return;
    ctx.state.language = language;
    states.delete(ctx.from.id);
    await ctx.reply(copyFor(ctx).welcome, menu(ctx));
  });

  async function showProcedures(ctx) {
    states.delete(ctx.from.id);
    try {
      const payload = await listProcedures();
      const source = Array.isArray(payload) ? payload : payload.procedures;
      const procedures = source?.map(procedure => localizeProcedure(procedure, languageOf(ctx)));
      if (!procedures?.length) {
        await ctx.reply(copyFor(ctx).emptyProcedures, menu(ctx));
        return;
      }
      states.set(ctx.from.id, { step: 'procedure', procedures });
      await ctx.reply(copyFor(ctx).chooseProcedure, procedureMenu(procedures, ctx));
    } catch (error) {
      await ctx.reply(localizeError(error, languageOf(ctx)), menu(ctx));
    }
  }

  function beginReport(ctx) {
    const copy = copyFor(ctx);
    states.set(ctx.from.id, { step: 'location' });
    const notice = config.dataMode === 'mock' ? copy.demoNotice : '';
    return ctx.reply(`${notice}${copy.steps.location}`, Markup.keyboard([
      [Markup.button.locationRequest(copy.shareLocation)], [copy.cancel],
    ]).resize());
  }

  bot.start(async ctx => {
    states.delete(ctx.from.id);
    await ctx.reply(copyFor(ctx).welcome, menu(ctx));
  });

  bot.command('cancel', async ctx => {
    states.delete(ctx.from.id);
    await ctx.reply(copyFor(ctx).cancelled, menu(ctx));
  });

  bot.hears(labels('cancel'), async ctx => {
    states.delete(ctx.from.id);
    await ctx.reply(copyFor(ctx).cancelled, menu(ctx));
  });

  bot.hears(labels('mainMenu'), ctx => {
    states.delete(ctx.from.id);
    return ctx.reply(copyFor(ctx).chooseAction, menu(ctx));
  });

  bot.hears(labels('report'), beginReport);
  if (config.dataMode === 'mock') bot.hears(labels('demoReport'), beginReport);

  bot.hears(labels('application'), async ctx => {
    states.set(ctx.from.id, { step: 'application' });
    await ctx.reply(copyFor(ctx).enterApplication, cancelMenu(ctx));
  });

  bot.hears(labels('procedures'), showProcedures);

  bot.action('procedures:list', async ctx => {
    await answerCallback(ctx);
    await showProcedures(ctx);
  });

  registerReportCabinet(bot, { menu, clearState: ctx => states.delete(ctx.from.id) });

  bot.on('location', async ctx => {
    const draft = states.get(ctx.from.id);
    if (!draft) return;
    if (draft.step !== 'location') {
      await ctx.reply(copyFor(ctx).steps[draft.step] || copyFor(ctx).chooseFirst);
      return;
    }
    draft.lat = ctx.message.location.latitude;
    draft.lon = ctx.message.location.longitude;
    draft.step = 'photo';
    await ctx.reply(copyFor(ctx).steps.photo, cancelMenu(ctx));
  });

  bot.on('photo', async ctx => {
    const draft = states.get(ctx.from.id);
    if (!draft) return;
    if (draft.step !== 'photo') {
      await ctx.reply(copyFor(ctx).steps[draft.step] || copyFor(ctx).chooseFirst);
      return;
    }
    draft.telegramFileId = ctx.message.photo.at(-1).file_id;
    draft.step = 'description';
    await ctx.reply(copyFor(ctx).steps.description, cancelMenu(ctx));
  });

  bot.on('text', async ctx => {
    const draft = states.get(ctx.from.id);
    if (!draft) return;
    const copy = copyFor(ctx);

    if (draft.step === 'procedure') {
      const procedure = draft.procedures.find(item => (item.menuLabel || item.title) === ctx.message.text);
      if (!procedure) {
        await ctx.reply(copy.chooseTopic, procedureMenu(draft.procedures, ctx));
        return;
      }
      const buttons = [];
      if (procedure.officialUrl) {
        buttons.push([Markup.button.url(procedure.officialButton || copy.openOfficial, procedure.officialUrl)]);
      }
      buttons.push([Markup.button.callback(copy.backProcedures, 'procedures:list')]);
      await ctx.reply(procedureText(procedure, ctx), {
        ...Markup.inlineKeyboard(buttons),
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    if (draft.step === 'location' || draft.step === 'photo') {
      await ctx.reply(copy.steps[draft.step]);
      return;
    }

    if (draft.step === 'description') {
      const description = ctx.message.text.trim();
      if (!description || description.length > 2000) {
        await ctx.reply(copy.invalidDescription);
        return;
      }
      try {
        const report = await createReport({
          telegramUserId: ctx.from.id,
          lat: draft.lat,
          lon: draft.lon,
          description,
          telegramFileId: draft.telegramFileId,
          casePassport: analyzeViolationCase({
            description,
            lat: draft.lat,
            lon: draft.lon,
            hasPhoto: Boolean(draft.telegramFileId),
          }),
        });
        if (!report?.id) throw new Error(copy.missingReportId);
        states.delete(ctx.from.id);
        await ctx.reply(
          report.demoOnly ? copy.demoReceipt(report.id) : copy.receipt(report.id),
          menu(ctx),
        );
      } catch (error) {
        await ctx.reply(`${localizeError(error, languageOf(ctx))}\n\n${copy.draftRetry}`);
      }
      return;
    }

    if (draft.step === 'application') {
      const trackingNumber = ctx.message.text.trim();
      if (!/^[A-Za-z0-9-]{4,40}$/.test(trackingNumber)) {
        await ctx.reply(copy.invalidApplication);
        return;
      }
      try {
        const application = await getApplication(trackingNumber);
        const status = copy.statuses[application.stage] || copy.statusMissing;
        const explanation = application.demoOnly ? copy.demoApplication
          : application.translations?.[languageOf(ctx)]?.explanation || application.explanation || '';
        states.delete(ctx.from.id);
        await ctx.reply(
          `${application.demoOnly ? `${copy.demoData}\n` : ''}${copy.applicationLabel} ${application.trackingNumber}\n${copy.status} ${status}\n${explanation}\n${copy.updated} ${formatDate(application.updatedAt, languageOf(ctx))}`,
          menu(ctx),
        );
      } catch (error) {
        await ctx.reply(`${localizeError(error, languageOf(ctx))}\n\n${copy.applicationRetry}`);
      }
    }
  });

  bot.catch((error, ctx) => {
    console.error(`Telegram update ${ctx.update.update_id} failed:`, error);
  });

  return bot;
}
