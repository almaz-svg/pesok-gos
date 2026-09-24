from django.urls import path
from . import views

urlpatterns = [
    path('health', views.HealthView.as_view()),
    path('auth/csrf', views.CsrfView.as_view()),
    path('auth/login', views.LoginView.as_view()),
    path('auth/me', views.MeView.as_view()),
    path('auth/logout', views.LogoutView.as_view()),
    path('reports', views.ReportsView.as_view()),
    path('reports/<uuid:report_id>', views.ReportView.as_view()),
    path('plots', views.PlotsView.as_view()),
    path('plots/<uuid:plot_id>', views.PlotView.as_view()),
    path('map', views.MapView.as_view()),
    path('statistics', views.StatisticsView.as_view()),
    path('photos/<uuid:photo_id>', views.PhotoView.as_view()),
    path('tracking/<str:number>', views.TrackingView.as_view()),
    path('instructions', views.InstructionsView.as_view()),
]
