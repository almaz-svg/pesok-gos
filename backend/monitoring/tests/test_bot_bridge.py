import uuid
from copy import deepcopy
from unittest.mock import patch

from django.core.cache import cache
from django.db import IntegrityError
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from monitoring.models import IdempotencyRecord, Report, StatusHistory, TrackingRecord, User
from .test_api import TEST_SETTINGS, payload


def bot_result():
    return {
        'language': 'ru',
        'location_summary': '  Участок у дороги\nРядом с населённым пунктом.  ',
        'land_case_id': '1abc234def56',
        'case_passport': {
            'type': 'dumping', 'typeLabel': 'Стихийная свалка',
            'responsibleAuthority': 'Местный исполнительный орган', 'urgency': 'normal',
            'evidenceChecklist': ['Фото участка', 'Координаты'],
            'officialDraft': '<b>Черновик</b>\nПрошу проверить участок.',
            'followUpDraft': 'Прошу сообщить о результатах.',
            'inactivityComplaintDraft': 'Прошу проверить сроки рассмотрения.',
            'publicText': 'На участке обнаружены отходы.',
            'socialText': 'Помогите проверить обращение.',
            'nextAction': 'Приложите фотографии.', 'followUpDays': 15,
        },
    }


@override_settings(**TEST_SETTINGS)
class BotBridgeTests(TestCase):
    def setUp(self):
        cache.clear()
        self.bot = APIClient()
        self.bot.credentials(HTTP_AUTHORIZATION='Bearer test-bot-key')
        self.inspector = APIClient()
        self.inspector.force_authenticate(User.objects.create_user(username='bridge-inspector', is_inspector=True))

    def create(self, body=None, key=None):
        return self.bot.post('/api/reports', body or payload(), format='json',
                             HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()))

    def test_result_roundtrip_preserves_plain_text_and_inspector_workflow(self):
        result = bot_result()
        created = self.create({**payload(), 'bot_result': result})
        self.assertEqual(created.status_code, 201, created.content)
        report_id = created.json()['id']
        self.assertEqual(Report.objects.get(pk=report_id).bot_result, result)
        detail_url = f'/api/reports/{report_id}'
        detail = self.inspector.get(detail_url).json()
        self.assertEqual(detail['bot_result'], result)
        self.assertNotIn('telegram_user_id', detail)
        self.assertNotIn('telegram_file_id', detail['photos'][0])
        self.assertNotIn('bot_result', self.inspector.get('/api/reports').json()['results'][0])
        updated = self.inspector.patch(detail_url, {'version': 1, 'status': 'INSPECTION'}, format='json')
        self.assertEqual(updated.status_code, 200, updated.content)
        self.assertEqual(updated.json()['bot_result'], result)
        self.assertEqual(updated.json()['version'], 2)
        # Results are immutable through the inspector's existing status editor.
        self.assertEqual(self.inspector.patch(detail_url, {'version': 2, 'bot_result': {}}, format='json').status_code, 400)

    def test_old_posts_and_explicit_null_remain_supported(self):
        for body in [payload(), {**payload(), 'bot_result': None}]:
            created = self.create(body)
            self.assertEqual(created.status_code, 201, created.content)
            detail = self.inspector.get(f'/api/reports/{created.json()["id"]}').json()
            self.assertIsNone(detail['bot_result'])

    def test_partial_result_and_text_length_boundaries(self):
        result = {
            'location_summary': 'а' * 4000, 'land_case_id': 'ABCDEF123456',
            'case_passport': {
                'type': 'а' * 80, 'typeLabel': 'а' * 160, 'responsibleAuthority': 'а' * 500,
                'evidenceChecklist': ['а' * 500] * 20,
                'officialDraft': 'а' * 12000, 'followUpDraft': 'а' * 12000,
                'inactivityComplaintDraft': 'а' * 12000, 'publicText': 'а' * 8000,
                'socialText': 'а' * 4000, 'nextAction': 'а' * 1000, 'followUpDays': 365,
            },
        }
        for value in [{}, {'case_passport': {}}, result]:
            response = self.create({**payload(), 'bot_result': value})
            self.assertEqual(response.status_code, 201, response.content)
            self.assertEqual(Report.objects.get(pk=response.json()['id']).bot_result, value)

    def test_invalid_result_fields_types_and_limits_are_rejected(self):
        invalid = [
            [], 'plain result', {'unknown': 'x'}, {'language': 'de'}, {'location_summary': 123},
            {'location_summary': 'x' * 4001}, {'land_case_id': 'not-a-hex-id'},
            {'land_case_id': '12345678901'}, {'land_case_id': '1234567890123'},
            {'land_case_id': 123456789012}, {'land_case_id': '123456789012\n'},
            {'case_passport': None}, {'case_passport': []}, {'case_passport': {'extra': 'x'}},
            {'case_passport': {'urgency': 'urgent'}}, {'case_passport': {'evidenceChecklist': ['x'] * 21}},
            {'case_passport': {'evidenceChecklist': ['x' * 501]}},
            {'case_passport': {'evidenceChecklist': [42]}},
        ]
        for days in [0, 366, True, 1.5, '15']:
            invalid.append({'case_passport': {'followUpDays': days}})
        for name, limit in [('type', 80), ('typeLabel', 160), ('responsibleAuthority', 500),
                            ('officialDraft', 12000), ('followUpDraft', 12000),
                            ('inactivityComplaintDraft', 12000), ('publicText', 8000),
                            ('socialText', 4000), ('nextAction', 1000)]:
            invalid.append({'case_passport': {name: 'x' * (limit + 1)}})
            invalid.append({'case_passport': {name: 17}})
        for value in invalid:
            with self.subTest(result=str(value)[:100]):
                response = self.create({**payload(), 'bot_result': value})
                self.assertEqual(response.status_code, 400, response.content)
                self.assertTrue(any(name.startswith('bot_result') for name in response.json()['error']['fields']))
        self.assertEqual(Report.objects.count(), 0)
        self.assertEqual(TrackingRecord.objects.count(), 0)
        self.assertEqual(IdempotencyRecord.objects.count(), 0)

    def test_result_is_part_of_idempotency_and_not_overwritten(self):
        key = uuid.uuid4()
        body = {**payload(), 'bot_result': bot_result()}
        first, replay = self.create(body, key), self.create(body, key)
        self.assertEqual(first.status_code, 201)
        self.assertEqual(replay.status_code, 201)
        self.assertEqual(first.json(), replay.json())
        changed = deepcopy(body)
        changed['bot_result']['case_passport']['officialDraft'] = 'Другой текст'
        for conflict_body in [changed, payload()]:
            conflict = self.create(conflict_body, key)
            self.assertEqual(conflict.status_code, 409)
            self.assertEqual(conflict.json()['error']['code'], 'idempotency_conflict')
        self.assertEqual(Report.objects.count(), 1)
        self.assertEqual(StatusHistory.objects.count(), 1)
        self.assertEqual(Report.objects.get().bot_result, body['bot_result'])

    def test_creation_failure_rolls_back_result_and_idempotency_key(self):
        key = uuid.uuid4()
        body = {**payload(), 'bot_result': bot_result()}
        with patch('monitoring.services.ReportPhoto.objects.bulk_create', side_effect=IntegrityError('rollback')):
            failed = self.create(body, key)
        self.assertEqual(failed.status_code, 500)
        for model in [Report, TrackingRecord, IdempotencyRecord, StatusHistory]:
            self.assertEqual(model.objects.count(), 0)
        self.assertEqual(self.create(body, key).status_code, 201)
        self.assertEqual(Report.objects.get().bot_result, body['bot_result'])

    def test_bot_listing_filters_owner_and_paginates_canonical_fields(self):
        first = self.create({**payload(), 'bot_result': bot_result()}).json()
        second = self.create().json()
        other = self.create({**payload(), 'telegram_user_id': '999', 'description': 'Другой владелец обращения'}).json()
        response = self.bot.get('/api/bot/reports', {'telegram_user_id': '123456789', 'page_size': 1})
        self.assertEqual(response.status_code, 200, response.content)
        page = response.json()
        self.assertEqual(page['count'], 2)
        self.assertEqual(page['results'][0]['id'], second['id'])
        self.assertIsNone(page['previous'])
        self.assertIn('telegram_user_id=123456789', page['next'])
        next_page = self.bot.get(page['next']).json()
        report = next_page['results'][0]
        self.assertEqual(report['id'], first['id'])
        self.assertEqual(report['telegram_user_id'], '123456789')
        self.assertEqual(report['bot_result'], bot_result())
        self.assertEqual(report['photos'][0]['telegram_file_id'], 'photo-from-telegram')
        self.assertEqual(report['photos'][0]['url'], f'/api/photos/{report["photos"][0]["id"]}')
        self.assertEqual(report['location'], payload()['location'])
        self.assertEqual(report['tracking_number'], first['tracking_number'])
        self.assertIsNone(next_page['next'])
        self.assertNotIn(other['id'], str(page) + str(next_page))
        only_other = self.bot.get('/api/bot/reports', {'telegram_user_id': '999'}).json()
        self.assertEqual([item['id'] for item in only_other['results']], [other['id']])
        empty = self.bot.get('/api/bot/reports', {'telegram_user_id': '888'}).json()
        self.assertEqual(empty, {'count': 0, 'next': None, 'previous': None, 'results': []})

    def test_bot_listing_requires_bot_auth_and_does_not_expand_inspector_access(self):
        report_id = self.create().json()['id']
        url = '/api/bot/reports?telegram_user_id=123456789'
        self.assertEqual(APIClient().get(url).status_code, 401)
        self.assertEqual(self.inspector.get(url).status_code, 403)
        self.assertEqual(self.bot.get('/api/reports').status_code, 403)
        self.assertEqual(self.bot.get(f'/api/reports/{report_id}').status_code, 403)
        self.assertEqual(self.bot.post(url, {}, format='json').status_code, 405)

    def test_bot_listing_query_validation(self):
        for query in ['', '?telegram_user_id=0', '?telegram_user_id=-1',
                      '?telegram_user_id=9223372036854775808',
                      '?telegram_user_id=1&telegram_user_id=2',
                      '?telegram_user_id=1&page_size=101', '?telegram_user_id=1&page_size=0',
                      '?telegram_user_id=1&page=0', '?telegram_user_id=1&owner=2']:
            with self.subTest(query=query):
                self.assertEqual(self.bot.get('/api/bot/reports' + query).status_code, 400)
        self.assertEqual(self.bot.get('/api/bot/reports?telegram_user_id=1&page=2').status_code, 404)
