"""Check separate sign-in and registration pages. API responses use isolated mocks.

Use --api against Vite started with VITE_DATA_MODE=api; otherwise demo mode is expected.
"""
import argparse
import json
import traceback
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='http://localhost:5174')
    parser.add_argument('--api', action='store_true')
    parser.add_argument('--recon', action='store_true')
    parser.add_argument('--out', default='test-results/login')
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    results = []

    def run(name, page, callback):
        try:
            callback()
            results.append({'name': name, 'status': 'passed'})
        except Exception:
            results.append({'name': name, 'status': 'failed', 'error': traceback.format_exc(limit=2)})
            page.screenshot(path=str(out / f'failure-{name}.png'), full_page=True)
        print(json.dumps(results[-1], ensure_ascii=True), flush=True)

    def goto(page, route):
        page.goto(args.base + route, wait_until='networkidle')
        expect(page.locator('h1')).to_be_visible()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel='msedge')
        if args.recon:
            page = browser.new_page(viewport={'width': 390, 'height': 844})
            goto(page, '/login')
            print(page.locator('main').aria_snapshot(), flush=True)
            page.screenshot(path=str(out / 'recon.png'), full_page=True)
            browser.close()
            return
        if not args.api:
            for width, height in [(320,568),(390,844),(768,1024),(844,390),(1280,800)]:
                with browser.new_context(viewport={'width':width,'height':height},has_touch=width<850,reduced_motion='reduce') as context:
                    page = context.new_page()
                    errors=[]
                    page.on('pageerror', lambda e: errors.append(str(e)))
                    goto(page, '/login')
                    for language in ['kk','ru','en']:
                        page.locator('.language-switcher select').select_option(language)
                        for route in ['/login','/register']:
                            def layout():
                                goto(page, route)
                                expect(page.locator('html')).to_have_attribute('lang', language)
                                assert page.evaluate('document.documentElement.scrollWidth') <= width
                                expect(page.locator('.auth-tabs a[aria-current="page"]')).to_have_attribute('href', route)
                                for el in page.locator('.site-header a,.auth-tabs a,.auth-submit,.auth-input-wrap input').all():
                                    box=el.bounding_box()
                                    if not box: continue
                                    assert box['x'] >= -1 and box['x']+box['width'] <= width+1,box
                                    assert box['height'] >= 43.9, box
                                a=page.locator('.header-register').bounding_box()
                                b=page.locator('.header-login').bounding_box()
                                assert a['x']+a['width'] <= b['x']+1, {'register':a,'login':b}
                                if route=='/login':
                                    expect(page.locator('#login-username')).to_be_disabled()
                                    expect(page.locator('#login-password')).to_be_disabled()
                                    expect(page.locator('.login-demo-link')).to_have_attribute('href','/map')
                                if width in [390,1280]:
                                    page.screenshot(path=str(out/f'{language}-{width}-{route[1:]}.png'),full_page=True)
                                assert not errors,errors
                            run(f'{language}-{width}-{route[1:]}',page,layout)
                    def links():
                        goto(page, '/register')
                        page.locator('.auth-signin a').click()
                        expect(page).to_have_url(args.base+'/login')
                        page.locator('.auth-tabs a[href="/register"]').click()
                        expect(page).to_have_url(args.base+'/register')
                        page.locator('.header-login').click()
                        page.locator('.login-demo-link').click()
                        expect(page).to_have_url(args.base+'/map')
                    run(f'links-{width}',page,links)
        else:
            with browser.new_context(viewport={'width':390,'height':844},reduced_motion='reduce') as context:
                state={'mode':'bad','signed':False,'posts':[], 'pending':None}
                def api(route):
                    path=urlparse(route.request.url).path
                    if path=='/api/auth/csrf':
                        route.fulfill(json={'csrf_token':'test-csrf'})
                    elif path=='/api/auth/login':
                        state['posts'].append(route.request.post_data_json)
                        assert route.request.headers.get('x-csrftoken') in ['test-csrf','rotated-csrf']
                        if state['mode']=='bad':
                            route.fulfill(status=401,json={'error':{'code':'invalid_credentials','message':'private diagnostics'}})
                        elif state['mode']=='hold':
                            state['pending']=route
                        elif state['mode']=='forbidden':
                            route.fulfill(status=403,json={'error':{'code':'permission_denied'}})
                        elif state['mode']=='throttle':
                            route.fulfill(status=429,json={'error':{'code':'throttled'}})
                        else:
                            state['signed']=True
                            route.fulfill(json={'user':{'id':'test-id','username':'inspector'},'csrf_token':'rotated-csrf'})
                    elif path=='/api/auth/me':
                        route.fulfill(status=200 if state['signed'] else 401,
                                      json={'id':'test-id','username':'inspector'} if state['signed'] else {'error':{'code':'authentication_required'}})
                    elif path=='/api/map':
                        empty={'type':'FeatureCollection','features':[]}
                        route.fulfill(json={'plots':empty,'reports':empty})
                    elif path=='/api/statistics':
                        route.fulfill(json={'total_plots':0,'under_inspection':0,'active_violations':0,'resolved':0})
                    else:
                        route.fulfill(json={'count':0,'next':None,'results':[]})
                context.route('**/api/**',api)
                page=context.new_page()
                def workflow():
                    goto(page, '/reports?view=analytics')
                    page.locator('.login-gate a').click()
                    expect(page).to_have_url(args.base+'/login?next=%2Freports%3Fview%3Danalytics')
                    page.locator('.login-form button[type="submit"]').click()
                    expect(page.locator('#login-username')).to_be_focused()
                    assert not state['posts']
                    page.locator('#login-username').fill(' inspector ')
                    page.locator('#login-password').fill(' pass ')
                    page.locator('.password-toggle').click()
                    expect(page.locator('#login-password')).to_have_attribute('type','text')
                    page.locator('.language-switcher select').select_option('en')
                    expect(page.locator('#login-password')).to_have_value(' pass ')
                    page.locator('.login-form button[type="submit"]').click()
                    expect(page.locator('.login-error')).to_have_text('Incorrect username or password')
                    expect(page.locator('.login-error')).to_be_focused()
                    expect(page.locator('#login-password')).to_have_value('')
                    assert state['posts'][-1]=={'username':'inspector','password':' pass '}
                    expect(page.locator('body')).not_to_contain_text('private diagnostics')
                    for mode,text in [('forbidden','This account does not have inspector access'),('throttle','Too many sign-in attempts.')]:
                        state['mode']=mode
                        page.locator('#login-password').fill('test')
                        page.locator('.login-form button[type="submit"]').click()
                        expect(page.locator('.login-error')).to_contain_text(text)
                    state['mode']='hold'
                    page.locator('#login-password').fill('test')
                    page.locator('.login-form button[type="submit"]').click()
                    expect(page.locator('.login-form button[type="submit"]')).to_be_disabled()
                    expect(page.locator('#login-username')).to_be_disabled()
                    assert len(state['posts'])==4
                    page.locator('.auth-tabs a').nth(1).click()
                    expect(page).to_have_url(args.base+'/register?next=%2Freports%3Fview%3Danalytics')
                    page.locator('.auth-tabs a').first.click()
                    expect(page.locator('#login-password')).to_have_value('')
                    state['mode']='success'
                    page.locator('#login-username').fill('inspector')
                    page.locator('#login-password').fill('test')
                    page.locator('.login-form button[type="submit"]').click()
                    expect(page).to_have_url(args.base+'/reports?view=analytics')
                    expect(page.locator('.user-label')).to_contain_text('inspector')
                    storage=page.evaluate('({local:{...localStorage},session:{...sessionStorage}})')
                    assert 'password' not in json.dumps(storage).lower(),storage
                run('api-sign-in-flow',page,workflow)
                if state['pending']:
                    try:
                        state['pending'].abort()
                    except Exception:
                        pass  # The browser may already have cancelled the request on navigation.
        browser.close()
    summary={'passed':sum(r['status']=='passed' for r in results),'failed':sum(r['status']=='failed' for r in results),'checks':results}
    (out/'results.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    print(f"Passed: {summary['passed']}; failed: {summary['failed']}")
    raise SystemExit(bool(summary['failed']))


if __name__=='__main__':
    main()
