import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Check, Eye, EyeOff, Info } from 'lucide-react';
import { REGISTRATION_FIELDS, validateRegistration } from '../../lib/registration-form.js';

const initialValues = { name: '', email: '', password: '', passwordConfirmation: '' };
const fields = [
  {
    name: 'name',
    label: 'Имя',
    placeholder: 'Как к вам обращаться',
    autoComplete: 'name',
    maxLength: 150,
  },
  {
    name: 'email',
    label: 'Email',
    placeholder: 'name@example.com',
    autoComplete: 'email',
    type: 'email',
    maxLength: 254,
  },
  {
    name: 'password',
    label: 'Пароль',
    placeholder: 'Придумайте пароль',
    autoComplete: 'new-password',
    type: 'password',
    maxLength: 128,
  },
  {
    name: 'passwordConfirmation',
    label: 'Подтверждение пароля',
    placeholder: 'Повторите пароль',
    autoComplete: 'new-password',
    type: 'password',
    maxLength: 128,
  },
];

export default function RegisterForm() {
  const [values, setValues] = useState(initialValues);
  const [touched, setTouched] = useState({});
  const [visible, setVisible] = useState({});
  const [validated, setValidated] = useState(false);
  const resultRef = useRef(null);
  const formRef = useRef(null);
  const returningToForm = useRef(false);
  const errors = validateRegistration(values);

  useEffect(() => {
    if (validated) resultRef.current?.focus();
    else if (returningToForm.current) {
      formRef.current?.elements.namedItem('name')?.focus();
      returningToForm.current = false;
    }
  }, [validated]);

  function submit(event) {
    event.preventDefault();
    setTouched(Object.fromEntries(REGISTRATION_FIELDS.map((name) => [name, true])));
    const firstError = REGISTRATION_FIELDS.find((name) => errors[name]);
    if (firstError) {
      event.currentTarget.elements.namedItem(firstError)?.focus();
      return;
    }
    // The current API has no registration endpoint. Never simulate account creation.
    setValidated(true);
    setValues((previous) => ({ ...previous, password: '', passwordConfirmation: '' }));
    setTouched({});
    setVisible({});
  }

  return (
    <div className="register-card">
      <div className="register-card-heading">
        <span className="auth-eyebrow">ЛИЧНЫЙ АККАУНТ</span>
        <h2 id="register-form-title">Создать аккаунт</h2>
        <p>Начните с простого — расскажите немного о себе.</p>
      </div>
      {validated ? (
        <div className="registration-result" tabIndex={-1} ref={resultRef} role="status">
          <span className="registration-result-icon">
            <Check size={26} />
          </span>
          <h3>Форма заполнена верно</h3>
          <p>Создание аккаунтов ещё не подключено. Аккаунт не создан, ваши данные не отправлены.</p>
          <button
            className="button auth-submit"
            onClick={() => {
              returningToForm.current = true;
              setValidated(false);
            }}
          >
            Вернуться к форме <ArrowUpRight size={18} />
          </button>
          <Link className="auth-text-link" to="/map">
            Посмотреть карту земель
          </Link>
        </div>
      ) : (
        <>
          <form
            ref={formRef}
            className="register-form"
            aria-labelledby="register-form-title"
            noValidate
            onSubmit={submit}
          >
            {fields.map((field) => {
              const error = touched[field.name] ? errors[field.name] : '';
              const isPassword = field.type === 'password';
              const inputId = `register-${field.name}`;
              const hintId = field.name === 'password' ? 'register-password-hint' : undefined;
              return (
                <div className="auth-field" key={field.name}>
                  <label htmlFor={inputId}>{field.label}</label>
                  <div className={`auth-input-wrap ${error ? 'has-error' : ''}`}>
                    <input
                      id={inputId}
                      name={field.name}
                      type={isPassword && visible[field.name] ? 'text' : field.type || 'text'}
                      value={values[field.name]}
                      autoComplete={field.autoComplete}
                      autoCapitalize={field.name === 'name' ? 'words' : 'none'}
                      spellCheck={field.name === 'name'}
                      maxLength={field.maxLength}
                      placeholder={field.placeholder}
                      required
                      aria-invalid={Boolean(error)}
                      aria-describedby={
                        [hintId, error ? `${inputId}-error` : null].filter(Boolean).join(' ') ||
                        undefined
                      }
                      onChange={(event) =>
                        setValues((previous) => ({ ...previous, [field.name]: event.target.value }))
                      }
                      onBlur={() => setTouched((previous) => ({ ...previous, [field.name]: true }))}
                    />
                    {isPassword && (
                      <button
                        type="button"
                        className="password-toggle"
                        aria-label={`${visible[field.name] ? 'Скрыть' : 'Показать'} ${field.name === 'password' ? 'пароль' : 'подтверждение пароля'}`}
                        aria-pressed={Boolean(visible[field.name])}
                        aria-controls={inputId}
                        onClick={() =>
                          setVisible((previous) => ({
                            ...previous,
                            [field.name]: !previous[field.name],
                          }))
                        }
                      >
                        {visible[field.name] ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    )}
                  </div>
                  {hintId && (
                    <p className="auth-field-hint" id={hintId}>
                      Не менее 8 символов. Можно использовать пробелы.
                    </p>
                  )}
                  {error && (
                    <p className="auth-field-error" id={`${inputId}-error`}>
                      {error}
                    </p>
                  )}
                </div>
              );
            })}
            <div className="registration-notice" id="registration-notice">
              <Info size={16} aria-hidden="true" />
              <p>
                Предпросмотр формы. Создание аккаунтов пока недоступно; данные никуда не
                отправляются.
              </p>
            </div>
            <button
              type="submit"
              className="button auth-submit"
              aria-describedby="registration-notice"
            >
              Создать аккаунт <ArrowUpRight size={19} />
            </button>
          </form>
          <p className="auth-signin">
            Уже есть доступ?{' '}
            <Link to="/map">
              Открыть панель <ArrowUpRight size={13} />
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
