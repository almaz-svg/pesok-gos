import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import {
  ArrowUp,
  ArrowUpRight,
  LoaderCircle,
  RotateCcw,
  AssistantChat,
  Square,
  X,
} from '../icons.jsx';
import { assistantClient, chatHistory, MAX_QUESTION_LENGTH } from '../../lib/assistant-client.js';
import './assistant.css';

const suggestions = ['Как работает карта?', 'Что означают статусы?', 'Как отправить обращение?'];
const pages = ['/', '/map', '/reports', '/register'];

export default function AssistantWidget() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState([]);
  const [connection, setConnection] = useState('checking');
  const [sending, setSending] = useState(false);
  const dialogRef = useRef(null);
  const launcherRef = useRef(null);
  const closeRef = useRef(null);
  const inputRef = useRef(null);
  const logRef = useRef(null);
  const requestRef = useRef(null);
  const statusRef = useRef(null);

  async function checkConnection() {
    statusRef.current?.abort();
    const controller = new AbortController();
    statusRef.current = controller;
    setConnection('checking');
    try {
      const result = await assistantClient.status(controller.signal);
      if (!controller.signal.aborted) setConnection(result.available ? 'ready' : 'unavailable');
    } catch {
      if (!controller.signal.aborted) setConnection('unavailable');
    }
  }

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    dialog.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const target = window.matchMedia('(max-width: 600px)').matches ? closeRef : inputRef;
    target.current?.focus({ preventScroll: true });
    checkConnection();
    const viewport = window.visualViewport;
    const resize = () => {
      dialog.style.setProperty(
        '--chat-viewport-height',
        `${viewport?.height || window.innerHeight}px`,
      );
      dialog.style.setProperty('--chat-viewport-top', `${viewport?.offsetTop || 0}px`);
    };
    resize();
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', resize);
    window.addEventListener('resize', resize);
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      statusRef.current?.abort();
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', resize);
      window.removeEventListener('resize', resize);
      launcherRef.current?.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(
    () => () => {
      requestRef.current?.abort();
      statusRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (open && logRef.current)
      logRef.current.scrollTop = turns.length ? logRef.current.scrollHeight : 0;
  }, [turns, open]);

  async function send(text, retryId = null) {
    const clean = text.trim();
    if (!clean || clean.length > MAX_QUESTION_LENGTH || requestRef.current) return;
    const id = retryId || crypto.randomUUID();
    const controller = new AbortController();
    requestRef.current = controller;
    const history = retryId
      ? turns.slice(
          0,
          turns.findIndex((turn) => turn.id === retryId),
        )
      : turns;
    const pending = { id, question: clean, answer: '', state: 'sending' };
    setTurns((previous) =>
      retryId ? previous.map((turn) => (turn.id === id ? pending : turn)) : [...previous, pending],
    );
    setQuestion('');
    setSending(true);
    try {
      const result = await assistantClient.send(
        chatHistory(history, clean),
        pages.includes(pathname) ? pathname : '/',
        controller.signal,
      );
      if (requestRef.current !== controller) return;
      setConnection('ready');
      setTurns((previous) =>
        previous.map((turn) =>
          turn.id === id
            ? { ...turn, answer: result.reply, truncated: result.truncated, state: 'done' }
            : turn,
        ),
      );
    } catch (error) {
      if (requestRef.current !== controller) return;
      setTurns((previous) =>
        previous.map((turn) =>
          turn.id === id
            ? {
                ...turn,
                state: 'error',
                error: error.name === 'AbortError' ? 'Ожидание ответа остановлено.' : error.message,
              }
            : turn,
        ),
      );
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setSending(false);
      }
    }
  }

  function reset() {
    requestRef.current?.abort();
    requestRef.current = null;
    setSending(false);
    setTurns([]);
    setQuestion('');
    inputRef.current?.focus();
  }

  return createPortal(
    <>
      <button
        className="assistant-launcher"
        ref={launcherRef}
        onClick={() => setOpen(true)}
        aria-label="Открыть ИИ-помощника"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="site-assistant"
      >
        <AssistantChat size={23} />
        <span>ИИ-помощник</span>
        <ArrowUpRight className="assistant-launcher-arrow" size={18} />
      </button>
      <dialog
        id="site-assistant"
        className="assistant-dialog"
        ref={dialogRef}
        aria-labelledby="assistant-title"
        aria-describedby="assistant-subtitle"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const targets = [
            ...event.currentTarget.querySelectorAll(
              'button:not(:disabled), a[href], textarea:not(:disabled)',
            ),
          ].filter((element) => element.getClientRects().length);
          const target =
            event.shiftKey && document.activeElement === targets[0]
              ? targets.at(-1)
              : !event.shiftKey && document.activeElement === targets.at(-1)
                ? targets[0]
                : null;
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
        onCancel={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            const rect = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            )
              setOpen(false);
          }
        }}
      >
        <header className="assistant-header">
          <span className="assistant-avatar" aria-hidden="true">
            <AssistantChat size={22} />
          </span>
          <div>
            <h2 id="assistant-title">Помощник Песок</h2>
            <p id="assistant-subtitle">Помогу разобраться в проекте</p>
          </div>
          <button
            className="assistant-icon-button"
            onClick={reset}
            aria-label="Начать новый диалог"
            title="Новый диалог"
            disabled={!turns.length && !question}
          >
            <RotateCcw size={18} />
          </button>
          <button
            className="assistant-icon-button"
            ref={closeRef}
            onClick={() => setOpen(false)}
            aria-label="Закрыть ИИ-помощника"
          >
            <X size={21} />
          </button>
        </header>
        <div
          className="assistant-log"
          ref={logRef}
          role="log"
          aria-label="Диалог с помощником"
          aria-live="polite"
          aria-relevant="additions text"
        >
          <div className="assistant-welcome">
            <span className="assistant-eyebrow">НА СТОРОНЕ ЗЕМЛИ</span>
            <h3>
              Давайте разберёмся
              <br />
              вместе<span>.</span>
            </h3>
            <p>Подскажу, где найти участок, как читать статусы и работать с обращениями.</p>
            <div className="assistant-shortcuts">
              <Link to="/map" onClick={() => setOpen(false)}>
                Карта земель <ArrowUpRight size={14} />
              </Link>
              <Link to="/reports" onClick={() => setOpen(false)}>
                Обращения <ArrowUpRight size={14} />
              </Link>
            </div>
          </div>
          {!turns.length && (
            <div className="assistant-suggestions" aria-label="Примеры вопросов">
              {suggestions.map((text) => (
                <button key={text} onClick={() => send(text)} disabled={sending}>
                  {text}
                  <ArrowUpRight size={15} />
                </button>
              ))}
            </div>
          )}
          {turns.map((turn, index) => (
            <div className="assistant-turn" key={turn.id}>
              <div className="assistant-message assistant-message-user">
                <span className="assistant-speaker">Вы</span>
                <p>{turn.question}</p>
              </div>
              {turn.answer && (
                <div className="assistant-message assistant-message-reply">
                  <span className="assistant-speaker">
                    <AssistantChat size={13} /> Песок · ИИ
                  </span>
                  <p>{turn.answer}</p>
                  {turn.truncated && (
                    <small>Ответ сокращён. Уточните вопрос, чтобы узнать больше.</small>
                  )}
                </div>
              )}
              {turn.state === 'sending' && (
                <div className="assistant-thinking" role="status">
                  <LoaderCircle size={16} /> Помощник готовит ответ…
                </div>
              )}
              {turn.state === 'error' && (
                <div className="assistant-error" role="alert">
                  <p>{turn.error}</p>
                  {index === turns.length - 1 && (
                    <button disabled={sending} onClick={() => send(turn.question, turn.id)}>
                      <RotateCcw size={14} /> Повторить отправку
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="assistant-bottom">
          {connection === 'unavailable' && !turns.length && (
            <div className="assistant-connection" role="status">
              <span>Помощник пока недоступен</span>
              <button onClick={checkConnection}>Проверить связь</button>
            </div>
          )}
          <form
            className="assistant-composer"
            onSubmit={(event) => {
              event.preventDefault();
              send(question);
            }}
          >
            <label className="sr-only" htmlFor="assistant-question">
              Ваш вопрос помощнику
            </label>
            <textarea
              id="assistant-question"
              ref={inputRef}
              value={question}
              rows={2}
              maxLength={MAX_QUESTION_LENGTH}
              placeholder="Спросите о проекте…"
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  !window.matchMedia('(pointer: coarse)').matches
                ) {
                  event.preventDefault();
                  send(question);
                }
              }}
            />
            {sending ? (
              <button
                type="button"
                className="assistant-send"
                onClick={() => requestRef.current?.abort()}
                aria-label="Остановить ответ"
              >
                <Square size={17} />
              </button>
            ) : (
              <button
                type="submit"
                className="assistant-send"
                disabled={!question.trim()}
                aria-label="Отправить сообщение"
              >
                <ArrowUp size={21} />
              </button>
            )}
          </form>
          <div className="assistant-footnote">
            <span>Сообщения обрабатывает OpenAI</span>
            <span>
              {question.length}/{MAX_QUESTION_LENGTH}
            </span>
          </div>
        </div>
      </dialog>
    </>,
    document.body,
  );
}
