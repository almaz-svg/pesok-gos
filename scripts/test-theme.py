"""Verify persisted theme switching, light surfaces and unchanged user drafts.
Uses isolated demo contexts. Assistant status is mocked; no paid AI calls.
"""
import argparse
import json
import traceback
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROUTES = ['/', '/map', '/reports', '/reports?view=analytics', '/register', '/login', '/missing']

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='http://localhost:5174')
    parser.add_argument('--out', default='test-results/themes')
    parser.add_argument('--recon', action='store_true')
    parser.add_argument('--workflows-only', action='store_true')
    args = parser.parse_args()
    out=Path(args.out)
    out.mkdir(parents=True,exist_ok=True)
    checks=[]
    def run(name,page,fn):
        try:
            fn()
            checks.append({'name':name,'status':'passed'})
        except Exception:
            checks.append({'name':name,'status':'failed','error':traceback.format_exc(limit=2)})
            page.screenshot(path=str(out/f'failure-{name}.png'),full_page=True)
        print(json.dumps(checks[-1]),flush=True)
    def goto(page,route):
        page.goto(args.base+route,wait_until='networkidle')
        expect(page.locator('h1')).to_be_visible()
    def set_theme(page,theme):
        if page.locator('html').get_attribute('data-theme')!=theme:
            page.locator('.theme-toggle').click()
        expect(page.locator('html')).to_have_attribute('data-theme',theme)

    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,channel='msedge')
        if args.recon:
            page=browser.new_page(viewport={'width':1280,'height':850})
            goto(page,'/map')
            print(page.locator('.site-header').aria_snapshot())
            page.get_by_role('button',name='Включить светлую тему').click()
            page.screenshot(path=str(out/'light-map.png'),full_page=True)
            browser.close()
            return
        for width,height in [(320,568),(390,844),(935,800),(1280,850)]:
            with browser.new_context(viewport={'width':width,'height':height},has_touch=width<600,reduced_motion='reduce') as context:
                context.route('**/api/assistant/chat',lambda route:route.fulfill(json={'available':True,'csrf_token':'test-token'}))
                page=context.new_page()
                errors=[]
                page.on('pageerror',lambda e:errors.append(str(e)))
                goto(page,'/map')
                expect(page.get_by_role('button',name='Включить светлую тему')).to_be_visible()
                for theme in ([] if args.workflows_only else ['light','dark']):
                    set_theme(page,theme)
                    for index,route in enumerate(ROUTES):
                        def layout():
                            goto(page,route)
                            expect(page.locator('html')).to_have_attribute('data-theme',theme)
                            assert page.evaluate('document.documentElement.scrollWidth')<=width
                            for control in page.locator('.site-header a,.header-preferences button').all():
                                box=control.bounding_box()
                                assert box['x']>=-1 and box['x']+box['width']<=width+1,box
                                assert box['height']>=43.9,box
                            bounds=page.locator('.brand,.header-preferences').evaluate_all('(els)=>els.map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})')
                            assert bounds[0]['right']<=bounds[1]['left']+1,bounds
                            assert page.locator('html').evaluate('(el)=>getComputedStyle(el).colorScheme')==theme
                            expected='rgb(245, 247, 241)' if theme=='light' else 'rgb(8, 16, 11)'
                            assert page.locator('html').evaluate('(el)=>getComputedStyle(el).backgroundColor')==expected
                            if route=='/map':
                                tile_filter=page.locator('.land-map__tiles').first.evaluate('(el)=>getComputedStyle(el).filter')
                                assert (tile_filter=='none')==(theme=='light')
                                assert page.locator('.land-map__plot').count()>0
                            if width in [390,1280] and route in ['/','/map','/register','/reports?view=analytics']:
                                page.screenshot(path=str(out/f'{theme}-{width}-{index}.png'),full_page=True)
                            assert not errors,errors
                        run(f'{theme}-{width}-{index}',page,layout)
                def state():
                    goto(page,'/register')
                    page.locator('#register-username').fill('draft-login')
                    page.locator('#register-email').fill('draft@example.com')
                    page.locator('.theme-toggle').focus()
                    page.keyboard.press('Enter')
                    expect(page.locator('html')).to_have_attribute('data-theme','light')
                    expect(page.locator('#register-username')).to_have_value('draft-login')
                    for lang,label in [('kk','Қараңғы тақырыпты қосу'),('en','Switch to dark theme'),('ru','Включить тёмную тему')]:
                        page.locator('.language-trigger').click()
                        page.locator(f'.language-menu [lang="{lang}"]').click()
                        expect(page.locator('.theme-toggle')).to_have_attribute('aria-label',label)
                    page.locator('.header-nav a[href="/map"]').click()
                    expect(page.locator('.land-map__canvas')).to_be_visible()
                    page.evaluate('window.testMap=document.querySelector(".land-map__canvas")')
                    set_theme(page,'dark')
                    assert page.evaluate('window.testMap===document.querySelector(".land-map__canvas")')
                    second=context.new_page()
                    goto(second,'/map')
                    page.locator('.report-preview').first.click()
                    drawer=page.locator('.inspector-drawer')
                    expect(drawer).to_be_visible()
                    drawer.locator('textarea').fill('Комментарий сохраняется')
                    set_theme(second,'light')
                    expect(page.locator('html')).to_have_attribute('data-theme','light')
                    expect(drawer.locator('textarea')).to_have_value('Комментарий сохраняется')
                    expect(drawer).to_have_css('background-color','rgb(255, 255, 255)')
                    page.screenshot(path=str(out/f'drawer-{width}.png'))
                    page.locator('.inspector-drawer__close').click()
                    page.locator('.assistant-launcher').click()
                    field=page.locator('.assistant-composer textarea')
                    field.fill('Неотправленный вопрос')
                    set_theme(second,'dark')
                    expect(page.locator('html')).to_have_attribute('data-theme','dark')
                    expect(field).to_have_value('Неотправленный вопрос')
                    set_theme(second,'light')
                    expect(field).to_have_value('Неотправленный вопрос')
                    page.screenshot(path=str(out/f'chat-{width}.png'))
                    second.close()
                    page.reload(wait_until='networkidle')
                    expect(page.locator('html')).to_have_attribute('data-theme','light')
                run(f'state-{width}',page,state)
        for value in ['light','broken','blocked']:
            with browser.new_context() as context:
                if value=='blocked':
                    context.add_init_script("Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError')}})")
                else:
                    context.add_init_script(f"localStorage.setItem('pesok-theme',{json.dumps(value)})")
                page=context.new_page()
                def boot():
                    # The HTML bootstrap must apply the palette even before the app is downloaded.
                    page.route('**/src/main.jsx',lambda route:route.fulfill(body='',content_type='application/javascript'))
                    page.goto(args.base,wait_until='networkidle')
                    expect(page.locator('html')).to_have_attribute('data-theme','light' if value=='light' else 'dark')
                    page.unroute('**/src/main.jsx')
                    goto(page,'/login')
                    page.locator('.theme-toggle').click()
                    expect(page.locator('html')).to_have_attribute('data-theme','dark' if value=='light' else 'light')
                run(f'boot-{value}',page,boot)
        browser.close()
    result={'passed':sum(c['status']=='passed' for c in checks),'failed':sum(c['status']=='failed' for c in checks),'checks':checks}
    (out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(f"Passed: {result['passed']}; failed: {result['failed']}")
    raise SystemExit(bool(result['failed']))

if __name__=='__main__':
    main()
