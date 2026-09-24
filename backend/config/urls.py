from django.urls import include, path

urlpatterns = [path('api/', include('monitoring.urls'))]
handler400 = 'monitoring.errors.bad_request'
handler403 = 'monitoring.errors.permission_denied'
handler404 = 'monitoring.errors.not_found'
handler500 = 'monitoring.errors.server_error'
