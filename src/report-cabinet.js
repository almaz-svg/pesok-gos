import { Markup } from 'telegraf';
import { listReports } from './api.js';
import { formatDate, languageOf, localizeError } from './i18n.js';

const PAGE_SIZE = 5;
const messages = {
  ru: {
    statuses: {
      signal_received: 'Сигнал сохранён',
      under_review: 'На рассмотрении',
      inspection_scheduled: 'Назначена проверка',
      approved: 'Одобрено',
      rejected: 'Отклонено',
    },
    nextSteps: {
      signal_received: 'Проверьте статус позже: сигнал сохранён в сервисе.',
      under_review: 'Проверяйте обновления и сохраняйте дополнительные материалы по проблеме.',
      inspection_scheduled: 'Сохраните новые фото участка, если ситуация изменится.',
      approved: 'Ознакомьтесь с решением и проверьте, устранена ли проблема.',
      rejected: 'Ознакомьтесь с причиной отказа в ответе и уточните недостающие сведения.',
    },
    savedInBot: 'Сохранено в боте',
    unknownStatus: 'Статус уточняется',
    demoNextStep: 'Для официального обращения перейдите в eOtinish. Сохраните фото и координаты.',
    unknownNextStep: 'Обновите карточку позже, чтобы проверить статус.',
    report: 'Обращение',
    status: 'Статус:',
    created: 'Создано:',
    updated: 'Обновлено:',
    demoNotice: 'Демо-сигнал. В госорганы не отправлялся.',
    description: 'Описание:',
    noDescription: 'Не указано.',
    coordinates: 'Координаты:',
    noCoordinates: 'Координаты не указаны.',
    nextStep: 'Следующий шаг:',
    mainMenu: 'Главное меню',
    privateOnly: 'Мои обращения доступны только в личном чате с ботом.',
    retry: 'Повторить',
    empty: 'У вас пока нет обращений. Чтобы зафиксировать проблему, выберите «Сообщить о проблеме».',
    myReports: 'Мои обращения:',
    page: (page, count) => `Страница ${page} из ${count}`,
    open: 'Открыть',
    back: 'Назад',
    next: 'Далее',
    refresh: 'Обновить',
    notFound: 'Обращение не найдено или недоступно.',
    backToList: 'К списку',
    noPhoto: 'У этого обращения нет сохранённого фото.',
    photoCaption: id => `Фото обращения ${id}`,
    photo: 'Фото',
    map: 'Открыть на карте',
    eotinish: 'Открыть eOtinish',
    refreshStatus: 'Обновить статус',
    chooseAction: 'Выберите действие:',
    passport: 'Паспорт нарушения',
    category: 'Категория:',
    authority: 'Ответственный орган:',
    urgency: 'Срочность:',
    urgencyLabels: { high: 'высокая', normal: 'обычная' },
    evidenceNeeded: 'Нужные доказательства:',
    officialDraft: 'Черновик обращения:',
  },
  kk: {
    statuses: {
      signal_received: 'Сигнал сақталды',
      under_review: 'Қаралуда',
      inspection_scheduled: 'Тексеру тағайындалды',
      approved: 'Мақұлданды',
      rejected: 'Қабылданбады',
    },
    nextSteps: {
      signal_received: 'Мәртебесін кейінірек тексеріңіз: сигнал сервисте сақталды.',
      under_review: 'Жаңартуларды тексеріп, мәселе бойынша қосымша материалдарды сақтаңыз.',
      inspection_scheduled: 'Жағдай өзгерсе, учаскенің жаңа фотоларын сақтаңыз.',
      approved: 'Шешіммен танысып, мәселенің шешілгенін тексеріңіз.',
      rejected: 'Жауаптағы бас тарту себебімен танысып, жетіспейтін мәліметтерді нақтылаңыз.',
    },
    savedInBot: 'Ботта сақталды',
    unknownStatus: 'Мәртебесі нақтылануда',
    demoNextStep: 'Ресми өтініш беру үшін eOtinish сервисіне өтіңіз. Фото мен координаттарды сақтаңыз.',
    unknownNextStep: 'Мәртебесін тексеру үшін карточканы кейінірек жаңартыңыз.',
    report: 'Өтініш',
    status: 'Мәртебесі:',
    created: 'Құрылған күні:',
    updated: 'Жаңартылған күні:',
    demoNotice: 'Демо-хабарлама. Мемлекеттік органдарға жіберілген жоқ.',
    description: 'Сипаттамасы:',
    noDescription: 'Көрсетілмеген.',
    coordinates: 'Координаттары:',
    noCoordinates: 'Координаттар көрсетілмеген.',
    nextStep: 'Келесі қадам:',
    mainMenu: 'Басты мәзір',
    privateOnly: 'Менің өтініштерім бөлімі ботпен жеке чатта ғана қолжетімді.',
    retry: 'Қайталау',
    empty: 'Әзірге өтініштеріңіз жоқ. Мәселені тіркеу үшін «Мәселе туралы хабарлау» тармағын таңдаңыз.',
    myReports: 'Менің өтініштерім:',
    page: (page, count) => `Бет ${page} / ${count}`,
    open: 'Ашу',
    back: 'Артқа',
    next: 'Келесі',
    refresh: 'Жаңарту',
    notFound: 'Өтініш табылмады немесе қолжетімсіз.',
    backToList: 'Тізімге оралу',
    noPhoto: 'Бұл өтініштің сақталған фотосы жоқ.',
    photoCaption: id => `${id} өтінішінің фотосы`,
    photo: 'Фото',
    map: 'Картадан ашу',
    eotinish: 'eOtinish ашу',
    refreshStatus: 'Мәртебені жаңарту',
    chooseAction: 'Әрекетті таңдаңыз:',
    passport: 'Бұзушылық паспорты',
    category: 'Санаты:',
    authority: 'Жауапты орган:',
    urgency: 'Шұғылдығы:',
    urgencyLabels: { high: 'жоғары', normal: 'қалыпты' },
    evidenceNeeded: 'Қажет дәлелдер:',
    officialDraft: 'Өтініш жобасы:',
  },
};

function statusLabel(report, copy) {
  return report.demoOnly ? copy.savedInBot : copy.statuses[report.status] || copy.unknownStatus;
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

function passportText(passport, copy) {
  if (!passport || typeof passport !== 'object') return [];
  const lines = ['', copy.passport];
  if (passport.typeLabel) lines.push(`${copy.category} ${shortText(passport.typeLabel, 120)}`);
  if (passport.responsibleAuthority) lines.push(`${copy.authority} ${shortText(passport.responsibleAuthority, 220)}`);
  const urgency = copy.urgencyLabels[passport.urgency] || shortText(passport.urgency, 40);
  if (urgency) lines.push(`${copy.urgency} ${urgency}`);
  if (Array.isArray(passport.evidenceChecklist) && passport.evidenceChecklist.length) {
    lines.push('', copy.evidenceNeeded, ...passport.evidenceChecklist.slice(0, 6).map(item => `• ${shortText(item, 180)}`));
  }
  if (passport.officialDraft) lines.push('', copy.officialDraft, shortText(passport.officialDraft, 1400));
  return lines;
}

function reportText(report, language) {
  const copy = messages[language];
  const nextStep = report.demoOnly
    ? copy.demoNextStep
    : shortText(report.nextStep, 500) || copy.nextSteps[report.status] || copy.unknownNextStep;
  const lines = [
    `${copy.report} ${report.id}`,
    `${copy.status} ${statusLabel(report, copy)}`,
    `${copy.created} ${formatDate(report.createdAt, language)}`,
  ];
  if (report.updatedAt) lines.push(`${copy.updated} ${formatDate(report.updatedAt, language)}`);
  if (report.demoOnly) lines.push('', copy.demoNotice);
  lines.push('', copy.description, shortText(report.description, 2000) || copy.noDescription);
  lines.push('', mapUrl(report) ? `${copy.coordinates} ${report.lat}, ${report.lon}` : copy.noCoordinates);
  lines.push(...passportText(report.casePassport, copy));
  if (report.explanation) lines.push('', shortText(report.explanation, 400));
  lines.push('', `${copy.nextStep} ${nextStep}`);
  return lines.join('\n');
}

const menuButton = copy => [Markup.button.callback(copy.mainMenu, 'reports:menu')];

export function registerReportCabinet(bot, { menu, clearState }) {
  const resolveMenu = ctx => typeof menu === 'function' ? menu(ctx) : menu;

  async function run(ctx, action) {
    const language = languageOf(ctx);
    const copy = messages[language];
    if (ctx.callbackQuery) {
      try {
        await ctx.answerCbQuery();
      } catch {
        // Telegram may expire the acknowledgement; still handle the action below.
      }
    }
    if (ctx.chat?.type !== 'private') {
      await ctx.reply(copy.privateOnly);
      return;
    }
    clearState(ctx);
    try {
      await action();
    } catch (error) {
      await ctx.reply(localizeError(error, language), Markup.inlineKeyboard([
        [Markup.button.callback(copy.retry, 'reports:page:0')],
        menuButton(copy),
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
    const language = languageOf(ctx);
    const copy = messages[language];
    const reports = await loadReports(ctx);
    if (!reports.length) {
      await ctx.reply(copy.empty, resolveMenu(ctx));
      return;
    }
    const pageCount = Math.ceil(reports.length / PAGE_SIZE);
    const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
    const items = reports.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const text = [
      `${copy.myReports} ${reports.length}`,
      copy.page(page + 1, pageCount),
      ...items.map(report => `\n${report.id} | ${formatDate(report.createdAt, language)}\n${statusLabel(report, copy)}\n${shortText(report.description, 100)}`),
    ].join('\n');
    const rows = items.map(report => [Markup.button.callback(`${copy.open} ${report.id}`, `reports:open:${report.id}`)]);
    const navigation = [];
    if (page > 0) navigation.push(Markup.button.callback(copy.back, `reports:page:${page - 1}`));
    if (page < pageCount - 1) navigation.push(Markup.button.callback(copy.next, `reports:page:${page + 1}`));
    if (navigation.length) rows.push(navigation);
    rows.push([Markup.button.callback(copy.refresh, `reports:page:${page}`)], menuButton(copy));
    await ctx.reply(text, Markup.inlineKeyboard(rows));
  }

  async function showReport(ctx, id, photoOnly) {
    const language = languageOf(ctx);
    const copy = messages[language];
    const reports = await loadReports(ctx);
    const index = reports.findIndex(report => report.id === id);
    if (index === -1) {
      await ctx.reply(copy.notFound, Markup.inlineKeyboard([
        [Markup.button.callback(copy.backToList, 'reports:page:0')], menuButton(copy),
      ]));
      return;
    }
    const report = reports[index];
    if (photoOnly) {
      if (!report.telegramFileId) {
        await ctx.reply(copy.noPhoto);
        return;
      }
      await ctx.replyWithPhoto(report.telegramFileId, { caption: copy.photoCaption(report.id) });
      return;
    }
    const rows = [];
    if (report.telegramFileId) rows.push([Markup.button.callback(copy.photo, `reports:photo:${report.id}`)]);
    const url = mapUrl(report);
    if (url) rows.push([Markup.button.url(copy.map, url)]);
    if (report.demoOnly) rows.push([Markup.button.url(copy.eotinish, 'https://eotinish.kz/ru')]);
    rows.push(
      [Markup.button.callback(copy.refreshStatus, `reports:open:${report.id}`)],
      [Markup.button.callback(copy.backToList, `reports:page:${Math.floor(index / PAGE_SIZE)}`)],
      menuButton(copy),
    );
    await ctx.reply(reportText(report, language), {
      ...Markup.inlineKeyboard(rows),
      link_preview_options: { is_disabled: true },
    });
  }

  bot.hears(['Мои обращения', 'Менің өтініштерім'], ctx => run(ctx, () => showList(ctx)));
  bot.command('reports', ctx => run(ctx, () => showList(ctx)));
  bot.action(/^reports:page:(\d+)$/, ctx => run(ctx, () => showList(ctx, Number(ctx.match[1]))));
  bot.action(/^reports:(open|photo):(.+)$/, ctx => run(ctx, () => showReport(ctx, ctx.match[2], ctx.match[1] === 'photo')));
  bot.action('reports:menu', ctx => run(ctx, () => ctx.reply(messages[languageOf(ctx)].chooseAction, resolveMenu(ctx))));
}
