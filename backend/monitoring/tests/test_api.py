import io
import uuid
from datetime import datetime, timedelta, timezone as utc
from unittest.mock import MagicMock, patch

from django.core.cache import cache
from django.core.management import call_command
from django.db import IntegrityError
from django.test import TestCase, override_settings
from django.utils import timezone
from PIL import Image
from rest_framework.test import APIClient

from monitoring.models import Application, LandPlot, Report, ReportPhoto, StatusHistory, TrackingRecord, User

TEST_SETTINGS = dict(BOT_API_KEY='test-bot-key', BOT_TOKEN='test-secret-token', SECURE_SSL_REDIRECT=False,
                     SESSION_COOKIE_SECURE=False, CSRF_COOKIE_SECURE=False, ALLOWED_HOSTS=['testserver'])

def payload():
    return {'telegram_user_id': '123456789', 'location': {'latitude': 43.3, 'longitude': 68.3},
            'photos': [{'telegram_file_id': 'photo-from-telegram'}], 'description': 'Обнаружена стихийная свалка.', 'category': 'DUMPING'}

def make_plot(number='DEMO-001'):
    return LandPlot.objects.create(cadastral_number=number, area_ha=1, purpose='Demo', geometry={
        'type': 'Polygon', 'coordinates': [[[68.29, 43.29], [68.31, 43.29], [68.31, 43.31], [68.29, 43.29]]]})

@override_settings(**TEST_SETTINGS)
class ApiTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username='inspector', password='Good-Test-Pass-987!', is_inspector=True)
        self.web = APIClient(enforce_csrf_checks=True)
        csrf = self.web.get('/api/auth/csrf').json()['csrf_token']
        response = self.web.post('/api/auth/login', {'username': 'inspector', 'password': 'Good-Test-Pass-987!'}, format='json', HTTP_X_CSRFTOKEN=csrf)
        self.assertEqual(response.status_code, 200, response.content)
        self.web.credentials(HTTP_X_CSRFTOKEN=response.json()['csrf_token'])
        self.bot = APIClient()
        self.bot.credentials(HTTP_AUTHORIZATION='Bearer test-bot-key')

    def create(self, body=None, key=None):
        return self.bot.post('/api/reports', body or payload(), format='json', HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()))

    def edit(self, obj, **changes):
        return self.web.patch(f'/api/reports/{obj["id"]}', {'version': obj['version'], **changes}, format='json')

    def test_end_to_end_create_map_detail_patch_tracking(self):
        created = self.create()
        self.assertEqual(created.status_code, 201, created.content)
        body = created.json()
        self.assertEqual(Report.objects.count(), 1)
        self.assertEqual(StatusHistory.objects.count(), 1)
        map_data = self.web.get('/api/map').json()
        marker = map_data['reports']['features'][0]
        self.assertEqual(marker['geometry']['coordinates'], [68.3, 43.3])
        detail = self.web.get(f'/api/reports/{body["id"]}').json()
        self.assertEqual(detail['created_at'], body['created_at'])
        self.assertIsNone(detail['plot'])
        self.assertEqual(detail['photos'][0]['url'], f'/api/photos/{ReportPhoto.objects.get().id}')
        self.assertNotIn('telegram_file_id', str(detail))
        self.assertNotIn('telegram_user_id', str(detail))
        plot = make_plot()
        result = self.edit(detail, status='INSPECTION', plot_id=str(plot.pk), deadline='2026-09-30', comment='Проверяем')
        self.assertEqual(result.status_code, 200, result.content)
        updated = result.json()
        self.assertEqual(updated['version'], 2)
        self.assertEqual(len(updated['history']), 2)
        self.assertEqual(updated['history'][1]['before']['status'], 'NEW')
        self.assertEqual(self.web.get(f'/api/plots/{plot.id}').json()['status'], 'INSPECTION')
        tracking = self.bot.get(f'/api/tracking/{body["tracking_number"]}', {'telegram_user_id': '123456789'})
        self.assertEqual(tracking.status_code, 200)
        self.assertEqual(tracking.json()['status'], 'INSPECTION')
        self.assertNotIn('Проверяем', str(tracking.json()))
        stats = self.web.get('/api/statistics').json()
        self.assertEqual(stats['under_inspection'], 1)

    def test_idempotency_replay_conflict_and_validation_rollback(self):
        key = uuid.uuid4()
        first, second = self.create(key=key), self.create(key=key)
        self.assertEqual(first.json(), second.json())
        self.assertEqual(second.status_code, 201)
        conflict = self.create({**payload(), 'description': 'Другое описание нарушения'}, key)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()['error']['code'], 'idempotency_conflict')
        self.assertEqual(Report.objects.count(), 1)
        with patch('monitoring.services.ReportPhoto.objects.bulk_create', side_effect=IntegrityError('test rollback')):
            failed = self.create()
        self.assertEqual(failed.status_code, 500)
        self.assertEqual(TrackingRecord.objects.count(), 1)

    def test_status_validation_version_conflict_and_close(self):
        created = self.create().json()
        detail = self.web.get(f'/api/reports/{created["id"]}').json()
        self.assertEqual(self.edit(detail, plot_id='not-a-uuid').status_code, 400)
        self.assertEqual(self.edit(detail, plot_id=str(uuid.uuid4())).status_code, 400)
        self.assertEqual(self.edit(detail, status='RESOLVED', comment='Закрыто').status_code, 409)
        self.assertEqual(self.edit(detail, status='NEW').json()['error']['code'], 'no_changes')
        inspection = self.edit(detail, status='INSPECTION').json()
        self.assertEqual(self.edit(detail, deadline='2026-09-30').json()['error']['code'], 'version_conflict')
        self.assertEqual(self.edit(inspection, status='RESOLVED').status_code, 400)
        resolved = self.edit(inspection, status='RESOLVED', comment='Не подтвердилось')
        self.assertEqual(resolved.status_code, 200)
        self.assertFalse(resolved.json()['is_overdue'])
        self.assertEqual(len(resolved.json()['history']), 3)

    def test_multiple_reports_plot_status_and_reassignment(self):
        first = self.create().json()
        second = self.create().json()
        plot, other = make_plot(), make_plot('DEMO-002')
        for data in [first, second]:
            report = Report.objects.get(pk=data['id'])
            report.plot, report.status = plot, 'VIOLATION'
            report.save()
        first = self.web.get(f'/api/reports/{first["id"]}').json()
        moved = self.edit(first, plot_id=str(other.id))
        self.assertEqual(moved.status_code, 200)
        self.assertEqual(self.web.get(f'/api/plots/{plot.id}').json()['status'], 'VIOLATION')
        self.assertEqual(self.web.get(f'/api/plots/{other.id}').json()['status'], 'VIOLATION')
        detached = self.edit(moved.json(), plot_id=None)
        self.assertIsNone(detached.json()['plot'])
        self.assertEqual(self.web.get(f'/api/plots/{other.id}').json()['status'], 'NORMAL')

    def test_permissions_csrf_logout_and_owner_privacy(self):
        created = self.create().json()
        detail_url = f'/api/reports/{created["id"]}'
        photo_url = self.web.get(detail_url).json()['photos'][0]['url']
        for url in ['/api/reports', '/api/map', photo_url, '/api/auth/me']:
            self.assertEqual(APIClient().get(url).status_code, 401)
            self.assertEqual(self.bot.get(url).status_code, 403)
        self.assertEqual(self.bot.patch(detail_url, {'version': 1, 'status': 'INSPECTION'}, format='json').status_code, 403)
        self.assertEqual(self.web.post('/api/reports', payload(), format='json').status_code, 403)
        self.assertEqual(self.bot.get(f'/api/tracking/{created["tracking_number"]}', {'telegram_user_id': '999'}).status_code, 404)
        self.web.credentials()
        denied = self.web.patch(detail_url, {'version': 1, 'status': 'INSPECTION'}, format='json')
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(denied.json()['error']['code'], 'csrf_failed')
        csrf = self.web.get('/api/auth/csrf').json()['csrf_token']
        self.assertEqual(self.web.post('/api/auth/logout', {}, format='json', HTTP_X_CSRFTOKEN=csrf).status_code, 204)
        self.assertEqual(self.web.get('/api/auth/me').status_code, 401)
        login = APIClient(enforce_csrf_checks=True).post('/api/auth/login', {'username': 'inspector', 'password': 'x'}, format='json')
        self.assertEqual(login.status_code, 403)

    def test_input_validation_and_error_shape(self):
        invalid = [
            {**payload(), 'photos': []}, {**payload(), 'location': None},
            {**payload(), 'location': {'latitude': 91, 'longitude': 0}},
            {**payload(), 'location': {'latitude': True, 'longitude': 0}},
            {**payload(), 'status': 'RESOLVED'}, {**payload(), 'description': 'short'},
            {**payload(), 'telegram_user_id': 123}, {**payload(), 'category': 'UNKNOWN'},
            {**payload(), 'photos': [{'telegram_file_id': 'x'}, {'telegram_file_id': 'x'}]},
            {**payload(), 'photos': [{'telegram_file_id': 'demo-photo:seed-v1'}]},
        ]
        for body in invalid:
            with self.subTest(body=body):
                result = self.create(body)
                self.assertEqual(result.status_code, 400, result.content)
                self.assertEqual(set(result.json()['error']), {'code', 'message', 'fields', 'request_id'})
        self.assertEqual(Report.objects.count(), 0)
        self.assertEqual(self.bot.post('/api/reports', payload(), format='json').status_code, 400)

    def test_filters_empty_pagination_bbox_and_limit(self):
        missing = self.web.get('/api/reports/not-a-uuid')
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.json()['error']['code'], 'not_found')
        self.assertEqual(self.web.get('/api/reports').json()['results'], [])
        self.assertEqual(self.web.get('/api/map').json()['reports']['features'], [])
        self.create()
        make_plot()
        for query in ['?status=INVALID', '?overdue=1', '?page=0', '?page_size=101', '?unknown=x', '?status=NEW&status=NEW']:
            self.assertEqual(self.web.get('/api/reports' + query).status_code, 400, query)
        self.assertEqual(self.web.get('/api/reports?page=2').status_code, 404)
        self.assertEqual(self.web.get('/api/reports?status=VIOLATION').json()['count'], 0)
        self.assertEqual(self.web.get('/api/reports?status=NEW&search=KZ').json()['count'], 1)
        self.assertEqual(self.web.get('/api/map?bbox=0,0,1,1').json()['reports']['features'], [])
        self.assertEqual(self.web.get('/api/map?bbox=68.2,43.2,68.4,43.4').status_code, 200)
        for bbox in ['1,0,0,1', 'NaN,0,1,1', '1,2,3', '0,0,400,90']:
            self.assertEqual(self.web.get('/api/map', {'bbox': bbox}).status_code, 400)
        with override_settings(MAP_MAX_FEATURES=1):
            self.assertEqual(self.web.get('/api/map').status_code, 422)

    def test_overdue_local_midnight(self):
        created = self.create().json()
        report = Report.objects.get(pk=created['id'])
        report.deadline = datetime(2026, 9, 25).date()
        report.save()
        for now, expected in [(datetime(2026, 9, 25, 18, 59, tzinfo=utc.utc), False),
                              (datetime(2026, 9, 25, 19, 1, tzinfo=utc.utc), True)]:
            with patch('django.utils.timezone.now', return_value=now):
                self.assertEqual(self.web.get(f'/api/reports/{report.id}').json()['is_overdue'], expected)
                self.assertEqual(self.web.get('/api/statistics').json()['overdue'], int(expected))
                self.assertEqual(self.web.get('/api/reports?overdue=true').json()['count'], int(expected))

    def test_photo_proxy_bytes_no_redirect_and_failure_redaction(self):
        self.create()
        photo = ReportPhoto.objects.get()
        buffer = io.BytesIO()
        Image.new('RGB', (2, 2), color='green').save(buffer, format='PNG')
        metadata, download = MagicMock(), MagicMock()
        metadata.__enter__.return_value = metadata
        download.__enter__.return_value = download
        metadata.status_code = download.status_code = 200
        metadata.json.return_value = {'ok': True, 'result': {'file_path': 'photos/file_1.png'}}
        download.iter_content.return_value = [buffer.getvalue()]
        with patch('monitoring.photos.requests.get', side_effect=[metadata, download]) as network:
            response = self.web.get(f'/api/photos/{photo.id}')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Type'], 'image/png')
        self.assertEqual(response.content, buffer.getvalue())
        self.assertEqual(response['Cache-Control'], 'private, no-store')
        self.assertFalse(network.call_args.kwargs['allow_redirects'])
        import requests
        with patch('monitoring.photos.requests.get', side_effect=requests.Timeout('test-secret-token')):
            failed = self.web.get(f'/api/photos/{photo.id}')
        self.assertEqual(failed.status_code, 502)
        self.assertNotIn('test-secret-token', failed.content.decode())
        with patch('monitoring.photos.requests.get', return_value=metadata):
            metadata.json.return_value = {'ok': True, 'result': {'file_path': '../secret'}}
            self.assertEqual(self.web.get(f'/api/photos/{photo.id}').status_code, 502)

    def test_seed_idempotence_preserves_live_and_edits(self):
        live = self.create().json()
        call_command('seed_demo', stdout=io.StringIO())
        self.assertEqual(LandPlot.objects.count(), 55)
        self.assertEqual(Report.objects.count(), 21)
        self.assertEqual(Application.objects.count(), 10)
        demo = Report.objects.get(tracking__number='KZ-2026-042')
        sample_photo = ReportPhoto.objects.get(report=demo)
        sample_response = self.web.get(f'/api/photos/{sample_photo.id}')
        self.assertEqual(sample_response.status_code, 200)
        self.assertEqual(sample_response['Content-Type'], 'image/png')
        self.assertTrue(sample_response.content.startswith(b'\x89PNG'))
        demo.description = 'Edited by inspector'
        demo.save()
        call_command('seed_demo', stdout=io.StringIO())
        demo.refresh_from_db()
        self.assertEqual(demo.description, 'Edited by inspector')
        self.assertTrue(Report.objects.filter(pk=live['id']).exists())
        self.assertEqual(Report.objects.count(), 21)
        self.assertEqual(ReportPhoto.objects.filter(report=demo).count(), 1)
        result = self.bot.get('/api/tracking/KZ-2026-102?telegram_user_id=123456789')
        self.assertEqual(result.json()['kind'], 'APPLICATION')
        self.assertEqual(len(self.bot.get('/api/instructions').json()), 3)
