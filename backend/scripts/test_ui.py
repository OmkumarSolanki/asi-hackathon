"""Drive the live UI with Playwright. Capture screenshots + console logs."""
from playwright.sync_api import sync_playwright
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "test-results"
OUT.mkdir(exist_ok=True)


def main():
    logs = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1600, "height": 1000})
        page = ctx.new_page()
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))

        page.goto("http://localhost:5173/")
        page.wait_for_load_state("networkidle", timeout=20000)
        page.wait_for_timeout(1500)  # extra time for map tiles + first API roundtrip

        page.screenshot(path=str(OUT / "01_initial.png"), full_page=False)
        print(f"saved 01_initial.png")

        # Wait for the scenario selector to populate
        try:
            page.wait_for_selector("select", timeout=10000)
        except Exception as e:
            logs.append(f"[err] no scenario select found: {e}")

        # Wait for flight markers to render (map source data)
        page.wait_for_timeout(3500)
        page.screenshot(path=str(OUT / "02_after_load.png"))
        print("saved 02_after_load.png")

        # Try clicking the first flight in the WX hotlist (dramatic flight)
        try:
            hot_btn = page.locator(".max-h-\\[140px\\] button").first
            hot_btn.wait_for(state="visible", timeout=8000)
            cs = hot_btn.text_content() or "?"
            print(f"clicking hotlist flight: {cs[:60]}")
            hot_btn.click()
            page.wait_for_timeout(1500)
            page.screenshot(path=str(OUT / "03_flight_selected.png"))
        except Exception as e:
            logs.append(f"[err] clicking hotlist: {e}")
            # fallback to general flight list
            try:
                first_btn = page.locator(".max-h-\\[280px\\] button").first
                first_btn.wait_for(state="visible", timeout=5000)
                first_btn.click()
                page.wait_for_timeout(1200)
                page.screenshot(path=str(OUT / "03_flight_selected.png"))
            except Exception as e2:
                logs.append(f"[err] fallback: {e2}")

        # Try clicking "Request Advisory"
        try:
            advise_btn = page.get_by_text("Request Advisory")
            advise_btn.wait_for(state="visible", timeout=5000)
            advise_btn.click()
            print("clicked Request Advisory; waiting for response...")
            page.wait_for_timeout(20000)
            page.screenshot(path=str(OUT / "04_advisory.png"))
        except Exception as e:
            logs.append(f"[err] requesting advisory: {e}")

        # Try clicking through tabs
        for tab in ["Options", "Crowd", "Archive"]:
            try:
                btn = page.get_by_role("button", name=tab, exact=True).first
                btn.click()
                page.wait_for_timeout(600)
                page.screenshot(path=str(OUT / f"05_tab_{tab.lower()}.png"))
            except Exception as e:
                logs.append(f"[err] tab {tab}: {e}")

        # Enable Wind layer to grab a streamlines screenshot
        try:
            wind_btn = page.locator("button:has-text('Wind')").first
            wind_btn.click()
            page.wait_for_timeout(4000)
            page.screenshot(path=str(OUT / "07_winds.png"))
        except Exception as e:
            logs.append(f"[err] wind toggle: {e}")

        # Toggle theme
        try:
            theme_btn = page.get_by_label("Switch to light mode").first
            theme_btn.click()
            page.wait_for_timeout(800)
            page.screenshot(path=str(OUT / "06_light_mode.png"))
        except Exception as e:
            logs.append(f"[err] theme toggle: {e}")

        browser.close()

    log_path = OUT / "console.log"
    log_path.write_text("\n".join(logs))
    print(f"\n===== CONSOLE ({len(logs)} entries) =====")
    for line in logs[-30:]:
        print(line)


if __name__ == "__main__":
    main()
