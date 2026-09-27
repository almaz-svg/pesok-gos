const DESTINATIONS = ['/map', '/reports', '/reports?view=analytics'];

export function loginDestination(value) {
  return DESTINATIONS.includes(value) ? value : '/map';
}

export function authPath(page, destination) {
  const next = loginDestination(destination);
  return next === '/map' ? page : `${page}?next=${encodeURIComponent(next)}`;
}

export function validateLogin({ username, password }) {
  const errors = {};
  if (!username.trim()) errors.username = 'Укажите логин.';
  else if (username.trim().length > 150)
    errors.username = 'Логин должен быть не длиннее 150 символов.';
  if (!password) errors.password = 'Введите пароль.';
  else if (password.length > 4096) errors.password = 'Пароль слишком длинный.';
  return errors;
}

export function loginErrorMessage(error) {
  if (error.code === 'invalid_credentials') return 'Неверный логин или пароль';
  if (error.code === 'permission_denied') return 'Нет прав инспектора';
  if (error.code === 'csrf_failed') return 'Сессия обновилась. Повторите вход.';
  if (error.status === 429) return 'Слишком много попыток входа. Подождите и попробуйте снова.';
  if (['network_error', 'timeout'].includes(error.code))
    return 'Не удалось связаться с сервером. Проверьте подключение.';
  return 'Не удалось войти. Попробуйте ещё раз.';
}
