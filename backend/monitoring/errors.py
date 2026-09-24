import logging
import uuid

from django.http import JsonResponse
from rest_framework.exceptions import APIException

logger = logging.getLogger(__name__)

class ApiProblem(APIException):
    def __init__(self, code, message, status=400, fields=None):
        self.status_code = status
        self.api_code = code
        self.fields = fields or {}
        super().__init__(message, code=code)

def envelope(request, code, message, fields=None):
    return {'error': {
        'code': code, 'message': message, 'fields': fields or {},
        'request_id': getattr(request, 'request_id', str(uuid.uuid4())),
    }}

def flatten(value, prefix=''):
    result = {}
    if isinstance(value, dict):
        for key, item in value.items():
            result.update(flatten(item, f'{prefix}.{key}' if prefix else str(key)))
    elif isinstance(value, list) and any(isinstance(item, (dict, list)) for item in value):
        for index, item in enumerate(value):
            result.update(flatten(item, f'{prefix}.{index}'))
    else:
        result[prefix or 'non_field_errors'] = [str(item) for item in value] if isinstance(value, list) else [str(value)]
    return result

def exception_handler(exc, context):
    from rest_framework.views import exception_handler as drf_exception_handler
    request = context['request']
    response = drf_exception_handler(exc, context)
    if response is None:
        # Do not log exception text: upstream HTTP exceptions can contain BOT_TOKEN URLs.
        logger.error('API failure request_id=%s type=%s', getattr(request, 'request_id', ''), type(exc).__name__)
        from rest_framework.response import Response
        return Response(envelope(request, 'internal_error', 'Внутренняя ошибка сервера'), status=500)
    defaults = {
        400: ('validation_error', 'Проверьте поля запроса'),
        401: ('authentication_required', 'Требуется авторизация'),
        403: ('permission_denied', 'Недостаточно прав'),
        404: ('not_found', 'Объект не найден'),
        405: ('method_not_allowed', 'Метод не поддерживается'),
        415: ('unsupported_media_type', 'Ожидается application/json'),
        429: ('rate_limited', 'Слишком много запросов'),
    }
    code, message = defaults.get(response.status_code, ('request_error', 'Ошибка запроса'))
    fields = flatten(response.data) if response.status_code == 400 else {}
    if isinstance(exc, ApiProblem):
        code, message, fields = exc.api_code, str(exc.detail), exc.fields
    response.data = envelope(request, code, message, fields)
    return response

def csrf_failure(request, reason=''):
    return JsonResponse(envelope(request, 'csrf_failed', 'Проверка CSRF не пройдена'), status=403)

def bad_request(request, exception=None):
    return JsonResponse(envelope(request, 'validation_error', 'Некорректный запрос'), status=400)

def permission_denied(request, exception=None):
    return JsonResponse(envelope(request, 'permission_denied', 'Недостаточно прав'), status=403)

def not_found(request, exception=None):
    return JsonResponse(envelope(request, 'not_found', 'Объект не найден'), status=404)

def server_error(request):
    return JsonResponse(envelope(request, 'internal_error', 'Внутренняя ошибка сервера'), status=500)
