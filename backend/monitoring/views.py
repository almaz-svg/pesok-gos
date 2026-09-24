import uuid

from django.conf import settings
from django.contrib.auth import authenticate, login, logout
from django.core.paginator import EmptyPage, Paginator
from django.db import connection
from django.db.models import Count, Q
from django.http import HttpResponse
from django.middleware.csrf import get_token
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .auth import BotThrottle, InspectorOrBot, InspectorSessionAuthentication, IsBot, IsInspector, LoginThrottle
from .errors import ApiProblem
from .models import Instruction, Report, ReportPhoto, ReportStatus, TrackingRecord
from .photos import fetch_photo
from .serializers import (
    CreateReportSerializer, InstructionSerializer, LoginSerializer, MapQuery, PatchReportSerializer,
    PlotQuery, PlotSerializer, ReportDetailSerializer, ReportQuery, ReportSerializer,
    StrictSerializer, TrackingQuerySerializer, validate_query,
)
from .services import create_report, filter_plots, filter_reports, plot_queryset, report_queryset, timestamp, update_report
from .validators import geometry_in_bbox

def paginated(request, queryset, serializer_class, params):
    paginator = Paginator(queryset, params['page_size'])
    try:
        page = paginator.page(params['page'])
    except EmptyPage:
        raise ApiProblem('not_found', 'Страница не найдена', 404)
    def link(number):
        query = request.query_params.copy()
        query['page'] = number
        return request.build_absolute_uri(request.path + '?' + query.urlencode())
    return Response({'count': paginator.count, 'next': link(page.next_page_number()) if page.has_next() else None,
                     'previous': link(page.previous_page_number()) if page.has_previous() else None,
                     'results': serializer_class(page.object_list, many=True).data})

class CsrfView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request):
        return Response({'csrf_token': get_token(request)})

class LoginView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [LoginThrottle]

    def post(self, request):
        # DRF skips anonymous CSRF checks by default; login must explicitly enforce it.
        InspectorSessionAuthentication().enforce_csrf(request)
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = authenticate(request, **serializer.validated_data)
        if user is None:
            raise ApiProblem('invalid_credentials', 'Неверный логин или пароль', 401)
        if not user.is_inspector:
            raise ApiProblem('permission_denied', 'Нет прав инспектора', 403)
        login(request, user)
        return Response({'user': {'id': str(user.id), 'username': user.username}, 'csrf_token': get_token(request)})

class MeView(APIView):
    def get(self, request):
        return Response({'id': str(request.user.id), 'username': request.user.username})

class LogoutView(APIView):
    def post(self, request):
        serializer = StrictSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        logout(request)
        return Response(status=204)

class ReportsView(APIView):
    throttle_classes = [BotThrottle]

    def get_permissions(self):
        return [IsBot()] if self.request.method == 'POST' else [IsInspector()]

    def get(self, request):
        params = validate_query(request, ReportQuery)
        return paginated(request, filter_reports(report_queryset(), params), ReportSerializer, params)

    def post(self, request):
        serializer = CreateReportSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            key = uuid.UUID(request.headers.get('Idempotency-Key', ''))
        except ValueError:
            raise ApiProblem('validation_error', 'Нужен Idempotency-Key UUID', fields={'Idempotency-Key': ['Обязателен UUID']})
        return Response(create_report(serializer.validated_data, key), status=201)

class ReportView(APIView):
    def get(self, request, report_id):
        validate_query(request, StrictSerializer)
        report = get_object_or_404(report_queryset().prefetch_related('history'), pk=report_id)
        return Response(ReportDetailSerializer(report).data)

    def patch(self, request, report_id):
        serializer = PatchReportSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        report = update_report(report_id, serializer.validated_data, request.user)
        return Response(ReportDetailSerializer(report).data)

class PlotsView(APIView):
    def get(self, request):
        params = validate_query(request, PlotQuery)
        return paginated(request, filter_plots(plot_queryset(), params), PlotSerializer, params)

class PlotView(APIView):
    def get(self, request, plot_id):
        validate_query(request, StrictSerializer)
        return Response(PlotSerializer(get_object_or_404(plot_queryset(), pk=plot_id)).data)

class MapView(APIView):
    def get(self, request):
        params = validate_query(request, MapQuery)
        report_params = {key: value for key, value in params.items() if key in ('category', 'overdue', 'search')}
        plot_params = {key: value for key, value in params.items() if key == 'search'}
        if 'report_status' in params:
            report_params['status'] = params['report_status']
        if 'plot_status' in params:
            plot_params['status'] = params['plot_status']
        reports = filter_reports(report_queryset(), report_params)
        plots = filter_plots(plot_queryset().exclude(geometry=None), plot_params)
        if 'bbox' in params:
            west, south, east, north = params['bbox']
            reports = reports.filter(longitude__gte=west, longitude__lte=east, latitude__gte=south, latitude__lte=north)
        plot_features, report_features = [], []
        def check_limit():
            if len(plot_features) + len(report_features) > settings.MAP_MAX_FEATURES:
                raise ApiProblem('map_limit_exceeded', 'Приблизьте карту для загрузки объектов', 422)
        for plot in plots.iterator(chunk_size=200):
            if 'bbox' in params and not geometry_in_bbox(plot.geometry, params['bbox']):
                continue
            plot_features.append({'type': 'Feature', 'id': str(plot.id), 'geometry': plot.geometry,
                                  'properties': {'cadastral_number': plot.cadastral_number, 'status': plot.computed_status, 'area_ha': float(plot.area_ha)}})
            check_limit()
        for report in reports.iterator(chunk_size=200):
            report_features.append({'type': 'Feature', 'id': str(report.id),
                'geometry': {'type': 'Point', 'coordinates': [report.longitude, report.latitude]},
                'properties': {'tracking_number': report.tracking.number, 'status': report.status, 'category': report.category,
                               'plot_id': str(report.plot_id) if report.plot_id else None,
                               'deadline': report.deadline.isoformat() if report.deadline else None, 'is_overdue': report.is_overdue}})
            check_limit()
        return Response({'plots': {'type': 'FeatureCollection', 'features': plot_features},
                         'reports': {'type': 'FeatureCollection', 'features': report_features}})

class StatisticsView(APIView):
    def get(self, request):
        validate_query(request, StrictSerializer)
        from .models import LandPlot
        counts = Report.objects.aggregate(
            active_violations=Count('id', filter=Q(status__in=['VIOLATION', 'IN_PROGRESS'])),
            under_inspection=Count('id', filter=Q(status__in=['NEW', 'INSPECTION'])),
            resolved=Count('id', filter=Q(status='RESOLVED')),
            overdue=Count('id', filter=Q(deadline__lt=timezone.localdate()) & ~Q(status='RESOLVED')),
        )
        return Response({'total_plots': LandPlot.objects.count(), **counts})

class PhotoView(APIView):
    def get(self, request, photo_id):
        photo = get_object_or_404(ReportPhoto, pk=photo_id)
        content, mime = fetch_photo(photo.telegram_file_id)
        response = HttpResponse(content, content_type=mime)
        response['X-Content-Type-Options'] = 'nosniff'
        return response

class InstructionsView(APIView):
    permission_classes = [InspectorOrBot]
    throttle_classes = [BotThrottle]

    def get(self, request):
        validate_query(request, StrictSerializer)
        return Response(InstructionSerializer(Instruction.objects.all(), many=True).data)

class TrackingView(APIView):
    permission_classes = [IsBot]
    throttle_classes = [BotThrottle]

    def get(self, request, number):
        params = validate_query(request, TrackingQuerySerializer)
        tracking = get_object_or_404(TrackingRecord.objects.select_related('report', 'application'),
                                    number=number, owner_telegram_user_id=int(params['telegram_user_id']))
        if hasattr(tracking, 'report'):
            obj, kind = tracking.report, 'REPORT'
            history = []
            for event in obj.history.all():
                if event.before is None or event.before['status'] != event.after['status']:
                    status = event.after['status']
                    history.append({'status': status, 'label': ReportStatus(status).label, 'created_at': timestamp(event.created_at)})
        elif hasattr(tracking, 'application'):
            obj, kind = tracking.application, 'APPLICATION'
            history = [{'status': event.status, 'label': event.label, 'created_at': timestamp(event.created_at)} for event in obj.history.all()]
        else:
            raise ApiProblem('not_found', 'Объект не найден', 404)
        return Response({'kind': kind, 'tracking_number': number, 'status': obj.status, 'status_label': obj.get_status_display(),
                         'deadline': obj.deadline.isoformat() if obj.deadline else None, 'updated_at': timestamp(obj.updated_at), 'history': history})

class HealthView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        with connection.cursor() as cursor:
            cursor.execute('SELECT 1')
        return Response({'status': 'ok'})
