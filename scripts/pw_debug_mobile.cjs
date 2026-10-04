const { chromium } = require('playwright');
const BASE = 'http://localhost:3100';
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  // 登录
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loginForm', { timeout: 10000 });
  await page.fill('input[name="username"]', 'admin');
  await page.fill('input[name="password"]', 'admin123');
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector('#appShell:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(400);
  // 缩到移动端并重载
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#appShell:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(900);
  const geo = await page.evaluate(() => {
    const sb = document.querySelector('.sidebar');
    const tg = document.querySelector('#navToggle');
    const sbCs = sb ? getComputedStyle(sb) : null;
    const tgCs = tg ? getComputedStyle(tg) : null;
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    return {
      appShellClass: document.querySelector('#appShell').className,
      loginHidden: document.querySelector('#loginPage').classList.contains('hidden'),
      sidebarTransform: sbCs ? sbCs.transform : null,
      sidebarRect: sb ? r(sb) : null,
      sidebarZ: sbCs ? sbCs.zIndex : null,
      toggleDisplay: tgCs ? tgCs.display : null,
      toggleRect: tg ? r(tg) : null,
      toggleZ: tgCs ? tgCs.zIndex : null,
    };
  });
  console.log(JSON.stringify(geo, null, 2));
  await browser.close();
})();
