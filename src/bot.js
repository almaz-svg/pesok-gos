import { Markup, Telegraf } from 'telegraf';
import { randomBytes } from 'node:crypto';
import { createReport, getApplication, listProcedures } from './api.js';
import { analyzeViolationCase } from './case-analysis.js';
import { config } from './config.js';
import { registerReportCabinet } from './report-cabinet.js';
import { copyFor, formatDate, languageOf, localizeError, messages } from './i18n.js';
import { localizeProcedure } from './procedures.js';
import { userPreferences } from './user-preferences.js';
import { aiAssistant } from './ai-assistant.js';
import { analyzeLocation, formatLocationAnalysis, locationMapUrl, validCoordinates } from './location.js';
import { createLandService } from './land/service.js';
import { registerLandFeatures } from './land/telegram.js';
import { landCopy, landMessages } from './land/messages.js';

const LANGUAGE_PROMPT = 'Тілді таңдаңыз / Выберите язык:';
const LANGUAGE_MENU = Markup.inlineKeyboard([
  [Markup.button.callback('Қазақша', 'language:kk'), Markup.button.callback('Русский', 'language:ru')],
]);

function menu(ctx) {
  const copy = copyFor(ctx);
  return Markup.keyboard([
    [copy.report, copy.myReports],
    [copy.application, copy.procedures],
    [landCopy(languageOf(ctx)).sites, copy.aiChat],
    ['Язык / Тіл'],
  ]).resize();
}

function cancelMenu(ctx) {
  return Markup.keyboard([[copyFor(ctx).cancel]]).resize();
}

function labels(key) {
  return Object.values(messages).map(copy => copy[key]);
}

function parseCoordinates(text) {
  const match = /^\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  return validCoordinates(lat, lon) ? { lat, lon } : null;
}

function incomingLocation(message) {
  const location = message?.location || message?.venue?.location;
  if (!location) return null;
  return { lat: location.latitude, lon: location.longitude, accuracyMeters: location.horizontal_accuracy,
    live: Boolean(location.live_period), inputType: message.venue ? 'venue' : 'telegram' };
}

const actionLabels = new Set([
  'Язык / Тіл',
  ...Object.values(landMessages).map(copy => copy.sites),
  ...['report', 'myReports', 'application', 'procedures', 'demoReport', 'mainMenu', 'cancel', 'aiChat'].flatMap(labels),
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

export function createBot(token, telegramOptions = {}, { preferences = userPreferences, assistant = aiAssistant, landService = createLandService() } = {}) {
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
    if (ctx.chat?.type !== 'private') {
      const text = ctx.message?.text || '';
      const command = /^\/(?:start|reports|language|cancel|ask|newchat|sites|review|myid)(?:@(\w+))?(?:\s|$)/.exec(text);
      const ownCommand = command && (!command[1] || command[1].toLowerCase() === ctx.botInfo.username.toLowerCase());
      const safePrivateRedirect = /^reports:|^language:/.test(ctx.callbackQuery?.data || '')
        || (ownCommand && /^\/(reports|ask|newchat|language)(?:@|\s|$)/.test(text))
        || ['myReports', 'aiChat'].flatMap(labels).includes(text) || text === 'Язык / Тіл';
      if (ctx.state.language && safePrivateRedirect) return next();
      if (ctx.callbackQuery || ownCommand || actionLabels.has(text)) {
        await answerCallback(ctx);
        await showLanguagePicker(ctx);
      }
      return;
    }
    const choosingLanguage = ctx.callbackQuery?.data?.startsWith('language:');
    if (ctx.chat?.type === 'private' && !ctx.state.language && !choosingLanguage) {
      const text = ctx.message?.text || '';
      const cancelCommand = /^\/cancel(?:@(\w+))?(?:\s|$)/.exec(text);
      if ((cancelCommand && (!cancelCommand[1] || cancelCommand[1].toLowerCase() === ctx.botInfo.username.toLowerCase()))
        || labels('cancel').includes(text)) states.delete(ctx.from.id);
      const input = incomingLocation(ctx.message) || parseCoordinates(ctx.message?.text || '');
      if (input) states.set(ctx.from.id, { step: 'pending_location', input });
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
    const pending = states.get(ctx.from.id);
    if (pending?.step !== 'pending_location') states.delete(ctx.from.id);
    await ctx.reply(copyFor(ctx).welcome, menu(ctx));
    if (pending?.step === 'pending_location' && states.get(ctx.from.id) === pending
      && languageSelections.get(ctx.from.id) === ctx.state.languageSelection) {
      states.delete(ctx.from.id);
      await acceptLocation(ctx, pending.input);
    }
  });

  async function showProcedures(ctx) {
    const loading = { step: 'procedures_loading' };
    states.set(ctx.from.id, loading);
    try {
      const payload = await listProcedures();
      if (states.get(ctx.from.id) !== loading) return;
      const source = Array.isArray(payload) ? payload : payload.procedures;
      const procedures = source?.map(procedure => localizeProcedure(procedure, languageOf(ctx)));
      if (!procedures?.length) {
        states.delete(ctx.from.id);
        await ctx.reply(copyFor(ctx).emptyProcedures, menu(ctx));
        return;
      }
      states.set(ctx.from.id, { step: 'procedure', procedures });
      await ctx.reply(copyFor(ctx).chooseProcedure, procedureMenu(procedures, ctx));
    } catch (error) {
      if (states.get(ctx.from.id) !== loading) return;
      states.delete(ctx.from.id);
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

  async function acceptLocation(ctx, input) {
    const copy = copyFor(ctx);
    if (!validCoordinates(input.lat, input.lon)) return ctx.reply(copy.invalidLocation);
    const locationAnalysis = analyzeLocation(input);
    const draft = { step: 'photo', lat: input.lat, lon: input.lon, locationAnalysis, landToken: randomBytes(6).toString('hex') };
    states.set(ctx.from.id, draft);
    await ctx.reply(formatLocationAnalysis(locationAnalysis, languageOf(ctx)), {
      ...Markup.inlineKeyboard([
        [Markup.button.url(copy.locationMap, locationMapUrl(input))],
        [Markup.button.callback(landCopy(languageOf(ctx)).history, `land:area:${draft.landToken}`)],
      ]),
      link_preview_options: { is_disabled: true },
    });
    if (states.get(ctx.from.id) === draft && draft.step === 'photo') await ctx.reply(copy.steps.photo, cancelMenu(ctx));
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

  async function beginAiChat(ctx, reset = false) {
    const copy = copyFor(ctx);
    if (ctx.chat?.type !== 'private') return ctx.reply(copy.aiPrivate);
    if (!assistant.enabled) return ctx.reply(copy.aiDisabled, menu(ctx));
    const state = { step: 'assistant' };
    states.set(ctx.from.id, state);
    try {
      if (reset) await assistant.reset(ctx.from.id);
      if (states.get(ctx.from.id) === state) {
        await ctx.reply(reset ? copy.aiReset : copy.aiWelcome, menu(ctx));
      }
    } catch {
      if (states.get(ctx.from.id) === state) await ctx.reply(copy.aiUnavailable, menu(ctx));
    }
  }

  bot.command('ask', ctx => beginAiChat(ctx));
  bot.command('newchat', ctx => beginAiChat(ctx, true));
  bot.hears(labels('aiChat'), ctx => beginAiChat(ctx));

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
  registerLandFeatures(bot, { states, service: landService });

  bot.on(['location', 'venue'], ctx => acceptLocation(ctx, incomingLocation(ctx.message)));

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
    const copy = copyFor(ctx);
    if (!draft) {
      const coordinates = parseCoordinates(ctx.message.text);
      if (coordinates) await acceptLocation(ctx, coordinates);
      return;
    }

    if (draft.step === 'assistant') {
      if (ctx.chat?.type !== 'private') return;
      if (ctx.message.text.startsWith('/')) return ctx.reply(copy.chooseAction, menu(ctx));
      if (ctx.message.text.trim().length > 2000) return ctx.reply(copy.aiInput);
      try {
        const answer = await assistant.ask(ctx.from.id, ctx.message.text, languageOf(ctx));
        for (let offset = 0; offset < answer.length;) {
          if (states.get(ctx.from.id) !== draft) return;
          let end = Math.min(offset + 3500, answer.length);
          if (end < answer.length && /[\uD800-\uDBFF]/.test(answer[end - 1])) end -= 1;
          await ctx.reply(answer.slice(offset, end), { ...menu(ctx), link_preview_options: { is_disabled: true } });
          offset = end;
        }
      } catch (error) {
        if (states.get(ctx.from.id) !== draft || error.code === 'AI_CANCELLED') return;
        const message = error.code === 'AI_BUSY' ? copy.aiBusy
          : error.code === 'AI_INPUT' ? copy.aiInput : copy.aiUnavailable;
        await ctx.reply(message, menu(ctx));
      }
      return;
    }

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

    if (draft.step === 'location') {
      const coordinates = parseCoordinates(ctx.message.text);
      if (!coordinates) {
        await ctx.reply(copy.invalidLocation);
        return;
      }
      await acceptLocation(ctx, coordinates);
      return;
    }

    if (draft.step === 'submitting') return ctx.reply(copy.reportSaving);

    if (draft.step === 'photo') {
      await ctx.reply(copy.steps[draft.step]);
      return;
    }

    if (draft.step === 'description') {
      const description = ctx.message.text.trim();
      if (!description || description.length > 2000) {
        await ctx.reply(copy.invalidDescription);
        return;
      }
      draft.step = 'submitting';
      try {
        if (draft.landCreation) {
          try { await draft.landCreation; } catch { /* The report does not require a satellite case. */ }
          if (states.get(ctx.from.id) !== draft) return;
        }
        const report = await createReport({
          telegramUserId: ctx.from.id,
          lat: draft.lat,
          lon: draft.lon,
          description,
          telegramFileId: draft.telegramFileId,
          locationAnalysis: draft.locationAnalysis,
          ...(draft.landCaseId ? { landCaseId: draft.landCaseId } : {}),
          casePassport: analyzeViolationCase({
            description,
            lat: draft.lat,
            lon: draft.lon,
            hasPhoto: Boolean(draft.telegramFileId),
          }),
        });
        if (!report?.id) throw new Error(copy.missingReportId);
        if (draft.landCaseId) {
          try { await landService.linkReport(draft.landCaseId, ctx.from.id, report.id); } catch {
            // The report already exists; failure to add a reverse link must not duplicate it.
          }
        }
        const current = states.get(ctx.from.id) === draft;
        if (current) states.delete(ctx.from.id);
        await ctx.reply(
          report.demoOnly ? copy.demoReceipt(report.id) : copy.receipt(report.id),
          current ? menu(ctx) : undefined,
        );
      } catch (error) {
        if (states.get(ctx.from.id) !== draft) return;
        draft.step = 'description';
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
        const current = states.get(ctx.from.id) === draft;
        if (current) states.delete(ctx.from.id);
        await ctx.reply(
          `${application.demoOnly ? `${copy.demoData}\n` : ''}${copy.applicationLabel} ${application.trackingNumber}\n${copy.status} ${status}\n${explanation}\n${copy.updated} ${formatDate(application.updatedAt, languageOf(ctx))}`,
          current ? menu(ctx) : undefined,
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
