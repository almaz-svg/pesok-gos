import uuid
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from monitoring.models import (
    Application, ApplicationHistory, ApplicationStatus, Category, Instruction,
    LandPlot, Report, ReportPhoto, StatusHistory, TrackingRecord,
)
from monitoring.services import snapshot
from monitoring.photos import DEMO_PHOTO_FILE_ID

def demo_id(name):
    return uuid.uuid5(uuid.NAMESPACE_URL, f'https://pesok-gos.invalid/demo/{name}')

class Command(BaseCommand):
    help = 'Add 55 fictional plots, 20 reports and 10 applications. Existing/live objects are never reset.'

    def add_arguments(self, parser):
        parser.add_argument('--telegram-user-id', type=int, default=123456789)
        parser.add_argument('--telegram-file-id', help='Optional real photo file_id from this bot, used on newly created demo reports.')

    @transaction.atomic
    def handle(self, *args, **options):
        from django.core.management.base import CommandError
        owner = options['telegram_user_id']
        if not 0 < owner <= 9223372036854775807:
            raise CommandError('telegram-user-id must be a positive signed bigint.')
        if options['telegram_file_id'] and len(options['telegram_file_id']) > 1024:
            raise CommandError('telegram-file-id exceeds 1024 characters.')
        plots = []
        for index in range(55):
            lon, lat = 68.26 + (index % 11) * 0.007, 43.28 + (index // 11) * 0.007
            geometry = {'type': 'Polygon', 'coordinates': [[[lon, lat], [lon + .003, lat],
                [lon + .003, lat + .003], [lon, lat + .003], [lon, lat]]]}
            plot, _ = LandPlot.objects.get_or_create(id=demo_id(f'plot/{index}'), defaults={
                'cadastral_number': f'DEMO-19-001-{index + 1:03d}', 'area_ha': 8.1,
                'purpose': 'Демонстрационный земельный участок', 'address': 'Вымышленные границы, район Туркестана',
                'geometry': geometry,
            })
            plots.append(plot)
        for index in range(20):
            existing = Report.objects.filter(pk=demo_id(f'report/{index}')).first()
            if existing:
                ReportPhoto.objects.get_or_create(report=existing, ordinal=0,
                    defaults={'telegram_file_id': options['telegram_file_id'] or DEMO_PHOTO_FILE_ID})
                continue
            # Three-digit demo numbers cannot collide with six-digit sequence numbers.
            tracking = TrackingRecord.objects.create(id=demo_id(f'report-tracking/{index}'),
                number=f'KZ-2026-{index + 41:03d}', owner_telegram_user_id=owner)
            lon, lat = plots[index].geometry['coordinates'][0][0]
            report = Report.objects.create(id=demo_id(f'report/{index}'), tracking=tracking, plot=plots[index],
                category=Category.values[index % len(Category.values)],
                description='ДЕМО: обнаружена проблема на вымышленном участке. Данные предназначены для демонстрации.',
                latitude=lat + .001, longitude=lon + .001,
                deadline=timezone.localdate() + timedelta(days=-2 if index < 3 else 5))
            StatusHistory.objects.create(report=report, event='CREATED', before=None, after=snapshot(report),
                                        actor_type='SYSTEM', actor_label='Демонстрационные данные')
            target = 'VIOLATION' if index < 10 else 'INSPECTION' if index < 15 else 'RESOLVED'
            route = ['INSPECTION', 'VIOLATION'] if target == 'VIOLATION' else ['INSPECTION'] if target == 'INSPECTION' else ['INSPECTION', 'RESOLVED']
            for status in route:
                before = snapshot(report)
                report.status = status
                report.version += 1
                report.save()
                StatusHistory.objects.create(report=report, event='UPDATED', before=before, after=snapshot(report),
                    comment='Демонстрационное изменение статуса', actor_type='SYSTEM', actor_label='Демонстрационные данные')
            ReportPhoto.objects.create(report=report, ordinal=0,
                telegram_file_id=options['telegram_file_id'] or DEMO_PHOTO_FILE_ID)
        for index in range(10):
            if Application.objects.filter(pk=demo_id(f'application/{index}')).exists():
                continue
            tracking = TrackingRecord.objects.create(id=demo_id(f'application-tracking/{index}'),
                number=f'KZ-2026-{index + 101:03d}', owner_telegram_user_id=owner)
            app = Application.objects.create(id=demo_id(f'application/{index}'), tracking=tracking)
            route = ['RECEIVED', 'IN_REVIEW', 'INSPECTION_SCHEDULED'][:index % 3 + 1]
            for status in route:
                ApplicationHistory.objects.create(application=app, status=status, label=ApplicationStatus(status).label)
            app.status = route[-1]
            app.save()
        for index, (slug, title, body) in enumerate([
            ('report-violation', 'Как сообщить о нарушении', 'Отправьте геолокацию, фото и описание через кнопку «Сообщить о нарушении». Сохраните номер обращения.'),
            ('track-status', 'Как проверить статус', 'Нажмите «Проверить заявление» и отправьте номер. Проверять можно только свои обращения и заявления.'),
            ('photo', 'Как сделать фото', 'Снимите проблему с безопасного места. Не заходите на чужую территорию. Фото — JPEG, PNG или WebP до 10 MiB.'),
        ]):
            Instruction.objects.get_or_create(id=slug, defaults={'title': title, 'body': body, 'sort_order': index})
        self.stdout.write(self.style.SUCCESS('Demo seed ready: 55 plots, 20 reports, 10 applications. Existing records preserved.'))
        self.stdout.write('Tracking: KZ-2026-042; application: KZ-2026-102. Owner is set only on first creation.')
        if not options['telegram_file_id']:
            self.stdout.write('Labeled sample images added to demo reports. Live Telegram photos still require BOT_TOKEN and real file_id.')
