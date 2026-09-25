export const REGISTRATION_FIELDS = ['name', 'email', 'password', 'passwordConfirmation'];

export function validateRegistration(values) {
  const errors = {};
  const name = values.name.trim();
  const email = values.email.trim();
  if (!name) errors.name = 'Укажите ваше имя.';
  else if (name.length < 2) errors.name = 'Введите не менее 2 символов.';
  else if (name.length > 150) errors.name = 'Имя должно быть не длиннее 150 символов.';

  if (!email) errors.email = 'Укажите email.';
  else if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    errors.email = 'Введите email в формате name@example.com.';

  if (!values.password) errors.password = 'Придумайте пароль.';
  else if (values.password.trim().length === 0 || values.password.length < 8)
    errors.password = 'Используйте не менее 8 символов.';
  else if (values.password.length > 128)
    errors.password = 'Пароль должен быть не длиннее 128 символов.';

  if (!values.passwordConfirmation) errors.passwordConfirmation = 'Повторите пароль.';
  else if (values.password !== values.passwordConfirmation)
    errors.passwordConfirmation = 'Пароли не совпадают.';
  return errors;
}
