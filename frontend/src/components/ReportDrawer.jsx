import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  FileText,
  ImageOff,
  Layers,
  LoaderCircle,
  MapPin,
  MessageSquare,
  RefreshCw,
  Save,
  TriangleAlert,
  X,
} from 'lucide-react';
import { getReport, getPlots, patchReport, photoUrl } from '../lib/data-client.js';
import {
  STATUS_META,
  CATEGORY_LABELS,
  TRANSITIONS,
  formatDate,
  formatDateTime,
} from '../lib/domain.js';
import './inspector.css';

const emptyDraft = { status: '', deadline: '', plot_id: '', comment: '' };
const EMPTY_PLOTS = [];
const draftFrom = (report) => ({
  status: report.status,
  deadline: report.deadline || '',
  plot_id: report.plot?.id || '',
  comment: '',
});
const errorMessage = (error) =>
  error?.message || 'Не удалось связаться с сервером. Проверьте подключение.';

function Status({ value }) {
  const meta = STATUS_META[value] || { label: value, tone: 'green' };
  return (
    <span className={`inspector-drawer__status is-${meta.tone}`}>
      <i />
      {meta.label}
    </span>
  );
}

function Photo({ photo, number }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const url = photoUrl(photo.url);
  const retryUrl = attempt ? `${url}${url.includes('?') ? '&' : '?'}retry=${attempt}` : url;
  return (
    <div className="inspector-drawer__photo">
      {failed || !url ? (
        <div className="inspector-drawer__photo-error">
          <ImageOff size={24} />
          <span>Фото недоступно</span>
          <button
            type="button"
            disabled={!url}
            onClick={() => {
              setAttempt(Date.now());
              setFailed(false);
            }}
          >
            <RefreshCw size={13} />
            Загрузить повторно
          </button>
        </div>
      ) : (
        <a
          href={retryUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Открыть фото обращения ${number} в новой вкладке`}
        >
          <img
            key={attempt}
            src={retryUrl}
            alt={`Фотография места нарушения ${number}`}
            onError={() => setFailed(true)}
          />
          <span>
            {String(number).padStart(2, '0')}
            <ArrowUpRight size={15} />
          </span>
        </a>
      )}
    </div>
  );
}

function History({ events, plots }) {
  function plotName(id) {
    return id
      ? plots.find((plot) => plot.id === id)?.cadastral_number || 'Земельный участок'
      : 'Без привязки';
  }
  return (
    <ol className="inspector-drawer__timeline">
      {[...(events || [])]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((event) => (
          <li key={event.id}>
            <span
              className={`inspector-drawer__timeline-icon ${event.event === 'CREATED' ? 'is-created' : ''}`}
            >
              {event.event === 'CREATED' ? <ArrowDownLeft size={13} /> : <Check size={13} />}
            </span>
            <div>
              <div className="inspector-drawer__event-title">
                {event.event === 'CREATED'
                  ? 'Обращение зарегистрировано'
                  : event.before?.status !== event.after.status
                    ? STATUS_META[event.after.status]?.label || event.after.status
                    : 'Данные обращения обновлены'}
              </div>
              {event.before && event.before.deadline !== event.after.deadline && (
                <p>
                  Срок: {event.after.deadline ? formatDate(event.after.deadline) : 'не назначен'}
                </p>
              )}
              {event.before && event.before.plot_id !== event.after.plot_id && (
                <p>Участок: {plotName(event.after.plot_id)}</p>
              )}
              {event.comment && <p className="inspector-drawer__event-comment">{event.comment}</p>}
              <span className="inspector-drawer__event-meta">
                {formatDateTime(event.created_at)} · {event.actor.label}
              </span>
            </div>
          </li>
        ))}
    </ol>
  );
}

export default function ReportDrawer({ selection, onClose, onSaved, plots = EMPTY_PLOTS }) {
  const [record, setRecord] = useState(null);
  const [availablePlots, setAvailablePlots] = useState(plots);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [formError, setFormError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [notice, setNotice] = useState('');
  const [blocked, setBlocked] = useState(null);
  const [reload, setReload] = useState(0);
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  const currentSelection = useRef('');
  const savingRef = useRef(false);
  const closeCallback = useRef(onClose);
  const titleId = useId();
  const fieldId = useId();
  const selectionKey = selection ? `${selection.type}:${selection.id}` : '';
  currentSelection.current = selectionKey;
  savingRef.current = saving;
  closeCallback.current = onClose;

  useEffect(() => {
    setAvailablePlots(plots);
  }, [plots]);

  useEffect(() => {
    if (!selectionKey) {
      setRecord(null);
      return;
    }
    const controller = new AbortController();
    const key = selectionKey;
    setLoading(true);
    setSaving(false);
    setRecord(null);
    setLoadError('');
    setFormError('');
    setFieldErrors({});
    setNotice('');
    setBlocked(null);
    setDraft(emptyDraft);
    const load = async () => {
      try {
        if (selection.type === 'report') {
          const next = await getReport(selection.id, { signal: controller.signal });
          if (controller.signal.aborted || currentSelection.current !== key) return;
          setRecord(next);
          setDraft(draftFrom(next));
        } else {
          let nextPlots = plots;
          let next = nextPlots.find((plot) => plot.id === selection.id);
          if (!next) {
            nextPlots = await getPlots({ signal: controller.signal });
            next = nextPlots.find((plot) => plot.id === selection.id);
          }
          if (controller.signal.aborted || currentSelection.current !== key) return;
          if (!next) throw new Error('Участок не найден. Возможно, он был удалён.');
          setAvailablePlots(nextPlots);
          setRecord(next);
        }
      } catch (error) {
        if (!controller.signal.aborted && currentSelection.current === key)
          setLoadError(errorMessage(error));
      } finally {
        if (!controller.signal.aborted && currentSelection.current === key) setLoading(false);
      }
    };
    load();
    return () => controller.abort();
    // The selection is a snapshot. Polling the parent list must not discard edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, reload]);

  useLayoutEffect(() => {
    if (!selectionKey) return;
    const previousFocus = document.activeElement;
    const previousMapFeature = previousFocus?.dataset?.mapFeature;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    function keydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!savingRef.current) closeCallback.current?.();
      }
      if (event.key !== 'Tab') return;
      const elements = [
        ...(panelRef.current?.querySelectorAll(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ) || []),
      ].filter((element) => element.getClientRects().length);
      const first = elements[0];
      const last = elements.at(-1);
      if (!first) {
        event.preventDefault();
        panelRef.current?.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first || !panelRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !panelRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', keydown);
      if (previousFocus?.isConnected) previousFocus.focus();
      else if (previousMapFeature)
        document.querySelector(`[data-map-feature="${CSS.escape(previousMapFeature)}"]`)?.focus();
    };
  }, [Boolean(selectionKey)]);

  async function refreshConflict() {
    const key = selectionKey;
    setSaving(true);
    setFormError('');
    try {
      const next = await getReport(selection.id);
      if (currentSelection.current !== key) return;
      setRecord(next);
      setDraft(draftFrom(next));
      setBlocked(null);
      setFieldErrors({});
      setNotice('Актуальные данные загружены. При необходимости внесите изменения заново.');
    } catch (error) {
      if (currentSelection.current === key) setFormError(errorMessage(error));
    } finally {
      if (currentSelection.current === key) setSaving(false);
    }
  }

  async function save(event) {
    event.preventDefault();
    if (saving || blocked || !record) return;
    const errors = {};
    if (draft.status === 'IN_PROGRESS' && !draft.deadline)
      errors.deadline = ['Назначьте срок устранения нарушения.'];
    if (
      draft.status !== record.status &&
      !(TRANSITIONS[record.status] || []).includes(draft.status)
    )
      errors.status = ['Этот переход статуса недоступен.'];
    if (draft.status === 'RESOLVED' && draft.status !== record.status && !draft.comment.trim())
      errors.comment = ['Укажите результат проверки или причину закрытия.'];
    if (draft.comment.trim().length > 2000) errors.comment = ['Максимум 2000 символов.'];
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      return;
    }
    const payload = { version: record.version };
    if (draft.status !== record.status) payload.status = draft.status;
    if ((draft.deadline || null) !== record.deadline) payload.deadline = draft.deadline || null;
    if ((draft.plot_id || null) !== (record.plot?.id || null))
      payload.plot_id = draft.plot_id || null;
    if (draft.comment.trim()) payload.comment = draft.comment.trim();
    if (Object.keys(payload).length === 1) {
      setNotice('Нет изменений для сохранения.');
      return;
    }
    const key = selectionKey;
    setSaving(true);
    setFormError('');
    setFieldErrors({});
    setNotice('');
    try {
      const next = await patchReport(record.id, payload);
      if (currentSelection.current !== key) return;
      setRecord(next);
      setDraft(draftFrom(next));
      setNotice('Изменения сохранены.');
      onSaved?.(next);
    } catch (error) {
      if (currentSelection.current !== key) return;
      if (error.status === 409) {
        setBlocked({
          kind: 'conflict',
          message:
            'Обращение изменилось или переход статуса уже недоступен. Загрузите актуальную карточку перед редактированием.',
        });
      } else if (!error.status || error.status >= 500) {
        setBlocked({
          kind: 'uncertain',
          message:
            'Ответ на сохранение не получен. Изменение могло сохраниться — проверяем актуальную карточку.',
        });
        try {
          const next = await getReport(record.id);
          if (currentSelection.current !== key) return;
          setRecord(next);
          setBlocked({
            kind: 'uncertain',
            message: `Получены данные сервера: «${STATUS_META[next.status]?.label || next.status}», версия ${next.version}. Примите актуальные данные перед дальнейшим редактированием.`,
          });
        } catch {
          if (currentSelection.current === key)
            setBlocked({
              kind: 'uncertain',
              message:
                'Не удалось проверить результат сохранения. Восстановите подключение и загрузите актуальную карточку. Повторная отправка остановлена.',
            });
        }
      } else {
        setFormError(
          `${errorMessage(error)}${error.requestId ? ` Код запроса: ${error.requestId}` : ''}`,
        );
        setFieldErrors(error.fields || {});
      }
    } finally {
      if (currentSelection.current === key) setSaving(false);
    }
  }

  if (!selection) return null;
  const isReport = selection.type === 'report';
  const changed =
    record &&
    isReport &&
    (draft.status !== record.status ||
      (draft.deadline || null) !== record.deadline ||
      (draft.plot_id || null) !== (record.plot?.id || null) ||
      Boolean(draft.comment.trim()));
  const update = (field, value) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setNotice('');
    setFieldErrors((previous) => ({ ...previous, [field]: undefined }));
  };
  const fieldError = (field) =>
    fieldErrors[field] ? (
      <span className="inspector-drawer__field-error" id={`${fieldId}-${field}-error`}>
        {Array.isArray(fieldErrors[field]) ? fieldErrors[field].join(' ') : fieldErrors[field]}
      </span>
    ) : null;

  return (
    <div className="inspector-drawer__overlay">
      <div
        className="inspector-drawer__backdrop"
        onClick={() => {
          if (!saving) onClose?.();
        }}
        aria-hidden="true"
      />
      <aside
        className="inspector-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="inspector-drawer__header">
          <div>
            <span className="inspector-drawer__eyebrow">
              {isReport ? 'ОБРАЩЕНИЕ ГРАЖДАНИНА' : 'ЗЕМЕЛЬНЫЙ УЧАСТОК'}
            </span>
            <h2 id={titleId}>
              {record
                ? isReport
                  ? record.tracking_number
                  : record.cadastral_number
                : isReport
                  ? 'Карточка обращения'
                  : 'Карточка участка'}
            </h2>
          </div>
          <button
            ref={closeRef}
            className="inspector-drawer__close"
            onClick={onClose}
            disabled={saving}
            type="button"
            aria-label="Закрыть карточку"
          >
            <X size={21} />
          </button>
        </header>
        <div className="inspector-drawer__body">
          {loading && (
            <div className="inspector-drawer__loading" role="status">
              <LoaderCircle className="inspector-drawer__spin" size={28} />
              <span>Загружаем карточку…</span>
            </div>
          )}
          {loadError && (
            <div className="inspector-drawer__error" role="alert">
              <TriangleAlert size={22} />
              <p>{loadError}</p>
              <button type="button" onClick={() => setReload((value) => value + 1)}>
                <RefreshCw size={15} />
                Повторить загрузку
              </button>
            </div>
          )}
          {record && !loading && (
            <>
              <div className="inspector-drawer__status-row">
                <Status value={record.status} />
                {isReport && (
                  <span className="inspector-drawer__date">{formatDate(record.created_at)}</span>
                )}
              </div>
              {isReport ? (
                <>
                  <section className="inspector-drawer__section">
                    <span className="inspector-drawer__eyebrow">СУТЬ ОБРАЩЕНИЯ</span>
                    <h3 className="inspector-drawer__category">
                      {CATEGORY_LABELS[record.category] || record.category}
                    </h3>
                    <p className="inspector-drawer__description">{record.description}</p>
                    <p className="inspector-drawer__helper">
                      Категория зафиксирована при отправке обращения.
                    </p>
                    <div className="inspector-drawer__coordinates">
                      <MapPin size={14} />
                      {record.location.latitude.toFixed(5)}, {record.location.longitude.toFixed(5)}
                    </div>
                  </section>
                  <section className="inspector-drawer__section">
                    <div className="inspector-drawer__section-heading">
                      <h3>Фото с места</h3>
                      <span>{record.photos.length}</span>
                    </div>
                    {record.photos.length ? (
                      <div className="inspector-drawer__photos">
                        {record.photos.map((photo, index) => (
                          <Photo
                            key={`${record.id}:${photo.id}`}
                            photo={photo}
                            number={index + 1}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="inspector-drawer__no-photo">
                        <ImageOff size={19} />К обращению не прикреплены фотографии
                      </div>
                    )}
                  </section>
                  <div
                    className={`inspector-drawer__deadline${record.is_overdue ? ' is-overdue' : ''}`}
                  >
                    <CalendarDays size={18} />
                    <div>
                      <span>
                        {record.is_overdue ? 'Срок устранения просрочен' : 'Срок устранения'}
                      </span>
                      <strong>
                        {record.deadline ? formatDate(record.deadline) : 'Не назначен'}
                      </strong>
                    </div>
                    {record.is_overdue && <TriangleAlert size={18} />}
                  </div>
                  <section className="inspector-drawer__section">
                    <div className="inspector-drawer__section-heading">
                      <h3>Работа с обращением</h3>
                      <FileText size={16} />
                    </div>
                    <form onSubmit={save} className="inspector-drawer__form" noValidate>
                      <fieldset disabled={saving || Boolean(blocked)}>
                        <label htmlFor={`${fieldId}-status`}>Статус обращения</label>
                        <select
                          id={`${fieldId}-status`}
                          value={draft.status}
                          onChange={(event) => update('status', event.target.value)}
                          aria-invalid={Boolean(fieldErrors.status)}
                          aria-describedby={
                            fieldErrors.status ? `${fieldId}-status-error` : undefined
                          }
                        >
                          {[record.status, ...(TRANSITIONS[record.status] || [])].map((status) => (
                            <option key={status} value={status}>
                              {STATUS_META[status]?.label || status}
                            </option>
                          ))}
                        </select>
                        {fieldError('status')}
                        <label htmlFor={`${fieldId}-deadline`}>
                          Срок устранения{' '}
                          {draft.status === 'IN_PROGRESS' && <span aria-hidden="true">*</span>}
                        </label>
                        <input
                          id={`${fieldId}-deadline`}
                          type="date"
                          value={draft.deadline}
                          onChange={(event) => update('deadline', event.target.value)}
                          required={draft.status === 'IN_PROGRESS'}
                          aria-invalid={Boolean(fieldErrors.deadline)}
                          aria-describedby={
                            fieldErrors.deadline ? `${fieldId}-deadline-error` : undefined
                          }
                        />
                        {fieldError('deadline')}
                        <label htmlFor={`${fieldId}-plot_id`}>Привязка к участку</label>
                        <select
                          id={`${fieldId}-plot_id`}
                          value={draft.plot_id}
                          onChange={(event) => update('plot_id', event.target.value)}
                          aria-invalid={Boolean(fieldErrors.plot_id)}
                          aria-describedby={
                            fieldErrors.plot_id ? `${fieldId}-plot_id-error` : undefined
                          }
                        >
                          <option value="">Без привязки к участку</option>
                          {record.plot &&
                            !availablePlots.some((plot) => plot.id === record.plot.id) && (
                              <option value={record.plot.id}>{record.plot.cadastral_number}</option>
                            )}
                          {availablePlots.map((plot) => (
                            <option key={plot.id} value={plot.id}>
                              {plot.cadastral_number}
                            </option>
                          ))}
                        </select>
                        {fieldError('plot_id')}
                        <label htmlFor={`${fieldId}-comment`}>
                          {draft.status === 'RESOLVED' && record.status !== 'RESOLVED'
                            ? 'Причина закрытия *'
                            : 'Комментарий инспектора'}
                        </label>
                        <textarea
                          id={`${fieldId}-comment`}
                          rows={3}
                          maxLength={2000}
                          placeholder={
                            draft.status === 'RESOLVED'
                              ? 'Укажите результат проверки или причину закрытия'
                              : 'Результат проверки, назначенные действия…'
                          }
                          value={draft.comment}
                          onChange={(event) => update('comment', event.target.value)}
                          aria-invalid={Boolean(fieldErrors.comment)}
                          aria-describedby={
                            fieldErrors.comment ? `${fieldId}-comment-error` : undefined
                          }
                        />
                        {fieldError('comment')}
                      </fieldset>
                      {blocked && (
                        <div className="inspector-drawer__conflict" role="alert">
                          <TriangleAlert size={18} />
                          <p>{blocked.message}</p>
                          <button type="button" disabled={saving} onClick={refreshConflict}>
                            <RefreshCw size={14} />
                            Загрузить актуальные данные
                          </button>
                        </div>
                      )}
                      {formError && (
                        <div className="inspector-drawer__form-error" role="alert">
                          {formError}
                        </div>
                      )}
                      {notice && (
                        <div className="inspector-drawer__success" role="status">
                          <CheckCheck size={17} />
                          <span>{notice}</span>
                        </div>
                      )}
                      <button
                        className="inspector-drawer__save"
                        type="submit"
                        disabled={!changed || saving || Boolean(blocked)}
                      >
                        {saving ? (
                          <LoaderCircle className="inspector-drawer__spin" size={16} />
                        ) : (
                          <Save size={16} />
                        )}
                        {saving ? 'Сохраняем…' : 'Сохранить изменения'}
                        <ChevronRight size={17} />
                      </button>
                      <p className="inspector-drawer__helper inspector-drawer__version">
                        Версия {record.version} · Обновлено {formatDateTime(record.updated_at)}
                      </p>
                    </form>
                  </section>
                  <section className="inspector-drawer__section">
                    <div className="inspector-drawer__section-heading">
                      <h3>История обращения</h3>
                      <Clock3 size={16} />
                    </div>
                    <History events={record.history} plots={availablePlots} />
                  </section>
                </>
              ) : (
                <>
                  <section className="inspector-drawer__section">
                    <h3 className="inspector-drawer__category">{record.purpose}</h3>
                    <p className="inspector-drawer__description">
                      {record.address || 'Адрес не указан'}
                    </p>
                  </section>
                  <div className="inspector-drawer__plot-stats">
                    <div>
                      <Layers size={19} />
                      <strong>
                        {new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(
                          record.area_ha,
                        )}
                        <small> га</small>
                      </strong>
                      <span>Площадь участка</span>
                    </div>
                    <div>
                      <MessageSquare size={19} />
                      <strong>{record.active_reports_count}</strong>
                      <span>Активных обращений</span>
                    </div>
                  </div>
                  <section className="inspector-drawer__section">
                    <span className="inspector-drawer__eyebrow">СТАТУС УЧАСТКА</span>
                    <p className="inspector-drawer__description">
                      Статус рассчитывается по связанным обращениям и обновляется при работе
                      инспектора с ними.
                    </p>
                    {!record.geometry && (
                      <div className="inspector-drawer__no-photo">
                        <MapPin size={18} />
                        Границы участка пока не добавлены на карту.
                      </div>
                    )}
                  </section>
                </>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
