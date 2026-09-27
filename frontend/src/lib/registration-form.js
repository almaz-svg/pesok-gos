export const REGISTRATION_FIELDS = ['username', 'email', 'password', 'passwordConfirmation'];

export function validateRegistration(values) {
  const errors = {};
  const username = values.username.trim();
  const email = values.email.trim();
  if (!username) errors.username = 'Укажите логин.';
  else if (username.length > 150) errors.username = 'Логин должен быть не длиннее 150 символов.';

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
