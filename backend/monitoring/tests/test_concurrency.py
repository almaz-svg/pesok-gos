import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest import skipUnless

from django.db import close_old_connections, connection, connections
from django.test import TransactionTestCase, override_settings
from rest_framework.test import APIClient

from monitoring.models import Report, StatusHistory, User
from .test_api import TEST_SETTINGS, payload

@skipUnless(connection.vendor == 'postgresql', 'Row locking and concurrent idempotency require PostgreSQL')
@override_settings(**TEST_SETTINGS)
class ConcurrencyTests(TransactionTestCase):
    def parallel(self, callback):
        barrier = threading.Barrier(2)
        def worker():
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                return callback()
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(worker) for _ in range(2)]
            return [future.result(timeout=20) for future in futures]

    def test_parallel_duplicate_posts_create_one_report(self):
        key = str(uuid.uuid4())
        def send():
            client = APIClient()
            result = client.post('/api/reports', payload(), format='json',
                                 HTTP_AUTHORIZATION='Bearer test-bot-key', HTTP_IDEMPOTENCY_KEY=key)
            return result.status_code, result.json()
        results = self.parallel(send)
        self.assertEqual([item[0] for item in results], [201, 201], results)
        self.assertEqual(results[0][1], results[1][1])
        self.assertEqual(Report.objects.count(), 1)
        self.assertEqual(StatusHistory.objects.count(), 1)

    def test_parallel_patch_has_one_winner(self):
        user = User.objects.create_user(username='concurrent-inspector', is_inspector=True)
        client = APIClient()
        created = client.post('/api/reports', payload(), format='json',
                              HTTP_AUTHORIZATION='Bearer test-bot-key', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4())).json()
        def send():
            web = APIClient()
            web.force_authenticate(user=user)
            result = web.patch(f'/api/reports/{created["id"]}', {'version': 1, 'status': 'INSPECTION'}, format='json')
            return result.status_code, result.json()
        results = self.parallel(send)
        self.assertEqual(sorted(item[0] for item in results), [200, 409], results)
        self.assertEqual(Report.objects.get().version, 2)
        self.assertEqual(StatusHistory.objects.count(), 2)
