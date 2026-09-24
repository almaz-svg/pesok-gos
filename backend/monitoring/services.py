import hashlib
import json

from django.db import transaction
from django.db.models import Case, CharField, Count, Q, Value, When
from django.utils import timezone

from .errors import ApiProblem
from .models import IdempotencyRecord, LandPlot, Report, ReportPhoto, StatusHistory, TrackingRecord, TRANSITIONS

def timestamp(value):
    from datetime import timezone as utc
    return value.astimezone(utc.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

def snapshot(report):
    return {'status': report.status, 'deadline': report.deadline.isoformat() if report.deadline else None,
            'plot_id': str(report.plot_id) if report.plot_id else None}

def report_queryset():
    return Report.objects.select_related('tracking', 'plot').prefetch_related('photos').order_by('-created_at', '-id')

def plot_queryset():
    return LandPlot.objects.annotate(
        violations=Count('reports', filter=Q(reports__status__in=['VIOLATION', 'IN_PROGRESS'])),
        inspections=Count('reports', filter=Q(reports__status__in=['NEW', 'INSPECTION'])),
        active_reports_count=Count('reports', filter=~Q(reports__status='RESOLVED')),
    ).annotate(computed_status=Case(
        When(violations__gt=0, then=Value('VIOLATION')),
        When(inspections__gt=0, then=Value('INSPECTION')),
        default=Value('NORMAL'), output_field=CharField(),
    )).order_by('cadastral_number', 'id')

def filter_reports(queryset, params):
    for field in ['status', 'category', 'plot_id']:
        if field in params:
            queryset = queryset.filter(**{field: params[field]})
    if params.get('search'):
        queryset = queryset.filter(Q(tracking__number__icontains=params['search']) | Q(plot__cadastral_number__icontains=params['search']))
    if 'overdue' in params:
        overdue = Q(deadline__lt=timezone.localdate()) & ~Q(status='RESOLVED')
        queryset = queryset.filter(overdue if params['overdue'] else ~overdue)
    return queryset

def filter_plots(queryset, params):
    if 'status' in params:
        queryset = queryset.filter(computed_status=params['status'])
    if params.get('search'):
        queryset = queryset.filter(cadastral_number__icontains=params['search'])
    return queryset

@transaction.atomic
def create_report(data, key):
    digest = hashlib.sha256(json.dumps(data, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    # Concurrent get_or_create waits for the unique row; a failed creation rolls back the key too.
    record, created = IdempotencyRecord.objects.get_or_create(
        service='telegram-bot', key=key, defaults={'payload_hash': digest},
    )
    if not created:
        if record.payload_hash != digest:
            raise ApiProblem('idempotency_conflict', 'Этот ключ уже использован для другого обращения', 409)
        return record.response
    tracking = TrackingRecord.allocate(int(data['telegram_user_id']))
    report = Report.objects.create(tracking=tracking, category=data['category'], description=data['description'], **data['location'])
    ReportPhoto.objects.bulk_create([
        ReportPhoto(report=report, ordinal=index, telegram_file_id=photo['telegram_file_id'])
        for index, photo in enumerate(data['photos'])
    ])
    StatusHistory.objects.create(report=report, event='CREATED', before=None, after=snapshot(report), actor_type='BOT', actor_label='Telegram-бот')
    record.response = {'id': str(report.id), 'tracking_number': tracking.number, 'status': report.status, 'created_at': timestamp(report.created_at)}
    record.save(update_fields=['response'])
    return record.response

@transaction.atomic
def update_report(report_id, data, actor):
    from django.shortcuts import get_object_or_404
    report = get_object_or_404(Report.objects.select_for_update(), pk=report_id)
    if report.version != data['version']:
        raise ApiProblem('version_conflict', 'Обращение уже изменено. Обновите карточку.', 409)
    before = snapshot(report)
    status = data.get('status', report.status)
    if status != report.status and status not in TRANSITIONS[report.status]:
        raise ApiProblem('invalid_transition', 'Этот переход статуса запрещён', 409)
    if status == 'RESOLVED' and 'status' in data and not data.get('comment'):
        raise ApiProblem('validation_error', 'Для закрытия нужен комментарий', fields={'comment': ['Укажите причину закрытия']})
    report.status = status
    if 'deadline' in data:
        report.deadline = data['deadline']
    if 'plot_id' in data:
        report.plot = data['plot_id']
    after = snapshot(report)
    if before == after and not data.get('comment'):
        raise ApiProblem('no_changes', 'Нет изменений')
    report.version += 1
    report.save(update_fields=['status', 'deadline', 'plot', 'version', 'updated_at'])
    StatusHistory.objects.create(report=report, event='UPDATED', before=before, after=after,
                                comment=data.get('comment'), actor_user=actor, actor_type='INSPECTOR', actor_label=actor.username)
    return report_queryset().prefetch_related('history').get(pk=report.pk)
