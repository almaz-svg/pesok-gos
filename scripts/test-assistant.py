"""Browser checks for the assistant and footer. Replies are explicitly mocked.

Run against Vite: python scripts/test-assistant.py --channel msedge
No OpenAI key or paid request is used. --real-status checks Django without mocking.
"""
import argparse
import json
import traceback
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright

ROUTES = ['/', '/map', '/reports', '/reports?view=analytics', '/register', '/missing']
SIZES = [(320, 568), (390, 844), (844, 390), (1280, 800)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='http://localhost:5173')
    parser.add_argument('--channel', default=None)
    parser.add_argument('--out', default='test-results/assistant')
    parser.add_argument('--real-status', action='store_true', help='Check Django status without sending a question')
    parser.add_argument('--workflows-only', action='store_true')
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    checks = []

    def bounds(locator, width, height=None):
        rect = locator.bounding_box()
        assert rect and rect['x'] >= -1 and rect['x'] + rect['width'] <= width + 1, rect
        if height:
            assert rect['y'] >= -1 and rect['y'] + rect['height'] <= height + 1, rect

    def settle(dialog):
        dialog.evaluate('el => Promise.all(el.getAnimations().map(animation => animation.finished))')

    def run(name, page, callback):
        try:
            detail = callback()
            checks.append({'name': name, 'status': 'passed', 'detail': detail})
        except Exception as error:
            checks.append({'name': name, 'status': 'failed', 'error': traceback.format_exc(limit=2)})
            page.screenshot(path=str(out / f'failure-{name}.png'))
        print(json.dumps(checks[-1], ensure_ascii=True), flush=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel=args.channel)
        version = browser.version
        for width, height in SIZES:
            with browser.new_context(viewport={'width': width, 'height': height},
                                     has_touch=True, is_mobile=width <= 850, locale='ru-RU') as context:
                state = {'mode': 'success', 'available': True, 'posts': [], 'pending': []}

                def mocked(route):
                    if route.request.method == 'GET':
                        route.fulfill(json={'available': state['available'], 'csrf_token': 'test-csrf-token'})
                        return
                    state['posts'].append(route.request.post_data_json)
                    if state['mode'] == 'hold':
                        state['pending'].append(route)
                    elif state['mode'] == 'error':
                        route.fulfill(status=503, json={'error': {'message': 'private-provider-debug'}})
                    else:
                        route.fulfill(json={'reply': 'Тестовый ответ: откройте карту земель. <script>alert(1)</script>', 'truncated': False})

                context.route('**/api/assistant/chat', mocked)
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                launcher = page.get_by_role('button', name='Открыть ИИ-помощника')
                dialog = page.get_by_role('dialog', name='Помощник Песок')

                for index, route in enumerate([] if args.workflows_only else ROUTES):
                    def layout():
                        page.goto(args.base + route, wait_until='networkidle')
                        expect(launcher).to_be_visible()
                        bounds(launcher, width, height)
                        launcher.tap()
                        expect(dialog).to_be_visible()
                        settle(dialog)
                        bounds(dialog, width, height)
                        bounds(page.locator('.assistant-composer'), width, height)
                        assert page.locator('.assistant-log').evaluate('el => el.scrollTop') == 0
                        expect(page.get_by_label('Ваш вопрос помощнику')).to_have_css('font-size', '16px')
                        for button in dialog.locator('button').all():
                            box = button.bounding_box()
                            assert box['height'] >= 43.9 and box['width'] >= 43.9, box
                        if index == 0:
                            page.screenshot(path=str(out / f'chat-{width}.png'))
                        page.get_by_role('button', name='Закрыть ИИ-помощника').tap()
                        expect(launcher).to_be_focused()
                        assert page.evaluate('document.documentElement.scrollWidth') <= width
                        footer = page.locator('footer')
                        footer.scroll_into_view_if_needed()
                        bounds(footer, width)
                        for link in footer.get_by_role('link').all():
                            assert link.bounding_box()['height'] >= 43.9
                        # At the page bottom, the floating launcher must not cover the signoff.
                        page.evaluate("window.scrollTo({top:document.body.scrollHeight,behavior:'instant'})")
                        a, b = launcher.bounding_box(), page.locator('.footer-signoff').bounding_box()
                        intersects = a['x'] < b['x'] + b['width'] and a['x'] + a['width'] > b['x'] and a['y'] < b['y'] + b['height'] and a['y'] + a['height'] > b['y']
                        assert not intersects, {'launcher': a, 'signoff': b}
                        if index == 0:
                            footer.screenshot(path=str(out / f'footer-{width}.png'))
                        assert not errors, errors
                        return {'route': route, 'width': width, 'height': height}
                    run(f'layout-{width}-{index}', page, layout)

                def workflow():
                    page.goto(args.base + '/register', wait_until='networkidle')
                    launcher.tap()
                    field = page.get_by_label('Ваш вопрос помощнику')
                    field.fill('Как найти участок?')
                    page.get_by_role('button', name='Отправить сообщение').tap()
                    expect(page.locator('.assistant-message-reply')).to_have_count(1)
                    expect(page.locator('.assistant-message-reply p')).to_contain_text('<script>alert(1)</script>')
                    assert page.locator('.assistant-message-reply script').count() == 0
                    assert state['posts'][-1]['page'] == '/register'
                    dialog.get_by_role('link', name='Карта земель', exact=True).tap()
                    expect(page).to_have_url(args.base + '/map')
                    launcher.tap()
                    expect(page.locator('.assistant-message-reply')).to_have_count(1)
                    field.fill('Какие статусы есть?')
                    page.get_by_role('button', name='Отправить сообщение').tap()
                    expect(page.locator('.assistant-message-reply')).to_have_count(2)
                    assert len(state['posts'][-1]['messages']) == 3
                    assert state['posts'][-1]['page'] == '/map'
                    page.screenshot(path=str(out / f'mocked-conversation-{width}.png'))
                    state['mode'] = 'error'
                    field.fill('Вопрос с ошибкой соединения')
                    page.get_by_role('button', name='Отправить сообщение').tap()
                    expect(page.locator('.assistant-error')).to_contain_text('временно недоступен')
                    expect(dialog).not_to_contain_text('private-provider-debug')
                    state['mode'] = 'success'
                    page.get_by_role('button', name='Повторить отправку').tap()
                    expect(page.locator('.assistant-message-reply')).to_have_count(3)
                    expect(page.locator('.assistant-message-user')).to_have_count(3)
                    state['mode'] = 'hold'
                    field.fill('Долгий запрос')
                    page.get_by_role('button', name='Отправить сообщение').tap()
                    expect(page.locator('.assistant-thinking')).to_be_visible()
                    page.get_by_role('button', name='Остановить ответ').tap()
                    expect(page.locator('.assistant-error')).to_contain_text('остановлено')
                    page.get_by_role('button', name='Начать новый диалог').tap()
                    expect(page.locator('.assistant-turn')).to_have_count(0)
                    state['mode'] = 'success'
                    # Focus remains inside the native modal while navigating with Tab.
                    for _ in range(12):
                        page.keyboard.press('Tab')
                        assert page.evaluate("document.querySelector('#site-assistant').contains(document.activeElement)"), page.evaluate('document.activeElement.outerHTML.slice(0, 200)')
                    if width == 390:
                        page.set_viewport_size({'width': 390, 'height': 360})
                        expect(dialog).to_be_visible()
                        page.wait_for_function("document.querySelector('#site-assistant').getBoundingClientRect().bottom <= 360")
                        bounds(page.locator('.assistant-composer'), 390, 360)
                        page.screenshot(path=str(out / 'chat-short-viewport.png'))
                        page.set_viewport_size({'width': width, 'height': height})
                    page.keyboard.press('Escape')
                    expect(dialog).not_to_be_visible()
                    expect(launcher).to_be_focused()
                    state['available'] = False
                    launcher.tap()
                    expect(page.locator('.assistant-connection')).to_contain_text('пока недоступен')
                    post_count = len(state['posts'])
                    field.fill('Без ключа')
                    page.get_by_role('button', name='Отправить сообщение').tap()
                    expect(page.locator('.assistant-error')).to_contain_text('пока недоступен')
                    assert len(state['posts']) == post_count
                    page.get_by_role('button', name='Закрыть ИИ-помощника').tap()
                    # Footer links navigate to real pages, including query-based analytics.
                    footer_nav = page.get_by_role('navigation', name='Навигация в подвале')
                    footer_nav.get_by_role('link', name='Аналитика', exact=True).tap()
                    expect(page).to_have_url(args.base + '/reports?view=analytics')
                    expect(footer_nav.get_by_role('link', name='Аналитика', exact=True)).to_have_attribute('aria-current', 'page')
                    footer_nav.get_by_role('link', name='Регистрация', exact=True).tap()
                    expect(page).to_have_url(args.base + '/register')
                    assert not errors, errors
                    return {'mockedReplies': True, 'navigationAndHistory': True, 'errorsRetryCancel': True,
                            'focusAndEscape': True, 'missingKey': True, 'footerNavigation': True}
                run(f'workflow-{width}', page, workflow)
                for pending in state['pending']:
                    try:
                        pending.abort()
                    except PlaywrightError:
                        pass

        if args.real_status:
            with browser.new_context(viewport={'width': 390, 'height': 844}, has_touch=True) as context:
                page = context.new_page()

                def real_status():
                    page.goto(args.base + '/register', wait_until='networkidle')
                    with page.expect_response('**/api/assistant/chat') as response:
                        page.get_by_role('button', name='Открыть ИИ-помощника').tap()
                    actual = response.value
                    assert actual.status == 200, actual.status
                    available = actual.json()['available']
                    if not available:
                        expect(page.locator('.assistant-connection')).to_contain_text('пока недоступен')
                    page.screenshot(path=str(out / 'real-backend-status.png'))
                    return {'available': available, 'liveModelCalled': False}
                run('real-backend-status', page, real_status)
        browser.close()
    result = {'browser': version, 'mockedReplies': True, 'checks': checks,
              'passed': sum(check['status'] == 'passed' for check in checks),
              'failed': sum(check['status'] == 'failed' for check in checks)}
    (out / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"Passed: {result['passed']}; failed: {result['failed']}", flush=True)
    raise SystemExit(bool(result['failed']))


if __name__ == '__main__':
    main()
