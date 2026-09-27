"""Mobile UI regression against a running frontend, using isolated demo contexts.

python -m pip install playwright
python scripts/test-mobile.py --base http://localhost:5173 --channel msedge
Omit --channel to use Playwright's installed Chromium.
"""

import argparse
import json
import re
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import expect, sync_playwright


ROUTES = [
    ("overview", "/"),
    ("map", "/map"),
    ("reports", "/reports"),
    ("analytics", "/reports?view=analytics"),
    ("register", "/register"),
    ("missing", "/unknown-mobile-test"),
]
SIZES = [(320, 568), (360, 800), (375, 667), (390, 844), (414, 896),
         (430, 932), (768, 1024), (844, 390), (1280, 800)]
LAYOUT = """() => {
  const width = document.documentElement.clientWidth;
  const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const rect = el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
  const name = el => (el.getAttribute('aria-label') || el.textContent || el.name || '').trim().slice(0,80);
  const outside = [...document.querySelectorAll('h1,h2,.site-header,.header-nav,.hero-bottom-nav,.filter-toolbar,.analytics-panel,.register-card,.data-footer,.section-heading,[role="dialog"]')]
    .filter(visible).filter(el => {const r=el.getBoundingClientRect(); return r.left < -1 || r.right > width+1;})
    .map(el => ({name:name(el),...rect(el)}));
  const smallTargets = [...document.querySelectorAll('.header-nav a,.header-register,.header-cta,.hero-button,.icon-button,.land-map__controls button,.password-toggle,.auth-submit,.inspector-drawer__close,.inspector-drawer__save,.table-report,.analytics-callout button')]
    .filter(visible).filter(el => {const r=el.getBoundingClientRect(); return r.width < 43.9 || r.height < 43.9;})
    .map(el => ({name:name(el),...rect(el)}));
  const smallFonts = [...document.querySelectorAll('input:not([type="checkbox"]),select,textarea')]
    .filter(visible).filter(el => parseFloat(getComputedStyle(el).fontSize) < 16)
    .map(el => ({name:name(el),font:getComputedStyle(el).fontSize}));
  return {width,documentWidth:document.documentElement.scrollWidth,outside,smallTargets,smallFonts};
}"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://localhost:5173")
    parser.add_argument("--channel", default=None)
    parser.add_argument("--out", default="test-results/mobile")
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--smoke", action="store_true", help="Only the 390px route checks")
    scope.add_argument("--workflows-only", action="store_true", help="Only touch workflows and reduced motion")
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    results = []

    def navigate(page, route):
        page.goto(args.base.rstrip("/") + route, wait_until="domcontentloaded")
        try:
            page.wait_for_load_state("networkidle", timeout=10000)
        except PlaywrightTimeout:
            # External OSM tiles can be slow. Local readiness is checked below.
            pass
        expect(page.locator("h1")).to_be_visible()
        if route.startswith(("/map", "/reports")):
            expect(page.locator(".demo-label")).to_contain_text("DEMO")
            expect(page.locator(".view-tabs")).to_be_visible()

    def reveal(page):
        for element in page.locator("[data-reveal]").all():
            element.scroll_into_view_if_needed()
            expect(element).to_have_css("opacity", "1")

    def layout(page, width):
        for dialog in page.get_by_role("dialog").all():
            dialog.evaluate("el => Promise.all(el.getAnimations().map(animation => animation.finished))")
        audit = page.evaluate(LAYOUT)
        assert audit["documentWidth"] <= width + 1, audit
        assert not audit["outside"], audit["outside"]
        if width <= 850:
            assert not audit["smallTargets"], audit["smallTargets"]
            assert not audit["smallFonts"], audit["smallFonts"]
        return audit

    def screenshot(page, name, full_page=True):
        page.screenshot(path=str(out / f"{name}.png"), full_page=full_page)

    def record(name, page, errors, fn):
        entry = {"name": name}
        try:
            entry["details"] = fn()
            assert not errors, errors
            entry["status"] = "passed"
        except Exception as error:
            entry.update(status="failed", error=str(error))
            screenshot(page, "failure-" + name, full_page=page.get_by_role("dialog").count() == 0)
        entry["pageErrors"] = errors[:]
        results.append(entry)
        print(json.dumps(entry, ensure_ascii=True), flush=True)

    def context_for(browser, width, height, **kwargs):
        return browser.new_context(viewport={"width": width, "height": height},
                                   is_mobile=width <= 850, has_touch=width <= 850,
                                   device_scale_factor=1, locale="ru-RU", **kwargs)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, channel=args.channel)
        version = browser.version
        sizes = [] if args.workflows_only else ([(390, 844)] if args.smoke else SIZES)
        for width, height in sizes:
            with context_for(browser, width, height) as context:
                for slug, route in ROUTES:
                    page = context.new_page()
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))

                    def check_route():
                        navigate(page, route)
                        reveal(page)
                        audit = layout(page, width)
                        if slug == "reports":
                            expect(page.locator("tbody tr")).to_have_count(7)
                            if width <= 600:
                                assert page.locator(".table-container").evaluate(
                                    "el => el.scrollWidth <= el.clientWidth + 1")
                        if width in (320, 390, 844, 1280):
                            page.evaluate("window.scrollTo({top:0,behavior:'instant'})")
                            screenshot(page, f"{slug}-{width}")
                        return audit

                    record(f"{slug}-{width}x{height}", page, errors, check_route)
                    page.close()

        if not args.smoke:
            for width, height in [(320, 568), (390, 844), (844, 390)]:
                with context_for(browser, width, height) as context:
                    page = context.new_page()
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))

                    def workflows():
                        navigate(page, "/")
                        page.locator(".hero").get_by_role("link", name="Открыть карту", exact=True).tap()
                        expect(page).to_have_url(re.compile(r"/map$"))
                        expect(page.locator(".demo-label")).to_contain_text("DEMO")
                        expect(page.get_by_role("navigation", name="Основная навигация")
                               .get_by_role("link", name="Карта земель")).to_have_attribute("aria-current", "page")
                        expect(page.locator(".land-map__marker")).to_have_count(7)
                        for title in ["Приблизить карту", "Отдалить карту", "Показать все видимые объекты"]:
                            page.get_by_role("button", name=title, exact=True).tap()
                        search = page.get_by_role("searchbox")
                        search.fill("000007")
                        expect(page.locator(".land-map__marker")).to_have_count(1)
                        page.get_by_role("button", name="Показать все видимые объекты").tap()
                        page.get_by_role("button", name=re.compile(r"^Обращение DEMO-2026-000007")).tap()
                        dialog = page.get_by_role("dialog", name="DEMO-2026-000007")
                        expect(dialog).to_be_visible()
                        layout(page, width)
                        screenshot(page, f"map-drawer-{width}", full_page=False)
                        dialog.get_by_role("button", name="Закрыть карточку").tap()
                        page.get_by_role("button", name="Очистить поиск").tap()
                        page.get_by_role("button", name="Дополнительные фильтры").tap()
                        page.get_by_label("Обращения на карте", exact=True).uncheck()
                        expect(page.locator(".land-map__marker")).to_have_count(0)
                        page.get_by_label("Обращения на карте", exact=True).check()
                        expect(page.locator(".land-map__marker")).to_have_count(7)
                        page.get_by_label("Участки на карте", exact=True).uncheck()
                        expect(page.locator('[data-map-feature^="plot:"]')).to_have_count(0)
                        page.get_by_label("Участки на карте", exact=True).check()
                        expect(page.locator('[data-map-feature^="plot:"]')).to_have_count(6)

                        page.get_by_role("navigation", name="Основная навигация").get_by_role("link", name="Обращения", exact=True).tap()
                        expect(page.locator("tbody tr")).to_have_count(7)
                        page.get_by_role("searchbox").fill("нет-такого-номера")
                        expect(page.get_by_text("Нет обращений по выбранным фильтрам", exact=True)).to_be_visible()
                        page.get_by_role("button", name="Очистить поиск").tap()
                        page.get_by_role("combobox", name="Статус обращения").select_option("NEW")
                        expect(page.locator("tbody tr")).to_have_count(2)
                        page.get_by_role("combobox", name="Статус обращения").select_option("ALL")
                        page.get_by_role("button", name="Открыть DEMO-2026-000007", exact=True).tap()
                        expect(dialog).to_be_visible()
                        dialog.get_by_label("Статус обращения", exact=True).select_option("INSPECTION")
                        comment = f"Проверка адаптивности {width}px — изолированное демо."
                        dialog.get_by_label("Комментарий инспектора", exact=True).fill(comment)
                        dialog.get_by_role("button", name="Сохранить изменения", exact=True).tap()
                        expect(dialog.get_by_text("Изменения сохранены.", exact=True)).to_be_visible()
                        expect(dialog.locator(".inspector-drawer__event-comment").filter(has_text=comment)).to_have_count(1)
                        layout(page, width)
                        screenshot(page, f"saved-drawer-{width}", full_page=False)
                        # Simulate a shorter visual area; this does not emulate a native keyboard.
                        if width == 390:
                            page.set_viewport_size({"width": 390, "height": 420})
                            comment_field = dialog.get_by_label("Комментарий инспектора", exact=True)
                            # Center explicitly after resize, avoiding fractional edge clipping
                            # while the browser settles its native nearest-edge scroll.
                            comment_field.evaluate("el => el.scrollIntoView({block:'center',behavior:'instant'})")
                            box = comment_field.bounding_box()
                            assert box["y"] >= 0 and box["y"] + box["height"] <= 421, box
                            layout(page, width)
                            screenshot(page, "short-viewport-drawer", full_page=False)
                            page.set_viewport_size({"width": width, "height": height})
                        dialog.get_by_role("button", name="Закрыть карточку").tap()
                        page.reload(wait_until="networkidle")
                        row = page.locator("tbody tr").filter(has_text="DEMO-2026-000007")
                        expect(row).to_contain_text("На проверке")
                        page.locator(".view-tabs").get_by_role("link", name="Аналитика", exact=True).tap()
                        expect(page.locator(".analytics-panel")).to_be_visible()
                        page.get_by_role("button", name="Посмотреть обращения", exact=True).tap()
                        expect(page.get_by_label("Только просроченные", exact=True)).to_be_checked()
                        rows = page.locator("tbody tr")
                        expect(rows.first).to_be_visible()
                        for overdue in rows.all():
                            expect(overdue).to_contain_text("Просрочено")
                        layout(page, width)

                        page.locator(".header-register").tap()
                        expect(page).to_have_url(re.compile(r"/register$"))
                        page.get_by_role("button", name="Создать аккаунт", exact=True).tap()
                        expect(page.locator("#register-name")).to_be_focused()
                        expect(page.locator(".auth-field-error")).to_have_count(4)
                        page.get_by_label("Имя", exact=True).fill("Мобильный тест")
                        page.get_by_label("Email", exact=True).fill("invalid-email")
                        page.get_by_label("Пароль", exact=True).fill("MobileTest!2026")
                        page.get_by_label("Подтверждение пароля", exact=True).fill("different-password")
                        page.get_by_role("button", name="Создать аккаунт", exact=True).tap()
                        expect(page.get_by_text("Пароли не совпадают.", exact=True)).to_be_visible()
                        expect(page.get_by_label("Email", exact=True)).to_be_focused()
                        layout(page, width)
                        screenshot(page, f"register-errors-{width}", full_page=False)
                        page.get_by_label("Email", exact=True).fill("mobile-test@example.com")
                        page.get_by_label("Подтверждение пароля", exact=True).fill("MobileTest!2026")
                        page.get_by_role("button", name="Показать пароль", exact=True).tap()
                        expect(page.get_by_label("Пароль", exact=True)).to_have_attribute("type", "text")
                        page.get_by_role("button", name="Скрыть пароль", exact=True).tap()
                        page.get_by_role("button", name="Создать аккаунт", exact=True).tap()
                        expect(page.get_by_role("heading", name="Форма заполнена верно")).to_be_visible()
                        expect(page.get_by_text(re.compile("Аккаунт не создан"))).to_be_visible()
                        page.get_by_role("button", name="Вернуться к форме", exact=True).tap()
                        expect(page.get_by_label("Имя", exact=True)).to_be_focused()
                        expect(page.get_by_label("Пароль", exact=True)).to_have_value("")
                        expect(page.get_by_label("Подтверждение пароля", exact=True)).to_have_value("")
                        return {"mapAndLayers": True, "navigation": True, "searchAndFilters": True,
                                "demoSaveAndReload": True, "analytics": True, "registrationValidation": True}

                    record(f"touch-workflows-{width}", page, errors, workflows)

            with context_for(browser, 390, 844, reduced_motion="reduce") as context:
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))

                def reduced_motion():
                    for route in ["/", "/register"]:
                        navigate(page, route)
                        for element in page.locator("[data-reveal]").all():
                            expect(element).to_have_css("opacity", "1")
                        layout(page, 390)
                    return {"contentVisibleWithoutAnimation": True}

                record("reduced-motion", page, errors, reduced_motion)
        browser.close()

    summary = {"browser": "Chromium", "channel": args.channel, "version": version,
               "base": args.base, "passed": sum(r["status"] == "passed" for r in results),
               "failed": sum(r["status"] == "failed" for r in results), "checks": results}
    (out / "results.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Passed: {summary['passed']}; failed: {summary['failed']}", flush=True)
    raise SystemExit(bool(summary["failed"]))


if __name__ == "__main__":
    main()
