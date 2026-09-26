import { Markup } from 'telegraf';
import { PNG } from 'pngjs';
import { languageOf } from '../i18n.js';
import { analysisVersion } from './service.js';
import { caseText, evidenceText, eventText, landCopy, landError, landMessages } from './messages.js';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const button = (label, action) => Markup.button.callback(label, `land:${action}`);
const validId = value => /^[a-f0-9]{12}$/.test(value || '');
const noPreview = { link_preview_options: { is_disabled: true } };

async function replyText(ctx, text, extra = {}, allowed = async () => true) {
  for (let offset = 0; offset < text.length;) {
    if (!await allowed()) return;
    let end = Math.min(offset + 3500, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    await ctx.reply(text.slice(offset, end), { ...noPreview, ...(end >= text.length ? extra : {}) });
    offset = end;
  }
}

export function displayImage(buffer) {
  const input = PNG.sync.read(buffer);
  if (input.width > 102 || input.height > 102) fail('LAND_INPUT');
  const scale = Math.max(1, Math.ceil(500 / Math.max(input.width, input.height)));
  const output = new PNG({ width: input.width * scale, height: input.height * scale });
  // Nearest-neighbor enlargement changes display size, never the 20 m data resolution.
  for (let y = 0; y < output.height; y++) for (let x = 0; x < output.width; x++) {
    const from = (Math.floor(y / scale) * input.width + Math.floor(x / scale)) * 4;
    const to = (y * output.width + x) * 4;
    if (!input.data[from + 3]) {
      output.data.set([150, 150, 150, 255], to);
    } else output.data.set(input.data.subarray(from, from + 4), to);
  }
  return PNG.sync.write(output);
}

export function caseKeyboard(record, language) {
  const c = landCopy(language);
  return Markup.inlineKeyboard([
    [button(c.retry, `retry:${record.id}`)],
    [button(c.boundary, `boundary:${record.id}`), button(c.evidence, `evidence:${record.id}`)],
    [button(c.materials, `materials:${record.id}`), button(c.events, `events:${record.id}`)],
    [button(record.reviewRequested ? c.unshare : c.share, `${record.reviewRequested ? 'unshare' : 'share'}:${record.id}`)],
    [button(record.localStatus === 'closed' ? c.reopen : c.close, `${record.localStatus === 'closed' ? 'reopen' : 'close'}:${record.id}`)],
    ...(record.localStatus === 'closed' ? [[button(record.watch.enabled ? c.stop : c.watch, `${record.watch.enabled ? 'stop' : 'watch'}:${record.id}`)]] : []),
    [button(c.sites, 'list')],
  ]);
}

export async function readTelegramBoundary(ctx, fetchImpl = fetch) {
  const doc = ctx.message?.document;
  if (!doc || !/\.(geojson|json)$/i.test(doc.file_name || '') || doc.file_size > 102400
    || !ctx.message.caption || ctx.message.caption.trim().length < 8 || ctx.message.caption.length > 1000) fail('LAND_INPUT');
  const link = new URL(String(await ctx.telegram.getFileLink(doc.file_id)));
  if (link.protocol !== 'https:' || link.hostname !== 'api.telegram.org' || link.port || link.username || link.password) fail('LAND_INPUT');
  const response = await fetchImpl(link, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok || Number(response.headers.get('content-length')) > 102400 || !response.body) fail('LAND_INPUT');
  const chunks = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 102400) fail('LAND_INPUT');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('LAND_INPUT'); }
}

export function registerLandFeatures(bot, { states, service, fetchImpl = fetch }) {
  const jobs = new Set();
  bot.landIdle = async () => { await Promise.allSettled([...jobs]); };
  const isCurrent = (ctx, state) => states.get(ctx.from.id) === state;

  async function showCase(ctx, record, images, current = () => true) {
    const c = landCopy(languageOf(ctx));
    const labels = [c.before, c.after, c.overlay];
    const dates = [record.analysis?.before.datetime, record.analysis?.after.datetime, record.analysis?.after.datetime];
    const saved = { afterId: record.analysis?.after.id };
    const fields = ['beforeFileId', 'afterFileId', 'overlayFileId'];
    if (images?.length) {
      for (let i = 0; i < images.length; i++) {
        if (!current()) return;
        const message = await ctx.replyWithPhoto({ source: displayImage(images[i]), filename: `${record.id}-${i}.png` }, {
          caption: `${labels[i]} | ${dates[i]?.slice(0, 10) || '?'} | Sentinel-2 | 20 м`,
        });
        const fileId = message?.photo?.at(-1)?.file_id;
        if (fileId) saved[fields[i]] = fileId;
      }
      await service.saveImagery(record.id, ctx.from.id, saved);
    } else if (record.imagery?.afterId === record.analysis?.after.id) {
      for (const [i, field] of fields.entries()) {
        if (!current()) return;
        if (record.imagery?.[field]) await ctx.replyWithPhoto(record.imagery[field], {
          caption: `${labels[i]} | ${dates[i]?.slice(0, 10) || '?'} | Sentinel-2 | 20 м`,
        });
      }
    }
    if (!current()) return;
    await replyText(ctx, caseText(record, languageOf(ctx)), caseKeyboard(record, languageOf(ctx)), async () => current());
  }

  async function run(ctx, action) {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    if (ctx.chat?.type !== 'private') return;
    try { await action(); } catch (error) { await ctx.reply(landError(error, languageOf(ctx))); }
  }

  function launch(ctx, state, work) {
    // Return to Telegram polling immediately so /cancel and other users remain responsive.
    const job = work().catch(async error => {
      if (isCurrent(ctx, state)) await ctx.reply(landError(error, languageOf(ctx)));
    }).catch(() => {}).finally(() => { jobs.delete(job); });
    jobs.add(job);
  }

  async function list(ctx) {
    states.delete(ctx.from.id);
    const c = landCopy(languageOf(ctx));
    const records = await service.list(ctx.from.id);
    await ctx.reply(records.length ? c.sites : c.empty, Markup.inlineKeyboard(
      records.map(r => [button(`${r.id} | ${r.area.lat.toFixed(4)}, ${r.area.lon.toFixed(4)}`, `open:${r.id}`)]),
    ));
  }

  async function queue(ctx, page = 0) {
    states.delete(ctx.from.id);
    const c = landCopy(languageOf(ctx));
    const records = await service.reviewQueue(ctx.from.id);
    const current = Math.max(0, Math.min(page, Math.ceil(records.length / 15) - 1));
    const rows = records.slice(current * 15, (current + 1) * 15).map(r => [button(r.id, `inspect:${r.id}`)]);
    if (current > 0) rows.push([button('<', `queue:${current - 1}`)]);
    if ((current + 1) * 15 < records.length) rows.push([button('>', `queue:${current + 1}`)]);
    await ctx.reply(records.length ? c.queue : c.queueEmpty, Markup.inlineKeyboard(rows));
  }

  async function inspect(ctx, caseId, evidenceId) {
    const r = await service.reviewCase(caseId, ctx.from.id);
    const version = analysisVersion(r);
    const allowed = async () => {
      const latest = await service.reviewCase(caseId, ctx.from.id);
      if (analysisVersion(latest) !== version) fail('LAND_STALE');
      return true;
    };
    const c = landCopy(languageOf(ctx));
    const decisionButtons = (kind, revision) => [
      button(c.approve, `decide:${caseId}:${kind}:${revision}:y:${version}`),
      button(c.reject, `decide:${caseId}:${kind}:${revision}:n:${version}`),
    ];
    if (evidenceId) {
      const e = r.evidence.find(item => item.id === evidenceId);
      if (!e) fail('LAND_STALE');
      await allowed();
      await ctx.replyWithPhoto(e.fileId);
      await replyText(ctx, evidenceText(e, languageOf(ctx)), Markup.inlineKeyboard([
        decisionButtons('e', e.id), [button(c.open, `inspect:${caseId}`)],
      ]), allowed);
      return;
    }
    const rows = [];
    if (r.imagery?.afterId === r.analysis?.after.id) {
      for (const field of ['beforeFileId', 'afterFileId', 'overlayFileId']) {
        await allowed();
        if (r.imagery?.[field]) await ctx.replyWithPhoto(r.imagery[field]);
      }
    }
    if (r.boundary) {
      await allowed();
      await ctx.replyWithDocument({ source: Buffer.from(JSON.stringify({ type: 'Feature', properties: { source: r.boundary.source }, geometry: r.boundary.geometry })), filename: `${r.id}.geojson` });
      rows.push(decisionButtons('b', r.boundary.revision));
    }
    rows.push(...r.evidence.map((e, i) => [button(`${c.evidence} ${i + 1}`, `inspect:${caseId}:${e.id}`)]));
    rows.push([button(c.queue, 'queue:0')]);
    await replyText(ctx, caseText(r, languageOf(ctx)), Markup.inlineKeyboard(rows), allowed);
  }

  bot.command('sites', ctx => run(ctx, () => list(ctx)));
  bot.hears(Object.values(landMessages).map(c => c.sites), ctx => run(ctx, () => list(ctx)));
  bot.command('myid', ctx => run(ctx, () => ctx.reply(`Telegram ID: ${ctx.from.id}`)));
  bot.command('review', ctx => run(ctx, () => queue(ctx)));

  bot.action(/^land:(.+)$/, ctx => run(ctx, async () => {
    const [action, caseId, arg, revision, decision, version] = ctx.match[1].split(':');
    const c = landCopy(languageOf(ctx));
    if (action === 'list') return list(ctx);
    if (action === 'queue') return queue(ctx, /^\d{1,6}$/.test(caseId) ? Number(caseId) : 0);
    if (!validId(caseId)) fail('LAND_STALE');
    if (action === 'area' || action === 'run') {
      const state = states.get(ctx.from.id);
      if (!state || state.landToken !== caseId || state.landStarted || !['photo', 'description'].includes(state.step)) fail('LAND_STALE');
      if (action === 'area') {
        state.landConsent = true;
        return ctx.reply(c.consent, Markup.inlineKeyboard([[
          button('0,5 x 0,5 км', `run:${caseId}:250`), button('1 x 1 км', `run:${caseId}:500`), button('2 x 2 км', `run:${caseId}:1000`),
        ]]));
      }
      if (!state.landConsent || !['250', '500', '1000'].includes(arg)) fail('LAND_STALE');
      state.landStarted = true;
      launch(ctx, state, async () => {
        state.landCreation = service.create(ctx.from.id, { lat: state.lat, lon: state.lon, halfSizeMeters: Number(arg) }, languageOf(ctx));
        const record = await state.landCreation;
        state.landCaseId = record.id;
        if (isCurrent(ctx, state)) await ctx.reply(`${c.working}\n${record.id}`);
        const result = await service.analyze(record.id, ctx.from.id);
        if (isCurrent(ctx, state)) await showCase(ctx, result.record, result.images, () => isCurrent(ctx, state));
      });
      return;
    }
    if (action === 'inspect') return inspect(ctx, caseId, arg);
    if (action === 'decide') {
      const record = await service.reviewCase(caseId, ctx.from.id);
      if (!validId(version) || analysisVersion(record) !== version) fail('LAND_STALE');
      const target = arg === 'b' ? record.boundary?.revision : arg === 'e' ? record.evidence.find(e => e.id === revision)?.id : null;
      if (target !== revision || !['y', 'n'].includes(decision)) fail('LAND_STALE');
      states.set(ctx.from.id, { step: 'land_review', caseId, kind: arg === 'b' ? 'boundary' : 'evidence', revision, accepted: decision === 'y', analysisAfterId: record.analysis?.after.id || null, analysisVersion: version });
      return ctx.reply(c.reason);
    }
    const record = await service.get(caseId, ctx.from.id);
    if (action === 'materials') {
      states.delete(ctx.from.id);
      if (record.boundary) await ctx.replyWithDocument({ source: Buffer.from(JSON.stringify({ type: 'Feature', properties: { source: record.boundary.source }, geometry: record.boundary.geometry })), filename: `${record.id}.geojson` });
      return ctx.reply(c.materials, Markup.inlineKeyboard([
        ...record.evidence.map((e, i) => [button(`${i + 1} | ${e.createdAt?.slice(0, 10) || ''}`, `material:${caseId}:${e.id}`)]),
        [button(c.open, `open:${caseId}`)],
      ]));
    }
    if (action === 'material') {
      const evidence = record.evidence.find(e => e.id === arg);
      if (!evidence) fail('LAND_STALE');
      await ctx.replyWithPhoto(evidence.fileId);
      return replyText(ctx, evidenceText(evidence, languageOf(ctx)), Markup.inlineKeyboard([[button(c.materials, `materials:${caseId}`)]]));
    }
    if (action === 'events') {
      const text = record.events?.length ? record.events.map(event => `${event.createdAt}\n${eventText({ ...record, language: languageOf(ctx) }, event)}\n${event.sourceUrl || ''}`).join('\n\n') : c.noEvents;
      return replyText(ctx, text, Markup.inlineKeyboard([[button(c.open, `open:${caseId}`)]]));
    }
    if (action === 'open') {
      states.delete(ctx.from.id);
      return showCase(ctx, record);
    }
    if (action === 'retry') {
      const state = { step: 'land_analysis', caseId };
      states.set(ctx.from.id, state);
      launch(ctx, state, async () => {
        await ctx.reply(c.working);
        const result = await service.analyze(caseId, ctx.from.id);
        if (isCurrent(ctx, state)) await showCase(ctx, result.record, result.images, () => isCurrent(ctx, state));
      });
      return;
    }
    if (action === 'boundary' || action === 'evidence') {
      states.set(ctx.from.id, { step: `land_${action}`, caseId });
      return ctx.reply(action === 'boundary' ? c.uploadBoundary : c.uploadEvidence, action === 'boundary'
        ? Markup.inlineKeyboard([[Markup.button.url('ЕГКН', 'https://map.gov4c.kz/egkn/')]]) : undefined);
    }
    if (action === 'share') {
      if (!service.hasOperators) return ctx.reply(c.noOperator);
      return ctx.reply(c.shareConsent, Markup.inlineKeyboard([[button(c.yesShare, `shared:${caseId}`)]]));
    }
    let updated;
    if (action === 'shared' || action === 'unshare') {
      if (action === 'shared' && !service.hasOperators) return ctx.reply(c.noOperator);
      updated = await service.shareReview(caseId, ctx.from.id, action === 'shared');
    } else if (action === 'close' || action === 'reopen') updated = await service.setClosed(caseId, ctx.from.id, action === 'close');
    else if (action === 'watch' || action === 'stop') updated = await service.setWatch(caseId, ctx.from.id, action === 'watch');
    else fail('LAND_STALE');
    states.delete(ctx.from.id);
    await showCase(ctx, updated);
  }));

  bot.use(async (ctx, next) => {
    const state = states.get(ctx.from?.id);
    if (!ctx.message || !state?.step.startsWith('land_')) return next();
    if (ctx.message.location || ctx.message.venue) return next();
    if (ctx.chat?.type !== 'private') return;
    const c = landCopy(languageOf(ctx));
    if (state.uploading || state.step === 'land_analysis') return ctx.reply(c.working);
    state.uploading = true;
    try {
      let record;
      if (state.step === 'land_boundary') {
        const geojson = await readTelegramBoundary(ctx, fetchImpl);
        if (!isCurrent(ctx, state)) return;
        record = await service.setBoundary(state.caseId, ctx.from.id, geojson, ctx.message.caption);
      } else if (state.step === 'land_evidence') {
        if (!ctx.message.photo?.length) return ctx.reply(c.uploadEvidence);
        record = await service.addEvidence(state.caseId, ctx.from.id, ctx.message.photo.at(-1).file_id, ctx.message.caption || '');
      } else if (state.step === 'land_review') {
        record = await service.review(state.caseId, ctx.from.id, state.kind, state.revision, state.accepted, ctx.message.text, state.analysisAfterId, state.analysisVersion);
        if (isCurrent(ctx, state)) {
          states.delete(ctx.from.id);
          await ctx.reply(c.saved);
          await inspect(ctx, record.id);
        }
        return;
      }
      if (record && isCurrent(ctx, state)) {
        states.delete(ctx.from.id);
        await showCase(ctx, record);
      }
    } catch (error) {
      if (isCurrent(ctx, state)) await ctx.reply(landError(error, languageOf(ctx)));
    } finally {
      state.uploading = false;
    }
  });
}
