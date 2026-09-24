import secrets

from django.conf import settings
from rest_framework.authentication import BaseAuthentication, SessionAuthentication, get_authorization_header
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied
from rest_framework.permissions import BasePermission
from rest_framework.throttling import SimpleRateThrottle

from .errors import ApiProblem

class BotPrincipal:
    is_authenticated = True
    is_inspector = False
    is_bot = True
    pk = 'telegram-bot'

class BotAuthentication(BaseAuthentication):
    def authenticate(self, request):
        header = get_authorization_header(request)
        if not header:
            return None
        parts = header.split()
        if (len(parts) != 2 or parts[0].lower() != b'bearer' or not settings.BOT_API_KEY
                or not secrets.compare_digest(parts[1], settings.BOT_API_KEY.encode())):
            raise AuthenticationFailed()
        return BotPrincipal(), 'bot'

    def authenticate_header(self, request):
        return 'Bearer'

class InspectorSessionAuthentication(SessionAuthentication):
    def enforce_csrf(self, request):
        try:
            super().enforce_csrf(request)
        except PermissionDenied:
            raise ApiProblem('csrf_failed', 'Проверка CSRF не пройдена', 403)

class IsInspector(BasePermission):
    def has_permission(self, request, view):
        return bool(request.user.is_authenticated and getattr(request.user, 'is_inspector', False))

class IsBot(BasePermission):
    def has_permission(self, request, view):
        return request.auth == 'bot'

class InspectorOrBot(BasePermission):
    def has_permission(self, request, view):
        return IsInspector().has_permission(request, view) or IsBot().has_permission(request, view)

class LoginThrottle(SimpleRateThrottle):
    scope = 'login'

    def get_cache_key(self, request, view):
        return self.cache_format % {'scope': self.scope, 'ident': request.META.get('REMOTE_ADDR', '')}

class BotThrottle(SimpleRateThrottle):
    scope = 'bot'

    def get_cache_key(self, request, view):
        if request.auth == 'bot':
            return self.cache_format % {'scope': self.scope, 'ident': 'telegram-bot'}
        return None
