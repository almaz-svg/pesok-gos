const API_BASE = (import.meta.env?.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
export const MAX_QUESTION_LENGTH = 2000;

export function chatHistory(turns, question) {
  const completed = turns.filter((turn) => turn.answer).slice(-6);
  const messages = [];
  let remaining = 24000;
  // Keep complete turns; never send an orphaned answer or an unanswered question.
  for (const turn of completed.reverse()) {
    const pair = [
      { role: 'user', content: turn.question },
      { role: 'assistant', content: turn.answer },
    ];
    const length = turn.question.length + turn.answer.length;
    if (length > remaining) break;
    messages.unshift(...pair);
    remaining -= length;
  }
  return [...messages, { role: 'user', content: question }];
}

export function createAssistantClient({ fetchImpl = globalThis.fetch, timeoutMs = 35000 } = {}) {
  async function request(options = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${API_BASE}/assistant/chat`, {
        method: options.body ? 'POST' : 'GET',
        credentials: 'include',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(options.body
            ? { 'Content-Type': 'application/json', 'X-CSRFToken': options.csrf }
            : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error('Помощник временно недоступен. Попробуйте позже.');
      }
      if (!response.ok) {
        const messages = {
          400: 'Не удалось отправить вопрос. Сократите сообщение или начните новый диалог.',
          403: 'Сессия обновилась. Попробуйте отправить сообщение ещё раз.',
          429: 'Слишком много запросов. Попробуйте через минуту.',
          504: 'Помощник не успел ответить. Попробуйте ещё раз.',
        };
        throw new Error(
          messages[response.status] || 'Помощник временно недоступен. Попробуйте позже.',
        );
      }
      return data;
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (controller.signal.aborted) throw new Error('Время ожидания истекло. Попробуйте ещё раз.');
      if (error instanceof TypeError)
        throw new Error('Нет соединения с помощником. Проверьте подключение.');
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  async function status(signal) {
    const data = await request({ signal });
    if (typeof data?.available !== 'boolean' || typeof data?.csrf_token !== 'string')
      throw new Error('Помощник временно недоступен. Попробуйте позже.');
    return data;
  }

  async function send(messages, page, signal) {
    // Get a fresh token: signing in on another page rotates Django's CSRF secret.
    const connection = await status(signal);
    if (!connection.available) throw new Error('Помощник пока недоступен. Попробуйте позже.');
    const data = await request({ body: { messages, page }, csrf: connection.csrf_token, signal });
    if (typeof data?.reply !== 'string' || !data.reply.trim())
      throw new Error('Помощник вернул пустой ответ. Попробуйте ещё раз.');
    return { reply: data.reply, truncated: Boolean(data.truncated) };
  }
  return { status, send };
}

export const assistantClient = createAssistantClient();
