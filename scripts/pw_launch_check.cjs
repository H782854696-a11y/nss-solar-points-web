const { chromium } = require('playwright');

(async () => {
  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent('<h1>launch-ok</h1>');
    const txt = await page.textContent('h1');
    console.log('LAUNCH_OK:', txt);
    await browser.close();
  } catch (e) {
    console.error('LAUNCH_FAIL:', e.message);
    process.exit(1);
  }
})();
