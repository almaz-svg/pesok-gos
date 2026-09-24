import uuid

class ApiMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.request_id = str(uuid.uuid4())
        response = self.get_response(request)
        if request.path.startswith('/api/'):
            # Django URL-resolution errors must follow the API envelope even in DEBUG mode.
            if response.status_code in (400, 403, 404, 500) and not response.get('Content-Type', '').startswith('application/json'):
                from . import errors
                handler = {400: errors.bad_request, 403: errors.permission_denied, 404: errors.not_found, 500: errors.server_error}
                response = handler[response.status_code](request)
            response['X-Request-ID'] = request.request_id
            response['Cache-Control'] = 'private, no-store'
        return response
