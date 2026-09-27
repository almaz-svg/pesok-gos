"""Language, Telegram link and responsive UI checks in isolated browser contexts.
Run against Vite. Chat replies are mocked; no messages are sent to Telegram or OpenAI.
"""
import argparse
import json
import re
import traceback
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROUTES = ['/', '/map', '/reports', '/reports?view=analytics', '/register', '/missing']
LANGUAGES = {'kk': ['Шолу', 'Жер картасы', 'Өтініштер'],
             'ru': ['Обзор', 'Карта земель', 'Обращения'],
             'en': ['Overview', 'Land map', 'Reports']}
AUDIT = """() => {
  const width = document.documentElement.clientWidth;
  const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const outside = [...document.querySelectorAll('.site-header a,.language-switcher,h1,h2,.view-tabs,.filter-toolbar,.footer-shell,.register-card')]
    .filter(visible).filter(el => {const r=el.getBoundingClientRect(); return r.left < -1 || r.right > width+1;})
    .map(el => el.textContent.trim().slice(0,100));
  const small = [...document.querySelectorAll('.site-header a,.language-trigger,.language-menu button,.footer-telegram')]
    .filter(visible).filter(el => el.getBoundingClientRect().height < 43.9)
    .map(el=>el.textContent.trim());
  return {width,documentWidth:document.documentElement.scrollWidth,outside,small};
}"""
ENGLISH_AUDIT = """() => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const found=[];
  while(walker.nextNode()) {
    const node=walker.currentNode, el=node.parentElement;
    if(!el || !el.getClientRects().length || el.closest('.brand,.footer-brand,.language-switcher,.report-preview p,.inspector-drawer__description,.inspector-drawer__event-comment,.inspector-drawer__event-meta,.inspector-drawer__address,script,style')) continue;
    if(/[А-Яа-яЁё]/.test(node.textContent)) found.push(node.textContent.trim());
  }
  return found.filter(Boolean);
}"""

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='http://localhost:5174')
    parser.add_argument('--channel', default='msedge')
    parser.add_argument('--out', default='test-results/languages')
    parser.add_argument('--workflows-only', action='store_true')
    parser.add_argument('--widths', nargs='+', type=int, default=[320,390,768,844,1280], choices=[320,390,768,844,1280])
    args = parser.parse_args()
    out=Path(args.out)
    out.mkdir(parents=True,exist_ok=True)
    results=[]

    def run(name,page,callback):
        try:
            callback()
            results.append({'name':name,'status':'passed'})
        except Exception:
            results.append({'name':name,'status':'failed','error':traceback.format_exc(limit=2)})
            page.screenshot(path=str(out/f'failure-{name}.png'))
        print(json.dumps(results[-1],ensure_ascii=True),flush=True)

    def goto(page,route):
        page.goto(args.base+route,wait_until='networkidle')
        expect(page.locator('h1')).to_be_visible()

    def switch(page,language):
        page.locator('.language-trigger').click()
        page.locator(f'.language-menu [lang="{language}"]').click()
        expect(page.locator('html')).to_have_attribute('lang',language)
        expect(page.locator('.header-nav a')).to_have_text(LANGUAGES[language])

    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,channel=args.channel)
        sizes = {320:568,390:844,768:1024,844:390,1280:800}
        for width,height in ([] if args.workflows_only else [(w,sizes[w]) for w in args.widths]):
            with browser.new_context(viewport={'width':width,'height':height},has_touch=width<850,
                                     is_mobile=width<850,reduced_motion='reduce') as context:
                page=context.new_page()
                errors=[]
                page.on('pageerror',lambda e:errors.append(str(e)))
                goto(page,'/')
                # Inspect the rendered header before operating its language menu.
                assert page.locator('.site-header').get_by_role('button', name='Язык интерфейса: Русский').is_visible()
                def menu():
                    trigger=page.locator('.language-trigger')
                    trigger.click()
                    options=page.get_by_role('menuitemradio')
                    expect(options).to_have_text(['ҚАЗҚазақша','РУСРусский','ENGEnglish'])
                    expect(options.nth(1)).to_have_attribute('aria-checked','true')
                    expect(options.nth(1)).to_be_focused()
                    box=page.get_by_role('menu').bounding_box()
                    assert box['x'] >= 0 and box['x']+box['width'] <= width
                    assert trigger.bounding_box()['width'] <= 90
                    page.screenshot(path=str(out/f'menu-{width}.png'))
                    page.keyboard.press('ArrowDown')
                    expect(options.nth(2)).to_be_focused()
                    page.keyboard.press('ArrowDown')
                    expect(options.first).to_be_focused()
                    page.keyboard.press('End')
                    expect(options.last).to_be_focused()
                    page.keyboard.press('Home')
                    page.keyboard.press('Enter')
                    expect(page.locator('html')).to_have_attribute('lang','kk')
                    expect(trigger).to_be_focused()
                    expect(page.get_by_role('menu')).to_have_count(0)
                    trigger.press('ArrowUp')
                    expect(page.get_by_role('menuitemradio').last).to_be_focused()
                    page.keyboard.press('Escape')
                    expect(trigger).to_be_focused()
                    expect(trigger).to_have_attribute('aria-expanded','false')
                    trigger.click()
                    page.keyboard.press('Tab')
                    expect(page.locator('.theme-toggle')).to_be_focused()
                    expect(page.get_by_role('menu')).to_have_count(0)
                    trigger.click()
                    page.locator('.site-header').click(position={'x':1,'y':1})
                    expect(trigger).to_have_attribute('aria-expanded','false')
                run(f'menu-{width}',page,menu)
                for language in LANGUAGES:
                    switch(page,language)
                    for index,route in enumerate(ROUTES):
                        def layout():
                            goto(page,route)
                            expect(page.locator('html')).to_have_attribute('lang',language)
                            expect(page.locator('.language-trigger span')).to_have_attribute('lang',language)
                            expect(page.locator('.header-nav a')).to_have_text(LANGUAGES[language])
                            audit=page.evaluate(AUDIT)
                            assert audit['documentWidth']<=width+1 and not audit['outside'],audit
                            assert not audit['small'],audit
                            links=page.locator('a[href="https://t.me/zbjer_bot"]')
                            expect(links).to_have_count(2)
                            for link in links.all():
                                expect(link).to_have_attribute('target','_blank')
                                assert 'noopener' in link.get_attribute('rel')
                            if language=='en':
                                assert not page.evaluate(ENGLISH_AUDIT),page.evaluate(ENGLISH_AUDIT)
                            if route in ['/', '/register']:
                                page.screenshot(path=str(out/f'{language}-{width}-{index}.png'),full_page=True)
                            assert not errors,errors
                        run(f'{language}-{width}-{index}',page,layout)

        with browser.new_context(viewport={'width':390,'height':844},reduced_motion='reduce') as context:
            page=context.new_page()
            def workflow():
                goto(page,'/register')
                page.locator('#register-name').fill('Тестовый пользователь')
                page.locator('#register-email').fill('test@example.com')
                switch(page,'kk')
                expect(page.locator('#register-name')).to_have_value('Тестовый пользователь')
                page.locator('.auth-submit').click()
                expect(page.locator('#register-password-error')).to_contain_text('Құпиясөз')
                switch(page,'en')
                expect(page.locator('#register-password-error')).to_have_text('Create a password.')
                expect(page.locator('#register-email')).to_have_value('test@example.com')
                assert page.title()=='Register — Pesok Gos'
                page.reload(wait_until='networkidle')
                expect(page.locator('html')).to_have_attribute('lang','en')
                page.locator('.header-nav a[href="/reports"]').click()
                expect(page.locator('h1')).to_contain_text('Reports.')
                page.locator('.table-report').first.click()
                drawer=page.locator('.inspector-drawer')
                expect(drawer).to_be_visible()
                field=drawer.locator('textarea')
                field.fill('Мой комментарий не переводится')
                second=context.new_page()
                goto(second,'/')
                switch(second,'kk')
                expect(page.locator('html')).to_have_attribute('lang','kk')
                expect(drawer).to_contain_text('Өтінішпен жұмыс')
                expect(field).to_have_value('Мой комментарий не переводится')
                second.close()
                drawer.locator('.inspector-drawer__close').click()
                posts=[]
                def chat(route):
                    if route.request.method=='GET':
                        route.fulfill(json={'available':True,'csrf_token':'test-csrf'})
                    else:
                        posts.append(route.request.post_data_json)
                        route.fulfill(json={'reply':'Тест жауабы','truncated':False})
                context.route('**/api/assistant/chat',chat)
                page.locator('.assistant-launcher').click()
                page.locator('.assistant-suggestions button').first.click()
                expect(page.locator('.assistant-message-reply')).to_be_visible()
                assert posts[-1]['language']=='kk',posts
                assert posts[-1]['messages'][-1]['content']=='Карта қалай жұмыс істейді?',posts
                page.get_by_role('button', name='ЖИ көмекшісін жабу').click()
                switch(page,'en')
                page.locator('.assistant-launcher').click()
                expect(page.locator('.assistant-message-reply')).to_contain_text('Тест жауабы')
                assert 'Тест жауабы' in page.locator('.assistant-log').inner_text()
            run('language-state-and-chat',page,workflow)
        browser.close()
    summary={'passed':sum(r['status']=='passed' for r in results),'failed':sum(r['status']=='failed' for r in results),'checks':results}
    (out/'results.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    print(f"Passed: {summary['passed']}; failed: {summary['failed']}")
    raise SystemExit(bool(summary['failed']))

if __name__=='__main__':
    main()
