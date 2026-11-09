from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(headless=True, executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')
 page=b.new_page(viewport={"width":1402,"height":1097})
 page.goto('http://127.0.0.1:50963/dsh-fish-world/fishworld/?v=layout3',wait_until='load',timeout=30000)
 page.wait_for_timeout(4000); page.mouse.click(80,437); page.wait_for_timeout(2500)
 page.screenshot(path='E:/dsh_fish_world/var/profile-layout3.png'); print('ok')
 b.close()
