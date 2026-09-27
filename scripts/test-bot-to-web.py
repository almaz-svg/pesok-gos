"""Run the real bot adapter -> isolated Django -> React workflow.

Requires Python backend dependencies, Playwright with Edge and npm ci in bot/frontend.
No real Telegram, OpenAI or satellite
requests are made. A temporary SQLite database and temporary secrets are discarded.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
from urllib.parse import urlparse
import uuid

REPO = Path(__file__).resolve().parents[1]
WEB = 'http://localhost:5177'
API = 'http://localhost:18000/api'
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
NODE_RUNNER = r'''
import fs from 'node:fs';
import assert from 'node:assert/strict';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  assert.equal(new URL(url).origin, new URL(process.env.API_BASE_URL).origin);
  return originalFetch(url, options);
};
const { createReport, listReports, getApplication } = await import('./bot/src/api.js');
if (input.action === 'create') {
  const { analyzeViolationCase } = await import('./bot/src/case-analysis.js');
  const { analyzeLocation, formatLocationAnalysis } = await import('./bot/src/location.js');
  const report = input.report;
  report.casePassport = analyzeViolationCase({ ...report, hasPhoto: true });
  report.locationAnalysis = analyzeLocation({ lat: report.lat, lon: report.lon, accuracyMeters: 12 });
  const created = await createReport(report);
  console.log(JSON.stringify({ created, expected: {
    language: report.language, case_passport: report.casePassport,
    location_summary: formatLocationAnalysis(report.locationAnalysis, report.language).replaceAll('\\n', '\n'),
    land_case_id: report.landCaseId,
  }}));
} else {
  const list = await listReports(input.owner);
  const other = await listReports(input.otherOwner);
  const tracking = await getApplication(input.tracking, input.owner);
  let denied = false;
  try { await getApplication(input.tracking, input.otherOwner); } catch { denied = true; }
  console.log(JSON.stringify({ list, other, tracking, denied }));
}
'''


def bot_adapter(node, payload):
    process = subprocess.run(
        [node, '--input-type=module', '-e', NODE_RUNNER], cwd=REPO,
        input=json.dumps(payload), text=True, encoding='utf-8',
        capture_output=True, timeout=30, creationflags=NO_WINDOW,
    )
    if process.returncode:
        raise AssertionError('Bot adapter failed: ' + process.stderr[-3000:])
    return json.loads(process.stdout)


def worker(args):
    from playwright.sync_api import expect, sync_playwright
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    results, errors, blocked = [], [], set()

    def passed(name, **data):
        result = {'name': name, 'status': 'passed', **data}
        results.append(result)
        print(json.dumps(result, ensure_ascii=True), flush=True)

    owner, other_owner = '123456789', '987654321'
    description = 'Проверка: мусор и отходы. <img src=x onerror="window.botXss=true">'
    report_input = {
        'telegramUserId': owner, 'idempotencyKey': str(uuid.uuid4()),
        'lat': 43.3, 'lon': 68.3, 'telegramFileId': 'isolated-test-photo',
        'description': description, 'language': 'ru', 'landCaseId': 'aabbcc001122',
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel=args.browser_channel)
        context = browser.new_context(viewport={'width': 1280, 'height': 900}, reduced_motion='reduce')

        def route_request(route):
            url = urlparse(route.request.url)
            if url.hostname not in ('localhost', '127.0.0.1'):
                blocked.add(url.hostname or '')
                route.abort()
            elif url.path.startswith('/api/photos/'):
                route.fulfill(status=200, content_type='image/svg+xml', body='<svg xmlns="http://www.w3.org/2000/svg" width="100" height="70"><rect width="100" height="70" fill="#d6edb1"/></svg>')
            elif url.path == '/api/assistant/chat':
                route.fulfill(status=200, json={'available': False, 'csrf_token': 'isolated-status-only'})
            else:
                route.continue_()

        context.route('**/*', route_request)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        navigation = []
        page.on('framenavigated', lambda frame: navigation.append(frame.url) if frame == page.main_frame else None)
        try:
            page.goto(WEB + '/reports', wait_until='networkidle')
            (out / 'recon-gate.txt').write_text(page.locator('main').aria_snapshot(), encoding='utf-8')
            expect(page.locator('.login-gate')).to_be_visible()
            page.locator('.login-gate a').click()
            page.wait_for_load_state('networkidle')
            (out / 'recon-login.txt').write_text(page.locator('main').aria_snapshot(), encoding='utf-8')
            page.locator('#login-username').fill('smoke_inspector')
            page.locator('#login-password').fill(os.environ['INSPECTOR_PASSWORD'])
            page.locator('.login-form button[type="submit"]').click()
            expect(page).to_have_url(WEB + '/reports')
            expect(page.get_by_text('Сигналов пока нет', exact=True)).to_be_visible()
            passed('real-inspector-session-login')
            (out / 'recon-reports.txt').write_text(page.locator('main').aria_snapshot(), encoding='utf-8')

            before_navs = len(navigation)
            started = time.monotonic()
            created = bot_adapter(args.node, {'action': 'create', 'report': report_input})
            report, expected = created['created'], created['expected']
            row = page.locator('.table-report').filter(has_text=report['id'])
            expect(row).to_be_visible(timeout=12000)
            assert len(navigation) == before_navs, 'Polling required navigation/reload'
            passed('real-bot-adapter-report-appears-without-reload', elapsed_seconds=round(time.monotonic()-started, 2))
            replay = bot_adapter(args.node, {'action': 'create', 'report': report_input})
            assert replay['created'] == report
            assert context.request.get(API + '/reports').json()['count'] == 1
            passed('idempotency-replay-does-not-duplicate-report')
            detail = context.request.get(API + '/reports/' + report['backendId']).json()
            assert detail['bot_result'] == expected
            assert detail['category'] == 'DUMPING'
            passed('analysis-and-location-roundtrip-through-real-api')
            cabinet = bot_adapter(args.node, {'action': 'cabinet', 'owner': owner, 'otherOwner': other_owner, 'tracking': report['id']})
            assert len(cabinet['list']) == 1
            assert cabinet['list'][0]['casePassport'] == expected['case_passport']
            assert cabinet['list'][0]['locationSummary'] == expected['location_summary']
            assert cabinet['list'][0]['landCaseId'] == 'aabbcc001122'
            assert cabinet['other'] == [] and cabinet['denied']
            assert cabinet['tracking']['trackingNumber'] == report['id']
            passed('bot-cabinet-tracking-roundtrip-and-owner-isolation')

            row.click()
            expect(page.locator('.bot-result')).to_be_visible()
            (out / 'recon-bot-result.txt').write_text(page.locator('.inspector-drawer').aria_snapshot(), encoding='utf-8')
            page.keyboard.press('Escape')
            labels = {'ru': 'Ответ Telegram-бота', 'kk': 'Telegram-боттың жауабы', 'en': 'Telegram bot response'}
            for width, language in [(320, 'ru'), (390, 'kk'), (1280, 'en')]:
                page.set_viewport_size({'width': width, 'height': 900 if width == 1280 else 844})
                page.locator('.language-trigger').click()
                page.locator(f'.language-menu [lang="{language}"]').click()
                for theme in ['light', 'dark']:
                    if page.locator('html').get_attribute('data-theme') != theme:
                        page.locator('.theme-toggle').click()
                    row.click()
                    panel = page.locator('.bot-result')
                    expect(panel.locator('h3')).to_have_text(labels[language])
                    expect(panel.locator('.bot-result__facts')).to_contain_text(expected['case_passport']['typeLabel'])
                    expect(panel.locator('.bot-result__facts')).to_contain_text(expected['location_summary'])
                    assert panel.locator('.bot-result__draft').count() == 5
                    textarea = page.locator('.inspector-drawer__form textarea')
                    textarea.fill('Несохранённый комментарий инспектора')
                    disclosure = panel.locator('[data-draft="officialDraft"]')
                    disclosure.locator('summary').focus()
                    page.keyboard.press('Enter')
                    expect(disclosure).to_have_attribute('open', '')
                    expect(disclosure.locator('p')).to_have_text(expected['case_passport']['officialDraft'])
                    expect(disclosure.locator('p')).to_have_attribute('lang', 'ru')
                    assert disclosure.locator('img,script').count() == 0
                    assert page.evaluate('window.botXss === undefined')
                    expect(textarea).to_have_value('Несохранённый комментарий инспектора')
                    assert page.evaluate('document.documentElement.scrollWidth') <= width
                    assert page.locator('.inspector-drawer__body').evaluate('(el) => el.scrollWidth <= el.clientWidth')
                    color = panel.evaluate('(el) => getComputedStyle(el).backgroundColor')
                    assert color == ('rgb(237, 242, 231)' if theme == 'light' else 'rgb(21, 33, 23)'), color
                    # Viewport screenshots preserve the fixed drawer and its scroll area;
                    # an element screenshot taller than that area captures clipped content.
                    page.screenshot(path=str(out / f'bot-draft-{width}-{theme}.png'))
                    disclosure.locator('summary').click()
                    panel.evaluate('(el) => { const body = el.closest(".inspector-drawer__body"); body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - 12; }')
                    page.screenshot(path=str(out / f'bot-result-{width}-{theme}.png'))
                    passed(f'bot-result-{width}-{theme}-{language}-plain-text-and-draft-preserved')
                    if width == 320 and theme == 'light':
                        page.wait_for_timeout(5500)
                        expect(textarea).to_have_value('Несохранённый комментарий инспектора')
                        passed('inspector-draft-survives-parent-poll')
                    page.keyboard.press('Escape')

            # The new block remains absent for legacy reports that have no bot_result.
            def old_detail(route):
                legacy = {key: value for key, value in detail.items() if key != 'bot_result'}
                route.fulfill(json=legacy)
            legacy_url = API + '/reports/' + report['backendId']
            context.route(legacy_url, old_detail)
            row.click()
            expect(page.locator('.inspector-drawer__description')).to_have_text(description)
            expect(page.locator('.bot-result')).to_have_count(0)
            page.keyboard.press('Escape')
            context.unroute(legacy_url, old_detail)
            passed('legacy-report-without-bot-result-hides-block')

            def location_only(route):
                partial = {**detail, 'bot_result': {'language': 'kk', 'location_summary': 'Геолокацияны тексеру: Түркістан облысы'}}
                route.fulfill(json=partial)
            context.route(legacy_url, location_only)
            row.click()
            expect(page.locator('.bot-result')).to_be_visible()
            expect(page.locator('.bot-result__facts dd')).to_have_text('Геолокацияны тексеру: Түркістан облысы')
            expect(page.locator('.bot-result__facts dd')).to_have_attribute('lang', 'kk')
            expect(page.locator('.bot-result__draft')).to_have_count(0)
            page.keyboard.press('Escape')
            context.unroute(legacy_url, location_only)
            passed('location-only-bot-result-remains-visible-in-original-language')

            page.goto(WEB + '/map', wait_until='networkidle')
            expect(page.locator(f'[data-map-feature="report:{report["backendId"]}"]')).to_be_visible(timeout=12000)
            (out / 'recon-map.txt').write_text(page.locator('main').aria_snapshot(), encoding='utf-8')
            before_navs = len(navigation)
            second_input = {**report_input, 'idempotencyKey': str(uuid.uuid4()), 'lat': 43.3002, 'lon': 68.3002, 'description': 'Новый сигнал: мусор на открытой карте.'}
            started = time.monotonic()
            second = bot_adapter(args.node, {'action': 'create', 'report': second_input})['created']
            expect(page.locator(f'[data-map-feature="report:{second["backendId"]}"]')).to_be_visible(timeout=12000)
            assert len(navigation) == before_navs
            passed('real-bot-report-appears-on-open-map', elapsed_seconds=round(time.monotonic()-started, 2))
            assert not errors, errors
            passed('no-browser-javascript-errors')
        except Exception:
            results.append({'name': 'workflow', 'status': 'failed', 'error': traceback.format_exc(limit=4)})
            page.screenshot(path=str(out / 'failure.png'), full_page=True)
            (out / 'failure-dom.txt').write_text(page.locator('body').aria_snapshot(), encoding='utf-8')
            print(results[-1]['error'], flush=True)
        finally:
            browser.close()
    result = {'results': results, 'page_errors': errors, 'external_hosts_blocked': sorted(blocked),
              'real_telegram_used': False, 'real_openai_used': False, 'real_satellite_used': False,
              'database': 'temporary SQLite; removed after run', 'photo': 'browser-only placeholder'}
    (out / 'result.json').write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'passed': sum(x['status'] == 'passed' for x in results), 'failed': sum(x['status'] == 'failed' for x in results)}))
    return int(any(x['status'] == 'failed' for x in results))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--out', default=str(REPO / 'test-results' / 'bot-to-web'))
    parser.add_argument('--node', default=shutil.which('node') or 'node')
    parser.add_argument('--browser-channel', default='msedge')
    args = parser.parse_args()
    if args.worker:
        return worker(args)
    for port in (18000, 5177):
        with socket.socket() as sock:
            assert sock.connect_ex(('localhost', port)) != 0, f'Port {port} occupied; no process changed.'
    with tempfile.TemporaryDirectory(prefix='pesok-bot-to-web-') as temporary:
        db = Path(temporary) / 'smoke.sqlite3'
        env = os.environ.copy()
        env.update({'PYTHON_DOTENV_DISABLED': '1', 'PYTHONIOENCODING': 'utf-8',
                    'DOTENV_CONFIG_PATH': str(Path(temporary) / 'unused.env'),
                    'DEBUG': 'true', 'DJANGO_SECRET_KEY': secrets.token_urlsafe(40),
                    'DATABASE_URL': 'sqlite:///' + db.as_posix(), 'ALLOWED_HOSTS': 'localhost,127.0.0.1',
                    'CSRF_TRUSTED_ORIGINS': WEB, 'CORS_ALLOWED_ORIGINS': WEB,
                    'SECURE_SSL_REDIRECT': 'false', 'TRUST_PROXY': 'false',
                    'BOT_API_KEY': secrets.token_urlsafe(40), 'BOT_TOKEN': '', 'OPENAI_API_KEY': '',
                    'INSPECTOR_PASSWORD': secrets.token_urlsafe(30),
                    'VITE_DATA_MODE': 'api', 'VITE_API_BASE_URL': API,
                    'DATA_MODE': 'api', 'API_BASE_URL': API})
        out = Path(args.out).resolve()
        out.mkdir(parents=True, exist_ok=True)
        common = {'cwd': REPO, 'env': env, 'creationflags': NO_WINDOW}
        for command in [
            [sys.executable, 'backend/manage.py', 'migrate', '--noinput'],
            [sys.executable, 'backend/manage.py', 'create_inspector', '--username', 'smoke_inspector'],
        ]:
            setup = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', **common)
            if setup.returncode:
                raise RuntimeError(setup.stdout + setup.stderr)
        # The bundled helper terminates the shell but leaves server children running
        # on Windows, locking SQLite. Keep handles for our own processes and stop
        # their exact process trees before TemporaryDirectory removes the database.
        servers, logs = [], []
        try:
            for name, command, port in [
                ('backend', [sys.executable, '-u', 'backend/manage.py', 'runserver', 'localhost:18000', '--noreload'], 18000),
                ('frontend', [args.node, 'frontend/node_modules/vite/bin/vite.js', '--host', 'localhost', '--port', '5177', '--strictPort', '--config', 'frontend/vite.config.js', 'frontend'], 5177),
            ]:
                log = (out / (name + '.log')).open('w', encoding='utf-8')
                logs.append(log)
                process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, **common)
                servers.append(process)
                deadline = time.monotonic() + 45
                while True:
                    if process.poll() is not None:
                        raise RuntimeError(name + ' stopped; see ' + str(out / (name + '.log')))
                    try:
                        with socket.create_connection(('localhost', port), timeout=1):
                            break
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise RuntimeError(name + ' did not become ready')
                        time.sleep(0.2)
            command = [sys.executable, str(Path(__file__).resolve()), '--worker', '--out', str(out),
                       '--node', args.node, '--browser-channel', args.browser_channel]
            completed = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', **common)
            print(completed.stdout, flush=True)
            if completed.stderr:
                print(completed.stderr, file=sys.stderr, flush=True)
            return completed.returncode
        finally:
            for process in reversed(servers):
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True, creationflags=NO_WINDOW)
                elif process.poll() is None:
                    process.terminate()
                process.wait(timeout=10)
            for log in logs:
                log.close()


if __name__ == '__main__':
    raise SystemExit(main())
